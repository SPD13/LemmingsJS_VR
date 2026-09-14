#!/usr/bin/env node
"use strict";
/**
 * nx-probe: look inside the solver on one level - what the planner's graph
 * holds, what a lemming's plan is, what a node's candidates are, what a
 * plan's rollout does. For working out why a level does not solve.
 *
 *   node tools/nx-probe.js graph <level> [frame]            the regions and their gates (ends, exit, hatch)
 *   node tools/nx-probe.js pic <level> [frame]              the level as cells: # solid, S steel, ~ water, ! hazard, letters regions
 *   node tools/nx-probe.js reach <level> [frame]            the regions one lemming can reach with the level's skills, by cost
 *   node tools/nx-probe.js plan <level> [frame] [plan]      the crowd's plan (the search's own _plan) after a plan of actions
 *   node tools/nx-probe.js cands <level> <plan> [regex]     a node's candidates after a plan, filtered by a pattern on "kind SKILL>lem (why)"
 *   node tools/nx-probe.js chain <level> <plan> [lemId]     the rollout's events after a plan for one lemming (or every death)
 *   node tools/nx-probe.js pixels <level> <x0> <x1> <y0> <y1> [frame] [plan]   the physics map as pixels
 *
 * <level> is a unique part of a level id; <plan> a JSON list of [frame, lemId, skill]; frame defaults to 120.
 * NX_PLAN_DEBUG=1 makes the planner say what it tried; NX_CAND_DEBUG=<lemId> the candidates what an event yields.
 */
const fs = require("fs"), path = require("path");
const { Lemmix, nodeIO, findRepoRoot, listLevels } = require("./lemmix-node");
const Solver = require("./solver");

const gateStr = (gt) => gt.kind + (gt.skill ? ":" + gt.skill : "") + (gt.also ? "+" + gt.also : "") + "->" + gt.to + "@" + gt.x + "," + gt.y + (gt.dir < 0 ? "<" : gt.dir > 0 ? ">" : "") + " c" + gt.cost + (gt.perLemming ? "/lem" : "") + (gt.twoWay ? " 2w" : "");
const stepStr = (st) => (st.turn ? "TURN(" + st.how + ")+" : "") + gateStr(st.gate) + (st.who ? " [" + st.who + "]" : "");
const endStr = (e) => !e ? "?" : e.kind + (e.height ? e.height : e.cells !== undefined ? "v" + e.cells : "");
const toPlan = (json) => JSON.parse(json).map(([frame, lemId, skill]) => ({ type: "assignment", frame, skill, lemIndex: +String(lemId).slice(1), lemId, x: 0, y: 0, dx: 1 }));

async function load(part) {
  const root = findRepoRoot(), io = nodeIO(root);
  const styles = new Lemmix.StyleManager(io), masks = await Lemmix.loadMasks(io);
  const entry = listLevels(root).find((l) => l.id.includes(part));
  if (!entry) throw new Error("no level matches " + part);
  const data = Lemmix.LevelBuilder.parseLevel(fs.readFileSync(path.join(root, entry.url), "utf8"));
  const level = await Lemmix.LevelBuilder.build(data, styles, { seed: entry.id });
  const world = new Solver.World(level, masks);
  return { level, world, masks, entry };
}
const blockersOf = (game) => game.lemmings.filter((L) => !L.removed && L.action === Lemmix.BA.BLOCKING).map((L) => ({ x: L.x, y: L.y }));

