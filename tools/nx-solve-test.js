#!/usr/bin/env node
"use strict";
/**
 * Checks of the solver (tools/solver/) on synthetic levels: a walk to the
 * exit needs nothing, a gap one builder, a wall one basher, a crowd a
 * blocker, water a swimmer, a trap a disarmer; a solution replays the same
 * through a fresh game; the optimiser drops a skill that did nothing; an
 * impossible level is given up at once; two skills asked on one frame land
 * on two. Then, when the Introduction pack is installed, its Skills rank
 * end to end through nx-solve.js.
 *
 * Usage: node tools/nx-solve-test.js [--quick]
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { Lemmix, nodeIO, findRepoRoot, listLevels } = require("./lemmix-node");
const Solver = require("./solver");
const F = require("./nx-fixtures");
const { PM } = Lemmix;

let masks;
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "  (" + JSON.stringify(detail) + ")" : "")); }
}

/** A floor level with a hatch on the left and an exit on the right, `count` lemmings, `need` to save, the given skills. */
function crossing(w, count, need, skills, si) {
  const level = F.makeLevel(w, 100, 60);
  F.setSpawn(level, [F.makeWindow(30, 20, 1)], count, need, si || 20);
  level.gadgets.push(F.makeExit(w - 60, 60));
  level.skills = Object.keys(skills || {}).map((name) => ({ name, count: skills[name] }));
  return level;
}
const solve = (level, budgetMs, extra) => Solver.solve(new Solver.World(level, masks), Object.assign({ tier: 1, budgetMs: budgetMs || 4000 }, extra || {}));
const skillsIn = (plan, name) => plan.filter((e) => e.type === "assignment" && e.skill === name).length;

