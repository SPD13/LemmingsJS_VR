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
    // All on until told otherwise: this is what the 3D mode is for, and each
    // one is remembered the moment its button is pressed.
    emboss: setting("emboss", "lem3d-emboss", true), // colour-keyed relief
    smooth: setting("smooth", "lem3d-smooth", true), // slope between heights
    doors: setting("doors", "lem3d-doors", true),    // entrances/exits as openings
    // Editing is the tagging workbench: the piece editor, the tagging marks
    // in the catalog, the "validation mode" billing. Playing is the game.
    edit: setting("edit", "lem3d-edit", false),
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
    title: document.getElementById("hud-title"),
    modeBtn: document.getElementById("btn-mode"),
    editor: document.getElementById("hud-editor"),
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

  // -------------------------------------------------- icon buttons (VR)
  // Small drawn squares the controller ray can press: the toolbar's own two
  // handles, the pause and restart pair over the play area, and the restart
  // dialog's answers. All hidden outside a session, where the DOM does this.
  const iconButtons = [];

  /** A small square with a drawn icon. `draw(ctx, state)` paints 64x64. */
  function makeIconButton(name, parent, draw) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const cx = cv.getContext("2d");
    const tex = new THREE.CanvasTexture(cv);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      }));
    mesh.name = name;
    mesh.renderOrder = GUI_ORDER_BAR_TOOL;
    mesh.visible = false;
    mesh.userData.state = { on: false, hovered: false };
    mesh.userData.repaint = () => {
      draw(cx, mesh.userData.state);
      tex.needsUpdate = true;
    };
    mesh.userData.repaint();
    parent.add(mesh);
    iconButtons.push(mesh);
    return mesh;
  }

  /** Change a button's state, repainting only when something actually moved. */
  function setBarToolState(mesh, patch) {
    const st = mesh.userData.state;
    let changed = false;
    for (const k of Object.keys(patch)) {
      if (st[k] !== patch[k]) { st[k] = patch[k]; changed = true; }
    }
    if (changed) mesh.userData.repaint();
  }

  /** The beam is on one of them (or has left them all). */
  function setBarToolHover(name) {
    for (const b of iconButtons) {
      setBarToolState(b, { hovered: b.name === "vr-" + name });
    }
    const onSlider = name === "volume";
    if (vrVolumeSlider.userData.hovered !== onSlider) {
      vrVolumeSlider.userData.hovered = onSlider;
      vrVolumeSlider.userData.paint(audio.volume, onSlider);
    }
    // The slider is summoned by the speaker and lingers: the beam has to
    // cross the gap between the two to reach it, so it cannot go the instant
    // the button is left. Riding it keeps it up for as long as it is held.
    if (onSlider || name === "mute") {
      soundPanelUntil = performance.now() + VR_SOUND_LINGER;
    }
  }
  let soundPanelUntil = 0;

  const barToolIcon = (cx, hovered, bg, stroke, body) => {
    cx.clearRect(0, 0, 64, 64);
    cx.fillStyle = bg;
    cx.beginPath();
    cx.roundRect ? cx.roundRect(2, 2, 60, 60, 12) : cx.rect(2, 2, 60, 60);
    cx.fill();
    if (hovered) {
      // the same white outline the skill panel puts round a chosen button
      cx.strokeStyle = "#ffffff";
      cx.lineWidth = 4;
      cx.beginPath();
      cx.roundRect ? cx.roundRect(4, 4, 56, 56, 10) : cx.rect(4, 4, 56, 56);
      cx.stroke();
    }
    cx.strokeStyle = stroke;
    cx.lineWidth = 5;
    cx.lineCap = "round";
    cx.lineJoin = "round";
    body(cx);
  };

  // padlock: shackle up and open when the bar floats free, closed when it
  // rides the head
  const barLockBtn = makeIconButton("vr-lock", guiRoot, (cx, st) => {
    const unlocked = st.on;
    barToolIcon(cx, st.hovered,
      unlocked ? (st.hovered ? "#6b6036" : "#4a4326")
               : (st.hovered ? "#1d5030" : "#12331d"),
      unlocked ? "#ffd866" : "#6fce7e", (c) => {
        c.strokeRect(18, 32, 28, 20);
        c.beginPath();
        if (unlocked) c.arc(42, 28, 10, Math.PI, Math.PI * 1.9); // swung open
        else c.arc(32, 30, 10, Math.PI, 0);
        c.stroke();
      });
  });

  // four-way arrows: grab here to move the bar
  const barMoveBtn = makeIconButton("vr-move", guiRoot, (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#33405a" : "#1c2432", "#cdd6e4", (c) => {
      c.beginPath();
      c.moveTo(32, 14); c.lineTo(32, 50);
      c.moveTo(14, 32); c.lineTo(50, 32);
      for (const [x, y, dx, dy] of [[32, 14, 0, 1], [32, 50, 0, -1],
                                    [14, 32, 1, 0], [50, 32, -1, 0]]) {
        c.moveTo(x - 7 * (dy ? 1 : 0) + 7 * dx, y - 7 * (dx ? 1 : 0) + 7 * dy);
        c.lineTo(x, y);
        c.lineTo(x + 7 * (dy ? 1 : 0) + 7 * dx, y + 7 * (dx ? 1 : 0) + 7 * dy);
      }
      c.stroke();
    });
  });
  // Over the play area: pause (which becomes play once it is paused) and
  // restart. They ride the toolbar, so they keep station with the bar
  // wherever it is dragged or unpinned to.

  // Over the play area: pause (which becomes play once it is paused) and
  // restart. They ride the diorama, so they pan and scale with the board they
  // belong to, and they are sized in game pixels like everything under it.
  const vrPauseBtn = makeIconButton("vr-pause", guiRoot, (cx, st) => {
    const paused = st.on;
    barToolIcon(cx, st.hovered, st.hovered ? "#1d5030" : "#12331d", "#6fce7e", (c) => {
      c.fillStyle = "#6fce7e";
      if (paused) {                       // a play triangle: press to resume
        c.beginPath();
        c.moveTo(24, 16); c.lineTo(48, 32); c.lineTo(24, 48);
        c.closePath();
        c.fill();
      } else {                            // two bars: press to pause
        c.fillRect(22, 17, 8, 30);
        c.fillRect(34, 17, 8, 30);
      }
    });
  });

  const vrRestartBtn = makeIconButton("vr-restart", guiRoot, (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#4a4326" : "#33301c", "#ffd866", (c) => {
      // An arrow curving right round: five sixths of a circle, with the head
      // filling the gap. Both ends come from the same angles, so the head
      // always sits on the arc's tip and points the way it was travelling -
      // spelling the triangle out by hand is what left it adrift before.
      const mx = 32, my = 32, r = 13;
      const from = Math.PI / 6, to = from + Math.PI * 5 / 3;
      c.beginPath();
      c.arc(mx, my, r, from, to);
      c.stroke();
      const ex = mx + r * Math.cos(to), ey = my + r * Math.sin(to);
      const tx = -Math.sin(to), ty = Math.cos(to);   // the way it is going
      const nx = Math.cos(to), ny = Math.sin(to);    // across the stroke
      const head = 9, half = 6.5;
      c.fillStyle = "#ffd866";
      c.beginPath();
      c.moveTo(ex + tx * head, ey + ty * head);      // the point
      c.lineTo(ex + nx * half, ey + ny * half);
      c.lineTo(ex - nx * half, ey - ny * half);
      c.closePath();
      c.fill();
    });
  });
  // Skip-track arrows, flanking restart. Deliberately not bare triangles:
  // a lone right-pointing triangle is the play icon two buttons along.
  const navIcon = (cx, st, back) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#33405a" : "#1c2432", "#cdd6e4", (c) => {
      c.fillStyle = "#cdd6e4";
      c.fillRect(back ? 18 : 40, 18, 6, 28);   // the bar it stops against
      c.beginPath();
      if (back) { c.moveTo(46, 18); c.lineTo(46, 46); c.lineTo(27, 32); }
      else { c.moveTo(18, 18); c.lineTo(18, 46); c.lineTo(37, 32); }
      c.closePath();
      c.fill();
    });
  };
  const vrPrevBtn = makeIconButton("vr-prev", guiRoot,
    (cx, st) => navIcon(cx, st, true));
  const vrNextBtn = makeIconButton("vr-next", guiRoot,
    (cx, st) => navIcon(cx, st, false));

  // globe: the way into the world catalog, the headset's own library button
  const vrWorldsBtn = makeIconButton("vr-worlds", guiRoot, (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#26485c" : "#152a36", "#7fd6e8", (c) => {
      c.lineWidth = 3.5;
      c.beginPath();
      c.arc(32, 32, 20, 0, Math.PI * 2);            // the globe
      c.moveTo(12, 32); c.lineTo(52, 32);           // equator
      c.stroke();
      c.beginPath();
      c.ellipse(32, 32, 9.5, 20, 0, 0, Math.PI * 2); // one meridian
      c.stroke();
      // two parallels: their ends meet the rim, and each sags toward the
      // equator in the middle, the way the near half of one actually reads
      c.beginPath();
      c.moveTo(16, 20); c.quadraticCurveTo(32, 26, 48, 20);
      c.moveTo(16, 44); c.quadraticCurveTo(32, 38, 48, 44);
      c.stroke();
    });
  });

  // The bar's own row of controls: the two handles at the left end, pause in
  // the middle, and the three that leave the level at the right end.
  // Sound, off the bar's right end: a column with the volume slider over a
  // mute switch. The slider is one mesh that draws its own track, fill and
  // knob, so the ray hits a single target and the hit's UV is the value.
  const vrVolumeSlider = (() => {
    const cv = document.createElement("canvas");
    cv.width = 64; cv.height = 256;
    const cx = cv.getContext("2d");
    const tex = new THREE.CanvasTexture(cv);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      }));
    mesh.name = "vr-volume";
    mesh.renderOrder = GUI_ORDER_BAR_TOOL;
    mesh.visible = false;
    mesh.userData.paint = (level, hovered) => {
      cx.clearRect(0, 0, 64, 256);
      const top = 14, bot = 242, span = bot - top;
      cx.fillStyle = "rgba(16, 20, 28, 0.92)";
      cx.beginPath();
      cx.roundRect ? cx.roundRect(2, 2, 60, 252, 14) : cx.rect(2, 2, 60, 252);
      cx.fill();
      if (hovered) {
        cx.strokeStyle = "#ffffff"; cx.lineWidth = 3;
        cx.beginPath();
        cx.roundRect ? cx.roundRect(4, 4, 56, 248, 12) : cx.rect(4, 4, 56, 248);
        cx.stroke();
      }
      cx.fillStyle = "#2a3446";                       // the groove
      cx.beginPath();
      cx.roundRect ? cx.roundRect(26, top, 12, span, 6) : cx.rect(26, top, 12, span);
      cx.fill();
      const y = bot - span * level;                   // filled from the bottom
      cx.fillStyle = "#6fce7e";
      cx.beginPath();
      cx.roundRect ? cx.roundRect(26, y, 12, bot - y, 6) : cx.rect(26, y, 12, bot - y);
      cx.fill();
      cx.fillStyle = "#f0f3f8";                       // the knob
      cx.beginPath();
      cx.roundRect ? cx.roundRect(12, y - 8, 40, 16, 6) : cx.rect(12, y - 8, 40, 16);
      cx.fill();
      tex.needsUpdate = true;
    };
    // painted blank for now: the audio it reads from is built further down,
    // and paintVolume() fills both this and the mute icon in once it exists
    mesh.userData.paint(1, false);
    guiRoot.add(mesh);
    return mesh;
  })();

  // speaker, with waves when it is on and a cross when it is not
  const vrMuteBtn = makeIconButton("vr-mute", guiRoot, (cx, st) => {
    const muted = st.on;
    barToolIcon(cx, st.hovered,
      muted ? (st.hovered ? "#5a2a2a" : "#33201c") : (st.hovered ? "#1d5030" : "#12331d"),
      muted ? "#e07a6a" : "#6fce7e", (c) => {
        c.fillStyle = muted ? "#e07a6a" : "#6fce7e";
        c.beginPath();                                  // cone and box
        c.moveTo(14, 26); c.lineTo(22, 26); c.lineTo(32, 16);
        c.lineTo(32, 48); c.lineTo(22, 38); c.lineTo(14, 38);
        c.closePath();
        c.fill();
        c.beginPath();
        if (muted) {
          c.moveTo(38, 24); c.lineTo(52, 40);
          c.moveTo(52, 24); c.lineTo(38, 40);
        } else {
          c.arc(34, 32, 10, -Math.PI / 3, Math.PI / 3);
          c.moveTo(34 + 17 * Math.cos(-Math.PI / 3), 32 + 17 * Math.sin(-Math.PI / 3));
          c.arc(34, 32, 17, -Math.PI / 3, Math.PI / 3);
        }
        c.stroke();
      });
  });

  function paintVolume() {
    vrVolumeSlider.userData.paint(
      audio.volume, vrVolumeSlider.userData.hovered === true);
    setBarToolState(vrMuteBtn, { on: !audio.enabled });
  }

  // cogwheel: the render switches, which are DOM buttons on a monitor
  const vrSettingsBtn = makeIconButton("vr-settings", guiRoot, (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#33405a" : "#1c2432", "#cdd6e4", (c) => {
      c.fillStyle = "#cdd6e4";
      c.beginPath();
      for (let i = 0; i < 8; i++) {           // eight teeth round the rim
        const a = (i / 8) * Math.PI * 2;
        c.save();
        c.translate(32 + Math.cos(a) * 20, 32 + Math.sin(a) * 20);
        c.rotate(a);
        c.fillRect(-5, -5, 10, 10);
        c.restore();
      }
      c.fill();
      c.beginPath();
      c.arc(32, 32, 16, 0, Math.PI * 2);
      c.fill();
      c.globalCompositeOperation = "destination-out";  // the hub
      c.beginPath();
      c.arc(32, 32, 7, 0, Math.PI * 2);
      c.fill();
      c.globalCompositeOperation = "source-over";
    });
  });

  const vrLeftTools = [barLockBtn, barMoveBtn, vrSettingsBtn];
  const vrRightTools = [vrWorldsBtn, vrPrevBtn, vrRestartBtn, vrNextBtn];
  const vrButtons = vrLeftTools.concat([vrPauseBtn], vrRightTools);
  // the sound column keeps its own place, so it is not in the row above, but
  // it is pressed like the rest
  const vrWidgets = vrButtons.concat([vrMuteBtn]);

  // Restart asks first. A DOM dialog is invisible in a headset, so the
  // question is in the scene, head-fixed like the toolbar and squarely in
  // front: while it is up it takes the ray and nothing behind it can be hit.
  const vrModal = new THREE.Group();
  vrModal.visible = false;
  camera.add(vrModal);
  const vrModalPanel = (() => {
    const cv = document.createElement("canvas");
    cv.width = 512; cv.height = 192;
    const cx = cv.getContext("2d");
    const tex = new THREE.CanvasTexture(cv);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      }));
    mesh.renderOrder = GUI_ORDER_MODAL;
    mesh.userData.ask = (title) => {
      cx.clearRect(0, 0, 512, 192);
      cx.fillStyle = "rgba(10, 14, 22, 0.95)";
      cx.beginPath();
      cx.roundRect ? cx.roundRect(2, 2, 508, 188, 16) : cx.rect(2, 2, 508, 188);
      cx.fill();
      cx.strokeStyle = "#ffd866";
      cx.lineWidth = 4;
      cx.stroke();
      cx.fillStyle = "#f0f3f8";
      cx.font = "bold 38px monospace";
      cx.textAlign = "center";
      cx.fillText(title, 256, 76);
      cx.fillStyle = "#8fa1bb";
      cx.font = "24px monospace";
      cx.fillText("progress on this level is lost", 256, 114);
      tex.needsUpdate = true;
    };
    mesh.userData.ask("Restart level?");
    vrModal.add(mesh);
    return mesh;
  })();

  const vrYesBtn = makeIconButton("vr-yes", vrModal, (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#1d5030" : "#12331d", "#6fce7e", (c) => {
      c.beginPath();
      c.moveTo(16, 33); c.lineTo(28, 45); c.lineTo(49, 20);
      c.stroke();
    });
  });
  const vrNoBtn = makeIconButton("vr-no", vrModal, (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#5a2a2a" : "#33201c", "#e07a6a", (c) => {
      c.beginPath();
      c.moveTo(19, 19); c.lineTo(45, 45);
      c.moveTo(45, 19); c.lineTo(19, 45);
      c.stroke();
    });
  });

  // over the question's own panel, and both over everything the bar draws
  vrYesBtn.renderOrder = GUI_ORDER_MODAL_BTN;
  vrNoBtn.renderOrder = GUI_ORDER_MODAL_BTN;

  /** Show or hide the restart question. */
  function setVrModal(open) {
    vrModal.visible = open && renderer.xr.isPresenting;
    for (const b of [vrYesBtn, vrNoBtn]) {
      b.visible = vrModal.visible;
      setBarToolState(b, { hovered: false });
    }
    if (vrModal.visible) holdSim("vr-modal");
    else { vrConfirmAction = null; releaseSim("vr-modal"); }
  }

  let vrConfirmAction = null;
  /** The in-scene twin of askConfirm: the same three questions, in a headset. */
  function askVrConfirm(title, action) {
    vrModalPanel.userData.ask(title);
    setVrModal(true);
    vrConfirmAction = action; // after setVrModal, which clears it on close
  }

  /** Lay the dialog out in front of the eyes, in metres of camera space. */
  function layoutVrModal() {
    const w = VR_MODAL_WIDTH, h = w * 192 / 512;
    vrModalPanel.scale.set(w, h, 1);
    vrModalPanel.position.set(0, VR_MODAL_Y, VR_MODAL_Z);
    const size = VR_BAR_TOOL_SIZE * 1.3;
    for (const [b, side] of [[vrYesBtn, -1], [vrNoBtn, 1]]) {
      const hot = b.userData.state.hovered;
      b.scale.setScalar(size * (hot ? VR_BAR_TOOL_HOVER : 1));
      b.position.set(side * w * 0.22, VR_MODAL_Y - h * 0.62,
        VR_MODAL_Z + (hot ? size * 0.25 : 0.001));
    }
  }
  // ------------------------------------------------------ world catalog (VR)
  /**
   * The headset's twin of the DOM library, in the dialog's plane: every level
   * of both games in the order they are played, under a heading per
   * difficulty, each tile carrying its miniature and - once it has been
   * cleared - a green ground and the best time. Picking one enters it.
   *
   * The list is far taller than the window, so it scrolls: either thumbstick
   * drives it while the catalog is up, and neither one moves the board behind
   * it. It is one canvas rather than a mesh per tile - a single texture, a
   * scroll offset and a UV lookup do the whole grid - with the close button as
   * the only separate target, so it can grow under the beam like the rest.
   */
  const VR_CAT_W = 1024, VR_CAT_H = 640;  // canvas pixels
  const VR_CAT_PAD = 26;                  // margin round the list
  const VR_CAT_TOP = 92;                  // below the heading
  const VR_CAT_GAP = 14;                  // between tiles
  const VR_CAT_COLS = 4;
  const VR_CAT_THUMB_H = 26;              // a level is ~10:1, so it draws thin
  const VR_CAT_TILE_H = 126;              // one row of levels
  const VR_CAT_BAND_H = 48;               // a difficulty's heading
  const VR_CAT_BAR_W = 16;                // the scrollbar down the right edge
  const VR_CAT_BAR_GRAB = 12;             // slack either side of it, for the ray
  const VR_CAT_SCROLL = 900;              // canvas px/second at full stick
  // The window the list scrolls behind.
  const VR_CAT_VIEW_X = VR_CAT_PAD;
  const VR_CAT_VIEW_Y = VR_CAT_TOP;
  const VR_CAT_VIEW_W = VR_CAT_W - 2 * VR_CAT_PAD - VR_CAT_BAR_W - 8;
  const VR_CAT_VIEW_H = VR_CAT_H - VR_CAT_TOP - VR_CAT_PAD;

  let vrCatalogItems = [];   // every level, in the order the games play them
  let vrCatalogCells = [];   // one per item, in the list's own coordinates
  let vrCatalogBands = [];   // the difficulty headings between them
  let vrCatalogHeight = 0;   // how tall the whole list is
  let vrCatalogScroll = 0;   // how far down it we are
  let vrCatalogHover = -1;
  let vrCatalogNote = "";

  const vrCatalog = new THREE.Group();
  vrCatalog.visible = false;
  camera.add(vrCatalog);

  /**
   * Lay the whole list out once, in its own coordinates: a heading wherever
   * the difficulty changes, then rows of level tiles under it. Painting and
   * picking both work from this, offset by the scroll.
   */
  function layoutVrCatalogList() {
    vrCatalogCells = [];
    vrCatalogBands = [];
    const colW = VR_CAT_VIEW_W / VR_CAT_COLS;
    let y = 0;              // the top of whatever is placed next
    let col = VR_CAT_COLS;  // == VR_CAT_COLS: no row is open
    let band = null;
    vrCatalogItems.forEach((item, i) => {
      const key = item.gameType + "/" + item.group;
      if (key !== band) {
        band = key;
        if (col < VR_CAT_COLS) { y += VR_CAT_TILE_H; col = VR_CAT_COLS; }
        vrCatalogBands.push({ label: item.band, y, h: VR_CAT_BAND_H });
        y += VR_CAT_BAND_H;
      }
      if (col >= VR_CAT_COLS) col = 0; // this item opens a row at y
      vrCatalogCells.push({
        item, i,
        x: VR_CAT_VIEW_X + col * colW + VR_CAT_GAP / 2,
        y: y + VR_CAT_GAP / 2,
        w: colW - VR_CAT_GAP,
        h: VR_CAT_TILE_H - VR_CAT_GAP,
      });
      if (++col >= VR_CAT_COLS) { y += VR_CAT_TILE_H; col = VR_CAT_COLS; }
    });
    if (col < VR_CAT_COLS) y += VR_CAT_TILE_H; // the last row, left part-full
    vrCatalogHeight = y;
    vrCatalogScrollTo(vrCatalogScroll);
  }

  /**
   * The scrollbar down the right edge: where it is, how tall its thumb is,
   * and how far the list can travel. Painted from this, and pressed on it.
   */
  function vrCatalogBar() {
    const max = Math.max(0, vrCatalogHeight - VR_CAT_VIEW_H);
    return {
      x: VR_CAT_W - VR_CAT_PAD - VR_CAT_BAR_W,
      y: VR_CAT_VIEW_Y, w: VR_CAT_BAR_W, h: VR_CAT_VIEW_H, max,
      thumb: max > 0
        ? Math.max(40, VR_CAT_VIEW_H * VR_CAT_VIEW_H / vrCatalogHeight) : 0,
    };
  }

  /** Where a press at this height down the bar puts the list. */
  function vrCatalogScrollFor(canvasY) {
    const bar = vrCatalogBar();
    const travel = bar.h - bar.thumb;
    if (travel <= 0) return 0;
    // the thumb centres on the press, the way a scrollbar drag behaves
    return ((canvasY - bar.y - bar.thumb / 2) / travel) * bar.max;
  }

  /** Move the list, clamped to its ends. Returns true if it actually moved. */
  function vrCatalogScrollTo(next) {
    const max = Math.max(0, vrCatalogHeight - VR_CAT_VIEW_H);
    const clamped = Math.max(0, Math.min(max, next));
    if (clamped === vrCatalogScroll) return false;
    vrCatalogScroll = clamped;
    return true;
  }

  /** Scroll by a number of canvas pixels, repainting if anything moved. */
  function scrollVrCatalog(delta) {
    if (vrCatalogScrollTo(vrCatalogScroll + delta)) paintVrCatalog();
  }

  /** Put a level in view, roughly a third of the way down. */
  function vrCatalogRevealItem(index) {
    const cell = vrCatalogCells[index];
    if (!cell) return;
    vrCatalogScrollTo(cell.y - VR_CAT_VIEW_H / 3);
  }

  const vrCatalogPanel = (() => {
    const cv = document.createElement("canvas");
    cv.width = VR_CAT_W; cv.height = VR_CAT_H;
    const cx = cv.getContext("2d");
    const tex = new THREE.CanvasTexture(cv);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      }));
    mesh.name = "vr-worldpanel";
    mesh.renderOrder = GUI_ORDER_MODAL;
    /** Trim a label to the width it has, with an ellipsis when it is cut. */
    const fit = (text, maxW) => {
      if (cx.measureText(text).width <= maxW) return text;
      let cut = text;
      while (cut.length > 1 && cx.measureText(cut + "…").width > maxW) {
        cut = cut.slice(0, -1);
      }
      return cut + "…";
    };
    mesh.userData.paint = () => {
      cx.clearRect(0, 0, VR_CAT_W, VR_CAT_H);
      cx.fillStyle = "rgba(10, 14, 22, 0.96)";
      cx.beginPath();
      cx.roundRect ? cx.roundRect(2, 2, VR_CAT_W - 4, VR_CAT_H - 4, 18)
                   : cx.rect(2, 2, VR_CAT_W - 4, VR_CAT_H - 4);
      cx.fill();
      cx.strokeStyle = "#ffd866";
      cx.lineWidth = 4;
      cx.stroke();

      cx.textAlign = "left";
      cx.fillStyle = "#f0f3f8";
      cx.font = "bold 36px monospace";
      cx.fillText("WORLDS", VR_CAT_PAD + 6, 58);
      cx.fillStyle = "#8fa1bb";
      cx.font = "22px monospace";
      cx.fillText(vrCatalogNote || "stick up / down to scroll",
        VR_CAT_PAD + 190, 56);

      // the list itself, clipped to its window and slid by the scroll
      cx.save();
      cx.beginPath();
      cx.rect(VR_CAT_VIEW_X - 4, VR_CAT_VIEW_Y,
        VR_CAT_VIEW_W + 8, VR_CAT_VIEW_H);
      cx.clip();
      cx.translate(0, VR_CAT_VIEW_Y - vrCatalogScroll);
      const top = vrCatalogScroll, bottom = top + VR_CAT_VIEW_H;

      for (const band of vrCatalogBands) {
        if (band.y + band.h < top || band.y > bottom) continue;
        cx.fillStyle = "#7fd6e8";
        cx.font = "bold 24px monospace";
        cx.fillText(band.label, VR_CAT_VIEW_X + VR_CAT_GAP / 2, band.y + 32);
        cx.strokeStyle = "rgba(127, 214, 232, 0.35)";
        cx.lineWidth = 2;
        cx.beginPath();
        cx.moveTo(VR_CAT_VIEW_X + VR_CAT_GAP / 2, band.y + 42);
        cx.lineTo(VR_CAT_VIEW_X + VR_CAT_VIEW_W - VR_CAT_GAP / 2, band.y + 42);
        cx.stroke();
      }

      for (const cell of vrCatalogCells) {
        if (cell.y + cell.h < top || cell.y > bottom) continue;
        const it = cell.item;
        const done = it.best !== null;
        const hot = cell.i === vrCatalogHover;
        cx.fillStyle = done ? (hot ? "#2c7042" : "#1d4a2b")
                            : (hot ? "#2b3548" : "#19202c");
        cx.beginPath();
        cx.roundRect ? cx.roundRect(cell.x, cell.y, cell.w, cell.h, 10)
                     : cx.rect(cell.x, cell.y, cell.w, cell.h);
        cx.fill();
        if (hot || it.current) {
          cx.strokeStyle = hot ? "#ffffff" : "#ffd866";
          cx.lineWidth = 3;
          cx.stroke();
        }
        // the miniature, letterboxed across the tile's top
        const tw = cell.w - 20;
        if (it.thumb) {
          cx.imageSmoothingEnabled = false;
          cx.drawImage(it.thumb, cell.x + 10, cell.y + 10, tw, VR_CAT_THUMB_H);
        } else {
          cx.fillStyle = "rgba(255,255,255,0.06)";
          cx.fillRect(cell.x + 10, cell.y + 10, tw, VR_CAT_THUMB_H);
          vrCatalogWantsThumb(it, Math.round(tw));
        }
        cx.fillStyle = "#f0f3f8";
        cx.font = "bold 24px monospace";
        cx.fillText(fit(it.label, tw), cell.x + 10, cell.y + 62);
        cx.fillStyle = "#c3ccda";
        cx.font = "17px monospace";
        cx.fillText(fit(it.name, tw), cell.x + 10, cell.y + 84);
        // the world it is built from, and the record if there is one
        cx.fillStyle = done ? "#6fce7e" : "#8fa1bb";
        cx.fillText(fit(
          (done ? "✔ " + LevelProgress.format(it.best) + " · " : "") + it.set,
          tw), cell.x + 10, cell.y + 104);
      }
      cx.restore();

      // how far down the list we are - and a handle to drag
      const bar = vrCatalogBar();
      if (bar.max > 0) {
        const r = VR_CAT_BAR_W / 2;
        cx.fillStyle = "rgba(255,255,255,0.07)";
        cx.beginPath();
        cx.roundRect ? cx.roundRect(bar.x, bar.y, bar.w, bar.h, r)
                     : cx.rect(bar.x, bar.y, bar.w, bar.h);
        cx.fill();
        const ty = bar.y +
          (bar.h - bar.thumb) * (vrCatalogScroll / bar.max);
        cx.fillStyle = vrCatalogHover === -2 ? "#a9e6f4" : "#7fd6e8";
        cx.beginPath();
        cx.roundRect ? cx.roundRect(bar.x, ty, bar.w, bar.thumb, r)
                     : cx.rect(bar.x, ty, bar.w, bar.thumb);
        cx.fill();
      }
      tex.needsUpdate = true;
    };
    mesh.userData.paint();
    vrCatalog.add(mesh);
    return mesh;
  })();

  const vrCatalogClose = makeIconButton("vr-catclose", vrCatalog, (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#5a2a2a" : "#33201c", "#e07a6a", (c) => {
      c.beginPath();
      c.moveTo(19, 19); c.lineTo(45, 45);
      c.moveTo(45, 19); c.lineTo(19, 45);
      c.stroke();
    });
  });
  vrCatalogClose.renderOrder = GUI_ORDER_MODAL_BTN;

  function paintVrCatalog() { vrCatalogPanel.userData.paint(); }

  /**
   * What the beam is on inside the catalog window: a tile, or the scrollbar
   * (which carries the position it would scroll to, so a press on it jumps
   * there and a held press keeps following the hand).
   */
  function vrCatalogPick(uv) {
    const bar = vrCatalogBar();
    const x = uv ? uv.x * VR_CAT_W : -1;
    const y = uv ? (1 - uv.y) * VR_CAT_H : -1;
    const onBar = !!uv && bar.max > 0 &&
      x >= bar.x - VR_CAT_BAR_GRAB && x <= bar.x + bar.w + VR_CAT_BAR_GRAB &&
      y >= bar.y && y <= bar.y + bar.h;
    return {
      barTool: "worldpanel",
      tile: onBar ? -1 : vrCatalogTileAt(uv),
      scrollBar: onBar,
      scrollAt: vrCatalogScrollFor(y),
    };
  }

  /** Which tile the beam is on, from the panel's own UV. */
  function vrCatalogTileAt(uv) {
    if (!uv) return -1;
    const x = uv.x * VR_CAT_W, py = (1 - uv.y) * VR_CAT_H;
    if (py < VR_CAT_VIEW_Y || py > VR_CAT_VIEW_Y + VR_CAT_VIEW_H) return -1;
    const y = py - VR_CAT_VIEW_Y + vrCatalogScroll; // into the list's own space
    for (const cell of vrCatalogCells) {
      if (x >= cell.x && x <= cell.x + cell.w &&
          y >= cell.y && y <= cell.y + cell.h) return cell.i;
    }
    return -1;
  }

  /**
   * Ask for a tile's miniature the first time it is drawn. Levels are loaded
   * to make one, so the list only pays for what has actually been looked at -
   * there are a couple of hundred of them.
   */
  function vrCatalogWantsThumb(item, width) {
    if (item.thumbReq) return;
    item.thumbReq = true;
    library.thumbnail(item.gameType, item.group, item.level,
      width, VR_CAT_THUMB_H)
      .then((canvas) => {
        item.thumb = canvas;
        if (vrCatalog.visible) paintVrCatalog();
      })
      .catch(() => { /* the tile keeps its blank plate */ });
  }

  function setVrCatalogHover(index) {
    if (vrCatalogHover === index) return;
    vrCatalogHover = index;
    paintVrCatalog();
  }

  /**
   * Every level of both games, in the order they are played: game, then
   * difficulty, then level. The scan behind it is cached; which levels have
   * been cleared is re-read on each open, since that changes as the player
   * plays.
   */
  async function loadVrCatalog() {
    vrCatalogNote = "scanning levels…";
    paintVrCatalog();
    let mapping;
    try {
      mapping = await library.catalog();
    } catch (err) {
      vrCatalogNote = "catalog unavailable";
      paintVrCatalog();
      console.error(err);
      return;
    }
    const items = [];
    for (const gameType of Object.keys(mapping).map(Number)) {
      const config = await factory.getConfig(gameType).catch(() => null);
      const groupNames = (config && config.level.groups) || [];
      const gameLabel = GAME_LABELS[gameType] || "game " + gameType;
      const levels = [];
      for (const world of mapping[gameType] || []) {
        for (const entry of world.levels) {
          levels.push({ entry, set: worldName(gameType, world) });
        }
      }
      // the scan walks the games tileset by tileset; play order is by group
      levels.sort((a, b) =>
        a.entry.group - b.entry.group || a.entry.level - b.entry.level);
      for (const { entry, set } of levels) {
        const group = groupNames[entry.group] || "Group " + (entry.group + 1);
        items.push({
          gameType, group: entry.group, level: entry.level,
          band: gameLabel + " · " + group,
          label: group + " " + (entry.level + 1),
          name: entry.name || "",
          set: set || "",
          best: LevelProgress.best(gameType, entry.group, entry.level),
          current: gameType === state.gameType && entry.group === state.group &&
            entry.level === state.level,
          thumb: null, thumbReq: false,
        });
      }
    }
    vrCatalogItems = items;
    vrCatalogNote = "";
    layoutVrCatalogList();
    // open on the level being played, so the list starts where the player is
    const here = items.findIndex((it) => it.current);
    if (here >= 0) vrCatalogRevealItem(here);
    paintVrCatalog();
  }

  // --------------------------------------------------------- settings (VR)
  /**
   * The render switches, in the scene. They are DOM buttons on a monitor,
   * which a headset cannot reach: a framerate that suffers mid-session used
   * to mean taking the headset off (or knowing the URL params). The panel
   * calls exactly what the buttons call, so the two stay in step, and it
   * carries the recentre that is otherwise only on the A/X button.
   */
  const VR_SET_W = 640, VR_SET_H = 400;   // canvas pixels
  const VR_SET_TOP = 96;                  // first row
  const VR_SET_ROW = 68;

  const vrSettingRows = [
    { label: "3D terrain", get: () => state.emboss, act: () => toggleEmboss() },
    { label: "3D doors", get: () => state.doors, act: () => toggleDoors() },
    { label: "smooth", get: () => state.smooth, act: () => toggleSmooth() },
    { label: "recentre the board", act: () => vr.recenterNow() },
  ];
  let vrSettingsHover = -1;

  const vrSettings = new THREE.Group();
  vrSettings.visible = false;
  camera.add(vrSettings);

  const vrSettingsPanel = (() => {
    const cv = document.createElement("canvas");
    cv.width = VR_SET_W; cv.height = VR_SET_H;
    const cx = cv.getContext("2d");
    const tex = new THREE.CanvasTexture(cv);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      }));
    mesh.name = "vr-setpanel";
    mesh.renderOrder = GUI_ORDER_MODAL;
    mesh.userData.paint = () => {
      cx.clearRect(0, 0, VR_SET_W, VR_SET_H);
      cx.fillStyle = "rgba(10, 14, 22, 0.96)";
      cx.beginPath();
      cx.roundRect ? cx.roundRect(2, 2, VR_SET_W - 4, VR_SET_H - 4, 16)
                   : cx.rect(2, 2, VR_SET_W - 4, VR_SET_H - 4);
      cx.fill();
      cx.strokeStyle = "#ffd866";
      cx.lineWidth = 4;
      cx.stroke();
      cx.textAlign = "left";
      cx.fillStyle = "#f0f3f8";
      cx.font = "bold 34px monospace";
      cx.fillText("SETTINGS", 28, 60);

      vrSettingRows.forEach((row, i) => {
        const y = VR_SET_TOP + i * VR_SET_ROW;
        const hot = i === vrSettingsHover;
        const on = row.get ? row.get() : null;
        cx.fillStyle = hot ? "#2b3548" : "#19202c";
        cx.beginPath();
        cx.roundRect ? cx.roundRect(24, y, VR_SET_W - 48, VR_SET_ROW - 12, 10)
                     : cx.rect(24, y, VR_SET_W - 48, VR_SET_ROW - 12);
        cx.fill();
        if (hot) {
          cx.strokeStyle = "#ffffff";
          cx.lineWidth = 3;
          cx.stroke();
        }
        cx.fillStyle = "#f0f3f8";
        cx.font = "26px monospace";
        cx.fillText(row.label, 44, y + 38);
        if (on === null) return;                    // an action, not a switch
        const pw = 86, px = VR_SET_W - 48 - pw - 12;
        cx.fillStyle = on ? "#1d5030" : "#3a2530";
        cx.beginPath();
        cx.roundRect ? cx.roundRect(px, y + 12, pw, 32, 16)
                     : cx.rect(px, y + 12, pw, 32);
        cx.fill();
        cx.fillStyle = on ? "#6fce7e" : "#e07a6a";
        cx.font = "bold 22px monospace";
        cx.textAlign = "center";
        cx.fillText(on ? "ON" : "OFF", px + pw / 2, y + 36);
        cx.textAlign = "left";
      });
      tex.needsUpdate = true;
    };
    mesh.userData.paint();
    vrSettings.add(mesh);
    return mesh;
  })();

  const vrSettingsClose = makeIconButton("vr-setclose", vrSettings, (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#5a2a2a" : "#33201c", "#e07a6a", (c) => {
      c.beginPath();
      c.moveTo(19, 19); c.lineTo(45, 45);
      c.moveTo(45, 19); c.lineTo(19, 45);
      c.stroke();
    });
  });
  vrSettingsClose.renderOrder = GUI_ORDER_MODAL_BTN;

  function paintVrSettings() { vrSettingsPanel.userData.paint(); }

  /** Which row the beam is on, from the panel's own UV. */
  function vrSettingsRowAt(uv) {
    if (!uv) return -1;
    const x = uv.x * VR_SET_W, y = (1 - uv.y) * VR_SET_H;
    if (x < 24 || x > VR_SET_W - 24) return -1;
    const i = Math.floor((y - VR_SET_TOP) / VR_SET_ROW);
    if (i < 0 || i >= vrSettingRows.length) return -1;
    return (y - VR_SET_TOP) % VR_SET_ROW <= VR_SET_ROW - 12 ? i : -1;
  }

  function setVrSettingsHover(index) {
    if (vrSettingsHover === index) return;
    vrSettingsHover = index;
    paintVrSettings();
  }

  /** Show or hide the switches, holding the clock while they are up. */
  function setVrSettings(open) {
    const show = open && renderer.xr.isPresenting;
    if (show === vrSettings.visible) return;
    vrSettings.visible = show;
    vrSettingsClose.visible = show;
    setBarToolState(vrSettingsClose, { hovered: false });
    setVrSettingsHover(-1);
    if (show) { holdSim("vr-settings"); paintVrSettings(); }
    else releaseSim("vr-settings");
  }

  /** In the dialog's plane, like every other window. */
  function layoutVrSettings() {
    const w = VR_SETTINGS_WIDTH, h = w * VR_SET_H / VR_SET_W;
    vrSettingsPanel.scale.set(w, h, 1);
    vrSettingsPanel.position.set(0, VR_MODAL_Y, VR_MODAL_Z);
    const size = VR_BAR_TOOL_SIZE;
    const hot = vrSettingsClose.userData.state.hovered;
    vrSettingsClose.scale.setScalar(size * (hot ? VR_BAR_TOOL_HOVER : 1));
    vrSettingsClose.position.set(
      w / 2 - size * 0.6, VR_MODAL_Y + h / 2 - size * 0.6,
      VR_MODAL_Z + (hot ? size * 0.25 : 0.001));
  }

  // ------------------------------------------------------ status strip (VR)
  /**
   * What the DOM HUD says, in the scene: which level this is, what it asks
   * for, and how it ended. None of that is readable in a headset otherwise -
   * the page around the canvas simply is not there - so a win, a loss and a
   * level swap all used to happen in silence.
   *
   * It rides the toolbar like the button row, just above it, so it follows
   * the bar wherever it is dragged or unpinned to.
   */
  const VR_STATUS_W = 1024, VR_STATUS_H = 132;

  const vrStatus = { name: "", meta: "", note: "loading…", kind: "" };

  const vrStatusPanel = (() => {
    const cv = document.createElement("canvas");
    cv.width = VR_STATUS_W; cv.height = VR_STATUS_H;
    const cx = cv.getContext("2d");
    const tex = new THREE.CanvasTexture(cv);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      }));
    mesh.name = "vr-status";
    mesh.renderOrder = GUI_ORDER_BAR_TOOL;
    mesh.visible = false;
    mesh.userData.paint = () => {
      cx.clearRect(0, 0, VR_STATUS_W, VR_STATUS_H);
      cx.fillStyle = "rgba(10, 14, 22, 0.86)";
      cx.beginPath();
      cx.roundRect ? cx.roundRect(2, 2, VR_STATUS_W - 4, VR_STATUS_H - 4, 14)
                   : cx.rect(2, 2, VR_STATUS_W - 4, VR_STATUS_H - 4);
      cx.fill();
      cx.strokeStyle = vrStatus.kind === "won" ? "#6fce7e"
        : vrStatus.kind === "lost" ? "#e07a6a" : "#2a3446";
      cx.lineWidth = 3;
      cx.stroke();
      cx.textAlign = "left";
      cx.fillStyle = "#f0f3f8";
      cx.font = "bold 40px monospace";
      cx.fillText(vrStatus.name || "…", 26, 56);
      cx.fillStyle = "#8fa1bb";
      cx.font = "26px monospace";
      cx.fillText(vrStatus.meta, 26, 98);
      if (vrStatus.note) {
        // the outcome, or that a level is on its way in
        cx.textAlign = "right";
        cx.fillStyle = vrStatus.kind === "won" ? "#6fce7e"
          : vrStatus.kind === "lost" ? "#e07a6a" : "#ffd866";
        cx.font = "bold 32px monospace";
        cx.fillText(vrStatus.note, VR_STATUS_W - 26, 84);
      }
      tex.needsUpdate = true;
    };
    mesh.userData.paint();
    guiRoot.add(mesh);
    return mesh;
  })();

  /** Update the strip. Any field left undefined keeps what it had. */
  function setVrStatus(patch) {
    let changed = false;
    for (const k of Object.keys(patch)) {
      if (vrStatus[k] !== patch[k]) { vrStatus[k] = patch[k]; changed = true; }
    }
    if (changed) vrStatusPanel.userData.paint();
  }

  /** Show or hide the catalog, holding the clock while the player reads it. */
  function setVrCatalog(open) {
    const show = open && renderer.xr.isPresenting;
    if (show === vrCatalog.visible) return;
    vrCatalog.visible = show;
    vrCatalogClose.visible = show;
    setBarToolState(vrCatalogClose, { hovered: false });
    setVrCatalogHover(-1);
    if (show) { holdSim("vr-catalog"); loadVrCatalog(); }
    else releaseSim("vr-catalog");
  }

  /** The window and its close button, in metres of camera space. */
  function layoutVrCatalog() {
    const w = VR_CATALOG_WIDTH, h = w * VR_CAT_H / VR_CAT_W;
    vrCatalogPanel.scale.set(w, h, 1);
    vrCatalogPanel.position.set(0, VR_CATALOG_Y, VR_MODAL_Z);
    const size = VR_BAR_TOOL_SIZE;
    const hot = vrCatalogClose.userData.state.hovered;
    vrCatalogClose.scale.setScalar(size * (hot ? VR_BAR_TOOL_HOVER : 1));
    vrCatalogClose.position.set(
      w / 2 - size * 0.6, VR_CATALOG_Y + h / 2 - size * 0.6,
      VR_MODAL_Z + (hot ? size * 0.25 : 0.001));
  }

  // Lay them out now rather than waiting for the first frame: until then these
  // are metre-wide planes sitting on the camera, and a ray aimed anywhere at
  // all would hit one.
  layoutVrModal();
  layoutVrCatalog();
  layoutVrSettings();

  /**
   * The toolbar rides the head by default. Unlocked, it is handed to the
   * scene with its world transform kept, so it simply stays where it was
   * hanging while the player looks around; locking hands it back the same
   * way, so it never jumps at the moment of the click - it just starts
   * following again from wherever it is.
   */
  let barLocked = true;
  let barDragFrom = null;
  function setBarLocked(locked) {
    if (barLocked === locked) return;
    barLocked = locked;
    const parent = locked ? camera : scene;
    parent.updateMatrixWorld(true);
    guiRoot.updateMatrixWorld(true);
    const world = guiRoot.matrixWorld.clone();
    parent.add(guiRoot); // three removes it from the old parent
    guiRoot.matrix.copy(parent.matrixWorld).invert().multiply(world);
    guiRoot.matrix.decompose(
      guiRoot.position, guiRoot.quaternion, guiRoot.scale);
    setBarToolState(barLockBtn, { on: !locked });
  }

  /** Back to riding the head, square in front, with no drag offset. */
  function resetBar() {
    setBarLocked(true);
    guiRoot.position.set(0, 0, 0);
    guiRoot.quaternion.identity();
    guiRoot.scale.setScalar(1);
    barDragFrom = null;
  }

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
  paintVolume();  // now that audio exists, show its real level and switch
    if (audio.enabled && session) audio.playMusic(session.musicTrack || 0);
  });
  renderSoundBtn();

  // master switch for colour-keyed terrain relief (per-piece tags in the editor)
  const embossBtn = document.getElementById("btn-emboss");
  const renderEmbossBtn = () => {
    embossBtn.textContent = "3D terrain: " + (state.emboss ? "on" : "off");
  };
  function toggleEmboss() {
    state.emboss = !state.emboss;
    try { localStorage.setItem("lem3d-emboss", state.emboss ? "on" : "off"); } catch (e) {}
    renderEmbossBtn();
    if (session) session.rebuildRelief();
    paintVrSettings();
  }
  embossBtn.addEventListener("click", toggleEmboss);
  renderEmbossBtn();

  /** Playing or editing: the billing, the catalog's labels, and whether the
   *  piece editor is reachable at all. */
  function renderMode() {
    hud.title.textContent = state.edit
      ? "LEMMINGS 3D · VALIDATION MODE" : "LEMMINGS 3D";
    document.title = state.edit
      ? "Lemmings 3D — validation mode" : "Lemmings 3D";
    hud.modeBtn.textContent = "mode: " + (state.edit ? "edit" : "play");
    library.setEditMode(state.edit);
    if (!state.edit && session && session.editor) session.editor.disable();
  }
  document.getElementById("btn-mode").addEventListener("click", () => {
    state.edit = !state.edit;
    try { localStorage.setItem("lem3d-edit", state.edit ? "on" : "off"); } catch (e) {}
    renderMode();
  });

  // entrances and exits as real openings rather than flat sprites. The
  // opening carves the terrain behind it as the level is built, so unlike the
  // relief this cannot be swapped in place - the level is rebuilt.
  const doorsBtn = document.getElementById("btn-doors");
  const renderDoorsBtn = () => {
    doorsBtn.textContent = "3D doors: " + (state.doors ? "on" : "off");
  };
  function toggleDoors() {
    state.doors = !state.doors;
    try { localStorage.setItem("lem3d-doors", state.doors ? "on" : "off"); } catch (e) {}
    renderDoorsBtn();
    paintVrSettings();
    loadLevel().catch((err) => console.error(err));
  }
  doorsBtn.addEventListener("click", toggleDoors);
  renderDoorsBtn();

  // slope the relief between heights instead of stepping
  const smoothBtn = document.getElementById("btn-smooth");
  const renderSmoothBtn = () => {
    smoothBtn.textContent = "smooth: " + (state.smooth ? "on" : "off");
  };
  function toggleSmooth() {
    state.smooth = !state.smooth;
    try { localStorage.setItem("lem3d-smooth", state.smooth ? "on" : "off"); } catch (e) {}
    renderSmoothBtn();
    if (session) session.terrain.setSmooth(state.smooth);
    paintVrSettings();
  }
  smoothBtn.addEventListener("click", toggleSmooth);
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
    setVrStatus({ note: "loading…", kind: "" });

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
      let best = "";
      if (won) {
        // the clock counts down; how long it took is the elapsed time
        const seconds = game.getGameTimer().getGameTime();
        const record = LevelProgress.record(
          state.gameType, state.group, state.level, seconds);
        best = " — " + LevelProgress.format(seconds) +
          (record ? " (best)" : "");
      }
      hud.state.textContent = won
        ? "LEVEL COMPLETE — " + Lemmings.GameStateTypes.toString(result.state) + best
        : "FAILED — " + Lemmings.GameStateTypes.toString(result.state);
      hud.state.className = won ? "won" : "lost";
      setVrStatus({ note: won ? "COMPLETE" + best : "FAILED",
                    kind: won ? "won" : "lost" });
      window.setTimeout(() => {
        if (session && session.game === game) moveLevel(won ? 1 : 0);
      }, 3000);
    });
    game.start();

    // Camera: frame the level's intended start position - but never during a
    // session, where the camera is the headset. Writing desktop coordinates
    // into it there is read straight back as a head pose, and the next level
    // gets placed hundreds of metres away. Leaving VR reframes anyway.
    if (!renderer.xr.isPresenting) frameDesktopCamera(level);

    hud.name.textContent = level.name.trim() || "(unnamed level)";
    hud.meta.textContent =
      "type " + state.gameType + " · group " + state.group +
      " · level " + (state.level + 1) +
      " · save " + level.needCount + "/" + level.releaseCount;
    hud.loading.classList.add("hidden");
    // the same, in the scene, where a headset can read it
    const groupNames = (await factory.getConfig(state.gameType)).level.groups || [];
    setVrStatus({
      name: level.name.trim() || "(unnamed level)",
      meta: (GAME_LABELS[state.gameType] || "game " + state.gameType) + " · " +
        (groupNames[state.group] || "group " + state.group) + " " +
        (state.level + 1) + " · save " + level.needCount + "/" + level.releaseCount,
      note: "", kind: "",
    });

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
      // deeper relief in a headset: on a flat screen the emboss is carried by
      // its shading, but stereo wants parallax to go with it
      session.gui.setReliefDepth(GUI_VR_RELIEF_DEPTH);
      session.gui.place(VR_GUI_WIDTH, VR_GUI_Y, VR_GUI_Z); // metres
      // The row of controls rides just above the bar's top edge, in the bar's
      // own space, so dragging or unpinning it carries them along: the two
      // handles at the left end, pause in the middle, the three that leave
      // the level at the right end.
      const barTop = VR_GUI_Y + session.gui.mesh.scale.y / 2;
      const y = barTop + VR_BAR_TOOL_SIZE * 0.8;
      // the status strip sits over the row, as wide as the bar itself
      const statusH = VR_GUI_WIDTH * VR_STATUS_H / VR_STATUS_W;
      vrStatusPanel.scale.set(VR_GUI_WIDTH, statusH, 1);
      vrStatusPanel.position.set(
        0, y + VR_BAR_TOOL_SIZE * 0.75 + statusH / 2, VR_GUI_Z);
      vrStatusPanel.visible = true;
      const step = VR_BAR_TOOL_SIZE * 1.15;
      const end = VR_GUI_WIDTH / 2 - VR_BAR_TOOL_SIZE * 0.6;
      vrLeftTools.forEach((b, i) => { b.position.x = -end + i * step; });
      vrPauseBtn.position.x = 0;
      vrRightTools.forEach((b, i) => {
        b.position.x = end - (vrRightTools.length - 1 - i) * step;
      });
      // the sound column stands off the bar's right end
      const sx = VR_GUI_WIDTH / 2 + VR_BAR_TOOL_SIZE * 0.85;
      const barBottom = VR_GUI_Y - session.gui.mesh.scale.y / 2;
      const muteHot = vrMuteBtn.userData.state.hovered;
      vrMuteBtn.scale.setScalar(
        VR_BAR_TOOL_SIZE * (muteHot ? VR_BAR_TOOL_HOVER : 1));
      vrMuteBtn.position.set(sx, barBottom + VR_BAR_TOOL_SIZE / 2,
        VR_GUI_Z + (muteHot ? VR_BAR_TOOL_SIZE * 0.25 : 0));
      vrMuteBtn.visible = true;
      vrVolumeSlider.scale.set(VR_BAR_TOOL_SIZE * 0.62, VR_VOLUME_HEIGHT, 1);
      vrVolumeSlider.position.set(sx,
        vrMuteBtn.position.y + VR_BAR_TOOL_SIZE / 2 + VR_VOLUME_HEIGHT / 2 + 0.008,
        VR_GUI_Z);
      vrVolumeSlider.visible = performance.now() < soundPanelUntil;
      for (const b of vrButtons) {
        // a hovered button grows and steps toward the player, the way a
        // hovered skill button does
        const hot = b.userData.state.hovered;
        b.scale.setScalar(VR_BAR_TOOL_SIZE * (hot ? VR_BAR_TOOL_HOVER : 1));
        b.position.y = y;
        b.position.z = VR_GUI_Z + (hot ? VR_BAR_TOOL_SIZE * 0.25 : 0);
        b.visible = true;
      }
    } else {
      for (const b of vrWidgets) b.visible = false;
      vrVolumeSlider.visible = false;
      vrStatusPanel.visible = false;
      session.gui.setReliefDepth(1);
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
    // A question on screen owns the ray: its two answers are the only things
    // that can be hit, so nothing behind it can be pressed by accident.
    if (vrModal.visible) {
      for (const b of [vrYesBtn, vrNoBtn]) {
        const hit = rc.intersectObject(b, false);
        if (hit.length) return hit[0];
      }
      return null;
    }
    if (vrSettings.visible) {
      const onClose = rc.intersectObject(vrSettingsClose, false);
      if (onClose.length) return onClose[0];
      const onPanel = rc.intersectObject(vrSettingsPanel, false);
      return onPanel.length ? onPanel[0] : null;
    }
    // the catalog owns it the same way: the grid and its close button only
    if (vrCatalog.visible) {
      const onClose = rc.intersectObject(vrCatalogClose, false);
      if (onClose.length) return onClose[0];
      const onPanel = rc.intersectObject(vrCatalogPanel, false);
      return onPanel.length ? onPanel[0] : null;
    }
    if (vrVolumeSlider.visible) {
      const hit = rc.intersectObject(vrVolumeSlider, false);
      if (hit.length) return hit[0];
    }
    // the icon buttons sit over the bar and the board and take the ray first
    for (const b of vrWidgets) {
      if (!b.visible) continue;
      const hit = rc.intersectObject(b, false);
      if (hit.length) return hit[0];
    }
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
    if (hit.object.name === "vr-volume") {
      // up the track is the value: the plane's own V, 0 at the bottom
      return { barTool: "volume", volume: hit.uv ? hit.uv.y : audio.volume };
    }
    if (hit.object.name === "vr-setpanel") {
      return { barTool: "setpanel", row: vrSettingsRowAt(hit.uv) };
    }
    if (hit.object.name === "vr-worldpanel") {
      // the grid is one plane: what is under the beam comes from the UV
      return vrCatalogPick(hit.uv);
    }
    if (hit.object.name.startsWith("vr-")) {
      return { barTool: hit.object.name.slice(3) };
    }
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
    setBarToolHover(p ? p.barTool : null);
    setVrCatalogHover(p && p.barTool === "worldpanel"
      ? (p.scrollBar ? -2 : p.tile) : -1);
    setVrSettingsHover(p && p.barTool === "setpanel" ? p.row : -1);
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

  /** Slide the diorama across the view. The camera is the headset, so the
   *  board shifts the opposite way to the push. */
  function panDioramaBy(dx, dy, seconds) {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const step = VR_STICK_PAN * seconds;
    dioramaRoot.position
      .sub(right.multiplyScalar(dx * step))
      .sub(up.multiplyScalar(dy * step));
  }

  /** Turn the diorama about its focus: yaw about world up, pitch about the
   *  headset's own horizontal. Same as left-drag and shift+arrows. */
  function tiltDioramaBy(dx, dy, seconds) {
    if (!session) return;
    const step = VR_STICK_TILT * seconds;
    const pivot = dioramaFocusWorld();
    rotateDioramaAroundPivot(new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * step), pivot);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    right.y = 0;
    if (right.lengthSq() > 1e-4) {
      rotateDioramaAroundPivot(new THREE.Quaternion()
        .setFromAxisAngle(right.normalize(), dy * step), pivot);
    }
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
    // the catalog scrolls instead, the way the sticks scroll it in a headset
    if (vrCatalog.visible) { scrollVrCatalog(e.deltaY); return; }
    const cur = dioramaRoot.scale.x;
    const next = THREE.MathUtils.clamp(
      cur * Math.pow(0.998, e.deltaY),
      VR_PIXEL_SCALE * 0.15, VR_PIXEL_SCALE * 8);
    scaleDioramaAbout(next, mouseCursorOnBoard
      ? mouseCursor.position.clone()
      : dioramaFocusWorld());
  }, { passive: false });

  // a volume slider or catalog scrollbar held down by the mouse
  let mouseScrub = null;

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
      // The in-scene controls answer to the mouse too: without controllers it
      // is the only pointer there is, and pause, restart and the catalog are
      // in the scene, not the DOM.
      const p0 = pick(e);
      if (p0 && p0.barTool) {
        if (p0.barTool === "volume" || p0.scrollBar) {
          // a scrubber follows the cursor until the button comes back up
          mouseScrub = p0.barTool;
          actOnPick(p0);
        }
        return; // a press on a control never orbits the board
      }
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
    if (mouseScrub) { mouseScrub = null; return; } // it acted as it was dragged
    const p = pick(e);
    if (p && p.barTool && vrMouseFallback()) { actOnPick(p); return; }
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
      if (mouseScrub && (e.buttons & 1)) {
        const on = pickWithRaycaster(rc);
        if (on && on.barTool === mouseScrub) actOnPick(on);
        return;
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
      // Mid-session callers without a frame pose: ask the XR camera, which is
      // only ever the head. The user camera is a copy the renderer refreshes
      // each frame, so anything on the desktop path can leave its own numbers
      // in it between renders.
      const eye = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
      eye.matrixWorld.decompose(headPos, headQuat, new THREE.Vector3());
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
    resetBar();
    layoutGuiPanel();
  });
  renderer.xr.addEventListener("sessionend", () => {
    camera.near = desktopClip.near;
    camera.far = desktopClip.far;
    camera.updateProjectionMatrix();
    // the session leaves the camera at the last headset pose (meter-scale,
    // near the scene origin); restore the page-load framing
    controls.enabled = true;
    // the in-scene windows are for the headset; the DOM does this on a monitor
    setVrModal(false);
    setVrCatalog(false);
    setVrSettings(false);
    // an unlocked bar is a VR notion: on the desktop it rides the camera
    resetBar();
    if (session) frameDesktopCamera(session.level);
    layoutGuiPanel();
  });

  /**
   * Act on a confirmed activation, wherever it came from: a controller
   * trigger, or the mouse in a session with no controllers. Everything the
   * in-scene controls do lives here, so both pointers reach all of it.
   */
  function actOnPick(p) {
    if (p.barTool === "lock") {
      setBarLocked(!barLocked);
    } else if (p.barTool === "move") {
      // nothing on a tap; it is the drag that moves the bar
    } else if (p.barTool === "volume") {
      audio.setVolume(p.volume);
      paintVolume();
    } else if (p.barTool === "mute") {
      audio.setEnabled(!audio.enabled);
      renderSoundBtn();
      if (audio.enabled && session) audio.playMusic(session.musicTrack || 0);
      paintVolume();
    } else if (p.barTool === "pause") {
      togglePause();
    } else if (p.barTool === "restart") {
      askVrConfirm("Restart level?", () => moveLevel(0));
    } else if (p.barTool === "prev") {
      askVrConfirm("Go back a level?", () => moveLevel(-1));
    } else if (p.barTool === "next") {
      askVrConfirm("Skip to the next level?", () => moveLevel(1));
    } else if (p.barTool === "settings") {
      setVrSettings(true);
    } else if (p.barTool === "setclose") {
      setVrSettings(false);
    } else if (p.barTool === "setpanel") {
      const row = vrSettingRows[p.row];
      if (row) { row.act(); paintVrSettings(); }
    } else if (p.barTool === "worlds") {
      setVrCatalog(true);
    } else if (p.barTool === "catclose") {
      setVrCatalog(false);
    } else if (p.barTool === "worldpanel") {
      // the scrollbar, pressed or dragged, moves the list instead
      if (p.scrollBar || p.scrubbing) {
        if (vrCatalogScrollTo(p.scrollAt)) paintVrCatalog();
      } else {
        const item = vrCatalogItems[p.tile];
        if (item) {
          setVrCatalog(false);
          library.enterWorld(item.gameType, item.group, item.level);
        }
      }
    } else if (p.barTool === "yes") {
      const act = vrConfirmAction;
      setVrModal(false);
      if (act) act();
    } else if (p.barTool === "no") {
      setVrModal(false);
    } else if (p.panelUv && session) {
      session.gui.onMouseDown(p.panelUv);
      session.gui.onMouseUp(p.panelUv);
    } else if (p.simX !== undefined) {
      actOnSimPick(p.simX, p.simY);
    }
  }

  const vr = new VRManager(renderer, scene, camera, dioramaRoot, {
    pickWithRaycaster,
    raycastHit,
    onSelectPick: actOnPick,
    onHoverPick: applyHover,
    onBarDragStart: () => { barDragFrom = guiRoot.position.clone(); },
    // the hand moves in world space; the bar hangs off the head or the scene,
    // so the delta is turned into whichever space it is living in
    onBarDrag: (worldDelta) => {
      if (!barDragFrom || !guiRoot.parent) return;
      const q = guiRoot.parent.getWorldQuaternion(new THREE.Quaternion());
      guiRoot.position.copy(barDragFrom)
        .add(worldDelta.clone().applyQuaternion(q.invert()));
    },
    // the pointing hand's stick pans, the other tilts (vr.js decides which) -
    // except while the catalog is up, when either stick scrolls its list and
    // neither one moves the board behind it
    onStick: (role, x, y, seconds) => {
      if (!session) return;
      if (vrCatalog.visible) {
        scrollVrCatalog(-y * VR_CAT_SCROLL * seconds);
        return;
      }
      if (role === "tilt") tiltDioramaBy(x, y, seconds);
      else panDioramaBy(x, y, seconds);
    },
    placeDiorama: placeDioramaForXR,
  });

  function togglePause() {
    if (!session) return;
    const timer = session.game.getGameTimer();
    timer.toggle();
    hud.pauseBtn.textContent = timer.isRunning() ? "pause" : "resume";
  }

  // ------------------------------------------------------- holding the sim
  /**
   * Anything on screen that the player has to deal with holds the clock: the
   * catalog, and either restart question. Lemmings should not be walking off
   * ledges behind a dialog.
   *
   * Only what was stopped gets restarted. The first holder remembers whether
   * the clock was running, and the last one to leave puts it back the way it
   * found it - so a game the player had already paused stays paused, and two
   * overlapping holders do not resume it between them.
   */
  const simHolders = new Set();
  let simWasRunning = false;

  function syncPauseLabel() {
    if (!session) return;
    hud.pauseBtn.textContent =
      session.game.getGameTimer().isRunning() ? "pause" : "resume";
  }

  function holdSim(who) {
    if (!session || simHolders.has(who)) return;
    const timer = session.game.getGameTimer();
    if (simHolders.size === 0) {
      simWasRunning = timer.isRunning();
      if (simWasRunning) timer.suspend();
    }
    simHolders.add(who);
    syncPauseLabel();
  }

  function releaseSim(who) {
    if (!simHolders.delete(who) || simHolders.size > 0) return;
    if (session && simWasRunning) session.game.getGameTimer().continue();
    simWasRunning = false;
    syncPauseLabel();
  }

  // -------------------------------------------------- confirmation dialog
  // The desktop twin of the in-scene question the VR restart asks.
  const confirmDom = {
    panel: document.getElementById("confirm"),
    title: document.getElementById("confirm-title"),
    body: document.getElementById("confirm-body"),
    yes: document.getElementById("confirm-yes"),
    no: document.getElementById("confirm-no"),
  };
  let confirmAction = null;

  /** Ask before anything that throws away a level in progress. */
  function askConfirm(title, verb, action) {
    confirmDom.title.textContent = title;
    confirmDom.body.textContent = "Progress on this level is lost.";
    confirmDom.yes.textContent = verb;
    confirmAction = action;
    confirmDom.panel.hidden = false;
    confirmDom.yes.focus();
    holdSim("confirm");
  }
  function closeConfirm() {
    confirmAction = null;
    confirmDom.panel.hidden = true;
    releaseSim("confirm");
  }
  confirmDom.yes.addEventListener("click", () => {
    const act = confirmAction;
    closeConfirm();
    if (act) act();
  });
  confirmDom.no.addEventListener("click", closeConfirm);
  // clicking off the dialog is a cancel, as it is anywhere else
  confirmDom.panel.addEventListener("click", (e) => {
    if (e.target === confirmDom.panel) closeConfirm();
  });

  window.addEventListener("keydown", (e) => {
    // a question on screen owns the keyboard: answer it or dismiss it, but
    // do not let a stray space bar pause the game behind it
    if (!confirmDom.panel.hidden) {
      if (e.key === "Escape") { e.preventDefault(); closeConfirm(); }
      else if (e.key === "Enter") { e.preventDefault(); confirmDom.yes.click(); }
      return;
    }
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
        // the piece editor is the edit mode's tool; asking for it enters it
        if (!state.edit) {
          state.edit = true;
          try { localStorage.setItem("lem3d-edit", "on"); } catch (err) {}
          renderMode();
        }
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

  // Leaving a level in progress asks first, whichever way you leave it. The
  // `,` and `.` keys still jump straight there: a shortcut that stops to ask
  // is no longer a shortcut.
  document.getElementById("btn-prev").addEventListener("click",
    () => askConfirm("Go back a level?", "go back", () => moveLevel(-1)));
  document.getElementById("btn-next").addEventListener("click",
    () => askConfirm("Skip to the next level?", "skip", () => moveLevel(1)));
  document.getElementById("btn-restart").addEventListener("click",
    () => askConfirm("Restart level?", "restart", () => moveLevel(0)));
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
      // point size does not follow the diorama's scale, so it is reapplied
      // here: grips, sticks and drags all change that scale mid-session
      session.particles.updateScale();
      updateHoverRing(); // ring keeps following the hovered lemming
      session.gui.update();
      layoutGuiPanel(); // no-ops unless the viewport or mode changed
      if (renderer.xr.isPresenting) {
        // the pause icon tracks the clock however it was stopped - this
        // button, the panel, the space bar or the catalog
        setBarToolState(vrPauseBtn,
          { on: !session.game.getGameTimer().isRunning() });
        layoutVrModal();
        layoutVrCatalog();
        layoutVrSettings();
      } else if (vrPauseBtn.visible) {
        setVrModal(false);
        setVrCatalog(false);
        setVrSettings(false);
      }
    }
    if (renderer.xr.isPresenting) {
      // grabs, sticks and hover; the headset pose drives the camera
      vr.update(dt / 1000);
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
    // the catalog is a way into a level in either mode; only the tagging
    // workbench opens the editor with it
    if (state.edit && session && session.editor) session.editor.enable();
  }, (open) => {
    if (open) holdSim("library");
    else releaseSim("library");
  });
  document.getElementById("btn-library").addEventListener("click", () => library.toggle());
  renderMode(); // billing, catalog labels and editor availability

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
