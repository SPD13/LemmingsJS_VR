"use strict";
/**
 * The skill panel of a Lemmix game, drawn into the DisplayImage the page
 * hands over (GameBaseSkillPanel.pas, on a canvas the shape of the DOS
 * panel's so the 3D toolbar can pick it up unchanged): an info strip along
 * the top in the 8x16 panel font, then 16-px buttons from x = 0 - release
 * rate down and up, ten skill slots (the level's skills with their counts
 * in the 4x8 skill digits, the rest empty slots, as NeoLemmix always shows
 * ten), pause, nuke, speed, then the four cells NeoLemmix's standard panel
 * ends with - replay (restart, the attempt replaying), frame back over
 * frame forward, direction left over direction right, clear physics over
 * load replay (a split cell answers by its upper or lower half, y 16..26
 * and 28..37, with y 27 between them) - and after them NeoLemmix's minimap
 * frame (minimap_region.png, 111x38 around a 104x34 window): NeoLemmix's
 * own 416x40, nineteen cells and the frame. The map itself is the page's
 * (3d/js/minimap.js); the panel only says where its window is
 * (layout.minimap). Skill pictures are the lemming sprites themselves,
 * placed the way NeoLemmix places them.
 *
 * The info strip is NeoLemmix's 38-column string (CreateNewInfoString):
 * the lemming under the pointer, the replay mark (an R from
 * panel_icons.png while the attempt is replaying, a blue one in insert
 * mode), the hatch, alive and saved counts behind their icons, and the
 * clock behind its.
 *
 * The toolbar embosses the pictures and the counts the way it does the DOS
 * panel's. There it keys them out of the button dither by colour; here the
 * panel knows exactly which pixels it drew as a picture and which as a
 * digit, so it says so (layout.reliefMasks) rather than leaving the toolbar
 * to guess from colours that differ from pack to pack.
 *
 * Presses come back through the display's mouse events, as they do for the
 * DOS panel, and turn into the DOS commands the replay records.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Lemmings = root.Lemmings;
  const { Bitmap, Pixels, SKILL_TO_ACTION } = Lemmix;

  const PANEL_W = 416, PANEL_H = 40;
  const BUTTON_Y = 16, CELL = 16;
  // a split cell's halves (HalfButtonRect): the upper ends at 26, the lower starts at 28
  const HALF_UPPER_BOTTOM = 26, HALF_LOWER_TOP = 28;
  // the minimap frame's picture and the window inside it (MinimapRect is
  // drawn at Left - 3, Top - 2 of the frame; the window is 104x34); the
  // frame starts a pixel after the last cell, as the cells start at x = 1
  const REGION_W = 111, REGION_H = 38, REGION_X = 1, REGION_Y = 1;
  const MINIMAP = { dx: 3, dy: 2, w: 104, h: 34, scale: 8 };
  // how far a press on frame back / forward goes: left, middle, right button
  const SKIP_BY_BUTTON = { 0: 1, 1: 85, 2: 17 };
  const HOLD_DELAY_MS = 250, HOLD_REPEAT_MS = 100; // CheckFrameSkip's auto-repeat
  // the info string: 38 columns of 8 px; panel_icons.png supplies glyphs 38..44
  const INFO_LEN = 38;
  const ICON = { REPLAY: 38, HATCH: 39, ALIVE: 40, SAVED: 41, CLOCK: 42, CLOCK_LIMIT: 43, REPLAY_INSERT: 44 };
  const COL = { CURSOR: 1, REPLAY: 13, HATCH_ICON: 15, HATCH: 16, ALIVE_ICON: 21, ALIVE: 22, SAVED_ICON: 27, SAVED: 28,
    CLOCK_ICON: 33, MIN: 34, DASH: 36, SEC: 37 };
  // LemmingActionStrings: what the strip calls a lemming doing this
  const ACTION_WORD = {
    walking: "WALKER", ascending: "ASCENDER", digging: "DIGGER", climbing: "CLIMBER", drowning: "DROWNER",
    hoisting: "HOISTER", building: "BUILDER", bashing: "BASHER", mining: "MINER", falling: "FALLER",
    floating: "FLOATER", splatting: "SPLATTER", exiting: "EXITER", vaporizing: "VAPORIZER", blocking: "BLOCKER",
    shrugging: "SHRUGGER", ohnoing: "EXPLODER", exploding: "EXPLODER", platforming: "PLATFORMER",
    stacking: "STACKER", stoning: "STONER", stonefinish: "STONER", swimming: "SWIMMER", gliding: "GLIDER",
    fixing: "DISARMER", cloning: "CLONER", fencing: "FENCER", reaching: "REACHER", shimmying: "SHIMMIER",
    jumping: "JUMPER", dehoisting: "DEHOISTER", sliding: "SLIDER", lasering: "LASERER",
  };
  const WORKING = new Set(["building", "platforming", "stacking", "lasering", "bashing", "mining", "digging", "blocking"]);
  const ATHLETES = ["", "", "ATHLETE", "TRIATHLETE", "QUADATHLETE", "QUINTATHLETE"];
  const SKILL_SLOTS = 10;   // MAX_SKILL_TYPES_PER_LEVEL: the panel always shows this many
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
    "icon_rr_minus", "icon_rr_plus", "icon_pause", "icon_nuke", "icon_ff", "icon_restart", "icon_frameskip",
    "icon_directional", "icon_cpm_and_replay", "panel_font", "panel_icons", "minimap_region"];
  const OPTIONAL_FILES = new Set(["minimap_region"]); // drawn by hand when the picture is missing

  const assetsByPack = new Map();
  /**
   * The gfx/panel bitmaps, loaded once - or, for a pack that ships its own
   * (skill_panels.png and friends next to its levels.nxmi), that pack's.
   * `packDir` is given only for such a pack (the levels index's `panel`
   * flag), so the packs without one are not asked for 17 missing files.
   */
  function loadPanelAssets(io, packDir) {
    const key = packDir || "";
    if (!assetsByPack.has(key)) {
      assetsByPack.set(key, (async () => {
        const out = {};
        await Promise.all(PANEL_FILES.map(async (n) => {
          let bmp = packDir ? await io.image(packDir + "/" + n + ".png") : null;
          if (!bmp) bmp = await io.image(Lemmix.ASSET_DIR + "gfx/panel/" + n + ".png");
          out[n] = bmp;
        }));
        for (const n of PANEL_FILES) {
          if (!out[n] && !OPTIONAL_FILES.has(n)) throw new Error("missing " + Lemmix.ASSET_DIR + "gfx/panel/" + n + ".png - see neolemmix/README.md");
        }
        return out;
      })());
    }
    return assetsByPack.get(key);
  }

  class GamePanel {
    constructor(game, display) {
      this.game = game;
      this.display = display;
      this.assets = null;
      this.skills = game.sim.activeSkills;
      // cell -> what it does
      const slots = this.skills.map((s) => "skill:" + s);
      while (slots.length < SKILL_SLOTS) slots.push("empty");
      this.cells = ["rrminus", "rrplus"].concat(slots).concat(["pause", "nuke", "speed", "restart", "frameskip", "directional", "cpmreplay"]);
      this.layout = { buttons: this.cells.length, digitButtons: 2 + SKILL_SLOTS, width: PANEL_W, height: PANEL_H,
        cells: this.cells, // what each cell does, for the label a resting pointer gets
        sharedBorder: false, // each cell is its own tile; nothing is drawn on a shared line
        minimap: { x: this.cells.length * CELL + REGION_X + MINIMAP.dx, y: REGION_Y + MINIMAP.dy, w: MINIMAP.w, h: MINIMAP.h,
          scaleX: MINIMAP.scale, scaleY: MINIMAP.scale, pad: 1 },
        // the cells that are two buttons, one over the other, and where they part
        splitCells: ["frameskip", "directional", "cpmreplay"].map((w) => this.cells.indexOf(w)),
        halfRows: { upperBottom: HALF_UPPER_BOTTOM, lowerTop: HALF_LOWER_TOP },
        // the toolbar's relief comes from these, once the graphics are in
        // (until then the canvas is black and there is nothing to emboss)
        reliefFromMasks: true, reliefMasks: null };
      game.panelLayout = this.layout;
      this.rrHeld = 0;
      this.held = null; // a frame back/forward half held down: {step, next}
      this.flatBackground = false; // the buttons on one plain colour instead of skill_panels.png
      this.icons = {};
      this.dirty = true;
      this.disposed = false;
      display.initSize(PANEL_W, PANEL_H);
      this._onDown = (pos) => this.handleMouseDown(pos.x, pos.y, pos.button || 0);
      this._onUp = () => { this.rrHeld = 0; this.held = null; };
      this._onDouble = (pos) => this.handleDoubleClick(pos.x, pos.y);
      display.onMouseDown.on(this._onDown);
      display.onMouseUp.on(this._onUp);
      display.onDoubleClick.on(this._onDouble);
      loadPanelAssets(Lemmix.io, game.packDir || null).then((assets) => {
        if (this.disposed) return;
        this.assets = assets;
        this._buildBase();
        this.render(true);
      });
    }

    dispose() { this.disposed = true; }

    /** The buttons' background as one plain colour (the mean of the pack's
     *  skill_panels.png, so the panel keeps the pack's tone) instead of the
     *  texture, so the pictures and counts have nothing to compete with. */
    setFlatBackground(on) {
      on = !!on;
      if (this.flatBackground === on) return;
      this.flatBackground = on;
      if (!this.assets || this.disposed) return; // applied when the graphics are in
      this._buildBase();
      this.render(true);
    }

    /** The mean of a bitmap's opaque pixels, lifted off black if need be: a
     *  tile that is nearly black would leave nothing to tell a button from
     *  the gap around it. */
    _meanColor(bmp) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < bmp.data.length; i += 4) {
        if (!bmp.data[i + 3]) continue;
        r += bmp.data[i]; g += bmp.data[i + 1]; b += bmp.data[i + 2]; n++;
      }
      if (!n) return [96, 96, 96];
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      const lift = 48 - (r + g + b);
      if (lift > 0) { r += Math.ceil(lift / 3); g += Math.ceil(lift / 3); b += Math.ceil(lift / 3); }
      return [r, g, b];
    }

    /** The panel with its buttons and pictures, before any counts. */
    _buildBase() {
      const A = this.assets;
      const base = new Bitmap(PANEL_W, PANEL_H);
      base.words().fill(0xff000000);
      const n = this.cells.length;
      // button backgrounds tile skill_panels.png across the row (DrawBlankPanel)
      const blank = A.skill_panels;
      if (this.flatBackground) {
        // ...or one plain colour where the tiles would go
        const [r, g, b] = this._meanColor(blank);
        for (let y = 0; y < blank.height && BUTTON_Y + y < PANEL_H; y++) for (let x = 0; x < n * CELL; x++) {
          const p = ((BUTTON_Y + y) * PANEL_W + x) * 4;
          base.data[p] = r; base.data[p + 1] = g; base.data[p + 2] = b; base.data[p + 3] = 255;
        }
      } else for (let x = 0; x < n * CELL; x += blank.width) {
        Pixels.blit(base, x, BUTTON_Y, blank, 0, 0, Math.min(blank.width, n * CELL - x), blank.height, Pixels.combineGadget);
      }
      // which pixels are a picture, for the toolbar to raise: where an icon
      // has paint - black included, the pause/nuke/speed icons are nothing else
      const art = new Uint8Array(PANEL_W * PANEL_H);
      const mark = (cell, bmp, value) => {
        for (let y = 0; y < bmp.height && BUTTON_Y + y < PANEL_H; y++) for (let x = 0; x < bmp.width; x++) {
          if (bmp.data[(y * bmp.width + x) * 4 + 3]) art[(BUTTON_Y + y) * PANEL_W + cell * CELL + x] = value;
        }
      };
      const icon = (cell, bmp) => {
        Pixels.blit(base, cell * CELL, BUTTON_Y, bmp, 0, 0, bmp.width, bmp.height, Pixels.combineGadget);
        mark(cell, bmp, 1);
      };
      this.cells.forEach((what, i) => {
        if (what === "rrminus") icon(i, A.icon_rr_minus);
        else if (what === "rrplus") icon(i, A.icon_rr_plus);
        else if (what === "pause") icon(i, A.icon_pause);
        else if (what === "nuke") icon(i, A.icon_nuke);
        else if (what === "speed") icon(i, A.icon_ff);
        else if (what === "restart") icon(i, A.icon_restart);
        else if (what === "frameskip") icon(i, A.icon_frameskip);
        else if (what === "directional") icon(i, A.icon_directional);
        else if (what === "cpmreplay") icon(i, A.icon_cpm_and_replay);
        else if (what === "empty") {
          // an unused slot: black, with the empty-slot picture merged over it (SetSkillIcons)
          for (let y = 0; y < 23; y++) for (let x = 0; x < CELL; x++) {
            const p = ((BUTTON_Y + y) * PANEL_W + i * CELL + x) * 4;
            base.data[p] = base.data[p + 1] = base.data[p + 2] = 0; base.data[p + 3] = 255;
          }
          icon(i, A.empty_slot);
          mark(i, A.empty_slot, 0); // a background, not a picture
        } else icon(i, this._skillIcon(what.slice(6)));
        // the count's box is drawn over the picture on every render
        if (what === "rrminus" || what === "rrplus" || what.startsWith("skill:")) mark(i, A.skill_count_erase, 0);
      });
      this.artMask = art;
      // the minimap's frame after the last cell (the map is drawn over it by the page)
      const region = A.minimap_region || this._redFrame();
      Pixels.blit(base, n * CELL + REGION_X, REGION_Y, region, 0, 0, region.width, region.height, Pixels.combineGadget);
      this.base = base;
    }

    /** DrawHighlight: skill_selected's border around a rect (a nine-slice with 3-px corners). */
    _highlight(out, x, y, w, h) {
      const s = this.assets.skill_selected, m = 3;
      const put = (dx, dy, sx, sy, cw, ch) => Pixels.blit(out, x + dx, y + dy, s, sx, sy, cw, ch, Pixels.combineGadget);
      put(0, 0, 0, 0, m, m); put(w - m, 0, s.width - m, 0, m, m);
      put(0, h - m, 0, s.height - m, m, m); put(w - m, h - m, s.width - m, s.height - m, m, m);
      for (let i = m; i < w - m; i++) { put(i, 0, m, 0, 1, m); put(i, h - m, m, s.height - m, 1, m); }
      for (let j = m; j < h - m; j++) { put(0, j, 0, m, m, 1); put(w - m, j, s.width - m, m, m, 1); }
    }

    /** minimap_region.png by hand: black, with its 1-px red frame where the
     *  picture has it - around the window, x 2..107 and y 1..36 - so the
     *  window (MINIMAP.dx/dy in) lands in the same place either way. */
    _redFrame() {
      const bmp = new Bitmap(REGION_W, REGION_H);
      bmp.words().fill(0xff000000);
      const x0 = MINIMAP.dx - 1, x1 = MINIMAP.dx + MINIMAP.w, y0 = MINIMAP.dy - 1, y1 = MINIMAP.dy + MINIMAP.h;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (x === x0 || y === y0 || x === x1 || y === y1) {
          const p = (y * REGION_W + x) * 4;
          bmp.data[p] = 240; bmp.data[p + 1] = 32; bmp.data[p + 2] = 32; bmp.data[p + 3] = 255;
        }
      }
      return bmp;
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

    /** A cell's count, and (in `mask`) which pixels the digits painted. */
    _drawDigits(out, cell, number, mask) {
      const A = this.assets;
      const x0 = cell * CELL, y0 = BUTTON_Y;
      Pixels.blit(out, x0, y0, A.skill_count_erase, 0, 0, A.skill_count_erase.width, A.skill_count_erase.height, Pixels.combineGadget);
      if (number <= 0) return;
      const digits = A.skill_count_digits;
      const digit = (d, x) => {
        Pixels.blit(out, x, y0 + 1, digits, d * 4, 0, 4, 8, Pixels.combineGadget);
        for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 4; dx++) {
          if (digits.data[(dy * digits.width + d * 4 + dx) * 4 + 3]) mask[(y0 + 1 + dy) * PANEL_W + x + dx] = 1;
        }
      };
      if (number > 99) { digit(9, x0 + 3); digit(9, x0 + 7); return; }
      if (number < 10) digit(number, x0 + 5);
      else { digit(Math.floor(number / 10), x0 + 3); digit(number % 10, x0 + 7); }
    }

    /** DrawNewStr: the strip's columns, characters from panel_font, icons (38..44) from panel_icons. */
    _drawText(out, cols) {
      const font = this.assets.panel_font, icons = this.assets.panel_icons;
      const limit = this.cells.length * CELL; // the strip stops where the minimap frame starts
      for (let i = 0; i < cols.length && i * 8 < limit; i++) {
        const ch = cols[i];
        let id = -1;
        if (typeof ch === "number") id = ch;
        else if (ch === "%") id = 0;
        else if (ch >= "0" && ch <= "9") id = ch.charCodeAt(0) - 48 + 1;
        else if (ch === "-") id = 11;
        else if (ch >= "A" && ch <= "Z") id = ch.charCodeAt(0) - 65 + 12;
        if (id < 0) continue;
        if (id >= ICON.REPLAY) {
          if (icons) Pixels.blit(out, i * 8, 0, icons, (id - ICON.REPLAY) * 8, 0, 8, 16, Pixels.combineGadget);
        } else Pixels.blit(out, i * 8, 0, font, id * 8, 0, 8, 16, Pixels.combineGadget);
      }
    }

    /** GetSkillString: what the strip calls the lemming under the pointer. */
    _cursorWord(L) {
      if (!L || L.removed) return "";
      const name = Lemmix.ACTION_NAMES[L.action] || "";
      let word = ACTION_WORD[name] || "";
      if (L.hasPermanentSkills && this.game.showAthleteInfo) {
        // the Show Athlete Info hotkey: one letter per permanent skill, a dash for each it lacks
        const w = "-------".split("");
        if (L.isSlider) w[0] = "L"; if (L.isClimber) w[1] = "C"; if (L.isSwimmer) w[2] = "S";
        if (L.isFloater) w[3] = "F"; if (L.isGlider) w[3] = "G"; if (L.isDisarmer) w[4] = "D";
        if (L.isZombie) w[5] = "Z"; if (L.isNeutral) w[6] = "N";
        return w.join("");
      }
      if (L.hasPermanentSkills && !WORKING.has(name)) {
        const perms = [];
        if (L.isSlider) perms.push("SLIDER"); if (L.isClimber) perms.push("CLIMBER"); if (L.isSwimmer) perms.push("SWIMMER");
        if (L.isFloater) perms.push("FLOATER"); if (L.isGlider) perms.push("GLIDER"); if (L.isDisarmer) perms.push("DISARMER");
        word = perms.length === 1 ? perms[0] : ATHLETES[Math.min(perms.length, 5)];
      }
      return word;
    }

    /** CreateNewInfoString, as the standard panel lays it out. */
    _infoColumns() {
      const sim = this.game.sim, game = this.game;
      const cols = new Array(INFO_LEN).fill(" ");
      const put = (col, text) => { for (let i = 0; i < text.length && col - 1 + i < INFO_LEN; i++) cols[col - 1 + i] = text[i]; };
      // PadL(PadR(S, 3), 4): a space, then the number left-aligned in three
      const count = (n) => { let s = String(n); if (s.length < 4) s = (s + "   ").slice(0, 3); return (" " + s).slice(-4); };
      put(COL.CURSOR, this._cursorWord(game.cursorLemming).padEnd(12).slice(0, 12));
      if (sim.replaying) cols[COL.REPLAY - 1] = sim.replayInsert ? ICON.REPLAY_INSERT : ICON.REPLAY;
      cols[COL.HATCH_ICON - 1] = ICON.HATCH;
      put(COL.HATCH, count(Math.max(0, sim.lemmingsToRelease - sim.spawnedDead)));
      cols[COL.ALIVE_ICON - 1] = ICON.ALIVE;
      put(COL.ALIVE, count(Math.max(0, sim.lemmingsToRelease + sim.lemmingsOut - sim.spawnedDead)));
      cols[COL.SAVED_ICON - 1] = ICON.SAVED;
      put(COL.SAVED, count(sim.lemmingsIn - sim.level.needCount));
      cols[COL.CLOCK_ICON - 1] = sim.hasTimeLimit ? ICON.CLOCK_LIMIT : ICON.CLOCK;
      let time = Math.floor(sim.currentIteration / 17);
      if (sim.hasTimeLimit) time = Math.abs(sim.level.timeLimitSeconds - time);
      put(COL.MIN, String(Math.floor(time / 60)).padStart(2, " "));
      cols[COL.DASH - 1] = "-";
      put(COL.SEC, String(time % 60).padStart(2, "0"));
      return cols;
    }

    /** Redraw when something changed (every frame while the counters move). */
    render(force) {
      if (!this.assets || this.disposed) return;
      const sim = this.game.sim;
      const out = this.base.clone();
      const digits = new Uint8Array(PANEL_W * PANEL_H);
      this.cells.forEach((what, i) => {
        if (what === "rrminus") this._drawDigits(out, i, sim.minReleaseRate, digits);
        else if (what === "rrplus") this._drawDigits(out, i, sim.releaseRate, digits);
        else if (what.startsWith("skill:")) this._drawDigits(out, i, sim.skillCount(what.slice(6)), digits);
      });
      this.layout.reliefMasks = { art: this.artMask, digits };
      const sel = this.cells.indexOf("skill:" + sim.selectedSkill);
      if (sel >= 0) {
        const s = this.assets.skill_selected;
        Pixels.blit(out, sel * CELL, BUTTON_Y, s, 0, 0, s.width, s.height, Pixels.combineGadget);
      }
      // the selectors NeoLemmix lights: pause while paused, speed while fast, a direction while chosen
      const timer = this.game.getGameTimer();
      const lit = (what) => { const i = this.cells.indexOf(what); if (i >= 0) this._highlight(out, i * CELL, BUTTON_Y, 15, 24); };
      if (!timer.isRunning()) lit("pause");
      if (timer.speedFactor > 1) lit("speed");
      if (this.game.clearPhysics) {
        const i = this.cells.indexOf("cpmreplay");
        if (i >= 0) this._highlight(out, i * CELL, BUTTON_Y, 15, HALF_UPPER_BOTTOM - BUTTON_Y + 1);
      }
      if (sim.selectDx !== 0) {
        const i = this.cells.indexOf("directional");
        if (i >= 0) {
          if (sim.selectDx < 0) this._highlight(out, i * CELL, BUTTON_Y, 15, HALF_UPPER_BOTTOM - BUTTON_Y + 1);
          else this._highlight(out, i * CELL, HALF_LOWER_TOP, 15, BUTTON_Y + 24 - HALF_LOWER_TOP);
        }
      }
      this._drawText(out, this._infoColumns());
      // onto the display, and tell the page it changed
      const frame = Lemmix.LevelBuilder.frameFromBitmap(out, 0, 0);
      frame.mask.fill(1);
      this.display.drawFrame(frame, 0, 0);
      this.display.redraw();
      // a held release-rate button keeps changing it
      if (this.rrHeld) this.game.queueCmmand(this.rrHeld > 0 ? new Lemmings.CommandReleaseRateIncrease(1) : new Lemmings.CommandReleaseRateDecrease(1));
    }

    /** A held frame back/forward half repeats (CheckFrameSkip): the page polls this every frame. */
    poll(now) {
      if (!this.held || now < this.held.next) return;
      this.held.next = now + HOLD_REPEAT_MS;
      this._skip(this.held.step);
    }

    _skip(step) {
      if (step < 0) this.game.backFrames(-step);
      else this.game.forwardFrames(step);
      this.render();
    }

    handleMouseDown(x, y, button) {
      if (y < BUTTON_Y || x >= this.cells.length * CELL) return; // the minimap is the page's
      const cell = Math.trunc(x / CELL);
      const what = this.cells[cell];
      if (!what) return;
      const game = this.game;
      // the split cells answer by half; the line between answers to nobody
      const upper = y <= HALF_UPPER_BOTTOM, lower = y >= HALF_LOWER_TOP;
      if (what === "restart") game.restartReplay();
      else if (what === "frameskip") {
        const n = SKIP_BY_BUTTON[button] || 1;
        if (upper) { this._skip(-n); if (n === 1) this.held = { step: -1, next: performance.now() + HOLD_DELAY_MS }; }
        else if (lower) { this._skip(n); if (n === 1) this.held = { step: 1, next: performance.now() + HOLD_DELAY_MS }; }
        return;
      } else if (what === "directional") {
        if (upper) game.setSelectDx(game.sim.selectDx === -1 ? 0 : -1);
        else if (lower) game.setSelectDx(game.sim.selectDx === 1 ? 0 : 1);
      } else if (what === "cpmreplay") {
        if (upper) game.toggleClearPhysics();
        else if (lower) game.requestLoadReplay();
      } else if (what === "rrminus") { this.rrHeld = -1; game.queueCmmand(new Lemmings.CommandReleaseRateDecrease(1)); }
      else if (what === "rrplus") { this.rrHeld = 1; game.queueCmmand(new Lemmings.CommandReleaseRateIncrease(1)); }
      else if (what === "pause") game.getGameTimer().toggle();
      else if (what === "nuke") {
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
      if (y < BUTTON_Y || x >= this.cells.length * CELL) return;
      if (this.cells[Math.trunc(x / CELL)] === "nuke") { this.game.queueCmmand(new Lemmings.CommandNuke()); this.game.nukePrepared = false; }
    }
  }

  Lemmix.GamePanel = GamePanel;
  Lemmix.loadPanelAssets = loadPanelAssets;
})(typeof window !== "undefined" ? window : globalThis);
