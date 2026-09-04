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

/**
 * Smoothing, for the surfaces drawn as a stack of slices (the "smooth
 * terrain" switch). Extruding pixels leaves a heap of cubes: a staircase
 * around the silhouette and a square cut all the way round the rim. Both are
 * rounded off - the corners of the outline slide along their diagonals, and
 * the rim is thinned to a bevel - so the shape reads as a surface rather than
 * as the pixels it was drawn with.
 */
const SPRITE_SMOOTH_PULL = 0.35;   // how far a corner slides, in pixels
const SPRITE_SMOOTH_BEVEL = 0.4;   // how much of its depth the rim gives up
/**
 * How far inside its own pixel a wall reads the picture, in pixels.
 *
 * A wall's ends sample the pixel's corners rather than its middle, so that the
 * rim leaves the face in the colour the face ends on and two walls meeting at
 * a corner agree on it - which is what stops the top of a surface, which is
 * nothing but rim seen end-on, reading as one flat facet per pixel. The
 * corners themselves are texel boundaries and there is nothing but the gap on
 * the other side of them, so the ends stop just short: near enough for the
 * linear filtering of a colour-blended texture to give almost the whole corner
 * colour, and far enough inside that nearest filtering still rounds to the
 * pixel itself, leaving the square-edged texture exactly as it was.
 */
const SPRITE_WALL_UV_INSET = 0.05;
// What a column keeps of its depth where the next slice has nothing there:
// enough to close the shape off rather than end it in a square wall.
const SPRITE_BLEND_PINCH = 0.15;

/** An explosion particle, in game pixels (see ParticleCloud.updateScale). */
const PARTICLE_SIZE = 2.2;

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
  // Collected per face group and emitted back -> walls -> fronts, so the
  // geometry is also correct in painter's order: overlays that draw without
  // depth testing (the skill toolbar) would otherwise have their dim back
  // faces and side walls paint over the bright front faces.
  const backQuads = [], wallQuads = [], frontQuads = [];
  const pushTo = (list) => (p, uv, shade) => list.push({ p, uv, shade });

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
      pushTo(frontQuads)(
        [[x, y, depth], [x + rw, y, depth], [x + rw, y + rh, depth], [x, y + rh, depth]],
        [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], SPRITE_SHADE_FRONT);
      pushTo(backQuads)(
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
        const IN = SPRITE_WALL_UV_INSET;
        const u = (x + (dir === -1 ? IN : 1 - IN)) / w;
        const va = (y + IN) / h, vb = (y + run - IN) / h;
        pushTo(wallQuads)(
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
        const IN = SPRITE_WALL_UV_INSET;
        const v = (y + (dir === -1 ? IN : 1 - IN)) / h;
        const ua = (x + IN) / w, ub = (x + run - IN) / w;
        pushTo(wallQuads)(
          [[x, wy, 0], [x + run, wy, 0], [x + run, wy, depth], [x, wy, depth]],
          [[ua, v], [ub, v], [ub, v], [ua, v]],
          dir === -1 ? SPRITE_SHADE_TOP : SPRITE_SHADE_BOTTOM);
        x += run;
      }
    }
  }

  const positions = [], colors = [], uvs = [], indices = [];
  for (const q of backQuads.concat(wallQuads, frontQuads)) {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(q.p[i][0], q.p[i][1], q.p[i][2]);
      colors.push(q.shade, q.shade, q.shade);
      uvs.push(q.uv[i][0], q.uv[i][1]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  if (indices.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  return geom;
}

/**
 * A frame split into the body of the thing and whatever floats loose of it.
 *
 * The surfaces are drawn as a stack of slices, and neighbouring slices are
 * blended into one another so the stack reads as one body rather than as
 * layers. That blend has to know what may be joined to what. Water and lava
 * animations carry spray: a pixel or two of foam thrown clear of the surface,
 * and in almost every tileset a droplet in one frame sits exactly where the
 * water is in the next. Blending on distance alone would weld it to the
 * surface, because the distance is nothing.
 *
 * So the parts are told apart by connectivity instead, which is exact. The
 * largest run of touching pixels is the body; everything else is loose, is
 * never blended into anything, and is built from its own pixels only, so no
 * surface can reach from one to the other however close they sit.
 */
function spriteBodyParts(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = [];
  for (let seed = 0; seed < w * h; seed++) {
    if (!mask[seed] || label[seed] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    label[seed] = id;
    stack.push(seed);
    while (stack.length) {
      const i = stack.pop();
      n++;
      const x = i % w, y = (i / w) | 0;
      // touching at a corner counts as joined, as it does on screen
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] && label[j] < 0) { label[j] = id; stack.push(j); }
        }
      }
    }
    sizes.push(n);
  }
  if (!sizes.length) return null;
  let big = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[big]) big = i;
  const body = new Uint8Array(w * h);
  const loose = new Uint8Array(w * h);
  let looseCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (label[i] < 0) continue;
    if (label[i] === big) body[i] = 1;
    else { loose[i] = 1; looseCount++; }
  }
  return { body, loose: looseCount ? loose : null, parts: sizes.length, looseCount };
}

