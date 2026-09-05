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
 * A piece taking the *surface blend* - every piece bar the ones tagged out of
 * it - has its side walls cut into bands down
 * the depth, each band drawing one of the colours that touch the pixel's own
 * colour region instead of repeating the surface pixel's (depth.js
 * buildBlendMap). The colours are sampled from ordinary level pixels carrying
 * them - "donors" - which is why _installBlend pins those few texels: the
 * engines blank a dug pixel's RGB to black, and a dug donor would blacken every
 * band aiming at it. Pin RGB only, never alpha.
 *
 * A piece taking the *colour blend* - every piece the master switch covers,
 * bar the ones tagged out of it - has its pixels' colours run into each
 * other instead of meeting at a hard edge: each face corner takes the mean of
 * the pixels of its class meeting there (the colour twin of _cornerZ), and a
 * wall runs from the colour its face ends on at the top, through a diffused
 * reading of the picture, to the colour of the pixel it drops onto at the
 * base - x, y and z (_wallColors). Its shade is per corner as well
 * (_wallShade), mixed from the way the outline faces there, so a staircase of
 * one-pixel steps reads as one rounded surface rather than as alternating
 * stripes down the extrusion. Those quads carry their colour in the vertex
 * attribute and are drawn by a second, map-less material as a second group of
 * the same chunk geometry, since a texture sampled per pixel would put the
 * hard edges straight back. They also need a quad per pixel, as a greedy
 * rectangle has no corners to carry the colours of the pixels inside it - the
 * same shape (and much the same cost) as smooth terrain.
 *
 * The 2D view (setFlat) hides the chunks behind one quad carrying the same
 * texture: the original's terrain, exactly, since the texture is the level's
 * picture with the collision mask for its alpha. The chunks are left alone
 * while it is up and re-meshed once when it comes down.
 */

const TERRAIN_CHUNK = 32;
const TERRAIN_DEPTH = 16; // front Z of the main terrain slab (DepthClass.TERRAIN)
// the decals' skin (decals.js): how far in front of the face it lies, and of
// the 2D view's quad (the objects stand a whole pixel in front of that one)
const DECAL_LIFT = 0.1;
const DECAL_FLAT_LIFT = 0.5;

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
// How far a wall pixel's colour is pulled toward the mean of the eight around
// it, in x and y, before the wall is coloured from it.
//
// A wall is one flat colour down the whole depth of the extrusion, so a row of
// them reads as lines running away from the viewer - worst on the surface the
// lemmings walk along, which is nothing but wall seen end-on, where a pair of
// neighbouring pixels a shade apart becomes a pair of stripes 16 pixels long.
// Diffusing across x and y first damps that difference before it is stretched:
// on the dirt style it takes the step between neighbouring walking-surface
// pixels down by about seven tenths. The face is left alone - the picture is
// read from it directly, and it is not stretched by anything.
const WALL_DIFFUSE = 0.75;
// the eight neighbours it is diffused over
const WALL_DIFFUSE_OFFSETS = [
  [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1],
];
// How far down a wall the face's own colour takes to run out into the
// diffused one, in game pixels. The wall leaves the face in exactly the colour
// the face ends on - no seam - and is the diffused colour from here down, so
// the picture's grain fades with depth rather than stopping dead at the edge.
const WALL_DIFFUSE_DEPTH = 4;

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

// A wall by face id (2 left, 3 right, 4 top, 5 bottom): the pixel it looks
// across at, and the direction it runs along - the columns beside it.
const WALL_ACROSS = { 2: [-1, 0], 3: [1, 0], 4: [0, -1], 5: [0, 1] };
const WALL_ALONG = { 2: [0, 1], 3: [0, 1], 4: [1, 0], 5: [1, 0] };

