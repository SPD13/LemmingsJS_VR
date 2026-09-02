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
      const dir = "styles/" + setName + "/lemmings/";
      let text = await this.io.text(dir + "scheme.nxmi");
      let base = dir;
      if (text === null) { base = "styles/default/lemmings/"; text = await this.io.text(base + "scheme.nxmi"); }
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

  /** The gfx/mask bitmaps the game carves with. */
  async function loadMasks(io) {
    const names = ["bomber", "stoner", "basher", "fencer", "miner", "laser"];
    const masks = {};
    await Promise.all(names.map(async (n) => { masks[n] = await io.image("gfx/mask/" + n + ".png"); }));
    for (const n of names) if (!masks[n]) throw new Error("missing gfx/mask/" + n + ".png - see README, Levels and assets");
    return masks;
  }

  Lemmix.SpriteSet = SpriteSet;
  Lemmix.ACTION_SPRITES = ACTION_SPRITES;
  Lemmix.loadMasks = loadMasks;

  if (typeof module !== "undefined" && module.exports) module.exports = { SpriteSet, loadMasks, ACTION_SPRITES };
})(typeof window !== "undefined" ? window : globalThis);
