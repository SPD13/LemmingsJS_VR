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
 *   by UV, lemmings via sim coordinates through CommandManager). A ray
 *   line is drawn from each controller; controller 0 also drives hover.
 * - Grip drags the diorama; both grips scale it about the hands' midpoint.
 *   The world itself never moves, so there is nothing to feel sick about.
 */

const VR_PIXEL_SCALE = 0.0025; // meters per game pixel (1600px level -> 4m)

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
        const session = await navigator.xr.requestSession("immersive-vr", {
          optionalFeatures: ["local-floor", "bounded-floor"],
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
   *  - placeDiorama()               -> position dioramaRoot for the headset
   */
  constructor(renderer, scene, camera, dioramaRoot, hooks) {
    this.renderer = renderer;
    this.dioramaRoot = dioramaRoot;
    this.hooks = hooks;
    this.raycaster = new THREE.Raycaster();
    this._tempMatrix = new THREE.Matrix4();
    this._grab = null;

    renderer.xr.enabled = true;
    createVRButton(renderer);

    // head-locked diagnostic board (children of the camera render head-locked;
    // the camera must be in the scene graph for that)
    scene.add(camera);
    this._diag = this._makeDiagBoard();
    camera.add(this._diag.mesh);
    this._diagFrame = 0;
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
    });
    const tipGeom = new THREE.SphereGeometry(0.014, 12, 8);
    const tipMat = new THREE.MeshBasicMaterial({ color: 0x6fce7e });
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
      c.add(new THREE.Mesh(tipGeom, tipMat)); // hand marker, always visible
      c.userData.dot = new THREE.Mesh(dotGeom, dotMat);
      c.userData.dot.visible = false;
      scene.add(c.userData.dot);
      // grip-space marker: a second visibility path in case the runtime
      // tracks grips but not target rays
      const grip = renderer.xr.getControllerGrip(i);
      grip.add(new THREE.Mesh(
        new THREE.BoxGeometry(0.03, 0.03, 0.06), tipMat));
      scene.add(grip);
      c.addEventListener("connected", (e) =>
        console.log("[vr] controller connected:", e.data && e.data.handedness,
          e.data && e.data.targetRayMode));
      c.addEventListener("disconnected", () =>
        console.log("[vr] controller disconnected"));
      c.addEventListener("selectstart", () => this._onSelect(c));
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
      this._grab = null;
      this.hooks.placeDiorama();
    }
    this._recenterHeld = pressed;
  }

  get presenting() {
    return this.renderer.xr.isPresenting;
  }

  _makeDiagBoard() {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 160;
    const texture = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.125),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.85 })
    );
    mesh.position.set(0, -0.22, -0.55); // just below the view center
    mesh.visible = false;
    return { canvas, texture, mesh, ctx: canvas.getContext("2d") };
  }

  /** Show what WebXR is actually reporting, inside the headset. */
  _updateDiagBoard() {
    const session = this.renderer.xr.getSession();
    const sources = session ? Array.from(session.inputSources) : [];
    // visible while controllers are missing, and for the first 8s regardless
    const show = this.presenting &&
      (sources.length === 0 || performance.now() - this._sessionStartedAt < 8000);
    this._diag.mesh.visible = show;
    if (!show || this._diagFrame++ % 30 !== 0) return;

    const { ctx, canvas, texture } = this._diag;
    ctx.fillStyle = "rgba(10, 14, 22, 0.9)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = "22px monospace";
    ctx.fillStyle = "#6fce7e";
    const lines = ["XR session active · input sources: " + sources.length];
    for (const src of sources) {
      lines.push(
        "· " + (src.handedness || "?") + " / " + src.targetRayMode +
        (src.gamepad ? " / pad " + src.gamepad.buttons.length + " btn" : " / no gamepad"));
    }
    if (sources.length === 0) {
      lines.push("no controllers detected —");
      lines.push("wake them / press any button");
      ctx.fillStyle = "#ffd866";
    }
    lines.forEach((l, i) => ctx.fillText(l, 14, 34 + i * 30));
    texture.needsUpdate = true;
  }

  resetDiorama() {
    this.dioramaRoot.position.set(0, 0, 0);
    this.dioramaRoot.rotation.set(0, 0, 0);
    this.dioramaRoot.scale.setScalar(1);
  }

  _rayFrom(controller) {
    this._tempMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this._tempMatrix);
    return this.raycaster;
  }

  _onSelect(controller) {
    if (!this.presenting) return;
    const pick = this.hooks.pickWithRaycaster(this._rayFrom(controller));
    if (pick) this.hooks.onSelectPick(pick);
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

  /** Per-frame: apply grabs, recenter button, hover from controller 0. */
  update() {
    if (!this.presenting) {
      this._diag.mesh.visible = false;
      return;
    }
    this._updateDiagBoard();
    if (this._needsPlacement) {
      try {
        if (this.hooks.placeDiorama()) this._needsPlacement = false;
      } catch (e) {
        console.error("[vr] placement failed:", e);
        this._needsPlacement = false;
      }
    }
    this._pollRecenter();
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
    // stretch each beam to its hit on the board/panel; park the dot there
    for (const c of this.controllers) {
      const hit = this.hooks.raycastHit
        ? this.hooks.raycastHit(this._rayFrom(c))
        : null;
      const len = hit ? Math.max(hit.distance, 0.05) : 4;
      for (const b of c.userData.beams) b.scale.z = len;
      c.userData.dot.visible = !!hit;
      if (hit) c.userData.dot.position.copy(hit.point);
    }

    this.hooks.onHoverPick(this.hooks.pickWithRaycaster(this._rayFrom(this.controllers[0])));
  }
}
