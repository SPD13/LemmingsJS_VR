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
// A Lemmix panel has no shared border - each 16-px cell is its own tile -
// so its copies crop exactly one cell, or they bite the neighbour's edge.
let GUI_SHARED_BORDER = true;
let GUI_CROP_H = GUI_TILE_H + 1;
let GUI_BUTTONS = 13;         // the DOS panel; a Lemmix game states its own (panelLayout)
// ...but the last button (speed) has no next tile: the status box's red
// border starts at x=207, so that button's cell is only 15 columns wide.
// Crop it short and don't grow it, or the raised copy lifts the box's border
// along with it.
let GUI_LAST_BUTTON = GUI_BUTTONS - 1;
// The DOS panel's last box, inside its red border (x 207..312, y 17..38):
// the minimap goes there, at the DOS scale of 16 px across and 8 down, so a
// 1600x160 level is 100x20 and fits with no room for a frame outside it.
const GUI_DOS_MINIMAP = { x: 208, y: 18, w: 104, h: 20, scaleX: 16, scaleY: 8, pad: 0 };
const GUI_CROP_W = (index) =>
  !GUI_SHARED_BORDER ? GUI_TILE_W : index >= GUI_LAST_BUTTON ? GUI_TILE_W - 1 : GUI_TILE_W + 1;
const GUI_GROW_FOR = (index) =>
  GUI_SHARED_BORDER && index >= GUI_LAST_BUTTON ? 1 : GUI_TILE_GROW;
const GUI_CROP_CX = (index) => index * GUI_TILE_W + GUI_CROP_W(index) / 2;
let GUI_CROP_CY = GUI_TILE_TOP + GUI_CROP_H / 2;
// The toolbar is an overlay: drawn without depth testing, after the world,
// so it is always visible and clickable no matter what it sits in front of.
// Aiming marks - the cursor, the controller dots and the hand markers - carry
// a render order above everything here and are transparent, which puts them
// last in three's draw order and so on top of the bar (see VR_MARK_ORDER).
const GUI_ORDER_PANEL = 50;
const GUI_ORDER_SOCKET = 51;  // covers the slot a raised button left behind
const GUI_ORDER_RELIEF = 52;
const GUI_ORDER_HOVER = 53;
const GUI_ORDER_HOVER_RELIEF = 54;
const GUI_ORDER_BAR_TOOL = 55;  // the VR lock/move handles above the bar
// A question interrupting the bar draws over all of it, whatever plane it
// shares with it and wherever the bar has been dragged to.
const GUI_ORDER_MODAL = 56;
const GUI_ORDER_MODAL_BTN = 57;

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
const guiIconTop = (index) => (index < GUI_DIGIT_BUTTONS ? 26 : 17);
// The counts themselves (white digits on their black box) are raised too,
// but they change as skills are spent, so their geometry is rebuilt whenever
// the digit strip's pixels change.
const GUI_DIGIT_TOP = 17;
const GUI_DIGIT_BOTTOM = 26;
let GUI_DIGIT_BUTTONS = 10; // 0..9 carry counts; 10..12 do not
const GUI_DIGIT_COLOR = "255,255,255";
// The counters strip along the top ("Out 5  In 0%  Time 4-57") is drawn as
// green letters with light highlights; those highlights get raised 1px on a
// smoothed surface, so the lettering reads as embossed rather than printed.
const GUI_TEXT_BOTTOM = GUI_TILE_TOP; // the strip above the buttons
// The counters strip is three colours: a black ground, the green writing and
// the white writing. They are raised by different amounts so the white reads
// as sitting proud of the green rather than merely being a lighter shade.
const GUI_TEXT_DEPTHS = {
  "0,176,0": 1,       // green
  "240,208,208": 2,   // white
  "255,255,255": 2,
};
const GUI_TEXT_DEPTH_MAX = 2;

