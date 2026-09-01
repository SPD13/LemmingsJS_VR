"use strict";
/**
 * Extruded, destructible terrain.
 *
 * The level's per-pixel solidity mask (which IS the game's collision data) is
 * turned into 3D geometry per 32x32-pixel chunk: greedy-merged front/back faces
 * plus boundary side walls, all UV-mapped onto one level-sized texture built
 * from level.groundImage. Level.setGroundAt/clearGroundAt are wrapped so every
 * dig/bash/mine/explosion/build marks dirty chunks, which are re-meshed with a
 * per-tick budget. Geometry lives in game pixel space (y down); the parent
 * group flips it into world space.
 */

const TERRAIN_CHUNK = 32;
const TERRAIN_DEPTH = 16;

// face shading factors (MeshBasicMaterial * vertexColors, no lights needed)
const SHADE_FRONT = 1.0;
const SHADE_BACK = 0.4;
const SHADE_LEFT = 0.6;
const SHADE_RIGHT = 0.66;
const SHADE_TOP = 0.85;
const SHADE_BOTTOM = 0.5;

class TerrainMesh {
  constructor(parent, level, resources) {
    this.level = level;
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

  _solid(x, y) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return false;
    return this.maskLayer.groundMask[x + y * this.w] !== 0;
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
      this._markDirty(x, y);
    };
    level.setGroundAt = (x, y, palletIndex) => {
      origSet(x, y, palletIndex);
      this._markDirty(x, y);
    };
  }

  _markDirty(x, y) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
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
    // a cleared pixel exposes new side faces in the neighboring chunk
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
    mesh.frustumCulled = true;
    this.group.add(mesh);
    this.chunkMeshes[id] = mesh;
  }

  _buildChunkGeometry(cx, cy) {
    const x0 = cx * TERRAIN_CHUNK;
    const y0 = cy * TERRAIN_CHUNK;
    const cw = Math.min(TERRAIN_CHUNK, this.w - x0);
    const ch = Math.min(TERRAIN_CHUNK, this.h - y0);
    const W = this.w, H = this.h, D = TERRAIN_DEPTH;

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

    // --- front + back faces from greedy rectangles over the chunk's mask ---
    const visited = new Uint8Array(cw * ch);
    for (let ly = 0; ly < ch; ly++) {
      for (let lx = 0; lx < cw; lx++) {
        if (visited[ly * cw + lx] || !this._solid(x0 + lx, y0 + ly)) continue;
        let rw = 1;
        while (lx + rw < cw && !visited[ly * cw + lx + rw] && this._solid(x0 + lx + rw, y0 + ly)) rw++;
        let rh = 1;
        expand: while (ly + rh < ch) {
          for (let i = 0; i < rw; i++) {
            if (visited[(ly + rh) * cw + lx + i] || !this._solid(x0 + lx + i, y0 + ly + rh)) break expand;
          }
          rh++;
        }
        for (let yy = 0; yy < rh; yy++)
          for (let xx = 0; xx < rw; xx++) visited[(ly + yy) * cw + lx + xx] = 1;

        const px = x0 + lx, py = y0 + ly;
        const u0 = px / W, u1 = (px + rw) / W;
        const v0 = py / H, v1 = (py + rh) / H;
        pushQuad(
          [[px, py, D], [px + rw, py, D], [px + rw, py + rh, D], [px, py + rh, D]],
          [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
          SHADE_FRONT
        );
        pushQuad(
          [[px, py, 0], [px + rw, py, 0], [px + rw, py + rh, 0], [px, py + rh, 0]],
          [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
          SHADE_BACK
        );
      }
    }

    // --- side walls where a solid pixel borders empty space ---
    // left/right: vertical runs per column; top/bottom: horizontal runs per row
    for (let lx = 0; lx < cw; lx++) {
      const px = x0 + lx;
      let ly = 0;
      while (ly < ch) {
        const py = y0 + ly;
        if (this._solid(px, py) && !this._solid(px - 1, py)) {
          let run = 1;
          while (ly + run < ch && this._solid(px, y0 + ly + run) && !this._solid(px - 1, y0 + ly + run)) run++;
          const u = (px + 0.5) / W, va = (y0 + ly) / H, vb = (y0 + ly + run) / H;
          pushQuad(
            [[px, y0 + ly, 0], [px, y0 + ly, D], [px, y0 + ly + run, D], [px, y0 + ly + run, 0]],
            [[u, va], [u, va], [u, vb], [u, vb]],
            SHADE_LEFT
          );
          ly += run;
        } else ly++;
      }
      ly = 0;
      while (ly < ch) {
        const py = y0 + ly;
        if (this._solid(px, py) && !this._solid(px + 1, py)) {
          let run = 1;
          while (ly + run < ch && this._solid(px, y0 + ly + run) && !this._solid(px + 1, y0 + ly + run)) run++;
          const u = (px + 0.5) / W, va = (y0 + ly) / H, vb = (y0 + ly + run) / H;
          pushQuad(
            [[px + 1, y0 + ly, 0], [px + 1, y0 + ly, D], [px + 1, y0 + ly + run, D], [px + 1, y0 + ly + run, 0]],
            [[u, va], [u, va], [u, vb], [u, vb]],
            SHADE_RIGHT
          );
          ly += run;
        } else ly++;
      }
    }
    for (let ly = 0; ly < ch; ly++) {
      const py = y0 + ly;
      let lx = 0;
      while (lx < cw) {
        const px = x0 + lx;
        if (this._solid(px, py) && !this._solid(px, py - 1)) {
          let run = 1;
          while (lx + run < cw && this._solid(x0 + lx + run, py) && !this._solid(x0 + lx + run, py - 1)) run++;
          const v = (py + 0.5) / H, ua = (x0 + lx) / W, ub = (x0 + lx + run) / W;
          pushQuad(
            [[x0 + lx, py, 0], [x0 + lx + run, py, 0], [x0 + lx + run, py, D], [x0 + lx, py, D]],
            [[ua, v], [ub, v], [ub, v], [ua, v]],
            SHADE_TOP
          );
          lx += run;
        } else lx++;
      }
      lx = 0;
      while (lx < cw) {
        const px = x0 + lx;
        if (this._solid(px, py) && !this._solid(px, py + 1)) {
          let run = 1;
          while (lx + run < cw && this._solid(x0 + lx + run, py) && !this._solid(x0 + lx + run, py + 1)) run++;
          const v = (py + 0.5) / H, ua = (x0 + lx) / W, ub = (x0 + lx + run) / W;
          pushQuad(
            [[x0 + lx, py + 1, 0], [x0 + lx + run, py + 1, 0], [x0 + lx + run, py + 1, D], [x0 + lx, py + 1, D]],
            [[ua, v], [ub, v], [ub, v], [ua, v]],
            SHADE_BOTTOM
          );
          lx += run;
        } else lx++;
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
