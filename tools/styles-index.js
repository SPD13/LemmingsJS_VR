#!/usr/bin/env node
"use strict";
/**
 * Build neolemmix/styles/index.json: the sprite galleries the 3D page's
 * galleries view lists. A browser cannot read a folder, so the terrain
 * pieces of every NeoLemmix style (neolemmix/styles/<style>/terrain/*.png)
 * are listed here - the launcher serves the same thing live from the
 * folders, this file is for static hosting, and the setup page builds it
 * for the styles it keeps in the browser.
 *
 *   { version, generated, count, pieceCount,
 *     styles: [ { name, title, theme, hasTheme, hasAlias,
 *                 pieces: [...], steel: [...], metas: [...], count } ] }
 *
 * `name` is the folder, `title` the display name from styles.ini when it has
 * one, `theme` the LEMMINGS line of theme.nxtm, `pieces` the lowercased
 * piece names (what the engine requests) in natural order, `steel` those
 * whose .nxmt marks them steel, `metas` those that have a .nxmt at all.
 * `hasTheme` and `hasAlias` say whether theme.nxtm and alias.nxmi are there.
 * The engine (lemmix/js/styles.js) reads the flags and `metas` so it only
 * asks for the optional files a style has, instead of probing for each.
 * A style without a terrain folder is listed with no pieces. The file lands
 * under neolemmix/, which is not committed.
 *
 * Like tools/levels-index.js the folders are read through an io (a repo root
 * on disk, or the setup page's snapshot of the browser's files); loaded as a
 * plain script it is window.StylesIndex.
 *
 * Usage: node tools/styles-index.js [--check]
 */
(function (root) {
const STYLES_DIR = "neolemmix/styles";
const INDEX_FILE = "index.json";

const isNode = typeof module !== "undefined" && module.exports;
const natural = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
const levelsIndex = isNode ? require("./levels-index") : root.LevelsIndex;

/** The display names of styles.ini: `[folder]` sections with a `Name=` line. */
function readStylesIni(text) {
  const titles = {};
  if (!text) return titles;
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

const readOr = (io, p, dflt) => { try { return io.exists(p) ? io.readText(p) : dflt; } catch (e) { return dflt; } };
const ext = (f) => { const i = f.lastIndexOf("."); return i < 0 ? "" : f.slice(i).toLowerCase(); };
const stem = (f) => { const i = f.lastIndexOf("."); return (i < 0 ? f : f.slice(0, i)).toLowerCase(); };

/** The terrain pieces of one style folder: names (lowercased), which have a .nxmt, and which are steel. */
function listPieces(io, styleDir) {
  const dir = styleDir + "/terrain";
  if (!io.isDir(dir)) return { pieces: [], steel: [], metas: [] };
  const names = new Set();
  const metas = new Map(); // lowercased stem -> the .nxmt file name as it is
  for (const f of io.listFiles(dir)) {
    const e = ext(f);
    if (e === ".png") names.add(stem(f));
    else if (e === ".nxmt") metas.set(stem(f), f);
  }
  const pieces = Array.from(names).sort(natural);
  const withMeta = pieces.filter((name) => metas.has(name));
  const steel = withMeta.filter((name) => /^\s*STEEL\b/mi.test(readOr(io, dir + "/" + metas.get(name), "")));
  return { pieces, steel, metas: withMeta };
}

/** The LEMMINGS line of theme.nxtm, "default" when absent. */
function readTheme(io, styleDir) {
  const text = readOr(io, styleDir + "/theme.nxtm", null);
  if (text === null) return "default";
  const m = /^\s*LEMMINGS\s+(.+?)\s*$/mi.exec(text);
  return m ? m[1].toLowerCase() : "default";
}

/** The index for a repo root on disk or an io (an empty one when the styles are not installed). */
function buildStylesIndex(source) {
  const io = typeof source === "string" ? levelsIndex.nodeIO(source) : source;
  const styles = [];
  if (io.isDir(STYLES_DIR)) {
    const titles = readStylesIni(readOr(io, STYLES_DIR + "/styles.ini", ""));
    for (const name of io.listDirs(STYLES_DIR)) {
      const dir = STYLES_DIR + "/" + name;
      const { pieces, steel, metas } = listPieces(io, dir);
      styles.push({
        name: name.toLowerCase(),
        title: titles[name.toLowerCase()] || name,
        theme: readTheme(io, dir),
        hasTheme: io.exists(dir + "/theme.nxtm"),
        hasAlias: io.exists(dir + "/alias.nxmi"),
        pieces, steel, metas, count: pieces.length,
      });
    }
  }
  return {
    version: 2,
    generated: new Date().toISOString(),
    count: styles.length,
    pieceCount: styles.reduce((n, s) => n + s.count, 0),
    styles,
  };
}

const api = { buildStylesIndex, readStylesIni, listPieces, readTheme, STYLES_DIR, INDEX_FILE };
if (isNode) module.exports = api;
else root.StylesIndex = api;

if (isNode && require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
  let repoRoot = path.resolve(__dirname);
  for (let i = 0; i < 6; i++) {
    if (exists(path.join(repoRoot, "config.json")) && exists(path.join(repoRoot, "js", "lemmings.js"))) break;
    repoRoot = path.dirname(repoRoot);
  }
  const index = buildStylesIndex(repoRoot);
  const outDir = path.join(repoRoot, ...STYLES_DIR.split("/"));
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
})(typeof window !== "undefined" ? window : globalThis);
