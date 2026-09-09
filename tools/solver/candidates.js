"use strict";
/**
 * From a rollout's events to the actions worth trying from that node: a
 * lemming, a skill and the frame to give it on, each with a prior that
 * orders the frontier. Nothing is tried at an arbitrary frame; every
 * candidate is anchored to a moment the rollout showed - the step off an
 * edge (and the frames the lemming stood k pixels short of it), a wall, a
 * landing, a shrug, a death and the fall or turn that led to it.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Solver = Lemmix.Solver || (Lemmix.Solver = {});
  const { BA, SKILL_TO_ACTION } = Lemmix;

  const PERM = ["CLIMBER", "FLOATER", "GLIDER", "SWIMMER", "DISARMER", "SLIDER"];
  // the perms bits an event carries (events.js) that make a permanent skill pointless
  const PERM_BITS = { CLIMBER: 1, FLOATER: 2 | 4, GLIDER: 2 | 4, SWIMMER: 8, DISARMER: 16, SLIDER: 32 };
  const TERRAIN = new Set(["BUILDER", "PLATFORMER", "STACKER", "DIGGER", "BASHER", "MINER", "FENCER", "LASERER", "BOMBER", "STONER"]);
  // the jobs worth keeping at: the skill given again each time it stops (a mesh a basher cuts a link
  // of at a time, a staircase of builders), as one step of the search
  const REPEATABLE = new Set(["BASHER", "MINER", "DIGGER", "BUILDER", "PLATFORMER", "FENCER", "STACKER", "LASERER"]);

  // the templates: event type -> [skill, where, weight]; where = "k" (the frames k pixels
  // before the anchor), "at" (the event's frame), "early" (the lemming's first frame)
  const TEMPLATES = {
    FALL: [["BUILDER", "k", 1.0], ["PLATFORMER", "k", 0.9], ["FLOATER", "at", 0.9], ["GLIDER", "at", 0.8], ["BLOCKER", "k", 0.7],
      ["STACKER", "k", 0.6], ["JUMPER", "k", 0.6], ["DIGGER", "k", 0.5], ["SLIDER", "at", 0.4], ["MINER", "k", 0.4], ["BOMBER", "k", 0.2]],
    TURN: [["BASHER", "k", 1.0], ["MINER", "k", 0.9], ["CLIMBER", "k", 0.9], ["BUILDER", "k", 0.8], ["JUMPER", "k", 0.7], ["FENCER", "k", 0.7],
      ["LASERER", "k", 0.6], ["SHIMMIER", "k0", 0.5], ["STACKER", "k", 0.5], ["DIGGER", "k", 0.5], ["BLOCKER", "k", 0.6], ["BOMBER", "k", 0.3], ["PLATFORMER", "k", 0.3]],
    LAND: [["DIGGER", "at", 0.8], ["MINER", "at", 0.6], ["BUILDER", "at", 0.5], ["BASHER", "at", 0.5], ["BLOCKER", "at", 0.5], ["CLIMBER", "at", 0.5],
      ["FLOATER", "at", 0.4], ["GLIDER", "at", 0.3], ["SWIMMER", "at", 0.3], ["DISARMER", "at", 0.3], ["SLIDER", "at", 0.2], ["CLONER", "at", 0.3], ["BOMBER", "at", 0.2], ["STACKER", "at", 0.2], ["PLATFORMER", "at", 0.2]],
    SHRUG: [["BUILDER", "at", 1.0], ["WALKER", "at", 0.6], ["BASHER", "at", 0.7], ["PLATFORMER", "at", 0.7], ["STACKER", "at", 0.5], ["MINER", "at", 0.5], ["DIGGER", "at", 0.5], ["BLOCKER", "at", 0.4], ["JUMPER", "at", 0.4], ["CLIMBER", "at", 0.3]],
    WORK_END: [["BUILDER", "at", 0.8], ["BASHER", "at", 0.8], ["MINER", "at", 0.7], ["DIGGER", "at", 0.7], ["BLOCKER", "at", 0.5], ["PLATFORMER", "at", 0.5], ["STACKER", "at", 0.4], ["CLIMBER", "at", 0.4], ["JUMPER", "at", 0.3]],
    CLIMB: [["SHIMMIER", "at", 0.9], ["JUMPER", "at", 0.4], ["BOMBER", "at", 0.3]],
    // a walk's samples: after the anchored moments (a wall, an edge, a death), so they come later in the frontier
    TICK: [["DIGGER", "ring", 0.35], ["BASHER", "ring", 0.35], ["MINER", "ring", 0.3], ["BUILDER", "ring", 0.3], ["BOMBER", "ring", 0.25], ["BLOCKER", "ring", 0.3], ["CLIMBER", "at", 0.2]],
  };
  const DEATH_TEMPLATES = {
    water: [["SWIMMER", "at", 1.0], ["BUILDER", "anchor", 0.9], ["PLATFORMER", "anchor", 0.8], ["BLOCKER", "anchor", 0.7], ["STACKER", "anchor", 0.4], ["JUMPER", "anchor0", 0.4]],
    trap: [["DISARMER", "early", 1.0], ["BLOCKER", "anchor", 0.7], ["CLIMBER", "anchor", 0.4], ["BOMBER", "back", 0.5], ["STONER", "back", 0.5], ["BUILDER", "anchor", 0.5], ["DIGGER", "back", 0.4], ["BASHER", "back", 0.3]],
    splat: [["FLOATER", "anchorat", 1.0], ["GLIDER", "anchorat", 0.8], ["BUILDER", "anchor", 0.8], ["PLATFORMER", "anchor", 0.7], ["BLOCKER", "anchor", 0.7], ["DIGGER", "anchor", 0.4], ["STACKER", "anchor", 0.4], ["SLIDER", "anchorat", 0.3], ["MINER", "anchor", 0.3]],
    fire: [["BLOCKER", "anchor", 0.8], ["BUILDER", "anchor", 0.8], ["CLIMBER", "anchor", 0.6], ["BASHER", "anchor", 0.5], ["MINER", "anchor", 0.5], ["DIGGER", "anchor", 0.5], ["JUMPER", "anchor0", 0.4], ["BOMBER", "back", 0.3]],
    offscreen: [["BLOCKER", "anchor", 0.9], ["BUILDER", "anchor", 0.8], ["CLIMBER", "anchor", 0.7], ["JUMPER", "anchor", 0.4], ["BASHER", "anchor", 0.5], ["MINER", "anchor", 0.5], ["DIGGER", "anchor", 0.5], ["PLATFORMER", "anchor", 0.5], ["STACKER", "anchor", 0.3], ["BOMBER", "back", 0.3]],
  };

  /** The frame in `ring` ([frame, x, y]) at which the lemming stood `k` pixels short of `edgeX` coming from direction `dx`. */
  function frameShortOf(ring, edgeX, dx, k) {
    const want = edgeX - k * dx;
    for (let i = ring.length - 1; i >= 0; i--) if (ring[i][1] === want) return ring[i][0];
    return -1;
  }

  /**
   * The candidates of a node: `events` its rollout's, `outcome` too,
   * `ctx` = { game (at the rollout's end), skillCounts (at the node),
   * activeSkills, params, analysis, lemFilter (ids allowed, or null),
   * nodeFrame, isRoot, level }.
   */
  function candidates(events, outcome, ctx) {
    const { params, analysis, skillCounts, nodeFrame } = ctx;
    const out = [];
    const seen = new Set();
    const has = (skill) => (skillCounts[skill] || 0) > 0;
    const push = (c) => {
      if (c.frame < nodeFrame || c.frame < 0) return;
      const key = c.kind + (c.gap ? "~" : "") + "|" + (c.lemId || "") + "|" + (c.skill || c.si || "") + "|" + c.frame;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    };
    // which lemmings: by their first event's order (the lead first), the tail last
    const byLem = new Map();
    for (const e of events) {
      if (!e.lemId) continue;
      if (ctx.lemFilter && !ctx.lemFilter.has(e.lemId)) continue;
      if (!byLem.has(e.lemId)) byLem.set(e.lemId, { id: e.lemId, first: e.frame, events: [], last: e });
      const rec = byLem.get(e.lemId);
      rec.events.push(e); rec.last = e;
    }
    const lems = Array.from(byLem.values());
    // rank: the lead (the first out) and the tail (the last out), then the nearest to an exit
    const ranked = [];
    if (lems.length) ranked.push(lems[0]);
    if (lems.length > 1) ranked.push(lems[lems.length - 1]);
    const rest = lems.slice(1, -1).map((r) => ({ r, d: analysis.field.at(r.last.x, r.last.y) })).sort((a, b) => a.d - b.d);
    for (const { r } of rest) { if (ranked.length >= params.lemmings) break; ranked.push(r); }
    // every other lemming that dies gets its own rescue (a permanent skill, timing-insensitive), the earliest deaths first
    const rescued = lems.filter((r) => ranked.indexOf(r) < 0 && r.events.some((e) => e.type === "DEATH"))
      .sort((a, b) => a.events.find((e) => e.type === "DEATH").frame - b.events.find((e) => e.type === "DEATH").frame)
      .slice(0, params.lemmings * 2);
    for (const rec of rescued) {
      for (const e of rec.events) {
        if (e.type !== "DEATH") continue;
        for (const [skill, where, weight] of DEATH_TEMPLATES[e.cause] || []) {
          if (!has(skill) || TERRAIN.has(skill) || skill === "BLOCKER") continue;
          if (PERM_BITS[skill] && (e.perms & PERM_BITS[skill])) continue;
          const frame = where === "early" ? rec.first : where === "anchorat" && e.anchor ? e.anchor.frame : e.frame;
          push({ kind: "assign", lemId: rec.id, skill, frame, why: "rescue:" + e.cause, prior: weight * 0.6 });
        }
      }
    }
    // the ranked lemmings get every template of every event; every other lemming only what
    // answers its own death (at its own anchor - a follower dies at the end of the partial
    // bridge, not at the original edge) and an early permanent skill, at a lower prior, the
    // earliest death first. The same terrain skill at the same place is not tried per lemming.
    const pathSeen = new Set();
    let deathOrder = 0;
    for (const rec of lems) {
      const full = ranked.indexOf(rec) >= 0;
      const isLead = rec === lems[0], isTail = rec === lems[lems.length - 1] && lems.length > 1;
      const lemWeight = isLead ? 1.0 : isTail ? 0.8 : full ? 0.7 : 0.5;
      const firstFrame = rec.first;
      for (const e of rec.events) {
        const early = e.type === "SPAWN" || e.type === "PRESENT";
        let templates = e.type === "DEATH" ? DEATH_TEMPLATES[e.cause] : TEMPLATES[e.type];
        // an unranked lemming: its deaths, its early permanent skills, and permanent skills at its other events
        if (!full && e.type !== "DEATH" && !early) templates = (templates || []).filter(([skill]) => PERM_BITS[skill]);
        if (early) {
          // an early permanent skill, timing-insensitive
          templates = PERM.map((s) => [s, "at", s === "CLIMBER" || s === "FLOATER" ? 0.35 : 0.25]).concat([["CLONER", "at", 0.15]]);
        }
        if (!templates) continue;
        const pathKey = e.type + ":" + (e.cause || "") + ":" + (e.x >> 2) + ":" + (e.y >> 2) + ":" + e.dx;
        const repeat = pathSeen.has(pathKey);
        pathSeen.add(pathKey);
        const orderWeight = e.type === "DEATH" ? 1 / (1 + 0.15 * deathOrder++) : 1;
        let n = 0;
        for (const [skill, where, weight] of templates) {
          if (!has(skill)) continue;
          if (PERM_BITS[skill] && (e.perms & PERM_BITS[skill])) continue;
          if (repeat && TERRAIN.has(skill) && e.type !== "DEATH") continue;
          if (n >= params.skillsPerEvent && !repeat) break;
          const fatal = e.type === "DEATH" ? 1.3 : (e.type === "FALL" && e.fatal) ? 1.2 : 1;
          const prior = weight * lemWeight * fatal * orderWeight * (skillCounts[skill] > 1 ? 1 : 0.85);
          const frames = [];
          const anchor = e.anchor;
          switch (where) {
            case "at": frames.push([e.frame, 1]); break;
            case "early": frames.push([firstFrame, 1]); break;
            case "k0": frames.push([frameShortOf(e.ring || [], e.edgeX !== undefined ? e.edgeX : e.wallX, e.type === "TURN" ? -e.dx : e.dx, 0), 1]); break;
            case "k": {
              const dir = e.type === "TURN" ? -e.dx : e.dx, edge = e.edgeX !== undefined ? e.edgeX : e.wallX;
              for (const k of params.offsets) frames.push([frameShortOf(e.ring || [], edge, dir, k), 1 / (1 + k / 8)]);
              break;
            }
            case "ring": {
              const ring = e.ring || [];
              for (let i = ring.length - 1; i >= 0; i -= 8) frames.push([ring[i][0], 0.8]);
              break;
            }
            case "anchor": case "anchor0": case "anchorat": {
              if (!anchor) { frames.push([Math.max(nodeFrame, e.frame - 24), 0.6]); break; }
              if (where === "anchorat") { frames.push([anchor.frame, 1]); break; }
              const dir = anchor.type === "TURN" ? -anchor.dx : anchor.dx, edge = anchor.edgeX !== undefined ? anchor.edgeX : anchor.wallX;
              const ks = where === "anchor0" ? [0] : params.offsets;
              for (const k of ks) frames.push([frameShortOf(anchor.ring || [], edge, dir, k), 1 / (1 + k / 8)]);
              break;
            }
            case "back": for (const k of [8, 24]) frames.push([Math.max(nodeFrame, e.frame - k), 0.8]); break;
          }
          let any = false;
          for (const [frame, w] of frames) {
            if (frame < 0) continue;
            const why = e.type + (e.cause ? ":" + e.cause : "");
            push({ kind: "assign", lemId: rec.id, skill, frame, why, prior: prior * w });
            if (REPEATABLE.has(skill) && skillCounts[skill] > 1) {
              push({ kind: "repeat", lemId: rec.id, skill, frame, why: why + " x", prior: prior * w * 0.8 });
              // and again with a dozen pixels' walk between: holes staggered, a staircase with landings
              if (skill === "DIGGER" || skill === "MINER" || skill === "BUILDER") push({ kind: "repeat", gap: 12, lemId: rec.id, skill, frame, why: why + " x~", prior: prior * w * 0.7 });
            }
            any = true;
          }
          if (any) n++;
        }
      }
    }
    // the release rate: at the root the extremes, after the first exit the fastest
    const level = ctx.level;
    if (!level.spawnLocked) {
      if (ctx.isRoot && params.rr > 0) {
        const sis = [4];
        if (params.rr > 2) sis.push(Math.round((level.spawnInterval + 4) / 2));
        for (const si of sis) if (si < level.spawnInterval) push({ kind: "si", si, frame: nodeFrame, why: "root", prior: 0.5 });
      }
      const firstExit = events.find((e) => e.type === "EXIT");
      if (firstExit && ctx.game.currSpawnInterval > 4) push({ kind: "si", si: 4, frame: firstExit.frame, why: "EXIT", prior: 0.45 });
    }
    // the nuke: the count made and the rest going nowhere - or, with no skill that
    // could change anything (none at all, or a crowd going nowhere), the explosions
    // themselves as the plan (Just Nuke Them!), at the root and where the crowd stalls
    if (outcome.saved >= analysis.needCount && analysis.needCount > 0) {
      const exits = events.filter((e) => e.type === "EXIT");
      const lastExit = exits.length ? exits[exits.length - 1].frame : nodeFrame;
      if (outcome.stuck || !outcome.ended || outcome.endFrame - lastExit > 340) push({ kind: "nuke", frame: lastExit + 1, why: "done", prior: 0.4 });
    } else if (!ctx.game.userSetNuking) {
      let skillsLeft = 0;
      for (const k of Object.keys(skillCounts)) skillsLeft += skillCounts[k];
      if (skillsLeft === 0 || outcome.stuck) {
        const firstTurn = events.find((e) => e.type === "TURN" || e.type === "FALL");
        push({ kind: "nuke", frame: nodeFrame, why: "root", prior: skillsLeft === 0 ? 0.8 : 0.2 });
        if (firstTurn) push({ kind: "nuke", frame: firstTurn.frame, why: "crowd", prior: skillsLeft === 0 ? 0.7 : 0.2 });
        if (outcome.stuck) push({ kind: "nuke", frame: Math.max(nodeFrame, outcome.lastFrame - 2 * 85), why: "stuck", prior: skillsLeft === 0 ? 0.6 : 0.25 });
        // with no skill at all the nuke's moment is the whole question: every ten seconds of the rollout
        if (skillsLeft === 0) for (let f = nodeFrame + 170; f < outcome.lastFrame; f += 170) push({ kind: "nuke", frame: f, why: "sweep", prior: 0.5 });
      }
    }
    return out;
  }

  Solver.candidates = candidates;
  Solver.TEMPLATES = TEMPLATES;
  if (typeof module !== "undefined" && module.exports) module.exports = { candidates, TEMPLATES, DEATH_TEMPLATES };
})(typeof window !== "undefined" ? window : globalThis);