/**
 * One slice of a surface, rounded off in all three directions and blended
 * into the slices either side of it.
 *
 * Across the slice, the outline's corners slide along their diagonals: toward
 * the lone pixel that owns a convex corner, and into the lone gap of a
 * concave one. That turns a staircase into a bevel. A corner with four pixels
 * round it, or two side by side, is not the corner of anything and does not
 * move, which is what keeps a straight edge straight instead of eroding the
 * whole silhouette inward.
 *
 * Through the slice, how far a column reaches toward each face is asked of
 * the neighbouring slice rather than fixed. Where that slice has the same
 * pixel the column runs the full depth and the two meet flush, so the stack
 * is continuous and no groove opens between them. Where it does not, the
 * column closes off short of the face instead of ending in a square wall.
 * At the front and back of the whole stack there is no neighbour to ask, so
 * the rim rolls off there and the stack is rounded rather than cut.
 *
 * `prevAt` and `nextAt` read the body of the slices in front and behind, in
 * this frame's own pixel grid; either is null at the ends of the stack. Loose
 * parts are passed separately and never blended: they keep a rim on both
 * faces and are built from their own pixels, so nothing can join them to the
 * body they float over.
 */
function buildBlendedSpriteGeometry(body, loose, prevAt, nextAt, w, h, depth) {
  const half = depth / 2;
  const at = (m, x, y) => (x >= 0 && x < w && y >= 0 && y < h && m[y * w + x] !== 0);
  const backQuads = [], wallQuads = [], frontQuads = [];

  // a pixel with a gap beside it is on the rim, and gives up some of its depth
  const rimOf = (mask) => (x, y) => (
    !at(mask, x - 1, y) || !at(mask, x + 1, y) ||
    !at(mask, x, y - 1) || !at(mask, x, y + 1)) ? 1 - SPRITE_SMOOTH_BEVEL : 1;

  const emit = (mask, frontFactor, backFactor) => {
    const isSolid = (x, y) => at(mask, x, y);
    // every corner of the grid, worked out once and shared by the (up to
    // four) pixels meeting there - which is what keeps the surface closed
    const corners = new Array((w + 1) * (h + 1));
    const cornerAt = (x, y) => {
      const slot = y * (w + 1) + x;
      let c = corners[slot];
      if (c) return c;
      const a = isSolid(x - 1, y - 1), b = isSolid(x, y - 1);
      const cc = isSolid(x - 1, y), d = isSolid(x, y);
      const n = (a ? 1 : 0) + (b ? 1 : 0) + (cc ? 1 : 0) + (d ? 1 : 0);
      let dx = 0, dy = 0;
      if (n === 1 || n === 3) {
        // toward the odd one out: the single pixel, or the single gap
        const odd = n === 1 ? [a, b, cc, d] : [!a, !b, !cc, !d];
        dx = (odd[0] || odd[2]) ? -1 : 1;
        dy = (odd[0] || odd[1]) ? -1 : 1;
      }
      let fs = 0, bs = 0, k = 0;
      for (const [px, py] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) {
        if (!isSolid(px, py)) continue;
        fs += frontFactor(px, py); bs += backFactor(px, py); k++;
      }
      const f = k ? fs / k : 1, bk = k ? bs / k : 1;
      c = {
        x: x + dx * SPRITE_SMOOTH_PULL, y: y + dy * SPRITE_SMOOTH_PULL,
        front: half + half * f, back: half - half * bk,
      };
      corners[slot] = c;
      return c;
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isSolid(x, y)) continue;
        const c00 = cornerAt(x, y), c10 = cornerAt(x + 1, y);
        const c11 = cornerAt(x + 1, y + 1), c01 = cornerAt(x, y + 1);
        const u0 = x / w, u1 = (x + 1) / w, v0 = y / h, v1 = (y + 1) / h;
        const uv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
        const face = (key) => [[c00.x, c00.y, c00[key]], [c10.x, c10.y, c10[key]],
                               [c11.x, c11.y, c11[key]], [c01.x, c01.y, c01[key]]];
        frontQuads.push({ p: face("front"), uv, shade: SPRITE_SHADE_FRONT });
        backQuads.push({ p: face("back"), uv, shade: SPRITE_SHADE_BACK });

        // the rim, wherever the shape stops. Each end reads the picture just
        // inside the pixel's corner it stands on (SPRITE_WALL_UV_INSET), so
        // the rim runs between the same colours the face is running to and
        // the surface's top - which is nothing but rim seen end-on - carries
        // the blend along it instead of a flat facet per pixel
        const IN = SPRITE_WALL_UV_INSET;
        const uvAt = (right, down) => [(x + (right ? 1 - IN : IN)) / w,
                                       (y + (down ? 1 - IN : IN)) / h];
        const wall = (a, b, shade, uvA, uvB) => wallQuads.push({
          p: [[a.x, a.y, a.back], [a.x, a.y, a.front], [b.x, b.y, b.front], [b.x, b.y, b.back]],
          uv: [uvA, uvA, uvB, uvB], shade,
        });
        if (!isSolid(x - 1, y)) wall(c00, c01, SPRITE_SHADE_LEFT, uvAt(0, 0), uvAt(0, 1));
        if (!isSolid(x + 1, y)) wall(c11, c10, SPRITE_SHADE_RIGHT, uvAt(1, 1), uvAt(1, 0));
        if (!isSolid(x, y - 1)) wall(c10, c00, SPRITE_SHADE_TOP, uvAt(1, 0), uvAt(0, 0));
        if (!isSolid(x, y + 1)) wall(c01, c11, SPRITE_SHADE_BOTTOM, uvAt(0, 1), uvAt(1, 1));
      }
    }
  };

  const bodyRim = rimOf(body);
  emit(body,
    prevAt ? (x, y) => (prevAt(x, y) ? 1 : SPRITE_BLEND_PINCH) : bodyRim,
    nextAt ? (x, y) => (nextAt(x, y) ? 1 : SPRITE_BLEND_PINCH) : bodyRim);
  if (loose) {
    const looseRim = rimOf(loose);
    emit(loose, looseRim, looseRim);
  }

  // back -> walls -> fronts, so the geometry is also correct in painter's order
  const positions = [], colors = [], uvs = [], indices = [];
  for (const q of backQuads.concat(wallQuads, frontQuads)) {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(q.p[i][0], q.p[i][1], q.p[i][2]);
      colors.push(q.shade, q.shade, q.shade);
      uvs.push(q.uv[i][0], q.uv[i][1]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  if (indices.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  return geom;
}

/**
 * Colour blend for the surfaces drawn from sprite frames - water, lava, acid -
 * baked into their texture.
 *
 * The terrain does this in geometry (terrain.js _buildChunkGeometrySmooth): a
 * quad per pixel whose corners carry the mean of the pixels meeting there, so
 * neighbouring pixels share an edge colour and the grid the sprite was drawn
 * on stops reading as a grid. A wave slice cannot be built that way - its
 * faces are greedy rectangles wearing a texture, and its stack is redressed
 * every tick from a cache of shapes shared between pools - so the same colour
 * profile is written into the texture instead and read back out by the
 * sampler. Each pixel is drawn FRAME_BLEND_SCALE texels across, every sub-texel
 * holding the colour the terrain's grid would put at that point of the pixel,
 * and the texture is filtered linearly rather than nearest.
 *
 * `softness` is the strength the terrain takes, 0..1, off the same switch. At
 * 1 a pixel is the plain bilinear of its four corner means and its own colour
 * survives only through them; below that it keeps a plateau of its own colour
 * in the middle and runs out to the shared colours over its outer `softness`,
 * so a boundary is still crossed in a continuous slope with no step in it.
 *
 * Only opaque pixels are averaged, as only pixels of the same class are in the
 * terrain: a transparent neighbour has no colour to lend, just the black it is
 * stored as. That leaves the silhouette, where the sampler goes on
 * interpolating into the transparent texels whatever the averaging did, so
 * those are filled with the mean of the opaque pixels beside them - which is
 * the colour the rim was heading for anyway, and keeps the edge from bleeding
 * dark. Alpha is not blended: a sub-texel is as opaque as the pixel it came
 * from, so the cut stays where it was.
 */
const FRAME_BLEND_SCALE = 4;

function buildBlendedFrameRgba(rgba, w, h, softness) {
  const S = FRAME_BLEND_SCALE;
  const opaque = (x, y) => x >= 0 && x < w && y >= 0 && y < h && rgba[(y * w + x) * 4 + 3] !== 0;
  const rgbAt = (x, y) => {
    const o = (y * w + x) * 4;
    return [rgba[o], rgba[o + 1], rgba[o + 2]];
  };
  /** The mean of whichever of these pixels are opaque, or null for none. */
  const meanOf = (pts) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const [px, py] of pts) {
      if (!opaque(px, py)) continue;
      const c = rgbAt(px, py);
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
    return n ? [r / n, g / n, b / n] : null;
  };
  // the (up to four) pixels meeting at a grid corner, and the two across an edge
  const cornerMean = (x, y) => meanOf([[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]);
  const edgeMean = (x, y, nx, ny) => meanOf([[x, y], [nx, ny]]);
  const NEIGHBOURS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
                              a[2] + (b[2] - a[2]) * t];
  const out = new Uint8Array(w * S * h * S * 4);
  const put = (x, y, i, j, c, a) => {
    const o = (((y * S + j) * w * S) + x * S + i) * 4;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = a;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) {
        // the rim's outside: the colour the pixels beside it are heading for
        const fill = meanOf(NEIGHBOURS.map(([dx, dy]) => [x + dx, y + dy])) || [0, 0, 0];
        for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) put(x, y, i, j, fill, 0);
        continue;
      }
      const own = rgbAt(x, y);
      const cc = [cornerMean(x, y) || own, cornerMean(x + 1, y) || own,
                  cornerMean(x + 1, y + 1) || own, cornerMean(x, y + 1) || own];
      let stops, grid;
      if (softness >= 1) {
        stops = [0, 1];
        grid = [[cc[0], cc[1]], [cc[3], cc[2]]];
      } else {
        // up, right, down, left - the same ring the terrain lays out
        const em = [edgeMean(x, y, x, y - 1) || own, edgeMean(x, y, x + 1, y) || own,
                    edgeMean(x, y, x, y + 1) || own, edgeMean(x, y, x - 1, y) || own];
        stops = [0, softness / 2, 1 - softness / 2, 1];
        grid = [
          [cc[0], em[0], em[0], cc[1]],
          [em[3], own, own, em[1]],
          [em[3], own, own, em[1]],
          [cc[3], em[2], em[2], cc[2]],
        ];
      }
      const cell = (t) => {
        let k = 0;
        while (k < stops.length - 2 && t > stops[k + 1]) k++;
        const a = stops[k], b = stops[k + 1];
        return [k, b > a ? (t - a) / (b - a) : 0];
      };
      for (let j = 0; j < S; j++) {
        const [jv, fv] = cell((j + 0.5) / S);
        for (let i = 0; i < S; i++) {
          const [iu, fu] = cell((i + 0.5) / S);
          put(x, y, i, j, lerp3(
            lerp3(grid[jv][iu], grid[jv][iu + 1], fu),
            lerp3(grid[jv + 1][iu], grid[jv + 1][iu + 1], fu), fv), 255);
        }
      }
    }
  }
  return out;
}

