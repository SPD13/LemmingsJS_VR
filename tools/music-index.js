#!/usr/bin/env node
"use strict";
/**
 * Build neolemmix/music/index.json: the files of the NeoLemmix music packs
 * (neolemmix/music/), so the game asks for a level's track by the name it
 * is there under instead of trying every extension NeoLemmix knows - the
 * launcher serves the same thing live from the folder, this file is for
 * static hosting, and the setup page builds it for the files it keeps in
 * the browser.
 *
 *   { version, generated, count, files: ["orig_01.it", ...] }
 *
 * `files` are the file names as they are, in natural order, subfolders
 * included as "sub/name.ext". Like tools/levels-index.js the folder is
 * read through an io (a repo root on disk, or the setup page's snapshot of
 * the browser's files); loaded as a plain script it is window.MusicIndex.
 *
 * Usage: node tools/music-index.js [--check]
 */
(function (root) {
const MUSIC_DIR = "neolemmix/music";
const INDEX_FILE = "index.json";

const isNode = typeof module !== "undefined" && module.exports;
const levelsIndex = isNode ? require("./levels-index") : root.LevelsIndex;

/** Every file under `dir`, as paths relative to it ("sub/name.ext"), in natural order; not the index itself. */
function listMusicFiles(io, dir) {
  return levelsIndex.listFilesBelow(io, dir).filter((f) => f !== INDEX_FILE);
}

/** The index for a repo root on disk or an io (an empty one when no music is installed). */
function buildMusicIndex(source) {
  const io = typeof source === "string" ? levelsIndex.nodeIO(source) : source;
  const files = listMusicFiles(io, MUSIC_DIR);
  return { version: 1, generated: new Date().toISOString(), count: files.length, files };
}

const api = { buildMusicIndex, listMusicFiles, MUSIC_DIR, INDEX_FILE };
if (isNode) module.exports = api;
else root.MusicIndex = api;

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
  const index = buildMusicIndex(repoRoot);
  const outDir = path.join(repoRoot, ...MUSIC_DIR.split("/"));
  const out = path.join(outDir, INDEX_FILE);
  const check = process.argv.includes("--check");
  if (!isDir(outDir)) {
    console.log("no " + MUSIC_DIR + " folder: no NeoLemmix music packs are installed (see neolemmix/README.md)");
  } else if (!check) {
    fs.writeFileSync(out, JSON.stringify(index, null, 1) + "\n");
  }
  console.log((check ? "would write " : isDir(outDir) ? "wrote " : "skipped ") + out + " · " + index.count + " files");
}
})(typeof window !== "undefined" ? window : globalThis);
