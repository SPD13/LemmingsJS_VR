"use strict";
/**
 * The environment: rings around the player - each a band of floor and of
 * ceiling and, at its outer edge, a wall all the way round that is a
 * cut-out skyline the next ring shows through, the last one the sky, every
 * one deeper in the fog - so the diorama sits in a place with distance in
 * it, whichever way the player looks. The pictures are envgen.js's; this
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
 * The room's meshes and materials live for the page; a level brings its
 * own textures (an EnvironmentSet) and its own geometry (the rings' radii
 * depend on the board's size and the player's place), built off
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

    const plane = (name, cutout) => {
      // a wall that is not the last is a cut-out: what it leaves clear shows the ring behind
      const mat = new THREE.MeshBasicMaterial({ color: ENV_SCENE_COLOR, side: THREE.DoubleSide });
      if (cutout) { mat.transparent = true; mat.alphaTest = 0.5; }
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat); // the ring's own geometry comes with the level
      mesh.name = "env-" + name;
      mesh.frustumCulled = false; // a ring the player stands in is cut by the near plane oddly otherwise
      root.add(mesh);
      return mesh;
    };
    this.planes = {};
    const n = EnvGen.ROOM.RINGS.length;
    // far to near, so the nearer cut-outs are drawn over the further rings
    for (let i = n - 1; i >= 0; i--) {
      this.planes["wall" + i] = plane("wall" + i, i < n - 1);
      this.planes["floor" + i] = plane("floor" + i, false);
      this.planes["ceiling" + i] = plane("ceiling" + i, false);
    }
    this._center = null; // the player's place in the room's frame, board pixels
    this.props = [];      // the pieces standing on the floor between the rings (meshes)
    this._propGeometry = new THREE.PlaneGeometry(1, 1);
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
    this.level = { ctx, room, styles, geometries: [] };
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
    if (this.level) for (const g of this.level.geometries) g.dispose();
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
    const first = ["floor0", "wall0", "ceiling0", "wall" + far];
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
      if (name === "backdrop") continue;
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
    // the pieces standing between the rings
    if (full) {
      await tick();
      if (stale()) return;
      t = performance.now();
      const built = EnvGen.build(ctx, Object.assign({ full, pieces }, opts), ["props"]);
      this._applyProps(built.props || []);
      stats.ms.props = Math.round(performance.now() - t);
    }
    stats.totalMs = Math.round(performance.now() - t0);
    this.stats = stats;
  }

  /** The standing pieces: a cut-out quad each, on its ring's floor, turned to the player. */
  _applyProps(list) {
    this._clearProps();
    for (const p of list) {
      const tex = this._texture(p.bitmap, true);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(this._propGeometry, mat);
      mesh.name = "env-prop";
      mesh.userData.prop = p;
      this.root.add(mesh);
      this.props.push(mesh);
    }
    this._placeProps();
  }

  _placeProps() {
    if (!this.level) return;
    const c = this._center || this.level.room.center, yF = this._yFloor;
    for (const mesh of this.props) {
      const p = mesh.userData.prop, th = p.u * Math.PI * 2;
      const x = c.x + p.r * Math.sin(th), z = c.z + p.r * Math.cos(th);
      mesh.position.set(x, yF + p.h / 2, z);
      mesh.rotation.set(0, Math.atan2(c.x - x, c.z - z), 0); // its face to the centre
      mesh.scale.set(p.w, p.h, 1);
    }
  }

  _clearProps() {
    for (const mesh of this.props) { this.root.remove(mesh); mesh.material.dispose(); }
    this.props = [];
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
    const names = EnvGen.planeNames(this.level.room).filter((n) => n !== "backdrop");
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

  /** A plane's picture: row 0 is the rim for a floor or ceiling band, the
   *  top for a wall; every one wraps round. */
  _apply(name, bitmap) {
    if (!bitmap) return;
    const targets = [this.planes[name]];
    if (!targets[0]) return;
    const kind = EnvGen.parsePlane(name).kind;
    const tex = this._texture(bitmap, true);
    tex.wrapS = THREE.RepeatWrapping;
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
    this._clearProps();
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
  placeForXR(dioramaRoot, headPos) {
    this._placed = "xr";
    this.root.rotation.copy(dioramaRoot.rotation);
    this.root.scale.copy(dioramaRoot.scale);
    this.root.position.copy(dioramaRoot.position);
    const s = this.root.scale.y || 1;
    this._yFloor = (0 - this.root.position.y) / s;
    this._yCeil = (EnvGen.ROOM.CEIL_M - this.root.position.y) / s;
    // the rings go round the player: the head, in the room's own frame
    if (headPos) {
      this.root.updateMatrixWorld(true);
      const local = this.root.worldToLocal(headPos.clone());
      this._center = { x: local.x, z: local.z };
    } else this._center = null;
    this._layout();
    this._applyVisibility();
  }

  /** On the desktop: the identity, the floor a little below the board, the
   *  rings round the place a player would stand. */
  placeDesktop() {
    this._placed = "desktop";
    this.root.rotation.set(0, 0, 0);
    this.root.scale.set(1, 1, 1);
    this.root.position.set(0, 0, 0);
    this._yFloor = -EnvGen.ROOM.FLOOR_DROP_M * this.pxPerMetre;
    this._yCeil = this._yFloor + EnvGen.ROOM.CEIL_M * this.pxPerMetre;
    this._center = null;
    this._layout();
    this._applyVisibility();
  }

  _layout() {
    if (!this.level) return;
    if (this._yFloor === undefined) this.placeDesktop();
    const room = this.level.room;
    const c = this._center || room.center;
    const yF = this._yFloor, yC = this._yCeil;
    const p = this.planes;
    for (const g of this.level.geometries) g.dispose();
    this.level.geometries = [];
    const keep = (g) => { this.level.geometries.push(g); return g; };
    for (const l of room.layers) {
      p["floor" + l.i].geometry = keep(Environment.ringGeometry(c, l.rIn, l.rOut, yF));
      p["ceiling" + l.i].geometry = keep(Environment.ringGeometry(c, l.rIn, l.rOut, yC));
      p["wall" + l.i].geometry = keep(Environment.drumGeometry(c, l.rOut, yF, yC));
    }
    this._wallHeight = yC - yF;
    for (const l of room.layers) {
      const map = p["wall" + l.i].material.map;
      if (map) this._wallRepeat(map);
    }
    this._placeProps();
  }
}

const ENV_SEGMENTS = 96; // round a ring

/**
 * A flat ring (a disc when rIn is 0) at height y round centre `c`, its
 * picture wrapping round: u runs round from straight behind the player
 * (+z) through the board's side (-z) and back, v from the inner edge (0)
 * to the rim (1) - the picture's row 0, flipped, is the rim.
 */
Environment.ringGeometry = function (c, rIn, rOut, y) {
  const rows = 6, segs = ENV_SEGMENTS;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= rows; j++) {
    const v = j / rows, r = rIn + (rOut - rIn) * v;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs, th = u * Math.PI * 2;
      pos.push(c.x + r * Math.sin(th), y, c.z + r * Math.cos(th));
      uv.push(u, v);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i, b = a + segs + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
};

/** An open drum of radius r round centre `c` from y0 up to y1, u round as the ring's, v up. */
Environment.drumGeometry = function (c, r, y0, y1) {
  const segs = ENV_SEGMENTS;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= 1; j++) {
    const y = j ? y1 : y0;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs, th = u * Math.PI * 2;
      pos.push(c.x + r * Math.sin(th), y, c.z + r * Math.cos(th));
      uv.push(u, j);
    }
  }
  for (let i = 0; i < segs; i++) idx.push(i, i + 1, i + segs + 1, i + 1, i + segs + 2, i + segs + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
};

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
