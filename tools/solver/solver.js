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
      this.onProgress = opts.onProgress || null; // (info) => the page's progress bar: phase, expansions, best so far
      this.phase = "";
      this._lastReport = 0;
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
    _makeNode(parent, plan, target, lemFilter, isRoot, skipSeen) {
      const world = this.world, game = world.game;
      const node = {
        id: this.nodes++, parent, frame: world.frame, plan, state: world.save(), depth: parent ? parent.depth + 1 : 0,
        skillsUsed: world.skillsUsed(), isRoot: !!isRoot, solved: false, // skillsUsed: at the node now, the whole plan's after the rollout
      };
      const skillCounts = world.skillCounts();
      let skillsLeft = 0; for (const k of Object.keys(skillCounts)) skillsLeft += skillCounts[k];
      const hash = Solver.hashState(game, false);
      const seenWith = this.transposition.get(hash);
      if (seenWith !== undefined && seenWith <= node.skillsUsed && !isRoot && !skipSeen) { this.dropped.seen++; return null; }
      this.transposition.set(hash, node.skillsUsed);
      node.skillsAtNode = node.skillsUsed;
      const boundAtNode = Solver.upperBound(game, this.analysis), outOfTimeAtNode = game.isOutOfTime, nukedAtNode = game.userSetNuking;
      const { events, outcome } = Solver.rollout(world, { field: this.analysis.field, leadId: lemFilter && lemFilter.size === 1 ? Array.from(lemFilter)[0] : null });
      outcome.bound = boundAtNode;
      node.skillsUsed = outcome.skillsUsed; // the plan's own, pending entries fired
      outcome.leadDist = outcome.saved > 0 ? 0 : (outcome.minDist === Infinity ? this.analysis.spanDist : outcome.minDist);
      outcome.solved = outcome.saved >= target && (outcome.ended || outcome.outOfTime || outcome.stuck || outcome.leadDone);
      node.outcome = outcome;
      node.events = events;
      node.score = Solver.score(node, this.analysis, target, !!lemFilter);
      const dead = outcome.solved ? null : Solver.deadReason(boundAtNode, outOfTimeAtNode, outcome, target, skillsLeft, nukedAtNode);
      node.dead = dead;
      if (dead) { this.dropped.dead++; node.state = null; node.events = null; return node; }
      node.candidates = node.depth >= this.params.depth ? [] : Solver.candidates(events, outcome, {
        game, skillCounts, activeSkills: game.activeSkills, params: this.params, analysis: this.analysis,
        lemFilter, nodeFrame: node.frame, isRoot: !!isRoot, level: world.level, plan,
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

    /**
     * "Keep at it", one step: the lemming's job (`skill`'s action) waited to
     * its end - a fall out of it to the landing - and the skill given again
     * at once, while it walks (or shrugs, a builder out of bricks) the same
     * way. True when it was given again; false when the chain is over (the
     * lemming turned, died, is done, or the skill is refused).
     */
    _keepAtOnce(L, skill, dx, gap) {
      const world = this.world, B = Lemmix.BA;
      const action = Lemmix.SKILL_TO_ACTION[skill];
      let frames = 0, walked = 0;
      while (frames < 3000 && !world.ended) {
        world.step(1); frames++;
        if (L.removed || L.cannotReceiveSkills || L.dx !== dx) return false;
        if (L.action === action || L.action === B.FALLING || L.action === B.FLOATING || L.action === B.GLIDING) continue;
        if (L.action !== B.WALKING && L.action !== B.SHRUGGING && L.action !== B.ASCENDING) return false;
        // a gap: a few frames' walk first, so the next hole is not under the last (the crowd drops one floor at a time)
        if (walked < (gap | 0) && L.action !== B.SHRUGGING) { walked++; continue; }
        if (!world.assign(L, skill)) return false;
        world.step(1);
        return L.action === action || L.action === B.FALLING; // on the job again (a digger drops through at once)
      }
      return false;
    }

    /** The child of `node` by `cand`, or null when the action could not be taken. */
    _expand(node, cand, target, lemFilter) {
      const world = this.world;
      if (!this._goto(node)) { this.dropped.ended++; return null; }
      if (cand.frame > world.frame) world.step(cand.frame - world.frame);
      if (world.frame !== cand.frame) { this.dropped.ended++; return null; }
      if (cand.kind === "follow") { const made = this._follow(node, cand, target, lemFilter); if (!made) this.dropped.refused++; return made; }
      let ok = false;
      if (cand.kind === "assign" || cand.kind === "repeat") { const L = world.lemmingById(cand.lemId); ok = !!L && world.assign(L, cand.skill); }
      else if (cand.kind === "si") ok = world.setSpawnInterval(cand.si);
      else if (cand.kind === "nuke") ok = world.nuke();
      if (!ok) { this.dropped.refused++; if (this.trace && this.log) this.log("  refused f=" + cand.frame + " " + describe(cand)); return null; }
      world.step(1);
      if (cand.kind === "assign") {
        const child = this._child(node, cand, target, lemFilter);
        // the lemming dies of what a permanent skill answers (a splat: a floater): the rescue at once, chained
        const rescued = child && !child.dead && !child.solved ? this._rescue(child, cand, target, lemFilter) : null;
        return rescued ? [child, rescued] : child;
      }
      if (cand.kind === "follow") return this._follow(node, cand, target, lemFilter);
      if (cand.kind !== "repeat") return this._child(node, cand, target, lemFilter);
      // "keep at it": the skill given again each time its job ends, a node per repetition, so
      // every length of the chain (three floors dug, not four) is a state the search holds.
      // The first node is the plain assignment's (a candidate of its own), so it is only the
      // chain's start here, never a child twice.
      const first = this._child(node, cand, target, lemFilter, true);
      if (!first || first.dead) return null;
      const children = [];
      const dx = (world.lemmingById(cand.lemId) || {}).dx || 0;
      let last = first;
      for (let n = 0; n < this.params.repeats && !last.dead; n++) {
        if (!this._goto(last)) break; // the node's state, or rebuilt from an ancestor's when the cache let it go
        const L = world.lemmingById(cand.lemId); // a restore makes the lemmings afresh
        if (!L || !this._keepAtOnce(L, cand.skill, dx, cand.gap)) break;
        const next = this._child(last, Object.assign({}, cand, { frame: world.frame, why: cand.why + (n + 2) }), target, lemFilter);
        if (!next) break;
        children.push(next);
        last = next;
      }
      return children;
    }

    /**
     * The rescue chained: the lemming of `cand` died in `child`'s rollout of a
     * cause a permanent skill answers (a splat, water, a trap), so that skill
     * is given at the death's anchor - the fall's start, or at once for a
     * swimmer - and the result is a node of its own.
     */
    _rescue(child, cand, target, lemFilter) {
      const death = (child.events || []).find((e) => e.type === "DEATH" && e.lemId === cand.lemId);
      if (!death) return null;
      const skill = { splat: "FLOATER", water: "SWIMMER", trap: "DISARMER" }[death.cause];
      if (!skill || !this.world.skillCounts()[skill]) return null;
      const frame = death.cause === "splat" ? (death.anchor ? death.anchor.frame : death.frame - 24) : death.frame;
      if (frame < child.frame) return null;
      const rescue = { kind: "assign", lemId: cand.lemId, skill, frame, why: cand.why + "+" + skill.toLowerCase(), prior: cand.prior };
      if (!this._goto(child)) return null;
      const world = this.world;
      if (frame > world.frame) world.step(frame - world.frame);
      if (world.frame !== frame) return null;
      const L = world.lemmingById(cand.lemId);
      if (!L || !world.assign(L, skill)) return null;
      world.step(1);
      return this._child(child, rescue, target, lemFilter);
    }

    /**
     * "Follow the lead": `cand.lemId` given the permanent skills the lead got
     * (`cand.perms`: [{skill, frame}] of the lead's, the frames shifted by
     * the two lemmings' spawn gap), each at its frame, as one edge.
     */
    _follow(node, cand, target, lemFilter) {
      const world = this.world;
      const L0 = world.lemmingById(cand.lemId);
      if (!L0) return null;
      for (const p of cand.perms) {
        const f = p.frame + cand.shift;
        if (f < world.frame) continue;
        world.step(f - world.frame);
        if (world.frame !== f) return null;
        const L = world.lemmingById(cand.lemId);
        if (!L || L.removed) return null;
        if (!world.assign(L, p.skill)) return null;
        world.step(1);
      }
      return this._child(node, cand, target, lemFilter);
    }

    /** The node of the world as it stands, after `cand` was applied, traced. */
    _child(node, cand, target, lemFilter, skipSeen) {
      const plan = this.world.plan();
      this.expansions++;
      const child = this._makeNode(node, plan, target, lemFilter, false, skipSeen);
      if (!child && this.trace && this.log) this.log("  seen f=" + cand.frame + " " + describe(cand));
      if (this.trace && this.log && child) {
        const o = child.outcome;
        this.log("  #" + this.expansions + " f=" + cand.frame + " " + describe(cand) + " -> saved " + o.saved + "/" + target + " lost " + o.lost + " skills " + child.skillsUsed
          + (o.stuck ? " stuck" : "") + (o.outOfTime ? " time" : "") + (child.dead ? " DEAD:" + child.dead : "") + (o.solved ? " SOLVED" : "") + " score " + child.score.toFixed(0));
      }
      return child;
    }

    /** A milestone for whoever watches: the phase, the work done, the best so far. */
    report(extra) {
      this._lastReport = now();
      if (!this.onProgress) return;
      const b = this.best;
      this.onProgress(Object.assign({ phase: this.phase, expansions: this.expansions,
        best: b ? { saved: b.saved, skillsUsed: b.skillsUsed, completionFrame: b.completionFrame } : null }, extra || {}));
    }

    /** Nothing left to search for: every lemming saved with no skill - or, seeding the crowd (a lead pass), the target made with none. */
    _done(target, lemFilter) {
      const b = this.best;
      if (!b || b.skillsUsed !== 0) return false;
      return b.saved >= this.analysis.maxSavable || (!!lemFilter && b.saved >= target);
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
        // the node's events and candidates have done their work: the edges hold what the
        // search still needs, and a long search keeps tens of thousands of nodes alive
        node.events = null; node.candidates = null;
        const cap = Math.max(4000, this.params.beam * 2);
        if (heap.size > cap * 2) { total -= heap.size; heap.trim(cap); total += heap.size; }
      };
      for (const seed of seeds) {
        this.world.reset(seed.plan);
        if (seed.frame > 0) this.world.step(seed.frame);
        const node = this._makeNode(null, Solver.copyPlan(seed.plan), target, lemFilter, seed.frame === 0 && !seed.plan.length);
        if (node) { node.isRoot = true; pushEdges(node); }
        if (this._done(target, lemFilter)) return this.best;
      }
      // which depth's turn: the one with the fewest pops so far, weighted toward the
      // shallow ones (a plain rotation goes straight down, every expansion opening a
      // new deeper heap that is visited next)
      const pops = new Map();
      while (total > 0 && now() < deadline) {
        if (this.onProgress && now() - this._lastReport > 1000) this.report();
        let heap = null, bestKey = Infinity;
        for (const [d, h] of open) {
          if (!h.size) continue;
          const key = ((pops.get(d) || 0) + 1) * (1 + 0.5 * d);
          if (key < bestKey) { bestKey = key; heap = h; pops.set(-1, d); }
        }
        if (!heap) break;
        const d = pops.get(-1);
        pops.set(d, (pops.get(d) || 0) + 1);
        const edge = heap.pop();
        total--;
        if (this.best && edge.node.skillsUsed + 1 > this.best.skillsUsed && this.best.saved >= this.analysis.maxSavable) continue;
        const made = this._expand(edge.node, edge.cand, target, lemFilter);
        const children = Array.isArray(made) ? made : made ? [made] : [];
        for (const child of children) if (!child.dead) pushEdges(child);
        if (this._done(target, lemFilter)) break;
      }
      return this.best;
    }
  }

  const planEntry = (e) => e.type === "assignment" ? e.skill + "@" + e.frame + ">" + e.lemId : e.type === "nuke" ? "NUKE@" + e.frame : "SI" + e.interval + "@" + e.frame;
  const describe = (c) => c.kind === "assign" || c.kind === "repeat" ? c.skill + ">" + c.lemId + " (" + c.why + ")" : c.kind === "follow" ? c.perms.map((p) => p.skill).join("+") + ">" + c.lemId + " (follow)" : c.kind === "si" ? "SI=" + c.si : "NUKE";

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
      search.phase = "lead pass";
      search.report();
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
      search.phase = widen ? "crowd pass, widened to tier " + tier : "crowd pass";
      search.report();
      const before = search.expansions;
      best = search.run(seeds, need, null, searchEnd);
      if (log) log("crowd pass" + (widen ? " (widened to tier " + tier + "'s breadth)" : "") + ": " + (best ? "saved " + best.saved + " with " + best.skillsUsed + " skills at frame " + best.completionFrame : "nothing") + ", " + (search.expansions - before) + " expansions, dropped " + JSON.stringify(search.dropped));
      if (best && (best.saved >= analysis.maxSavable || tier >= 3)) break;
      if (tier >= 3) break;
      if (best) { seeds.push({ plan: best.plan, frame: 0 }); }
    }
    // the optimiser, in the slice reserved for it (and whatever the search left)
    if (best) {
      search.phase = "optimising";
      search.best = best;
      search.report();
      best = Solver.optimise(world, best, analysis, t0 + budget, log);
    }
    search.phase = "done"; search.best = best; search.report();
    const stats = { expansions: search.expansions, nodes: search.nodes, frames: world.frames, elapsedMs: now() - t0, dropped: search.dropped, features: analysis.features, maxSavable: analysis.maxSavable, lead: lead ? lead.skillsUsed : null };
    return { best, stats, analysis };
  }

  Solver.solve = solve;
  Solver.Search = Search;
  Solver.compare = compare;
  Solver.planEntry = planEntry;
  if (typeof module !== "undefined" && module.exports) module.exports = { solve, Search, compare, planEntry };
})(typeof window !== "undefined" ? window : globalThis);
