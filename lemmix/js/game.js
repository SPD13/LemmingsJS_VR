"use strict";
/**
 * Lemmix.Game: the NeoLemmix simulation behind the surface the 3D layer
 * already drives for the DOS engine - the same method names on the game,
 * its timer, lemming manager, skills, victory condition and command manager
 * (the DOS Command* classes are reused unchanged, so replays record the
 * same way), and the same Level/objects/frames the diorama builds from.
 *
 * One frame is one call of LemGame.update at 17 frames a second. Skill
 * assignments arrive as commands naming a lemming id, the way the DOS
 * engine records them; the lemming under the cursor is chosen with
 * NeoLemmix's own priority rules (getLemmingAt).
 *
 * Time can be walked, the NeoLemmix way (rewind.js): the game keeps saved
 * states as it goes, and a restart, a frame back or a loaded replay put it
 * at a frame by loading the nearest state and simulating up to it with the
 * replay's actions firing on the way. The page is told (onRestore) so it
 * can redraw what it holds copies of. The player taking control while the
 * replay still has actions ahead cuts them off (LemGame.regainControl).
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Lemmings = root.Lemmings;
  const { LemGame, Lemming, BA, SKILL_TO_ACTION } = Lemmix;

  const FRAME_MS = 1000 / 17;

  /** The DOS GameTimer's surface, at NeoLemmix's frame rate. */
  class GameTimer {
    constructor() {
      this.TIME_PER_FRAME_MS = FRAME_MS;
      this._speedFactor = 1;
      this.gameTimerHandler = 0;
      this.tickIndex = 0;
      this.onGameTick = new Lemmings.EventHandler();
      this.onBeforeGameTick = new Lemmings.EventHandler();
    }
    isRunning() { return this.gameTimerHandler !== 0; }
    get speedFactor() { return this._speedFactor; }
    set speedFactor(v) { this._speedFactor = v; if (this.isRunning()) { this.suspend(); this.continue(); } }
    suspend() { if (this.gameTimerHandler) clearInterval(this.gameTimerHandler); this.gameTimerHandler = 0; }
    stop() { this.suspend(); this.onBeforeGameTick.dispose(); this.onGameTick.dispose(); }
    toggle() { if (this.isRunning()) this.suspend(); else this.continue(); }
    continue() {
      if (this.isRunning()) return;
      this.gameTimerHandler = setInterval(() => this.tick(), this.TIME_PER_FRAME_MS / this._speedFactor);
    }
    tick() {
      if (this.onBeforeGameTick) this.onBeforeGameTick.trigger(this.tickIndex);
      this.tickIndex++;
      if (this.onGameTick) this.onGameTick.trigger();
    }
    getGameTime() { return Math.floor(this.tickIndex / 17); }
    getGameTicks() { return this.tickIndex; }
    ticksToSeconds(t) { return t / 17; }
    secondsToTicks(s) { return s * 17; }
  }

  /** getGameSkills(): skill ids are positions in the level's panel (0..9). */
  class Skills {
    constructor(sim) {
      this.sim = sim;
      this.onCountChanged = new Lemmings.EventHandler();
      this.onSelectionChanged = new Lemmings.EventHandler();
    }
    get names() { return this.sim.activeSkills; }
    getSelectedSkill() { return this.sim.activeSkills.indexOf(this.sim.selectedSkill); }
    setSelectedSkill(i) {
      const name = this.sim.activeSkills[i];
      if (!name) return false;
      this.sim.setSelectedSkill(name);
      this.onSelectionChanged.trigger();
      return true;
    }
    getSkill(i) { return this.sim.skillCount(this.sim.activeSkills[i]); }
    canReduseSkill(i) {
      const name = this.sim.activeSkills[i];
      return !!name && this.sim.checkSkillAvailable(SKILL_TO_ACTION[name]);
    }
    reduseSkill() { return true; } // the simulation already took it
    cheat() { for (const n of this.sim.activeSkills) this.sim.currSkillCount[SKILL_TO_ACTION[n]] = 99; }
  }

  /** getVictoryCondition(): counts and the release rate, in DOS terms. */
  class Victory {
    constructor(sim) { this.sim = sim; }
    getNeedCount() { return this.sim.level.needCount; }
    getReleaseCount() { return this.sim.level.releaseCount; }
    getSurvivorsCount() { return this.sim.lemmingsIn; }
    getSurvivorPercentage() { return Math.floor(this.sim.lemmingsIn / Math.max(1, this.sim.level.releaseCount) * 100); }
    getLeftCount() { return this.sim.lemmingsToRelease; }
    getOutCount() { return this.sim.lemmingsOut; }
    getCurrentReleaseRate() { return this.sim.releaseRate; }
    getMinReleaseRate() { return this.sim.minReleaseRate; }
    getMaxReleaseRate() { return 99; }
    /** DOS commands change the rate in steps; NeoLemmix moves the interval. */
    changeReleaseRate(delta) {
      const target = this.sim.currSpawnInterval - Math.sign(delta);
      if (!this.sim.checkIfLegalSI(target)) return false;
      this.sim.adjustSpawnInterval(target);
      return true;
    }
    doNuke() { this.sim.nuke(); return true; } // the manager already asked; nuke() is idempotent
    doFinalize() {}
  }

  class Game {
    /**
     * `level` built by LevelBuilder; `assets` = {masks, sprites}; `options`
     * may name a `theme` sprite set already loaded in `assets.sprites`.
     */
    constructor(level, assets) {
      this.level = level;
      this.sim = new LemGame(level, assets.masks);
      this.sprites = assets.sprites;
      Lemmix.generatePickupIcons(level, this.sprites, level.theme);
      this.gameTimer = new GameTimer();
      this.skills = new Skills(this.sim);
      this.gameVictoryCondition = new Victory(this.sim);
      this.commandManager = new Lemmings.CommandManager(this, this.gameTimer);
      this.onGameEnd = new Lemmings.EventHandler();
      this.finalGameState = Lemmings.GameStateTypes.UNKNOWN;
      this.lemmingManager = new LemmingManager(this);
      this.objectManager = new ObjectManager(this);
      this.triggerManager = { trigger: () => 0, triggers: [] };
      this.gui = null;
      this.onRestore = new Lemmings.EventHandler(); // the game jumped to another frame
      this.onLoadReplayRequest = null;               // () => the page opens a file picker
      this.cursorLemming = null;                     // what the pointer is on, for the info strip
      this.nukePrepared = false;
      this.clearPhysics = false;                     // the level as its physics map (the panel's CPM half, key t)
      this.onOptionChanged = null;                   // () => the page redraws what it shows for an option
      this.showAthleteInfo = false;                  // the hotkey held: the info strip spells the permanent skills
      this.stateMark = null;                         // the Save State hotkey: {frame, recorded}
      this.gameTimer.onGameTick.on(() => this.onGameTimerTick());
      this.sim.start();
      for (const L of this.sim.lemmings) L.game = this;
      this.states = new Lemmix.SaveStates();
      this.states.add(this.sim); // frame 0: what a restart goes back to
    }

    /** The DOS Game builds the level here; ours already has it. */
    async loadLevel() { return this; }

    start() { this.gameTimer.continue(); }
    stop() { this.gameTimer.stop(); }
    dispose() { this.stop(); if (this.gui) this.gui.dispose(); }

    getGameTimer() { return this.gameTimer; }
    getLemmingManager() { return this.lemmingManager; }
    getGameSkills() { return this.skills; }
    getVictoryCondition() { return this.gameVictoryCondition; }
    getCommandManager() { return this.commandManager; }
    getObjectManager() { return this.objectManager; }
    queueCmmand(cmd) { this.commandManager.queueCommand(cmd); }
    setGameDispaly() {}
    setGuiDisplay(display) {
      if (this.gui) this.gui.dispose();
      this.gui = new Lemmix.GamePanel(this, display);
    }

    onGameTimerTick() {
      this.sim.update();
      for (const L of this.sim.lemmings) if (!L.game) L.game = this;
      // a state every ten seconds, the list thinned as it grows
      if (this.sim.currentIteration > 0 && this.sim.currentIteration % Lemmix.Rewind.SAVE_EVERY === 0 &&
          !this.states.states.some((s) => Lemmix.SaveStates.frameOf(s) === this.sim.currentIteration)) {
        this.states.add(this.sim);
        this.states.tidy(this.sim.currentIteration);
      }
      this.checkForGameOver();
      if (this.gui) this.gui.render();
    }

    // ---- walking time (the panel's replay, frame back and frame forward)

    get replaying() { return this.sim.replaying; }
    get replayInsert() { return this.sim.replayInsert; }
    toggleReplayInsert() { this.sim.replayInsert = !this.sim.replayInsert; if (this.gui) this.gui.render(true); }
    toggleClearPhysics() {
      this.clearPhysics = !this.clearPhysics;
      if (this.gui) this.gui.render(true);
      if (this.onOptionChanged) this.onOptionChanged();
    }
    setClearPhysics(on) { if (this.clearPhysics !== !!on) this.toggleClearPhysics(); }
    setSelectDx(dx) { this.sim.selectDx = dx; if (this.gui) this.gui.render(true); }

    // ---- the hotkeys' own functions (GameWindow.Form_KeyDown)

    /** Select a skill by its NeoLemmix name, when the level has it. */
    selectSkillByName(name) {
      const i = this.sim.activeSkills.indexOf(String(name).toUpperCase());
      if (i < 0) return false;
      this.queueCmmand(new Lemmings.CommandSelectSkill(i));
      return true;
    }

    /** Next (+1) or previous (-1) skill on the panel, wrapping as NeoLemmix does. */
    stepSkill(dir) {
      const names = this.sim.activeSkills;
      const sn = this.skills.getSelectedSkill();
      let to = -1;
      if (dir > 0) {
        if (sn >= 0 && sn < names.length - 1) to = sn + 1;
        else if (sn > 0) to = 0;
      } else {
        if (sn > 0) to = sn - 1;
        else if (sn === 0 && names.length > 1) to = names.length - 1;
      }
      if (to >= 0) this.queueCmmand(new Lemmings.CommandSelectSkill(to));
    }

    /** The release rate to its limit (spbFaster/spbSlower with RightClick). */
    setReleaseRateExtreme(dir) {
      for (let i = 0; i < 200 && this.gameVictoryCondition.changeReleaseRate(dir); i++) { /* one step each */ }
      if (this.gui) this.gui.render(true);
    }

    /** Cancel Replay: the player takes over even in replay-insert mode. */
    cancelReplay() { this.sim.regainControl(true); if (this.gui) this.gui.render(true); }

    /** Save State: this frame and the replay as it stands, for Load State. */
    saveStateMark() {
      this.stateMark = { frame: this.sim.currentIteration, recorded: this.sim.recorded.map((r) => Object.assign({}, r)) };
    }

    /** Load State: the replay as saved, the game at the saved frame, paused. */
    loadStateMark() {
      if (!this.stateMark) return false;
      this.sim.recorded = this.stateMark.recorded.map((r) => Object.assign({}, r));
      this.gotoFrame(this.stateMark.frame, true);
      return true;
    }

    /** Skip to Previous Assignment: the frame before the replay's last action at or before now. */
    skipToLastAction() {
      const sim = this.sim;
      const last = sim.lastActionFrame;
      if (last === -1) return;
      let target = 0;
      if (sim.currentIteration > last) target = last;
      else for (let i = 0; i <= sim.currentIteration; i++) if (sim.recorded.some((r) => r.frame === i)) target = i;
      this.gotoFrame(Math.max(target - 1, 0), true);
    }

    /** Skip to Next Shrugger: ahead at hyperspeed until a builder, platformer or stacker runs out, then paused. */
    skipToNextShrugger() {
      const sim = this.sim;
      const busy = (L) => !L.removed && (L.action === BA.BUILDING || L.action === BA.PLATFORMING || L.action === BA.STACKING);
      if (!sim.lemmings.some(busy)) return;
      Lemmix.Rewind.runUntil(sim, this.states, (s) => s.lemmings.some((L) => !L.removed && L.action === BA.SHRUGGING), 17 * 60 * 10);
      this._afterJump(true);
    }

    /** The game at `frame`, the replay kept; paused when `pause`. */
    gotoFrame(frame, pause) {
      Lemmix.Rewind.gotoFrame(this.sim, this.states, frame);
      this._afterJump(pause);
    }

    /** The replay button: the level from the start, paused, the attempt replaying. */
    restartReplay() { this.gotoFrame(0, true); }

    /** One (or 17, or 85) frames back, paused. */
    backFrames(n) { this.gotoFrame(this.sim.currentIteration - n, true); }

    /** One frame forward is a tick while paused (the page sees it as any
     *  other); more is a skip ahead at whatever speed the game was at. */
    forwardFrames(n) {
      if (n <= 1) { this.forceOneFrame(); return; }
      Lemmix.Rewind.gotoFrame(this.sim, this.states, this.sim.currentIteration + n);
      this._afterJump(false);
    }

    /** A paused game runs one frame: a click's assignment shows (ForceUpdateOneFrame). */
    forceOneFrame() {
      if (!this.gameTimer.isRunning()) this.gameTimer.tick();
    }

    /** A loaded replay file plays from the start at normal speed. */
    loadReplayFile(parsed) {
      this.sim.loadReplay(parsed);
      this.gameTimer.speedFactor = 1;
      Lemmix.Rewind.gotoFrame(this.sim, this.states, 0);
      this._afterJump(false);
      if (!this.gameTimer.isRunning()) this.gameTimer.continue();
    }

    requestLoadReplay() { if (this.onLoadReplayRequest) this.onLoadReplayRequest(); }

    _afterJump(pause) {
      const sim = this.sim;
      for (const L of sim.lemmings) L.game = this;
      // the command log and the timer count frames the way the sim does
      this.gameTimer.tickIndex = sim.currentIteration;
      const logged = this.commandManager.loggedCommads;
      for (const k of Object.keys(logged)) if (+k >= sim.currentIteration) delete logged[k];
      this.finalGameState = Lemmings.GameStateTypes.UNKNOWN; // re-latched by checkForGameOver if still over
      this.nukePrepared = false;
      if (pause) this.gameTimer.suspend();
      if (this.gui) this.gui.render(true);
      this.onRestore.trigger({ frame: sim.currentIteration, paused: !this.gameTimer.isRunning() });
    }

    getGameState() {
      const T = Lemmings.GameStateTypes;
      if (this.finalGameState !== T.UNKNOWN) return this.finalGameState;
      const sim = this.sim;
      const won = sim.lemmingsIn >= sim.level.needCount;
      if (sim.gameFinished || sim.stateIsUnplayable) return won ? T.SUCCEEDED : (sim.isOutOfTime ? T.FAILED_OUT_OF_TIME : T.FAILED_LESS_LEMMINGS);
      if (sim.isOutOfTime && !sim.userSetNuking) sim.nuke(); // NeoLemmix nukes when the clock runs out
      return T.RUNNING;
    }

    checkForGameOver() {
      if (this.finalGameState !== Lemmings.GameStateTypes.UNKNOWN) return;
      const state = this.getGameState();
      if (state !== Lemmings.GameStateTypes.RUNNING && state !== Lemmings.GameStateTypes.UNKNOWN) {
        this.finalGameState = state;
        this.onGameEnd.trigger(new Lemmings.GameResult(this));
      }
    }

    /** Sound cues of the last frame: [{name, x, y}]. */
    get sounds() { return this.sim.sounds; }

    /** The 4x5 countdown digit `n` as a frame, cached. */
    countdownFrame(n) {
      if (!Lemmix.digitFont) return null;
      if (!this._countdown) this._countdown = new Map();
      if (!this._countdown.has(n)) {
        const font = Lemmix.digitFont;
        const bmp = font.crop(Math.min(9, Math.max(0, n)) * 4, 0, 4, 5);
        this._countdown.set(n, Lemmix.LevelBuilder.frameFromBitmap(bmp, 0, 0));
      }
      return this._countdown.get(n);
    }

    /** A NeoLemmix replay (parsed by Lemmix.Replay) as this game's own, before it starts. */
    loadReplay(replay) { this.sim.loadReplay(replay); }
  }

  /** getLemmingManager(): the lemmings, and how a click picks one. */
  class LemmingManager {
    constructor(game) { this.game = game; }
    get lemmings() { return this.game.sim.lemmings; }
    getLemmings() { return this.game.sim.lemmings; }
    getLemming(id) { return this.game.sim.lemmings[id] || null; }
    /** The lemming NeoLemmix would give the selected skill to, at this cursor position. */
    getLemmingAt(x, y) {
      const sim = this.game.sim;
      const action = sim.selectedSkill ? SKILL_TO_ACTION[sim.selectedSkill] : BA.NONE;
      const pick = sim.getPriorityLemming(action, x, y);
      if (pick.lemming) return pick.lemming;
      return sim.getPriorityLemming(BA.NONE, x, y).lemming; // hover: any lemming under the cursor
    }
    /** The lemming NeoLemmix marks at this cursor position - the one the selected skill would go to - or null. */
    getSelectedLemmingAt(x, y) {
      const sim = this.game.sim;
      const action = sim.selectedSkill ? SKILL_TO_ACTION[sim.selectedSkill] : BA.NONE;
      return sim.getPriorityLemming(action, x, y).lemming;
    }
    doLemmingAction(lem, skillIndex) {
      const name = this.game.sim.activeSkills[skillIndex];
      return !!name && this.game.sim.assignSkillTo(lem, name);
    }
    addNewLemmings() {} // the simulation releases its own
    isNuking() { return this.game.sim.userSetNuking; }
    doNukeAllLemmings() { this.game.sim.nuke(); }
    getLemmingsOut() { return this.game.sim.lemmingsOut; }
  }

  /** objectManager.render(display): every on-map gadget at its current frame. */
  class ObjectManager {
    constructor(game) { this.game = game; }
    render(display) {
      for (const obj of this.game.level.objects) {
        const g = obj.gadget;
        if (g.effectBase === "NONE" && g.effect === "NONE" && !g.animations.length) continue;
        display.drawFrameFlags(g.render(), obj.x, obj.y, obj.drawProperties);
      }
    }
  }

  /** What the display and the diorama draw for a lemming. */
  Lemming.prototype.render = function (display) {
    if (this.removed || this.teleporting || !this.game) return;
    if (this.portalWarpFrame >= 3 && this.portalWarpFrame <= 4) return; // mid-warp
    let variant = this.isZombie ? "zombie" : this.isNeutral ? "neutral" : this.hasPermanentSkills ? "athlete" : "normal";
    if (this.game.cursorLemming === this) variant += "+selected"; // the one the skill would go to
    if (this.game.clearPhysics) {
      // TRecolorImage.SwapColors with ClearPhysics: one flat colour per state
      let c = this.hasPermanentSkills ? 0x00FFFF : 0x0000FF;
      if (this.game.cursorLemming === this) c |= 0x7F0000;
      if (this.isNeutral) c ^= 0xFFFFFF;
      if (this.isZombie) c = (c | 0x007F00) & ~0x0000C0;
      variant = "flat:" + c.toString(16).padStart(6, "0");
    }
    const frame = this.game.sprites.frame(this.action, this.dx, this.frame, variant);
    if (frame) display.drawFrame(frame, this.x, this.y);
    // the countdown over a lemming about to blow (DrawLemmingCountdown)
    if (this.explosionTimer > 0 && !this.hideCountdown) {
      const n = Math.floor(this.explosionTimer / 17) + 1;
      const digit = this.game.countdownFrame(n);
      if (digit) display.drawFrame(digit, this.x - (this.dx < 0 ? 2 : 1), this.y - 17);
    }
  };
  Object.defineProperty(Lemming.prototype, "state", { get() { return this.action === BA.BUILDING ? 12 - this.bricksLeft : 0; } });

  Lemmix.Game = Game;
  Lemmix.GameTimer = GameTimer;

  if (typeof module !== "undefined" && module.exports) module.exports = { Game, GameTimer };
})(typeof window !== "undefined" ? window : globalThis);
