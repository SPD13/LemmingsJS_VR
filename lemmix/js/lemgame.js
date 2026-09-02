"use strict";
/**
 * The NeoLemmix game mechanics, ported method for method from LemGame.pas
 * (TLemmingGame) at the commit recorded in Doc/neolemmix-src/COMMIT. Names,
 * constants and the order of checks are kept, so any divergence can be
 * traced to a Pascal line. Everything is integer arithmetic on the physics
 * map; there is no randomness, so a run is reproducible from its inputs.
 *
 * Not ported: shadows, hyperspeed, the save states and the skill queue's
 * frame limit setting. Replays are read and written by replay.js.
 *
 * The game works on a Lemmix.Level: its physics map (PM bits), its gadgets
 * (Lemmix.Gadget) and its spawn order. Terrain changes go through the
 * level's setGroundAt/clearGroundAt so the picture, the collision mask and
 * the 3D diorama's hooks stay in step. Sound cues are collected per frame
 * in `sounds` for whoever plays them.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const { PM, SKILLS } = Lemmix;

  // TBasicLemmingAction
  const BA = {
    NONE: 0, WALKING: 1, ASCENDING: 2, DIGGING: 3, CLIMBING: 4, DROWNING: 5, HOISTING: 6, BUILDING: 7,
    BASHING: 8, MINING: 9, FALLING: 10, FLOATING: 11, SPLATTING: 12, EXITING: 13, VAPORIZING: 14,
    BLOCKING: 15, SHRUGGING: 16, OHNOING: 17, EXPLODING: 18, TOWALKING: 19, PLATFORMING: 20,
    STACKING: 21, STONING: 22, STONEFINISH: 23, SWIMMING: 24, GLIDING: 25, FIXING: 26, CLONING: 27,
    FENCING: 28, REACHING: 29, SHIMMYING: 30, JUMPING: 31, DEHOISTING: 32, SLIDING: 33, LASERING: 34,
  };
  const ACTION_NAMES = ["none", "walking", "ascending", "digging", "climbing", "drowning", "hoisting",
    "building", "bashing", "mining", "falling", "floating", "splatting", "exiting", "vaporizing",
    "blocking", "shrugging", "ohnoing", "exploding", "towalking", "platforming", "stacking", "stoning",
    "stonefinish", "swimming", "gliding", "fixing", "cloning", "fencing", "reaching", "shimmying",
    "jumping", "dehoisting", "sliding", "lasering"];
  // number of physics frames per action (Transition's ANIM_FRAMECOUNT)
  const ANIM_FRAMECOUNT = [0, 4, 1, 16, 8, 16, 8, 16, 16, 24, 4, 17, 16, 8, 14, 16, 8, 16, 1, 0, 16, 8,
    16, 1, 8, 17, 16, 0, 16, 8, 20, 13, 7, 1, 12];

  // skill panel button (name) <-> action
  const SKILL_TO_ACTION = {
    WALKER: BA.TOWALKING, JUMPER: BA.JUMPING, SHIMMIER: BA.SHIMMYING, SLIDER: BA.SLIDING,
    CLIMBER: BA.CLIMBING, SWIMMER: BA.SWIMMING, FLOATER: BA.FLOATING, GLIDER: BA.GLIDING,
    DISARMER: BA.FIXING, BOMBER: BA.EXPLODING, STONER: BA.STONING, BLOCKER: BA.BLOCKING,
    PLATFORMER: BA.PLATFORMING, BUILDER: BA.BUILDING, STACKER: BA.STACKING, LASERER: BA.LASERING,
    BASHER: BA.BASHING, FENCER: BA.FENCING, MINER: BA.MINING, DIGGER: BA.DIGGING, CLONER: BA.CLONING,
  };
  const ACTION_TO_SKILL = {};
  for (const name of Object.keys(SKILL_TO_ACTION)) ACTION_TO_SKILL[SKILL_TO_ACTION[name]] = name;
  const PERM_SKILL_SET = new Set([BA.SLIDING, BA.CLIMBING, BA.FLOATING, BA.GLIDING, BA.FIXING, BA.SWIMMING]);
  const ASSIGNABLE = new Set(Object.values(SKILL_TO_ACTION));

  const MAX_FALLDISTANCE = 62;
  const LEMMING_MAX_Y = 9;
  const PARTICLE_FRAMECOUNT = 51;
  const RM = { NEUTRAL: 0, SAVE: 1, KILL: 2, ZOMBIE: 3 };
  const NO_OBJECT = 65535;
  const MIN_SI = 4;
  // each step moves one pixel; horizontal steps are for a right-facing lemming
  const JUMP_PATTERNS = [
    [[0, -1], [0, -1], [1, 0], [0, -1], [0, -1], [1, 0]],
    [[0, -1], [1, 0], [0, -1], [1, 0], [0, -1], [1, 0]],
    [[0, -1], [1, 0], [0, -1], [1, 0], [1, 0], [0, 0]],
    [[0, -1], [1, 0], [1, 0], [0, -1], [1, 0], [0, 0]],
    [[1, 0], [1, 0], [1, 0], [1, 0], [0, 0], [0, 0]],
    [[1, 0], [0, 1], [1, 0], [1, 0], [0, 1], [0, 0]],
    [[1, 0], [1, 0], [0, 1], [1, 0], [0, 1], [0, 0]],
    [[1, 0], [0, 1], [1, 0], [0, 1], [1, 0], [0, 1]],
    [[1, 0], [0, 1], [0, 1], [1, 0], [0, 1], [0, 1]],
  ];

  // trigger map bits (one map, a bit per TTriggerTypes entry that is a gadget area)
  const TR = {
    EXIT: 1, LOCKEDEXIT: 2, WATER: 4, FIRE: 8, TRAP: 16, TELEPORT: 32, UPDRAFT: 64, PICKUP: 128,
    BUTTON: 256, FLIPPER: 512, NOSPLAT: 1024, SPLAT: 2048, FORCELEFT: 4096, FORCERIGHT: 8192,
    ANIM: 16384, PORTAL: 32768, NEUTRALIZER: 65536, DENEUTRALIZER: 131072, ADDSKILL: 262144,
    REMOVESKILLS: 524288,
  };
  const EFFECT_TRIGGER = {
    EXIT: TR.EXIT, LOCKEXIT: TR.LOCKEDEXIT, WATER: TR.WATER, FIRE: TR.FIRE, TRAP: TR.TRAP,
    TRAPONCE: TR.TRAP, TELEPORT: TR.TELEPORT, UPDRAFT: TR.UPDRAFT, PICKUP: TR.PICKUP, BUTTON: TR.BUTTON,
    FLIPPER: TR.FLIPPER, NOSPLAT: TR.NOSPLAT, SPLAT: TR.SPLAT, FORCELEFT: TR.FORCELEFT,
    FORCERIGHT: TR.FORCERIGHT, ANIMATION: TR.ANIM, ANIMONCE: TR.ANIM, PORTAL: TR.PORTAL,
    NEUTRALIZER: TR.NEUTRALIZER, DENEUTRALIZER: TR.DENEUTRALIZER, ADDSKILL: TR.ADDSKILL,
    REMOVESKILLS: TR.REMOVESKILLS,
  };
  // blocker map field effects
  const BM = { NONE: 0, FORCELEFT: 2, FORCERIGHT: 3, BLOCKER: 10 };

  const ALWAYS_ANIMATE = new Set(["NONE", "EXIT", "FORCELEFT", "FORCERIGHT", "WATER", "FIRE", "ONEWAYLEFT",
    "ONEWAYRIGHT", "ONEWAYDOWN", "UPDRAFT", "NOSPLAT", "SPLAT", "BACKGROUND", "PAINT", "PORTAL",
    "NEUTRALIZER", "DENEUTRALIZER", "REMOVESKILLS"]);

  // sound cue names (the sound/ file names NeoLemmix uses)
  const SFX = {
    ASSIGN_SKILL: "mousepre", ASSIGN_FAIL: "assignfail", HITS_STEEL: "chink", LETSGO: "letsgo",
    ENTRANCE: "door", YIPPEE: "yippee", OHNO: "ohno", EXPLOSION: "explode", SPLAT: "splat",
    DROWNING: "glug", VAPORIZING: "fire", SWIMMING: "splash", FALLOUT: "die", ZOMBIE: "zombie",
    PICKUP: "oing2", EXIT_OPEN: "exitopen", BUILDER_WARNING: "ting", FIXING: "wrench",
    TIMEUP: "timeup", ADD_SKILL: "skill_add", REMOVE_SKILLS: "skill_remove", NEUTRALIZE: "neutralize",
    DENEUTRALIZE: "deneutralize", PORTAL: "portal", SKILLBUTTON: "changeop",
  };

  const inSet = (v, arr) => arr.indexOf(v) >= 0;

  // ------------------------------------------------------------- lemming

  /** TLemming, with LemX/LemY/... shortened to x/y/... */
  class Lemming {
    constructor(index) {
      this.index = index;          // LemIndex
      this.identifier = "";
      this.x = 0; this.y = 0; this.dx = 1;
      this.ascended = 0;
      this.fallen = 0; this.trueFallen = 0;
      this.explosionTimer = 0;
      this.disarmingFrames = 0;
      this.frame = 0; this.maxFrame = -1; this.frameDiff = 0;
      this.physicsFrame = 0; this.maxPhysicsFrame = 0;
      this.particleTimer = -1;
      this.bricksLeft = 0;
      this.action = BA.NONE;
      this.removed = false;
      this.teleporting = false;
      this.endOfAnimation = false;
      this.isPhysicsSimulation = false;
      this.isSlider = false; this.isClimber = false; this.isSwimmer = false;
      this.isFloater = false; this.isGlider = false; this.isDisarmer = false;
      this.isZombie = false; this.isNeutral = false;
      this.hasBeenOhnoer = false;
      this.placedBrick = false;
      this.inFlipper = -1;
      this.hasBlockerField = false;
      this.isStartingAction = false;
      this.exploded = false;
      this.timerToStone = false;
      this.hideCountdown = false;
      this.stackLow = false;
      this.jumpProgress = 0;
      this.dehoistPinY = -1;
      this.laserHit = false; this.laserRemainTime = 0;
      this.constructivePositionFreeze = false;
      this.walkerPositionAdjusted = false;
      this.initialFall = false;
      this.xOld = 0; this.yOld = 0; this.dxOld = 1;
      this.actionOld = BA.NONE;
      this.actionNew = BA.NONE;
      this.portalWarpFrame = 0; this.inPortal = -1;
      this.jumpPositions = [];
      this.queueAction = BA.NONE; this.queueFrame = 0;
    }

    assign(s) {
      for (const k of Object.keys(s)) if (k !== "index" && k !== "queueAction" && k !== "queueFrame") this[k] = s[k];
    }

    get hasPermanentSkills() {
      return this.isSlider || this.isClimber || this.isSwimmer || this.isFloater || this.isGlider || this.isDisarmer;
    }
    get cannotReceiveSkills() { return this.isZombie || this.isNeutral || this.hasBeenOhnoer; }

    // what the 3D layer and the DOS-style display read
    get id() { return this.index; }
    get lookRight() { return this.dx > 0; }
    getActionName() { return ACTION_NAMES[this.action]; }
  }

  // ------------------------------------------------------------ the game

  class LemGame {
    /**
     * `level` is a built Lemmix.Level; `masks` = {bomber, stoner, basher,
     * fencer, miner, laser} bitmaps from gfx/mask.
     */
    constructor(level, masks) {
      this.level = level;
      this.masks = masks;
      this.width = level.width;
      this.height = level.height;
      this.physics = level.physics;
      this.gadgets = level.gadgets;
      this.lemmings = [];              // LemmingList
      this.sounds = [];                // cues of the current frame: {name, x, y}
      this.triggerMap = new Uint32Array(this.width * this.height);
      this.blockerMap = new Uint32Array(this.width * this.height);
      this.zombieMap = new Uint8Array(this.width * this.height);
      this.simulationDepth = 0;
      this.currentIteration = 0;
      this.clockFrame = 0;
      this.timePlay = 0;
      this.hasTimeLimit = level.timeLimitSeconds > 0;
      this.lemmingsToRelease = 0;
      this.lemmingsCloned = 0;
      this.lemmingsOut = 0;
      this.lemmingsIn = 0;
      this.lemmingsRemoved = 0;
      this.spawnedDead = 0;
      this.delayEndFrames = 0;
      this.particleFinishTimer = 0;
      this.nextLemmingCountdown = 20;
      this.hatchesOpened = false;
      this.buttonsRemain = 0;
      this.currSpawnInterval = level.spawnInterval;
      this.spawnIntervalModifier = 0;
      this.userSetNuking = false;
      this.exploderAssignInProgress = false;
      this.indexLemmingToBeNuked = 0;
      this.gameFinished = false;
      this.gameCheated = false;
      this.doneAssignmentThisFrame = false;
      this.lemNextAction = BA.NONE;
      this.lemJumpToHoistAdvance = false;
      this.lastBlockerCheckLem = null;
      this.selectedSkill = null;       // a skill name, or null
      this.activeSkills = level.skills.map((s) => s.name);
      this.currSkillCount = {};        // by action
      this.usedSkillCount = {};
      this.skillLimits = {};
      this.talismansAchieved = new Set();
      this.brickColors = [];
      this.fixedColor = null;
      this.playing = false;
      this.resultRec = null;
      this.replay = null;        // {assignments, spawnIntervals, nukes} being played back
      this.recorded = [];        // what the player did, for replay.js to write out
    }

    /** Play back a parsed replay (replay.js): its actions fire on their frames. */
    loadReplay(replay) { this.replay = replay; }

    /** CheckForReplayAction: what the replay says happens on this frame. */
    checkForReplayAction() {
      const r = this.replay;
      if (!r) return;
      const f = this.currentIteration;
      for (const c of r.spawnIntervals) if (c.frame === f) this.adjustSpawnInterval(c.interval);
      for (const n of r.nukes) if (n.frame === f) { this.userSetNuking = true; this.exploderAssignInProgress = true; }
      for (const a of r.assignments) {
        if (a.frame !== f) continue;
        let L = null;
        if (a.lemId) L = this.lemmings.find((x) => x.identifier.toUpperCase() === a.lemId) || null;
        if (!L && a.lemIndex >= 0 && a.lemIndex < this.lemmings.length) L = this.lemmings[a.lemIndex];
        const action = SKILL_TO_ACTION[a.skill];
        if (!L || action === undefined || !ASSIGNABLE.has(action)) continue;
        if (L.removed || L.teleporting || L.portalWarpFrame > 0) continue;
        if (this.mayAssign(action, L) && this.checkSkillAvailable(action)) {
          if (this.doSkillAssignment(L, action, true)) this.cueSoundEffect(SFX.ASSIGN_SKILL, L);
        }
      }
    }

    // ---- setup

    start() {
      const level = this.level;
      this.gameFinished = false;
      this.lemmingsToRelease = level.releaseCount;
      this.lemmingsCloned = 0;
      this.timePlay = this.hasTimeLimit ? level.timeLimitSeconds : 0;
      this.lemmingsOut = 0;
      this.spawnedDead = level.zombieCount;
      this.lemmingsIn = 0;
      this.lemmingsRemoved = 0;
      this.delayEndFrames = 0;
      this.currentIteration = 0;
      this.clockFrame = 0;
      this.hatchesOpened = false;
      this.spawnIntervalModifier = 0;
      this.userSetNuking = false;
      this.exploderAssignInProgress = false;
      this.indexLemmingToBeNuked = 0;
      this.particleFinishTimer = 0;
      this.lemmings = [];
      this.currSpawnInterval = level.spawnInterval;
      for (const name of SKILLS) this.currSkillCount[SKILL_TO_ACTION[name]] = 0;
      for (const s of level.skills) this.currSkillCount[SKILL_TO_ACTION[s.name]] = s.count;
      for (const name of SKILLS) this.usedSkillCount[SKILL_TO_ACTION[name]] = 0;
      this.nextLemmingCountdown = 20;
      this.buttonsRemain = 0;
      for (const g of this.gadgets) {
        g.triggered = false; g.teleLem = -1; g.holdActive = false;
        g.zombieMode = false; g.neutralMode = false; g.secondariesTreatAsBusy = false;
        if (g.effect === "BUTTON") this.buttonsRemain++;
      }
      this.initializeBrickColors(Lemmix.StyleManager.themeColor(level.theme, "MASK"));
      this.initializeAllTriggerMaps();
      this.setGadgetMap();
      this.addPreplacedLemmings();
      this.setBlockerMap();
      this.drawAnimatedGadgets();
      this.selectedSkill = this.activeSkills.length ? this.activeSkills[0] : null;
      this.playing = true;
    }

    initializeBrickColors(rgb) {
      const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
      this.brickColors = [];
      for (let i = 0; i < 12; i++) {
        const c = (v) => Math.min(Math.max(v + (i - 6) * 4, 0), 255);
        // ABGR word, the layout the level picture keeps
        this.brickColors.push((0xff << 24 | c(b) << 16 | c(g) << 8 | c(r)) >>> 0);
      }
    }

    addPreplacedLemmings() {
      for (const pre of this.level.preplaced) {
        const L = new Lemming(this.lemmings.length);
        this.lemmings.push(L);
        L.identifier = "P" + pre.x + "." + pre.y;
        L.x = pre.x; L.y = pre.y; L.dx = pre.dx;
        L.isSlider = pre.slider; L.isClimber = pre.climber; L.isSwimmer = pre.swimmer;
        L.isFloater = pre.floater; L.isGlider = pre.glider; L.isDisarmer = pre.disarmer;
        L.isNeutral = pre.neutral;
        if (!this.hasPixelAt(L.x, L.y)) this.transition(L, BA.FALLING);
        else if (pre.blocker && !this.checkForOverlappingField(L)) this.transition(L, BA.BLOCKING);
        else this.transition(L, BA.WALKING);
        if (L.action === BA.FALLING) L.initialFall = true;
        if (pre.zombie) { this.removeLemming(L, RM.ZOMBIE, true); this.spawnedDead--; }
        this.lemmingsToRelease--;
        this.lemmingsOut++;
      }
    }

    // ---- physics map access

    hasPixelAt(x, y) {
      return y >= 0 && y < this.height && x >= 0 && x < this.width && (this.physics[x + y * this.width] & PM.SOLID) !== 0;
    }
    hasSteelAt(x, y) {
      return y >= 0 && y < this.height && x >= 0 && x < this.width && (this.physics[x + y * this.width] & PM.STEEL) !== 0;
    }
    pixelBits(x, y) {
      return y >= 0 && y < this.height && x >= 0 && x < this.width ? this.physics[x + y * this.width] : 0;
    }
    removePixelAt(x, y) {
      if (y >= 0 && y < this.height && x >= 0 && x < this.width) this.physics[x + y * this.width] &= ~PM.TERRAIN;
    }
    get isSimulating() { return this.simulationDepth > 0; }

    /** RenderInterface.RemoveTerrain: the picture loses what the physics map lost. */
    removeTerrain(x0, y0, w, h) {
      if (this.isSimulating) return;
      const mask = this.level.groundMask.groundMask;
      for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y++) {
        for (let x = Math.max(0, x0); x < Math.min(this.width, x0 + w); x++) {
          const i = x + y * this.width;
          if ((this.physics[i] & PM.SOLID) === 0 && mask[i]) this.level.clearGroundAt(x, y);
        }
      }
    }

    addConstructivePixel(x, y, color) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
      this.physics[x + y * this.width] |= PM.SOLID;
      if (!this.isSimulating) this.level.setGroundAt(x, y, color);
    }

    // ---- trigger maps

    initializeAllTriggerMaps() {
      this.triggerMap.fill(0);
      this.blockerMap.fill(0);
      this.zombieMap.fill(0);
    }

    writeTriggerMap(bit, r) {
      for (let y = Math.max(0, r.y0); y < Math.min(this.height, r.y1); y++) {
        for (let x = Math.max(0, r.x0); x < Math.min(this.width, r.x1); x++) this.triggerMap[x + y * this.width] |= bit;
      }
    }

    setGadgetMap() {
      for (const g of this.gadgets) {
        const bit = EFFECT_TRIGGER[g.effect];
        if (!bit) continue;
        this.writeTriggerMap(bit, g.triggerRect);
        if (g.effect === "LOCKEXIT" && this.buttonsRemain === 0) g.currentFrame = 0;
      }
    }

    readTriggerMap(x, y, bit) {
      return x >= 0 && x < this.width && y >= 0 && y < this.height && (this.triggerMap[x + y * this.width] & bit) !== 0;
    }

    writeBlockerMap(x, y, lemIndex, effect) {
      if (x >= 0 && x < this.width && y >= 0 && y < this.height) this.blockerMap[x + y * this.width] = (lemIndex << 8) | effect;
    }

    readBlockerMap(x, y, L) {
      if (x < 0 || x >= this.width || y < 0 || y >= this.height) return BM.NONE;
      const v = this.blockerMap[x + y * this.width];
      let result = v & 0xff;
      this.lastBlockerCheckLem = result !== BM.NONE ? this.lemmings[(v >> 8) & 0xffff] : null;
      if (this.lastBlockerCheckLem) {
        const B = this.lastBlockerCheckLem;
        if (result !== BM.NONE && L && L.action === BA.BUILDING) {
          const checkPosX = B.dx === L.dx ? L.x + 2 * L.dx : L.x + 3 * L.dx;
          if (L.y >= B.y - 1 && L.y <= B.y + 3 && B.x === checkPosX) return BM.NONE;
        }
        if (this.isSimulating && (result === BM.FORCERIGHT || result === BM.FORCELEFT)) {
          if (!this.hasPixelAt(B.x, B.y)) return BM.NONE;
        }
      }
      return result;
    }

    setBlockerMap() {
      this.blockerMap.fill(0);
      this.lemmings.forEach((L, i) => {
        if (!L.hasBlockerField || L.removed) return;
        let x = L.x - 6;
        if (L.dx === 1) x++;
        for (let step = 0; step < 12; step++) {
          const effect = step <= 3 ? BM.FORCELEFT : step <= 7 ? BM.BLOCKER : BM.FORCERIGHT;
          for (let y = L.y - 6; y <= L.y + 4; y++) this.writeBlockerMap(x + step, y, i, effect);
        }
      });
    }

    readZombieMap(x, y) {
      return x >= 0 && x < this.width && y >= 0 && y < this.height ? this.zombieMap[x + y * this.width] : 0;
    }
    writeZombieMap(x, y, v) {
      if (x >= 0 && x < this.width && y >= 0 && y < this.height) this.zombieMap[x + y * this.width] |= v;
    }
    setZombieField(L) {
      for (let x = L.x - 5; x <= L.x + 5; x++) for (let y = L.y - 6; y <= L.y + 4; y++) this.writeZombieMap(x, y, 1);
      for (let y = L.y - 6; y <= L.y + 4; y++) this.writeZombieMap(L.x + L.dx * 6, y, 1);
    }

    checkForOverlappingField(L) {
      let x = L.x - 6;
      if (L.dx === 1) x++;
      return this.hasTriggerAt(x, L.y - 6, "BLOCKER") || this.hasTriggerAt(x + 11, L.y - 6, "BLOCKER")
        || this.hasTriggerAt(x, L.y + 4, "BLOCKER") || this.hasTriggerAt(x + 11, L.y + 4, "BLOCKER");
    }

    /** HasTriggerAt, by the TTriggerTypes name. */
    hasTriggerAt(x, y, type, L) {
      this.lastBlockerCheckLem = null;
      switch (type) {
        case "EXIT": return this.readTriggerMap(x, y, TR.EXIT) || (this.buttonsRemain === 0 && this.readTriggerMap(x, y, TR.LOCKEDEXIT));
        case "FORCELEFT": return this.readBlockerMap(x, y, L) === BM.FORCELEFT || this.readTriggerMap(x, y, TR.FORCELEFT);
        case "FORCERIGHT": return this.readBlockerMap(x, y, L) === BM.FORCERIGHT || this.readTriggerMap(x, y, TR.FORCERIGHT);
        case "TRAP": return this.readTriggerMap(x, y, TR.TRAP);
        case "ANIM": return this.readTriggerMap(x, y, TR.ANIM);
        case "WATER": return this.readTriggerMap(x, y, TR.WATER);
        case "FIRE": return this.readTriggerMap(x, y, TR.FIRE);
        case "OWLEFT": return (this.pixelBits(x, y) & PM.ONEWAYLEFT) !== 0;
        case "OWRIGHT": return (this.pixelBits(x, y) & PM.ONEWAYRIGHT) !== 0;
        case "OWDOWN": return (this.pixelBits(x, y) & PM.ONEWAYDOWN) !== 0;
        case "OWUP": return (this.pixelBits(x, y) & PM.ONEWAYUP) !== 0;
        case "STEEL": return (this.pixelBits(x, y) & PM.STEEL) !== 0;
        case "BLOCKER": { const b = this.readBlockerMap(x, y); return b === BM.BLOCKER || b === BM.FORCERIGHT || b === BM.FORCELEFT; }
        case "TELEPORT": return this.readTriggerMap(x, y, TR.TELEPORT);
        case "PICKUP": return this.readTriggerMap(x, y, TR.PICKUP);
        case "BUTTON": return this.readTriggerMap(x, y, TR.BUTTON);
        case "UPDRAFT": return this.readTriggerMap(x, y, TR.UPDRAFT);
        case "FLIPPER": return this.readTriggerMap(x, y, TR.FLIPPER);
        case "NOSPLAT": return this.readTriggerMap(x, y, TR.NOSPLAT);
        case "SPLAT": return this.readTriggerMap(x, y, TR.SPLAT);
        case "PORTAL": return this.readTriggerMap(x, y, TR.PORTAL);
        case "NEUTRALIZER": return this.readTriggerMap(x, y, TR.NEUTRALIZER);
        case "DENEUTRALIZER": return this.readTriggerMap(x, y, TR.DENEUTRALIZER);
        case "ADDSKILL": return this.readTriggerMap(x, y, TR.ADDSKILL);
        case "REMOVESKILLS": return this.readTriggerMap(x, y, TR.REMOVESKILLS);
        case "ZOMBIE": return (this.readZombieMap(x, y) & 1) !== 0;
      }
      return false;
    }

    hasIndestructibleAt(x, y, direction, skill) {
      return this.hasTriggerAt(x, y, "STEEL")
        || (this.hasTriggerAt(x, y, "OWUP") && inSet(skill, [BA.BASHING, BA.MINING, BA.DIGGING]))
        || (this.hasTriggerAt(x, y, "OWDOWN") && inSet(skill, [BA.BASHING, BA.FENCING, BA.LASERING]))
        || (this.hasTriggerAt(x, y, "OWLEFT") && direction === 1 && inSet(skill, [BA.BASHING, BA.FENCING, BA.MINING, BA.LASERING]))
        || (this.hasTriggerAt(x, y, "OWRIGHT") && direction === -1 && inSet(skill, [BA.BASHING, BA.FENCING, BA.MINING, BA.LASERING]));
    }

    /** FindGadgetID: the last-listed usable gadget of this trigger type at (x, y). */
    findGadgetId(x, y, triggerType) {
      const bit = { TRAP: TR.TRAP, ANIM: TR.ANIM, TELEPORT: TR.TELEPORT, PICKUP: TR.PICKUP, BUTTON: TR.BUTTON,
        EXIT: TR.EXIT | TR.LOCKEDEXIT, FLIPPER: TR.FLIPPER, PORTAL: TR.PORTAL, ADDSKILL: TR.ADDSKILL }[triggerType];
      for (let id = this.gadgets.length - 1; id >= 0; id--) {
        const g = this.gadgets[id];
        let found = false;
        if ((EFFECT_TRIGGER[g.effect] & bit) !== 0) {
          const r = g.triggerRect;
          if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) found = true;
        }
        if (g.effect === "LOCKEXIT" && this.buttonsRemain !== 0) found = false;
        if ((g.effect === "EXIT" || g.effect === "LOCKEXIT") && g.remainingLemmings === 0) found = false;
        if (g.triggered) found = false;
        if ((g.effect === "BUTTON" || g.effect === "TRAPONCE" || g.effect === "ANIMONCE") && g.currentFrame === 0) found = false;
        if (g.effect === "PICKUP" && g.currentFrame % 2 === 0) found = false;
        if (g.effect === "TELEPORT" && g.receiverId >= 0 &&
          (this.gadgets[g.receiverId].triggered || this.gadgets[g.receiverId].holdActive)) found = false;
        if (found) return id;
      }
      return NO_OBJECT;
    }

    // ---- sounds

    cueSoundEffect(name, pos) {
      if (this.isSimulating || !name) return;
      if (this.sounds.some((s) => s.name === name)) return;
      this.sounds.push({ name, x: pos ? pos.x : null, y: pos ? pos.y : null });
    }

    // ---- transitions

    turnAround(L) { L.dx = -L.dx; }

    transition(L, newAction, doTurn) {
      if (doTurn) this.turnAround(L);
      if (newAction === BA.TOWALKING) newAction = BA.WALKING;
      if (L.hasBlockerField && !(newAction === BA.OHNOING || newAction === BA.STONING)) {
        L.hasBlockerField = false;
        this.setBlockerMap();
      }
      if (!this.hasPixelAt(L.x, L.y) && newAction === BA.WALKING) newAction = BA.FALLING;
      if (L.action === newAction) return;
      if (newAction === BA.FALLING) {
        if (L.action !== BA.SWIMMING) {
          L.fallen = 1;
          if (L.action === BA.WALKING || L.action === BA.BASHING) L.fallen = 3;
          else if (L.action === BA.MINING || L.action === BA.DIGGING) L.fallen = 0;
          else if (L.action === BA.BLOCKING || L.action === BA.JUMPING || L.action === BA.LASERING) L.fallen = -1;
        }
        L.trueFallen = L.fallen;
      }
      if (((newAction === BA.SHIMMYING || newAction === BA.JUMPING) && L.action === BA.CLIMBING) ||
          (newAction === BA.JUMPING && L.action === BA.SLIDING)) {
        this.turnAround(L);
        L.x += L.dx;
        if (newAction === BA.SHIMMYING && this.hasPixelAt(L.x, L.y - 8)) L.y++;
      }
      if (newAction === BA.SHIMMYING && L.action === BA.SLIDING) { L.y += 2; if (this.hasPixelAt(L.x, L.y - 8)) L.y++; }
      if (newAction === BA.SHIMMYING && L.action === BA.DEHOISTING) { L.y += 2; if (this.hasPixelAt(L.x, L.y - 9 + 1)) L.y++; }
      if (newAction === BA.SHIMMYING && L.action === BA.JUMPING) {
        for (let i = -1; i <= 3; i++) {
          if (this.hasPixelAt(L.x, L.y - 9 - i) && !this.hasPixelAt(L.x, L.y - 8 - i)) { L.y -= i; break; }
        }
      }
      if (newAction === BA.DEHOISTING) L.dehoistPinY = L.y;
      if (newAction === BA.SLIDING) L.dehoistPinY = -1;

      L.action = newAction;
      L.frame = 0;
      L.physicsFrame = 0;
      L.endOfAnimation = false;
      L.bricksLeft = 0;
      const oldIsStartingAction = L.isStartingAction;
      L.isStartingAction = true;
      L.initialFall = false;
      L.maxFrame = -1;
      L.maxPhysicsFrame = ANIM_FRAMECOUNT[newAction] - 1;

      switch (L.action) {
        case BA.ASCENDING: L.ascended = 0; break;
        case BA.HOISTING: L.isStartingAction = oldIsStartingAction; break;
        case BA.SPLATTING: L.explosionTimer = 0; this.cueSoundEffect(SFX.SPLAT, L); break;
        case BA.BLOCKING: L.hasBlockerField = true; this.setBlockerMap(); break;
        case BA.EXITING:
          if (!this.isOutOfTime) L.explosionTimer = 0;
          this.cueSoundEffect(SFX.YIPPEE, L);
          break;
        case BA.VAPORIZING: L.explosionTimer = 0; break;
        case BA.BUILDING: L.bricksLeft = 12; L.constructivePositionFreeze = false; break;
        case BA.PLATFORMING: L.bricksLeft = 12; L.constructivePositionFreeze = false; break;
        case BA.STACKING: L.bricksLeft = 8; break;
        case BA.OHNOING: case BA.STONING:
          this.cueSoundEffect(SFX.OHNO, L);
          L.isSlider = L.isClimber = L.isSwimmer = L.isFloater = L.isGlider = L.isDisarmer = false;
          L.hasBeenOhnoer = true;
          break;
        case BA.EXPLODING: case BA.STONEFINISH: this.cueSoundEffect(SFX.EXPLOSION, L); break;
        case BA.SWIMMING: {
          let i = 0;
          while (i < 4 && this.hasTriggerAt(L.x, L.y - i - 1, "WATER") && !this.hasPixelAt(L.x, L.y - i - 1)) i++;
          L.y -= i;
          break;
        }
        case BA.FIXING: L.disarmingFrames = 42; break;
        case BA.JUMPING: L.jumpProgress = 0; break;
        case BA.LASERING: L.laserRemainTime = 10; break;
      }
    }

    updateExplosionTimer(L) {
      L.explosionTimer--;
      if (L.explosionTimer === 0) {
        if (inSet(L.action, [BA.VAPORIZING, BA.DROWNING, BA.FLOATING, BA.GLIDING, BA.FALLING, BA.SWIMMING, BA.REACHING, BA.SHIMMYING, BA.JUMPING])) {
          this.transition(L, L.timerToStone ? BA.STONEFINISH : BA.EXPLODING);
        } else {
          this.transition(L, L.timerToStone ? BA.STONING : BA.OHNOING);
        }
        return true;
      }
      return false;
    }

    get isOutOfTime() {
      return this.hasTimeLimit && (this.timePlay < 0 || (this.timePlay === 0 && this.clockFrame > 0));
    }

    get stateIsUnplayable() {
      return this.lemmingsOut === 0 && (this.lemmingsToRelease === 0 || this.userSetNuking)
        && this.delayEndFrames === 0 && this.particleFinishTimer === 0
        && !(this.userSetNuking && this.checkIfZombiesRemain());
    }

    // ---- skills

    checkSkillAvailable(action) {
      const name = ACTION_TO_SKILL[action];
      return !!name && this.activeSkills.indexOf(name) >= 0 && this.currSkillCount[action] > 0;
    }

    updateSkillCount(action, amount) {
      if (amount === undefined) amount = -1;
      if (this.currSkillCount[action] < 100) this.currSkillCount[action] = Math.max(Math.min(this.currSkillCount[action] + amount, 99), 0);
      if (amount < 0) this.usedSkillCount[action] += -amount;
    }

    skillCount(name) { return this.currSkillCount[SKILL_TO_ACTION[name]] || 0; }
    skillsUsed(name) { return this.usedSkillCount[SKILL_TO_ACTION[name]] || 0; }

    mayAssign(action, L) {
      const A = BA;
      const dying = [A.OHNOING, A.STONING, A.EXPLODING, A.STONEFINISH, A.DROWNING, A.VAPORIZING, A.SPLATTING, A.EXITING];
      switch (action) {
        case A.TOWALKING: return inSet(L.action, [A.WALKING, A.SHRUGGING, A.BLOCKING, A.PLATFORMING, A.BUILDING, A.STACKING, A.BASHING, A.FENCING, A.MINING, A.DIGGING, A.REACHING, A.SHIMMYING, A.LASERING]);
        case A.SLIDING: return !inSet(L.action, dying) && !L.isSlider;
        case A.CLIMBING: return !inSet(L.action, dying) && !L.isClimber;
        case A.FLOATING: case A.GLIDING: return !inSet(L.action, dying) && !(L.isFloater || L.isGlider);
        case A.SWIMMING: return !inSet(L.action, [A.OHNOING, A.STONING, A.EXPLODING, A.STONEFINISH, A.VAPORIZING, A.SPLATTING, A.EXITING]) && !L.isSwimmer;
        case A.FIXING: return !inSet(L.action, dying) && !L.isDisarmer;
        case A.BLOCKING: return inSet(L.action, [A.WALKING, A.SHRUGGING, A.PLATFORMING, A.BUILDING, A.STACKING, A.BASHING, A.FENCING, A.MINING, A.DIGGING, A.LASERING]) && !this.checkForOverlappingField(L);
        case A.EXPLODING: case A.STONING: return !inSet(L.action, [A.OHNOING, A.STONING, A.DROWNING, A.EXPLODING, A.STONEFINISH, A.VAPORIZING, A.SPLATTING, A.EXITING]);
        case A.BUILDING: return inSet(L.action, [A.WALKING, A.SHRUGGING, A.PLATFORMING, A.STACKING, A.LASERING, A.BASHING, A.FENCING, A.MINING, A.DIGGING]);
        case A.PLATFORMING: {
          let r = false;
          for (let n = 0; n <= 5; n++) r = r || !this.hasPixelAt(L.x + n * L.dx, L.y);
          return r && inSet(L.action, [A.WALKING, A.SHRUGGING, A.BUILDING, A.STACKING, A.BASHING, A.FENCING, A.MINING, A.DIGGING, A.LASERING]) && this.lemCanPlatform(L);
        }
        case A.STACKING: return inSet(L.action, [A.WALKING, A.SHRUGGING, A.PLATFORMING, A.BUILDING, A.BASHING, A.FENCING, A.MINING, A.DIGGING, A.LASERING]);
        case A.BASHING: return inSet(L.action, [A.WALKING, A.SHRUGGING, A.PLATFORMING, A.BUILDING, A.STACKING, A.FENCING, A.MINING, A.DIGGING, A.LASERING]);
        case A.FENCING: return inSet(L.action, [A.WALKING, A.SHRUGGING, A.PLATFORMING, A.BUILDING, A.STACKING, A.BASHING, A.MINING, A.DIGGING, A.LASERING]);
        case A.MINING: return inSet(L.action, [A.WALKING, A.SHRUGGING, A.PLATFORMING, A.BUILDING, A.STACKING, A.BASHING, A.FENCING, A.DIGGING, A.LASERING]) && !this.hasIndestructibleAt(L.x, L.y, L.dx, A.MINING);
        case A.DIGGING: return inSet(L.action, [A.WALKING, A.SHRUGGING, A.PLATFORMING, A.BUILDING, A.STACKING, A.BASHING, A.FENCING, A.MINING, A.LASERING]) && !this.hasIndestructibleAt(L.x, L.y, L.dx, A.DIGGING);
        case A.CLONING: return inSet(L.action, [A.WALKING, A.SHRUGGING, A.PLATFORMING, A.BUILDING, A.STACKING, A.BASHING, A.FENCING, A.MINING, A.DIGGING, A.ASCENDING, A.FALLING, A.FLOATING, A.SWIMMING, A.GLIDING, A.FIXING, A.REACHING, A.SHIMMYING, A.JUMPING, A.LASERING]);
        case A.SHIMMYING: return this.mayAssignShimmier(L);
        case A.JUMPING: return inSet(L.action, [A.WALKING, A.DIGGING, A.BUILDING, A.BASHING, A.MINING, A.SHRUGGING, A.PLATFORMING, A.STACKING, A.FENCING, A.CLIMBING, A.SLIDING, A.LASERING]);
        case A.LASERING: return inSet(L.action, [A.WALKING, A.SHRUGGING, A.PLATFORMING, A.BUILDING, A.STACKING, A.BASHING, A.FENCING, A.MINING, A.DIGGING]);
      }
      return false;
    }

    mayAssignShimmier(L) {
      const A = BA;
      let result = inSet(L.action, [A.WALKING, A.SHRUGGING, A.PLATFORMING, A.BUILDING, A.STACKING, A.BASHING, A.FENCING, A.MINING, A.DIGGING, A.LASERING]);
      if (L.action === A.CLIMBING) {
        const copy = new Lemming(L.index); copy.assign(L); copy.isPhysicsSimulation = true;
        const saved = this.physics.slice();
        this.simulateLem(copy, false);
        this.physics.set(saved);
        if ((copy.action === A.FALLING && copy.dx === -L.dx) || copy.action === A.SLIDING) {
          if (this.hasPixelAt(copy.x, copy.y - 9) || this.hasPixelAt(copy.x, copy.y - 8)) result = true;
        }
      } else if (L.action === A.SLIDING || L.action === A.DEHOISTING) {
        const copy = new Lemming(L.index); copy.assign(L); copy.isPhysicsSimulation = true;
        const old = copy.action;
        const saved = this.physics.slice();
        this.simulateLem(copy, false);
        this.physics.set(saved);
        if (copy.action !== old && copy.dx === L.dx && (old !== A.DEHOISTING || copy.action !== A.SLIDING)) {
          result = L.y > this.height + 4 ? !this.hasPixelAt(L.x, this.height - 1) : true;
        }
      } else if (L.action === A.JUMPING) {
        for (let i = -1; i <= 3; i++) {
          if (this.hasPixelAt(L.x, L.y - 9 - i) && !this.hasPixelAt(L.x, L.y - 8 - i)) { result = true; break; }
        }
      }
      return result;
    }

    /** DoSkillAssignment: the skill goes to this lemming now. */
    doSkillAssignment(L, newSkill, fromReplay) {
      if (!this.checkSkillAvailable(newSkill)) return false;
      if (this.doneAssignmentThisFrame) return false;
      if (!fromReplay) this.recorded.push({ type: "assignment", frame: this.currentIteration, skill: ACTION_TO_SKILL[newSkill],
        lemIndex: L.index, lemId: L.identifier, x: L.x, y: L.y, dx: L.dx });
      this.updateSkillCount(newSkill);
      L.queueAction = BA.NONE; L.queueFrame = 0;
      if (newSkill === BA.STACKING) L.stackLow = !this.hasPixelAt(L.x + L.dx, L.y);
      if (newSkill === BA.TOWALKING && L.action === BA.BUILDING && this.hasPixelAt(L.x, L.y - 1) && !this.hasPixelAt(L.x + L.dx, L.y)) L.y--;
      if (newSkill === BA.TOWALKING && L.action === BA.WALKING) {
        this.turnAround(L);
        if ((this.hasTriggerAt(L.x, L.y, "FORCERIGHT", L) && L.dx === -1) || (this.hasTriggerAt(L.x, L.y, "FORCELEFT", L) && L.dx === 1)) {
          if (this.hasPixelAt(L.x, L.y)) { L.walkerPositionAdjusted = true; L.x -= L.dx; }
        }
      }
      if (newSkill === BA.SLIDING) L.isSlider = true;
      else if (newSkill === BA.CLIMBING) L.isClimber = true;
      else if (newSkill === BA.FLOATING) L.isFloater = true;
      else if (newSkill === BA.GLIDING) L.isGlider = true;
      else if (newSkill === BA.FIXING) L.isDisarmer = true;
      else if (newSkill === BA.SWIMMING) {
        L.isSwimmer = true;
        if (L.action === BA.DROWNING) this.transition(L, BA.SWIMMING);
      } else if (newSkill === BA.EXPLODING) {
        L.explosionTimer = 1; L.timerToStone = false; L.hideCountdown = true;
      } else if (newSkill === BA.STONING) {
        L.explosionTimer = 1; L.timerToStone = true; L.hideCountdown = true;
      } else if (newSkill === BA.CLONING) {
        this.lemmingsCloned++;
        this.generateClonedLem(L);
      } else if (newSkill === BA.SHIMMYING) {
        this.transition(L, inSet(L.action, [BA.CLIMBING, BA.SLIDING, BA.JUMPING, BA.DEHOISTING]) ? BA.SHIMMYING : BA.REACHING);
      } else this.transition(L, newSkill);
      this.doneAssignmentThisFrame = true;
      return true;
    }

    generateClonedLem(L) {
      const N = new Lemming(this.lemmings.length);
      N.assign(L);
      N.identifier = "C" + this.currentIteration;
      this.lemmings.push(N);
      this.turnAround(N);
      this.lemmingsOut++;
      if (N.action === BA.MINING) {
        if (N.physicsFrame === 2) this.applyMinerMask(N, 1, 0, 0);
        else if (N.physicsFrame >= 3 && N.physicsFrame < 15) this.applyMinerMask(N, 1, -2 * N.dx, -1);
      } else if ((N.action === BA.BUILDING || N.action === BA.PLATFORMING) && N.physicsFrame >= 9) this.layBrick(N);
    }

    /**
     * GetPriorityLemming: the lemming a click at (x, y) means, for the
     * selected skill (or any skill when `action` is NONE). Returns
     * {lemming, count} where count is how many lemmings sit under the cursor.
     */
    getPriorityLemming(action, mx, my) {
      const NonPerm = 0, Perm = 1, NonWalk = 2, Walk = 3;
      let priority = null, curValue = 10, count = 0;
      let newSkill = action;
      if (newSkill === BA.NONE) newSkill = this.selectedSkill ? SKILL_TO_ACTION[this.selectedSkill] : BA.EXPLODING;
      const inCursor = (L) => mx >= L.x - 8 && mx < L.x + 5 && my >= L.y - 10 && my < L.y + 3;
      const dist = (L) => { const a = 2 * (L.x - 8) - 2 * mx + 13, b = 2 * (L.y - 10) - 2 * my + 13; return a * a + b * b; };
      const inBox = (L, box) => {
        switch (box) {
          case Perm: return L.hasPermanentSkills;
          case NonPerm: return inSet(L.action, [BA.BASHING, BA.FENCING, BA.MINING, BA.DIGGING, BA.BUILDING, BA.PLATFORMING, BA.STACKING, BA.BLOCKING, BA.SHRUGGING, BA.REACHING, BA.SHIMMYING, BA.LASERING]);
          case Walk: return L.action === BA.WALKING || L.action === BA.ASCENDING;
          case NonWalk: return !(L.action === BA.WALKING || L.action === BA.ASCENDING);
        }
        return true;
      };
      for (let i = this.lemmings.length - 1; i >= 0; i--) {
        const L = this.lemmings[i];
        if (L.removed || L.teleporting || L.portalWarpFrame > 0) continue;
        if (L.cannotReceiveSkills && priority) continue;
        if (!inCursor(L)) continue;
        if (!L.cannotReceiveSkills) count++;
        let box = 0, isIn;
        do { isIn = inBox(L, box); box++; } while (!(box > Math.min(curValue, 4) || isIn));
        if (!this.mayAssign(newSkill, L)) box = 8;
        if (L.cannotReceiveSkills) box = 9;
        if (box < curValue || (box === curValue && dist(L) < dist(priority))) { priority = L; curValue = box; }
      }
      if (curValue > 6 && action !== BA.NONE) priority = null;
      return { lemming: priority, count };
    }

    // ---- trigger areas

    getGadgetCheckPositions(L) {
      const out = [];
      let cx = L.xOld, cy = L.yOld;
      const save = () => out.push([cx, cy]);
      const moveH = () => { while (cx !== L.x) { cx += Math.sign(L.x - cx); save(); } };
      const moveV = () => { while (cy !== L.y) { cy += Math.sign(L.y - cy); save(); } };
      if (L.x === L.xOld && L.y === L.yOld) save();
      else {
        if (L.actionOld === BA.JUMPING) {
          for (const p of L.jumpPositions) { if (p[0] < 0 || p[1] < 0) break; cx = p[0]; cy = p[1]; save(); }
        }
      }
      if (L.x === L.xOld && L.y === L.yOld) { /* saved above */ }
      else if (L.actionOld === BA.MINING) {
        if (L.yOld < L.y) { cy++; save(); }
        moveH(); moveV();
      } else if ((L.y < L.yOld || L.action === BA.FALLING) && L.actionOld !== BA.BUILDING) { moveH(); moveV(); }
      else { moveV(); moveH(); }
      return out;
    }

    checkTriggerArea(L, isPostTeleportCheck) {
      let saveX = 0, saveY = 0;
      if (isPostTeleportCheck) { L.xOld = L.x; L.yOld = L.y; saveX = L.x; saveY = L.y; }
      const pos = this.getGadgetCheckPositions(L);
      let i = -1, abort = false, needShift = 0;
      do {
        i++;
        const px = pos[i][0], py = pos[i][1];
        if (this.lemNextAction !== BA.NONE && px === L.x && py === L.y
          && (this.lemNextAction !== BA.SPLATTING || !this.hasTriggerAt(L.x, L.y, "WATER"))) {
          this.transition(L, this.lemNextAction);
          if (this.lemJumpToHoistAdvance) { L.frame += 2; L.physicsFrame += 2; }
          this.lemNextAction = BA.NONE;
          this.lemJumpToHoistAdvance = false;
        }
        if (this.hasTriggerAt(px, py, "PICKUP")) this.handlePickup(L, px, py);
        if (this.hasTriggerAt(px, py, "BUTTON")) this.handleButton(L, px, py);
        if (this.hasTriggerAt(px, py, "FIRE")) abort = this.handleFire(L);
        if (!abort && this.hasTriggerAt(px, py, "WATER")) abort = this.handleWaterDrown(L);
        if (!abort && this.hasTriggerAt(px, py, "TRAP")) {
          abort = this.handleTrap(L, px, py);
          if (L.action === BA.FIXING) pos[i][0] = L.x;
        }
        if (!abort && this.hasTriggerAt(px, py, "PORTAL") && !isPostTeleportCheck) abort = this.handlePortal(L, px, py);
        if (!abort && this.hasTriggerAt(px, py, "TELEPORT") && !isPostTeleportCheck) abort = this.handleTeleport(L, px, py);
        if (!abort && this.hasTriggerAt(px, py, "NEUTRALIZER")) this.handleNeutralize(L);
        if (!abort && this.hasTriggerAt(px, py, "DENEUTRALIZER")) this.handleDeneutralize(L);
        if (!abort && this.hasTriggerAt(px, py, "ADDSKILL")) this.handleAddSkill(L, px, py);
        if (!abort && this.hasTriggerAt(px, py, "REMOVESKILLS")) {
          const wasOnWall = inSet(L.action, [BA.CLIMBING, BA.SLIDING, BA.DEHOISTING]);
          abort = this.handleRemoveSkills(L);
          if (wasOnWall && abort) needShift = -1;
        }
        if (!abort && this.hasTriggerAt(px, py, "EXIT")) abort = this.handleExit(L, px, py);
        if (!abort && this.hasTriggerAt(px, py, "FLIPPER") && L.action !== BA.BLOCKING
          && !(L.actionOld === BA.JUMPING || L.action === BA.JUMPING)) {
          const wasOnWall = inSet(L.action, [BA.CLIMBING, BA.SLIDING, BA.DEHOISTING]);
          abort = this.handleFlipper(L, px, py);
          if (wasOnWall && abort) needShift = L.dx;
        }
        if (!abort && this.hasTriggerAt(px, py, "ANIM")) this.handleAnimation(L, px, py);
        if (abort) { L.x = pos[i][0]; L.y = pos[i][1]; }
        if (!this.hasTriggerAt(pos[i][0], pos[i][1], "FLIPPER") && !(L.actionOld === BA.JUMPING || L.action === BA.JUMPING)) L.inFlipper = NO_OBJECT;
        if (!this.hasTriggerAt(pos[i][0], pos[i][1], "PORTAL")) L.inPortal = NO_OBJECT;
      } while (!(pos[i][0] === L.x && pos[i][1] === L.y) && i < pos.length - 1);
      L.x += L.dx * needShift;
      if (this.hasTriggerAt(L.x, L.y, "WATER")) this.handleWaterSwim(L);
      if ((L.action !== BA.MINING || !(L.physicsFrame === 1 || L.physicsFrame === 2)) && L.action !== BA.JUMPING) {
        if (this.hasTriggerAt(L.x, L.y, "FORCELEFT", L)) this.handleForceField(L, -1);
        else if (this.hasTriggerAt(L.x, L.y, "FORCERIGHT", L)) this.handleForceField(L, 1);
      }
      if (isPostTeleportCheck) { L.x = saveX; L.y = saveY; }
    }

    handleTrap(L, px, py) {
      const id = this.findGadgetId(px, py, "TRAP");
      if (id === NO_OBJECT) return false;
      const g = this.gadgets[id];
      if (L.isDisarmer && this.hasPixelAt(px, py) && !inSet(L.action, [BA.DEHOISTING, BA.SLIDING, BA.CLIMBING, BA.HOISTING, BA.SWIMMING, BA.OHNOING, BA.JUMPING])) {
        L.actionNew = (L.yOld > L.y && this.hasPixelAt(px, py + 1)) ? BA.ASCENDING : BA.WALKING;
        g.effect = "NONE";
        this.transition(L, BA.FIXING);
      } else {
        g.triggered = true;
        g.zombieMode = L.isZombie;
        g.neutralMode = L.isNeutral;
        L.hasBlockerField = false;
        this.setBlockerMap();
        this.removeLemming(L, RM.KILL);
        this.cueSoundEffect(g.meta.soundActivate, L);
        this.delayEndFrames = Math.max(this.delayEndFrames, g.frameCount);
        if (g.effect === "TRAPONCE") g.effect = "NONE";
      }
      return true;
    }

    handleAnimation(L, px, py) {
      const id = this.findGadgetId(px, py, "ANIM");
      if (id === NO_OBJECT) return false;
      const g = this.gadgets[id];
      g.triggered = true;
      this.cueSoundEffect(g.meta.soundActivate, L);
      if (g.effect === "ANIMONCE") g.effect = "NONE";
      return false;
    }

    handleTeleport(L, px, py) {
      if (L.action === BA.SPLATTING) return false;
      if (L.action === BA.FALLING && this.hasPixelAt(px, py) && L.fallen > MAX_FALLDISTANCE) return false;
      const id = this.findGadgetId(px, py, "TELEPORT");
      if (id === NO_OBJECT) return false;
      const g = this.gadgets[id];
      g.triggered = true;
      g.zombieMode = L.isZombie; g.neutralMode = L.isNeutral;
      this.cueSoundEffect(g.meta.soundActivate, L);
      L.teleporting = true;
      g.teleLem = L.index;
      L.hasBlockerField = false;
      L.dehoistPinY = -1;
      this.setBlockerMap();
      this.gadgets[g.receiverId].holdActive = true;
      return true;
    }

    handlePortal(L, px, py) {
      if (L.action === BA.SPLATTING) return false;
      if (L.action === BA.FALLING && this.hasPixelAt(px, py) && L.fallen > MAX_FALLDISTANCE) return false;
      const id = this.findGadgetId(px, py, "PORTAL");
      if (id === NO_OBJECT || id === L.inPortal) return false;
      this.cueSoundEffect(SFX.PORTAL, L);
      L.portalWarpFrame = 1;
      L.hasBlockerField = false;
      L.dehoistPinY = -1;
      this.setBlockerMap();
      return true;
    }

    checkLemPortalWarping(L) {
      L.portalWarpFrame++;
      if (L.portalWarpFrame === 4) {
        const id = this.findGadgetId(L.x, L.y, "PORTAL");
        if (id === NO_OBJECT) return false;
        const g = this.gadgets[id];
        if (g.effect !== "PORTAL" || g.receiverId < 0) return false;
        const dest = this.gadgets[g.receiverId];
        L.x = dest.triggerRect.x0 + (((dest.triggerRect.x1 - dest.triggerRect.x0) + 1) >> 1) - 1;
        L.y = dest.triggerRect.y1 - 1;
        L.inPortal = g.receiverId;
        this.handlePostTeleport(L);
      } else if (L.portalWarpFrame >= 7) L.portalWarpFrame = 0;
      return false;
    }

    handlePickup(L, px, py) {
      const id = this.findGadgetId(px, py, "PICKUP");
      if (id === NO_OBJECT) return false;
      if (!L.isZombie) {
        const g = this.gadgets[id];
        g.currentFrame = g.currentFrame & ~1;
        this.cueSoundEffect(SFX.PICKUP, L);
        this.updateSkillCount(SKILL_TO_ACTION[g.skillName], g.skillCount);
      }
      return false;
    }

    handleButton(L, px, py) {
      const id = this.findGadgetId(px, py, "BUTTON");
      if (id === NO_OBJECT) return false;
      if (!L.isZombie) {
        const g = this.gadgets[id];
        this.cueSoundEffect(g.meta.soundActivate, L);
        g.triggered = true;
        this.buttonsRemain--;
        if (this.buttonsRemain === 0) {
          for (const e of this.gadgets) {
            if (e.effect !== "LOCKEXIT") continue;
            e.triggered = true;
            this.cueSoundEffect(e.meta.soundActivate || SFX.EXIT_OPEN, { x: e.x + (e.width >> 1), y: e.y + (e.height >> 1) });
          }
        }
      }
      return false;
    }

    handleExit(L, px, py) {
      if (!L.isZombie && !inSet(L.action, [BA.FALLING, BA.SPLATTING, BA.JUMPING, BA.REACHING])
        && (this.hasPixelAt(L.x, L.y) || !(L.action === BA.OHNOING || L.action === BA.STONING))) {
        if (this.isOutOfTime && this.userSetNuking && L.action === BA.OHNOING) return false;
        const id = this.findGadgetId(px, py, "EXIT");
        if (id === NO_OBJECT) return false;
        const g = this.gadgets[id];
        if (g.remainingLemmings > 0) {
          g.remainingLemmings--;
          if (g.remainingLemmings === 0) this.cueSoundEffect(g.meta.soundExhaust, { x: g.x, y: g.y });
        }
        this.transition(L, BA.EXITING);
        this.cueSoundEffect(SFX.YIPPEE, L);
        return true;
      }
      return false;
    }

    handleForceField(L, direction) {
      if (L.dx === -direction && !(L.action === BA.DEHOISTING || L.action === BA.HOISTING)) {
        this.turnAround(L);
        if (L.isZombie && this.lastBlockerCheckLem && !this.lastBlockerCheckLem.isZombie) this.removeLemming(this.lastBlockerCheckLem, RM.ZOMBIE);
        if (L.action === BA.MINING) {
          if (L.physicsFrame === 2) this.applyMinerMask(L, 1, 0, 0);
          else if (L.physicsFrame >= 3 && L.physicsFrame < 15) this.applyMinerMask(L, 1, -2 * L.dx, -1);
        } else if ((L.action === BA.BUILDING || L.action === BA.PLATFORMING) && L.physicsFrame >= 9) this.layBrick(L);
        else if (inSet(L.action, [BA.CLIMBING, BA.SLIDING, BA.DEHOISTING])) {
          L.x += L.dx;
          if (!L.isStartingAction) L.y++;
          this.transition(L, BA.WALKING);
        }
        return true;
      }
      return false;
    }

    handleFire(L) {
      this.transition(L, BA.VAPORIZING);
      this.cueSoundEffect(SFX.VAPORIZING, L);
      return true;
    }

    handleFlipper(L, px, py) {
      const id = this.findGadgetId(px, py, "FLIPPER");
      if (id === NO_OBJECT) return false;
      const g = this.gadgets[id];
      let result = false;
      if (L.inFlipper !== id) {
        L.inFlipper = id;
        if ((g.currentFrame === 1) !== (L.dx < 0)) result = this.handleForceField(L, -L.dx);
        if (!this.isSimulating) g.currentFrame = 1 - g.currentFrame;
      }
      return result;
    }

    handleWaterDrown(L) {
      if (L.isSwimmer) return false;
      if (!inSet(L.action, [BA.SWIMMING, BA.EXPLODING, BA.STONEFINISH, BA.VAPORIZING, BA.EXITING, BA.SPLATTING])) {
        this.transition(L, BA.DROWNING);
        this.cueSoundEffect(SFX.DROWNING, L);
      }
      return true;
    }

    handleWaterSwim(L) {
      if (L.isSwimmer && !inSet(L.action, [BA.SWIMMING, BA.CLIMBING, BA.HOISTING, BA.OHNOING, BA.EXPLODING, BA.STONING, BA.STONEFINISH, BA.VAPORIZING, BA.EXITING, BA.SPLATTING])) {
        this.transition(L, BA.SWIMMING);
        this.cueSoundEffect(SFX.SWIMMING, L);
      }
      return true;
    }

    handleAddSkill(L, px, py) {
      if (L.hasBeenOhnoer) return false;
      const id = this.findGadgetId(px, py, "ADDSKILL");
      if (id === NO_OBJECT) return false;
      const s = this.gadgets[id].skillName;
      const give = () => this.cueSoundEffect(SFX.ADD_SKILL, L);
      if (s === "SLIDER" && !L.isSlider) { L.isSlider = true; give(); }
      if (s === "CLIMBER" && !L.isClimber) { L.isClimber = true; give(); }
      if (s === "SWIMMER" && !L.isSwimmer) { L.isSwimmer = true; give(); if (L.action === BA.DROWNING) this.transition(L, BA.SWIMMING); }
      if (s === "FLOATER" && !(L.isFloater || L.isGlider)) { L.isFloater = true; give(); }
      if (s === "GLIDER" && !(L.isFloater || L.isGlider)) { L.isGlider = true; give(); }
      if (s === "DISARMER" && !L.isDisarmer) { L.isDisarmer = true; give(); }
      return false;
    }

    handleRemoveSkills(L) {
      if (!L.hasPermanentSkills) return false;
      this.cueSoundEffect(SFX.REMOVE_SKILLS, L);
      L.isClimber = L.isSlider = L.isSwimmer = L.isFloater = L.isGlider = L.isDisarmer = false;
      const old = L.action;
      if (inSet(L.action, [BA.CLIMBING, BA.DEHOISTING, BA.SLIDING, BA.FLOATING, BA.GLIDING])) this.transition(L, BA.FALLING);
      else if (L.action === BA.SWIMMING) this.transition(L, BA.DROWNING);
      if (L.action === BA.FALLING && old !== BA.FALLING) { L.fallen = -1; L.trueFallen = -1; }
      return true;
    }

    handleNeutralize(L) {
      if (!(L.isNeutral || L.isZombie)) { this.cueSoundEffect(SFX.NEUTRALIZE, L); L.isNeutral = true; }
      return false;
    }
    handleDeneutralize(L) {
      if (L.isNeutral && !L.isZombie) { this.cueSoundEffect(SFX.DENEUTRALIZE, L); L.isNeutral = false; }
      return false;
    }

    // ---- masks

    /** Draw a mask onto the physics map: where the mask has alpha and the pixel has none of `exclude`, clear terrain. */
    applyMask(mask, sx, sy, w, h, dx, dy, exclude) {
      const md = mask.data;
      for (let y = 0; y < h; y++) {
        const py = dy + y;
        if (py < 0 || py >= this.height) continue;
        for (let x = 0; x < w; x++) {
          const px = dx + x;
          if (px < 0 || px >= this.width) continue;
          if (md[((sy + y) * mask.width + sx + x) * 4 + 3] === 0) continue;
          const i = px + py * this.width;
          if ((this.physics[i] & exclude) === 0) this.physics[i] &= ~PM.TERRAIN;
        }
      }
    }

    applyStoneLemming(L) {
      let x = L.x;
      if (L.dx === 1) x++;
      const m = this.masks.stoner;
      const md = m.data;
      for (let y = 0; y < m.height; y++) for (let xx = 0; xx < m.width; xx++) {
        const px = x - 8 + xx, py = L.y - 10 + y;
        if (px < 0 || py < 0 || px >= this.width || py >= this.height) continue;
        if (md[(y * m.width + xx) * 4 + 3] === 0) continue;
        const i = px + py * this.width;
        if ((this.physics[i] & PM.SOLID) === 0) {
          this.physics[i] |= PM.SOLID;
          if (!this.isSimulating) {
            const c = (0xff << 24 | md[(y * m.width + xx) * 4 + 2] << 16 | md[(y * m.width + xx) * 4 + 1] << 8 | md[(y * m.width + xx) * 4]) >>> 0;
            this.level.setGroundAt(px, py, c);
          }
        }
      }
    }

    applyExplosionMask(L) {
      let px = L.x;
      if (L.dx === 1) px++;
      const m = this.masks.bomber;
      this.applyMask(m, 0, 0, m.width, m.height, px - 8, L.y - 14, PM.STEEL);
      this.removeTerrain(px - 8, L.y - 14, m.width, m.height);
    }

    applyBashingMask(L, maskFrame) {
      const excl = L.dx === 1 ? (PM.STEEL | PM.ONEWAYLEFT | PM.ONEWAYDOWN | PM.ONEWAYUP) : (PM.STEEL | PM.ONEWAYRIGHT | PM.ONEWAYDOWN | PM.ONEWAYUP);
      this.applyMask(this.masks.basher, L.dx === 1 ? 16 : 0, maskFrame * 10, 16, 10, L.x - 8, L.y - 10, excl);
      this.removeTerrain(L.x - 8, L.y - 10, 16, 10);
    }

    applyFencerMask(L, maskFrame) {
      const excl = L.dx === 1 ? (PM.STEEL | PM.ONEWAYLEFT | PM.ONEWAYDOWN) : (PM.STEEL | PM.ONEWAYRIGHT | PM.ONEWAYDOWN);
      this.applyMask(this.masks.fencer, L.dx === 1 ? 16 : 0, maskFrame * 10, 16, 10, L.x - 8, L.y - 10, excl);
      this.removeTerrain(L.x - 8, L.y - 10, 16, 10);
    }

    applyLaserMask(px, py, L) {
      const excl = L.dx === 1 ? (PM.STEEL | PM.ONEWAYLEFT | PM.ONEWAYDOWN) : (PM.STEEL | PM.ONEWAYRIGHT | PM.ONEWAYDOWN);
      // the 9x9 mask around the hit point, kept to the side the beam came from
      const tx0 = L.dx === 1 ? L.x : 0, tx1 = L.dx === 1 ? this.width : L.x + 1;
      const x0 = Math.max(px - 4, tx0), y0 = Math.max(py - 4, 0), x1 = Math.min(px + 5, tx1), y1 = Math.min(py + 5, L.y);
      if (x1 <= x0 || y1 <= y0) return;
      this.applyMask(this.masks.laser, x0 - (px - 4), y0 - (py - 4), x1 - x0, y1 - y0, x0, y0, excl);
      this.removeTerrain(x0, y0, x1 - x0, y1 - y0);
    }

    applyMinerMask(L, maskFrame, adjustX, adjustY) {
      const mx = L.x + L.dx - 8 + adjustX, my = L.y + maskFrame - 12 + adjustY;
      const excl = L.dx === 1 ? (PM.STEEL | PM.ONEWAYLEFT | PM.ONEWAYUP) : (PM.STEEL | PM.ONEWAYRIGHT | PM.ONEWAYUP);
      this.applyMask(this.masks.miner, L.dx === 1 ? 16 : 0, maskFrame * 13, 16, 13, mx, my, excl);
      this.removeTerrain(mx, my, 16, 13);
    }

    // ---- constructive skills

    layBrick(L) {
      const brickY = L.action === BA.BUILDING ? L.y - 1 : L.y;
      for (let n = 0; n <= 5; n++) this.addConstructivePixel(L.x + n * L.dx, brickY, this.brickColors[12 - L.bricksLeft]);
    }

    layStackBrick(L) {
      let brickY = L.y - 9 + L.bricksLeft;
      if (L.stackLow) brickY++;
      let result = false;
      for (let n = 1; n <= 3; n++) {
        const px = L.x + n * L.dx;
        if (!this.hasPixelAt(px, brickY)) { this.addConstructivePixel(px, brickY, this.brickColors[12 - L.bricksLeft]); result = true; }
      }
      return result;
    }

    digOneRow(px, py) {
      let result = false;
      for (let n = -4; n <= 4; n++) {
        if (this.hasPixelAt(px + n, py) && !this.hasIndestructibleAt(px + n, py, 0, BA.DIGGING)) {
          this.removePixelAt(px + n, py);
          if (n > -4 && n < 4) result = true;
        }
      }
      this.removeTerrain(px - 4, py, 9, 1);
      return result;
    }

    lemCanPlatform(L) {
      let r = false;
      for (let n = 0; n <= 5; n++) r = r || !this.hasPixelAt(L.x + n * L.dx, L.y);
      r = r && !this.hasPixelAt(L.x + L.dx, L.y - 1);
      r = r && !this.hasPixelAt(L.x + 2 * L.dx, L.y - 1);
      return r;
    }

    findGroundPixel(x, y) {
      let r = 0;
      if (this.hasPixelAt(x, y)) {
        while (this.hasPixelAt(x, y + r - 1) && r > -7) r--;
      } else {
        r++;
        while (!this.hasPixelAt(x, y + r) && r < 4) r++;
      }
      return r;
    }

    // ---- the per-lemming step

    handleLemming(L) {
      L.xOld = L.x; L.yOld = L.y; L.dxOld = L.dx; L.actionOld = L.action;
      this.lemNextAction = BA.NONE;
      this.lemJumpToHoistAdvance = false;
      L.frame++;
      L.physicsFrame++;
      if (L.physicsFrame > L.maxPhysicsFrame) {
        L.physicsFrame = 0;
        if (L.action === BA.FLOATING || L.action === BA.GLIDING) L.physicsFrame = 9;
        if (inSet(L.action, [BA.DROWNING, BA.HOISTING, BA.SPLATTING, BA.EXITING, BA.VAPORIZING, BA.SHRUGGING, BA.OHNOING, BA.EXPLODING, BA.STONING, BA.REACHING, BA.DEHOISTING])) L.endOfAnimation = true;
      }
      let result;
      switch (L.action) {
        case BA.WALKING: case BA.TOWALKING: result = this.handleWalking(L); break;
        case BA.ASCENDING: result = this.handleAscending(L); break;
        case BA.DIGGING: result = this.handleDigging(L); break;
        case BA.CLIMBING: result = this.handleClimbing(L); break;
        case BA.DROWNING: result = this.handleDrowning(L); break;
        case BA.HOISTING: result = this.handleHoisting(L); break;
        case BA.BUILDING: result = this.handleBuilding(L); break;
        case BA.BASHING: result = this.handleBashing(L); break;
        case BA.MINING: result = this.handleMining(L); break;
        case BA.FALLING: result = this.handleFalling(L); break;
        case BA.FLOATING: result = this.handleFloating(L); break;
        case BA.SPLATTING: result = this.handleSplatting(L); break;
        case BA.EXITING: result = this.handleExiting(L); break;
        case BA.VAPORIZING: result = this.handleVaporizing(L); break;
        case BA.BLOCKING: result = this.handleBlocking(L); break;
        case BA.SHRUGGING: result = this.handleShrugging(L); break;
        case BA.OHNOING: case BA.STONING: result = this.handleOhNoing(L); break;
        case BA.EXPLODING: case BA.STONEFINISH: result = this.handleExploding(L); break;
        case BA.PLATFORMING: result = this.handlePlatforming(L); break;
        case BA.STACKING: result = this.handleStacking(L); break;
        case BA.SWIMMING: result = this.handleSwimming(L); break;
        case BA.GLIDING: result = this.handleGliding(L); break;
        case BA.FIXING: result = this.handleDisarming(L); break;
        case BA.FENCING: result = this.handleFencing(L); break;
        case BA.REACHING: result = this.handleReaching(L); break;
        case BA.SHIMMYING: result = this.handleShimmying(L); break;
        case BA.JUMPING: result = this.handleJumping(L); break;
        case BA.DEHOISTING: result = this.handleDehoisting(L); break;
        case BA.SLIDING: result = this.handleSliding(L); break;
        case BA.LASERING: result = this.handleLasering(L); break;
        default: this.transition(L, BA.WALKING); result = true;
      }
      if (L.isZombie && !this.isSimulating) this.setZombieField(L);
      return result;
    }

    checkLevelBoundaries(L) {
      let result = true;
      if (L.y <= 0 || L.y > LEMMING_MAX_Y + this.height) { this.removeLemming(L, RM.NEUTRAL); result = false; }
      if (L.x < 0 || L.x >= this.width) { this.removeLemming(L, RM.NEUTRAL); result = false; }
      return result;
    }

    handleWalking(L) {
      const adjusted = L.walkerPositionAdjusted;
      L.walkerPositionAdjusted = false;
      L.x += L.dx;
      let dy = this.findGroundPixel(L.x, L.y);
      if (dy > 0 && L.isSlider && this.lemCanDehoist(L, true)) {
        L.x -= L.dx;
        this.transition(L, BA.DEHOISTING, true);
        return true;
      }
      if (dy < -6) {
        if (L.isClimber) this.transition(L, BA.CLIMBING);
        else { this.turnAround(L); if (!adjusted) L.x += L.dx; }
      } else if (dy < -2) {
        this.transition(L, BA.ASCENDING);
        L.y -= 2;
      } else if (dy < 1) L.y += dy;
      dy = this.findGroundPixel(L.x, L.y);
      if (dy > 3) { L.y += 4; this.transition(L, BA.FALLING); }
      else if (dy > 0) L.y += dy;
      return true;
    }

    handleSwimming(L) {
      L.fallen = 0;
      L.x += L.dx;
      const lemDive = () => {
        let r = 1;
        while (this.hasPixelAt(L.x, L.y + r) && r <= 4) {
          r++; L.fallen++;
          if (this.hasTriggerAt(L.x, L.y + r, "WATER")) L.fallen = 0;
          if (L.y + r >= this.height) break;
        }
        return r > 4 ? 0 : r;
      };
      if (this.hasTriggerAt(L.x, L.y, "WATER") || this.hasPixelAt(L.x, L.y)) {
        const dy = this.findGroundPixel(L.x, L.y);
        if (dy >= -1 && this.hasTriggerAt(L.x, L.y - 1, "WATER") && !this.hasPixelAt(L.x, L.y - 1)) L.y--;
        else if (dy < -6) {
          const dive = lemDive();
          if (dive > 0) {
            L.y += dive;
            if (!this.hasTriggerAt(L.x, L.y, "WATER")) this.transition(L, BA.WALKING);
          } else if (L.isClimber && !this.hasTriggerAt(L.x, L.y - 1, "WATER")) this.transition(L, BA.CLIMBING);
          else { this.turnAround(L); L.x += L.dx; }
        } else if (dy <= -3) { this.transition(L, BA.ASCENDING); L.y -= 2; }
        else if (dy <= -1 || (dy === 0 && !this.hasTriggerAt(L.x, L.y, "WATER"))) { this.transition(L, BA.WALKING); L.y += dy; }
      } else {
        const dy = this.findGroundPixel(L.x, L.y);
        if (dy > 1) { L.y++; this.transition(L, BA.FALLING); }
        else { L.y += dy; this.transition(L, BA.WALKING); }
      }
      return true;
    }

    handleAscending(L) {
      let dy = 0;
      while (dy < 2 && L.ascended < 5 && this.hasPixelAt(L.x, L.y - 1)) { dy++; L.y--; L.ascended++; }
      if (dy < 2 && !this.hasPixelAt(L.x, L.y - 1)) this.lemNextAction = BA.WALKING;
      else if ((L.ascended === 4 && this.hasPixelAt(L.x, L.y - 1) && this.hasPixelAt(L.x, L.y - 2)) || (L.ascended >= 5 && this.hasPixelAt(L.x, L.y - 1))) {
        L.x -= L.dx;
        while (this.hasPixelAt(L.x, L.y) && L.ascended > 0) { L.y++; L.ascended--; }
        this.transition(L, BA.FALLING, true);
      }
      return true;
    }

    handleDigging(L) {
      if (L.isStartingAction) {
        L.isStartingAction = false;
        this.digOneRow(L.x, L.y - 1);
        L.physicsFrame--;
      }
      if (L.physicsFrame === 0 || L.physicsFrame === 8) {
        L.y++;
        const cont = this.digOneRow(L.x, L.y - 1);
        if (this.hasIndestructibleAt(L.x, L.y, L.dx, BA.DIGGING)) {
          if (this.hasSteelAt(L.x, L.y)) this.cueSoundEffect(SFX.HITS_STEEL, L);
          this.transition(L, BA.WALKING);
        } else if (!cont) this.transition(L, BA.FALLING);
      }
      return true;
    }

    handleClimbing(L) {
      if (L.physicsFrame <= 3) {
        let clip = this.hasPixelAt(L.x - L.dx, L.y - 6 - L.physicsFrame)
          || (this.hasPixelAt(L.x - L.dx, L.y - 5 - L.physicsFrame) && !L.isStartingAction);
        if (L.physicsFrame === 0) clip = clip && this.hasPixelAt(L.x - L.dx, L.y - 7);
        if (clip) {
          if (!L.isStartingAction) L.y = L.y - L.physicsFrame + 3;
          if (L.isSlider) { L.y--; this.transition(L, BA.SLIDING); }
          else { L.x -= L.dx; this.transition(L, BA.FALLING, true); L.fallen++; }
        } else if (!this.hasPixelAt(L.x, L.y - 7 - L.physicsFrame)) {
          if (!(L.isStartingAction && L.physicsFrame === 1)) { L.y = L.y - L.physicsFrame + 2; L.isStartingAction = false; }
          this.transition(L, BA.HOISTING);
        }
      } else {
        L.y--;
        L.isStartingAction = false;
        let clip = this.hasPixelAt(L.x - L.dx, L.y - 7);
        if (L.physicsFrame === 7) clip = clip && this.hasPixelAt(L.x, L.y - 7);
        if (clip) {
          L.y++;
          if (L.isSlider) this.transition(L, BA.SLIDING);
          else { L.x -= L.dx; this.transition(L, BA.FALLING, true); }
        }
      }
      return true;
    }

    handleDrowning(L) { if (L.endOfAnimation) this.removeLemming(L, RM.KILL); return false; }

    handleDisarming(L) {
      L.disarmingFrames--;
      if (L.disarmingFrames <= 0) {
        this.transition(L, L.actionNew !== BA.NONE ? L.actionNew : BA.WALKING);
        L.actionNew = BA.NONE;
      } else if (L.physicsFrame % 8 === 0) this.cueSoundEffect(SFX.FIXING, L);
      return false;
    }

    handleHoisting(L) {
      if (L.endOfAnimation) this.transition(L, BA.WALKING);
      else if (L.physicsFrame === 1 && L.isStartingAction) L.y -= 1;
      else if (L.physicsFrame <= 4) L.y -= 2;
      return true;
    }

    handlePlatforming(L) {
      const check = (x, y) => this.hasPixelAt(x, y - 1) || this.hasPixelAt(x, y - 2);
      if (L.physicsFrame === 9) { L.placedBrick = this.lemCanPlatform(L); this.layBrick(L); }
      else if (L.physicsFrame === 10 && L.bricksLeft <= 3) this.cueSoundEffect(SFX.BUILDER_WARNING, L);
      else if (L.physicsFrame === 15) {
        if (!L.placedBrick) this.transition(L, BA.WALKING, true);
        else if (check(L.x + 2 * L.dx, L.y)) { L.x += L.dx; this.transition(L, BA.WALKING, true); }
        else if (!L.constructivePositionFreeze) L.x += L.dx;
      } else if (L.physicsFrame === 0) {
        if (check(L.x + 2 * L.dx, L.y) && L.bricksLeft > 1) { L.x += L.dx; this.transition(L, BA.WALKING, true); }
        else if (check(L.x + 3 * L.dx, L.y) && L.bricksLeft > 1) { L.x += 2 * L.dx; this.transition(L, BA.WALKING, true); }
        else {
          if (!L.constructivePositionFreeze) L.x += 2 * L.dx;
          L.bricksLeft--;
          if (L.bricksLeft === 0) {
            if (this.hasPixelAt(L.x, L.y - 1)) L.x -= L.dx;
            this.transition(L, BA.SHRUGGING);
          }
        }
      }
      if (L.physicsFrame === 0) L.constructivePositionFreeze = false;
      return true;
    }

    handleBuilding(L) {
      if (L.physicsFrame === 9) this.layBrick(L);
      else if (L.physicsFrame === 10 && L.bricksLeft <= 3) this.cueSoundEffect(SFX.BUILDER_WARNING, L);
      else if (L.physicsFrame === 0) {
        L.bricksLeft--;
        if (this.hasPixelAt(L.x + L.dx, L.y - 2)) this.transition(L, BA.WALKING, true);
        else if (this.hasPixelAt(L.x + L.dx, L.y - 3) || this.hasPixelAt(L.x + 2 * L.dx, L.y - 2)
          || (this.hasPixelAt(L.x + 2 * L.dx, L.y - 10) && L.bricksLeft > 0)) {
          L.y--; L.x += L.dx; this.transition(L, BA.WALKING, true);
        } else {
          if (!L.constructivePositionFreeze) { L.y--; L.x += 2 * L.dx; }
          if (this.hasPixelAt(L.x, L.y - 2) || this.hasPixelAt(L.x, L.y - 3) || this.hasPixelAt(L.x + L.dx, L.y - 3)
            || (this.hasPixelAt(L.x + L.dx, L.y - 9) && L.bricksLeft > 0)) this.transition(L, BA.WALKING, true);
          else if (L.bricksLeft === 0) this.transition(L, BA.SHRUGGING);
        }
      }
      if (L.physicsFrame === 0) L.constructivePositionFreeze = false;
      return true;
    }

    handleStacking(L) {
      const mayPlaceNext = () => {
        let by = L.y - 9 + L.bricksLeft;
        if (L.stackLow) by++;
        return !(this.hasPixelAt(L.x + L.dx, by) && this.hasPixelAt(L.x + 2 * L.dx, by) && this.hasPixelAt(L.x + 3 * L.dx, by));
      };
      if (L.physicsFrame === 7) L.placedBrick = this.layStackBrick(L);
      else if (L.physicsFrame === 0) {
        L.bricksLeft--;
        if (L.bricksLeft < 3) this.cueSoundEffect(SFX.BUILDER_WARNING, L);
        if (!L.placedBrick) {
          if (L.bricksLeft < 7 || !mayPlaceNext()) this.transition(L, BA.WALKING, true);
        } else if (L.bricksLeft === 0) this.transition(L, BA.SHRUGGING);
      }
      return true;
    }

    handleBashing(L) {
      const indestructible = (x, y, d) => this.hasIndestructibleAt(x, y - 3, d, BA.BASHING) || this.hasIndestructibleAt(x, y - 4, d, BA.BASHING) || this.hasIndestructibleAt(x, y - 5, d, BA.BASHING);
      const turn = (steelSound) => {
        L.x -= L.dx;
        this.transition(L, BA.WALKING, true);
        if (steelSound) this.cueSoundEffect(SFX.HITS_STEEL, L);
      };
      const H = (x, y) => this.hasPixelAt(x, y);
      const stepUpCheck = (x, y, d, step) => {
        if (step === -1) {
          if (!H(x + d, y + step - 1) && H(x + d, y + step) && H(x + 2 * d, y + step) && H(x + 2 * d, y + step - 1) && H(x + 2 * d, y + step - 2)) return false;
          if (!H(x + d, y + step - 2) && H(x + d, y + step) && H(x + d, y + step - 1) && H(x + 2 * d, y + step - 1) && H(x + 2 * d, y + step - 2)) return false;
          if (H(x + d, y + step - 2) && H(x + d, y + step - 1) && H(x + d, y + step)) return false;
        } else if (step === -2) {
          if (!H(x + d, y + step) && H(x + d, y + step + 1) && H(x + 2 * d, y + step + 1) && H(x + 2 * d, y + step) && H(x + 2 * d, y + step - 1)) return false;
          if (!H(x + d, y + step - 1) && H(x + d, y + step) && H(x + 2 * d, y + step) && H(x + 2 * d, y + step - 1)) return false;
          if (H(x + d, y + step - 1) && H(x + d, y + step)) return false;
        }
        return true;
      };
      const doTurnAtSteel = () => {
        const copy = new Lemming(L.index);
        copy.assign(L);
        copy.isPhysicsSimulation = true;
        const saved = this.physics.slice();
        let result = false;
        copy.physicsFrame = 10;
        for (let i = 0; i <= 10; i++) {
          if (copy.physicsFrame === 0 || copy.physicsFrame === 16) {
            this.simulationDepth++;
            for (let f = 0; f < 4; f++) this.applyBashingMask(copy, f);
            this.simulationDepth--;
            copy.physicsFrame = 10;
          }
          this.simulateLem(copy, false);
          if (copy.dx === -L.dx && copy.action !== BA.DEHOISTING) { result = true; break; }
          else if (copy.removed || copy.action !== BA.BASHING) break;
        }
        this.physics.set(saved);
        return result;
      };

      if (L.physicsFrame >= 2 && L.physicsFrame <= 5) this.applyBashingMask(L, L.physicsFrame - 2);
      if (L.physicsFrame === 5) {
        let cont = false;
        for (let n = 1; n <= 14; n++) {
          if (H(L.x + n * L.dx, L.y - 6) && !this.hasIndestructibleAt(L.x + n * L.dx, L.y - 6, L.dx, BA.BASHING)) cont = true;
          if (H(L.x + n * L.dx, L.y - 5) && !this.hasIndestructibleAt(L.x + n * L.dx, L.y - 5, L.dx, BA.BASHING)) cont = true;
        }
        if (!cont && !L.isPhysicsSimulation) cont = doTurnAtSteel();
        if (!cont) this.transition(L, H(L.x, L.y) ? BA.WALKING : BA.FALLING);
      }
      if (L.physicsFrame >= 11 && L.physicsFrame <= 15) {
        L.x += L.dx;
        const dy = this.findGroundPixel(L.x, L.y);
        if (dy > 0 && L.isSlider && this.lemCanDehoist(L, true)) { L.x -= L.dx; this.transition(L, BA.DEHOISTING, true); }
        else if (dy === 4) { L.y += dy; this.transition(L, BA.FALLING); }
        else if (dy === 3) { L.y += dy; this.transition(L, BA.WALKING); }
        else if (dy >= 0 && dy <= 2) {
          if (indestructible(L.x, L.y + dy, L.dx)) turn(this.hasSteelAt(L.x, L.y + dy - 4));
          else L.y += dy;
        } else if (dy === -1 || dy === -2) {
          if (indestructible(L.x, L.y + dy, L.dx)) turn(this.hasSteelAt(L.x, L.y + dy - 4));
          else if (!stepUpCheck(L.x, L.y, L.dx, dy)) {
            if (indestructible(L.x + L.dx, L.y + 2, L.dx)) turn(this.hasSteelAt(L.x + L.dx, L.y + dy) || this.hasSteelAt(L.x + L.dx, L.y + dy + 1));
            else L.x -= L.dx;
          } else L.y += dy;
        } else if (dy < -2) {
          if (indestructible(L.x, L.y, L.dx)) turn(this.hasSteelAt(L.x, L.y - 3) || this.hasSteelAt(L.x, L.y - 4) || this.hasSteelAt(L.x, L.y - 5));
          else L.x -= L.dx;
        }
      }
      return true;
    }

    handleFencing(L) {
      const H = (x, y) => this.hasPixelAt(x, y);
      const indestructible = (x, y, d) => this.hasIndestructibleAt(x, y - 3, d, BA.FENCING);
      let needUndoMoveUp = false;
      const turn = (steelSound) => {
        L.x -= L.dx;
        if (needUndoMoveUp) L.y++;
        this.transition(L, BA.WALKING, true);
        if (steelSound) this.cueSoundEffect(SFX.HITS_STEEL, L);
      };
      const stepUpCheck = (x, y, d, step) => {
        if (step === -1) {
          if (!H(x + d, y + step - 1) && H(x + d, y + step) && H(x + 2 * d, y + step) && H(x + 2 * d, y + step - 1) && H(x + 2 * d, y + step - 2)) return false;
          if (!H(x + d, y + step - 2) && H(x + d, y + step) && H(x + d, y + step - 1) && H(x + 2 * d, y + step - 1) && H(x + 2 * d, y + step - 2)) return false;
          if (H(x + d, y + step - 2) && H(x + d, y + step - 1) && H(x + d, y + step)) return false;
        } else if (step === -2) {
          if (!H(x + d, y + step) && H(x + d, y + step + 1) && H(x + 2 * d, y + step + 1) && H(x + 2 * d, y + step) && H(x + 2 * d, y + step - 1)) return false;
          if (!H(x + d, y + step - 1) && H(x + d, y + step) && H(x + 2 * d, y + step) && H(x + 2 * d, y + step - 1)) return false;
          if (H(x + d, y + step - 1) && H(x + d, y + step)) return false;
        }
        return true;
      };
      const continueTests = () => {
        const copy = new Lemming(L.index);
        copy.assign(L);
        copy.isPhysicsSimulation = true;
        const saved = this.physics.slice();
        let steelContinue = false, moveUpContinue = false;
        copy.physicsFrame = 10;
        for (let i = 0; i <= 10; i++) {
          if (copy.physicsFrame === 0) {
            this.simulationDepth++;
            for (let f = 0; f < 4; f++) this.applyFencerMask(copy, f);
            this.simulationDepth--;
            copy.physicsFrame = 10;
          }
          this.simulateLem(copy, false);
          if (copy.y < L.y) moveUpContinue = true;
          if (copy.dx === -L.dx && copy.action !== BA.DEHOISTING) { steelContinue = true; break; }
          else if (copy.removed || copy.action !== BA.FENCING) break;
        }
        this.physics.set(saved);
        return { steelContinue, moveUpContinue };
      };

      if (L.physicsFrame >= 2 && L.physicsFrame <= 5) this.applyFencerMask(L, L.physicsFrame - 2);
      if (L.physicsFrame === 15) L.isStartingAction = false;
      if (L.physicsFrame === 5) {
        let cont = false;
        for (let n = 1; n <= 14; n++) {
          if (H(L.x + n * L.dx, L.y - 6) && !this.hasIndestructibleAt(L.x + n * L.dx, L.y - 6, L.dx, BA.FENCING)) cont = true;
          if (H(L.x + n * L.dx, L.y - 5) && !this.hasIndestructibleAt(L.x + n * L.dx, L.y - 5, L.dx, BA.FENCING)) cont = true;
        }
        if (!L.isPhysicsSimulation && !(cont && L.isStartingAction)) {
          const t = continueTests();
          if (cont && !L.isStartingAction) cont = t.moveUpContinue;
          if (!cont) cont = t.steelContinue;
        }
        if (!cont) this.transition(L, H(L.x, L.y) ? BA.WALKING : BA.FALLING);
      }
      if (L.physicsFrame >= 11 && L.physicsFrame <= 14) {
        L.x += L.dx;
        let dy = this.findGroundPixel(L.x, L.y);
        if (dy === -1 && (L.physicsFrame === 11 || L.physicsFrame === 13)) { L.y -= 1; dy = 0; needUndoMoveUp = true; }
        if (dy > 0 && L.isSlider && this.lemCanDehoist(L, true)) { L.x -= L.dx; this.transition(L, BA.DEHOISTING, true); }
        else if (dy === 4) { L.y += dy; this.transition(L, BA.FALLING); }
        else if (dy > 0) { L.y += dy; this.transition(L, BA.WALKING); }
        else if (dy === 0) { if (indestructible(L.x, L.y, L.dx)) turn(this.hasSteelAt(L.x, L.y - 4)); }
        else if (dy === -1 || dy === -2) {
          if (indestructible(L.x, L.y + dy, L.dx)) turn(this.hasSteelAt(L.x, L.y + dy - 4));
          else if (!stepUpCheck(L.x, L.y, L.dx, dy)) {
            if (indestructible(L.x + L.dx, L.y + 2, L.dx)) turn(this.hasSteelAt(L.x + L.dx, L.y + dy) || this.hasSteelAt(L.x + L.dx, L.y + dy + 1));
            else { L.x -= L.dx; if (needUndoMoveUp) L.y++; }
          } else L.y += dy;
        } else if (dy < -2) {
          if (indestructible(L.x, L.y, L.dx)) turn(this.hasSteelAt(L.x, L.y - 3) || this.hasSteelAt(L.x, L.y - 4) || this.hasSteelAt(L.x, L.y - 5));
          else L.x -= L.dx;
        }
      }
      return true;
    }

    handleMining(L) {
      const minerTurn = (x, y) => {
        if (this.hasSteelAt(x, y)) this.cueSoundEffect(SFX.HITS_STEEL, L);
        if (this.hasPixelAt(L.x, L.y - 1)) L.y--;
        this.transition(L, BA.WALKING, true);
      };
      if (L.physicsFrame === 1 || L.physicsFrame === 2) this.applyMinerMask(L, L.physicsFrame - 1, 0, 0);
      else if (L.physicsFrame === 3 || L.physicsFrame === 15) {
        if (L.isSlider && this.lemCanDehoist(L, false)) { this.transition(L, BA.DEHOISTING, true); return true; }
        L.x += 2 * L.dx;
        L.y++;
        if (L.isSlider && this.lemCanDehoist(L, true)) { L.x -= L.dx; this.transition(L, BA.DEHOISTING, true); return true; }
        const ind = (x, y) => this.hasIndestructibleAt(x, y, L.dx, BA.MINING);
        if (ind(L.x - L.dx, L.y - 1) && ind(L.x, L.y - 1)) { L.x -= 2 * L.dx; minerTurn(L.x + 2 * L.dx, L.y - 1); }
        else if (L.physicsFrame === 3 && ind(L.x - L.dx, L.y - 2)) { L.x -= 2 * L.dx; minerTurn(L.x + L.dx, L.y - 2); }
        else if (!this.hasPixelAt(L.x - L.dx, L.y - 1) && !this.hasPixelAt(L.x - L.dx, L.y) && !this.hasPixelAt(L.x - L.dx, L.y + 1)) {
          L.x -= L.dx; L.y++; this.transition(L, BA.FALLING); L.fallen++;
        } else if (ind(L.x, L.y - 2)) { L.x -= L.dx; minerTurn(L.x + L.dx, L.y - 2); }
        else if (!this.hasPixelAt(L.x, L.y)) { L.y++; this.transition(L, BA.FALLING); }
        else if (ind(L.x + L.dx, L.y - 2)) minerTurn(L.x + L.dx, L.y - 2);
        else if (ind(L.x, L.y)) minerTurn(L.x, L.y);
      }
      return true;
    }

    lemCanDehoist(L, alreadyMovedX) {
      let curX = L.x, nextX = L.x;
      if (alreadyMovedX) curX -= L.dx; else nextX += L.dx;
      if (nextX < 0 || nextX >= this.width) return false;
      if (!this.hasPixelAt(curX, L.y) || this.hasPixelAt(nextX, L.y)) return false;
      for (let n = 1; n <= 3; n++) {
        if (this.hasPixelAt(nextX, L.y + n)) return false;
        if (!this.hasPixelAt(curX, L.y + n)) break;
      }
      return true;
    }

    lemSliderTerrainChecks(L, maxYCheckOffset) {
      if (maxYCheckOffset === undefined) maxYCheckOffset = 7;
      const has = (x, y) => {
        let r = this.hasPixelAt(x, y);
        if (!r && x === L.x && y === L.dehoistPinY && y >= 0) r = this.hasPixelAt(x, y + 1);
        return r;
      };
      if (has(L.x, L.y) && !has(L.x, L.y - 1)) { this.transition(L, BA.WALKING); return false; }
      if (!has(L.x, L.y - Math.min(maxYCheckOffset, 7))) { this.transition(L, BA.FALLING); return false; }
      if (has(L.x, L.y)) {
        if (this.hasTriggerAt(L.x - L.dx, L.y, "WATER", L)) {
          L.x -= L.dx;
          if (L.isSwimmer) { this.transition(L, BA.SWIMMING, true); this.cueSoundEffect(SFX.SWIMMING, L); }
          else { this.transition(L, BA.DROWNING, true); this.cueSoundEffect(SFX.DROWNING, L); }
          return false;
        }
        if (has(L.x - L.dx, L.y)) { L.x -= L.dx; this.transition(L, BA.WALKING, true); return false; }
      }
      return true;
    }

    handleDehoisting(L) {
      if (L.endOfAnimation) {
        if ((L.x <= 0 && L.dx === -1) || (L.x >= this.width - 1 && L.dx === 1)) this.removeLemming(L, RM.NEUTRAL);
        else if (this.hasPixelAt(L.x, L.y - 7)) this.transition(L, BA.SLIDING);
        else this.transition(L, BA.FALLING);
      } else if (L.physicsFrame >= 2) {
        for (let n = 0; n <= 1; n++) {
          L.y++;
          if (!this.lemSliderTerrainChecks(L, L.physicsFrame * 2 - 3 + n)) return L.action !== BA.DROWNING;
        }
      }
      return true;
    }

    handleSliding(L) {
      if ((L.x <= 0 && L.dx === -1) || (L.x >= this.width - 1 && L.dx === 1)) this.removeLemming(L, RM.NEUTRAL);
      for (let n = 0; n <= 1; n++) {
        L.y++;
        if (!this.lemSliderTerrainChecks(L)) return L.action !== BA.DROWNING;
      }
      return true;
    }

    handleReaching(L) {
      const movement = [0, 3, 2, 2, 1, 1, 1, 0];
      const H = (x, y) => this.hasPixelAt(x, y);
      let empty;
      if (H(L.x, L.y - 10)) empty = 0; else if (H(L.x, L.y - 11)) empty = 1; else if (H(L.x, L.y - 12)) empty = 2; else if (H(L.x, L.y - 13)) empty = 3; else empty = 4;
      if (H(L.x, L.y - 5) || H(L.x, L.y - 6) || H(L.x, L.y - 7) || H(L.x, L.y - 8)) this.transition(L, BA.FALLING);
      else if (L.physicsFrame === 1 && H(L.x, L.y - 9)) this.transition(L, BA.FALLING);
      else if (empty <= movement[L.physicsFrame]) { L.y -= empty + 1; this.transition(L, BA.SHIMMYING); }
      else { L.y -= movement[L.physicsFrame]; if (L.physicsFrame === 7) this.transition(L, BA.FALLING); }
      return true;
    }

    handleShimmying(L) {
      const H = (x, y) => this.hasPixelAt(x, y);
      if (L.physicsFrame % 2 !== 0) return true;
      for (let i = 0; i <= 2; i++) {
        if (H(L.x + L.dx, L.y - i) && !H(L.x + L.dx, L.y - i - 1)) { L.x += L.dx; L.y -= i; this.transition(L, BA.WALKING); return true; }
      }
      for (let i = 3; i <= 5; i++) {
        if (H(L.x + L.dx, L.y - i) && !H(L.x + L.dx, L.y - i - 1)) {
          L.x += L.dx; L.y -= i - 4; L.isStartingAction = false;
          this.transition(L, BA.HOISTING); L.frame += 2; L.physicsFrame += 2;
          return true;
        }
      }
      for (let i = 6; i <= 7; i++) {
        if (H(L.x + L.dx, L.y - i)) {
          if (L.isSlider) { L.x += L.dx; this.transition(L, BA.SLIDING); } else this.transition(L, BA.FALLING);
          return true;
        }
      }
      if (!(H(L.x + L.dx, L.y - 9) || H(L.x + L.dx, L.y - 10))) { this.transition(L, BA.FALLING); return true; }
      if (H(L.x + L.dx, L.y - 8) && !H(L.x + L.dx, L.y - 9)) { this.transition(L, BA.FALLING); return true; }
      L.x += L.dx;
      if (H(L.x, L.y - 8)) {
        L.y += 1;
        if (H(L.x, L.y)) { this.transition(L, BA.WALKING); return true; }
      }
      if (!H(L.x, L.y - 9)) L.y -= 1;
      if (H(L.x, L.y - 5)) { L.y -= 5; this.transition(L, BA.WALKING); return true; }
      if (L.y >= this.height + 8) { this.removeLemming(L, RM.NEUTRAL); }
      return true;
    }

    handleJumping(L) {
      const H = (x, y) => this.hasPixelAt(x, y);
      const triggerChecks = () => {
        if (!this.hasTriggerAt(L.x, L.y, "FLIPPER")) L.inFlipper = NO_OBJECT;
        else if (this.handleFlipper(L, L.x, L.y)) return;
        if (this.hasTriggerAt(L.x, L.y, "ZOMBIE", L) && !L.isZombie) this.removeLemming(L, RM.ZOMBIE);
        if (this.hasTriggerAt(L.x, L.y, "FORCELEFT", L)) this.handleForceField(L, -1);
        else if (this.hasTriggerAt(L.x, L.y, "FORCERIGHT", L)) this.handleForceField(L, 1);
      };
      const makeJumpMovement = () => {
        let patternIndex;
        const p = L.jumpProgress;
        if (p <= 1) patternIndex = 0; else if (p <= 3) patternIndex = 1; else if (p <= 8) patternIndex = p - 2;
        else if (p <= 10) patternIndex = 7; else if (p <= 12) patternIndex = 8; else return false;
        const pattern = JUMP_PATTERNS[patternIndex];
        L.jumpPositions = [];
        for (let i = 0; i < 6; i++) L.jumpPositions.push([-1, -1]);
        let firstStep = L.jumpProgress === 0;
        for (let i = 0; i < 6; i++) {
          L.jumpPositions[i] = [L.x, L.y];
          if (pattern[i][0] === 0 && pattern[i][1] === 0) break;
          if (pattern[i][0] !== 0) {
            const checkX = L.x + L.dx;
            if (H(checkX, L.y)) {
              for (let n = 1; n <= 8; n++) {
                if (!H(checkX, L.y - n)) {
                  if (n <= 2) { L.x = checkX; L.y = L.y - n + 1; this.lemNextAction = BA.WALKING; }
                  else if (n <= 5) { L.x = checkX; L.y = L.y - n + 5; this.lemNextAction = BA.HOISTING; this.lemJumpToHoistAdvance = true; }
                  else { L.x = checkX; L.y = L.y - n + 8; this.lemNextAction = BA.HOISTING; }
                  return false;
                }
                if ((n === 5 && !L.isClimber) || n === 7) {
                  if (L.isClimber) { L.x = checkX; this.lemNextAction = BA.CLIMBING; }
                  else if (L.isSlider) { L.x += L.dx; this.lemNextAction = BA.SLIDING; }
                  else { L.dx = -L.dx; this.lemNextAction = BA.FALLING; }
                  return false;
                }
              }
            }
          }
          if (pattern[i][1] < 0) {
            for (let n = 1; n <= 9; n++) {
              if (n === 1 && firstStep) continue;
              if (H(L.x, L.y - n)) { this.lemNextAction = BA.FALLING; return false; }
            }
          }
          L.x += pattern[i][0] * L.dx;
          L.y += pattern[i][1];
          triggerChecks();
          if (firstStep) firstStep = false;
          else if (H(L.x, L.y)) { this.lemNextAction = BA.WALKING; return false; }
        }
        return true;
      };
      if (makeJumpMovement()) {
        L.jumpProgress++;
        if (L.jumpProgress >= 8 && L.isGlider) this.lemNextAction = BA.GLIDING;
        else if (L.jumpProgress === 13) this.lemNextAction = BA.WALKING;
      }
      return true;
    }

    handleLasering(L) {
      if (!this.hasPixelAt(L.x, L.y)) { this.transition(L, BA.FALLING); return true; }
      const OFFSETS = [[1, -1], [0, -1], [1, 0], [-1, -1], [-1, -2], [0, -2], [1, -2], [2, -1], [2, 0], [2, 2], [1, 1]];
      let tx = L.x + L.dx * 2, ty = L.y - 5;
      let hit = false, useful = false;
      for (let i = 0; i < 112; i++) {
        let kind = "none";
        if (tx < -4 || ty < -4 || tx >= this.width + 4) kind = "out";
        else {
          for (const [ox, oy] of OFFSETS) {
            const cx = tx + ox * L.dx, cy = ty + oy;
            if (!this.hasPixelAt(cx, cy)) continue;
            if (this.hasIndestructibleAt(cx, cy, L.dx, BA.LASERING) && kind !== "solid") kind = "indestructible";
            else kind = "solid";
          }
        }
        if (kind === "none") { tx += L.dx; ty--; continue; }
        if (kind === "solid") { hit = true; useful = true; }
        else if (kind === "indestructible") hit = true;
        break;
      }
      L.laserHitPoint = [tx, ty];
      if (hit) { L.laserHit = true; this.applyLaserMask(tx, ty, L); } else L.laserHit = false;
      if (useful) L.laserRemainTime = 10;
      else { L.laserRemainTime--; if (L.laserRemainTime <= 0) this.transition(L, BA.WALKING); }
      return true;
    }

    handleFalling(L) {
      let curr = 0, maxFall = 3;
      if (this.hasTriggerAt(L.x, L.y, "UPDRAFT")) maxFall = 2;
      const isFatal = () => !(L.isFloater || L.isGlider) && !this.hasTriggerAt(L.x, L.y, "NOSPLAT")
        && (L.fallen > MAX_FALLDISTANCE || this.hasTriggerAt(L.x, L.y, "SPLAT"));
      const floaterOrGlider = () => {
        if (L.isFloater && L.trueFallen > 16 && curr === 0) { this.transition(L, BA.FLOATING); return true; }
        if (L.isGlider && (L.trueFallen > 8 || (L.initialFall && L.trueFallen > 6))) { this.transition(L, BA.GLIDING); return true; }
        return false;
      };
      if (floaterOrGlider()) return true;
      while (curr < maxFall && !this.hasPixelAt(L.x, L.y)) {
        if (curr > 0 && floaterOrGlider()) return true;
        L.y++; curr++; L.fallen++; L.trueFallen++;
        if (this.hasTriggerAt(L.x, L.y, "UPDRAFT")) L.fallen = 0;
      }
      if (L.fallen > MAX_FALLDISTANCE) L.fallen = MAX_FALLDISTANCE + 1;
      if (L.trueFallen > MAX_FALLDISTANCE) L.trueFallen = MAX_FALLDISTANCE + 1;
      if (curr < maxFall) this.lemNextAction = isFatal() ? BA.SPLATTING : BA.WALKING;
      return true;
    }

    handleFloating(L) {
      const table = [3, 3, 3, 3, -1, 0, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2];
      let maxFall = table[L.physicsFrame - 1];
      if (this.hasTriggerAt(L.x, L.y, "UPDRAFT")) maxFall--;
      const ground = Math.max(this.findGroundPixel(L.x, L.y), 0);
      if (maxFall > ground) { L.y += ground; this.lemNextAction = BA.WALKING; }
      else L.y += maxFall;
      return true;
    }

    handleGliding(L) {
      const H = (x, y) => this.hasPixelAt(x, y);
      const doTurnAround = (moveForwardFirst) => {
        let cx = L.x;
        if (moveForwardFirst) cx += L.dx;
        let dy = 0;
        do {
          if (H(cx, L.y + dy) && H(cx - L.dx, L.y + dy)) return true;
          dy++;
        } while (!(dy > 3 || !H(cx, L.y + dy)));
        return dy > 3;
      };
      const headCheck = (x, y) => !(H(x - 1, y - 12) && H(x, y - 12) && H(x + 1, y - 12));
      const checkOnePixelShaft = () => {
        const hasConsecutive = () => {
          const type = L.dx > 0 ? "FORCELEFT" : "FORCERIGHT";
          for (let i = 1; i <= 3; i++) if (!(H(L.x + L.dx, L.y + i) || this.hasTriggerAt(L.x + L.dx, L.y + i, type))) return false;
          return true;
        };
        let yDir = this.hasTriggerAt(L.x, L.y, "UPDRAFT") ? -1 : 1;
        if ((this.findGroundPixel(L.x + L.dx, L.y) < -4 && doTurnAround(true)) || hasConsecutive()) {
          if (H(L.x, L.y) && yDir === 1) this.lemNextAction = BA.WALKING;
          else if (H(L.x, L.y - 2) && yDir === -1) { /* nothing */ }
          else L.y += yDir;
        }
      };
      const table = [3, 3, 3, 3, -1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
      let maxFall = table[L.physicsFrame - 1];
      if (this.hasTriggerAt(L.x, L.y, "UPDRAFT")) {
        maxFall--;
        if (L.physicsFrame >= 9 && L.physicsFrame % 2 === 1 && !H(L.x + L.dx, L.y + maxFall - 1) && headCheck(L.x, L.y - 1)) maxFall--;
      }
      L.x += L.dx;
      if (maxFall < 0) L.y += maxFall;
      const groundDist = this.findGroundPixel(L.x, L.y);
      if (groundDist < -4) {
        if (doTurnAround(false)) { L.x -= L.dx; this.turnAround(L); checkOnePixelShaft(); }
        else { let dy = 0; do { dy++; } while (H(L.x, L.y + dy)); L.y += dy; }
      } else if (groundDist < 0) { L.y += groundDist; this.lemNextAction = BA.WALKING; }
      else if (maxFall > 0) {
        if (maxFall > groundDist) { L.y += groundDist; this.lemNextAction = BA.WALKING; }
        else L.y += maxFall;
      } else if (this.hasTriggerAt(L.x, L.y, "UPDRAFT")) {
        let dy = -1;
        while (!headCheck(L.x, L.y) && dy < 2) {
          L.y++; dy++;
          if (H(L.x, L.y)) { this.lemNextAction = BA.WALKING; dy = 4; }
        }
      }
      return true;
    }

    handleSplatting(L) { if (L.endOfAnimation) this.removeLemming(L, RM.KILL); return false; }

    handleExiting(L) {
      if (this.isOutOfTime) {
        L.frame--; L.physicsFrame--;
        if (this.userSetNuking && L.explosionTimer <= 0 && this.indexLemmingToBeNuked > L.index) this.transition(L, BA.OHNOING);
      } else if (L.endOfAnimation) this.removeLemming(L, RM.SAVE);
      return false;
    }

    handleVaporizing(L) { if (L.endOfAnimation) this.removeLemming(L, RM.KILL); return false; }
    handleBlocking(L) { if (!this.hasPixelAt(L.x, L.y)) this.transition(L, BA.FALLING); return true; }
    handleShrugging(L) { if (L.endOfAnimation) this.transition(L, BA.WALKING); return true; }

    handleOhNoing(L) {
      if (L.endOfAnimation) {
        this.transition(L, L.action === BA.OHNOING ? BA.EXPLODING : BA.STONEFINISH);
        L.hasBlockerField = false;
        this.setBlockerMap();
        return false;
      }
      if (!this.hasPixelAt(L.x, L.y)) {
        L.hasBlockerField = false;
        this.setBlockerMap();
        L.y += Math.min(this.findGroundPixel(L.x, L.y), this.hasTriggerAt(L.x, L.y, "UPDRAFT") ? 2 : 3);
      }
      return true;
    }

    handleExploding(L) {
      if (L.action === BA.EXPLODING) this.applyExplosionMask(L);
      else this.applyStoneLemming(L);
      this.removeLemming(L, RM.KILL);
      L.exploded = true;
      L.particleTimer = PARTICLE_FRAMECOUNT;
      this.particleFinishTimer = PARTICLE_FRAMECOUNT;
      return false;
    }

    removeLemming(L, remMode, silent) {
      if (this.isSimulating) return;
      if (L.isZombie) {
        L.removed = true;
        if (remMode === RM.NEUTRAL && !silent) this.cueSoundEffect(SFX.FALLOUT, L);
      } else if (!L.removed) {
        this.lemmingsRemoved++;
        this.lemmingsOut--;
        L.removed = true;
        switch (remMode) {
          case RM.SAVE: this.lemmingsIn++; break;
          case RM.NEUTRAL: if (!silent) this.cueSoundEffect(SFX.FALLOUT, L); break;
          case RM.ZOMBIE:
            if (!silent) this.cueSoundEffect(SFX.ZOMBIE);
            L.isZombie = true;
            L.removed = false;
            break;
        }
      }
      this.doTalismanCheck();
    }

    doTalismanCheck() {
      for (const t of this.level.talismans || []) {
        const saveReq = t.save >= 0 ? t.save : this.level.needCount;
        if (this.lemmingsIn < saveReq) continue;
        if (t.timeLimit >= 0 && this.currentIteration >= t.timeLimit) continue;
        let total = 0, types = 0, ok = true;
        for (const name of SKILLS) {
          const used = this.skillsUsed(name);
          if (name in t.limits && t.limits[name] >= 0 && used > t.limits[name]) ok = false;
          total += used;
          if (used > 0) types++;
        }
        if (!ok) continue;
        if (t.skillLimit >= 0 && total > t.skillLimit) continue;
        if (t.skillTypeLimit >= 0 && types > t.skillTypeLimit) continue;
        this.talismansAchieved.add(t.id);
      }
    }

    // ---- the frame

    /** UpdateLemmings: one frame of the game. */
    update() {
      this.doneAssignmentThisFrame = false;
      this.sounds = [];
      if (this.gameFinished || this.stateIsUnplayable) return;
      this.checkAdjustSpawnInterval();
      this.checkForQueuedAction();
      this.checkForReplayAction();
      this.incrementIteration();
      this.checkReleaseLemming();
      this.checkLemmings();
      this.checkUpdateNuking();
      this.updateGadgets();
      this.drawAnimatedGadgets();
    }

    incrementIteration() {
      this.currentIteration++;
      this.clockFrame++;
      if (this.delayEndFrames > 0) this.delayEndFrames--;
      if (this.particleFinishTimer > 0) this.particleFinishTimer--;
      if (this.clockFrame === 17) {
        this.clockFrame = 0;
        if (this.timePlay > -5999) this.timePlay--;
        if (this.timePlay === 0) this.cueSoundEffect(SFX.TIMEUP);
      }
      switch (this.currentIteration) {
        case 15:
          this.cueSoundEffect(this.gadgets.some((g) => g.effect === "WINDOW" && g.presets.zombie) ? SFX.ZOMBIE : SFX.LETSGO);
          break;
        case 35: {
          let count = 0, ax = 0, ay = 0;
          for (const g of this.gadgets) {
            if (g.effectBase !== "WINDOW") continue;
            g.triggered = true;
            g.currentFrame = 1;
            count++;
            ax += g.x + (g.width >> 1); ay += g.y + (g.height >> 1);
          }
          this.hatchesOpened = true;
          if (count) this.cueSoundEffect(SFX.ENTRANCE, { x: (ax / count) | 0, y: (ay / count) | 0 });
          break;
        }
      }
    }

    checkReleaseLemming() {
      if (!this.hatchesOpened || this.userSetNuking) return;
      if (this.nextLemmingCountdown > 0) this.nextLemmingCountdown--;
      if (this.nextLemmingCountdown !== 0) return;
      this.nextLemmingCountdown = this.currSpawnInterval;
      if (this.lemmingsToRelease <= 0) return;
      const level = this.level;
      const pos = level.releaseCount - level.preplaced.length - this.lemmingsToRelease;
      const ix = level.spawnOrder[pos];
      if (ix === undefined || ix < 0) return;
      const g = this.gadgets[ix];
      const L = new Lemming(this.lemmings.length);
      this.lemmings.push(L);
      L.identifier = "N" + pos;
      this.transition(L, BA.FALLING);
      if (L.action === BA.FALLING) L.initialFall = true;
      L.x = g.triggerRect.x0;
      L.y = g.triggerRect.y0;
      L.dx = 1;
      if (g.flipLemming) this.turnAround(L);
      L.isSlider = g.presets.slider; L.isClimber = g.presets.climber; L.isSwimmer = g.presets.swimmer;
      L.isDisarmer = g.presets.disarmer; L.isFloater = g.presets.floater;
      if (!L.isFloater) L.isGlider = g.presets.glider;
      if (g.presets.zombie) { this.spawnedDead--; this.removeLemming(L, RM.ZOMBIE, true); }
      if (g.presets.neutral) L.isNeutral = true;
      if (g.remainingLemmings > 0) {
        g.remainingLemmings--;
        if (g.remainingLemmings === 0) this.cueSoundEffect(g.meta.soundExhaust, { x: g.x, y: g.y });
      }
      this.lemmingsToRelease--;
      this.lemmingsOut++;
    }

    checkUpdateNuking() {
      if (!(this.userSetNuking && this.exploderAssignInProgress)) return;
      while (this.indexLemmingToBeNuked < this.lemmings.length - 1 && this.lemmings[this.indexLemmingToBeNuked].removed) this.indexLemmingToBeNuked++;
      if (this.indexLemmingToBeNuked > this.lemmings.length - 1) this.exploderAssignInProgress = false;
      else {
        const L = this.lemmings[this.indexLemmingToBeNuked];
        if (L.explosionTimer === 0 && !(L.action === BA.SPLATTING || L.action === BA.EXPLODING)) L.explosionTimer = 84;
        this.indexLemmingToBeNuked++;
      }
    }

    checkIfZombiesRemain() {
      for (const L of this.lemmings) if (L.isZombie && !L.removed) return true;
      if (this.lemmingsToRelease > 0) {
        const i = this.level.spawnOrder[this.level.releaseCount - this.level.preplaced.length - this.lemmingsToRelease];
        if (i >= 0 && this.gadgets[i].presets.zombie) return true;
      }
      return false;
    }

    checkIfLegalSI(si) {
      return !(this.level.spawnLocked || si < MIN_SI || si > this.level.spawnInterval);
    }

    adjustSpawnInterval(si) {
      if (si === this.currSpawnInterval || !this.checkIfLegalSI(si)) return;
      this.currSpawnInterval = si;
      if (!this.replay) this.recorded.push({ type: "spawn_interval", frame: this.currentIteration, interval: si, spawned: this.lemmings.length });
    }

    checkAdjustSpawnInterval() {
      if (this.spawnIntervalModifier === 0) return;
      this.adjustSpawnInterval(this.currSpawnInterval + this.spawnIntervalModifier);
    }

    checkForQueuedAction() {
      for (const L of this.lemmings) {
        if (L.queueAction === BA.NONE) continue;
        if (L.removed || L.cannotReceiveSkills || L.teleporting) { L.queueAction = BA.NONE; L.queueFrame = 0; continue; }
        const skill = L.queueAction;
        if (this.mayAssign(skill, L) && this.checkSkillAvailable(skill)) this.doSkillAssignment(L, skill);
        else {
          L.queueFrame++;
          if (L.queueFrame > 0) { L.queueAction = BA.NONE; L.queueFrame = 0; } // SkillQFrames default 0
        }
      }
    }

    checkLemmings() {
      this.zombieMap.fill(0);
      for (const L of this.lemmings) {
        let cont = true;
        if (L.particleTimer >= 0) L.particleTimer--;
        if (L.removed) continue;
        if (L.teleporting) cont = this.checkLemTeleporting(L);
        if (cont && L.portalWarpFrame > 0) cont = this.checkLemPortalWarping(L);
        if (cont && L.explosionTimer !== 0) cont = !this.updateExplosionTimer(L);
        if (cont) cont = this.handleLemming(L);
        if (cont) cont = this.checkLevelBoundaries(L);
        if (cont) this.checkTriggerArea(L, false);
      }
      for (const L of this.lemmings) {
        if ((this.readZombieMap(L.x, L.y) & 1) !== 0 && L.action !== BA.EXITING && !L.isZombie) this.removeLemming(L, RM.ZOMBIE);
      }
    }

    simulateLem(L, doCheckObjects) {
      this.simulationDepth++;
      let handle = this.handleLemming(L);
      if (handle) handle = this.checkLevelBoundaries(L);
      if (handle && doCheckObjects) {
        const pos = this.getGadgetCheckPositions(L);
        for (let i = 0; i < pos.length; i++) {
          const px = pos[i][0], py = pos[i][1];
          if (this.lemNextAction !== BA.NONE && px === L.x && py === L.y) {
            this.transition(L, this.lemNextAction);
            this.lemNextAction = BA.NONE;
          }
          if ((this.hasTriggerAt(px, py, "TRAP") && this.findGadgetId(px, py, "TRAP") !== NO_OBJECT && !L.isDisarmer)
            || this.hasTriggerAt(px, py, "EXIT") || (this.hasTriggerAt(px, py, "WATER") && !L.isSwimmer)
            || this.hasTriggerAt(px, py, "FIRE") || this.hasTriggerAt(px, py, "ADDSKILL") || this.hasTriggerAt(px, py, "REMOVESKILLS")
            || (this.hasTriggerAt(px, py, "TELEPORT") && this.findGadgetId(px, py, "TELEPORT") !== NO_OBJECT)
            || (this.hasTriggerAt(px, py, "PORTAL") && this.findGadgetId(px, py, "PORTAL") !== NO_OBJECT)) {
            L.action = BA.EXPLODING;
            this.simulationDepth--;
            return;
          }
          if (this.hasTriggerAt(px, py, "WATER") && L.isSwimmer) this.lemNextAction = BA.SWIMMING;
          if (this.hasTriggerAt(px, py, "TRAP") && this.hasPixelAt(px, py) && L.isDisarmer) this.lemNextAction = BA.FIXING;
          if (L.x === px && L.y === py) break;
        }
        if (this.hasTriggerAt(L.x, L.y, "FORCELEFT", L)) this.handleForceField(L, -1);
        else if (this.hasTriggerAt(L.x, L.y, "FORCERIGHT", L)) this.handleForceField(L, 1);
      }
      this.simulationDepth--;
    }

    checkLemTeleporting(L) {
      const id = this.gadgets.findIndex((g) => g.teleLem === L.index);
      if (id < 0) return false;
      const g = this.gadgets[id];
      if (g.effect !== "RECEIVER") return false;
      if (g.meta.keyFrame === 0 && g.currentFrame < g.frameCount - 1) return false;
      if (g.meta.keyFrame > 0 && g.currentFrame < g.meta.keyFrame - 1) return false;
      L.teleporting = false;
      g.teleLem = -1;
      this.handlePostTeleport(L);
      return true;
    }

    handlePostTeleport(L) {
      this.checkTriggerArea(L, true);
      if (L.action === BA.BLOCKING) {
        if (this.checkForOverlappingField(L)) this.transition(L, BA.WALKING);
        else { L.hasBlockerField = true; this.setBlockerMap(); }
      }
      if ((L.action === BA.BUILDING || L.action === BA.PLATFORMING) && L.physicsFrame >= 9) L.constructivePositionFreeze = true;
      if (L.action === BA.BUILDING && (L.bricksLeft < 12 || L.physicsFrame >= 9)) {
        if (L.physicsFrame < 9) L.bricksLeft++;
        for (let i = 0; i <= 3; i++) this.addConstructivePixel(L.x + i * L.dx, L.y, this.brickColors[12 - L.bricksLeft]);
        if (L.physicsFrame < 9) L.bricksLeft--;
      } else if (L.action === BA.PLATFORMING && (L.bricksLeft < 12 || L.physicsFrame >= 9)) {
        if (L.physicsFrame < 9) L.bricksLeft++;
        this.addConstructivePixel(L.x, L.y, this.brickColors[12 - L.bricksLeft]);
        if (L.physicsFrame < 9) L.bricksLeft--;
      }
    }

    moveLemToReceivePoint(L, gadgetId) {
      const g = this.gadgets[gadgetId];
      const g2 = this.gadgets[g.receiverId];
      if (g.flipLemming) this.turnAround(L);
      L.x = g2.triggerRect.x0;
      L.y = g2.triggerRect.y0;
    }

    /** Which animation-trigger conditions hold for a gadget (TGadget.GetAnimFlagState). */
    animFlag(g, cond) {
      const base = g.effectBase;
      switch (cond) {
        case "unconditional": return true;
        case "ready":
          if (!inSet(base, ["TRAP", "TELEPORT", "RECEIVER", "PICKUP", "LOCKEXIT", "BUTTON", "WINDOW", "TRAPONCE", "ANIMATION", "ANIMONCE"])) return true;
          if (g.secondariesTreatAsBusy || g.effect === "NONE") return false;
          switch (base) {
            case "EXIT": return g.remainingLemmings !== 0;
            case "TRAP": case "TELEPORT": case "ANIMATION": return g.currentFrame === 0;
            case "LOCKEXIT": return g.currentFrame === 0 && g.remainingLemmings !== 0;
            case "BUTTON": case "TRAPONCE": case "ANIMONCE": return g.currentFrame === 1;
            case "PICKUP": return g.currentFrame % 2 !== 0;
            case "RECEIVER": return g.currentFrame === 0 && !g.holdActive;
            case "WINDOW": return g.currentFrame === 0 && g.remainingLemmings !== 0;
          }
          return true;
        case "busy":
          if (!inSet(base, ["TRAP", "TELEPORT", "RECEIVER", "LOCKEXIT", "BUTTON", "WINDOW", "TRAPONCE", "ANIMATION", "ANIMONCE"])) return false;
          if (g.secondariesTreatAsBusy) return true;
          switch (base) {
            case "TRAP": case "ANIMATION": case "TELEPORT": return g.currentFrame > 0;
            case "TRAPONCE": case "LOCKEXIT": case "BUTTON": case "WINDOW": case "ANIMONCE": return g.currentFrame > 1;
            case "RECEIVER": return g.currentFrame > 0 || g.holdActive;
          }
          return false;
        case "disabled":
          if (!inSet(base, ["EXIT", "TRAP", "PICKUP", "LOCKEXIT", "BUTTON", "WINDOW", "TRAPONCE", "ANIMONCE"])) return false;
          if (g.effect === "NONE") return true;
          switch (base) {
            case "EXIT": return g.remainingLemmings === 0;
            case "PICKUP": return g.currentFrame % 2 === 0;
            case "BUTTON": case "TRAPONCE": case "ANIMONCE": return g.currentFrame === 0;
            case "LOCKEXIT": return g.currentFrame === 1 || g.remainingLemmings === 0;
            case "WINDOW": return g.remainingLemmings === 0;
          }
          return false;
        case "exhausted":
          switch (base) {
            case "PICKUP": return g.currentFrame % 2 === 0;
            case "BUTTON": case "TRAPONCE": case "ANIMONCE": return g.currentFrame === 0;
            case "EXIT": case "LOCKEXIT": case "WINDOW": return g.remainingLemmings === 0;
          }
          return false;
      }
      return false;
    }

    updateGadgets() {
      for (let i = this.gadgets.length - 1; i >= 0; i--) {
        const g = this.gadgets[i];
        if ((g.triggered || ALWAYS_ANIMATE.has(g.effectBase)) && g.effect !== "PICKUP") g.currentFrame = g.currentFrame + 1;
        if (g.effect === "TELEPORT" && g.receiverId >= 0) {
          const g2 = this.gadgets[g.receiverId];
          if ((g.currentFrame >= g.frameCount && g.meta.keyFrame === 0) || (g.currentFrame === g.meta.keyFrame && g.meta.keyFrame !== 0)) {
            if (g.teleLem >= 0) {
              this.moveLemToReceivePoint(this.lemmings[g.teleLem], i);
              g2.teleLem = g.teleLem;
              g2.triggered = true;
              g2.zombieMode = g.zombieMode; g2.neutralMode = g.neutralMode;
              g.teleLem = -1;
            }
          }
          g.secondariesTreatAsBusy = g2.triggered;
        }
        if (g.currentFrame >= g.frameCount) {
          g.currentFrame = 0;
          g.triggered = false;
          g.holdActive = false;
          g.zombieMode = false; g.neutralMode = false;
        }
        // secondary animations (TGadgetAnimationInstance.UpdateOneFrame)
        for (const a of g.animations) {
          if (a.primary) continue;
          for (let t = a.meta.triggers.length - 1; t >= 0; t--) {
            const trig = a.meta.triggers[t];
            if (this.animFlag(g, trig.condition)) { a.state = trig.state; a.visible = trig.visible; break; }
          }
          if (a.state !== "pause" && (a.state !== "looptozero" || a.frame > 0)) a.frame = (a.frame + 1) % a.meta.frameCount;
          switch (a.state) {
            case "looptozero": if (a.frame === 0) a.state = "pause"; break;
            case "stop": a.frame = 0; a.state = "pause"; break;
            case "matchphysics": a.frame = g.currentFrame; break;
          }
        }
      }
    }

    drawAnimatedGadgets() {
      for (const g of this.gadgets) {
        if (g.effect !== "BACKGROUND" || !g.speed) continue;
        const AnimObjMov = [0, 1, 2, 2, 2, 2, 2, 1, 0, -1, -2, -2, -2, -2, -2, -1];
        const factor = Math.floor((2 * g.speed * (this.currentIteration + 1)) / 17) - Math.floor((2 * g.speed * this.currentIteration) / 17);
        const mx = Math.trunc((AnimObjMov[g.angleSegment] * factor) / 2);
        const my = Math.trunc((AnimObjMov[(g.angleSegment + 12) % 16] * factor) / 2);
        g.x += mx; g.y += my;
        let f = this.width + g.width;
        g.x = ((g.x + g.width + f) % f) - g.width;
        f = this.height + g.height;
        g.y = ((g.y + g.height + f) % f) - g.height;
        if (g.object) { g.object.x = g.x; g.object.y = g.y; }
      }
    }

    // ---- the player's controls

    setSelectedSkill(name) {
      if (this.activeSkills.indexOf(name) >= 0) this.selectedSkill = name;
    }

    /** Assign the selected skill to the lemming the cursor at (x, y) picks. */
    assignSkillAt(x, y, skillName) {
      const action = SKILL_TO_ACTION[skillName || this.selectedSkill];
      if (action === undefined) return false;
      const { lemming } = this.getPriorityLemming(action, x, y);
      if (!lemming || !this.checkSkillAvailable(action)) return false;
      return this.doSkillAssignment(lemming, action);
    }

    /** Assign to a specific lemming (what a recorded command replays). */
    assignSkillTo(L, skillName) {
      const action = SKILL_TO_ACTION[skillName];
      if (action === undefined || !L || L.removed) return false;
      if (!this.mayAssign(action, L) || !this.checkSkillAvailable(action)) return false;
      return this.doSkillAssignment(L, action);
    }

    nuke() {
      if (this.userSetNuking) return;
      this.userSetNuking = true;
      this.exploderAssignInProgress = true;
      if (!this.replay) this.recorded.push({ type: "nuke", frame: this.currentIteration });
    }

    setSpawnIntervalModifier(m) { this.spawnIntervalModifier = m; }

    /** Panel release rate, 1..99 (103 - SI). */
    get releaseRate() { return 103 - this.currSpawnInterval; }
    get minReleaseRate() { return 103 - this.level.spawnInterval; }

    /** How the level ends: SUCCEEDED, FAILED_LESS_LEMMINGS (in a DOS-style result), or null while playing. */
    result() {
      if (!this.gameFinished && !this.stateIsUnplayable) return null;
      return { success: this.lemmingsIn >= this.level.needCount, saved: this.lemmingsIn, needed: this.level.needCount,
        count: this.level.releaseCount, timeUp: this.isOutOfTime, talismans: Array.from(this.talismansAchieved) };
    }
  }

  Lemmix.BA = BA;
  Lemmix.ACTION_NAMES = ACTION_NAMES;
  Lemmix.SKILL_TO_ACTION = SKILL_TO_ACTION;
  Lemmix.ACTION_TO_SKILL = ACTION_TO_SKILL;
  Lemmix.SFX = SFX;
  Lemmix.Lemming = Lemming;
  Lemmix.LemGame = LemGame;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { BA, ACTION_NAMES, SKILL_TO_ACTION, Lemming, LemGame, SFX };
  }
})(typeof window !== "undefined" ? window : globalThis);
