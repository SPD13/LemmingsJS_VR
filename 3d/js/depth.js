"use strict";
/**
 * Depth compositing (plan §5.1): a per-pixel depth-class buffer built
 * alongside groundImage/groundMask.
 *
 * The sim's compositor (GroundRenderer) is hooked only to stash the terrain
 * piece list it was given; we then replay the same composite order, stamping
 * each piece's profile-assigned depth class with the exact transparency /
 * noOverwrite / onlyOverwrite / isErase semantics of Frame.setPixel. A final
 * reconcile pass forces the invariant depth>0 <=> pixel solid, so a
 * replication bug can only ever misclassify a pixel, never disagree with the
 * collision mask.
 */

const DepthClass = { EMPTY: 0, BACKDROP: 1, TERRAIN: 2, RELIEF: 3, OVERLAY: 4 };
const DepthClassByName = { backdrop: 1, terrain: 2, relief: 3, overlay: 4 };

/** Z band and front-face shading per class (indexed by DepthClass). */
const DEPTH_BANDS = [
  null,
  { back: 0, front: 3, frontShade: 0.62 },  // BACKDROP: recessed, dimmed
  { back: 0, front: 16, frontShade: 1.0 },  // TERRAIN: the main slab
  { back: 0, front: 22, frontShade: 1.0 },  // RELIEF: proud of the slab
  { back: 0, front: 18, frontShade: 1.0 },  // OVERLAY: thin decal layer
];

// Stash the level reader + terrain images the compositor was given, so the
// depth pass can replay the same piece list. Sim behavior is unchanged.
(function installGroundRendererHook() {
  // under node (tools/profiles-test.js) there is no DOS engine to hook
  if (typeof Lemmings === "undefined" || !Lemmings.GroundRenderer) return;
  if (Lemmings.GroundRenderer.__lem3dHooked) return;
  Lemmings.GroundRenderer.__lem3dHooked = true;
  const orig = Lemmings.GroundRenderer.prototype.createGroundMap;
  Lemmings.GroundRenderer.prototype.createGroundMap = function (lr, terraImages) {
    orig.call(this, lr, terraImages);
    window.__lem3dGroundData = { lr, terraImages };
  };
})();

/** Loads per-tileset profile JSON; a missing profile is not an error. */
const DepthProfiles = {
  _cache: new Map(),
  async load(url) {
    if (this._cache.has(url)) return this._cache.get(url);
    let profile = null;
    try {
      const res = await fetch(url);
      if (res.ok) profile = await res.json();
    } catch (e) { /* no profile: flag-based defaults apply */ }
    this._cache.set(url, profile);
    return profile;
  },
};

/**
 * Depth class for one placed terrain piece. Default: everything drawn is
 * TERRAIN — in Lemmings nearly every drawn pixel is standable ground, so
 * draw flags (noOverwrite/onlyOverwrite) are compositing hints, not reliable
 * depth intent. backdrop/relief/overlay come only from explicit profile
 * tags (the piece editor). Entrances/exits are objects, not terrain pieces,
 * and never enter the depth buffer.
 */
/** What a placed piece is tagged by: its name (Lemmix styles) or its numeric id (DOS tilesets). */
function pieceKey(piece) { return piece.key != null ? piece.key : piece.id; }

function depthClassForPiece(piece, profile) {
  const terrainCfg = (profile && profile.terrain) || {};
  const byId = terrainCfg.byId || {};
  const override = DepthClassByName[byId[pieceKey(piece)]];
  if (override) return override;
  return DepthClassByName[terrainCfg.default] || DepthClass.TERRAIN;
}

/** Maximum colour-keyed relief on terrain, in game pixels. */
const RELIEF_MAX = 4;

/**
 * How far a slice of a sculpted piece (the "3D object" tag) may stand proud of
 * its class band, in game pixels. A slice stands its own radius
 * (sculptRadius), and this is the cap on it.
 */
