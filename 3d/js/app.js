"use strict";
/**
 * Lemmings 3D validation mode: runs the untouched LemmingsJS simulation and
 * renders it as an extruded diorama with Three.js in a normal browser tab.
 * Same scene graph the VR build will use, orbit camera instead of a headset.
 *
 * URL params: ?type=1|2 (Lemmings / Oh No!), ?group=N, ?level=N, ?speed=N,
 *             ?replay=<string from the 'r' key dump>
 */

(function () {
  const LEMMING_Z = TERRAIN_DEPTH + 1.4;
  const OBJECT_Z = TERRAIN_DEPTH + 0.6;
  const OBJECT_BG_Z = -1.4;
  const OBJECT_DECAL_Z = TERRAIN_DEPTH + 0.25;

  window.__LEM3D_BUILD = "2026-08-31.4";
  console.log("[3d] build " + window.__LEM3D_BUILD);
  window.addEventListener("unhandledrejection", (e) => {
    console.warn("[3d] unhandled rejection:", e.reason,
      e.reason && e.reason.stack ? e.reason.stack : "(no stack)");
  });

  const params = new URLSearchParams(location.search);
  const state = {
    gameType: parseInt(params.get("type") || "1", 10),
    group: parseInt(params.get("group") || "0", 10),
    level: parseInt(params.get("level") || "0", 10),
    speed: parseFloat(params.get("speed") || "1"),
    replay: params.get("replay"),
  };

  const hud = {
    name: document.getElementById("level-name"),
    meta: document.getElementById("level-meta"),
    state: document.getElementById("game-state"),
    hover: document.getElementById("hud-hover"),
    loading: document.getElementById("loading"),
    pauseBtn: document.getElementById("btn-pause"),
  };

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById("view").appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141c);

  // everything game-sized lives under this root: identity on desktop
  // (1 unit = 1 game pixel), scaled to meters and placed in reach in VR
  const dioramaRoot = new THREE.Group();
  scene.add(dioramaRoot);

  const camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 1, 10000);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.maxDistance = 3000;

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const factory = new Lemmings.GameFactory("../");
  const raycaster = new THREE.Raycaster();

  // per-level session state, rebuilt on every level load
  let session = null;

  function disposeSession() {
    if (!session) return;
    try {
      if (session.game && session.game.getGameTimer()) session.game.stop();
    } catch (e) { /* already stopped */ }
    if (session.editor) session.editor.dispose();
    session.lemmingPool.dispose();
    session.objectPool.dispose();
    session.particles.dispose();
    session.terrain.dispose();
    session.gui.dispose();
    dioramaRoot.remove(session.worldGroup);
    session.resources.disposeAll();
    session = null;
  }

  async function loadLevel() {
    disposeSession();
    hud.loading.classList.remove("hidden");
    hud.state.textContent = "";
    hud.state.className = "";

    window.__lem3dGroundData = null; // cleared so a VGASPEC level can't reuse a stale piece list
    const game = await factory.getGame(state.gameType);
    await game.loadLevel(state.group, state.level);
    const level = game.level;

    // depth compositing (plan §5.1): per-tileset profile + per-pixel classes
    const config = await factory.getConfig(state.gameType);
    const groundData = window.__lem3dGroundData;
    let profile = null;
    let profileUrl = null;
    if (groundData && groundData.lr) {
      const slug = (config.path || "game").replace(/[^a-z0-9]/gi, "").toLowerCase();
      const setId = groundData.lr.graphicSet1 != null ? groundData.lr.graphicSet1 : 0;
      profileUrl = "profiles/" + slug + "-g" + setId + ".json";
      profile = await DepthProfiles.load(profileUrl);
    }
    const depthMap = buildDepthMap(level, groundData, profile);

    const resources = new SessionResources();

    // pixel-space group: x right, y down (like the sim); flipped into world
    const worldGroup = new THREE.Group();
    worldGroup.scale.y = -1;
    worldGroup.position.y = level.height;
    dioramaRoot.add(worldGroup);

    const terrain = new TerrainMesh(worldGroup, level, depthMap, resources);

    // dark backdrop behind the terrain so holes read as depth, not void
    const backdrop = new THREE.Mesh(
      resources.track(new THREE.PlaneGeometry(1, 1)),
      resources.track(new THREE.MeshBasicMaterial({ color: 0x05070c }))
    );
    backdrop.scale.set(level.width, level.height, 1);
    backdrop.position.set(level.width / 2, level.height / 2, -2);
    worldGroup.add(backdrop);

    // invisible plane the mouse ray hits to get sim coordinates
    const pickPlane = new THREE.Mesh(
      resources.track(new THREE.PlaneGeometry(1, 1)),
      resources.track(new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      }))
    );
    pickPlane.scale.set(level.width, level.height + 40, 1);
    pickPlane.position.set(level.width / 2, level.height / 2, LEMMING_Z);
    pickPlane.name = "pick-plane";
    worldGroup.add(pickPlane);

    // selection highlight ring
    const ring = new THREE.Mesh(
      resources.track(new THREE.RingGeometry(7, 9, 24)),
      resources.track(new THREE.MeshBasicMaterial({
        color: 0xffd866, side: THREE.DoubleSide,
      }))
    );
    ring.visible = false;
    ring.position.z = LEMMING_Z + 2;
    worldGroup.add(ring);

    const materialCache = new SpriteMaterialCache(resources);
    const lemmingPool = new BillboardPool(worldGroup, materialCache);
    const objectPool = new BillboardPool(worldGroup, materialCache);
    const particles = new ParticleCloud(worldGroup, LEMMING_Z + 1);
    const lemCapture = new SpriteCapture();
    const objCapture = new SpriteCapture();

    const gui = new GuiPanel(dioramaRoot, game, resources);

    if (state.replay) {
      game.getCommandManager().loadReplay(state.replay);
      state.replay = null;
    }

    // our per-tick bridge; registered after Game's own handler so it runs
    // after the sim step and GameGui render
    let lastTickTime = performance.now();
    game.getGameTimer().onGameTick.on(() => {
      lastTickTime = performance.now();

      objCapture.begin();
      game.objectManager.render(objCapture);
      objectPool.sync(objCapture.items, (layer) =>
        layer < 0 ? OBJECT_BG_Z : layer > 0 ? OBJECT_DECAL_Z : OBJECT_Z, false);

      lemCapture.begin();
      const lems = game.getLemmingManager().lemmings;
      for (let i = 0; i < lems.length; i++) {
        if (lems[i].removed) continue;
        lemCapture.tag = lems[i].id;
        lems[i].render(lemCapture);
      }
      lemmingPool.sync(lemCapture.items, () => LEMMING_Z, true);
      particles.sync(lemCapture.particles);

      terrain.flushDirty();
    });

    // Replace the timer's setInterval drive with our rAF accumulator (below):
    // browsers throttle setInterval hard in unfocused/occluded windows, and the
    // VR build needs a rAF-driven fixed step anyway. tick()/suspend semantics
    // and the 60ms fixed step are preserved; the sim code is untouched.
    const timer = game.getGameTimer();
    timer.suspend();
    timer.continue = function () { this.gameTimerHandler = 1; };
    timer.suspend = function () { this.gameTimerHandler = 0; };

    game.getGameTimer().speedFactor = state.speed;
    game.onGameEnd.on((result) => {
      const won = result.state === Lemmings.GameStateTypes.SUCCEEDED;
      hud.state.textContent = won
        ? "LEVEL COMPLETE — " + Lemmings.GameStateTypes.toString(result.state)
        : "FAILED — " + Lemmings.GameStateTypes.toString(result.state);
      hud.state.className = won ? "won" : "lost";
      window.setTimeout(() => {
        if (session && session.game === game) moveLevel(won ? 1 : 0);
      }, 3000);
    });
    game.start();

    // camera: frame the level's intended start position
    const startX = level.screenPositionX + 200;
    const targetY = level.height / 2;
    controls.target.set(startX, targetY, TERRAIN_DEPTH / 2);
    camera.position.set(startX, targetY + 120, 420);
    controls.update();
    gui.layout(startX);

    hud.name.textContent = level.name.trim() || "(unnamed level)";
    hud.meta.textContent =
      "type " + state.gameType + " · group " + state.group +
      " · level " + (state.level + 1) +
      " · save " + level.needCount + "/" + level.releaseCount;
    hud.loading.classList.add("hidden");

    session = {
      game, level, terrain, gui, worldGroup, pickPlane, ring,
      lemmingPool, objectPool, particles, resources, depthMap, profile,
      groundData, profileUrl,
      getLastTickTime: () => lastTickTime,
    };
    session.editor = new PieceEditor(session, profileUrl || "profiles/profile.json", timer);
    if (renderer.xr.isPresenting) placeDioramaForXR();
  }

  async function moveLevel(delta) {
    const config = await factory.getConfig(state.gameType);
    state.level += delta;
    if (state.level >= config.level.getGroupLength(state.group)) {
      state.group++; state.level = 0;
      if (state.group >= config.level.order.length) { state.group = 0; }
    } else if (state.level < 0) {
      state.group--;
      if (state.group < 0) { state.group = 0; state.level = 0; }
      else state.level = config.level.getGroupLength(state.group) - 1;
    }
    await loadLevel();
  }

  // ------------------------------------------------------------------ input
  function ndcFromEvent(e) {
    const r = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
  }

  /** Raw nearest hit on the interactive surfaces (gameplay plane, panel). */
  function raycastHit(rc) {
    if (!session) return null;
    const targets = [session.pickPlane];
    if (session.gui.mesh) targets.push(session.gui.mesh);
    const hits = rc.intersectObjects(targets, false);
    return hits.length ? hits[0] : null;
  }

  /** Ray hit against panel + gameplay plane; returns {panelUv} or {simX, simY}. */
  function pickWithRaycaster(rc) {
    const hit = raycastHit(rc);
    if (!hit) return null;
    if (hit.object.name === "gui-panel") return { panelUv: hit.uv };
    const local = session.worldGroup.worldToLocal(hit.point.clone());
    return { simX: Math.round(local.x), simY: Math.round(local.y) };
  }

  /** Mouse ray: desktop camera normally; inside a session, the XR eye camera
   *  so aiming at the headset's mirrored view on the monitor maps correctly. */
  function mouseRaycaster(e) {
    const ndc = ndcFromEvent(e);
    if (renderer.xr.isPresenting) {
      const xrCam = renderer.xr.getCamera();
      const eye = xrCam.cameras && xrCam.cameras.length ? xrCam.cameras[0] : xrCam;
      const projInv = new THREE.Matrix4().copy(eye.projectionMatrix).invert();
      const origin = new THREE.Vector3().setFromMatrixPosition(eye.matrixWorld);
      const target = new THREE.Vector3(ndc.x, ndc.y, 0.5)
        .applyMatrix4(projInv).applyMatrix4(eye.matrixWorld);
      raycaster.set(origin, target.sub(origin).normalize());
    } else {
      raycaster.setFromCamera(ndc, camera);
    }
    return raycaster;
  }

  function pick(e) {
    return pickWithRaycaster(mouseRaycaster(e));
  }

  /** True while a session runs without any controllers: mouse takes over. */
  function vrMouseFallback() {
    return renderer.xr.isPresenting && vr.inputSourceCount === 0;
  }

  // glowing in-headset dot showing where the desktop mouse is aiming
  const mouseCursor = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 12, 8),
    new THREE.MeshBasicMaterial({
      color: 0xffd866, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  mouseCursor.visible = false;
  scene.add(mouseCursor);

  // warning sign shown beside the play area when a session has no controllers
  const vrWarningSign = (() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 224;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(12, 16, 24, 0.92)";
    ctx.fillRect(0, 0, 512, 224);
    ctx.strokeStyle = "#ffd866";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 506, 218);
    ctx.fillStyle = "#ffd866";
    ctx.font = "bold 38px monospace";
    ctx.fillText("NO VR CONTROLLERS", 28, 62);
    ctx.fillStyle = "#cdd6e4";
    ctx.font = "26px monospace";
    ctx.fillText("Mouse fallback is active:", 28, 118);
    ctx.fillText("aim and click with the mouse", 28, 154);
    ctx.fillText("on the desktop window.", 28, 190);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(canvas), transparent: true,
      })
    );
    mesh.visible = false;
    dioramaRoot.add(mesh);
    return mesh;
  })();

  /** A confirmed activation on the play area (mouse click or VR trigger). */
  function actOnSimPick(simX, simY) {
    if (!session) return;
    if (session.editor && session.editor.enabled) {
      session.editor.handleSimClick(simX, simY);
      return;
    }
    const lem = session.game.getLemmingManager().getLemmingAt(simX, simY);
    if (lem) session.game.queueCmmand(new Lemmings.CommandLemmingsAction(lem.id));
  }

  /** Aiming feedback (mouse hover or VR controller ray). */
  function applyHover(p) {
    if (!session) return;
    if (p && p.simX !== undefined) {
      const lem = session.game.getLemmingManager().getLemmingAt(p.simX, p.simY);
      if (lem && lem.action) {
        session.ring.visible = true;
        session.ring.position.set(lem.x, lem.y - 5, LEMMING_Z + 2);
        hud.hover.textContent =
          "lemming " + lem.id + " — " + lem.action.getActionName();
        return;
      }
    }
    session.ring.visible = false;
    hud.hover.innerHTML = "&nbsp;";
  }

  // while a session has controllers, they own the pointer and stray desktop
  // mouse events are ignored; with none, the mouse is the pointer (fallback)
  const mouseAllowed = () => session &&
    (!renderer.xr.isPresenting || vrMouseFallback());

  let downAt = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (!mouseAllowed()) return;
    downAt = { x: e.clientX, y: e.clientY };
    const p = pick(e);
    if (p && p.panelUv) session.gui.onMouseDown(p.panelUv);
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!mouseAllowed()) return;
    const p = pick(e);
    if (p && p.panelUv) session.gui.onMouseUp(p.panelUv);
    // treat as a click only if the pointer barely moved (else it was an orbit)
    if (!downAt || Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 5) return;
    if (p && p.simX !== undefined) actOnSimPick(p.simX, p.simY);
  });
  renderer.domElement.addEventListener("dblclick", (e) => {
    if (!mouseAllowed()) return;
    const p = pick(e);
    if (p && p.panelUv) session.gui.onDoubleClick(p.panelUv);
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!mouseAllowed()) return;
    if (vrMouseFallback()) {
      const rc = mouseRaycaster(e);
      const hit = raycastHit(rc);
      mouseCursor.visible = !!hit;
      if (hit) mouseCursor.position.copy(hit.point);
      applyHover(hit ? pickWithRaycaster(rc) : null);
      return;
    }
    applyHover(pick(e));
  });

  // ------------------------------------------------------------------ WebXR
  /**
   * Place the diorama in front of the player's CURRENT head pose — position
   * and horizontal facing — not the reference-space origin (whose -Z axis
   * follows room calibration on PC VR and can point anywhere). Requires a
   * valid pose, so it runs on the first rendered XR frame, not sessionstart;
   * returns false to request a retry when the level isn't loaded yet.
   */
  // Some runtime/headset combos report a viewer pose whose forward axis is
  // rotated on Y (observed: 90° off on PSVR2 + SteamVR + Chrome). Applied to
  // the placement basis; tune live with the [ and ] keys, re-place with V.
  let vrYawCorrection = -Math.PI / 2;

  function placeDioramaForXR(headPose) {
    if (!session) return false;
    const s = VR_PIXEL_SCALE;
    const headPos = new THREE.Vector3();
    const headQuat = new THREE.Quaternion();
    if (headPose && headPose.pos) {
      headPos.copy(headPose.pos);
      headQuat.copy(headPose.quat);
    } else {
      // mid-session callers without a frame pose: the camera is valid by then
      camera.matrixWorld.decompose(headPos, headQuat, new THREE.Vector3());
    }
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    else fwd.normalize();
    fwd.applyAxisAngle(new THREE.Vector3(0, 1, 0), vrYawCorrection);

    // level face (+Z local) turns back toward the player
    dioramaRoot.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
    dioramaRoot.scale.setScalar(s);

    const startX = session.level.screenPositionX + 200;
    const focusLocal = new THREE.Vector3(
      startX, session.level.height / 2, TERRAIN_DEPTH / 2);
    const target = headPos.clone().addScaledVector(fwd, 0.9);
    target.y = Math.max(0.6, headPos.y - 0.35); // just below eye level
    dioramaRoot.position.copy(target)
      .sub(focusLocal.multiplyScalar(s).applyEuler(dioramaRoot.rotation));

    // park the no-controller warning above the play area, outside the level
    const signW = 230, signH = signW * 224 / 512;
    vrWarningSign.scale.set(signW, signH, 1);
    vrWarningSign.position.set(
      startX, session.level.height + signH / 2 + 30, 40);
    return true;
  }

  // desktop clip planes are in pixel units; in VR they are METERS, and the
  // diorama sits 0.9m away — near=1 would clip it entirely (black screen)
  const desktopClip = { near: camera.near, far: camera.far };
  renderer.xr.addEventListener("sessionstart", () => {
    camera.near = 0.05;
    camera.far = 300;
    camera.updateProjectionMatrix();
  });
  renderer.xr.addEventListener("sessionend", () => {
    camera.near = desktopClip.near;
    camera.far = desktopClip.far;
    camera.updateProjectionMatrix();
  });

  const vr = new VRManager(renderer, scene, camera, dioramaRoot, {
    pickWithRaycaster,
    raycastHit,
    onSelectPick: (p) => {
      if (p.panelUv && session) {
        session.gui.onMouseDown(p.panelUv);
        session.gui.onMouseUp(p.panelUv);
      } else if (p.simX !== undefined) {
        actOnSimPick(p.simX, p.simY);
      }
    },
    onHoverPick: applyHover,
    placeDiorama: placeDioramaForXR,
  });

  function togglePause() {
    if (!session) return;
    const timer = session.game.getGameTimer();
    timer.toggle();
    hud.pauseBtn.textContent = timer.isRunning() ? "pause" : "resume";
  }

  window.addEventListener("keydown", (e) => {
    if (!session) return;
    const timer = session.game.getGameTimer();
    switch (e.key) {
      case " ": e.preventDefault(); togglePause(); break;
      case "n": if (!timer.isRunning()) timer.tick(); break;
      case "+": case "=": timer.speedFactor = Math.min(10, timer.speedFactor + 1); break;
      case "-": timer.speedFactor = Math.max(0.5, timer.speedFactor - 0.5); break;
      case ",": moveLevel(-1); break;
      case ".": moveLevel(1); break;
      case "e":
        if (session.editor) session.editor.toggle();
        break;
      case "v":
        if (renderer.xr.isPresenting) vr.recenterNow();
        break;
      case "[":
      case "]":
        vrYawCorrection += (e.key === "]" ? 1 : -1) * (Math.PI / 12);
        console.log("[vr] yaw correction: " +
          Math.round(vrYawCorrection * 180 / Math.PI) + "°");
        if (renderer.xr.isPresenting) vr.recenterNow();
        break;
      case "w":
        window.__lem3d.library.toggle();
        break;
      case "Escape":
        window.__lem3d.library.close();
        break;
      case "c":
        if (session.editor && session.editor.enabled) session.editor.cycleClass();
        break;
      case "r":
        console.log("replay string (append as ?replay=... to reproduce this run):");
        console.log(session.game.getCommandManager().serialize());
        break;
    }
  });

  document.getElementById("btn-prev").addEventListener("click", () => moveLevel(-1));
  document.getElementById("btn-next").addEventListener("click", () => moveLevel(1));
  document.getElementById("btn-restart").addEventListener("click", () => moveLevel(0));
  hud.pauseBtn.addEventListener("click", togglePause);

  // ------------------------------------------------------------ render loop
  // The sim keeps its own fixed 60ms clock (GameTimer, untouched); we render
  // at display rate and interpolate lemming positions between ticks.
  let lastFrameTime = performance.now();
  let tickDebt = 0;
  let loopErrorLogged = false;

  function animate() {
    try {
      animateBody();
    } catch (err) {
      // never let one bad frame kill the loop (in VR that means a black void)
      if (!loopErrorLogged) {
        loopErrorLogged = true;
        console.error("[3d] render loop error:", err);
        hud.state.textContent = "RENDER ERROR — see console";
        hud.state.className = "lost";
      }
    }
  }

  function animateBody() {
    const now = performance.now();
    const dt = now - lastFrameTime;
    lastFrameTime = now;

    if (session) {
      const timer = session.game.getGameTimer();
      let alpha = 1;
      if (timer && timer.isRunning()) {
        const tickMs = timer.TIME_PER_FRAME_MS / timer.speedFactor;
        // fixed-step sim, capped catch-up so a stalled frame can't spiral
        tickDebt = Math.min(tickDebt + dt, tickMs * 5);
        while (tickDebt >= tickMs && timer.isRunning()) {
          timer.tick();
          tickDebt -= tickMs;
        }
        alpha = Math.min(1, (now - session.getLastTickTime()) / tickMs);
      } else {
        tickDebt = 0;
      }
      session.lemmingPool.applyInterpolation(alpha);
      session.gui.update();
    }
    if (renderer.xr.isPresenting) {
      vr.update(); // controller grabs + hover; headset pose drives the camera
      vrWarningSign.visible = vrMouseFallback();
    } else {
      controls.update();
      vrWarningSign.visible = false;
    }
    if (!vrMouseFallback()) mouseCursor.visible = false;
    renderer.render(scene, camera);
  }

  // world library: catalog of tilesets, click-to-enter for tagging sessions
  const library = new WorldLibrary(factory, async (gameType, group, level) => {
    state.gameType = gameType;
    state.group = group;
    state.level = level;
    await loadLevel();
    if (session && session.editor) session.editor.enable();
  });
  document.getElementById("btn-library").addEventListener("click", () => library.toggle());

  // debug handle for the console / automated checks
  window.__lem3d = {
    state, camera, renderer, controls, library, vr, dioramaRoot, placeDioramaForXR,
    get session() { return session; },
  };

  loadLevel().catch((err) => {
    hud.loading.textContent = "FAILED TO LOAD — see console";
    console.error(err);
  });
  // setAnimationLoop instead of window rAF: inside an XR session the
  // headset's frame loop (90Hz) drives the same fixed-step accumulator
  renderer.setAnimationLoop(animate);
})();
