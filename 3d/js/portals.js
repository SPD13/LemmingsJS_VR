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
const PORTAL_EXIT_DEPTH = 2;       // an exit pushes its opening back this far
const PORTAL_SKY_MIN = 40;         // sky is at least this bright,
const PORTAL_SKY_SAT = 0.35;       // this saturated (not a tinted grey),
const PORTAL_SKY_WARM = 0.2;       // and this far off red (not a yellow)
const PORTAL_SKY_PATCH_MIN = 6;    // a doorway is a patch, not a stray pixel
const PORTAL_CARVE_MIN = 2;        // interior pixels (by distance) get carved
const PORTAL_REVEAL_MIN = 8;       // pixels a colour needs to count as revealed
const PORTAL_REVEAL_RATIO = 5;     // and how much rarer it must be when shut
const PORTAL_SPAWN_OFFSET_X = 24;  // LemmingManager spawns at entrance.x + 24
const PORTAL_PANEL_THICK = 1;      // the ceiling square is a game pixel thick
const PORTAL_FLAP_THICK = 1;       // and so are the doors hinged under it

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
 * Pick one texel to paint a door with: the commonest colour over its half of
 * the shut hatch. The artwork draws the shut doors as bands of light and dark
 * to fake depth on a flat sprite; sampling a single texel keeps the door the
 * flat panel it is instead of carrying that painted relief into 3D.
 */
/**
 * A flap: one flat panel, half the opening wide and as long as it is deep,
 * hinged along one side of the square and wearing the artwork the artist
 * painted on that door.
 *
 * The shut hatch is drawn in perspective, so the door narrows row by row
 * exactly as the opening does. Laying the panel down as one strip per sprite
 * row - each stretched to the flap's full width, the way the ceiling square
 * is built - undoes that perspective, so the door's own texture lands square
 * on a panel that is flat.
 */
