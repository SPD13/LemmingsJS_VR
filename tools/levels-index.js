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
 * The tree is read through an `io` - {readText, exists, isDir, listDirs,
 * listFiles} over "/"-joined repo-relative paths - so the same code lists a
 * checkout on disk (nodeIO) and the files the setup page keeps in the
 * browser (snapshotIO over an in-memory listing; the file is also loaded as
 * a plain script there, as window.LevelsIndex).
 *
 * Usage: node tools/levels-index.js [--check]   (from anywhere in the repo)
 */
(function (root) {
const LEVELS_DIR = "levels";
const GAME_TYPE = { LEMMINGS: 1, OHNO: 2, XMAS91: 3, XMAS92: 4, HOLIDAY93: 5, HOLIDAY94: 6 };
const PRETTY_NAME = { LEMMINGS: "Lemmings", OHNO: "Oh No! More Lemmings" };

const isNode = typeof module !== "undefined" && module.exports;
const natural = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
const join = (...parts) => parts.filter((p) => p !== "" && p != null).join("/");
const basename = (p, ext) => {
  let b = p.slice(p.lastIndexOf("/") + 1);
  if (ext && b.toLowerCase().endsWith(ext.toLowerCase())) b = b.slice(0, b.length - ext.length);
  return b;
};

/** The io over a checkout on disk. */
function nodeIO(repoRoot) {
  const fs = require("fs");
  const path = require("path");
  const abs = (p) => path.join(repoRoot, ...p.split("/"));
  const stat = (p) => { try { return fs.statSync(abs(p)); } catch (e) { return null; } };
  return {
    readText: (p) => fs.readFileSync(abs(p), "utf8"),
    exists: (p) => stat(p) !== null,
    isDir: (p) => { const s = stat(p); return !!s && s.isDirectory(); },
    listDirs: (p) => fs.readdirSync(abs(p), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort(natural),
    listFiles: (p, ext) => fs.readdirSync(abs(p), { withFileTypes: true })
      .filter((d) => d.isFile() && (!ext || d.name.toLowerCase().endsWith(ext))).map((d) => d.name).sort(natural),
  };
}

/**
 * The io over an in-memory listing: `files` maps repo-relative paths to
 * their text (or null for a file whose content is not needed). Directories
 * are implied by the paths.
 */
function snapshotIO(files) {
  const dirs = new Set();
  const children = new Map(); // dir -> {dirs: Set, files: Set}
  const entry = (d) => {
    let c = children.get(d);
    if (!c) { c = { dirs: new Set(), files: new Set() }; children.set(d, c); }
    return c;
  };
  for (const p of files.keys()) {
    const parts = p.split("/");
    let dir = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const sub = join(dir, parts[i]);
      dirs.add(sub);
      entry(dir).dirs.add(parts[i]);
      dir = sub;
    }
    entry(dir).files.add(parts[parts.length - 1]);
  }
  dirs.add("");
  const norm = (p) => p.replace(/\/+$/, "");
  return {
    readText: (p) => {
      const t = files.get(norm(p));
      if (t == null) throw new Error("no such file " + p);
      return t;
    },
    exists: (p) => files.has(norm(p)) || dirs.has(norm(p)),
    isDir: (p) => dirs.has(norm(p)),
    listDirs: (p) => Array.from((children.get(norm(p)) || entry("_")).dirs).sort(natural),
    listFiles: (p, ext) => Array.from((children.get(norm(p)) || entry("_")).files)
      .filter((f) => !ext || f.toLowerCase().endsWith(ext)).sort(natural),
  };
}

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

/**
 * The styles a level's terrain pieces come from: the STYLE of every $TERRAIN
 * block, lowercased, sorted, once each. A `*group` pseudo-style (a piece
 * group defined in the level) names no folder and is left out. This is what
 * the tagging status and the sprite galleries go by, since a level's theme
 * says nothing about where its pieces are from.
 */
function terrainStyles(text) {
  const styles = new Set();
  const re = /^\s*\$TERRAIN\s*$([\s\S]*?)^\s*\$END\s*$/gmi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = /^\s*STYLE\s+(.+?)\s*$/mi.exec(m[1]);
    if (!s) continue;
    const style = s[1].toLowerCase();
    if (style && style[0] !== "*") styles.add(style);
  }
  return Array.from(styles).sort();
}

/** The header of a .nxlv: the keys before the first section, plus what the browser lists. */
function readLevelHeader(io, file) {
  const text = io.readText(file);
  const cut = text.search(/^\s*\$/m);
  const nx = parseNx(cut < 0 ? text : text.slice(0, cut));
  const num = (k) => { const v = first(nx, k); return v === null ? null : parseInt(v, 10); };
  return {
    title: first(nx, "TITLE") || basename(file, ".nxlv").replace(/_/g, " "),
    theme: first(nx, "THEME") || null,
    styles: terrainStyles(text),
    nxId: first(nx, "ID") || null,
    width: num("WIDTH"), height: num("HEIGHT"),
    lemmings: num("LEMMINGS"), save: num("SAVE_REQUIREMENT"),
  };
}

/** A classic pack from its config.json entry (skipped when its folder is absent). */
function classicPack(io, entry) {
  const dir = entry.path.replace(/\/+$/, "");
  if (!io.isDir(dir)) return null;
  const name = basename(dir);
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
    dir,
    gameType: GAME_TYPE[entry.gametype] || 0,
    count: children.reduce((n, c) => n + c.count, 0),
    children,
  };
}

