"use strict";
/**
 * Bridge between the untouched LemmingsJS simulation and the Three.js scene.
 *
 * - HeadlessStage: satisfies the Stage contract DisplayImage needs, without a canvas.
 * - SpriteCapture: a fake "display" handed to the game's own render methods; every
 *   drawFrame/drawMask/setPixel call is captured instead of blitted, then turned
 *   into textured billboards. The game code never knows it isn't drawing pixels.
 * - BillboardPool: reuses plane meshes for the captured draws each tick.
 */

/** Tracks GPU resources for one loaded level so we can free them on teardown. */
class SessionResources {
  constructor() {
    this.textures = [];
    this.materials = [];
    this.geometries = [];
  }
  track(res) {
    if (res.isTexture) this.textures.push(res);
    else if (res.isMaterial) this.materials.push(res);
    else if (res.isBufferGeometry) this.geometries.push(res);
    return res;
  }
  disposeAll() {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
    this.geometries.length = this.materials.length = this.textures.length = 0;
  }
}

/** Minimal stand-in for Lemmings.Stage: enough for DisplayImage + GameGui. */
class HeadlessStage {
  constructor(onRedraw) {
    this.onRedraw = onRedraw;
  }
  createImage(display, width, height) {
    return new ImageData(width, height);
  }
  setGameViewPointPosition(x, y) {}
  redraw() {
    if (this.onRedraw) this.onRedraw();
  }
}

/** Builds (and caches) a Three.js material for a game Frame or Mask. */
class SpriteMaterialCache {
  constructor(resources) {
    this.resources = resources;
    this.byFrame = new Map();
    this.byMask = new Map();
  }

  _makeTexture(rgba, w, h) {
    const tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return this.resources.track(tex);
  }

  _makeMaterial(tex) {
    return this.resources.track(
      new THREE.MeshBasicMaterial({
        map: tex,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
      })
    );
  }

  /** Frame: Uint32 RGBA pixels + 0/1 transparency mask. */
  forFrame(frame) {
    let entry = this.byFrame.get(frame);
    if (entry) return entry;
    const w = frame.width, h = frame.height;
    const buf = frame.getBuffer();
    const src = new Uint8Array(buf.buffer, buf.byteOffset, w * h * 4);
    const mask = frame.getMask();
    const rgba = new Uint8Array(w * h * 4);
    rgba.set(src);
    for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = mask[i] ? 255 : 0;
    entry = { material: this._makeMaterial(this._makeTexture(rgba, w, h)), w, h };
    this.byFrame.set(frame, entry);
    return entry;
  }

  /** Mask: 1-bit stencil, drawn as solid white by the original renderer. */
  forMask(mask) {
    let entry = this.byMask.get(mask);
    if (entry) return entry;
    const w = mask.width, h = mask.height;
    const bits = mask.getMask();
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      if (bits[i] !== 0) {
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = rgba[i * 4 + 3] = 255;
      }
    }
    entry = { material: this._makeMaterial(this._makeTexture(rgba, w, h)), w, h };
    this.byMask.set(mask, entry);
    return entry;
  }
}

/**
 * Fake display: implements every draw method the game's render paths use and
 * records the calls. `tag` lets the caller associate captured draws with a
 * lemming id so positions can be interpolated between ticks.
 */
