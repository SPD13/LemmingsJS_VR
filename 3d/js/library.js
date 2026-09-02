"use strict";
/**
 * World library: every level of both games. Clicking a level tile loads it.
 *
 * What a tile says depends on the mode. Playing, it reports your own record:
 * a cleared level is marked and carries its best time. Editing, it reports
 * the tagging instead - a green mark on a world's header means a tagging file
 * for that world exists in 3d/profiles/ - and entering a level turns the
 * piece editor on.
 *
 * The tiles are laid out either way round: by level number, the order the
 * games play them in (the default), or by world, the tileset each is built
 * from. The choice is remembered in localStorage.
 *
 * Discovery scans the complete level order once, recording each level's
 * ground set. A VGASPEC special level is one painted picture with no piece
 * list, so it belongs to no tileset: those are collected as a world of their
 * own rather than dropped, which used to make them unreachable from here;
 * the mapping is cached in localStorage. Tile miniatures are rendered
 * lazily (IntersectionObserver + a sequential load queue) so opening the
 * library doesn't load ~220 levels up front.
 */

const WORLD_NAMES = {
  1: ["Dirt", "Fire", "Marble", "Pillar", "Crystal"],
  2: ["Brick", "Rock", "Snow", "Bubble"],
};
const GAME_LABELS = { 1: "Lemmings", 2: "Oh No! More Lemmings" };
const SPECIAL_SET = -1; // the VGASPEC levels: one picture, no tileset

/** What to call a world, tileset or not. */
function worldName(gameType, world) {
  if (world.special) return "Special";
  const names = WORLD_NAMES[gameType] || [];
  return names[world.set] || "World " + world.set;
}
const LIBRARY_CACHE_KEY = "lem3d-worlds-v3";
const PROGRESS_KEY = "lem3d-cleared";
const ORDER_KEY = "lem3d-lib-order";

/**
 * Which levels this browser has cleared, and how fast. Kept in localStorage,
 * so it is per-browser and per-device - there is no account behind it.
 */
const LevelProgress = {
  key(gameType, group, level) { return gameType + "/" + group + "/" + level; },

  all() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; }
    catch (e) { return {}; }
  },

  /** Best time in seconds, or null if this one has never been cleared. */
  best(gameType, group, level) {
    const rec = this.all()[this.key(gameType, group, level)];
    return rec && typeof rec.best === "number" ? rec.best : null;
  },

  /** Record a clear, keeping the fastest. Returns true if it is a new best. */
  record(gameType, group, level, seconds) {
    const all = this.all();
    const k = this.key(gameType, group, level);
    const rec = all[k] || { best: null, clears: 0 };
    const better = rec.best === null || seconds < rec.best;
    all[k] = { best: better ? seconds : rec.best, clears: rec.clears + 1 };
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(all)); } catch (e) {}
    return better;
  },

  /** m:ss, the way the game's own clock reads. */
  format(seconds) {
    const m = Math.floor(seconds / 60), s = seconds % 60;
    return m + ":" + String(s).padStart(2, "0");
  },
};

