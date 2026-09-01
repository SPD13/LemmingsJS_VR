"use strict";
/**
 * The original skill panel, recycled: GameGui keeps rendering its pixel buffer
 * into a real Lemmings.DisplayImage (backed by our HeadlessStage instead of a
 * canvas Stage); we upload that buffer as a texture on a plane in the scene and
 * forward ray hits as the mouse events GameGui already listens for. Release
 * rate, skill selection, pause, nuke — all original logic, zero reimplementation.
 */

// skill-panel button geometry, in panel pixels (see GameGui.handleSkillMouseDown:
// buttons are 16px columns below y=15; drawSelection frames them 16x23)
const GUI_TILE_W = 16;
const GUI_TILE_TOP = 16;
const GUI_TILE_H = 23;
const GUI_TILE_POP = 5;    // how far a hovered button rises toward the player
const GUI_TILE_GROW = 1.08;
// GameGui draws the selection frame on the tile's shared right/bottom border
// lines (x = 16i+16, y = 39), so a raised copy must crop one pixel wider and
// taller or those two edges are left behind.
const GUI_CROP_H = GUI_TILE_H + 1;
const GUI_BUTTONS = 13;
// ...but the last button has no next tile - the status box sits there - so it
// crops to its own width and is not grown, or the raised copy would bite into
// the box beside it.
const GUI_LAST_BUTTON = GUI_BUTTONS - 1;
const GUI_CROP_W = (index) =>
  index >= GUI_LAST_BUTTON ? GUI_TILE_W : GUI_TILE_W + 1;
const GUI_GROW_FOR = (index) =>
  index >= GUI_LAST_BUTTON ? 1 : GUI_TILE_GROW;
const GUI_CROP_CX = (index) => index * GUI_TILE_W + GUI_CROP_W(index) / 2;
const GUI_CROP_CY = GUI_TILE_TOP + GUI_CROP_H / 2;
// The toolbar is an overlay: drawn without depth testing, after the world,
// so it is always visible and clickable no matter what it sits in front of.
// (Aiming marks - cursor, controller dots - are transparent and so still
// draw on top of it.)
const GUI_ORDER_PANEL = 50;
const GUI_ORDER_SOCKET = 51;  // covers the slot a raised button left behind
const GUI_ORDER_RELIEF = 52;
const GUI_ORDER_HOVER = 53;
const GUI_ORDER_HOVER_RELIEF = 54;

// The panel ships as one composited bitmap - the button pictures are baked
// into their tiles - but every tile's background is just the yellow/gray
// dither, so the artwork color-keys out and can be extruded. Black counts as
// artwork: it outlines the figures and *is* the pause/nuke/speed icons.
const GUI_BG_COLORS = new Set(["240,240,0", "128,128,128"]);
const GUI_ICON_BOTTOM = 39;
const GUI_ICON_DEPTH = 1;    // panel pixels of relief on the artwork
// Buttons 0..9 carry a count drawn at y17..25 (it changes as skills are
// spent, so it must stay flat); 10..12 have no digits and their art runs
// the full tile height.
const guiIconTop = (index) => (index <= 9 ? 26 : 17);
// The counts themselves (white digits on their black box) are raised too,
// but they change as skills are spent, so their geometry is rebuilt whenever
// the digit strip's pixels change.
const GUI_DIGIT_TOP = 17;
const GUI_DIGIT_BOTTOM = 26;
const GUI_DIGIT_BUTTONS = 10; // 0..9 carry counts; 10..12 do not
const GUI_DIGIT_COLOR = "255,255,255";
// The counters strip along the top ("Out 5  In 0%  Time 4-57") is drawn as
// green letters with light highlights; those highlights get raised 1px on a
// smoothed surface, so the lettering reads as embossed rather than printed.
const GUI_TEXT_BOTTOM = GUI_TILE_TOP; // the strip above the buttons
const GUI_TEXT_DEPTH = 1;
const GUI_TEXT_COLORS = new Set(["240,208,208", "255,255,255"]);

