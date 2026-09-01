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
 * Depth class for one placed terrain piece: per-id profile override first,
 * then the piece's own draw flags (noOverwrite pieces sit behind existing
 * terrain, onlyOverwrite pieces are decals on it), then the default.
 */
function depthClassForPiece(piece, profile) {
  const terrainCfg = (profile && profile.terrain) || {};
  const byId = terrainCfg.byId || {};
  const override = DepthClassByName[byId[piece.id]];
  if (override) return override;
  if (piece.drawProperties.noOverwrite) return DepthClass.BACKDROP;
  if (piece.drawProperties.onlyOverwrite) return DepthClass.OVERLAY;
  return DepthClassByName[terrainCfg.default] || DepthClass.TERRAIN;
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
