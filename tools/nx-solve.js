#!/usr/bin/env node
"use strict";
/**
 * Solve NeoLemmix levels headlessly and keep the solutions as .nxrp replays
 * the page plays back (the "Watch solution" button): the search of
 * tools/solver/ on the Lemmix physics, one level at a time or a whole pack
 * on a pool of workers, each solution verified through a fresh game before
 * it is written, and solutions/index.json saying what was found.
 *
 *   node tools/nx-solve.js <level>  [--tier 1|2|3] [--budget <s>] [--trace] [--events]
 *                                   [--nxrp <file>] [--no-index] [--stdout]
 *   node tools/nx-solve.js [prefix] [--tier 1|2|3|all] [--budget <s>] [--jobs N] [--force]
 *                                   [--out <dir>] [--verbose]
 *   node tools/nx-solve.js --verify [prefix]      every solution replayed through a fresh game
 *   node tools/nx-solve.js --list [prefix]        what the index says
 *
 * <level> is a level id (its path in levels/index.json, with or without
 * .nxlv) or a unique case-insensitive substring of one; anything else is a
 * prefix of ids, as with nx-run, and no argument means every Lemmix level.
 * One level runs in this process, with --trace printing every expansion
 * and --events only the root rollout's decision points; a set runs on
 * --jobs workers. A level is skipped when the index already holds a
 * solution from this tier or higher, or an optimal one; --force retries.
 * Tiers: 1 = 10 s, 2 = 2 min, 3 = 15 min per level; "all" runs them in
 * turn on what the previous one left.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Lemmix, nodeIO, findRepoRoot, listLevels } = require("./lemmix-node");
const Solver = require("./solver");

const SOLVER_VERSION = "0.1.0";
const TIER_SECONDS = { 1: 10, 2: 120, 3: 900 };

function parseArgs(argv) {
  const opts = { positional: [], tier: 1, budget: null, jobs: Math.max(1, os.cpus().length - 1), force: false, out: null,
    trace: false, events: false, nxrp: null, noIndex: false, stdout: false, verify: false, list: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--tier": { const t = next(); opts.tier = t === "all" ? "all" : parseInt(t, 10); break; }
      case "--budget": opts.budget = parseFloat(next()); break;
      case "--jobs": opts.jobs = Math.max(1, parseInt(next(), 10)); break;
      case "--force": opts.force = true; break;
      case "--out": opts.out = next(); break;
      case "--trace": opts.trace = true; break;
      case "--events": opts.events = true; break;
      case "--nxrp": opts.nxrp = next(); break;
      case "--no-index": opts.noIndex = true; break;
      case "--stdout": opts.stdout = true; break;
      case "--verify": opts.verify = true; break;
      case "--list": opts.list = true; break;
      case "--verbose": opts.verbose = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: if (a.startsWith("--")) { console.error("unknown option " + a); process.exit(2); } opts.positional.push(a);
    }
  }
  return opts;
}

/** The solution file's path for a level, relative to the solutions directory. */
function solutionFile(entry) {
  return entry.url.replace(/^levels\//, "").replace(/\.nxlv$/i, "") + ".nxrp";
}

// ---- the index

function readIndex(outDir) {
  try { return JSON.parse(fs.readFileSync(path.join(outDir, "index.json"), "utf8")); }
  catch (e) { return { version: 1, generated: "", solverVersion: SOLVER_VERSION, levels: {} }; }
}

function writeIndex(outDir, index) {
  fs.mkdirSync(outDir, { recursive: true });
  index.generated = new Date().toISOString();
  index.solverVersion = SOLVER_VERSION;
  const sorted = {};
  for (const k of Object.keys(index.levels).sort()) sorted[k] = index.levels[k];
  index.levels = sorted;
  const tmp = path.join(outDir, "index.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(index, null, 1));
  fs.renameSync(tmp, path.join(outDir, "index.json"));
}

/** Does the index's record excuse the level from a run at this tier? */
function skipRecord(rec, tier, force) {
  if (force || !rec) return false;
  if (rec.status === "solved" && rec.optimal) return true;
  if (rec.tier >= tier) return true;
  return false;
}

/** Is `a` (a new record) better than `b` (the old one), by the objective? */
function betterRecord(a, b) {
  if (!b || b.status !== "solved") return a.status === "solved";
  if (a.status !== "solved") return false;
  return Solver.compare(a, b) > 0;
}

// ---- one level

/**
 * Solve one level: { record, nxrp }. `env` = { repoRoot, styles, masks };
 * `opts` = { tier, budgetMs, trace, log, eventsOnly }.
 */
async function solveLevel(entry, env, opts) {
  const t0 = Date.now();
  const text = fs.readFileSync(path.join(env.repoRoot, entry.url), "utf8");
  const data = Lemmix.LevelBuilder.parseLevel(text);
  const build = () => Lemmix.LevelBuilder.build(data, env.styles, { seed: entry.id });
  const level = await build();
  const world = new Solver.World(level, env.masks);
  const record = { status: "unsolved", file: solutionFile(entry), needed: level.needCount, count: level.releaseCount, tier: opts.tier, solverVersion: SOLVER_VERSION };
  if (opts.eventsOnly) {
    const { events, outcome } = Solver.rollout(world);
    const analysis = Solver.analyse(level);
    opts.log("level " + level.width + "x" + level.height + ", " + level.releaseCount + " lemmings, save " + level.needCount + ", skills " + JSON.stringify(world.skillCounts()) + ", features " + analysis.features.join(","));
    for (const e of events) opts.log("  " + String(e.frame).padStart(5) + "  " + e.type.padEnd(8) + " " + (e.lemId || "").padEnd(8) + " at " + e.x + "," + e.y + " " + (e.dx > 0 ? ">" : "<") + (e.cause ? "  " + e.cause : "") + (e.edgeX !== undefined ? "  edge " + e.edgeX : "") + (e.wallX !== undefined ? "  wall " + e.wallX : ""));
    opts.log("outcome " + JSON.stringify(outcome));
    record.status = "events";
    return { record, nxrp: null };
  }
  const result = Solver.solve(world, { tier: opts.tier, budgetMs: opts.budgetMs, log: opts.log, trace: opts.trace });
  const st = result.stats;
  Object.assign(record, { maxSavable: st.maxSavable, features: st.features, expansions: st.expansions, elapsedMs: Math.round(st.elapsedMs) });
  if (!result.best) { record.elapsedMs = Date.now() - t0; return { record, nxrp: null }; }
  // the replay text, then its verification through a fresh game
  world.reset(result.best.plan);
  Solver.rollout(world, { maxFrames: result.best.completionFrame + 1 });
  const nxrp = Lemmix.Replay.serialize(world.game, { author: "nx-solve", user: "nx-solve/" + SOLVER_VERSION });
  const fresh = await build();
  const check = Solver.verify(fresh, env.masks, nxrp, { saved: result.best.saved, skillsUsed: result.best.skillsUsed });
  if (!check.ok) {
    record.status = "error"; record.error = "verification: " + (check.reason || "the replay does not win");
    record.elapsedMs = Date.now() - t0;
    return { record, nxrp: null };
  }
  Object.assign(record, { status: "solved", saved: check.saved, skillsUsed: check.skillsUsed, completionFrame: check.completionFrame,
    optimal: check.saved >= st.maxSavable && check.skillsUsed === 0, elapsedMs: Date.now() - t0 });
  return { record, nxrp };
}

function describeRecord(rec) {
  if (!rec) return "-";
  if (rec.status === "solved") return "solved " + rec.saved + "/" + rec.count + " need " + rec.needed + ", " + rec.skillsUsed + " skills, frame " + rec.completionFrame + (rec.optimal ? ", optimal" : "") + ", tier " + rec.tier + ", " + (rec.elapsedMs / 1000).toFixed(1) + " s";
  if (rec.status === "error") return "ERROR " + rec.error + (rec.tier ? ", tier " + rec.tier : "");
  return rec.status + (rec.tier ? " at tier " + rec.tier : "") + (rec.elapsedMs ? ", " + (rec.elapsedMs / 1000).toFixed(1) + " s" : "") + (rec.features && rec.features.length ? " [" + rec.features.join(",") + "]" : "");
}

/** The level an argument names exactly (or uniquely), or null when it is a prefix. */
function findLevel(levels, arg) {
  const exact = levels.find((l) => l.id === arg || l.id === arg + ".nxlv");
  if (exact) return exact;
  const lower = arg.toLowerCase().replace(/\.nxlv$/, "");
  let hits = levels.filter((l) => l.id.toLowerCase().includes(lower));
  if (hits.length > 1) hits = hits.filter((l) => l.id.toLowerCase().endsWith(lower + ".nxlv")); // the whole name, not a part of a longer one
  if (hits.length === 1 && !levels.some((l) => l.id.startsWith(arg) && l !== hits[0])) return hits[0];
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].split("\n").slice(2).map((l) => l.replace(/^ \* ?/, "")).join("\n")); return; }
  const repoRoot = findRepoRoot();
  const outDir = opts.out ? path.resolve(opts.out) : path.join(repoRoot, "solutions");
  const all = listLevels(repoRoot);
  const arg = opts.positional[0];
  const one = arg ? findLevel(all, arg) : null;
  const levels = one ? [one] : arg ? all.filter((l) => l.id.startsWith(arg)) : all;
  if (!levels.length) { console.error("no level matches " + arg); process.exit(2); }
  const index = readIndex(outDir);

  if (opts.list) {
    for (const l of levels) console.log(l.id + "  " + describeRecord(index.levels[l.id]));
    return;
  }

  const io = nodeIO(repoRoot);
  const env = { repoRoot, styles: new Lemmix.StyleManager(io), masks: await Lemmix.loadMasks(io) };

  if (opts.verify) {
    let bad = 0, n = 0;
    for (const l of levels) {
      const rec = index.levels[l.id];
      if (!rec || rec.status !== "solved") continue;
      n++;
      const file = path.join(outDir, rec.file);
      let line = l.id + "  ";
      try {
        const data = Lemmix.LevelBuilder.parseLevel(fs.readFileSync(path.join(repoRoot, l.url), "utf8"));
        const level = await Lemmix.LevelBuilder.build(data, env.styles, { seed: l.id });
        const r = Solver.verify(level, env.masks, fs.readFileSync(file, "utf8"), { saved: rec.saved, skillsUsed: rec.skillsUsed });
        line += r.ok ? "ok  saved " + r.saved + " frame " + r.completionFrame : "MISMATCH " + r.reason;
        if (!r.ok) bad++;
      } catch (e) { bad++; line += "ERROR " + e.message; }
      console.log(line);
    }
    console.log(n + " solutions verified, " + bad + " mismatches");
    if (bad) process.exitCode = 1;
    return;
  }

  if (one) {
    // one level, in this process
    const tier = opts.tier === "all" ? 1 : opts.tier;
    const budgetMs = (opts.budget || TIER_SECONDS[tier]) * 1000;
    const log = (s) => console.log(s);
    console.log(one.id + (opts.events ? "" : "  tier " + tier + ", budget " + budgetMs / 1000 + " s"));
    const { record, nxrp } = await solveLevel(one, env, { tier, budgetMs, trace: opts.trace, log, eventsOnly: opts.events });
    if (opts.events) return;
    console.log(one.id + "  " + describeRecord(record));
    if (record.status === "error") { process.exitCode = 1; return; }
    if (record.status !== "solved") { process.exitCode = 3; return; }
    const file = opts.nxrp ? path.resolve(opts.nxrp) : path.join(outDir, record.file);
    const old = index.levels[one.id];
    if (opts.nxrp || betterRecord(record, old) || opts.force) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, nxrp);
      console.log("written " + path.relative(repoRoot, file));
    } else console.log("kept the existing solution (" + describeRecord(old) + ")");
    if (opts.stdout) process.stdout.write(nxrp + "\n");
    if (!opts.noIndex && !opts.nxrp && (betterRecord(record, old) || opts.force || !old)) {
      index.levels[one.id] = record;
      writeIndex(outDir, index);
    }
    const url = "http://127.0.0.1:8123/?level=" + encodeURIComponent(one.id) + (opts.nxrp ? "&nxrp=" + encodeURIComponent("/" + path.relative(repoRoot, file)) : "&solution=1");
    console.log("watch it: " + url);
    return;
  }

  // a set of levels on a pool of workers, tier by tier
  const tiers = opts.tier === "all" ? [1, 2, 3] : [opts.tier];
  let errors = 0;
  for (const tier of tiers) {
    const budgetMs = (opts.budget || TIER_SECONDS[tier]) * 1000;
    const todo = levels.filter((l) => !skipRecord(index.levels[l.id], tier, opts.force));
    console.log("[nx-solve] tier " + tier + ": " + todo.length + " of " + levels.length + " levels, " + budgetMs / 1000 + " s each, " + opts.jobs + " jobs");
    if (!todo.length) continue;
    const t0 = Date.now();
    let done = 0;
    await runPool(todo, Math.min(opts.jobs, todo.length), { tier, budgetMs, repoRoot }, (entry, msg) => {
      done++;
      const rec = msg.record;
      const old = index.levels[entry.id];
      if (rec.status === "error") errors++;
      if (rec.status === "solved" && msg.nxrp && (betterRecord(rec, old) || opts.force)) {
        const file = path.join(outDir, rec.file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, msg.nxrp);
        index.levels[entry.id] = rec;
      } else if (!old || old.status !== "solved" || rec.status === "solved") {
        // an unsolved run at a higher tier, or an equal solution: the record moves on, the old file stays
        index.levels[entry.id] = old && old.status === "solved" ? Object.assign({}, old, { tier: Math.max(old.tier || 0, rec.tier) }) : rec;
      }
      writeIndex(outDir, index);
      console.log("[nx-solve] " + done + "/" + todo.length + " " + entry.id + "  " + describeRecord(rec));
    });
    const recs = levels.map((l) => index.levels[l.id]).filter(Boolean);
    const solved = recs.filter((r) => r.status === "solved");
    console.log("[nx-solve] tier " + tier + " done in " + ((Date.now() - t0) / 60000).toFixed(1) + " min: solved " + solved.length + " (optimal " + solved.filter((r) => r.optimal).length + "), unsolved " + recs.filter((r) => r.status === "unsolved").length + ", errors " + recs.filter((r) => r.status === "error").length);
  }
  if (errors) process.exitCode = 1;
}

