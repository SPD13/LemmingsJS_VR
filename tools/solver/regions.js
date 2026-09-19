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
 * (dug through, unless steel), a wall built up by a staircase of builders or
 * blown open by a bomber when thin, a deadly drop cut short by a stoner's stone,
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
  const WATER = 1, FIRE = 2, TRAP = 3, TRAPONCE = 4, FORCELEFT = 5, FORCERIGHT = 6;
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
  function build(level, physics, blockers, masks) {
    const w = level.width, h = level.height;
    const g = cells(physics || level.physics, w, h);
    const { cw, ch, kind } = g;
    const at = (cx, cy) => (cx < 0 || cy < 0 || cx >= cw || cy >= ch) ? 1 : kind[cx + cy * cw];
    const floor = new Uint8Array(cw * ch);
    for (let cy = 0; cy < ch - 1; cy++) for (let cx = 0; cx < cw; cx++) if (at(cx, cy) === 0 && at(cx, cy + 1) !== 0 && at(cx, cy - 1) === 0) floor[cx + cy * cw] = 1;
    // slits: a gap narrower than a cell between two terrain pieces (a pixel or three), invisible to the cells, which
    // a walker falls into all the same - a floor cell with a pixel column whose ground lies more than eight pixels
    // under the cell's floor is no floor: the region ends there, in a drop as deep as the column goes
    const phys0 = physics || level.physics;
    const solid0 = (x, y) => x >= 0 && y >= 0 && x < w && y < h && (phys0[x + y * w] & PM.SOLID) !== 0;
    const slit = new Int16Array(cw * ch).fill(-1); // the cell's slit column (px), or -1
    const slitDepth = new Int16Array(cw * ch);     // pixels down to the ground in that column (-1: off the level)
    for (let cy = 0; cy < ch - 1; cy++) for (let cx = 0; cx < cw; cx++) {
      const i = cx + cy * cw;
      if (!floor[i]) continue;
      // the floor's level: the topmost ground pixel in the cell below across its columns
      let top = Infinity;
      for (let x = cx * CELL; x < Math.min(w, (cx + 1) * CELL); x++) for (let y = cy * CELL; y < Math.min(h, (cy + 2) * CELL); y++) if (solid0(x, y)) { if (y < top) top = y; break; }
      if (top === Infinity) continue;
      // a slit is a run of three columns at most with deep ground, bounded on both sides by ground at the floor's
      // level (a ledge's end, where the ground stays deep beyond, is a drop the cells see by themselves)
      const groundY = (x) => { let y = top; while (y < h && !solid0(x, y)) y++; return y; };
      const deep = (x) => x < 0 || x >= w || groundY(x) - top > 8;
      for (let x = cx * CELL; x < Math.min(w, (cx + 1) * CELL); x++) {
        if (!deep(x)) continue;
        let l = x - 1; while (l >= x - 3 && deep(l)) l--;
        let rr = x + 1; while (rr <= x + 3 && deep(rr)) rr++;
        if (l < 0 || rr >= w || deep(l) || deep(rr) || rr - l - 1 > 3) continue;
        const y = groundY(x);
        slit[i] = x; slitDepth[i] = y >= h ? -1 : y - top; floor[i] = 0; break;
      }
    }
    // hazards: water drowns, fire burns, a trap kills - none of their cells is floor to walk on
    const hazard = new Uint8Array(cw * ch);
    const HAZARD = { WATER, FIRE, TRAP, TRAPONCE, FORCELEFT, FORCERIGHT };
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
      // an overhang: terrain within a jump's height over some cell, which a jump into turns the jumper round
      let overhang = false;
      for (const j of list) { const jx = j % cw, jy = (j / cw) | 0; for (let k = 2; k <= 4 && !overhang; k++) if (at(jx, jy - k) !== 0) overhang = true; if (overhang) break; }
      regions.push({ id, cells: list, x0, x1, ymin, ymax, exit: false, hatch: false, overhang, ends: {}, gates: [] });
    }
    const regionAt = (cx, cy) => (cx < 0 || cy < 0 || cx >= cw || cy >= ch) ? -1 : region[cx + cy * cw];
    const phys = physics || level.physics;
    const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && (phys[x + y * w] & PM.SOLID) !== 0;
    /**
     * Where a shimmier hanging from the ceiling cell row `c` at column `cx`
     * gets to heading `dir`, as the engine moves it: along the ceiling while
     * it stays level (a step of a cell up or down in front drops it, as do
     * the teeth of a toothed ceiling), onto a ledge whose top is two cells
     * under the ceiling (hoisted), else the fall where the ceiling ends or a
     * wall meets its head. A region id, or -1 (nowhere new, or the same).
     */
    const ceilingWalk = (cx, c, dir, fromId) => {
      let x = cx;
      while (x + dir >= 0 && x + dir < cw) {
        const nx2 = x + dir;
        if (at(nx2, c) !== 0 && at(nx2, c + 1) === 0 && at(nx2, c + 2) === 0) { x = nx2; continue; }
        if (at(nx2, c + 1) !== 0) { const l = landing(x, c + 1); return l && l.region !== fromId ? l.region : -1; } // a tooth, a wall at head height: let go
        if (at(nx2, c + 2) !== 0) { const id = regionAt(nx2, c + 1); return id !== fromId ? id : -1; } // a ledge at hanging height: hoisted onto
        const l = landing(nx2, c + 1); return l && l.region !== fromId ? l.region : -1; // the ceiling ends: the fall
      }
      return -1;
    };
    /**
     * A wall the cells see that a walker climbs on foot - a slope, steps of
     * six pixels or less at the pixels: from the end cell (ex, ey) heading
     * `dir`, the ground followed pixel by pixel (up six at most, down three)
     * until another region's cell is underfoot (its id) or a real wall or
     * drop stops it (-1). At most 64 pixels of it.
     */
    const walkUp = (ex, ey, dir, fromId) => {
      // from the end cell's inner pixel (its outer one may lie inside the wall, the cell straddling it), on the
      // ground's top - which may lie inside the floor cell (a six-pixel brick)
      let x = dir > 0 ? ex * CELL : ex * CELL + CELL - 1;
      let y = ey * CELL;
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
    /**
     * Where a digger at pixel column `px` on the floor cell row `cy` ends: the shaft goes down a row at a time
     * while any pixel within three of the centre is solid (the engine's digOneRow), stops on steel under the feet,
     * else the digger falls from the shaft's end to the ground below. {region, cells (the fall for those after)}
     * or null (off the level).
     */
    const digShaft = (px, cy) => {
      let top = cy * CELL; while (top < h && !solid(px, top)) top++; // the ground's top under the feet
      if (top >= h) return null;
      let y = top;
      while (y < h) {
        if ((phys[px + y * w] & PM.STEEL) !== 0) break; // stands on the steel
        let any = false; for (let n = -3; n <= 3 && !any; n++) any = solid(px + n, y) && (phys[px + n + y * w] & PM.STEEL) === 0;
        if (!any) break;
        y++;
      }
      while (y < h && !solid(px, y)) y++; // the fall
      if (y >= h) return null;
      const cx = Math.floor(px / CELL);
      let id = regionAt(cx, Math.floor((y - 1) / CELL)); if (id < 0) id = regionAt(cx, Math.floor((y - 1) / CELL) - 1);
      return { region: id, cells: Math.round((y - top) / CELL) };
    };
    /**
     * A miner's ramp as the engine digs it, from the lemming standing on pixel (x0, y0) heading dir: the miner's
     * mask taken out twice a cycle, two steps of two along and one down a cycle, the engine's own tests for steel
     * (a turn) and for the ground gone under it (a fall). {region, fall} where the fall lands, {turn: true} at
     * steel, null off the level - or undefined without the masks (the cells' word stands then).
     */
    const rampCache = new Map();
    const mineFrom = (x0, y0, dir) => {
      const m = masks && masks.miner;
      if (!m) return undefined;
      const key = x0 + "," + y0 + "," + dir;
      if (rampCache.has(key)) return rampCache.get(key);
      const removed = new Set();
      const has = (x, y) => solid(x, y) && !removed.has(x + y * w);
      const steel = (x, y) => x >= 0 && y >= 0 && x < w && y < h && (phys[x + y * w] & PM.STEEL) !== 0;
      const md = m.data, sx = dir === 1 ? 16 : 0;
      const applyMask = (x, y, frame) => {
        const mx = x + dir - 8, my = y + frame - 12;
        for (let yy = 0; yy < 13; yy++) for (let xx = 0; xx < 16; xx++) {
          if (md[((frame * 13 + yy) * m.width + sx + xx) * 4 + 3] === 0) continue;
          const px = mx + xx, py = my + yy;
          if (px >= 0 && px < w && py >= 0 && py < h && !steel(px, py)) removed.add(px + py * w);
        }
      };
      const fallFrom = (x, y) => {
        while (y < h && !has(x, y)) y++;
        if (y >= h) return null;
        const cx = Math.floor(x / CELL);
        let id = regionAt(cx, Math.floor((y - 1) / CELL)); if (id < 0) id = regionAt(cx, Math.floor((y - 1) / CELL) - 1);
        return { region: id, fall: y - y0, x, y };
      };
      let x = x0, y = y0, out = { turn: true };
      done: for (let cycle = 0; cycle < 40; cycle++) {
        applyMask(x, y, 0); applyMask(x, y, 1);
        for (const first of [true, false]) {
          x += 2 * dir; y++;
          if (x < 0 || x >= w || y >= h) { out = null; break done; }
          if (steel(x - dir, y - 1) && steel(x, y - 1)) break done;
          if (first && steel(x - dir, y - 2)) break done;
          if (!has(x - dir, y - 1) && !has(x - dir, y) && !has(x - dir, y + 1)) { out = fallFrom(x - dir, y + 1); break done; }
          if (steel(x, y - 2)) break done;
          if (!has(x, y)) { out = fallFrom(x, y + 1); break done; }
          if (steel(x + dir, y - 2) || steel(x, y)) break done;
        }
      }
      rampCache.set(key, out);
      return out;
    };
    /** The ground's top under pixel column px from cell row cy (the pixel the feet stand on), or -1. */
    const groundTop = (px, cy) => { let y = cy * CELL; while (y < h && !solid(px, y)) y++; return y < h && y - cy * CELL <= CELL + 1 ? y : -1; };
    const buildFrom = (x0, y0, dir, k) => {
      const laid = new Set(); const has = (x, y) => solid(x, y) || laid.has(x + y * w);
      let x = x0, y = y0, bricks = 0;
      const ends = []; // where the lemming stands after each builder's last brick, or where it turned back
      for (let b = 0; b < 12 * k; b++) {
        if (y <= 1 || x < 0 || x >= w) return ends; // the level's edge: a lemming out of it (its feet at the top row) is lost, so no bridge goes on from here
        for (let n = 0; n <= 5; n++) laid.add(x + n * dir + (y - 1) * w);
        bricks++;
        const left = 12 * k - b - 1;
        if (has(x + dir, y - 2)) { ends.push({ x, y, bricks, blocked: true, laid }); return ends; }
        if (has(x + dir, y - 3) || has(x + 2 * dir, y - 2) || (has(x + 2 * dir, y - 10) && left > 0)) { ends.push({ x: x + dir, y: y - 1, bricks, blocked: true, laid }); return ends; }
        y--; x += 2 * dir;
        if (has(x, y - 2) || has(x, y - 3) || has(x + dir, y - 3) || (has(x + dir, y - 9) && left > 0)) { ends.push({ x, y, bricks, blocked: true, laid }); return ends; }
        if (bricks % 12 === 0) ends.push({ x, y, bricks, blocked: false, laid: new Set(laid) });
      }
      return ends;
    };
    /**
     * Where a walker from pixel (x, y) heading dir gets off the bricks `laid`: along them, up six pixels or down a
     * fall, to the first real ground - {region, fall} or null (a wall, off the level, still on the bricks).
     */
    const walkOff = (x, y, dir, laid) => {
      const has = (px, py) => solid(px, py) || laid.has(px + py * w);
      let cx = x, cy = y;
      for (let n = 0; n < 16; n++) {
        const nx = cx + dir; let ny = cy;
        if (nx < 0 || nx >= w) return null;
        if (has(nx, ny)) { let up = 0; while (up <= 6 && has(nx, ny - 1)) { ny--; up++; } if (up > 6) return null; }
        else { while (ny + 1 < h && !has(nx, ny + 1)) ny++; if (ny + 1 >= h) return null; }
        cx = nx; cy = ny;
        if (!laid.has(cx + cy * w)) break;
      }
      if (laid.has(cx + cy * w)) return null;
      const col = Math.floor(cx / CELL);
      let id = regionAt(col, Math.floor((cy - 1) / CELL)); if (id < 0) id = regionAt(col, Math.floor((cy - 1) / CELL) - 1);
      return { region: id, fall: cy - y };
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
      // the trigger may lie a few pixels under the floor it is walked on (a hill's exit): the nearest floor
      // cell from the trigger's bottom up to four cells above it
      const r = e.triggerRect, cx = Math.floor((r.x0 + r.x1) / 2 / CELL);
      for (let cy = Math.min(ch - 1, Math.floor(r.y1 / CELL) + 1); cy >= Math.max(0, Math.floor(r.y0 / CELL) - 4); cy--) { const id = regionAt(cx, cy); if (id >= 0) { regions[id].exit = true; exitAt.push({ region: id, x: (r.x0 + r.x1) >> 1 }); break; } }
    }
    for (const hd of level.gadgets.filter((gd) => gd.effectBase === "WINDOW")) {
      const l = landing(Math.floor(hd.triggerRect.x0 / CELL), Math.floor(hd.triggerRect.y0 / CELL));
      if (l && l.region >= 0) regions[l.region].hatch = true;
    }
    // the ends of every region, and the gates out of it
    const gates = [];
    const deadEnds = []; // tunnels a basher would dig into bedrock up to steel: regions in waiting (below)
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
          // a bridge, cell by cell along its line (a builder's rises one row in two cells, a platformer's is flat),
          // with headroom, until it meets terrain: a floor cell above the meeting point (or a floor cell on the
          // line) is where it lands, and another region there is a gate of as many builders as the length took;
          // terrain with no floor above it blocks the bridge - so does a wall in the way (the column beside a
          // hill is not built over)
          const bridge = (kind, skill, rise) => {
            if (kind === "build") {
              // a builder's bridge as the engine lays it, from the end's pixel (and four short of it): where the
              // lemming gets off the bricks after each builder, or where followers step off a bridge whose builder
              // was turned back by terrain in front
              // from the end's pixel and up to ten short of it: a start a pixel or two back makes the difference
              // between bricks that meet the far brick's face (the builder turned back, a bridge for those behind)
              // and bricks level with its top (the builder walks on) - the builder's own way across preferred
              const found = new Map();
              for (let off = 0; off <= 10; off++) {
                const sx = (dir > 0 ? ex * CELL + CELL - 1 : ex * CELL) - dir * off, sy = groundTop(sx, ey);
                if (sy < 0 || regionAt(Math.floor(sx / CELL), Math.floor((sy - 1) / CELL)) !== r.id) continue;
                for (const e of buildFrom(sx, sy, dir, MAX_BUILDERS)) {
                  const k = Math.ceil(e.bricks / 12), st = walkOff(e.x, e.y, dir, e.laid);
                  if (!st || st.region < 0 || st.region === r.id || st.fall > SPLAT_CELLS * CELL) continue;
                  const cur = found.get(st.region);
                  if (!cur || (cur.blocked && !e.blocked) || (cur.blocked === e.blocked && k < cur.k)) found.set(st.region, { k, blocked: e.blocked, fall: st.fall, px: sx, py: sy });
                }
              }
              for (const [to, b] of found) gate(r.id, to, kind, skill, b.k, ex, ey, dir, { builders: b.k, twoWay: b.fall <= 6, followersOnly: b.blocked, px: b.px, py: b.py });
              return;
            }
            const seen = new Set();
            for (let t = 1; t <= BUILD_ACROSS * MAX_BUILDERS; t++) {
              const col = ex + dir * t, row = ey - Math.floor((t * rise) / BUILD_ACROSS);
              if (col < 0 || col >= cw || row < 1) break;
              const k = Math.ceil(t / BUILD_ACROSS);
              if (at(col, row) !== 0 || at(col, row - 1) !== 0) {
                // terrain met: the floor cell over it (the bridge's end climbs onto it) or nothing
                const id = at(col, row) !== 0 ? regionAt(col, row - 1) : -1;
                if (id >= 0 && id !== r.id && !seen.has(id)) { seen.add(id); gate(r.id, id, kind, skill, k, ex, ey, dir, { builders: k, twoWay: true }); }
                break;
              }
              const id = regionAt(col, row);
              if (id >= 0 && id !== r.id && !seen.has(id)) { seen.add(id); gate(r.id, id, kind, skill, k, ex, ey, dir, { builders: k, twoWay: true }); break; }
              // at a builder's last brick the lemming walks off the end: a floor below within a safe fall is a landing too
              if (t % BUILD_ACROSS === 0) { const l = landing(col, row + 1); if (l && l.region >= 0 && l.region !== r.id && l.cells <= SPLAT_CELLS && !seen.has(l.region)) { seen.add(l.region); gate(r.id, l.region, kind, skill, k, ex, ey, dir, { builders: k, twoWay: false }); } }
            }
          };
          bridge("build", "BUILDER", BUILD_UP);
          bridge("platform", "PLATFORMER", 0);
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
        const si = (nx >= 0 && nx < cw) ? nx + ey * cw : -1;
        if (si >= 0 && slit[si] >= 0) {
          // a slit: a drop as deep as the column - deadly past the splat height or off the level - crossed by a bridge
          // (one builder or platformer) to the floor beyond it, if any; a floater rides a deep one down
          const depth = slitDepth[si], cells = depth < 0 ? Infinity : Math.ceil(depth / CELL);
          const l = depth < 0 ? null : landing(nx, ey + Math.floor(depth / CELL));
          r.ends[side] = { kind: "drop", cells, region: l ? l.region : -1, slit: true };
          if (l && l.region >= 0 && l.region !== r.id) {
            if (cells <= SPLAT_CELLS) gate(r.id, l.region, "drop", null, 0, ex, ey, dir);
            else gate(r.id, l.region, "drop", "FLOATER", 1, ex, ey, dir, { perLemming: true });
          }
          // the builder's first bricks meet the far side's floor when it stands two pixels or more above the near feet: the
          // builder is blocked and turns back (the engine's transition with a turn) - the bridge is for those behind
          const nearTop = (() => { let y = ey * CELL; while (y < h && !solid(ex * CELL + (dir > 0 ? CELL - 1 : 0), y)) y++; return y; })();
          let farTop = 0; { let x = slit[si]; while (x >= 0 && x < w && !solid(x, nearTop) && Math.abs(x - slit[si]) <= 4) x += dir; let y = Math.max(0, nearTop - 12); while (y < h && !solid(x, y)) y++; farTop = y; }
          const blocked = farTop <= nearTop - 2;
          let beyondId = -1;
          for (let k = 1; k <= 2 && beyondId < 0; k++) for (const dy of [0, -1, 1]) { const id = regionAt(nx + dir * k, ey + dy); if (id >= 0 && id !== r.id) { beyondId = id; break; } }
          if (beyondId >= 0) { gate(r.id, beyondId, "build", "BUILDER", 1, ex, ey, dir, { builders: 1, twoWay: true, followersOnly: blocked }); gate(r.id, beyondId, "platform", "PLATFORMER", 1, ex, ey, dir, { platformers: 1, twoWay: true, followersOnly: blocked }); }
          crossings();
          // every bridge from here onto the floor beyond the slit is the same bridge: blocked the same way
          if (beyondId >= 0 && blocked) for (const gt of r.gates) if (gt.to === beyondId && (gt.kind === "build" || gt.kind === "platform")) gt.followersOnly = true;
        } else if (hz === FORCELEFT || hz === FORCERIGHT) {
          // a force field: it turns whoever comes against it and lets the others through on foot
          r.ends[side] = { kind: "force", dir: hz === FORCELEFT ? -1 : 1 };
          let far = nx; while (far >= 0 && far < cw && hazardAt(far, ey) === hz) far += dir;
          let to = -1; for (const dy of [0, -1, 1]) { const id = regionAt(far, ey + dy); if (id >= 0 && id !== r.id) { to = id; break; } }
          if (to >= 0 && r.ends[side].dir === dir) gate(r.id, to, "walk", null, 0, ex, ey, dir);
        } else if (blockedAt(nx, ey)) {
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
          // the tunnel a basher cuts is the lemming's height over its feet: the wall is measured a cell up, where
          // the tunnel's middle runs, and the far side is where that row meets air - the tunnel's floor stays at
          // the feet, so the way out must be a floor at that level or a cell above it (a hollow higher up is
          // passed under: the tunnel runs on)
          let steel = false, ow = 0, far = nx, tr = ey, thickness = Infinity, l = null;
          for (const row of [ey >= 1 ? ey - 1 : ey]) {
            steel = false; ow = 0; far = nx; tr = row;
            // the tunnel runs until air or steel (a basher stops at steel, the tunnel dug so far stays)
            while (far >= 0 && far < cw && at(far, tr) !== 0 && at(far, tr) !== 2 && at(far, ey) !== 2) { ow |= g.oneway[far + tr * cw] | g.oneway[far + ey * cw]; far += dir; }
            steel = far >= 0 && far < cw && (at(far, tr) === 2 || at(far, ey) === 2);
            thickness = Math.abs(far - nx);
            // out of the tunnel: onto the floor at the tunnel's level, a step down, or the fall from there
            const out = far < 0 || far >= cw ? null : regionAt(far, tr) >= 0 ? { cy: tr, region: regionAt(far, tr), cells: 0 } : at(far, ey) !== 0 ? { cy: tr, region: -1, cells: 0 } : at(far, ey + 1) !== 0 ? { cy: ey, region: regionAt(far, ey), cells: 0 } : landing(far, ey);
            l = out && out.region < 0 && out.cells === 0 ? landing(far, tr) : out;
            if (l && l.region >= 0 && l.region !== r.id) break;
          }
          let top = ey; while (top > 0 && at(nx, top - 1) !== 0) top--;
          const height = ey - top + 1;
          r.ends[side] = { kind: "wall", height, thickness, steel, oneway: ow };
          // a slope the cells take for a wall: walked up on foot, both ways
          const up = walkUp(ex, ey, dir, r.id);
          if (up >= 0) { r.ends[side].kind = "slope"; gate(r.id, up, "walk", null, 0, ex, ey, dir, { twoWay: true }); }
          // one-way: a wall of arrows left is cut only by a lemming moving left (dir -1); arrows down or up stop a basher, arrows up a miner
          const sideForbids = ((ow & 1) && dir > 0) || ((ow & 2) && dir < 0);
          if (steel && thickness >= 2 && !sideForbids && !(ow & 12) && far >= 0 && far < cw) {
            // a tunnel that ends at steel is a floor of its own. Up from its end: through a thin roof (three cells
            // or fewer) a bomber blows a way to the floor above; under an open shaft a staircase of builders goes
            // up the steel to whatever stands above - one gate for the two skills either way
            // the roof over the tunnel's last stretch (eight cells back from the steel): its thinnest spot
            let above = -1, roof = -1, bombAt = far - dir;
            for (let k = 1; k <= 8 && k < thickness; k++) {
              const cc = far - dir * k, px = cc * CELL + 2;
              let y = ey * CELL + CELL - 1, rf = 0, ground = 0, air = 0;
              while (y >= 0 && solid(px, y) && ground < CELL) { ground++; y--; }
              while (y >= 0 && !solid(px, y) && air < 14) { air++; y--; } // the tunnel's own height
              while (y >= 0 && solid(px, y) && rf <= 16) { rf++; y--; }
              if (y < 0 || Math.max(air, 10) + rf > 14 || solid(px, y)) continue; // the blast reaches fourteen pixels over the feet, the tunnel itself ten high
              let id = -1; for (const dx of [0, -1, 1]) id = Math.max(id, regionAt(cc + dx, Math.floor(y / CELL)), regionAt(cc + dx, Math.floor(y / CELL) - 1));
              if (id >= 0 && id !== r.id && (roof < 0 || rf < roof)) { roof = rf; above = id; bombAt = cc; }
            }
            if (above >= 0 && roof >= 1 && false) gate(r.id, above, "bashbomb", "BASHER", 2.5, ex, ey, dir, { thickness, also: "BOMBER", alsoCost: 1, wallX: bombAt * CELL + 2 }); // (a hole over the head is no way up)
            deadEnds.push({ from: r.id, nx, far, ey, dir, ex });
            const c = far - dir;
            if (roof === 0) {
              let stop = tr; while (stop > 0 && at(far, stop - 1) !== 0) stop--;
              let open = true; for (let rr = tr - 1; rr >= stop - 1 && rr >= 0; rr--) if (at(c, rr) !== 0) { open = false; break; }
              if (open && stop >= 1 && at(far, stop - 1) === 0) {
                const top = regionAt(far, stop - 1), h = ey - stop + 1, k = Math.ceil(h / BUILD_UP);
                if (top >= 0 && top !== r.id && k <= MAX_BUILDERS && thickness >= BUILD_ACROSS * k) gate(r.id, top, "bashup", "BASHER", 1 + k, ex, ey, dir, { thickness, also: "BUILDER", alsoCost: k, builders: k, wallX: far * CELL - (dir > 0 ? 1 : -CELL), runUp: BUILD_ACROSS * CELL * k });
              }
            }
          }
          if (!steel && !sideForbids && far >= 0 && far < cw) {
            if (!(ow & 12) && l && l.region >= 0 && l.region !== r.id) gate(r.id, l.region, "bash", "BASHER", 1, ex, ey, dir, { thickness, fall: l.cells, twoWay: l.cells === 0, span: [Math.min(nx, far), Math.max(nx, far)], arrival: { col: far, row: l.cy } });
          // a miner: down and along, to the floor it breaks into
            if (!(ow & 8)) for (let k = 1, mx = nx, my = ey + 1; k < 40 && mx >= 0 && mx < cw && my < ch; k++, mx += dir, my++) {
              if (at(mx, my) === 2 || (g.oneway[mx + my * cw] & 8)) break;
              if (at(mx, my) === 0) {
                const l2 = landing(mx, my);
                if (l2 && l2.region >= 0 && l2.region !== r.id) {
                  // the ramp as the engine digs it must come out where the cells say (a ramp off a pillar's side falls out of the level)
                  const sx = dir > 0 ? ex * CELL + CELL - 1 : ex * CELL, sy = groundTop(sx, ey);
                  const sim = sy >= 0 ? mineFrom(sx, sy, dir) : undefined;
                  if (sim === undefined || (sim && sim.region === l2.region)) gate(r.id, l2.region, "mine", "MINER", 1, ex, ey, dir, { twoWay: true });
                }
                break;
              }
            }
          }
          // a bash from higher up: a staircase of k builders at the wall raises the feet six pixels a builder, and the
          // tunnel from the staircase top, through what stands there, comes out where its span meets an opening -
          // a floor within a step of the tunnel's, or a slope above it reached by one more builder from the tunnel's
          // floor. One gate, a sequence of skills at their spots.
          for (let k = 1; k <= 2; k++) {
            if (r.x1 - r.x0 + 1 < BUILD_ACROSS * k) break;
            const feetY = ey * CELL + CELL - 1 - 6 * k, px0 = nx * CELL + (dir > 0 ? 0 : CELL - 1);
            let x = px0, hit = false, out = -1;
            for (let n = 0; n < 240; n++, x += dir) {
              if (x < 0 || x >= w) break;
              let air = 0, steel = false;
              for (let yy = feetY - 9; yy <= feetY - 1; yy++) { const b = phys[x + yy * w]; if (b & PM.STEEL) steel = true; if (!(b & PM.SOLID)) air++; }
              if (steel) { hit = true; break; }
              if (air >= 4) { out = x; break; }
            }
            if (hit || out < 0 || Math.abs(out - px0) < 8) continue;
            const wallX = ex * CELL + (dir > 0 ? CELL - 1 : 0);
            const seq = [{ skill: "BUILDER", x: wallX - dir * BUILD_ACROSS * CELL * k, y: ey * CELL + 2 }, { skill: "BASHER", x: wallX, y: feetY }];
            // the floor met at the opening: level with the tunnel's floor (a step at most) - or the slope above it
            // the surface at the opening: the ground under the tunnel's floor (level: a step at most), else the first
            // surface up the opening's column (a slope or a ledge above, one more builder from the tunnel's floor)
            const surface = (x, from) => { let y = from; while (y < h - 1 && !solid(x, y + 1)) y++; return y; }; // the last air pixel over ground
            let id = -1, cost = 1 + k;
            const fy = surface(out, feetY);
            if (fy - feetY <= 6) for (const dx of [0, dir, 2 * dir]) for (const row of [Math.floor(fy / CELL), Math.floor(fy / CELL) - 1]) { if (id < 0) { const cand = regionAt(Math.floor(out / CELL) + dx, row); if (cand >= 0 && cand !== r.id) id = cand; } }
            if (id < 0) {
              const ox = out + dir * 12;
              let y = feetY - 1; while (y > feetY - 40 && solid(ox, y)) y--; // up through the body to air
              while (y > feetY - 40 && !solid(ox, y - 1)) y--; // up through the air to the surface's underside... no: to the last air over ground
              const sy = surface(ox, y);
              const above = sy > feetY - 40 && sy < feetY ? regionAt(Math.floor(ox / CELL), Math.floor(sy / CELL)) : -1;
              if (above >= 0 && above !== r.id) { id = above; cost++; seq.push({ skill: "BUILDER", x: out + dir * 4, y: feetY }); }
            }
            if (id >= 0 && id !== r.id) { gate(r.id, id, "raisedbash", "BASHER", cost, ex, ey, dir, { sequence: seq, builders: k, wallX, runUp: BUILD_ACROSS * CELL * k, feetY }); break; }
          }
          // and away from it: a lemming turned at the wall builds back the way it came, a staircase up over its own
          // region to whatever floor its line meets (a slope across a cavity), as the crossings at a drop do
          {
            // as the engine lays it, from the pixel beside the wall (and two off it, where the turn leaves the lemming)
            const back = -dir;
            const found = new Map();
            for (let off = 0; off <= 6; off++) {
              const sx = (dir > 0 ? ex * CELL + CELL - 1 : ex * CELL) + back * off, sy = groundTop(sx, ey);
              if (sy < 0 || regionAt(Math.floor(sx / CELL), Math.floor((sy - 1) / CELL)) !== r.id) continue;
              for (const e of buildFrom(sx, sy, back, MAX_BUILDERS)) {
                const k = Math.ceil(e.bricks / 12), st = walkOff(e.x, e.y, back, e.laid);
                if (!st || st.region < 0 || st.region === r.id || st.fall > SPLAT_CELLS * CELL) continue;
                const cur = found.get(st.region);
                if (!cur || (cur.blocked && !e.blocked) || (cur.blocked === e.blocked && k < cur.k)) found.set(st.region, { k, blocked: e.blocked, fall: st.fall, px: sx, py: sy });
              }
            }
            for (const [to, b] of found) gate(r.id, to, "build", "BUILDER", b.k, ex, ey, back, { builders: b.k, twoWay: b.fall <= 6, followersOnly: b.blocked, fromWall: true, px: b.px, py: b.py });
          }
          // up it: a climber to the wall's top whatever it is made of; a jump or a stack up a low one; a staircase
          // of builders up it, one per three cells of height, given the run-up (six cells of floor a builder)
          if (top >= 1 && at(nx, top - 1) === 0) {
            const topRegion = regionAt(nx, top - 1);
            if (topRegion >= 0 && topRegion !== r.id) {
              // the climber's own column (the pixel beside the wall) must be clear from six over its feet to the
              // wall's top: terrain there clips it off the wall (the brick over the ramp's top under a two-brick wall)
              // the wall's own pixel column: the first solid pixel a step over the feet, out from the end cell's middle
              let feetY = groundTop(ex * CELL + 2, ey), wallPx = ex * CELL + 2;
              if (feetY >= 0) { for (let n = 0; n < 8 && wallPx >= 0 && wallPx < w && !solid(wallPx, feetY - 3); n++) wallPx += dir; }
              const bodyX = wallPx - dir;
              if (feetY >= 0) feetY = groundTop(bodyX, ey);
              let wallTop = top * CELL; while (wallTop < h && !solid(wallPx, wallTop)) wallTop++;
              let clear = feetY >= 0 && wallPx >= 0 && wallPx < w && solid(wallPx, feetY - 3);
              if (clear) for (let y = feetY - 6; y >= wallTop - 2 && y >= 0; y--) if (solid(bodyX, y)) { clear = false; break; }
              if (clear) gate(r.id, topRegion, "climb", "CLIMBER", 1, ex, ey, dir, { perLemming: true, height });
              if (height <= JUMP_LEDGE) gate(r.id, topRegion, "jump", "JUMPER", 1, ex, ey, dir, { perLemming: true, height });
              if (height <= STACK_UP) gate(r.id, topRegion, "stack", "STACKER", 1, ex, ey, dir, { height });
              const k = Math.ceil(height / BUILD_UP);
              let shaft = true; for (let rr = ey - 1; rr >= top - 1 && rr >= 0; rr--) if (at(ex, rr) !== 0) { shaft = false; break; }
              if (shaft && k <= MAX_BUILDERS && r.x1 - r.x0 + 1 >= BUILD_ACROSS * k) gate(r.id, topRegion, "buildup", "BUILDER", k, ex - dir * BUILD_ACROSS * k, ey, dir, { builders: k, height, wallX: ex * CELL + 2, runUp: BUILD_ACROSS * CELL * k });
            }
          }
          // through a thin one: a bomber at its foot blows it open for everyone after (the bomber is lost)
          if (!steel && thickness <= 3 && far >= 0 && far < cw) {
            const l = regionAt(far, tr) >= 0 ? { cy: tr, region: regionAt(far, tr), cells: 0 } : at(far, ey + 1) !== 0 ? { cy: ey, region: regionAt(far, ey), cells: 0 } : landing(far, ey);
            if (l && l.region >= 0 && l.region !== r.id) gate(r.id, l.region, "bomb", "BOMBER", 1.5, ex, ey, dir, { thickness, twoWay: l.cells === 0 });
          }
          // a ceiling over the climber's own column before the wall's top: its head meets it and it falls - or,
          // a shimmier, hangs on and gets along the ceiling its way
          for (let cc = ey - 3; cc > top - 3 && cc >= 0; cc--) {
            if (at(ex, cc) === 0 || at(ex, cc + 1) !== 0) continue;
            const end = ceilingWalk(ex, cc, dir, r.id);
            if (end >= 0 && end !== r.id) gate(r.id, end, "climbshimmy", "CLIMBER", 2, ex, ey, dir, { perLemming: true, also: "SHIMMIER", ceiling: cc });
            break;
          }
        }
      }
      // a shimmier: a ceiling within reach over a floor cell (two or three cells up, 8 to 13 px), followed its way
      for (const dir of [-1, 1]) {
        let found = false;
        const ordered = dir > 0 ? r.cells : r.cells.slice().reverse();
        for (const j of ordered) {
          if (found) break;
          const jx = j % cw, jy = (j / cw) | 0;
          if (at(jx, jy - 1) !== 0) continue;
          const c = at(jx, jy - 2) !== 0 ? jy - 2 : at(jx, jy - 3) !== 0 ? jy - 3 : -1;
          if (c < 0) continue;
          const to = ceilingWalk(jx, c, dir, r.id);
          if (to >= 0 && to !== r.id) { gate(r.id, to, "shimmy", "SHIMMIER", 1, jx, jy, dir, { perLemming: true }); found = true; }
        }
      }
      // the roof blown through, from anywhere in the region: a thin ceiling (three cells or fewer) with a floor
      // of another region above it - a bomber under it opens the way up (the bomber is lost)
      const ups = new Set();
      for (let n = 0; n < 0; n++) { // (no bomb-up: a bomber under a roof opens a hole over its head, not a ramp a walker climbs)
        let up = null;
        const j = r.cells[n], jx = j % cw, jy = (j / cw) | 0, px = jx * CELL + 2;
        // at the pixels (a tunnel's roof is thinner than a cell): the air over the feet, then the roof, then air again
        let y = jy * CELL + CELL - 1, air = 0, roof = 0, ground = 0;
        while (y >= 0 && solid(px, y) && ground < CELL) { ground++; y--; } // the ground's own pixels inside the floor cell
        while (y >= 0 && !solid(px, y) && air < 14) { air++; y--; }
        if (y < 0 || !solid(px, y)) continue;
        while (y >= 0 && solid(px, y) && roof <= 16) { roof++; y--; }
        if (y < 0 || air + roof > 14 || solid(px, y)) continue; // the blast reaches fourteen pixels over the feet
        // the floor above: in this column or the next either way (a bowl's floor cell sits a column over)
        let id = -1; for (const dx of [0, -1, 1]) id = Math.max(id, regionAt(jx + dx, Math.floor(y / CELL)), regionAt(jx + dx, Math.floor(y / CELL) - 1));
        if (id >= 0 && id !== r.id && !ups.has(id)) { ups.add(id); up = { to: id, cx: jx, cy: jy }; }
        if (up) gate(r.id, up.to, "bombup", "BOMBER", 1.5, up.cx, up.cy, 0);
      }
      // the floor dug through, from anywhere in the region: the region below - the shaft as the engine digs it
      // (a row at a time while any pixel within three of the centre is solid, so a shaft over a pillar's edge runs
      // down its side and off the level; the cells alone read a landing on the pillar's decoration)
      let dug = null;
      for (const j of r.cells) {
        const jx = j % cw, jy = (j / cw) | 0;
        if (at(jx, jy + 1) === 2) continue;
        let y = jy + 1; while (y < ch && at(jx, y) !== 0) { if (at(jx, y) === 2) { y = -1; break; } y++; }
        if (y < 0 || y >= ch) continue;
        const l = landing(jx, y);
        if (!l || l.region < 0 || l.region === r.id) continue;
        const shaft = digShaft(jx * CELL + 2, jy);
        if (process.env.NX_DIG_DEBUG) console.log("dig", r.id, "cell", jx * CELL + 2, jy * CELL, "cells say", l.region, "shaft", JSON.stringify(shaft));
        if (!shaft || shaft.region < 0 || shaft.region === r.id) continue;
        dug = { to: shaft.region, cx: jx, cy: jy, depth: shaft.cells }; break;
      }
      // the shaft is the digger's own way down, a step at a time; for everyone after it is a fall of the shaft's
      // depth - deadly past the splat height, a floater's job then
      if (dug) gate(r.id, dug.to, "dig", "DIGGER", 1, dug.cx, dug.cy, 0, { depth: dug.depth, deep: dug.depth > SPLAT_CELLS });
    }
    // a tunnel a basher digs into the bedrock up to steel is a floor of its own once dug, and what can be
    // done from it or into it is worth planning before the first stroke: it becomes a region in waiting,
    // reached by the bash (walked back out the same way), with a bomber up through a thin roof, and with a
    // miner's ramp down into it from any floor above within reach - a ramp is walked both ways, so the crowd
    // in the tunnel gets up it once someone above has mined it
    for (const t of deadEnds) {
      const cells = [];
      for (let x = t.nx; (t.dir > 0 ? x < t.far : x > t.far); x += t.dir) cells.push(x + t.ey * cw);
      if (cells.length < 3) continue;
      const id = regions.length;
      const xs = cells.map((j) => j % cw);
      const v = { id, cells, x0: Math.min(...xs), x1: Math.max(...xs), ymin: t.ey, ymax: t.ey, exit: false, hatch: false, overhang: false, virtual: true, ends: { left: { kind: "wall" }, right: { kind: "wall" } }, gates: [] };
      regions.push(v);
      gate(t.from, id, "bash", "BASHER", 1, t.ex, t.ey, t.dir, { thickness: cells.length, twoWay: true, tunnel: true });
      // its far end is the steel that stopped the bash: a climber goes up it to whatever floor is at its top
      { let top = t.ey; while (top > 0 && at(t.far, top - 1) !== 0) top--; const topRegion = top >= 1 && at(t.far, top - 1) === 0 ? regionAt(t.far, top - 1) : -1; if (topRegion >= 0 && topRegion !== id) gate(id, topRegion, "climb", "CLIMBER", 1, t.far - t.dir, t.ey, t.dir, { perLemming: true, height: t.ey - top + 1 }); }
      // up through the roof, where it is thin enough for the blast (the tunnel itself ten pixels high)
      const ups = new Set();
      for (const j of cells) {
        const jx = j % cw, px = jx * CELL + 2;
        let y = t.ey * CELL + CELL - 1 - 10, roof = 0;
        while (y >= 0 && solid(px, y) && roof <= 4) { roof++; y--; }
        if (y < 0 || roof === 0 || roof > 4 || solid(px, y)) continue;
        let above = -1; for (const dx of [0, -1, 1]) above = Math.max(above, regionAt(jx + dx, Math.floor(y / CELL)), regionAt(jx + dx, Math.floor(y / CELL) - 1));
        if (above >= 0 && above !== t.from && !ups.has(above) && false) { ups.add(above); gate(id, above, "bombup", "BOMBER", 1.5, jx, t.ey, 0); } // (no bomb-up, as above)
      }
    }
    // a staircase from inside a region, as the engine lays it: a builder given on a step of the floor (a brick's
    // top, a slope's foot) whose bricks clear a wall's top or reach a ledge no bridge from the region's end does
    // (the exit block over the brick under it: from the brick a builder's bricks pass over the block's top, from
    // the floor at the block's foot they run into it). Every fourth pixel of the floor is tried, both ways, up to
    // six builders in a row, the bricks checked pixel by pixel by the builder's own rules; a builder turned back by
    // terrain in front leaves a bridge for those behind. One gate per pair and way, the fewest builders kept, and
    // none where a bridge from the end already leads for as few.
    for (const r of regions) {
      if (r.virtual || r.exit) continue;
      for (const dir of [-1, 1]) {
        const ex = dir < 0 ? r.x0 : r.x1, wallX = ex * CELL + 2;
        const best = new Map(); // to -> {k, cx, cy, followersOnly, twoWay, starts}
        for (const j of r.cells) for (const half of [0, 2]) {
          const jx = j % cw, jy = (j / cw) | 0, px = jx * CELL + half;
          let y0 = jy * CELL; while (y0 < h && !solid(px, y0)) y0++;
          if (y0 - jy * CELL > CELL + 1) continue;
          const runUp = Math.abs(wallX - px);
          if (runUp < 6 || runUp > 48) continue; // the moment is found from the walk to the end: within the ring's reach
          const ends = buildFrom(px, y0, dir, MAX_BUILDERS);
          for (const e of ends) {
            const k = Math.ceil(e.bricks / 12);
            const st = walkOff(e.x, e.y, dir, e.laid || new Set());
            if (!st || st.region < 0 || st.region === r.id || st.fall > SPLAT_CELLS * CELL) continue;
            const cur = best.get(st.region);
            if (process.env.NX_STEP_DEBUG && r.id === +process.env.NX_STEP_DEBUG) console.log("step", r.id, "dir", dir, "from", px, y0, "k", k, "blocked", e.blocked, "->", st.region, "fall", st.fall);
            const better = !cur || (cur.followersOnly && !e.blocked) || (cur.followersOnly === e.blocked && k < cur.k);
            if (better) best.set(st.region, { k, cx: jx, cy: jy, followersOnly: e.blocked, twoWay: st.fall <= 6, runUp, starts: (cur && cur.k === k && cur.followersOnly === e.blocked ? cur.starts : 0) + 1, px, py: y0 });
            else if (k === cur.k && cur.followersOnly === e.blocked) cur.starts++;
          }
        }
        for (const [to, b] of best) {
          // (a single start is no pixel's luck: the search places the builder on the gate's own pixel)
          if (r.gates.some((gt) => gt.to === to && gt.dir === dir && (gt.kind === "build" || gt.kind === "buildup" || gt.kind === "platform") && gt.cost <= b.k)) continue;
          gate(r.id, to, "buildup", "BUILDER", b.k, b.cx, b.cy, dir, { builders: b.k, wallX, runUp: b.runUp, fromStep: true, twoWay: b.twoWay, followersOnly: b.followersOnly, px: b.px, py: b.py });
        }
      }
    }
    // a miner's ramp from any floor to a floor below within twelve cells: two cells along for one down, through
    // plain terrain (no steel, no air), landing on a cell of the region below - into a tunnel in waiting as into a
    // real region; one gate per pair and way. Walked both ways once mined.
    const rowsOf = regions.map((v) => { const m = new Map(); for (const j of v.cells) { const jy = (j / cw) | 0; if (!m.has(jy)) m.set(jy, new Set()); m.get(jy).add(j % cw); } return m; });
    for (const u of regions) {
      if (u.virtual) continue;
      for (const v of regions) {
        if (v === u || v.ymin <= u.ymin) continue;
        if (v.ymin - u.ymax > 12) continue;
        for (const dir of [-1, 1]) {
          let found = null;
          for (const j of u.cells) {
            const ux = j % cw, uy = (j / cw) | 0;
            // down the diagonal through plain terrain: to a cell of v, or into air (the miner falls) landing in v
            for (let k = 1; k <= 12 && !found; k++) {
              const x = ux + dir * 2 * k, y = uy + k, c = at(x, y);
              if (c === 2) break;
              // into air: only at the floor's level (a cell over its ground at most) - through a tunnel's roof the
              // ramp ends ten pixels over the floor, a drop no walker comes back up
              if (c === 0) { const rowA = rowsOf[v.id].get(y), rowB = rowsOf[v.id].get(y + 1); if ((rowA && rowA.has(x)) || (rowB && rowB.has(x))) found = { ux, uy, dir }; break; }
              // onto a floor cell of v: for a tunnel in waiting (still solid) only over steel - the miner is stopped by
              // nothing else and digs on through the floor
              const row = rowsOf[v.id].get(y + 1);
              if (k >= 2 && row && row.has(x)) { if (!v.virtual || at(x, y + 2) === 2) found = { ux, uy, dir }; break; }
            }
            if (found && !v.virtual) {
              // the ramp as the engine digs it must come out in v (the cells read a landing on a pillar's decoration
              // where the miner runs off its side and out of the level)
              const sy = groundTop(ux * CELL + 2, uy), sim = sy >= 0 ? mineFrom(ux * CELL + 2, sy, dir) : undefined;
              if (process.env.NX_RAMP_DEBUG) console.log("ramp", u.id, "->", v.id, "from", ux * CELL + 2, sy, dir, "sim", JSON.stringify(sim));
              if (sim !== undefined && !(sim && sim.region === v.id)) found = null;
            }
            if (found) break;
          }
          if (found) gate(u.id, v.id, "mine", "MINER", 1, found.ux, found.uy, found.dir, { twoWay: true, ramp: true });
        }
      }
    }
    // a bash whose tunnel runs under cells of the region it comes out in - the region walks over the wall's top,
    // a brick's step down onto the far floor - takes those cells away (the wall's top is left ten pixels over the
    // tunnel's floor, no step): the bash comes out in what is left, the far floor's own part, a region of its own
    // for the plan (`alias` the region it is cut from, for the search's matching), with the gates worked from there
    for (const bg of gates.slice()) {
      if (bg.kind !== "bash" || !bg.span || bg.to < 0) continue;
      const to = regions[bg.to];
      if (to.virtual) continue;
      const lost = new Set();
      for (const j of to.cells) { const jx = j % cw, jy = (j / cw) | 0; if (jx >= bg.span[0] && jx < bg.span[1] && jy <= bg.y / CELL) lost.add(j); }
      // the tunnel's own columns beyond the wall count too when the region's cells there stand over the tunnel row
      if (!lost.size) continue;
      const keep = new Set(to.cells.filter((j) => !lost.has(j)));
      const start = to.cells.find((j) => j % cw === bg.arrival.col && !lost.has(j) && Math.abs(((j / cw) | 0) - bg.arrival.row) <= 1);
      if (start === undefined) continue;
      const comp = new Set([start]), stack = [start];
      while (stack.length) { const j = stack.pop(); const jx = j % cw, jy = (j / cw) | 0; for (const dx of [-1, 1]) for (const dy of [-1, 0, 1]) { const k = jx + dx + (jy + dy) * cw; if (jx + dx >= 0 && jx + dx < cw && keep.has(k) && !comp.has(k)) { comp.add(k); stack.push(k); } } }
      if (comp.size === keep.size && !lost.size) continue;
      const cells = Array.from(comp);
      let x0 = Infinity, x1 = -Infinity, ymin = Infinity, ymax = -Infinity;
      for (const j of cells) { const jx = j % cw, jy = (j / cw) | 0; if (jx < x0) x0 = jx; if (jx > x1) x1 = jx; if (jy < ymin) ymin = jy; if (jy > ymax) ymax = jy; }
      const V = { id: regions.length, cells, x0, x1, ymin, ymax, exit: to.exit, hatch: false, overhang: to.overhang, ends: to.ends, gates: [], virtual: false, alias: to.id, afterBash: bg };
      regions.push(V);
      for (const gt of to.gates) {
        const cx = Math.floor(gt.x / CELL), cy = Math.floor(gt.y / CELL);
        if (!comp.has(cx + cy * cw) && !comp.has(cx + (cy + 1) * cw) && !comp.has(cx + (cy - 1) * cw)) continue;
        const copy = Object.assign({}, gt, { from: V.id, id: gates.length }); gates.push(copy); V.gates.push(copy);
      }
      bg.to = V.id;
    }
    return { cw, ch, kind, floor, hazard, slit, slitDepth, region, regions, gates, exitAt, regionOf: (x, y) => regionAt(Math.floor(x / CELL), Math.floor(y / CELL)) };
  }

  /** The region a climber on the wall beside (x, y), heading dx, gets to: the floor at the wall's top, or -1. */
  function regionOfClimber(graph, x, y, dx) {
    const cx = Math.floor((x + dx) / CELL), cw = graph.cw;
    if (cx < 0 || cx >= cw) return -1;
    let row = Math.floor((y - 1) / CELL);
    if (row < 0 || graph.kind[cx + row * cw] === 0) row = Math.floor((y + 4) / CELL);
    while (row >= 0 && graph.kind[cx + row * cw] !== 0) row--;
    return row >= 0 ? graph.region[cx + row * cw] : -1;
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
  /**
   * What taking gate `gt` costs a lemming heading `d` in `reg` besides the
   * gate: nothing when it heads that way or a wall, a blocker or a force
   * field ahead turns it (not in the exit's region, where the exit takes it
   * first); else a turn of its own - a blocker and a bomber (2), a stacker
   * in its way (1), or a jump into an overhang the region has (1).
   */
  function turnCost(reg, d, gt, skills, climber) {
    if (gt.dir === 0 || gt.dir === d) return { extra: 0, turn: false };
    // a wall ahead turns the lemming for nothing - not a climber, which goes over a wall it can climb
    const ahead = reg.ends[d > 0 ? "right" : "left"];
    const climbs = climber && ahead && ahead.kind === "wall" && reg.gates.some((g) => g.kind === "climb" && g.dir === d);
    if (ahead && !reg.exit && !climbs && (ahead.kind === "wall" || ahead.kind === "blocker" || (ahead.kind === "force" && ahead.dir !== d))) return { extra: 0, turn: false };
    let extra = Infinity, how = null;
    if (skills.BLOCKER > 0 && skills.BOMBER > 0) { extra = TURN_COST; how = "BLOCKER"; }
    if (skills.STACKER > 0 && 1 < extra) { extra = 1; how = "STACKER"; }
    if (skills.JUMPER > 0 && reg.overhang && 1 < extra) { extra = 1; how = "JUMPER"; }
    return { extra, turn: extra !== Infinity, how };
  }

  function sweep(graph, from, skills, crowd, opened) {
    const climber = !!(crowd && crowd.lacking && crowd.lacking.CLIMBER === 0); // the mover has the skill already
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
      if (reg.exit) continue; // the exit takes whoever walks in: nothing leads out of its region
      // an opened two-way gate (a tunnel, a bridge) is walked from either side: its twin back
      const twins = [];
      if (opened) for (const og of opened) if (og.twoWay && og.to === r) twins.push({ from: r, to: og.from, kind: og.kind, skill: null, cost: 0, x: og.x, y: og.y, dir: -og.dir, twin: og });
      for (const gt of reg.gates.concat(twins)) {
        const free = ((opened && opened.has(gt)) || !!gt.twin) && !(gt.deep && crowd && !crowd.lead); // a deep shaft is no one's to open for the next
        const per = gt.perLemming ? (crowd && crowd.lacking && crowd.lacking[gt.skill] !== undefined ? crowd.lacking[gt.skill] : crowd && crowd.n !== undefined ? crowd.n : crowd || 1) : 1;
        // closed: the skill is out, or too few of it for everyone in the group who lacks it
        if (!free && gt.skill && (!(skills[gt.skill] > 0) || per > skills[gt.skill])) continue;
        // a bridge only those behind the builder cross (the builder turns back): none for the lead's own way
        if (gt.followersOnly && !free && crowd && crowd.lead) continue;
        // a deep shaft (a dig past the splat height) for a group: a floater each for those without one
        let deepCost = 0;
        if (gt.deep && crowd && !crowd.lead) { const need = crowd.lacking && crowd.lacking.FLOATER !== undefined ? crowd.lacking.FLOATER : crowd.n !== undefined ? crowd.n : 1; if (need > (skills.FLOATER || 0)) continue; deepCost = need; }
        if (!free && gt.also && !(skills[gt.also] > 0)) continue;
        const { extra, turn, how } = turnCost(reg, d, gt, skills, climber);
        if (extra === Infinity) continue;
        const cost = c + extra + (free ? 0 : gt.cost * per) + deepCost;
        push(gt.to, gt.dir === 0 ? d : gt.dir, cost, { from: k, step: { gate: gt, dir: gt.dir === 0 ? d : gt.dir, turn, how } });
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

  const TERRAIN = new Set(["bash", "bashup", "bashbomb", "bombup", "raisedbash", "mine", "dig", "build", "buildup", "bomb", "platform", "stack", "stone", "unblock", "disarm", "sacrifice"]);

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
    const terrain = graph.gates.filter((gt) => TERRAIN.has(gt.kind) && (!gt.skill || skills[gt.skill] > 0) && !gt.followersOnly);
    let best = null;
    for (const leadGroup of taken) {
      const lead = { n: 1, lead: true, lacking: leadGroup.leadLacking || scaled(leadGroup.lacking, 1) };
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
          if (T.followersOnly) return null; // not the lead's to take: it would turn back
          const sw = sweep(graph, pos, skills, lead, opened);
          const reg = graph.regions[T.from];
          let via = null;
          for (const d of [1, -1]) {
            const k = sw.key(T.from, d);
            if (!sw.dist.has(k)) continue;
            const { extra, turn, how } = turnCost(reg, d, T, skills, lead.lacking && lead.lacking.CLIMBER === 0);
            if (extra === Infinity) continue;
            const c = sw.dist.get(k) + extra + T.cost;
            if (!via || c < via.c) via = { c, k, turn, how };
          }
          if (!via) return null;
          cost += via.c;
          steps = steps.concat(stepsTo(sw, via.k), [{ gate: T, dir: T.dir, turn: via.turn, how: via.how }]);
          opened.add(T);
          pos = { region: T.to, dir: T.dir };
        }
        const rest = graph.regions[pos.region].exit ? { cost: 0, steps: [] } : exitCost(pos, lead, opened);
        if (!rest) return null;
        // whatever terrain the lead works on the rest of its way is open for the crowd as well
        for (const st of rest.steps) if (TERRAIN.has(st.gate.kind) && !st.gate.twin && !st.gate.followersOnly) opened.add(st.gate);
        return { cost: cost + rest.cost, steps: steps.concat(rest.steps), opened };
      };
      // each lead's greedy climbs against its own best: another lead's plan as the mark would stop a chain of
      // gates whose first steps alone are dearer than that plan
      let lb = null;
      const dbg = typeof process !== "undefined" && process.env.NX_PLAN_DEBUG;
      const evaluate = (order) => {
        const lw = leadWay(order);
        if (dbg) console.log("    evaluate [" + order.map((T) => T.kind + "@" + T.x + (T.dir < 0 ? "<" : T.dir > 0 ? ">" : "")).join(",") + "] lead " + (lw ? lw.cost + " via " + lw.steps.map((st) => (st.turn ? "TURN+" : "") + st.gate.kind + (st.gate.skill ? ":" + st.gate.skill : "") + "@" + st.gate.x + (st.gate.dir < 0 ? "<" : st.gate.dir > 0 ? ">" : "") + "->" + st.gate.to).join(" ") : "no way"));
        if (!lw) return null;
        if (lb && lw.cost >= lb.cost) return null;
        const key = keyOf(lw.opened);
        // a terrain gate one group pays is open for the groups after it (the staircase built once)
        let total = lw.cost; const parts = [];
        let opened2 = lw.opened, key2 = key;
        for (const g of others) {
          const gc = groupCost(g, opened2, key2);
          if (dbg) console.log("      group " + g.region + " n" + g.n + " " + (gc ? gc.cost : "no way"));
          if (!gc) return null;
          total += gc.cost;
          if (lb && total >= lb.cost) return null;
          parts.push(Object.assign({}, g, gc));
          const more = gc.steps.filter((st) => TERRAIN.has(st.gate.kind) && !st.gate.twin && !opened2.has(st.gate)).map((st) => st.gate);
          if (more.length) { opened2 = new Set([...opened2, ...more]); key2 = keyOf(opened2); }
        }
        // every step, marked whose it is: the lead's per-lemming gates are the lead's alone
        const all = lw.steps.map((st) => Object.assign({}, st, { who: "lead" }));
        // a group's step through a gate the lead opens (or its twin, walked back through) is free thanks to the
        // lead: it says which lead gate it rides on, so the search takes the lead's gate first
        for (const g of parts) for (const st of g.steps) { const via = lw.opened.has(st.gate) ? st.gate : st.gate.twin && lw.opened.has(st.gate.twin) ? st.gate.twin : null; all.push(Object.assign({}, st, { who: "group", group: g, via })); }
        // (a gate an earlier group paid shows in the later group's steps as that gate again: the route takes it once)
        // the whole route's skills must fit the stock: four climbs for one lemming with three climbers is no way
        const used = {};
        const spend = (skill, n) => { if (!skill) return; used[skill] = (used[skill] || 0) + n; };
        for (const st of all) {
          const gt = st.gate;
          if (gt.twin || (lw.opened.has(gt) && st.who === "group")) continue;
          const per = gt.perLemming ? (st.who === "lead" ? (lead.lacking[gt.skill] !== undefined ? lead.lacking[gt.skill] : 1) : (st.group.lacking && st.group.lacking[gt.skill] !== undefined ? st.group.lacking[gt.skill] : st.group.n)) : 1;
          if (gt.sequence) for (const it of gt.sequence) spend(it.skill, 1);
          else { spend(gt.skill, gt.cost * per); if (gt.also) spend(gt.also, gt.alsoCost || per); }
          if (gt.deep && st.who === "group" && st.group) spend("FLOATER", st.group.lacking && st.group.lacking.FLOATER !== undefined ? st.group.lacking.FLOATER : st.group.n);
          if (st.turn && st.how === "BLOCKER") { spend("BLOCKER", 1); spend("BOMBER", 1); } else if (st.turn && st.how) spend(st.how, 1);
        }
        for (const k of Object.keys(used)) if (used[k] > (skills[k] || 0)) { if (dbg) console.log("      over budget " + k + " " + used[k] + "/" + (skills[k] || 0)); return null; }
        return { cost: total, steps: all, lead: lw.steps, leadGroup, groups: parts, order };
      };
      const consider = (r) => { if (r && (!lb || r.cost < lb.cost)) lb = r; return r; };
      consider(evaluate([]));
      // the crowd's own way in, its terrain gates opened by the lead in that order: the natural plan
      for (const g of others) {
        const own = groupCost(g, new Set(), "");
        if (!own) continue;
        const order = []; for (const st of own.steps) if (TERRAIN.has(st.gate.kind) && !st.gate.followersOnly && !order.includes(st.gate)) order.push(st.gate);
        if (order.length) consider(evaluate(order));
      }
      // one gate opened, the nearest first (one gate per crossing, the cheapest); then, while it helps, one more on top of the best
      const sw0 = sweep(graph, start, skills, lead, null);
      const near = (T) => { let d = Infinity; for (const dd of [1, -1]) { const k = sw0.key(T.from, dd); if (sw0.dist.has(k)) d = Math.min(d, sw0.dist.get(k)); } return d; };
      const cheapest = new Map();
      for (const T of terrain) { const ck = T.from + ">" + T.to + ":" + (T.dir || 0); if (!cheapest.has(ck) || cheapest.get(ck).cost > T.cost) cheapest.set(ck, T); }
      const ranked = Array.from(cheapest.values()).map((T) => ({ T, d: near(T) })).filter((x) => isFinite(x.d)).sort((a, b) => a.d - b.d || a.T.cost - b.T.cost).slice(0, 48);
      let chosen = null;
      for (const { T, d } of ranked) { if (lb && d + T.cost >= lb.cost) break; const r = consider(evaluate([T])); if (r === lb && r) chosen = r; }
      for (let round = 0; chosen && round < 2; round++) {
        let next = null;
        for (const { T } of ranked) { if (chosen.order.includes(T)) continue; const r = consider(evaluate(chosen.order.concat([T]))); if (r === lb && r) next = r; }
        chosen = next;
      }
      if (typeof process !== "undefined" && process.env.NX_PLAN_DEBUG) console.log("  lead from region " + leadGroup.region + " n" + leadGroup.n + " dir " + leadGroup.dir + ": " + (lb ? "cost " + lb.cost + " order " + lb.order.map((T) => T.kind + "@" + T.x).join(",") : "none") + " ranked " + ranked.slice(0, 8).map((x) => x.T.kind + "@" + x.T.x + "=" + x.d).join(" "));
      if (lb && (!best || lb.cost < best.cost)) best = lb;
    }
    if (!best) {
      // no lead reaches an exit on its own (a bridge only those behind its builder cross): every group pays its own
      // way, the gates one opens open for the next
      let opened = new Set(), key = "", total = 0; const parts = [], all = [];
      for (const g of taken.slice().sort((a, b) => b.n - a.n)) { // the crowd first: its route is the one the search follows
        const gc = groupCost(g, opened, key);
        if (!gc) return null;
        total += gc.cost; parts.push(Object.assign({}, g, gc));
        for (const st of gc.steps) all.push(Object.assign({}, st, { who: "group", group: g }));
        const more = gc.steps.filter((st) => TERRAIN.has(st.gate.kind) && !st.gate.twin && !opened.has(st.gate)).map((st) => st.gate);
        if (more.length) { opened = new Set([...opened, ...more]); key = keyOf(opened); }
      }
      // the route's skills must fit the stock here as well
      const used = {};
      const spend = (skill, n) => { if (skill) used[skill] = (used[skill] || 0) + n; };
      const paid = new Set();
      for (const st of all) {
        const gt = st.gate;
        if (gt.twin || paid.has(gt)) continue;
        paid.add(gt);
        const per = gt.perLemming ? (st.group.lacking && st.group.lacking[gt.skill] !== undefined ? st.group.lacking[gt.skill] : st.group.n) : 1;
        if (gt.sequence) for (const it of gt.sequence) spend(it.skill, 1);
        else { spend(gt.skill, gt.cost * per); if (gt.also) spend(gt.also, gt.alsoCost || per); }
        if (gt.deep) spend("FLOATER", st.group.lacking && st.group.lacking.FLOATER !== undefined ? st.group.lacking.FLOATER : st.group.n);
        if (st.turn && st.how === "BLOCKER") { spend("BLOCKER", 1); spend("BOMBER", 1); } else if (st.turn && st.how) spend(st.how, 1);
      }
      for (const k of Object.keys(used)) if (used[k] > (skills[k] || 0)) return null;
      best = { cost: total, steps: all, lead: [], leadGroup: null, groups: parts, order: [] };
    }
    return best;
  }

  /** `lacking` with every count capped at n. */
  function scaled(lacking, n) { const o = {}; if (lacking) for (const k of Object.keys(lacking)) o[k] = Math.min(lacking[k], n); return o; }

  Solver.Regions = { build, plan, planAll, sweep, regionOfLemming, regionOfClimber, CELL, TERRAIN, PERMS: ["CLIMBER", "FLOATER", "GLIDER", "SWIMMER", "DISARMER", "SLIDER"] };
  if (typeof module !== "undefined" && module.exports) module.exports = Solver.Regions;
})(typeof window !== "undefined" ? window : globalThis);
