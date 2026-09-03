"use strict";
/**
 * Skill shadows (LemRendering.pas DrawShadows and its Draw*Shadow): with a
 * skill selected and a lemming under the cursor, NeoLemmix shows what the
 * skill would do - the bricks a builder would lay, the tunnel a basher
 * would cut, a jumper's arc, a bomber's crater - by simulating a copy of
 * the lemming with the skill, frame by frame, and marking pixels as it
 * goes. NeoLemmix marks the outlines of what a skill would dig or build,
 * from tables; the diorama wants the solids, so the terrain the simulated
 * action removes or lays is read off the physics map itself - every pixel
 * that was solid and is no more is "high" (a tunnel, a crater, a hole),
 * every pixel that became solid is a brick - and the map is put back
 * afterwards; the game never knows. Paths (a jumper's arc, a glider's
 * flight) are the positions the copy passes, as NeoLemmix draws them.
 *
 * compute(sim, lemming, skill) returns { low, high, bricks }, each a list of
 * [x, y]: "low" the paths, "bricks" the terrain a builder, platformer or
 * stacker would lay, "high" the terrain a basher, miner, digger, fencer,
 * laserer or bomber would take.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const { BA, ACTION_TO_SKILL } = Lemmix;

  /** The skills that cast one (CheckForNewShadow's ShadowSkillSet). */
  const SHADOW_SKILLS = new Set(["JUMPER", "SHIMMIER", "PLATFORMER", "BUILDER", "STACKER", "DIGGER",
    "MINER", "BASHER", "FENCER", "BOMBER", "GLIDER", "CLONER", "LASERER"]);

  const MAX_WORK_FRAMES = 10000; // a tunnel or a hole is simulated to its end, within reason

  class ShadowSet {
    constructor(sim) { this.sim = sim; this.low = []; this.high = []; this.bricks = []; this._seen = new Set(); }
    _put(list, tag, x, y) {
      if (x < 0 || x >= this.sim.width || y < 0 || y >= this.sim.height) return;
      const key = tag + x + "," + y;
      if (this._seen.has(key)) return;
      this._seen.add(key);
      list.push([x, y]);
    }
    lowAt(x, y) { this._put(this.low, "l", x, y); }
    highAt(x, y) { this._put(this.high, "h", x, y); }
    brickAt(x, y) { this._put(this.bricks, "b", x, y); }
  }

  /**
   * Run `fn` with the physics map and the game's frame scratch put back
   * afterwards; what the map lost and gained meanwhile goes into `out` as
   * the high pixels and the bricks.
   */
  function withPhysicsSaved(sim, out, fn) {
    const saved = sim.physics.slice();
    const nextAction = sim.lemNextAction, hoist = sim.lemJumpToHoistAdvance, done = sim.doneAssignmentThisFrame;
    sim.lemNextAction = BA.NONE; sim.lemJumpToHoistAdvance = false;
    try { fn(); } finally {
      const now = sim.physics, w = sim.width;
      for (let i = 0; i < now.length; i++) {
        const was = saved[i] & 1, is = now[i] & 1;
        if (was && !is) out.highAt(i % w, (i / w) | 0);
        else if (!was && is) out.brickAt(i % w, (i / w) | 0);
      }
      sim.physics.set(saved);
      sim.lemNextAction = nextAction; sim.lemJumpToHoistAdvance = hoist; sim.doneAssignmentThisFrame = done;
    }
  }

  function drawJumper(sim, L, out) {
    let frames = 0;
    out.lowAt(L.x, L.y - 1);
    const follow = new Set([BA.JUMPING, BA.CLIMBING, BA.HOISTING, BA.FALLING, BA.FLOATING, BA.GLIDING, BA.SLIDING]);
    while (frames < 2000 && follow.has(L.action)) {
      frames++;
      const pos = sim.simulateLem(L, true);
      for (const [x, y] of pos) {
        if (x < 0 || x >= sim.width || y <= 0) return;
        out.lowAt(x, y - 1); out.highAt(x, y - 1);
        if (L.x === x && L.y === y) break;
      }
    }
  }

  function drawShimmier(sim, L, out) {
    let frames = 0, pos = null;
    out.lowAt(L.x, L.y - 1);
    while (frames < 2000 && (L.action === BA.REACHING || L.action === BA.SHIMMYING)) {
      frames++;
      if (pos) for (const [x, y] of pos) { out.lowAt(x, y - 1); if (L.x === x && L.y === y) break; }
      pos = sim.simulateLem(L, true);
    }
  }

  function drawGlider(sim, L, out) {
    let frames = 0, pos = null;
    out.lowAt(L.x, L.y - 1);
    while (frames < 2000 && (L.action === BA.GLIDING || (frames < 15 && (L.action === BA.FALLING || L.action === BA.JUMPING)))) {
      frames++;
      if (pos) for (const [x, y] of pos) { out.lowAt(x, y - 1); if (L.x === x && L.y === y) break; }
      pos = sim.simulateLem(L, true);
    }
  }

  /** The skill's work simulated to its end: what the map lost and gained is the shadow. */
  function work(sim, L, action) {
    let frames = 0;
    while (L.action === action && frames < MAX_WORK_FRAMES) {
      sim.simulateLem(L, true);
      frames++;
    }
  }

  /** The laserer: until the beam stops hitting, or hits the same spot twice. */
  function drawLaserer(sim, L) {
    let last = null;
    while (L.action === BA.LASERING) {
      sim.simulateLem(L, true);
      if (!L.laserHit || !L.laserHitPoint || (last && last[0] === L.laserHitPoint[0] && last[1] === L.laserHitPoint[1])) break;
      last = L.laserHitPoint.slice();
    }
  }

  /** The bomber: the crater its mask leaves, applied in simulation. */
  function drawExploder(sim, L) {
    sim.simulationDepth++;
    try { sim.applyExplosionMask(L); } finally { sim.simulationDepth--; }
  }

  /** DrawShadows: the pixels the skill would touch, for this lemming as it stands now. */
  function draw(sim, L, skill, out) {
    const copy = L.clone();
    switch (skill) {
      case "JUMPER": sim.simulateTransitionLem(copy, BA.JUMPING); drawJumper(sim, copy, out); break;
      case "SHIMMIER":
        sim.simulateTransitionLem(copy, (copy.action === BA.CLIMBING || copy.action === BA.JUMPING) ? BA.SHIMMYING : BA.REACHING);
        drawShimmier(sim, copy, out); break;
      case "BUILDER": sim.simulateTransitionLem(copy, BA.BUILDING); work(sim, copy, BA.BUILDING); break;
      case "PLATFORMER": sim.simulateTransitionLem(copy, BA.PLATFORMING); work(sim, copy, BA.PLATFORMING); break;
      case "STACKER": sim.simulateTransitionLem(copy, BA.STACKING); work(sim, copy, BA.STACKING); break;
      case "DIGGER": sim.simulateTransitionLem(copy, BA.DIGGING); work(sim, copy, BA.DIGGING); break;
      case "MINER": sim.simulateTransitionLem(copy, BA.MINING); work(sim, copy, BA.MINING); break;
      case "BASHER": sim.simulateTransitionLem(copy, BA.BASHING); work(sim, copy, BA.BASHING); break;
      case "FENCER": sim.simulateTransitionLem(copy, BA.FENCING); work(sim, copy, BA.FENCING); break;
      case "BOMBER": drawExploder(sim, copy); break;
      case "GLIDER": copy.isGlider = true; drawGlider(sim, copy, out); break;
      case "LASERER": sim.simulateTransitionLem(copy, BA.LASERING); drawLaserer(sim, copy); break;
      case "CLONER": {
        // the clone goes the other way, doing what this one does
        copy.dx = -copy.dx;
        const doing = ACTION_TO_SKILL[copy.action];
        if (doing && SHADOW_SKILLS.has(doing) && doing !== "CLONER") draw(sim, copy, doing, out);
        break;
      }
      default: break;
    }
  }

  function compute(sim, L, skill) {
    const out = new ShadowSet(sim);
    if (!L || L.removed || !SHADOW_SKILLS.has(skill)) return { low: [], high: [], bricks: [] };
    withPhysicsSaved(sim, out, () => draw(sim, L, skill, out));
    return { low: out.low, high: out.high, bricks: out.bricks };
  }

  Lemmix.Shadows = { compute, SHADOW_SKILLS };
  if (typeof module !== "undefined" && module.exports) module.exports = Lemmix.Shadows;
})(typeof window !== "undefined" ? window : globalThis);
