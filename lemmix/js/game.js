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
    doNuke() { this.sim.nuke(); return true; }
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
      this.gameTimer.onGameTick.on(() => this.onGameTimerTick());
      this.sim.start();
      for (const L of this.sim.lemmings) L.game = this;
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
      this.checkForGameOver();
      if (this.gui) this.gui.render();
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
    doLemmingAction(lem, skillIndex) {
      const name = this.game.sim.activeSkills[skillIndex];
      return !!name && this.game.sim.assignSkillTo(lem, name);
    }
    addNewLemmings() {} // the simulation releases its own
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
    const variant = this.isZombie ? "zombie" : this.isNeutral ? "neutral" : this.hasPermanentSkills ? "athlete" : "normal";
    const frame = this.game.sprites.frame(this.action, this.dx, this.frame, variant);
    if (frame) display.drawFrame(frame, this.x, this.y);
  };
  Object.defineProperty(Lemming.prototype, "state", { get() { return this.action === BA.BUILDING ? 12 - this.bricksLeft : 0; } });

  Lemmix.Game = Game;
  Lemmix.GameTimer = GameTimer;

  if (typeof module !== "undefined" && module.exports) module.exports = { Game, GameTimer };
})(typeof window !== "undefined" ? window : globalThis);
