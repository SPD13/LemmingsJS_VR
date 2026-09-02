"use strict";
/**
 * The Lemmix engine under node: loads the browser modules into a shared
 * namespace and supplies an io that reads styles and levels from disk
 * (PNG decoding through pngjs). Used by the nx-* tools.
 */
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const LEMMIX_DIR = path.join(__dirname, "..", "lemmix", "js");

// the modules attach themselves to globalThis.Lemmix, in dependency order
for (const name of ["parser.js", "pixels.js", "styles.js", "level.js", "lemgame.js", "sprites.js", "replay.js"]) {
  require(path.join(LEMMIX_DIR, name));
}
const Lemmix = globalThis.Lemmix;

/** Files relative to the repo root, null when absent - like the browser's fetch. */
function nodeIO(repoRoot) {
  const abs = (url) => path.join(repoRoot, decodeURIComponent(url));
  return {
    async text(url) {
      try { return fs.readFileSync(abs(url), "utf8"); } catch (e) { return null; }
    },
    async image(url) {
      let buf;
      try { buf = fs.readFileSync(abs(url)); } catch (e) { return null; }
      const png = PNG.sync.read(buf);
      return new Lemmix.Bitmap(png.width, png.height, new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length));
    },
  };
}

/** Write an RGBA bitmap as a PNG file. */
function writePng(file, width, height, rgba) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  fs.writeFileSync(file, PNG.sync.write(png));
}

function findRepoRoot() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "config.json")) && fs.existsSync(path.join(dir, "levels"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, "..");
}

/** Every .nxlv under a directory, in the order the index lists them where it can. */
function listLevels(repoRoot, under) {
  const index = JSON.parse(fs.readFileSync(path.join(repoRoot, "levels", "index.json"), "utf8"));
  const out = [];
  const walk = (node) => {
    for (const level of node.levels || []) if (level.url) out.push(level);
    for (const child of node.children || []) walk(child);
  };
  walk(index);
  return under ? out.filter((l) => l.id.startsWith(under)) : out;
}

module.exports = { Lemmix, nodeIO, writePng, findRepoRoot, listLevels };
