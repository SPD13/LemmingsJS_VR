"use strict";
/**
 * WebXR layer (plan Phase 4). The same scene the desktop mode renders is
 * presented in a headset as a tabletop diorama:
 *
 * - Enter VR button (minimal VRButton equivalent; needs a secure context —
 *   https or localhost, e.g. `adb reverse tcp:8123 tcp:8123` for Quest).
 * - On session start the diorama root (level + skill panel) is scaled to
 *   VR_PIXEL_SCALE meters per game pixel and placed at chest height in
 *   front of the player; on exit it snaps back to desktop identity.
 * - Controller trigger = the desktop click (same pick() path: skill panel
 *   by UV, lemmings via sim coordinates through CommandManager). One hand
 *   points at a time - it alone draws a ray, drives hover, and acts on its
 *   trigger. The right starts with it; a trigger pull on the other hand
 *   takes it over. Holding the trigger and moving the hand drags the board
 *   instead, in all three axes, so pulling back walks it in along Z.
 * - Grip drags the diorama; both grips scale it about the hands' midpoint.
 *   The world itself never moves, so there is nothing to feel sick about.
 */

const VR_PIXEL_SCALE = 0.0025; // meters per game pixel (1600px level -> 4m)
// Skill toolbar, head-fixed so it is always to hand (metres, camera space).
// Sized so a button is ~46mm across at this distance: a comfortable target
// for a controller ray, and enough for the 1px relief to read in stereo.
const VR_GUI_WIDTH = 0.6;
const VR_GUI_Y = -0.3;
const VR_GUI_Z = -0.75;
// The buttons stand off the panel by the one pixel they are modelled at, in
// the headset as on a monitor. Multiplying it to force the parallax made them
// look like blocks stuck to the bar rather than artwork pressed into it.
const GUI_VR_RELIEF_DEPTH = 1;
const VR_BAR_TOOL_SIZE = 0.045; // metres: the lock/move handles above the bar
const VR_BAR_TOOL_HOVER = 1.18; // how much a handle grows under the beam
const VR_VOLUME_HEIGHT = 0.15;  // the volume slider, standing off the bar's end
const VR_SOUND_LINGER = 2000;   // ms the slider stays up once the beam leaves
// The restart question, head-fixed in metres of camera space.
const VR_MODAL_WIDTH = 0.42;
const VR_MODAL_Y = 0.02;
const VR_MODAL_Z = VR_GUI_Z;  // the toolbar's plane: one surface to focus on
// The world catalog shares that plane; it is wider because it holds a grid.
const VR_CATALOG_WIDTH = 0.62;
const VR_CATALOG_Y = 0.06;
// Aiming marks - the impact dot and the hand markers - over everything the
// toolbar draws, which tops out at 55.
const VR_MARK_ORDER = 60;
// Thumbsticks. The deadzone is generous because a resting thumb on a stick
// that never quite centres would otherwise drift the board all session.
const VR_STICK_DEADZONE = 0.15;
const VR_STICK_PAN = 0.8;   // metres per second at full deflection
const VR_STICK_TILT = 1.0;  // radians per second at full deflection
// How far the hand has to travel with the trigger held before it counts as a
// drag rather than a click. A trigger pull moves the hand a little on its own.
const VR_DRAG_THRESHOLD = 0.02; // metres

function createVRButton(renderer) {
  const button = document.createElement("button");
  button.id = "vr-button";
  const setLabel = (text, enabled) => {
    button.textContent = text;
    button.disabled = !enabled;
  };
  if (!("xr" in navigator)) {
    setLabel(window.isSecureContext ? "VR NOT SUPPORTED" : "VR NEEDS HTTPS", false);
  } else {
    setLabel("VR CHECKING…", false);
    navigator.xr.isSessionSupported("immersive-vr").then((ok) => {
      setLabel(ok ? "ENTER VR" : "VR NOT SUPPORTED", ok);
    }).catch(() => setLabel("VR NOT ALLOWED", false));
    let currentSession = null;
    button.addEventListener("click", async () => {
      if (currentSession) { currentSession.end(); return; }
      try {
        // minimal session request: extra optional features exercise more
        // runtime paths, and some runtime/controller combos are fragile there
        const session = await navigator.xr.requestSession("immersive-vr", {
          optionalFeatures: ["local-floor"],
        });
        session.addEventListener("end", () => {
          currentSession = null;
          setLabel("ENTER VR", true);
        });
        await renderer.xr.setSession(session);
        currentSession = session;
        setLabel("EXIT VR", true);
      } catch (err) {
        console.error("failed to start VR session:", err);
      }
    });
  }
  document.body.appendChild(button);
  return button;
}

