#!/usr/bin/env node
"use strict";
/**
 * Physics fixtures for the Lemmix engine: small synthetic levels (a flat
 * floor, a wall, a pit) with one lemming, a skill, and the outcome NeoLemmix
 * produces - the fall distance that splats, the bricks a builder lays, how
 * a digger, basher and miner cut, what steel and one-way walls stop. The
 * numbers come from LemGame.pas; a failure here means the port drifted.
 *
 * Usage: node tools/nx-physics-test.js
 */
const { Lemmix, nodeIO, findRepoRoot } = require("./lemmix-node");

const { PM, BA } = Lemmix;
let masks;
let passed = 0, failed = 0;

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

/** A game on the level with one lemming at (x, y) facing dx, given `skills`. */
function makeGame(level, x, y, dx, skills) {
  level.skills = (skills || []).map((name) => ({ name, count: 5 }));
  level.preplaced = [{ x, y, dx, slider: false, climber: false, swimmer: false, floater: false, glider: false, disarmer: false, zombie: false, neutral: false, blocker: false }];
  level.releaseCount = 1;
  const game = new Lemmix.LemGame(level, masks);
  game.start();
  return game;
}

function run(game, frames, onFrame) {
  for (let f = 0; f < frames; f++) { game.update(); if (onFrame && onFrame(f) === false) break; }
}

function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "  (" + JSON.stringify(detail) + ")" : "")); }
}

const solidCount = (level) => { let n = 0; for (const v of level.physics) if (v & PM.SOLID) n++; return n; };

