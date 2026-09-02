"use strict";
/**
 * World library: every level of every pack, browsed the way the levels/
 * directory is laid out. Clicking a level tile loads it.
 *
 * The tree comes from levels/index.json (written by tools/levels-index.js,
 * served live by the launcher): one subdirectory of levels/ per pack, a pack
 * being either a classic DOS game (ranks = difficulties) or a NeoLemmix pack
 * (ranks = its rank folders), and a downloaded collection of packs showing
 * as a directory of packs. The browser walks that tree: a directory shows
 * one row per child - name, whether it is classic or lemmix, how many levels
 * it holds and how many of them are cleared - and a directory that holds
 * levels shows their miniature tiles. Where the player is in the tree is
 * remembered; opening the library lands on the directory of the level being
 * played.
 *
 * What a tile says depends on the mode. Playing, it reports your own record:
 * a cleared level is marked and carries its best time. Editing, it reports
 * the tagging instead - in a classic pack, laid out by world, a green mark on
 * a world's header means a tagging file for that tileset exists in
 * 3d/profiles/ - and entering a level turns the piece editor on.
 *
 * Classic levels carry no name in the index (that would mean reading the DAT
 * files); a pack is scanned once for its names and tilesets, and the result
 * is cached in localStorage. Tile miniatures are rendered lazily
 * (IntersectionObserver + a sequential load queue), so opening a directory
 * does not load every level in it up front. A NeoLemmix level draws a
 * miniature only once a loader for that engine has been registered.
 */

const WORLD_NAMES = {
  1: ["Dirt", "Fire", "Marble", "Pillar", "Crystal"],
  2: ["Brick", "Rock", "Snow", "Bubble"],
};
const SPECIAL_SET = -1; // the VGASPEC levels: one picture, no tileset
const ENGINE_LABEL = { classic: "classic", lemmix: "lemmix" };

/** What to call a classic world, tileset or not. */
function worldName(gameType, world) {
  if (world.special) return "Special";
  const names = WORLD_NAMES[gameType] || [];
  return names[world.set] || "World " + world.set;
}
const INDEX_URL = "levels/index.json";
const SCAN_CACHE_KEY = "lem3d-worlds-v4";
const PROGRESS_KEY = "lem3d-cleared";
const ORDER_KEY = "lem3d-lib-order";
const PATH_KEY = "lem3d-lib-path";

/**
 * The level tree, and every way of looking a level up in it. Loaded once
 * from the index; `byId` resolves a level id to its record, its directory
 * and its pack.
 */
const LevelTree = {
  root: null,
  byId: new Map(),
  byPath: new Map(),

  /** Fetch the index (relative to `root`, the repo root as seen from 3d/). */
  async load(root, force) {
    if (this.root && !force) return this.root;
    const res = await fetch(root + INDEX_URL, { cache: force ? "reload" : "no-cache" });
    if (!res.ok) throw new Error("levels/index.json: HTTP " + res.status);
    this.root = await res.json();
    this.root.kind = "dir";
    this.root.name = "levels";
    this.root.path = "";
    this._index(this.root, null, []);
    return this.root;
  },

  _index(node, pack, ancestors) {
    this.byPath.set(node.path, node);
    node.parent = ancestors.length ? ancestors[ancestors.length - 1] : null;
    if (node.kind === "pack") pack = node;
    node.pack = pack;
    for (const level of node.levels || []) {
      this.byId.set(level.id, { level, node, pack, ancestors });
    }
    for (const child of node.children || []) {
      this._index(child, pack, ancestors.concat(node));
    }
  },

  nodeAt(path) { return this.byPath.get(path || "") || null; },

  /** Every level under a node, in the order it is played. */
  levelsOf(node) {
    const out = [];
    const walk = (n) => {
      for (const level of n.levels || []) out.push(level);
      for (const child of n.children || []) walk(child);
    };
    walk(node);
    return out;
  },

  /** The level `delta` places on from this one within its pack, wrapping. */
  next(levelId, delta) {
    const hit = this.byId.get(levelId);
    if (!hit) return null;
    const list = this.levelsOf(hit.pack || this.root);
    const i = list.findIndex((l) => l.id === levelId);
    if (i < 0) return null;
    return list[(i + delta + list.length) % list.length].id;
  },

  /** How a level is named in the browser and the status strip. */
  describe(levelId) {
    const hit = this.byId.get(levelId);
    if (!hit) return null;
    const { level, node, pack } = hit;
    const ordinal = (node.levels || []).indexOf(level) + 1;
    return {
      level, node, pack,
      engine: node.engine,
      label: node.name + " " + ordinal,               // "Fun 1", "Wimpy 3"
      packName: pack ? pack.name : "",
      title: level.title || null,                     // lemmix levels carry theirs
    };
  },

  /** The first level in the tree: what plays when nothing was asked for. */
  firstLevelId() {
    const list = this.levelsOf(this.root);
    return list.length ? list[0].id : null;
  },

  /** A classic level id from the parameters the URLs used to carry. */
  classicId(gameType, group, index) {
    const pack = (this.root.children || []).find(
      (n) => n.engine === "classic" && n.gameType === gameType);
    if (!pack) return null;
    const rank = (pack.children || [])[group];
    const level = rank && rank.levels[index];
    return level ? level.id : null;
  },
};

