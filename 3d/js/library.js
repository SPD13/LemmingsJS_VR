"use strict";
/**
 * World library: a catalog of every tileset ("world") with a rendered
 * miniature of a representative level. Clicking a card loads that level with
 * the piece editor already enabled — the entry point for tagging sessions.
 * A green mark below a miniature means a tagging file for that world exists
 * in 3d/profiles/.
 *
 * Discovery: ground-set files (GROUND<n>O.DAT) are probed per game, then the
 * level order is scanned front to back, loading levels until each set has a
 * representative (VGASPEC special levels carry no piece data and are
 * skipped). The set->level mapping is cached in localStorage so later opens
 * only load one level per world for the miniatures.
 */

const WORLD_NAMES = {
  1: ["Dirt", "Fire", "Marble", "Pillar", "Crystal"],
  2: ["Brick", "Rock", "Snow", "Bubble"],
};
const GAME_LABELS = { 1: "Lemmings", 2: "Oh No! More Lemmings" };
const LIBRARY_CACHE_KEY = "lem3d-worlds-v1";

class WorldLibrary {
  /** enterWorld(gameType, group, level) loads the level with the editor on. */
  constructor(factory, enterWorld) {
    this.factory = factory;
    this.enterWorld = enterWorld;
    this.isOpen = false;
    this.dom = {
      panel: document.getElementById("library"),
      grid: document.getElementById("lib-grid"),
      status: document.getElementById("lib-status"),
      close: document.getElementById("lib-close"),
      rescan: document.getElementById("lib-rescan"),
    };
    this.dom.close.addEventListener("click", () => this.close());
    this.dom.rescan.addEventListener("click", () => {
      try { localStorage.removeItem(LIBRARY_CACHE_KEY); } catch (e) {}
      this._populate(true);
    });
    this._populated = false;
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    this.isOpen = true;
    this.dom.panel.hidden = false;
    if (!this._populated) this._populate(false);
  }

  close() {
    this.isOpen = false;
    this.dom.panel.hidden = true;
  }

  _readCache() {
    try {
      return JSON.parse(localStorage.getItem(LIBRARY_CACHE_KEY)) || null;
    } catch (e) { return null; }
  }

  _writeCache(mapping) {
    try { localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(mapping)); } catch (e) {}
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
      await this._renderCards(mapping);
      this.dom.status.textContent = "";
    } catch (err) {
      this.dom.status.textContent = "library failed to build — see console";
      console.error(err);
      this._populated = false;
    }
  }

  /** Find one representative (group, level) per ground set, per game type. */
  async _discover() {
    const mapping = {}; // gameType -> [{set, group, level, name}]
    for (const gameType of [1, 2]) {
      const config = await this.factory.getConfig(gameType).catch(() => null);
      if (!config) continue;
      const sets = await this._probeGroundSets(config.path);
      if (sets.length === 0) continue;
      const resources = await this.factory.getGameResources(gameType);
      const found = new Map();
      const groups = config.level.order.length;
      const total = config.level.order.reduce((n, g) => n + g.length, 0);
      let scanned = 0;
      scan: for (let g = 0; g < groups; g++) {
        for (let l = 0; l < config.level.getGroupLength(g); l++) {
          this.dom.status.textContent =
            "scanning " + GAME_LABELS[gameType] + " levels… " + (++scanned) + "/" + total;
          try {
            window.__lem3dGroundData = null;
            const level = await resources.getLevel(g, l);
            const gd = window.__lem3dGroundData;
            if (!gd || !gd.lr) continue; // special level, no piece data
            const set = gd.lr.graphicSet1 != null ? gd.lr.graphicSet1 : 0;
            if (!found.has(set)) {
              found.set(set, { set, group: g, level: l, name: level.name.trim() });
              if (found.size >= sets.length) break scan;
            }
          } catch (e) { /* unreadable level: skip */ }
        }
      }
      mapping[gameType] = Array.from(found.values()).sort((a, b) => a.set - b.set);
    }
    return mapping;
  }

  async _probeGroundSets(path) {
    const sets = [];
    for (let i = 0; i < 10; i++) {
      const res = await fetch("../" + path + "/GROUND" + i + "O.DAT", { method: "HEAD" })
        .catch(() => null);
      if (res && res.ok) sets.push(i);
    }
    return sets;
  }

  async _renderCards(mapping) {
    for (const gameType of Object.keys(mapping).map(Number)) {
      const worlds = mapping[gameType];
      if (!worlds || worlds.length === 0) continue;
      const header = document.createElement("div");
      header.className = "lib-game";
      header.textContent = GAME_LABELS[gameType] || "game " + gameType;
      this.dom.grid.appendChild(header);

      const config = await this.factory.getConfig(gameType);
      const resources = await this.factory.getGameResources(gameType);
      const slug = (config.path || "game").replace(/[^a-z0-9]/gi, "").toLowerCase();

      for (const world of worlds) {
        this.dom.status.textContent =
          "rendering " + (GAME_LABELS[gameType] || "") + " miniatures…";
        const card = await this._buildCard(gameType, slug, resources, world);
        this.dom.grid.appendChild(card);
      }
    }
  }

  async _buildCard(gameType, slug, resources, world) {
    const card = document.createElement("div");
    card.className = "lib-card";

    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 40;
    card.appendChild(canvas);
    try {
      const level = await resources.getLevel(world.group, world.level);
      this._drawMiniature(canvas, level);
    } catch (e) { /* leave the miniature blank */ }

    const label = document.createElement("div");
    label.className = "lib-label";
    const names = WORLD_NAMES[gameType] || [];
    label.textContent = (names[world.set] || "World") + " · set " + world.set;
    card.appendChild(label);

    const sub = document.createElement("div");
    sub.className = "lib-sub";
    sub.textContent = world.name;
    card.appendChild(sub);

    const mark = document.createElement("div");
    mark.className = "lib-mark";
    card.appendChild(mark);
    const profileUrl = "profiles/" + slug + "-g" + world.set + ".json";
    fetch(profileUrl, { method: "HEAD" }).then((res) => {
      if (res.ok) {
        mark.classList.add("tagged");
        mark.textContent = "✔ tagged";
      } else {
        mark.textContent = "not tagged";
      }
    }).catch(() => { mark.textContent = "not tagged"; });

    card.addEventListener("click", () => {
      this.close();
      this.enterWorld(gameType, world.group, world.level);
    });
    return card;
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
