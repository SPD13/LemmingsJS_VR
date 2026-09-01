"use strict";
/**
 * Entrances and exits as real openings (plan §5.4).
 *
 * Their sprites are perspective drawings of a box - a rim, slanted walls
 * converging inward, and a flat far face - so the artwork already says "this
 * recedes". Rather than key depth off brightness (which would extrude the
 * flat interior as one slab), the opening is rebuilt geometrically: a
 * distance transform of the sprite's own silhouette gives how far inside each
 * pixel lies, and that becomes recession, so the rim stays at the sprite
 * plane and the interior falls away into a tunnel you can look into.
 *
 * The terrain behind an opening is carved from the render-only depth map so
 * the tunnel is not filled in. Collision is never touched: the sim keeps its
 * own ground mask, so this is presentation only.
 */

const PORTAL_ENTRANCE_ID = 1;      // level-object id of an entrance
const PORTAL_DEFAULT_DEPTH = 12;   // game pixels of recession
const PORTAL_EXIT_DEPTH = 14;
const PORTAL_CARVE_MIN = 2;        // interior pixels (by distance) get carved

/** Stash the object list and their metadata as the level is built. */
(function installObjectDataHook() {
  if (Lemmings.Level.__lem3dObjectHook) return;
  Lemmings.Level.__lem3dObjectHook = true;
  const orig = Lemmings.Level.prototype.setMapObjects;
  Lemmings.Level.prototype.setMapObjects = function (objects, objectImg) {
    orig.call(this, objects, objectImg);
    window.__lem3dObjectData = { objects, objectImg };
  };
})();

/**
 * Portal settings for an object, profile first then sensible defaults:
 * entrances and exits are openings, everything else is left flat.
 * Profile shape: objects.byId[<objectId>] = { shape: "portal"|"flat", depth }
 */
function portalConfigFor(objectId, info, profile) {
  const byId = ((profile && profile.objects) || {}).byId || {};
  const entry = byId[objectId];
  if (entry && entry.shape) {
    return entry.shape === "portal"
      ? { depth: entry.depth || PORTAL_DEFAULT_DEPTH } : null;
  }
  if (objectId === PORTAL_ENTRANCE_ID) return { depth: PORTAL_DEFAULT_DEPTH };
  if (info && info.trigger_effect_id === Lemmings.TriggerTypes.EXIT_LEVEL) {
    return { depth: PORTAL_EXIT_DEPTH };
  }
  return null;
}

/**
 * Chebyshev distance from each opaque pixel to the sprite's outline: 1 on the
 * rim, growing toward the middle of the opening. Two passes, in place.
 */
function spriteInteriorDistance(frame) {
  const w = frame.width, h = frame.height, mask = frame.getMask();
  const dist = new Float32Array(w * h);
  const INF = 1e6;
  for (let i = 0; i < w * h; i++) dist[i] = mask[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let m = dist[i];
      if (x > 0) m = Math.min(m, dist[i - 1] + 1);
      if (y > 0) m = Math.min(m, dist[i - w] + 1);
      if (x > 0 && y > 0) m = Math.min(m, dist[i - w - 1] + 1);
      if (x < w - 1 && y > 0) m = Math.min(m, dist[i - w + 1] + 1);
      dist[i] = m;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let m = dist[i];
      if (x < w - 1) m = Math.min(m, dist[i + 1] + 1);
      if (y < h - 1) m = Math.min(m, dist[i + w] + 1);
      if (x < w - 1 && y < h - 1) m = Math.min(m, dist[i + w + 1] + 1);
      if (x > 0 && y < h - 1) m = Math.min(m, dist[i + w - 1] + 1);
      dist[i] = m;
    }
  }
  // pixels touching the sprite's bounding edge are rim, not interior
  for (let x = 0; x < w; x++) {
    if (mask[x]) dist[x] = Math.min(dist[x], 1);
    const b = (h - 1) * w + x;
    if (mask[b]) dist[b] = Math.min(dist[b], 1);
  }
  for (let y = 0; y < h; y++) {
    if (mask[y * w]) dist[y * w] = Math.min(dist[y * w], 1);
    const r = y * w + w - 1;
    if (mask[r]) dist[r] = Math.min(dist[r], 1);
  }
  return dist;
}

