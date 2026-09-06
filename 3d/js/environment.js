"use strict";
/**
 * The environment: a floor, a ceiling and a run of walls going back in
 * layers around the board - each layer a band of floor and ceiling and a
 * cut-out skyline the next shows through, the last one the sky, every one
 * deeper in the fog - so the diorama sits in a place with distance in it
 * rather than floating in the void. The pictures are envgen.js's; this
 * hangs them in the scene and keeps them where they belong.
 *
 * The room lives under `envRoot`, a sibling of `dioramaRoot` in the same
 * frame (1 unit = 1 board pixel, y up, the slab's back face at z = 0). In a
 * session the root copies the diorama's placement - its yaw, its scale and
 * where it was put - the moment the board is placed, and then stays: the
 * floor is at the physical floor (the `local-floor` reference space's
 * y = 0) whatever height the board hangs at, and a board grabbed, dollied or
 * rescaled afterwards moves inside the room, not with it. On the desktop the
 * root is the identity and the room stands around the diorama in pixel
 * units, the same proportions, so the whole thing can be looked at without
 * a headset.
 *
 * The room and its planes, their geometry and materials live for the
 * page; a level only brings its own textures (an EnvironmentSet), built off
 * the critical path once the board is up - the ambient gradients first, in
 * one go, then the collage a plane per frame - and disposed with the level.
 * Three states, like the other 3D effects: "off" (nothing, the scene as it
 * was), "ambient" (the gradients), "full" (the collage as well).
 */

const ENV_SCENE_COLOR = 0x10141c;  // the page's own background, restored when the room is off
const ENV_BACKDROP_COLOR = 0x05070c; // the slab's backdrop without an environment (app.js)
const ENV_MODES = ["off", "ambient", "full"];

class Environment {
  constructor(scene, dioramaRoot, opts) {
    this.scene = scene;
    this.dioramaRoot = dioramaRoot;
    this.pxPerMetre = opts.pxPerMetre;
    this.mode = "off";
    this.level = null;      // { ctx, room, styles } while a level is loaded
    this.set = null;        // the level's textures
    this.grid = null;       // the headset's floor grid, hidden while the floor shows
    this.stats = {};
    this._token = 0;
    this._placed = "desktop";
    this._sceneColor = scene.background && scene.background.isColor ? scene.background.getHex() : ENV_SCENE_COLOR;

    const root = new THREE.Group();
    root.name = "environment";
    root.visible = false;
    scene.add(root);
    this.root = root;

    const geom = new THREE.PlaneGeometry(1, 1);
    this.geometry = geom;
    const plane = (name, cutout) => {
      // a wall that is not the last is a cut-out: what it leaves clear shows the layer behind
      const mat = new THREE.MeshBasicMaterial({ color: ENV_SCENE_COLOR, side: THREE.FrontSide });
      if (cutout) { mat.transparent = true; mat.alphaTest = 0.5; }
      const mesh = new THREE.Mesh(geom, mat);
      mesh.name = "env-" + name;
      mesh.frustumCulled = false; // a plane the player stands on is cut by the near plane oddly otherwise
      root.add(mesh);
      return mesh;
    };
    this.planes = {};
    const n = EnvGen.ROOM.LAYERS.length;
    // far to near, so the nearer cut-outs are drawn over the further layers
    for (let i = n - 1; i >= 0; i--) {
      this.planes["wall" + i] = plane("wall" + i, i < n - 1);
      this.planes["floor" + i] = plane("floor" + i, false);
      this.planes["ceiling" + i] = plane("ceiling" + i, false);
    }
    this.planes.sideL = plane("sideL", false);
    this.planes.sideR = plane("sideR", false);
    // the slab's own backdrop, handed to app.js for the plane it puts behind the terrain
    this.backdropMaterial = new THREE.MeshBasicMaterial({ color: ENV_BACKDROP_COLOR });
  }

  static get MODES() { return ENV_MODES; }

  /** The floor grid the headset shows: hidden while the room's floor is up. */
  setVrGrid(grid) { this.grid = grid; this._applyVisibility(); }

  get active() { return this.mode !== "off" && !!this.level; }

  /** The state: off, ambient or full. A level already up is rebuilt for it. */
  setMode(mode) {
    if (!ENV_MODES.includes(mode)) mode = "full";
    if (mode === this.mode) return;
    const was = this.mode;
    this.mode = mode;
    this._applyVisibility();
    if (!this.level) return;
    if (mode === "off") { this._disposeSet(); this._applyBackdrop(); this._applyScene(); return; }
    if (was === "off" || (mode === "full") !== (was === "full")) this.rebuild();
  }

  /** Shown or hidden as a whole (the 2D view hides it); the state still counts. */
  setVisible(v) { this._shown = v !== false; this._applyVisibility(); }

