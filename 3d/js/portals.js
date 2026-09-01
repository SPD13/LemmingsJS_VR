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
    if (entry.shape === "flat") return null;
    return { shape: entry.shape, depth: entry.depth ||
      (entry.shape === "ceiling" ? PORTAL_DEFAULT_DEPTH : PORTAL_EXIT_DEPTH) };
  }
  // the entrance hatch lies flat overhead; an exit tunnels into the scenery
  if (objectId === PORTAL_ENTRANCE_ID) {
    return { shape: "ceiling", depth: PORTAL_DEFAULT_DEPTH };
  }
  if (info && info.trigger_effect_id === Lemmings.TriggerTypes.EXIT_LEVEL) {
    return { shape: "portal", depth: PORTAL_EXIT_DEPTH };
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

/** Concatenate two geometries built by the helpers below. */
function mergePortalGeometry(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = {
    positions: a.positions.concat(b.positions),
    colors: a.colors.concat(b.colors),
    uvs: a.uvs.concat(b.uvs),
    indices: a.indices.slice(),
  };
  const offset = a.positions.length / 3;
  for (const i of b.indices) out.indices.push(i + offset);
  return out;
}

function toBufferGeometry(parts) {
  if (!parts || parts.indices.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(parts.positions, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(parts.colors, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(parts.uvs, 2));
  geom.setIndex(parts.indices);
  return geom;
}

/**
 * The entrance's blue/green/white trapezoid is not a tunnel: it is a hatch
 * lying flat above the player - a square parallel to the ground, drawn in
 * perspective. A horizontal surface above eye level recedes *downward* in the
 * image (toward the horizon) as it goes away, which is exactly what the
 * artwork shows: the panel is widest at its top row and narrows going down.
 *
 * So the trapezoid is un-projected back into a rectangle: the widest row
 * becomes the near edge, each row below is pushed further back in Z at a
 * constant height, and its pixels are stretched out to the near edge's width.
 * The rest of the sprite (frame, pillars, legs) keeps the usual flat
 * extrusion.
 */
/**
 * The two flaps of an entrance hatch. They are flat panels that fill the
 * square when shut and swing down on hinges along its left and right edges,
 * so each is half the opening wide and as long as the opening is deep.
 *
 * How far they are open is read from the artwork rather than assumed: the
 * last animation frame is the fully open hatch, so for each frame we count
 * how many of the opening's pixels already match it. The closed frame
 * matches almost none (the doors cover the hole), a half-open frame matches
 * about half. That ratio becomes the hinge angle, and it works for any
 * tileset without naming a single colour.
 */
function hatchOpenness(frames, openingMask, w) {
  const open = frames[frames.length - 1];
  const openBuf = open.getBuffer(), openMask = open.getMask();
  const pixel = (frame, i) => (frame.getMask()[i] ? frame.getBuffer()[i] : -1);
  const matchOver = (frame, region, total) => {
    if (total === 0) return 1;
    let same = 0;
    for (let i = 0; i < region.length; i++) {
      if (!region[i]) continue;
      if (pixel(frame, i) === (openMask[i] ? openBuf[i] : -1)) same++;
    }
    return same / total;
  };

  let openingTotal = 0;
  for (let i = 0; i < openingMask.length; i++) if (openingMask[i]) openingTotal++;
  if (openingTotal === 0) return frames.map(() => 1);

  // the shut frame is the one that looks least like the open one
  let shut = frames[0], worst = Infinity;
  for (const frame of frames) {
    const r = matchOver(frame, openingMask, openingTotal);
    if (r < worst) { worst = r; shut = frame; }
  }

  // Measure only the hole - where shut and open actually differ. The rest of
  // the opening region is the doors themselves, and those are now 3D flaps
  // whose painted position must not be mistaken for the hatch being ajar.
  const hole = new Uint8Array(openingMask.length);
  let holeTotal = 0;
  for (let i = 0; i < openingMask.length; i++) {
    if (!openingMask[i]) continue;
    if (pixel(shut, i) !== (openMask[i] ? openBuf[i] : -1)) { hole[i] = 1; holeTotal++; }
  }
  if (holeTotal === 0) return frames.map(() => 1);

  // Openness is how much of the hole is no longer covered by a door, i.e.
  // how far each frame has departed from the shut one. Asking "does this
  // still look shut?" rather than "does this match one chosen open frame?"
  // keeps every fully open frame at a full quarter turn, however the
  // artwork varies between them.
  const ratios = frames.map((frame) => {
    let uncovered = 0;
    for (let i = 0; i < hole.length; i++) {
      if (hole[i] && pixel(frame, i) !== pixel(shut, i)) uncovered++;
    }
    return uncovered / holeTotal;
  });
  const hi = Math.max(...ratios);
  if (hi < 0.05) return ratios.map(() => 1);
  return ratios.map((r) => Math.min(1, r / hi)); // shut -> 0, open -> 90 degrees
}

/** A flap: half the opening wide, hinged along one side, textured from the
 *  closed frame so it carries the door's own artwork rather than the void. */
function buildFlapGeometry(uv, halfWidth, depth, sign) {
  const positions = [], colors = [], uvs = [], indices = [];
  // hinge at local x=0; the panel extends to sign*halfWidth, back to -depth
  const corners = [
    [0, 0, 0, sign > 0 ? uv.u0 : uv.u1, uv.v0],
    [sign * halfWidth, 0, 0, sign > 0 ? uv.u1 : uv.u0, uv.v0],
    [sign * halfWidth, 0, -depth, sign > 0 ? uv.u1 : uv.u0, uv.v1],
    [0, 0, -depth, sign > 0 ? uv.u0 : uv.u1, uv.v1],
  ];
  for (const [x, y, z, u, v] of corners) {
    positions.push(x, y, z);
    colors.push(0.9, 0.9, 0.9);
    uvs.push(u, v);
  }
  indices.push(0, 1, 2, 0, 2, 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  return geom;
}

function buildCeilingGeometry(frame, depth) {
  const w = frame.width, h = frame.height, mask = frame.getMask();
  const dist = spriteInteriorDistance(frame);

  const rows = [];
  for (let y = 0; y < h; y++) {
    let min = null, max = null;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] && dist[y * w + x] >= PORTAL_CARVE_MIN) {
        if (min === null) min = x;
        max = x;
      }
    }
    rows[y] = min === null ? null : { min, max, width: max - min + 1 };
  }

  let nearY = -1, nearW = 0;
  for (let y = 0; y < h; y++) {
    if (rows[y] && rows[y].width > nearW) { nearW = rows[y].width; nearY = y; }
  }
  if (nearY < 0) return null;
  let farY = nearY;
  for (let y = nearY + 1; y < h; y++) {
    if (!rows[y] || rows[y].width > rows[y - 1].width) break;
    farY = y;
  }
  if (farY - nearY < 2) return null; // no taper: not a panel in perspective

  // the hatch is a square: it is as deep as it is wide
  depth = nearW;
  const span = farY - nearY;
  const nearCentre = (rows[nearY].min + rows[nearY].max + 1) / 2;
  const rowAt = (y) => rows[Math.max(nearY, Math.min(farY, y))];
  // un-project a sprite x on row y onto the flat panel
  const panelX = (x, y) => {
    const r = rowAt(y);
    const centre = (r.min + r.max + 1) / 2;
    return nearCentre + (x - centre) * (nearW / r.width);
  };
  const panelZ = (y) =>
    -((Math.max(nearY, Math.min(farY, y)) - nearY) / span) * depth;

  const panel = { positions: [], colors: [], uvs: [], indices: [] };
  const inPanel = new Uint8Array(w * h);
  for (let y = nearY; y <= farY; y++) {
    const r = rows[y];
    for (let x = r.min; x <= r.max; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      inPanel[i] = 1;
      const zTop = panelZ(y), zBottom = panelZ(y + 1);
      const corners = [
        [panelX(x, y), nearY, zTop, x / w, y / h],
        [panelX(x + 1, y), nearY, zTop, (x + 1) / w, y / h],
        [panelX(x + 1, y + 1), nearY, zBottom, (x + 1) / w, (y + 1) / h],
        [panelX(x, y + 1), nearY, zBottom, x / w, (y + 1) / h],
      ];
      const base = panel.positions.length / 3;
      for (const [cx, cy, cz, cu, cv] of corners) {
        panel.positions.push(cx, cy, cz);
        const shade = 1 - 0.45 * Math.min(1, -cz / depth); // dimmer further in
        panel.colors.push(shade, shade, shade);
        panel.uvs.push(cu, cv);
      }
      panel.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  if (panel.indices.length === 0) return null;

  // the surrounding frame keeps a plain slab extrusion
  const frameGeom = buildExtrudedSpriteGeometry(
    (x, y) => mask[y * w + x] !== 0 && !inPanel[y * w + x], w, h, SPRITE_DEPTH);
  let framePart = null;
  if (frameGeom) {
    framePart = {
      positions: Array.from(frameGeom.attributes.position.array),
      colors: Array.from(frameGeom.attributes.color.array),
      uvs: Array.from(frameGeom.attributes.uv.array),
      indices: Array.from(frameGeom.index.array),
    };
    frameGeom.dispose();
  }
  return {
    geometry: toBufferGeometry(mergePortalGeometry(framePart, panel)),
    openingMask: inPanel,
    hatch: {
      // hinge lines along the square's left and right edges, at the near row
      leftX: nearCentre - nearW / 2,
      rightX: nearCentre + nearW / 2,
      y: nearY,
      halfWidth: nearW / 2,
      depth,
      uv: {
        u0: (nearCentre - nearW / 2) / w, u1: nearCentre / w,
        v0: nearY / h, v1: (farY + 1) / h,
      },
    },
  };
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
    let geometry = null, hatch = null, openness = null;
    if (config.shape === "ceiling") {
      const built = buildCeilingGeometry(frame, config.depth);
      if (!built) continue;
      geometry = built.geometry;
      hatch = built.hatch;
      openness = hatchOpenness(mapObject.animation.frames, built.openingMask,
        frame.width);
    } else {
      geometry = buildPortalGeometry(frame, config.depth);
    }
    if (!geometry) continue;

    const originX = mapObject.x + frame.offsetX;
    const originY = mapObject.y + frame.offsetY;
    portals.push({
      index: i, objectId, geometry, originX, originY, shape: config.shape,
      hatch, openness, closedFrame: mapObject.animation.frames[1] || frame,
      animation: mapObject.animation,
      carved: carveTerrainForPortal(depthMap, level, originX, originY, frame),
    });
  }
  return portals;
}
