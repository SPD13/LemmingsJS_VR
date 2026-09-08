#!/usr/bin/env node
"use strict";
/**
 * The environment's pictures for every gallery the installed levels use:
 * each theme style of levels/index.json, most-used first, through
 * tools/env-gen.js one after the other, into 3d/env/<style>/. A style with
 * a finished set already there is skipped (--force redoes it), a style the
 * styles package does not have is skipped, a failure (the model server
 * gone, say) is noted and the next style tried - so the job can be stopped
 * and started again and picks up where it left off.
 *
 * Usage: node tools/env-gen-all.js [options]   (the model options are env-gen.js's)
 *   --list             the styles in order, with what they have, and stop
 *   --only a,b         these styles only
 *   --limit <n>        the first n styles that need doing
 *   --force            redo styles that have a set
 *   --api, --lora, --trigger, --steps, --denoise, --cfg, --sampler, --model, --prompt
 *                      passed on to env-gen.js (defaults below are the recipe used so far)
 * The classic games' tilesets come first (`<pack>-g<set>`), then the styles.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const classic = require("./classic-node");

const repoRoot = path.resolve(__dirname, "..");
const ENV_DIR = path.join(repoRoot, "3d", "env");
const DEFAULTS = {
  api: "http://127.0.0.1:7860", lora: "16_bit_pixel_background_sd1.5_lora_f16.ckpt:0.8",
  trigger: "apxlz, prushik", steps: "24", denoise: "0.35",
};
const PASS = ["api", "lora", "trigger", "steps", "denoise", "cfg", "sampler", "model", "prompt"];

function parseArgs(argv) {
  const o = { pass: Object.assign({}, DEFAULTS) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === "--list") o.list = true;
    else if (a === "--only") o.only = next().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a === "--limit") o.limit = parseInt(next(), 10);
    else if (a === "--force") o.force = true;
    else if (a.startsWith("--") && PASS.includes(a.slice(2))) o.pass[a.slice(2)] = next();
    else throw new Error("unknown option " + a);
  }
  return o;
}

/** The theme styles of the installed levels, most-used first. */
function galleries() {
  const index = JSON.parse(fs.readFileSync(path.join(repoRoot, "levels", "index.json"), "utf8"));
  const counts = new Map();
  const walk = (n) => {
    for (const l of n.levels || []) if (l.theme) counts.set(l.theme.toLowerCase(), (counts.get(l.theme.toLowerCase()) || 0) + 1);
    for (const c of n.children || []) walk(c);
  };
  walk(index);
  let styles = new Map();
  try {
    for (const s of JSON.parse(fs.readFileSync(path.join(repoRoot, "neolemmix", "styles", "index.json"), "utf8")).styles || []) styles.set(s.name.toLowerCase(), s);
  } catch (e) { styles = null; }
  const isDone = (name) => fs.existsSync(path.join(ENV_DIR, name, "floor.png")) && fs.existsSync(path.join(ENV_DIR, name, "wall.png"));
  // the classic games' tilesets first - the headline worlds - then the NeoLemmix styles
  const dos = classic.classicTilesets(repoRoot).map((t) => ({
    name: t.id, levels: 30, installed: true, pieces: null, done: isDone(t.id), title: t.title,
  }));
  const nx = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([name, levels]) => {
    const entry = styles && styles.get(name);
    return { name, levels, installed: !!entry, pieces: entry ? entry.count : 0, done: isDone(name) };
  });
  return dos.concat(nx);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let list = galleries();
  if (opts.only) list = list.filter((g) => opts.only.includes(g.name));
  if (opts.list) {
    for (const g of list) console.log((g.done ? "done " : g.installed ? "todo " : "none ") + g.name.padEnd(28) + String(g.levels).padStart(4) + " levels" + (g.title ? ", " + g.title : g.installed ? ", " + g.pieces + " pieces" : ", not installed"));
    const todo = list.filter((g) => g.installed && !g.done).length;
    console.log(list.length + " galleries: " + list.filter((g) => g.done).length + " done, " + todo + " to do, " + list.filter((g) => !g.installed).length + " not installed");
    return;
  }
  let todo = list.filter((g) => g.installed && (opts.force || !g.done));
  if (opts.limit) todo = todo.slice(0, opts.limit);
  console.log("[env-gen-all] " + todo.length + " galleries to make: " + todo.map((g) => g.name).join(", "));
  const failed = [];
  const t0 = Date.now();
  todo.forEach((g, i) => {
    const t = Date.now();
    console.log("\n[env-gen-all] " + (i + 1) + "/" + todo.length + " " + g.name + " (" + g.levels + " levels)");
    const args = [path.join(__dirname, "env-gen.js"), g.name];
    for (const k of PASS) if (opts.pass[k] !== undefined) args.push("--" + k, String(opts.pass[k]));
    const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: repoRoot });
    const s = Math.round((Date.now() - t) / 1000);
    if (r.status !== 0) { failed.push(g.name); console.log("[env-gen-all] " + g.name + " FAILED after " + s + " s (exit " + r.status + ")"); }
    else console.log("[env-gen-all] " + g.name + " done in " + s + " s");
  });
  const total = Math.round((Date.now() - t0) / 60000);
  console.log("\n[env-gen-all] finished: " + (todo.length - failed.length) + " made, " + failed.length + " failed" + (failed.length ? " (" + failed.join(", ") + ")" : "") + ", " + total + " min");
  if (failed.length) process.exit(1);
}

main();
