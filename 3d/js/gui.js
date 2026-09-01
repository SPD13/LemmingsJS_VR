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
const GUI_BUTTONS = 13;

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
    this.reliefMesh = null;    // extruded lemming figures across the row
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

  /** Build the figure relief once the panel canvas holds real pixels. */
  _buildRelief() {
    const W = this.canvas.width, H = this.canvas.height;
    this.iconMask = this._buildIconMask();
    const geom = buildExtrudedSpriteGeometry(
      (x, y) => this.iconMask[y * W + x] !== 0, W, H, GUI_ICON_DEPTH);
    if (!geom) return;
    this.resources.track(geom);

    // the panel texture again, unflipped: this geometry's UVs run y-down
    this.reliefTexture = this.resources.track(new THREE.CanvasTexture(this.canvas));
    this.reliefTexture.flipY = false;
    this.reliefTexture.magFilter = THREE.NearestFilter;
    this.reliefTexture.minFilter = THREE.NearestFilter;
    const material = this.resources.track(new THREE.MeshBasicMaterial({
      map: this.reliefTexture, vertexColors: true, side: THREE.DoubleSide,
    }));

    this.reliefMesh = new THREE.Mesh(geom, material);
    this.scene.add(this.reliefMesh);
    this.hoverRelief = new THREE.Mesh(geom, material);
    this.hoverRelief.visible = false;
    this.hoverRelief.renderOrder = 6;
    this.scene.add(this.hoverRelief);
    this._layoutRelief();
  }

  /** Per-tile relief geometry (cached), for the raised hovered button. */
  _tileGeometry(index) {
    if (this._tileGeoms[index]) return this._tileGeoms[index];
    const W = this.canvas.width, H = this.canvas.height;
    const x0 = index * GUI_TILE_W, x1 = x0 + GUI_TILE_W;
    const geom = buildExtrudedSpriteGeometry(
      (x, y) => x >= x0 && x < x1 && this.iconMask[y * W + x] !== 0,
      W, H, GUI_ICON_DEPTH);
    if (geom) this.resources.track(geom);
    this._tileGeoms[index] = geom;
    return geom;
  }

  _layoutRelief() {
    if (!this.reliefMesh || !this.mesh) return;
    const sx = this.mesh.scale.x / this.canvas.width;
    const sy = this.mesh.scale.y / this.canvas.height;
    // geometry is in canvas pixels, y down: flip Y and pin to the top-left
    this.reliefMesh.scale.set(sx, -sy, sx);
    this.reliefMesh.position.set(
      this.mesh.position.x - this.mesh.scale.x / 2,
      this.mesh.position.y + this.mesh.scale.y / 2,
      this.mesh.position.z + 0.2);
    if (this.hoverIndex != null) this._layoutHoverRelief(this.hoverIndex);
  }

  /** Same transform, grown about the tile centre and raised with the tile. */
  _layoutHoverRelief(index) {
    if (!this.hoverRelief || !this.mesh) return;
    const pw = this.mesh.scale.x, ph = this.mesh.scale.y;
    const sx = pw / this.canvas.width, sy = ph / this.canvas.height;
    const g = GUI_TILE_GROW;
    const cx = (index + 0.5) * GUI_TILE_W;
    const cy = GUI_TILE_TOP + GUI_TILE_H / 2;
    this.hoverRelief.scale.set(sx * g, -sy * g, sx * g);
    this.hoverRelief.position.set(
      this.mesh.position.x - pw / 2 + cx * sx * (1 - g),
      this.mesh.position.y + ph / 2 + cy * sy * (g - 1),
      this.mesh.position.z + GUI_TILE_POP + 0.2);
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
      new THREE.MeshBasicMaterial({ map: this.texture })
    );
    const geom = this.resources.track(new THREE.PlaneGeometry(1, 1));
    this.mesh = new THREE.Mesh(geom, material);
    this.mesh.name = "gui-panel";
    this.scene.add(this.mesh);

    // hovered-button copy: same texture, UVs cropped to one button, drawn
    // slightly toward the player so the button reads as raised
    this.hoverTexture = this.resources.track(new THREE.CanvasTexture(this.canvas));
    this.hoverTexture.magFilter = THREE.NearestFilter;
    this.hoverTexture.minFilter = THREE.NearestFilter;
    this.hoverTexture.repeat.set(
      GUI_TILE_W / this.canvas.width, GUI_TILE_H / this.canvas.height);
    this.hoverTile = new THREE.Mesh(
      this.resources.track(new THREE.PlaneGeometry(1, 1)),
      this.resources.track(new THREE.MeshBasicMaterial({ map: this.hoverTexture }))
    );
    this.hoverTile.visible = false;
    this.hoverTile.renderOrder = 5;
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
    this.hoverIndex = index;
    this.hoverTile.visible = index != null;
    if (this.hoverRelief) {
      const geom = index != null ? this._tileGeometry(index) : null;
      this.hoverRelief.visible = !!geom;
      if (geom) this.hoverRelief.geometry = geom;
    }
    if (index == null) return;
    this._layoutHoverTile(index);
    this._layoutHoverRelief(index);
  }

  _layoutHoverTile(index) {
    const cw = this.canvas.width, ch = this.canvas.height;
    const pw = this.mesh.scale.x, phh = this.mesh.scale.y;
    // crop the texture to this button
    this.hoverTexture.offset.set(
      (index * GUI_TILE_W) / cw, 1 - (GUI_TILE_TOP + GUI_TILE_H) / ch);
    this.hoverTexture.needsUpdate = true;
    // match the button's footprint on the panel, grown a touch
    const grow = 1.08;
    this.hoverTile.scale.set(
      (GUI_TILE_W / cw) * pw * grow, (GUI_TILE_H / ch) * phh * grow, 1);
    this.hoverTile.position.set(
      this.mesh.position.x + ((index + 0.5) * GUI_TILE_W / cw - 0.5) * pw,
      this.mesh.position.y + (0.5 - (GUI_TILE_TOP + GUI_TILE_H / 2) / ch) * phh,
      this.mesh.position.z + GUI_TILE_POP
    );
  }

  /** Position under the diorama, centered on the camera's current target x.
   *  The buffer may not exist yet on the first call (GameGui sizes it on its
   *  first render), so remember the request and apply it from update(). */
  layout(centerX, scale = 2) {
    this._layoutRequest = { centerX, scale };
    this._applyLayout();
  }

  _applyLayout() {
    if (!this._layoutRequest || !this._ensureMesh()) return;
    const { centerX, scale } = this._layoutRequest;
    const w = this.canvas.width * scale;
    const h = this.canvas.height * scale;
    this.mesh.scale.set(w, h, 1);
    this.mesh.position.set(centerX, -h / 2 - 14, TERRAIN_DEPTH);
    this._layoutRequest = null;
    if (this.hoverIndex != null) this._layoutHoverTile(this.hoverIndex);
    this._layoutRelief();
  }

  update() {
    if (!this._ensureMesh()) return;
    this._applyLayout();
    if (!this.dirty) return;
    this.dirty = false;
    this.ctx.putImageData(this.display.getImageData(), 0, 0);
    this.texture.needsUpdate = true;
    if (this.hoverTexture) this.hoverTexture.needsUpdate = true; // shares the canvas
    if (this.reliefTexture) this.reliefTexture.needsUpdate = true;
    if (!this.reliefMesh) this._buildRelief(); // needs painted pixels
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
    if (this.reliefMesh) this.scene.remove(this.reliefMesh);
    if (this.hoverRelief) this.scene.remove(this.hoverRelief);
  }
}
