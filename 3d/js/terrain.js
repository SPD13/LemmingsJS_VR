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
 *
 * A piece tagged for *surface blend* has its side walls cut into bands down
 * the depth, each band drawing one of the colours that touch the pixel's own
 * colour region instead of repeating the surface pixel's (depth.js
 * buildBlendMap). The colours are sampled from ordinary level pixels carrying
 * them - "donors" - which is why _installBlend pins those few texels: the
 * engines blank a dug pixel's RGB to black, and a dug donor would blacken every
 * band aiming at it. Pin RGB only, never alpha.
 *
 * The 2D view (setFlat) hides the chunks behind one quad carrying the same
 * texture: the original's terrain, exactly, since the texture is the level's
 * picture with the collision mask for its alpha. The chunks are left alone
 * while it is up and re-meshed once when it comes down.
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

// How far a corner of the outline slides along its diagonal when the terrain
// is smoothed across the board (the "smooth terrain" switch), in pixels.
const TERRAIN_SMOOTH_PULL = 0.35;

// Surface blend (depth.js buildBlendMap): a tagged pixel's side wall is cut
// into bands down the extrusion, each band a colour the pixel's own colour
// region touches, instead of one colour smeared the whole depth.
const BLEND_BAND_PX = 4;   // how deep one band is, in game pixels
const BLEND_BANDS_MAX = 4; // and how many a wall is ever cut into
const BLEND_RUN = 4;       // a blended wall run stops at every multiple of this

/**
 * Which colour a band takes, jittered per pixel so a wall reads as grain
 * rather than stripes. Stateless on purpose: a chunk re-meshed after a dig has
 * to come out identical to what it was, so portals.js's waveRandom - a
 * generator carrying state from call to call - is the wrong shape here.
 */
function blendHash(x, y, face, band) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^
          Math.imul(face + 1, 0x9e3779b1) ^ Math.imul(band + 1, 0x85ebca6b);
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return h >>> 0;
}

class TerrainMesh {
  constructor(parent, level, depthMap, reliefMap, resources, blendMap) {
    this.level = level;
    this.depth = depthMap;
    this.relief = reliefMap || new Uint8Array(level.width * level.height);
    // the level as built: a dig or a blast writes EMPTY into the depth (and
    // flattens the relief) as it goes, and a saved state put back can bring
    // those pixels back solid - they take their class and relief from here
    this.depth0 = this.depth.slice();
    this.relief0 = this.relief.slice();
    this.resources = resources;
    this.w = level.width;
    this.h = level.height;
    this.chunksX = Math.ceil(this.w / TERRAIN_CHUNK);
    this.chunksY = Math.ceil(this.h / TERRAIN_CHUNK);
    this.group = new THREE.Group();
    parent.add(this.group);
    this.chunkGroup = new THREE.Group(); // the extruded chunks (3D)
    this.group.add(this.chunkGroup);
    this.flatMesh = null;                // the one quad (2D), built on first use
    this.flat = false;
    this.flatZ = 0;                      // the quad's plane, which the chunks collapse onto

    this.maskLayer = level.getGroundMaskLayer();
    this.hasRelief = this.relief.some((v) => v > 0);
    this.smooth = false;         // slope the relief between heights (z)
    this.smoothTerrain = false;  // round the outline's corners off (x, y)

    // one texture for the whole level; alpha mirrors the solidity mask
    this.texData = new Uint8Array(this.w * this.h * 4);
    this._installBlend(blendMap); // before the refill: it is what stamps the pins
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

  /** Colour-keyed relief height at a pixel (0 when the effect is off). */
  _reliefAt(x, y) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return 0;
    return this.relief[x + y * this.w];
  }

  /** Front face depth of a pixel: its class band plus its relief. */
  _frontAt(x, y) {
    const c = this._classAt(x, y);
    if (c === DepthClass.EMPTY) return null;
    return DEPTH_BANDS[c].front + this._reliefAt(x, y);
  }

