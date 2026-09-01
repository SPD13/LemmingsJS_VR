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
    scene.remove(session.worldGroup);
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
    scene.add(worldGroup);

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

    const gui = new GuiPanel(scene, game, resources);

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

  /** Ray hit against panel + gameplay plane; returns {panelUv} or {simX, simY}. */
  function pick(e) {
    if (!session) return null;
    raycaster.setFromCamera(ndcFromEvent(e), camera);
    const targets = [session.pickPlane];
    if (session.gui.mesh) targets.push(session.gui.mesh);
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    if (hit.object.name === "gui-panel") return { panelUv: hit.uv };
    const local = session.worldGroup.worldToLocal(hit.point.clone());
    return { simX: Math.round(local.x), simY: Math.round(local.y) };
  }

  let downAt = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    downAt = { x: e.clientX, y: e.clientY };
    const p = pick(e);
    if (p && p.panelUv) session.gui.onMouseDown(p.panelUv);
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    const p = pick(e);
    if (p && p.panelUv) session.gui.onMouseUp(p.panelUv);
    // treat as a click only if the pointer barely moved (else it was an orbit)
    if (!downAt || Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 5) return;
    if (p && p.simX !== undefined && session) {
      if (session.editor && session.editor.enabled) {
        session.editor.handleSimClick(p.simX, p.simY);
        return;
      }
      const lem = session.game.getLemmingManager().getLemmingAt(p.simX, p.simY);
      if (lem) session.game.queueCmmand(new Lemmings.CommandLemmingsAction(lem.id));
    }
  });
  renderer.domElement.addEventListener("dblclick", (e) => {
    const p = pick(e);
    if (p && p.panelUv) session.gui.onDoubleClick(p.panelUv);
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!session) return;
    const p = pick(e);
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

  function animate() {
    requestAnimationFrame(animate);
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
    controls.update();
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
  window.__lem3d = { state, camera, renderer, controls, library, get session() { return session; } };

  loadLevel().catch((err) => {
    hud.loading.textContent = "FAILED TO LOAD — see console";
    console.error(err);
  });
  animate();
})();