class GuiPanel {
  constructor(scene, game, resources) {
    this.dirty = true;
    this.game = game;
    this.stage = new HeadlessStage(() => { this.dirty = true; });
    this.display = new Lemmings.DisplayImage(this.stage);
    game.setGuiDisplay(this.display);
    // a Lemmix game draws its own panel (created just above) and states its
    // layout: how many 16-px buttons, and which of them carry counts
    const layout = game.panelLayout || null;
    GUI_BUTTONS = layout ? layout.buttons : 13;
    GUI_LAST_BUTTON = GUI_BUTTONS - 1;
    GUI_DIGIT_BUTTONS = layout ? layout.digitButtons : 10;
    GUI_SHARED_BORDER = !(layout && layout.sharedBorder === false);
    GUI_CROP_H = GUI_SHARED_BORDER ? GUI_TILE_H + 1 : GUI_TILE_H;
    GUI_CROP_CY = GUI_TILE_TOP + GUI_CROP_H / 2;
    // the minimap's window: where a Lemmix panel put it, or the DOS box
    this.minimapSpec = layout ? layout.minimap || null : GUI_DOS_MINIMAP;
    this.minimap = null;
    this.minimapDrag = false;  // a press on the map, still held
    this.onMinimapCenter = null; // (levelPoint) => the page moves the view
    this.viewRect = null;

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
    // Multiplies how far the artwork stands off the panel. The toolbar is an
    // overlay drawn with no depth testing, so on a flat screen the relief is
    // sold entirely by its shading and one canvas pixel is plenty. In a
    // headset the shading is the same but the eyes want parallax too, and one
    // pixel of a 0.6m panel is under 2mm at arm's length - far too shallow to
    // read as raised. See setReliefDepth.
    this.reliefDepth = 1;
    // Whether the artwork and counters stand off the panel at all: off, the
    // bar is the flat original. See setRelief.
    this.reliefOn = true;
    this._tileGeoms = [];
  }

  /** A Lemmix panel says which pixels are pictures and which are digits
   *  (layout.reliefMasks), since it drew them; the DOS panel is keyed by
   *  colour. Null until a panel that promises masks has painted. */
  _panelMasks() {
    const layout = this.game.panelLayout || null;
    return layout && layout.reliefFromMasks ? layout.reliefMasks || null : null;
  }

  /** 1 where a pixel belongs to a tile's lemming picture, 0 elsewhere. */
  _buildIconMask() {
    const masks = this._panelMasks();
    if (masks) return masks.art;
    const W = this.canvas.width, H = this.canvas.height;
    // the button backgrounds to key the pictures out of: the DOS dither
    const bg = GUI_BG_COLORS;
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
        if (!bg.has(key)) mask[y * W + x] = 1;
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

    this._applyReliefVisibility(); // the switch may have been thrown before the build
    this._layoutRelief();
  }

  /** White digit pixels of the skill/release-rate counts. */
  _buildDigitMask() {
    const masks = this._panelMasks();
    if (masks) return masks.digits;
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

  /** How far each pixel of the counters text stands off the panel. */
  _buildTextMask() {
    const W = this.canvas.width;
    const data = this.ctx.getImageData(0, 0, W, GUI_TEXT_BOTTOM).data;
    const height = new Uint8Array(W * this.canvas.height);
    for (let y = 0; y < GUI_TEXT_BOTTOM; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const key = data[i] + "," + data[i + 1] + "," + data[i + 2];
        height[y * W + x] = GUI_TEXT_DEPTHS[key] || 0;
      }
    }
    return height;
  }

  _textChecksum() {
    const data = this.ctx.getImageData(0, 0, this.canvas.width, GUI_TEXT_BOTTOM).data;
    let h = 0;
    for (let i = 0; i < data.length; i += 4) h = (h * 31 + data[i]) | 0;
    return h;
  }

