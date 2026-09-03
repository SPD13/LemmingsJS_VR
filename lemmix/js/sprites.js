"use strict";
/**
 * The lemming sprites of a NeoLemmix sprite set (styles/<set>/lemmings/):
 * one PNG per animation, frames stacked vertically, the left-facing frames
 * in the left half of the image and the right-facing ones in the right half
 * (LemAnimationSet.pas ReadData), with scheme.nxmi giving frame counts, the
 * loop point and the foot position per direction. Frames come out as
 * Lemmings.Frame objects offset by the foot, so `display.drawFrame(frame,
 * lem.x, lem.y)` puts the feet on the lemming's position.
 *
 * State recolouring (scheme.nxmi $STATE_RECOLORING): an athlete (any
 * permanent skill), a zombie or a neutral lemming swaps the listed colours;
 * each variant is built once and kept.
 *
 * Also here: the physics masks of gfx/mask (bomber, stoner, basher, fencer,
 * miner, laser) the game carves terrain with.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const { NxParser, Bitmap } = Lemmix;
  const Lemmings = root.Lemmings || null;

  // the file for each action (TBasicLemmingAction order), null where NeoLemmix has no sprite
  const ACTION_SPRITES = [null, "walker", "ascender", "digger", "climber", "drowner", "hoister", "builder",
    "basher", "miner", "faller", "floater", "splatter", "exiter", "burner", "blocker", "shrugger", "ohnoer",
    "bomber", "walker", "platformer", "stacker", "ohnoer", "stoner", "swimmer", "glider", "disarmer", null,
    "fencer", "reacher", "shimmier", "jumper", "dehoister", "slider", "laserer"];
  const ANIM_NAMES = ["walker", "ascender", "digger", "climber", "drowner", "hoister", "builder", "basher",
    "miner", "faller", "floater", "splatter", "exiter", "burner", "blocker", "shrugger", "ohnoer", "bomber",
    "platformer", "stoner", "swimmer", "glider", "disarmer", "stacker", "fencer", "reacher", "shimmier",
    "jumper", "dehoister", "slider", "laserer"];

  class SpriteSet {
    constructor(io) {
      this.io = io;
      this.anims = {};      // name -> {frameCount, frameDiff, width, height, right:{footX,footY,frames}, left:{...}}
      this.recolor = {};    // athlete/zombie/neutral -> [[from, to], ...]
      this.variants = new Map();
    }

    async load(setName) {
      const dir = Lemmix.ASSET_DIR + "styles/" + setName + "/lemmings/";
      let text = await this.io.text(dir + "scheme.nxmi");
      let base = dir;
      if (text === null) { base = Lemmix.ASSET_DIR + "styles/default/lemmings/"; text = await this.io.text(base + "scheme.nxmi"); }
      const nx = NxParser.parse(text);
      const animsSec = nx.section("ANIMATIONS");
      const recolor = nx.section("STATE_RECOLORING");
      if (recolor) {
        for (const kind of ["ATHLETE", "ZOMBIE", "NEUTRAL"]) {
          this.recolor[kind.toLowerCase()] = recolor.sectionsNamed(kind)
            .map((s) => [NxParser.color(s.get("FROM")), NxParser.color(s.get("TO"))]).filter((p) => p[0] !== null && p[1] !== null);
        }
      }
      await Promise.all(ANIM_NAMES.map(async (name) => {
        const sec = animsSec && animsSec.section(name);
        if (!sec) return;
        const image = await this.io.image(base + name + ".png");
        if (!image) return;
        const frameCount = sec.int("FRAMES", 1) || 1;
        const frameDiff = sec.has("PEAK_FRAME") ? frameCount - sec.int("PEAK_FRAME", 0)
          : frameCount - sec.int("LOOP_TO_FRAME", 0);
        const w = image.width >> 1, h = Math.floor(image.height / frameCount);
        const side = (dirName, x0) => {
          const d = sec.section(dirName);
          const frames = [];
          for (let i = 0; i < frameCount; i++) frames.push(image.crop(x0, i * h, w, h));
          return { footX: d ? d.int("FOOT_X", 0) : 0, footY: d ? d.int("FOOT_Y", 0) : 0, frames };
        };
        this.anims[name] = { frameCount, frameDiff, width: w, height: h, right: side("RIGHT", w), left: side("LEFT", 0) };
      }));
      return this;
    }

    /** The animation an action uses, and its frame count. */
    animationFor(action) {
      const name = ACTION_SPRITES[action];
      return name ? this.anims[name] || null : null;
    }

    /**
     * The frame to draw for a lemming: `variant` is "normal", "athlete",
     * "zombie" or "neutral". Frames past the end wrap by frameDiff, the way
     * DrawThisLemming does.
     */
    frame(action, dx, frameIndex, variant) {
      const anim = this.animationFor(action);
      if (!anim) return null;
      let f = frameIndex;
      const max = anim.frameCount - 1;
      if (anim.frameDiff > 0) while (f > max) f -= anim.frameDiff;
      if (f > max || f < 0) f = ((f % anim.frameCount) + anim.frameCount) % anim.frameCount;
      const key = ACTION_SPRITES[action] + "/" + (dx > 0 ? "r" : "l") + "/" + f + "/" + (variant || "normal");
      if (this.variants.has(key)) return this.variants.get(key);
      const side = dx > 0 ? anim.right : anim.left;
      let bmp = side.frames[f];
      if (variant && variant !== "normal" && this.recolor[variant] && this.recolor[variant].length) bmp = recolored(bmp, this.recolor[variant]);
      const frame = Lemmix.LevelBuilder.frameFromBitmap(bmp, -side.footX, -side.footY);
      this.variants.set(key, frame);
      return frame;
    }
  }

  function recolored(bmp, pairs) {
    const out = bmp.clone();
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const c = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      for (const [from, to] of pairs) {
        if (c === from) { d[i] = (to >> 16) & 255; d[i + 1] = (to >> 8) & 255; d[i + 2] = to & 255; break; }
      }
    }
    return out;
  }

  // TGadgetAnimation.GeneratePickupSkills: the picture on a pickup skill is a
  // lemming sprite placed in a 24x24 box, plus bricks for the builders
  const PICKUP_SIZE = 24, PICKUP_MID = PICKUP_SIZE / 2 - 1, PICKUP_BASELINE = PICKUP_SIZE / 2 + 7;
  const PICKUP_ICONS = {
    WALKER: [["walker", 1, 1, 0, -1]], JUMPER: [["jumper", 1, 0, 0, -3]], SHIMMIER: [["shimmier", 1, 1, 0, -4]],
    SLIDER: [["slider", -1, 0, -2, -2]], CLIMBER: [["climber", 1, 3, 3, -1]], SWIMMER: [["swimmer", 1, 2, 1, -6]],
    FLOATER: [["floater", 1, 4, -1, 6]], GLIDER: [["glider", 1, 4, -1, 6]], DISARMER: [["disarmer", 1, 6, -2, -3]],
    BOMBER: [["ohnoer", 1, 7, 0, -3]], STONER: [["stoner", 1, 0, 1, -1]], BLOCKER: [["blocker", 1, 0, 0, -1]],
    PLATFORMER: [["platformer", 1, 1, 0, -4]], BUILDER: [["builder", 1, 1, 0, -3]], STACKER: [["stacker", 1, 0, 0, -2]],
    LASERER: [["laserer", 1, 0, 1, -2]], BASHER: [["basher", 1, 0, 1, -2]], FENCER: [["fencer", 1, 1, 0, -2]],
    MINER: [["miner", 1, 12, -3, -2]], DIGGER: [["digger", 1, 4, 1, -4]],
    CLONER: [["walker", -1, 1, -1, -1], ["walker", 1, 1, 2, -1]],
  };
  const PICKUP_BRICKS = {
    PLATFORMER: [[-5, -4], [-3, -4], [-1, -4], [1, -4], [3, -4]],
    BUILDER: [[-3, -2], [-1, -3], [1, -4], [3, -5]],
    STACKER: [[2, -2], [2, -3], [2, -4], [2, -5], [2, -6], [2, -7]],
  };

  /**
   * Paint the pickup gadgets' skill pictures from the sprite set: frame
   * 2i is the picked-up look, 2i+1 the available one, each with the style's
   * skill_mask erased out of it (or blank when there is no mask).
   */
  function generatePickupIcons(level, sprites, theme) {
    const { Pixels, SKILLS } = Lemmix;
    let brick = Lemmix.StyleManager.themeColor(theme, "PICKUP_BRICKS");
    if (brick === Lemmix.StyleManager.themeColor(theme, "MASK")) brick = 0xffffff;
    const done = new Set();
    for (const g of level.gadgets) {
      if (g.effectBase !== "PICKUP") continue;
      const primary = g.meta.base.primary;
      if (!primary || primary.generated !== "pickup" || done.has(primary)) continue;
      done.add(primary);
      const eraser = g.meta.base.animations.find((a) => a.name === "SKILL_MASK");
      const frames = [];
      SKILLS.forEach((name, i) => {
        const icon = new Bitmap(PICKUP_SIZE, PICKUP_SIZE);
        for (const [sprite, dx, frameIndex, ox, oy] of PICKUP_ICONS[name] || []) {
          const anim = sprites.anims[sprite];
          if (!anim) continue;
          const side = dx > 0 ? anim.right : anim.left;
          const f = side.frames[Math.min(frameIndex, anim.frameCount - 1)];
          Pixels.blit(icon, PICKUP_MID + ox - side.footX, PICKUP_BASELINE + oy - side.footY, f, 0, 0, f.width, f.height, Pixels.mergeOver);
        }
        for (const [bx, by] of PICKUP_BRICKS[name] || []) {
          for (let o = 0; o < 2; o++) {
            const x = PICKUP_MID + bx + o, y = PICKUP_BASELINE + by;
            if (x < 0 || y < 0 || x >= PICKUP_SIZE || y >= PICKUP_SIZE) continue;
            const p = (y * PICKUP_SIZE + x) * 4;
            icon.data[p] = (brick >> 16) & 255; icon.data[p + 1] = (brick >> 8) & 255; icon.data[p + 2] = brick & 255; icon.data[p + 3] = 255;
          }
        }
        const used = icon.clone();
        if (eraser && eraser.frames.length >= 2) {
          erase(used, eraser.frames[0]);
          erase(icon, eraser.frames[1]);
        } else used.data.fill(0);
        frames.push(used, icon);
      });
      primary.setFrames(frames, PICKUP_SIZE, PICKUP_SIZE);
      // variations already derived from the blank frames are rebuilt on demand
      g.meta._variations.clear();
      for (const h of level.gadgets) if (h.meta === g.meta) h.v = g.meta.variation(h.flip, h.invert, h.rotate);
    }
    for (const g of level.gadgets) {
      if (g.effectBase !== "PICKUP") continue;
      g.animations.forEach((a, i) => { a.meta = g.v.animations[i] || a.meta; });
      g._frameCache.clear();
      if (g.object) g.object.animation.frames = [g.render()];
    }
  }

  /** Clear the pixels of `bmp` where `mask` has any. */
  function erase(bmp, mask) {
    for (let y = 0; y < Math.min(bmp.height, mask.height); y++) {
      for (let x = 0; x < Math.min(bmp.width, mask.width); x++) {
        if (mask.data[(y * mask.width + x) * 4 + 3] !== 0) {
          const p = (y * bmp.width + x) * 4;
          bmp.data[p] = bmp.data[p + 1] = bmp.data[p + 2] = bmp.data[p + 3] = 0;
        }
      }
    }
  }

  /** The gfx/mask bitmaps the game carves with. */
  async function loadMasks(io) {
    const names = ["bomber", "stoner", "basher", "fencer", "miner", "laser", "countdown"];
    const masks = {};
    await Promise.all(names.map(async (n) => { masks[n] = await io.image(Lemmix.ASSET_DIR + "gfx/mask/" + n + ".png"); }));
    for (const n of names) if (!masks[n]) throw new Error("missing " + Lemmix.ASSET_DIR + "gfx/mask/" + n + ".png - see neolemmix/README.md");
    Lemmix.digitFont = masks.countdown; // 4x5 digits, used on gadgets and over nuked lemmings
    return masks;
  }

  Lemmix.SpriteSet = SpriteSet;
  Lemmix.ACTION_SPRITES = ACTION_SPRITES;
  Lemmix.loadMasks = loadMasks;
  Lemmix.generatePickupIcons = generatePickupIcons;

  if (typeof module !== "undefined" && module.exports) module.exports = { SpriteSet, loadMasks, ACTION_SPRITES };
})(typeof window !== "undefined" ? window : globalThis);
