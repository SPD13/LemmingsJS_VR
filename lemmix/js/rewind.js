"use strict";
/**
 * Saved states and skipping through time, as NeoLemmix does them (the
 * TLemmingGameSavedStateList of LemGame.pas and GotoSaveState of
 * GameWindow.pas): there is no running the physics backwards. A state is
 * kept at frame 0 and every 170 frames, and the list is thinned to one per
 * ten seconds over the last minute, one per half minute over the last three
 * and one per minute beyond. Going to a frame loads the nearest state before
 * it and simulates forward with nothing drawn or heard until it is reached -
 * the replay's actions firing on their frames on the way - which is what a
 * step back of one frame, a restart and a load of a replay all are.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});

  const SAVE_EVERY = 170;                 // frames: every 10 seconds
  const MINUTE = 17 * 60, HALF_MINUTE = 17 * 30, TEN_SECONDS = 17 * 10;

  class SaveStates {
    constructor() {
      this.states = [];
      this.onSave = null;   // (state) => the page adds what it keeps per state
      this.onLoad = null;   // (state) => the page takes it back
    }

    static frameOf(s) { return s.scalars.currentIteration; }
    get count() { return this.states.length; }

    /** Keep this frame. */
    add(sim) {
      const s = sim.saveState();
      if (this.onSave) this.onSave(s);
      this.states.push(s);
      return s;
    }

    /** Put the game back at this state. */
    load(sim, s) {
      sim.loadState(s);
      if (this.onLoad) this.onLoad(s);
    }

    /** TidyList: what is worth keeping, seen from the current frame. */
    tidy(current) {
      this.states = this.states.filter((s) => {
        const f = SaveStates.frameOf(s);
        if (f === 0) return true;
        if (f % MINUTE === 0) return true;
        if (f % HALF_MINUTE === 0 && current - f <= MINUTE * 3) return true;
        if (f % TEN_SECONDS === 0 && current - f <= MINUTE) return true;
        return false;
      });
    }

    /** FindNearestState: the latest state strictly before the frame, or null. */
    nearestBefore(target) {
      let best = null;
      for (const s of this.states) {
        const f = SaveStates.frameOf(s);
        if (f < target && (!best || f > SaveStates.frameOf(best))) best = s;
      }
      return best;
    }

    /** The state at frame 0, if any. */
    first() {
      return this.states.find((s) => SaveStates.frameOf(s) === 0) || null;
    }

    /** ClearAfterIteration: states past the frame are stale once the past is replayed. */
    clearAfter(frame) {
      this.states = this.states.filter((s) => SaveStates.frameOf(s) <= frame);
    }
  }

  /**
   * GotoSaveState: the game at `target`. Loads the nearest state before it
   * (the frame-0 state for a restart), drops the states beyond, and updates
   * the sim until the target - or until the level has ended, where the
   * frame counter stops. Returns how many frames were simulated.
   */
  function gotoFrame(sim, states, target) {
    target = Math.max(0, Math.floor(target));
    const from = target > 0 ? states.nearestBefore(target) : states.first();
    if (!from) throw new Error("rewind: no saved state before frame " + target);
    states.load(sim, from);
    states.clearAfter(sim.currentIteration);
    let n = 0;
    while (sim.currentIteration < target && !sim.gameFinished && !sim.stateIsUnplayable) {
      sim.update();
      n++;
      if (sim.currentIteration % SAVE_EVERY === 0) {
        states.add(sim);
        states.tidy(sim.currentIteration);
      }
    }
    return n;
  }

  Lemmix.SaveStates = SaveStates;
  Lemmix.Rewind = { gotoFrame, SAVE_EVERY };
  if (typeof module !== "undefined" && module.exports) module.exports = { SaveStates, gotoFrame, SAVE_EVERY };
})(typeof window !== "undefined" ? window : globalThis);
