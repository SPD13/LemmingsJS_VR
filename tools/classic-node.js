"use strict";
/**
 * The classic engine under node, for its tilesets: js/lemmings.js is a
 * browser script, run here in a bare context with the few globals it
 * touches at load, and its readers used to open a DOS graphics set
 * (GROUND<n>O.DAT + VGAGR<n>.DAT) the way the game and the galleries page
 * do. The pack names are the profiles' (`<pack>-g<set>`: the config path's
 * last segment, letters and digits only, lowercased).
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let engine = null;

/** The Lemmings namespace of js/lemmings.js, loaded once. */
function classicEngine(repoRoot) {
  if (engine) return engine;
  const src = fs.readFileSync(path.join(repoRoot, "js", "lemmings.js"), "utf8");
  const ctx = {
    console: { log() {}, warn() {}, error: console.error, debug() {} },
    window: {}, document: { createElement: () => ({ getContext: () => null }) },
    setTimeout, clearTimeout, Promise, Uint8Array, Uint8ClampedArray, Int8Array, Int16Array, Uint16Array,
    Uint32Array, Int32Array, Float32Array, Float64Array, ArrayBuffer, DataView, Map, Set, Math, Object, Array,
    Error, TextDecoder, Number, String, Boolean, JSON, Date, RegExp,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "lemmings.js" });
  engine = ctx.Lemmings;
  return engine;
}

/** The classic packs of config.json: { name, path, slug, gameType }. */
function classicPacks(repoRoot) {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "config.json"), "utf8"));
  return config.map((c) => ({
    name: c.name, path: c.path, gameType: c.gametype,
    slug: String(c.path || "game").split("/").pop().replace(/[^a-z0-9]/gi, "").toLowerCase(),
  }));
}

/** The world names the library shows for a pack's graphics sets. */
const WORLD_NAMES = {
  LEMMINGS: ["Dirt", "Fire", "Marble", "Pillar", "Crystal"],
  OHNO: ["Brick", "Rock", "Snow", "Bubble"],
};

/** The graphics sets a pack has on disk: [{ pack, set, id, title, dir }]. */
function classicTilesets(repoRoot) {
  const out = [];
  for (const pack of classicPacks(repoRoot)) {
    const dir = path.join(repoRoot, pack.path);
    for (let set = 0; set < 10; set++) {
      if (!fs.existsSync(path.join(dir, "GROUND" + set + "O.DAT")) || !fs.existsSync(path.join(dir, "VGAGR" + set + ".DAT"))) continue;
      const world = (WORLD_NAMES[pack.gameType] || [])[set];
      out.push({ pack, set, id: pack.slug + "-g" + set, title: pack.name + (world ? " " + world : " set " + set), dir });
    }
  }
  return out;
}

/** A tileset's terrain images and ground palette, as the game reads them. */
function readTileset(repoRoot, id) {
  const ts = classicTilesets(repoRoot).find((t) => t.id === id);
  if (!ts) throw new Error("no such classic tileset: " + id);
  const L = classicEngine(repoRoot);
  const read = (file) => new L.BinaryReader(new Uint8Array(fs.readFileSync(path.join(ts.dir, file))), 0, undefined, file);
  const container = new L.FileContainer(read("VGAGR" + ts.set + ".DAT"));
  const reader = new L.GroundReader(read("GROUND" + ts.set + "O.DAT"), container.getPart(0), container.getPart(1));
  return { tileset: ts, terraImages: reader.getTerraImages(), groundPalette: reader.groundPalette, colorPalette: reader.colorPalette };
}

module.exports = { classicEngine, classicPacks, classicTilesets, readTileset, WORLD_NAMES };
