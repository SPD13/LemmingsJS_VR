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
const VR_VIEW_POSITION = new THREE.Vector3(0, 1.2, -0.9); // diorama focus point

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
  constructor(renderer, scene, dioramaRoot, hooks) {
    this.renderer = renderer;
    this.dioramaRoot = dioramaRoot;
    this.hooks = hooks;
    this.raycaster = new THREE.Raycaster();
    this._tempMatrix = new THREE.Matrix4();
    this._grab = null;

    renderer.xr.enabled = true;
    createVRButton(renderer);

    const rayGeom = new THREE.BufferGeometry().setFromPoints(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const rayMat = new THREE.LineBasicMaterial({ color: 0x6fce7e });
    this.controllers = [];
    for (let i = 0; i < 2; i++) {
      const c = renderer.xr.getController(i);
      c.userData.gripping = false;
      const line = new THREE.Line(rayGeom, rayMat);
      line.scale.z = 3;
      c.add(line);
      c.addEventListener("selectstart", () => this._onSelect(c));
      c.addEventListener("squeezestart", () => { c.userData.gripping = true; this._grabBaseline(); });
      c.addEventListener("squeezeend", () => { c.userData.gripping = false; this._grabBaseline(); });
      scene.add(c);
      this.controllers.push(c);
    }

    renderer.xr.addEventListener("sessionstart", () => this.hooks.placeDiorama());
    renderer.xr.addEventListener("sessionend", () => this.resetDiorama());
  }

  get presenting() {
    return this.renderer.xr.isPresenting;
  }

  resetDiorama() {
    this.dioramaRoot.position.set(0, 0, 0);
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

  /** Per-frame: apply grabs, drive hover from controller 0. */
  update() {
    if (!this.presenting) return;
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
    this.hooks.onHoverPick(this.hooks.pickWithRaycaster(this._rayFrom(this.controllers[0])));
  }
}
