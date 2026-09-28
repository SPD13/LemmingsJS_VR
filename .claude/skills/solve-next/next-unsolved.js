#!/usr/bin/env node
"use strict";
/**
 * The next level the solver has not solved, in the packs' own order (the
 * order of `nx-solve --list`), the parked ones left out: a level is parked
 * by a line of 3d/plans/solver-parked.md carrying its id in backticks.
 *
 *   node .claude/skills/solve-next/next-unsolved.js [prefix] [--count N] [--after <level id>]
 *
 * Prints one line per level: the id, a tab, what the index says of it.
 */
const fs = require("fs");
const path = require("path");
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const { listLevels } = require(path.join(repoRoot, "tools", "lemmix-node"));
const { readIndex, describeRecord } = require(path.join(repoRoot, "tools", "nx-solve"));

const argv = process.argv.slice(2);
let prefix = "", count = 1, after = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--count") count = parseInt(argv[++i], 10) || 1;
  else if (argv[i] === "--after") after = argv[++i];
  else prefix = argv[i];
}

let parked = new Set();
try {
  const text = fs.readFileSync(path.join(repoRoot, "3d", "plans", "solver-parked.md"), "utf8");
  for (const m of text.matchAll(/`([^`]+\.nxlv)`/g)) parked.add(m[1]);
} catch (e) { /* nothing parked yet */ }

const index = readIndex(path.join(repoRoot, "solutions"));
let levels = listLevels(repoRoot).filter((l) => l.id.startsWith(prefix));
if (after) { const at = levels.findIndex((l) => l.id === after); if (at >= 0) levels = levels.slice(at + 1); }
const open = levels.filter((l) => { const rec = index.levels[l.id]; return !(rec && rec.status === "solved") && !parked.has(l.id); });
if (!open.length) { console.log("nothing left unsolved" + (prefix ? " under " + prefix : "") + " (parked: " + parked.size + ")"); process.exit(3); }
for (const l of open.slice(0, count)) console.log(l.id + "\t" + describeRecord(index.levels[l.id]));