/**
 * Which levels this browser has cleared, and how fast. Kept in localStorage,
 * so it is per-browser and per-device - there is no account behind it.
 * Records are keyed by level id (the level's path in the tree).
 */
const LevelProgress = {
  all() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; }
    catch (e) { return {}; }
  },

  _write(all) {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(all)); } catch (e) {}
  },

  /**
   * Records used to be keyed "<gameType>/<group>/<level>"; once the tree is
   * known they are moved to the classic ids those levels have now.
   */
  migrate() {
    const all = this.all();
    let changed = false;
    for (const key of Object.keys(all)) {
      const m = /^([12])\/(\d+)\/(\d+)$/.exec(key);
      if (!m) continue;
      const id = LevelTree.classicId(+m[1], +m[2], +m[3]);
      if (id && !all[id]) all[id] = all[key];
      delete all[key];
      changed = true;
    }
    if (changed) this._write(all);
  },

  /** Best time in seconds, or null if this one has never been cleared. */
  best(levelId) {
    const rec = this.all()[levelId];
    return rec && typeof rec.best === "number" ? rec.best : null;
  },

  /** Record a clear, keeping the fastest. Returns true if it is a new best. */
  record(levelId, seconds) {
    const all = this.all();
    const rec = all[levelId] || { best: null, clears: 0 };
    const better = rec.best === null || seconds < rec.best;
    all[levelId] = { best: better ? seconds : rec.best, clears: rec.clears + 1 };
    this._write(all);
    return better;
  },

  /** How many levels under a node are cleared. */
  clearedUnder(node) {
    const all = this.all();
    return LevelTree.levelsOf(node).filter(
      (l) => all[l.id] && typeof all[l.id].best === "number").length;
  },

  /** m:ss, the way the game's own clock reads. */
  format(seconds) {
    const m = Math.floor(seconds / 60), s = seconds % 60;
    return m + ":" + String(s).padStart(2, "0");
  },
};