/** `entries` through `jobs` workers; `onDone(entry, message)` per level, in completion order. */
function runPool(entries, jobs, job, onDone) {
  const { Worker } = require("worker_threads");
  return new Promise((resolve, reject) => {
    let next = 0, running = 0;
    const start = () => {
      if (next >= entries.length) { if (running === 0) resolve(); return; }
      const entry = entries[next++];
      running++;
      const worker = new Worker(path.join(__dirname, "solver", "worker.js"), { workerData: { repoRoot: job.repoRoot } });
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        worker.terminate();
        onDone(entry, { record: { status: "error", error: "timeout", file: solutionFile(entry), tier: job.tier, elapsedMs: job.budgetMs * 1.5 + 30000 } });
        running--; start();
      }, job.budgetMs * 1.5 + 30000);
      worker.on("message", (msg) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        worker.terminate();
        onDone(entry, msg);
        running--; start();
      });
      worker.on("error", (e) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        onDone(entry, { record: { status: "error", error: String(e && e.message || e), file: solutionFile(entry), tier: job.tier } });
        running--; start();
      });
      worker.postMessage({ entry, tier: job.tier, budgetMs: job.budgetMs });
    };
    for (let i = 0; i < jobs; i++) start();
  });
}

module.exports = { solveLevel, solutionFile, describeRecord, readIndex, writeIndex, findLevel, SOLVER_VERSION };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
