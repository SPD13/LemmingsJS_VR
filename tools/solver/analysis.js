"use strict";
/**
 * What a level is, before any search: where its exits are, how far every
 * point is from one (a cost field over the map - open pixels cost one, a
 * solid pixel the effort of getting through it, steel a great deal more -
 * so a walled-in exit still has a distance, the cost of the tunnel), how
 * many lemmings can be saved at most, and which features it uses (the tags
 * the index carries, so an unsolved level says what beat the solver).
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Solver = Lemmix.Solver || (Lemmix.Solver = {});
  const { PM } = Lemmix;

  const CELL = 4;            // the field's resolution, in level pixels
  const COST_AIR = 1, COST_SOLID = 6, COST_STEEL = 60;

  /** The exit-distance field: cell costs by a bucketed Dijkstra from every exit's trigger area. */
  function exitField(level) {
    const w = level.width, h = level.height;
    const cw = Math.ceil(w / CELL), ch = Math.ceil(h / CELL);
    const cost = new Uint8Array(cw * ch);
    const phys = level.physics;
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      let solid = 0, steel = 0, n = 0;
      for (let y = cy * CELL; y < Math.min(h, (cy + 1) * CELL); y++) for (let x = cx * CELL; x < Math.min(w, (cx + 1) * CELL); x++) {
        const b = phys[x + y * w]; n++;
        if (b & PM.SOLID) { solid++; if (b & PM.STEEL) steel++; }
      }
      cost[cx + cy * cw] = steel > n / 2 ? COST_STEEL : solid > n / 2 ? COST_SOLID : COST_AIR;
    }
    const dist = new Float32Array(cw * ch).fill(Infinity);
    const buckets = [];
    const push = (d, i) => { (buckets[d] || (buckets[d] = [])).push(i); };
    const exits = level.gadgets.filter((g) => g.effectBase === "EXIT" || g.effectBase === "LOCKEXIT");
    for (const g of exits) {
      const r = g.triggerRect;
      for (let y = r.y0; y < r.y1; y += 1) for (let x = r.x0; x < r.x1; x += 1) {
        const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
        if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) continue;
        const i = cx + cy * cw;
        if (dist[i] !== 0) { dist[i] = 0; push(0, i); }
      }
    }
    for (let d = 0; d < buckets.length; d++) {
      const b = buckets[d];
      if (!b) continue;
      for (let k = 0; k < b.length; k++) {
        const i = b[k];
        if (dist[i] !== d) continue;
        const cx = i % cw, cy = (i / cw) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const j = nx + ny * cw;
          const nd = d + cost[j];
          if (nd < dist[j]) { dist[j] = nd; push(nd, j); }
        }
      }
    }
    return {
      cw, ch, dist, cost, exits,
      at(x, y) {
        const cx = Math.max(0, Math.min(cw - 1, Math.floor(x / CELL))), cy = Math.max(0, Math.min(ch - 1, Math.floor(y / CELL)));
        return dist[cx + cy * cw] * CELL;
      },
    };
  }

  /** The tags of what the level uses. */
  function features(level) {
    const tags = new Set();
    for (const g of level.gadgets) {
      const e = g.effectBase;
      if (e === "TELEPORT" || e === "RECEIVER") tags.add("teleport");
      else if (e === "BUTTON" || e === "LOCKEXIT") tags.add("button");
      else if (e === "PICKUP") tags.add("pickup");
      else if (e === "TRAP" || e === "TRAPONCE") tags.add("trap");
      else if (e === "WATER") tags.add("water");
      else if (e === "FIRE") tags.add("fire");
      else if (e === "UPDRAFT") tags.add("updraft");
      else if (e === "FLIPPER") tags.add("flipper");
      else if (e === "PORTAL") tags.add("portal");
      else if (e === "SPLAT" || e === "NOSPLAT") tags.add("splatpad");
      else if (e === "FORCELEFT" || e === "FORCERIGHT") tags.add("forcefield");
      else if (e === "NEUTRALIZER" || e === "DENEUTRALIZER") tags.add("neutralizer");
      else if (e === "ADDSKILL" || e === "REMOVESKILLS") tags.add("skillgadget");
      if (e === "WINDOW" && g.presets) { if (g.presets.zombie) tags.add("zombie"); if (g.presets.neutral) tags.add("neutral"); }
      if ((e === "EXIT" || e === "LOCKEXIT") && g.lemmingCap > 0) tags.add("exitcap");
    }
    if (level.zombieCount > 0 || (level.preplaced || []).some((p) => p.zombie)) tags.add("zombie");
    if (level.neutralCount > 0 || (level.preplaced || []).some((p) => p.neutral)) tags.add("neutral");
    if (level.timeLimitSeconds > 0) tags.add("timeLimit");
    if ((level.preplaced || []).length) tags.add("preplaced");
    if (level.entrances.length > 1) tags.add("multiHatch");
    if (level.skills.some((s) => s.name === "CLONER")) tags.add("cloner");
    if (level.spawnLocked) tags.add("lockedRR");
    let oneway = false, steel = false;
    const phys = level.physics;
    for (let i = 0; i < phys.length; i += 7) {
      const b = phys[i];
      if (b & PM.STEEL) steel = true;
      if (b & (PM.ONEWAYLEFT | PM.ONEWAYRIGHT | PM.ONEWAYDOWN | PM.ONEWAYUP)) oneway = true;
      if (steel && oneway) break;
    }
    if (oneway) tags.add("oneway");
    if (steel) tags.add("steel");
    return Array.from(tags).sort();
  }

  /** The most lemmings that could ever be saved. */
  function maxSavable(level) {
    let n = level.releaseCount - (level.zombieCount || 0);
    n += (level.skills.find((s) => s.name === "CLONER") || { count: 0 }).count;
    for (const g of level.gadgets) if (g.effectBase === "PICKUP" && g.skillName === "CLONER") n += g.skillCount || 0;
    let cap = 0, capped = true;
    for (const g of level.gadgets) {
      if (g.effectBase !== "EXIT" && g.effectBase !== "LOCKEXIT") continue;
      if (g.lemmingCap > 0) cap += g.lemmingCap; else capped = false;
    }
    if (capped && cap > 0) n = Math.min(n, cap);
    return Math.max(0, n);
  }

  function analyse(level) {
    return { field: exitField(level), features: features(level), maxSavable: maxSavable(level), needCount: level.needCount,
      spanDist: (level.width + level.height) * 2 };
  }

  Solver.analyse = analyse;
  Solver.ANALYSIS = { CELL, COST_AIR, COST_SOLID, COST_STEEL };
  if (typeof module !== "undefined" && module.exports) module.exports = { analyse, exitField, features, maxSavable };
})(typeof window !== "undefined" ? window : globalThis);
