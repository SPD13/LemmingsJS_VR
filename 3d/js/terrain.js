"use strict";
/**
 * Extruded, destructible terrain with depth classes.
 *
 * Each pixel of the level carries a depth class (see depth.js): backdrop
 * pixels form a recessed slab, terrain the main slab, relief sticks out,
 * overlay floats as a thin decal layer. Per 32x32-pixel chunk we greedy-mesh
 * front/back faces per class and emit step walls where classes of different
 * heights meet (always from the taller side, spanning only the exposed part,
 * so no coplanar duplicates). Everything is UV-mapped onto one level-sized
 * texture built from level.groundImage.
 *
 * Level.setGroundAt/clearGroundAt are wrapped (every dig/bash/mine/explode/
 * build funnels through them) to keep the depth buffer + texture in sync and
 * re-mesh dirty chunks with a per-tick budget. Geometry lives in game pixel
 * space (y down); the parent group flips it into world space.
 */

const TERRAIN_CHUNK = 32;
const TERRAIN_DEPTH = 16; // front Z of the main terrain slab (DepthClass.TERRAIN)

// face shading factors (MeshBasicMaterial * vertexColors, no lights needed)
const SHADE_FRONT = 1.0;
const SHADE_BACK = 0.4;
const SHADE_LEFT = 0.6;
const SHADE_RIGHT = 0.66;
const SHADE_TOP = 0.85;
const SHADE_BOTTOM = 0.5;