/** One NeoLemmix pack: info.nxmi for its name, levels.nxmi for its ranks. */
function lemmixPack(io, dir, logicalPath, musicDir) {
  const nx = parseNx(io.readText(join(dir, "levels.nxmi")));
  const info = io.exists(join(dir, "info.nxmi"))
    ? parseNx(io.readText(join(dir, "info.nxmi"))) : null;
  const music = io.exists(join(dir, "music.nxmi"))
    ? all(parseNx(io.readText(join(dir, "music.nxmi"))), "TRACK") : [];
  const children = [];
  for (const group of nx.sections.filter((s) => s.name === "GROUP" || s.name === "RANK")) {
    const rankName = first(group, "NAME") || first(group, "FOLDER");
    const folder = first(group, "FOLDER") || rankName;
    if (!folder) continue;
    const rankDir = join(dir, folder);
    if (!io.isDir(rankDir)) continue;
    const rank = lemmixLevels(io, rankDir, logicalPath + "/" + folder, rankName);
    if (rank.count) children.push(rank);
  }
  // levels listed straight in the pack (a pack without ranks)
  const loose = all(nx, "LEVEL");
  if (loose.length) {
    const own = lemmixLevels(io, dir, logicalPath, basename(dir));
    if (own.count) children.push(own);
  }
  const pack = {
    kind: "pack", engine: "lemmix",
    name: (info && first(info, "TITLE")) || basename(dir).replace(/_/g, " "),
    path: logicalPath,
    dir,
    count: children.reduce((n, c) => n + c.count, 0),
    children,
  };
  if (info && first(info, "AUTHOR")) pack.author = first(info, "AUTHOR");
  if (info && first(info, "VERSION")) pack.version = first(info, "VERSION");
  if (io.exists(join(dir, "logo.png"))) pack.logo = join(dir, "logo.png");
  // a pack shipping its own skill panel graphics (skill_panels.png and
  // friends next to levels.nxmi, the way GameBaseSkillPanel looks them up):
  // the page asks the pack for them only then (lemmix/js/panel.js)
  if (io.exists(join(dir, "skill_panels.png"))) pack.panel = true;
  if (music.length) pack.musicRotation = music;
  if (musicDir) {
    pack.musicDir = musicDir;
    // its files ("sub/name.ext" below musicDir), so the game asks for a
    // track by the name it is there under (app.js musicCandidates)
    pack.musicFiles = listFilesBelow(io, musicDir);
  }
  return pack;
}

/** Every file under `dir`, as paths relative to it ("sub/name.ext"), in natural order. */
function listFilesBelow(io, dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const f of io.listFiles(d)) out.push(rel + f);
    for (const sub of io.listDirs(d)) walk(d + "/" + sub, rel + sub + "/");
  };
  if (io.isDir(dir)) walk(dir, "");
  return out;
}

