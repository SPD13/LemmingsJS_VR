"use strict";
/**
 * Bridge between the untouched LemmingsJS simulation and the Three.js scene.
 *
 * - HeadlessStage: satisfies the Stage contract DisplayImage needs, without a canvas.
 * - SpriteCapture: a fake "display" handed to the game's own render methods; every
 *   drawFrame/drawMask/setPixel call is captured instead of blitted, then turned
 *   into voxel sprites. The game code never knows it isn't drawing pixels.
 * - SpriteGeometryCache: per-frame extruded geometry + texture. Sprites are not
 *   flat cutouts: each frame's opaque pixels are greedy-meshed into a
 *   SPRITE_DEPTH-deep relief (front/back faces plus shaded edge walls), the
 *   plan's "characters get volume" (§5.5). Built once per animation frame,
 *   cached forever.
 * - BillboardPool: reuses meshes for the captured draws each tick.
 */

/** How far sprites extrude (in game pixels). */
const SPRITE_DEPTH = 2;

const SPRITE_SHADE_FRONT = 1.0;
const SPRITE_SHADE_BACK = 0.45;
const SPRITE_SHADE_LEFT = 0.62;
const SPRITE_SHADE_RIGHT = 0.66;
const SPRITE_SHADE_TOP = 0.85;
const SPRITE_SHADE_BOTTOM = 0.5;

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

/**
 * Extrude a sprite's opaque mask into a relief: greedy front/back rectangles
 * plus edge walls where an opaque pixel borders a transparent one. Geometry
 * is in sprite pixel space (origin top-left, y down, z toward the viewer),
 * UV-mapped onto the sprite's own texture; walls shaded via vertex colors.
 */
