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
    Environment.evictGallery(this._galleryKey(this.level.ctx) + "|" + this.mode);
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

  /** The gallery a level's environment belongs to: its theme style, or its DOS tileset. */
  _galleryKey(ctx) {
    if (ctx.engine === "lemmix") return "nx:" + (ctx.themeName || "default");
    const gd = ctx.groundData, set = gd && gd.lr && gd.lr.graphicSet1 != null ? gd.lr.graphicSet1 : "x";
    return "dos:" + (ctx.pack || "game") + "-g" + set;
  }

  async _build() {
    const token = ++this._token;
    const { ctx, styles } = this.level;
    const t0 = performance.now();
    const stats = { mode: this.mode, ms: {} };
    const stale = () => token !== this._token;
    const set = { textures: [], gallery: null, wallpaper: null, source: "collage" };
    this.set = set;
    const key = this._galleryKey(ctx) + "|" + this.mode;
    stats.gallery = key;
    // the gallery's pictures, built once for every level of the style and kept
    let g = Environment.galleries.get(key);
    stats.cached = !!g;
    if (!g) {
      g = { key, mode: this.mode, textures: new Map(), props: [], palette: null, fog: null, source: "collage", room: null, done: false, ready: null };
      Environment.galleries.set(key, g);
      Environment.evictGalleries(3);
      g.ready = this._buildGallery(g, ctx, styles, token);
    }
    set.gallery = g;
    // the level's own part: its backdrop behind the slab
    set.wallpaper = await this._wallpaper(ctx);
    if (stale()) return;
    if (g.palette) { this._applyScene(); this._applyBackdrop(); }
    // whatever the gallery has so far, then the rest as it comes
    for (const [name, tex] of g.textures) this._applyTexture(name, tex);
    if (g.done) this._applyProps(g.props);
    else {
      try { await g.ready; } catch (e) { console.warn("[env] gallery:", e); }
      if (stale()) return;
      for (const [name, tex] of g.textures) this._applyTexture(name, tex);
      this._applyProps(g.props);
    }
    this._applyScene();
    this._applyBackdrop();
    set.source = g.source;
    stats.paletteSource = g.palette && g.palette.source;
    stats.collageMode = g.collageMode;
    Object.assign(stats.ms, g.ms || {});
    stats.totalMs = Math.round(performance.now() - t0);
    this.stats = stats;
  }

  /**
   * A gallery's pictures: the whole style's pieces (or the whole DOS
   * tileset's) laid round rings of the canonical size, the palette and
   * the fog from them, the standing pieces between the rings - built off
   * the critical path, a picture per frame, the textures kept until the
   * gallery is evicted. `token` is the level's: the pictures go up on the
   * planes as they come while that level is still the one shown.
   */
  async _buildGallery(g, ctx, styles, token) {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const live = () => token === this._token;
    const ms = g.ms = {};
    let t = performance.now();
    const gctx = await this._galleryContext(ctx, styles);
    ms.pieces = Math.round(performance.now() - t);
    const room = EnvGen.canonicalRoom(this.pxPerMetre);
    g.room = room;
    const palette = EnvGen.derivePalette(gctx);
    g.palette = palette;
    g.wallpaper = await this._galleryWallpaper(gctx, styles);
    const files = await this._files(gctx, room);
    if (files) g.source = "file";
    const opts = { room, palette, wallpaper: g.wallpaper };
    const full = g.mode === "full";
    // the near ring and the sky in gradients, in one go, so the room is there at once
    t = performance.now();
    const far = room.layers[room.layers.length - 1].i;
    const first = ["floor0", "wall0", "ceiling0", "wall" + far];
    for (const name of first) {
      const ambient = EnvGen.build(gctx, Object.assign({ full: false }, opts), [name]);
      g.fog = ambient.fog;
      g.textures.set(name, this._textureFor(name, ambient.planes[name]));
      if (live()) { this._applyTexture(name, g.textures.get(name)); this._applyScene(); this._applyBackdrop(); }
      await tick();
    }
    ms.ambient = Math.round(performance.now() - t);
    // then every picture, one per frame: the collage, or the shipped picture where there is one
    let pieces = null;
    for (const name of EnvGen.planeNames(room)) {
      if (name === "backdrop") continue;
      if (!full && first.includes(name)) continue;
      await tick();
      t = performance.now();
      let bitmap = files && files[name];
      if (!bitmap) {
        const built = EnvGen.build(gctx, Object.assign({ full, pieces }, opts), [name]);
        pieces = built.pieces;
        bitmap = built.planes[name];
        if (built.mode) g.collageMode = built.mode;
      }
      const old = g.textures.get(name);
      if (old) old.dispose();
      g.textures.set(name, this._textureFor(name, bitmap));
      if (live()) this._applyTexture(name, g.textures.get(name));
      ms[name] = Math.round(performance.now() - t);
    }
    if (full) {
      await tick();
      t = performance.now();
      const built = EnvGen.build(gctx, Object.assign({ full, pieces }, opts), ["props"]);
      g.props = (built.props || []).map((p) => Object.assign(p, { tex: this._textureFor("prop", p.bitmap) }));
      ms.props = Math.round(performance.now() - t);
    }
    g.done = true;
  }

  /**
   * What a gallery is drawn from: every terrain piece of the level's theme
   * style (the styles index says which, the style manager loads them), or
   * every image of its DOS tileset; a contact sheet of them stands in for
   * a level's picture, the palette being read from it. Without an index,
   * the level's own pieces.
   */
  async _galleryContext(ctx, styles) {
    const base = {
      engine: ctx.engine, levelId: "gallery:" + this._galleryKey(ctx), gallery: true,
      themeName: ctx.themeName, theme: ctx.theme, background: null, backgroundName: null,
      donors: null, profile: ctx.profile, lemmixObjects: null, dosPalette: ctx.dosPalette || null,
    };
    let images = [], pieces = null, groundData = null;
    if (ctx.engine === "lemmix" && styles && ctx.themeName) {
      try {
        const index = await styles.index();
        const entry = index && index.get(ctx.themeName);
        if (entry && entry.pieces && entry.pieces.length) {
          const steel = new Set(entry.steel || []);
          const metas = await Promise.all(entry.pieces.map((piece) => styles.terrain(ctx.themeName, piece).catch(() => null)));
          pieces = [];
          metas.forEach((meta, i) => {
            if (!meta || !meta.base || !meta.base.image) return;
            const image = meta.base.image, piece = entry.pieces[i];
            pieces.push({ x: 0, y: 0, drawn: { key: ctx.themeName + ":" + piece, variantKey: "", image, width: image.width, height: image.height, steel: meta.steel || steel.has(piece) } });
            images.push(image);
          });
        }
      } catch (e) { pieces = null; }
    }
    if (!pieces && ctx.engine === "lemmix") {
      pieces = ctx.lemmixPieces || [];
      images = pieces.filter((p) => p.drawn && p.drawn.image).map((p) => p.drawn.image);
    }
    if (ctx.engine !== "lemmix") {
      groundData = ctx.groundData;
      const list = (groundData && groundData.terraImages) || [];
      list.forEach((img) => { if (img && img.frames && img.frames[0]) images.push(EnvGen.dosBitmap(img)); });
    }
    const sheet = EnvGen.sheetOf(images);
    return Object.assign(base, {
      width: sheet.width, height: sheet.height, groundImage: sheet.data, groundMask: null,
      lemmixPieces: ctx.engine === "lemmix" ? pieces : null, groundData,
    });
  }

  /** The gallery's sky: the wallpaper its profile names, when it names one. */
  async _galleryWallpaper(gctx, styles) {
    const profile = gctx.profile || {}, env = profile.environment || {};
    if (!env.wallpaper || !styles || typeof Lemmix === "undefined" || !Lemmix.splitIdentifier) return null;
    const id = Lemmix.splitIdentifier(String(env.wallpaper).toLowerCase(), gctx.themeName || "default");
    let image = null;
    try { image = await styles.background(id.gs, id.piece); } catch (e) { image = null; }
    if (!image) return null;
    const key = id.gs + ":" + id.piece;
    return { image, key, kind: EnvGen.classifyBackground(image, key, profile) };
  }

  /** The standing pieces: a cut-out quad each, on its ring's floor, turned
   *  to the player - the gallery's pictures, the meshes the level's. */
  _applyProps(list) {
    this._clearProps();
    for (const p of list) {
      const mat = new THREE.MeshBasicMaterial({ map: p.tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
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

  // ------------------------------------------------------ every frame
  /**
   * The camera kept inside the room - within the last ring, between the
   * floor and the ceiling - on the desktop, where the orbit could otherwise
   * carry it out through the decor; and whatever stands between the eye
   * and the board hidden - a ring's wall the line from one to the other
   * crosses, a standing piece it passes through - until it no longer does.
   */
  update(camera, dioramaRoot, presenting) {
    if (!this.active || !this.level) return;
    // a session the room was never placed for (the placement hook missed,
    // a level loaded mid-session): placed now, round the head, at the
    // board's scale - a room left at the desktop's pixel scale is
    // kilometres wide, and all a headset sees of it is the fog
    if (presenting && (this._placed !== "xr" || Math.abs(this.root.scale.y - dioramaRoot.scale.y) > 1e-6)) {
      this.placeForXR(dioramaRoot, new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld));
    } else if (!presenting && this._placed !== "desktop") this.placeDesktop();
    const room = this.level.room, c = this._center || room.center;
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
    const last = room.layers[room.layers.length - 1];
    if (!presenting) {
      // inside the last ring, a step in from its wall, and between floor and ceiling
      const margin = 0.3 * this.pxPerMetre;
      const dx = eye.x - c.x, dz = eye.z - c.z, d = Math.hypot(dx, dz), rMax = last.rOut - margin;
      let moved = false;
      if (d > rMax) { eye.x = c.x + dx * rMax / d; eye.z = c.z + dz * rMax / d; moved = true; }
      const yLo = this._yFloor + margin * 0.5, yHi = this._yCeil - margin * 0.5;
      if (eye.y < yLo) { eye.y = yLo; moved = true; }
      if (eye.y > yHi) { eye.y = yHi; moved = true; }
      if (moved) camera.position.copy(this.root.localToWorld(eye.clone()));
    }
    // the board's middle, in the room's frame
    dioramaRoot.updateMatrixWorld(true);
    const board = new THREE.Vector3(room.W / 2, room.H / 2, 8).applyMatrix4(dioramaRoot.matrixWorld).applyMatrix4(inv);
    // a wall is in the way when the eye-to-board line crosses its drum
    const ex = eye.x - c.x, ez = eye.z - c.z, bx = board.x - c.x, bz = board.z - c.z;
    const dEye = Math.hypot(ex, ez), dBoard = Math.hypot(bx, bz);
    const vx = bx - ex, vz = bz - ez, len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ex * vx + ez * vz) / len2)) : 0;
    const dMin = Math.hypot(ex + vx * t, ez + vz * t); // the line's closest approach to the centre
    for (const l of room.layers) {
      const wall = this.planes["wall" + l.i];
      const blocks = (dEye > l.rOut || dBoard > l.rOut) && dMin < l.rOut;
      wall.visible = !blocks;
    }
    // a standing piece is in the way when the line passes through its quad
    const pad = 0.1 * this.pxPerMetre;
    const seg = new THREE.Vector3().subVectors(board, eye), segLen2 = seg.lengthSq();
    for (const mesh of this.props) {
      const p = mesh.position;
      const tp = segLen2 > 0 ? Math.max(0, Math.min(1, new THREE.Vector3().subVectors(p, eye).dot(seg) / segLen2)) : 0;
      const near = new THREE.Vector3().copy(eye).addScaledVector(seg, tp);
      const horiz = Math.hypot(near.x - p.x, near.z - p.z), vert = Math.abs(near.y - p.y);
      mesh.visible = !(tp > 0 && tp < 1 && horiz < mesh.scale.x / 2 + pad && vert < mesh.scale.y / 2 + pad);
    }
  }

  _clearProps() {
    for (const mesh of this.props) { this.root.remove(mesh); mesh.material.dispose(); }
    this.props = [];
  }

  /** Pictures made offline for a gallery's style (tools/env-gen.js), or null. */
  async _files(gctx, room) {
    if (gctx.engine !== "lemmix" || !gctx.themeName) return null;
    const dir = "3d/env/" + gctx.themeName + "/";
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
    if (!Environment.shipped || !Environment.shipped.has(gctx.themeName)) return null;
    // floor.png is the first ring's, floor-1.png the next one's, and so on
    const names = EnvGen.planeNames(room).filter((n) => n !== "backdrop");
    const files = await Promise.all(names.map((n) => load(Environment.fileFor(n))));
    const out = {};
    let any = false;
    names.forEach((n, i) => { if (files[i]) { out[n] = files[i]; any = true; } });
    return any ? out : null;
  }

  /** The level's own background, for the backdrop behind its slab. */
  async _wallpaper(ctx) {
    if (!ctx.background || !ctx.background.image) return null;
    const image = ctx.background.image;
    let key = String(ctx.backgroundName || "").toLowerCase();
    if (key && !key.includes(":")) key = ctx.themeName + ":" + key;
    return { image, key, kind: EnvGen.classifyBackground(image, key, ctx.profile || {}) };
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
    return tex;
  }

  /** A gallery's texture for a plane: row 0 is the rim for a floor or
   *  ceiling band, the top for a wall; every one wraps round. */
  _textureFor(name, bitmap) {
    const tex = this._texture(bitmap, true);
    tex.wrapS = THREE.RepeatWrapping;
    tex.userData.bitmap = bitmap;
    return tex;
  }

  /** A plane dressed with a gallery texture. */
  _applyTexture(name, tex) {
    const mesh = this.planes[name];
    if (!mesh || !tex) return;
    if (EnvGen.parsePlane(name).kind === "wall") this._wallRepeat(tex);
    mesh.material.map = tex;
    mesh.material.color.setHex(0xffffff);
    mesh.material.needsUpdate = true;
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
    const g = this.active && this.set && this.set.gallery;
    // past the last ring there is only the fog
    const hex = g && g.palette ? (g.fog !== null ? g.fog : EnvGen.scale(g.palette.dark, 0.35)) : this._sceneColor;
    if (this.scene.background && this.scene.background.isColor) this.scene.background.setHex(hex);
    else this.scene.background = new THREE.Color(hex);
  }

  /** The slab's backdrop: the page's colour, the gallery's, or the level's
   *  own wallpaper tiled 1:1 behind the terrain (a prop placed once). */
  _applyBackdrop() {
    const m = this.backdropMaterial;
    const old = m.map;
    m.map = null;
    if (old) old.dispose();
    const g = this.set && this.set.gallery;
    if (!this.active || !g || !g.palette) { m.color.setHex(ENV_BACKDROP_COLOR); m.needsUpdate = true; return; }
    const wp = this.set.wallpaper;
    if (wp && wp.kind === "wallpaper") {
      // the worldGroup is flipped in y, so row 0 (v = 0, no flip) lands at the top - the picture's own way up
      const tex = this._texture(wp.image, false);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(this.level.ctx.width / wp.image.width, this.level.ctx.height / wp.image.height);
      m.map = tex;
      m.color.setHex(0x999999); // behind the slab, tonally: the holes must still read as depth
    } else if (wp && wp.kind === "prop") {
      const prop = EnvGen.propBackdrop(this.level.ctx, wp.image, g.palette.bg);
      m.map = this._texture(prop.bitmap, false);
      m.color.setHex(0xb0b0b0);
    } else {
      m.color.setHex(EnvGen.scale(g.palette.bg, 0.7));
    }
    m.needsUpdate = true;
  }

  /** The level's part let go; the gallery's textures stay for the next level of the style. */
  _disposeSet() {
    this._token++;
    this._clearProps();
    if (!this.set) return;
    this.set = null;
    for (const mesh of Object.values(this.planes)) {
      mesh.material.map = null;
      mesh.material.color.setHex(ENV_SCENE_COLOR);
      mesh.material.needsUpdate = true;
    }
    if (this.backdropMaterial.map) { this.backdropMaterial.map.dispose(); this.backdropMaterial.map = null; this.backdropMaterial.needsUpdate = true; }
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
    console.log("[env] placed for the session: scale " + s.toFixed(4) + ", floor at local y " + Math.round(this._yFloor)
      + ", centre " + (this._center ? Math.round(this._center.x) + "," + Math.round(this._center.z) : "nominal"));
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

// The galleries built so far - one per style (or DOS tileset) and state,
// their textures kept - the last few, so a pack's levels cost nothing to
// move between.
Environment.galleries = new Map();
Environment.evictGallery = function (key) {
  const g = Environment.galleries.get(key);
  if (!g) return;
  Environment.galleries.delete(key);
  for (const tex of g.textures.values()) tex.dispose();
  for (const p of g.props) if (p.tex) p.tex.dispose();
};
Environment.evictGalleries = function (keep) {
  const keys = Array.from(Environment.galleries.keys());
  while (keys.length > keep) Environment.evictGallery(keys.shift());
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