async function main() {
  const io = nodeIO(findRepoRoot());
  masks = await Lemmix.loadMasks(io);

  // --- falls off a ledge: a walker steps 4 px down before it counts as
  // falling with LemFallen = 3, so a drop of 63 lands (fallen 62) and 64 splats
  for (const [drop, expect] of [[63, "walking"], [64, "splatting"]]) {
    const level = makeLevel(100, 120, 100);
    level.fill(0, 100 - drop, 30, 100, PM.SOLID); // a ledge `drop` pixels above the floor
    const game = makeGame(level, 20, 100 - drop, 1, []);
    let landed = null;
    run(game, 80, () => { const L = game.lemmings[0]; if (L.x >= 30 && L.action !== BA.FALLING && landed === null) { landed = Lemmix.ACTION_NAMES[L.action]; return false; } });
    check("fall of " + drop + " px -> " + expect, landed === expect, landed);
  }

  // --- floater survives a long fall, glider too
  for (const perm of ["floater", "glider"]) {
    const level = makeLevel(100, 120, 100);
    level.fill(0, 10, 30, 100, PM.SOLID);
    const game = makeGame(level, 20, 10, 1, []);
    game.lemmings[0]["is" + perm[0].toUpperCase() + perm.slice(1)] = true;
    let saw = new Set();
    run(game, 200, () => { saw.add(Lemmix.ACTION_NAMES[game.lemmings[0].action]); });
    check(perm + " survives a 90 px drop", saw.has(perm === "floater" ? "floating" : "gliding") && !saw.has("splatting") && saw.has("walking"), [...saw]);
  }

  // --- builder: 12 bricks, then a shrug, 12 px higher
  {
    const level = makeLevel(200, 100, 60);
    const game = makeGame(level, 20, 60, 1, ["BUILDER"]);
    game.assignSkillTo(game.lemmings[0], "BUILDER");
    let shrugged = false, bricksAt = null;
    run(game, 400, () => { const L = game.lemmings[0]; if (L.action === BA.SHRUGGING && !shrugged) { shrugged = true; bricksAt = { x: L.x, y: L.y }; } });
    const added = solidCount(level) - 200 * 40;
    check("builder lays 12 bricks of 6 px and shrugs", shrugged && added === 12 * 6 && bricksAt.y === 60 - 12, { shrugged, added, bricksAt });
  }

  // --- platformer: 12 bricks flat
  {
    const level = makeLevel(200, 100, 60);
    level.fill(40, 60, 200, 100, 0); // a chasm from x = 40
    const game = makeGame(level, 38, 60, 1, ["PLATFORMER"]);
    game.assignSkillTo(game.lemmings[0], "PLATFORMER");
    let ended = null;
    run(game, 500, () => { const L = game.lemmings[0]; if (ended === null && L.action !== BA.PLATFORMING && L.x > 35) { ended = { action: Lemmix.ACTION_NAMES[L.action], x: L.x, y: L.y }; return false; } });
    const added = solidCount(level) - 200 * 40 + 160 * 40;
    check("platformer bridges flat and shrugs", ended && ended.action === "shrugging" && ended.y === 60 && added > 20, { ended, added });
  }

  // --- stacker: 8 bricks high
  {
    const level = makeLevel(100, 100, 60);
    const game = makeGame(level, 20, 60, 1, ["STACKER"]);
    game.assignSkillTo(game.lemmings[0], "STACKER");
    run(game, 200);
    let top = 60;
    for (let y = 59; y >= 0; y--) if (level.physics[22 + y * 100] & PM.SOLID) top = y;
    check("stacker stacks 8 bricks", top === 60 - 8, top);
  }

  // --- digger: through 30 px, then falls; steel stops it
  {
    const level = makeLevel(100, 120, 60);
    level.fill(0, 90, 100, 120, 0); // floor is 30 thick, air below
    const game = makeGame(level, 50, 60, 1, ["DIGGER"]);
    game.assignSkillTo(game.lemmings[0], "DIGGER");
    let fell = null;
    run(game, 400, (f) => { const L = game.lemmings[0]; if (L.action === BA.FALLING && fell === null) { fell = { f, y: L.y }; return false; } });
    const hole = 9 * 30;
    const removed = 100 * 30 - (solidCount(level));
    check("digger cuts a 9 px shaft through 30 px and falls out", fell && fell.y >= 90 && removed === hole, { fell, removed });
  }
  {
    const level = makeLevel(100, 120, 60);
    level.fill(0, 70, 100, 120, PM.SOLID | PM.STEEL);
    const game = makeGame(level, 50, 60, 1, ["DIGGER"]);
    game.assignSkillTo(game.lemmings[0], "DIGGER");
    let stopped = null;
    run(game, 300, () => { const L = game.lemmings[0]; if (L.action === BA.WALKING && L.y > 60 && stopped === null) { stopped = L.y; return false; } });
    check("digger stops on steel 10 px down", stopped === 70, stopped);
  }

  // --- basher: through a 40 px wall; steel wall turns it
  {
    const level = makeLevel(200, 100, 60);
    level.fill(60, 20, 100, 60, PM.SOLID);
    const game = makeGame(level, 40, 60, 1, ["BASHER"]);
    run(game, 8);
    game.assignSkillTo(game.lemmings[0], "BASHER");
    let through = false;
    run(game, 600, () => { const L = game.lemmings[0]; if (L.x > 110 && L.action === BA.WALKING) { through = true; return false; } });
    check("basher tunnels through a 40 px wall", through, { x: game.lemmings[0].x, action: Lemmix.ACTION_NAMES[game.lemmings[0].action] });
  }
  {
    const level = makeLevel(200, 100, 60);
    level.fill(60, 20, 100, 60, PM.SOLID | PM.STEEL);
    const game = makeGame(level, 40, 60, 1, ["BASHER"]);
    run(game, 8);
    game.assignSkillTo(game.lemmings[0], "BASHER");
    let turned = false;
    run(game, 300, () => { const L = game.lemmings[0]; if (L.dx === -1) { turned = true; return false; } });
    check("basher turns at a steel wall", turned && solidCount(level) === 200 * 40 + 40 * 40, { turned, solid: solidCount(level) });
  }
  // one-way wall: a right-facing basher is stopped by ONEWAYLEFT, passes ONEWAYRIGHT
  for (const [bit, expectThrough] of [[PM.ONEWAYLEFT, false], [PM.ONEWAYRIGHT, true]]) {
    const level = makeLevel(200, 100, 60);
    level.fill(60, 20, 100, 60, PM.SOLID | PM.ONEWAY | bit);
    const game = makeGame(level, 40, 60, 1, ["BASHER"]);
    run(game, 8);
    game.assignSkillTo(game.lemmings[0], "BASHER");
    let through = false;
    run(game, 600, () => { const L = game.lemmings[0]; if (L.x > 110 && L.action === BA.WALKING) { through = true; return false; } });
    check("right-facing basher vs one-way " + (bit === PM.ONEWAYLEFT ? "left" : "right") + " wall: through=" + expectThrough, through === expectThrough, through);
  }

  // --- miner: goes down diagonally through the floor and falls out
  {
    const level = makeLevel(200, 120, 60);
    level.fill(0, 90, 200, 120, 0);
    const game = makeGame(level, 50, 60, 1, ["MINER"]);
    run(game, 10);
    game.assignSkillTo(game.lemmings[0], "MINER");
    let out = null;
    run(game, 600, () => { const L = game.lemmings[0]; if (L.y >= 90 && out === null) { out = { x: L.x, y: L.y, action: Lemmix.ACTION_NAMES[L.action] }; return false; } });
    check("miner mines diagonally out of a 30 px floor", out && out.x > 60 && out.action === "falling", out);
  }

  // --- climber: up a 20 px wall and over it
  {
    const level = makeLevel(200, 100, 60);
    level.fill(80, 40, 200, 60, PM.SOLID);
    const game = makeGame(level, 50, 60, 1, []);
    game.lemmings[0].isClimber = true;
    let saw = new Set(), over = false;
    run(game, 300, () => { const L = game.lemmings[0]; saw.add(Lemmix.ACTION_NAMES[L.action]); if (L.x > 90 && L.y === 40 && L.action === BA.WALKING) { over = true; return false; } });
    check("climber climbs and hoists over a 20 px wall", over && saw.has("climbing") && saw.has("hoisting"), [...saw]);
  }

  // --- blocker turns a walker; walker without climber turns at a wall
  {
    const level = makeLevel(200, 100, 60);
    const game = makeGame(level, 50, 60, 1, ["BLOCKER"]);
    level.preplaced.push({ x: 100, y: 60, dx: 1, blocker: true, slider: false, climber: false, swimmer: false, floater: false, glider: false, disarmer: false, zombie: false, neutral: false });
    const g2 = new Lemmix.LemGame(level, masks); g2.start();
    let turned = false;
    run(g2, 200, () => { if (g2.lemmings[0].dx === -1) { turned = true; return false; } });
    check("a blocker turns the walker", turned && g2.lemmings[1].action === BA.BLOCKING, { turned, x: g2.lemmings[0].x });
  }

  // --- bomber: instant, ohno for 16 frames, then a crater
  {
    const level = makeLevel(200, 100, 60);
    const game = makeGame(level, 50, 60, 1, ["BOMBER"]);
    game.assignSkillTo(game.lemmings[0], "BOMBER");
    let exploded = -1;
    run(game, 60, (f) => { if (game.lemmings[0].removed && exploded < 0) exploded = f; });
    const removed = 200 * 40 - solidCount(level);
    check("bomber explodes after the oh-no and leaves a crater", exploded > 10 && exploded < 30 && removed > 50, { exploded, removed });
  }

  // --- stoner: leaves a stone
  {
    const level = makeLevel(200, 100, 60);
    const game = makeGame(level, 50, 60, 1, ["STONER"]);
    game.assignSkillTo(game.lemmings[0], "STONER");
    run(game, 60);
    const added = solidCount(level) - 200 * 40;
    check("stoner leaves a stone", added >= 20, added);
  }

  // --- spawn cadence: SI 53 releases every 53 frames after the hatch opens at 35 + 20
  {
    const level = makeLevel(200, 100, 60);
    level.releaseCount = 3; level.spawnOrder = [0, 0, 0];
    const window = { effect: "WINDOW", effectBase: "WINDOW", triggerRect: { x0: 20, y0: 20, x1: 21, y1: 21 }, flipLemming: false,
      presets: { slider: false, climber: false, swimmer: false, floater: false, glider: false, disarmer: false, zombie: false, neutral: false },
      remainingLemmings: -1, meta: { soundActivate: "", soundExhaust: "", keyFrame: 0 }, animations: [], frameCount: 10, currentFrame: 0, x: 20, y: 20, width: 48, height: 24 };
    level.gadgets = [window];
    const game = new Lemmix.LemGame(level, masks); game.start();
    const releases = [];
    run(game, 200, (f) => { if (game.lemmings.length > releases.length) releases.push(f + 1); });
    // the hatch opens on iteration 35 and the 20-frame countdown ends on 54
    check("spawn at frames 54, 107, 160 for SI 53", JSON.stringify(releases) === "[54,107,160]", releases);
  }

  // --- jumper: clears a 3 px step and lands walking further on
  {
    const level = makeLevel(200, 100, 60);
    level.fill(80, 57, 200, 60, PM.SOLID);
    const game = makeGame(level, 60, 60, 1, ["JUMPER"]);
    run(game, 5);
    game.assignSkillTo(game.lemmings[0], "JUMPER");
    let saw = new Set(), landed = null;
    run(game, 60, () => { const L = game.lemmings[0]; saw.add(Lemmix.ACTION_NAMES[L.action]); if (saw.has("jumping") && L.action === BA.WALKING && landed === null) { landed = { x: L.x, y: L.y }; return false; } });
    check("jumper jumps an arc and lands walking on the step", saw.has("jumping") && landed && landed.x > 70 && landed.y === 57, { saw: [...saw], landed });
  }

  // --- shimmier: reaches a ceiling and shimmies along it
  {
    const level = makeLevel(200, 100, 60);
    level.fill(0, 44, 200, 47, PM.SOLID); // a ceiling 13-16 px above the floor
    const game = makeGame(level, 40, 60, 1, ["SHIMMIER"]);
    run(game, 5);
    game.assignSkillTo(game.lemmings[0], "SHIMMIER");
    let saw = new Set(), far = 0;
    run(game, 120, () => { const L = game.lemmings[0]; saw.add(Lemmix.ACTION_NAMES[L.action]); if (L.action === BA.SHIMMYING) far = Math.max(far, L.x); });
    check("shimmier reaches the ceiling and moves along it", saw.has("reaching") && saw.has("shimmying") && far > 60, { saw: [...saw], far });
  }

  // --- slider: slides down a wall instead of falling off it, then walks
  {
    const level = makeLevel(200, 120, 100);
    level.fill(0, 40, 60, 100, PM.SOLID); // a 60 px cliff
    const game = makeGame(level, 50, 40, 1, []);
    game.lemmings[0].isSlider = true;
    let saw = new Set(), ended = null;
    run(game, 150, () => { const L = game.lemmings[0]; saw.add(Lemmix.ACTION_NAMES[L.action]); if (saw.has("sliding") && L.action === BA.WALKING && ended === null) { ended = { x: L.x, y: L.y }; return false; } });
    check("slider dehoists at the edge, slides down the cliff and walks on", saw.has("dehoisting") && saw.has("sliding") && !saw.has("splatting") && ended && ended.y === 100, { saw: [...saw], ended });
  }

  // --- laserer: cuts a diagonal upward through a wall
  {
    const level = makeLevel(200, 120, 100);
    level.fill(70, 20, 200, 100, PM.SOLID);
    const game = makeGame(level, 60, 100, 1, ["LASERER"]);
    run(game, 3);
    game.assignSkillTo(game.lemmings[0], "LASERER");
    const before = solidCount(level);
    run(game, 60);
    const removed = before - solidCount(level);
    check("laserer removes terrain along its beam", removed > 30, { removed });
  }

  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