class GuiPanel {
  constructor(scene, game, resources) {
    this.dirty = true;
    this.stage = new HeadlessStage(() => { this.dirty = true; });
    this.display = new Lemmings.DisplayImage(this.stage);
    game.setGuiDisplay(this.display);

    this.canvas = document.createElement("canvas");
    this.ctx = null;
    this.texture = null;
    this.mesh = null;
    this.scene = scene;
    this.resources = resources;
    this.hoverTile = null;     // the raised copy of the hovered button
    this.hoverIndex = null;
    this.tileReliefs = null;   // extruded artwork, one mesh per button
    this.hoverRelief = null;   // the hovered tile's figure, raised with it
    this._tileGeoms = [];
  }

  /** 1 where a pixel belongs to a tile's lemming picture, 0 elsewhere. */
  _buildIconMask() {
    const W = this.canvas.width, H = this.canvas.height;
    const data = this.ctx.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    for (let x = 0; x < GUI_BUTTONS * GUI_TILE_W && x < W; x++) {
      const col = x % GUI_TILE_W;
      // skip tile edges: the selection frame is drawn there and moves
      if (col === 0 || col === GUI_TILE_W - 1) continue;
      const top = guiIconTop(Math.trunc(x / GUI_TILE_W));
      for (let y = top; y < GUI_ICON_BOTTOM; y++) {
        const i = (y * W + x) * 4;
        const key = data[i] + "," + data[i + 1] + "," + data[i + 2];
        if (!GUI_BG_COLORS.has(key)) mask[y * W + x] = 1;
      }
    }
    return mask;
  }

  /** Build the button relief once the panel canvas holds real pixels.
   *  One mesh per button: raising a button then means hiding its own relief
   *  and showing the raised copy, instead of leaving a ghost behind. */
  _buildRelief() {
    this.iconMask = this._buildIconMask();
    this.digitMask = this._buildDigitMask();
    this._digitSum = this._digitChecksum();

    // the panel texture again, unflipped: this geometry's UVs run y-down
    this.reliefTexture = this.resources.track(new THREE.CanvasTexture(this.canvas));
    this.reliefTexture.flipY = false;
    this.reliefTexture.magFilter = THREE.NearestFilter;
    this.reliefTexture.minFilter = THREE.NearestFilter;
    this.reliefMaterial = this.resources.track(new THREE.MeshBasicMaterial({
      map: this.reliefTexture, vertexColors: true, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false,
    }));
    this._emptyGeom = this.resources.track(new THREE.BufferGeometry());

    this.tileReliefs = [];
    for (let i = 0; i < GUI_BUTTONS; i++) {
      const mesh = new THREE.Mesh(this._tileGeometry(i) || this._emptyGeom,
        this.reliefMaterial);
      mesh.renderOrder = GUI_ORDER_RELIEF;
      this.scene.add(mesh);
      this.tileReliefs.push(mesh);
    }

    this.hoverRelief = new THREE.Mesh(this._emptyGeom, this.reliefMaterial);
    this.hoverRelief.visible = false;
    this.hoverRelief.renderOrder = GUI_ORDER_HOVER_RELIEF;
    this.scene.add(this.hoverRelief);

    // the empty slot behind a raised button, so the panel art underneath it
    // cannot show through beside the raised copy
    this.socket = new THREE.Mesh(
      this.resources.track(new THREE.PlaneGeometry(1, 1)),
      this.resources.track(new THREE.MeshBasicMaterial({
        color: 0x05070c, depthTest: false, depthWrite: false,
      })));
    this.socket.visible = false;
    this.socket.renderOrder = GUI_ORDER_SOCKET;
    this.scene.add(this.socket);

    this.textMesh = new THREE.Mesh(this._emptyGeom, this.reliefMaterial);
    this.textMesh.renderOrder = GUI_ORDER_RELIEF;
    this.scene.add(this.textMesh);
    this._refreshText();

    this._layoutRelief();
  }

