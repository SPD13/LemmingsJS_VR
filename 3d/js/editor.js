"use strict";
/**
 * Piece-tagging editor (plan §6): the authoring tool for depth profiles.
 *
 * Toggle with 'e' (pauses the sim). Click a terrain piece in the 3D view: the
 * ray is marched through the extrusion (surfacePick) and the first column it
 * enters names the piece, read off the composite's own piece map — so what is
 * tagged is the pixel being looked at, whichever face of the diorama it sits
 * on and however far the perspective has slid it from the level's flat plane.
 * Every placement of that piece id lights up as a translucent yellow *volume*
 * standing where the extrusion put it, the piece's own shape rather than a
 * card floating over it; assigning a class (backdrop / terrain / relief / overlay,
 * or back to auto) writes the tag into the profile file of the piece's own
 * sprite gallery (profile-store.js), rebuilds the depth buffer and re-meshes
 * only the chunks that changed. Save posts every changed file to the
 * launcher; export downloads them for 3d/profiles/.
 *
 * A tag belongs to the sprite, so it covers every placement in every level
 * that draws it — tag once, fixed everywhere. The galleries page
 * (galleries.html) tags the same files sprite by sprite.
 */

// The tagging highlight: the selected piece drawn as a translucent yellow
// volume standing where the extrusion put it.
const TAG_HILITE_COLOR = 0xffd866;
// How far the volume stands proud of the terrain it wraps, in game pixels: a
// whole one, so the highlight is a lip toward the eye rather than a skin
// fighting the surface for its pixels, and reads from any angle.
const TAG_HILITE_LIFT = 1;
// Picking through the extrusion: how far the ray steps between samples - under
// a pixel, so a one-pixel column cannot be stepped over.
const TAG_PICK_STEP = 0.4;

