"use strict";
/**
 * The sprite galleries page (galleries.html): every sprite gallery the
 * levels draw from - a DOS tileset (a GROUND/VGAGR pair of a classic pack)
 * or a NeoLemmix style folder - and, for the open one, a miniature of each
 * terrain sprite with the tag buttons of the piece editor. Tags go to the
 * gallery's profile file (profile-store.js) exactly as the editor's do, so
 * the two tools edit the same files: what is tagged here is what the
 * diorama shows for every placement of the sprite, in every level.
 *
 * The DOS galleries are found by probing each classic pack's folder for
 * its ground files; the NeoLemmix ones come from neolemmix/styles/index.json,
 * which the launcher builds live from the style folders (and
 * tools/styles-index.js writes for static hosting).
 *
 * The list is a tree: the classic games, a directory per pack holding its
 * tilesets; the NeoLemmix styles, a directory per author (the part of the
 * folder name before the first underscore, NeoLemmix's naming) holding
 * their styles. Directories open and close by a click, which is
 * remembered; the filter searches the whole tree and opens whatever holds
 * a match; opening a gallery opens its branch.
 */
Vfs.boot("").then(function (booted) {
  return ConfigStore.sync(booted.mode, ""); // the open branches, from the server in server mode
}).then(function () {
  const ROOT = "";
  const STYLES_INDEX = ROOT + "neolemmix/styles/index.json";
  const CARD_PX = 96;       // the miniature's larger side, before integer zoom
  const MAX_DOS_SETS = 10;  // GROUND0O.DAT .. GROUND9O.DAT
  const PARALLEL = 8;       // sprite loads in flight

  const factory = new Lemmings.GameFactory(ROOT);
  const styles = new Lemmix.StyleManager(Lemmix.StyleManager.browserIO(ROOT));
  const files = new ProfileFiles();
  document.getElementById("gal-back").href = Vfs.link("index.html"); // a forced mode goes along

  const dom = {
    filter: document.getElementById("gal-filter"),
    note: document.getElementById("gal-note"),
    collapse: document.getElementById("gal-collapse"),
    list: document.getElementById("gal-list"),
    head: document.getElementById("gal-head"),
    title: document.getElementById("gal-title"),
    status: document.getElementById("gal-status"),
    save: document.getElementById("gal-save"),
    export: document.getElementById("gal-export"),
    reset: document.getElementById("gal-reset"),
    msg: document.getElementById("gal-msg"),
    empty: document.getElementById("gal-empty"),
    grid: document.getElementById("gal-grid"),
    back: document.getElementById("gal-back"),
  };

  let galleries = [];       // every gallery, in list order
  let current = null;       // the open gallery
  let opening = 0;          // a counter so a slow open does not paint over a newer one
  const cards = new Map();  // piece key -> { el, dom, sprite }
  const OPEN_KEY = "lem3d-gal-open";
  let tree = { children: [] };  // directories ({kind:"dir", id, title, children, parent, row, mark}) and galleries
  let openDirs = new Set(["dos", "nx"]);
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY));
    if (Array.isArray(saved)) openDirs = new Set(saved.filter((id) => typeof id === "string"));
  } catch (e) { /* the defaults: the two roots open */ }

  const slugOf = (dir) => String(dir || "game").split("/").pop().replace(/[^a-z0-9]/gi, "").toLowerCase();

  /** Run `job` over `items`, at most PARALLEL at a time, in order of start. */
  async function eachLimited(items, job) {
    let next = 0;
    const workers = [];
    for (let w = 0; w < PARALLEL; w++) {
      workers.push((async () => {
        while (next < items.length) {
          const i = next++;
          await job(items[i], i);
        }
      })());
    }
    await Promise.all(workers);
  }

  // ---- the list

  /** The DOS tilesets: each classic pack's ground files, probed by number. */
  async function dosGalleries() {
    const out = [];
    let tree = null;
    try { tree = await LevelTree.load(ROOT); } catch (e) { return out; }
    const packs = [];
    const walk = (n) => {
      if (n.kind === "pack" && n.engine === "classic") packs.push(n);
      for (const c of n.children || []) walk(c);
    };
    walk(tree);
    for (const pack of packs) {
      const dir = pack.dir || ("levels/" + pack.path);
      const slug = slugOf(dir);
      const found = await Promise.all(Array.from({ length: MAX_DOS_SETS }, (_, n) =>
        fetch(ROOT + dir + "/GROUND" + n + "O.DAT", { method: "HEAD" }).then((r) => r.ok).catch(() => false)));
      found.forEach((ok, n) => {
        if (!ok) return;
        const id = slug + "-g" + n;
        out.push({
          id, kind: "dos", pack, set: n, url: ProfileStore.urlForGallery(id),
          title: pack.name + " · " + worldName(pack.gameType, { set: n }),
          short: worldName(pack.gameType, { set: n }),
          sub: "set " + n,
          count: null,
        });
      });
    }
    return out;
  }

  /** The NeoLemmix styles, from the styles index. */
  async function nxGalleries() {
    let index = null;
    try {
      const res = await fetch(STYLES_INDEX, { cache: "no-store" });
      if (res.ok) index = await res.json();
    } catch (e) { /* no index */ }
    if (!index) return null;
    const out = [];
    for (const s of index.styles || []) {
      const id = "nx:" + s.name;
      const url = ProfileStore.urlForGallery(id);
      if (!url) continue;
      out.push({
        id, kind: "nx", style: s.name, url,
        title: s.title || s.name,
        short: s.title || s.name,
        sub: s.name + (s.theme && s.theme !== "default" ? " · lemmings: " + s.theme : ""),
        author: s.name.includes("_") ? s.name.split("_")[0] : null,
        count: s.count | 0, pieces: s.pieces || [], steel: new Set(s.steel || []),
      });
    }
    // the styles with pieces first, the empty ones (no terrain folder) after
    out.sort((a, b) => (b.count > 0) - (a.count > 0));
    return out;
  }

  function galleryRow(g) {
    const row = document.createElement("div");
    row.className = "lib-row" + (g.count === 0 ? " empty" : "");
    row.dataset.id = g.id;
    const name = document.createElement("div");
    name.className = "lib-row-name";
    name.textContent = g.short || g.title;
    const sub = document.createElement("div");
    sub.className = "lib-row-sub";
    sub.textContent = g.sub;
    name.appendChild(sub);
    row.title = g.title + (g.kind === "dos" ? " (classic tileset)" : " (NeoLemmix style)");
    const count = document.createElement("span");
    count.className = "lib-count";
    count.textContent = g.count == null ? "" : String(g.count);
    count.title = g.count == null ? "" : g.count + (g.count === 1 ? " sprite" : " sprites");
    const mark = document.createElement("span");
    mark.className = "lib-mark";
    mark.textContent = "…";
    row.append(name, count, mark);
    row.addEventListener("click", () => openGallery(g, null, true));
    g.row = row;
    g.mark = mark;
    return row;
  }

  function setMark(g, tagged) {
    g.tagged = tagged;
    g.mark.textContent = tagged ? "✔" : "";
    g.mark.title = tagged ? "has a profile file" : "no profile file yet";
    g.mark.classList.toggle("tagged", tagged);
    for (let d = g.parent; d && d.id; d = d.parent) renderDirMark(d);
  }

  // ---- the tree

  function dirNode(id, title, sub, parent) {
    const node = { kind: "dir", id, title, sub, children: [], parent, row: null, mark: null };
    parent.children.push(node);
    return node;
  }

  /** Every gallery under a directory. */
  function leavesOf(node) {
    const out = [];
    const walk = (n) => { for (const c of n.children) c.kind === "dir" ? walk(c) : out.push(c); };
    walk(node);
    return out;
  }

  function matches(g, q) {
    return !q || (g.title + " " + g.sub + " " + g.id).toLowerCase().includes(q);
  }

  function dirRow(node) {
    const row = document.createElement("div");
    row.className = "lib-row gal-dir";
    const caret = document.createElement("span");
    caret.className = "gal-caret";
    const name = document.createElement("div");
    name.className = "lib-row-name";
    name.textContent = node.title;
    if (node.sub) {
      const sub = document.createElement("div");
      sub.className = "lib-row-sub";
      sub.textContent = node.sub;
      name.appendChild(sub);
    }
    const count = document.createElement("span");
    count.className = "lib-count";
    const mark = document.createElement("span");
    mark.className = "lib-mark";
    row.append(caret, name, count, mark);
    row.addEventListener("click", () => {
      if (dom.filter.value.trim()) return; // the filter decides what is open
      if (openDirs.has(node.id)) openDirs.delete(node.id); else openDirs.add(node.id);
      saveOpen();
      renderList();
    });
    node.row = row;
    node.caret = caret;
    node.count = count;
    node.mark = mark;
    renderDirMark(node);
    return row;
  }

  /** A directory's tally: how many galleries it holds, how many have a file. */
  function renderDirMark(node) {
    if (!node.mark) return;
    const leaves = leavesOf(node);
    const tagged = leaves.filter((g) => g.tagged).length;
    node.count.textContent = String(leaves.length);
    node.count.title = leaves.length + (leaves.length === 1 ? " gallery" : " galleries");
    node.mark.textContent = tagged ? tagged + " ✔" : "";
    node.mark.title = tagged + " with a profile file";
    node.mark.classList.toggle("tagged", tagged > 0);
  }

  function saveOpen() {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(Array.from(openDirs))); } catch (e) {}
  }

  /** Open every directory above a gallery, so it is on screen. */
  function reveal(g) {
    let changed = false;
    for (let d = g.parent; d && d.id; d = d.parent) {
      if (!openDirs.has(d.id)) { openDirs.add(d.id); changed = true; }
    }
    if (changed) saveOpen();
    renderList();
    if (g.row.isConnected) g.row.scrollIntoView({ block: "nearest" });
  }

  /**
   * Lay the tree out: open directories unfold, a filter shows only the
   * galleries that match, inside their (then open) directories.
   */
  function renderList() {
    const q = dom.filter.value.trim().toLowerCase();
    dom.list.textContent = "";
    const walk = (node, depth) => {
      for (const child of node.children) {
        if (child.kind === "dir") {
          const hits = q ? leavesOf(child).filter((g) => matches(g, q)).length : -1;
          if (q && !hits) continue;
          const open = q ? true : openDirs.has(child.id);
          child.caret.textContent = open ? "▾" : "▸";
          child.row.style.paddingLeft = (12 + depth * 16) + "px";
          child.row.classList.toggle("open", open);
          dom.list.appendChild(child.row);
          if (open) walk(child, depth + 1);
        } else {
          if (!matches(child, q)) continue;
          child.row.style.paddingLeft = (12 + depth * 16) + "px";
          dom.list.appendChild(child.row);
        }
      }
    };
    walk(tree, 0);
    if (!dom.list.children.length) {
      const none = document.createElement("div");
      none.id = "gal-none";
      none.textContent = q ? "no gallery matches" : "no galleries found";
      dom.list.appendChild(none);
    }
  }

  /** Which galleries have a profile file (a HEAD per file, a few at a time). */
  async function markTagged(list) {
    await eachLimited(list, async (g) => {
      let ok = false;
      try { ok = (await fetch(g.url, { method: "HEAD", cache: "no-store" })).ok; } catch (e) {}
      setMark(g, ok);
    });
  }

  async function buildList() {
    const [dos, nx] = await Promise.all([dosGalleries(), nxGalleries()]);
    galleries = dos.concat(nx || []);
    tree = { children: [] };
    if (dos.length) {
      const root = dirNode("dos", "Classic games", "the DOS tilesets, a pack at a time", tree);
      const packs = new Map();
      for (const g of dos) {
        const key = g.pack.path || g.pack.name;
        if (!packs.has(key)) packs.set(key, dirNode("dos/" + key, g.pack.name, g.pack.dir || "", root));
        g.parent = packs.get(key);
        g.parent.children.push(g);
      }
    }
    if (nx && nx.length) {
      const root = dirNode("nx", "NeoLemmix styles", "a directory per author", tree);
      const authors = new Map();
      const sorted = nx.slice().sort((a, b) =>
        (!a.author) - (!b.author) || (a.author || "").localeCompare(b.author || "") ||
        (b.count > 0) - (a.count > 0) || a.title.localeCompare(b.title));
      for (const g of sorted) {
        const key = g.author || "other";
        if (!authors.has(key)) authors.set(key, dirNode("nx/" + key, key, g.author ? key + "_*" : "styles without an author prefix", root));
        g.parent = authors.get(key);
        g.parent.children.push(g);
      }
    }
    for (const g of galleries) galleryRow(g);
    const walkDirs = (n) => { for (const c of n.children) if (c.kind === "dir") { dirRow(c); walkDirs(c); } };
    walkDirs(tree);
    const notes = [];
    if (nx === null) {
      notes.push("no NeoLemmix styles listed: start the launcher, or run `node tools/styles-index.js` after unpacking the styles (neolemmix/README.md)");
    }
    dom.note.textContent = notes.join(" · ") ||
      (dos.length + " DOS tileset" + (dos.length === 1 ? "" : "s") + ", " + (nx || []).length + " NeoLemmix style" + ((nx || []).length === 1 ? "" : "s"));
    renderList();
    markTagged(galleries);
  }

  // ---- the sprites of a gallery

  /** A DOS tileset's terrain sprites, as RGBA from the ground palette. */
  async function dosSprites(g) {
    const resources = await factory.getGameResources(g.pack.gameType);
    const fp = resources.fileProvider, dir = resources.config.path;
    const [vga, ground] = await Promise.all([
      fp.loadBinary(dir, "VGAGR" + g.set + ".DAT"),
      fp.loadBinary(dir, "GROUND" + g.set + "O.DAT"),
    ]);
    const container = new Lemmings.FileContainer(vga);
    const reader = new Lemmings.GroundReader(ground, container.getPart(0), container.getPart(1));
    const out = [];
    reader.getTerraImages().forEach((img, i) => {
      if (!img || !img.width || !img.height || !img.frames || !img.frames[0]) return;
      const w = img.width, h = img.height, src = img.frames[0], pal = img.palette;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let p = 0, o = 0; p < w * h; p++, o += 4) {
        const c = src[p];
        if ((c & 0x80) !== 0) continue; // transparent
        rgba[o] = pal.getR(c); rgba[o + 1] = pal.getG(c); rgba[o + 2] = pal.getB(c); rgba[o + 3] = 255;
      }
      out.push({ key: i, label: "#" + i, w, h, rgba, steel: false });
    });
    return out;
  }

  /** A style's terrain sprites: one card per piece of the index, filled as each loads. */
  function nxSprites(g) {
    return g.pieces.map((piece) => ({
      key: g.style + ":" + piece, label: piece, steel: g.steel.has(piece),
      load: async () => {
        const meta = await styles.terrain(g.style, piece);
        if (!meta) return null;
        return { w: meta.base.width, h: meta.base.height, rgba: meta.base.image.data };
      },
    }));
  }

  function paint(canvas, sp) {
    const z = Math.max(1, Math.floor(CARD_PX / Math.max(sp.w, sp.h)));
    canvas.width = sp.w;
    canvas.height = sp.h;
    canvas.style.width = (sp.w * z) + "px";
    canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(sp.rgba), sp.w, sp.h), 0, 0);
  }

  function makeCard(g, sp) {
    const el = document.createElement("div");
    el.className = "gal-sprite";
    const pic = document.createElement("div");
    pic.className = "gal-pic";
    const canvas = document.createElement("canvas");
    pic.appendChild(canvas);
    const name = document.createElement("div");
    name.className = "gal-name";
    name.textContent = sp.label;
    name.title = String(sp.key);
    const size = document.createElement("div");
    size.className = "gal-size";
    const row1 = document.createElement("div");
    row1.className = "btnrow";
    const classBtns = ProfileStore.CLASSES.map((cls) => {
      const b = document.createElement("button");
      b.dataset.class = cls;
      b.textContent = cls;
      b.addEventListener("click", () => tag(g, sp, () => files.setClass(sp.key, cls, g.url)));
      return b;
    });
    const autoBtn = document.createElement("button");
    autoBtn.textContent = "auto";
    autoBtn.addEventListener("click", () => tag(g, sp, () => files.setClass(sp.key, null, g.url)));
    row1.append(...classBtns, autoBtn);
    const row2 = document.createElement("div");
    row2.className = "btnrow";
    const embossBtn = document.createElement("button");
    embossBtn.textContent = "3D shade";
    embossBtn.addEventListener("click", () => tag(g, sp, () =>
      files.setEmboss(sp.key, ProfileStore.nextEmbossToggle(sp.key, files.get(g.url)), g.url)));
    const invertBtn = document.createElement("button");
    invertBtn.textContent = "invert";
    invertBtn.addEventListener("click", () => tag(g, sp, () =>
      files.setEmboss(sp.key, ProfileStore.nextEmbossInvert(sp.key, files.get(g.url)), g.url)));
    const blendBtn = document.createElement("button");
    blendBtn.textContent = "surface blend";
    blendBtn.addEventListener("click", () => tag(g, sp, () =>
      files.setBlend(sp.key, ProfileStore.nextBlendToggle(sp.key, files.get(g.url)), g.url)));
    const colorBlendBtn = document.createElement("button");
    colorBlendBtn.textContent = "colour blend";
    colorBlendBtn.addEventListener("click", () => tag(g, sp, () =>
      files.setColorBlend(sp.key, ProfileStore.nextColorBlendToggle(sp.key, files.get(g.url)), g.url)));
    row2.append(embossBtn, invertBtn, blendBtn, colorBlendBtn);
    el.append(pic, name, size, row1, row2);
    const card = { el, sprite: sp, canvas, size, dom: { classBtns, autoBtn, embossBtn, invertBtn, blendBtn, colorBlendBtn } };
    cards.set(String(sp.key), card);
    return card;
  }

  function fillCard(card, loaded) {
    const sp = card.sprite;
    if (!loaded) {
      card.el.classList.add("missing");
      card.size.textContent = "missing";
      renderTagButtons(card.dom, sp.key, files.get(current.url), false);
      return;
    }
    Object.assign(sp, loaded);
    paint(card.canvas, sp);
    card.size.textContent = sp.w + "×" + sp.h;
    if (sp.steel) {
      const s = document.createElement("span");
      s.className = "gal-steel";
      s.textContent = "steel";
      card.size.appendChild(s);
    }
    refreshCard(card);
  }

  function refreshCard(card) {
    const profile = files.get(current.url);
    renderTagButtons(card.dom, card.sprite.key, profile, true);
    card.el.classList.toggle("tagged", ProfileStore.classOf(card.sprite.key, profile) !== null);
  }

  function tag(g, sp, change) {
    if (g !== current) return;
    change();
    refreshCard(cards.get(String(sp.key)));
    renderHead();
  }

  // ---- the head: which file, its state, save / export / reset

  function msg(text, ok) {
    dom.msg.textContent = text;
    dom.msg.className = ok ? "ok" : "err";
  }

  function renderHead() {
    if (!current) return;
    const g = current;
    const profile = files.get(g.url);
    const tagged = Object.keys(profile.terrain.byId).length;
    const shaded = Object.keys(profile.emboss.byId).length;
    const unblended = Object.keys(profile.blend.byId)
      .filter((k) => profile.blend.byId[k] === false).length;
    // the colour blend is on unless a piece is tagged out, so what the file
    // holds is the exceptions
    const uncoloured = Object.keys(profile.colorBlend.byId)
      .filter((k) => profile.colorBlend.byId[k] === false).length;
    dom.status.textContent = "";
    const b = document.createElement("b");
    b.textContent = ProfileStore.fileName(g.url);
    dom.status.append("profile: ", b, " · " + (files.exists(g.url) ? "on disk" : "no file yet") +
      " · " + tagged + " class tag" + (tagged === 1 ? "" : "s") +
      (shaded ? ", " + shaded + " shade setting" + (shaded === 1 ? "" : "s") : "") +
      (unblended ? ", " + unblended + " out of the surface blend" : "") +
      (uncoloured ? ", " + uncoloured + " out of the colour blend" : "") +
      (files.isDirty(g.url) ? " · unsaved changes" : ""));
    dom.save.disabled = !files.isDirty(g.url);
    dom.reset.disabled = !tagged && !shaded && !blended && !coloured;
  }

  async function save() {
    if (!current) return;
    const g = current;
    const r = await files.save(g.url);
    if (r.ok) {
      msg("saved " + ProfileStore.fileName(g.url) + " — the 3D page loads it with the next level", true);
      setMark(g, true);
    } else {
      msg("NOT saved — the launcher server writes the file; a plain static server cannot (use export JSON)", false);
    }
    renderHead();
  }

  function exportFile() {
    if (!current) return;
    files.download(current.url);
    msg("exported " + ProfileStore.fileName(current.url) + " — save it into 3d/profiles/", true);
  }

  function resetAll() {
    if (!current) return;
    files.resetAll(current.url);
    for (const card of cards.values()) if (!card.el.classList.contains("missing")) refreshCard(card);
    renderHead();
    msg("all tags of " + ProfileStore.fileName(current.url) + " reset (not saved yet)", true);
  }

  // ---- opening a gallery

  async function openGallery(g, pieceKey, pushUrl) {
    const token = ++opening;
    current = g;
    cards.clear();
    for (const other of galleries) other.row.classList.toggle("here", other === g);
    reveal(g);
    dom.empty.hidden = true;
    dom.head.hidden = false;
    dom.title.textContent = g.title;
    dom.msg.textContent = "";
    dom.grid.textContent = "";
    dom.status.textContent = "loading…";
    if (pushUrl) {
      const q = "?gallery=" + encodeURIComponent(g.id) + (pieceKey != null ? "&piece=" + encodeURIComponent(pieceKey) : "");
      history.replaceState(null, "", q);
    }
    await files.load(g.url);
    if (token !== opening) return;
    renderHead();

    if (g.kind === "dos") {
      let sprites = [];
      try { sprites = await dosSprites(g); } catch (e) { msg("could not read the tileset: " + e.message, false); }
      if (token !== opening) return;
      g.count = sprites.length;
      g.row.querySelector(".lib-count").textContent = String(sprites.length);
      for (const sp of sprites) {
        const card = makeCard(g, sp);
        dom.grid.appendChild(card.el);
        fillCard(card, sp);
      }
    } else {
      const sprites = nxSprites(g);
      const made = sprites.map((sp) => {
        const card = makeCard(g, sp);
        dom.grid.appendChild(card.el);
        card.size.textContent = "…";
        renderTagButtons(card.dom, sp.key, files.get(g.url), false);
        return card;
      });
      if (!sprites.length) dom.status.textContent += " · this style has no terrain folder";
      eachLimited(made, async (card) => {
        let loaded = null;
        try { loaded = await card.sprite.load(); } catch (e) { loaded = null; }
        if (token !== opening) return;
        fillCard(card, loaded);
      });
    }
    if (pieceKey != null) {
      const card = cards.get(String(pieceKey));
      if (card) {
        card.el.classList.add("gal-hit");
        card.el.scrollIntoView({ block: "center" });
      } else {
        msg("no sprite " + pieceKey + " in this gallery", false);
      }
    }
  }

  // ---- boot

  dom.filter.addEventListener("input", renderList);
  dom.collapse.addEventListener("click", () => {
    openDirs.clear();
    saveOpen();
    dom.filter.value = "";
    renderList();
  });
  dom.save.addEventListener("click", save);
  dom.export.addEventListener("click", exportFile);
  dom.reset.addEventListener("click", resetAll);
  window.addEventListener("beforeunload", (e) => {
    if (!files.dirtyUrls().length) return;
    e.preventDefault();
    e.returnValue = "";
  });

  buildList().then(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get("gallery");
    const piece = params.get("piece");
    if (!id) return;
    const g = galleries.find((x) => x.id === id);
    if (g) openGallery(g, piece, false);
    else dom.note.textContent = "no gallery " + id + " here";
  }).catch((e) => { dom.note.textContent = "could not list the galleries: " + e.message; });

  window.__galleries = { files, get galleries() { return galleries; }, get current() { return current; }, openGallery, cards };
});