  /** White digit pixels of the skill/release-rate counts. */
  _buildDigitMask() {
    const W = this.canvas.width, H = this.canvas.height;
    const data = this.ctx.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    for (let x = 0; x < GUI_DIGIT_BUTTONS * GUI_TILE_W && x < W; x++) {
      const col = x % GUI_TILE_W;
      if (col === 0 || col === GUI_TILE_W - 1) continue;
      for (let y = GUI_DIGIT_TOP; y < GUI_DIGIT_BOTTOM; y++) {
        const i = (y * W + x) * 4;
        const key = data[i] + "," + data[i + 1] + "," + data[i + 2];
        if (key === GUI_DIGIT_COLOR) mask[y * W + x] = 1;
      }
    }
    return mask;
  }

  /** Cheap fingerprint of the digit strip, to rebuild only on real change. */
  _digitChecksum() {
    const data = this.ctx.getImageData(
      0, GUI_DIGIT_TOP,
      Math.min(GUI_DIGIT_BUTTONS * GUI_TILE_W, this.canvas.width),
      GUI_DIGIT_BOTTOM - GUI_DIGIT_TOP).data;
    let h = 0;
    for (let i = 0; i < data.length; i += 4) h = (h * 31 + data[i]) | 0;
    return h;
  }

  /** Rebuild the buttons' relief when a count changes (the digits are part
   *  of each button's geometry). */
  _refreshDigits() {
    const sum = this._digitChecksum();
    if (sum === this._digitSum) return;
    this._digitSum = sum;
    this.digitMask = this._buildDigitMask();
    for (const geom of this._tileGeoms) {
      if (geom) geom.dispose();
    }
    this._tileGeoms.length = 0;
    for (let i = 0; i < this.tileReliefs.length; i++) {
      this.tileReliefs[i].geometry = this._tileGeometry(i) || this._emptyGeom;
    }
    if (this.hoverIndex != null) {
      this.hoverRelief.geometry =
        this._tileGeometry(this.hoverIndex) || this._emptyGeom;
    }
  }

