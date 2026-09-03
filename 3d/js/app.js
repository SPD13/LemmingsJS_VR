"use strict";
/**
 * Lemmings 3D validation mode: runs the untouched LemmingsJS simulation and
 * renders it as an extruded diorama with Three.js in a normal browser tab.
 * Same scene graph the VR build will use, orbit camera instead of a headset.
 *
 * URL params: ?level=<id> - a level's path in levels/index.json, e.g.
 *             lemmings/0/3 or LemmingsPlus_All_20201114/Lemmings_Plus_I/Wimpy/Just_Walk!.nxlv
 *             (the old ?type=1|2&group=N&level=N still name a classic level),
 *             ?speed=N, ?replay=<string from the 'r' key dump>
 *
 * With no level in the URL the page opens on the world library, at the root
 * of levels/, and nothing plays until one is chosen there. A level named in
 * the URL loads straight away, as a headset's bookmark or a replay link needs.
 */

(function () {
  // lemmings live embedded mid-slab (sprite centered at TERRAIN_DEPTH/2), so
  // they walk inside the carved space rather than floating in front of it;
  // normal objects (hatch/exit/traps) sit just behind them at the same depth
  const LEMMING_Z = TERRAIN_DEPTH / 2 - SPRITE_DEPTH / 2;
  const OBJECT_Z = LEMMING_Z - 0.8;
  const OBJECT_BG_Z = -1.4;
  const OBJECT_DECAL_Z = TERRAIN_DEPTH + 0.25;

  window.__LEM3D_BUILD = "2026-09-02.1";
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
    skillBar: setting("skillbar", "lem3d-skillbar", true), // the skill bar's relief
    shadows: setting("shadows", "lem3d-shadows", true),  // NeoLemmix's skill shadows (a hotkey toggles them)
    music: setting("music", "lem3d-music", true),        // the music, apart from the sound (a hotkey toggles it)
    // Editing is the tagging workbench: the piece editor, the tagging marks
    // in the catalog, the "validation mode" billing. Playing is the game.
    edit: setting("edit", "lem3d-edit", false),
    // The level, by its id in the tree (see library.js). A bare number in
    // ?level= is the old addressing, resolved with ?type= and ?group=.
    levelId: /\//.test(params.get("level") || "") ? params.get("level") : null,
    // whether the URL named a level at all: without one the page starts on
    // the world library and waits for a choice, rather than playing the
    // first level there is
    asked: params.has("level") || params.has("type") || params.has("group"),
    legacy: {
      type: parseInt(params.get("type") || "1", 10),
      group: parseInt(params.get("group") || "0", 10),
      level: parseInt(params.get("level") || "0", 10),
    },
    engine: null,   // "classic" or "lemmix": which engine plays levelId
    gameType: 1, group: 0, level: 0, // the classic engine's own addressing of it
    speed: parseFloat(params.get("speed") || "1"),
    replay: params.get("replay"),
    nxrp: params.get("nxrp"),      // a NeoLemmix .nxrp replay, for Lemmix levels
  };

  /** A lemming's action name, from either engine. */
  const actionName = (lem) => typeof lem.getActionName === "function"
    ? lem.getActionName() : (lem.action ? lem.action.getActionName() : null);
  // NeoLemmix sound cue -> the AdLib effect that stands in for it (file
  // sounds are a later phase)
  const SFX_BY_CUE = {
    assign: SFX.ASSIGN, chink: SFX.STEEL, letsgo: SFX.LETSGO, door: SFX.DOOR, yippee: SFX.YIPPEE,
    ohno: SFX.OHNO, explode: SFX.EXPLODE, splat: SFX.SPLAT, glug: SFX.DROWN, ting: SFX.TING,
    pickup: SFX.CLICK, exitopen: SFX.CLICK, fire: SFX.TRAP, thud: SFX.TRAP, electric: SFX.CLICK,
  };

  const hud = {
    name: document.getElementById("level-name"),
    meta: document.getElementById("level-meta"),
    state: document.getElementById("game-state"),
    text: document.getElementById("level-text"),
    textToggle: document.getElementById("level-text-toggle"),
    textBody: document.getElementById("level-text-body"),
    hover: document.getElementById("hud-hover"),
    loading: document.getElementById("loading"),
    pauseBtn: document.getElementById("btn-pause"),
    title: document.getElementById("hud-title"),
    modeBtn: document.getElementById("btn-mode"),
    editor: document.getElementById("hud-editor"),
  };

  /**
   * A level's own text - a NeoLemmix opening text, or its closing text once
   * it is won - sits folded behind a "detail" label, since it can run to a
   * paragraph. No lines, no label. A headset reads it in its own window,
   * behind the status strip's detail button (setVrDetail).
   */
  let levelTextLines = null;
  /**
   * A level's text comes hard-wrapped for the game's own 320-px screen. Run
   * the lines together into paragraphs - a blank line is a break - so it
   * flows to whatever width it is shown at instead of stopping short.
   */
  function flowLevelText(lines) {
    const paragraphs = [];
    let cur = "";
    for (const raw of lines) {
      const line = String(raw).trim();
      if (!line) { if (cur) { paragraphs.push(cur); cur = ""; } continue; }
      cur = cur ? cur + " " + line : line;
    }
    if (cur) paragraphs.push(cur);
    return paragraphs;
  }
  function setLevelText(lines) {
    const has = !!(lines && lines.length);
    levelTextLines = has ? flowLevelText(lines) : null;
    if (!has) setVrDetail(false);
    hud.text.hidden = !has;
    hud.textBody.hidden = true;
    hud.textBody.textContent = has ? levelTextLines.join("\n\n") : "";
    hud.textToggle.innerHTML = "detail &#9656;";
  }
  hud.textToggle.addEventListener("click", (e) => {
    e.preventDefault();
    hud.textBody.hidden = !hud.textBody.hidden;
    hud.textToggle.innerHTML = hud.textBody.hidden ? "detail &#9656;" : "detail &#9662;";
  });

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
    mesh.userData.draw = draw; // shared with the HUD's twin of this button
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
    noteVrTipHover(name);
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
  // a board over a bar, with an arrow between: put the bar back where a
  // session starts it, below the board
  const barParkBtn = makeIconButton("vr-park", guiRoot, (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#33405a" : "#1c2432", "#cdd6e4", (c) => {
      c.strokeRect(17, 12, 30, 16);        // the board
      c.fillStyle = "#cdd6e4";
      c.fillRect(13, 44, 38, 7);           // the bar
      c.beginPath();                        // the arrow down to it
      c.moveTo(32, 30); c.lineTo(32, 41);
      c.moveTo(26, 36); c.lineTo(32, 41); c.lineTo(38, 36);
      c.stroke();
    });
  });

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

  const vrLeftTools = [barLockBtn, barMoveBtn, barParkBtn, vrSettingsBtn];
  const vrRightTools = [vrWorldsBtn, vrPrevBtn, vrRestartBtn, vrNextBtn];
  const vrButtons = vrLeftTools.concat([vrPauseBtn], vrRightTools);

  /**
   * A HUD button wearing an icon in the VR bar's style: a painter (usually
   * a VR button's own, so the two views share one look) on a small canvas.
   * Returns a repaint that takes the icon's state (on: paused, muted);
   * hover comes from the mouse.
   */
  function iconizeHudButton(button, draw, title) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const cx = cv.getContext("2d");
    button.textContent = "";
    button.appendChild(cv);
    button.classList.add("icon");
    button.title = title;
    const st = { on: false, hovered: false };
    const repaint = (patch) => {
      Object.assign(st, patch || {});
      draw(cx, st);
    };
    button.addEventListener("mouseenter", () => repaint({ hovered: true }));
    button.addEventListener("mouseleave", () => repaint({ hovered: false }));
    repaint();
    return repaint;
  }
  // a crosshair: the view back to where the level starts (desktop only;
  // in a headset that is the recentre, which has no button on the bar)
  const resetViewIcon = (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#33405a" : "#1c2432", "#cdd6e4", (c) => {
      c.beginPath();
      c.arc(32, 32, 13, 0, Math.PI * 2);
      c.moveTo(32, 10); c.lineTo(32, 20);
      c.moveTo(32, 44); c.lineTo(32, 54);
      c.moveTo(10, 32); c.lineTo(20, 32);
      c.moveTo(44, 32); c.lineTo(54, 32);
      c.stroke();
      c.fillStyle = "#cdd6e4";
      c.beginPath();
      c.arc(32, 32, 3.5, 0, Math.PI * 2);
      c.fill();
    });
  };
  const hudIcons = {
    prev: iconizeHudButton(document.getElementById("btn-prev"), vrPrevBtn.userData.draw, "previous level"),
    restart: iconizeHudButton(document.getElementById("btn-restart"), vrRestartBtn.userData.draw, "restart the level"),
    next: iconizeHudButton(document.getElementById("btn-next"), vrNextBtn.userData.draw, "next level"),
    pause: iconizeHudButton(hud.pauseBtn, vrPauseBtn.userData.draw, "pause / resume"),
    worlds: iconizeHudButton(document.getElementById("btn-library"), vrWorldsBtn.userData.draw, "world library"),
    sound: iconizeHudButton(document.getElementById("btn-sound"), vrMuteBtn.userData.draw, "sound on / off"),
    view: iconizeHudButton(document.getElementById("btn-view"), resetViewIcon, "reset the view (Home)"),
  };
  // the sound column keeps its own place, so it is not in the row above, but
  // it is pressed like the rest
  // three lines of text: the level's own text, off the status strip's end (laid out with it)
  const vrDetailBtn = makeIconButton("vr-detail", dioramaRoot, (cx, st) => {
    barToolIcon(cx, st.hovered, st.hovered ? "#26485c" : "#152a36", "#7fd6e8", (c) => {
      c.beginPath();
      c.moveTo(16, 20); c.lineTo(48, 20);
      c.moveTo(16, 32); c.lineTo(48, 32);
      c.moveTo(16, 44); c.lineTo(36, 44);
      c.stroke();
    });
  });

  const vrWidgets = vrButtons.concat([vrMuteBtn, vrDetailBtn]);

  // The in-scene windows - the restart question, the world catalog and the
  // settings - hang off this root, which is fixed in the world: when a
  // window opens, the root is set to where the head is looking, so the
  // window is centred in the view, and there it stays while the head moves.
  // Recentring (A/X, the settings row, the reset button) sets it again.
  const vrWindowRoot = new THREE.Group();
  scene.add(vrWindowRoot);
  let vrWindowsPlaced = false; // set from the first head pose of a session

  // Restart asks first. A DOM dialog is invisible in a headset, so the
  // question is in the scene, squarely in front: while it is up it takes the
  // ray and nothing behind it can be hit.
  const vrModal = new THREE.Group();
  vrModal.visible = false;
  vrWindowRoot.add(vrModal);
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
    mesh.userData.ask = (title, body) => {
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
      cx.fillText(body || "progress on this level is lost", 256, 114);
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
  /** Whether any of the three windows is up: a second one opening while
   *  another is up shares its frame rather than moving it. */
  function anyVrWindowUp() {
    return vrModal.visible || vrCatalog.visible || vrSettings.visible || vrDetail.visible;
  }

  /**
   * A bar riding the head would sit across a window. While one is up, such
   * a bar is parked where the bar starts a session - below the board, in
   * the room - and when the last window goes it is handed back to the head
   * exactly as it was hanging. A bar already in the room is left alone.
   */
  let barParked = null; // the head-relative transform to give back
  function syncBarForWindows() {
    const up = anyVrWindowUp();
    if (up && !barParked && barLocked && session) {
      barParked = {
        position: guiRoot.position.clone(),
        quaternion: guiRoot.quaternion.clone(),
        scale: guiRoot.scale.clone(),
      };
      placeBarBelowDiorama();
    } else if (!up && barParked) {
      const back = barParked;
      barParked = null;
      setBarLocked(true);
      guiRoot.position.copy(back.position);
      guiRoot.quaternion.copy(back.quaternion);
      guiRoot.scale.copy(back.scale);
      barDragFrom = null;
    }
  }

  let vrModalNotice = false; // one button (OK) rather than a yes and a no
  function setVrModal(open, notice) {
    if (open && renderer.xr.isPresenting && !anyVrWindowUp()) placeVrWindows();
    vrModal.visible = open && renderer.xr.isPresenting;
    vrModalNotice = vrModal.visible && !!notice;
    for (const b of [vrYesBtn, vrNoBtn]) {
      b.visible = vrModal.visible && !(vrModalNotice && b === vrNoBtn);
      setBarToolState(b, { hovered: false });
    }
    if (vrModal.visible) holdSim("vr-modal");
    else { vrConfirmAction = null; releaseSim("vr-modal"); }
    syncBarForWindows();
    if (vrModal.visible) layoutVrModal(); // its buttons where this dialog wants them, now
  }

  let vrConfirmAction = null;
  /** The in-scene twin of askConfirm: the same three questions, in a headset. */
  function askVrConfirm(title, action) {
    vrModalPanel.userData.ask(title);
    setVrModal(true);
    vrConfirmAction = action; // after setVrModal, which clears it on close
  }

  /** A notice in the same frame, with one button to take it away. */
  function askVrNotice(title, body) {
    vrModalPanel.userData.ask(title, body);
    setVrModal(true, true);
  }

  /** Lay the dialog out in front of the eyes, in metres of camera space. */
  function layoutVrModal() {
    const w = VR_MODAL_WIDTH, h = w * 192 / 512;
    vrModalPanel.scale.set(w, h, 1);
    vrModalPanel.position.set(0, VR_MODAL_Y, VR_MODAL_Z);
    const size = VR_BAR_TOOL_SIZE * 1.3;
    for (const [b, side] of [[vrYesBtn, vrModalNotice ? 0 : -1], [vrNoBtn, 1]]) {
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
  const VR_CAT_BAND_H = 48;               // the heading: where in the tree we are
  const VR_CAT_ROW_H = 60;                // a directory row
  const VR_CAT_BAR_W = 16;                // the scrollbar down the right edge
  const VR_CAT_BAR_GRAB = 12;             // slack either side of it, for the ray
  const VR_CAT_SCROLL = 900;              // canvas px/second at full stick
  // The window the list scrolls behind.
  const VR_CAT_VIEW_X = VR_CAT_PAD;
  const VR_CAT_VIEW_Y = VR_CAT_TOP;
  const VR_CAT_VIEW_W = VR_CAT_W - 2 * VR_CAT_PAD - VR_CAT_BAR_W - 8;
  const VR_CAT_VIEW_H = VR_CAT_H - VR_CAT_TOP - VR_CAT_PAD;

  let vrCatalogItems = [];   // what the directory holds: rows, or level tiles
  let vrCatalogCells = [];   // one per item, in the list's own coordinates
  let vrCatalogBands = [];   // the heading above them
  let vrCatalogHeading = ""; // the path down the tree to here
  let vrCatalogHeight = 0;   // how tall the whole list is
  let vrCatalogScroll = 0;   // how far down it we are
  let vrCatalogHover = -1;
  let vrCatalogNote = "";

  const vrCatalog = new THREE.Group();
  vrCatalog.visible = false;
  vrWindowRoot.add(vrCatalog);

  /**
   * Lay the whole list out once, in its own coordinates: the heading saying
   * where we are, then a full-width row per directory, or rows of level
   * tiles. Painting and picking both work from this, offset by the scroll.
   */
  function layoutVrCatalogList() {
    vrCatalogCells = [];
    vrCatalogBands = [];
    const colW = VR_CAT_VIEW_W / VR_CAT_COLS;
    let y = 0;              // the top of whatever is placed next
    let col = VR_CAT_COLS;  // == VR_CAT_COLS: no row is open
    if (vrCatalogHeading) {
      vrCatalogBands.push({ label: vrCatalogHeading, y, h: VR_CAT_BAND_H });
      y += VR_CAT_BAND_H;
    }
    vrCatalogItems.forEach((item, i) => {
      if (item.kind !== "level") {
        // a directory (or the way back up) takes a row of its own
        if (col < VR_CAT_COLS) { y += VR_CAT_TILE_H; col = VR_CAT_COLS; }
        vrCatalogCells.push({
          item, i,
          x: VR_CAT_VIEW_X + VR_CAT_GAP / 2,
          y: y + VR_CAT_GAP / 2,
          w: VR_CAT_VIEW_W - VR_CAT_GAP,
          h: VR_CAT_ROW_H - VR_CAT_GAP,
        });
        y += VR_CAT_ROW_H;
        return;
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
        const hot = cell.i === vrCatalogHover;
        if (it.kind !== "level") {
          // a directory row: name, classic/lemmix, how many levels, how many done
          const all = it.kind === "dir" && it.done === it.count && it.count > 0;
          cx.fillStyle = it.kind === "back" ? (hot ? "#232b3a" : "rgba(255,255,255,0.03)")
            : all ? (hot ? "#2c7042" : "#1d4a2b") : (hot ? "#2b3548" : "#19202c");
          cx.beginPath();
          cx.roundRect ? cx.roundRect(cell.x, cell.y, cell.w, cell.h, 10)
                       : cx.rect(cell.x, cell.y, cell.w, cell.h);
          cx.fill();
          if (hot) { cx.strokeStyle = "#ffffff"; cx.lineWidth = 3; cx.stroke(); }
          cx.textAlign = "left";
          cx.fillStyle = it.kind === "back" ? "#8fa1bb" : "#f0f3f8";
          cx.font = "bold 24px monospace";
          cx.fillText(fit(it.label, cell.w - 520), cell.x + 16, cell.y + 31);
          if (it.kind === "dir") {
            cx.font = "16px monospace";
            cx.fillStyle = it.engine === "lemmix" ? "#ffb066" : "#7fd6e8";
            cx.fillText((it.engine || "").toUpperCase(), cell.x + cell.w - 470, cell.y + 30);
            cx.textAlign = "right";
            cx.fillStyle = "#cdd6e4";
            cx.font = "20px monospace";
            cx.fillText(it.count + " levels", cell.x + cell.w - 230, cell.y + 31);
            cx.fillStyle = all ? "#6fce7e" : "#8fa1bb";
            cx.fillText(it.done + " / " + it.count + " cleared", cell.x + cell.w - 16, cell.y + 31);
            cx.textAlign = "left";
          }
          continue;
        }
        const done = it.best !== null;
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
    library.thumbnail(item.levelId, width, VR_CAT_THUMB_H)
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
   * The directory the library is looking at, as the headset's list: a row per
   * subdirectory (with its classic/lemmix mark and counts), or the level tiles
   * where the directory holds levels, in the order they are played. Opening
   * the catalog (`landing`) goes to the directory of the level being played;
   * a row press descends and the back row ascends, through the same library
   * object the DOM browser uses. Which levels are cleared is re-read on each
   * visit, since that changes as the player plays.
   */
  async function loadVrCatalog(landing) {
    vrCatalogNote = "loading…";
    paintVrCatalog();
    let node;
    try {
      await library.tree();
      if (landing) {
        const hit = state.levelId && LevelTree.byId.get(state.levelId);
        if (hit) library.navigate(hit.node.path);
      }
      node = library.currentNode() || LevelTree.root;
    } catch (err) {
      vrCatalogNote = "catalog unavailable";
      paintVrCatalog();
      console.error(err);
      return;
    }
    const chain = [];
    for (let n = node; n; n = n.parent) chain.unshift(n.name);
    vrCatalogHeading = chain.join(" › ");
    const items = [];
    if (node.parent) items.push({ kind: "back", label: "‹ back" });
    if (node.levels && node.levels.length) {
      if (node.engine === "classic") {
        vrCatalogNote = "scanning levels…";
        paintVrCatalog();
        await library.ensureNames(node); // classic names come from a scan
      }
      const playable = library.canLoad(node.engine);
      node.levels.forEach((level, i) => {
        items.push({
          kind: "level", levelId: level.id, playable,
          label: node.name + " " + (i + 1),
          name: library.levelName(level.id),
          set: library.worldOf(level.id),
          best: LevelProgress.best(level.id),
          current: level.id === state.levelId,
          thumb: null, thumbReq: false,
        });
      });
      vrCatalogNote = playable ? "" : "needs the Lemmix engine";
    } else {
      for (const child of node.children || []) {
        items.push({
          kind: "dir", node: child, label: child.name, engine: child.engine,
          count: child.count, done: LevelProgress.clearedUnder(child),
        });
      }
      vrCatalogNote = "";
    }
    vrCatalogItems = items;
    vrCatalogScroll = 0;
    layoutVrCatalogList();
    // open on the level being played, so the list starts where the player is
    const here = items.findIndex((it) => it.current);
    if (here >= 0) vrCatalogRevealItem(here);
    if (library.locked && !vrCatalogNote) vrCatalogNote = "choose a level to play";
    paintVrCatalog();
  }

  // --------------------------------------------------------- tooltips (VR)
  /**
   * The icon buttons carry no words, so a beam that rests on one for a
   * moment gets a label: a small strip just above the button, in the
   * button's own plane, saying what it does (and, for a switch, which way
   * it would go). It comes after a delay so that a beam merely crossing the
   * row does not flash labels, and it goes the moment the beam leaves.
   */
  const VR_TIP_DELAY = 1500;              // ms of rest before the label shows
  const VR_TIP_H = 56, VR_TIP_PAD = 22;   // canvas px
  const VR_TIP_HEIGHT = 0.03;             // metres
  const vrTipTexts = {
    lock: () => barLocked ? "let the bar go: it stays where it hangs" : "lock the bar to your head",
    move: () => "hold the trigger here and move your hand to carry the bar",
    park: () => "put the bar back below the board",
    settings: () => "settings",
    pause: () => session && !session.game.getGameTimer().isRunning() ? "resume" : "pause",
    restart: () => "restart the level (asks first)",
    prev: () => "previous level (asks first)",
    next: () => "next level (asks first)",
    worlds: () => "world library: choose a level",
    mute: () => audio.enabled ? "sound off" : "sound on",
    catclose: () => "close the library",
    setclose: () => "close the settings",
    detail: () => "the level's text",
  };
  let vrTipName = null;   // the icon button under the beam, by bare name
  let vrTipSince = 0;     // when the beam arrived on it
  let vrTipText = "";     // what the label says now
  const vrTip = (() => {
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = VR_TIP_H;
    const cx = cv.getContext("2d");
    let tex = new THREE.CanvasTexture(cv);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      }));
    mesh.name = "vr-tip";
    mesh.renderOrder = GUI_ORDER_MODAL_BTN + 1; // over every window and button
    mesh.visible = false;
    mesh.userData.paint = (text) => {
      cx.font = "bold 28px monospace";
      const w = Math.ceil(cx.measureText(text).width) + 2 * VR_TIP_PAD;
      if (cv.width !== w) { cv.width = w; }        // resizing clears the canvas
      cx.clearRect(0, 0, cv.width, cv.height);
      cx.fillStyle = "rgba(10, 14, 22, 0.96)";
      cx.beginPath();
      cx.roundRect ? cx.roundRect(2, 2, w - 4, VR_TIP_H - 4, 12) : cx.rect(2, 2, w - 4, VR_TIP_H - 4);
      cx.fill();
      cx.strokeStyle = "#ffd866";
      cx.lineWidth = 3;
      cx.stroke();
      cx.fillStyle = "#f0f3f8";
      cx.font = "bold 28px monospace";
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillText(text, w / 2, VR_TIP_H / 2 + 1);
      // a resized canvas needs a fresh texture; a repaint of the same size
      // just re-uploads
      tex.dispose();
      tex = new THREE.CanvasTexture(cv);
      mesh.material.map = tex;
      mesh.material.needsUpdate = true;
      mesh.scale.set(VR_TIP_HEIGHT * w / VR_TIP_H, VR_TIP_HEIGHT, 1);
    };
    scene.add(mesh);
    return mesh;
  })();

  /** The beam is on this button (or, null, on none): restart the wait. */
  function noteVrTipHover(name) {
    if (name === vrTipName) return;
    vrTipName = name && vrTipTexts[name] ? name : null;
    vrTipSince = performance.now();
    vrTip.visible = false;
  }

  /** Per frame in a session: show the label once the beam has rested, and
   *  keep it just above its button, in the button's plane. */
  function updateVrTip() {
    const button = vrTipName && iconButtons.find((b) => b.name === "vr-" + vrTipName);
    if (!button || !button.visible || performance.now() - vrTipSince < VR_TIP_DELAY) {
      vrTip.visible = false;
      return;
    }
    const text = vrTipTexts[vrTipName]();
    if (text !== vrTipText || !vrTip.visible) {
      vrTipText = text;
      vrTip.userData.paint(text);
    }
    button.updateWorldMatrix(true, false);
    const q = button.parent.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const size = button.getWorldScale(new THREE.Vector3()).y;
    vrTip.position.copy(button.getWorldPosition(new THREE.Vector3()))
      .addScaledVector(up, size / 2 + VR_TIP_HEIGHT / 2 + 0.012);
    vrTip.quaternion.copy(q);
    vrTip.visible = true;
  }

  // ------------------------------------------------------ level text (VR)
  /**
   * A level's own text - the opening text, or the closing text once it is
   * won - behind the strip's detail button: a window in the dialogs' plane
   * with the text on the author's lines, word-wrapped, and an OK to close
   * it. It holds the clock like the other windows, and gives it back the
   * way it found it.
   */
  const VR_DETAIL_W = 768, VR_DETAIL_PAD = 36;   // canvas px
  const VR_DETAIL_LINE = 34, VR_DETAIL_FONT = "26px monospace";
  const VR_DETAIL_MAX_LINES = 16;
  const VR_DETAIL_OK = { w: 168, h: 58 };        // the OK button
  const VR_DETAIL_WIDTH = 0.5;                   // metres
  const vrDetail = new THREE.Group();
  vrDetail.visible = false;
  vrWindowRoot.add(vrDetail);
  let vrDetailOkHot = false;
  let vrDetailOkRect = { x: 0, y: 0, w: 0, h: 0 };
  let vrDetailLines = [];
  const vrDetailPanel = (() => {
    const cv = document.createElement("canvas");
    cv.width = VR_DETAIL_W; cv.height = 256;
    const cx = cv.getContext("2d");
    let tex = new THREE.CanvasTexture(cv);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      }));
    mesh.name = "vr-detailpanel";
    mesh.renderOrder = GUI_ORDER_MODAL;
    /** Break the author's lines at words to the window's width. */
    const wrap = (lines) => {
      cx.font = VR_DETAIL_FONT;
      const max = VR_DETAIL_W - 2 * VR_DETAIL_PAD;
      const out = [];
      for (const line of lines) {
        let cur = "";
        for (const word of String(line).split(/\s+/)) {
          const next = cur ? cur + " " + word : word;
          if (cur && cx.measureText(next).width > max) { out.push(cur); cur = word; }
          else cur = next;
        }
        out.push(cur);
      }
      if (out.length > VR_DETAIL_MAX_LINES) {
        out.length = VR_DETAIL_MAX_LINES;
        out[VR_DETAIL_MAX_LINES - 1] += " \u2026";
      }
      return out;
    };
    mesh.userData.paint = (lines) => {
      vrDetailLines = wrap(lines || []);
      const textTop = 40;
      const okTop = textTop + vrDetailLines.length * VR_DETAIL_LINE + 24;
      const h = okTop + VR_DETAIL_OK.h + 30;
      if (cv.height !== h) cv.height = h; // resizing clears the canvas
      cx.clearRect(0, 0, VR_DETAIL_W, h);
      cx.fillStyle = "rgba(10, 14, 22, 0.96)";
      cx.beginPath();
      cx.roundRect ? cx.roundRect(2, 2, VR_DETAIL_W - 4, h - 4, 16) : cx.rect(2, 2, VR_DETAIL_W - 4, h - 4);
      cx.fill();
      cx.strokeStyle = "#ffd866";
      cx.lineWidth = 4;
      cx.stroke();
      cx.fillStyle = "#cdd6e4";
      cx.font = VR_DETAIL_FONT;
      cx.textAlign = "left";
      cx.textBaseline = "alphabetic";
      vrDetailLines.forEach((line, i) => {
        cx.fillText(line, VR_DETAIL_PAD, textTop + (i + 1) * VR_DETAIL_LINE - 8);
      });
      vrDetailOkRect = {
        x: (VR_DETAIL_W - VR_DETAIL_OK.w) / 2, y: okTop, w: VR_DETAIL_OK.w, h: VR_DETAIL_OK.h,
      };
      const r = vrDetailOkRect;
      cx.fillStyle = vrDetailOkHot ? "#1d5030" : "#12331d";
      cx.beginPath();
      cx.roundRect ? cx.roundRect(r.x, r.y, r.w, r.h, 12) : cx.rect(r.x, r.y, r.w, r.h);
      cx.fill();
      cx.strokeStyle = vrDetailOkHot ? "#ffffff" : "#6fce7e";
      cx.lineWidth = 3;
      cx.stroke();
      cx.fillStyle = "#6fce7e";
      cx.font = "bold 30px monospace";
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillText("OK", r.x + r.w / 2, r.y + r.h / 2 + 1);
      // a resized canvas needs a fresh texture
      tex.dispose();
      tex = new THREE.CanvasTexture(cv);
      mesh.material.map = tex;
      mesh.material.needsUpdate = true;
      mesh.scale.set(VR_DETAIL_WIDTH, VR_DETAIL_WIDTH * h / VR_DETAIL_W, 1);
    };
    mesh.userData.paint([]);
    vrDetail.add(mesh);
    return mesh;
  })();

  /** Is this UV on the window's OK? */
  function vrDetailOkAt(uv) {
    if (!uv) return false;
    const x = uv.x * VR_DETAIL_W, y = (1 - uv.y) * vrDetailPanel.material.map.image.height;
    const r = vrDetailOkRect;
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  }

  function setVrDetailHover(hot) {
    if (vrDetailOkHot === hot) return;
    vrDetailOkHot = hot;
    if (vrDetail.visible) vrDetailPanel.userData.paint(levelTextLines);
  }

  /** Show or hide the level's text, holding the clock while it is read. */
  function setVrDetail(open) {
    const show = open && renderer.xr.isPresenting && !!(levelTextLines && levelTextLines.length);
    if (show === vrDetail.visible) return;
    if (show && !anyVrWindowUp()) placeVrWindows();
    vrDetail.visible = show;
    if (show) { vrDetailOkHot = false; vrDetailPanel.userData.paint(levelTextLines); holdSim("vr-detail"); }
    else releaseSim("vr-detail");
    syncBarForWindows();
  }

  /** In the dialogs' plane, like every other window. */
  function layoutVrDetail() {
    vrDetailPanel.position.set(0, VR_MODAL_Y, VR_MODAL_Z);
  }

  // --------------------------------------------------------- settings (VR)
  /**
   * The render switches, in the scene. They are DOM buttons on a monitor,
   * which a headset cannot reach: a framerate that suffers mid-session used
   * to mean taking the headset off (or knowing the URL params). The panel
   * calls exactly what the buttons call, so the two stay in step, and it
   * carries the recentre that is otherwise only on the A/X button.
   */
  const VR_SET_W = 640, VR_SET_H = 468;   // canvas pixels
  const VR_SET_TOP = 96;                  // first row
  const VR_SET_ROW = 68;

  const vrSettingRows = [
    { label: "3D terrain", get: () => state.emboss, act: () => toggleEmboss() },
    { label: "3D doors", get: () => state.doors, act: () => toggleDoors() },
    { label: "smooth", get: () => state.smooth, act: () => toggleSmooth() },
    { label: "3D skills bar", get: () => state.skillBar, act: () => toggleSkillBar() },
    { label: "recentre the board", act: () => vr.recenterNow() },
  ];
  let vrSettingsHover = -1;

  const vrSettings = new THREE.Group();
  vrSettings.visible = false;
  vrWindowRoot.add(vrSettings);

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
    if (show && !anyVrWindowUp()) placeVrWindows();
    vrSettings.visible = show;
    vrSettingsClose.visible = show;
    setBarToolState(vrSettingsClose, { hovered: false });
    setVrSettingsHover(-1);
    if (show) { holdSim("vr-settings"); paintVrSettings(); }
    else releaseSim("vr-settings");
    syncBarForWindows();
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
    dioramaRoot.add(mesh); // over the board, in its own pixels: see layoutVrStatus
    return mesh;
  })();

  /**
   * The strip stands over the board, centred on the level's focus, in the
   * board's own pixels - as wide as the bar is at the board's default scale
   * - so it stays with the level however the board is moved or scaled. The
   * detail button sits off its right end when the level has a text, and
   * the REPLAY plate above it while an attempt is replaying.
   */
  const VR_STATUS_GAP = 14; // px between the level's top edge and the strip
  const vrStatusPx = () => {
    const w = VR_GUI_WIDTH / VR_PIXEL_SCALE;
    return { w, h: w * VR_STATUS_H / VR_STATUS_W };
  };
  function layoutVrStatus() {
    if (!session) return;
    const level = session.level;
    const { w, h } = vrStatusPx();
    const x = level.screenPositionX + 200;
    const y = level.height + VR_STATUS_GAP + h / 2;
    vrStatusPanel.scale.set(w, h, 1);
    vrStatusPanel.position.set(x, y, TERRAIN_DEPTH + 2);
    vrStatusPanel.visible = true;
    const size = VR_BAR_TOOL_SIZE / VR_PIXEL_SCALE;
    const hot = vrDetailBtn.userData.state.hovered;
    vrDetailBtn.scale.setScalar(size * (hot ? VR_BAR_TOOL_HOVER : 1));
    vrDetailBtn.position.set(
      x + w / 2 + size * 0.7, y, TERRAIN_DEPTH + 3 + (hot ? size * 0.25 : 0));
    vrDetailBtn.visible = !!(levelTextLines && levelTextLines.length);
    if (vrReplayLabel) {
      const rw = w * 0.3, rh = rw * VR_REPLAY_H / VR_REPLAY_W;
      vrReplayLabel.scale.set(rw, rh, 1);
      vrReplayLabel.position.set(x, y + h / 2 + 5 + rh / 2, TERRAIN_DEPTH + 2);
    }
  }

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
    if (show && !anyVrWindowUp()) placeVrWindows();
    vrCatalog.visible = show;
    // locked (no level chosen yet), the catalog has no close: there is
    // nothing behind it to go back to
    vrCatalogClose.visible = show && !library.locked;
    setBarToolState(vrCatalogClose, { hovered: false });
    setVrCatalogHover(-1);
    if (show) { holdSim("vr-catalog"); loadVrCatalog(true); }
    else releaseSim("vr-catalog");
    syncBarForWindows();
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
  layoutVrDetail();

  /**
   * The toolbar is the scene's by default, placed below the board (see
   * placeBarBelowDiorama), and it rides the head on the desktop and until
   * the board is placed. Unlocking hands it to the scene with its world
   * transform kept, so it simply stays where it was hanging while the
   * player looks around; locking hands it back the same way, so it never
   * jumps at the moment of the click - it just starts following again from
   * wherever it is.
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
    barParked = null;
    setBarLocked(true);
    guiRoot.position.set(0, 0, 0);
    guiRoot.quaternion.identity();
    guiRoot.scale.setScalar(1);
    barDragFrom = null;
  }

  /**
   * Where the bar goes in a session by default: unlocked, the scene's, just
   * below the board and centred on the part of the level in front of the
   * player, facing the way the board faces. guiRoot is laid out as if it
   * were a head - the panel hangs VR_GUI_Y below and VR_GUI_Z ahead of it -
   * so it is set where such a head would have to be for the panel to land
   * there. Set with the board (placeDioramaForXR): at a session's first
   * frame, on a recentre, on a level change - unless the player has locked
   * the bar to the head, which is then their choice to keep.
   */
  let barAutoPlace = false; // the first placement of a session
  function placeBarBelowDiorama() {
    if (!session) return;
    setBarLocked(false);
    const level = session.level;
    dioramaRoot.updateMatrixWorld(true);
    // the level's bottom edge, under the focus, on the terrain's front face
    const edge = dioramaRoot.localToWorld(
      new THREE.Vector3(level.screenPositionX + 200, 0, TERRAIN_DEPTH));
    const guiW = VR_GUI_WIDTH * panelWidthScale();
    const cv = session.gui.canvas;
    const barH = guiW * (cv.width ? cv.height / cv.width : 40 / 320);
    // the row of controls stands over the bar
    const above = VR_BAR_TOOL_SIZE * 1.55;
    const centre = edge.clone();
    centre.y -= 0.02 + above + barH / 2;
    guiRoot.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), dioramaRoot.rotation.y);
    guiRoot.scale.setScalar(1);
    guiRoot.position.copy(centre).sub(
      new THREE.Vector3(0, VR_GUI_Y, VR_GUI_Z).applyQuaternion(guiRoot.quaternion));
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

  audio.setFileRoot("../");
  const audioResources = {}; // one GameResources per game type for ADLIB data
  const soundBtn = document.getElementById("btn-sound");
  const renderSoundBtn = () => hudIcons.sound({ on: !audio.enabled });
  soundBtn.addEventListener("click", () => {
    audio.setEnabled(!audio.enabled);
    renderSoundBtn();
  paintVolume();  // now that audio exists, show its real level and switch
    if (audio.enabled && session) session.playMusic();
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
  // the view back to where a level starts: the same as Home or a double
  // right-click (in a headset, the board is re-placed in front of the player)
  document.getElementById("btn-view").addEventListener("click", () => {
    if (renderer.xr.isPresenting) vr.recenterNow();
    else if (session) frameDesktopCamera(session.level);
  });

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
    if (state.levelId) loadLevel().catch((err) => console.error(err));
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

  // the skill bar's own relief: its artwork and counters extruded off the
  // panel. Off, the bar is the flat original.
  const skillBarBtn = document.getElementById("btn-skillbar");
  const renderSkillBarBtn = () => {
    skillBarBtn.textContent = "3D skills bar: " + (state.skillBar ? "on" : "off");
  };
  function toggleSkillBar() {
    state.skillBar = !state.skillBar;
    try { localStorage.setItem("lem3d-skillbar", state.skillBar ? "on" : "off"); } catch (e) {}
    renderSkillBarBtn();
    if (session) session.gui.setRelief(state.skillBar);
    paintVrSettings();
  }
  skillBarBtn.addEventListener("click", toggleSkillBar);
  renderSkillBarBtn();

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
  // NeoLemmix's cursor (cross, square over a lemming), once its pictures are
  // in; until then, and without them, the page's own pointer and ring
  let gameCursor = null;
  GameCursor.load("../").then((c) => { gameCursor = c; });
  const cursorReady = () => !!(gameCursor && gameCursor.ok);
  const selectDxNow = () => (session && session.game.sim ? session.game.sim.effectiveSelectDx : 0);
  let endTimeout = null; // the level's end moving on to the next, unless the game is rewound

  // ----------------------------------------------------- the REPLAY badge
  // A red REPLAY over the play area while a NeoLemmix attempt is replaying
  // (the panel's own R is small): on the desktop a label in the page, in a
  // headset a plate in the bar's space above the status strip.
  const replayBadge = document.getElementById("replay-badge");
  const VR_REPLAY_W = 256, VR_REPLAY_H = 72;
  let vrReplayLabel = null;
  function vrReplayLabelMesh() {
    if (vrReplayLabel) return vrReplayLabel;
    const cv = document.createElement("canvas");
    cv.width = VR_REPLAY_W; cv.height = VR_REPLAY_H;
    const cx = cv.getContext("2d");
    cx.fillStyle = "rgba(40, 8, 8, 0.85)";
    cx.beginPath();
    cx.roundRect ? cx.roundRect(3, 3, VR_REPLAY_W - 6, VR_REPLAY_H - 6, 12) : cx.rect(3, 3, VR_REPLAY_W - 6, VR_REPLAY_H - 6);
    cx.fill();
    cx.strokeStyle = "#ff3b3b";
    cx.lineWidth = 5;
    cx.stroke();
    cx.fillStyle = "#ff3b3b";
    cx.font = "bold 40px monospace";
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText("REPLAY", VR_REPLAY_W / 2, VR_REPLAY_H / 2 + 2);
    const tex = new THREE.CanvasTexture(cv);
    vrReplayLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    vrReplayLabel.name = "vr-replaybadge";
    vrReplayLabel.renderOrder = GUI_ORDER_BAR_TOOL;
    vrReplayLabel.visible = false;
    dioramaRoot.add(vrReplayLabel); // over the strip, over the board
    return vrReplayLabel;
  }
  function setReplayBadge(on) {
    if (replayBadge) replayBadge.hidden = !on;
    const mesh = on && renderer.xr.isPresenting ? vrReplayLabelMesh() : vrReplayLabel;
    if (mesh) mesh.visible = !!on && renderer.xr.isPresenting;
  }

  function disposeSession() {
    if (!session) return;
    setReplayBadge(false);
    if (session.shadowOverlay) session.shadowOverlay.dispose(); // its geometries are rebuilt per hover, not tracked
    if (gameCursor) gameCursor.clear(renderer.domElement);
    if (mouseCursorSprite) mouseCursorSprite.visible = false;
    if (endTimeout) { clearTimeout(endTimeout); endTimeout = null; }
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
    setLevelText(null);
    setVrStatus({ note: "loading…", kind: "" });

    window.__lem3dGroundData = null; // cleared so a VGASPEC level can't reuse a stale piece list
    const where = await resolveLevel();
    let game;
    if (state.engine === "lemmix") {
      game = await lemmixEngine.createGame(where);
    } else if (state.engine === "classic") {
      game = await factory.getGame(state.gameType);
      await game.loadLevel(state.group, state.level);
    } else { showUnplayable(where); return; }
    const level = game.level;
    // the doors and water need the objects' trigger boxes; the DOS engine
    // stashes them as the level builds, a Lemmix level describes its own
    if (state.engine === "lemmix") {
      window.__lem3dObjectData = lemmixEngine.objectData(level);
      window.__lem3dGroundData = lemmixEngine.groundData(level);
    }

    // depth compositing (plan §5.1): per-tileset profile + per-pixel classes
    const config = await factory.getConfig(state.gameType);
    const groundData = window.__lem3dGroundData;
    let profile = null;
    let profileUrl = null;
    if (state.engine === "lemmix") {
      // a Lemmix level's pieces are tagged by name, in a profile per theme style
      profileUrl = "profiles/nx-" + (level.themeName || "default").replace(/[^a-z0-9_]/gi, "") + ".json";
      profile = await DepthProfiles.load(profileUrl);
    } else if (groundData && groundData.lr) {
      // the profile is named after the pack's folder, wherever it lives
      const slug = (config.path || "game").split("/").pop()
        .replace(/[^a-z0-9]/gi, "").toLowerCase();
      const setId = groundData.lr.graphicSet1 != null ? groundData.lr.graphicSet1 : 0;
      profileUrl = "profiles/" + slug + "-g" + setId + ".json";
      profile = await DepthProfiles.load(profileUrl);
    }
    const depthMap = buildDepthMap(level, groundData, profile);
    const pieceMap = buildPieceMap(level, groundData);
    const reliefMap = buildReliefMap(level, pieceMap, profile, state.emboss, groundData);
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
    const musicTrack = state.engine === "lemmix"
      ? Array.from(state.levelId).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 1000
      : state.group * 30 + state.level;
    // the music is started here and again by the sound and music toggles
    const playMusic = () => {
      if (!state.music) return;
      if (state.engine === "lemmix") audio.playLevelMusic(lemmixEngine.musicCandidates(where, level), musicTrack);
      else audio.playMusic(musicTrack);
    };
    playMusic();

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

    // clear physics mode's own layer over the terrain (Lemmix): trigger
    // areas, blocker fields, the spawn-point marks
    const cpmOverlay = game.sim ? makeClearPhysicsOverlay(level, worldGroup, resources) : null;
    // the skill shadows (Lemmix): what the selected skill would do to the lemming under the cursor
    const shadowOverlay = game.sim ? makeShadowOverlay(level, worldGroup, resources) : null;

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
    // water: a translucent body under the wave sprites, which keep animating
    // on top of it. Deep enough to fill the slab, so a drowning lemming is
    // seen through it rather than in front of it.
    const waterMeshes = [];
    for (const pool of state.doors ? waterObjectsFrom(level, profile, OBJECT_Z) : []) {
      const w = pool.x1 - pool.x0, h = pool.y1 - pool.y0, d = pool.z1 - pool.z0;
      if (w <= 0 || h <= 0 || d <= 0) continue;
      const mesh = new THREE.Mesh(
        resources.track(new THREE.BoxGeometry(w, h, d)),
        resources.track(new THREE.MeshBasicMaterial({
          color: pool.colour, transparent: true, opacity: WATER_OPACITY,
          depthWrite: false,
        })));
      mesh.position.set(pool.x0 + w / 2, pool.y0 + h / 2, pool.z0 + d / 2);
      mesh.renderOrder = 1; // after the terrain, so it tints what is behind it
      worldGroup.add(mesh);
      waterMeshes.push({ mesh, colour: pool.colour });
    }

    const lemmingPool = new BillboardPool(worldGroup, materialCache);
    const objectPool = new BillboardPool(worldGroup, materialCache);
    const particles = new ParticleCloud(worldGroup, LEMMING_Z + 1);
    const lemCapture = new SpriteCapture();
    const objCapture = new SpriteCapture();

    const gui = new GuiPanel(guiRoot, game, resources);
    gui.setRelief(state.skillBar);
    gui.onMinimapCenter = (p) => centerViewOn(p.x, p.y);

    if (game.states) {
      // a saved state carries the depth and relief maps with it: the terrain
      // rewrites them as it is dug, and a level's picture alone cannot say
      // what class a dug-then-rebuilt pixel had
      game.states.onSave = (s) => { s.extra.depth = depthMap.slice(); s.extra.relief = terrain.relief ? terrain.relief.slice() : null; };
      game.states.onLoad = (s) => {
        if (s.extra.depth) depthMap.set(s.extra.depth);
        if (s.extra.relief && terrain.relief) terrain.relief.set(s.extra.relief);
      };
      game.onRestore.on((info) => refreshAfterRestore(game, info));
      // the load-replay half of the last cell: a file picker (desktop only)
      // an option changed how the level is drawn (clear physics): paused, redraw now
      game.onOptionChanged = () => {
        if (session && session.game === game && !game.getGameTimer().isRunning() && session.syncScene) session.syncScene(true);
      };
      game.onLoadReplayRequest = () => {
        if (renderer.xr.isPresenting) {
          askVrNotice("Load replay", "load a replay file from the desktop");
          return;
        }
        const input = document.getElementById("replay-file");
        if (!input) return;
        holdSim("replay-file"); // NeoLemmix suspends play while its file dialog is up
        input.click();
      };
    }

    if (state.replay) {
      game.getCommandManager().loadReplay(state.replay);
      state.replay = null;
    }
    // a NeoLemmix replay file (?nxrp=<url>) drives a Lemmix game from its own frames
    if (state.nxrp && game.sim) {
      try {
        const res = await fetch(state.nxrp);
        if (res.ok) game.loadReplay(Lemmix.Replay.parse(await res.text()));
        else console.warn("[3d] replay not found: " + state.nxrp);
      } catch (e) { console.warn("[3d] replay failed:", e); }
      state.nxrp = null;
    }

    // our per-tick bridge; registered after Game's own handler so it runs
    // after the sim step and GameGui render
    let lastTickTime = performance.now();
    const prevActions = new Map(); // lemming id -> action name, for SFX cues
    const prevBricks = new Map();  // lemming id -> bricks laid, for the warning
    let doorSfxPlayed = false;     // the hatches open together; one sound
    // (named, so the page can run it once after the game jumps to another frame)
    // (`redrawOnly`: the same frame again - a hover changed how a lemming is drawn - with no sound)
    const syncScene = (redrawOnly) => {
      if (!redrawOnly) lastTickTime = performance.now();

      objCapture.begin();
      game.objectManager.render(objCapture);
      // objects drawn as openings have their own geometry: drop the flat copy
      // (ObjectManager emits exactly one draw per object, in list order) and
      // keep their texture in step with the animation
      // (clear physics: the background gadgets and the on-terrain ones are left
      // out, as NeoLemmix leaves rlBackgroundObjects and rlOnTerrainGadgets out)
      const cpmHides = (i) => {
        const g = level.objects[i] && level.objects[i].gadget;
        return !!g && (g.effectBase === "BACKGROUND" || g.effectBase === "PAINT" || g.onlyOnTerrain);
      };
      const cpmOn = !!(cpmOverlay && game.clearPhysics);
      const objectItems = portalIndices.size === 0 && !cpmOn ? objCapture.items
        : objCapture.items.filter((_, i) => !portalIndices.has(i) && !(cpmOn && cpmHides(i)));
      if (cpmOverlay) {
        // clear physics: the terrain as its physics map, the layer of
        // trigger areas and marks repainted for this frame
        terrain.setPhysicsPaint(game.clearPhysics ? level.physics : null, cpmHighlightBits(level));
        cpmOverlay.update(game);
      }
      if (shadowOverlay) {
        const choice = shadowChoice(game);
        shadowOverlay.update(game.sim, choice && choice.lem, choice && choice.skill,
          choice && (choice.lem.index + "/" + choice.skill + "/" + game.sim.currentIteration + "/" + choice.lem.x + "," + choice.lem.y + "/" + choice.lem.action + "/" + choice.lem.dx));
      }
      if (portalIndices.size > 0) {
        const tick = game.getGameTimer().getGameTicks();
        for (const portal of portals) {
          const frame = portal.animation.getFrame(tick);
          // A hatch keeps the open frame on its ceiling square: the doors are
          // real geometry now, so following the animation there would leave
          // the painted ones lying in the opening as the real ones swing.
          // (clear physics: the opening's geometry in the one colour, doors included)
          const shown = portal.hatch ? portal.animation.frames[0] : (frame || portal.animation.frames[0]);
          if (shown) {
            portal.mesh.material = game.clearPhysics
              ? materialCache.flatMaterialFor(shown) : materialCache.forFrame(shown).material;
          }
          if (portal.flaps) {
            const doorMaterial = game.clearPhysics
              ? materialCache.flatMaterialFor(portal.closedFrame) : materialCache.forFrame(portal.closedFrame).material;
            for (const flap of portal.flaps) flap.mesh.material = doorMaterial;
          }
          if (!portal.flaps || !portal.openness) continue;
          // swing the doors by however far this frame has the hatch open
          const frames = portal.animation.frames;
          const idx = Math.max(0, frames.indexOf(frame));
          const angle = (portal.openness[idx] || 0) * Math.PI / 2;
          if (angle > 0 && !doorSfxPlayed) {
            // once for the level, not once per hatch: they all swing on the
            // same tick, and the engine plays one effect at a time anyway
            doorSfxPlayed = true;
            audio.playSfx(SFX.DOOR, sfxPos(portal.sfxX, portal.sfxY));
          }
          for (const flap of portal.flaps) {
            flap.mesh.rotation.z = flap.sign * angle;
          }
        }
      }
      objectPool.sync(objectItems, (layer) =>
        layer < 0 ? OBJECT_BG_Z : layer > 0 ? OBJECT_DECAL_Z : OBJECT_Z, false, !!game.clearPhysics);

      lemCapture.begin();
      const lems = game.getLemmingManager().lemmings;
      if (game.sounds && !redrawOnly) {
        for (const cue of game.sounds) {
          audio.playCue(cue.name, cue.x != null ? sfxPos(cue.x, cue.y) : null, SFX_BY_CUE[cue.name]);
        }
      }
      let tickSfx = null; // at most one effect per tick (nuke-proofing)
      for (let i = 0; i < lems.length; i++) {
        const lem = lems[i];
        const action = lem.removed || !lem.action ? null : actionName(lem);
        if (action !== prevActions.get(lem.id)) {
          prevActions.set(lem.id, action);
          // a Lemmix game cues its own sounds (below); the DOS one is read off its states
          if (action && !game.sounds && SFX_BY_ACTION[action] != null) {
            tickSfx = { sfx: SFX_BY_ACTION[action], x: lem.x, y: lem.y };
          }
        }
        // a builder counts bricks in lem.state and shrugs at 12; the original
        // warns when three are left, which is the sound you actually play by
        if (action === "building") {
          if (lem.state !== prevBricks.get(lem.id)) {
            prevBricks.set(lem.id, lem.state);
            if (lem.state === BUILDER_WARN_AT) {
              tickSfx = { sfx: SFX.TING, x: lem.x, y: lem.y };
            }
          }
        } else if (prevBricks.has(lem.id)) {
          prevBricks.delete(lem.id);
        }
        if (lem.removed) continue;
        lemCapture.tag = lem.id;
        lem.render(lemCapture);
      }
      if (trapSfxAt) {
        tickSfx = { sfx: SFX.TRAP, x: trapSfxAt.x, y: trapSfxAt.y };
        trapSfxAt = null;
      }
      if (tickSfx != null && !redrawOnly) audio.playSfx(tickSfx.sfx, sfxPos(tickSfx.x, tickSfx.y));
      lemmingPool.sync(lemCapture.items, () => LEMMING_Z, true);
      particles.sync(lemCapture.particles);

      terrain.flushDirty();
    };
    game.getGameTimer().onGameTick.on(syncScene);
    // what the bridge remembers from tick to tick, dropped when the game jumps
    const resetSceneMemory = () => {
      prevActions.clear(); prevBricks.clear(); doorSfxPlayed = false; trapSfxAt = null;
      lastTickTime = performance.now();
    };

    // Replace the timer's setInterval drive with our rAF accumulator (below):
    // browsers throttle setInterval hard in unfocused/occluded windows, and the
    // VR build needs a rAF-driven fixed step anyway. tick()/suspend semantics
    // and the 60ms fixed step are preserved; the sim code is untouched.
    const timer = game.getGameTimer();
    timer.suspend();
    timer.continue = function () { this.gameTimerHandler = 1; };
    timer.suspend = function () { this.gameTimerHandler = 0; };

    // Steel areas, which the engine parses and then ignores entirely: the
    // three destructive skills are stopped at them here (js/steel.js).
    // (a Lemmix game handles steel and its entrances itself)
    const steel = state.engine === "classic" ? installSteel(
      game,
      new SteelMap(steelRangesFrom(groundData && groundData.lr, level)),
      (lem) => audio.playSfx(SFX.STEEL, sfxPos(lem.x, lem.y))) : null;

    // Multiple entrances: the engine releases every lemming from the first
    // one, where the original takes them in turn. The release is small enough
    // to restate here, on the manager's own instance.
    const lemmingManager = game.getLemmingManager();
    if (state.engine === "classic" && lemmingManager && level.entrances.length > 1) {
      let nextEntrance = 0;
      lemmingManager.addNewLemmings = function () {
        if (this.gameVictoryCondition.getLeftCount() <= 0) return;
        this.releaseTickIndex++;
        if (this.releaseTickIndex >= (104 - this.gameVictoryCondition.getCurrentReleaseRate())) {
          this.releaseTickIndex = 0;
          const list = this.level.entrances;
          const entrance = list[nextEntrance++ % list.length];
          this.addLemming(entrance.x + 24, entrance.y + 14);
          this.gameVictoryCondition.releaseOne();
        }
      };
    }

    // A trap fires through the trigger manager, and the state it puts a
    // lemming into is shared with climbing, so the trigger is where it can be
    // told apart. Instance wrapper, like every other hook here.
    let trapSfxAt = null;
    const triggerAt = game.triggerManager.trigger.bind(game.triggerManager);
    game.triggerManager.trigger = (x, y) => {
      const type = triggerAt(x, y);
      if (type === Lemmings.TriggerTypes.TRAP) trapSfxAt = { x, y };
      return type;
    };

    // The nuke is issued by the panel itself, so it is caught where every
    // command passes: an instance wrapper, like every other hook here.
    const queueCommand = game.queueCmmand.bind(game);
    game.queueCmmand = (cmd) => {
      if (cmd instanceof Lemmings.CommandNuke) audio.playSfx(SFX.NUKE);
      return queueCommand(cmd);
    };

    game.getGameTimer().speedFactor = state.speed;
    game.onGameEnd.on((result) => {
      const won = result.state === Lemmings.GameStateTypes.SUCCEEDED;
      let best = "";
      if (won) {
        // the clock counts down; how long it took is the elapsed time
        const seconds = game.getGameTimer().getGameTime();
        const record = LevelProgress.record(state.levelId, seconds);
        best = " — " + LevelProgress.format(seconds) +
          (record ? " (best)" : "");
      }
      // a NeoLemmix level's talismans and its closing text
      let extra = "";
      if (game.sim) {
        const got = (level.talismans || []).filter((t) => game.sim.talismansAchieved.has(t.id));
        if (got.length) {
          extra += " — talisman: " + got.map((t) => t.title + " (" + t.color + ")").join(", ");
          try {
            const all = JSON.parse(localStorage.getItem("lem3d-talismans") || "{}");
            all[state.levelId] = Array.from(new Set((all[state.levelId] || []).concat(got.map((t) => t.id))));
            localStorage.setItem("lem3d-talismans", JSON.stringify(all));
          } catch (e) {}
        }
        // the closing text takes the opening text's place behind "detail"
        if (won && level.posttext && level.posttext.length) setLevelText(level.posttext);
      }
      hud.state.textContent = (won
        ? "LEVEL COMPLETE — " + Lemmings.GameStateTypes.toString(result.state) + best
        : "FAILED — " + Lemmings.GameStateTypes.toString(result.state)) + extra;
      hud.state.className = won ? "won" : "lost";
      setVrStatus({ note: won ? "COMPLETE" + best : "FAILED",
                    kind: won ? "won" : "lost" });
      endTimeout = window.setTimeout(() => {
        endTimeout = null;
        // a replay or a step back since the end keeps the level (it is playable again)
        if (session && session.game === game && game.finalGameState !== Lemmings.GameStateTypes.UNKNOWN) moveLevel(won ? 1 : 0);
      }, 3000);
    });
    game.start();
    // A window the player is dealing with - the catalog, a question - holds
    // whatever game is current. A level that arrives behind it (the
    // auto-advance or restart after a result, a reload from a switch) starts
    // held too, and is released with the rest when the window goes.
    if (simHolders.size > 0) {
      simWasRunning = true;
      game.getGameTimer().suspend();
    }
    syncPauseLabel();

    // Camera: frame the level's intended start position - but never during a
    // session, where the camera is the headset. Writing desktop coordinates
    // into it there is read straight back as a head pose, and the next level
    // gets placed hundreds of metres away. Leaving VR reframes anyway.
    if (!renderer.xr.isPresenting) frameDesktopCamera(level);

    hud.name.textContent = level.name.trim() || "(unnamed level)";
    const meta = where.packName + " · " + where.label +
      " · save " + level.needCount + "/" + level.releaseCount;
    hud.meta.textContent = meta;
    // a NeoLemmix level's opening text, folded behind "detail"
    setLevelText(level.pretext);
    hud.loading.classList.add("hidden");
    // the same, in the scene, where a headset can read it
    setVrStatus({
      name: level.name.trim() || "(unnamed level)",
      meta, note: "", kind: "",
    });

    session = {
      game, level, terrain, gui, worldGroup, pickPlane, ring,
      lemmingPool, objectPool, particles, resources, depthMap, profile,
      groundData, profileUrl, musicTrack, playMusic, pieceMap,
      getLastTickTime: () => lastTickTime,
      syncScene, resetSceneMemory, shadowOverlay,
      // clear physics: the gadgets' one colour walks the hues every five
      // seconds (MakeFixedDrawColor), between ticks too; the water bodies with it
      cpmAnimate: (now) => {
        if (!cpmOverlay) return;
        if (game.clearPhysics) {
          const c = new THREE.Color().setHSL((now % 5000) / 5000, 1, 0.375);
          materialCache.setFlatColor(c.getHex());
          for (const w of waterMeshes) w.mesh.material.color.copy(c);
        } else {
          for (const w of waterMeshes) if (w.mesh.material.color.getHex() !== w.colour) w.mesh.material.color.setHex(w.colour);
        }
      },
      // re-derive the colour-keyed relief (master switch or a per-piece tag)
      rebuildRelief: () => {
        session.terrain.setRelief(
          buildReliefMap(level, pieceMap, session.profile, state.emboss, groundData));
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
      // a Lemmix panel is wider than the DOS one (its minimap frame comes
      // after the buttons): the bar grows with it so a panel pixel stays
      // the same size, and the bar's row and sound column follow its ends
      const guiW = VR_GUI_WIDTH * panelWidthScale();
      session.gui.place(guiW, VR_GUI_Y, VR_GUI_Z); // metres
      // the panel has no mesh until it has painted once: a level loaded
      // mid-session lays out on the next frame, not this one
      if (!session.gui.mesh) return;
      // The row of controls rides just above the bar's top edge, in the bar's
      // own space, so dragging or unpinning it carries them along: the two
      // handles at the left end, pause in the middle, the three that leave
      // the level at the right end.
      const barTop = VR_GUI_Y + session.gui.mesh.scale.y / 2;
      const y = barTop + VR_BAR_TOOL_SIZE * 0.8;
      // the status strip, its detail button and the REPLAY plate stand
      // over the board instead
      layoutVrStatus();
      const step = VR_BAR_TOOL_SIZE * 1.15;
      const end = guiW / 2 - VR_BAR_TOOL_SIZE * 0.6;
      vrLeftTools.forEach((b, i) => { b.position.x = -end + i * step; });
      vrPauseBtn.position.x = 0;
      vrRightTools.forEach((b, i) => {
        b.position.x = end - (vrRightTools.length - 1 - i) * step;
      });
      // the sound column stands off the bar's right end
      const sx = guiW / 2 + VR_BAR_TOOL_SIZE * 0.85;
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
      const width = viewH * camera.aspect * 0.55 * panelWidthScale();
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

  // ------------------------------------------------- clear physics (Lemmix)
  // Trigger areas NeoLemmix does not draw: none, the windows (their spawn
  // point is marked instead), backgrounds, paint, blockers' own fields (a
  // blocking lemming's are drawn from the lemming), and the one-way walls.
  const CPM_NO_TRIGGER = new Set(["NONE", "WINDOW", "BACKGROUND", "PAINT", "BLOCKER",
    "ONEWAYLEFT", "ONEWAYRIGHT", "ONEWAYDOWN", "ONEWAYUP"]);
  const PM_ONEWAYFLAGS = 0x78; // left, right, down, up

  /** The one-way wall under the pointer, as its direction bits: terrain of the same kind lights up blue. */
  function cpmHighlightBits(level) {
    if (!cursorSim) return 0;
    const x = Math.round(cursorSim.x), y = Math.round(cursorSim.y);
    if (x < 0 || y < 0 || x >= level.width || y >= level.height) return 0;
    return level.physics[x + y * level.width] & PM_ONEWAYFLAGS;
  }

  /**
   * Clear physics mode's own layer, the level's size, over the terrain:
   * NeoLemmix's trigger areas (DrawTriggerAreaRectOnLayer - a pink checker,
   * darker over terrain and darker still over steel, and darker where two
   * overlap), a blocker's two fields, and the gold-and-orange mark at each
   * hatch's spawn point (DrawAllGadgets). Repainted every frame the mode is
   * on, hidden otherwise. Drawn first among the transparent things and
   * without a depth test, so it lies on the slab under the lemmings.
   */
  function makeClearPhysicsOverlay(level, worldGroup, resources) {
    const w = level.width, h = level.height;
    const data = new Uint8Array(w * h * 4);
    const tex = resources.track(new THREE.DataTexture(data, w, h, THREE.RGBAFormat));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    const mesh = new THREE.Mesh(
      resources.track(new THREE.PlaneGeometry(1, 1)),
      resources.track(new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      })));
    mesh.scale.set(w, h, 1);
    mesh.position.set(w / 2, h / 2, OBJECT_DECAL_Z + 0.5);
    mesh.renderOrder = -5;
    mesh.visible = false;
    worldGroup.add(mesh);
    const phys = level.physics;
    const put = (x, y, r, g, b) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    };
    const triggerRect = (x0, y0, x1, y1) => {
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
          const i = (y * w + x) * 4, bits = phys[y * w + x];
          const present = data[i + 3] !== 0;
          let c = !(bits & 1) ? 0xFF : (bits & 2) ? 0x60 : 0xA0; // free / steel / terrain
          if ((x - y) & 1) c -= 0x20;
          if (present) c -= 0x30;
          data[i] = c; data[i + 1] = 0; data[i + 2] = c; data[i + 3] = 255;
        }
      }
    };
    return {
      mesh,
      update(game) {
        const on = !!game.clearPhysics;
        mesh.visible = on;
        if (!on) return;
        data.fill(0);
        for (const g of level.gadgets) {
          if (g.offMap || CPM_NO_TRIGGER.has(g.effect)) continue;
          if ((g.effectBase === "TELEPORT" || g.effectBase === "RECEIVER") && g.pairingId < 0) continue;
          const t = g.triggerRect;
          triggerRect(t.x0, t.y0, t.x1, t.y1);
        }
        for (const L of game.sim.lemmings) {
          if (L.removed || L.action !== Lemmix.BA.BLOCKING) continue;
          let left = L.x - 6;
          if (L.dx === 1) left++;
          const top = L.y - 6;
          triggerRect(left, top, left + 4, top + 11);
          triggerRect(left + 8, top, left + 12, top + 11);
        }
        for (const g of level.gadgets) {
          if (g.offMap || g.effectBase !== "WINDOW") continue;
          const x = g.triggerRect.x0, y = g.triggerRect.y0;
          put(x, y, 0xFF, 0xD7, 0x00);
          put(x - 1, y, 0xFF, 0x45, 0x00); put(x + 1, y, 0xFF, 0x45, 0x00);
          put(x, y - 1, 0xFF, 0x45, 0x00); put(x, y + 1, 0xFF, 0x45, 0x00);
        }
        tex.needsUpdate = true;
      },
    };
  }

  // ------------------------------------------------ skill shadows (Lemmix)
  /**
   * NeoLemmix's skill shadows, in the diorama's depth: what the selected
   * skill would do to the lemming under the cursor (shadows.js), as
   * translucent volumes rather than a flat layer. The terrain a tunnel or a
   * crater would take is cut through the whole slab, dark; the bricks a
   * builder, platformer or stacker would lay stand as slab-deep blocks,
   * light; a path (a jumper's arc, a glider's flight) is a thin ribbon at
   * the lemmings' depth. Each is the greedy relief the sprites use, shaded
   * on its walls, drawn over everything without a depth test so a cut
   * inside the slab still shows. Rebuilt when the lemming, the skill or the
   * frame changes; NeoLemmix's masking kept (cuts on destructible terrain
   * only, bricks and paths where there is no terrain).
   */
  function makeShadowOverlay(level, worldGroup, resources) {
    const w = level.width, h = level.height, phys = level.physics;
    const part = (color, opacity, depth, z) => {
      const material = resources.track(new THREE.MeshBasicMaterial({
        color, vertexColors: true, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      }));
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
      mesh.renderOrder = -4;
      mesh.visible = false;
      worldGroup.add(mesh);
      return { mesh, depth, z };
    };
    const cuts = part(0x585858, 0.62, TERRAIN_DEPTH, 0);         // through the slab
    const bricks = part(0xd8d8d8, 0.55, TERRAIN_DEPTH, 0);       // slab-deep blocks
    const paths = part(0xe8e8e8, 0.85, SPRITE_DEPTH, LEMMING_Z); // a ribbon at the lemmings' depth
    const parts = [cuts, bricks, paths];
    const keep = (x, y, overTerrain) => {
      const bits = phys[y * w + x], solid = (bits & 1) !== 0;
      return overTerrain ? (solid && !(bits & 2)) : !solid;
    };
    /** The pixels as one relief over their bounding box, put where they are in the level. */
    const rebuild = (p, pixels, overTerrain) => {
      const kept = pixels.filter(([x, y]) => keep(x, y, overTerrain));
      p.mesh.geometry.dispose();
      if (!kept.length) { p.mesh.geometry = new THREE.BufferGeometry(); p.mesh.visible = false; return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of kept) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const grid = new Uint8Array(bw * bh);
      for (const [x, y] of kept) grid[(y - y0) * bw + (x - x0)] = 1;
      p.mesh.geometry = buildExtrudedSpriteGeometry((x, y) => grid[y * bw + x] !== 0, bw, bh, p.depth) || new THREE.BufferGeometry();
      p.mesh.position.set(x0, y0, p.z);
      p.mesh.visible = true;
    };
    let lastKey = null;
    return {
      mesh: cuts.mesh,
      dispose() { parts.forEach((p) => { p.mesh.geometry.dispose(); worldGroup.remove(p.mesh); }); },
      /** Build for this lemming and skill (null: none); `key` says when nothing changed. */
      update(sim, lem, skill, key) {
        if (!lem || !skill) { parts.forEach((p) => { p.mesh.visible = false; }); lastKey = null; return; }
        if (key === lastKey) return;
        lastKey = key;
        const shadow = Lemmix.Shadows.compute(sim, lem, skill);
        rebuild(cuts, shadow.high, true);
        rebuild(bricks, shadow.bricks, false);
        rebuild(paths, shadow.low, false);
      },
    };
  }

  /**
   * CheckForNewShadow: which lemming casts which skill's shadow now - the
   * one the selected skill would go to, for a skill that has a shadow; else
   * a glider under the cursor while it falls or glides, whatever the skill.
   */
  function shadowChoice(game) {
    const sim = game.sim;
    if (!sim || !cursorSim || !state.shadows) return null; // the Toggle Skill Shadows hotkey hides them
    const skill = sim.selectedSkill;
    if (game.cursorLemming && skill && Lemmix.Shadows.SHADOW_SKILLS.has(skill)) return { lem: game.cursorLemming, skill };
    const any = sim.getPriorityLemming(Lemmix.BA.NONE, Math.round(cursorSim.x), Math.round(cursorSim.y)).lemming;
    if (any && any.isGlider && (any.action === Lemmix.BA.FALLING || any.action === Lemmix.BA.GLIDING)) return { lem: any, skill: "GLIDER" };
    return null;
  }

  /** Default desktop framing: the level's intended start area, slightly above. */
  /**
   * A Lemmix game jumped to another frame (the replay button, a frame back,
   * a loaded replay): the state went back into the level's own arrays, so
   * everything the scene holds a copy of is refreshed - the terrain's
   * texture and meshes, the sprite pools' last positions, the bridge's
   * memory of actions and bricks, the verdict on the HUD, the minimap -
   * and one bridge pass draws the frame as a tick would.
   */
  function refreshAfterRestore(game) {
    if (!session || session.game !== game) return;
    const level = session.level;
    session.terrain.resync();
    session.lemmingPool.prevPositions.clear();
    session.resetSceneMemory();
    tickDebt = 0;
    if (endTimeout) { clearTimeout(endTimeout); endTimeout = null; }
    hud.state.textContent = "";
    hud.state.className = "";
    setLevelText(level.pretext);
    setVrStatus({ note: "", kind: "" });
    if (session.gui.minimap) session.gui.minimap.terrainDirty = true;
    session.syncScene();
    syncPauseLabel();
  }

  function frameDesktopCamera(level) {
    const startX = level.screenPositionX + 200;
    const targetY = level.height / 2;
    controls.target.set(startX, targetY, TERRAIN_DEPTH / 2);
    camera.position.set(startX, targetY + 120, 420);
    controls.update();
  }

  /** How much wider than the DOS panel this session's panel is (a Lemmix
   *  panel carries its minimap frame after the buttons): the bar scales with
   *  it so a panel pixel keeps its size on screen and in the headset. */
  function panelWidthScale() {
    return session && session.gui.mesh ? session.gui.canvas.width / 320 : 1;
  }

  // ------------------------------------------------- the view as a rectangle
  // The minimap wants "the part of the level on screen" and, on a press,
  // "put this level point in the middle". In 2D those are the scroll
  // offset; here the level is a board in front of a camera - or a headset -
  // so both are worked out on the lemmings' plane: where the rays through
  // the corners of the view land on it (the rectangle), and where the ray
  // through the middle lands (the centre). Centring is then a translation
  // between two board points, which keeps zoom, tilt and scale: the camera
  // moves on the desktop, the board in the headset (the world never moves).

  /** The eye whose view the rectangle describes: the headset's combined
   *  camera in a session (its projection covers both eyes), the desktop one otherwise. */
  function viewEye() {
    if (renderer.xr.isPresenting) return renderer.xr.getCamera();
    camera.updateMatrixWorld();
    return camera;
  }

  /** The lemmings' plane of the board, in world space. */
  function levelPlane() {
    session.worldGroup.updateWorldMatrix(true, false);
    const p0 = session.worldGroup.localToWorld(new THREE.Vector3(0, 0, LEMMING_Z));
    const p1 = session.worldGroup.localToWorld(new THREE.Vector3(0, 0, LEMMING_Z + 1));
    return new THREE.Plane().setFromNormalAndCoplanarPoint(p1.sub(p0).normalize(), p0);
  }

  /** Where the ray through view point (nx, ny) (NDC) lands on the board, in
   *  level px; {hit:false} with the far point along the ray when it misses -
   *  a corner looking past the board still bounds the rectangle on that side. */
  function levelPointAt(eye, plane, nx, ny) {
    const projInv = new THREE.Matrix4().copy(eye.projectionMatrix).invert();
    const origin = new THREE.Vector3().setFromMatrixPosition(eye.matrixWorld);
    const target = new THREE.Vector3(nx, ny, 0.5).applyMatrix4(projInv).applyMatrix4(eye.matrixWorld);
    const ray = new THREE.Ray(origin, target.sub(origin).normalize());
    const p = new THREE.Vector3();
    const hit = !!ray.intersectPlane(plane, p);
    if (!hit) plane.projectPoint(ray.at(1e6, p), p);
    const local = session.worldGroup.worldToLocal(p);
    return { x: local.x, y: local.y, hit };
  }

  /** The level-space box the view covers, clamped to the level; null when
   *  none of the view's corners reaches the board (the last box stands). */
  function visibleLevelRect() {
    if (!session) return null;
    const eye = viewEye(), plane = levelPlane();
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([nx, ny]) => levelPointAt(eye, plane, nx, ny));
    if (!corners.some((c) => c.hit)) return null;
    const { width, height } = session.level;
    const clampX = (v) => Math.max(0, Math.min(width, v));
    const clampY = (v) => Math.max(0, Math.min(height, v));
    return {
      x0: clampX(Math.min(...corners.map((c) => c.x))), x1: clampX(Math.max(...corners.map((c) => c.x))),
      y0: clampY(Math.min(...corners.map((c) => c.y))), y1: clampY(Math.max(...corners.map((c) => c.y))),
    };
  }

  /** The level point in the middle of the view. */
  function currentViewCentre() {
    if (!session) return null;
    const c = levelPointAt(viewEye(), levelPlane(), 0, 0);
    if (c.hit) return { x: c.x, y: c.y };
    const r = visibleLevelRect();
    return r ? { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 } : null;
  }

  /** Put level point (simX, simY) in the middle of the view - as far as the
   *  level allows: NeoLemmix stops the screen at the level's edges, so the
   *  centre is held back by half the view where the view is narrower than
   *  the level, and a view wider than the level just sees it whole. */
  function centerViewOn(simX, simY) {
    if (!session) return;
    const { width, height } = session.level;
    const r = visibleLevelRect();
    const rw = r ? r.x1 - r.x0 : 0, rh = r ? r.y1 - r.y0 : 0;
    const cx = rw >= width ? width / 2 : THREE.MathUtils.clamp(simX, rw / 2, width - rw / 2);
    const cy = rh >= height ? height / 2 : THREE.MathUtils.clamp(simY, rh / 2, height - rh / 2);
    const cur = currentViewCentre();
    if (!cur) return;
    session.worldGroup.updateWorldMatrix(true, false);
    const from = session.worldGroup.localToWorld(new THREE.Vector3(cur.x, cur.y, LEMMING_Z));
    const to = session.worldGroup.localToWorld(new THREE.Vector3(cx, cy, LEMMING_Z));
    const delta = to.sub(from);
    if (renderer.xr.isPresenting) {
      dioramaRoot.position.sub(delta);
    } else {
      camera.position.add(delta);
      controls.target.add(delta);
      controls.update();
    }
  }

  /** Prev/next: the neighbouring level in the pack's play order, wrapping. */
  async function moveLevel(delta) {
    if (!state.levelId) return; // no level yet: the library is up, choose there
    await library.tree();
    const next = LevelTree.next(state.levelId, delta);
    if (next) state.levelId = next;
    await loadLevel();
  }

  /**
   * Settle which level is meant: state.levelId, else the old ?type/group/level
   * parameters, else the first level there is - and, for a classic level, the
   * game/group/index the DOS engine addresses it by.
   */
  async function resolveLevel() {
    await library.tree();
    if (!state.levelId) {
      state.levelId = LevelTree.classicId(
        state.legacy.type, state.legacy.group, state.legacy.level) || LevelTree.firstLevelId();
    }
    let where = LevelTree.describe(state.levelId);
    if (!where) {
      state.levelId = LevelTree.firstLevelId();
      where = LevelTree.describe(state.levelId);
    }
    if (!where) throw new Error("no levels found — run tools/levels-index.js");
    state.engine = where.engine;
    if (state.engine === "classic") {
      state.gameType = where.pack.gameType;
      state.group = where.level.group;
      state.level = where.level.index;
    }
    library.setCurrent(state.levelId);
    return where;
  }

  /** A level the page has no engine for yet: say so, and leave the board empty. */
  function showUnplayable(where) {
    hud.name.textContent = where.title || where.label;
    hud.meta.textContent = where.packName + " · " + where.label + " · " + where.engine;
    hud.state.textContent = "these levels need the Lemmix engine, which is not built yet";
    hud.state.className = "lost";
    hud.loading.classList.add("hidden");
    setVrStatus({
      name: where.title || where.label,
      meta: where.packName + " · " + where.label,
      note: "needs the Lemmix engine", kind: "lost",
    });
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
    // A question on screen owns the ray: its two answers are the only things
    // that can be hit, so nothing behind it can be pressed by accident.
    if (vrModal.visible) {
      for (const b of [vrYesBtn, vrNoBtn]) {
        if (!b.visible) continue; // a notice has no "no"
        const hit = rc.intersectObject(b, false);
        if (hit.length) return hit[0];
      }
      return null;
    }
    // the level's text owns it the same way: its window alone
    if (vrDetail.visible) {
      const onPanel = rc.intersectObject(vrDetailPanel, false);
      return onPanel.length ? onPanel[0] : null;
    }
    if (vrSettings.visible) {
      const onClose = rc.intersectObject(vrSettingsClose, false);
      if (onClose.length) return onClose[0];
      const onPanel = rc.intersectObject(vrSettingsPanel, false);
      return onPanel.length ? onPanel[0] : null;
    }
    // the catalog owns it the same way: the grid and its close button only
    // (a raycast does not skip an invisible mesh, so the hidden close of a
    // locked catalog is skipped here)
    if (vrCatalog.visible) {
      const onClose = vrCatalogClose.visible
        ? rc.intersectObject(vrCatalogClose, false) : [];
      if (onClose.length) return onClose[0];
      const onPanel = rc.intersectObject(vrCatalogPanel, false);
      return onPanel.length ? onPanel[0] : null;
    }
    // past the windows, everything else belongs to a level
    if (!session) return null;
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
    if (hit.object.name === "vr-detailpanel") {
      return { barTool: vrDetailOkAt(hit.uv) ? "detailok" : "detailpanel" };
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
    if (hit.object.name === "gui-panel") {
      // the minimap answers to a hold as a scrubber does (vr.js), the buttons to a press
      if (session.gui.isMinimap(hit.uv)) return { panelUv: hit.uv, barTool: "minimap", minimap: true };
      return { panelUv: hit.uv };
    }
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
  // ...and, on the board, NeoLemmix's cursor as a sprite where the ray lands
  let mouseCursorSprite = null;
  const boardCursorSprite = () => {
    if (!cursorReady()) return null;
    if (!mouseCursorSprite) { mouseCursorSprite = gameCursor.makeSprite(VR_MARK_ORDER); scene.add(mouseCursorSprite); }
    return mouseCursorSprite;
  };

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
      // a Lemmix assignment is written into the replay and shows on the
      // next frame: paused, that frame is run now (ForceUpdateOneFrame)
      if (session.game.forceOneFrame) session.game.forceOneFrame();
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
    setBarToolHover(p ? p.barTool : null);
    setVrCatalogHover(p && p.barTool === "worldpanel"
      ? (p.scrollBar ? -2 : p.tile) : -1);
    setVrSettingsHover(p && p.barTool === "setpanel" ? p.row : -1);
    setVrDetailHover(!!(p && p.barTool === "detailok"));
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
    if (session.game.sim && session.game.clearPhysics) {
      // clear physics: the one-way walls like the one under the pointer light up
      session.terrain.setPhysicsPaint(session.level.physics, cpmHighlightBits(session.level));
    }
    if (session.game.sim) {
      // the lemming NeoLemmix marks (red shirt, named in the info strip): the
      // one the selected skill would go to, at the cursor as it is now
      const marked = cursorSim ? session.game.getLemmingManager().getSelectedLemmingAt(cursorSim.x, cursorSim.y) : null;
      const markedChanged = marked !== session.game.cursorLemming;
      session.game.cursorLemming = marked;
      const shadow = shadowChoice(session.game); // from the marked lemming as it is now
      const shadowKey = shadow ? shadow.lem.index + "/" + shadow.skill : null;
      if (markedChanged || shadowKey !== session.game.shadowKey) {
        session.game.shadowKey = shadowKey;
        // paused, no tick will redraw it (the red shirt, the skill shadow): draw the frame again, quietly
        if (!session.game.getGameTimer().isRunning() && session.syncScene) session.syncScene(true);
      }
    }
    if (lem) {
      // with NeoLemmix's cursor in use the square is the mark; the ring is the page's own
      session.ring.visible = !cursorReady();
      session.ring.position.set(lem.x, lem.y - 5, LEMMING_Z + 2);
      hud.hover.textContent =
        "lemming " + lem.id + " — " + actionName(lem);
    } else {
      session.ring.visible = false;
      hud.hover.innerHTML = "&nbsp;";
    }
    // The desktop pointer. Over the board it is the sprite - sixteen level
    // pixels wide, so its size on screen follows the zoom and it rings a
    // lemming at any distance - and the OS pointer is hidden there; off the
    // board (the toolbar, the dark) it is the picture as a CSS cursor.
    if (cursorReady() && !renderer.xr.isPresenting) {
      const sprite = boardCursorSprite();
      if (cursorSim && sprite) {
        session.worldGroup.updateWorldMatrix(true, false);
        sprite.position.copy(session.worldGroup.localToWorld(new THREE.Vector3(cursorSim.x, cursorSim.y, LEMMING_Z + 2)));
        gameCursor.dressSprite(sprite, !!lem, selectDxNow(), dioramaRoot.scale.x);
        sprite.visible = true;
        gameCursor.hide(renderer.domElement);
      } else {
        if (sprite) sprite.visible = false;
        gameCursor.apply(renderer.domElement, false, selectDxNow());
      }
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

  /**
   * A press on the skills bar, any button. It is the bar's alone: this runs
   * in the capture phase, ahead of OrbitControls' own listener, and stops
   * the event there, so no drag can start from the bar - a press that opens
   * a file dialog (load replay) never gets its release, and the board would
   * otherwise turn with the pointer once the dialog closed. Right and middle
   * presses are a click each (a Lemmix panel skips 17 or 85 frames on them);
   * a left press is held, for the release-rate and frame-skip repeats and
   * for dragging on the minimap.
   */
  let pressedOnPanel = false; // the last press was the bar's: its release is not a click on the board
  function pressOnPanel(e, p) {
    pressedOnPanel = true;
    if (e.button !== 0) {
      if (p.minimap) return;
      e.preventDefault();
      session.gui.onMouseDown(p.panelUv, e.button);
      session.gui.onMouseUp(p.panelUv);
      return;
    }
    downAt = { x: e.clientX, y: e.clientY };
    if (!p.minimap) audio.playSfx(SFX.CLICK);
    session.gui.onMouseDown(p.panelUv);
  }
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (!mouseAllowed()) return;
    const p = pick(e);
    if (!(p && p.panelUv)) return;
    e.stopImmediatePropagation();
    pressOnPanel(e, p);
  }, true);

  // a middle press must not start the browser's autoscroll: it is a key here
  renderer.domElement.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
  renderer.domElement.addEventListener("pointerdown", (e) => {
    pressedOnPanel = false;
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
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (e.button === 2) {
      vrPan = null;
      // double right-click (no drag) = reset the view to its default
      const dragged = !rightDownAt ||
        Math.abs(e.clientX - rightDownAt.x) + Math.abs(e.clientY - rightDownAt.y) > 5;
      if (!dragged) {
        // a right click is a key in NeoLemmix's table; on the board it is
        // also the first half of the double click that resets the view
        if (!pressedOnPanel) runMouseKey("MouseRight");
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
    if (e.button === 1) { // a middle click is a key in NeoLemmix's table (pause, by default)
      if (mouseAllowed() && !pressedOnPanel) runMouseKey("MouseMiddle");
      return;
    }
    if (!mouseAllowed() || e.button !== 0) return;
    if (session.gui.minimapDrag) session.gui.onMouseUp(null); // wherever the button came up
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
    if (session.gui.minimapDrag && (e.buttons & 1)) {
      // held on the map: keep centring the view under the pointer
      const p = pick(e);
      session.gui.onMouseMove(p && p.panelUv ? p.panelUv : null);
      return;
    }
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
      const sprite = hit && hit.object.name === "pick-plane" ? boardCursorSprite() : null;
      if (mouseCursorSprite) mouseCursorSprite.visible = !!sprite;
      if (sprite) {
        // the cursor picture on the board, the dot elsewhere
        mouseCursor.visible = false;
        sprite.position.copy(hit.point);
        gameCursor.dressSprite(sprite, !!hoveredLemming, selectDxNow(), dioramaRoot.scale.x);
      } else if (hit) {
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
  // the pointer leaving the canvas takes the cursor with it
  renderer.domElement.addEventListener("pointerleave", () => {
    if (!mouseAllowed() || renderer.xr.isPresenting) return;
    applyHover(null);
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

  /** Where the head is: the frame's pose when given, else the XR camera's. */
  function headPoseNow(headPose) {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    if (headPose && headPose.pos) {
      pos.copy(headPose.pos);
      quat.copy(headPose.quat);
    } else {
      // Mid-session callers without a frame pose: ask the XR camera, which is
      // only ever the head. The user camera is a copy the renderer refreshes
      // each frame, so anything on the desktop path can leave its own numbers
      // in it between renders.
      const eye = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
      eye.matrixWorld.decompose(pos, quat, new THREE.Vector3());
    }
    return { pos, quat };
  }

  /**
   * Set the windows' frame from the head: each window's own layout is in
   * metres in front of the eyes, so the root goes where a head would have
   * to be for the window to sit centred on the gaze, at the usual distance -
   * but turned by the gaze's yaw alone, so the window stands upright on the
   * floor however far up or down the head was tilted. The root being the
   * scene's, the window stays there when the head moves on. Called as a
   * window opens, on the first pose of a session, and by every recentre.
   */
  let vrWindowYaw = 0; // kept for a gaze too vertical to have a heading
  function placeVrWindows(headPose) {
    // the last rendered frame's pose first: between frames the XR camera can
    // be behind or, before any frame, still identity
    const head = headPoseNow(headPose || vr.lastHeadPose);
    const gaze = new THREE.Vector3(0, 0, -1).applyQuaternion(head.quat);
    // where the window's plane meets the gaze
    const centre = head.pos.clone().addScaledVector(gaze, -VR_MODAL_Z);
    const flat = new THREE.Vector3(gaze.x, 0, gaze.z);
    if (flat.lengthSq() > 1e-4) vrWindowYaw = Math.atan2(-flat.x, -flat.z);
    vrWindowRoot.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), vrWindowYaw);
    vrWindowRoot.position.copy(centre).sub(
      new THREE.Vector3(0, 0, VR_MODAL_Z).applyQuaternion(vrWindowRoot.quaternion));
    vrWindowsPlaced = true;
  }

  function placeDioramaForXR(headPose) {
    if (!session) return false;
    const s = VR_PIXEL_SCALE;
    const head = headPoseNow(headPose);
    const headPos = head.pos, headQuat = head.quat;
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
    const strip = vrStatusPx();
    vrWarningSign.position.set(
      startX, session.level.height + VR_STATUS_GAP + strip.h * 1.35 + 24 + signH / 2, 40);
    // the bar goes with the board, unless it is riding the head by choice
    if (barAutoPlace || !barLocked) placeBarBelowDiorama();
    barAutoPlace = false;
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
    resetBar();          // on the head until the board is placed...
    barAutoPlace = true; // ...then below the board, unlocked
    layoutGuiPanel();
    vrWindowsPlaced = false; // the first frame's pose places them
    // no level chosen yet: the headset gets the catalog the monitor shows
    if (!state.levelId) setVrCatalog(true);
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
    setVrDetail(false);
    noteVrTipHover(null); // and no label lingers from a headset beam
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
    } else if (p.barTool === "park") {
      // back where a session starts it: in the room, below the board
      barParked = null;
      placeBarBelowDiorama();
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
    } else if (p.barTool === "detail") {
      setVrDetail(true);
    } else if (p.barTool === "detailok") {
      setVrDetail(false);
    } else if (p.barTool === "worlds") {
      setVrCatalog(true);
    } else if (p.barTool === "catclose") {
      if (!library.locked) setVrCatalog(false);
    } else if (p.barTool === "worldpanel") {
      // the scrollbar, pressed or dragged, moves the list instead
      if (p.scrollBar || p.scrubbing) {
        if (vrCatalogScrollTo(p.scrollAt)) paintVrCatalog();
      } else {
        const item = vrCatalogItems[p.tile];
        if (item && item.kind === "back") {
          library.up();
          loadVrCatalog();
        } else if (item && item.kind === "dir") {
          library.navigate(item.node.path);
          loadVrCatalog();
        } else if (item && item.playable) {
          setVrCatalog(false);
          library.enter(item.levelId);
        }
      }
    } else if (p.barTool === "yes") {
      const act = vrConfirmAction;
      setVrModal(false);
      if (act) act();
    } else if (p.barTool === "no") {
      setVrModal(false);
    } else if (p.barTool === "minimap" && session) {
      // the press centres the view; held and moved, it goes on centring
      if (session.gui.minimapDrag) session.gui.onMouseMove(p.panelUv);
      else session.gui.onMouseDown(p.panelUv);
    } else if (p.panelUv && session) {
      audio.playSfx(SFX.CLICK);
      session.gui.onMouseDown(p.panelUv);
      session.gui.onMouseUp(p.panelUv);
    } else if (p.simX !== undefined) {
      actOnSimPick(p.simX, p.simY);
    }
  }

  const vr = new VRManager(renderer, scene, camera, dioramaRoot, {
    pickWithRaycaster,
    raycastHit,
    // NeoLemmix's cursor where the beam lands on the board (null until its pictures are in)
    cursorSprite: () => (cursorReady() ? gameCursor.makeSprite(VR_MARK_ORDER) : null),
    dressCursor: (sprite) => gameCursor.dressSprite(sprite, !!hoveredLemming, selectDxNow(), dioramaRoot.scale.x),
    onSelectPick: actOnPick,
    onHoverPick: applyHover,
    // a hold on the minimap ends with the trigger, or when the beam leaves it
    onScrubEnd: (what) => { if (what === "minimap" && session) session.gui.onMouseUp(null); },
    onScrubOff: (what) => { if (what === "minimap" && session) session.gui.onMouseMove(null); },
    onBarDragStart: () => { barDragFrom = guiRoot.position.clone(); },
    // the hand moves in world space; the bar hangs off the head or the scene,
    // so the delta is turned into whichever space it is living in
    onBarDrag: (worldDelta) => {
      if (!barDragFrom || !guiRoot.parent) return;
      const q = guiRoot.parent.getWorldQuaternion(new THREE.Quaternion());
      guiRoot.position.copy(barDragFrom)
        .add(worldDelta.clone().applyQuaternion(q.invert()));
    },
    // a thumbstick does what the controls table says (pan, tilt or dolly) -
    // except while the catalog is up, when either stick scrolls its list and
    // neither one moves the board behind it
    onStick: (code, x, y, seconds) => {
      if (vrCatalog.visible) {
        scrollVrCatalog(-y * VR_CAT_SCROLL * seconds);
        return;
      }
      if (!session) return;
      const b = hotkeys.get(code);
      if (!b) return;
      if (b.action === "vr_tilt") tiltDioramaBy(x, y, seconds);
      else if (b.action === "vr_pan") panDioramaBy(x, y, seconds);
      else if (b.action === "vr_zoom" && y) dollyVr(Math.sign(y), Math.abs(y) * seconds);
    },
    // the face buttons and stick clicks: a function from the controls table
    // on the press, the held filters through the set of inputs down, the
    // dollies for as long as the button stays down
    onVrButton: (code, down) => {
      if (down) {
        const b = hotkeys.get(code);
        if (!b) return;
        const a = Hotkeys.ACTION_BY_ID.get(b.action);
        heldCodes.add(code);
        if (a && a.held) checkShifts();
        else if (b.action !== "vr_dolly_in" && b.action !== "vr_dolly_out") {
          // a window up owns the hands; a recentre is the way out of anything
          if (!anyVrWindowUp() || b.action === "recenter_vr") runHotkey(b);
        }
      } else keyUp(code);
    },
    onVrButtonHeld: (code, seconds) => {
      const b = hotkeys.get(code);
      if (!b) return;
      if (b.action === "vr_dolly_in") dollyVr(1, seconds);
      else if (b.action === "vr_dolly_out") dollyVr(-1, seconds);
    },
    placeDiorama: placeDioramaForXR,
    // a recentre brings the windows to the new view along with the board
    onRecenter: (headPose) => placeVrWindows(headPose),
  });

  /**
   * A dolly: the board slides along the line of sight, so the point of it
   * being looked at - wherever the board has been panned to - comes closer
   * or recedes, staying dead centre, and the rest grows or shrinks with it
   * in perspective. (Scaling about the level's focus, as the keys do, pulls
   * a panned board toward its middle instead.) A gaze off the board dollies
   * its focus point. Not while a window is up, which owns the hands.
   */
  function dollyVr(dir, seconds) {
    if (!session || anyVrWindowUp()) return;
    const head = vr.lastHeadPose;
    if (!head) return;
    const gaze = new THREE.Vector3(0, 0, -1).applyQuaternion(head.quat);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(dioramaRoot.quaternion);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, dioramaFocusWorld());
    const point = new THREE.Ray(head.pos, gaze).intersectPlane(plane, new THREE.Vector3())
      || dioramaFocusWorld();
    const line = point.sub(head.pos);
    const dist = line.length();
    if (dist < 1e-4) return;
    const next = THREE.MathUtils.clamp(
      dist / Math.pow(VR_ZOOM_RATE, dir * seconds), VR_ZOOM_NEAR, VR_ZOOM_FAR);
    dioramaRoot.position.addScaledVector(line.normalize(), next - dist);
  }

  function togglePause() {
    if (!session) return;
    const timer = session.game.getGameTimer();
    timer.toggle();
    hudIcons.pause({ on: !timer.isRunning() });
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
    hudIcons.pause({ on: !session.game.getGameTimer().isRunning() });
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
  function askConfirm(title, verb, action, body) {
    confirmDom.title.textContent = title;
    confirmDom.body.textContent = body || "Progress on this level is lost.";
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

  // --------------------------------------------------------------- hotkeys
  /**
   * NeoLemmix's key table (hotkeys.js): a key is looked up and its function
   * run, for either engine - the functions a DOS level cannot do are simply
   * nothing there. The held ones (a direction filter, walkers only, the
   * athlete info) work through the set of keys down, read after every key
   * event as NeoLemmix's CheckShifts reads the keyboard; the release-rate
   * keys and a "hold" clear physics undo themselves on the key's release.
   * The dialog behind the "hotkeys" button edits the table and keeps it in
   * this browser. A headset gets the keys too: the keyboard still reaches
   * the page while it presents.
   */
  const hotkeys = new Hotkeys.HotkeyManager(); // the keyboard's keys and the headset's inputs
  const hotkeyDialog = new Hotkeys.HotkeyDialog(hotkeys, {
    onOpen: () => { releaseHeldKeys(); holdSim("hotkeys"); },
    onClose: () => { releaseSim("hotkeys"); refreshKeyHints(); },
  });
  document.getElementById("btn-controls").addEventListener("click", () => hotkeyDialog.open());
  hotkeys.onChange = () => refreshKeyHints();

  /** The tooltips and the controls panel name the keys as they are set. */
  function refreshKeyHints() {
    const k = (id, mod) => { const n = hotkeys.keyNameFor(id, mod); return n ? " (" + n + ")" : ""; };
    const t = (id, text, mod) => { const b = document.getElementById(id); if (b) b.title = text + k(b.dataset.action, mod); };
    t("btn-prev", "previous level");
    t("btn-next", "next level");
    t("btn-pause", "pause / resume");
    t("btn-library", "world library");
    t("btn-sound", "sound on / off");
    t("btn-view", "reset the view");
    const hint = document.getElementById("hud-keys-hotkeys");
    if (hint) {
      const parts = [];
      const add = (id, label, mod) => { const n = hotkeys.keyNameFor(id, mod); if (n) parts.push("<b>" + n + "</b> " + label); };
      add("pause", "pause"); add("skip", "step", 1); add("restart", "restart"); add("fastforward", "fast forward");
      add("previous_skill", "prev skill"); add("next_skill", "next skill"); add("quit", "library"); add("save_replay", "save replay");
      hint.innerHTML = parts.join(" &middot; ") + (parts.length ? " &middot; " : "") + "<b>configure controls</b> (below) sets them all";
    }
  }
  for (const [id, action] of [["btn-prev", "previous_level"], ["btn-next", "next_level"], ["btn-pause", "pause"],
    ["btn-library", "quit"], ["btn-sound", "toggle_sound"], ["btn-view", "reset_view"]]) {
    document.getElementById(id).dataset.action = action;
  }
  refreshKeyHints();

  const FF_SPEED = 4, SLOWMO_SPEED = 0.25; // NeoLemmix's fast forward and slow motion
  const NUKE_DOUBLE_MS = 250;              // the second press of the nuke key must come within this
  const isMac = /Mac/.test(navigator.platform);
  const heldCodes = new Set();
  let lastNukeKeyAt = 0;

  const heldAction = (id) => {
    for (const c of heldCodes) { const b = hotkeys.get(c); if (b && b.action === id) return true; }
    return false;
  };

  /** CheckShifts: the held keys' filters into the game. */
  function checkShifts() {
    if (!session || !session.game.sim) return;
    const game = session.game, sim = game.sim;
    let dx = 0;
    if (heldAction("dir_select_left")) dx--;
    if (heldAction("dir_select_right")) dx++; // both held cancel out, as in NeoLemmix
    sim.hotkeyDx = dx;
    sim.selectWalkerOnly = heldAction("force_walker");
    const info = heldAction("athlete_info");
    if (game.showAthleteInfo !== info) {
      game.showAthleteInfo = info;
      if (game.gui) game.gui.render(true);
    }
  }

  /** A key let go: the held filters re-read, a held release-rate or clear-physics key released. */
  function keyUp(code) {
    heldCodes.delete(code);
    const b = hotkeys.get(code);
    if (b && session) {
      if (b.action === "rr_down" || b.action === "rr_up") holdReleaseRate(0);
      else if (b.action === "clear_physics" && b.mod && session.game.setClearPhysics) session.game.setClearPhysics(false);
    }
    checkShifts();
  }

  /** Every held key let go at once: focus lost, or a dialog taking the keyboard. */
  function releaseHeldKeys() {
    for (const code of Array.from(heldCodes)) keyUp(code);
    heldCodes.clear();
    checkShifts();
  }
  window.addEventListener("blur", releaseHeldKeys);

  /** A held release-rate key: the Lemmix panel's own repeat, or the DOS panel's per-tick change. */
  function holdReleaseRate(dir) {
    if (!session) return;
    const game = session.game;
    if (dir) game.queueCmmand(dir > 0 ? new Lemmings.CommandReleaseRateIncrease(1) : new Lemmings.CommandReleaseRateDecrease(1));
    if (game.gui && "rrHeld" in game.gui) game.gui.rrHeld = dir;
    else if (game.gameGui) game.gameGui.deltaReleaseRate = dir;
  }

  /** Select a skill by NeoLemmix's name: the level's cell of it, on either panel. */
  function selectSkillNamed(name) {
    const game = session.game;
    if (game.selectSkillByName) { game.selectSkillByName(name); return; }
    const type = Lemmings.SkillTypes[String(name).toUpperCase()];
    if (type) game.queueCmmand(new Lemmings.CommandSelectSkill(type));
  }

  /** The next (+1) or previous (-1) skill on the panel, wrapping as NeoLemmix wraps. */
  function stepSkill(dir) {
    const game = session.game;
    if (game.stepSkill) { game.stepSkill(dir); return; }
    // the DOS panel: its eight skills, in the order of their types
    const n = 8, sn = game.getGameSkills().getSelectedSkill() - 1;
    let to = -1;
    if (dir > 0) { if (sn >= 0 && sn < n - 1) to = sn + 1; else if (sn > 0) to = 0; }
    else { if (sn > 0) to = sn - 1; else if (sn === 0) to = n - 1; }
    if (to >= 0) game.queueCmmand(new Lemmings.CommandSelectSkill(to + 1));
  }

  /** Fast forward or slow motion: on at that speed, off back to normal; a paused game runs. */
  function toggleSpeed(speed) {
    const timer = session.game.getGameTimer();
    const paused = !timer.isRunning();
    timer.speedFactor = !paused && timer.speedFactor === speed ? 1 : speed;
    if (paused) { timer.continue(); hudIcons.pause({ on: false }); }
  }

  /** A time skip of `n` frames: back through the saved states (Lemmix), forward by ticks. */
  function skipFrames(n) {
    const game = session.game, timer = game.getGameTimer();
    if (game.sim) {
      if (n < 0) game.backFrames(-n);
      else game.forwardFrames(n);
      return;
    }
    if (n === 1) { if (!timer.isRunning()) timer.tick(); }
    else for (let i = 0; i < n; i++) timer.tick();
  }

  /** Save Replay: the attempt as a file - NeoLemmix's .nxrp, or the DOS engine's replay string. */
  function saveReplayFile() {
    const game = session.game;
    const base = (hud.name.textContent || "level").trim().replace(/[^\w.-]+/g, "_").slice(0, 60) || "level";
    let text, name;
    if (game.sim) {
      text = Lemmix.Replay.serialize(game.sim, {});
      name = base + ".nxrp";
    } else {
      text = game.getCommandManager().serialize();
      name = base + ".replay.txt";
      console.log("replay string (append as ?replay=... to reproduce this run):");
    }
    console.log(text);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function toggleMusic() {
    state.music = !state.music;
    try { localStorage.setItem("lem3d-music", state.music ? "on" : "off"); } catch (e) {}
    if (!state.music) audio.stopMusic();
    else if (session) session.playMusic();
  }

  function toggleShadows() {
    state.shadows = !state.shadows;
    try { localStorage.setItem("lem3d-shadows", state.shadows ? "on" : "off"); } catch (e) {}
    if (session && session.syncScene && !session.game.getGameTimer().isRunning()) session.syncScene(true);
  }

  /** One zoom step in or out: the camera along its line of sight, or the diorama about its focus. */
  function zoomView(zoomIn) {
    if (!session) return;
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
  }

  /** The view back to its start: the desktop camera framed, the headset recentred. */
  function resetView() {
    if (!session) return;
    if (renderer.xr.isPresenting) vr.recenterNow();
    else frameDesktopCamera(session.level);
  }

  /** The piece editor is the edit mode's tool; asking for it enters the mode. */
  function openPieceEditor() {
    if (!state.edit) {
      state.edit = true;
      try { localStorage.setItem("lem3d-edit", "on"); } catch (err) {}
      renderMode();
    }
    if (session && session.editor) session.editor.toggle();
  }

  /**
   * Form_KeyDown: a key's function, on the key going down. The held ones
   * (direction filters, walkers only, athlete info) are not here: the set
   * of keys down does their work. Returns whether the key was taken.
   */
  function runHotkey(b) {
    const a = Hotkeys.ACTION_BY_ID.get(b.action);
    if (!a || a.held) return false;
    if (!session) {
      // without a level on the board, only what does not need one
      if (b.action === "quit") { if (renderer.xr.isPresenting) setVrCatalog(true); else library.open(); return true; }
      if (b.action === "previous_level") { moveLevel(-1); return true; }
      if (b.action === "next_level") { moveLevel(1); return true; }
      return false;
    }
    const game = session.game, sim = game.sim || null, timer = game.getGameTimer();
    if (Hotkeys.tagOf(b) === "lemmix" && !sim) return true; // a NeoLemmix function on a DOS level: nothing
    switch (b.action) {
      case "skill": selectSkillNamed(b.mod); break;
      case "previous_skill": stepSkill(-1); break;
      case "next_skill": stepSkill(1); break;
      case "rr_down": holdReleaseRate(-1); break;
      case "rr_up": holdReleaseRate(1); break;
      case "rr_min":
      case "rr_max": {
        const dir = b.action === "rr_max" ? 1 : -1;
        if (sim) game.setReleaseRateExtreme(dir);
        else game.queueCmmand(dir > 0 ? new Lemmings.CommandReleaseRateIncrease(99) : new Lemmings.CommandReleaseRateDecrease(99));
        break;
      }
      case "pause": togglePause(); break;
      case "nuke": {
        // a double press, so a stray key does not end the level
        const now = performance.now();
        if (now - lastNukeKeyAt < NUKE_DOUBLE_MS) {
          lastNukeKeyAt = 0;
          game.queueCmmand(new Lemmings.CommandNuke());
          game.nukePrepared = false;
        } else lastNukeKeyAt = now;
        break;
      }
      case "fastforward": toggleSpeed(FF_SPEED); break;
      case "slow_motion": toggleSpeed(SLOWMO_SPEED); break;
      case "skip": skipFrames(b.mod | 0); break;
      case "special_skip": if ((b.mod | 0) === 0) game.skipToLastAction(); else game.skipToNextShrugger(); break;
      case "restart": if (sim) game.restartReplay(); else moveLevel(0); break;
      case "save_state": game.saveStateMark(); break;
      case "load_state": game.loadStateMark(); break;
      case "clear_physics": if (b.mod) game.setClearPhysics(true); else game.toggleClearPhysics(); break;
      case "toggle_shadows": toggleShadows(); break;
      case "replay_insert": game.toggleReplayInsert(); break;
      case "cancel_replay": game.cancelReplay(); break;
      case "load_replay": game.requestLoadReplay(); break;
      case "save_replay": saveReplayFile(); break;
      case "toggle_music": toggleMusic(); break;
      case "toggle_sound": soundBtn.click(); break;
      case "zoom_in": zoomView(true); break;
      case "zoom_out": zoomView(false); break;
      case "quit": if (renderer.xr.isPresenting) setVrCatalog(true); else library.open(); break;
      case "cheat": game.getGameSkills().cheat(); if (game.gui && game.gui.render) game.gui.render(true); break;
      case "reset_view": resetView(); break;
      case "recenter_vr": if (renderer.xr.isPresenting) vr.recenterNow(); break;
      case "speed_up": timer.speedFactor = Math.min(10, timer.speedFactor + 1); break;
      case "speed_down": timer.speedFactor = Math.max(0.5, timer.speedFactor - 0.5); break;
      case "previous_level": moveLevel(-1); break;
      case "next_level": moveLevel(1); break;
      case "piece_editor": openPieceEditor(); break;
      case "cycle_class": if (session.editor && session.editor.enabled) session.editor.cycleClass(); break;
      case "yaw_left":
      case "yaw_right":
        vrYawCorrection += (b.action === "yaw_right" ? 1 : -1) * (Math.PI / 12);
        console.log("[vr] yaw correction: " + Math.round(vrYawCorrection * 180 / Math.PI) + "°");
        if (renderer.xr.isPresenting) vr.recenterNow();
        break;
      default: return false;
    }
    return true;
  }

  /** A mouse button as a key: the middle and right clicks of NeoLemmix's table. */
  function runMouseKey(code) {
    const b = hotkeys.get(code);
    if (b) runHotkey(b);
  }

  /** The view keys that are not in the table: arrows pan, shift+arrows orbit. */
  function viewKey(e) {
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        if (!session) return false;
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
          return true;
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
        return true;
      }
    }
    return false;
  }

  const typingIn = (el) => !!(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable));

  window.addEventListener("keydown", (e) => {
    // a question on screen owns the keyboard: answer it or dismiss it, but
    // do not let a stray space bar pause the game behind it
    if (!confirmDom.panel.hidden) {
      if (e.key === "Escape") { e.preventDefault(); closeConfirm(); }
      else if (e.key === "Enter") { e.preventDefault(); confirmDom.yes.click(); }
      return;
    }
    if (hotkeyDialog.isOpen || typingIn(e.target) || vrModal.visible) return;
    // the browser's own shortcuts stay its own (a reload, a new tab)
    if (e.metaKey || (e.ctrlKey && !isMac)) return;
    // the library open: Escape closes it, the rest waits for a level
    if (library.isOpen) {
      if (e.key === "Escape") { e.preventDefault(); library.close(); }
      return;
    }
    const code = Hotkeys.normalizeCode(e.code);
    const b = hotkeys.get(code);
    if (b) {
      const a = Hotkeys.ACTION_BY_ID.get(b.action);
      heldCodes.add(code);
      if (a.held) checkShifts();
      else if (!e.repeat || a.repeat) runHotkey(b);
      e.preventDefault();
      // a held function leaves the fixed view keys their work (a direction
      // filter on an arrow key does not stop the arrow from panning)
      if (!a.held) return;
    }
    viewKey(e);
  });
  window.addEventListener("keyup", (e) => {
    if (typingIn(e.target)) return;
    keyUp(Hotkeys.normalizeCode(e.code));
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
      if (session.cpmAnimate) session.cpmAnimate(now);
      session.gui.setViewRect(visibleLevelRect()); // the minimap's frame
      session.gui.update();
      setReplayBadge(!!session.game.replaying); // the red REPLAY over the play area
      layoutGuiPanel(); // no-ops unless the viewport or mode changed
      if (renderer.xr.isPresenting) {
        // the pause icon tracks the clock however it was stopped - this
        // button, the panel, the space bar or the catalog
        setBarToolState(vrPauseBtn,
          { on: !session.game.getGameTimer().isRunning() });
      }
    }
    // the in-scene windows are there with or without a level: the catalog
    // is how a level gets chosen in the first place
    if (renderer.xr.isPresenting) {
      layoutVrModal();
      layoutVrCatalog();
      layoutVrSettings();
      layoutVrDetail();
      updateVrTip();
    } else if (anyVrWindowUp()) {
      setVrModal(false);
      setVrCatalog(false);
      setVrSettings(false);
      setVrDetail(false);
    }
    if (renderer.xr.isPresenting) {
      // grabs, sticks and hover; the headset pose drives the camera
      vr.update(dt / 1000);
      // a window opened before the first pose (the catalog, at a session's
      // start) was placed on an identity head; place it on the real one
      if (!vrWindowsPlaced && vr.lastHeadPose) placeVrWindows(vr.lastHeadPose);
      // the sign is parked over the level, so it has nowhere to be without one
      vrWarningSign.visible = vrMouseFallback() && !!session;
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

  // world library: the level packs, browsed like the levels/ directory
  const library = new WorldLibrary(factory, "../", async (levelId) => {
    state.levelId = levelId;
    await loadLevel();
    // the catalog is a way into a level in either mode; only the tagging
    // workbench opens the editor with it
    if (state.edit && session && session.editor) session.editor.enable();
  }, (open) => {
    if (open) holdSim("library");
    else releaseSim("library");
  });
  // NeoLemmix levels: parsed and built from the styles on disk. Until the
  // Lemmix engine plays them, this is how their miniatures are drawn.
  Lemmix.io = Lemmix.StyleManager.browserIO("../");
  const lemmixStyles = new Lemmix.StyleManager(Lemmix.io);
  // the Lemmix engine: a level built from the styles, the sprite set its
  // theme names, the physics masks, and a Game the page drives like the DOS one
  const lemmixEngine = {
    masks: null,
    spriteSets: new Map(),
    async createGame(where) {
      const level = await library.loadLevel(where.level.id);
      if (!this.masks) this.masks = await Lemmix.loadMasks(Lemmix.io);
      const setName = (level.theme && level.theme.lemmings) || "default";
      if (!this.spriteSets.has(setName)) this.spriteSets.set(setName, new Lemmix.SpriteSet(Lemmix.io).load(setName));
      const sprites = await this.spriteSets.get(setName);
      const game = new Lemmix.Game(level, { masks: this.masks, sprites });
      game.packDir = where.pack && where.pack.dir ? where.pack.dir : null; // a pack's own panel graphics
      return game;
    },
    /**
     * What depth.js and the piece editor read: the placed pieces with an id
     * per distinct drawn image, each image as a palette-style frame (0x80 =
     * transparent), and the piece's name as the key its tags live under.
     */
    groundData(level) {
      const ids = new Map();
      const terraImages = {};
      const terrains = [];
      for (const p of level.pieces || []) {
        const d = p.drawn;
        if (!ids.has(d.variantKey)) {
          const id = ids.size;
          ids.set(d.variantKey, id);
          const frame = new Uint8Array(d.width * d.height);
          for (let i = 0, a = 3; i < frame.length; i++, a += 4) frame[i] = d.image.data[a] < 128 ? 0x80 : 0;
          terraImages[id] = { width: d.width, height: d.height, frames: [frame], name: d.key };
        }
        terrains.push({
          x: p.x, y: p.y, id: ids.get(d.variantKey), key: d.key,
          drawProperties: { isUpsideDown: false, noOverwrite: p.noOverwrite, onlyOverwrite: false, isErase: p.erase },
        });
      }
      return { lr: { levelWidth: level.width, levelHeight: level.height, terrains, graphicSet1: null, steel: [] }, terraImages };
    },
    /**
     * Where a level's music may be: its MUSIC line (a ;-separated list of
     * fallbacks), else the pack's rotation by level ordinal; each name tried
     * in the pack's music folder and then neolemmix/music/ (the NeoLemmix
     * music packs), with the extensions NeoLemmix tries.
     */
    musicCandidates(where, level) {
      const names = [];
      const music = (level.info && level.info.music) || "";
      if (music) {
        for (let part of music.split(";")) {
          part = part.trim().replace(/^!/, "");
          if (!part || part.startsWith("?")) continue;
          names.push(part);
        }
      }
      const rotation = (where.pack && where.pack.musicRotation) || [];
      if (rotation.length) {
        const ordinal = LevelTree.levelsOf(where.pack).indexOf(where.level);
        names.push(rotation[((ordinal % rotation.length) + rotation.length) % rotation.length]);
      }
      const dirs = [];
      if (where.pack && where.pack.musicDir) dirs.push(where.pack.musicDir);
      dirs.push(Lemmix.ASSET_DIR + "music");
      const urls = [];
      for (const name of names) {
        for (const dir of dirs) {
          for (const ext of ["ogg", "wav", "mp3", "it", "mod", "xm", "s3m"]) {
            urls.push("../" + (dir + "/" + name + "." + ext).split("/").map(encodeURIComponent).join("/"));
          }
        }
      }
      return urls;
    },
    /** What portals.js reads: an id per object and its trigger box, in DOS terms. */
    objectData(level) {
      const T = Lemmings.TriggerTypes;
      const objects = level.objects.map((o, i) => ({ id: o.gadget.effectBase === "WINDOW" ? 1 : 100 + i }));
      const objectImg = {};
      level.objects.forEach((o, i) => {
        const g = o.gadget, r = g.triggerRect;
        const effect = g.effect === "EXIT" || g.effect === "LOCKEXIT" ? T.EXIT_LEVEL
          : g.effect === "WATER" ? T.DROWN : g.effect === "FIRE" ? T.KILL
          : g.effect === "TRAP" || g.effect === "TRAPONCE" ? T.TRAP : T.NO_TRIGGER;
        objectImg[objects[i].id] = {
          trigger_effect_id: effect, trigger_left: r.x0 - g.x, trigger_top: r.y0 - g.y,
          trigger_width: r.x1 - r.x0, trigger_height: r.y1 - r.y0,
        };
      });
      return { objects, objectImg };
    },
  };
  library.registerLoader("lemmix", async (level) => {
    const res = await fetch("../" + level.url.split("/").map(encodeURIComponent).join("/"));
    if (!res.ok) throw new Error("level file: HTTP " + res.status);
    const data = Lemmix.LevelBuilder.parseLevel(await res.text());
    return Lemmix.LevelBuilder.build(data, lemmixStyles, { seed: level.id });
  });
  document.getElementById("btn-library").addEventListener("click", () => library.toggle());
  // the panel's load-replay half opens this picker: the file plays from the start
  const replayFile = document.getElementById("replay-file");
  if (replayFile) {
    // NeoLemmix's StartReplay: the file is read, a replay that names another
    // level draws a warning first, then the level plays it from the start at
    // normal speed
    replayFile.addEventListener("change", async () => {
      const file = replayFile.files && replayFile.files[0];
      replayFile.value = "";
      releaseSim("replay-file");
      if (!file || !session || !session.game.loadReplayFile) return;
      let parsed;
      try { parsed = Lemmix.Replay.parse(await file.text()); }
      catch (e) { console.warn("[3d] replay file:", e); return; }
      const game = session.game;
      const load = () => { if (session && session.game === game) game.loadReplayFile(parsed); };
      const own = String(game.level.info && game.level.info.id || "").toUpperCase();
      const theirs = String(parsed.meta.id || "").toUpperCase();
      if (theirs && own && theirs !== own) {
        askConfirm("Replay from another level?", "load it anyway",
          load, "This replay appears to be from a different level. Whatever it does here will make little sense.");
      } else load();
    });
    // the dialog closed without a file: the clock goes on (Chrome fires cancel; focus is the fallback)
    replayFile.addEventListener("cancel", () => releaseSim("replay-file"));
    window.addEventListener("focus", () => releaseSim("replay-file"));
  }
  renderMode(); // billing, catalog labels and editor availability

  // The folding panels down the right edge - the key hints, the 3D
  // effects. Each is a button; pressed, it unfolds into its panel, which
  // stays as long as the mouse is on it and folds back a couple of seconds
  // after the mouse has left - or at once from its own close.
  const FOLD_MS = 2000;
  function foldingPanel(panel) {
    let timer = null;
    const cancel = () => { clearTimeout(timer); timer = null; };
    const fold = () => { cancel(); panel.classList.add("folded"); };
    const arm = () => {
      cancel();
      timer = window.setTimeout(() => {
        timer = null;
        if (!panel.matches(":hover")) fold();
      }, FOLD_MS);
    };
    panel.querySelector(".fold-open").addEventListener("click", () => {
      panel.classList.remove("folded");
      // the button was where the panel now is, so the mouse is usually on
      // it; when it is not (a touch, say), the panel folds on its own
      window.setTimeout(() => { if (!panel.matches(":hover")) arm(); }, 0);
    });
    panel.querySelector(".fold-close").addEventListener("click", fold);
    panel.addEventListener("mouseenter", cancel);
    panel.addEventListener("mouseleave", () => {
      if (!panel.classList.contains("folded")) arm();
    });
  }
  document.querySelectorAll(".fold").forEach(foldingPanel);

  // debug handle for the console / automated checks
  window.__lem3d = {
    state, camera, renderer, controls, library, vr, dioramaRoot, placeDioramaForXR,
    audio, // audition SFX indexes: __lem3d.audio.playSfx(n)
    lemmixStyles,
    visibleLevelRect, centerViewOn, // the minimap's view rectangle and its click
    setReplayBadge, layoutGuiPanel, // for checks without a frame loop
    hotkeys, hotkeyDialog, runHotkey, // the key table, its dialog, a function by its binding
    get cursor() { return gameCursor; },
    // the headset's catalog, for checks without a headset: load(landing), items(), panel (its canvas texture)
    vrCatalog: { load: loadVrCatalog, items: () => vrCatalogItems, cells: () => vrCatalogCells, panel: vrCatalogPanel },
    // the beam's label on an icon button, for the same: update() is the per-frame step
    vrTip: { update: updateVrTip, mesh: vrTip, text: () => vrTipText },
    get session() { return session; },
  };

  if (state.asked) {
    loadLevel().catch((err) => {
      hud.loading.textContent = "FAILED TO LOAD — see console";
      console.error(err);
    });
  } else {
    // Nothing asked for: the world library, at the root of levels/, and it
    // stays up until a level is chosen. The board behind it is empty.
    hud.loading.classList.add("hidden");
    hud.name.textContent = "no level loaded";
    hud.state.textContent = "choose a level in the world library";
    setVrStatus({ name: "choose a level", meta: "", note: "", kind: "" });
    library.open({ path: "", locked: true });
  }
  // setAnimationLoop instead of window rAF: inside an XR session the
  // headset's frame loop (90Hz) drives the same fixed-step accumulator
  renderer.setAnimationLoop(animate);
})();
