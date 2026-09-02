"use strict";
/**
 * The skill panel of a Lemmix game, drawn into the DisplayImage the page
 * hands over (GameBaseSkillPanel.pas, on the DOS panel's 320x40 canvas so
 * the 3D toolbar can pick it up unchanged): an info strip along the top in
 * the 8x16 panel font, then 16-px buttons from x = 0 - release rate down
 * and up, the level's skills (up to ten, each with its count in the 4x8
 * skill digits), pause, nuke and speed. Skill pictures are the lemming
 * sprites themselves, placed the way NeoLemmix places them.
 *
 * Presses come back through the display's mouse events, as they do for the
 * DOS panel, and turn into the DOS commands the replay records.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Lemmings = root.Lemmings;
  const { Bitmap, Pixels, SKILL_TO_ACTION } = Lemmix;

  const PANEL_W = 320, PANEL_H = 40;
  const BUTTON_Y = 16, CELL = 16;
  // sprite frame, and where its feet go inside the 16x23 button (SetSkillIcons)
  const SKILL_ICONS = {
    WALKER: ["walker", 1, 1, 6, 21], JUMPER: ["jumper", 1, 0, 6, 20], SHIMMIER: ["shimmier", 1, 1, 7, 20],
    SLIDER: ["slider", -1, 0, 5, 21], CLIMBER: ["climber", 1, 3, 10, 22], SWIMMER: ["swimmer", 1, 2, 8, 19],
    FLOATER: ["floater", 1, 4, 7, 26], GLIDER: ["glider", 1, 4, 7, 26], DISARMER: ["disarmer", 1, 6, 4, 21],
    BOMBER: ["bomber", 1, 0, 8, 21], STONER: ["stoner", 1, 0, 8, 21], BLOCKER: ["blocker", 1, 0, 7, 21],
    PLATFORMER: ["platformer", 1, 1, 7, 20], BUILDER: ["builder", 1, 1, 7, 20], STACKER: ["stacker", 1, 0, 7, 21],
    LASERER: ["laserer", 1, 0, 8, 21], BASHER: ["basher", 1, 0, 8, 21], FENCER: ["fencer", 1, 1, 7, 21],
    MINER: ["miner", 1, 12, 4, 21], DIGGER: ["digger", 1, 4, 7, 21], CLONER: ["walker", -1, 1, 6, 21],
  };
  const SKILL_BRICKS = {
    PLATFORMER: [[2, 21], [5, 21], [8, 21], [11, 21]],
    BUILDER: [[4, 22], [6, 21], [8, 20], [10, 19]],
    STACKER: [[10, 20], [10, 19], [10, 18], [10, 17]],
  };
  const BRICK_COLOR = 0xf0d0d0;
  const PANEL_FILES = ["skill_panels", "empty_slot", "skill_count_digits", "skill_count_erase", "skill_selected",
    "icon_rr_minus", "icon_rr_plus", "icon_pause", "icon_nuke", "icon_ff", "panel_font"];

  let assetsPromise = null;
  /** The gfx/panel bitmaps, loaded once. */
  function loadPanelAssets(io) {
    if (!assetsPromise) {
      assetsPromise = (async () => {
        const out = {};
        await Promise.all(PANEL_FILES.map(async (n) => { out[n] = await io.image("gfx/panel/" + n + ".png"); }));
        for (const n of PANEL_FILES) if (!out[n]) throw new Error("missing gfx/panel/" + n + ".png - see README, Levels and assets");
        return out;
      })();
    }
    return assetsPromise;
  }

  class GamePanel {
    constructor(game, display) {
      this.game = game;
      this.display = display;
      this.assets = null;
      this.skills = game.sim.activeSkills;
      // cell -> what it does
      this.cells = ["rrminus", "rrplus"].concat(this.skills.map((s) => "skill:" + s)).concat(["pause", "nuke", "speed"]);
      this.layout = { buttons: this.cells.length, digitButtons: 2 + this.skills.length, width: PANEL_W, height: PANEL_H };
      game.panelLayout = this.layout;
      this.rrHeld = 0;
      this.lastNukeClick = -1;
      this.icons = {};
      this.dirty = true;
      this.disposed = false;
      display.initSize(PANEL_W, PANEL_H);
      this._onDown = (pos) => this.handleMouseDown(pos.x, pos.y);
      this._onUp = () => { this.rrHeld = 0; };
      this._onDouble = (pos) => this.handleDoubleClick(pos.x, pos.y);
      display.onMouseDown.on(this._onDown);
      display.onMouseUp.on(this._onUp);
      display.onDoubleClick.on(this._onDouble);
      loadPanelAssets(Lemmix.io).then((assets) => {
        if (this.disposed) return;
        this.assets = assets;
        this._buildBase();
        this.render(true);
      });
    }

    dispose() { this.disposed = true; }

    /** The panel with its buttons and pictures, before any counts. */
    _buildBase() {
      const A = this.assets;
      const base = new Bitmap(PANEL_W, PANEL_H);
      base.words().fill(0xff000000);
      const n = this.cells.length;
      // button backgrounds tile skill_panels.png across the row (DrawBlankPanel)
      const blank = A.skill_panels;
      for (let x = 0; x < n * CELL; x += blank.width) {
        Pixels.blit(base, x, BUTTON_Y, blank, 0, 0, Math.min(blank.width, n * CELL - x), blank.height, Pixels.combineGadget);
      }
      const icon = (cell, bmp) => Pixels.blit(base, cell * CELL, BUTTON_Y, bmp, 0, 0, bmp.width, bmp.height, Pixels.combineGadget);
      this.cells.forEach((what, i) => {
        if (what === "rrminus") icon(i, A.icon_rr_minus);
        else if (what === "rrplus") icon(i, A.icon_rr_plus);
        else if (what === "pause") icon(i, A.icon_pause);
        else if (what === "nuke") icon(i, A.icon_nuke);
        else if (what === "speed") icon(i, A.icon_ff);
        else icon(i, this._skillIcon(what.slice(6)));
      });
      this.base = base;
      // the button backgrounds' own colours, so the toolbar's relief keys the pictures out of them
      const counts = new Map();
      for (let i = 0; i < blank.data.length; i += 4) {
        if (blank.data[i + 3] === 0) continue;
        const k = blank.data[i] + "," + blank.data[i + 1] + "," + blank.data[i + 2];
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      this.layout.bgColors = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
    }

    /** A skill's picture: the lemming sprite NeoLemmix puts on the button. */
    _skillIcon(name) {
      if (this.icons[name]) return this.icons[name];
      const bmp = new Bitmap(CELL, 23);
      const spec = SKILL_ICONS[name];
      const sprites = this.game.sprites;
      if (spec && sprites) {
        const anim = sprites.anims[spec[0]];
        if (anim) {
          const side = spec[1] > 0 ? anim.right : anim.left;
          const frame = side.frames[Math.min(spec[2], anim.frameCount - 1)];
          Pixels.blit(bmp, spec[3] - side.footX, spec[4] - side.footY, frame, 0, 0, frame.width, frame.height, Pixels.combineGadget);
        }
      }
      for (const [bx, by] of SKILL_BRICKS[name] || []) {
        for (let o = 0; o < 2; o++) {
          const x = bx + o, y = by;
          if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) continue;
          const p = (y * bmp.width + x) * 4;
          bmp.data[p] = (BRICK_COLOR >> 16) & 255; bmp.data[p + 1] = (BRICK_COLOR >> 8) & 255; bmp.data[p + 2] = BRICK_COLOR & 255; bmp.data[p + 3] = 255;
        }
      }
      this.icons[name] = bmp;
      return bmp;
    }

    _drawDigits(out, cell, number) {
      const A = this.assets;
      const x0 = cell * CELL, y0 = BUTTON_Y;
      Pixels.blit(out, x0, y0, A.skill_count_erase, 0, 0, A.skill_count_erase.width, A.skill_count_erase.height, Pixels.combineGadget);
      if (number <= 0) return;
      const digit = (d, x) => Pixels.blit(out, x, y0 + 1, A.skill_count_digits, d * 4, 0, 4, 8, Pixels.combineGadget);
      if (number > 99) { digit(9, x0 + 3); digit(9, x0 + 7); return; }
      if (number < 10) digit(number, x0 + 5);
      else { digit(Math.floor(number / 10), x0 + 3); digit(number % 10, x0 + 7); }
    }

    _drawText(out, text) {
      const font = this.assets.panel_font;
      for (let i = 0; i < text.length && i * 8 < PANEL_W; i++) {
        const ch = text[i];
        let id = -1;
        if (ch === "%") id = 0;
        else if (ch >= "0" && ch <= "9") id = ch.charCodeAt(0) - 48 + 1;
        else if (ch === "-") id = 11;
        else if (ch >= "A" && ch <= "Z") id = ch.charCodeAt(0) - 65 + 12;
        if (id < 0) continue;
        Pixels.blit(out, i * 8, 0, font, id * 8, 0, 8, 16, Pixels.combineGadget);
      }
    }

    /** Redraw when something changed (every frame while the counters move). */
    render(force) {
      if (!this.assets || this.disposed) return;
      const sim = this.game.sim;
      const out = this.base.clone();
      this.cells.forEach((what, i) => {
        if (what === "rrminus") this._drawDigits(out, i, sim.minReleaseRate);
        else if (what === "rrplus") this._drawDigits(out, i, sim.releaseRate);
        else if (what.startsWith("skill:")) this._drawDigits(out, i, sim.skillCount(what.slice(6)));
      });
      const sel = this.cells.indexOf("skill:" + sim.selectedSkill);
      if (sel >= 0) {
        const s = this.assets.skill_selected;
        Pixels.blit(out, sel * CELL, BUTTON_Y, s, 0, 0, s.width, s.height, Pixels.combineGadget);
      }
      let time;
      if (sim.hasTimeLimit) {
        const t = Math.max(0, sim.timePlay);
        time = Math.floor(t / 60) + "-" + String(t % 60).padStart(2, "0");
      } else {
        const t = -sim.timePlay;
        time = Math.floor(t / 60) + "-" + String(t % 60).padStart(2, "0");
      }
      const text = "OUT " + String(sim.lemmingsOut).padStart(2, " ") + "  IN " + String(sim.lemmingsIn).padStart(2, " ") +
        "  TIME " + time;
      this._drawText(out, text);
      // onto the display, and tell the page it changed
      const frame = Lemmix.LevelBuilder.frameFromBitmap(out, 0, 0);
      frame.mask.fill(1);
      this.display.drawFrame(frame, 0, 0);
      this.display.redraw();
      // a held release-rate button keeps changing it
      if (this.rrHeld) this.game.queueCmmand(this.rrHeld > 0 ? new Lemmings.CommandReleaseRateIncrease(1) : new Lemmings.CommandReleaseRateDecrease(1));
    }

    handleMouseDown(x, y) {
      if (y < BUTTON_Y) return;
      const cell = Math.trunc(x / CELL);
      const what = this.cells[cell];
      if (!what) return;
      const game = this.game;
      if (what === "rrminus") { this.rrHeld = -1; game.queueCmmand(new Lemmings.CommandReleaseRateDecrease(1)); }
      else if (what === "rrplus") { this.rrHeld = 1; game.queueCmmand(new Lemmings.CommandReleaseRateIncrease(1)); }
      else if (what === "pause") game.getGameTimer().toggle();
      else if (what === "nuke") {
        const tick = game.getGameTimer().getGameTicks();
        if (game.nukePrepared) { game.queueCmmand(new Lemmings.CommandNuke()); game.nukePrepared = false; }
        else game.nukePrepared = true;
      } else if (what === "speed") {
        const timer = game.getGameTimer();
        timer.speedFactor = timer.speedFactor >= 8 ? 1 : timer.speedFactor * 2;
      } else if (what.startsWith("skill:")) {
        game.queueCmmand(new Lemmings.CommandSelectSkill(cell - 2));
      }
      this.render();
    }

    handleDoubleClick(x, y) {
      if (y < BUTTON_Y) return;
      if (this.cells[Math.trunc(x / CELL)] === "nuke") { this.game.queueCmmand(new Lemmings.CommandNuke()); this.game.nukePrepared = false; }
    }
  }

  Lemmix.GamePanel = GamePanel;
  Lemmix.loadPanelAssets = loadPanelAssets;
})(typeof window !== "undefined" ? window : globalThis);