const SCULPT_MAX = 24;

/**
 * The most relief any pixel can carry, whichever effect put it there: what the
 * mesher keys greedy rectangles by, what the picker clips its ray to, what the
 * VR bar stands in front of.
 */
const RELIEF_TOP = Math.max(RELIEF_MAX, SCULPT_MAX);

/**
 * Piece id per pixel (stored as id+1; 0 = no piece), replaying the compositor
 * in the same order as buildDepthMap. Lets per-piece settings — like the
 * colour-keyed relief below — be resolved for any pixel.
 */
function buildPieceMap(level, groundData) {
  const W = level.width, H = level.height;
  const map = new Uint16Array(W * H);
  const usable = groundData && groundData.lr &&
    groundData.lr.levelWidth === W && groundData.lr.levelHeight === H &&
    Array.isArray(groundData.lr.terrains);
  if (!usable) return map;

  for (const piece of groundData.lr.terrains) {
    const src = groundData.terraImages[piece.id];
    if (!src) continue;
    const pixBuf = src.frames[0];
    const w = src.width, h = src.height;
    const props = piece.drawProperties;
    for (let y = 0; y < h; y++) {
      const outY = y + piece.y;
      if (outY < 0 || outY >= H) continue;
      const sourceY = props.isUpsideDown ? (h - y - 1) : y;
      for (let x = 0; x < w; x++) {
        if ((pixBuf[sourceY * w + x] & 0x80) !== 0) continue; // transparent
        const outX = x + piece.x;
        if (outX < 0 || outX >= W) continue;
        const idx = outY * W + outX;
        if (props.isErase) { map[idx] = 0; continue; }
        if (props.noOverwrite && map[idx] !== 0) continue;
        if (props.onlyOverwrite && map[idx] === 0) continue;
        map[idx] = (piece.id + 1) & 0xffff;
      }
    }
  }
  return map;
}

/**
 * Colour-keyed relief setting for a piece id, from the profile's emboss map:
 *   false     -> "off"     (no relief)
 *   "invert"  -> "invert"  (darker pixels are the raised ones)
 *   otherwise -> "normal"  (lighter pixels are raised; the default)
 * Pieces opt out, not in.
 */
function embossModeFor(pieceId, profile) {
  const cfg = (profile && profile.emboss) || {};
  const byId = cfg.byId || {};
  const value = Object.prototype.hasOwnProperty.call(byId, pieceId)
    ? byId[pieceId] : cfg.default;
  if (value === false) return "off";
  if (value === "invert") return "invert";
  return "normal";
}

function embossEnabledFor(pieceId, profile) {
  return embossModeFor(pieceId, profile) !== "off";
}

function embossInvertedFor(pieceId, profile) {
  return embossModeFor(pieceId, profile) === "invert";
}

/**
 * The "3D object" tag: is the piece a flat rendering of a solid object, to be
 * given that object's shape back.
 *
 * A tileset's shading is a light on a surface. An artist drawing a bottle or
 * a sausage shades it in bands running the length of it - a cylinder lit from
 * one side is light along that side, dark along the other, and the band in
 * between, the one facing the viewer, is the nearest point of the body. So
 * the shade of a pixel says which way its bit of surface *faces*, not how
 * near it is: the light rim and the dark rim are at the same depth, and no
 * reading of brightness as height gets that right. (The colour-keyed relief
 * above does read brightness as height, as a few pixels of grain, which is
 * fine for texture and wrong for a body.)
 *
 * What the shading does say is which way the body runs: the bands lie along
 * the axis, so the brightness changes *across* it. A sculpted piece is read
 * as a body turned on that axis - a lathe: every run of pixels across the
 * axis is one round slice, as deep as it is wide (sculptRadius), with a
 * semicircle for its profile. That gives a bottle its neck and shoulders
 * from its outline, the cone of its tip from the rows narrowing, and both
 * rims at the band's face with the middle standing proud, whichever side the
 * artist lit it from. The outline is the sprite's own, so a part of it
 * covered by another piece still shapes the part that shows.
 *
 * Pieces opt in: most drawn pixels are ground, not objects, and ground read
 * as a body would stand out of the slab as a row of bumps.
 */