class PieceEditor {
  /**
   * session: the app's per-level session object (session.profile is the
   * merged view of session.profileUrls; session.profileUrl the DOS
   * tileset's file, null for a Lemmix level); files: the page's ProfileFiles;
   * opts.confirm(title, verb, action, body) asks before leaving the page
   * with unsaved tags.
   */
  constructor(session, files, timer, opts) {
    this.s = session;
    this.files = files;
    this.timer = timer;
    this.confirm = (opts && opts.confirm) || null;
    this.enabled = false;
    this.selectedId = null;
    this._wasRunning = false;

    this._flat = false; // the 2D view: nothing is extruded, so nothing to stand up

    // The flat footprint the 2D view gets, on the level's own plane...
    this.highlightGroup = new THREE.Group();
    this.highlightGroup.visible = false;
    session.worldGroup.add(this.highlightGroup);
    // ...and the diorama's volume, hung off the terrain chunks so the change
    // of view squeezes it with them and the flat view hides it with them.
    this.volumeGroup = new THREE.Group();
    this.volumeGroup.visible = false;
    (session.terrain ? session.terrain.chunkGroup : session.worldGroup).add(this.volumeGroup);
    this._volumeGeom = null; // both are rebuilt whenever the selection or the
    this._flatGeom = null;   // depth under it changes
    this._highlightMat = new THREE.MeshBasicMaterial({
      color: TAG_HILITE_COLOR, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false,
      // its walls sit exactly on the terrain's own: nudged toward the eye so
      // the two cannot fight over the pixel
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    // the same volume once more, faintly and through everything, so a piece
    // buried behind another still shows where it is
    this._ghostMat = new THREE.MeshBasicMaterial({
      color: TAG_HILITE_COLOR, transparent: true, opacity: 0.15,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false,
    });
    // and the 2D view's wash over the picture, where there is no volume
    this._flatMat = new THREE.MeshBasicMaterial({
      color: TAG_HILITE_COLOR, transparent: true, opacity: 0.45,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false,
    });

    this.dom = {
      panel: document.getElementById("hud-editor"),
      info: document.getElementById("ed-info"),
      files: document.getElementById("ed-files"),
      classBtns: Array.from(document.querySelectorAll("#hud-editor [data-class]")),
      autoBtn: document.getElementById("ed-auto"),
      embossBtn: document.getElementById("ed-emboss"),
      invertBtn: document.getElementById("ed-invert"),
      blendBtn: document.getElementById("ed-blend"),
      colorBlendBtn: document.getElementById("ed-colorblend"),
      resetBtn: document.getElementById("ed-reset"),
      saveBtn: document.getElementById("ed-save"),
      exportBtn: document.getElementById("ed-export"),
      galleriesBtn: document.getElementById("ed-galleries"),
      msg: document.getElementById("ed-msg"),
    };
    this._onClassBtn = (e) => this.setClass(e.target.dataset.class);
    this._onAutoBtn = () => this.setClass(null);
    this._onEmbossBtn = () => this.toggleEmboss();
    this._onInvertBtn = () => this.toggleEmbossInvert();
    this._onBlendBtn = () => this.toggleBlend();
    this._onColorBlendBtn = () => this.toggleColorBlend();
    this._onResetBtn = () => this.resetAll();
    this._onSaveBtn = () => this.save();
    this._onExportBtn = () => this.export();
    this._onGalleriesBtn = () => this.leaveTo(this.galleriesUrl());
    this.dom.classBtns.forEach((b) => b.addEventListener("click", this._onClassBtn));
    this.dom.autoBtn.addEventListener("click", this._onAutoBtn);
    this.dom.embossBtn.addEventListener("click", this._onEmbossBtn);
    this.dom.invertBtn.addEventListener("click", this._onInvertBtn);
    this.dom.blendBtn.addEventListener("click", this._onBlendBtn);
    this.dom.colorBlendBtn.addEventListener("click", this._onColorBlendBtn);
    this.dom.resetBtn.addEventListener("click", this._onResetBtn);
    this.dom.saveBtn.addEventListener("click", this._onSaveBtn);
    this.dom.exportBtn.addEventListener("click", this._onExportBtn);
    if (this.dom.galleriesBtn) this.dom.galleriesBtn.addEventListener("click", this._onGalleriesBtn);
  }

  _msg(text, ok) {
    this.dom.msg.textContent = text;
    this.dom.msg.className = ok ? "ok" : "err";
  }

  get _hasPieceData() {
    return !!(this.s.groundData && this.s.groundData.lr &&
      Array.isArray(this.s.groundData.lr.terrains));
  }

  /** The files this level's pieces are tagged in. */
  get _urls() { return this.s.profileUrls || []; }

  toggle() { this.enabled ? this.disable() : this.enable(); }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this._wasRunning = this.timer.isRunning();
    if (this._wasRunning) this.timer.suspend();
    this.dom.panel.hidden = false;
    this.highlightGroup.visible = true;
    this.volumeGroup.visible = true;
    this._renderInfo();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this._wasRunning) this.timer.continue();
    this.dom.panel.hidden = true;
    this.highlightGroup.visible = false;
    this.volumeGroup.visible = false;
  }

