#!/usr/bin/env node
"use strict";
/**
 * levels/index.json - the tree the level browser navigates.
 *
 * Every subdirectory of levels/ is a level pack. A browser cannot list a
 * directory and neither can the static servers this repo is served with, so
 * the tree is written down once here (and served live by the launcher, which
 * requires this same module). Two kinds of pack:
 *
 * - classic: a DOS game folder (MAIN.DAT, LEVELxxx.DAT ...) registered in
 *   config.json, whose entry supplies the difficulty names and level order.
 *   Ranks are the difficulties; a level is identified by group and index.
 * - lemmix: a NeoLemmix pack - a folder with a levels.nxmi declaring its
 *   ranks ($GROUP), each rank folder listing its .nxlv files. A folder that
 *   merely wraps packs in a levels/ subfolder (the way the Lemmings Plus
 *   collection ships) is collapsed: its packs appear directly under it.
 *
 * Nodes: {kind: "dir"|"pack", engine: "classic"|"lemmix", name, path, count,
 *         children?: [nodes], levels?: [levels]}. `path` is the logical path
 * from levels/ (the collapsed levels/ wrapper is not part of it); a level's
 * `id` is that path plus its own name, and stays stable across rescans.
 *
 * Usage: node tools/levels-index.js [--check]   (from anywhere in the repo)
 */

const fs = require("fs");
const path = require("path");

const LEVELS_DIR = "levels";
const GAME_TYPE = { LEMMINGS: 1, OHNO: 2, XMAS91: 3, XMAS92: 4, HOLIDAY93: 5, HOLIDAY94: 6 };
const PRETTY_NAME = { LEMMINGS: "Lemmings", OHNO: "Oh No! More Lemmings" };

/** The NeoLemmix text format: `KEY value` lines and $SECTION ... $END blocks. */
function parseNx(text) {
  const root = { name: null, entries: [], sections: [] };
  const stack = [root];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === "#") continue;
    if (line[0] === "$") {
      const name = line.slice(1).trim().toUpperCase();
      if (name === "END") { if (stack.length > 1) stack.pop(); continue; }
      const section = { name, entries: [], sections: [] };
      stack[stack.length - 1].sections.push(section);
      stack.push(section);
      continue;
    }
    const sp = line.indexOf(" ");
    const key = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const value = sp < 0 ? "" : line.slice(sp + 1).trim();
    stack[stack.length - 1].entries.push({ key, value });
  }
  return root;
}

const first = (node, key) => {
  const e = node.entries.find((x) => x.key === key);
  return e ? e.value : null;
};
const all = (node, key) => node.entries.filter((x) => x.key === key).map((x) => x.value);

const readText = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const listDirs = (p) => fs.readdirSync(p, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("."))
  .map((d) => d.name)
  .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
