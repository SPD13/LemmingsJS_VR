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
function depthClassForPiece(piece, profile) {
  const terrainCfg = (profile && profile.terrain) || {};
  const byId = terrainCfg.byId || {};
  const override = DepthClassByName[byId[piece.id]];
  if (override) return override;
  return DepthClassByName[terrainCfg.default] || DepthClass.TERRAIN;
}

/** Maximum colour-keyed relief on terrain, in game pixels. */
const RELIEF_MAX = 4;

/**
 * Piece id per pixel (stored as id+1; 0 = no piece), replaying the compositor
 * in the same order as buildDepthMap. Lets per-piece settings — like the
 * colour-keyed relief below — be resolved for any pixel.
 */
function buildPieceMap(level, groundData) {
  const W = level.width, H = level.height;
  const map = new Uint8Array(W * H);
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
        map[idx] = (piece.id + 1) & 0xff;
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
 * Per-pixel relief height (0..RELIEF_MAX) keyed off pixel brightness: the
 * tilesets shade a single hue, so lighter pixels read as raised. The
 * brightness range is measured across the pixels actually being embossed, so
 * every tileset uses the full range instead of a fixed global threshold.
 * `enabled` false (the default) returns a flat map.
 */
function buildReliefMap(level, pieceMap, profile, enabled) {
  const W = level.width, H = level.height;
  const relief = new Uint8Array(W * H);
  if (!enabled) return relief;

  // 0 = off, 1 = lighter is higher, 2 = darker is higher
  const embossById = new Uint8Array(256);
  for (let id = 0; id < 255; id++) {
    const mode = embossModeFor(id, profile);
    embossById[id + 1] = mode === "off" ? 0 : mode === "invert" ? 2 : 1;
  }

  const img = level.groundImage;
  const mask = level.getGroundMaskLayer().groundMask;
  const luma = (i) => {
    const o = i * 4;
    return (img[o] * 299 + img[o + 1] * 587 + img[o + 2] * 114) / 1000;
  };

  let lo = 255, hi = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || !embossById[pieceMap[i]]) continue;
    const l = luma(i);
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  if (hi <= lo) return relief;

  for (let i = 0; i < W * H; i++) {
    const mode = embossById[pieceMap[i]];
    if (!mask[i] || !mode) continue;
    const t = (luma(i) - lo) / (hi - lo);
    relief[i] = Math.round((mode === 2 ? 1 - t : t) * RELIEF_MAX);
  }
  return relief;
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
