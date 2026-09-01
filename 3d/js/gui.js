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
const GUI_TILE_POP = 5; // how far a hovered button rises toward the player

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
    if (index == null) return;
    this._layoutHoverTile(index);
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
  }

  update() {
    if (!this._ensureMesh()) return;
    this._applyLayout();
    if (!this.dirty) return;
    this.dirty = false;
    this.ctx.putImageData(this.display.getImageData(), 0, 0);
    this.texture.needsUpdate = true;
    if (this.hoverTexture) this.hoverTexture.needsUpdate = true; // shares the canvas
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
  }
}