class TerrainMesh {
  constructor(parent, level, depthMap, reliefMap, resources, blendMap, colorMap, colorSoftness) {
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
    // Colour blend draws its quads from the vertex colours alone - the colour
    // is interpolated across the quad, which is the whole point, and a texture
    // sampled per pixel would put the hard edges straight back. One mesh per
    // chunk still: the two materials are two groups of the same geometry.
    this.colorMaterial = resources.track(
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    );
    this.materials = [this.material, this.colorMaterial];
    this.colorSoftness = 1;
    this._installColorBlend(colorMap, colorSoftness);

    this.chunkMeshes = new Array(this.chunksX * this.chunksY).fill(null);
    this.dirtyChunks = new Set();
    // the decals painted on the face (decals.js): their texture on a skin of
    // per-pixel quads a hair in front of it, one mesh per chunk
    this.decals = null;
    this.decalMaterial = null;
    this.decalMeshes = new Array(this.chunksX * this.chunksY).fill(null);
    this.decalFlatMesh = null;

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

  /**
   * Take the per-pixel colour-blend flags (depth.js buildColorBlendMap). A
   * blended pixel's colours are read from texData rather than groundImage, so
   * a dig and clear-physics mode carry through without a second source of
   * truth - which is also why setPhysicsPaint has to re-mesh while this is on.
   * `softness` is the strength, 0..1: how much of each pixel runs out into
   * the shared colours (1 = all of it; below that a plateau of its own colour
   * is left in the middle - see _buildChunkGeometrySmooth).
   */
  _installColorBlend(colorMap, softness) {
    const on = !!(colorMap && colorMap.some((v) => v !== 0));
    this.color = on ? colorMap : null;
    this.color0 = on ? colorMap.slice() : null; // as built, for resync
    if (softness != null) this.colorSoftness = Math.max(0, Math.min(1, softness));
  }

  /** Swap in new colour-blend flags (the master switch or a tag) and re-mesh. */
  setColorBlend(colorMap, softness) {
    this._installColorBlend(colorMap, softness);
    this._rebuildAll();
  }

  /** Does this pixel's colour run into its neighbours'. */
  _colorAt(x, y) {
    if (!this.color || x < 0 || x >= this.w || y < 0 || y >= this.h) return 0;
    return this.color[x + y * this.w];
  }

  /** The pixel's colour as it is drawn, 0..1 per channel. */
  _rgbAt(x, y) {
    const o = (y * this.w + x) * 4;
    return [this.texData[o] / 255, this.texData[o + 1] / 255, this.texData[o + 2] / 255];
  }

  /**
   * The colour a *wall* takes from a pixel: its own pulled toward the mean of
   * the eight around it in x and y (WALL_DIFFUSE), which is what keeps a row
   * of walls from reading as stripes down the extrusion. Only pixels of the
   * same class count, so a hole or a silhouette cannot darken it. The blur is
   * smooth's alone: at full strength the face is a blur and the walls diffuse
   * to match; below it the face keeps its pixels, and the walls carry the
   * same pixels straight down their depth rather than running off into a blur
   * the face does not have.
   */
  _wallRgb(x, y, cls) {
    const own = this._rgbAt(x, y);
    if (this.colorSoftness < 1) return own;
    let r = own[0], g = own[1], b = own[2], n = 1;
    for (const [dx, dy] of WALL_DIFFUSE_OFFSETS) {
      if (this._classAt(x + dx, y + dy) !== cls) continue;
      const c = this._rgbAt(x + dx, y + dy);
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
    if (n === 1) return own;
    const d = WALL_DIFFUSE;
    return [own[0] + (r / n - own[0]) * d,
            own[1] + (g / n - own[1]) * d,
            own[2] + (b / n - own[2]) * d];
  }

  /**
   * Colour at a pixel corner: the mean of the (up to four) pixels of the same
   * class meeting there - the colour twin of _cornerZ. Averaging is what takes
   * the hard edge off; restricting it to one class keeps the boundaries
   * between depth classes as crisp as their heights are. Empty pixels never
   * count, so the black of a hole or a silhouette cannot bleed into a surface.
   *
   * Every quad meeting at a corner reads the same colour there, whatever the
   * strength: the surface stays continuous, and a wall leaves the face in the
   * colour the face ends on. The strength (colorSoftness) is instead how much
   * of each pixel is given over to reaching these means - see the plateau in
   * _buildChunkGeometrySmooth. `fallback` is what a corner with no pixel of
   * the class around it returns, which a solid pixel's own corner never is.
   */
  _cornerColor(x, y, cls, fallback, diffuse) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 0; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        if (this._classAt(x + dx, y + dy) !== cls) continue;
        const c = diffuse ? this._wallRgb(x + dx, y + dy, cls) : this._rgbAt(x + dx, y + dy);
        r += c[0]; g += c[1]; b += c[2]; n++;
      }
    }
    return n ? [r / n, g / n, b / n] : fallback;
  }

  /**
   * Colour in the middle of a pixel's edge: the mean of the pixel and the
   * neighbour across that edge when it is of the same class, else the pixel's
   * own - the edge twin of _cornerColor, for the plateau's ramps.
   */
  _edgeColor(x, y, nx, ny, cls, own) {
    if (this._classAt(nx, ny) !== cls) return own;
    const c = this._rgbAt(nx, ny);
    return [(own[0] + c[0]) / 2, (own[1] + c[1]) / 2, (own[2] + c[2]) / 2];
  }

  /**
   * The colours down a wall standing on corners `cA` and `cB`, as stops from
   * its top to its base: `{ t, c }`, t the height as a fraction of the
   * wall's span (1 = top, 0 = base) and c the colours across it, one per entry
   * of `fr` - the points across the wall as fractions of the way from A to B,
   * the first and last being the corners themselves and any between them
   * reading the pixel's own colour (the ends of a soft plateau, matching the
   * face's edge exactly).
   *
   * The top is the colour the front face ends on at those corners - the same
   * corner reading, undiffused - so the wall leaves the face without a seam.
   * At full strength WALL_DIFFUSE_DEPTH down it has run out into the diffused
   * reading (_wallRgb), which is what it stays from there; below full strength
   * there is no diffusion and it carries the face's colour straight down. The
   * base is the same the other way up when the wall drops onto a lower class:
   * it runs into the colour that pixel's face begins on. An empty neighbour
   * has nothing to run into.
   *
   * A surface-blended wall is instead cut into bands down its depth, the same
   * bands the textured path cuts (_wallBands), each a donor colour picked per
   * pixel and jittered (_donorPick) so a row of walls reads as grain rather
   * than as one gradient repeated down every column. Each band is a plateau of
   * its colour with a ramp to the next - the plateaus in x carried into z; at
   * full strength the plateaus are points and the bands become one gradient
   * through the picks. A corner point takes the mean of the picks of the two
   * columns sharing it (when the next column stands the same wall of the same
   * slot), so the grain is continuous across the columns as the face is.
   */
  _wallColors(cA, cB, fr, cls, own, px, py, nx, ny, faceId, slot, span) {
    const nCls = this._classAt(nx, ny);
    const empty = nCls === DepthClass.EMPTY;
    const ramp = this.colorSoftness;
    const diffusing = ramp >= 1;
    // a colour per point across the wall: the corners read the corner mean,
    // the points between them the pixel's own
    const pts = fr.map((f, i) => (i === 0 ? cA : i === fr.length - 1 ? cB : null));
    const across = (c, mid, diffuse) =>
      pts.map((p) => (p ? this._cornerColor(p[0], p[1], c, mid, diffuse) : mid));
    const face = across(cls, own);
    const diff = across(cls, this._wallRgb(px, py, cls), true);
    const faceN = empty ? null : across(nCls, this._rgbAt(nx, ny));
    const stops = [{ t: 1, c: face }];
    const bands = slot ? this._blendBands(span) : 1;
    if (bands >= 2) {
      const h = 1 / bands;
      const [ox, oy] = WALL_ALONG[faceId];
      const pick = (k) => {
        const mine = this._donorPick(slot, px, py, faceId, k, bands);
        return pts.map((p) => {
          if (!p) return mine;
          // the column sharing this corner: the one on the corner's side
          const qx = px + (ox ? (p[0] > px ? 1 : -1) : 0);
          const qy = py + (oy ? (p[1] > py ? 1 : -1) : 0);
          if (this._blendAt(qx, qy) !== slot || !this._wallExposed(qx, qy, faceId)) return mine;
          const theirs = this._donorPick(slot, qx, qy, faceId, k, bands);
          return [(mine[0] + theirs[0]) / 2, (mine[1] + theirs[1]) / 2, (mine[2] + theirs[2]) / 2];
        });
      };
      // band 0 is the pixel's own colour, as the textured path keeps the
      // face's uv there; at full strength that is the diffused reading
      stops.push({ t: 1 - h + ramp * h / 2, c: diffusing ? diff : face });
      for (let k = 1; k < bands; k++) {
        const c = pick(k);
        stops.push({ t: 1 - k * h - ramp * h / 2, c });
        stops.push({ t: k === bands - 1 && empty ? 0 : 1 - (k + 1) * h + ramp * h / 2, c });
      }
    } else {
      // the fade takes WALL_DIFFUSE_DEPTH at each end that has a face to
      // leave, and on a short wall no more than half of it each, so the two
      // never cross; with no diffusion there is nothing to fade into, and the
      // wall runs straight from the one face to the other
      const fade = diffusing && span > 0 ? WALL_DIFFUSE_DEPTH / span : 1;
      const d = Math.min(faceN ? 0.5 : 1, fade);
      stops.push({ t: 1 - d, c: diff });
      if (faceN) stops.push({ t: d, c: across(nCls, this._wallRgb(nx, ny, nCls), true) });
      else stops.push({ t: 0, c: diff });
    }
    if (faceN) stops.push({ t: 0, c: faceN });
    // two stops at one height (a short wall's fades meeting, or a plateau
    // shrunk to a point) become one, so no zero-height band is emitted
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].t < stops[i - 1].t) continue;
      const a = stops[i - 1].c, b = stops[i].c;
      stops[i - 1].c = a.map((ca, k) => ca.map((v, j) => (v + b[k][j]) / 2));
      stops.splice(i--, 1);
    }
    return stops;
  }

  /**
   * Shade at a grid corner for the walls of a pixel of class `cls`: the four
   * wall shades mixed by the way the outline faces there, read off the four
   * pixels around the corner - a pixel this class would not drop onto counts
   * as solid, the rest as open, and the normal points from the one to the
   * other. A corner in the middle of a straight run faces straight out and
   * gets that wall's own shade; a corner of a step faces diagonally and gets
   * the mean of the two. Every wall meeting at a corner shares it, so the
   * shading runs smoothly around the outline instead of breaking at each step
   * of the staircase - which, stretched down the whole extrusion, is what
   * made a jagged walking surface a row of alternating stripes. A corner
   * facing nowhere (a checkerboard) falls back to the wall's own shade.
   */
  _wallShade(x, y, cls, fallback) {
    const front = DEPTH_BANDS[cls].front;
    const solid = (px, py) => {
      const c = this._classAt(px, py);
      return c !== DepthClass.EMPTY && DEPTH_BANDS[c].front >= front ? 1 : 0;
    };
    const tl = solid(x - 1, y - 1), tr = solid(x, y - 1);
    const bl = solid(x - 1, y), br = solid(x, y);
    const nx = (tl + bl) - (tr + br); // > 0: the outline faces +x, right
    const ny = (tl + tr) - (bl + br); // > 0: it faces +y, down (y is down here)
    const ax = Math.abs(nx), ay = Math.abs(ny);
    if (!ax && !ay) return fallback;
    return (ax * (nx < 0 ? SHADE_LEFT : SHADE_RIGHT) +
            ay * (ny < 0 ? SHADE_TOP : SHADE_BOTTOM)) / (ax + ay);
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
    const i = this._donorIndex(slot, qx, qy, face, band, bands);
    const u = uv[i * 2], v = uv[i * 2 + 1];
    return [[u, v], [u, v], [u, v], [u, v]];
  }

  /** Which donor of the slot's palette band `band` of a wall of pixel (qx,qy) draws (see _blendUvFor). */
  _donorIndex(slot, qx, qy, face, band, bands) {
    const n = this.blend.donors[slot - 1].length;
    const t = bands > 1 ? band / (bands - 1) : 0;
    const i = Math.round(t * (n - 1)) + (blendHash(qx, qy, face, band) % 3) - 1;
    return Math.max(0, Math.min(n - 1, i));
  }

  /**
   * That donor's colour, read from its texel rather than the colour recorded
   * with it: the texel is what a surface-blended wall samples, so
   * clear-physics mode greys these along with every other face.
   */
  _donorPick(slot, qx, qy, face, band, bands) {
    const d = this.blend.donors[slot - 1][this._donorIndex(slot, qx, qy, face, band, bands)];
    return this._rgbAt(d.index % this.w, (d.index / this.w) | 0);
  }

  /** Does pixel (x,y) stand a wall on face `faceId` - the same test the smooth path's wallBase makes. */
  _wallExposed(x, y, faceId) {
    const c = this._classAt(x, y);
    if (c === DepthClass.EMPTY) return false;
    const [dx, dy] = WALL_ACROSS[faceId];
    const nc = this._classAt(x + dx, y + dy);
    return nc === DepthClass.EMPTY || (nc !== c && DEPTH_BANDS[nc].front < DEPTH_BANDS[c].front);
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

  /**
   * The decals painted on the face (decals.js): the pixels they may cover
   * get a second skin, cut per pixel like the face and lying DECAL_LIFT in
   * front of it - on top of the relief, sloped with it - carrying the decal
   * texture. The 2D view gets one quad of it over the terrain's quad.
   */
  setDecals(decals) {
    this.decals = decals;
    this.decalMaterial = decals ? this.resources.track(new THREE.MeshBasicMaterial({
      map: decals.texture, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    })) : null;
    if (this.decalFlatMesh) {
      this.group.remove(this.decalFlatMesh);
      this.decalFlatMesh = null;
    }
    if (this.flatMesh) this._buildDecalFlat();
    if (this.flat) {
      // the chunks wait for the quad to come down; the skins go with them
      for (let i = 0; i < this.decalMeshes.length; i++) this._dropDecalChunk(i);
    } else {
      this._rebuildAll();
    }
  }

  _buildDecalFlat() {
    if (!this.decals || this.decalFlatMesh) return;
    const geom = this.resources.track(new THREE.PlaneGeometry(1, 1));
    this.decalFlatMesh = new THREE.Mesh(geom, this.decalMaterial);
    this.decalFlatMesh.scale.set(this.w, this.h, 1);
    this.decalFlatMesh.name = "decals-flat";
    this.decalFlatMesh.visible = this.flat;
    this.group.add(this.decalFlatMesh);
    this.decalFlatMesh.position.set(this.w / 2, this.h / 2, this.flatZ + DECAL_FLAT_LIFT);
  }

  _dropDecalChunk(id) {
    const old = this.decalMeshes[id];
    if (!old) return;
    this.chunkGroup.remove(old);
    old.geometry.dispose();
    this.decalMeshes[id] = null;
  }

  /**
   * The skin of one chunk: a quad per covered solid pixel, its corners where
   * the face's are (the same sliding with smooth terrain, the same corner
   * heights with smooth relief), lifted by DECAL_LIFT, mapped onto the
   * level-sized decal texture.
   */
  _rebuildDecalChunk(cx, cy) {
    const id = cy * this.chunksX + cx;
    this._dropDecalChunk(id);
    if (!this.decals) return;
    const coverage = this.decals.coverage;
    const x0 = cx * TERRAIN_CHUNK, y0 = cy * TERRAIN_CHUNK;
    const cw = Math.min(TERRAIN_CHUNK, this.w - x0), ch = Math.min(TERRAIN_CHUNK, this.h - y0);
    const W = this.w, H = this.h;
    const slope = this.smooth && this.hasRelief;
    const positions = [], uvs = [], indices = [];
    for (let ly = 0; ly < ch; ly++) {
      for (let lx = 0; lx < cw; lx++) {
        const px = x0 + lx, py = y0 + ly;
        if (!coverage[px + py * W]) continue;
        const c = this._classAt(px, py);
        if (c === DepthClass.EMPTY) continue;
        const front = this._frontAt(px, py);
        const z00 = (slope ? this._cornerZ(px, py, c, front) : front) + DECAL_LIFT;
        const z10 = (slope ? this._cornerZ(px + 1, py, c, front) : front) + DECAL_LIFT;
        const z11 = (slope ? this._cornerZ(px + 1, py + 1, c, front) : front) + DECAL_LIFT;
        const z01 = (slope ? this._cornerZ(px, py + 1, c, front) : front) + DECAL_LIFT;
        const p00 = this._cornerPos(px, py), p10 = this._cornerPos(px + 1, py);
        const p11 = this._cornerPos(px + 1, py + 1), p01 = this._cornerPos(px, py + 1);
        const base = positions.length / 3;
        positions.push(p00[0], p00[1], z00, p10[0], p10[1], z10, p11[0], p11[1], z11, p01[0], p01[1], z01);
        const u0 = px / W, u1 = (px + 1) / W, v0 = py / H, v1 = (py + 1) / H;
        uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    if (indices.length === 0) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    const mesh = new THREE.Mesh(geom, this.decalMaterial);
    mesh.name = "decals";
    this.chunkGroup.add(mesh);
    this.decalMeshes[id] = mesh;
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
      this._buildDecalFlat();
    }
    if (z != null) this.flatZ = z;
    if (this.flatMesh) this.flatMesh.position.set(this.w / 2, this.h / 2, this.flatZ);
    if (this.decalFlatMesh) this.decalFlatMesh.position.set(this.w / 2, this.h / 2, this.flatZ + DECAL_FLAT_LIFT);
    if (this.flat === on) return;
    this.flat = on;
    this.chunkGroup.visible = !on;
    if (this.flatMesh) this.flatMesh.visible = on;
    if (this.decalFlatMesh) this.decalFlatMesh.visible = on;
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
    // blended quads carry their colour in the geometry, so unlike every other
    // face they do not follow a repaint on their own
    if (this.color) this._rebuildAll();
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
    if (this.color) this.color[i] = 0;
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
          if (this.color) this.color[i] = this.color0[i];
          changed = true;
        } else if (!solid && depth[i] !== DepthClass.EMPTY) {
          depth[i] = DepthClass.EMPTY;
          relief[i] = 0;
          if (this.blend) this.blend.slot[i] = 0;
          if (this.color) this.color[i] = 0;
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
    this._rebuildDecalChunk(cx, cy);
    const geom = this._buildChunkGeometry(cx, cy);
    if (!geom) return;
    const mesh = new THREE.Mesh(geom, geom.groups.length > 1 ? this.materials : this.material);
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
    // colour blend: how much of a pixel runs out to its neighbours' colours
    // (1 = all of it, the plain mean at every corner; less leaves a plateau)
    const ramp = this.colorSoftness;

    const positions = [], colors = [], uvs = [];
    // two buckets over one set of vertices: the textured faces and, for the
    // colour-blended pixels, the ones carrying their colour per corner
    const indices = [], colorIndices = [];
    const pushQuad = (p, uv, shade) => {
      const base = positions.length / 3;
      for (let i = 0; i < 4; i++) {
        positions.push(p[i][0], p[i][1], p[i][2]);
        colors.push(shade, shade, shade);
        uvs.push(uv[i][0], uv[i][1]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    /** A quad whose colour is its four corners', shaded by one factor or one per corner. */
    const pushColorQuad = (p, rgb, shade) => {
      const base = positions.length / 3;
      for (let i = 0; i < 4; i++) {
        const s = Array.isArray(shade) ? shade[i] : shade;
        positions.push(p[i][0], p[i][1], p[i][2]);
        colors.push(rgb[i][0] * s, rgb[i][1] * s, rgb[i][2] * s);
        uvs.push(0, 0);
      }
      colorIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
        // colour blend: the four corners carry the mean of the pixels meeting
        // there, so neighbouring quads share an edge colour and the grid the
        // sprite was drawn on stops reading as a grid
        const blendCol = this._colorAt(px, py);
        const own = blendCol ? this._rgbAt(px, py) : null;
        const cc = blendCol ? [
          this._cornerColor(px, py, c, own), this._cornerColor(px + 1, py, c, own),
          this._cornerColor(px + 1, py + 1, c, own), this._cornerColor(px, py + 1, c, own),
        ] : null;
        const face = (p, shade) => (blendCol ? pushColorQuad(p, cc, shade) : pushQuad(p, uv, shade));
        const frontQuad = [[p00[0], p00[1], z00], [p10[0], p10[1], z10],
                           [p11[0], p11[1], z11], [p01[0], p01[1], z01]];
        if (blendCol && ramp < 1) {
          /*
           * Below full strength the pixel keeps its own colour over a plateau
           * in its middle and only its outer `ramp` runs out to the colours it
           * shares with its neighbours: the corner means at the corners and,
           * along each edge, the mean of the two pixels across it. The next
           * pixel does the same from its side, so the boundary is crossed in a
           * continuous slope `ramp` wide with no step in it, while the pixel
           * survives as a flat of its own colour. A 3x3 grid of quads: the
           * middle one the plateau, the ring around it the ramps.
           */
          const em = [
            this._edgeColor(px, py, px, py - 1, c, own), this._edgeColor(px, py, px + 1, py, c, own),
            this._edgeColor(px, py, px, py + 1, c, own), this._edgeColor(px, py, px - 1, py, c, own),
          ];
          const U = [0, ramp / 2, 1 - ramp / 2, 1];
          const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
          const at = (u, v) => lerp3(lerp3(frontQuad[0], frontQuad[1], u), lerp3(frontQuad[3], frontQuad[2], u), v);
          const col = (i, j) => {
            const iu = i === 0 ? 0 : i === 3 ? 2 : 1, jv = j === 0 ? 0 : j === 3 ? 2 : 1;
            if (iu === 1 && jv === 1) return own;
            if (iu === 1) return jv === 0 ? em[0] : em[2];
            if (jv === 1) return iu === 0 ? em[3] : em[1];
            return cc[jv === 0 ? (iu === 0 ? 0 : 1) : (iu === 0 ? 3 : 2)];
          };
          for (let j = 0; j < 3; j++) {
            for (let i = 0; i < 3; i++) {
              pushColorQuad(
                [at(U[i], U[j]), at(U[i + 1], U[j]), at(U[i + 1], U[j + 1]), at(U[i], U[j + 1])],
                [col(i, j), col(i + 1, j), col(i + 1, j + 1), col(i, j + 1)],
                SHADE_FRONT * band.frontShade);
            }
          }
        } else {
          face(frontQuad, SHADE_FRONT * band.frontShade);
        }
        face([[p00[0], p00[1], band.back], [p10[0], p10[1], band.back],
              [p11[0], p11[1], band.back], [p01[0], p01[1], band.back]],
          SHADE_BACK);

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
        /**
         * One wall of this pixel. A wall is the surface between the pixel and
         * the lower one beside it, so with colour blend on it runs from the
         * colour this pixel's face ends on at the top to the one that pixel's
         * face begins on at the base - the transition in z (_wallColors).
         * Against empty space there is nothing to run to and it keeps the
         * diffused colour down. Its shade is per corner too (_wallShade), so
         * it runs smoothly around the outline.
         *
         * `pA`/`pB` are the wall's two ends on the grid, `cA`/`cB` the corners
         * they stand on (the same corners the front face uses, so the colours
         * meet), `place` lays the four corners - given as A-low, A-high,
         * B-high, B-low - out in the winding the face needs; the positions,
         * colours and shades all go through it, so they cannot come apart.
         */
        const wall = (nx, ny, base, zA, zB, faceId, shade, pA, pB, cA, cB, place) => {
          const at = (loA, hiA, hiB, loB) => place(
            [pA[0], pA[1], loA], [pA[0], pA[1], hiA], [pB[0], pB[1], hiB], [pB[0], pB[1], loB]);
          if (!blendCol) {
            this._wallBands(base, zA, zB, wallUv, slot, faceId, px, py,
              (loA, hiA, hiB, loB, uv) => pushQuad(at(loA, hiA, hiB, loB), uv, shade));
            return;
          }
          // the points across the wall: its two corners and, with a plateau
          // on the face, the plateau's two ends, so the wall's top runs the
          // way the face's edge does and the two meet everywhere along it
          const fr = ramp < 1 ? [0, ramp / 2, 1 - ramp / 2, 1] : [0, 1];
          const stops = this._wallColors(cA, cB, fr, c, own, px, py, nx, ny, faceId, slot, (zA + zB) / 2 - base);
          const sA = this._wallShade(cA[0], cA[1], c, shade);
          const sB = this._wallShade(cB[0], cB[1], c, shade);
          for (let i = 0; i + 1 < fr.length; i++) {
            const fA = fr[i], fB = fr[i + 1];
            const qA = [pA[0] + (pB[0] - pA[0]) * fA, pA[1] + (pB[1] - pA[1]) * fA];
            const qB = [pA[0] + (pB[0] - pA[0]) * fB, pA[1] + (pB[1] - pA[1]) * fB];
            const tA = zA + (zB - zA) * fA, tB = zA + (zB - zA) * fB;
            const shA = sA + (sB - sA) * fA, shB = sA + (sB - sA) * fB;
            const shades = place(shA, shA, shB, shB);
            for (let k = 0; k + 1 < stops.length; k++) {
              const hi = stops[k], lo = stops[k + 1];
              pushColorQuad(
                place([qA[0], qA[1], base + (tA - base) * lo.t], [qA[0], qA[1], base + (tA - base) * hi.t],
                      [qB[0], qB[1], base + (tB - base) * hi.t], [qB[0], qB[1], base + (tB - base) * lo.t]),
                place(lo.c[i], hi.c[i], hi.c[i + 1], lo.c[i + 1]), shades);
            }
          }
        };
        // the two windings the original walls use, kept exactly
        const side = (aLo, aHi, bHi, bLo) => [aLo, aHi, bHi, bLo];
        const cap = (aLo, aHi, bHi, bLo) => [bLo, aLo, aHi, bHi];

        let base = wallBase(px - 1, py);
        if (base !== null) {
          wall(px - 1, py, base, z00, z01, 2, SHADE_LEFT,
            p00, p01, [px, py], [px, py + 1], side);
        }
        base = wallBase(px + 1, py);
        if (base !== null) {
          wall(px + 1, py, base, z10, z11, 3, SHADE_RIGHT,
            p10, p11, [px + 1, py], [px + 1, py + 1], side);
        }
        base = wallBase(px, py - 1);
        if (base !== null) {
          wall(px, py - 1, base, z10, z00, 4, SHADE_TOP,
            p10, p00, [px + 1, py], [px, py], cap);
        }
        base = wallBase(px, py + 1);
        if (base !== null) {
          wall(px, py + 1, base, z11, z01, 5, SHADE_BOTTOM,
            p11, p01, [px + 1, py + 1], [px, py + 1], cap);
        }
      }
    }

    if (indices.length === 0 && colorIndices.length === 0) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices.concat(colorIndices));
    if (colorIndices.length) {
      geom.addGroup(0, indices.length, 0);
      geom.addGroup(indices.length, colorIndices.length, 1);
    }
    return geom;
  }

  /** Is any pixel of this chunk colour-blended (then it needs a quad each). */
  _chunkHasColor(x0, y0, cw, ch) {
    if (!this.color) return false;
    for (let y = y0; y < y0 + ch; y++) {
      const row = y * this.w;
      for (let x = x0; x < x0 + cw; x++) if (this.color[row + x]) return true;
    }
    return false;
  }

  _buildChunkGeometry(cx, cy) {
    // Both smoothings need a quad per pixel to have corners to move. Sloping
    // only differs where heights vary, so with the relief flat and the
    // outline left alone the cheaper greedy stepped path still does.
    // colour blend needs a quad per pixel too: a greedy rectangle has no
    // corners to carry the colours of the pixels inside it
    const x0 = cx * TERRAIN_CHUNK, y0 = cy * TERRAIN_CHUNK;
    const cw = Math.min(TERRAIN_CHUNK, this.w - x0), ch = Math.min(TERRAIN_CHUNK, this.h - y0);
    if (this.smoothTerrain || (this.smooth && this.hasRelief) ||
        this._chunkHasColor(x0, y0, cw, ch)) {
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
    for (const mesh of this.decalMeshes) {
      if (mesh) mesh.geometry.dispose();
    }
    this.group.parent.remove(this.group);
  }
}