class WorldLibrary {
  /**
   * enterWorld(gameType, group, level) loads the level with the editor on.
   * onVisibility(open) fires when the catalog is shown or hidden, so the
   * caller can hold the sim while the player is reading it.
   */
  constructor(factory, enterWorld, onVisibility) {
    this.factory = factory;
    this.enterWorld = enterWorld;
    this.onVisibility = onVisibility;
    this.isOpen = false;
    this.editMode = false;
    this.dom = {
      panel: document.getElementById("library"),
      grid: document.getElementById("lib-grid"),
      status: document.getElementById("lib-status"),
      close: document.getElementById("lib-close"),
      rescan: document.getElementById("lib-rescan"),
      order: document.getElementById("lib-order"),
    };
    // by level number, the way the games are played, or by the world each
    // level is built from
    let saved = null;
    try { saved = localStorage.getItem(ORDER_KEY); } catch (e) {}
    this.order = saved === "world" ? "world" : "level";
    this._renderOrderBtn();
    this.dom.order.addEventListener("click", () => {
      this.order = this.order === "level" ? "world" : "level";
      try { localStorage.setItem(ORDER_KEY, this.order); } catch (e) {}
      this._renderOrderBtn();
      if (this._populated) this._populate(false);
    });
    this.dom.close.addEventListener("click", () => this.close());
    this.dom.rescan.addEventListener("click", () => {
      try { localStorage.removeItem(LIBRARY_CACHE_KEY); } catch (e) {}
      this._populate(true);
    });
    this._populated = false;
    this._loadChain = Promise.resolve();
    this._observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this._observer.unobserve(entry.target);
        this._queueThumb(entry.target);
      }
    });
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  _renderOrderBtn() {
    this.dom.order.textContent = "order: " + this.order;
    this.dom.order.title = this.order === "level"
      ? "listed by level number - click to group by world"
      : "grouped by world - click to list by level number";
  }

  /** Playing or editing: the tiles report different things. */
  setEditMode(on) {
    if (this.editMode === on) return;
    this.editMode = on;
    if (this._populated) this._populate(false); // redraw with the other labels
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.dom.panel.hidden = false;
    if (this.onVisibility) this.onVisibility(true);
    if (!this._populated) this._populate(false);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dom.panel.hidden = true;
    if (this.onVisibility) this.onVisibility(false);
  }

  _readCache() {
    try {
      const mapping = JSON.parse(localStorage.getItem(LIBRARY_CACHE_KEY));
      // require the per-level shape (older caches held one level per set)
      for (const worlds of Object.values(mapping || {})) {
        if (!worlds.every((w) => Array.isArray(w.levels))) return null;
      }
      return mapping || null;
    } catch (e) { return null; }
  }

  _writeCache(mapping) {
    try { localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(mapping)); } catch (e) {}
  }

  /**
   * The world map, scanned once and cached: the same data the DOM catalog is
   * built from, for callers that draw their own (the VR window).
   */
  async catalog() {
    let mapping = this._readCache();
    if (!mapping) {
      mapping = await this._discover();
      this._writeCache(mapping);
    }
    return mapping;
  }

  /** A miniature of one level at the given size, loaded once and kept. */
  thumbnail(gameType, group, level, w, h) {
    if (!this._thumbs) this._thumbs = new Map();
    const key = [gameType, group, level, w, h].join("/");
    if (this._thumbs.has(key)) return this._thumbs.get(key);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    // on the same queue the tile miniatures use: a caller that reveals a
    // screenful at once should load them one after another, not all at once
    const pending = this._loadChain.then(async () => {
      const resources = await this.factory.getGameResources(gameType);
      const level_ = await resources.getLevel(group, level);
      this._drawMiniature(canvas, level_);
      return canvas;
    });
    this._loadChain = pending.catch(() => {}); // a failure must not stall it
    this._thumbs.set(key, pending);
    return pending;
  }

  async _populate(force) {
    this._populated = true;
    this.dom.grid.innerHTML = "";
    let mapping = force ? null : this._readCache();
    try {
      if (!mapping) {
        mapping = await this._discover();
        this._writeCache(mapping);
      }
      if (this.order === "world") await this._renderWorlds(mapping);
      else await this._renderLevels(mapping);
      this.dom.status.textContent = "";
    } catch (err) {
      this.dom.status.textContent = "library failed to build — see console";
      console.error(err);
      this._populated = false;
    }
  }

  /** Scan every level of both games and record its ground set. */
  async _discover() {
    const mapping = {}; // gameType -> [{set, levels: [{group, level, name}]}]
    for (const gameType of [1, 2]) {
      const config = await this.factory.getConfig(gameType).catch(() => null);
      if (!config) continue;
      const resources = await this.factory.getGameResources(gameType);
      const bySet = new Map();
      const groups = config.level.order.length;
      const total = config.level.order.reduce((n, g) => n + g.length, 0);
      let scanned = 0;
      for (let g = 0; g < groups; g++) {
        for (let l = 0; l < config.level.getGroupLength(g); l++) {
          this.dom.status.textContent =
            "scanning " + GAME_LABELS[gameType] + " levels… " + (++scanned) + "/" + total;
          try {
            window.__lem3dGroundData = null;
            const level = await resources.getLevel(g, l);
            const gd = window.__lem3dGroundData;
            // no piece data = a VGASPEC special: its own world, not a gap
            const special = !gd || !gd.lr;
            const set = special ? SPECIAL_SET
              : (gd.lr.graphicSet1 != null ? gd.lr.graphicSet1 : 0);
            if (!bySet.has(set)) bySet.set(set, special ? { set, special: true, levels: [] } : { set, levels: [] });
            bySet.get(set).levels.push({ group: g, level: l, name: level.name.trim() });
          } catch (e) { /* unreadable level: skip */ }
        }
      }
      // specials last: they are a footnote to the tilesets, not one of them
      mapping[gameType] = Array.from(bySet.values()).sort(
        (a, b) => (a.special ? 1 : 0) - (b.special ? 1 : 0) || a.set - b.set);
    }
    return mapping;
  }

  async _renderWorlds(mapping) {
    for (const gameType of Object.keys(mapping).map(Number)) {
      const worlds = mapping[gameType];
      if (!worlds || worlds.length === 0) continue;
      const gameHeader = document.createElement("div");
      gameHeader.className = "lib-game";
      gameHeader.textContent = GAME_LABELS[gameType] || "game " + gameType;
      this.dom.grid.appendChild(gameHeader);

      const config = await this.factory.getConfig(gameType);
      const slug = (config.path || "game").replace(/[^a-z0-9]/gi, "").toLowerCase();
      const groupNames = config.level.groups || [];

      for (const world of worlds) {
        const header = document.createElement("div");
        header.className = "lib-world";
        const title = document.createElement("span");
        title.textContent = worldName(gameType, world) +
          (world.special ? "" : " · set " + world.set) +
          " · " + world.levels.length + " levels";
        header.appendChild(title);
        const mark = document.createElement("span");
        mark.className = "lib-mark";
        header.appendChild(mark);
        if (this.editMode && world.special) {
          mark.textContent = "no pieces to tag";
        } else if (this.editMode) {
          fetch("profiles/" + slug + "-g" + world.set + ".json", { method: "HEAD" })
            .then((res) => {
              mark.textContent = res.ok ? "✔ tagged" : "not tagged";
              if (res.ok) mark.classList.add("tagged");
            }).catch(() => { mark.textContent = "not tagged"; });
        } else {
          const done = world.levels.filter(
            (e) => LevelProgress.best(gameType, e.group, e.level) !== null).length;
          mark.textContent = done + " / " + world.levels.length + " cleared";
          if (done === world.levels.length) mark.classList.add("tagged");
        }
        this.dom.grid.appendChild(header);

        const tiles = document.createElement("div");
        tiles.className = "lib-tiles";
        for (const entry of world.levels) {
          tiles.appendChild(this._buildTile(gameType, groupNames, entry));
        }
        this.dom.grid.appendChild(tiles);
      }
    }
  }

  /**
   * The same tiles, in the order the games play them: a heading per
   * difficulty, and each tile saying which world it is built from, since that
   * is no longer what groups them.
   */
  async _renderLevels(mapping) {
    for (const gameType of Object.keys(mapping).map(Number)) {
      const worlds = mapping[gameType];
      if (!worlds || worlds.length === 0) continue;
      const gameHeader = document.createElement("div");
      gameHeader.className = "lib-game";
      gameHeader.textContent = GAME_LABELS[gameType] || "game " + gameType;
      this.dom.grid.appendChild(gameHeader);

      const config = await this.factory.getConfig(gameType);
      const groupNames = config.level.groups || [];
      const levels = [];
      for (const world of worlds) {
        for (const entry of world.levels) {
          levels.push({ entry, set: worldName(gameType, world) });
        }
      }
      // the scan walks a game tileset by tileset; play order is by group
      levels.sort((a, b) =>
        a.entry.group - b.entry.group || a.entry.level - b.entry.level);

      let group = -1, tiles = null;
      for (const { entry, set } of levels) {
        if (entry.group !== group) {
          group = entry.group;
          const inGroup = levels.filter((l) => l.entry.group === group);
          const header = document.createElement("div");
          header.className = "lib-world";
          const title = document.createElement("span");
          title.textContent = (groupNames[group] || "Group " + (group + 1)) +
            " · " + inGroup.length + " levels";
          header.appendChild(title);
          if (!this.editMode) {
            const mark = document.createElement("span");
            mark.className = "lib-mark";
            const done = inGroup.filter((l) => LevelProgress.best(
              gameType, l.entry.group, l.entry.level) !== null).length;
            mark.textContent = done + " / " + inGroup.length + " cleared";
            if (done === inGroup.length) mark.classList.add("tagged");
            header.appendChild(mark);
          }
          this.dom.grid.appendChild(header);
          tiles = document.createElement("div");
          tiles.className = "lib-tiles";
          this.dom.grid.appendChild(tiles);
        }
        tiles.appendChild(this._buildTile(gameType, groupNames, entry, set));
      }
    }
  }

  _buildTile(gameType, groupNames, entry, setName) {
    const tile = document.createElement("div");
    tile.className = "lib-tile";

    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 24;
    canvas.dataset.gameType = gameType;
    canvas.dataset.group = entry.group;
    canvas.dataset.level = entry.level;
    tile.appendChild(canvas);
    this._observer.observe(canvas); // miniature renders when scrolled into view

    const label = document.createElement("div");
    label.className = "lib-label";
    label.textContent =
      (groupNames[entry.group] || "Group " + entry.group) + " " + (entry.level + 1);
    tile.appendChild(label);

    // playing: a cleared level is marked and wears its best time
    if (!this.editMode) {
      const best = LevelProgress.best(gameType, entry.group, entry.level);
      if (best !== null) {
        tile.classList.add("cleared");
        const time = document.createElement("span");
        time.className = "lib-best";
        time.textContent = "✔ " + LevelProgress.format(best);
        time.title = "best clearing time";
        label.appendChild(time);
      }
    }

    const sub = document.createElement("div");
    sub.className = "lib-sub";
    // in level order the world is not the heading, so the tile carries it
    sub.textContent = setName ? entry.name + " · " + setName : entry.name;
    sub.title = sub.textContent;
    tile.appendChild(sub);

    tile.addEventListener("click", () => {
      this.close();
      this.enterWorld(gameType, entry.group, entry.level);
    });
    return tile;
  }

  /** Sequentially load a level and draw its miniature into the tile canvas. */
  _queueThumb(canvas) {
    this._loadChain = this._loadChain.then(async () => {
      if (canvas.dataset.drawn || !this.isOpen && !canvas.isConnected) return;
      try {
        const resources = await this.factory.getGameResources(+canvas.dataset.gameType);
        const level = await resources.getLevel(+canvas.dataset.group, +canvas.dataset.level);
        this._drawMiniature(canvas, level);
        canvas.dataset.drawn = "1";
      } catch (e) { /* leave the miniature blank */ }
    });
  }

  /** Downscale the level's ground image into the card canvas (mask as alpha). */
  _drawMiniature(canvas, level) {
    const full = document.createElement("canvas");
    full.width = level.width;
    full.height = level.height;
    const img = new ImageData(level.width, level.height);
    img.data.set(level.groundImage);
    const mask = level.getGroundMaskLayer().groundMask;
    for (let i = 0; i < level.width * level.height; i++) {
      img.data[i * 4 + 3] = mask[i] ? 255 : 0;
    }
    full.getContext("2d").putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
  }
}