async function main() {
  const [cmd, part, ...rest] = process.argv.slice(2);
  if (!cmd || !part) { console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 16).join("\n")); process.exit(2); }
  const { level, world, masks } = await load(part);
  const R = Solver.Regions;
  if (cmd === "graph" || cmd === "pic" || cmd === "reach") {
    world.reset([]); world.step(+(rest[0] || 120));
    const g = R.build(level, world.game.physics, blockersOf(world.game));
    if (cmd === "graph") {
      console.log(level.width + "x" + level.height + " gadgets " + level.gadgets.map((gd) => gd.effect + "@" + gd.triggerRect.x0 + "," + gd.triggerRect.y0).join(" "));
      for (const r of g.regions) console.log(r.id + ":[x" + r.x0 * 4 + "-" + (r.x1 * 4 + 3) + " y" + r.ymin * 4 + "-" + r.ymax * 4 + "]" + (r.exit ? " EXIT" : "") + (r.hatch ? " HATCH" : "") + (r.virtual ? " TUNNEL" : "") + " L:" + endStr(r.ends.left) + " R:" + endStr(r.ends.right) + " | " + r.gates.map(gateStr).join(", "));
      const skills = world.skillCounts();
      for (const L of world.game.lemmings) if (!L.removed) { const reg = R.regionOfLemming(g, L.x, L.y); const p = reg >= 0 ? R.plan(g, { region: reg, dir: L.dx }, skills, 1) : null; console.log(L.identifier + " at " + L.x + "," + L.y + " region " + reg + " plan " + (p ? p.cost + " " + p.steps.map(stepStr).join(" | ") : "none")); }
    } else if (cmd === "pic") {
      for (let cy = 0; cy < g.ch; cy++) {
        let line = String(cy * 4).padStart(4) + " ";
        for (let cx = 0; cx < g.cw; cx++) { const i = cx + cy * g.cw; let c = g.kind[i] === 2 ? "S" : g.kind[i] ? "#" : g.hazard[i] === 1 ? "~" : g.hazard[i] ? "!" : "."; if (g.region[i] >= 0) { const r = g.regions[g.region[i]]; c = r.exit ? "E" : r.hatch ? "H" : String.fromCharCode(97 + (g.region[i] % 26)); } line += c; }
        console.log(line);
      }
      console.log("regions a=0 b=1 ... (mod 26); hatch H, exit E");
    } else {
      const L0 = world.game.lemmings.find((L) => !L.removed);
      const from = L0 ? R.regionOfLemming(g, L0.x, L0.y) : (g.regions.find((r) => r.hatch) || {}).id;
      const sw = R.sweep(g, { region: from, dir: 0 }, world.skillCounts(), { n: 1, lacking: {} }, null);
      const reach = new Map(); for (const [k, c] of sw.dist) { const r = Math.floor(k / 2); if (!reach.has(r) || reach.get(r) > c) reach.set(r, c); }
      console.log("from region " + from + ": " + Array.from(reach).map(([r, c]) => r + "=" + c).join(" "));
    }
  } else if (cmd === "plan") {
    const frame = +(rest[0] || 120), plan = rest[1] ? toPlan(rest[1]) : [];
    world.reset(plan); world.step(frame);
    const analysis = Solver.analyse(level);
    const search = new Solver.Search(world, analysis, Solver.tierParams(1, level), {});
    console.log("frame " + world.frame + " skills " + JSON.stringify(world.skillCounts()) + " in " + world.game.lemmingsIn + " toRelease " + world.game.lemmingsToRelease);
    const p = search._plan(level.needCount, null);
    console.log(p ? "cost " + p.cost + " lead " + p.leadId + "\n  " + p.steps.map(stepStr).join("\n  ") : "no plan");
  } else if (cmd === "cands") {
    const plan = toPlan(rest[0] || "[]"), re = new RegExp(rest[1] || ".");
    const analysis = Solver.analyse(level);
    const search = new Solver.Search(world, analysis, Solver.tierParams(1, level), {});
    world.reset(Solver.copyPlan(plan));
    const node = search._makeNode(null, Solver.copyPlan(plan), level.needCount, null, false, true);
    const o = node.outcome;
    console.log("outcome saved " + o.saved + " lost " + o.lost + " skills " + node.skillsUsed + " stuck " + !!o.stuck + " last " + o.lastFrame + " plan " + (node.planned ? node.planned.cost : "none") + " candidates " + (node.candidates || []).length);
    if (node.planned) console.log("  plan steps: " + node.planned.steps.map((st) => (st.who || "?")[0] + ":" + (st.gate.skill ? Solver.gateKey(st.gate) : st.gate.kind)).join(" "));
    const cs = (c) => c.kind === "plan" ? "plan [" + (c.keys || []).join(" ") + "] first " + (c.first ? cs(c.first) : "-") : c.kind + " " + c.skill + ">" + c.lemId + "@" + c.frame + (c.x !== undefined ? " x" + c.x : "") + " " + c.why + " " + c.prior.toFixed(2) + (c.gate ? " gate " + Solver.gateKey(c.gate) : "");
    for (const c of (node.candidates || []).filter((c) => re.test(c.kind + " " + c.skill + ">" + c.lemId + " (" + c.why + ")")).slice(0, 40)) console.log("  " + cs(c));
  } else if (cmd === "chain") {
    const plan = toPlan(rest[0] || "[]"), who = rest[1];
    world.reset(plan);
    const analysis = Solver.analyse(level);
    const { events, outcome } = Solver.rollout(world, { field: analysis.field });
    console.log("outcome " + JSON.stringify({ saved: outcome.saved, lost: outcome.lost, alive: outcome.alive, stuck: outcome.stuck, end: outcome.endFrame, last: outcome.lastFrame, skills: outcome.skillsUsed }));
    for (const e of events) if ((who && e.lemId === who) || (!who && e.type === "DEATH")) console.log(e.frame + " " + e.type + " " + e.lemId + " " + e.x + "," + e.y + " " + (e.dx > 0 ? ">" : "<") + " " + (e.cause || "") + (e.job !== undefined ? " job " + e.job : ""));
    const g = R.build(level, world.game.physics, blockersOf(world.game));
    for (const L of world.game.lemmings) if (!L.removed) console.log(L.identifier + " " + L.x + "," + L.y + " action " + L.action + " region " + R.regionOfLemming(g, L.x, L.y));
  } else if (cmd === "pixels") {
    const [x0, x1, y0, y1] = rest.slice(0, 4).map(Number), frame = +(rest[4] || 120), plan = rest[5] ? toPlan(rest[5]) : [];
    world.reset(plan); world.step(frame);
    for (let y = y0; y <= y1; y++) { let line = ""; for (let x = x0; x <= x1; x++) line += world.game.hasPixelAt(x, y) ? "#" : "."; console.log(String(y).padStart(3) + " " + line); }
  } else { console.log("unknown command " + cmd); process.exit(2); }
}
main().catch((e) => { console.error(e.stack || e); process.exit(1); });