  /**
   * Smoothed relief for the text: each quad corner rises to the mean of the
   * heights meeting there, so strokes are beveled into the panel instead of
   * standing on hard little walls (no walls are needed - the surface slopes
   * back down to the panel at the edge of a stroke). Averaging heights rather
   * than counting pixels also ramps the white down onto the green where the
   * two meet, instead of stepping.
   */
  _buildTextGeometry() {
    const W = this.canvas.width, H = this.canvas.height;
    const height = this.textMask;
    const at = (x, y) =>
      (x >= 0 && x < W && y >= 0 && y < H) ? height[y * W + x] : 0;
    const cornerZ = (x, y) =>
      (at(x - 1, y - 1) + at(x, y - 1) + at(x - 1, y) + at(x, y)) / 4;

    const positions = [], colors = [], uvs = [], indices = [];
    const push = (px, py, pz, u, v) => {
      positions.push(px, py, pz);
      // shade with height so the bevel reads even head-on
      const shade = 0.72 + 0.28 * (pz / GUI_TEXT_DEPTH_MAX);
      colors.push(shade, shade, shade);
      uvs.push(u, v);
    };
    for (let y = 0; y < GUI_TEXT_BOTTOM; y++) {
      for (let x = 0; x < W; x++) {
        const h = height[y * W + x];
        if (!h) continue;
        // a centre vertex at this pixel's own height fanned out to the
        // averaged corners: a stroke reaches its full height even where it is
        // a single pixel wide, while the corners bevel down around it
        const base = positions.length / 3;
        push(x + 0.5, y + 0.5, h, (x + 0.5) / W, (y + 0.5) / H);
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
    this.textMesh.visible = this.reliefOn && !!geom;
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
      mesh.scale.set(sx, -sy, sx * this.reliefDepth);
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

  /** The panel cell of the selected skill, or -1: on the DOS panel the selection frame
   *  is drawn on the lines tiles share, so which lines a raised copy takes depends on it. */
  _selectedIndex() {
    if (!GUI_SHARED_BORDER) return -1;
    try {
      const skill = this.game.getGameSkills().getSelectedSkill();
      return skill > 0 ? skill + 1 : -1; // CLIMBER..DIGGER (1..8) sit on cells 2..9
    } catch (e) { return -1; }
  }

  /**
   * What a raised copy of `index` crops: its own cell, plus the shared line
   * on its right when the selection frame is its own, minus its first column
   * when that line belongs to a selected neighbour on the left. The DOS panel's
   * last button stops a column short of the status box's border.
   */
  _crop(index) {
    let x0 = index * GUI_TILE_W, x1 = x0 + GUI_TILE_W;
    if (GUI_SHARED_BORDER) {
      const sel = this._selectedIndex();
      if (index >= GUI_LAST_BUTTON) x1 -= 1;
      else if (sel === index) x1 += 1;
      if (sel === index - 1) x0 += 1;
    }
    return { x0, w: x1 - x0, cx: (x0 + x1) / 2 };
  }

  _layoutSocket(index) {
    if (!this.socket || !this.mesh) return;
    const cw = this.canvas.width, ch = this.canvas.height;
    const pw = this.mesh.scale.x, ph = this.mesh.scale.y;
    const crop = this._crop(index);
    this.socket.scale.set((crop.w / cw) * pw, (GUI_CROP_H / ch) * ph, 1);
    this.socket.position.set(
      this.mesh.position.x + (crop.cx / cw - 0.5) * pw,
      this.mesh.position.y + (0.5 - GUI_CROP_CY / ch) * ph,
      this.mesh.position.z + 0.1 * this._unit);
  }

  /** Same transform, grown about the tile centre and raised with the tile. */
  _layoutHoverRelief(index) {
    if (!this.hoverRelief || !this.mesh) return;
    const pw = this.mesh.scale.x, ph = this.mesh.scale.y;
    const sx = pw / this.canvas.width, sy = ph / this.canvas.height;
    const g = GUI_GROW_FOR(index);
    const cx = this._crop(index).cx; // same pivot as the raised copy
    const cy = GUI_CROP_CY;
    this.hoverRelief.scale.set(sx * g, -sy * g, sx * g * this.reliefDepth);
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

    if (this.minimapSpec && typeof MiniMap !== "undefined" && this.game.level) {
      this.minimap = new MiniMap(this, this.game, this.game.level, this.minimapSpec,
        this.scene, this.resources);
      if (this.viewRect) this.minimap.setViewRect(this.viewRect);
    }
    return true;
  }

  /** Panel-space UV -> button index (0..last button of this panel), or null outside the row. */
  _buttonIndexAt(uv) {
    if (!uv || !this.canvas.width) return null;
    const px = uv.x * this.canvas.width;
    const py = (1 - uv.y) * this.canvas.height;
    if (py <= GUI_TILE_TOP) return null; // the counters strip, not a button
    const index = Math.trunc(px / GUI_TILE_W);
    return index >= 0 && index <= GUI_LAST_BUTTON ? index : null;
  }

  /** Raise the button under the pointer (uv from a panel ray hit, or null). */
  setHover(uv) {
    if (!this._ensureMesh()) return;
    const index = this._buttonIndexAt(uv);
    if (index === this.hoverIndex) return;
    // put the previously raised button back in its slot
    if (this.tileReliefs && this.hoverIndex != null && this.tileReliefs[this.hoverIndex]) {
      this.tileReliefs[this.hoverIndex].visible = this.reliefOn;
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
      this.hoverRelief.visible = this.reliefOn && !!geom;
      if (geom) this.hoverRelief.geometry = geom;
    }
    this._layoutHoverTile(index);
    this._layoutSocket(index);
    this._layoutHoverRelief(index);
  }

  _layoutHoverTile(index) {
    const cw = this.canvas.width, ch = this.canvas.height;
    const pw = this.mesh.scale.x, phh = this.mesh.scale.y;
    // crop the texture to this button, with the frame edges that are its own
    const crop = this._crop(index);
    this.hoverTexture.repeat.set(crop.w / cw, GUI_CROP_H / ch);
    this.hoverTexture.offset.set(crop.x0 / cw, 1 - (GUI_TILE_TOP + GUI_CROP_H) / ch);
    this.hoverTexture.needsUpdate = true;
    // match the button's footprint on the panel, grown a touch
    const grow = GUI_GROW_FOR(index);
    this.hoverTile.scale.set(
      (crop.w / cw) * pw * grow, (GUI_CROP_H / ch) * phh * grow, 1);
    this.hoverTile.position.set(
      this.mesh.position.x + (crop.cx / cw - 0.5) * pw,
      this.mesh.position.y + (0.5 - GUI_CROP_CY / ch) * phh,
      this.mesh.position.z + GUI_TILE_POP * this._unit
    );
  }

  /** Place the panel in its parent's space: `width` wide, centred on x=0,
   *  at (y, z). The parent is the camera rig, so the toolbar stays put while
   *  the play area is moved. The buffer may not exist yet on the first call
   *  (GameGui sizes it on its first render), so the request is remembered and
   *  applied from update(). */
  /** How far the extruded artwork stands off the panel, as a multiple of the
   *  one canvas pixel it is modelled at. */
  setReliefDepth(mult) {
    if (this.reliefDepth === mult) return;
    this.reliefDepth = mult;
    this._layoutRelief();
  }

  /** Whether the artwork and counters are extruded at all. Off, the bar is
   *  the flat original; a hovered button still rises, since that is how the
   *  bar answers the pointer. */
  setRelief(on) {
    if (this.reliefOn === on) return;
    this.reliefOn = on;
    this._applyReliefVisibility();
  }

  _applyReliefVisibility() {
    if (!this.tileReliefs) return; // applied once the relief is built
    const on = this.reliefOn;
    this.tileReliefs.forEach((m, i) => { m.visible = on && i !== this.hoverIndex; });
    if (this.hoverRelief) {
      this.hoverRelief.visible =
        on && this.hoverIndex != null && !!this._tileGeometry(this.hoverIndex);
    }
    if (this.textMesh) {
      this.textMesh.visible = on && this.textMesh.geometry !== this._emptyGeom;
    }
  }

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
    if (this.hoverIndex != null) {
      this._layoutHoverTile(this.hoverIndex);   // the selection may have moved a frame edge
      this._layoutSocket(this.hoverIndex);
      this._layoutHoverRelief(this.hoverIndex);
    }
    this._layoutRelief();
    if (this.minimap) this.minimap.layout();
  }

  /** The part of the level in view, in level px, from the page each frame. */
  setViewRect(rect) {
    if (rect) this.viewRect = rect;
    if (this.minimap) this.minimap.setViewRect(rect);
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
    if (this.minimap) this.minimap.update(); // the frame moves between ticks
    // a Lemmix panel's held frame-skip half repeats between ticks (and while paused)
    if (this.game.gui && this.game.gui.poll) this.game.gui.poll(performance.now());
    if (!this.dirty) return;
    this.dirty = false;
    this.ctx.putImageData(this.display.getImageData(), 0, 0);
    this.texture.needsUpdate = true;
    if (this.hoverTexture) this.hoverTexture.needsUpdate = true; // shares the canvas
    if (this.reliefTexture) this.reliefTexture.needsUpdate = true;
    if (!this.tileReliefs) {
      // needs painted pixels: a Lemmix panel paints once its graphics are
      // in, and says which pixels are what when it does
      const layout = this.game.panelLayout;
      if (!(layout && layout.reliefFromMasks && !layout.reliefMasks)) this._buildRelief();
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

  /** Does this UV land on the minimap's window? */
  isMinimap(uv) {
    if (!uv || !this.minimap) return false;
    const p = this._uvToPixels(uv);
    return this.minimap.contains(p.x, p.y);
  }

  _centerFromMinimap(p) {
    if (this.onMinimapCenter) this.onMinimapCenter(this.minimap.pointToLevel(p.x, p.y));
  }

  _endMinimapDrag() {
    this.minimapDrag = false;
    if (this.minimap) this.minimap.setFreeze(false);
  }

  // A press on the map is the page's to answer, never the game's: the DOS
  // GameGui would take it for a button past the last one and disarm a
  // prepared nuke on the way (handleSkillMouseDown), and a Lemmix panel
  // would look up a cell that is not there. Held and moved, it keeps
  // centring the view (MinimapMouseMove); moved off the map, it lets go.
  onMouseDown(uv, button) {
    const p = this._uvToPixels(uv);
    if (this.minimap && this.minimap.contains(p.x, p.y)) {
      this.minimapDrag = true;
      this.minimap.setFreeze(true);
      this._centerFromMinimap(p);
      return;
    }
    p.button = button || 0; // a Lemmix panel skips further on a right or middle press
    this.display.onMouseDown.trigger(p);
  }
  onMouseMove(uv) {
    if (!this.minimapDrag) return;
    const p = uv ? this._uvToPixels(uv) : null;
    if (p && this.minimap.contains(p.x, p.y)) this._centerFromMinimap(p);
    else this._endMinimapDrag();
  }
  onMouseUp(uv) {
    if (this.minimapDrag) { this._endMinimapDrag(); return; }
    if (uv) this.display.onMouseUp.trigger(this._uvToPixels(uv));
  }
  onDoubleClick(uv) {
    const p = this._uvToPixels(uv);
    if (this.minimap && this.minimap.contains(p.x, p.y)) return;
    this.display.onDoubleClick.trigger(p);
  }

  dispose() {
    if (this.minimap) { this.minimap.dispose(); this.minimap = null; }
    if (this.mesh) this.scene.remove(this.mesh);
    if (this.hoverTile) this.scene.remove(this.hoverTile);
    if (this.tileReliefs) this.tileReliefs.forEach((m) => this.scene.remove(m));
    if (this.hoverRelief) this.scene.remove(this.hoverRelief);
    if (this.socket) this.scene.remove(this.socket);
    if (this.textMesh) this.scene.remove(this.textMesh);
  }
}