function sculptFor(pieceId, profile) {
  const cfg = (profile && profile.sculpt) || {};
  const byId = cfg.byId || {};
  const value = Object.prototype.hasOwnProperty.call(byId, pieceId)
    ? byId[pieceId] : cfg.default;
  return value === true;
}

/**
 * How far a round slice `width` pixels across stands proud at its middle:
 * its radius, since a round thing is as deep as it is wide, capped at
 * SCULPT_MAX so a wide barrel does not stand out of the board.
 */
function sculptRadius(width) {
  return Math.min(SCULPT_MAX, width / 2);
}

/** How many colours one blended wall may draw from. */
const BLEND_PALETTE_MAX = 6;
/**
 * Channel-delta sum (|dR|+|dG|+|dB|) below which two colours count as one.
 * It does two jobs: it keeps a palette from filling up with six shades of the
 * same green, and - the reason it exists - it lets a zone grow through the
 * one-pixel anti-aliased fringe some styles draw, so the fringe cannot wall a
 * colour region off from the colour it actually borders. On a flat-palette
 * sprite (the orig_* styles, every DOS tileset) it changes nothing.
 */
const BLEND_MERGE = 24;

/**
 * Surface blend for a piece: may its extruded side walls draw the sprite's
 * other colours down the depth instead of repeating the surface pixel's one.
 *
 * Pieces opt out, not in, as they do of the colour-keyed relief and the colour
 * blend: a wall smearing one pixel's colour the whole depth is what turns a
 * shaded sprite into a monolithic cliff, so the blend is the better default
 * and a tag is worth spending on the pieces it does not suit.
 */
function surfaceBlendFor(pieceId, profile) {
  const cfg = (profile && profile.blend) || {};
  const byId = cfg.byId || {};
  const value = Object.prototype.hasOwnProperty.call(byId, pieceId)
    ? byId[pieceId] : cfg.default;
  return value !== false;
}

/** Perceived brightness of a packed 0xRRGGBB colour. */
function blendLuma(rgb) {
  return (((rgb >> 16) & 255) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000;
}

/** Are two packed colours the same to within BLEND_MERGE. */
function blendNear(a, b) {
  return Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)) +
         Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) +
         Math.abs((a & 255) - (b & 255)) <= BLEND_MERGE;
}

/**
 * Colour blend for a piece: should its pixels' colours run into each other
 * instead of meeting at a hard edge, in x and y across its faces and in z down
 * the walls between two heights.
 *
 * Pieces opt out, not in, as they do of the colour-keyed relief above: what
 * the blend is for - a sprite reading as a surface rather than as the grid it
 * was drawn on - is wanted almost everywhere, so a tag is worth spending on
 * the exceptions rather than on the rule. The master switch in the 3D effects
 * drawer still gates the lot, which is where the cost is answered: a blended
 * pixel cannot merge into a greedy rectangle, since a rectangle has no corners
 * to carry the colours of the pixels inside it.
 */
function colorBlendFor(pieceId, profile) {
  const cfg = (profile && profile.colorBlend) || {};
  const byId = cfg.byId || {};
  const value = Object.prototype.hasOwnProperty.call(byId, pieceId)
    ? byId[pieceId] : cfg.default;
  return value !== false;
}

/**
 * Per-pixel flag: 1 where the pixel's piece takes the colour blend - which is
 * every piece that has not been tagged out of it. `enabled` false (the master
 * switch off) returns a flat map, exactly as buildReliefMap does for the
 * relief, and so does a level with no piece list to read (a special level):
 * slot 0 of the table is "no piece", and it is never on.
 */