const listFiles = (p, ext) => fs.readdirSync(p, { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(ext))
  .map((d) => d.name)
  .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
const toUrl = (repoRoot, abs) => path.relative(repoRoot, abs).split(path.sep).join("/");

/** The header of a .nxlv: the keys before the first section, plus what the browser lists. */
function readLevelHeader(file) {
  const text = readText(file);
  const cut = text.search(/^\s*\$/m);
  const nx = parseNx(cut < 0 ? text : text.slice(0, cut));
  const num = (k) => { const v = first(nx, k); return v === null ? null : parseInt(v, 10); };
  return {
    title: first(nx, "TITLE") || path.basename(file, ".nxlv").replace(/_/g, " "),
    theme: first(nx, "THEME") || null,
    nxId: first(nx, "ID") || null,
    width: num("WIDTH"), height: num("HEIGHT"),
    lemmings: num("LEMMINGS"), save: num("SAVE_REQUIREMENT"),
  };
}

/** A classic pack from its config.json entry (skipped when its folder is absent). */
function classicPack(repoRoot, entry) {
  const dir = path.join(repoRoot, entry.path);
  if (!isDir(dir)) return null;
  const name = path.basename(entry.path);
  const groups = entry["level.groups"] || [];
  const order = entry["level.order"] || [];
  const children = order.map((levels, g) => ({
    kind: "dir", engine: "classic",
    name: groups[g] || "Group " + (g + 1),
    path: name + "/" + g,
    count: levels.length,
    levels: levels.map((_, i) => ({ id: name + "/" + g + "/" + i, group: g, index: i })),
  }));
  return {
    kind: "pack", engine: "classic",
    name: PRETTY_NAME[entry.gametype] || entry.name || name,
    path: name,
    dir: entry.path,
    gameType: GAME_TYPE[entry.gametype] || 0,
    count: children.reduce((n, c) => n + c.count, 0),
    children,
  };
}

/** One NeoLemmix pack: info.nxmi for its name, levels.nxmi for its ranks. */
function lemmixPack(repoRoot, dir, logicalPath, musicDir) {
  const nx = parseNx(readText(path.join(dir, "levels.nxmi")));
  const info = exists(path.join(dir, "info.nxmi"))
    ? parseNx(readText(path.join(dir, "info.nxmi"))) : null;
  const music = exists(path.join(dir, "music.nxmi"))
    ? all(parseNx(readText(path.join(dir, "music.nxmi"))), "TRACK") : [];
  const children = [];
  for (const group of nx.sections.filter((s) => s.name === "GROUP" || s.name === "RANK")) {
    const rankName = first(group, "NAME") || first(group, "FOLDER");
    const folder = first(group, "FOLDER") || rankName;
    if (!folder) continue;
    const rankDir = path.join(dir, folder);
    if (!isDir(rankDir)) continue;
    const rank = lemmixLevels(repoRoot, rankDir, logicalPath + "/" + folder, rankName);
    if (rank.count) children.push(rank);
  }
  // levels listed straight in the pack (a pack without ranks)
  const loose = all(nx, "LEVEL");
  if (loose.length) {
    const own = lemmixLevels(repoRoot, dir, logicalPath, path.basename(dir));
    if (own.count) children.push(own);
  }
  const pack = {
    kind: "pack", engine: "lemmix",
    name: (info && first(info, "TITLE")) || path.basename(dir).replace(/_/g, " "),
    path: logicalPath,
    dir: toUrl(repoRoot, dir),
    count: children.reduce((n, c) => n + c.count, 0),
    children,
  };
  if (info && first(info, "AUTHOR")) pack.author = first(info, "AUTHOR");
  if (info && first(info, "VERSION")) pack.version = first(info, "VERSION");
  if (exists(path.join(dir, "logo.png"))) pack.logo = toUrl(repoRoot, path.join(dir, "logo.png"));
  if (music.length) pack.musicRotation = music;
  if (musicDir) pack.musicDir = toUrl(repoRoot, musicDir);
  return pack;
}

/** A folder of .nxlv files, in the order its levels.nxmi lists them. */
function lemmixLevels(repoRoot, dir, logicalPath, name) {
  let files;
  if (exists(path.join(dir, "levels.nxmi"))) {
    files = all(parseNx(readText(path.join(dir, "levels.nxmi"))), "LEVEL")
      .filter((f) => exists(path.join(dir, f)));
  }
  if (!files || !files.length) files = listFiles(dir, ".nxlv");
  const levels = files.map((file) => {
    const abs = path.join(dir, file);
    const header = readLevelHeader(abs);
    return Object.assign({ id: logicalPath + "/" + file, file, url: toUrl(repoRoot, abs) }, header);
  });
  return { kind: "dir", engine: "lemmix", name, path: logicalPath, count: levels.length, levels };
}

/** Any non-classic folder under levels/: a pack, a wrapper of packs, or loose levels. */
function lemmixNode(repoRoot, dir, logicalPath, musicDir) {
  const name = path.basename(dir);
  if (exists(path.join(dir, "levels.nxmi"))) {
    return lemmixPack(repoRoot, dir, logicalPath, musicDir);
  }
  const dirs = listDirs(dir);
  const nxlv = listFiles(dir, ".nxlv");
  // the wrapper a downloaded collection ships as: levels/ (and music/) only
  if (!nxlv.length && dirs.includes("levels") && !dirs.some((d) => d !== "levels" && d !== "music")) {
    const inner = path.join(dir, "levels");
    const music = isDir(path.join(dir, "music")) ? path.join(dir, "music") : musicDir;
    const children = listDirs(inner)
      .map((d) => lemmixNode(repoRoot, path.join(inner, d), logicalPath + "/" + d, music))
      .filter((n) => n && n.count);
    return {
      kind: "dir", engine: "lemmix", name: name.replace(/_/g, " "), path: logicalPath,
      count: children.reduce((n, c) => n + c.count, 0), children,
    };
  }
  if (nxlv.length && !dirs.length) return lemmixLevels(repoRoot, dir, logicalPath, name);
  const children = dirs
    .map((d) => lemmixNode(repoRoot, path.join(dir, d), logicalPath + "/" + d, musicDir))
    .filter((n) => n && n.count);
  if (nxlv.length) children.unshift(lemmixLevels(repoRoot, dir, logicalPath, name));
  if (!children.length) return null;
  return {
    kind: "dir", engine: "lemmix", name: name.replace(/_/g, " "), path: logicalPath,
    count: children.reduce((n, c) => n + c.count, 0), children,
  };
}

/** The whole tree for the repo at `repoRoot`. */
function buildIndex(repoRoot) {
  const levelsDir = path.join(repoRoot, LEVELS_DIR);
  let config = [];
  try { config = JSON.parse(readText(path.join(repoRoot, "config.json"))); } catch (e) {}
  const classicByDir = new Map();
  for (const entry of config) {
    const pack = classicPack(repoRoot, entry);
    if (pack) classicByDir.set(path.basename(entry.path), pack);
  }
  const children = [];
  if (isDir(levelsDir)) {
    for (const d of listDirs(levelsDir)) {
      if (classicByDir.has(d)) { children.push(classicByDir.get(d)); continue; }
      const node = lemmixNode(repoRoot, path.join(levelsDir, d), d, null);
      if (node && node.count) children.push(node);
    }
  }
  return {
    version: 1,
    generated: new Date().toISOString(),
    count: children.reduce((n, c) => n + c.count, 0),
    children,
  };
}

/** Where the repo root is, from wherever this runs. */
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    if (exists(path.join(dir, "config.json")) && exists(path.join(dir, "js", "lemmings.js"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(start);
}

function summarize(node, depth, out) {
  const pad = "  ".repeat(depth);
  const tag = node.engine ? " [" + node.engine + "]" : "";
  out.push(pad + node.name + tag + " · " + node.count + " levels");
  for (const c of node.children || []) if (c.kind !== "dir" || c.children) summarize(c, depth + 1, out);
}

if (require.main === module) {
  const repoRoot = findRepoRoot(__dirname);
  const index = buildIndex(repoRoot);
  const out = path.join(repoRoot, LEVELS_DIR, "index.json");
  if (!process.argv.includes("--check")) {
    fs.writeFileSync(out, JSON.stringify(index, null, 1) + "\n");
  }
  const lines = [];
  for (const c of index.children) summarize(c, 0, lines);
  console.log(lines.join("\n"));
  console.log((process.argv.includes("--check") ? "would write " : "wrote ") + out +
    " · " + index.count + " levels");
}

module.exports = { buildIndex, parseNx, readLevelHeader };