  /** Light highlight pixels of the counters text. */
  _buildTextMask() {
    const W = this.canvas.width;
    const data = this.ctx.getImageData(0, 0, W, GUI_TEXT_BOTTOM).data;
    const mask = new Uint8Array(W * this.canvas.height);
    for (let y = 0; y < GUI_TEXT_BOTTOM; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const key = data[i] + "," + data[i + 1] + "," + data[i + 2];
        if (GUI_TEXT_COLORS.has(key)) mask[y * W + x] = 1;
      }
    }
    return mask;
  }

  _textChecksum() {
    const data = this.ctx.getImageData(0, 0, this.canvas.width, GUI_TEXT_BOTTOM).data;
    let h = 0;
    for (let i = 0; i < data.length; i += 4) h = (h * 31 + data[i]) | 0;
    return h;
  }

  /**
   * Smoothed 1px relief for the text: each quad corner rises with the number
   * of highlight pixels meeting there, so strokes are beveled into the panel
   * instead of standing on hard little walls (no walls are needed - the
   * surface slopes back down to the panel at the edge of a stroke).
   */
  _buildTextGeometry() {
    const W = this.canvas.width, H = this.canvas.height;
    const mask = this.textMask;
    const solid = (x, y) =>
      (x >= 0 && x < W && y >= 0 && y < H && mask[y * W + x]) ? 1 : 0;
    const cornerZ = (x, y) =>
      ((solid(x - 1, y - 1) + solid(x, y - 1) + solid(x - 1, y) + solid(x, y)) / 4) *
      GUI_TEXT_DEPTH;

    const positions = [], colors = [], uvs = [], indices = [];
    const push = (px, py, pz, u, v) => {
      positions.push(px, py, pz);
      // shade with height so the bevel reads even head-on
      const shade = 0.72 + 0.28 * (pz / GUI_TEXT_DEPTH);
      colors.push(shade, shade, shade);
      uvs.push(u, v);
    };
    for (let y = 0; y < GUI_TEXT_BOTTOM; y++) {
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        // a centre vertex at full depth fanned out to the averaged corners:
        // strokes reach the full 1px even where they are a single pixel wide,
        // while the corners bevel down to the panel around them
        const base = positions.length / 3;
        push(x + 0.5, y + 0.5, GUI_TEXT_DEPTH, (x + 0.5) / W, (y + 0.5) / H);
        push(x, y, cornerZ(x, y), x / W, y / H);
        push(x + 1, y, cornerZ(x + 1, y), (x + 1) / W, y / H);
        push(x + 1, y + 1, cornerZ(x + 1, y + 1), (x + 1) / W, (y + 1) / H);
        push(x, y + 1, cornerZ(x, y + 1), x / W, (y + 1) / H);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3,
                     base, base + 3, base + 4, base, base + 4, base + 1);
      }
    }
    if (indices.length === 0) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    return geom;
  }

  /** Rebuild the text relief when the counters change (time ticks, etc.). */
  _refreshText() {
    const sum = this._textChecksum();
    if (sum === this._textSum) return;
    this._textSum = sum;
    this.textMask = this._buildTextMask();
    const geom = this._buildTextGeometry();
    if (this.textMesh.geometry && this.textMesh.geometry !== this._emptyGeom) {
      this.textMesh.geometry.dispose();
    }
    this.textMesh.geometry = geom || this._emptyGeom;
    this.textMesh.visible = !!geom;
  }

  /** Per-tile relief geometry (cached), for the raised hovered button. */
  _tileGeometry(index) {
    if (this._tileGeoms[index]) return this._tileGeoms[index];
    const W = this.canvas.width, H = this.canvas.height;
    const x0 = index * GUI_TILE_W, x1 = x0 + GUI_TILE_W;
    const geom = buildExtrudedSpriteGeometry(
      (x, y) => x >= x0 && x < x1 &&
        (this.iconMask[y * W + x] !== 0 ||
         (this.digitMask && this.digitMask[y * W + x] !== 0)),
      W, H, GUI_ICON_DEPTH);
    if (geom) this.resources.track(geom);
    this._tileGeoms[index] = geom;
    return geom;
  }

  _layoutRelief() {
    if (!this.tileReliefs || !this.mesh) return;
    const sx = this.mesh.scale.x / this.canvas.width;
    const sy = this.mesh.scale.y / this.canvas.height;
    // geometry is in canvas pixels, y down: flip Y and pin to the top-left
    const meshes = this.textMesh
      ? this.tileReliefs.concat([this.textMesh]) : this.tileReliefs;
    for (const mesh of meshes) {
      mesh.scale.set(sx, -sy, sx);
      mesh.position.set(
        this.mesh.position.x - this.mesh.scale.x / 2,
        this.mesh.position.y + this.mesh.scale.y / 2,
        this.mesh.position.z + 0.2 * sx);
    }
    if (this.hoverIndex != null) {
      this._layoutSocket(this.hoverIndex);
      this._layoutHoverRelief(this.hoverIndex);
    }
  }

  _layoutSocket(index) {
    if (!this.socket || !this.mesh) return;
    const cw = this.canvas.width, ch = this.canvas.height;
    const pw = this.mesh.scale.x, ph = this.mesh.scale.y;
    this.socket.scale.set((GUI_CROP_W(index) / cw) * pw, (GUI_CROP_H / ch) * ph, 1);
    this.socket.position.set(
      this.mesh.position.x + (GUI_CROP_CX(index) / cw - 0.5) * pw,
      this.mesh.position.y + (0.5 - GUI_CROP_CY / ch) * ph,
      this.mesh.position.z + 0.1 * this._unit);
  }

  /** Same transform, grown about the tile centre and raised with the tile. */
  _layoutHoverRelief(index) {
    if (!this.hoverRelief || !this.mesh) return;
    const pw = this.mesh.scale.x, ph = this.mesh.scale.y;
    const sx = pw / this.canvas.width, sy = ph / this.canvas.height;
    const g = GUI_GROW_FOR(index);
    const cx = GUI_CROP_CX(index); // same pivot as the raised copy
    const cy = GUI_CROP_CY;
    this.hoverRelief.scale.set(sx * g, -sy * g, sx * g);
    this.hoverRelief.position.set(
      this.mesh.position.x - pw / 2 + cx * sx * (1 - g),
      this.mesh.position.y + ph / 2 + cy * sy * (g - 1),
      this.mesh.position.z + (GUI_TILE_POP + 0.2) * sx);
  }

  /** Create the plane once the first GameGui.render sized the buffer. */
  _ensureMesh() {
    if (this.mesh) return true;
    const img = this.display.getImageData();
    if (!img) return false;
    this.canvas.width = img.width;
    this.canvas.height = img.height;
    this.ctx = this.canvas.getContext("2d");

    this.texture = this.resources.track(new THREE.CanvasTexture(this.canvas));
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;

    const material = this.resources.track(
      new THREE.MeshBasicMaterial({
        map: this.texture, depthTest: false, depthWrite: false,
      })
    );
    const geom = this.resources.track(new THREE.PlaneGeometry(1, 1));
    this.mesh = new THREE.Mesh(geom, material);
    this.mesh.name = "gui-panel";
    this.mesh.renderOrder = GUI_ORDER_PANEL;
    this.scene.add(this.mesh);

    // hovered-button copy: same texture, UVs cropped to one button, drawn
    // slightly toward the player so the button reads as raised
    this.hoverTexture = this.resources.track(new THREE.CanvasTexture(this.canvas));
    this.hoverTexture.magFilter = THREE.NearestFilter;
    this.hoverTexture.minFilter = THREE.NearestFilter;
    this.hoverTexture.repeat.set(
      GUI_CROP_W(0) / this.canvas.width, GUI_CROP_H / this.canvas.height);
    this.hoverTile = new THREE.Mesh(
      this.resources.track(new THREE.PlaneGeometry(1, 1)),
      this.resources.track(new THREE.MeshBasicMaterial({
        map: this.hoverTexture, depthTest: false, depthWrite: false,
      }))
    );
    this.hoverTile.visible = false;
    this.hoverTile.renderOrder = GUI_ORDER_HOVER;
    this.scene.add(this.hoverTile);
    return true;
  }

  /** Panel-space UV -> button index (0..12), or null outside the button row. */
  _buttonIndexAt(uv) {
    if (!uv || !this.canvas.width) return null;
    const px = uv.x * this.canvas.width;
    const py = (1 - uv.y) * this.canvas.height;
    if (py <= GUI_TILE_TOP) return null; // the counters strip, not a button
    const index = Math.trunc(px / GUI_TILE_W);
    return index >= 0 && index <= 12 ? index : null;
  }

  /** Raise the button under the pointer (uv from a panel ray hit, or null). */
  setHover(uv) {
    if (!this._ensureMesh()) return;
    const index = this._buttonIndexAt(uv);
    if (index === this.hoverIndex) return;
    // put the previously raised button back in its slot
    if (this.tileReliefs && this.hoverIndex != null && this.tileReliefs[this.hoverIndex]) {
      this.tileReliefs[this.hoverIndex].visible = true;
    }
    this.hoverIndex = index;
    this.hoverTile.visible = index != null;
    if (this.socket) this.socket.visible = index != null;
    if (index == null) {
      if (this.hoverRelief) this.hoverRelief.visible = false;
      return;
    }
    // the button leaves its slot: hide it there, show the raised copy
    if (this.tileReliefs && this.tileReliefs[index]) {
      this.tileReliefs[index].visible = false;
    }
    if (this.hoverRelief) {
      const geom = this._tileGeometry(index);
      this.hoverRelief.visible = !!geom;
      if (geom) this.hoverRelief.geometry = geom;
    }
    this._layoutHoverTile(index);
    this._layoutSocket(index);
    this._layoutHoverRelief(index);
  }

  _layoutHoverTile(index) {
    const cw = this.canvas.width, ch = this.canvas.height;
    const pw = this.mesh.scale.x, phh = this.mesh.scale.y;
    // crop the texture to this button, including its frame edges
    this.hoverTexture.repeat.set(GUI_CROP_W(index) / cw, GUI_CROP_H / ch);
    this.hoverTexture.offset.set(
      (index * GUI_TILE_W) / cw, 1 - (GUI_TILE_TOP + GUI_CROP_H) / ch);
    this.hoverTexture.needsUpdate = true;
    // match the button's footprint on the panel, grown a touch
    const grow = GUI_GROW_FOR(index);
    this.hoverTile.scale.set(
      (GUI_CROP_W(index) / cw) * pw * grow, (GUI_CROP_H / ch) * phh * grow, 1);
    this.hoverTile.position.set(
      this.mesh.position.x + (GUI_CROP_CX(index) / cw - 0.5) * pw,
      this.mesh.position.y + (0.5 - GUI_CROP_CY / ch) * phh,
      this.mesh.position.z + GUI_TILE_POP * this._unit
    );
  }

  /** Place the panel in its parent's space: `width` wide, centred on x=0,
   *  at (y, z). The parent is the camera rig, so the toolbar stays put while
   *  the play area is moved. The buffer may not exist yet on the first call
   *  (GameGui sizes it on its first render), so the request is remembered and
   *  applied from update(). */
  place(width, y, z) {
    const p = this._placement;
    if (this._placed && p && p.width === width && p.y === y && p.z === z) return;
    this._placement = { width, y, z };
    this._placed = false;
    this._applyPlacement();
  }

  _applyPlacement() {
    if (this._placed || !this._placement || !this._ensureMesh()) return;
    const { width, y, z } = this._placement;
    const height = width * this.canvas.height / this.canvas.width;
    this.mesh.scale.set(width, height, 1);
    this.mesh.position.set(0, y, z);
    this._placed = true;
    if (this.hoverIndex != null) this._layoutHoverTile(this.hoverIndex);
    this._layoutRelief();
  }

  /** How far a raised button's bottom edge sits below the panel's centre,
   *  as a fraction of panel height (used to keep it inside the viewport). */
  raisedTileBottomOffset() {
    const ch = this.canvas.height || 40;
    const centre = GUI_CROP_CY / ch;
    const bottom = (GUI_TILE_TOP + GUI_CROP_H) / ch;
    return (bottom - centre) * GUI_TILE_GROW + (centre - 0.5);
  }

  /** Parent-space units per panel pixel: keeps depth offsets proportional
   *  whether the parent measures in game pixels or metres. */
  get _unit() {
    return this.mesh ? this.mesh.scale.x / this.canvas.width : 1;
  }

  update() {
    if (!this._ensureMesh()) return;
    this._applyPlacement();
    if (!this.dirty) return;
    this.dirty = false;
    this.ctx.putImageData(this.display.getImageData(), 0, 0);
    this.texture.needsUpdate = true;
    if (this.hoverTexture) this.hoverTexture.needsUpdate = true; // shares the canvas
    if (this.reliefTexture) this.reliefTexture.needsUpdate = true;
    if (!this.tileReliefs) {
      this._buildRelief(); // needs painted pixels
    } else {
      this._refreshDigits();
      this._refreshText();
    }
  }

  /** Convert a ray hit UV on the panel into pixel coords for GameGui. */
  _uvToPixels(uv) {
    return {
      x: Math.floor(uv.x * this.canvas.width),
      y: Math.floor((1 - uv.y) * this.canvas.height),
    };
  }

  onMouseDown(uv) { this.display.onMouseDown.trigger(this._uvToPixels(uv)); }
  onMouseUp(uv) { this.display.onMouseUp.trigger(this._uvToPixels(uv)); }
  onDoubleClick(uv) { this.display.onDoubleClick.trigger(this._uvToPixels(uv)); }

  dispose() {
    if (this.mesh) this.scene.remove(this.mesh);
    if (this.hoverTile) this.scene.remove(this.hoverTile);
    if (this.tileReliefs) this.tileReliefs.forEach((m) => this.scene.remove(m));
    if (this.hoverRelief) this.scene.remove(this.hoverRelief);
    if (this.socket) this.scene.remove(this.socket);
    if (this.textMesh) this.scene.remove(this.textMesh);
  }
}