async function main() {
  const repoRoot = findRepoRoot();
  masks = await Lemmix.loadMasks(nodeIO(repoRoot));

  console.log("walk to the exit");
  {
    const r = solve(crossing(300, 5, 5, {}));
    check("solved with no skill", r.best && r.best.saved === 5 && r.best.skillsUsed === 0, r.best);
    check("nothing expanded", r.stats.expansions === 0, r.stats.expansions);
  }

  console.log("a gap needs one builder");
  {
    const level = crossing(300, 1, 1, { BUILDER: 3 });
    level.fill(120, 60, 138, 100, 0); // 18 px: one builder's 12 bricks reach
    const r = solve(level);
    check("solved", r.best && r.best.saved >= 1, r.best);
    check("with one builder", r.best && skillsIn(r.best.plan, "BUILDER") === 1, r.best && r.best.plan.map(Solver.planEntry));
    check("the builder at the edge", r.best && r.best.plan.every((e) => e.type !== "assignment" || (e.x >= 100 && e.x <= 121)), r.best && r.best.plan);
  }

  console.log("a wall needs one basher, steel needs a climber");
  {
    const level = crossing(300, 5, 5, { BASHER: 3, CLIMBER: 3 });
    level.fill(150, 30, 160, 60, PM.SOLID);
    const r = solve(level);
    check("solved", r.best && r.best.saved === 5, r.best);
    check("one skill", r.best && r.best.skillsUsed === 1, r.best && r.best.plan.map(Solver.planEntry));
    const steel = crossing(300, 5, 5, { BASHER: 3, CLIMBER: 5 });
    steel.fill(150, 30, 160, 60, PM.SOLID | PM.STEEL);
    const r2 = solve(steel);
    check("steel: solved by climbers", r2.best && r2.best.saved === 5 && skillsIn(r2.best.plan, "BASHER") === 0, r2.best && r2.best.plan.map(Solver.planEntry));
    const none = crossing(300, 5, 5, { BASHER: 3 });
    none.fill(150, 30, 160, 60, PM.SOLID | PM.STEEL);
    const r3 = solve(none, 2000);
    check("steel and no climber: unsolved", !r3.best, r3.best);
  }

  console.log("a crowd needs a blocker");
  {
    // the hatch faces left toward a deadly drop; the exit is on the right: the first
    // lemming blocks, the others turn and walk to the exit
    const level = F.makeLevel(400, 100, 60);
    level.fill(0, 60, 40, 100, 0); // the drop off the left end
    F.setSpawn(level, [F.makeWindow(80, 20, -1)], 8, 5, 12);
    level.gadgets.push(F.makeExit(330, 60));
    level.skills = [{ name: "BLOCKER", count: 2 }];
    const r = solve(level, 6000);
    check("solved", r.best && r.best.saved >= 5, r.best);
    check("with a blocker", r.best && skillsIn(r.best.plan, "BLOCKER") >= 1, r.best && r.best.plan.map(Solver.planEntry));
  }

  console.log("hazards: water wants a swimmer or a bridge, a trap a disarmer");
  {
    const level = crossing(300, 3, 2, { SWIMMER: 3, BUILDER: 3 });
    level.fill(120, 60, 150, 100, 0);
    level.gadgets.push(F.makeGadget("WATER", 120, 56, 30, 44));
    const r = solve(level);
    check("water: solved", r.best && r.best.saved >= 2, r.best && r.best.plan.map(Solver.planEntry));
    const trap = crossing(300, 3, 3, { DISARMER: 3 });
    trap.gadgets.push(F.makeGadget("TRAP", 150, 50, 4, 11, { frameCount: 2 })); // armed again at once: no slipping past
    const r2 = solve(trap);
    check("trap: solved with disarmers", r2.best && r2.best.saved === 3 && skillsIn(r2.best.plan, "DISARMER") >= 1, r2.best && r2.best.plan.map(Solver.planEntry));
  }

  console.log("a solution replays the same through a fresh game");
  {
    const make = () => { const level = crossing(300, 1, 1, { BUILDER: 3 }); level.fill(120, 60, 138, 100, 0); return level; };
    const r = solve(make());
    check("solved", !!r.best, r.best);
    if (r.best) {
      const world = new Solver.World(make(), masks);
      world.reset(r.best.plan);
      Solver.rollout(world, { maxFrames: r.best.completionFrame + 1 });
      const text = Lemmix.Replay.serialize(world.game, { author: "nx-solve" });
      check("the replay names its author", /^AUTHOR nx-solve$/m.test(text), text.split("\n").slice(0, 3));
      const v = Solver.verify(make(), masks, text, { saved: r.best.saved, skillsUsed: r.best.skillsUsed });
      check("verified: same saved and skills", v.ok, v);
      check("same completion frame", v.completionFrame === r.best.completionFrame, [v.completionFrame, r.best.completionFrame]);
    }
  }

  console.log("the optimiser drops a skill that did nothing");
  {
    const level = crossing(300, 3, 3, { CLIMBER: 3 });
    const world = new Solver.World(level, masks);
    const analysis = Solver.analyse(level);
    // a climber on the flat floor: the level is still won, with a wasted skill
    world.step(70);
    const L = world.game.lemmings[0];
    world.assign(L, "CLIMBER");
    world.step(1);
    const plan = world.plan();
    const before = Solver.evaluate(world, plan);
    check("the wasteful plan wins", before.saved === 3 && before.skillsUsed === 1, before);
    const after = Solver.optimise(world, before, analysis, Date.now() + 4000, null);
    check("the digger is dropped", after.skillsUsed === 0 && after.saved === 3, after);
  }

  console.log("an impossible level is given up at once");
  {
    const level = crossing(300, 5, 5, {});
    level.fill(120, 60, 150, 100, 0);
    const r = solve(level, 3000);
    check("unsolved", !r.best, r.best);
    check("under 40 expansions (the nuke's moments tried, nothing else)", r.stats.expansions < 40, r.stats.expansions);
  }

  console.log("two skills wanted on one frame land on two frames");
  {
    const level = crossing(300, 2, 2, { CLIMBER: 3 });
    const world = new Solver.World(level, masks);
    world.step(120);
    const [a, b] = world.game.lemmings;
    const first = world.assign(a, "CLIMBER");
    world.step(1);
    const second = world.assign(b, "CLIMBER");
    world.step(1);
    check("both recorded", first && second && world.plan().length === 2, world.plan());
    check("on consecutive frames", world.plan()[1].frame === world.plan()[0].frame + 1, world.plan().map((e) => e.frame));
    check("both applied", a.isClimber && b.isClimber);
    // insert mode: an assignment keeps the plan's later entries
    world.game.recorded.push({ type: "nuke", frame: world.frame + 5 });
    world.step(2);
    world.assign(a, "CLIMBER");
    check("an assignment keeps the plan's later entries", world.plan().some((e) => e.type === "nuke"), world.plan());
  }

  if (process.argv.includes("--quick")) return;
  console.log("end to end: the Introduction pack's Skills rank");
  {
    const levels = listLevels(repoRoot, "NeoLemmix_Introduction_Pack/Skills");
    if (!levels.length) { console.log("  skipped: the pack is not installed"); return; }
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "nx-solve-"));
    const run = (args) => execFileSync(process.execPath, [path.join(__dirname, "nx-solve.js")].concat(args), { encoding: "utf8", maxBuffer: 1 << 26 });
    const log = run(["NeoLemmix_Introduction_Pack/Skills/Just_Digging", "--budget", "15", "--out", out]);
    check("one level solved through the CLI", /  solved /.test(log), log.split("\n").slice(-4));
    const index = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
    const rec = index.levels["NeoLemmix_Introduction_Pack/Skills/Just_Digging_Into_NeoLemmix.nxlv"];
    check("the index records it", rec && rec.status === "solved" && rec.saved >= rec.needed, rec);
    check("the replay file exists", rec && fs.existsSync(path.join(out, rec.file)));
    const verify = run(["--verify", "NeoLemmix_Introduction_Pack/Skills", "--out", out]);
    check("--verify agrees", /1 solutions verified, 0 mismatches/.test(verify), verify);
    const nxrun = execFileSync(process.execPath, [path.join(__dirname, "nx-run.js"), rec.file.replace(/\.nxrp$/, "") , "--nxrp", path.join(out, rec.file), "--frames", "3000"], { encoding: "utf8" });
    const m = /"saved":(\d+)/.exec(nxrun);
    check("nx-run --nxrp agrees", m && +m[1] === rec.saved, nxrun.split("\n")[0]);
    fs.rmSync(out, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log(passed + " passed, " + failed + " failed");
  if (failed) process.exit(1);
}).catch((e) => { console.error(e); process.exit(2); });
