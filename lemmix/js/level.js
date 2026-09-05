"use strict";
/**
 * A NeoLemmix level: parsed from its .nxlv text, then built into a Level
 * the rest of the engine (and the 3D layer) can use.
 *
 * Parsing follows LemLevel.pas: the header keys, $SKILLSET, $TERRAIN,
 * $GADGET (with its per-effect extras), $LEMMING, $TALISMAN, $PRETEXT and
 * $POSTTEXT, then Sanitize and PrepareForUse (spawn order, lemming count,
 * save requirement caps).
 *
 * Building follows LemRendering.pas: terrain pieces drawn in file order
 * onto the terrain layer with the no-overwrite / erase rules and, in the
 * same pass, onto the physics-prep map whose channels are solidity, steel
 * and one-way eligibility; the physics map is cut from that at ALPHA_CUTOFF,
 * one-way arrows are stamped onto it from their trigger areas, and pixels
 * that ended up non-solid are removed from the picture. Gadgets become
 * Lemmix.Gadget instances with their trigger rectangles and animations
 * (LemGadgets.pas), receivers paired to teleporters, and the resulting Level
 * exposes the same surface the DOS Level does - width/height, groundImage,
 * getGroundMaskLayer(), setGroundAt/clearGroundAt, objects, entrances - so
 * the diorama builds from it unchanged.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const { NxParser, Bitmap, Pixels } = Lemmix;
  const Lemmings = root.Lemmings || null;

  // TSkillPanelButton, in panel order
  const SKILLS = ["WALKER", "JUMPER", "SHIMMIER", "SLIDER", "CLIMBER", "SWIMMER", "FLOATER", "GLIDER",
    "DISARMER", "BOMBER", "STONER", "BLOCKER", "PLATFORMER", "BUILDER", "STACKER", "LASERER", "BASHER",
    "FENCER", "MINER", "DIGGER", "CLONER"];
  const MAX_SKILL_TYPES_PER_LEVEL = 10;
  const MIN_SI = 4, MAX_SI = 102;         // ReleaseRateToSpawnInterval(99), (1)

  // physics map bits (LemRenderHelpers.pas)
  const PM = {
    SOLID: 0x0001, STEEL: 0x0002, ONEWAY: 0x0004, ONEWAYLEFT: 0x0008, ONEWAYRIGHT: 0x0010,
    ONEWAYDOWN: 0x0020, ONEWAYUP: 0x0040, NOCANCELSTEEL: 0x0080, ORIGSOLID: 0x0100,
  };
  PM.TERRAIN = 0x01ff;

  const NO_FLIP_HORIZONTAL_TYPES = new Set(["PICKUP", "PORTAL"]);
  const NO_FLIP_VERTICAL_TYPES = new Set(["WINDOW", "PICKUP", "UPDRAFT", "PORTAL"]);
  const NO_ROTATE_TYPES = new Set(["WINDOW", "FORCELEFT", "FORCERIGHT", "PICKUP", "UPDRAFT", "FLIPPER", "PORTAL"]);

  const VIEWPORT_WIDTH = 320;  // what the DOS display shows; START_X is a centre

  /** A small deterministic generator, so "random" initial frames replay. */
  function seededRandom(seed) {
    let s = 0;
    for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    s = s || 1;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  // ------------------------------------------------------------ parsing

  /** The level file as plain data, before any graphics are involved. */
  function parseLevel(text) {
    const nx = NxParser.parse(text);
    const info = {
      title: (nx.get("TITLE") || "").trim(),
      author: (nx.get("AUTHOR") || "").trim(),
      theme: (nx.get("THEME") || "").trim().toLowerCase(),
      music: (nx.get("MUSIC") || "").trim(),
      id: (nx.get("ID") || "").trim(),
      lemmings: nx.int("LEMMINGS", 1),
      save: nx.int("SAVE_REQUIREMENT", 1),
      // seconds; absent or INFINITE = no limit
      timeLimit: nx.has("TIME_LIMIT") && String(nx.get("TIME_LIMIT")).toLowerCase() !== "infinite"
        ? nx.int("TIME_LIMIT", 1) : 0,
      spawnInterval: nx.has("MAX_SPAWN_INTERVAL") ? nx.int("MAX_SPAWN_INTERVAL", 53)
        : nx.has("RELEASE_RATE") ? 53 - (nx.int("RELEASE_RATE", 0) >> 1) : 53,
      spawnLocked: nx.has("SPAWN_INTERVAL_LOCKED") || nx.has("RELEASE_RATE_LOCKED"),
      width: nx.int("WIDTH", 320),
      height: nx.int("HEIGHT", 160),
      startX: nx.int("START_X", 0),
      startY: nx.int("START_Y", 0),
      startAuto: !nx.has("START_X") || !nx.has("START_Y"),
      background: (nx.get("BACKGROUND") || "").trim().toLowerCase(),
    };

    const skills = {};
    const skillset = nx.section("SKILLSET");
    if (skillset) {
      for (const name of SKILLS) {
        if (!skillset.has(name)) continue;
        const v = String(skillset.get(name)).trim().toLowerCase();
        skills[name] = v === "infinite" ? 100 : skillset.int(name, 0);
      }
    }

    const styleOf = (s) => (s.get("STYLE") !== null ? s.get("STYLE") : s.get("COLLECTION") || "").trim().toLowerCase();
    const pieceOf = (s) => (s.get("PIECE") || "").trim().toLowerCase();

    const terrains = nx.sectionsNamed("TERRAIN").map((s) => ({
      gs: styleOf(s), piece: pieceOf(s),
      x: s.int16("X", 0), y: s.int16("Y", 0),
      width: s.int("WIDTH", 0), height: s.int("HEIGHT", 0),
      oneWay: s.has("ONE_WAY"), rotate: s.has("ROTATE"), flip: s.has("FLIP_HORIZONTAL"),
      invert: s.has("FLIP_VERTICAL"), noOverwrite: s.has("NO_OVERWRITE"), erase: s.has("ERASE"),
    }));

    const gadgets = [];
    for (const s of nx.sectionsNamed("GADGET").concat(nx.sectionsNamed("OBJECT"))) {
      const dir = String(s.get("DIRECTION") || "").trim().toLowerCase().charAt(0);
      const g = {
        gs: styleOf(s), piece: pieceOf(s),
        x: s.int16("X", 0), y: s.int16("Y", 0),
        width: s.int("WIDTH", 0), height: s.int("HEIGHT", 0),
        rotate: s.has("ROTATE"), flip: s.has("FLIP_HORIZONTAL"), invert: s.has("FLIP_VERTICAL"),
        noOverwrite: s.has("NO_OVERWRITE"), onlyOnTerrain: s.has("ONLY_ON_TERRAIN"),
        lemmingCap: s.int("LEMMINGS", 0),
        pairing: s.int("PAIRING", 0),
        skill: (s.get("SKILL") || "").trim().toUpperCase(),
        skillCount: Math.max(s.has("SKILL_COUNT") ? s.int("SKILL_COUNT", 1) : s.int("SKILLCOUNT", 1), 1),
        direction: dir === "l" ? "l" : dir === "r" ? "r" : "",
        presets: {
          slider: s.has("SLIDER"), climber: s.has("CLIMBER"), swimmer: s.has("SWIMMER"),
          floater: s.has("FLOATER"), glider: s.has("GLIDER"), disarmer: s.has("DISARMER"),
          zombie: s.has("ZOMBIE"), neutral: s.has("NEUTRAL"),
        },
        angle: s.int("ANGLE", 0), speed: s.int("SPEED", 0),
      };
      gadgets.push(g);
    }

    const lemmings = nx.sectionsNamed("LEMMING").map((s) => {
      const dir = String(s.get("DIRECTION") || "").trim().toLowerCase().charAt(0);
      return {
        x: s.int16("X", 0), y: s.int16("Y", 0),
        dx: s.has("FLIP_HORIZONTAL") || dir === "l" ? -1 : 1,
        shimmier: s.has("SHIMMIER"), slider: s.has("SLIDER"), climber: s.has("CLIMBER"),
        swimmer: s.has("SWIMMER"), floater: s.has("FLOATER"), glider: s.has("GLIDER"),
        disarmer: s.has("DISARMER"), zombie: s.has("ZOMBIE"), neutral: s.has("NEUTRAL"),
        blocker: s.has("BLOCKER"),
      };
    });

    const talismans = nx.sectionsNamed("TALISMAN").map((s) => {
      const t = {
        title: (s.get("TITLE") || "").trim(), id: s.int("ID", 0),
        color: (s.get("COLOR") || "bronze").trim().toLowerCase(),
        save: s.has("SAVE_REQUIREMENT") ? s.int("SAVE_REQUIREMENT", -1) : s.int("SAVE", -1),
        timeLimit: s.int("TIME_LIMIT", -1),        // frames
        skillLimit: s.int("SKILL_LIMIT", -1), skillTypeLimit: s.int("SKILL_TYPE_LIMIT", -1),
        skillEachLimit: s.int("SKILL_EACH_LIMIT", -1),
        useOnlySkill: (s.get("USE_ONLY_SKILL") || "").trim().toUpperCase() || null,
        limits: {},
      };
      for (const name of SKILLS) if (s.has(name + "_LIMIT")) t.limits[name] = s.int(name + "_LIMIT", -1);
      return t;
    });

    const lines = (name) => nx.sectionsNamed(name).flatMap((s) => s.getAll("LINE"));
    return { info, skills, terrains, gadgets, lemmings, talismans, pretext: lines("PRETEXT"), posttext: lines("POSTTEXT") };
  }

  // ------------------------------------------------------------- gadgets

  /** A placed gadget: its metadata variation, trigger area and animation state. */
  class Gadget {
    constructor(spec, meta, v, index, rand) {
      this.spec = spec;
      this.meta = meta;
      this.v = v;             // the orientation-specific metadata
      this.index = index;
      this.x = spec.x;
      this.y = spec.y;
      this.flip = spec.flip; this.invert = spec.invert; this.rotate = spec.rotate;
      this.noOverwrite = spec.noOverwrite;
      this.onlyOnTerrain = spec.onlyOnTerrain;
      this.width = evaluateResizable(spec.width, v.defaultWidth, v.width, v.resizeH);
      this.height = evaluateResizable(spec.height, v.defaultHeight, v.height, v.resizeV);
      this.widthVariance = this.width - v.width;
      this.heightVariance = this.height - v.height;
      this.effectBase = meta.effect;
      this.effect = adjustOwwDirection(meta.effect, spec);
      if (spec.flip) {
        if (this.effect === "FORCELEFT") this.effect = "FORCERIGHT";
        else if (this.effect === "FORCERIGHT") this.effect = "FORCELEFT";
      }
      this.lemmingCap = spec.lemmingCap;
      this.pairing = spec.pairing;
      this.skillName = spec.skill;
      this.skill = SKILLS.indexOf(spec.skill); // -1 = none
      this.skillCount = spec.skillCount;
      this.presets = spec.presets;
      this.flipLemming = spec.flip || spec.direction === "l"; // windows face left; splitters start left
      if (meta.effect === "FLIPPER") this.flipLemming = spec.direction === "l";
      this.angleSegment = ((Math.round(spec.angle / 22.5) % 16) + 16) % 16;
      this.speed = spec.speed;
      this.receiverId = -1;
      this.pairingId = -1;
      this.remainingLemmings = this.lemmingCap > 0 ? this.lemmingCap : -1;
      this.holdActive = false;
      this.triggered = false;
      this.secondariesTreatAsBusy = false;
      this.offMap = spec.x <= -30000 || spec.y <= -30000;
      this.triggerRect = this.computeTriggerRect();
      // animation instances (TGadgetAnimationInstance.Create)
      this.animations = v.animations.map((a) => {
        let frame;
        if (a.startFrame < 0) frame = Math.floor(rand() * a.frameCount);
        else frame = a.startFrame < a.frameCount ? a.startFrame : 0;
        if (a.primary) {
          if (meta.effect === "PICKUP" || meta.effect === "ADDSKILL") frame = Math.max(this.skill, 0) * 2 + 1;
          if (["LOCKEXIT", "BUTTON", "WINDOW", "TRAPONCE", "ANIMONCE"].includes(meta.effect)) frame = 1;
          if (meta.effect === "FLIPPER" && this.flipLemming) frame = 1;
        }
        return { meta: a, frame, state: a.baseState, visible: a.baseVisible, primary: a.primary };
      });
      this.primaryAnimation = this.animations.find((a) => a.primary);
      this._frameCache = new Map();
    }

    get currentFrame() { return this.primaryAnimation ? this.primaryAnimation.frame : 0; }
    set currentFrame(f) { if (this.primaryAnimation) this.primaryAnimation.frame = f; }
    get frameCount() { return this.primaryAnimation ? this.primaryAnimation.meta.frameCount : 1; }

    /** TGadget.GetTriggerRect - half-open: right and bottom lines excluded. */
    computeTriggerRect() {
      const v = this.v;
      let x = this.x + v.trigger.x, y = this.y + v.trigger.y, w = v.trigger.w, h = v.trigger.h;
      if (v.resizeH) w += this.width - v.width;
      if (v.resizeV) h += this.height - v.height;
      if (this.effectBase === "RECEIVER") {
        if (w > 1 || h > 1) {
          x += w >> 1;
          y = this.y + Math.min(this.height, v.trigger.y + h - 1);
        }
        w = 1; h = 1;
      }
      return { x0: x, y0: y, x1: x + w, y1: y + h };
    }

    /** The number NeoLemmix writes on this gadget, if any (pickup count, exit/window capacity). */
    digits() {
      if (this.effect === "PICKUP" || this.effectBase === "PICKUP") {
        if (this.skillCount > 1 || this.meta.digitMinLength >= 1) return { value: this.skillCount, min: this.meta.digitMinLength };
      } else if (["EXIT", "LOCKEXIT", "WINDOW"].includes(this.effectBase) && this.remainingLemmings >= 0) {
        return { value: this.remainingLemmings, min: this.meta.digitMinLength };
      }
      return null;
    }

    /** The composite picture of every visible animation, at this moment. */
    render() {
      const digits = Lemmix.digitFont ? this.digits() : null;
      const digitText = digits && (digits.value > 0 || digits.min > 0) ? String(digits.value).padStart(digits.min, "0") : "";
      const key = this.animations.map((a) => (a.visible || a.state !== "pause") ? a.frame : "-").join(",") + "|" + digitText;
      if (this._frameCache.has(key)) return this._frameCache.get(key);
      // the composite spans every animation's box, offsets included
      let x0 = 0, y0 = 0, x1 = this.width, y1 = this.height;
      let digitBox = null;
      if (digitText) {
        // DrawNumberWithCountdownDigits: 4x5 digits 5 px apart, at DIGIT_X/Y with the alignment
        const dw = digitText.length * 5;
        const dx = this.v.digit.x, dy = this.v.digit.y - 2;
        const left = this.v.digit.align < 0 ? dx : this.v.digit.align > 0 ? dx - dw + 1 : dx - (dw >> 1) + 1;
        digitBox = { left: left - 1, top: dy, right: left + dw + 1, bottom: dy + 7 };
        x0 = Math.min(x0, digitBox.left); y0 = Math.min(y0, digitBox.top);
        x1 = Math.max(x1, digitBox.right); y1 = Math.max(y1, digitBox.bottom);
      }
      for (const a of this.animations) {
        x0 = Math.min(x0, a.meta.offsetX); y0 = Math.min(y0, a.meta.offsetY);
        x1 = Math.max(x1, a.meta.offsetX + a.meta.width + this.widthVariance);
        y1 = Math.max(y1, a.meta.offsetY + a.meta.height + this.heightVariance);
      }
      const bmp = new Bitmap(x1 - x0, y1 - y0);
      for (const a of this.animations) {
        if (!a.visible && a.state === "pause") continue;
        const src = a.meta.frames[a.frame % a.meta.frames.length];
        Pixels.drawNineSlice(bmp, a.meta.offsetX - x0, a.meta.offsetY - y0,
          a.meta.width + this.widthVariance, a.meta.height + this.heightVariance, src, a.meta.cut, Pixels.combineGadget);
      }
      if (digitText) {
        const font = Lemmix.digitFont;
        let cx = digitBox.left + 1 - x0;
        for (const ch of digitText) {
          const d = ch.charCodeAt(0) - 48;
          const shadow = (ox, oy) => Pixels.blit(bmp, cx + ox, digitBox.top + 1 + oy - y0, font, d * 4, 0, 4, 5, (fd, fi, bd, bi) => {
            if (fd[fi + 3]) { bd[bi] = 0x20; bd[bi + 1] = 0x20; bd[bi + 2] = 0x20; bd[bi + 3] = 255; }
          });
          shadow(-1, 1); shadow(0, 0); shadow(0, 1);
          Pixels.blit(bmp, cx - 1, digitBox.top + 1 - y0, font, d * 4, 0, 4, 5, Pixels.mergeOver);
          cx += 5;
        }
      }
      const frame = frameFromBitmap(bmp, x0, y0);
      this._frameCache.set(key, frame);
      return frame;
    }
  }

  function evaluateResizable(specified, dflt, base, resizable) {
    if (!resizable) return base;
    if (specified > 0) return specified;
    if (dflt > 0) return dflt;
    return base;
  }

  /** A flipped or rotated arrow points another way (TGadget.AdjustOWWDirection). */
  function adjustOwwDirection(effect, spec) {
    const DIRS = ["ONEWAYLEFT", "ONEWAYUP", "ONEWAYRIGHT", "ONEWAYDOWN"];
    let d = DIRS.indexOf(effect);
    if (d < 0) return effect;
    if (spec.rotate) d += 1;
    if (spec.flip && d % 2 === 0) d += 2;
    if (spec.invert && d % 2 === 1) d += 2;
    return DIRS[d % 4];
  }

  /** A Lemmings.Frame (or a stand-in under node) from a bitmap. */
  function frameFromBitmap(bmp, offsetX, offsetY) {
    let frame;
    if (Lemmings && Lemmings.Frame) frame = new Lemmings.Frame(bmp.width, bmp.height, offsetX, offsetY);
    else {
      frame = { width: bmp.width, height: bmp.height, offsetX, offsetY,
        data: new Uint32Array(bmp.width * bmp.height), mask: new Int8Array(bmp.width * bmp.height),
        getData() { return new Uint8ClampedArray(this.data.buffer); }, getMask() { return this.mask; } };
    }
    frame.data.set(bmp.words());
    const d = bmp.data, m = frame.mask;
    for (let i = 0, p = 3; i < m.length; i++, p += 4) m[i] = d[p] !== 0 ? 1 : 0;
    return frame;
  }

  // -------------------------------------------------------------- level

  class SolidLayerFallback {
    constructor(width, height, mask) { this.width = width; this.height = height; this.groundMask = mask; }
    hasGroundAt(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height && this.groundMask[x + y * this.width] !== 0; }
    setGroundAt(x, y) { this.groundMask[x + y * this.width] = 1; }
    clearGroundAt(x, y) { this.groundMask[x + y * this.width] = 0; }
  }

  class Level {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.name = "";
      this.groundImage = null;      // RGBA bytes, width*height*4
      this.groundMask = null;       // SolidLayer
      this.physics = null;          // Uint16Array of PM bits
      this.objects = [];            // gadgets on the map, for drawing
      this.gadgets = [];            // every gadget, for physics
      this.entrances = [];          // window gadgets
      this.triggers = [];
      this.releaseCount = 0;
      this.needCount = 0;
      this.timeLimit = 0;
      this.screenPositionX = 0;
      this.skills = [];
      this.isSuperLemming = false;
    }

    getGroundMaskLayer() { return this.groundMask; }
    hasGroundAt(x, y) { return this.groundMask.hasGroundAt(x, y); }
    hasSteelAt(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height && (this.physics[x + y * this.width] & PM.STEEL) !== 0; }
    oneWayAt(x, y) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
      return this.physics[x + y * this.width] & (PM.ONEWAYLEFT | PM.ONEWAYRIGHT | PM.ONEWAYDOWN | PM.ONEWAYUP);
    }

    /** Add a pixel of ground in this ABGR colour (a brick, a stoner). */
    setGroundAt(x, y, color) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
      const i = x + y * this.width;
      this.groundMask.setGroundAt(x, y);
      this.physics[i] |= PM.SOLID;
      new Uint32Array(this.groundImage.buffer)[i] = color >>> 0;
    }

    clearGroundAt(x, y) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
      const i = x + y * this.width;
      this.groundMask.clearGroundAt(x, y);
      this.physics[i] &= ~PM.TERRAIN;
      new Uint32Array(this.groundImage.buffer)[i] = 0;
    }

    /** What the DOS engine's renderer does: the whole ground onto a display. */
    render(gameDisplay) {
      gameDisplay.initSize(this.width, this.height);
      gameDisplay.setBackground(this.groundImage, this.groundMask);
    }
  }

  /** An unresolvable piece becomes default:fallback, as NeoLemmix does. */
  async function resolveTerrain(styles, t) {
    const d = await styles.dealias(t.gs, t.piece, "terrain");
    let meta = await styles.terrain(d.gs, d.piece);
    if (!meta) {
      styles.missing.add(t.gs + ":" + t.piece);
      meta = await styles.terrain("default", "fallback");
    }
    return { meta, defWidth: d.defWidth, defHeight: d.defHeight };
  }

  async function resolveGadget(styles, g) {
    const d = await styles.dealias(g.gs, g.piece, "gadget");
    let meta = await styles.gadget(d.gs, d.piece);
    if (!meta) {
      styles.missing.add(g.gs + ":" + g.piece);
      meta = await styles.gadget("default", "fallback");
    }
    return { meta, defWidth: d.defWidth, defHeight: d.defHeight };
  }

  /**
   * Build the level: graphics, physics map, gadgets. `data` is parseLevel's
   * result; `styles` a StyleManager; `seed` makes the random initial frames
   * repeatable (the level id by default).
   */
  async function build(data, styles, options) {
    options = options || {};
    const info = data.info;
    const rand = seededRandom(options.seed || info.id || info.title);

    // ---- sanitize (TLevel.Sanitize)
    const width = Math.max(1, info.width), height = Math.max(1, info.height);
    const spawnInterval = Math.max(MIN_SI, Math.min(MAX_SI, info.spawnInterval));

    // ---- pieces
    const terrainMeta = await Promise.all(data.terrains.map((t) => resolveTerrain(styles, t)));
    const gadgetMeta = await Promise.all(data.gadgets.map((g) => resolveGadget(styles, g)));
    const theme = (await styles.style(info.theme || "default")).theme;

    // ---- terrain: the picture and the physics-prep map, in one pass
    const picture = new Bitmap(width, height);
    const prep = new Bitmap(width, height);
    const pieces = [];   // every placement, for the diorama's depth tagging
    const drawnCache = new Map();
    data.terrains.forEach((t, i) => {
      const { meta, defWidth, defHeight } = terrainMeta[i];
      if (!meta) return;
      const v = meta.variation(t.flip, t.invert, t.rotate);
      const w = evaluateResizable(t.width || defWidth, v.defaultWidth, v.width, v.resizeH);
      const h = evaluateResizable(t.height || defHeight, v.defaultHeight, v.height, v.resizeV);
      const key = meta.gs + ":" + meta.piece;
      const variantKey = key + "/" + (t.flip ? "f" : "") + (t.invert ? "i" : "") + (t.rotate ? "r" : "") + "/" + w + "x" + h;
      if (!drawnCache.has(variantKey)) {
        let image = v.image;
        if (w !== v.width || h !== v.height) {
          image = new Bitmap(w, h);
          Pixels.drawNineSlice(image, 0, 0, w, h, v.image, v.cut, Pixels.combineGadget);
        }
        drawnCache.set(variantKey, { key, variantKey, image, width: w, height: h, steel: meta.steel });
      }
      pieces.push({ x: t.x, y: t.y, drawn: drawnCache.get(variantKey), noOverwrite: t.noOverwrite, erase: t.erase, oneWay: t.oneWay });
      const combine = t.noOverwrite ? Pixels.combineTerrainNoOverwrite
        : t.erase ? Pixels.combineTerrainErase : Pixels.combineTerrainDefault;
      Pixels.drawNineSlice(picture, t.x, t.y, w, h, v.image, v.cut, combine);
      const kind = t.erase ? "erase" : meta.steel ? "steel" : t.oneWay ? "oneway" : "standard";
      Pixels.drawNineSlice(prep, t.x, t.y, w, h, v.image, v.cut,
        Pixels.physicsCombiner(kind, t.noOverwrite && !t.erase));
    });

    // ---- the physics map (GeneratePhysicsMapFromInfoMap)
    const physics = new Uint16Array(width * height);
    const pd = prep.data;
    for (let i = 0, p = 0; i < physics.length; i++, p += 4) {
      const sol = pd[p + 3];
      if (sol < Pixels.ALPHA_CUTOFF) continue;
      let c = PM.SOLID | PM.ORIGSOLID;
      const mod = sol / 255, cutoff = Pixels.ALPHA_CUTOFF * mod;
      if (pd[p] * mod >= cutoff) c |= PM.STEEL;
      else if (pd[p + 1] * mod >= cutoff) c |= PM.ONEWAY;
      physics[i] = c;
    }

    // ---- gadgets
    const gadgets = data.gadgets.map((g, i) => {
      const { meta, defWidth, defHeight } = gadgetMeta[i];
      if (!meta) return null;
      const spec = Object.assign({}, g);
      if (meta.effect !== "NONE") {
        if (NO_FLIP_HORIZONTAL_TYPES.has(meta.effect)) spec.flip = false;
        if (NO_FLIP_VERTICAL_TYPES.has(meta.effect)) spec.invert = false;
        if (NO_ROTATE_TYPES.has(meta.effect)) spec.rotate = false;
      }
      if (!spec.width) spec.width = defWidth;
      if (!spec.height) spec.height = defHeight;
      return new Gadget(spec, meta, meta.variation(spec.flip, spec.invert, spec.rotate), i, rand);
    }).filter(Boolean);
    findReceivers(gadgets);

    // ---- one-way arrows onto the physics map (ApplyOWW, RemoveOverlappingOWWs, Validate)
    const OWW = { ONEWAYLEFT: PM.ONEWAYLEFT, ONEWAYRIGHT: PM.ONEWAYRIGHT, ONEWAYDOWN: PM.ONEWAYDOWN, ONEWAYUP: PM.ONEWAYUP };
    for (const g of gadgets) {
      const bit = OWW[g.effect];
      if (!bit) continue;
      const r = g.triggerRect;
      for (let y = Math.max(0, r.y0); y < Math.min(height, r.y1); y++) {
        for (let x = Math.max(0, r.x0); x < Math.min(width, r.x1); x++) physics[x + y * width] |= bit;
      }
    }
    const ALL_OWW = PM.ONEWAYLEFT | PM.ONEWAYRIGHT | PM.ONEWAYDOWN | PM.ONEWAYUP;
    for (let i = 0; i < physics.length; i++) {
      let c = physics[i];
      const bits = c & ALL_OWW;
      // RemoveOverlappingOWWs: a one-way pixel keeps its bits only under
      // exactly one arrow - none, and it is not one-way at all (which is
      // what the arrows are drawn through: only PM_ONEWAY pixels show them)
      if (bits === 0 || (bits & (bits - 1)) !== 0) c &= ~(PM.ONEWAY | ALL_OWW);
      if ((c & PM.SOLID) === 0) c &= ~PM.TERRAIN;
      if (c & PM.STEEL) c &= ~PM.ONEWAY;
      if ((c & PM.ONEWAY) === 0) c &= ~ALL_OWW;
      c &= ~PM.NOCANCELSTEEL;
      physics[i] = c;
    }

    // ---- the picture keeps only solid pixels (ApplyRemovedTerrain)
    const mask = new Int8Array(width * height);
    const words = picture.words();
    for (let i = 0; i < physics.length; i++) {
      if (physics[i] & PM.SOLID) mask[i] = 1;
      else words[i] = 0;
    }

    // ---- background: the theme colour, and a tiled image if named
    const bgColor = Lemmix.StyleManager.themeColor(theme, "BACKGROUND");
    let bgImage = null;
    if (info.background && info.background !== ":") {
      const id = Lemmix.splitIdentifier(info.background, info.theme);
      bgImage = (await styles.background(id.gs, id.piece)) || (await styles.background("default", "fallback"));
    }

    // ---- the level
    const level = new Level(width, height);
    level.name = info.title;
    level.info = info;
    level.theme = theme;
    level.themeName = info.theme;
    level.groundImage = picture.data;
    level.groundMask = new (Lemmings && Lemmings.SolidLayer ? Lemmings.SolidLayer : SolidLayerFallback)(width, height, mask);
    level.physics = physics;
    level.gadgets = gadgets;
    level.pieces = pieces;
    level.objects = gadgets.filter((g) => !g.offMap).map((g) => gadgetAsObject(g));
    level.entrances = gadgets.filter((g) => g.effectBase === "WINDOW");
    level.preplaced = data.lemmings;
    level.talismans = data.talismans;
    level.pretext = data.pretext;
    level.posttext = data.posttext;
    level.background = { color: bgColor, image: bgImage };
    level.spawnInterval = spawnInterval;
    level.spawnLocked = info.spawnLocked;
    level.timeLimitSeconds = Math.min(5999, info.timeLimit);
    level.timeLimit = 0; // the DOS engine's minutes field: not used here
    level.missingPieces = Array.from(styles.missing);

    // ---- skills (Sanitize + PrepareForUse step 1)
    const pickupSkills = new Set(gadgets.filter((g) => g.effectBase === "PICKUP").map((g) => g.skillName));
    let types = 0;
    level.skills = [];
    for (const name of SKILLS) {
      if (!(name in data.skills)) continue;
      let count = Math.max(0, Math.min(100, data.skills[name]));
      if (++types > MAX_SKILL_TYPES_PER_LEVEL) continue;
      if (count === 0 && !pickupSkills.has(name)) continue;
      if (name === "CLONER" && count > 99) count = 99;
      level.skills.push({ name, count });
    }

    // ---- lemming count and spawn order (PrepareForUse steps 2-3)
    prepareSpawn(level, info, gadgets, data.lemmings);

    // ---- where the screen starts (START_X/Y are a centre; auto when absent)
    let startX = info.startX, startY = info.startY;
    if (info.startAuto) [startX, startY] = autoScreenStart(level, gadgets, data.lemmings);
    startX = Math.max(0, Math.min(width - 1, startX));
    startY = Math.max(0, Math.min(height - 1, startY));
    level.startX = startX;
    level.startY = startY;
    level.screenPositionX = Math.max(0, Math.min(Math.max(0, width - VIEWPORT_WIDTH), startX - (VIEWPORT_WIDTH >> 1)));
    return level;
  }

  /** TGadgetList.FindReceiverID: each teleporter takes the next receiver with its pairing. */
  function findReceivers(gadgets) {
    const n = gadgets.length;
    const used = new Array(n).fill(false);
    let pairCount = 0;
    for (let i = 0; i < n; i++) {
      const g = gadgets[i];
      if (g.effect === "TELEPORT") {
        let test = i, found = null;
        do {
          test++;
          found = gadgets[test % n];
        } while (!((found.effect === "RECEIVER" && found.pairing === g.pairing) || test === i + n));
        test %= n;
        if (test === i) { g.effect = "NONE"; continue; }
        g.receiverId = test;
        if (used[test]) {
          // a receiver shared by teleporters is cloned for each
          const clone = new Gadget(found.spec, found.meta, found.v, gadgets.length, () => 0);
          gadgets.push(clone); used.push(false);
          g.receiverId = gadgets.length - 1;
          found = clone;
        }
        g.pairingId = pairCount; found.pairingId = pairCount; pairCount++;
        used[test] = true;
        found.flipLemming = g.flipLemming; // SetFlipOfReceiverTo
      }
    }
    for (let i = 0; i < n; i++) {
      const g = gadgets[i];
      if (g.effect !== "PORTAL" || used[i]) continue;
      let test = i, found = null;
      do { test++; found = gadgets[test % n]; } while (!((found.effect === "PORTAL" && found.pairing === g.pairing) || test === i + n));
      test %= n;
      if (test === i) { g.effect = "NONE"; continue; }
      g.receiverId = test; found.receiverId = i;
      used[i] = true; used[test] = true;
      g.pairingId = pairCount; found.pairingId = pairCount; pairCount++;
      found.flipLemming = g.flipLemming;
    }
    for (let i = 0; i < n; i++) {
      if (gadgets[i].effect === "RECEIVER" && !used[i]) gadgets[i].effect = "NONE";
    }
  }

  /** TLevel.PrepareForUse steps 2 and 3: which window releases each lemming, and the counts. */
  function prepareSpawn(level, info, gadgets, preplaced) {
    const windows = gadgets.map((g) => g.effectBase === "WINDOW" ? (g.lemmingCap > 0 ? g.lemmingCap : -1) : 0);
    const hasWindow = windows.some((w) => w !== 0);
    let lemmingsCount = Math.max(info.lemmings, preplaced.length);
    let zombies = preplaced.filter((l) => l.zombie).length;
    let neutrals = preplaced.filter((l) => !l.zombie && l.neutral).length;
    const spawnOrder = [];
    if (!hasWindow) {
      lemmingsCount = preplaced.length;
    } else {
      let n = -1, spawned = preplaced.length;
      const total = lemmingsCount - preplaced.length;
      for (let i = 0; i < total; i++) {
        // SetNextWindow
        const initial = n === -1 ? gadgets.length - 1 : n;
        let dead = false;
        do {
          n++;
          if (n >= gadgets.length) n = 0;
          if (n === initial && windows[n] === 0) { dead = true; break; }
        } while (windows[n] === 0);
        if (dead) { lemmingsCount = spawned; break; }
        const g = gadgets[n];
        if (g.presets.zombie) zombies++;
        else if (g.presets.neutral) neutrals++;
        spawnOrder.push(n);
        if (windows[n] > 0) windows[n]--;
        spawned++;
      }
    }
    let maxLemmings = lemmingsCount + (level.skills.find((s) => s.name === "CLONER") || { count: 0 }).count - zombies;
    let maxExit = 0;
    for (const g of gadgets) {
      if (g.effectBase === "EXIT" || g.effectBase === "LOCKEXIT") {
        if (g.lemmingCap > 0 && maxExit >= 0) maxExit += g.lemmingCap;
        else maxExit = -1;
      }
      if (g.effectBase === "PICKUP" && g.skillName === "CLONER") maxLemmings += g.skillCount;
    }
    let save = Math.max(0, info.save);
    if (save > maxLemmings) save = maxLemmings;
    if (maxExit >= 0 && save > maxExit) save = maxExit;
    level.releaseCount = lemmingsCount;
    level.needCount = save;
    level.zombieCount = zombies;
    level.neutralCount = neutrals;
    level.spawnOrder = spawnOrder;
  }

  /** TLevel.CalculateAutoScreenStart. */
  function autoScreenStart(level, gadgets, preplaced) {
    const entrances = gadgets.filter((g) => g.effectBase === "WINDOW" && !g.presets.zombie && !g.presets.neutral);
    const exits = gadgets.filter((g) => g.effectBase === "EXIT" || g.effectBase === "LOCKEXIT");
    const lems = preplaced.filter((l) => !l.zombie && !l.neutral);
    let hx = level.width >> 1, hy = level.height >> 1, targetDx = 0, vertShift = false;
    let ax = 0, ay = 0;
    if (entrances.length) {
      for (const g of entrances) { ax += g.triggerRect.x0; ay += g.triggerRect.y0; }
      ax /= entrances.length; ay /= entrances.length;
    } else if (lems.length) {
      for (const l of lems) { ax += l.x; ay += l.y; }
      ax /= lems.length; ay /= lems.length;
    }
    let closest = -1;
    const tryPos = (x, y, dx, shift) => {
      const d = Math.sqrt((x - ax) * (x - ax) + (y - ay) * (y - ay));
      if (d < closest || closest < 0) { closest = d; hx = x; hy = y; targetDx = dx; vertShift = shift; }
    };
    for (const g of entrances) tryPos(g.triggerRect.x0, g.triggerRect.y0, g.flipLemming ? -1 : 1, true);
    for (const g of exits) tryPos(g.triggerRect.x0 + ((g.triggerRect.x1 - g.triggerRect.x0) >> 1),
      g.triggerRect.y0 + ((g.triggerRect.y1 - g.triggerRect.y0) >> 1), 0, false);
    for (const l of lems) tryPos(l.x, l.y, l.dx, false);
    if (targetDx !== 0) hx += 48 * targetDx;
    hy += vertShift ? 20 : -12;
    return [hx, hy];
  }

  /** The MapObject shape the 3D layer draws: position, animation frames, draw flags. */
  const OWW_EFFECTS = new Set(["ONEWAYLEFT", "ONEWAYRIGHT", "ONEWAYDOWN", "ONEWAYUP"]);

  function gadgetAsObject(g) {
    const frames = [];
    const count = g.frameCount;
    const saved = g.currentFrame;
    for (let f = 0; f < count; f++) { g.currentFrame = f; frames.push(g.render()); }
    g.currentFrame = saved;
    // NeoLemmix's layers (LemRendering.pas, DrawGadgetsOnLayer): a moving
    // background is behind the terrain; a NO_OVERWRITE gadget is "gadgets low",
    // under the terrain where they overlap but part of the scene, not the
    // backdrop - in the diorama the slab's depth test does that ordering, so
    // it sits in the slab with the other objects (a step behind them in the
    // 2D view, which has only its terrain quad to hide it), and only the
    // moving backgrounds go behind the slab; ONLY_ON_TERRAIN is a decal over
    // it; a gadget carrying both flags is an ordinary one.
    // A one-way arrow is its own layer (rlOneWayArrows), over the terrain
    // and cut to its PM_ONEWAY pixels whatever flags it carries: a decal.
    const oneWay = OWW_EFFECTS.has(g.effect);
    const behind = g.effectBase === "BACKGROUND" && !g.onlyOnTerrain && !oneWay;
    const low = g.noOverwrite && !g.onlyOnTerrain && !behind && !oneWay;
    const decal = oneWay || (g.onlyOnTerrain && !g.noOverwrite);
    const drawProperties = Lemmings && Lemmings.DrawProperties
      ? new Lemmings.DrawProperties(false, behind, decal, false)
      : { isUpsideDown: false, noOverwrite: behind, onlyOverwrite: decal, isErase: false };
    drawProperties.low = low;
    drawProperties.oneWay = oneWay;
    const object = {
      x: g.x, y: g.y, gadget: g, drawProperties,
      animation: {
        frames, isRepeat: true, firstFrameIndex: 0,
        getFrame() { return g.render(); },
      },
    };
    g.object = object;
    return object;
  }

  Lemmix.SKILLS = SKILLS;
  Lemmix.PM = PM;
  Lemmix.Level = Level;
  Lemmix.Gadget = Gadget;
  Lemmix.LevelBuilder = { parseLevel, build, evaluateResizable, frameFromBitmap };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseLevel, build, Level, Gadget, SKILLS, PM };
  }
})(typeof window !== "undefined" ? window : globalThis);