function buildFlapGeometry(frame, doorRows, halfWidth, depth, sign) {
  const w = frame.width, h = frame.height;
  const span = doorRows.length;
  const positions = [], colors = [], uvs = [], indices = [];
  const xFar = sign * halfWidth;
  // The hinge is the origin, so the door has to be built off it: its top face
  // lies in the plane it turns about. Set the body away from that plane and
  // the swing carries the offset round with it, standing the open door that
  // far clear of the opening it is supposed to be hinged on.
  const yTop = 0, yBot = PORTAL_FLAP_THICK;
  const zAt = (k) => depth / 2 - (k / span) * depth;
  const quad = (verts, shade) => {
    const base = positions.length / 3;
    for (const [px, py, pz, pu, pv] of verts) {
      positions.push(px, py, pz);
      colors.push(shade, shade, shade);
      uvs.push(pu, pv);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // each door owns its half of the drawn opening, hinge side outermost
  const uHingeOf = (row) => (sign > 0 ? row.min : row.max + 1) / w;
  const uMidOf = (row) => ((row.min + row.max + 1) / 2) / w;

  doorRows.forEach((row, k) => {
    const zNear = zAt(k), zFar = zAt(k + 1);
    const uh = uHingeOf(row), um = uMidOf(row);
    const v0 = row.y / h, v1 = (row.y + 1) / h;
    // a door is painted on the side you see whichever way it is swung, so
    // both faces stay at full brightness; only the pixel of rim is shaded
    quad([[0, yTop, zNear, uh, v0], [xFar, yTop, zNear, um, v0],
          [xFar, yTop, zFar, um, v1], [0, yTop, zFar, uh, v1]], SPRITE_SHADE_FRONT);
    quad([[0, yBot, zFar, uh, v1], [xFar, yBot, zFar, um, v1],
          [xFar, yBot, zNear, um, v0], [0, yBot, zNear, uh, v0]], SPRITE_SHADE_FRONT);
    // the long edges: along the hinge and along the door's meeting edge
    quad([[0, yTop, zNear, uh, v0], [0, yTop, zFar, uh, v1],
          [0, yBot, zFar, uh, v1], [0, yBot, zNear, uh, v0]], SPRITE_SHADE_LEFT);
    quad([[xFar, yTop, zFar, um, v1], [xFar, yTop, zNear, um, v0],
          [xFar, yBot, zNear, um, v0], [xFar, yBot, zFar, um, v1]], SPRITE_SHADE_RIGHT);
  });

  // and the two short ends, closing the slab
  const first = doorRows[0], last = doorRows[span - 1];
  const zFront = zAt(0), zBack = zAt(span);
  quad([[0, yTop, zFront, uHingeOf(first), first.y / h],
        [xFar, yTop, zFront, uMidOf(first), first.y / h],
        [xFar, yBot, zFront, uMidOf(first), first.y / h],
        [0, yBot, zFront, uHingeOf(first), first.y / h]], SPRITE_SHADE_TOP);
  quad([[xFar, yTop, zBack, uMidOf(last), (last.y + 1) / h],
        [0, yTop, zBack, uHingeOf(last), (last.y + 1) / h],
        [0, yBot, zBack, uHingeOf(last), (last.y + 1) / h],
        [xFar, yBot, zBack, uMidOf(last), (last.y + 1) / h]], SPRITE_SHADE_BOTTOM);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  return geom;
}

/**
 * Where the opening is, row by row, found by asking what the doors hide.
 *
 * Shut, the doors cover the hole; open, the same pixels show landscape. So
 * the colours that gain pixels when the hatch opens are the landscape's, and
 * the opening is the region painted in them. Counts rather than presence,
 * because a tileset may put a stray pixel of sky elsewhere in the sprite -
 * one such pixel is enough to lose the sky from a set difference.
 *
 * That alone can also pick up the swung doors, which are redrawn as they
 * open, so the region is taken as the blob connected to the commonest
 * revealed colour: the sky, in the middle of the hole. The grey rim comes
 * along with it, being revealed too, which is what we want - it belongs to
 * the square.
 *
 * Keying off the animation rather than the artwork's colours is what makes
 * this hold across tilesets. Reading the palette directly cannot: an opening
 * drawn touching the sprite's edge puts sky on the silhouette, where a
 * colour-based reading has to call it frame.
 */
function spriteOpeningRows(open, shut) {
  const w = open.width, h = open.height;
  const maskOpen = open.getMask(), bufOpen = open.getBuffer();
  const maskShut = shut.getMask(), bufShut = shut.getBuffer();

  const countOpen = new Map(), countShut = new Map();
  for (let i = 0; i < w * h; i++) {
    if (maskOpen[i]) countOpen.set(bufOpen[i], (countOpen.get(bufOpen[i]) || 0) + 1);
    if (maskShut[i]) countShut.set(bufShut[i], (countShut.get(bufShut[i]) || 0) + 1);
  }
  const revealed = new Set();
  let sky = null, skyCount = 0;
  for (const [colour, n] of countOpen) {
    if (n < PORTAL_REVEAL_MIN) continue;
    if ((countShut.get(colour) || 0) * PORTAL_REVEAL_RATIO > n) continue;
    revealed.add(colour);
    if (n > skyCount) { skyCount = n; sky = colour; }
  }
  if (sky === null) return null;

  const inOpening = new Uint8Array(w * h), stack = [];
  for (let i = 0; i < w * h; i++) {
    if (maskOpen[i] && bufOpen[i] === sky) { inOpening[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (inOpening[j] || !maskOpen[j] || !revealed.has(bufOpen[j])) continue;
      inOpening[j] = 1;
      stack.push(j);
    }
  }

  const rows = [];
  for (let y = 0; y < h; y++) {
    let min = null, max = null;
    for (let x = 0; x < w; x++) {
      if (inOpening[y * w + x]) { if (min === null) min = x; max = x; }
    }
    rows[y] = min === null ? null : { min, max, width: max - min + 1 };
  }
  return rows;
}

/**
 * The entrance hatch, built simply:
 *   - one flat square lying parallel to the ground, carrying the grey rim and
 *     the landscape drawn inside it. The sprite draws that square in
 *     perspective, so each of its rows is laid down as a depth slice
 *     stretched to the square's full width, which undoes the perspective.
 * The two door flaps are separate meshes so they can swing (see below).
 */
function buildCeilingGeometry(frame, shutFrame) {
  const w = frame.width, h = frame.height;
  const mask = frame.getMask();
  if (!shutFrame || shutFrame === frame) return null;
  const rows = spriteOpeningRows(frame, shutFrame);
  if (!rows) return null;

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

  // The opening's extents are the doors' extents: shut, the doors are exactly
  // what covers this. So the same rows both size the square and say where to
  // read each door's paint from the shut hatch.
  const doorRows = [];
  for (let y = nearY; y <= farY; y++) {
    doorRows.push({ y, min: rows[y].min, max: rows[y].max });
  }

  const side = rows[nearY].width;                     // a square: side x side
  const centre = (rows[nearY].min + rows[nearY].max + 1) / 2;
  const span = farY - nearY + 1;
  const zOf = (y) => side / 2 - ((y - nearY) / span) * side; // centred on z=0

  // --- the square: a slab a pixel thick, one strip per sprite row ---
  const panel = { positions: [], colors: [], uvs: [], indices: [] };
  const inPanel = new Uint8Array(w * h);
  const yTop = nearY, yBot = nearY + PORTAL_PANEL_THICK;
  const xl = centre - side / 2, xr = centre + side / 2;
  const quad = (verts, shade) => {
    const base = panel.positions.length / 3;
    for (const [px, py, pz, pu, pv] of verts) {
      panel.positions.push(px, py, pz);
      panel.colors.push(shade, shade, shade);
      panel.uvs.push(pu, pv);
    }
    panel.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const strip = (r, y, zNear, zFar) => {
    for (let x = r.min; x <= r.max; x++) if (mask[y * w + x]) inPanel[y * w + x] = 1;
    const u0 = r.min / w, u1 = (r.max + 1) / w, v0 = y / h, v1 = (y + 1) / h;
    // the landscape overhead, and the same ceiling seen from underneath
    quad([[xl, yTop, zNear, u0, v0], [xr, yTop, zNear, u1, v0],
          [xr, yTop, zFar, u1, v1], [xl, yTop, zFar, u0, v1]], SPRITE_SHADE_FRONT);
    quad([[xl, yBot, zFar, u0, v1], [xr, yBot, zFar, u1, v1],
          [xr, yBot, zNear, u1, v0], [xl, yBot, zNear, u0, v0]], SPRITE_SHADE_FRONT);
    // the pixel of cut edge down each long side
    quad([[xl, yTop, zNear, u0, v0], [xl, yTop, zFar, u0, v1],
          [xl, yBot, zFar, u0, v1], [xl, yBot, zNear, u0, v0]], SPRITE_SHADE_LEFT);
    quad([[xr, yTop, zFar, u1, v1], [xr, yTop, zNear, u1, v0],
          [xr, yBot, zNear, u1, v0], [xr, yBot, zFar, u1, v1]], SPRITE_SHADE_RIGHT);
  };
  for (let y = nearY; y <= farY; y++) strip(rows[y], y, zOf(y), zOf(y + 1));
  if (panel.indices.length === 0) return null;

  // and the near and far edges, closing the slab
  const rNear = rows[nearY], rFar = rows[farY];
  const zNearEnd = zOf(nearY), zFarEnd = zOf(farY + 1);
  const uNear0 = rNear.min / w, uNear1 = (rNear.max + 1) / w, vNear = nearY / h;
  const uFar0 = rFar.min / w, uFar1 = (rFar.max + 1) / w, vFar = (farY + 1) / h;
  quad([[xl, yTop, zNearEnd, uNear0, vNear], [xr, yTop, zNearEnd, uNear1, vNear],
        [xr, yBot, zNearEnd, uNear1, vNear], [xl, yBot, zNearEnd, uNear0, vNear]],
       SPRITE_SHADE_TOP);
  quad([[xr, yTop, zFarEnd, uFar1, vFar], [xl, yTop, zFarEnd, uFar0, vFar],
        [xl, yBot, zFarEnd, uFar0, vFar], [xr, yBot, zFarEnd, uFar1, vFar]],
       SPRITE_SHADE_BOTTOM);

  // Nothing else from the sprite is drawn. The rest of it is the same hatch
  // in 2D perspective - the trapezoid's walls and the shading around them -
  // and rebuilding that here as upright pixels only stands a wall behind the
  // doors. The square and its two flaps say it in three dimensions instead,
  // so the opening stays open.

  return {
    geometry: toBufferGeometry(panel),
    openingMask: inPanel,
    hatch: {
      leftX: centre - side / 2,
      rightX: centre + side / 2,
      // the hinge line runs along the ceiling's underside, so a shut door
      // meets it and an open one swings flush against the opening's edge
      y: nearY + PORTAL_PANEL_THICK,
      halfWidth: side / 2,
      depth: side,
      // the shut hatch's doors, row by row, so the flaps can be painted
      // from the artwork the artist drew on them
      doorRows,
    },
  };
}

/**
 * Is this pixel sky seen through the opening rather than the wall around it?
 * Exits are drawn as a mouth of blue, sometimes blue and green, set in the
 * tileset's own stone. Three things separate the two, and all three are
 * needed: stone is shaded in cool-tinted near-neutrals, so sky has to be
 * properly saturated rather than merely bluest-of-three; stone is often warm,
 * so red may not lead; and a pale yellow is saturated with green leading, so
 * the lead has to stand clear of red as well.
 */
function isSkyColour(v) {
  const r = v & 255, g = (v >> 8) & 255, b = (v >> 16) & 255;
  const max = Math.max(r, g, b);
  if (max < PORTAL_SKY_MIN) return false;
  if (max - Math.min(r, g, b) < PORTAL_SKY_SAT * max) return false;
  if (max === r) return false;
  return max - r >= PORTAL_SKY_WARM * max;
}

/**
 * The opening's pixels: sky, but only the patch of it that is the doorway.
 *
 * Colour alone is not enough. Some tilesets are built of blue stone - the
 * crystal set most of all - and pick up stray saturated pixels all over the
 * sprite, which would dent it at random. But the level data says where the
 * doorway is: an exit carries the trigger box a lemming has to reach to get
 * out. So the region is the connected patch of sky nearest that box, and
 * scattered pixels elsewhere in the artwork are left alone.
 */
function spriteSkyMask(frame, triggerX, triggerY) {
  const w = frame.width, h = frame.height;
  const mask = frame.getMask(), buf = frame.getBuffer();
  const candidate = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) {
    if (mask[i] && isSkyColour(buf[i])) { candidate[i] = 1; any = true; }
  }
  if (!any) return null;

  // the patch whose nearest pixel to the trigger is nearest of all
  const seen = new Uint8Array(w * h);
  let best = null, bestD = Infinity;
  for (let start = 0; start < w * h; start++) {
    if (!candidate[start] || seen[start]) continue;
    const blob = [], stack = [start];
    seen[start] = 1;
    let d2 = Infinity;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      blob.push(i);
      const dx = x - triggerX, dy = y - triggerY;
      d2 = Math.min(d2, dx * dx + dy * dy);
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (seen[j] || !candidate[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    // a lone saturated pixel can easily sit closer to the trigger than the
    // doorway does, and denting one pixel is not worth doing
    if (blob.length < PORTAL_SKY_PATCH_MIN) continue;
    if (d2 < bestD) { bestD = d2; best = blob; }
  }
  if (!best) return null;
  const out = new Uint8Array(w * h);
  for (const i of best) out[i] = 1;
  return out;
}

/**
 * Geometry for one exit, in sprite pixel space (y down). The sprite stays in
 * its own plane and only the opening is pushed back, by `depth`. Corner
 * heights are averaged from the four pixels that meet there, so the step in
 * is a short ramp rather than a cliff, and the recess darkens a little: a
 * shallow tunnel rather than a hole cut in a picture.
 */
function buildPortalGeometry(frame, depth, triggerX, triggerY) {
  const w = frame.width, h = frame.height;
  const mask = frame.getMask();

  const sky = spriteSkyMask(frame, triggerX, triggerY);
  if (!sky) return null; // no opening to push back

  // outside the sprite counts as the plane, so the rim stays flush
  const recessAt = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;
    return sky[y * w + x] ? depth : 0;
  };
  const cornerZ = (x, y) => {
    let sum = 0;
    for (const [px, py] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) {
      sum += recessAt(px, py);
    }
    return -sum / 4;
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
        const shade = 1 - 0.3 * Math.min(1, -cz / depth); // deeper = darker
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
      const built = buildCeilingGeometry(frame, mapObject.animation.frames[1]);
      if (!built) continue;
      geometry = built.geometry;
      hatch = built.hatch;
      openness = hatchOpenness(mapObject.animation.frames, built.openingMask,
        frame.width);
    } else {
      // the trigger box is in object space; the frame may be inset from it
      const tx = (info ? info.trigger_left + info.trigger_width / 2 : frame.width / 2)
        - frame.offsetX;
      const ty = (info ? info.trigger_top + info.trigger_height / 2 : frame.height / 2)
        - frame.offsetY;
      geometry = buildPortalGeometry(frame, config.depth, tx, ty);
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
      // Only a hatch needs the slab cleared from behind it: it is a hole a
      // lemming really falls through. An exit only dents its opening a
      // couple of pixels, well clear of the terrain behind, so carving
      // there would hollow out the wall for nothing.
      carved: hatch
        ? carveTerrainForPortal(depthMap, level, originX, originY, frame) : 0,
    });
  }
  return portals;
}