function buildColorBlendMap(level, pieceMap, profile, enabled, groundData) {
  const W = level.width, H = level.height;
  const map = new Uint8Array(W * H);
  if (!enabled || !pieceMap || !groundData) return map;

  const images = (groundData && groundData.terraImages) || {};
  let maxId = 254;
  for (const id of Object.keys(images)) maxId = Math.max(maxId, +id);
  const onById = new Uint8Array(maxId + 2);
  for (let id = 0; id <= maxId; id++) {
    const key = images[id] && images[id].name != null ? images[id].name : id;
    if (colorBlendFor(key, profile)) onById[id + 1] = 1;
  }

  const mask = level.getGroundMaskLayer().groundMask;
  for (let i = 0; i < W * H; i++) {
    if (mask[i] && onById[pieceMap[i]]) map[i] = 1;
  }
  return map;
}

/**
 * Which colours each pixel of a blend-tagged piece may use down its extrusion,
 * and where in the level texture each of those colours can be sampled from.
 *
 * The rule is adjacency, not "any colour of the sprite": the level is cut into
 * zones of one colour (a flood fill that grows through colours within
 * BLEND_MERGE of the zone's seed, and stops at anything else), and a zone's
 * palette is its own colour plus the colours that touch it. A dark green
 * touched five pixels away by a light green may use that light green; a brown
 * at the far end of the sprite, touching nothing of the zone, may not.
 * Adjacency stays inside one piece id, so a sprite looks the same wherever it
 * is placed instead of borrowing from whatever was drawn next to it.
 *
 * Each kept colour is remembered as a *donor*: one solid pixel of the level
 * carrying it. The mesh points a wall band's uv at that pixel's texel, so the
 * colour comes out of the texture already there - see terrain.js, which also
 * explains why those few texels have to be pinned against being dug away.
 *
 * Returns { slot, donors }: `slot` is slot+1 per pixel (0 = do not blend),
 * `donors` one array of {index, r, g, b} per slot. Zones that end up with a
 * single colour are dropped - blending them would be a no-op.
 */
