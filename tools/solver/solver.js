"use strict";
/**
 * The search: best-first over the edges (node, candidate) of a tree whose
 * nodes are the game at a frame with a plan behind it, and whose edges are
 * the actions a node's rollout suggested. An edge is only followed when it
 * is popped: the world is put back at the node, stepped to the action's
 * frame, the action recorded and applied, the child saved and rolled out
 * to see what happens next with no more help. Its rollout's events become
 * its own edges. Dead branches (out of time, too few lemmings, no skill
 * left) are dropped, states already seen with no more skills spent are
 * dropped, the frontier is capped, and the saved states of the least
 * promising nodes are let go (their plans stay, so they can be rebuilt
 * from an ancestor).
 *
 * Two passes: the lead pass looks for one lemming's way to the exit (only
 * the first lemming out is given skills, any save is a success), and the
 * crowd pass, seeded with the root and the lead's solutions, for the
 * count. The result is the best solution by (saved, fewest skills,
 * earliest end), or null.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Solver = Lemmix.Solver || (Lemmix.Solver = {});

  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

  class Heap {
    constructor(key) { this.a = []; this.key = key; }
    get size() { return this.a.length; }
    push(v) { const a = this.a; a.push(v); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.key(a[p]) >= this.key(a[i])) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() {
      const a = this.a; if (!a.length) return undefined;
      const top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.key(a[l]) > this.key(a[m])) m = l; if (r < a.length && this.key(a[r]) > this.key(a[m])) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
      return top;
    }
    /** Keep the best `n`. */
    trim(n) { if (this.a.length <= n) return; this.a.sort((x, y) => this.key(y) - this.key(x)); this.a.length = n; }
  }

  /** (saved, fewest skills, earliest end): positive when a is better than b. */
  function compare(a, b) {
    if (!a) return b ? -1 : 0;
    if (!b) return 1;
    if (a.saved !== b.saved) return a.saved - b.saved;
    if (a.skillsUsed !== b.skillsUsed) return b.skillsUsed - a.skillsUsed;
    return b.completionFrame - a.completionFrame;
  }

  class Search {
    constructor(world, analysis, params, opts) {
      this.world = world; this.analysis = analysis; this.params = params;
      this.log = opts.log || null; this.trace = !!opts.trace;
      this.nodes = 0; this.expansions = 0; this.dropped = { dead: 0, seen: 0, refused: 0, ended: 0 };
      this.transposition = new Map();
      this.cache = [];   // nodes holding a state, oldest first
      this.solutions = [];
      this.best = null;
    }

    _hold(node) {
      this.cache.push(node);
      if (this.cache.length > this.params.states) {
        // let go of the least promising held state (never a solution's)
        let worst = -1, worstScore = Infinity;
        for (let i = 0; i < this.cache.length; i++) {
          const n = this.cache[i];
          if (n.isRoot || n.solved) continue;
          if (n.score < worstScore) { worstScore = n.score; worst = i; }
        }
        if (worst >= 0) { this.cache[worst].state = null; this.cache.splice(worst, 1); }
      }
    }

    /** The world at `node`. False when the level ends before the node's frame (a stale plan). */
    _goto(node) {
      let anc = node;
      while (anc && !anc.state) anc = anc.parent;
      if (!anc) { this.world.reset(node.plan); }
      else this.world.restore(anc.state, node.plan);
      if (this.world.frame < node.frame) this.world.step(node.frame - this.world.frame);
      return this.world.frame === node.frame;
    }

    /** A node out of the world as it stands (after `plan` was applied to this frame): its rollout, score and edges. */
    _makeNode(parent, plan, target, lemFilter, isRoot) {
      const world = this.world, game = world.game;
      const node = {
        id: this.nodes++, parent, frame: world.frame, plan, state: world.save(), depth: parent ? parent.depth + 1 : 0,
        skillsUsed: world.skillsUsed(), isRoot: !!isRoot, solved: false, // skillsUsed: at the node now, the whole plan's after the rollout
      };
      const skillCounts = world.skillCounts();
      let skillsLeft = 0; for (const k of Object.keys(skillCounts)) skillsLeft += skillCounts[k];
      const hash = Solver.hashState(game, false);
      const seenWith = this.transposition.get(hash);
      if (seenWith !== undefined && seenWith <= node.skillsUsed && !isRoot) { this.dropped.seen++; return null; }
      this.transposition.set(hash, node.skillsUsed);
      node.skillsAtNode = node.skillsUsed;
      const boundAtNode = Solver.upperBound(game, this.analysis), outOfTimeAtNode = game.isOutOfTime;
      const { events, outcome } = Solver.rollout(world, { field: this.analysis.field });
      outcome.bound = boundAtNode;
      node.skillsUsed = outcome.skillsUsed; // the plan's own, pending entries fired
      outcome.leadDist = outcome.saved > 0 ? 0 : (outcome.minDist === Infinity ? this.analysis.spanDist : outcome.minDist);
      outcome.solved = outcome.saved >= target && (outcome.ended || outcome.outOfTime || outcome.stuck);
      node.outcome = outcome;
      node.events = events;
      node.score = Solver.score(node, this.analysis, target);
      const dead = outcome.solved ? null : Solver.deadReason(boundAtNode, outOfTimeAtNode, outcome, target, skillsLeft);
      node.dead = dead;
      if (dead) { this.dropped.dead++; node.state = null; return node; }
      node.candidates = node.depth >= this.params.depth ? [] : Solver.candidates(events, outcome, {
        game, skillCounts, activeSkills: game.activeSkills, params: this.params, analysis: this.analysis,
        lemFilter, nodeFrame: node.frame, isRoot: !!isRoot, level: world.level,
      });
      this._hold(node);
      if (outcome.solved) {
        node.solved = true;
        const sol = { plan: Solver.copyPlan(plan), saved: outcome.saved, skillsUsed: node.skillsUsed, completionFrame: outcome.endFrame === Infinity ? outcome.lastFrame : outcome.endFrame, node, stuck: outcome.stuck };
        this.solutions.push(sol);
        if (compare(sol, this.best) > 0) {
          this.best = sol;
          if (this.log) this.log("  best: saved " + sol.saved + ", " + sol.skillsUsed + " skills, frame " + sol.completionFrame + " (" + plan.map(planEntry).join(" ") + ")");
        }
      }
      return node;
    }

    /** The child of `node` by `cand`, or null when the action could not be taken. */
    _expand(node, cand, target, lemFilter) {
      const world = this.world;
      if (!this._goto(node)) { this.dropped.ended++; return null; }
      if (cand.frame > world.frame) world.step(cand.frame - world.frame);
      if (world.frame !== cand.frame) { this.dropped.ended++; return null; }
      let ok = false;
      if (cand.kind === "assign") { const L = world.lemmingById(cand.lemId); ok = !!L && world.assign(L, cand.skill); }
      else if (cand.kind === "si") ok = world.setSpawnInterval(cand.si);
      else if (cand.kind === "nuke") ok = world.nuke();
      if (!ok) { this.dropped.refused++; if (this.trace && this.log) this.log("  refused f=" + cand.frame + " " + describe(cand)); return null; }
      world.step(1);
      const plan = world.plan();
      this.expansions++;
      const child = this._makeNode(node, plan, target, lemFilter, false);
      if (!child && this.trace && this.log) this.log("  seen f=" + cand.frame + " " + describe(cand));
      if (this.trace && this.log && child) {
        const o = child.outcome;
        this.log("  #" + this.expansions + " f=" + cand.frame + " " + describe(cand) + " -> saved " + o.saved + "/" + target + " lost " + o.lost + " skills " + child.skillsUsed
          + (o.stuck ? " stuck" : "") + (o.outOfTime ? " time" : "") + (child.dead ? " DEAD:" + child.dead : "") + (o.solved ? " SOLVED" : "") + " score " + child.score.toFixed(0));
      }
      return child;
    }

    /**
     * Search from `seeds` (plans) for `target` saved, giving skills only to
     * `lemFilter`'s lemmings when given, until `deadline` (ms, absolute) or
     * an optimal result. Returns the best solution found in this pass.
     */
    run(seeds, target, lemFilter, deadline) {
      // the frontier: one heap per depth, popped in rotation, so a shallow edge (a
      // follower's own climber at the seed) is never starved by a deep run of nodes
      // that look better - the score is the parent's, and a parent that saved two
      // lemmings outranks the seed whatever its followers' prospects
      const open = new Map();
      let total = 0;
      const pushEdges = (node) => {
        let heap = open.get(node.depth);
        if (!heap) { heap = new Heap((e) => e.f); open.set(node.depth, heap); }
        for (const c of node.candidates || []) { heap.push({ node, cand: c, f: node.score + 100 * c.prior }); total++; }
        const cap = Math.max(4000, this.params.beam * 8);
        if (heap.size > cap * 2) { total -= heap.size; heap.trim(cap); total += heap.size; }
      };
      for (const seed of seeds) {
        this.world.reset(seed.plan);
        if (seed.frame > 0) this.world.step(seed.frame);
        const node = this._makeNode(null, Solver.copyPlan(seed.plan), target, lemFilter, seed.frame === 0 && !seed.plan.length);
        if (node) { node.isRoot = true; pushEdges(node); }
        if (this.best && this.best.saved >= this.analysis.maxSavable && this.best.skillsUsed === 0) return this.best;
      }
      let turn = 0;
      while (total > 0 && now() < deadline) {
        const depths = Array.from(open.keys()).filter((d) => open.get(d).size > 0).sort((a, b) => a - b);
        if (!depths.length) break;
        const heap = open.get(depths[turn % depths.length]);
        turn++;
        const edge = heap.pop();
        total--;
        if (this.best && edge.node.skillsUsed + 1 > this.best.skillsUsed && this.best.saved >= this.analysis.maxSavable) continue;
        const child = this._expand(edge.node, edge.cand, target, lemFilter);
        if (!child || child.dead) continue;
        if (child.solved && child.outcome.saved >= this.analysis.maxSavable && child.skillsUsed === 0) break;
        pushEdges(child);
      }
      return this.best;
    }
  }

  const planEntry = (e) => e.type === "assignment" ? e.skill + "@" + e.frame + ">" + e.lemId : e.type === "nuke" ? "NUKE@" + e.frame : "SI" + e.interval + "@" + e.frame;
  const describe = (c) => c.kind === "assign" ? c.skill + ">" + c.lemId + " (" + c.why + ")" : c.kind === "si" ? "SI=" + c.si : "NUKE";

  /**
   * Solve the level `world` holds: { best, stats }. `opts` = { tier,
   * budgetMs, params (overrides), log, trace }.
   */
  function solve(world, opts) {
    opts = opts || {};
    const t0 = now();
    const level = world.level;
    const analysis = Solver.analyse(level);
    const params = Solver.tierParams(opts.tier || 1, level, opts.params);
    const budget = opts.budgetMs || params.budgetMs;
    const optimiseShare = 0.1;
    const searchEnd = t0 + budget * (1 - optimiseShare);
    const log = opts.log || null;
    const search = new Search(world, analysis, params, opts);
    const need = level.needCount;
    if (log) log("level " + level.width + "x" + level.height + ", " + level.releaseCount + " lemmings, save " + need + " (at most " + analysis.maxSavable + "), skills " + JSON.stringify(world.skillCounts()) + ", features " + analysis.features.join(","));
    // the lead pass: the first lemming out to the exit
    world.reset([]);
    const firstOut = world.level.preplaced.length ? "P" + world.level.preplaced[0].x + "." + world.level.preplaced[0].y : "N0";
    const leadEnd = t0 + budget * (1 - optimiseShare) * params.leadShare;
    let lead = null;
    if (need > 0) {
      lead = search.run([{ plan: [], frame: 0 }], 1, new Set([firstOut]), leadEnd);
      if (log) log("lead pass: " + (lead ? "a way in with " + lead.skillsUsed + " skills at frame " + lead.completionFrame : "none") + ", " + search.expansions + " expansions");
    }
    // the crowd pass: the count, from the root and every lead solution. When the
    // frontier runs dry with time to spare, the pass runs again wider - the next
    // tier's lemmings, offsets and skills per event - up to the widest tier.
    const seeds = [{ plan: [], frame: 0 }];
    for (const s of search.solutions.slice().sort((a, b) => compare(b, a)).slice(0, 4)) seeds.push({ plan: s.plan, frame: 0 });
    search.solutions = []; search.best = null;
    let best = null;
    for (let widen = 0; widen < 3 && now() < searchEnd; widen++) {
      const tier = Math.min(3, (opts.tier || 1) + widen);
      search.params = Solver.tierParams(tier, level, Object.assign({}, opts.params || {}, { budgetMs: budget }));
      search.transposition.clear();
      const before = search.expansions;
      best = search.run(seeds, need, null, searchEnd);
      if (log) log("crowd pass" + (widen ? " (widened to tier " + tier + "'s breadth)" : "") + ": " + (best ? "saved " + best.saved + " with " + best.skillsUsed + " skills at frame " + best.completionFrame : "nothing") + ", " + (search.expansions - before) + " expansions, dropped " + JSON.stringify(search.dropped));
      if (best && (best.saved >= analysis.maxSavable || tier >= 3)) break;
      if (tier >= 3) break;
      if (best) { seeds.push({ plan: best.plan, frame: 0 }); }
    }
    // the optimiser, in the slice reserved for it (and whatever the search left)
    if (best) best = Solver.optimise(world, best, analysis, t0 + budget, log);
    const stats = { expansions: search.expansions, nodes: search.nodes, frames: world.frames, elapsedMs: now() - t0, dropped: search.dropped, features: analysis.features, maxSavable: analysis.maxSavable, lead: lead ? lead.skillsUsed : null };
    return { best, stats, analysis };
  }

  Solver.solve = solve;
  Solver.Search = Search;
  Solver.compare = compare;
  Solver.planEntry = planEntry;
  if (typeof module !== "undefined" && module.exports) module.exports = { solve, Search, compare, planEntry };
})(typeof window !== "undefined" ? window : globalThis);
