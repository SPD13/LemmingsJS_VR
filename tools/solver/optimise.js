"use strict";
/**
 * A found solution made better by the objective (saved, then fewest
 * skills, then the earliest end), each try a full replay from frame 0:
 * every entry dropped in turn from the last to the first (kept out when
 * the result is no worse), the release rate at its fastest from the start,
 * and each assignment moved a few frames earlier.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Solver = Lemmix.Solver || (Lemmix.Solver = {});

  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

  /** The outcome of `plan` from the start: { saved, skillsUsed, completionFrame, plan, ok }. */
  function evaluate(world, plan) {
    world.reset(plan);
    const { outcome, events } = Solver.rollout(world);
    let lastExit = -1;
    for (const e of events) if (e.type === "EXIT" && e.frame > lastExit) lastExit = e.frame;
    return {
      plan: Solver.copyPlan(plan), saved: outcome.saved, skillsUsed: outcome.skillsUsed,
      completionFrame: outcome.endFrame === Infinity ? outcome.lastFrame : outcome.endFrame,
      ok: outcome.ended || outcome.outOfTime, stuck: outcome.stuck, lastExit,
    };
  }

  function optimise(world, best, analysis, deadline, log) {
    const better = (a, b) => Solver.compare(a, b) >= 0 && (a.ok || !b.ok || a.stuck === b.stuck);
    let cur = evaluate(world, best.plan);
    if (Solver.compare(cur, best) < 0) return best; // the plan does not replay as claimed: keep the claim for the verifier to judge
    cur.ok = cur.ok || best.ok;
    // a plan that wins with the rest pacing for ever never ends the level: a nuke once the count is made
    if ((cur.stuck || !cur.ok) && !cur.plan.some((e) => e.type === "nuke") && now() < deadline) {
      // once the last lemming is in (or, with none in, after the plan's last action)
      let lastAction = 0;
      for (const e of cur.plan) if (e.frame > lastAction) lastAction = e.frame;
      const at = (cur.lastExit >= 0 ? cur.lastExit : lastAction) + 1;
      const trial = Solver.copyPlan(cur.plan);
      trial.push({ type: "nuke", frame: at });
      const r = evaluate(world, trial);
      if (r.ok && r.saved >= cur.saved) { if (log) log("  optimise: the nuke at " + at + " ends the level"); cur = r; }
    }
    let changed = true, rounds = 0;
    while (changed && now() < deadline && rounds < 6) {
      changed = false; rounds++;
      // fewer entries
      for (let i = cur.plan.length - 1; i >= 0 && now() < deadline; i--) {
        const trial = cur.plan.slice(0, i).concat(cur.plan.slice(i + 1));
        const r = evaluate(world, trial);
        if (better(r, cur) && (r.ok || !cur.ok)) { if (log) log("  optimise: dropped " + Solver.planEntry(cur.plan[i])); cur = r; changed = true; }
      }
      // the fastest release from the start
      if (!world.level.spawnLocked && now() < deadline) {
        const si0 = cur.plan.find((e) => e.type === "spawn_interval" && e.frame === 0);
        if (!si0 || si0.interval > 4) {
          const trial = cur.plan.filter((e) => e !== si0);
          trial.unshift({ type: "spawn_interval", frame: 0, interval: 4, spawned: 0 });
          const r = evaluate(world, trial);
          if (better(r, cur) && r.completionFrame < cur.completionFrame) { if (log) log("  optimise: release rate 99 from the start"); cur = r; changed = true; }
        }
      }
      // each assignment a little earlier
      for (let i = 0; i < cur.plan.length && now() < deadline; i++) {
        const e = cur.plan[i];
        if (e.type !== "assignment") continue;
        for (const back of [1, 2, 4, 8]) {
          if (e.frame - back < 0) break;
          const trial = Solver.copyPlan(cur.plan);
          trial[i].frame = e.frame - back;
          const r = evaluate(world, trial);
          if (better(r, cur) && r.completionFrame < cur.completionFrame) { if (log) log("  optimise: " + Solver.planEntry(e) + " " + back + " frames earlier"); cur = r; changed = true; break; }
        }
      }
    }
    return cur;
  }

  Solver.optimise = optimise;
  Solver.evaluate = evaluate;
  if (typeof module !== "undefined" && module.exports) module.exports = { optimise, evaluate };
})(typeof window !== "undefined" ? window : globalThis);