function buildBlendMap(level, pieceMap, profile, groundData) {
  const W = level.width, H = level.height, N = W * H;
  const slot = new Uint16Array(N);
  const nothing = { slot, donors: [] };
  if (!pieceMap || !groundData) return nothing;

  // which piece ids take the blend - all of them bar the ones tagged out (a
  // Lemmix piece is tagged by name, so the id is looked up through its image,
  // as buildReliefMap does). Slot 0 is "no piece" and is never on, so a level
  // with no piece list to read comes out blank, as it did before.
  const images = groundData.terraImages || {};
  let maxId = 254;
  for (const id of Object.keys(images)) maxId = Math.max(maxId, +id);
  const blendById = new Uint8Array(maxId + 2);
  for (let id = 0; id <= maxId; id++) {
    const key = images[id] && images[id].name != null ? images[id].name : id;
    if (surfaceBlendFor(key, profile)) blendById[id + 1] = 1;
  }

  const img = level.groundImage;
  const mask = level.getGroundMaskLayer().groundMask;
  const rgbAt = (i) => {
    const o = i * 4;
    return ((img[o] << 16) | (img[o + 1] << 8) | img[o + 2]) >>> 0;
  };
  // only a solid pixel of a tagged piece takes part - so a donor is never one
  // of the pixels the engine blanks to black when it is dug away
  const eligible = (i) => mask[i] !== 0 && blendById[pieceMap[i]] !== 0;

  // --- zones: a colour-tolerant flood fill, compared against the seed so a
  // gradient cannot drift one zone across the whole sprite
  const zoneOf = new Int32Array(N).fill(-1);
  const zones = [];
  const stack = [];
  for (let s = 0; s < N; s++) {
    if (zoneOf[s] >= 0 || !eligible(s)) continue;
    const id = zones.length;
    const pid = pieceMap[s];
    const seed = rgbAt(s);
    const zone = { colour: seed, sample: s, border: new Map(), borderAt: new Map() };
    zones.push(zone);
    zoneOf[s] = id;
    stack.length = 0;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      const x = i % W, y = (i / W) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
        const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const j = ny * W + nx;
        if (pieceMap[j] !== pid || !eligible(j)) continue;
        const c = rgbAt(j);
        if (blendNear(c, seed)) {
          if (zoneOf[j] < 0) { zoneOf[j] = id; stack.push(j); }
          continue;
        }
        zone.border.set(c, (zone.border.get(c) || 0) + 1); // a colour that touches it
        if (!zone.borderAt.has(c)) zone.borderAt.set(c, j);
      }
    }
  }

  // --- one palette per zone, deduped into slots: many zones of a tileset end
  // up with the same colours, and they can share a slot
  const donors = [];
  const bySignature = new Map();
  const slotOfZone = new Int32Array(zones.length);
  for (let zi = 0; zi < zones.length; zi++) {
    const zone = zones[zi];
    const kept = [{ rgb: zone.colour, index: zone.sample }];
    const touching = Array.from(zone.border.entries()).sort((a, b) => b[1] - a[1]);
    for (const [c] of touching) {
      if (kept.length >= BLEND_PALETTE_MAX) break;
      if (kept.some((k) => blendNear(k.rgb, c))) continue;
      kept.push({ rgb: c, index: zone.borderAt.get(c) });
    }
    if (kept.length < 2) continue; // nothing to blend with
    kept.sort((a, b) => blendLuma(b.rgb) - blendLuma(a.rgb)); // lightest first
    const signature = kept.map((k) => k.rgb).join(",");
    let s = bySignature.get(signature);
    if (s === undefined) {
      donors.push(kept.map((k) => ({
        index: k.index,
        r: (k.rgb >> 16) & 255, g: (k.rgb >> 8) & 255, b: k.rgb & 255,
      })));
      s = donors.length; // stored as slot+1
      bySignature.set(signature, s);
    }
    slotOfZone[zi] = s;
  }
  if (!donors.length) return nothing;

  for (let i = 0; i < N; i++) {
    const z = zoneOf[i];
    if (z >= 0) slot[i] = slotOfZone[z];
  }
  return { slot, donors };
}

/**
 * Per-pixel relief height keyed off pixel brightness: the tilesets shade a
 * single hue, so lighter pixels read as raised. Two readings share the map:
 *
 * - the colour-keyed relief (the "3D shade" tag): 0..RELIEF_MAX of grain on
 *   every piece not tagged out, the brightness range measured across the
 *   pixels actually being embossed, so every tileset uses the full range
 *   instead of a fixed global threshold;
 * - the sculpt (the "3D object" tag, sculptFor): the tagged pieces read as
 *   bodies turned on the axis their shading runs along, which replaces the
 *   grain on those pixels and is left out of the grain's range.
 *
 * `enabled` false (the 3D-terrain switch off) returns a flat map: the switch
 * is where the triangle count is answered, and both readings cost the same.
 */
