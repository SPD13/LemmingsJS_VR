"use strict";
/**
 * Depth profiles, one file per sprite gallery.
 *
 * A tag (depth class, 3D shade) belongs to a sprite, so it is kept with the
 * gallery the sprite comes from: a DOS tileset (`profiles/<pack>-g<set>.json`,
 * pieces keyed by their index in the ground set) or a NeoLemmix style folder
 * (`profiles/nx-<style>.json`, pieces keyed `<style>:<piece>`). A level reads
 * the files of every gallery its pieces use and works on the merged view;
 * a change goes back into the file of the piece's own gallery.
 *
 * `ProfileStore` is the arithmetic (keys, urls, merging), `ProfileFiles` the
 * per-page cache with unsaved-change tracking, saving through the launcher's
 * POST route and the export download. `renderTagButtons` paints the tag
 * buttons the piece editor and the galleries page share. Runs under node
 * too (tools/profiles-test.js), where depth.js is required.
 */
(function (root) {
  const D = (typeof module !== "undefined" && module.exports)
    ? require("./depth.js")
    : { embossEnabledFor, embossInvertedFor };

  const PROFILE_DIR = "3d/profiles/"; // page-relative: the pages sit at the repo root
  const CLASSES = ["backdrop", "terrain", "relief", "overlay"];
  /** What `c` (cycle class) walks through: the classes, then back to auto. */
  const CLASS_CYCLE = ["terrain", "relief", "backdrop", "overlay", null];

  const ProfileStore = {
    CLASSES,
    CLASS_CYCLE,

    /** A profile with nothing tagged. */
    emptyProfile() {
      return { terrain: { default: "terrain", byId: {} }, emboss: { byId: {} } };
    },

    /** A loaded file brought to the shape the page relies on (other fields kept). */
    normalize(profile) {
      const p = profile && typeof profile === "object" ? profile : {};
      if (!p.terrain || typeof p.terrain !== "object") p.terrain = {};
      if (!p.terrain.default) p.terrain.default = "terrain";
      if (!p.terrain.byId || typeof p.terrain.byId !== "object") p.terrain.byId = {};
      if (!p.emboss || typeof p.emboss !== "object") p.emboss = {};
      if (!p.emboss.byId || typeof p.emboss.byId !== "object") p.emboss.byId = {};
      return p;
    },

    /** Is this a gallery id the page knows: `nx:<style>` or `<pack>-g<set>`. */
    isGalleryId(id) {
      return /^nx:[a-z0-9_]+$/.test(id) || /^[a-z0-9]+-g\d+$/.test(id);
    },

    /** The profile file of a gallery, null for an id that is not one. */
    urlForGallery(id) {
      if (!ProfileStore.isGalleryId(id)) return null;
      return PROFILE_DIR + (id.startsWith("nx:") ? "nx-" + id.slice(3) : id) + ".json";
    },

    /** The gallery a profile file belongs to (the inverse of urlForGallery). */
    galleryForUrl(url) {
      const name = String(url || "").split("/").pop().replace(/\.json$/, "");
      return name.startsWith("nx-") ? "nx:" + name.slice(3) : name;
    },

    /** The style of a Lemmix piece key (`orig_marble:column_01`), null for a DOS id. */
    styleOfKey(key) {
      const s = String(key);
      const colon = s.indexOf(":");
      return colon > 0 ? s.slice(0, colon) : null;
    },

    /** The gallery a piece belongs to: its style, or the level's DOS gallery. */
    galleryForKey(key, dosGalleryId) {
      const style = ProfileStore.styleOfKey(key);
      return style !== null ? "nx:" + style : (dosGalleryId || null);
    },

    /** The file a piece's tag is kept in: its style's, or the level's DOS file. */
    urlForKey(key, dosUrl) {
      const style = ProfileStore.styleOfKey(key);
      return style !== null ? ProfileStore.urlForGallery("nx:" + style) : (dosUrl || null);
    },

    /**
     * The files a level needs, in first-seen order: one per style its pieces
     * come from (Lemmix), the tileset's (DOS), none for a special level.
     */
    urlsForGroundData(groundData, dosUrl) {
      const urls = [];
      if (!groundData || !groundData.lr || !Array.isArray(groundData.lr.terrains)) return urls;
      const images = groundData.terraImages || {};
      let named = false;
      for (const id of Object.keys(images)) {
        const img = images[id];
        if (!img || img.name == null) continue;
        named = true;
        const url = ProfileStore.urlForKey(img.name, null);
        if (url && !urls.includes(url)) urls.push(url);
      }
      if (!named && dosUrl) urls.push(dosUrl);
      return urls;
    },

    /**
     * One view over several files: byId maps unioned (a later file wins on a
     * duplicate key, which only a stray entry can produce), the object
     * settings with them, the terrain default "terrain".
     */
    merge(entries) {
      const out = ProfileStore.emptyProfile();
      for (const e of entries || []) {
        const p = e && e.profile;
        if (!p) continue;
        if (p.terrain && p.terrain.byId) Object.assign(out.terrain.byId, p.terrain.byId);
        if (p.emboss) {
          if (p.emboss.byId) Object.assign(out.emboss.byId, p.emboss.byId);
          if (p.emboss.default !== undefined) out.emboss.default = p.emboss.default;
        }
        if (p.objects && p.objects.byId) {
          if (!out.objects) out.objects = { byId: {} };
          Object.assign(out.objects.byId, p.objects.byId);
        }
      }
      return out;
    },

    /** The class a piece is tagged with, null when it is left to auto. */
    classOf(key, profile) {
      const byId = (profile && profile.terrain && profile.terrain.byId) || {};
      return CLASSES.includes(byId[key]) ? byId[key] : null;
    },

    /** Tag a piece with a class, or null to return it to auto. */
    withClass(profile, key, name) {
      const p = ProfileStore.normalize(profile);
      if (name) p.terrain.byId[key] = name;
      else delete p.terrain.byId[key];
      return p;
    },

    /** Set a piece's 3D shade: true (light raised), "invert" (dark raised), false (off). */
    withEmboss(profile, key, value) {
      const p = ProfileStore.normalize(profile);
      p.emboss.byId[key] = value;
      return p;
    },

    /** What "3D shade" sets next: off when on, on (light raised) when off. */
    nextEmbossToggle(key, profile) {
      return D.embossEnabledFor(key, profile) ? false
        : (D.embossInvertedFor(key, profile) ? "invert" : true);
    },

    /** What "invert" sets next: it also turns the shade on. */
    nextEmbossInvert(key, profile) {
      return D.embossInvertedFor(key, profile) ? true : "invert";
    },

    /** The class after `current` in the cycle. */
    nextClass(current) {
      return CLASS_CYCLE[(CLASS_CYCLE.indexOf(current) + 1) % CLASS_CYCLE.length];
    },

    /** The file's name alone, for messages. */
    fileName(url) { return String(url || "").split("/").pop(); },
  };

  /**
   * The profile files a page works with. A file is fetched fresh (no HTTP
   * cache) unless it holds unsaved changes, so a save made from the other
   * page shows up on the next level load while edits in progress survive
   * level switches.
   */
  class ProfileFiles {
    constructor(opts) {
      const o = opts || {};
      this._fetch = o.fetch || ((url, init) => root.fetch(url, init));
      this.files = new Map(); // url -> { profile, exists, dirty, loaded }
    }

    entry(url) {
      if (!this.files.has(url)) {
        this.files.set(url, { profile: ProfileStore.emptyProfile(), exists: false, dirty: false, loaded: false });
      }
      return this.files.get(url);
    }

    /** The file's profile (a missing file is an empty profile, not an error). */
    async load(url) {
      const e = this.entry(url);
      if (e.dirty) return e.profile;
      let profile = null, exists = false;
      try {
        const res = await this._fetch(url, { cache: "no-store" });
        if (res && res.ok) { profile = await res.json(); exists = true; }
      } catch (err) { /* absent or unreadable: defaults apply */ }
      e.profile = ProfileStore.normalize(profile);
      e.exists = exists;
      e.loaded = true;
      return e.profile;
    }

    /** Every file loaded, then the merged view. */
    async loadAll(urls) {
      await Promise.all(urls.map((u) => this.load(u)));
      return this.merged(urls);
    }

    get(url) { return this.entry(url).profile; }
    exists(url) { return this.entry(url).exists; }
    isDirty(url) { return this.entry(url).dirty; }

    merged(urls) {
      return ProfileStore.merge(urls.map((url) => ({ url, profile: this.entry(url).profile })));
    }

    setClass(key, name, url) {
      const e = this.entry(url);
      ProfileStore.withClass(e.profile, key, name);
      e.dirty = true;
    }

    setEmboss(key, value, url) {
      const e = this.entry(url);
      ProfileStore.withEmboss(e.profile, key, value);
      e.dirty = true;
    }

    /** Every tag of the file cleared (in memory; save to persist). */
    resetAll(url) {
      const e = this.entry(url);
      e.profile.terrain.byId = {};
      e.profile.emboss.byId = {};
      e.dirty = true;
    }

    dirtyUrls() {
      return Array.from(this.files.keys()).filter((u) => this.files.get(u).dirty);
    }

    exportJson(url) {
      return JSON.stringify(this.entry(url).profile, null, 2) + "\n";
    }

    /**
     * POST the file to the launcher, which writes 3d/profiles/. A plain
     * static server answers a POST like a GET, which used to read as a false
     * "saved": the write receipt is required, and the file is read back.
     */
    async save(url) {
      const e = this.entry(url);
      try {
        const res = await this._fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(e.profile, null, 2),
        });
        const receipt = res && res.ok ? await res.json().catch(() => null) : null;
        if (!receipt || receipt.ok !== true) throw new Error("no write receipt");
        const back = await this._fetch(url, { cache: "no-store" });
        const check = back && back.ok ? await back.json() : null;
        const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});
        if (!check || !same(e.profile.terrain.byId, check.terrain && check.terrain.byId) ||
            !same(e.profile.emboss.byId, check.emboss && check.emboss.byId)) {
          throw new Error("read-back mismatch");
        }
        e.dirty = false;
        e.exists = true;
        return { url, ok: true };
      } catch (err) {
        return { url, ok: false, error: err.message };
      }
    }

    /** Save every file with unsaved changes; the results in order. */
    async saveDirty() {
      const out = [];
      for (const url of this.dirtyUrls()) out.push(await this.save(url));
      return out;
    }

    /** Download the file (browser only). */
    download(url) {
      const json = this.exportJson(url);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = ProfileStore.fileName(url);
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  /**
   * Paint a set of tag buttons for a piece: `dom` = {classBtns (one per
   * data-class), autoBtn, embossBtn, invertBtn}; all disabled when nothing is
   * selected (`enabled` false), the current state lit with `.active`.
   */
  function renderTagButtons(dom, key, profile, enabled) {
    const cls = enabled ? ProfileStore.classOf(key, profile) : null;
    for (const b of dom.classBtns) {
      b.disabled = !enabled;
      b.classList.toggle("active", enabled && cls === b.dataset.class);
    }
    dom.autoBtn.disabled = !enabled;
    dom.autoBtn.classList.toggle("active", enabled && cls === null);
    dom.embossBtn.disabled = !enabled;
    dom.embossBtn.classList.toggle("active", enabled && D.embossEnabledFor(key, profile));
    dom.invertBtn.disabled = !enabled;
    dom.invertBtn.classList.toggle("active", enabled && D.embossInvertedFor(key, profile));
  }

  root.ProfileStore = ProfileStore;
  root.ProfileFiles = ProfileFiles;
  root.renderTagButtons = renderTagButtons;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { ProfileStore, ProfileFiles, renderTagButtons };
  }
})(typeof window !== "undefined" ? window : globalThis);