class WorldLibrary {
  /**
   * `root` is the repo root as seen from the page ("../" from 3d/).
   * enterLevel(levelId) loads the level (with the editor on, in edit mode).
   * onVisibility(open) fires when the catalog is shown or hidden, so the
   * caller can hold the sim while the player is reading it.
   */
  constructor(factory, root, enterLevel, onVisibility) {
    this.factory = factory;
    this.root = root;
    this.enterLevel = enterLevel;
    this.onVisibility = onVisibility;
    this.isOpen = false;
    this.editMode = false;
    this.currentLevelId = null;
    // how a level of each engine is loaded for a miniature; the classic
    // engine is built in, a NeoLemmix loader is registered when it exists
    this.loaders = {
      classic: async (level, hit) => {
        const resources = await this.factory.getGameResources(hit.pack.gameType);
        return resources.getLevel(level.group, level.index);
      },
    };
    this.dom = {
      panel: document.getElementById("library"),
      crumb: document.getElementById("lib-crumb"),
      grid: document.getElementById("lib-grid"),
      status: document.getElementById("lib-status"),
      close: document.getElementById("lib-close"),
      rescan: document.getElementById("lib-rescan"),
      order: document.getElementById("lib-order"),
    };
    // a classic pack's levels: by number, the way the game plays them, or by
    // the world each level is built from
    let saved = null;
    try { saved = localStorage.getItem(ORDER_KEY); } catch (e) {}
    this.order = saved === "world" ? "world" : "level";
    this._renderOrderBtn();
    this.dom.order.addEventListener("click", () => {
      this.order = this.order === "level" ? "world" : "level";
      try { localStorage.setItem(ORDER_KEY, this.order); } catch (e) {}
      this._renderOrderBtn();
      this._render();
    });
    this.dom.close.addEventListener("click", () => this.close());
    this.dom.rescan.addEventListener("click", () => {
      try { localStorage.removeItem(SCAN_CACHE_KEY); } catch (e) {}
      this._scans = {};
      this.ready = null;
      this._render(true);
    });
    let path = "";
    try { path = localStorage.getItem(PATH_KEY) || ""; } catch (e) {}
    this.path = path;
    this.ready = null;
    this._scans = {};      // classic pack path -> its tileset scan
    this._loadChain = Promise.resolve();
    this._observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this._observer.unobserve(entry.target);
        this._queueThumb(entry.target);
      }
    });
  }

  /** The tree, loaded on first use; `force` re-reads the index. */
  tree(force) {
    if (!this.ready || force) {
      this.ready = LevelTree.load(this.root, force).then((tree) => {
        LevelProgress.migrate();
        return tree;
      });
    }
    return this.ready;
  }

  /** The same tree, for callers that draw their own catalog (the VR window). */
  catalog() { return this.tree(); }

  /** A miniature loader for another engine: fn(level, hit) -> Promise<Level>. */
  registerLoader(engine, fn) { this.loaders[engine] = fn; }

  /** Whether levels of this engine can be loaded at all yet. */
  canLoad(engine) { return !!this.loaders[engine]; }

  /** Load a level record (from either engine) into a Level for a miniature. */
  async loadLevel(levelId) {
    await this.tree();
    const hit = LevelTree.byId.get(levelId);
    if (!hit) throw new Error("unknown level " + levelId);
    const loader = this.loaders[hit.node.engine];
    if (!loader) throw new Error("no loader for " + hit.node.engine + " levels");
    return loader(hit.level, hit);
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
    if (this.isOpen) this._render(); // redraw with the other labels
  }

  /** The level being played: the library opens on its directory. */
  setCurrent(levelId) { this.currentLevelId = levelId; }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.dom.panel.hidden = false;
    if (this.onVisibility) this.onVisibility(true);
    this.tree().then(() => {
      const hit = this.currentLevelId && LevelTree.byId.get(this.currentLevelId);
      if (hit) this.path = hit.node.path;
      this._render();
    }).catch((err) => this._fail(err));
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dom.panel.hidden = true;
    if (this.onVisibility) this.onVisibility(false);
  }

  /** The directory being looked at (the root until the tree is loaded). */
  currentNode() {
    return LevelTree.root ? (LevelTree.nodeAt(this.path) || LevelTree.root) : null;
  }

  navigate(path) {
    this.path = path || "";
    try { localStorage.setItem(PATH_KEY, this.path); } catch (e) {}
    if (this.isOpen) this._render();
  }

  up() {
    const node = this.currentNode();
    if (node && node.parent) this.navigate(node.parent.path);
  }

  _fail(err) {
    this.dom.status.textContent = "library failed to build — see console";
    console.error(err);
  }

  async _render(force) {
    this.dom.grid.innerHTML = "";
    this.dom.status.textContent = "";
    try {
      await this.tree(force);
      let node = this.currentNode();
      if (!node) { node = LevelTree.root; this.path = ""; }
      this._renderCrumb(node);
      const hasLevels = !!(node.levels && node.levels.length);
      this.dom.order.hidden = !(hasLevels && node.engine === "classic");
      if (hasLevels) await this._renderLevels(node);
      else this._renderRows(node);
    } catch (err) {
      this._fail(err);
    }
  }

  /** "levels › Lemmings Plus (all) › Lemmings Plus I › Wimpy" - each part a way up. */
  _renderCrumb(node) {
    const crumb = this.dom.crumb;
    crumb.innerHTML = "";
    const chain = [];
    for (let n = node; n; n = n.parent) chain.unshift(n);
    chain.forEach((n, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "lib-sep";
        sep.textContent = "›";
        crumb.appendChild(sep);
      }
      const part = document.createElement(i < chain.length - 1 ? "a" : "span");
      part.className = "lib-part" + (i === chain.length - 1 ? " here" : "");
      part.textContent = n.name;
      if (i < chain.length - 1) {
        part.href = "#";
        part.addEventListener("click", (e) => { e.preventDefault(); this.navigate(n.path); });
      }
      crumb.appendChild(part);
    });
  }

  /** A directory: one row per child, and a way back up. */
  _renderRows(node) {
    const list = document.createElement("div");
    list.className = "lib-rows";
    if (node.parent) {
      const back = document.createElement("div");
      back.className = "lib-row lib-back";
      back.innerHTML = '<span class="lib-row-name">‹ back</span>';
      back.addEventListener("click", () => this.up());
      list.appendChild(back);
    }
    for (const child of node.children || []) {
      list.appendChild(this._buildRow(child));
    }
    if (!(node.children || []).length) {
      this.dom.status.textContent = "nothing here";
    }
    this.dom.grid.appendChild(list);
  }

  _buildRow(child) {
    const row = document.createElement("div");
    row.className = "lib-row";
    if (child.logo) {
      const logo = document.createElement("img");
      logo.className = "lib-logo";
      logo.src = this.root + child.logo;
      logo.alt = "";
      row.appendChild(logo);
    }
    const name = document.createElement("span");
    name.className = "lib-row-name";
    name.textContent = child.name;
    if (child.author) {
      const by = document.createElement("span");
      by.className = "lib-row-by";
      by.textContent = child.author;
      name.appendChild(by);
    }
    row.appendChild(name);

    const badge = document.createElement("span");
    badge.className = "lib-badge " + (child.engine || "");
    badge.textContent = ENGINE_LABEL[child.engine] || child.engine || "";
    row.appendChild(badge);

    const count = document.createElement("span");
    count.className = "lib-count";
    count.textContent = child.count + (child.count === 1 ? " level" : " levels");
    row.appendChild(count);

    if (!this.editMode) {
      const done = LevelProgress.clearedUnder(child);
      const cleared = document.createElement("span");
      cleared.className = "lib-cleared" + (done === child.count && done > 0 ? " all" : "");
      cleared.textContent = done + " / " + child.count + " cleared";
      row.appendChild(cleared);
      if (done === child.count && done > 0) row.classList.add("done");
    } else if (child.engine === "lemmix") {
      const mark = document.createElement("span");
      mark.className = "lib-cleared";
      mark.textContent = "tagging by style";
      row.appendChild(mark);
    }
    if (child.engine === "lemmix" && !this.canLoad("lemmix")) {
      row.title = "needs the Lemmix engine";
    }
    row.addEventListener("click", () => this.navigate(child.path));
    return row;
  }

  /** A directory of levels: their tiles, by number or (classic) by world. */
  async _renderLevels(node) {
    const list = document.createElement("div");
    list.className = "lib-rows";
    const back = document.createElement("div");
    back.className = "lib-row lib-back";
    back.innerHTML = '<span class="lib-row-name">‹ back</span>';
    back.addEventListener("click", () => this.up());
    list.appendChild(back);
    this.dom.grid.appendChild(list);

    let scan = null;
    if (node.engine === "classic") {
      scan = await this._scanClassic(node.pack);
      if (!this.isOpen || this.currentNode() !== node) return; // moved on meanwhile
    } else if (!this.canLoad(node.engine)) {
      this.dom.status.textContent =
        "these levels need the Lemmix engine, which is not built yet";
    } else if (this.editMode) {
      // a Lemmix profile is per theme style: say which of this rank's are tagged
      const themes = Array.from(new Set(node.levels.map((l) => l.theme).filter(Boolean)));
      Promise.all(themes.map((t) => fetch("profiles/nx-" + t + ".json", { method: "HEAD" })
        .then((r) => [t, r.ok]).catch(() => [t, false]))).then((marks) => {
        this.dom.status.textContent = "styles tagged: " +
          (marks.filter((m) => m[1]).map((m) => m[0]).join(", ") || "none") +
          " · not tagged: " + (marks.filter((m) => !m[1]).map((m) => m[0]).join(", ") || "none");
      });
    }

    if (scan && this.order === "world") {
      // the node's levels, grouped by the tileset each is built from
      const byWorld = new Map();
      for (const level of node.levels) {
        const info = scan.byId[level.id];
        const set = info ? info.set : SPECIAL_SET;
        if (!byWorld.has(set)) byWorld.set(set, []);
        byWorld.get(set).push(level);
      }
      const sets = Array.from(byWorld.keys()).sort(
        (a, b) => (a === SPECIAL_SET ? 1 : 0) - (b === SPECIAL_SET ? 1 : 0) || a - b);
      for (const set of sets) {
        const world = { set, special: set === SPECIAL_SET };
        const levels = byWorld.get(set);
        this._renderHeader(node, worldName(node.pack.gameType, world) +
          (world.special ? "" : " · set " + set), levels, world);
        const tiles = document.createElement("div");
        tiles.className = "lib-tiles";
        for (const level of levels) tiles.appendChild(this._buildTile(node, level, scan));
        this.dom.grid.appendChild(tiles);
      }
      return;
    }

    this._renderHeader(node, node.name, node.levels, null);
    const tiles = document.createElement("div");
    tiles.className = "lib-tiles";
    for (const level of node.levels) tiles.appendChild(this._buildTile(node, level, scan));
    this.dom.grid.appendChild(tiles);
  }

  _renderHeader(node, text, levels, world) {
    const header = document.createElement("div");
    header.className = "lib-world";
    const title = document.createElement("span");
    title.textContent = text + " · " + levels.length + " levels";
    header.appendChild(title);
    const mark = document.createElement("span");
    mark.className = "lib-mark";
    header.appendChild(mark);
    if (this.editMode && world && world.special) {
      mark.textContent = "no pieces to tag";
    } else if (this.editMode && world) {
      const slug = (node.pack.dir || "game").split("/").pop()
        .replace(/[^a-z0-9]/gi, "").toLowerCase();
      fetch("profiles/" + slug + "-g" + world.set + ".json", { method: "HEAD" })
        .then((res) => {
          mark.textContent = res.ok ? "✔ tagged" : "not tagged";
          if (res.ok) mark.classList.add("tagged");
        }).catch(() => { mark.textContent = "not tagged"; });
    } else if (!this.editMode) {
      const done = levels.filter((l) => LevelProgress.best(l.id) !== null).length;
      mark.textContent = done + " / " + levels.length + " cleared";
      if (done === levels.length) mark.classList.add("tagged");
    }
    this.dom.grid.appendChild(header);
  }

  /**
   * Scan a classic pack once for its level names and tilesets (a VGASPEC
   * special level has no piece list, so it belongs to no tileset). Cached in
   * localStorage per pack; about 1.6 s for both games.
   */
  async _scanClassic(pack) {
    if (this._scans[pack.path]) return this._scans[pack.path];
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(SCAN_CACHE_KEY)) || {}; } catch (e) {}
    if (cache[pack.path]) {
      this._scans[pack.path] = cache[pack.path];
      return cache[pack.path];
    }
    const resources = await this.factory.getGameResources(pack.gameType);
    const byId = {};
    const levels = LevelTree.levelsOf(pack);
    let scanned = 0;
    for (const level of levels) {
      this.dom.status.textContent =
        "scanning " + pack.name + " levels… " + (++scanned) + "/" + levels.length;
      try {
        window.__lem3dGroundData = null;
        const loaded = await resources.getLevel(level.group, level.index);
        const gd = window.__lem3dGroundData;
        // no piece data = a VGASPEC special: its own world, not a gap
        const set = !gd || !gd.lr ? SPECIAL_SET
          : (gd.lr.graphicSet1 != null ? gd.lr.graphicSet1 : 0);
        byId[level.id] = { name: loaded.name.trim(), set };
      } catch (e) { /* unreadable level: skip */ }
    }
    this.dom.status.textContent = "";
    const scan = { byId };
    this._scans[pack.path] = scan;
    cache[pack.path] = scan;
    try { localStorage.setItem(SCAN_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
    return scan;
  }

  /** A level's name if known: from the index, or a classic pack's scan. */
  levelName(levelId) {
    const hit = LevelTree.byId.get(levelId);
    if (!hit) return "";
    if (hit.level.title) return hit.level.title;
    const scan = hit.pack && this._scans[hit.pack.path];
    const info = scan && scan.byId[levelId];
    return info ? info.name : "";
  }

  /** The tileset name of a classic level, once its pack has been scanned. */
  worldOf(levelId) {
    const hit = LevelTree.byId.get(levelId);
    const scan = hit && hit.pack && this._scans[hit.pack.path];
    const info = scan && scan.byId[levelId];
    if (!info) return hit && hit.level.theme ? hit.level.theme : "";
    return worldName(hit.pack.gameType, { set: info.set, special: info.set === SPECIAL_SET });
  }

  /** Make sure a classic pack's names are known (the VR list asks for this). */
  async ensureNames(node) {
    await this.tree();
    if (node && node.engine === "classic" && node.pack) await this._scanClassic(node.pack);
  }

  _buildTile(node, level, scan) {
    const tile = document.createElement("div");
    tile.className = "lib-tile";
    const ordinal = node.levels.indexOf(level) + 1;

    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 24;
    canvas.dataset.levelId = level.id;
    tile.appendChild(canvas);
    if (this.canLoad(node.engine)) {
      this._observer.observe(canvas); // miniature renders when scrolled into view
    }

    const label = document.createElement("div");
    label.className = "lib-label";
    label.textContent = node.name + " " + ordinal;
    tile.appendChild(label);

    // playing: a cleared level is marked and wears its best time
    if (!this.editMode) {
      const best = LevelProgress.best(level.id);
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
    const info = scan && scan.byId[level.id];
    const name = level.title || (info ? info.name : "") || "";
    // the world a classic level is built from, or a NeoLemmix level's theme
    const world = info
      ? worldName(node.pack.gameType, { set: info.set, special: info.set === SPECIAL_SET })
      : (level.theme || "");
    sub.textContent = [name, world].filter(Boolean).join(" · ");
    sub.title = sub.textContent;
    tile.appendChild(sub);

    tile.addEventListener("click", () => {
      this.close();
      this.enterLevel(level.id);
    });
    return tile;
  }

  /** A miniature of one level at the given size, loaded once and kept. */
  thumbnail(levelId, w, h) {
    if (!this._thumbs) this._thumbs = new Map();
    const key = [levelId, w, h].join("|");
    if (this._thumbs.has(key)) return this._thumbs.get(key);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    // on the same queue the tile miniatures use: a caller that reveals a
    // screenful at once should load them one after another, not all at once
    const pending = this._loadChain.then(async () => {
      const level = await this.loadLevel(levelId);
      this._drawMiniature(canvas, level);
      return canvas;
    });
    this._loadChain = pending.catch(() => {}); // a failure must not stall it
    this._thumbs.set(key, pending);
    return pending;
  }

  /** Sequentially load a level and draw its miniature into the tile canvas. */
  _queueThumb(canvas) {
    this._loadChain = this._loadChain.then(async () => {
      if (canvas.dataset.drawn || !this.isOpen && !canvas.isConnected) return;
      try {
        const level = await this.loadLevel(canvas.dataset.levelId);
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
