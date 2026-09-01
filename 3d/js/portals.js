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
const PORTAL_RIM_MAX = 4;          // grey rim pixels bordering the opening
const PORTAL_SPAWN_OFFSET_X = 24;  // LemmingManager spawns at entrance.x + 24

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

/**
 * A flap: one flat panel, half the opening wide and as long as it is deep,
 * hinged along one side of the square and textured from the closed frame so
 * it carries the door's own artwork rather than the void behind it.
 */
function buildFlapGeometry(uv, halfWidth, depth, sign) {
  const zNear = depth / 2, zFar = -depth / 2;
  const uOuter = sign > 0 ? uv.u1 : uv.u0;
  const uInner = sign > 0 ? uv.u0 : uv.u1;
  const x = sign * halfWidth;
  const positions = [], colors = [], uvs = [];
  for (const [px, pz, pu, pv] of [
    [0, zNear, uInner, uv.v0], [x, zNear, uOuter, uv.v0],
    [x, zFar, uOuter, uv.v1], [0, zFar, uInner, uv.v1],
  ]) {
    positions.push(px, 0, pz);
    colors.push(1, 1, 1);
    uvs.push(pu, pv);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  return geom;
}

/**
 * The entrance hatch, built simply:
 *   - one flat square lying parallel to the ground, carrying the grey rim and
 *     the landscape drawn inside it. The sprite draws that square in
 *     perspective, so each of its rows is laid down as a depth slice
 *     stretched to the square's full width, which undoes the perspective.
 *   - the surrounding frame, pillars and legs as a slab of the same depth.
 * The two door flaps are separate meshes so they can swing (see below).
 */
function buildCeilingGeometry(frame) {
  const w = frame.width, h = frame.height;
  const mask = frame.getMask(), buf = frame.getBuffer();
  const dist = spriteInteriorDistance(frame);

  // Tell the door from its frame without naming a colour: the frame's colours
  // are the ones drawn on the sprite's outline, so interior pixels painted in
  // anything else are the door.
  const outline = new Set();
  for (let i = 0; i < w * h; i++) if (mask[i] && dist[i] <= 1) outline.add(buf[i]);

  const rows = [];
  for (let y = 0; y < h; y++) {
    let min = null, max = null;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] && dist[i] >= PORTAL_CARVE_MIN && !outline.has(buf[i])) {
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
    if (rows[y].width < nearW * 0.4) break;
    farY = y;
  }
  if (farY - nearY < 2) return null; // no taper: not drawn in perspective

  // the grey border beside the opening is its rim and belongs to the square
  for (let y = nearY; y <= farY; y++) {
    const r = rows[y];
    for (let n = 0; n < PORTAL_RIM_MAX && r.min > 0 && mask[y * w + r.min - 1]; n++) r.min--;
    for (let n = 0; n < PORTAL_RIM_MAX && r.max < w - 1 && mask[y * w + r.max + 1]; n++) r.max++;
    r.width = r.max - r.min + 1;
  }
  // The grey lip drawn below the opening is the near part of the same rim.
  // Left in the frame it would be extruded the full depth and jut out in
  // front of the landscape; it belongs flat in the ceiling plane.
  const lipRows = [];
  for (let y = farY + 1; y < h && lipRows.length < PORTAL_RIM_MAX; y++) {
    let min = null, max = null;
    for (let x = Math.max(0, rows[farY].min - PORTAL_RIM_MAX);
         x <= Math.min(w - 1, rows[farY].max + PORTAL_RIM_MAX); x++) {
      if (mask[y * w + x]) { if (min === null) min = x; max = x; }
    }
    if (min === null || max - min + 1 < nearW * 0.4) break;
    lipRows.push({ y, min, max });
  }

  const side = rows[nearY].width;                       // a square: side x side
  const centre = (rows[nearY].min + rows[nearY].max + 1) / 2;
  const span = farY - nearY + 1;
  const slice = side / span;
  const zOf = (y) => side / 2 - ((y - nearY) / span) * side; // centred on z=0

  // --- the square, one strip per sprite row ---
  const panel = { positions: [], colors: [], uvs: [], indices: [] };
  const inPanel = new Uint8Array(w * h);
  const strip = (r, y, zNear, zFar) => {
    for (let x = r.min; x <= r.max; x++) if (mask[y * w + x]) inPanel[y * w + x] = 1;
    const xl = centre - side / 2, xr = centre + side / 2;
    const u0 = r.min / w, u1 = (r.max + 1) / w, v0 = y / h, v1 = (y + 1) / h;
    const base = panel.positions.length / 3;
    for (const [px, pz, pu, pv] of [
      [xl, zNear, u0, v0], [xr, zNear, u1, v0], [xr, zFar, u1, v1], [xl, zFar, u0, v1],
    ]) {
      panel.positions.push(px, nearY, pz);
      panel.colors.push(1, 1, 1);
      panel.uvs.push(pu, pv);
    }
    panel.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let y = nearY; y <= farY; y++) strip(rows[y], y, zOf(y), zOf(y + 1));
  // the lip carries on forward from the square's near edge, still flat
  lipRows.forEach((r, k) => {
    strip(r, r.y, side / 2 + (k + 1) * slice, side / 2 + k * slice);
  });
  if (panel.indices.length === 0) return null;

  // --- the frame around it: beams and legs running the same depth as the
  // square, so the structure is a box rather than a plate pinned to the
  // front of it ---
  const frameGeom = buildExtrudedSpriteGeometry(
    (x, y) => mask[y * w + x] !== 0 && !inPanel[y * w + x], w, h, side);
  let framePart = null;
  if (frameGeom) {
    const positions = Array.from(frameGeom.attributes.position.array);
    // the extruder builds toward the viewer from z=0; centre it on the square
    for (let i = 2; i < positions.length; i += 3) positions[i] -= side / 2;
    framePart = {
      positions,
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
      leftX: centre - side / 2,
      rightX: centre + side / 2,
      y: nearY,
      halfWidth: side / 2,
      depth: side,
      // the doors carry the artwork drawn inside the square
      uv: {
        u0: rows[nearY].min / w, u1: (rows[nearY].min + rows[nearY].width / 2) / w,
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
      const built = buildCeilingGeometry(frame);
      if (!built) continue;
      geometry = built.geometry;
      hatch = built.hatch;
      openness = hatchOpenness(mapObject.animation.frames, built.openingMask,
        frame.width);
    } else {
      geometry = buildPortalGeometry(frame, config.depth);
    }
    if (!geometry) continue;

    let originX = mapObject.x + frame.offsetX;
    const originY = mapObject.y + frame.offsetY;
    if (hatch) {
      // line the opening up with where lemmings actually spawn, so they drop
      // through its middle (LemmingManager: entrance.x + 24)
      const spawnLocalX = mapObject.x + PORTAL_SPAWN_OFFSET_X - originX;
      originX += spawnLocalX - (hatch.leftX + hatch.halfWidth);
    }
    portals.push({
      index: i, objectId, geometry, originX, originY, shape: config.shape,
      hatch, openness, closedFrame: mapObject.animation.frames[1] || frame,
      animation: mapObject.animation,
      carved: carveTerrainForPortal(depthMap, level, originX, originY, frame),
    });
  }
  return portals;
}