  _applyVisibility() {
    const on = this.active && this._shown !== false;
    this.root.visible = on;
    if (this.grid) {
      // the grid proves rendering works when there is nothing else; the floor does that better
      const presenting = this._placed === "xr";
      this.grid.visible = presenting && !on;
    }
  }

  // --------------------------------------------------------------- levels
  /**
   * A level's environment, built off the critical path: `ctx` is the plain
   * data envgen.js reads (engine, levelId, width, height, theme, background,
   * backgroundName, groundImage, groundMask, donors, groundData, profile,
   * lemmixPieces, lemmixObjects, dosPalette), `styles` the Lemmix
   * StyleManager for a wallpaper named by a profile (null for the DOS engine).
   */
  async setLevel(ctx, styles) {
    this._disposeSet();
    const room = EnvGen.roomFor(ctx.width, ctx.height, this.pxPerMetre);
    this.level = { ctx, room, styles };
    this._layout();
    this._applyVisibility();
    if (this.mode === "off") { this._applyBackdrop(); return; }
    await this._build();
  }

  /** The room's pictures again, for the state in force (a profile edited, the state moved). */
  rebuild() {
    if (!this.level) return Promise.resolve();
    this._disposeSet();
    if (this.mode === "off") { this._applyBackdrop(); this._applyScene(); return Promise.resolve(); }
    return this._build();
  }

  /** The level gone: its textures with it, the scene as it was. */
  clearLevel() {
    this._token++;
    this._disposeSet();
    this.level = null;
    this._applyBackdrop();
    this._applyScene();
    this._applyVisibility();
  }

  async _build() {
    const token = ++this._token;
    const { ctx, room, styles } = this.level;
    const t0 = performance.now();
    const stats = { mode: this.mode, ms: {} };
    const set = { textures: [], palette: null, wallpaper: null, fog: null, planes: {}, source: "collage" };
    this.set = set;
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const stale = () => token !== this._token;

    await tick();
    if (stale()) return;
    const palette = EnvGen.derivePalette(ctx);
    set.palette = palette;
    stats.paletteSource = palette.source;
    // the wallpaper first: a sky is what the far layers dissolve into
    set.wallpaper = await this._wallpaper(ctx, styles);
    if (stale()) return;
    const files = await this._files(ctx);
    if (stale()) return;
    if (files) set.source = "file";
    const opts = { room, palette, wallpaper: set.wallpaper };
    // the near layer and the sky in gradients, in one go, so the room is there at once
    let t = performance.now();
    const far = room.layers[room.layers.length - 1].i;
    const first = ["floor0", "wall0", "ceiling0", "wall" + far, "side"];
    const ambient = EnvGen.build(ctx, Object.assign({ full: false }, opts), first);
    set.fog = ambient.fog;
    this._applyScene();
    for (const name of first) this._apply(name, ambient.planes[name]);
    this._applyBackdrop();
    stats.ms.ambient = Math.round(performance.now() - t);
    const full = this.mode === "full";
    // then every plane, one per frame: the collage, or the shipped picture where there is one
    let pieces = null;
    for (const name of EnvGen.planeNames(room)) {
      if (name === "side" || name === "backdrop") continue;
      if (!full && first.includes(name)) continue;
      await tick();
      if (stale()) return;
      t = performance.now();
      let bitmap = files && files[name];
      if (!bitmap) {
        const built = EnvGen.build(ctx, Object.assign({ full, pieces }, opts), [name, name === "wall0" ? "backdrop" : ""]);
        pieces = built.pieces;
        bitmap = built.planes[name];
        if (built.mode) stats.collageMode = built.mode;
        if (built.backdrop) this._applyBackdropProp(built.backdrop);
      }
      this._apply(name, bitmap);
      stats.ms[name] = Math.round(performance.now() - t);
    }
    stats.totalMs = Math.round(performance.now() - t0);
    this.stats = stats;
  }

  /** Pictures made offline for the level's style (tools/env-gen.js), or null. */
  async _files(ctx) {
    if (this.mode !== "full" || !ctx.themeName) return null;
    const dir = "3d/env/" + ctx.themeName + "/";
    const load = async (name) => {
      try {
        const res = await fetch(dir + name + ".png");
        if (!res.ok) return null;
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        const cv = document.createElement("canvas");
        cv.width = bmp.width; cv.height = bmp.height;
        const cx = cv.getContext("2d");
        cx.drawImage(bmp, 0, 0);
        const d = cx.getImageData(0, 0, cv.width, cv.height);
        return new Lemmix.Bitmap(cv.width, cv.height, d.data);
      } catch (e) { return null; }
    };
    // only asked for when an index says the folder is there: no probing 404s
    if (!Environment.shipped || !Environment.shipped.has(ctx.themeName)) return null;
    // floor.png is the first layer's, floor-1.png the next one's, and so on
    const names = EnvGen.planeNames(this.level.room).filter((n) => n !== "side" && n !== "backdrop");
    const files = await Promise.all(names.map((n) => load(Environment.fileFor(n))));
    const out = {};
    let any = false;
    names.forEach((n, i) => { if (files[i]) { out[n] = files[i]; any = true; } });
    return any ? out : null;
  }

