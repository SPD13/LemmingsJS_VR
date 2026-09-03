"use strict";
/**
 * Piece-tagging editor (plan §6): the authoring tool for depth profiles.
 *
 * Toggle with 'e' (pauses the sim). Click a terrain piece in the 3D view:
 * the click is hit-tested against the level's placed-piece list in composite
 * order, honoring per-pixel transparency, upside-down placement and erase
 * pieces — so what you click is what you see. Every placement of that piece
 * id highlights; assigning a class (backdrop / terrain / relief / overlay,
 * or back to auto) writes the tag into the profile file of the piece's own
 * sprite gallery (profile-store.js), rebuilds the depth buffer and re-meshes
 * only the chunks that changed. Save posts every changed file to the
 * launcher; export downloads them for 3d/profiles/.
 *
 * A tag belongs to the sprite, so it covers every placement in every level
 * that draws it — tag once, fixed everywhere. The galleries page
 * (galleries.html) tags the same files sprite by sprite.
 */

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

    this.highlightGroup = new THREE.Group();
    this.highlightGroup.visible = false;
    session.worldGroup.add(this.highlightGroup);
    this._highlightGeom = new THREE.PlaneGeometry(1, 1);
    this._highlightMat = new THREE.MeshBasicMaterial({
      color: 0xffd866, transparent: true, opacity: 0.32,
      depthTest: false, side: THREE.DoubleSide,
    });

    this.dom = {
      panel: document.getElementById("hud-editor"),
      info: document.getElementById("ed-info"),
      files: document.getElementById("ed-files"),
      classBtns: Array.from(document.querySelectorAll("#hud-editor [data-class]")),
      autoBtn: document.getElementById("ed-auto"),
      embossBtn: document.getElementById("ed-emboss"),
      invertBtn: document.getElementById("ed-invert"),
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
    this._onResetBtn = () => this.resetAll();
    this._onSaveBtn = () => this.save();
    this._onExportBtn = () => this.export();
    this._onGalleriesBtn = () => this.leaveTo(this.galleriesUrl());
    this.dom.classBtns.forEach((b) => b.addEventListener("click", this._onClassBtn));
    this.dom.autoBtn.addEventListener("click", this._onAutoBtn);
    this.dom.embossBtn.addEventListener("click", this._onEmbossBtn);
    this.dom.invertBtn.addEventListener("click", this._onInvertBtn);
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
    this._renderInfo();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this._wasRunning) this.timer.continue();
    this.dom.panel.hidden = true;
    this.highlightGroup.visible = false;
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

  /** Click from the app's pointer handler while edit mode is on. */
  handleSimClick(px, py) {
    const piece = this.pieceAt(px, py);
    this.select(piece ? piece.id : null);
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

  _rebuildHighlights() {
    while (this.highlightGroup.children.length) {
      this.highlightGroup.remove(this.highlightGroup.children[0]);
    }
    if (this.selectedId == null) return;
    const src = this.s.groundData.terraImages[this.selectedId];
    if (!src) return;
    for (const piece of this._placements(this.selectedId)) {
      const img = this.s.groundData.terraImages[piece.id] || src;
      const m = new THREE.Mesh(this._highlightGeom, this._highlightMat);
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
    this._renderInfo();
  }

  _setEmboss(value) {
    const url = this._urlFor(this.selectedId);
    if (!url) return;
    this.files.setEmboss(this._key(this.selectedId), value, url);
    this._refreshProfile();
    if (this.s.rebuildRelief) this.s.rebuildRelief();
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
    if (this.selectedId == null || !this._hasPieceData) return "galleries.html";
    const key = this._key(this.selectedId);
    const gallery = ProfileStore.galleryForKey(key, this.s.profileUrl ? ProfileStore.galleryForUrl(this.s.profileUrl) : null);
    if (!gallery) return "galleries.html";
    return "galleries.html?gallery=" + encodeURIComponent(gallery) + "&piece=" + encodeURIComponent(key);
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
      const tags = Object.keys(profile.terrain.byId).length + Object.keys(profile.emboss.byId).length;
      const line = document.createElement("div");
      line.className = "ed-file";
      const a = document.createElement("a");
      a.href = "galleries.html?gallery=" + encodeURIComponent(gallery);
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
    this._renderInfo();
    this._msg("all tags reset in " + urls.map(ProfileStore.fileName).join(", ") + " (not saved yet)", true);
  }

  /** Download the changed files, or every file of the level when nothing is pending. */
  export() {
    const dirty = this.files.dirtyUrls();
    const urls = dirty.length ? dirty : this._urls;
    if (!urls.length) { this._msg("no profile file for this level", false); return; }
    for (const url of urls) {
      console.log("depth profile — save as 3d/" + url + ":\n" + this.files.exportJson(url));
      this.files.download(url);
    }
    this._msg("exported " + urls.map(ProfileStore.fileName).join(", ") + " — save into 3d/profiles/", true);
  }

  dispose() {
    this.disable();
    this.highlightGroup.parent.remove(this.highlightGroup);
    this._highlightGeom.dispose();
    this._highlightMat.dispose();
    this.dom.classBtns.forEach((b) => b.removeEventListener("click", this._onClassBtn));
    this.dom.autoBtn.removeEventListener("click", this._onAutoBtn);
    this.dom.embossBtn.removeEventListener("click", this._onEmbossBtn);
    this.dom.invertBtn.removeEventListener("click", this._onInvertBtn);
    this.dom.resetBtn.removeEventListener("click", this._onResetBtn);
    this.dom.saveBtn.removeEventListener("click", this._onSaveBtn);
    this.dom.exportBtn.removeEventListener("click", this._onExportBtn);
    if (this.dom.galleriesBtn) this.dom.galleriesBtn.removeEventListener("click", this._onGalleriesBtn);
    this.dom.panel.hidden = true;
  }
}
