"use strict";
/**
 * The original skill panel, recycled: GameGui keeps rendering its pixel buffer
 * into a real Lemmings.DisplayImage (backed by our HeadlessStage instead of a
 * canvas Stage); we upload that buffer as a texture on a plane in the scene and
 * forward ray hits as the mouse events GameGui already listens for. Release
 * rate, skill selection, pause, nuke — all original logic, zero reimplementation.
 */

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
    return true;
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
  }

  update() {
    if (!this._ensureMesh()) return;
    this._applyLayout();
    if (!this.dirty) return;
    this.dirty = false;
    this.ctx.putImageData(this.display.getImageData(), 0, 0);
    this.texture.needsUpdate = true;
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
  }
}