  /**
   * Take a blend map (depth.js buildBlendMap) and work out what the mesh needs
   * from it: the donor uvs, and the *pins*.
   *
   * A donor is an ordinary pixel of the level that happens to carry the colour
   * a band wants, and a band is just a quad pointing at that pixel's texel - so
   * blending costs no texture space, and clear-physics mode repaints the donors
   * grey along with everything else. The catch is that both engines blank a dug
   * pixel's RGB to black in groundImage (not only its mask), so a dug donor
   * would turn every band aiming at it black. Hence the pins: the donors' own
   * colours, re-stamped into the texture after any repaint.
   *
   * Pinning RGB is safe because nothing samples a cleared pixel's texel - it
   * emits no front or back quad, walls sample their own pixel, and the 2D quad
   * alpha-tests it away. Never pin alpha: resync() reads it as the record of
   * what is currently drawn.
   */
  _installBlend(blendMap) {
    const on = !!(blendMap && blendMap.donors && blendMap.donors.length);
    this.blend = on ? blendMap : null;
    // as built, for resync: a dug pixel loses its slot and gets it back
    this.blendSlot0 = on ? blendMap.slot.slice() : null;
    this.blendUv = [];
    this.blendPins = [];
    this.blendPinned = new Set();
    if (!on) return;
    const src = this.level.groundImage;
    for (const palette of blendMap.donors) {
      const uv = new Float32Array(palette.length * 2);
      for (let k = 0; k < palette.length; k++) {
        const d = palette[k];
        uv[k * 2] = ((d.index % this.w) + 0.5) / this.w;
        uv[k * 2 + 1] = (((d.index / this.w) | 0) + 0.5) / this.h;
        if (this.blendPinned.has(d.index)) continue;
        this.blendPinned.add(d.index);
        const o = d.index * 4;
        this.blendPins.push({
          index: d.index,
          r: d.r != null ? d.r : src[o],
          g: d.g != null ? d.g : src[o + 1],
          b: d.b != null ? d.b : src[o + 2],
        });
      }
      this.blendUv.push(uv);
    }
  }

  /** The donors' colours put back into the texture (see _installBlend). */
  _paintPins() {
    // in clear-physics mode the level is painted flat greys, and the donors go
    // grey with it - that is the whole point of sampling real pixels
    if (!this.blend || this.physicsPaint) return;
    for (const pin of this.blendPins) {
      const o = pin.index * 4;
      this.texData[o] = pin.r; this.texData[o + 1] = pin.g; this.texData[o + 2] = pin.b;
    }
  }

  /** Blend slot of a pixel (slot+1), 0 where the effect is off. */
  _blendAt(x, y) {
    if (!this.blend || x < 0 || x >= this.w || y < 0 || y >= this.h) return 0;
    return this.blend.slot[x + y * this.w];
  }

  /** How many bands a wall of this depth is cut into (1 = leave it whole). */
  _blendBands(span) {
    return Math.max(1, Math.min(BLEND_BANDS_MAX, Math.round(span / BLEND_BAND_PX)));
  }

  /**
   * The uv of the donor a band draws from, as one pair repeated for all four
   * corners: the palette is sorted lightest first, so the pick walks it as the
   * band goes deeper - darker with depth - jittered a step either way.
   */
  _blendUvFor(slot, qx, qy, face, band, bands) {
    const uv = this.blendUv[slot - 1];
    const n = uv.length / 2;
    const t = bands > 1 ? band / (bands - 1) : 0;
    let i = Math.round(t * (n - 1)) + (blendHash(qx, qy, face, band) % 3) - 1;
    i = Math.max(0, Math.min(n - 1, i));
    const u = uv[i * 2], v = uv[i * 2 + 1];
    return [[u, v], [u, v], [u, v], [u, v]];
  }

  /**
   * A wall, as one quad or as a stack of colour bands down its depth. `emit`
   * draws one band between two heights; `zA`/`zB` are the wall's top at its two
   * ends (they differ only on the smooth path, where the top is sloped), and
   * the frontmost band keeps the face's own uv so the wall still meets the
   * front face exactly.
   */
  _wallBands(base, zA, zB, uv0, slot, face, qx, qy, emit) {
    const bands = slot ? this._blendBands(Math.max(zA, zB) - base) : 1;
    if (bands < 2) { emit(base, zA, zB, base, uv0); return; }
    for (let k = 0; k < bands; k++) {
      const hi = 1 - k / bands, lo = 1 - (k + 1) / bands;
      emit(base + (zA - base) * lo, base + (zA - base) * hi,
           base + (zB - base) * hi, base + (zB - base) * lo,
           k === 0 ? uv0 : this._blendUvFor(slot, qx, qy, face, k, bands));
    }
  }

