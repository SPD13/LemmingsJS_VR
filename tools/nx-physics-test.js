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

  // ================= the replay model and saved states (rewind.js)

  /** A fingerprint of everything a frame is: lemmings, ground, counters. */
  function fingerprint(game) {
    let h = 0;
    const mix = (v) => { h = (Math.imul(h ^ (v | 0), 0x9e3779b1) + 0x7f4a7c15) | 0; };
    for (const L of game.lemmings) { mix(L.x); mix(L.y); mix(L.dx); mix(L.action); mix(L.frame); mix(L.removed ? 1 : 0); mix(L.explosionTimer); }
    const ph = game.level.physics; for (let i = 0; i < ph.length; i++) mix(ph[i]);
    for (const k of ["currentIteration", "clockFrame", "lemmingsOut", "lemmingsIn", "lemmingsRemoved", "currSpawnInterval", "nextLemmingCountdown"]) mix(game[k]);
    for (const g of game.gadgets) { mix(g.currentFrame); mix(g.triggered ? 1 : 0); }
    return h;
  }

  // --- a player's assignment is recorded now and takes effect in the next update
  {
    const level = makeLevel(200, 100, 60);
    const game = makeGame(level, 20, 60, 1, ["DIGGER"]);
    run(game, 40);
    const at = game.currentIteration;
    const ok = game.assignSkillTo(game.lemmings[0], "DIGGER");
    const before = game.lemmings[0].action;
    game.update();
    const after = game.lemmings[0].action;
    check("an assignment is recorded at the frame and applied by the next update",
      ok && before === BA.WALKING && after === BA.DIGGING && game.recorded.length === 1 && game.recorded[0].frame === at &&
      game.skillCount("DIGGER") === 4, { ok, before, after, recorded: game.recorded });
    check("the replay is over once its last action has fired", game.replaying === false && game.lastActionFrame === at);
  }

  // --- saving a state and loading it back gives the same future
  {
    const level = makeLevel(600, 100, 60);
    const game = makeGame(level, 20, 60, 1, ["BUILDER", "DIGGER"]);
    run(game, 30);
    game.assignSkillTo(game.lemmings[0], "BUILDER");
    run(game, 70);
    const state = game.saveState();
    const atSave = game.currentIteration;
    run(game, 60);
    game.assignSkillTo(game.lemmings[0], "DIGGER");
    run(game, 140);
    const straight = fingerprint(game), endFrame = game.currentIteration;
    game.loadState(state);
    check("loadState puts the frame back", game.currentIteration === atSave && fingerprint(game) !== straight);
    run(game, endFrame - atSave);
    check("the same frames after a load give the same game (the replay re-fires)", fingerprint(game) === straight, { endFrame });
  }

  // --- cutReplay: assignments and nukes from the frame, spawn intervals from the frame after
  {
    const level = makeLevel(200, 100, 60);
    const game = makeGame(level, 20, 60, 1, ["DIGGER"]);
    game.recorded = [
      { type: "assignment", frame: 10, skill: "DIGGER", lemIndex: 0, lemId: "N1" },
      { type: "spawn_interval", frame: 20, interval: 40, spawned: 1 },
      { type: "assignment", frame: 20, skill: "DIGGER", lemIndex: 0, lemId: "N1" },
      { type: "nuke", frame: 25 },
      { type: "spawn_interval", frame: 30, interval: 30, spawned: 1 },
    ];
    game.currSpawnInterval = 40; // the one on frame 20 agrees with what is in force
    game.cutReplay(20);
    const kept = game.recorded.map((r) => r.type + "@" + r.frame).join(" ");
    check("cutReplay keeps the agreeing spawn interval on the frame, drops the rest", kept === "assignment@10 spawn_interval@20", kept);
    game.recorded.push({ type: "spawn_interval", frame: 20, interval: 45, spawned: 1 });
    game.recorded = game.recorded.filter((r) => !(r.type === "spawn_interval" && r.interval === 40));
    game.cutReplay(20);
    check("...and drops a disagreeing one", game.recorded.length === 1 && game.recorded[0].frame === 10);
  }

  // --- regainControl cuts only while the replay still has actions ahead
  {
    const level = makeLevel(200, 100, 60);
    const game = makeGame(level, 20, 60, 1, ["DIGGER"]);
    game.recorded = [{ type: "assignment", frame: 50, skill: "DIGGER", lemIndex: 0, lemId: "N1" }];
    run(game, 10);
    check("replaying while an action lies ahead", game.replaying === true && game.lastActionFrame === 50);
    game.regainControl();
    check("taking control drops the action ahead", game.recorded.length === 0 && game.replaying === false);
    game.replayInsert = true;
    game.recorded = [{ type: "assignment", frame: 50, skill: "DIGGER", lemIndex: 0, lemId: "N1" }];
    game.regainControl();
    check("...but not in replay-insert mode", game.recorded.length === 1);
    game.regainControl(true);
    check("...unless forced", game.recorded.length === 0);
  }

  // --- gotoFrame: back and forward through saved states equals playing straight
  {
    const level = makeLevel(600, 100, 60);
    const game = makeGame(level, 20, 60, 1, ["BUILDER", "DIGGER"]);
    const states = new Lemmix.SaveStates();
    states.add(game);
    const marks = {};
    const step = () => {
      game.update();
      if (game.currentIteration % Lemmix.Rewind.SAVE_EVERY === 0) { states.add(game); states.tidy(game.currentIteration); }
      if (game.currentIteration === 60) game.assignSkillTo(game.lemmings[0], "BUILDER");
      if (game.currentIteration === 300) game.assignSkillTo(game.lemmings[0], "DIGGER");
      if ([100, 250, 400].includes(game.currentIteration)) marks[game.currentIteration] = fingerprint(game);
    };
    for (let f = 0; f < 400; f++) step();
    const n1 = Lemmix.Rewind.gotoFrame(game, states, 250);
    check("gotoFrame 250 lands on the frame from the state before it", game.currentIteration === 250 && fingerprint(game) === marks[250] && n1 > 0 && n1 <= Lemmix.Rewind.SAVE_EVERY, { n1 });
    Lemmix.Rewind.gotoFrame(game, states, 100);
    check("gotoFrame 100 (before the digger, after the builder) matches", game.currentIteration === 100 && fingerprint(game) === marks[100]);
    Lemmix.Rewind.gotoFrame(game, states, 400);
    check("gotoFrame 400 forward again re-fires the replay and matches", game.currentIteration === 400 && fingerprint(game) === marks[400]);
    Lemmix.Rewind.gotoFrame(game, states, 0);
    check("gotoFrame 0 is the level's start, the replay kept", game.currentIteration === 0 && game.lemmings.length === 1 && game.recorded.length === 2 && game.replaying === true);
    // one frame back from 400: a state strictly before, then 399 - 340 = 59 frames
    Lemmix.Rewind.gotoFrame(game, states, 400);
    const n2 = Lemmix.Rewind.gotoFrame(game, states, 399);
    check("one frame back re-simulates from the state before", game.currentIteration === 399 && n2 === 399 - 340, { n2 });
  }

  // --- taking control at a rewound frame forks the replay there
  {
    const level = makeLevel(600, 100, 60);
    const game = makeGame(level, 20, 60, 1, ["BUILDER", "DIGGER"]);
    const states = new Lemmix.SaveStates();
    states.add(game);
    for (let f = 0; f < 200; f++) { game.update(); if (game.currentIteration === 180) game.assignSkillTo(game.lemmings[0], "DIGGER"); }
    Lemmix.Rewind.gotoFrame(game, states, 120);
    check("rewound to 120, the digger at 180 still lies ahead", game.replaying && game.recorded.length === 1);
    game.assignSkillTo(game.lemmings[0], "BUILDER");
    check("a new action at 120 replaces the future", game.recorded.length === 1 && game.recorded[0].skill === "BUILDER" && game.recorded[0].frame === 120);
    run(game, 100);
    check("...and the old digger never fires", game.skillCount("DIGGER") === 5 && game.skillCount("BUILDER") === 4);
  }

  // ================= skill shadows (shadows.js)

  // --- a builder's shadow: twelve bricks of six pixels, the terrain untouched
  {
    const level = makeLevel(200, 100, 60);
    const game = makeGame(level, 20, 60, 1, ["BUILDER", "BASHER", "DIGGER", "BOMBER"]);
    run(game, 30);
    const L = game.lemmings[0], before = solidCount(level), x0 = L.x, y0 = L.y, action = L.action;
    const sh = Lemmix.Shadows.compute(game, L, "BUILDER");
    check("builder shadow: 12 bricks x 6 pixels rising a row each", sh.bricks.length === 72 && sh.high.length === 0 && sh.low.length === 0 &&
      sh.bricks.every(([x, y]) => y < y0 && y >= y0 - 12) && Math.max(...sh.bricks.map((p) => p[0])) === x0 + 2 * 11 + 5 && Math.min(...sh.bricks.map((p) => p[1])) === y0 - 12, { n: sh.bricks.length, maxX: Math.max(...sh.bricks.map((p) => p[0])) - x0 });
    check("...and leaves the game as it was", solidCount(level) === before && L.x === x0 && L.y === y0 && L.action === action);
    // --- a digger through the 40-px floor: the whole hole, 9 wide, down to the bottom of the level
    const dig = Lemmix.Shadows.compute(game, L, "DIGGER");
    check("digger shadow: the solid hole, nine wide, through the floor", dig.high.length === 9 * 40 && dig.low.length === 0 &&
      dig.high.every(([x, y]) => Math.abs(x - x0) <= 4 && y >= y0 && y < 100), { n: dig.high.length });
    check("...and the floor is whole again", solidCount(level) === before);
    // --- a bomber: the crater as a solid, the mask's pixels that were terrain
    const bomb = Lemmix.Shadows.compute(game, L, "BOMBER");
    check("bomber shadow: the solid crater, below the feet only on open ground", bomb.high.length > 40 && bomb.high.every(([x, y]) => Math.abs(x - x0) <= 8 && y >= y0 && y <= y0 + 7), { n: bomb.high.length });
    // --- a walker on flat ground bashes nothing: no terrain taken, no shadow
    const bash = Lemmix.Shadows.compute(game, L, "BASHER");
    check("basher shadow on open ground: nothing", bash.high.length === 0, { n: bash.high.length });
    check("no shadow for a skill without one", Lemmix.Shadows.compute(game, L, "CLIMBER").high.length === 0 && Lemmix.Shadows.compute(game, L, "CLIMBER").low.length === 0);
  }

  // ================= the hotkeys' filters and skips

  // --- directional select: the panel's sticky choice, a held direction key over it
  {
    const level = makeLevel(200, 100, 60);
    level.skills = [{ name: "BUILDER", count: 5 }, { name: "DIGGER", count: 5 }];
    level.preplaced = [
      { x: 50, y: 60, dx: 1, slider: false, climber: false, swimmer: false, floater: false, glider: false, disarmer: false, zombie: false, neutral: false, blocker: false },
      { x: 52, y: 60, dx: -1, slider: false, climber: false, swimmer: false, floater: false, glider: false, disarmer: false, zombie: false, neutral: false, blocker: false },
    ];
    level.releaseCount = 2;
    const game = new Lemmix.LemGame(level, masks);
    game.start();
    const right = game.lemmings.find((L) => L.dx === 1), left = game.lemmings.find((L) => L.dx === -1);
    const at = () => game.getPriorityLemming(BA.NONE, 51, 58).lemming;
    check("both under the cursor: one of them", at() === right || at() === left);
    game.selectDx = -1;
    check("the panel's left filter: the left-facing one", at() === left);
    game.hotkeyDx = 1;
    check("a held right key wins over the panel's choice", game.effectiveSelectDx === 1 && at() === right);
    game.hotkeyDx = 0; game.selectDx = 0;
    // --- select walker: a worker would come first; with the key held only the walker counts
    game.assignSkillTo(left, "BUILDER");
    run(game, 3);
    game.setSelectedSkill("DIGGER"); // a skill a builder can take: the worker's box comes first
    check("a builder under the cursor comes before a walker", left.action === BA.BUILDING && at() === left);
    game.selectWalkerOnly = true;
    check("...unless only walkers are wanted", at() === right);
    game.selectWalkerOnly = false;
  }

  // --- skip to next shrugger: ahead at hyperspeed until a builder runs out of bricks
  {
    const level = makeLevel(600, 100, 60);
    const game = makeGame(level, 20, 60, 1, ["BUILDER"]);
    const states = new Lemmix.SaveStates();
    states.add(game);
    run(game, 10);
    game.assignSkillTo(game.lemmings[0], "BUILDER");
    run(game, 2);
    const n = Lemmix.Rewind.runUntil(game, states, (s) => s.lemmings.some((L) => L.action === BA.SHRUGGING), 5000);
    check("runUntil stops on the shrugger", game.lemmings[0].action === BA.SHRUGGING && n > 12 * 9 && n < 300, { n, action: game.lemmings[0].action });
    check("...and saved a state on the way", states.states.length >= 2);
    const m = Lemmix.Rewind.runUntil(game, states, () => false, 7);
    check("runUntil runs its bound out", m === 7);
  }

  // ================= the hotkey table (3d/js/hotkeys.js)
  {
    const Hotkeys = require("../3d/js/hotkeys.js");
    const hk = new Hotkeys.HotkeyManager(); // no localStorage here: the traditional layout
    check("traditional layout: R restarts, P pauses, F3 is the climber", hk.get("KeyR").action === "restart" && hk.get("KeyP").action === "pause" &&
      hk.get("F3").action === "skill" && hk.get("F3").mod === "climber");
    check("the manual's skips: B back one, N forward one, space 170", hk.get("KeyB").mod === -1 && hk.get("KeyN").mod === 1 && hk.get("Space").mod === 170);
    check("described as NeoLemmix lists them", Hotkeys.describe(hk.get("KeyB")) === "Time Skip: Back 1 Frame" && Hotkeys.describe(hk.get("Comma")) === "Time Skip: Back 85 Frames" &&
      Hotkeys.describe(hk.get("Digit1")) === "Select Skill: Walker" && Hotkeys.describe(hk.get("KeyT")) === "Clear Physics Mode (hold)" && Hotkeys.describe(hk.get("BracketLeft")) === "Skip to Previous Assignment");
    check("tagged Lemmix when a DOS level cannot do it", Hotkeys.tagOf(hk.get("KeyB")) === "lemmix" && Hotkeys.tagOf(hk.get("Digit1")) === "lemmix" && Hotkeys.tagOf(hk.get("KeyT")) === "lemmix" &&
      Hotkeys.tagOf(hk.get("F3")) === "" && Hotkeys.tagOf(hk.get("KeyN")) === "" && Hotkeys.tagOf(hk.get("Home")) === "view");
    hk.set("KeyQ", "pause");
    check("a key given a function, and one cleared", hk.get("KeyQ").action === "pause" && (hk.set("KeyQ", null), hk.get("KeyQ") === null));
    check("the first keyboard key of a function names it", hk.keyNameFor("pause") === "P" && hk.keyNameFor("skill", "digger") === "F10" && hk.keyNameFor("skip", 1) === "N");
    hk.applyPreset("functional");
    check("functional layout: F1 restarts, D is the walker, space pauses", hk.get("F1").action === "restart" && hk.get("KeyD").mod === "walker" && hk.get("Space").action === "pause");
    check("Shift and Ctrl are keys like any other", Hotkeys.normalizeCode("ShiftLeft") === "Shift" && Hotkeys.normalizeCode("ControlRight") === "Control" && hk.get("Shift").action === "previous_skill");
  }

  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