/**
 * Geometry for one opening, in sprite pixel space (y down). The surface sits
 * at z=0 on the rim and recedes to -depth at the deepest interior, smoothed
 * by averaging the corner heights, and darkens with depth so the tunnel
 * reads as a tunnel rather than a flat picture.
 */
function buildPortalGeometry(frame, depth) {
  const w = frame.width, h = frame.height, mask = frame.getMask();
  const dist = spriteInteriorDistance(frame);
  let maxD = 0;
  for (let i = 0; i < w * h; i++) if (dist[i] > maxD) maxD = dist[i];
  if (maxD <= 1) return null; // nothing but rim: not an opening
  const scale = depth / maxD;

  const zAt = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return null;
    if (!mask[y * w + x]) return null;
    return -Math.min(dist[y * w + x] * scale, depth);
  };
  const cornerZ = (x, y) => {
    let sum = 0, n = 0;
    for (const [px, py] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) {
      const z = zAt(px, py);
      if (z === null) continue;
      sum += z; n++;
    }
    // corners on the outline stay at the sprite plane, so the rim is flush
    return n === 4 ? sum / n : (n ? (sum / n) * (n / 4) : 0);
  };

  const positions = [], colors = [], uvs = [], indices = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const corners = [
        [x, y, cornerZ(x, y)], [x + 1, y, cornerZ(x + 1, y)],
        [x + 1, y + 1, cornerZ(x + 1, y + 1)], [x, y + 1, cornerZ(x, y + 1)],
      ];
      const base = positions.length / 3;
      for (const [cx, cy, cz] of corners) {
        positions.push(cx, cy, cz);
        const shade = 1 - 0.55 * Math.min(1, -cz / depth); // deeper = darker
        colors.push(shade, shade, shade);
        uvs.push(cx / w, cy / h);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
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

/**
 * Clear the render-only terrain depth behind an opening so the tunnel is not
 * filled by the slab. The collision mask is untouched, so the simulation is
 * unchanged - a lemming still walks on whatever the game says is there.
 */
function carveTerrainForPortal(depthMap, level, originX, originY, frame) {
  const w = frame.width, h = frame.height, mask = frame.getMask();
  const dist = spriteInteriorDistance(frame);
  const W = level.width, H = level.height;
  let carved = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i] || dist[i] < PORTAL_CARVE_MIN) continue;
      const tx = originX + x, ty = originY + y;
      if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
      const ti = ty * W + tx;
      if (depthMap[ti] !== DepthClass.EMPTY) { depthMap[ti] = DepthClass.EMPTY; carved++; }
    }
  }
  return carved;
}

/** Every object that should be rendered as an opening, with its geometry. */
function buildPortals(level, profile, depthMap) {
  const data = window.__lem3dObjectData;
  const portals = [];
  if (!data || !Array.isArray(data.objects)) return portals;

  for (let i = 0; i < level.objects.length && i < data.objects.length; i++) {
    const objectId = data.objects[i].id;
    const info = data.objectImg ? data.objectImg[objectId] : null;
    const config = portalConfigFor(objectId, info, profile);
    if (!config) continue;

    const mapObject = level.objects[i];
    const frame = mapObject.animation.frames[0];
    if (!frame) continue;
    const geometry = buildPortalGeometry(frame, config.depth);
    if (!geometry) continue;

    const originX = mapObject.x + frame.offsetX;
    const originY = mapObject.y + frame.offsetY;
    portals.push({
      index: i, objectId, geometry, originX, originY,
      animation: mapObject.animation,
      carved: carveTerrainForPortal(depthMap, level, originX, originY, frame),
    });
  }
  return portals;
}