  /** Greedy-meshing key: pixels merge only with the same class and height. */
  _keyAt(x, y) {
    const c = this._classAt(x, y);
    if (c === DepthClass.EMPTY) return 0;
    return c * (RELIEF_MAX + 1) + this._reliefAt(x, y);
  }

  /** Swap in a new relief map (the 3D-terrain toggle) and re-mesh. */
  setRelief(reliefMap) {
    this.relief = reliefMap || new Uint8Array(this.w * this.h);
    this.relief0 = this.relief.slice();
    this.hasRelief = this.relief.some((v) => v > 0);
    this._rebuildAll();
  }

  /** Swap in a new blend map (a surface-blend tag changed) and re-mesh. */
  setBlend(blendMap) {
    this._installBlend(blendMap);
    this._paintPins();
    this.texture.needsUpdate = true;
    this._rebuildAll();
  }

  /** Slope between neighbouring heights instead of stepping (toggle). */
  setSmooth(smooth) {
    this.smooth = !!smooth;
    this._rebuildAll();
  }

  /** Round the outline's corners off across the board (toggle). */
  setSmoothTerrain(on) {
    on = !!on;
    if (this.smoothTerrain === on) return;
    this.smoothTerrain = on;
    this._rebuildAll();
  }

  /**
   * Where a corner of the pixel grid actually sits.
   *
   * Extruded pixels leave the outline a staircase. Each corner slides along
   * its own diagonal to take the step off: toward the lone pixel that owns a
   * convex corner, and into the lone gap of a concave one. A corner with four
   * pixels around it, or two side by side, is not the corner of anything and
   * stays where it is - which is what keeps a straight edge straight instead
   * of eroding the whole silhouette inward.
   *
   * It reads the depth buffer rather than the chunk, so the same corner comes
   * out the same from either side of a chunk boundary.
   */
  _cornerPos(x, y) {
    if (!this.smoothTerrain) return [x, y];
    const solid = (px, py) => this._classAt(px, py) !== DepthClass.EMPTY;
    const a = solid(x - 1, y - 1), b = solid(x, y - 1);
    const c = solid(x - 1, y), d = solid(x, y);
    const n = (a ? 1 : 0) + (b ? 1 : 0) + (c ? 1 : 0) + (d ? 1 : 0);
    if (n !== 1 && n !== 3) return [x, y];
    const odd = n === 1 ? [a, b, c, d] : [!a, !b, !c, !d];
    const dx = (odd[0] || odd[2]) ? -1 : 1;
    const dy = (odd[0] || odd[1]) ? -1 : 1;
    return [x + dx * TERRAIN_SMOOTH_PULL, y + dy * TERRAIN_SMOOTH_PULL];
  }