  /** Topmost opaque piece at sim coords, honoring composite order + erase. */
  pieceAt(px, py) {
    if (!this._hasPieceData) return null;
    const pieces = this.s.groundData.lr.terrains;
    const imgs = this.s.groundData.terraImages;
    let hit = null;
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const src = imgs[piece.id];
      if (!src) continue;
      const lx = px - piece.x, ly = py - piece.y;
      if (lx < 0 || lx >= src.width || ly < 0 || ly >= src.height) continue;
      const sy = piece.drawProperties.isUpsideDown ? (src.height - ly - 1) : ly;
      if ((src.frames[0][sy * src.width + lx] & 0x80) !== 0) continue; // transparent
      hit = piece.drawProperties.isErase ? null : piece; // last drawn wins
    }
    return hit;
  }

  /**
   * Which piece owns a pixel as the level is actually composited: the piece
   * map the depth pass already builds (depth.js buildPieceMap), which knows
   * about erase, no-overwrite and only-overwrite placements as well as
   * transparency. pieceAt above is the fallback for a level that has none.
   */
  pieceIdAt(px, py) {
    const t = this.s.terrain, map = this.s.pieceMap;
    if (map && t && px >= 0 && py >= 0 && px < t.w && py < t.h) {
      const id = map[py * t.w + px] - 1;
      return id >= 0 ? id : null;
    }
    const piece = this.pieceAt(px, py);
    return piece ? piece.id : null;
  }

  /**
   * The pixel whose *surface* a ray lands on.
   *
   * The diorama is extruded, so under a perspective camera the pixel seen at
   * a point on screen is not the one the flat pick plane behind it names: a
   * column standing proud of its neighbours covers them, and the wall it is
   * seen through from the side belongs to the column it rises from, not to
   * the floor beyond it. So the ray is marched through the depth buffer read
   * as a heightfield - every solid pixel a column from its class's back to
   * its front, relief included - and the first column it enters is the one
   * under the cursor, which is the one whose pixel the eye is looking at.
   *
   * `ray` is in world space; the walk happens in the world group's own space,
   * where x and y are sim coordinates and z is the extrusion depth. Returns
   * null when the ray passes the level by - clicking the sky drops the
   * selection rather than tagging whatever lies behind it.
   */
  surfacePick(ray) {
    const t = this.s.terrain;
    if (!t || !this.s.worldGroup) return null;
    const local = ray.clone().applyMatrix4(
      new THREE.Matrix4().copy(this.s.worldGroup.matrixWorld).invert());
    const o = local.origin, d = local.direction.normalize();

    // clip to the box the terrain lives in, so only the pixels the ray
    // actually crosses are walked
    let t0 = 0, t1 = Infinity;
    const clip = (p, dd, lo, hi) => {
      if (Math.abs(dd) < 1e-9) return p >= lo && p <= hi;
      let a = (lo - p) / dd, b = (hi - p) / dd;
      if (a > b) { const swap = a; a = b; b = swap; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      return t1 >= t0;
    };
    const zTop = DEPTH_BANDS.reduce((m, b) => Math.max(m, b ? b.front : 0), 0) +
      RELIEF_MAX;
    if (!clip(o.x, d.x, 0, t.w) || !clip(o.y, d.y, 0, t.h) ||
        !clip(o.z, d.z, 0, zTop)) return null;

    for (let s = Math.max(t0, 0); s <= t1; s += TAG_PICK_STEP) {
      const x = Math.floor(o.x + d.x * s), y = Math.floor(o.y + d.y * s);
      if (x < 0 || y < 0 || x >= t.w || y >= t.h) continue;
      const i = y * t.w + x;
      const cls = t.depth[i];
      if (cls === DepthClass.EMPTY) continue;
      const band = DEPTH_BANDS[cls];
      const z = o.z + d.z * s;
      if (z <= band.front + (t.relief ? t.relief[i] : 0) && z >= band.back) {
        return { x, y };
      }
    }
    return null;
  }

  /**
   * Click from the app's pointer handler while edit mode is on. The ray is
   * what picks in the diorama (surfacePick); the flat coordinates are what
   * the 2D view goes by, where there is no depth to see past.
   */
  handleSimClick(px, py, ray) {
    if (ray && !this._flat) {
      const surface = this.surfacePick(ray);
      this.select(surface ? this.pieceIdAt(surface.x, surface.y) : null);
      return;
    }
    this.select(this.pieceIdAt(px, py));
  }

  /** The 2D view is on or off: the volume gives way to a flat footprint. */
  setFlat(on) {
    on = !!on;
    if (this._flat === on) return;
    this._flat = on;
    this._rebuildHighlights();
  }

  select(pieceId) {
    this.selectedId = pieceId;
    this._rebuildHighlights();
    this._renderInfo();
  }

  _placements(id) {
    if (!this._hasPieceData) return [];
    const key = this._key(id);
    return this.s.groundData.lr.terrains.filter(
      (p) => (p.key != null ? p.key === key : p.id === id) && !p.drawProperties.isErase);
  }

  /** The ids tagged under the same key as `id` - what a tag really covers. */
  _idsForKey(id) {
    // terraImages is an array for a DOS tileset and a plain object for a
    // Lemmix style, so it is walked by its own keys either way
    const imgs = this.s.groundData ? this.s.groundData.terraImages : null;
    const key = this._key(id);
    const ids = new Set();
    for (const k of imgs ? Object.keys(imgs) : []) {
      const i = Number(k);
      if (imgs[i] && this._key(i) === key) ids.add(i);
    }
    return ids;
  }

  /**
   * The selected piece's pixels as the diorama actually stands, and how high
   * the highlight's front face stands over each of them; -1 everywhere else,
   * which is also what a pixel covered by a later piece, erased, or dug away
   * since gets. Null when the level has no piece map to read, or the piece is
   * nowhere on show.
   *
   * The front is *flat*: every pixel of a depth class is given the height of
   * the tallest column that class has here, so the face clears the relief the
   * 3D shade puts into the terrain under it rather than following it - a
   * highlight that rippled with those bumps would read as texture instead of
   * as a marker. A piece whose placements fall into different classes (the
   * flag defaults can do that) keeps one flat face per class, so a recessed
   * placement is not dragged up to the height of a proud one.
   */
  _footprint() {
    const t = this.s.terrain, map = this.s.pieceMap;
    if (!t || !map || map.length !== t.w * t.h) return null;
    const ids = this._idsForKey(this.selectedId);
    const cls = new Uint8Array(t.w * t.h);            // this tag's pixels, by class
    const tallest = new Float32Array(DEPTH_BANDS.length); // and their highest column
    let any = false;
    for (let i = 0; i < cls.length; i++) {
      const id = map[i] - 1;
      if (id < 0 || !ids.has(id)) continue;
      const c = t.depth[i];
      if (c === DepthClass.EMPTY) continue; // dug out from under the tag
      cls[i] = c;
      const front = DEPTH_BANDS[c].front + (t.relief ? t.relief[i] : 0);
      if (front > tallest[c]) tallest[c] = front;
      any = true;
    }
    if (!any) return null;
    const heights = new Float32Array(cls.length).fill(-1);
    for (let i = 0; i < cls.length; i++) {
      if (cls[i]) heights[i] = tallest[cls[i]] + TAG_HILITE_LIFT;
    }
    return heights;
  }

  /**
   * The footprint as geometry. With `flatZ` given it is the outline alone, one
   * quad per run on that plane (the 2D view). Without it, it is the volume:
   * the piece's shape extruded from the back of the slab up to the flat front
   * face _footprint worked out for each of its pixels. Only the faces that are
   * exposed are emitted - the front of each run, and a wall wherever the
   * neighbour's face is lower or the piece is not there at all, spanning just
   * the exposed part. So the highlight is the piece's own shape standing in
   * the diorama, not a card floating over it, and its inside faces do not pile
   * translucency onto themselves.
   */
  _footprintGeometry(heights, flatZ) {
    const t = this.s.terrain, w = t.w, h = t.h;
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? -1 : heights[y * w + x];
    const pos = [];
    const quad = (a, b, c, d) => pos.push(
      a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
      a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);

    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        const z = at(x, y);
        if (z < 0) { x++; continue; }
        let run = 1; // the pixels beside it under the same stretch of face
        while (at(x + run, y) === z) run++;
        const top = flatZ != null ? flatZ : z;
        quad([x, y, top], [x + run, y, top], [x + run, y + 1, top], [x, y + 1, top]);
        if (flatZ == null) {
          // the walls across the run, up and down, merged while the drop is
          // the same; then the two ends, where the run stops by definition
          for (const dy of [-1, 1]) {
            const wy = dy < 0 ? y : y + 1;
            let i = 0;
            while (i < run) {
              const n = at(x + i, y + dy);
              if (n >= z) { i++; continue; }
              let k = 1;
              while (i + k < run && at(x + i + k, y + dy) === n) k++;
              // between two faces of the piece the wall spans the drop
              // alone; onto open ground it goes the whole way down
              const base = n < 0 ? 0 : n;
              quad([x + i, wy, base], [x + i + k, wy, base],
                   [x + i + k, wy, top], [x + i, wy, top]);
              i += k;
            }
          }
          for (const dx of [-1, 1]) {
            const n = at(dx < 0 ? x - 1 : x + run, y);
            if (n >= z) continue;
            const wx = dx < 0 ? x : x + run;
            const base = n < 0 ? 0 : n;
            quad([wx, y, base], [wx, y + 1, base], [wx, y + 1, top], [wx, y, top]);
          }
        }
        x += run;
      }
    }
    if (!pos.length) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return geom;
  }

  _clearGroup(group) {
    while (group.children.length) group.remove(group.children[0]);
  }

  _rebuildHighlights() {
    this._clearGroup(this.highlightGroup);
    this._clearGroup(this.volumeGroup);
    if (this._volumeGeom) { this._volumeGeom.dispose(); this._volumeGeom = null; }
    if (this._flatGeom) { this._flatGeom.dispose(); this._flatGeom = null; }
    if (this.selectedId == null) return;
    const heights = this._footprint();
    if (!heights) { this._rebuildPlacementRects(); return; }
    if (this._flat) {
      this._flatGeom = this._footprintGeometry(heights, this.s.terrain.flatZ + 0.6);
      if (this._flatGeom) {
        const m = new THREE.Mesh(this._flatGeom, this._flatMat);
        m.renderOrder = 10;
        this.highlightGroup.add(m);
      }
      return;
    }
    this._volumeGeom = this._footprintGeometry(heights, null);
    if (!this._volumeGeom) return;
    for (const mat of [this._highlightMat, this._ghostMat]) {
      const m = new THREE.Mesh(this._volumeGeom, mat);
      m.renderOrder = mat === this._ghostMat ? 11 : 10;
      this.volumeGroup.add(m);
    }
  }

  /** No piece map (a special level): the placements as flat cards, as before. */
  _rebuildPlacementRects() {
    const src = this.s.groundData && this.s.groundData.terraImages[this.selectedId];
    if (!src) return;
    if (!this._rectGeom) this._rectGeom = new THREE.PlaneGeometry(1, 1);
    for (const piece of this._placements(this.selectedId)) {
      const img = this.s.groundData.terraImages[piece.id] || src;
      const m = new THREE.Mesh(this._rectGeom, this._flatMat);
      m.scale.set(img.width, img.height, 1);
      m.position.set(piece.x + img.width / 2, piece.y + img.height / 2, 28);
      m.renderOrder = 10;
      this.highlightGroup.add(m);
    }
  }

  /** What a piece id is tagged by: its name for Lemmix styles, the id itself for DOS tilesets. */
  _key(id) {
    const src = this.s.groundData && this.s.groundData.terraImages[id];
    return src && src.name != null ? src.name : id;
  }
  /** The file a piece's tag lives in: its style's, or the DOS tileset's. */
  _urlFor(id) {
    return ProfileStore.urlForKey(this._key(id), this.s.profileUrl);
  }
  _override(id) {
    return ProfileStore.classOf(this._key(id), this.s.profile);
  }

  /** The class(es) flag-defaults would give this id's placements. */
  _autoClasses(id) {
    const names = { 1: "backdrop", 2: "terrain", 3: "relief", 4: "overlay" };
    const set = new Set();
    for (const piece of this._placements(id)) {
      set.add(names[depthClassForPiece(piece, null)]);
    }
    return Array.from(set);
  }

  /** The merged view again after a change to one of the files. */
  _refreshProfile() {
    this.s.profile = this.files.merged(this._urls);
  }

  /** name = "backdrop"|"terrain"|"relief"|"overlay", or null for auto. */
  setClass(name) {
    if (this.selectedId == null) return;
    const url = this._urlFor(this.selectedId);
    if (!url) return;
    this.files.setClass(this._key(this.selectedId), name, url);
    this._refreshProfile();
    this._applyProfile();
    this._rebuildHighlights(); // the piece stands at a new height now
    this._renderInfo();
  }

  _setEmboss(value) {
    const url = this._urlFor(this.selectedId);
    if (!url) return;
    this.files.setEmboss(this._key(this.selectedId), value, url);
    this._refreshProfile();
    if (this.s.rebuildRelief) this.s.rebuildRelief();
    this._rebuildHighlights(); // relief changes the columns' heights
    this._renderInfo();
  }

  /** Turn colour-keyed 3D relief on/off for the selected piece. */
  toggleEmboss() {
    if (this.selectedId == null) return;
    this._setEmboss(ProfileStore.nextEmbossToggle(this._key(this.selectedId), this.s.profile));
  }

  /** Swap which shades are raised: lighter (default) or darker (inverted). */
  toggleEmbossInvert() {
    if (this.selectedId == null) return;
    this._setEmboss(ProfileStore.nextEmbossInvert(this._key(this.selectedId), this.s.profile));
  }

  /**
   * Turn surface blend on/off for the selected piece: only the colours down
   * the extrusion change, so the depth buffer is untouched and the blend map
   * alone is re-derived.
   */
  toggleBlend() {
    if (this.selectedId == null) return;
    const url = this._urlFor(this.selectedId);
    if (!url) return;
    const key = this._key(this.selectedId);
    this.files.setBlend(key, ProfileStore.nextBlendToggle(key, this.s.profile), url);
    this._refreshProfile();
    if (this.s.rebuildBlend) this.s.rebuildBlend();
    this._renderInfo();
  }

  /**
   * Turn colour blend on/off for the selected piece. Like surface blend it is
   * only a matter of colour, so the depth buffer stands and the colour map
   * alone is re-derived - though the master switch in the 3D effects drawer
   * can be holding the effect off whatever the tag says.
   */
  toggleColorBlend() {
    if (this.selectedId == null) return;
    const url = this._urlFor(this.selectedId);
    if (!url) return;
    const key = this._key(this.selectedId);
    this.files.setColorBlend(key, ProfileStore.nextColorBlendToggle(key, this.s.profile), url);
    this._refreshProfile();
    if (this.s.rebuildColorBlend) this.s.rebuildColorBlend();
    this._renderInfo();
  }

  cycleClass() {
    if (this.selectedId == null) return;
    this.setClass(ProfileStore.nextClass(this._override(this.selectedId)));
  }

  /** Rebuild the depth buffer and re-mesh only the chunks that changed. */
  _applyProfile() {
    const t = this.s.terrain;
    const next = buildDepthMap(this.s.level, this.s.groundData, this.s.profile);
    const old = t.depth;
    for (let y = 0; y < t.h; y++) {
      for (let x = 0; x < t.w; x++) {
        const i = y * t.w + x;
        if (old[i] === next[i]) continue;
        old[i] = next[i];
        const cx = Math.floor(x / TERRAIN_CHUNK), cy = Math.floor(y / TERRAIN_CHUNK);
        t.dirtyChunks.add(cy * t.chunksX + cx);
        const lx = x % TERRAIN_CHUNK, ly = y % TERRAIN_CHUNK;
        if (lx === 0 && cx > 0) t.dirtyChunks.add(cy * t.chunksX + cx - 1);
        if (lx === TERRAIN_CHUNK - 1 && cx < t.chunksX - 1) t.dirtyChunks.add(cy * t.chunksX + cx + 1);
        if (ly === 0 && cy > 0) t.dirtyChunks.add((cy - 1) * t.chunksX + cx);
        if (ly === TERRAIN_CHUNK - 1 && cy < t.chunksY - 1) t.dirtyChunks.add((cy + 1) * t.chunksX + cx);
      }
    }
    t.flushDirty(Infinity);
  }

  /** The galleries page, on the selected piece's gallery when there is one. */
  galleriesUrl() {
    if (this.selectedId == null || !this._hasPieceData) return Vfs.link("galleries.html");
    const key = this._key(this.selectedId);
    const gallery = ProfileStore.galleryForKey(key, this.s.profileUrl ? ProfileStore.galleryForUrl(this.s.profileUrl) : null);
    if (!gallery) return Vfs.link("galleries.html");
    return Vfs.link("galleries.html?gallery=" + encodeURIComponent(gallery) + "&piece=" + encodeURIComponent(key));
  }

  /** Go to another page, asking first when a file holds unsaved tags. */
  leaveTo(href) {
    const dirty = this.files.dirtyUrls();
    if (!dirty.length || !this.confirm) { window.location.href = href; return; }
    this.confirm("Leave with unsaved tags?", "leave",
      () => { window.location.href = href; },
      "Unsaved changes in " + dirty.map(ProfileStore.fileName).join(", ") +
      " are lost when this page is left. Save or export them first to keep them.");
  }

  /** The galleries this level's pieces come from: a link, an unsaved mark, a download each. */
  _renderFiles() {
    const box = this.dom.files;
    if (!box) return;
    box.textContent = "";
    const urls = this._urls;
    if (!urls.length) return;
    for (const url of urls) {
      const gallery = ProfileStore.galleryForUrl(url);
      const dirty = this.files.isDirty(url);
      const profile = this.files.get(url);
      const tags = Object.keys(profile.terrain.byId).length +
        Object.keys(profile.emboss.byId).length + Object.keys(profile.blend.byId).length +
        Object.keys(profile.colorBlend.byId).length;
      const line = document.createElement("div");
      line.className = "ed-file";
      const a = document.createElement("a");
      a.href = Vfs.link("galleries.html?gallery=" + encodeURIComponent(gallery));
      a.textContent = gallery.startsWith("nx:") ? gallery.slice(3) : gallery;
      a.title = "open this gallery (" + ProfileStore.fileName(url) + ")";
      a.addEventListener("click", (e) => { e.preventDefault(); this.leaveTo(a.href); });
      line.appendChild(a);
      if (dirty) {
        const m = document.createElement("span");
        m.className = "ed-dirty";
        m.textContent = "● unsaved";
        m.title = "changed since it was last saved";
        line.appendChild(m);
      }
      const c = document.createElement("span");
      c.className = "ed-count";
      c.textContent = tags + (tags === 1 ? " tag" : " tags") + (this.files.exists(url) ? "" : " · no file yet");
      line.appendChild(c);
      const dl = document.createElement("a");
      dl.className = "ed-dl";
      dl.href = "#";
      dl.textContent = "⤓ json";
      dl.title = "download " + ProfileStore.fileName(url);
      dl.addEventListener("click", (e) => { e.preventDefault(); this.files.download(url); });
      line.appendChild(dl);
      box.appendChild(line);
    }
  }

  _renderInfo() {
    this._renderFiles();
    const selected = this.selectedId != null;
    const key = selected ? this._key(this.selectedId) : null;
    renderTagButtons(this.dom, key, this.s.profile, selected);
    if (this.dom.galleriesBtn) {
      this.dom.galleriesBtn.textContent = selected ? "this piece in its gallery" : "galleries";
    }
    if (!this._hasPieceData) {
      this.dom.info.textContent = "no piece data for this level (special level)";
      return;
    }
    if (!selected) {
      const dirty = this.files.dirtyUrls().length;
      this.dom.info.textContent = "click a terrain piece to tag it" +
        (dirty ? " · " + dirty + " file" + (dirty === 1 ? "" : "s") + " with unsaved changes" : "");
      return;
    }
    const n = this._placements(this.selectedId).length;
    const override = this._override(this.selectedId);
    const url = this._urlFor(this.selectedId);
    this.dom.info.textContent =
      "piece " + key + " · " + n + " placement" + (n === 1 ? "" : "s") +
      " · " + (override ? "tagged: " + override
                        : "auto: " + this._autoClasses(this.selectedId).join("/")) +
      " · 3D shade " + (embossEnabledFor(key, this.s.profile)
        ? (embossInvertedFor(key, this.s.profile)
            ? "on (dark raised)" : "on (light raised)")
        : "off") +
      " · surface blend " + (surfaceBlendFor(key, this.s.profile) ? "on" : "off") +
      " · colour blend " + (colorBlendFor(key, this.s.profile) ? "on" : "off") +
      (url ? " · file " + ProfileStore.fileName(url) + (this.files.isDirty(url) ? " (unsaved)" : "") : "");
  }

  /** POST every changed file to the launcher server, which writes 3d/profiles/. */
  async save() {
    const dirty = this.files.dirtyUrls();
    if (!dirty.length) { this._msg("nothing to save", true); return; }
    const results = await this.files.saveDirty();
    const failed = results.filter((r) => !r.ok);
    const saved = results.filter((r) => r.ok).map((r) => ProfileStore.fileName(r.url));
    if (failed.length) {
      this._msg("NOT saved: " + failed.map((r) => ProfileStore.fileName(r.url)).join(", ") +
        " — restart the launcher server (or use export JSON)" +
        (saved.length ? " · saved " + saved.join(", ") : ""), false);
    } else {
      this._msg("saved " + saved.join(", ") + " — loads automatically now", true);
    }
    this._renderInfo();
  }

  /** Clear every tag of this level's files (in memory; press save to persist). */
  resetAll() {
    const urls = this._urls;
    if (!urls.length) return;
    for (const url of urls) this.files.resetAll(url);
    this._refreshProfile();
    this._applyProfile();
    if (this.s.rebuildRelief) this.s.rebuildRelief();
    if (this.s.rebuildBlend) this.s.rebuildBlend();
    if (this.s.rebuildColorBlend) this.s.rebuildColorBlend();
    this._rebuildHighlights();
    this._renderInfo();
    this._msg("all tags reset in " + urls.map(ProfileStore.fileName).join(", ") + " (not saved yet)", true);
  }

  /** Download the changed files, or every file of the level when nothing is pending. */
  export() {
    const dirty = this.files.dirtyUrls();
    const urls = dirty.length ? dirty : this._urls;
    if (!urls.length) { this._msg("no profile file for this level", false); return; }
    for (const url of urls) {
      console.log("depth profile — save as " + url + ":\n" + this.files.exportJson(url));
      this.files.download(url);
    }
    this._msg("exported " + urls.map(ProfileStore.fileName).join(", ") + " — save into 3d/profiles/", true);
  }

  dispose() {
    this.disable();
    this.highlightGroup.parent.remove(this.highlightGroup);
    if (this.volumeGroup.parent) this.volumeGroup.parent.remove(this.volumeGroup);
    if (this._volumeGeom) this._volumeGeom.dispose();
    if (this._flatGeom) this._flatGeom.dispose();
    if (this._rectGeom) this._rectGeom.dispose();
    this._highlightMat.dispose();
    this._ghostMat.dispose();
    this._flatMat.dispose();
    this.dom.classBtns.forEach((b) => b.removeEventListener("click", this._onClassBtn));
    this.dom.autoBtn.removeEventListener("click", this._onAutoBtn);
    this.dom.embossBtn.removeEventListener("click", this._onEmbossBtn);
    this.dom.invertBtn.removeEventListener("click", this._onInvertBtn);
    this.dom.blendBtn.removeEventListener("click", this._onBlendBtn);
    this.dom.colorBlendBtn.removeEventListener("click", this._onColorBlendBtn);
    this.dom.resetBtn.removeEventListener("click", this._onResetBtn);
    this.dom.saveBtn.removeEventListener("click", this._onSaveBtn);
    this.dom.exportBtn.removeEventListener("click", this._onExportBtn);
    if (this.dom.galleriesBtn) this.dom.galleriesBtn.removeEventListener("click", this._onGalleriesBtn);
    this.dom.panel.hidden = true;
  }
}
