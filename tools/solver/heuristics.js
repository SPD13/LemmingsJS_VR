"use strict";
/**
 * What the search judges by: a state's fingerprint (so two roads to the
 * same place are searched once), the tests that write a branch off (out of
 * time, too few lemmings left to make the count, no skill left and the
 * count not made), the score that orders the frontier, and the three tiers'
 * parameters - how wide the search looks at each budget.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Solver = Lemmix.Solver || (Lemmix.Solver = {});
  const { SKILL_TO_ACTION } = Lemmix;

  /** FNV-1a over a Uint16Array, two 32-bit lanes so collisions are of no concern. */
  function hashArray(arr, h1, h2) {
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      h1 = Math.imul(h1 ^ v, 0x01000193);
      h2 = Math.imul(h2 ^ (v + i), 0x9e3779b1);
    }
    return [h1, h2];
  }

  /**
   * The fingerprint of the game as it stands: terrain, lemmings, skills,
   * release, gadgets and (unless `loose`) the frame. `loose` also buckets
   * positions by four pixels and drops the animation frames, for the
   * frontier's diversity test.
   */
  function hashState(game, loose) {
    let [h1, h2] = hashArray(game.physics, 0x811c9dc5 | 0, 0x12345678 | 0);
    const mix = (v) => { v = v | 0; h1 = Math.imul(h1 ^ v, 0x01000193); h2 = Math.imul((h2 ^ v) + 0x7f4a7c15, 0x9e3779b1); };
    for (const L of game.lemmings) {
      if (L.removed && !L.isZombie) { mix(-1); continue; }
      mix(loose ? L.x >> 2 : L.x); mix(loose ? L.y >> 2 : L.y); mix(L.dx); mix(L.action);
      if (!loose) mix(L.physicsFrame);
      mix((L.isClimber ? 1 : 0) | (L.isFloater ? 2 : 0) | (L.isGlider ? 4 : 0) | (L.isSwimmer ? 8 : 0) | (L.isSlider ? 16 : 0) | (L.isDisarmer ? 32 : 0) | (L.isZombie ? 64 : 0) | (L.isNeutral ? 128 : 0));
      mix(L.explosionTimer);
    }
    for (const k of Object.keys(game.currSkillCount)) mix(game.currSkillCount[k]);
    mix(game.currSpawnInterval); mix(game.lemmingsToRelease); mix(game.nextLemmingCountdown); mix(game.buttonsRemain);
    mix(game.lemmingsIn); mix(game.userSetNuking ? 1 : 0);
    for (const g of game.gadgets) { mix(g.triggered ? 1 : 0); mix(g.remainingLemmings); mix(g.effect === "NONE" ? 1 : 0); }
    if (!loose) mix(game.currentIteration);
    // the record's future is part of the state: two games alike now with different plans ahead differ
    for (const r of game.recorded) {
      if (r.frame < game.currentIteration) continue;
      mix(r.frame); mix(r.type === "assignment" ? 1 : r.type === "nuke" ? 2 : 3);
      if (r.type === "assignment") { mix(r.lemIndex); for (let i = 0; i < r.skill.length; i++) mix(r.skill.charCodeAt(i)); }
      else if (r.type === "spawn_interval") mix(r.interval);
    }
    return (h1 >>> 0).toString(16) + ":" + (h2 >>> 0).toString(16);
  }

  /** How many skills remain in all. */
  function skillsLeft(game) {
    let n = 0;
    for (const name of game.activeSkills) n += game.currSkillCount[SKILL_TO_ACTION[name]] || 0;
    return n;
  }

  /** The most this branch could still save, from the state at the end of its rollout. */
  function upperBound(game, analysis) {
    let alive = 0;
    for (const L of game.lemmings) if (!L.removed && !L.isZombie) alive++;
    const cloners = game.currSkillCount[SKILL_TO_ACTION.CLONER] || 0;
    return Math.min(analysis.maxSavable, game.lemmingsIn + alive + game.lemmingsToRelease + cloners);
  }

  /**
   * Is the branch beyond saving `target`? `boundAtNode` is what the node's
   * state could still save (before its rollout, which acts on nothing),
   * `outcome` the rollout's; with no skill left the rollout is the branch's
   * whole future.
   */
  function deadReason(boundAtNode, outOfTimeAtNode, outcome, target, skillsAtNode, nuked) {
    if (outcome.saved >= target) return null;
    if (outOfTimeAtNode) return "time";
    if (boundAtNode < target) return "count";
    if (skillsAtNode === 0 && nuked && !outcome.capped) return "skills"; // nothing left to do, the nuke included
    return null;
  }

  /** The frontier's order: higher is more promising. */
  function score(node, analysis, target, leadOnly) {
    const o = node.outcome;
    const bound = Math.min(o.bound, target);
    // the lead pass looks for one lemming's way in, whatever it costs: a skill is cheap there and
    // progress dear, and what the crowd loses meanwhile is the crowd pass's concern (which
    // pays the objective's price per skill and per lemming lost)
    // in the crowd pass a save counts in full only once the count is made: a branch that gives two
    // saves up to move the whole crowd (a blocker turning a lemming back to open the way) must not
    // be buried under every sibling that keeps them; the crowd's mean distance to an exit is its progress
    const savedWeight = leadOnly || o.solved ? 1000 : 50;
    // a skill costs the search little on either pass - the optimiser trims the solution afterwards;
    // priced at the objective's rate a four-skill node sat below every one-skill sibling, and its
    // edges (the far-side blocker after the second athlete) never came up
    let s = savedWeight * Math.min(o.saved, target) + 300 * bound - (leadOnly ? 20 : 40) * node.skillsUsed - (leadOnly ? 0 : 40 * o.lost);
    s -= (leadOnly ? 1.0 : 0.5) * (o.leadDist || 0); // progress: how near anyone came to an exit
    if (!leadOnly) s -= 2 * (o.crowdDist || 0);      // and how near the crowd stands
    // the plan through the regions and gates: what it still costs to get in - an opened tunnel, a
    // freed blocker, a lemming turned the right way all show here at once; no plan at all is dear
    if (o.planCost !== undefined) s -= 80 * (o.planCost === null ? 25 : Math.min(o.planCost, 25));
    s -= (o.endFrame === Infinity ? o.lastFrame : o.endFrame) / 500;
    if (o.stuck) s -= 20;
    if (o.solved) s += 5000;
    return s;
  }

  const TIERS = {
    1: { budgetMs: 10000, lemmings: 2, offsets: [0, 4], skillsPerEvent: 3, beam: 64, states: 32, depth: 12, rr: 2, restarts: 0, leadShare: 0.3, repeats: 8, tickEvery: 32 },
    2: { budgetMs: 120000, lemmings: 4, offsets: [0, 2, 4, 8], skillsPerEvent: 6, beam: 512, states: 128, depth: 24, rr: 3, restarts: 0, leadShare: 0.15, repeats: 16, tickEvery: 16 },
    3: { budgetMs: 900000, lemmings: 8, offsets: [0, 1, 2, 4, 8, 12, 16], skillsPerEvent: 99, beam: 4096, states: 512, depth: 48, rr: 3, restarts: 3, leadShare: 0.15, repeats: 24, tickEvery: 8 },
  };

  /** A tier's parameters, the state cache scaled down for a big level. */
  function tierParams(tier, level, overrides) {
    const p = Object.assign({}, TIERS[tier] || TIERS[1], overrides || {});
    const area = level.width * level.height;
    if (area > 320 * 160) p.states = Math.max(8, Math.floor(p.states * (320 * 160) / area));
    return p;
  }

  Solver.hashState = hashState;
  Solver.skillsLeft = skillsLeft;
  Solver.upperBound = upperBound;
  Solver.deadReason = deadReason;
  Solver.score = score;
  Solver.TIERS = TIERS;
  Solver.tierParams = tierParams;
  if (typeof module !== "undefined" && module.exports) module.exports = { hashState, skillsLeft, upperBound, deadReason, score, TIERS, tierParams };
})(typeof window !== "undefined" ? window : globalThis);