class TerrainMesh {
  constructor(parent, level, depthMap, resources) {
    this.level = level;
    this.depth = depthMap;
    this.resources = resources;
    this.w = level.width;
    this.h = level.height;
    this.chunksX = Math.ceil(this.w / TERRAIN_CHUNK);
    this.chunksY = Math.ceil(this.h / TERRAIN_CHUNK);
    this.group = new THREE.Group();
    parent.add(this.group);

    this.maskLayer = level.getGroundMaskLayer();

    // one texture for the whole level; alpha mirrors the solidity mask
    this.texData = new Uint8Array(this.w * this.h * 4);
    this._refillTexRect(0, 0, this.w, this.h);
    this.texture = resources.track(
      new THREE.DataTexture(this.texData, this.w, this.h, THREE.RGBAFormat)
    );
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;

    this.material = resources.track(
      new THREE.MeshBasicMaterial({
        map: this.texture,
        vertexColors: true,
        side: THREE.DoubleSide,
      })
    );

    this.chunkMeshes = new Array(this.chunksX * this.chunksY).fill(null);
    this.dirtyChunks = new Set();

    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cx = 0; cx < this.chunksX; cx++) {
        this._rebuildChunk(cx, cy);
      }
    }

    this._hookLevelMutations();
  }

  _classAt(x, y) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return DepthClass.EMPTY;
    return this.depth[x + y * this.w];
  }

  _refillTexRect(x0, y0, w, h) {
    const src = this.level.groundImage;
    const mask = this.maskLayer.groundMask;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * this.w + x) * 4;
        this.texData[i] = src[i];
        this.texData[i + 1] = src[i + 1];
        this.texData[i + 2] = src[i + 2];
        this.texData[i + 3] = mask[y * this.w + x] ? 255 : 0;
      }
    }
  }

  /** Wrap the two Level methods every terrain mutation funnels through. */
  _hookLevelMutations() {
    const level = this.level;
    const origClear = level.clearGroundAt.bind(level);
    const origSet = level.setGroundAt.bind(level);
    level.clearGroundAt = (x, y) => {
      origClear(x, y);
      this._applyMutation(x, y, DepthClass.EMPTY);
    };
    level.setGroundAt = (x, y, palletIndex) => {
      origSet(x, y, palletIndex);
      this._applyMutation(x, y, DepthClass.TERRAIN); // builder bricks are terrain
    };
  }

  _applyMutation(x, y, depthClass) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    this.depth[x + y * this.w] = depthClass;
    const i = (y * this.w + x) * 4;
    const src = this.level.groundImage;
    this.texData[i] = src[i];
    this.texData[i + 1] = src[i + 1];
    this.texData[i + 2] = src[i + 2];
    this.texData[i + 3] = this.maskLayer.groundMask[y * this.w + x] ? 255 : 0;
    this.texture.needsUpdate = true;

    const cx = Math.floor(x / TERRAIN_CHUNK);
    const cy = Math.floor(y / TERRAIN_CHUNK);
    this.dirtyChunks.add(cy * this.chunksX + cx);
    // a changed pixel exposes new step walls in the neighboring chunk
    const lx = x % TERRAIN_CHUNK, ly = y % TERRAIN_CHUNK;
    if (lx === 0 && cx > 0) this.dirtyChunks.add(cy * this.chunksX + cx - 1);
    if (lx === TERRAIN_CHUNK - 1 && cx < this.chunksX - 1) this.dirtyChunks.add(cy * this.chunksX + cx + 1);
    if (ly === 0 && cy > 0) this.dirtyChunks.add((cy - 1) * this.chunksX + cx);
    if (ly === TERRAIN_CHUNK - 1 && cy < this.chunksY - 1) this.dirtyChunks.add((cy + 1) * this.chunksX + cx);
  }

  /** Re-mesh dirty chunks, at most `budget` per call (nuke-proofing). */
  flushDirty(budget = 24) {
    let n = 0;
    for (const id of this.dirtyChunks) {
      this.dirtyChunks.delete(id);
      this._rebuildChunk(id % this.chunksX, Math.floor(id / this.chunksX));
      if (++n >= budget) break;
    }
  }

  _rebuildChunk(cx, cy) {
    const id = cy * this.chunksX + cx;
    const old = this.chunkMeshes[id];
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      this.chunkMeshes[id] = null;
    }
    const geom = this._buildChunkGeometry(cx, cy);
    if (!geom) return;
    const mesh = new THREE.Mesh(geom, this.material);
    this.group.add(mesh);
    this.chunkMeshes[id] = mesh;
  }

  /**
   * Wall span at the boundary between class c and its neighbor nc, or null.
   * Emitted only from the taller class and only over the exposed height, so
   * two classes never produce coplanar overlapping walls.
   */
  _wallSpan(c, nc) {
    if (nc === c) return null;
    const band = DEPTH_BANDS[c];
    if (nc === DepthClass.EMPTY) return [band.back, band.front];
    const nBand = DEPTH_BANDS[nc];
    if (nBand.front < band.front) return [nBand.front, band.front];
    return null;
  }

  _buildChunkGeometry(cx, cy) {
    const x0 = cx * TERRAIN_CHUNK;
    const y0 = cy * TERRAIN_CHUNK;
    const cw = Math.min(TERRAIN_CHUNK, this.w - x0);
    const ch = Math.min(TERRAIN_CHUNK, this.h - y0);
    const W = this.w, H = this.h;

    const positions = [];
    const colors = [];
    const uvs = [];
    const indices = [];

    const pushQuad = (p, uv, shade) => {
      const base = positions.length / 3;
      for (let i = 0; i < 4; i++) {
        positions.push(p[i][0], p[i][1], p[i][2]);
        colors.push(shade, shade, shade);
        uvs.push(uv[i][0], uv[i][1]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    // --- front + back faces from greedy same-class rectangles ---
    const visited = new Uint8Array(cw * ch);
    for (let ly = 0; ly < ch; ly++) {
      for (let lx = 0; lx < cw; lx++) {
        if (visited[ly * cw + lx]) continue;
        const c = this._classAt(x0 + lx, y0 + ly);
        if (c === DepthClass.EMPTY) continue;
        let rw = 1;
        while (lx + rw < cw && !visited[ly * cw + lx + rw] &&
               this._classAt(x0 + lx + rw, y0 + ly) === c) rw++;
        let rh = 1;
        expand: while (ly + rh < ch) {
          for (let i = 0; i < rw; i++) {
            if (visited[(ly + rh) * cw + lx + i] ||
                this._classAt(x0 + lx + i, y0 + ly + rh) !== c) break expand;
          }
          rh++;
        }
        for (let yy = 0; yy < rh; yy++)
          for (let xx = 0; xx < rw; xx++) visited[(ly + yy) * cw + lx + xx] = 1;

        const band = DEPTH_BANDS[c];
        const px = x0 + lx, py = y0 + ly;
        const u0 = px / W, u1 = (px + rw) / W;
        const v0 = py / H, v1 = (py + rh) / H;
        pushQuad(
          [[px, py, band.front], [px + rw, py, band.front],
           [px + rw, py + rh, band.front], [px, py + rh, band.front]],
          [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
          SHADE_FRONT * band.frontShade
        );
        pushQuad(
          [[px, py, band.back], [px + rw, py, band.back],
           [px + rw, py + rh, band.back], [px, py + rh, band.back]],
          [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
          SHADE_BACK
        );
      }
    }

    // --- walls where a pixel borders empty space or a lower class ---
    // left/right: vertical runs per column; top/bottom: horizontal runs per row.
    // Runs merge while the (class, span) pair stays identical.
    const spanKey = (s) => (s ? s[0] * 1000 + s[1] : -1);

    for (let lx = 0; lx < cw; lx++) {
      const px = x0 + lx;
      for (const dir of [-1, 1]) { // -1 = left neighbor, 1 = right neighbor
        let ly = 0;
        while (ly < ch) {
          const c = this._classAt(px, y0 + ly);
          const span = c === DepthClass.EMPTY
            ? null : this._wallSpan(c, this._classAt(px + dir, y0 + ly));
          if (!span) { ly++; continue; }
          let run = 1;
          while (ly + run < ch) {
            const c2 = this._classAt(px, y0 + ly + run);
            const s2 = c2 === DepthClass.EMPTY
              ? null : this._wallSpan(c2, this._classAt(px + dir, y0 + ly + run));
            if (c2 !== c || spanKey(s2) !== spanKey(span)) break;
            run++;
          }
          const wx = dir === -1 ? px : px + 1;
          const u = (px + 0.5) / W, va = (y0 + ly) / H, vb = (y0 + ly + run) / H;
          pushQuad(
            [[wx, y0 + ly, span[0]], [wx, y0 + ly, span[1]],
             [wx, y0 + ly + run, span[1]], [wx, y0 + ly + run, span[0]]],
            [[u, va], [u, va], [u, vb], [u, vb]],
            dir === -1 ? SHADE_LEFT : SHADE_RIGHT
          );
          ly += run;
        }
      }
    }
    for (let ly = 0; ly < ch; ly++) {
      const py = y0 + ly;
      for (const dir of [-1, 1]) { // -1 = neighbor above, 1 = neighbor below
        let lx = 0;
        while (lx < cw) {
          const c = this._classAt(x0 + lx, py);
          const span = c === DepthClass.EMPTY
            ? null : this._wallSpan(c, this._classAt(x0 + lx, py + dir));
          if (!span) { lx++; continue; }
          let run = 1;
          while (lx + run < cw) {
            const c2 = this._classAt(x0 + lx + run, py);
            const s2 = c2 === DepthClass.EMPTY
              ? null : this._wallSpan(c2, this._classAt(x0 + lx + run, py + dir));
            if (c2 !== c || spanKey(s2) !== spanKey(span)) break;
            run++;
          }
          const wy = dir === -1 ? py : py + 1;
          const v = (py + 0.5) / H, ua = (x0 + lx) / W, ub = (x0 + lx + run) / W;
          pushQuad(
            [[x0 + lx, wy, span[0]], [x0 + lx + run, wy, span[0]],
             [x0 + lx + run, wy, span[1]], [x0 + lx, wy, span[1]]],
            [[ua, v], [ub, v], [ub, v], [ua, v]],
            dir === -1 ? SHADE_TOP : SHADE_BOTTOM
          );
          lx += run;
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

  dispose() {
    for (const mesh of this.chunkMeshes) {
      if (mesh) mesh.geometry.dispose();
    }
    this.group.parent.remove(this.group);
  }
}
