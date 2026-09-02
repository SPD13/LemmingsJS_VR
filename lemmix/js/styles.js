"use strict";
/**
 * NeoLemmix styles: the graphics and metadata a level's pieces refer to,
 * loaded lazily from styles/<style>/ and kept.
 *
 *   theme.nxtm                 which lemming sprite set, and the theme colours
 *   alias.nxmi                 renamed pieces (followed the way LemNeoPieceManager.Dealias does)
 *   terrain/<piece>.png/.nxmt  a terrain piece: steel, resizable, nine-slice margins
 *   objects/<piece>.nxmo       a gadget: effect, trigger area, animations (one PNG each)
 *   backgrounds/<name>.png     a tiled backdrop
 *
 * Every piece is kept once in its natural orientation; the rotated,
 * flipped and inverted variations a level asks for are derived on demand
 * (LemMetaTerrain.DeriveVariation, LemGadgetsMeta.DeriveVariation), trigger
 * areas and offsets included.
 *
 * Files come through an `io` object - {text(url), image(url)} returning
 * null for a missing file - so the same code serves the page (fetch + Image)
 * and node tools (fs + pngjs).
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const { NxParser } = Lemmix;
  const { Bitmap, Pixels } = Lemmix;

  const STYLES_DIR = "styles/";
  const PICKUP_AUTO_GFX_SIZE = 24;
  const SKILL_BUTTON_COUNT = 21; // TSkillPanelButton, walker .. cloner
  const THEME_DEFAULT_COLOR = 0x808080; // TNeoTheme DEFAULT_COLOR

  /** The browser's io: fetch for text, an Image and a canvas for pixels. */
  function browserIO(root) {
    return {
      async text(url) {
        const res = await fetch(root + url);
        return res.ok ? res.text() : null;
      },
      image(url) {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            resolve(new Bitmap(canvas.width, canvas.height, data));
          };
          img.onerror = () => resolve(null);
          img.src = root + url;
        });
      },
    };
  }

  const lower = (s) => String(s || "").trim().toLowerCase();
  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

  /** A terrain piece's metadata and image, with its variations. */
  class MetaTerrain {
    constructor(gs, piece, image, nxmt) {
      this.gs = gs;
      this.piece = piece;
      this.steel = !!(nxmt && nxmt.has("STEEL"));
      const both = !!(nxmt && nxmt.has("RESIZE_BOTH"));
      this.base = {
        image, width: image.width, height: image.height,
        resizeH: both || !!(nxmt && nxmt.has("RESIZE_HORIZONTAL")),
        resizeV: both || !!(nxmt && nxmt.has("RESIZE_VERTICAL")),
        defaultWidth: nxmt ? nxmt.int("DEFAULT_WIDTH", 0) : 0,
        defaultHeight: nxmt ? nxmt.int("DEFAULT_HEIGHT", 0) : 0,
        cut: {
          left: nxmt ? nxmt.int("NINE_SLICE_LEFT", 0) : 0,
          top: nxmt ? nxmt.int("NINE_SLICE_TOP", 0) : 0,
          right: nxmt ? nxmt.int("NINE_SLICE_RIGHT", 0) : 0,
          bottom: nxmt ? nxmt.int("NINE_SLICE_BOTTOM", 0) : 0,
        },
      };
      this._variations = new Map();
    }

    /** The piece as drawn with these flags (rotate first, then flip, then invert). */
    variation(flip, invert, rotate) {
      const key = (flip ? 1 : 0) | (invert ? 2 : 0) | (rotate ? 4 : 0);
      if (key === 0) return this.base;
      if (this._variations.has(key)) return this._variations.get(key);
      const b = this.base;
      let image = b.image;
      if (rotate) image = image.rotate90();
      if (flip) image = image.flipHorizontal();
      if (invert) image = image.flipVertical();
      const v = {
        image, width: image.width, height: image.height,
        resizeH: rotate ? b.resizeV : b.resizeH,
        resizeV: rotate ? b.resizeH : b.resizeV,
        defaultWidth: rotate ? b.defaultHeight : b.defaultWidth,
        defaultHeight: rotate ? b.defaultWidth : b.defaultHeight,
        cut: rotate
          ? { left: b.cut.bottom, top: b.cut.left, right: b.cut.top, bottom: b.cut.right }
          : Object.assign({}, b.cut),
      };
      if (flip) { const t = v.cut.left; v.cut.left = v.cut.right; v.cut.right = t; }
      if (invert) { const t = v.cut.top; v.cut.top = v.cut.bottom; v.cut.bottom = t; }
      this._variations.set(key, v);
      return v;
    }
  }

  /** One animation of a gadget: its frames and how they play. */
  class MetaAnimation {
    constructor(section, primary, mainWidth, mainHeight) {
      this.primary = primary;
      this.name = String(section.get("NAME") || "").toUpperCase();
      this.color = String(section.get("COLOR") || "").toUpperCase();
      this.frameCount = section.int("FRAMES", 0) || 1;
      this.horizontalStrip = section.has("HORIZONTAL_STRIP");
      this.zIndex = primary && !section.has("Z_INDEX") ? 1 : section.int("Z_INDEX", 0);
      const initial = String(section.get("INITIAL_FRAME") || "").toUpperCase();
      this.startFrame = initial === "RANDOM" ? -1 : section.int("INITIAL_FRAME", 0);
      this.offsetX = section.int("OFFSET_X", 0);
      this.offsetY = section.int("OFFSET_Y", 0);
      this.cut = {
        left: section.int("NINE_SLICE_LEFT", 0), top: section.int("NINE_SLICE_TOP", 0),
        right: section.int("NINE_SLICE_RIGHT", 0), bottom: section.int("NINE_SLICE_BOTTOM", 0),
      };
      this.mainWidth = mainWidth;
      this.mainHeight = mainHeight;
      this._nxWidth = section.int("WIDTH", 0);   // *BLANK animations size themselves
      this._nxHeight = section.int("HEIGHT", 0);
      this.frames = [];
      this.width = 0;
      this.height = 0;
      // how it plays until a trigger says otherwise
      const state = lower(section.get("STATE"));
      const hide = section.has("HIDE");
      this.baseState = state === "pause" ? "pause" : state === "stop" ? "stop"
        : state === "looptozero" ? "looptozero" : state === "matchphysics" ? "matchphysics"
        : hide ? "pause" : "play";
      this.baseVisible = !hide;
      if (primary) { this.baseState = "pause"; this.baseVisible = true; } // physics drive the primary
      this.triggers = [];
      if (!primary) {
        for (const t of section.sectionsNamed("TRIGGER")) {
          const cond = String(t.get("CONDITION") || "").toUpperCase();
          const visible = !t.has("HIDE");
          let st;
          if (!visible && !t.has("STATE")) st = "pause";
          else {
            const s = String(t.get("STATE") || "").toUpperCase();
            st = s === "PAUSE" ? "pause" : s === "STOP" ? "stop" : s === "LOOPTOZERO" ? "looptozero"
              : s === "MATCHPHYSICS" ? "matchphysics" : "play";
          }
          this.triggers.push({
            condition: ["READY", "BUSY", "DISABLED", "EXHAUSTED"].includes(cond) ? cond.toLowerCase() : "unconditional",
            state: st, visible,
          });
        }
      }
    }

    setFrames(frames, width, height) {
      this.frames = frames;
      this.width = width;
      this.height = height;
      if (this.primary) { this.mainWidth = width; this.mainHeight = height; }
    }

    /** A transformed copy (TGadgetAnimation.Rotate90 / Flip / Invert). */
    transformed(flip, invert, rotate) {
      const a = Object.create(MetaAnimation.prototype);
      Object.assign(a, this);
      a.cut = Object.assign({}, this.cut);
      a.frames = this.frames;
      if (rotate) {
        a.frames = a.frames.map((f) => f.rotate90());
        const w = a.width; a.width = a.height; a.height = w;
        const mw = a.mainWidth; a.mainWidth = a.mainHeight; a.mainHeight = mw;
        const oy = a.offsetY; a.offsetY = a.offsetX; a.offsetX = a.mainWidth - oy - a.width;
        const t = a.cut.top; a.cut.top = a.cut.left; a.cut.left = a.cut.bottom; a.cut.bottom = a.cut.right; a.cut.right = t;
      }
      if (flip) {
        a.frames = a.frames.map((f) => f.flipHorizontal());
        a.offsetX = a.mainWidth - a.offsetX - a.width;
        const t = a.cut.left; a.cut.left = a.cut.right; a.cut.right = t;
      }
      if (invert) {
        a.frames = a.frames.map((f) => f.flipVertical());
        a.offsetY = a.mainHeight - a.offsetY - a.height;
        const t = a.cut.bottom; a.cut.bottom = a.cut.top; a.cut.top = t;
      }
      return a;
    }
  }

  const NO_POSITION_ADJUST = new Set(["ONEWAYLEFT", "ONEWAYRIGHT", "ONEWAYDOWN", "ONEWAYUP"]);

  /** A gadget's metadata and animations, with its variations. */
  class MetaGadget {
    constructor(gs, piece, nxmo) {
      this.gs = gs;
      this.piece = piece;
      this.effect = String(nxmo.get("EFFECT") || "").toUpperCase() || "NONE";
      if (this.effect === "TELEPORTER") this.effect = "TELEPORT";
      if (this.effect === "ENTRANCE") this.effect = "WINDOW";
      if (this.effect === "SPLITTER") this.effect = "FLIPPER";
      if (this.effect === "PICKUPSKILL") this.effect = "PICKUP";
      if (this.effect === "LOCKEDEXIT") this.effect = "LOCKEXIT";
      if (this.effect === "UNLOCKBUTTON") this.effect = "BUTTON";
      if (this.effect === "ANTISPLATPAD") this.effect = "NOSPLAT";
      if (this.effect === "SPLATPAD") this.effect = "SPLAT";
      const both = nxmo.has("RESIZE_BOTH");
      this.soundActivate = nxmo.get("SOUND_ACTIVATE") || nxmo.get("SOUND") || "";
      this.soundExhaust = nxmo.get("SOUND_EXHAUST") || "";
      this.keyFrame = nxmo.int("KEY_FRAME", 0);
      this.digitMinLength = nxmo.int("DIGIT_LENGTH", 1);
      this._nxmo = nxmo;
      this.base = {
        trigger: {
          x: nxmo.int("TRIGGER_X", 0), y: nxmo.int("TRIGGER_Y", 0),
          w: nxmo.int("TRIGGER_WIDTH", 0), h: nxmo.int("TRIGGER_HEIGHT", 0),
        },
        defaultWidth: nxmo.int("DEFAULT_WIDTH", 0), defaultHeight: nxmo.int("DEFAULT_HEIGHT", 0),
        resizeH: both || nxmo.has("RESIZE_HORIZONTAL"), resizeV: both || nxmo.has("RESIZE_VERTICAL"),
        digit: { x: 0, y: nxmo.int("DIGIT_Y", -6), align: 0 },
        animations: [], primary: null, width: 0, height: 0,
      };
      const align = lower(nxmo.get("DIGIT_ALIGNMENT")).charAt(0);
      this.base.digit.align = align === "l" ? -1 : align === "r" ? 1 : 0;
      if (["NONE", "BACKGROUND", "PAINT"].includes(this.effect)) { this.base.trigger.w = 0; this.base.trigger.h = 0; }
      if (["RECEIVER", "WINDOW"].includes(this.effect)) { this.base.trigger.w = 1; this.base.trigger.h = 1; }
      this._variations = new Map();
    }

    /** Called once the animation images are in. */
    finish(animations) {
      const b = this.base;
      b.animations = animations.slice().sort((p, q) => p.zIndex - q.zIndex);
      b.primary = animations.find((a) => a.primary);
      b.width = b.primary.width;
      b.height = b.primary.height;
      if (!this._nxmo.has("DIGIT_X")) b.digit.x = b.width >> 1;
      else b.digit.x = this._nxmo.int("DIGIT_X", 0);
    }

    variation(flip, invert, rotate) {
      const key = (flip ? 1 : 0) | (invert ? 2 : 0) | (rotate ? 4 : 0);
      if (key === 0) return this.base;
      if (this._variations.has(key)) return this._variations.get(key);
      const s = this.base;
      const v = {
        trigger: Object.assign({}, s.trigger),
        defaultWidth: s.defaultWidth, defaultHeight: s.defaultHeight,
        resizeH: s.resizeH, resizeV: s.resizeV,
        digit: Object.assign({}, s.digit),
        animations: s.animations.map((a) => a.transformed(flip, invert, rotate)),
      };
      v.primary = v.animations.find((a) => a.primary);
      v.width = v.primary.width;
      v.height = v.primary.height;
      const adjust = !NO_POSITION_ADJUST.has(this.effect);
      if (rotate) {
        v.trigger.x = s.primary.height - s.trigger.y - s.trigger.h;
        v.trigger.y = s.trigger.x;
        if (adjust) { v.trigger.x += 4; v.trigger.y += 5; }
        v.trigger.w = s.trigger.h;
        v.trigger.h = s.trigger.w;
        v.defaultWidth = s.defaultHeight; v.defaultHeight = s.defaultWidth;
        v.resizeH = s.resizeV; v.resizeV = s.resizeH;
        v.digit.align = 0;
        v.digit.x = s.primary.height - s.digit.y - 1;
        v.digit.y = s.digit.x;
      }
      if (flip) {
        v.trigger.x = v.width - v.trigger.x - v.trigger.w;
        v.digit.x = v.width - v.digit.x - 1;
        v.digit.align = -v.digit.align;
      }
      if (invert) {
        v.trigger.y = v.height - v.trigger.y - v.trigger.h;
        if (adjust) v.trigger.y += 10;
        v.digit.y = v.height - v.digit.y - 1;
      }
      this._variations.set(key, v);
      return v;
    }
  }

  class StyleManager {
    constructor(io) {
      this.io = io;
      this._styles = new Map();   // name -> Promise<style>
      this._terrain = new Map();  // "gs:piece" -> Promise<MetaTerrain|null>
      this._gadgets = new Map();  // "gs:piece" -> Promise<MetaGadget|null>
      this._images = new Map();   // url -> Promise<Bitmap|null>
      this.missing = new Set();   // "gs:piece" references that fell back
    }

    _image(url) {
      if (!this._images.has(url)) this._images.set(url, this.io.image(encodePath(url)));
      return this._images.get(url);
    }

    _text(url) { return this.io.text(encodePath(url)); }

    /** A style's theme and aliases (an unknown style resolves with `exists: false`). */
    style(name) {
      name = lower(name);
      if (!this._styles.has(name)) {
        this._styles.set(name, (async () => {
          const dir = STYLES_DIR + name + "/";
          const [themeText, aliasText] = await Promise.all([
            this._text(dir + "theme.nxtm"), this._text(dir + "alias.nxmi"),
          ]);
          const theme = { lemmings: "default", colors: {} };
          if (themeText !== null) {
            const nx = NxParser.parse(themeText);
            theme.lemmings = lower(nx.get("LEMMINGS")) || "default";
            const colors = nx.section("COLORS");
            if (colors) {
              for (const e of colors.entries) {
                const c = NxParser.color(e.value);
                if (c !== null) theme.colors[e.key] = c;
              }
            }
          }
          const aliases = [];
          if (aliasText !== null) {
            const nx = NxParser.parse(aliasText);
            for (const sec of nx.sections) {
              const kind = { STYLE: "style", GADGET: "gadget", TERRAIN: "terrain", BACKGROUND: "background", LEMMINGS: "lemmings" }[sec.name];
              if (!kind) continue;
              const from = splitIdentifier(sec.get("FROM"), name), to = splitIdentifier(sec.get("TO"), name);
              if (!from || !to) continue;
              aliases.push({ kind, from, to, width: sec.int("WIDTH", 0), height: sec.int("HEIGHT", 0) });
            }
          }
          return { name, theme, aliases, exists: themeText !== null };
        })());
      }
      return this._styles.get(name);
    }

    /** A theme colour by name (TNeoTheme.GetColor's fallbacks). */
    static themeColor(theme, name) {
      name = String(name || "").toUpperCase();
      if (name in theme.colors) return theme.colors[name];
      if (name === "BACKGROUND") return 0x000000;
      if ("MASK" in theme.colors) return theme.colors.MASK;
      return THEME_DEFAULT_COLOR;
    }

    /**
     * Follow renames until the name stops changing (LemNeoPieceManager
     * .Dealias): a piece alias of `kind`, then a style alias, repeated.
     */
    async dealias(gs, piece, kind) {
      let cur = { gs: lower(gs), piece: lower(piece) };
      let defWidth = 0, defHeight = 0;
      for (let guard = 0; guard < 16; guard++) {
        const last = cur;
        const style = await this.style(cur.gs);
        for (const a of style.aliases) {
          if (a.from.gs !== cur.gs) continue;
          if (a.kind === kind && a.from.piece === cur.piece) {
            cur = { gs: a.to.gs, piece: a.to.piece };
            defWidth = a.width; defHeight = a.height;
          }
        }
        for (const a of style.aliases) {
          if (a.from.gs === cur.gs && a.kind === "style") cur = { gs: a.to.gs, piece: cur.piece };
        }
        if (cur.gs === last.gs && cur.piece === last.piece) break;
      }
      return { gs: cur.gs, piece: cur.piece, defWidth, defHeight };
    }

    /** A terrain piece, or null when the style has no such piece. */
    terrain(gs, piece) {
      const key = lower(gs) + ":" + lower(piece);
      if (!this._terrain.has(key)) {
        this._terrain.set(key, (async () => {
          const dir = STYLES_DIR + lower(gs) + "/terrain/" + lower(piece);
          const [image, nxmtText] = await Promise.all([this._image(dir + ".png"), this._text(dir + ".nxmt")]);
          if (!image) return null;
          return new MetaTerrain(lower(gs), lower(piece), image, nxmtText !== null ? NxParser.parse(nxmtText) : null);
        })());
      }
      return this._terrain.get(key);
    }

    /** A gadget, or null when the style has no such gadget. */
    gadget(gs, piece) {
      const key = lower(gs) + ":" + lower(piece);
      if (!this._gadgets.has(key)) {
        this._gadgets.set(key, (async () => {
          const dir = STYLES_DIR + lower(gs) + "/objects/" + lower(piece);
          const nxmoText = await this._text(dir + ".nxmo");
          if (nxmoText === null) return null;
          const nxmo = NxParser.parse(nxmoText);
          const primarySection = nxmo.section("PRIMARY_ANIMATION");
          if (!primarySection) return null; // pre-12.7 format
          const meta = new MetaGadget(lower(gs), lower(piece), nxmo);
          const style = await this.style(gs);
          const primary = new MetaAnimation(primarySection, true, 0, 0);
          await this._loadAnimation(primary, dir, style.theme);
          const animations = [primary];
          for (const sec of nxmo.sectionsNamed("ANIMATION")) {
            const anim = new MetaAnimation(sec, false, primary.width, primary.height);
            await this._loadAnimation(anim, dir, style.theme);
            animations.push(anim);
          }
          meta.finish(animations);
          return meta;
        })());
      }
      return this._gadgets.get(key);
    }

    async _loadAnimation(anim, dir, theme) {
      let frames, width, height;
      if (anim.name.charAt(0) !== "*") {
        const url = dir + (anim.name ? "_" + anim.name.toLowerCase() : "") + ".png";
        const image = await this._image(url);
        if (!image) {
          frames = [new Bitmap(1, 1)]; width = 1; height = 1; anim.frameCount = 1;
        } else {
          if (anim.horizontalStrip) { width = Math.floor(image.width / anim.frameCount); height = image.height; }
          else { width = image.width; height = Math.floor(image.height / anim.frameCount); }
          frames = image.frames(anim.frameCount, anim.horizontalStrip);
        }
      } else if (anim.name === "*BLANK") {
        width = anim._nxWidth || 1; height = anim._nxHeight || 1;
        frames = [];
        for (let i = 0; i < anim.frameCount; i++) frames.push(new Bitmap(width, height));
      } else if (anim.name === "*PICKUP") {
        // the skill pictures are painted from the lemming sprites (Phase 3);
        // until then the pickup is its coloured frame alone
        width = PICKUP_AUTO_GFX_SIZE; height = PICKUP_AUTO_GFX_SIZE;
        anim.frameCount = SKILL_BUTTON_COUNT * 2;
        frames = [];
        for (let i = 0; i < anim.frameCount; i++) frames.push(new Bitmap(width, height));
        anim.generated = "pickup";
      } else {
        frames = [new Bitmap(1, 1)]; width = 1; height = 1; anim.frameCount = 1;
      }
      if (anim.color) {
        // MaskImageFromImage: the image tinted by the theme colour, merged over itself
        const rgb = StyleManager.themeColor(theme, anim.color);
        frames = frames.map((f) => {
          const out = f.clone();
          const tint = f.tinted(rgb);
          Pixels.blit(out, 0, 0, tint, 0, 0, f.width, f.height, Pixels.mergeOver);
          return out;
        });
      }
      anim.setFrames(frames, width, height);
    }

    /** A background image, or null. */
    background(gs, name) {
      return this._image(STYLES_DIR + lower(gs) + "/backgrounds/" + lower(name) + ".png");
    }
  }

  /** "style:piece" (or ":piece" within `defaultGs`) into its two halves. */
  function splitIdentifier(id, defaultGs) {
    if (!id) return null;
    const i = id.indexOf(":");
    if (i < 0) return { gs: lower(defaultGs), piece: lower(id) };
    return { gs: lower(i === 0 ? defaultGs : id.slice(0, i)), piece: lower(id.slice(i + 1)) };
  }

  Lemmix.StyleManager = StyleManager;
  Lemmix.StyleManager.browserIO = browserIO;
  Lemmix.MetaTerrain = MetaTerrain;
  Lemmix.MetaGadget = MetaGadget;
  Lemmix.MetaAnimation = MetaAnimation;
  Lemmix.splitIdentifier = splitIdentifier;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { StyleManager, MetaTerrain, MetaGadget, MetaAnimation, splitIdentifier };
  }
})(typeof window !== "undefined" ? window : globalThis);