function buildExtrudedSpriteGeometry(isSolidRaw, w, h, depth) {
  const isSolid = (x, y) => x >= 0 && x < w && y >= 0 && y < h && isSolidRaw(x, y);
  const positions = [], colors = [], uvs = [], indices = [];

  const pushQuad = (p, uv, shade) => {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(p[i][0], p[i][1], p[i][2]);
      colors.push(shade, shade, shade);
      uvs.push(uv[i][0], uv[i][1]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // front + back faces from greedy rectangles
  const visited = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (visited[y * w + x] || !isSolid(x, y)) continue;
      let rw = 1;
      while (x + rw < w && !visited[y * w + x + rw] && isSolid(x + rw, y)) rw++;
      let rh = 1;
      expand: while (y + rh < h) {
        for (let i = 0; i < rw; i++) {
          if (visited[(y + rh) * w + x + i] || !isSolid(x + i, y + rh)) break expand;
        }
        rh++;
      }
      for (let yy = 0; yy < rh; yy++)
        for (let xx = 0; xx < rw; xx++) visited[(y + yy) * w + x + xx] = 1;

      const u0 = x / w, u1 = (x + rw) / w;
      const v0 = y / h, v1 = (y + rh) / h;
      pushQuad(
        [[x, y, depth], [x + rw, y, depth], [x + rw, y + rh, depth], [x, y + rh, depth]],
        [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], SPRITE_SHADE_FRONT);
      pushQuad(
        [[x, y, 0], [x + rw, y, 0], [x + rw, y + rh, 0], [x, y + rh, 0]],
        [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], SPRITE_SHADE_BACK);
    }
  }

  // edge walls (runs merged per direction)
  for (let x = 0; x < w; x++) {
    for (const dir of [-1, 1]) {
      let y = 0;
      while (y < h) {
        if (!isSolid(x, y) || isSolid(x + dir, y)) { y++; continue; }
        let run = 1;
        while (y + run < h && isSolid(x, y + run) && !isSolid(x + dir, y + run)) run++;
        const wx = dir === -1 ? x : x + 1;
        const u = (x + 0.5) / w, va = y / h, vb = (y + run) / h;
        pushQuad(
          [[wx, y, 0], [wx, y, depth], [wx, y + run, depth], [wx, y + run, 0]],
          [[u, va], [u, va], [u, vb], [u, vb]],
          dir === -1 ? SPRITE_SHADE_LEFT : SPRITE_SHADE_RIGHT);
        y += run;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (const dir of [-1, 1]) {
      let x = 0;
      while (x < w) {
        if (!isSolid(x, y) || isSolid(x, y + dir)) { x++; continue; }
        let run = 1;
        while (x + run < w && isSolid(x + run, y) && !isSolid(x + run, y + dir)) run++;
        const wy = dir === -1 ? y : y + 1;
        const v = (y + 0.5) / h, ua = x / w, ub = (x + run) / w;
        pushQuad(
          [[x, wy, 0], [x + run, wy, 0], [x + run, wy, depth], [x, wy, depth]],
          [[ua, v], [ub, v], [ub, v], [ua, v]],
          dir === -1 ? SPRITE_SHADE_TOP : SPRITE_SHADE_BOTTOM);
        x += run;
      }
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

/** Builds (and caches) voxel geometry + material for a game Frame or Mask. */
class SpriteGeometryCache {
  constructor(resources) {
    this.resources = resources;
    this.byFrame = new Map();
    this.byMask = new Map();
    this._emptyGeom = resources.track(new THREE.BufferGeometry());
  }

  _makeTexture(rgba, w, h) {
    const tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return this.resources.track(tex);
  }

  _makeEntry(rgba, solidFn, w, h) {
    const material = this.resources.track(
      new THREE.MeshBasicMaterial({
        map: this._makeTexture(rgba, w, h),
        vertexColors: true,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
      })
    );
    let geometry = buildExtrudedSpriteGeometry(solidFn, w, h, SPRITE_DEPTH);
    if (geometry) this.resources.track(geometry);
    else geometry = this._emptyGeom;
    return { material, geometry, w, h };
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
    entry = this._makeEntry(rgba, (x, y) => mask[y * w + x] !== 0, w, h);
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
    entry = this._makeEntry(rgba, (x, y) => bits[y * w + x] !== 0, w, h);
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

/** Pool of voxel-sprite meshes fed from a SpriteCapture each game tick. */
class BillboardPool {
  constructor(parent, geometryCache) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.geometryCache = geometryCache;
    this.pool = [];
    this.activeCount = 0;
    this.prevPositions = new Map();
  }

  _acquire(i) {
    let mesh = this.pool[i];
    if (!mesh) {
      mesh = new THREE.Mesh();
      mesh.userData.interp = null;
      this.pool[i] = mesh;
      this.group.add(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  /**
   * Rebuild sprites from captured draw calls.
   * zFor(layer) maps a capture layer (-1 background / 0 normal / 1 decal) to depth.
   */
  sync(items, zFor, interpolate) {
    const nextPositions = interpolate ? new Map() : null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = item.frame
        ? this.geometryCache.forFrame(item.frame)
        : this.geometryCache.forMask(item.mask);
      const src = item.frame || item.mask;
      const mesh = this._acquire(i);
      mesh.geometry = entry.geometry;
      mesh.material = entry.material;
      // geometry origin is the sprite's top-left corner
      const bx = item.x + src.offsetX;
      const by = item.y + src.offsetY + (item.flipY ? entry.h : 0);
      mesh.scale.y = item.flipY ? -1 : 1;
      mesh.position.set(bx, by, zFor(item.layer) + i * 0.02);
      if (interpolate && item.key) {
        const prev = this.prevPositions.get(item.key) || { x: bx, y: by };
        mesh.userData.interp = { px: prev.x, py: prev.y, cx: bx, cy: by };
        nextPositions.set(item.key, { x: bx, y: by });
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

  /** Lerp sprite positions between the last two sim ticks (alpha 0..1). */
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

/** Kept as an alias: bridge consumers were written against this name. */
const SpriteMaterialCache = SpriteGeometryCache;