  async _wallpaper(ctx, styles) {
    const profile = ctx.profile || {};
    const env = profile.environment || {};
    let image = null, key = null;
    if (ctx.background && ctx.background.image) {
      image = ctx.background.image;
      key = String(ctx.backgroundName || "").toLowerCase();
      if (key && !key.includes(":")) key = ctx.themeName + ":" + key;
    } else if (env.wallpaper && styles && typeof Lemmix !== "undefined" && Lemmix.splitIdentifier) {
      const id = Lemmix.splitIdentifier(String(env.wallpaper).toLowerCase(), ctx.themeName || "default");
      try { image = await styles.background(id.gs, id.piece); } catch (e) { image = null; }
      key = id.gs + ":" + id.piece;
    }
    if (!image) return null;
    return { image, key, kind: EnvGen.classifyBackground(image, key, profile) };
  }

  // ------------------------------------------------------------- textures
  _texture(bitmap, flipY) {
    const tex = new THREE.DataTexture(bitmap.data, bitmap.width, bitmap.height, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = !!flipY;
    tex.needsUpdate = true;
    if (this.set) this.set.textures.push(tex);
    return tex;
  }

  /** A plane's picture: row 0 is the far edge for a floor or ceiling band,
   *  the top for a wall; the sides share one picture. */
  _apply(name, bitmap) {
    if (!bitmap) return;
    const targets = name === "side" ? [this.planes.sideL, this.planes.sideR] : [this.planes[name]];
    if (!targets[0]) return;
    const kind = EnvGen.parsePlane(name).kind;
    // the ceiling faces down and its local +y runs toward the player, so the
    // far edge (row 0) has to be at the bottom of its picture
    const tex = this._texture(kind === "ceiling" ? bitmap.flipVertical() : bitmap, true);
    if (kind === "wall") this._wallRepeat(tex);
    for (const mesh of targets) {
      const old = mesh.material.map;
      mesh.material.map = tex;
      mesh.material.color.setHex(0xffffff);
      mesh.material.needsUpdate = true;
      if (old && this.set) { const i = this.set.textures.indexOf(old); if (i >= 0) { this.set.textures.splice(i, 1); old.dispose(); } }
    }
    if (this.set) this.set.planes[name] = bitmap;
  }

  /** The wall's picture is drawn for a nominal height; the plane's real
   *  height shows that many rows from the floor up, and past the top the
   *  darkest row goes on. */
  _wallRepeat(tex) {
    if (!this.level || !this._wallHeight) return;
    tex.repeat.set(1, this._wallHeight / this.level.room.wallPx);
    tex.offset.set(0, 0);
  }

  _applyScene() {
    const on = this.active && this.set && this.set.palette;
    // past the last layer there is only the fog
    const hex = on ? (this.set.fog !== null ? this.set.fog : EnvGen.scale(this.set.palette.dark, 0.35)) : this._sceneColor;
    if (this.scene.background && this.scene.background.isColor) this.scene.background.setHex(hex);
    else this.scene.background = new THREE.Color(hex);
  }

  /** The slab's backdrop: the page's colour, the level's, or its wallpaper tiled 1:1 behind the terrain. */
  _applyBackdrop() {
    const m = this.backdropMaterial;
    const old = m.map;
    m.map = null;
    if (old) { old.dispose(); if (this.set) { const i = this.set.textures.indexOf(old); if (i >= 0) this.set.textures.splice(i, 1); } }
    if (!this.active || !this.set || !this.set.palette) { m.color.setHex(ENV_BACKDROP_COLOR); m.needsUpdate = true; return; }
    const wp = this.set.wallpaper;
    if (wp && wp.kind === "wallpaper") {
      // the worldGroup is flipped in y, so row 0 (v = 0, no flip) lands at the top - the picture's own way up
      const tex = this._texture(wp.image, false);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(this.level.ctx.width / wp.image.width, this.level.ctx.height / wp.image.height);
      m.map = tex;
      m.color.setHex(0x999999); // behind the slab, tonally: the holes must still read as depth
    } else {
      m.color.setHex(EnvGen.scale(this.set.palette.bg, 0.7));
    }
    m.needsUpdate = true;
  }

  /** A prop background as the whole backdrop picture (envgen propBackdrop). */
  _applyBackdropProp(prop) {
    const m = this.backdropMaterial;
    if (m.map) { m.map.dispose(); }
    m.map = this._texture(prop.bitmap, false);
    m.color.setHex(0xb0b0b0);
    m.needsUpdate = true;
  }

  _disposeSet() {
    this._token++;
    if (!this.set) return;
    for (const tex of this.set.textures) tex.dispose();
    this.set = null;
    for (const mesh of Object.values(this.planes)) {
      mesh.material.map = null;
      mesh.material.color.setHex(ENV_SCENE_COLOR);
      mesh.material.needsUpdate = true;
    }
    if (this.backdropMaterial.map) { this.backdropMaterial.map = null; this.backdropMaterial.needsUpdate = true; }
    this.stats = {};
  }

  // ------------------------------------------------------------ placement
  /**
   * In a session: the room takes the diorama's placement as it is now and
   * keeps it. A yaw never mixes y with x and z, so a world height is a local
   * one through the root's y and scale alone: the floor at the physical
   * floor, the ceiling CEIL_M above it.
   */
  placeForXR(dioramaRoot) {
    this._placed = "xr";
    this.root.rotation.copy(dioramaRoot.rotation);
    this.root.scale.copy(dioramaRoot.scale);
    this.root.position.copy(dioramaRoot.position);
    const s = this.root.scale.y || 1;
    this._yFloor = (0 - this.root.position.y) / s;
    this._yCeil = (EnvGen.ROOM.CEIL_M - this.root.position.y) / s;
    this._layout();
    this._applyVisibility();
  }

  /** On the desktop: the identity, the floor a little below the board. */
  placeDesktop() {
    this._placed = "desktop";
    this.root.rotation.set(0, 0, 0);
    this.root.scale.set(1, 1, 1);
    this.root.position.set(0, 0, 0);
    this._yFloor = -EnvGen.ROOM.FLOOR_DROP_M * this.pxPerMetre;
    this._yCeil = this._yFloor + EnvGen.ROOM.CEIL_M * this.pxPerMetre;
    this._layout();
    this._applyVisibility();
  }

  _layout() {
    if (!this.level) return;
    if (this._yFloor === undefined) this.placeDesktop();
    const room = this.level.room, W = room.W;
    const yF = this._yFloor, yC = this._yCeil, yMid = (yF + yC) / 2;
    const p = this.planes;
    for (const l of room.layers) {
      const zMid = (l.zNear + l.zFar) / 2;
      const floor = p["floor" + l.i], ceiling = p["ceiling" + l.i], wall = p["wall" + l.i];
      floor.rotation.set(-Math.PI / 2, 0, 0);
      floor.scale.set(l.spanX, l.depth, 1);
      floor.position.set(W / 2, yF, zMid);
      ceiling.rotation.set(Math.PI / 2, 0, 0);
      ceiling.scale.set(l.spanX, l.depth, 1);
      ceiling.position.set(W / 2, yC, zMid);
      wall.rotation.set(0, 0, 0);
      wall.scale.set(l.spanX, yC - yF, 1);
      wall.position.set(W / 2, yMid, l.zFar);
    }
    const side = room.side, zMid = (room.frontPx + room.layers[room.layers.length - 1].zFar) / 2;
    p.sideL.rotation.set(0, Math.PI / 2, 0);
    p.sideL.scale.set(side.spanZ, yC - yF, 1);
    p.sideL.position.set(side.x0, yMid, zMid);
    p.sideR.rotation.set(0, -Math.PI / 2, 0);
    p.sideR.scale.set(side.spanZ, yC - yF, 1);
    p.sideR.position.set(side.x1, yMid, zMid);
    this._wallHeight = yC - yF;
    for (const l of room.layers) {
      const map = p["wall" + l.i].material.map;
      if (map) this._wallRepeat(map);
    }
  }
}

/** The file a plane's shipped picture is kept in: floor.png, floor-1.png, ... */
Environment.fileFor = function (name) {
  const { kind, i } = EnvGen.parsePlane(name);
  return kind + (i ? "-" + i : "");
};

// The styles with pictures made offline under 3d/env/ (tools/env-gen.js
// keeps the list in 3d/env/index.json); read once, so nothing is probed for.
Environment.shipped = null;
Environment.loadShipped = async function () {
  try {
    const res = await fetch("3d/env/index.json");
    if (!res.ok) { Environment.shipped = new Set(); return; }
    const json = await res.json();
    Environment.shipped = new Set((json.styles || []).map((s) => String(s).toLowerCase()));
  } catch (e) { Environment.shipped = new Set(); }
};
