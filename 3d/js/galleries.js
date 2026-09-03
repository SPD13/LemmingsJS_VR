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
 */
(function () {
  const ROOT = "../";
  const STYLES_INDEX = ROOT + "neolemmix/styles/index.json";
  const CARD_PX = 96;       // the miniature's larger side, before integer zoom
  const MAX_DOS_SETS = 10;  // GROUND0O.DAT .. GROUND9O.DAT
  const PARALLEL = 8;       // sprite loads in flight

  const factory = new Lemmings.GameFactory(ROOT);
  const styles = new Lemmix.StyleManager(Lemmix.StyleManager.browserIO(ROOT));
  const files = new ProfileFiles();

  const dom = {
    filter: document.getElementById("gal-filter"),
    note: document.getElementById("gal-note"),
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
          sub: "set " + n + " · " + dir,
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
        sub: s.name + (s.theme && s.theme !== "default" ? " · lemmings: " + s.theme : ""),
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
    name.textContent = g.title;
    const sub = document.createElement("div");
    sub.className = "lib-row-sub";
    sub.textContent = g.sub;
    name.appendChild(sub);
    const badge = document.createElement("span");
    badge.className = "lib-badge " + (g.kind === "dos" ? "classic" : "lemmix");
    badge.textContent = g.kind === "dos" ? "classic" : "lemmix";
    const count = document.createElement("span");
    count.className = "lib-count";
    count.textContent = g.count == null ? "" : g.count + (g.count === 1 ? " sprite" : " sprites");
    const mark = document.createElement("span");
    mark.className = "lib-mark";
    mark.textContent = "…";
    row.append(name, badge, count, mark);
    row.addEventListener("click", () => openGallery(g, null, true));
    g.row = row;
    g.mark = mark;
    return row;
  }

  function setMark(g, tagged) {
    g.tagged = tagged;
    g.mark.textContent = tagged ? "✔ tagged" : "not tagged";
    g.mark.classList.toggle("tagged", tagged);
  }

  /** Which galleries have a profile file (a HEAD per file, a few at a time). */
  async function markTagged(list) {
    await eachLimited(list, async (g) => {
      let ok = false;
      try { ok = (await fetch(g.url, { method: "HEAD", cache: "no-store" })).ok; } catch (e) {}
      setMark(g, ok);
    });
  }

  function applyFilter() {
    const q = dom.filter.value.trim().toLowerCase();
    for (const g of galleries) {
      const hay = (g.title + " " + g.sub + " " + g.id).toLowerCase();
      g.row.hidden = !!q && !hay.includes(q);
    }
  }

  async function buildList() {
    const [dos, nx] = await Promise.all([dosGalleries(), nxGalleries()]);
    galleries = dos.concat(nx || []);
    dom.list.textContent = "";
    for (const g of galleries) dom.list.appendChild(galleryRow(g));
    const notes = [];
    if (nx === null) {
      notes.push("no NeoLemmix styles listed: start the launcher, or run `node tools/styles-index.js` after unpacking the styles (neolemmix/README.md)");
    }
    dom.note.textContent = notes.join(" · ") ||
      (dos.length + " DOS tileset" + (dos.length === 1 ? "" : "s") + ", " + (nx || []).length + " NeoLemmix style" + ((nx || []).length === 1 ? "" : "s"));
    applyFilter();
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
    row2.append(embossBtn, invertBtn);
    el.append(pic, name, size, row1, row2);
    const card = { el, sprite: sp, canvas, size, dom: { classBtns, autoBtn, embossBtn, invertBtn } };
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
    dom.status.textContent = "";
    const b = document.createElement("b");
    b.textContent = ProfileStore.fileName(g.url);
    dom.status.append("profile: ", b, " · " + (files.exists(g.url) ? "on disk" : "no file yet") +
      " · " + tagged + " class tag" + (tagged === 1 ? "" : "s") +
      (shaded ? ", " + shaded + " shade setting" + (shaded === 1 ? "" : "s") : "") +
      (files.isDirty(g.url) ? " · unsaved changes" : ""));
    dom.save.disabled = !files.isDirty(g.url);
    dom.reset.disabled = !tagged && !shaded;
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
      g.row.querySelector(".lib-count").textContent = sprites.length + " sprites";
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

  dom.filter.addEventListener("input", applyFilter);
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
})();