  _rebuildAll() {
    if (this.flat) return; // re-meshed once, when the quad comes down
    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cx = 0; cx < this.chunksX; cx++) this._rebuildChunk(cx, cy);
    }
  }

  /**
   * The 2D view: the chunks hidden behind one quad at `z` textured with the
   * level's picture (the texture is kept in step with every dig either way,
   * so the quad shows them at once). Opaque, with an alpha test: the
   * overlays (clear physics, the skill shadows, the ring) are transparent
   * and drawn after all opaque things, so they still read on top of it.
   * Coming back, every chunk is re-meshed from the depth buffer as it stands.
   */
  setFlat(on, z) {
    on = !!on;
    if (on && !this.flatMesh) {
      const geom = this.resources.track(new THREE.PlaneGeometry(1, 1));
      const material = this.resources.track(new THREE.MeshBasicMaterial({
        map: this.texture, alphaTest: 0.5, side: THREE.DoubleSide,
      }));
      this.flatMesh = new THREE.Mesh(geom, material);
      this.flatMesh.scale.set(this.w, this.h, 1);
      this.flatMesh.name = "terrain-flat";
      this.group.add(this.flatMesh);
    }
    if (z != null) this.flatZ = z;
    if (this.flatMesh) this.flatMesh.position.set(this.w / 2, this.h / 2, this.flatZ);
    if (this.flat === on) return;
    this.flat = on;
    this.chunkGroup.visible = !on;
    if (this.flatMesh) this.flatMesh.visible = on;
    if (!on) {
      this.dirtyChunks.clear();
      this._rebuildAll();
    }
  }

  /**
   * Height at a pixel corner: the mean front of the (up to four) pixels of
   * the same class that meet there. Averaging turns the per-pixel columns
   * into a continuous surface; restricting it to one class keeps the
   * boundaries between depth classes crisp.
   */
  _cornerZ(x, y, cls, fallback) {
    let sum = 0, n = 0;
    if (this._classAt(x - 1, y - 1) === cls) { sum += this._frontAt(x - 1, y - 1); n++; }
    if (this._classAt(x, y - 1) === cls) { sum += this._frontAt(x, y - 1); n++; }
    if (this._classAt(x - 1, y) === cls) { sum += this._frontAt(x - 1, y); n++; }
    if (this._classAt(x, y) === cls) { sum += this._frontAt(x, y); n++; }
    return n ? sum / n : fallback;
  }

  _refillTexRect(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) this._paintPixel(x, y);
    }
    this._paintPins();
  }

  /**
   * One texture pixel from the level: its picture, or - with a physics map
   * set (clear physics mode) - NeoLemmix's DrawClearPhysicsTerrain: grey for
   * terrain, darker for steel, bluish where a one-way wall runs the way the
   * one under the pointer does (the highlight bits), every other pixel a
   * shade darker in a fine checker.
   */
  _paintPixel(x, y) {
    const i = (y * this.w + x) * 4, j = y * this.w + x;
    const solid = this.maskLayer.groundMask[j] ? 255 : 0;
    if (this.physicsPaint) {
      const bits = this.physicsPaint[j];
      let c = (bits & 2) ? 0x60 : 0xB0; // PM_STEEL : terrain
      let b = c;
      if (!(bits & 2) && (bits & this.physicsHighlight)) { c = 0x60; b = 0xB0; } // a one-way wall like the pointed one
      const shade = ((x & 1) !== (y & 1)) ? 0x20 : 0;
      this.texData[i] = c - shade; this.texData[i + 1] = c - shade; this.texData[i + 2] = b - shade;
    } else {
      const src = this.level.groundImage;
      this.texData[i] = src[i]; this.texData[i + 1] = src[i + 1]; this.texData[i + 2] = src[i + 2];
    }
    this.texData[i + 3] = solid;
  }

  /** Paint the terrain from this physics map (Uint16Array of PM bits) with these
   *  one-way bits lit, or from its picture again with null. */
  setPhysicsPaint(physics, highlight) {
    highlight = physics ? (highlight | 0) : 0;
    if ((this.physicsPaint || null) === (physics || null) && (this.physicsHighlight | 0) === highlight) return;
    this.physicsPaint = physics || null;
    this.physicsHighlight = highlight;
    this._refillTexRect(0, 0, this.w, this.h);
    this.texture.needsUpdate = true;
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
    const i = x + y * this.w;
    this.depth[i] = depthClass;
    this.relief[i] = 0; // dug holes and built bricks are flat
    if (this.blend) this.blend.slot[i] = 0; // nor are they the tagged piece any more
    this._paintPixel(x, y);
    if (this.blendPinned && this.blendPinned.has(i)) this._paintPins();
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

  /**
   * The level's arrays changed under the mesh without passing through the
   * mutation hooks (a saved state was put back): every pixel whose solidity
   * differs from what is drawn marks its chunk - and the neighbour it
   * borders, for the step walls - the texture is refilled, and only those
   * chunks are re-meshed. A frame back costs a few chunks, not the level.
   *
   * The depth buffer is put back in step too: a pixel dug out and now solid
   * again gets the class and relief the level was built with (a brick's
   * place, empty at the build, is terrain), and one built and now gone is
   * emptied - the meshes are cut from the depth, so without this a restored
   * hole would stay a hole.
   */
  resync() {
    const w = this.w, h = this.h, mask = this.maskLayer.groundMask;
    const depth = this.depth, depth0 = this.depth0, relief = this.relief, relief0 = this.relief0;
    const dirty = this.dirtyChunks;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const solid = mask[i] !== 0;
        let changed = (this.texData[i * 4 + 3] !== 0) !== solid;
        if (solid && depth[i] === DepthClass.EMPTY) {
          depth[i] = depth0[i] !== DepthClass.EMPTY ? depth0[i] : DepthClass.TERRAIN;
          relief[i] = relief0[i];
          if (this.blend) this.blend.slot[i] = this.blendSlot0[i];
          changed = true;
        } else if (!solid && depth[i] !== DepthClass.EMPTY) {
          depth[i] = DepthClass.EMPTY;
          relief[i] = 0;
          if (this.blend) this.blend.slot[i] = 0;
          changed = true;
        }
        if (!changed) continue;
        const cx = Math.floor(x / TERRAIN_CHUNK), cy = Math.floor(y / TERRAIN_CHUNK);
        dirty.add(cy * this.chunksX + cx);
        const lx = x % TERRAIN_CHUNK, ly = y % TERRAIN_CHUNK;
        if (lx === 0 && cx > 0) dirty.add(cy * this.chunksX + cx - 1);
        if (lx === TERRAIN_CHUNK - 1 && cx < this.chunksX - 1) dirty.add(cy * this.chunksX + cx + 1);
        if (ly === 0 && cy > 0) dirty.add((cy - 1) * this.chunksX + cx);
        if (ly === TERRAIN_CHUNK - 1 && cy < this.chunksY - 1) dirty.add((cy + 1) * this.chunksX + cx);
      }
    }
    this._refillTexRect(0, 0, w, h);
    this.texture.needsUpdate = true;
    this.flushDirty(Infinity);
  }

  /** The slab's depth as a fraction of what was built, for the change of
   *  view: the chunks squeezed toward the quad's plane (1 = as built). A
   *  group transform, so nothing is re-meshed. */
  setExtrusion(s) {
    this.chunkGroup.scale.z = s;
    this.chunkGroup.position.z = this.flatZ * (1 - s);
  }

  /** Re-mesh dirty chunks, at most `budget` per call (nuke-proofing). */
  flushDirty(budget = 24) {
    if (this.flat) return; // the quad shows the texture; the chunks wait
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
      this.chunkGroup.remove(old);
      old.geometry.dispose();
      this.chunkMeshes[id] = null;
    }
    const geom = this._buildChunkGeometry(cx, cy);
    if (!geom) return;
    const mesh = new THREE.Mesh(geom, this.material);
    this.chunkGroup.add(mesh);
    this.chunkMeshes[id] = mesh;
  }

  /**
   * Wall span between a pixel and its neighbour, or null. Emitted only from
   * the taller side and only over the exposed height, so two pixels never
   * produce coplanar overlapping walls. Works off per-pixel front heights,
   * so colour-keyed relief gets its own little walls too.
   */
  _wallSpanAt(x, y, nx, ny) {
    const c = this._classAt(x, y);
    if (c === DepthClass.EMPTY) return null;
    const front = this._frontAt(x, y);
    if (this._classAt(nx, ny) === DepthClass.EMPTY) {
      return [DEPTH_BANDS[c].back, front];
    }
    const nFront = this._frontAt(nx, ny);
    if (nFront < front) return [nFront, front];
    return null;
  }

  /**
   * Smooth path: every solid pixel becomes one quad of its own, so the
   * corners can be moved.
   *
   * With "smooth relief" the corners sit at the averaged corner heights, and
   * differing heights slope into each other instead of stepping. With "smooth
   * terrain" they also slide along their diagonals, taking the staircase off
   * the outline. Either way no internal walls are needed - the shared corners
   * cover them - only silhouettes and drops onto a lower depth class.
   */
  _buildChunkGeometrySmooth(cx, cy) {
    const x0 = cx * TERRAIN_CHUNK;
    const y0 = cy * TERRAIN_CHUNK;
    const cw = Math.min(TERRAIN_CHUNK, this.w - x0);
    const ch = Math.min(TERRAIN_CHUNK, this.h - y0);
    const W = this.w, H = this.h;
    // relief is what the sloping is for: with none, every corner of a class
    // is at the same height and averaging them only costs time
    const slope = this.smooth && this.hasRelief;

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

    for (let ly = 0; ly < ch; ly++) {
      for (let lx = 0; lx < cw; lx++) {
        const px = x0 + lx, py = y0 + ly;
        const c = this._classAt(px, py);
        if (c === DepthClass.EMPTY) continue;
        const band = DEPTH_BANDS[c];
        const front = this._frontAt(px, py);
        const z00 = slope ? this._cornerZ(px, py, c, front) : front;
        const z10 = slope ? this._cornerZ(px + 1, py, c, front) : front;
        const z11 = slope ? this._cornerZ(px + 1, py + 1, c, front) : front;
        const z01 = slope ? this._cornerZ(px, py + 1, c, front) : front;
        // shared with the pixels next door, so the surface stays closed
        const p00 = this._cornerPos(px, py), p10 = this._cornerPos(px + 1, py);
        const p11 = this._cornerPos(px + 1, py + 1), p01 = this._cornerPos(px, py + 1);

        const u0 = px / W, u1 = (px + 1) / W;
        const v0 = py / H, v1 = (py + 1) / H;
        const uv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
        pushQuad([[p00[0], p00[1], z00], [p10[0], p10[1], z10],
                  [p11[0], p11[1], z11], [p01[0], p01[1], z01]],
          uv, SHADE_FRONT * band.frontShade);
        pushQuad([[p00[0], p00[1], band.back], [p10[0], p10[1], band.back],
                  [p11[0], p11[1], band.back], [p01[0], p01[1], band.back]],
          uv, SHADE_BACK);

        // a wall only where this pixel overhangs empty space or a lower class
        const wallBase = (nx, ny) => {
          const nc = this._classAt(nx, ny);
          if (nc === DepthClass.EMPTY) return band.back;
          if (nc !== c && DEPTH_BANDS[nc].front < band.front) return DEPTH_BANDS[nc].front;
          return null;
        };
        // walls sample the pixel's own centre: a texel-boundary UV would pick
        // up the neighbour, which at a silhouette is empty (black)
        const uMid = (px + 0.5) / W, vMid = (py + 0.5) / H;
        const wallUv = [[uMid, vMid], [uMid, vMid], [uMid, vMid], [uMid, vMid]];
        // the tops are sloped here, so each end of a band is interpolated on
        // its own corner; the bands are cut per pixel, there is no run to break
        const slot = this._blendAt(px, py);
        let base = wallBase(px - 1, py);
        if (base !== null) {
          this._wallBands(base, z00, z01, wallUv, slot, 2, px, py,
            (loA, hiA, hiB, loB, uv) => pushQuad(
              [[p00[0], p00[1], loA], [p00[0], p00[1], hiA],
               [p01[0], p01[1], hiB], [p01[0], p01[1], loB]], uv, SHADE_LEFT));
        }
        base = wallBase(px + 1, py);
        if (base !== null) {
          this._wallBands(base, z10, z11, wallUv, slot, 3, px, py,
            (loA, hiA, hiB, loB, uv) => pushQuad(
              [[p10[0], p10[1], loA], [p10[0], p10[1], hiA],
               [p11[0], p11[1], hiB], [p11[0], p11[1], loB]], uv, SHADE_RIGHT));
        }
        base = wallBase(px, py - 1);
        if (base !== null) {
          this._wallBands(base, z10, z00, wallUv, slot, 4, px, py,
            (loA, hiA, hiB, loB, uv) => pushQuad(
              [[p00[0], p00[1], loB], [p10[0], p10[1], loA],
               [p10[0], p10[1], hiA], [p00[0], p00[1], hiB]], uv, SHADE_TOP));
        }
        base = wallBase(px, py + 1);
        if (base !== null) {
          this._wallBands(base, z11, z01, wallUv, slot, 5, px, py,
            (loA, hiA, hiB, loB, uv) => pushQuad(
              [[p01[0], p01[1], loB], [p11[0], p11[1], loA],
               [p11[0], p11[1], hiA], [p01[0], p01[1], hiB]], uv, SHADE_BOTTOM));
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

  _buildChunkGeometry(cx, cy) {
    // Both smoothings need a quad per pixel to have corners to move. Sloping
    // only differs where heights vary, so with the relief flat and the
    // outline left alone the cheaper greedy stepped path still does.
    if (this.smoothTerrain || (this.smooth && this.hasRelief)) {
      return this._buildChunkGeometrySmooth(cx, cy);
    }
    return this._buildChunkGeometryStepped(cx, cy);
  }

  _buildChunkGeometryStepped(cx, cy) {
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

    // --- front + back faces from greedy same-class, same-height rectangles ---
    const visited = new Uint8Array(cw * ch);
    for (let ly = 0; ly < ch; ly++) {
      for (let lx = 0; lx < cw; lx++) {
        if (visited[ly * cw + lx]) continue;
        const c = this._classAt(x0 + lx, y0 + ly);
        if (c === DepthClass.EMPTY) continue;
        const key = this._keyAt(x0 + lx, y0 + ly);
        let rw = 1;
        while (lx + rw < cw && !visited[ly * cw + lx + rw] &&
               this._keyAt(x0 + lx + rw, y0 + ly) === key) rw++;
        let rh = 1;
        expand: while (ly + rh < ch) {
          for (let i = 0; i < rw; i++) {
            if (visited[(ly + rh) * cw + lx + i] ||
                this._keyAt(x0 + lx + i, y0 + ly + rh) !== key) break expand;
          }
          rh++;
        }
        for (let yy = 0; yy < rh; yy++)
          for (let xx = 0; xx < rw; xx++) visited[(ly + yy) * cw + lx + xx] = 1;

        const band = DEPTH_BANDS[c];
        const front = this._frontAt(x0 + lx, y0 + ly);
        const px = x0 + lx, py = y0 + ly;
        const u0 = px / W, u1 = (px + rw) / W;
        const v0 = py / H, v1 = (py + rh) / H;
        pushQuad(
          [[px, py, front], [px + rw, py, front],
           [px + rw, py + rh, front], [px, py + rh, front]],
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
          const span = this._wallSpanAt(px, y0 + ly, px + dir, y0 + ly);
          if (!span) { ly++; continue; }
          const slot = this._blendAt(px, y0 + ly);
          let run = 1;
          while (ly + run < ch) {
            const y = y0 + ly + run;
            // a blended run stops on the BLEND_RUN grid rather than merely
            // being capped: the band colours are hashed off the segment's
            // grid cell, so digging one pixel cannot recolour the rest
            if (slot && y % BLEND_RUN === 0) break;
            const c2 = this._classAt(px, y);
            const s2 = this._wallSpanAt(px, y, px + dir, y);
            if (c2 !== c || spanKey(s2) !== spanKey(span)) break;
            if (this._blendAt(px, y) !== slot) break;
            run++;
          }
          const wx = dir === -1 ? px : px + 1;
          const u = (px + 0.5) / W, va = (y0 + ly) / H, vb = (y0 + ly + run) / H;
          const uv0 = [[u, va], [u, va], [u, vb], [u, vb]];
          const shade = dir === -1 ? SHADE_LEFT : SHADE_RIGHT;
          const ya = y0 + ly, yb = y0 + ly + run;
          this._wallBands(span[0], span[1], span[1], uv0, slot,
            dir === -1 ? 2 : 3, px, (ya / BLEND_RUN) | 0,
            (loA, hiA, hiB, loB, uv) => pushQuad(
              [[wx, ya, loA], [wx, ya, hiA], [wx, yb, hiB], [wx, yb, loB]],
              uv, shade));
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
          const span = this._wallSpanAt(x0 + lx, py, x0 + lx, py + dir);
          if (!span) { lx++; continue; }
          const slot = this._blendAt(x0 + lx, py);
          let run = 1;
          while (lx + run < cw) {
            const x = x0 + lx + run;
            if (slot && x % BLEND_RUN === 0) break; // as above: on the grid
            const c2 = this._classAt(x, py);
            const s2 = this._wallSpanAt(x, py, x, py + dir);
            if (c2 !== c || spanKey(s2) !== spanKey(span)) break;
            if (this._blendAt(x, py) !== slot) break;
            run++;
          }
          const wy = dir === -1 ? py : py + 1;
          const v = (py + 0.5) / H, ua = (x0 + lx) / W, ub = (x0 + lx + run) / W;
          const uv0 = [[ua, v], [ub, v], [ub, v], [ua, v]];
          const shade = dir === -1 ? SHADE_TOP : SHADE_BOTTOM;
          const xa = x0 + lx, xb = x0 + lx + run;
          this._wallBands(span[0], span[1], span[1], uv0, slot,
            dir === -1 ? 4 : 5, (xa / BLEND_RUN) | 0, py,
            (loA, hiA, hiB, loB, uv) => pushQuad(
              [[xa, wy, loA], [xb, wy, loB], [xb, wy, hiB], [xa, wy, hiA]],
              uv, shade));
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
