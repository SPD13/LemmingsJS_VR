"use strict";
/**
 * Regions and gates: the level as a lemming sees it, and a plan through it.
 *
 * On the four-pixel cells of the analysis a floor cell is air over solid.
 * A region is a set of floor cells a walker crosses on its own - a step of
 * one cell up or down at a time - and it has two ends, each a wall or a
 * drop. Gates lead out of a region: a drop (free under the splat height, a
 * floater's job beyond it), a wall (bashed level, mined down, climbed to
 * its top; steel and a one-way wall's forbidden side forbid what they
 * forbid), a gap (built across, as many builders as its width and rise
 * need; a platformer flat; a jump over nine cells and up to five up), the floor
 * (dug through, unless steel), a deadly drop cut short by a stoner's stone,
 * a low wall jumped or stacked up, a ceiling
 * within reach shimmied along to where it ends. Water, fire and a trap
 * are ends too - deadly on foot, crossed above like a gap, water swum by a
 * swimmer to the bank it climbs out on, a trap walked through by a
 * disarmer and gone for everyone after (a trap that fires once takes one
 * lemming and is gone). Each gate names the skill, where
 * it is worked and which way the lemming faces there.
 *
 * A blocker standing on a floor cuts it in two, with a bomber on it as the
 * gate between the halves; the graph is rebuilt when the terrain or the
 * blockers change.
 *
 * plan() is a Dijkstra over (region, heading): a lemming heading one way
 * reaches that end first, the other end after a wall (or a blocker) turns
 * it - or after a turn of its own, a blocker set by another lemming and a
 * bomber to free it later, which is what a one-way wall to be opened from
 * its far side asks for. The exit's region is the goal. planAll() plans
 * for every lemming: one goes first and opens terrain gates for the rest,
 * chosen outright since its own cheapest way rarely opens what the crowd
 * needs; each group of lemmings then pays its own way, per-lemming gates
 * by those lacking the skill.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Solver = Lemmix.Solver || (Lemmix.Solver = {});
  const { PM } = Lemmix;

  const CELL = 4;
  const SPLAT_CELLS = 15;      // 62 px: a longer drop splats
  const BUILD_ACROSS = 6;      // cells one builder spans (12 bricks, 24 px)
  const BUILD_UP = 3;          // cells one builder rises (12 px)
  const MAX_BUILDERS = 6;
  const PLATFORM_ACROSS = 6;   // cells one platformer spans, flat
  const JUMP_ACROSS = 9;       // cells a jump covers (38 px, back at its level) before the fall
  const JUMP_UP = 4;           // cells a jump rises (18 px)
  const JUMP_LEDGE = 5;        // cells a jump gets up onto: the arc, plus the hoist over a ledge within 5 px of its head
  const STACK_UP = 3;          // cells a stack (8 px) plus a walker's step (6 px) climbs
  const WATER = 1, FIRE = 2, TRAP = 3, TRAPONCE = 4;
  const PERM = new Set(["CLIMBER", "FLOATER", "GLIDER", "SWIMMER", "DISARMER", "SLIDER"]);

  /** The cell grid of a physics map: 0 air, 1 solid, 2 steel; and the one-way bits per cell (1 left, 2 right, 4 down, 8 up). */
  function cells(physics, w, h) {
    const cw = Math.ceil(w / CELL), ch = Math.ceil(h / CELL);
    const kind = new Uint8Array(cw * ch), oneway = new Uint8Array(cw * ch);
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      let n = 0, s = 0, st = 0, ow = 0;
      for (let y = cy * CELL; y < Math.min(h, (cy + 1) * CELL); y++) for (let x = cx * CELL; x < Math.min(w, (cx + 1) * CELL); x++) {
        const b = physics[x + y * w]; n++;
        if (b & PM.SOLID) { s++; if (b & PM.STEEL) st++; ow |= b & (PM.ONEWAYLEFT | PM.ONEWAYRIGHT | PM.ONEWAYDOWN | PM.ONEWAYUP); }
      }
      const i = cx + cy * cw;
      kind[i] = st > n / 2 ? 2 : s > n / 2 ? 1 : 0;
      oneway[i] = (ow & PM.ONEWAYLEFT ? 1 : 0) | (ow & PM.ONEWAYRIGHT ? 2 : 0) | (ow & PM.ONEWAYDOWN ? 4 : 0) | (ow & PM.ONEWAYUP ? 8 : 0);
    }
    return { cw, ch, kind, oneway };
  }

  /**
   * The graph: regions, each {id, cells: [i...], x0, x1 (cells), rows, ends:
   * {left, right}, exit, hatch}, and gates [{from, to, kind, skill, cost,
   * x, y (px), dir, side}]. `level` for the gadgets, `physics` as it now is.
   */
  function build(level, physics, blockers) {
    const w = level.width, h = level.height;
    const g = cells(physics || level.physics, w, h);
    const { cw, ch, kind } = g;
    const at = (cx, cy) => (cx < 0 || cy < 0 || cx >= cw || cy >= ch) ? 1 : kind[cx + cy * cw];
    const floor = new Uint8Array(cw * ch);
    for (let cy = 0; cy < ch - 1; cy++) for (let cx = 0; cx < cw; cx++) if (at(cx, cy) === 0 && at(cx, cy + 1) !== 0 && at(cx, cy - 1) === 0) floor[cx + cy * cw] = 1;
    // hazards: water drowns, fire burns, a trap kills - none of their cells is floor to walk on
    const hazard = new Uint8Array(cw * ch);
    const HAZARD = { WATER, FIRE, TRAP, TRAPONCE };
    for (const gd of level.gadgets) {
      const hz = HAZARD[gd.effect] || 0;
      if (!hz || !gd.triggerRect) continue;
      const r = gd.triggerRect;
      for (let cy = Math.max(0, Math.floor(r.y0 / CELL)); cy <= Math.min(ch - 1, Math.floor((r.y1 - 1) / CELL)); cy++)
        for (let cx = Math.max(0, Math.floor(r.x0 / CELL)); cx <= Math.min(cw - 1, Math.floor((r.x1 - 1) / CELL)); cx++) { const i = cx + cy * cw; if (!hazard[i] || hz === WATER) hazard[i] = hz; floor[i] = 0; }
    }
    const hazardAt = (cx, cy) => (cx < 0 || cy < 0 || cx >= cw || cy >= ch) ? 0 : hazard[cx + cy * cw];
    // a blocker standing there cuts its floor in two: its cell column is no floor, and a gate of its own
    const blocked = new Uint8Array(cw * ch);
    for (const b of blockers || []) {
      const cx = Math.floor(b.x / CELL);
      if (cx < 0 || cx >= cw) continue;
      for (let cy = Math.max(0, Math.floor((b.y - 1) / CELL) - 1); cy <= Math.min(ch - 1, Math.floor((b.y - 1) / CELL) + 1); cy++) { const i = cx + cy * cw; if (floor[i]) { floor[i] = 0; blocked[i] = 1; } }
    }
    // regions: union of floor cells a step apart
    const region = new Int32Array(cw * ch).fill(-1);
    const regions = [];
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      const i = cx + cy * cw;
      if (!floor[i] || region[i] >= 0) continue;
      const id = regions.length, list = [], stack = [i];
      region[i] = id;
      while (stack.length) {
        const j = stack.pop(); list.push(j);
        const jx = j % cw, jy = (j / cw) | 0;
        for (const dx of [-1, 1]) for (const dy of [-1, 0, 1]) {
          const nx = jx + dx, ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const k = nx + ny * cw;
          if (floor[k] && region[k] < 0 && (dy !== -1 || at(jx, jy - 1) === 0)) { region[k] = id; stack.push(k); }
        }
      }
      let x0 = Infinity, x1 = -Infinity, ymin = Infinity, ymax = -Infinity;
      for (const j of list) { const jx = j % cw, jy = (j / cw) | 0; if (jx < x0) x0 = jx; if (jx > x1) x1 = jx; if (jy < ymin) ymin = jy; if (jy > ymax) ymax = jy; }
      regions.push({ id, cells: list, x0, x1, ymin, ymax, exit: false, hatch: false, ends: {}, gates: [] });
    }
    const regionAt = (cx, cy) => (cx < 0 || cy < 0 || cx >= cw || cy >= ch) ? -1 : region[cx + cy * cw];
    const phys = physics || level.physics;
    const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && (phys[x + y * w] & PM.SOLID) !== 0;
    /**
     * A wall the cells see that a walker climbs on foot - a slope, steps of
     * six pixels or less at the pixels: from the end cell (ex, ey) heading
     * `dir`, the ground followed pixel by pixel (up six at most, down three)
     * until another region's cell is underfoot (its id) or a real wall or
     * drop stops it (-1). At most 64 pixels of it.
     */
    const walkUp = (ex, ey, dir, fromId) => {
      let x = dir > 0 ? ex * CELL + CELL - 1 : ex * CELL;
      let y = ey * CELL + CELL; // the pixel under the feet
      while (y < h && !solid(x, y)) y++;
      for (let n = 0; n < 64; n++) {
        x += dir;
        if (x < 0 || x >= w) return -1;
        let ny = y;
        if (solid(x, ny)) { let up = 0; while (up <= 6 && solid(x, ny - 1)) { ny--; up++; } if (up > 6) return -1; }
        else { let down = 0; while (down <= 3 && !solid(x, ny + 1)) { ny++; down++; } if (down > 3) return -1; }
        y = ny;
        const id = regionAt(Math.floor(x / CELL), Math.floor((y - 1) / CELL));
        if (id >= 0 && id !== fromId) return id;
      }
      return -1;
    };
    /** The floor a fall from (cx, cy) lands on: {cy, region} or null (off the level). */
    const landing = (cx, cy) => {
      for (let y = cy; y < ch; y++) {
        if (hazardAt(cx, y)) return { cy: y, region: -1, cells: y - cy, hazard: hazard[cx + y * cw] };
        if (at(cx, y) !== 0) return y > cy ? { cy: y - 1, region: regionAt(cx, y - 1), cells: y - 1 - cy } : null;
      }
      return null;
    };
    /**
     * Where a swimmer dropped into the water at (cx, cy) gets out: along the
     * surface its way until terrain, climbed out when a floor is within two
     * cells above the surface, else turned and the other way. A region or -1.
     */
    const swimOut = (cx, cy, dir) => {
      let sy = cy; while (sy > 0 && hazardAt(cx, sy - 1) === WATER) sy--;
      for (const d of [dir, -dir]) {
        for (let x = cx; x >= 0 && x < cw; x += d) {
          if (hazardAt(x, sy) === WATER) continue;
          // the water's edge: a bank at the surface (walked out on), a low wall (climbed out), a drop (fallen down), a high wall (turned)
          if (at(x, sy) === 0) { const id = regionAt(x, sy); if (id >= 0) return id; const l = landing(x, sy); return l && l.region >= 0 ? l.region : -1; }
          for (let dy = 1; dy <= 2; dy++) { const id = regionAt(x, sy - dy); if (id >= 0) return id; }
          break;
        }
      }
      return -1;
    };
    // gadgets: the exit's region, the hatches' landing regions
    const exits = level.gadgets.filter((gd) => gd.effectBase === "EXIT" || gd.effectBase === "LOCKEXIT");
    const exitAt = [];
    for (const e of exits) {
      const r = e.triggerRect, cx = Math.floor((r.x0 + r.x1) / 2 / CELL);
      for (let cy = Math.floor(r.y0 / CELL); cy <= Math.floor(r.y1 / CELL) + 1 && cy < ch; cy++) { const id = regionAt(cx, cy); if (id >= 0) { regions[id].exit = true; exitAt.push({ region: id, x: (r.x0 + r.x1) >> 1 }); break; } }
    }
    for (const hd of level.gadgets.filter((gd) => gd.effectBase === "WINDOW")) {
      const l = landing(Math.floor(hd.triggerRect.x0 / CELL), Math.floor(hd.triggerRect.y0 / CELL));
      if (l && l.region >= 0) regions[l.region].hatch = true;
    }
    // the ends of every region, and the gates out of it
    const gates = [];
    const gate = (from, to, kind, skill, cost, cx, cy, dir, extra) => {
      const gt = Object.assign({ from, to, kind, skill, cost, x: cx * CELL + 2, y: cy * CELL + 2, dir }, extra || {});
      gt.id = gates.length; gates.push(gt); regions[from].gates.push(gt);
    };
    for (const r of regions) {
      // the row of the region's cell at each end
      const rowAt = (cx) => { let best = -1; for (const j of r.cells) if (j % cw === cx) { const jy = (j / cw) | 0; if (jy > best) best = jy; } return best; };
      for (const [side, dir] of [["left", -1], ["right", 1]]) {
        const ex = dir < 0 ? r.x0 : r.x1, ey = rowAt(ex);
        const nx = ex + dir;
        const beyond = at(nx, ey);
        const blockedAt = (cx, cy) => cx >= 0 && cx < cw && ((cy >= 0 && blocked[cx + cy * cw]) || (cy + 1 < ch && blocked[cx + (cy + 1) * cw]) || (cy >= 1 && blocked[cx + (cy - 1) * cw]));
        const hz = hazardAt(nx, ey) || (at(nx, ey) === 0 ? hazardAt(nx, ey + 1) : 0);
        /** What a builder, a platformer or a jumper reaches across from this end: the nearest region within reach. */
        const crossings = () => {
          for (const t of regions) {
            if (t.id === r.id) continue;
            for (let k = 1; k <= MAX_BUILDERS; k++) {
              const reachX = ex + dir * BUILD_ACROSS * k, minY = ey - BUILD_UP * k;
              const hit = t.cells.some((j) => { const jx = j % cw, jy = (j / cw) | 0; return (dir > 0 ? jx > ex && jx <= reachX : jx < ex && jx >= reachX) && jy >= minY && jy <= ey; });
              if (hit) { gate(r.id, t.id, "build", "BUILDER", k, ex, ey, dir, { builders: k, twoWay: true }); break; }
            }
            // a platformer: flat, as far as a builder
            for (let k = 1; k <= MAX_BUILDERS; k++) {
              const reachX = ex + dir * PLATFORM_ACROSS * k;
              const hit = t.cells.some((j) => { const jx = j % cw, jy = (j / cw) | 0; return (dir > 0 ? jx > ex && jx <= reachX : jx < ex && jx >= reachX) && jy >= ey - 1 && jy <= ey + 1; });
              if (hit) { gate(r.id, t.id, "platform", "PLATFORMER", k, ex, ey, dir, { platformers: k, twoWay: true }); break; }
            }
          }
          // a jump: an arc two cells up over seven across, through the air, onto a ledge on the way or wherever the fall after it lands
          let to = -1;
          for (let k = 1; k <= JUMP_ACROSS; k++) {
            const col = ex + dir * k;
            if (col < 0 || col >= cw || at(col, ey - JUMP_UP) !== 0) break;
            if (k >= 2) for (let dy = JUMP_LEDGE; dy >= 1; dy--) { const id = regionAt(col, ey - dy); if (id >= 0 && id !== r.id) { to = id; break; } }
            if (to >= 0) break;
            if (k === JUMP_ACROSS) { const l = landing(col, ey - JUMP_UP); if (l && l.region >= 0 && l.region !== r.id) to = l.region; }
          }
          if (to >= 0) gate(r.id, to, "jump", "JUMPER", 1, ex, ey, dir, { perLemming: true });
        };
        if (blockedAt(nx, ey)) {
          // a blocker: it turns whoever comes, a bomber on it opens the way (both ways) to what stands beyond
          r.ends[side] = { kind: "blocker" };
          let beyondRegion = -1;
          for (let k = 1; k <= 2 && beyondRegion < 0; k++) for (const dy of [0, -1, 1]) { const id = regionAt(nx + dir * k, ey + dy); if (id >= 0 && id !== r.id) { beyondRegion = id; break; } }
          if (beyondRegion >= 0) gate(r.id, beyondRegion, "unblock", "BOMBER", 1, nx, ey, 0, { twoWay: true });
        } else if (hz) {
          // water, fire or a trap on the way: deadly on foot; crossed above by a builder, a platformer or a jump
          r.ends[side] = { kind: hz === WATER ? "water" : hz === FIRE ? "fire" : "trap", once: hz === TRAPONCE };
          if (hz === WATER) { const to = swimOut(nx, hazardAt(nx, ey) ? ey : ey + 1, dir); if (to >= 0 && to !== r.id) gate(r.id, to, "swim", "SWIMMER", 1, ex, ey, dir, { perLemming: true }); }
          if (hz === TRAP || hz === TRAPONCE) {
            // a disarmer walks through and the trap is gone for everyone after it; a trap that fires once is gone
            // for the one lemming it takes - half a skill's worth of loss, and no skill at all
            let far = nx; while (far >= 0 && far < cw && hazardAt(far, ey) === hz) far += dir;
            let to = -1; for (const dy of [0, -1, 1]) { const id = regionAt(far, ey + dy); if (id >= 0 && id !== r.id) { to = id; break; } }
            if (to >= 0) gate(r.id, to, "disarm", "DISARMER", 1, ex, ey, dir, { perLemming: true, twoWay: true });
            if (to >= 0 && hz === TRAPONCE) gate(r.id, to, "sacrifice", null, 0.5, ex, ey, dir, { twoWay: true });
            // a trap that fires again and again is busy while it fires: a crowd through it loses some - a gauntlet, a lemming's worth
            if (to >= 0 && hz === TRAP) gate(r.id, to, "gauntlet", null, 1, ex, ey, dir, { twoWay: true });
          }
          crossings();
        } else if (beyond === 0 && at(nx, ey + 1) === 0) {
          // a drop: where it lands
          const l = landing(nx, ey);
          r.ends[side] = { kind: "drop", cells: l ? l.cells : Infinity, region: l ? l.region : -1 };
          if (l && l.hazard === WATER) { const to = swimOut(nx, l.cy, dir); if (to >= 0 && to !== r.id) gate(r.id, to, "swim", "SWIMMER", 1, ex, ey, dir, { perLemming: true }); }
          else if (l && l.region >= 0 && l.region !== r.id) {
            if (l.cells <= SPLAT_CELLS) gate(r.id, l.region, "drop", null, 0, ex, ey, dir);
            else {
              gate(r.id, l.region, "drop", "FLOATER", 1, ex, ey, dir, { perLemming: true });
              // a stoner off the edge: a stone in the fall's way, the drop cut into safe pieces for everyone after
              const stones = Math.ceil(l.cells / SPLAT_CELLS) - 1;
              if (stones <= 3) gate(r.id, l.region, "stone", "STONER", stones, ex, ey, dir, { stones });
            }
          }
          crossings();
        } else if (beyond !== 0 || (beyond === 0 && at(nx, ey - 1) !== 0)) {
          // a wall: its height, and what stands on the other side at this row
          let top = ey; while (top > 0 && at(nx, top - 1) !== 0) top--;
          let steel = false, ow = 0, far = nx;
          while (far >= 0 && far < cw && at(far, ey) !== 0) { if (at(far, ey) === 2) steel = true; ow |= g.oneway[far + ey * cw]; far += dir; }
          const thickness = Math.abs(far - nx);
          const height = ey - top + 1;
          r.ends[side] = { kind: "wall", height, thickness, steel, oneway: ow };
          // a slope the cells take for a wall: walked up on foot, both ways
          const up = walkUp(ex, ey, dir, r.id);
          if (up >= 0) { r.ends[side].kind = "slope"; gate(r.id, up, "walk", null, 0, ex, ey, dir, { twoWay: true }); }
          // one-way: a wall of arrows left is cut only by a lemming moving left (dir -1); arrows down or up stop a basher, arrows up a miner
          const sideForbids = ((ow & 1) && dir > 0) || ((ow & 2) && dir < 0);
          if (!steel && !sideForbids && far >= 0 && far < cw) {
            const l = at(far, ey + 1) !== 0 ? { cy: ey, region: regionAt(far, ey), cells: 0 } : landing(far, ey);
            if (!(ow & 12) && l && l.region >= 0 && l.region !== r.id) gate(r.id, l.region, "bash", "BASHER", 1, ex, ey, dir, { thickness, fall: l.cells, twoWay: l.cells === 0 });
            // a miner: down and along, to the floor it breaks into
            if (!(ow & 8)) for (let k = 1, mx = nx, my = ey + 1; k < 40 && mx >= 0 && mx < cw && my < ch; k++, mx += dir, my++) {
              if (at(mx, my) === 2 || (g.oneway[mx + my * cw] & 8)) break;
              if (at(mx, my) === 0) { const l2 = landing(mx, my); if (l2 && l2.region >= 0 && l2.region !== r.id) gate(r.id, l2.region, "mine", "MINER", 1, ex, ey, dir); break; }
            }
          }
          // up it: a climber to the wall's top whatever it is made of; a jump or a stack up a low one
          if (top >= 1 && at(nx, top - 1) === 0) {
            const topRegion = regionAt(nx, top - 1);
            if (topRegion >= 0 && topRegion !== r.id) {
              gate(r.id, topRegion, "climb", "CLIMBER", 1, ex, ey, dir, { perLemming: true, height });
              if (height <= JUMP_LEDGE) gate(r.id, topRegion, "jump", "JUMPER", 1, ex, ey, dir, { perLemming: true, height });
              if (height <= STACK_UP) gate(r.id, topRegion, "stack", "STACKER", 1, ex, ey, dir, { height });
            }
          }
        }
      }
      // a shimmier: a ceiling within reach over a floor cell (two or three cells up, 8 to 13 px), followed its way -
      // the ceiling stepping up or down a cell at a time, as it does with the hang - until it ends (the fall from
      // there) or a ledge stands in the way at hanging height (walked onto)
      for (const dir of [-1, 1]) {
        let found = false;
        const ordered = dir > 0 ? r.cells : r.cells.slice().reverse();
        for (const j of ordered) {
          if (found) break;
          const jx = j % cw, jy = (j / cw) | 0;
          if (at(jx, jy - 1) !== 0) continue;
          let c = at(jx, jy - 2) !== 0 ? jy - 2 : at(jx, jy - 3) !== 0 ? jy - 3 : -1;
          if (c < 0) continue;
          let x = jx, to = -1;
          while (x + dir >= 0 && x + dir < cw) {
            const nx2 = x + dir;
            let next = -1;
            for (const dc of [0, 1, -1]) { const cc = c + dc; if (cc >= 0 && cc < jy && at(nx2, cc) !== 0 && at(nx2, cc + 1) === 0) { next = cc; break; } }
            if (next >= 0) { x = nx2; c = next; continue; }
            if (at(nx2, c + 1) !== 0 && at(nx2, c) === 0) { to = regionAt(nx2, c); } // a ledge at hanging height: onto it
            else if (at(nx2, c) === 0 && at(nx2, c + 1) === 0) { const l = landing(nx2, c + 1); to = l ? l.region : -1; } // the ceiling ends: the fall
            else { const l = landing(x, c + 1); to = l ? l.region : -1; } // a wall at head height: let go where it hangs
            break;
          }
          if (to >= 0 && to !== r.id && x !== jx) { gate(r.id, to, "shimmy", "SHIMMIER", 1, jx, jy, dir, { perLemming: true }); found = true; }
        }
      }
      // the floor dug through, from anywhere in the region: the region below
      let dug = null;
      for (const j of r.cells) {
        const jx = j % cw, jy = (j / cw) | 0;
        if (at(jx, jy + 1) === 2) continue;
        let y = jy + 1; while (y < ch && at(jx, y) !== 0) { if (at(jx, y) === 2) { y = -1; break; } y++; }
        if (y < 0 || y >= ch) continue;
        const l = landing(jx, y);
        if (l && l.region >= 0 && l.region !== r.id) { dug = { to: l.region, cx: jx, cy: jy }; break; }
      }
      if (dug) gate(r.id, dug.to, "dig", "DIGGER", 1, dug.cx, dug.cy, 0);
    }
    return { cw, ch, kind, floor, hazard, region, regions, gates, exitAt, regionOf: (x, y) => regionAt(Math.floor(x / CELL), Math.floor(y / CELL)) };
  }

  /** The region a lemming stands in (or would land in), or -1. */
  function regionOfLemming(graph, x, y) {
    // (x, y) is the pixel under the feet: the cell above it is the floor cell; a lemming in the air
    // (falling, on a wall) takes the first floor cell below it
    const cx = Math.floor(x / CELL);
    if (cx < 0 || cx >= graph.cw) return -1;
    for (let d = 0; d <= 1; d++) { const id = graph.regionOf(x, y - 1 - d * CELL); if (id >= 0) return id; }
    for (let yy = Math.max(0, Math.floor((y - 1) / CELL)); yy < graph.ch; yy++) { const id = graph.region[cx + yy * graph.cw]; if (id >= 0) return id; if (graph.kind[cx + yy * graph.cw] !== 0) break; }
    return -1;
  }

  /**
   * The cheapest way from `from` = {region, dir} to an exit region:
   * { cost, steps: [{gate, dir, turn}] } or null. `skills` = counts by name
   * (a gate whose skill is out is closed); `crowd` = how many lemmings a
   * per-lemming gate is paid for (1 for the lead). The TURN_COST is a
   * blocker and a bomber: a deliberate turn.
   */
  function plan(graph, from, skills, crowd) {
    const sw = sweep(graph, { region: from.region, dir: from.dir || 1 }, skills, crowd || 1, null);
    let bestKey = null, best = Infinity;
    for (const reg of graph.regions) if (reg.exit) for (const d of [1, -1]) {
      const k = sw.key(reg.id, d);
      if (sw.dist.has(k) && sw.dist.get(k) < best) { best = sw.dist.get(k); bestKey = k; }
    }
    return bestKey === null ? null : { cost: best, steps: stepsTo(sw, bestKey) };
  }

  /**
   * Dijkstra from a state over the graph: dist and prev maps, every state
   * settled. `crowd` = a count, or { n, lacking: { CLIMBER: k, ... } } - how
   * many of the group pay a per-lemming gate (the ones without that skill).
   * `opened` = terrain gates already paid for by someone ahead (free, and
   * walked back through the other way).
   */
  const TURN_COST = 2;
  /** What taking gate `gt` costs a lemming heading `d` in `reg` besides the gate: nothing when it heads that way or a wall ahead turns it, else a blocker and a bomber. */
  function turnCost(reg, d, gt, skills) {
    if (gt.dir === 0 || gt.dir === d) return { extra: 0, turn: false };
    // a wall or a blocker ahead turns the lemming for nothing - unless the exit takes it first
    const ahead = reg.ends[d > 0 ? "right" : "left"];
    if (ahead && (ahead.kind === "wall" || ahead.kind === "blocker") && !reg.exit) return { extra: 0, turn: false };
    return { extra: skills.BLOCKER > 0 && skills.BOMBER > 0 ? TURN_COST : Infinity, turn: true };
  }

  function sweep(graph, from, skills, crowd, opened) {
    const key = (r, d) => r * 2 + (d > 0 ? 1 : 0);
    const dist = new Map(), prev = new Map(), open = [];
    const push = (r, d, c, p) => { const k = key(r, d); if (dist.has(k) && dist.get(k) <= c) return; dist.set(k, c); prev.set(k, p); open.push({ r, d, c }); };
    for (const d of from.dir ? [from.dir] : [1, -1]) push(from.region, d, 0, null);
    const settled = new Set();
    while (open.length) {
      open.sort((a, b) => a.c - b.c);
      const { r, d, c } = open.shift();
      const k = key(r, d);
      if (settled.has(k) || dist.get(k) < c) continue;
      settled.add(k);
      const reg = graph.regions[r];
      if (!reg) continue;
      // an opened two-way gate (a tunnel, a bridge) is walked from either side: its twin back
      const twins = [];
      if (opened) for (const og of opened) if (og.twoWay && og.to === r) twins.push({ from: r, to: og.from, kind: og.kind, skill: null, cost: 0, x: og.x, y: og.y, dir: -og.dir, twin: og });
      for (const gt of reg.gates.concat(twins)) {
        const free = (opened && opened.has(gt)) || !!gt.twin;
        const per = gt.perLemming ? (crowd && crowd.lacking && crowd.lacking[gt.skill] !== undefined ? crowd.lacking[gt.skill] : crowd && crowd.n !== undefined ? crowd.n : crowd || 1) : 1;
        // closed: the skill is out, or too few of it for everyone in the group who lacks it
        if (!free && gt.skill && (!(skills[gt.skill] > 0) || per > skills[gt.skill])) continue;
        const { extra, turn } = turnCost(reg, d, gt, skills);
        if (extra === Infinity) continue;
        const cost = c + extra + (free ? 0 : gt.cost * per);
        push(gt.to, gt.dir === 0 ? d : gt.dir, cost, { from: k, step: { gate: gt, dir: gt.dir === 0 ? d : gt.dir, turn } });
      }
    }
    return { dist, prev, key };
  }

  /** The steps back from a state. */
  function stepsTo(sw, k) {
    const steps = [];
    for (let cur = k; ; ) { const p = sw.prev.get(cur); if (!p) break; steps.unshift(p.step); cur = p.from; }
    return steps;
  }

  /** The cheapest exit state of a sweep: { cost, key } or null. */
  function cheapestExit(graph, sw) {
    let cost = Infinity, key = null;
    for (const reg of graph.regions) if (reg.exit) for (const d of [1, -1]) { const k = sw.key(reg.id, d); if (sw.dist.has(k) && sw.dist.get(k) < cost) { cost = sw.dist.get(k); key = k; } }
    return key === null ? null : { cost, key };
  }

  const TERRAIN = new Set(["bash", "mine", "dig", "build", "platform", "stack", "stone", "unblock", "disarm", "sacrifice"]);

  /**
   * The cheapest plan for every group of lemmings together: `groups` =
   * [{ region, dir, n, lacking, leadLacking }]. One lemming goes first -
   * the lead, tried from every group - and opens terrain gates (a tunnel, a
   * hole, a bridge) on its way, free for everyone after it and walked
   * either way; then every group pays its own way in, the per-lemming
   * gates by those lacking the skill, a gate closed to a group with more
   * lacking it than there are of the skill. Which gates to open is chosen
   * outright (none, one, then greedily more while it helps), since the
   * cheapest way for the lead alone is not the one that opens what the
   * crowd needs. Only `needed` lemmings count: the dearest are left out.
   * Returns { cost, steps: [every step], lead: [the lead's steps],
   * leadGroup, groups: [{ ...group, cost, steps }] } or null.
   */
  function planAll(graph, groups, skills, needed) {
    if (!groups.length) return null;
    const exitOf = (sw) => cheapestExit(graph, sw);
    const exitCost = (from, crowd, opened) => { const sw = sweep(graph, from, skills, crowd, opened); const ex = exitOf(sw); return ex ? { cost: ex.cost, steps: stepsTo(sw, ex.key) } : null; };
    // what each group needs on its own, one lemming's worth: the cheapest fill `needed`
    const units = groups.map((g) => { const r = exitCost({ region: g.region, dir: g.dir }, { n: 1, lacking: scaled(g.lacking, 1) }, null); return { g, unit: r ? r.cost : Infinity }; });
    units.sort((a, b) => a.unit - b.unit);
    let left = needed === undefined ? Infinity : needed;
    const taken = [];
    for (const u of units) {
      if (left <= 0) break;
      const n = Math.min(u.g.n, left);
      left -= n;
      taken.push({ region: u.g.region, dir: u.g.dir, n, lacking: scaled(u.g.lacking, n), leadLacking: u.g.leadLacking, unit: u.unit, lem: u.g.lem });
    }
    const memo = new Map();
    const keyOf = (opened) => Array.from(opened).map((gt) => gt.id).sort((a, b) => a - b).join(",");
    const groupCost = (g, opened, key) => {
      const mk = g.region + ":" + g.dir + ":" + g.n + ":" + key;
      if (memo.has(mk)) return memo.get(mk);
      const r = exitCost({ region: g.region, dir: g.dir }, g, opened);
      memo.set(mk, r);
      return r;
    };
    const terrain = graph.gates.filter((gt) => TERRAIN.has(gt.kind) && (!gt.skill || skills[gt.skill] > 0));
    let best = null;
    for (const leadGroup of taken) {
      const lead = { n: 1, lacking: leadGroup.leadLacking || scaled(leadGroup.lacking, 1) };
      const start = { region: leadGroup.region, dir: leadGroup.dir };
      const others = [];
      for (const g of taken) {
        if (g !== leadGroup) { others.push(g); continue; }
        if (g.n > 1) { const lk = {}; for (const k of Object.keys(g.lacking)) lk[k] = Math.max(0, g.lacking[k] - (lead.lacking[k] || 0)); others.push({ region: g.region, dir: 0, n: g.n - 1, lacking: scaled(lk, g.n - 1), lem: g.lem }); }
      }
      // the lead through the gates of `order` in turn, then to an exit: its cost and steps, or null
      const leadWay = (order) => {
        let pos = start, cost = 0, steps = [];
        const opened = new Set();
        for (const T of order) {
          const sw = sweep(graph, pos, skills, lead, opened);
          const reg = graph.regions[T.from];
          let via = null;
          for (const d of [1, -1]) {
            const k = sw.key(T.from, d);
            if (!sw.dist.has(k)) continue;
            const { extra, turn } = turnCost(reg, d, T, skills);
            if (extra === Infinity) continue;
            const c = sw.dist.get(k) + extra + T.cost;
            if (!via || c < via.c) via = { c, k, turn };
          }
          if (!via) return null;
          cost += via.c;
          steps = steps.concat(stepsTo(sw, via.k), [{ gate: T, dir: T.dir, turn: via.turn }]);
          opened.add(T);
          pos = { region: T.to, dir: T.dir };
        }
        const rest = graph.regions[pos.region].exit ? { cost: 0, steps: [] } : exitCost(pos, lead, opened);
        if (!rest) return null;
        return { cost: cost + rest.cost, steps: steps.concat(rest.steps), opened };
      };
      const evaluate = (order) => {
        const lw = leadWay(order);
        if (!lw) return null;
        if (best && lw.cost >= best.cost) return null;
        const key = keyOf(lw.opened);
        let total = lw.cost; const parts = [];
        for (const g of others) {
          const gc = groupCost(g, lw.opened, key);
          if (!gc) return null;
          total += gc.cost;
          if (best && total >= best.cost) return null;
          parts.push(Object.assign({}, g, gc));
        }
        // every step, marked whose it is: the lead's per-lemming gates are the lead's alone
        const all = lw.steps.map((st) => Object.assign({}, st, { who: "lead" }));
        for (const g of parts) for (const st of g.steps) all.push(Object.assign({}, st, { who: "group" }));
        return { cost: total, steps: all, lead: lw.steps, leadGroup, groups: parts, order };
      };
      const consider = (r) => { if (r && (!best || r.cost < best.cost)) best = r; return r; };
      consider(evaluate([]));
      // one gate opened, the nearest first; then, while it helps, one more on top of the best
      const sw0 = sweep(graph, start, skills, lead, null);
      const near = (T, opened) => { let d = Infinity; for (const dd of [1, -1]) { const k = sw0.key(T.from, dd); if (sw0.dist.has(k)) d = Math.min(d, sw0.dist.get(k)); } return d; };
      const ranked = terrain.map((T) => ({ T, d: near(T) })).filter((x) => isFinite(x.d)).sort((a, b) => a.d - b.d).slice(0, 48);
      let chosen = null;
      for (const { T, d } of ranked) { if (best && d + T.cost >= best.cost) break; const r = consider(evaluate([T])); if (r === best && r) chosen = r; }
      for (let round = 0; chosen && round < 2; round++) {
        let next = null;
        for (const { T } of ranked.slice(0, 24)) { if (chosen.order.includes(T)) continue; const r = consider(evaluate(chosen.order.concat([T]))); if (r === best && r) next = r; }
        chosen = next;
      }
    }
    return best;
  }

  /** `lacking` with every count capped at n. */
  function scaled(lacking, n) { const o = {}; if (lacking) for (const k of Object.keys(lacking)) o[k] = Math.min(lacking[k], n); return o; }

  Solver.Regions = { build, plan, planAll, sweep, regionOfLemming, CELL, TERRAIN, PERMS: ["CLIMBER", "FLOATER", "GLIDER", "SWIMMER", "DISARMER", "SLIDER"] };
  if (typeof module !== "undefined" && module.exports) module.exports = Solver.Regions;
})(typeof window !== "undefined" ? window : globalThis);
