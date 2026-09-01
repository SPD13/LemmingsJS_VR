"use strict";
/**
 * Piece-tagging editor (plan §6): the authoring tool for depth profiles.
 *
 * Toggle with 'e' (pauses the sim). Click a terrain piece in the 3D view:
 * the click is hit-tested against the level's placed-piece list in composite
 * order, honoring per-pixel transparency, upside-down placement and erase
 * pieces — so what you click is what you see. Every placement of that piece
 * id highlights; assigning a class (backdrop / terrain / relief / overlay,
 * or back to auto) writes a byId override into the in-memory profile,
 * rebuilds the depth buffer and re-meshes only the chunks that changed.
 * Export downloads the profile JSON for 3d/profiles/.
 *
 * A tag applies to a piece ID, so it covers every placement in every level
 * of the same tileset — tag once, fixed everywhere.
 */

class PieceEditor {
  /** session: the app's per-level session object (mutates session.profile). */
  constructor(session, profileUrl, timer) {
    this.s = session;
    this.profileUrl = profileUrl;
    this.timer = timer;
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
      classBtns: Array.from(document.querySelectorAll("#hud-editor [data-class]")),
      autoBtn: document.getElementById("ed-auto"),
      embossBtn: document.getElementById("ed-emboss"),
      invertBtn: document.getElementById("ed-invert"),
      resetBtn: document.getElementById("ed-reset"),
      saveBtn: document.getElementById("ed-save"),
      exportBtn: document.getElementById("ed-export"),
      msg: document.getElementById("ed-msg"),
    };
    this._onClassBtn = (e) => this.setClass(e.target.dataset.class);
    this._onAutoBtn = () => this.setClass(null);
    this._onEmbossBtn = () => this.toggleEmboss();
    this._onInvertBtn = () => this.toggleEmbossInvert();
    this._onResetBtn = () => this.resetAll();
    this._onSaveBtn = () => this.save();
    this._onExportBtn = () => this.export();
    this.dom.classBtns.forEach((b) => b.addEventListener("click", this._onClassBtn));
    this.dom.autoBtn.addEventListener("click", this._onAutoBtn);
    this.dom.embossBtn.addEventListener("click", this._onEmbossBtn);
    this.dom.invertBtn.addEventListener("click", this._onInvertBtn);
    this.dom.resetBtn.addEventListener("click", this._onResetBtn);
    this.dom.saveBtn.addEventListener("click", this._onSaveBtn);
    this.dom.exportBtn.addEventListener("click", this._onExportBtn);
  }

  _msg(text, ok) {
    this.dom.msg.textContent = text;
    this.dom.msg.className = ok ? "ok" : "err";
  }

  get _hasPieceData() {
    return !!(this.s.groundData && this.s.groundData.lr &&
      Array.isArray(this.s.groundData.lr.terrains));
  }

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
    return this.s.groundData.lr.terrains.filter(
      (p) => p.id === id && !p.drawProperties.isErase);
  }

  _rebuildHighlights() {
    while (this.highlightGroup.children.length) {
      this.highlightGroup.remove(this.highlightGroup.children[0]);
    }
    if (this.selectedId == null) return;
    const src = this.s.groundData.terraImages[this.selectedId];
    if (!src) return;
    for (const piece of this._placements(this.selectedId)) {
      const m = new THREE.Mesh(this._highlightGeom, this._highlightMat);
      m.scale.set(src.width, src.height, 1);
      m.position.set(piece.x + src.width / 2, piece.y + src.height / 2, 28);
      m.renderOrder = 10;
      this.highlightGroup.add(m);
    }
  }

  _override(id) {
    const p = this.s.profile;
    return (p && p.terrain && p.terrain.byId && p.terrain.byId[id]) || null;
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

  /** name = "backdrop"|"terrain"|"relief"|"overlay", or null for auto. */
  setClass(name) {
    if (this.selectedId == null) return;
    if (!this.s.profile) this.s.profile = {};
    const p = this.s.profile;
    if (!p.terrain) p.terrain = { default: "terrain", byId: {} };
    if (!p.terrain.byId) p.terrain.byId = {};
    if (name) p.terrain.byId[this.selectedId] = name;
    else delete p.terrain.byId[this.selectedId];
    DepthProfiles._cache.set(this.profileUrl, p); // survives level reloads
    this._applyProfile();
    this._renderInfo();
  }

  _setEmboss(value) {
    if (!this.s.profile) this.s.profile = {};
    const p = this.s.profile;
    if (!p.emboss) p.emboss = { byId: {} };
    if (!p.emboss.byId) p.emboss.byId = {};
    p.emboss.byId[this.selectedId] = value;
    DepthProfiles._cache.set(this.profileUrl, p);
    if (this.s.rebuildRelief) this.s.rebuildRelief();
    this._renderInfo();
  }

  /** Turn colour-keyed 3D relief on/off for the selected piece. */
  toggleEmboss() {
    if (this.selectedId == null) return;
    const on = embossEnabledFor(this.selectedId, this.s.profile);
    // turning it back on keeps whichever direction was in use
    this._setEmboss(on ? false
      : (embossInvertedFor(this.selectedId, this.s.profile) ? "invert" : true));
  }

  /** Swap which shades are raised: lighter (default) or darker (inverted). */
  toggleEmbossInvert() {
    if (this.selectedId == null) return;
    const inverted = embossInvertedFor(this.selectedId, this.s.profile);
    this._setEmboss(inverted ? true : "invert"); // also enables the effect
  }

  cycleClass() {
    if (this.selectedId == null) return;
    const order = ["terrain", "relief", "backdrop", "overlay", null];
    const cur = this._override(this.selectedId);
    this.setClass(order[(order.indexOf(cur) + 1) % order.length]);
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

  _renderInfo() {
    const btnsOn = this.selectedId != null;
    this.dom.classBtns.forEach((b) => {
      b.disabled = !btnsOn;
      b.classList.toggle("active",
        btnsOn && this._override(this.selectedId) === b.dataset.class);
    });
    this.dom.autoBtn.disabled = !btnsOn;
    this.dom.autoBtn.classList.toggle("active",
      btnsOn && !this._override(this.selectedId));
    this.dom.embossBtn.disabled = !btnsOn;
    this.dom.embossBtn.classList.toggle("active",
      btnsOn && embossEnabledFor(this.selectedId, this.s.profile));
    this.dom.invertBtn.disabled = !btnsOn;
    this.dom.invertBtn.classList.toggle("active",
      btnsOn && embossInvertedFor(this.selectedId, this.s.profile));
    if (!this._hasPieceData) {
      this.dom.info.textContent = "no piece data for this level (special level)";
      return;
    }
    if (this.selectedId == null) {
      this.dom.info.textContent = "click a terrain piece to tag it";
      return;
    }
    const n = this._placements(this.selectedId).length;
    const override = this._override(this.selectedId);
    this.dom.info.textContent =
      "piece " + this.selectedId + " · " + n + " placement" + (n === 1 ? "" : "s") +
      " · " + (override ? "tagged: " + override
                        : "auto: " + this._autoClasses(this.selectedId).join("/")) +
      " · 3D shade " + (embossEnabledFor(this.selectedId, this.s.profile)
        ? (embossInvertedFor(this.selectedId, this.s.profile)
            ? "on (dark raised)" : "on (light raised)")
        : "off");
  }

  /** POST the profile to the launcher server, which writes 3d/profiles/. */
  async save() {
    const profile = this.s.profile || { terrain: { default: "terrain", byId: {} } };
    try {
      const res = await fetch(this.profileUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile, null, 2),
      });
      // a pre-endpoint server answers POST like a GET (200 + file contents),
      // which used to read as a false "saved"; require the write receipt
      const receipt = res.ok ? await res.json().catch(() => null) : null;
      if (!receipt || receipt.ok !== true) {
        throw new Error("no write receipt");
      }
      // belt and braces: read the file back and confirm our tags are in it
      const check = await fetch(this.profileUrl, { cache: "no-store" }).then((r) => r.json());
      const want = JSON.stringify((profile.terrain && profile.terrain.byId) || {});
      const got = JSON.stringify((check.terrain && check.terrain.byId) || {});
      if (want !== got) throw new Error("read-back mismatch");
      this._msg("saved — " + this.profileUrl + " loads automatically now", true);
    } catch (e) {
      this._msg("NOT saved — restart the launcher server (or use export JSON)", false);
    }
  }

  /** Clear every tag for this tileset (in memory; press save to persist). */
  resetAll() {
    if (!this.s.profile) this.s.profile = {};
    if (!this.s.profile.terrain) this.s.profile.terrain = { default: "terrain" };
    this.s.profile.terrain.byId = {};
    DepthProfiles._cache.set(this.profileUrl, this.s.profile);
    this._applyProfile();
    this._renderInfo();
    this._msg("all tags reset to default (not saved yet)", true);
  }

  export() {
    const profile = this.s.profile || { terrain: { default: "terrain", byId: {} } };
    const json = JSON.stringify(profile, null, 2) + "\n";
    console.log("depth profile — save as 3d/" + this.profileUrl + ":\n" + json);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = this.profileUrl.split("/").pop();
    a.click();
    URL.revokeObjectURL(a.href);
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
    this.dom.panel.hidden = true;
  }
}
