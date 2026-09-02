#!/usr/bin/env node
"use strict";
/**
 * Check every NeoLemmix level in levels/ against the styles on disk: parse
 * each file, resolve every terrain, gadget and background reference (through
 * aliases), and report what is missing, plus the counts a survey of the
 * packs established, so a regression in the parser shows up as a number.
 *
 * Usage: node tools/nx-check.js [level-id-prefix]
 */
const { Lemmix, nodeIO, findRepoRoot, listLevels } = require("./lemmix-node");
const fs = require("fs");
const path = require("path");

async function main() {
  const repoRoot = findRepoRoot();
  const styles = new Lemmix.StyleManager(nodeIO(repoRoot));
  const levels = listLevels(repoRoot, process.argv[2]);
  const counts = { files: 0, terrain: 0, gadget: 0, lemming: 0, talisman: 0, skillset: 0 };
  const missing = new Map(); // "gs:piece" -> count
  const styleNames = new Set();
  const effects = new Map();
  const skills = new Map();
  let parseErrors = 0;

  for (const entry of levels) {
    let data;
    try {
      data = Lemmix.LevelBuilder.parseLevel(fs.readFileSync(path.join(repoRoot, entry.url), "utf8"));
    } catch (e) {
      parseErrors++;
      console.error("parse error in " + entry.id + ": " + e.message);
      continue;
    }
    counts.files++;
    counts.terrain += data.terrains.length;
    counts.gadget += data.gadgets.length;
    counts.lemming += data.lemmings.length;
    counts.talisman += data.talismans.length;
    counts.skillset += Object.keys(data.skills).length ? 1 : 0;
    for (const name of Object.keys(data.skills)) skills.set(name, (skills.get(name) || 0) + 1);

    for (const t of data.terrains) {
      styleNames.add(t.gs);
      const d = await styles.dealias(t.gs, t.piece, "terrain");
      if (!(await styles.terrain(d.gs, d.piece))) {
        const k = "terrain " + t.gs + ":" + t.piece;
        missing.set(k, (missing.get(k) || 0) + 1);
      }
    }
    for (const g of data.gadgets) {
      styleNames.add(g.gs);
      const d = await styles.dealias(g.gs, g.piece, "gadget");
      const meta = await styles.gadget(d.gs, d.piece);
      if (!meta) {
        const k = "gadget " + g.gs + ":" + g.piece;
        missing.set(k, (missing.get(k) || 0) + 1);
      } else {
        effects.set(meta.effect, (effects.get(meta.effect) || 0) + 1);
      }
    }
    if (data.info.background) {
      const id = Lemmix.splitIdentifier(data.info.background, data.info.theme);
      if (!(await styles.background(id.gs, id.piece))) {
        const k = "background " + data.info.background;
        missing.set(k, (missing.get(k) || 0) + 1);
      }
    }
    if (data.info.theme && !(await styles.style(data.info.theme)).exists) {
      const k = "theme " + data.info.theme;
      missing.set(k, (missing.get(k) || 0) + 1);
    }
  }

  console.log("levels parsed:", counts, "parse errors:", parseErrors);
  console.log("styles referenced:", styleNames.size);
  console.log("gadget effects:", Object.fromEntries([...effects.entries()].sort((a, b) => b[1] - a[1])));
  console.log("skills used:", Object.fromEntries([...skills.entries()].sort((a, b) => b[1] - a[1])));
  if (missing.size) {
    console.log("MISSING references (" + missing.size + "):");
    for (const [k, n] of [...missing.entries()].sort((a, b) => b[1] - a[1])) console.log("  " + k + " ×" + n);
    process.exitCode = 1;
  } else {
    console.log("every terrain, gadget, background and theme reference resolves");
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
