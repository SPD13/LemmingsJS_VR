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
  // lemmings live embedded mid-slab (sprite centered at TERRAIN_DEPTH/2), so
  // they walk inside the carved space rather than floating in front of it;
  // normal objects (hatch/exit/traps) sit just behind them at the same depth
  const LEMMING_Z = TERRAIN_DEPTH / 2 - SPRITE_DEPTH / 2;
  const OBJECT_Z = LEMMING_Z - 0.8;
  const OBJECT_BG_Z = -1.4;
  const OBJECT_DECAL_Z = TERRAIN_DEPTH + 0.25;

  window.__LEM3D_BUILD = "2026-08-31.4";
  console.log("[3d] build " + window.__LEM3D_BUILD);
  window.addEventListener("unhandledrejection", (e) => {
    console.warn("[3d] unhandled rejection:", e.reason,
      e.reason && e.reason.stack ? e.reason.stack : "(no stack)");
  });

  const params = new URLSearchParams(location.search);
  /**
   * A render setting: the URL first, then what was last toggled here.
   *
   * These are toggled with DOM buttons, which are invisible inside a headset,
   * and the headset is usually not the machine they were toggled on - its
   * browser has its own empty localStorage. Without the URL there is no way
   * to ask the VR build for smoothed terrain at all.
   */
  const setting = (name, key, dflt) => {
    if (params.has(name)) {
      const v = params.get(name).toLowerCase();
      return v === "" || v === "1" || v === "on" || v === "true" || v === "yes";
    }
    let stored = null;
    try { stored = localStorage.getItem(key); } catch (e) {}
    if (stored === "on") return true;
    if (stored === "off") return false;
    return dflt;
  };
  const state = {
    emboss: setting("emboss", "lem3d-emboss", false), // colour-keyed relief
    smooth: setting("smooth", "lem3d-smooth", false), // slope between heights
    doors: setting("doors", "lem3d-doors", true),     // openings, on by default
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
  // the skill toolbar rides the camera instead of the level, so it stays in
  // view while the play area is panned, orbited, zoomed or grabbed
  scene.add(camera); // children of the camera render only once it is in the graph
  const guiRoot = new THREE.Group();
  camera.add(guiRoot);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.maxDistance = 3000;

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    layoutGuiPanel(); // the toolbar is sized to the viewport
  });

  const factory = new Lemmings.GameFactory("../");
  const raycaster = new THREE.Raycaster();

  const audio = new GameAudio();
  const audioResources = {}; // one GameResources per game type for ADLIB data
  const soundBtn = document.getElementById("btn-sound");
  const renderSoundBtn = () => {
    soundBtn.textContent = "sound: " + (audio.enabled ? "on" : "off");
  };
  soundBtn.addEventListener("click", () => {
    audio.setEnabled(!audio.enabled);
    renderSoundBtn();
    if (audio.enabled && session) audio.playMusic(session.musicTrack || 0);
  });
  renderSoundBtn();

  // master switch for colour-keyed terrain relief (per-piece tags in the editor)
  const embossBtn = document.getElementById("btn-emboss");
  const renderEmbossBtn = () => {
    embossBtn.textContent = "3D terrain: " + (state.emboss ? "on" : "off");
  };
  embossBtn.addEventListener("click", () => {
    state.emboss = !state.emboss;
    try { localStorage.setItem("lem3d-emboss", state.emboss ? "on" : "off"); } catch (e) {}
    renderEmbossBtn();
    if (session) session.rebuildRelief();
  });
  renderEmbossBtn();

  // entrances and exits as real openings rather than flat sprites. The
  // opening carves the terrain behind it as the level is built, so unlike the
  // relief this cannot be swapped in place - the level is rebuilt.
  const doorsBtn = document.getElementById("btn-doors");
  const renderDoorsBtn = () => {
    doorsBtn.textContent = "3D doors: " + (state.doors ? "on" : "off");
  };
  doorsBtn.addEventListener("click", () => {
    state.doors = !state.doors;
    try { localStorage.setItem("lem3d-doors", state.doors ? "on" : "off"); } catch (e) {}
    renderDoorsBtn();
    loadLevel().catch((err) => console.error(err));
  });
  renderDoorsBtn();

  // slope the relief between heights instead of stepping
  const smoothBtn = document.getElementById("btn-smooth");
  const renderSmoothBtn = () => {
    smoothBtn.textContent = "smooth: " + (state.smooth ? "on" : "off");
  };
  smoothBtn.addEventListener("click", () => {
    state.smooth = !state.smooth;
    try { localStorage.setItem("lem3d-smooth", state.smooth ? "on" : "off"); } catch (e) {}
    renderSmoothBtn();
    if (session) session.terrain.setSmooth(state.smooth);
  });
  renderSmoothBtn();

  audio.configureSpatial({
    isActive: () => renderer.xr.isPresenting,
    getListenerMatrix: () => camera.matrixWorld,
  });

  /** World-space emitter position for a sim coordinate (VR spatial SFX). */
  function sfxPos(simX, simY) {
    if (!session) return null;
    session.worldGroup.updateWorldMatrix(true, false);
    return session.worldGroup.localToWorld(
      new THREE.Vector3(simX, simY, LEMMING_Z));
  }

  // per-level session state, rebuilt on every level load
  let session = null;

  function disposeSession() {
    if (!session) return;
    try {
      if (session.game && session.game.getGameTimer()) session.game.stop();
    } catch (e) { /* already stopped */ }
    audio.stopAll();
    if (session.editor) session.editor.dispose();
    session.lemmingPool.dispose();
    session.objectPool.dispose();
    session.particles.dispose();
    session.terrain.dispose();
    session.gui.dispose();
    dioramaRoot.remove(session.worldGroup);
    session.resources.disposeAll();
    session = null;
    hoveredLemming = null;
    cursorSim = null;
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
    const pieceMap = buildPieceMap(level, groundData);
    const reliefMap = buildReliefMap(level, pieceMap, profile, state.emboss);
    // entrances/exits become real openings; this also carves the terrain
    // behind them (render only - collision is untouched). Switched off, they
    // stay the flat sprites the original draws and nothing is carved.
    const portals = state.doors
      ? buildPortals(level, profile, depthMap, OBJECT_Z) : [];
    const portalIndices = new Set(portals.map((p) => p.index));

    // music: the original rotates tunes with the level ordinal
    if (!audioResources[state.gameType]) {
      audioResources[state.gameType] = await factory.getGameResources(state.gameType);
    }
    audio.setResources(audioResources[state.gameType], config);
    const musicTrack = state.group * 30 + state.level;
    audio.playMusic(musicTrack);

    const resources = new SessionResources();

    // pixel-space group: x right, y down (like the sim); flipped into world
    const worldGroup = new THREE.Group();
    worldGroup.scale.y = -1;
    worldGroup.position.y = level.height;
    dioramaRoot.add(worldGroup);

    const terrain = new TerrainMesh(worldGroup, level, depthMap, reliefMap, resources);
    if (state.smooth) terrain.setSmooth(true);

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
        depthTest: false, // highlight reads on top of the embedded slab
      }))
    );
    ring.renderOrder = 19;
    ring.visible = false;
    ring.position.z = LEMMING_Z + 2;
    worldGroup.add(ring);

    const materialCache = new SpriteMaterialCache(resources);

    // openings: recessed geometry, textured with the object's current frame
    for (const portal of portals) {
      resources.track(portal.geometry);
      portal.mesh = new THREE.Mesh(portal.geometry,
        materialCache.forFrame(portal.animation.frames[0]).material);
      portal.mesh.position.set(portal.originX, portal.originY, OBJECT_Z);
      worldGroup.add(portal.mesh);

      // hatch flaps: flat doors hinged on the opening's left and right edges,
      // textured from the closed frame so they carry the door's own artwork
      if (portal.hatch) {
        const h = portal.hatch;
        const material = materialCache.forFrame(portal.closedFrame).material;
        portal.flaps = [
          { sign: 1, x: h.leftX },
          { sign: -1, x: h.rightX },
        ].map((side) => {
          const geom = resources.track(buildFlapGeometry(
            portal.closedFrame, h.doorRows, h.halfWidth, h.depth, side.sign));
          const mesh = new THREE.Mesh(geom, material);
          mesh.position.set(portal.originX + side.x, portal.originY + h.y, OBJECT_Z);
          worldGroup.add(mesh);
          return { mesh, sign: side.sign };
        });
      }
    }
    const lemmingPool = new BillboardPool(worldGroup, materialCache);
    const objectPool = new BillboardPool(worldGroup, materialCache);
    const particles = new ParticleCloud(worldGroup, LEMMING_Z + 1);
    const lemCapture = new SpriteCapture();
    const objCapture = new SpriteCapture();

    const gui = new GuiPanel(guiRoot, game, resources);

    if (state.replay) {
      game.getCommandManager().loadReplay(state.replay);
      state.replay = null;
    }

    // our per-tick bridge; registered after Game's own handler so it runs
    // after the sim step and GameGui render
    let lastTickTime = performance.now();
    const prevActions = new Map(); // lemming id -> action name, for SFX cues
    game.getGameTimer().onGameTick.on(() => {
      lastTickTime = performance.now();

      objCapture.begin();
      game.objectManager.render(objCapture);
      // objects drawn as openings have their own geometry: drop the flat copy
      // (ObjectManager emits exactly one draw per object, in list order) and
      // keep their texture in step with the animation
      const objectItems = portalIndices.size === 0 ? objCapture.items
        : objCapture.items.filter((_, i) => !portalIndices.has(i));
      if (portalIndices.size > 0) {
        const tick = game.getGameTimer().getGameTicks();
        for (const portal of portals) {
          const frame = portal.animation.getFrame(tick);
          // A hatch keeps the open frame on its ceiling square: the doors are
          // real geometry now, so following the animation there would leave
          // the painted ones lying in the opening as the real ones swing.
          if (frame && !portal.hatch) {
            portal.mesh.material = materialCache.forFrame(frame).material;
          }
          if (!portal.flaps || !portal.openness) continue;
          // swing the doors by however far this frame has the hatch open
          const frames = portal.animation.frames;
          const idx = Math.max(0, frames.indexOf(frame));
          const angle = (portal.openness[idx] || 0) * Math.PI / 2;
          for (const flap of portal.flaps) {
            flap.mesh.rotation.z = flap.sign * angle;
          }
        }
      }
      objectPool.sync(objectItems, (layer) =>
        layer < 0 ? OBJECT_BG_Z : layer > 0 ? OBJECT_DECAL_Z : OBJECT_Z, false);

      lemCapture.begin();
      const lems = game.getLemmingManager().lemmings;
      let tickSfx = null; // at most one effect per tick (nuke-proofing)
      for (let i = 0; i < lems.length; i++) {
        const lem = lems[i];
        const action = lem.removed || !lem.action ? null : lem.action.getActionName();
        if (action !== prevActions.get(lem.id)) {
          prevActions.set(lem.id, action);
          if (action && SFX_BY_ACTION[action] != null) {
            tickSfx = { sfx: SFX_BY_ACTION[action], x: lem.x, y: lem.y };
          }
        }
        if (lem.removed) continue;
        lemCapture.tag = lem.id;
        lem.render(lemCapture);
      }
      if (tickSfx != null) audio.playSfx(tickSfx.sfx, sfxPos(tickSfx.x, tickSfx.y));
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
    frameDesktopCamera(level);

    hud.name.textContent = level.name.trim() || "(unnamed level)";
    hud.meta.textContent =
      "type " + state.gameType + " · group " + state.group +
      " · level " + (state.level + 1) +
      " · save " + level.needCount + "/" + level.releaseCount;
    hud.loading.classList.add("hidden");

    session = {
      game, level, terrain, gui, worldGroup, pickPlane, ring,
      lemmingPool, objectPool, particles, resources, depthMap, profile,
      groundData, profileUrl, musicTrack, pieceMap,
      getLastTickTime: () => lastTickTime,
      // re-derive the colour-keyed relief (master switch or a per-piece tag)
      rebuildRelief: () => {
        session.terrain.setRelief(
          buildReliefMap(level, pieceMap, session.profile, state.emboss));
      },
    };
    session.editor = new PieceEditor(session, profileUrl || "profiles/profile.json", timer);
    layoutGuiPanel();
    if (renderer.xr.isPresenting) placeDioramaForXR();

    const entrance = level.entrances[0];
    audio.playSfx(SFX.LETSGO,
      entrance ? sfxPos(entrance.x + 24, entrance.y + 14) : null);
  }

  /** Park the toolbar in camera space: bottom-centre of the view on desktop,
   *  a comfortable HUD panel below the line of sight in VR. */
  function layoutGuiPanel() {
    if (!session || !session.gui) return;
    if (renderer.xr.isPresenting) {
      session.gui.place(VR_GUI_WIDTH, VR_GUI_Y, VR_GUI_Z); // metres
    } else {
      const dist = 600;
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const viewH = 2 * dist * tanHalf;
      const width = viewH * camera.aspect * 0.55;
      const height = width * session.gui.canvas.height / session.gui.canvas.width;
      // A hovered button is grown and moved toward the camera, so it reaches
      // lower on screen than the panel does: sit the panel high enough that
      // the raised button still clears the bottom edge.
      const pop = GUI_TILE_POP * (width / session.gui.canvas.width);
      const tileBottom = session.gui.raisedTileBottomOffset() * height;
      const y = -(dist - pop) * tanHalf + tileBottom + height * 0.04; // + slack
      session.gui.place(width, y, -dist);
    }
  }

  /** Default desktop framing: the level's intended start area, slightly above. */
  function frameDesktopCamera(level) {
    const startX = level.screenPositionX + 200;
    const targetY = level.height / 2;
    controls.target.set(startX, targetY, TERRAIN_DEPTH / 2);
    camera.position.set(startX, targetY + 120, 420);
    controls.update();
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

  /** Raw nearest hit on the interactive surfaces (toolbar, gameplay plane).
   *  The toolbar is a fixed overlay in front of the viewer, so it takes
   *  priority over the play area behind it regardless of distance. */
  function raycastHit(rc) {
    if (!session) return null;
    if (session.gui.mesh) {
      const guiHits = rc.intersectObject(session.gui.mesh, false);
      if (guiHits.length) return guiHits[0];
    }
    const hits = rc.intersectObject(session.pickPlane, false);
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
      depthTest: false, // pointer stays visible on top of everything
    })
  );
  mouseCursor.renderOrder = 20;
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
    if (lem) {
      session.game.queueCmmand(new Lemmings.CommandLemmingsAction(lem.id));
      audio.playSfx(SFX.ASSIGN, sfxPos(lem.x, lem.y));
    }
  }

  // Sticky hover: once a lemming is acquired, the yellow ring follows it as
  // it walks, releasing only when the circle has moved off the pointer's
  // position (or the lemming is gone). Shared by mouse, controller ray, and
  // the VR mouse-fallback - they all feed applyHover.
  const HOVER_RING_RADIUS = 9; // matches the ring geometry's outer radius
  let hoveredLemming = null;
  let cursorSim = null;

  /** Aiming feedback (mouse hover or VR controller ray). */
  function applyHover(p) {
    if (!session) return;
    session.gui.setHover(p && p.panelUv ? p.panelUv : null);
    if (p && p.simX !== undefined) {
      cursorSim = { x: p.simX, y: p.simY };
      const lem = session.game.getLemmingManager().getLemmingAt(p.simX, p.simY);
      if (lem && lem.action) hoveredLemming = lem;
    } else {
      cursorSim = null;
    }
    updateHoverRing();
  }

  /** Per-frame: track the hovered lemming, release when it escapes the cursor. */
  function updateHoverRing() {
    if (!session) return;
    let lem = hoveredLemming;
    if (lem && (lem.removed || !lem.action)) lem = null;
    if (lem && cursorSim) {
      const dx = lem.x - cursorSim.x;
      const dy = (lem.y - 5) - cursorSim.y;
      if (dx * dx + dy * dy > HOVER_RING_RADIUS * HOVER_RING_RADIUS) lem = null;
    }
    if (!cursorSim) lem = null;
    hoveredLemming = lem;
    if (lem) {
      session.ring.visible = true;
      session.ring.position.set(lem.x, lem.y - 5, LEMMING_Z + 2);
      hud.hover.textContent =
        "lemming " + lem.id + " — " + lem.action.getActionName();
    } else {
      session.ring.visible = false;
      hud.hover.innerHTML = "&nbsp;";
    }
  }

  // while a session has controllers, they own the pointer and stray desktop
  // mouse events are ignored; with none, the mouse is the pointer (fallback)
  const mouseAllowed = () => session &&
    (!renderer.xr.isPresenting || vrMouseFallback());

  let downAt = null;
  let mouseCursorOnBoard = false;
  let vrPan = null;   // right-drag pan state in VR mouse-fallback
  let vrOrbit = null; // left-drag rotate state in VR mouse-fallback
  let rightDownAt = null; // for right-double-click detection (no native event)
  let lastRightClickAt = 0;

  /** World position of the level's focus point (the wheel/orbit pivot). */
  function dioramaFocusWorld() {
    const startX = session.level.screenPositionX + 200;
    return dioramaRoot.localToWorld(new THREE.Vector3(
      startX, session.level.height / 2, TERRAIN_DEPTH / 2));
  }

  /** Rotate the diorama by q about a fixed world pivot. */
  function rotateDioramaAroundPivot(q, pivot) {
    dioramaRoot.quaternion.premultiply(q);
    dioramaRoot.position.sub(pivot).applyQuaternion(q).add(pivot);
  }

  /**
   * Scale the diorama about a fixed world pivot, so whatever is under that
   * point stays under it. The position has to be moved from where it is,
   * which means never writing it before reading it.
   */
  function scaleDioramaAbout(next, pivot) {
    const k = next / dioramaRoot.scale.x;
    dioramaRoot.scale.setScalar(next);
    dioramaRoot.position.sub(pivot).multiplyScalar(k).add(pivot);
  }

  // OrbitControls suppresses the context menu only while enabled (desktop);
  // in a session the right button belongs to our pan
  renderer.domElement.addEventListener("contextmenu", (e) => {
    if (renderer.xr.isPresenting) e.preventDefault();
  });

  // wheel in VR mouse-fallback: zoom the diorama toward the cursor's point
  // on the board (desktop wheel zoom stays with OrbitControls)
  renderer.domElement.addEventListener("wheel", (e) => {
    if (!vrMouseFallback() || !session) return;
    e.preventDefault();
    const cur = dioramaRoot.scale.x;
    const next = THREE.MathUtils.clamp(
      cur * Math.pow(0.998, e.deltaY),
      VR_PIXEL_SCALE * 0.15, VR_PIXEL_SCALE * 8);
    scaleDioramaAbout(next, mouseCursorOnBoard
      ? mouseCursor.position.clone()
      : dioramaFocusWorld());
  }, { passive: false });

  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (!mouseAllowed()) return;
    if (e.button === 2) rightDownAt = { x: e.clientX, y: e.clientY };
    if (e.button === 2 && vrMouseFallback()) {
      // right-drag = pan, as in the web view: grab the point under the
      // cursor on the board's plane and slide the diorama with it
      const rc = mouseRaycaster(e);
      const hit = raycastHit(rc);
      const point = hit ? hit.point.clone()
        : mouseCursor.visible ? mouseCursor.position.clone() : null;
      if (point) {
        const normal = new THREE.Vector3(0, 0, 1).applyEuler(dioramaRoot.rotation);
        vrPan = {
          plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point),
          last: point,
        };
      }
      return;
    }
    if (e.button !== 0) return;
    downAt = { x: e.clientX, y: e.clientY };
    if (vrMouseFallback()) {
      // left-drag = orbit, as in the web view: rotates the diorama about
      // its focus point; a barely-moved press stays a click
      vrOrbit = { lastX: e.clientX, lastY: e.clientY,
                  pivot: dioramaFocusWorld(), active: false };
    }
    const p = pick(e);
    if (p && p.panelUv) session.gui.onMouseDown(p.panelUv);
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (e.button === 2) {
      vrPan = null;
      // double right-click (no drag) = reset the view to its default
      const dragged = !rightDownAt ||
        Math.abs(e.clientX - rightDownAt.x) + Math.abs(e.clientY - rightDownAt.y) > 5;
      if (!dragged) {
        const now = performance.now();
        if (now - lastRightClickAt < 400) {
          lastRightClickAt = 0;
          if (renderer.xr.isPresenting) {
            if (vrMouseFallback()) vr.recenterNow();
          } else if (session) {
            frameDesktopCamera(session.level);
          }
        } else {
          lastRightClickAt = now;
        }
      }
      return;
    }
    if (e.button === 0) vrOrbit = null;
    if (!mouseAllowed() || e.button !== 0) return;
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
      if (vrPan) {
        // slide the diorama so the grabbed board point follows the cursor
        const p = new THREE.Vector3();
        if (rc.ray.intersectPlane(vrPan.plane, p)) {
          dioramaRoot.position.add(p.clone().sub(vrPan.last));
          vrPan.last = p;
        }
        return;
      }
      if (vrOrbit && (e.buttons & 1)) {
        const dx = e.clientX - vrOrbit.lastX;
        const dy = e.clientY - vrOrbit.lastY;
        if (!vrOrbit.active && downAt &&
            Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 5) {
          vrOrbit.active = true;
        }
        if (vrOrbit.active) {
          const up = new THREE.Vector3(0, 1, 0);
          rotateDioramaAroundPivot(
            new THREE.Quaternion().setFromAxisAngle(up, dx * 0.005), vrOrbit.pivot);
          const right = new THREE.Vector3()
            .setFromMatrixColumn(camera.matrixWorld, 0);
          right.y = 0;
          if (right.lengthSq() > 1e-4) {
            right.normalize();
            rotateDioramaAroundPivot(
              new THREE.Quaternion().setFromAxisAngle(right, dy * 0.005), vrOrbit.pivot);
          }
        }
        vrOrbit.lastX = e.clientX;
        vrOrbit.lastY = e.clientY;
        if (vrOrbit.active) return;
      }
      const hit = raycastHit(rc);
      // always render the cursor so it can be steered back onto the board:
      // yellow at the hit point, dimmed mid-air along the ray when off it
      mouseCursor.visible = true;
      mouseCursorOnBoard = !!hit;
      if (hit) {
        mouseCursor.position.copy(hit.point);
        mouseCursor.material.color.setHex(0xffd866);
      } else {
        mouseCursor.position.copy(rc.ray.origin)
          .addScaledVector(rc.ray.direction, 1.5);
        mouseCursor.material.color.setHex(0x8fa1bb);
      }
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
  // Yaw correction applied to the reported viewer pose. Live calibration on
  // PSVR2 + SteamVR + Chrome settled on 0 - the pose is trustworthy; earlier
  // apparent offsets were placement-race artifacts. Kept (with the [ ] tuning
  // keys, V to re-place) in case another runtime ever reports a rotated axis.
  let vrYawCorrection = 0;

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
    target.y = Math.max(0.7, headPos.y - 0.15); // just below eye level
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
    // OrbitControls would silently accumulate wheel/drag input during the
    // session and apply it as a jump on exit
    controls.enabled = false;
    layoutGuiPanel();
  });
  renderer.xr.addEventListener("sessionend", () => {
    camera.near = desktopClip.near;
    camera.far = desktopClip.far;
    camera.updateProjectionMatrix();
    // the session leaves the camera at the last headset pose (meter-scale,
    // near the scene origin); restore the page-load framing
    controls.enabled = true;
    if (session) frameDesktopCamera(session.level);
    layoutGuiPanel();
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
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        const dx = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        const dy = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
        if (e.shiftKey) {
          // shift+arrows = orbit (10 degrees per press)
          const step = Math.PI / 18;
          if (renderer.xr.isPresenting) {
            const pivot = dioramaFocusWorld();
            const up = new THREE.Vector3(0, 1, 0);
            rotateDioramaAroundPivot(
              new THREE.Quaternion().setFromAxisAngle(up, dx * step), pivot);
            const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
            right.y = 0;
            if (right.lengthSq() > 1e-4) {
              rotateDioramaAroundPivot(
                new THREE.Quaternion().setFromAxisAngle(right.normalize(), dy * step), pivot);
            }
          } else {
            const offset = camera.position.clone().sub(controls.target);
            const spherical = new THREE.Spherical().setFromVector3(offset);
            spherical.theta -= dx * step;
            spherical.phi = THREE.MathUtils.clamp(
              spherical.phi - dy * step, 0.05, Math.PI - 0.05);
            camera.position.copy(controls.target)
              .add(offset.setFromSpherical(spherical));
            controls.update();
          }
          break;
        }
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        if (renderer.xr.isPresenting) {
          // the camera is the headset; shift the diorama the opposite way
          const step = 0.12; // meters per press
          dioramaRoot.position
            .sub(right.multiplyScalar(dx * step))
            .sub(up.multiplyScalar(dy * step));
        } else {
          const step = camera.position.distanceTo(controls.target) * 0.08;
          const offset = right.multiplyScalar(dx * step)
            .add(up.multiplyScalar(dy * step));
          camera.position.add(offset);
          controls.target.add(offset);
          controls.update();
        }
        break;
      }
      case "PageUp":
      case "PageDown": {
        e.preventDefault();
        const zoomIn = e.key === "PageUp";
        if (renderer.xr.isPresenting) {
          const cur = dioramaRoot.scale.x;
          const next = THREE.MathUtils.clamp(
            cur * (zoomIn ? 1.15 : 1 / 1.15),
            VR_PIXEL_SCALE * 0.15, VR_PIXEL_SCALE * 8);
          scaleDioramaAbout(next, dioramaFocusWorld());
        } else {
          const dir = camera.position.clone().sub(controls.target)
            .multiplyScalar(zoomIn ? 1 / 1.15 : 1.15);
          camera.position.copy(controls.target).add(dir);
          controls.update();
        }
        break;
      }
      case "Home":
        e.preventDefault();
        if (renderer.xr.isPresenting) vr.recenterNow();
        else frameDesktopCamera(session.level);
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
      updateHoverRing(); // ring keeps following the hovered lemming
      session.gui.update();
      layoutGuiPanel(); // no-ops unless the viewport or mode changed
    }
    if (renderer.xr.isPresenting) {
      vr.update(); // controller grabs + hover; headset pose drives the camera
      vrWarningSign.visible = vrMouseFallback();
    } else {
      controls.update();
      vrWarningSign.visible = false;
    }
    if (!vrMouseFallback()) {
      mouseCursor.visible = false;
      vrPan = null;
      vrOrbit = null;
    }
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
    audio, // audition SFX indexes: __lem3d.audio.playSfx(n)
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