/** Builds (and caches) voxel geometry + material for a game Frame or Mask. */
class SpriteGeometryCache {
  constructor(resources) {
    this.resources = resources;
    this.byFrame = new Map();
    this.byMask = new Map();
    // the surfaces drawn as a stack of slices: the body/loose split per frame,
    // and one rounded, blended shape per (slice in front, this, slice behind).
    // The slices only ever ask for consecutive frames, so there are as many of
    // those as the animation has frames and every pool shares them.
    this.partsByFrame = new Map();
    this.blendedByKey = new Map();
    this.frameIds = new Map();
    this.flatByFrame = new Map();   // the silhouettes of clear physics mode
    this.flatColor = new THREE.Color(0xffffff);
    // the colour blend of the surfaces: the switch's strength, and one
    // material per frame per strength (so a change of strength keeps what it
    // built last time and a change back costs nothing)
    this.blendSoftness = 0;
    this.softByFrame = new Map();
    this._emptyGeom = resources.track(new THREE.BufferGeometry());
  }

  /** The colour blend the surfaces are drawn with from now on, 0 = off. */
  setColorBlend(softness) {
    this.blendSoftness = Math.max(0, Math.min(1, softness || 0));
  }

  /**
   * A frame's shape in one colour (NeoLemmix's CombineFixedColor, how every
   * gadget draws in clear physics mode): a white cut-out of the frame,
   * tinted by the shared colour - one colour for all, set by setFlatColor.
   */
  flatMaterialFor(frame) {
    let material = this.flatByFrame.get(frame);
    if (material) return material;
    const w = frame.width, h = frame.height;
    const mask = frame.getMask();
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      if (mask[i] !== 0) rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = rgba[i * 4 + 3] = 255;
    }
    material = this.resources.track(new THREE.MeshBasicMaterial({
      map: this._makeTexture(rgba, w, h), color: this.flatColor.clone(),
      alphaTest: 0.5, side: THREE.DoubleSide,
    }));
    this.flatByFrame.set(frame, material);
    return material;
  }

  /** The one colour every silhouette wears now. */
  setFlatColor(hex) {
    if (this.flatColor.getHex() === hex) return;
    this.flatColor.setHex(hex);
    for (const m of this.flatByFrame.values()) m.color.setHex(hex);
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

  /** A frame's pixels as RGBA, its mask written into the alpha. */
  _rgbaOf(frame) {
    const w = frame.width, h = frame.height;
    const buf = frame.getBuffer();
    const src = new Uint8Array(buf.buffer, buf.byteOffset, w * h * 4);
    const mask = frame.getMask();
    const rgba = new Uint8Array(w * h * 4);
    rgba.set(src);
    for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = mask[i] ? 255 : 0;
    return rgba;
  }

  /** Frame: Uint32 RGBA pixels + 0/1 transparency mask. */
  forFrame(frame) {
    let entry = this.byFrame.get(frame);
    if (entry) return entry;
    const w = frame.width, h = frame.height;
    const mask = frame.getMask();
    entry = this._makeEntry(this._rgbaOf(frame), (x, y) => mask[y * w + x] !== 0, w, h);
    this.byFrame.set(frame, entry);
    return entry;
  }

  /**
   * The material for one slice of a surface - water, lava, acid - with the
   * colour blend baked into its texture at the strength the switch is on
   * (buildBlendedFrameRgba). Off, this is the frame's ordinary material, so
   * the slices go on sharing it with everything else drawn from that frame.
   *
   * The alpha test is loosened along with the filtering. A quad only ever
   * spans its own pixels' texels, so the alpha it samples never falls below
   * a half - the value at a texel boundary with nothing on the other side -
   * and a test at a half would shave a hairline off every silhouette.
   */
  surfaceMaterialFor(frame) {
    const softness = this.blendSoftness;
    if (!(softness > 0)) return this.forFrame(frame).material;
    let byStrength = this.softByFrame.get(frame);
    if (!byStrength) { byStrength = new Map(); this.softByFrame.set(frame, byStrength); }
    let material = byStrength.get(softness);
    if (material) return material;
    const w = frame.width, h = frame.height;
    const blended = buildBlendedFrameRgba(this._rgbaOf(frame), w, h, softness);
    const S = FRAME_BLEND_SCALE;
    const texture = this.resources.track(
      new THREE.DataTexture(blended, w * S, h * S, THREE.RGBAFormat));
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    material = this.resources.track(new THREE.MeshBasicMaterial({
      map: texture, vertexColors: true, alphaTest: 0.25, side: THREE.DoubleSide,
    }));
    byStrength.set(softness, material);
    return material;
  }

  /** A frame's body and whatever floats loose of it, worked out once. */
  _partsFor(frame) {
    let parts = this.partsByFrame.get(frame);
    if (parts !== undefined) return parts;
    parts = spriteBodyParts(frame.getMask(), frame.width, frame.height);
    this.partsByFrame.set(frame, parts);
    return parts;
  }

  _frameId(frame) {
    if (!frame) return -1;
    let id = this.frameIds.get(frame);
    if (id === undefined) { id = this.frameIds.size; this.frameIds.set(frame, id); }
    return id;
  }

  /**
   * Reads a neighbouring slice's body in `frame`'s own pixel grid. Frames
   * carry their own offsets and need not even be the same size, so the same
   * point of the level is not the same pixel in both.
   */
  _bodyReader(frame, other) {
    if (!other) return null;
    const parts = this._partsFor(other);
    if (!parts) return null;
    const ow = other.width, oh = other.height, body = parts.body;
    const dx = Math.round((frame.offsetX || 0) - (other.offsetX || 0));
    const dy = Math.round((frame.offsetY || 0) - (other.offsetY || 0));
    return (x, y) => {
      const ax = x + dx, ay = y + dy;
      return ax >= 0 && ax < ow && ay >= 0 && ay < oh && body[ay * ow + ax] !== 0;
    };
  }

  /**
   * One slice of a surface, rounded off and blended into the slices either
   * side of it. Pass null for a neighbour at the front or back of the stack.
   * Only the geometry differs from the square-edged cut, so the texture and
   * material are the ones that entry already owns.
   */
  forFrameBlended(prevFrame, frame, nextFrame) {
    const key = this._frameId(prevFrame) + "/" + this._frameId(frame) +
      "/" + this._frameId(nextFrame);
    let entry = this.blendedByKey.get(key);
    if (entry) return entry;
    const flat = this.forFrame(frame);
    const parts = this._partsFor(frame);
    let geometry = null;
    if (parts) {
      geometry = buildBlendedSpriteGeometry(parts.body, parts.loose,
        this._bodyReader(frame, prevFrame), this._bodyReader(frame, nextFrame),
        frame.width, frame.height, SPRITE_DEPTH);
    }
    if (geometry) this.resources.track(geometry);
    else geometry = this._emptyGeom;
    entry = { material: flat.material, geometry, w: flat.w, h: flat.h };
    this.blendedByKey.set(key, entry);
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
  sync(items, zFor, interpolate, flat) {
    const nextPositions = interpolate ? new Map() : null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = item.frame
        ? this.geometryCache.forFrame(item.frame)
        : this.geometryCache.forMask(item.mask);
      const src = item.frame || item.mask;
      const mesh = this._acquire(i);
      mesh.geometry = entry.geometry;
      // clear physics: the shape only, in the one colour
      mesh.material = flat && item.frame ? this.geometryCache.flatMaterialFor(item.frame) : entry.material;
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
      size: PARTICLE_SIZE,
      vertexColors: true,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    parent.add(this.points);
  }

  /**
   * Keep a particle the size of a game pixel whatever the diorama is scaled
   * to. A point's size is a view-space constant in three's shader - it is not
   * carried by the object's scale the way its position is - so the same 2.2
   * that reads as a couple of screen pixels on the desktop covers a headset's
   * eye when the board is 2.5mm to the pixel and an arm's length away.
   */
  updateScale(pxPerUnit) {
    this.points.updateWorldMatrix(true, false);
    const s = new THREE.Vector3().setFromMatrixScale(this.points.matrixWorld);
    // under an orthographic camera (the 2D view) a point's size is plain
    // screen pixels: one level pixel's worth, at the view's zoom
    const size = (pxPerUnit ? Math.max(1, pxPerUnit) : PARTICLE_SIZE) * Math.abs(s.x);
    if (this.material.size !== size) this.material.size = size;
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
