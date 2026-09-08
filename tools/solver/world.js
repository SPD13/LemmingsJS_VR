"use strict";
/**
 * The solver's hold on one game: a LemGame it steps, saves and puts back
 * at will. A saved state here is the physics-only kind (the picture is
 * nobody's concern under a solver); the replay is not part of a state, so
 * a restore takes the plan the state belongs with and makes it the game's
 * record, which is what fires the plan's actions on their frames as the
 * game is stepped (LemGame applies its record, never a click).
 *
 * Nothing here knows about search: World is the physics, wrapped so the
 * search above it can branch (save), backtrack (restore) and act (assign,
 * setSpawnInterval, nuke) in the engine's own record-then-apply model.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Solver = Lemmix.Solver || (Lemmix.Solver = {});
  const { BA, SKILL_TO_ACTION } = Lemmix;

  const copyPlan = (plan) => plan.map((e) => Object.assign({}, e));

  class World {
    /** `level` a built Lemmix.Level (mutated by the game), `masks` from Lemmix.loadMasks. */
    constructor(level, masks) {
      this.level = level;
      this.game = new Lemmix.LemGame(level, masks);
      this.game.start();
      // replay-insert mode: an action joins the record without cutting what the plan holds
      // beyond this frame (a seeded plan's later entries stay), as NeoLemmix's insert mode does
      this.game.replayInsert = true;
      this.terrainVersion = 0;
      this._hookTerrain();
      this.rootState = this.game.saveState(); // the full kind: the picture goes back too when the world is reset
      this.frames = 0;                          // frames simulated in all, for the statistics
    }

    /** Every write to the physics map bumps terrainVersion (writes under a simulation do not count). */
    _hookTerrain() {
      const game = this.game, world = this;
      for (const name of ["removePixelAt", "addConstructivePixel", "applyMask", "applyStoneLemming"]) {
        const orig = game[name];
        game[name] = function () { if (!this.isSimulating) world.terrainVersion++; return orig.apply(this, arguments); };
      }
    }

    get frame() { return this.game.currentIteration; }

    /** A state to come back to: the physics and the counters, not the picture. */
    save() { return this.game.saveState({ physicsOnly: true }); }

    /** The game at `state`, its record the plan the state belongs with. */
    restore(state, plan) {
      this.game.loadState(state);
      this.game.recorded = copyPlan(plan || []);
      this.terrainVersion++;
    }

    /** Frame 0 again, with `plan` as the record (empty for a clean start). */
    reset(plan) { this.restore(this.rootState, plan); }

    /** `n` frames on (the record's actions firing on their frames). Stops when the level has ended. */
    step(n) {
      const game = this.game;
      let done = 0;
      while (done < n && !game.gameFinished && !game.stateIsUnplayable) { game.update(); done++; }
      this.frames += done;
      return done;
    }

    /** The level has ended, one way or the other. */
    get ended() { return this.game.gameFinished || this.game.stateIsUnplayable; }

    /**
     * The skill given to the lemming at this frame, into the record, in
     * force on the next step. False when the engine refuses it (mayAssign,
     * the count, a lemming that cannot take skills, an assignment already
     * on this frame).
     */
    assign(L, skill) {
      return this.game.assignSkillTo(L, skill);
    }

    /** The spawn interval changed at this frame (recorded and in force at once). True when it changed. */
    setSpawnInterval(si) {
      const game = this.game;
      if (!game.checkIfLegalSI(si) || si === game.currSpawnInterval) return false;
      game.adjustSpawnInterval(si);
      return game.currSpawnInterval === si;
    }

    /** The nuke at this frame. */
    nuke() {
      const game = this.game;
      if (game.userSetNuking) return false;
      game.nuke();
      return true;
    }

    /** The lemming with this identifier, alive or not, or null. */
    lemmingById(id) {
      const up = String(id).toUpperCase();
      return this.game.lemmings.find((L) => L.identifier.toUpperCase() === up) || null;
    }

    /** The lemmings a skill can go to: alive, not zombie, neutral or an ohnoer. */
    controllable() {
      return this.game.lemmings.filter((L) => !L.removed && !L.cannotReceiveSkills);
    }

    /** The skills the level offers, with their counts as they stand. */
    skillCounts() {
      const out = {};
      for (const name of this.game.activeSkills) out[name] = this.game.currSkillCount[SKILL_TO_ACTION[name]] || 0;
      return out;
    }

    /** How many skills have gone (the objective's second key). */
    skillsUsed() {
      let n = 0;
      for (const k of Object.keys(this.game.usedSkillCount)) n += this.game.usedSkillCount[k] || 0;
      return n;
    }

    /** The record as it stands, copied. */
    plan() { return copyPlan(this.game.recorded); }
  }

  Solver.World = World;
  Solver.copyPlan = copyPlan;
  if (typeof module !== "undefined" && module.exports) module.exports = { World, copyPlan };
})(typeof window !== "undefined" ? window : globalThis);