class SpriteCapture {
  constructor() {
    this.items = [];
    this.particles = [];
    this.tag = null;
    this._ordinals = new Map();
  }
  begin() {
    this.items.length = 0;
    this.particles.length = 0;
    this.tag = null;
    this._ordinals.clear();
  }
  _key() {
    if (this.tag == null) return null;
    const n = (this._ordinals.get(this.tag) || 0) + 1;
    this._ordinals.set(this.tag, n);
    return this.tag + ":" + n;
  }
  drawFrame(frame, x, y) {
    this.items.push({ frame, x, y, flipY: false, layer: 0, key: this._key() });
  }
  drawFrameFlags(frame, x, y, props) {
    this.items.push({
      frame, x, y,
      flipY: !!props.isUpsideDown,
      layer: props.noOverwrite ? -1 : props.onlyOverwrite ? 1 : 0,
      key: this._key(),
    });
  }
  drawFrameCovered(frame, x, y, r, g, b) {
    this.drawFrame(frame, x, y);
  }
  drawMask(mask, x, y) {
    this.items.push({ mask, x, y, flipY: false, layer: 0, key: this._key() });
  }
  setPixel(x, y, r, g, b) {
    this.particles.push(x, y, r, g, b);
  }
  // no-ops for the rest of the display surface
  setDebugPixel() {}
  drawRect() {}
  drawRectangle() {}
  drawHorizontalLine() {}
  drawVerticalLine() {}
  initSize() {}
  setBackground() {}
  setScreenPosition() {}
  getWidth() { return 0; }
  getHeight() { return 0; }
  redraw() {}
}

/** Pool of billboard meshes fed from a SpriteCapture each game tick. */
class BillboardPool {
  constructor(parent, materialCache) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.materialCache = materialCache;
    this.pool = [];
    this.activeCount = 0;
    this.prevPositions = new Map();
    this._planeGeom = new THREE.PlaneGeometry(1, 1);
  }

  _acquire(i) {
    let mesh = this.pool[i];
    if (!mesh) {
      mesh = new THREE.Mesh(this._planeGeom);
      mesh.userData.interp = null;
      this.pool[i] = mesh;
      this.group.add(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  /**
   * Rebuild billboards from captured draw calls.
   * zFor(layer) maps a capture layer (-1 background / 0 normal / 1 decal) to depth.
   */
  sync(items, zFor, interpolate) {
    const nextPositions = interpolate ? new Map() : null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = item.frame
        ? this.materialCache.forFrame(item.frame)
        : this.materialCache.forMask(item.mask);
      const src = item.frame || item.mask;
      const mesh = this._acquire(i);
      mesh.material = entry.material;
      const cx = item.x + src.offsetX + entry.w / 2;
      const cy = item.y + src.offsetY + entry.h / 2;
      mesh.scale.set(entry.w, item.flipY ? -entry.h : entry.h, 1);
      mesh.position.set(cx, cy, zFor(item.layer) + i * 0.02);
      if (interpolate && item.key) {
        const prev = this.prevPositions.get(item.key) || { cx, cy };
        mesh.userData.interp = { px: prev.cx, py: prev.cy, cx, cy };
        nextPositions.set(item.key, { cx, cy });
      } else {
        mesh.userData.interp = null;
      }
    }
    for (let i = items.length; i < this.pool.length; i++) {
      this.pool[i].visible = false;
      this.pool[i].userData.interp = null;
    }
    this.activeCount = items.length;
    if (interpolate) this.prevPositions = nextPositions;
  }

  /** Lerp billboard positions between the last two sim ticks (alpha 0..1). */
  applyInterpolation(alpha) {
    for (let i = 0; i < this.activeCount; i++) {
      const it = this.pool[i].userData.interp;
      if (!it) continue;
      this.pool[i].position.x = it.px + (it.cx - it.px) * alpha;
      this.pool[i].position.y = it.py + (it.cy - it.py) * alpha;
    }
  }

  dispose() {
    this.group.parent.remove(this.group);
    this._planeGeom.dispose();
    this.pool.length = 0;
  }
}

/** Explosion particles: captured setPixel calls rendered as a point cloud. */
class ParticleCloud {
  constructor(parent, z) {
    this.z = z;
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.PointsMaterial({
      size: 2.2,
      vertexColors: true,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    parent.add(this.points);
  }

  sync(flat) {
    const count = flat.length / 5;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = flat[i * 5];
      pos[i * 3 + 1] = flat[i * 5 + 1];
      pos[i * 3 + 2] = this.z;
      col[i * 3] = flat[i * 5 + 2] / 255;
      col[i * 3 + 1] = flat[i * 5 + 3] / 255;
      col[i * 3 + 2] = flat[i * 5 + 4] / 255;
    }
    this.geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
  }

  dispose() {
    this.points.parent.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