/** A folder of .nxlv files, in the order its levels.nxmi lists them. */
function lemmixLevels(io, dir, logicalPath, name) {
  let files;
  if (io.exists(join(dir, "levels.nxmi"))) {
    files = all(parseNx(io.readText(join(dir, "levels.nxmi"))), "LEVEL")
      .filter((f) => io.exists(join(dir, f)));
  }
  if (!files || !files.length) files = io.listFiles(dir, ".nxlv");
  const levels = files.map((file) => {
    const url = join(dir, file);
    const header = readLevelHeader(io, url);
    return Object.assign({ id: logicalPath + "/" + file, file, url }, header);
  });
  return { kind: "dir", engine: "lemmix", name, path: logicalPath, count: levels.length, levels };
}

/** Any non-classic folder under levels/: a pack, a wrapper of packs, or loose levels. */
function lemmixNode(io, dir, logicalPath, musicDir) {
  const name = basename(dir);
  if (io.exists(join(dir, "levels.nxmi"))) {
    return lemmixPack(io, dir, logicalPath, musicDir);
  }
  const dirs = io.listDirs(dir);
  const nxlv = io.listFiles(dir, ".nxlv");
  // the wrapper a downloaded collection ships as: levels/ (and music/) only
  if (!nxlv.length && dirs.includes("levels") && !dirs.some((d) => d !== "levels" && d !== "music")) {
    const inner = join(dir, "levels");
    const music = io.isDir(join(dir, "music")) ? join(dir, "music") : musicDir;
    const children = io.listDirs(inner)
      .map((d) => lemmixNode(io, join(inner, d), logicalPath + "/" + d, music))
      .filter((n) => n && n.count);
    return {
      kind: "dir", engine: "lemmix", name: name.replace(/_/g, " "), path: logicalPath,
      count: children.reduce((n, c) => n + c.count, 0), children,
    };
  }
  if (nxlv.length && !dirs.length) return lemmixLevels(io, dir, logicalPath, name);
  const children = dirs
    .map((d) => lemmixNode(io, join(dir, d), logicalPath + "/" + d, musicDir))
    .filter((n) => n && n.count);
  if (nxlv.length) children.unshift(lemmixLevels(io, dir, logicalPath, name));
  if (!children.length) return null;
  return {
    kind: "dir", engine: "lemmix", name: name.replace(/_/g, " "), path: logicalPath,
    count: children.reduce((n, c) => n + c.count, 0), children,
  };
}

/**
 * The whole tree. `source` is a repo root on disk (a string) or an io;
 * `config` the parsed config.json (read from the source when omitted).
 */
function buildIndex(source, config) {
  const io = typeof source === "string" ? nodeIO(source) : source;
  if (!config) {
    config = [];
    try { config = JSON.parse(io.readText("config.json")); } catch (e) {}
  }
  const classicByDir = new Map();
  for (const entry of config) {
    const pack = classicPack(io, entry);
    if (pack) classicByDir.set(basename(entry.path.replace(/\/+$/, "")), pack);
  }
  const children = [];
  if (io.isDir(LEVELS_DIR)) {
    for (const d of io.listDirs(LEVELS_DIR)) {
      if (classicByDir.has(d)) { children.push(classicByDir.get(d)); continue; }
      const node = lemmixNode(io, join(LEVELS_DIR, d), d, null);
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

function summarize(node, depth, out) {
  const pad = "  ".repeat(depth);
  const tag = node.engine ? " [" + node.engine + "]" : "";
  out.push(pad + node.name + tag + " · " + node.count + " levels");
  for (const c of node.children || []) if (c.kind !== "dir" || c.children) summarize(c, depth + 1, out);
}

const api = { buildIndex, nodeIO, snapshotIO, parseNx, readLevelHeader, terrainStyles, summarize, listFilesBelow, LEVELS_DIR };
if (isNode) module.exports = api;
else root.LevelsIndex = api;

if (isNode && require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
  /** Where the repo root is, from wherever this runs. */
  let repoRoot = path.resolve(__dirname);
  for (let i = 0; i < 6; i++) {
    if (exists(path.join(repoRoot, "config.json")) && exists(path.join(repoRoot, "js", "lemmings.js"))) break;
    repoRoot = path.dirname(repoRoot);
  }
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
})(typeof window !== "undefined" ? window : globalThis);
