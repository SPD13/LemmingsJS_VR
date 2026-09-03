#!/usr/bin/env node
"use strict";
/**
 * Build neolemmix/styles/index.json: the sprite galleries the 3D page's
 * galleries view lists. A browser cannot read a folder, so the terrain
 * pieces of every NeoLemmix style (neolemmix/styles/<style>/terrain/*.png)
 * are listed here - the launcher serves the same thing live from the
 * folders, this file is for static hosting.
 *
 *   { version, generated, count,
 *     styles: [ { name, title, theme, pieces: [...], steel: [...], count } ] }
 *
 * `name` is the folder, `title` the display name from styles.ini when it has
 * one, `theme` the LEMMINGS line of theme.nxtm, `pieces` the lowercased
 * piece names (what the engine requests) in natural order, `steel` those
 * whose .nxmt marks them steel. A style without a terrain folder is listed
 * with no pieces. The file lands under neolemmix/, which is not committed.
 *
 * Usage: node tools/styles-index.js [--check]
 */
const fs = require("fs");
const path = require("path");

const STYLES_DIR = path.join("neolemmix", "styles");
const INDEX_FILE = "index.json";

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
const natural = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/** The display names of styles.ini: `[folder]` sections with a `Name=` line. */
function readStylesIni(file) {
  const titles = {};
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return titles; }
  let current = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === ";" || line[0] === "#") continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) { current = m[1].trim().toLowerCase(); continue; }
    const eq = line.indexOf("=");
    if (current && eq > 0 && line.slice(0, eq).trim().toLowerCase() === "name") {
      titles[current] = line.slice(eq + 1).trim();
    }
  }
  return titles;
}

/** The terrain pieces of one style folder: names (lowercased) and which are steel. */
function listPieces(styleDir) {
  const dir = path.join(styleDir, "terrain");
  if (!isDir(dir)) return { pieces: [], steel: [] };
  const names = new Set();
  const metas = new Set();
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isFile()) continue;
    const ext = path.extname(d.name).toLowerCase();
    const base = path.basename(d.name, path.extname(d.name)).toLowerCase();
    if (ext === ".png") names.add(base);
    else if (ext === ".nxmt") metas.add(base);
  }
  const pieces = Array.from(names).sort(natural);
  const steel = pieces.filter((name) => {
    if (!metas.has(name)) return false;
    let text = "";
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase() === name + ".nxmt") { try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch (e) {} break; }
    }
    return /^\s*STEEL\b/mi.test(text);
  });
  return { pieces, steel };
}

/** The LEMMINGS line of theme.nxtm, "default" when absent. */
function readTheme(styleDir) {
  let text;
  try { text = fs.readFileSync(path.join(styleDir, "theme.nxtm"), "utf8"); } catch (e) { return "default"; }
  const m = /^\s*LEMMINGS\s+(.+?)\s*$/mi.exec(text);
  return m ? m[1].toLowerCase() : "default";
}

/** The index for the repo at `repoRoot` (an empty one when the styles are not installed). */
function buildStylesIndex(repoRoot) {
  const stylesDir = path.join(repoRoot, STYLES_DIR);
  const styles = [];
  if (isDir(stylesDir)) {
    const titles = readStylesIni(path.join(stylesDir, "styles.ini"));
    const folders = fs.readdirSync(stylesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort(natural);
    for (const name of folders) {
      const dir = path.join(stylesDir, name);
      const { pieces, steel } = listPieces(dir);
      styles.push({
        name: name.toLowerCase(),
        title: titles[name.toLowerCase()] || name,
        theme: readTheme(dir),
        pieces, steel, count: pieces.length,
      });
    }
  }
  return {
    version: 1,
    generated: new Date().toISOString(),
    count: styles.length,
    pieceCount: styles.reduce((n, s) => n + s.count, 0),
    styles,
  };
}

function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    if (exists(path.join(dir, "config.json")) && exists(path.join(dir, "js", "lemmings.js"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(start);
}

if (require.main === module) {
  const repoRoot = findRepoRoot(__dirname);
  const index = buildStylesIndex(repoRoot);
  const outDir = path.join(repoRoot, STYLES_DIR);
  const out = path.join(outDir, INDEX_FILE);
  const check = process.argv.includes("--check");
  if (!isDir(outDir)) {
    console.log("no " + STYLES_DIR + " folder: the NeoLemmix styles are not installed (see neolemmix/README.md)");
  } else if (!check) {
    fs.writeFileSync(out, JSON.stringify(index, null, 1) + "\n");
  }
  const empty = index.styles.filter((s) => !s.count).length;
  console.log((check ? "would write " : isDir(outDir) ? "wrote " : "skipped ") + out +
    " · " + index.count + " styles, " + index.pieceCount + " pieces" +
    (empty ? " (" + empty + " styles without terrain)" : ""));
}

module.exports = { buildStylesIndex, readStylesIni, listPieces, readTheme, STYLES_DIR, INDEX_FILE };