function buildReliefMap(level, pieceMap, profile, enabled, groundData) {
  const W = level.width, H = level.height;
  const relief = new Uint8Array(W * H);
  if (!enabled) return relief;

  // per piece id (stored as id+1, 0 = no piece): the emboss - 0 = off, 1 =
  // lighter is higher, 2 = darker is higher - and whether the piece is
  // sculpted. A Lemmix level's pieces are tagged by name, so the id is
  // looked up through its image.
  const images = (groundData && groundData.terraImages) || {};
  let maxId = 254;
  for (const id of Object.keys(images)) maxId = Math.max(maxId, +id);
  const embossById = new Uint8Array(maxId + 2);
  const sculptById = new Uint8Array(maxId + 2);
  let anySculpt = false;
  for (let id = 0; id <= maxId; id++) {
    const key = images[id] && images[id].name != null ? images[id].name : id;
    const mode = embossModeFor(key, profile);
    embossById[id + 1] = mode === "off" ? 0 : mode === "invert" ? 2 : 1;
    if (images[id] && sculptFor(key, profile)) {
      sculptById[id + 1] = 1;
      anySculpt = true;
    }
  }

  const img = level.groundImage;
  const mask = level.getGroundMaskLayer().groundMask;
  const luma = (i) => {
    const o = i * 4;
    return (img[o] * 299 + img[o + 1] * 587 + img[o + 2] * 114) / 1000;
  };

  // --- the grain, over every embossed pixel that is not a sculpted one
  let lo = 255, hi = 0;
  for (let i = 0; i < W * H; i++) {
    const p = pieceMap[i];
    if (!mask[i] || !embossById[p] || sculptById[p]) continue;
    const l = luma(i);
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  if (hi > lo) {
    for (let i = 0; i < W * H; i++) {
      const p = pieceMap[i];
      const mode = embossById[p];
      if (!mask[i] || !mode || sculptById[p]) continue;
      const t = (luma(i) - lo) / (hi - lo);
      relief[i] = Math.round((mode === 2 ? 1 - t : t) * RELIEF_MAX);
    }
  }

  if (anySculpt) sculptRelief(relief, W, H, pieceMap, mask, luma, sculptById, groundData);
  return relief;
}

/**
 * The sculpted pieces' heights, written into `relief` over their pixels.
 *
 * First the axis, per piece id: the shading's bands run along it, so the
 * brightness changes more *across* it than along it. Summed over the piece's
 * visible pixels, a bigger change from a pixel to its right-hand neighbour
 * than to the one below says the bands are upright and the body stands
 * (a bottle: sliced row by row), the other way round says it lies (a
 * sausage: sliced column by column). A piece of one flat colour has no
 * bands, and is turned on its longer side.
 *
 * Then the lathe, per placement: each row (or column) of the sprite is cut
 * into its runs of solid pixels, and every run is one round slice - a
 * semicircle as deep as the run's radius (sculptRadius), its rims at the
 * band's face and its middle standing proud. The runs come from the sprite,
 * not from what shows, so a slice half hidden behind another piece keeps
 * its true width; only the pixels the level draws for the piece are written.
 * Later placements overwrite earlier ones, in the compositor's own order.
 */
function sculptRelief(relief, W, H, pieceMap, mask, luma, sculptById, groundData) {
  const usable = groundData && groundData.lr && Array.isArray(groundData.lr.terrains) &&
    groundData.lr.levelWidth === W && groundData.lr.levelHeight === H;
  if (!usable) return;

  // --- the axis: change across x against change across y, per piece id
  const ids = sculptById.length;
  const dx = new Float64Array(ids), dy = new Float64Array(ids);
  for (let i = 0; i < W * H; i++) {
    const p = pieceMap[i];
    if (!mask[i] || !sculptById[p]) continue;
    const l = luma(i);
    const x = i % W;
    if (x + 1 < W && mask[i + 1] && pieceMap[i + 1] === p) dx[p] += Math.abs(l - luma(i + 1));
    if (i + W < W * H && mask[i + W] && pieceMap[i + W] === p) dy[p] += Math.abs(l - luma(i + W));
  }

  // --- the lathe
  const images = groundData.terraImages || {};
  for (const piece of groundData.lr.terrains) {
    const p = piece.id + 1;
    if (!sculptById[p]) continue;
    const src = images[piece.id];
    if (!src || !src.frames || !src.frames[0]) continue;
    const pixBuf = src.frames[0];
    const w = src.width, h = src.height;
    const props = piece.drawProperties || {};
    // in the sprite's output orientation (buildPieceMap reads it the same way)
    const solid = (x, y) => {
      const sy = props.isUpsideDown ? (h - y - 1) : y;
      return (pixBuf[sy * w + x] & 0x80) === 0;
    };
    const write = (x, y, z) => {
      const ox = x + piece.x, oy = y + piece.y;
      if (ox < 0 || ox >= W || oy < 0 || oy >= H) return;
      const idx = oy * W + ox;
      if (mask[idx] && pieceMap[idx] === p) relief[idx] = z;
    };
    // upright bands (or none and a tall sprite): the body stands, slice the rows
    const acrossX = dx[p] !== dy[p] ? dx[p] > dy[p] : h >= w;
    const along = acrossX ? h : w, across = acrossX ? w : h;
    for (let a = 0; a < along; a++) {
      const at = (b) => acrossX ? solid(b, a) : solid(a, b);
      for (let b0 = 0; b0 < across;) {
        if (!at(b0)) { b0++; continue; }
        let b1 = b0;
        while (b1 + 1 < across && at(b1 + 1)) b1++;
        const width = b1 - b0 + 1, r = width / 2, amp = sculptRadius(width);
        const centre = b0 + r;
        for (let b = b0; b <= b1; b++) {
          const u = (b + 0.5 - centre) / r;
          const z = Math.round(amp * Math.sqrt(Math.max(0, 1 - u * u)));
          if (acrossX) write(b, a, z); else write(a, b, z);
        }
        b0 = b1 + 1;
      }
    }
  }
}

/**
 * Build the depth buffer for a loaded level.
 * groundData may be null (VGASPEC special levels, or a stale stash): then
 * everything solid falls back to the TERRAIN class.
 */
function buildDepthMap(level, groundData, profile) {
  const W = level.width, H = level.height;
  const depth = new Uint8Array(W * H);

  const usable = groundData && groundData.lr &&
    groundData.lr.levelWidth === W && groundData.lr.levelHeight === H &&
    Array.isArray(groundData.lr.terrains);

  if (usable) {
    const pieces = groundData.lr.terrains;
    for (let p = 0; p < pieces.length; p++) {
      const piece = pieces[p];
      const src = groundData.terraImages[piece.id];
      if (!src) continue;
      const cls = depthClassForPiece(piece, profile);
      const pixBuf = src.frames[0];
      const w = src.width, h = src.height;
      const props = piece.drawProperties;
      for (let y = 0; y < h; y++) {
        const outY = y + piece.y;
        if (outY < 0 || outY >= H) continue;
        const sourceY = props.isUpsideDown ? (h - y - 1) : y;
        for (let x = 0; x < w; x++) {
          const colorIndex = pixBuf[sourceY * w + x];
          if ((colorIndex & 0x80) !== 0) continue; // transparent
          const outX = x + piece.x;
          if (outX < 0 || outX >= W) continue;
          const idx = outY * W + outX;
          if (props.isErase) {
            depth[idx] = DepthClass.EMPTY;
          } else {
            if (props.noOverwrite && depth[idx] !== DepthClass.EMPTY) continue;
            if (props.onlyOverwrite && depth[idx] === DepthClass.EMPTY) continue;
            depth[idx] = cls;
          }
        }
      }
    }
  }

  // authoritative reconcile against the collision mask
  const mask = level.getGroundMaskLayer().groundMask;
  for (let i = 0; i < W * H; i++) {
    depth[i] = mask[i] ? (depth[i] || DepthClass.TERRAIN) : DepthClass.EMPTY;
  }
  return depth;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DepthClass, DepthClassByName, DEPTH_BANDS, DepthProfiles, pieceKey, depthClassForPiece,
    RELIEF_MAX, SCULPT_MAX, RELIEF_TOP, buildPieceMap, embossModeFor, embossEnabledFor, embossInvertedFor,
    sculptFor, sculptRadius,
    BLEND_PALETTE_MAX, BLEND_MERGE, surfaceBlendFor, buildBlendMap,
    colorBlendFor, buildColorBlendMap,
    buildReliefMap, buildDepthMap,
  };
}