class VRManager {
  /**
   * hooks:
   *  - pickWithRaycaster(raycaster) -> {panelUv}|{simX,simY}|null
   *  - onSelectPick(pick)           -> act on a trigger pull
   *  - onHoverPick(pick|null)       -> aiming feedback (highlight ring)
   *  - onStick("pan"|"tilt", x, y, dt) -> thumbstick, already resolved to a
   *                                    role, y flipped to "away is positive"
   *  - onBarDragStart(), onBarDrag(worldDelta) -> dragging the toolbar by its
   *                                    move handle, instead of the world
   *  - placeDiorama()               -> position dioramaRoot for the headset
   */
  constructor(renderer, scene, camera, dioramaRoot, hooks) {
    this.renderer = renderer;
    this.dioramaRoot = dioramaRoot;
    this.hooks = hooks;
    this.raycaster = new THREE.Raycaster();
    this._tempMatrix = new THREE.Matrix4();
    this._grab = null;
    this._aiming = null; // the controller currently driving hover
    this._pointerHand = "right"; // which hand carries the beam; a trigger
                                 // pull on the other one takes it over
    this._press = null;  // trigger held: a click until the hand moves, then a drag

    renderer.xr.enabled = true;
    createVRButton(renderer);

    this._sessionStartedAt = 0;

    // a dim floor grid, shown only in-session: proves rendering works and
    // gives scale/orientation even if the diorama is somewhere unexpected
    this.floor = new THREE.GridHelper(8, 16, 0x2e5f46, 0x1c2733);
    this.floor.visible = false;
    scene.add(this.floor);

    // lightsaber-style beam: a bright core inside a soft additive halo,
    // stretched each frame from the hand to the ray's hit on the board
    const makeBeamGeom = (radius) => {
      const g = new THREE.CylinderGeometry(radius, radius, 1, 10, 1, true);
      g.rotateX(-Math.PI / 2);   // align along -Z (the pointing direction)
      g.translate(0, 0, -0.5);   // spans z 0..-1, so scale.z = beam length
      return g;
    };
    const coreGeom = makeBeamGeom(0.0025);
    const glowGeom = makeBeamGeom(0.008);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xd8ffe2, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x36e06c, transparent: true, opacity: 0.28,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide,
    });
    const dotGeom = new THREE.SphereGeometry(0.009, 12, 8);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xb9ffcb, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
      depthTest: false, // impact dot stays visible on top of everything
    });
    const tipGeom = new THREE.SphereGeometry(0.014, 12, 8);
    // The hand marks are where your hands are, so nothing should cover them.
    // The toolbar draws with its depth test off, so a depth-tested marker
    // loses to it however near the hand is: they go on top by render order
    // instead, like the impact dot.
    // Marked transparent despite being solid: three draws every transparent
    // object after every opaque one, so an opaque marker would lose to the
    // toolbar's transparent handles whatever its render order. In the
    // transparent pass the order decides, which is the point. Both shapes are
    // convex and cull their back faces, so they need no depth test to look
    // right from any side.
    const tipMat = new THREE.MeshBasicMaterial({
      color: 0x6fce7e, transparent: true, depthTest: false, depthWrite: false,
    });
    this.controllers = [];
    for (let i = 0; i < 2; i++) {
      const c = renderer.xr.getController(i);
      c.userData.gripping = false;
      c.userData.beams = [
        new THREE.Mesh(coreGeom, coreMat),
        new THREE.Mesh(glowGeom, glowMat),
      ];
      for (const b of c.userData.beams) {
        b.scale.z = 4;
        c.add(b);
      }
      const tip = new THREE.Mesh(tipGeom, tipMat); // hand marker
      tip.renderOrder = VR_MARK_ORDER;
      c.add(tip);
      c.userData.dot = new THREE.Mesh(dotGeom, dotMat);
      // above everything the toolbar draws, handles included: the dot marks
      // where the beam lands, so it belongs on top of whatever it landed on
      c.userData.dot.renderOrder = VR_MARK_ORDER;
      c.userData.dot.visible = false;
      scene.add(c.userData.dot);
      // grip-space marker: a second visibility path in case the runtime
      // tracks grips but not target rays
      const grip = renderer.xr.getControllerGrip(i);
      const gripBox = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, 0.03, 0.06), tipMat);
      gripBox.renderOrder = VR_MARK_ORDER;
      grip.add(gripBox);
      scene.add(grip);
      c.userData.grip = grip;
      c.addEventListener("connected", (e) => {
        c.userData.handedness = e.data && e.data.handedness;
        console.log("[vr] controller connected:", e.data && e.data.handedness,
          e.data && e.data.targetRayMode);
      });
      c.addEventListener("disconnected", () => {
        c.userData.handedness = null;
        console.log("[vr] controller disconnected");
      });
      c.addEventListener("selectstart", () => this._onSelectStart(c));
      c.addEventListener("selectend", () => this._onSelectEnd(c));
      c.addEventListener("squeezestart", () => { c.userData.gripping = true; this._grabBaseline(); });
      c.addEventListener("squeezeend", () => { c.userData.gripping = false; this._grabBaseline(); });
      scene.add(c);
      this.controllers.push(c);
    }

    renderer.xr.addEventListener("sessionstart", () => {
      console.log("[vr] session started");
      this.floor.visible = true;
      this._sessionStartedAt = performance.now();
      // head pose is only valid once frames render; update() places then
      this._needsPlacement = true;
    });
    renderer.xr.addEventListener("sessionend", () => {
      console.log("[vr] session ended");
      this.floor.visible = false;
      this.resetDiorama();
    });
    this._recenterHeld = false;
  }

  /** A/X button (xr-standard button 4) on either controller = recenter:
   *  snap the diorama back to its session-start placement and scale. */
  _pollRecenter() {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    let pressed = false;
    for (const source of session.inputSources) {
      const b = source.gamepad && source.gamepad.buttons && source.gamepad.buttons[4];
      if (b && b.pressed) pressed = true;
    }
    if (pressed && !this._recenterHeld) {
      this.recenterNow();
    }
    this._recenterHeld = pressed;
  }

  get presenting() {
    return this.renderer.xr.isPresenting;
  }

  /** Live count of WebXR input sources (0 = no controllers delivered). */
  get inputSourceCount() {
    const session = this.renderer.xr.getSession();
    return session ? session.inputSources.length : 0;
  }

  _isIdentity(m) {
    const e = m.elements;
    return e[0] === 1 && e[5] === 1 && e[10] === 1 && e[15] === 1 &&
      e[12] === 0 && e[13] === 0 && e[14] === 0 &&
      e[1] === 0 && e[2] === 0 && e[4] === 0 && e[6] === 0 && e[8] === 0 && e[9] === 0;
  }

  /** Re-place the diorama using the most recent head pose. */
  recenterNow() {
    this._grab = null;
    this.hooks.placeDiorama(this._lastHeadPose);
  }

  resetDiorama() {
    this.dioramaRoot.position.set(0, 0, 0);
    this.dioramaRoot.rotation.set(0, 0, 0);
    this.dioramaRoot.scale.setScalar(1);
  }

  /**
   * The hand that points. Only the right carries a beam - two of them
   * crossing the board is noise when one does the job. A controller the
   * runtime will not name points as well, and so does a lone left one,
   * since otherwise nothing would.
   */
  _handPoints(hand) {
    if (!hand) return true;                     // unnamed by the runtime
    if (hand === this._pointerHand) return true;
    // the hand that should be pointing is not here, so this one does
    return !this.controllers.some(
      (o) => o.userData.handedness === this._pointerHand);
  }

  _isPointer(c) {
    return this._handPoints(c.userData.handedness);
  }

  _rayFrom(controller) {
    this._tempMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this._tempMatrix);
    return this.raycaster;
  }

  /**
   * A trigger on the hand that is not pointing takes the pointer over: pull
   * the left one and the beam moves to the left, the right one to bring it
   * back. That first pull only hands it over and does not act - until it had
   * the beam that hand was aiming at nothing the player could see, and a
   * blind click assigns a skill to whatever happened to be under it.
   *
   * Otherwise the pull opens a press, which becomes either a click or a drag
   * depending on whether the hand moves. Nothing happens yet: acting on the
   * pull would fire the click at the start of every drag.
   */
  _onSelectStart(controller) {
    if (!this.presenting) return;
    const hand = controller.userData.handedness;
    if (hand && hand !== this._pointerHand) {
      this._pointerHand = hand;
      this._aiming = null;
      this._press = null;
      return;
    }
    if (!this._isPointer(controller)) return;
    // a press that starts on the bar's move handle drags the bar, one on the
    // volume slider scrubs it, anything else drags the world
    const on = this.hooks.pickWithRaycaster(this._rayFrom(controller));
    const slider = !!(on && on.barTool === "volume");
    const bar = !!(on && on.barTool === "move");
    this._press = {
      c: controller,
      from: controller.getWorldPosition(new THREE.Vector3()),
      rootFrom: this.dioramaRoot.position.clone(),
      bar,
      slider,
      // a press on any other control answers to the release alone: a hand
      // that wanders while a button is held should not haul the board with it
      button: !!(on && on.barTool) && !bar && !slider,
      // a slider answers to the press itself and keeps answering as the hand
      // moves; counting it as a drag from the outset stops the release firing
      // it a second time
      dragging: slider,
    };
    if (slider) this.hooks.onSelectPick(on);
  }

  /** Release: a press that never turned into a drag is the click. */
  _onSelectEnd(controller) {
    const p = this._press;
    this._press = null;
    if (!p || p.c !== controller || p.dragging || !this.presenting) return;
    const pick = this.hooks.pickWithRaycaster(this._rayFrom(controller));
    if (pick) this.hooks.onSelectPick(pick);
  }

  /**
   * Trigger held and the hand moved: the board comes with it, all three axes,
   * so pulling the hand back walks the board in along Z as well as sliding it
   * about. A grip beats it - that is the deliberate two-handed grab - and
   * until the hand has moved past the threshold nothing happens, or no click
   * would ever survive the tremor of pulling a trigger.
   */
  _updateDrag() {
    const p = this._press;
    if (!p || this._grab) return;
    if (p.slider) {
      // follow the beam up and down the track for as long as it is held
      const on = this.hooks.pickWithRaycaster(this._rayFrom(p.c));
      if (on && on.barTool === "volume") this.hooks.onSelectPick(on);
      return;
    }
    if (p.button) return;
    const cur = p.c.getWorldPosition(new THREE.Vector3());
    const delta = cur.sub(p.from);
    if (!p.dragging && delta.length() < VR_DRAG_THRESHOLD) return;
    if (!p.dragging && p.bar && this.hooks.onBarDragStart) {
      this.hooks.onBarDragStart();
    }
    p.dragging = true;
    if (p.bar) {
      if (this.hooks.onBarDrag) this.hooks.onBarDrag(delta);
    } else {
      this.dioramaRoot.position.copy(p.rootFrom).add(delta);
    }
  }

  /** (Re)baseline the grab whenever the set of gripping controllers changes. */
  _grabBaseline() {
    const g = this.controllers.filter((c) => c.userData.gripping);
    if (g.length === 1) {
      this._grab = {
        mode: 1, c: g[0],
        cStart: g[0].getWorldPosition(new THREE.Vector3()),
        pStart: this.dioramaRoot.position.clone(),
      };
    } else if (g.length === 2) {
      const a = g[0].getWorldPosition(new THREE.Vector3());
      const b = g[1].getWorldPosition(new THREE.Vector3());
      this._grab = {
        mode: 2, ca: g[0], cb: g[1],
        d0: Math.max(a.distanceTo(b), 0.01),
        mid0: a.clone().add(b).multiplyScalar(0.5),
        s0: this.dioramaRoot.scale.x,
        pStart: this.dioramaRoot.position.clone(),
      };
    } else {
      this._grab = null;
    }
  }

  /**
   * The thumbsticks: the pointing hand's pans the board, the other tilts it -
   * the same two moves as right-drag and left-drag on the desktop. They
   * follow the beam, so handing it to the left hand brings pan with it and
   * sends tilt to the right, and the pointing thumb keeps the same job.
   *
   * xr-standard puts the stick on axes 2 and 3, leaving 0 and 1 for a
   * trackpad, but a device with no trackpad may report it at 0 and 1, so
   * take the pair the runtime actually gives. Its y runs negative away from
   * the player, the opposite of the arrow keys, so it is flipped to match.
   */
  _pollSticks(dt) {
    const session = this.renderer.xr.getSession();
    if (!session || !this.hooks.onStick || !dt) return;
    for (const source of session.inputSources) {
      const axes = source.gamepad && source.gamepad.axes;
      if (!axes || axes.length < 2) continue;
      const i = axes.length >= 4 ? 2 : 0;
      const dead = (v) => (Math.abs(v) < VR_STICK_DEADZONE ? 0 : v);
      const x = dead(axes[i] || 0), y = dead(axes[i + 1] || 0);
      if (!x && !y) continue;
      this.hooks.onStick(
        this._handPoints(source.handedness) ? "pan" : "tilt", x, -y, dt);
    }
  }

  /** Per-frame: grabs, recenter, thumbsticks, hover from the aiming hand. */
  update(dt) {
    if (!this.presenting) return;
    // the authoritative head pose comes from the XR frame (the user camera
    // only receives it during render, AFTER this update - placing from it on
    // the first frame would use the desktop pose, kilometers away). Fallback:
    // the XR camera rig, which three poses before our callback; an identity
    // matrix means it has no pose yet.
    let headPose = null;
    try {
      const frame = this.renderer.xr.getFrame ? this.renderer.xr.getFrame() : null;
      const refSpace = this.renderer.xr.getReferenceSpace();
      const vp = frame && refSpace ? frame.getViewerPose(refSpace) : null;
      if (vp) {
        const t = vp.transform;
        headPose = {
          pos: new THREE.Vector3(t.position.x, t.position.y, t.position.z),
          quat: new THREE.Quaternion(
            t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w),
        };
      }
    } catch (e) { /* pose not available yet */ }
    if (!headPose) {
      const xrCam = this.renderer.xr.getCamera();
      if (xrCam && !this._isIdentity(xrCam.matrixWorld)) {
        headPose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
        xrCam.matrixWorld.decompose(headPose.pos, headPose.quat, new THREE.Vector3());
      }
    }
    this._lastHeadPose = headPose;
    if (this._needsPlacement && headPose) {
      try {
        if (this.hooks.placeDiorama(headPose)) this._needsPlacement = false;
      } catch (e) {
        console.error("[vr] placement failed:", e);
        this._needsPlacement = false;
      }
    }
    this._pollRecenter();
    this._pollSticks(dt);
    this._updateDrag();
    const g = this._grab;
    if (g && g.mode === 1 && g.c.userData.gripping) {
      const cur = g.c.getWorldPosition(new THREE.Vector3());
      this.dioramaRoot.position.copy(g.pStart).add(cur.sub(g.cStart));
    } else if (g && g.mode === 2 && g.ca.userData.gripping && g.cb.userData.gripping) {
      const a = g.ca.getWorldPosition(new THREE.Vector3());
      const b = g.cb.getWorldPosition(new THREE.Vector3());
      const k = THREE.MathUtils.clamp(a.distanceTo(b) / g.d0, 0.15, 8);
      this.dioramaRoot.scale.setScalar(g.s0 * k);
      // keep the point that was between the hands under the hands
      const mid = a.add(b).multiplyScalar(0.5);
      this.dioramaRoot.position.copy(mid)
        .sub(g.mid0.clone().sub(g.pStart).multiplyScalar(k));
    }
    // with no input sources the mouse fallback owns the pointer: hide the
    // untracked controllers (their beams would sit at the origin) and do NOT
    // drive hover from controller 0 - it would stomp the mouse hover with
    // null every frame, hiding the highlight ring
    const hasControllers = this.inputSourceCount > 0;
    let aiming = null, aimingDist = Infinity;
    for (const c of this.controllers) {
      c.visible = hasControllers;
      if (c.userData.grip) c.userData.grip.visible = hasControllers;
      if (!hasControllers) {
        c.userData.dot.visible = false;
        continue;
      }
      // only the pointing hand carries a beam; the other keeps its marker
      // and its grip, and never aims at anything
      const pointer = this._isPointer(c);
      for (const b of c.userData.beams) b.visible = pointer;
      if (!pointer) {
        c.userData.dot.visible = false;
        continue;
      }
      // stretch each beam to its hit on the board/panel; park the dot there
      const hit = this.hooks.raycastHit
        ? this.hooks.raycastHit(this._rayFrom(c))
        : null;
      const len = hit ? Math.max(hit.distance, 0.05) : 4;
      for (const b of c.userData.beams) b.scale.z = len;
      c.userData.dot.visible = !!hit;
      if (hit) c.userData.dot.position.copy(hit.point);
      // the pointing hand drives the highlight while it is on the board; the
      // one already doing so keeps it, so a second pointer (an unnamed hand,
      // say) cannot take it away frame by frame
      if (!hit) continue;
      if (c === this._aiming) { aiming = c; aimingDist = -1; }
      else if (hit.distance < aimingDist) { aimingDist = hit.distance; aiming = c; }
    }

    // Hover comes from the hand that is aiming. Reading it from a fixed
    // controller meant that pointing with the other hand fed a miss every
    // frame: the beam landed on a lemming or a skill tile and neither the
    // ring nor the tile's pop-out ever appeared.
    if (hasControllers) {
      this._aiming = aiming;
      this.hooks.onHoverPick(aiming
        ? this.hooks.pickWithRaycaster(this._rayFrom(aiming)) : null);
    }
  }
}
