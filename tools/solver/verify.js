"use strict";
/**
 * A solution checked the way the page will play it: a fresh level, a fresh
 * game, the .nxrp text parsed and loaded, the game run to its end (nuked
 * when the clock runs out, as the page does), and the result compared with
 * what the solver claimed.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Solver = Lemmix.Solver || (Lemmix.Solver = {});

  const MAX_FRAMES = 17 * 60 * 30;

  /**
   * `level` a freshly built level (never the solver's), `masks` the engine's.
   * Returns { ok, saved, completionFrame, skillsUsed, needed, reason }.
   */
  function verify(level, masks, nxrpText, claim) {
    const game = new Lemmix.LemGame(level, masks);
    game.start();
    game.loadReplay(Lemmix.Replay.parse(nxrpText));
    let frames = 0;
    while (!game.gameFinished && !game.stateIsUnplayable && frames < MAX_FRAMES) {
      if (game.isOutOfTime && !game.userSetNuking) game.nuke();
      game.update();
      frames++;
    }
    let skillsUsed = 0;
    for (const k of Object.keys(game.usedSkillCount)) skillsUsed += game.usedSkillCount[k] || 0;
    const result = { saved: game.lemmingsIn, completionFrame: game.currentIteration, skillsUsed, needed: level.needCount, ended: game.gameFinished || game.stateIsUnplayable };
    result.ok = result.ended && result.saved >= level.needCount && level.needCount > 0;
    if (claim) {
      if (result.saved !== claim.saved) { result.ok = false; result.reason = "saved " + result.saved + " != " + claim.saved; }
      else if (result.skillsUsed !== claim.skillsUsed) { result.ok = false; result.reason = "skills " + result.skillsUsed + " != " + claim.skillsUsed; }
    }
    if (!result.ended) result.reason = "the level did not end";
    return result;
  }

  Solver.verify = verify;
  if (typeof module !== "undefined" && module.exports) module.exports = { verify };
})(typeof window !== "undefined" ? window : globalThis);
