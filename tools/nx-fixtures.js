"use strict";
/**
 * Synthetic levels for the Lemmix engine's node checks: a flat floor with
 * what a test needs drawn on it (`fill`), one lemming or a hatch, an exit,
 * water, a trap - mock gadgets carrying just the fields the physics reads.
 * nx-physics-test.js and nx-solve-test.js build their fixtures from these.
 */
const { Lemmix } = require("./lemmix-node");
const { PM } = Lemmix;

/** A level of `w` x `h` with a solid floor from row `floorY` down. */
function makeLevel(w, h, floorY) {
  const level = new Lemmix.Level(w, h);
  level.physics = new Uint16Array(w * h);
  const mask = new Int8Array(w * h);
  level.groundImage = new Uint8ClampedArray(w * h * 4);
  level.groundMask = { groundMask: mask, hasGroundAt: (x, y) => mask[x + y * w] !== 0,
    setGroundAt: (x, y) => { mask[x + y * w] = 1; }, clearGroundAt: (x, y) => { mask[x + y * w] = 0; } };
  level.gadgets = []; level.objects = []; level.entrances = [];
  level.preplaced = []; level.talismans = []; level.skills = [];
  level.releaseCount = 0; level.needCount = 0; level.spawnInterval = 53; level.spawnLocked = false;
  level.timeLimitSeconds = 0; level.zombieCount = 0; level.spawnOrder = [];
  level.theme = { lemmings: "default", colors: { MASK: 0x006090 } };
  level.info = { title: "fixture", author: "nx-fixtures", id: "fixture" };
  const fill = (x0, y0, x1, y1, bits) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      level.physics[x + y * w] = bits; mask[x + y * w] = bits & PM.SOLID ? 1 : 0;
    }
  };
  fill(0, floorY, w, h, PM.SOLID);
  level.fill = fill;
  return level;
}

const NO_PRESETS = { slider: false, climber: false, swimmer: false, floater: false, glider: false, disarmer: false, zombie: false, neutral: false };

/**
 * A mock gadget of `effect` whose trigger area is the rectangle (x, y, w, h)
 * - the fields the physics reads and nothing more. `extra` overrides any.
 */
function makeGadget(effect, x, y, w, h, extra) {
  return Object.assign({
    effect, effectBase: effect, triggerRect: { x0: x, y0: y, x1: x + w, y1: y + h }, flipLemming: false,
    presets: Object.assign({}, NO_PRESETS), remainingLemmings: -1, lemmingCap: 0, receiverId: -1, pairingId: -1,
    meta: { soundActivate: "", soundExhaust: "", keyFrame: 0 }, animations: [], frameCount: 10, currentFrame: 0,
    x, y, width: w, height: h, triggered: false, holdActive: false, teleLem: -1, zombieMode: false, neutralMode: false,
    secondariesTreatAsBusy: false, skillName: "", skill: -1, skillCount: 0,
  }, extra || {});
}

/** A hatch whose lemmings appear at (x, y), facing `dx`. */
function makeWindow(x, y, dx, extra) {
  return makeGadget("WINDOW", x, y, 1, 1, Object.assign({ flipLemming: dx < 0, width: 48, height: 24 }, extra || {}));
}

/** An exit standing on the floor at row `floorY`: its trigger area spans the feet row and the 6 above. */
function makeExit(x, floorY, w) { return makeGadget("EXIT", x, floorY - 6, w || 6, 8); }

/**
 * The level's hatches and lemming counts set up: `count` lemmings out of the
 * given windows in turn, `need` to save. Gadgets are appended to the level.
 */
function setSpawn(level, windows, count, need, spawnInterval) {
  const first = level.gadgets.length;
  for (const win of windows) level.gadgets.push(win);
  level.entrances = windows;
  level.releaseCount = count;
  level.needCount = need;
  if (spawnInterval) level.spawnInterval = spawnInterval;
  level.spawnOrder = [];
  for (let i = 0; i < count; i++) level.spawnOrder.push(first + (i % windows.length));
  return level;
}

/** A game on the level with one preplaced lemming at (x, y) facing dx, given `skills` (5 each). */
function makeGame(level, x, y, dx, skills, masks) {
  level.skills = (skills || []).map((name) => ({ name, count: 5 }));
  level.preplaced = [Object.assign({ x, y, dx, blocker: false }, NO_PRESETS)];
  level.releaseCount = 1;
  const game = new Lemmix.LemGame(level, masks);
  game.start();
  return game;
}

function run(game, frames, onFrame) {
  for (let f = 0; f < frames; f++) { game.update(); if (onFrame && onFrame(f) === false) break; }
}

module.exports = { makeLevel, makeGadget, makeWindow, makeExit, setSpawn, makeGame, run, NO_PRESETS };
