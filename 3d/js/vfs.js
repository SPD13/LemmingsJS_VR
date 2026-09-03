"use strict";
/**
 * Vfs - the browser's own copy of the game's assets, and the choice between
 * the two ways the page gets them.
 *
 * Two asset modes:
 * - server: neolemmix/ and levels/ are files on the web server (the launcher,
 *   any static server, a checkout with the folders on disk). Today's mode.
 * - static: they live in this browser's IndexedDB, installed from the setup
 *   page (3d/setup.html), and a service worker at the repo root (sw.js)
 *   answers the game's requests for them. What a static host such as GitHub
 *   Pages runs, since it ships the engine only.
 *
 * The mode comes from the URL (?assets=static|server, remembered in
 * localStorage), else the remembered choice, else a probe: a server that has
 * levels/index.json is a server. The worker only intercepts in static mode;
 * it reads the mode from the database (its memory can be dropped between
 * requests) and is told about changes by message.
 *
 * The store: one record per file, keyed by its repo-relative path
 * ("neolemmix/styles/orig_dirt/terrain/x.png", "levels/lemmings/MAIN.DAT"),
 * with the "unit" that installed it - "engine", "styles" or "levels/<dir>" -
 * so an install can be replaced or a level directory deleted as a whole.
 *
 * Loaded by the three 3d pages and the root 2D page; plain script, global Vfs.
 */
(function (root) {
  const DB_NAME = "lem3d-files";
  const DB_VERSION = 1;
  const MODE_KEY = "lem3d-assets";      // localStorage: the remembered mode
  const SEEN_KEY = "lem3d-setup-seen";  // localStorage: the setup page was shown
  const PARAM = "assets";
  const STORE_PREFIXES = ["neolemmix/", "levels/"];
  const INDEX_PATH = "levels/index.json";
  const BATCH = 200; // records per write transaction

  // the same table the launcher's server uses
  const MIME = {
    ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif",
    ".txt": "text/plain; charset=utf-8",
    ".dat": "application/octet-stream",
    ".nxlv": "text/plain; charset=utf-8", ".nxmi": "text/plain; charset=utf-8",
    ".nxmo": "text/plain; charset=utf-8", ".nxmt": "text/plain; charset=utf-8",
    ".nxtm": "text/plain; charset=utf-8", ".ini": "text/plain; charset=utf-8",
    ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg",
    ".it": "application/octet-stream", ".xm": "application/octet-stream",
    ".mod": "application/octet-stream", ".s3m": "application/octet-stream",
  };
  const mimeOf = (path) => {
    const dot = path.lastIndexOf(".");
    return (dot >= 0 && MIME[path.slice(dot).toLowerCase()]) || "application/octet-stream";
  };

  // this script sits at <repo>/3d/js/vfs.js; the worker at <repo>/sw.js
  const scriptSrc = (document.currentScript && document.currentScript.src) || location.href;
  const SW_URL = new URL("../../sw.js", scriptSrc).href;

  // ---- the service worker -------------------------------------------------

  /** Registers the worker; resolves {controlled, reason} once it controls this page. */
  const swReady = (async () => {
    if (!("serviceWorker" in navigator)) {
      return {
        controlled: false,
        reason: window.isSecureContext ? "this browser has no service workers"
          : "not a secure origin: open the page on localhost or over https",
      };
    }
    let registration;
    try {
      registration = await navigator.serviceWorker.register(SW_URL, { updateViaCache: "none" });
    } catch (e) {
      return { controlled: false, reason: "the service worker failed to register: " + (e && e.message) };
    }
    if (navigator.serviceWorker.controller) return { controlled: true, registration };
    // first visit: the worker claims the page once active
    const controlled = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    });
    return {
      controlled, registration,
      reason: controlled ? "" : "the service worker did not take control of the page (a hard reload bypasses it)",
    };
  })();

  /** Tells the worker the mode and waits for its answer (it may be starting up). */
  function tellWorker(mode) {
    const ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!ctl) return Promise.resolve(false);
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(false), 1500);
      ch.port1.onmessage = () => { clearTimeout(timer); resolve(true); };
      try { ctl.postMessage({ type: "mode", value: mode }, [ch.port2]); }
      catch (e) { clearTimeout(timer); resolve(false); }
    });
  }

  // ---- the database -------------------------------------------------------

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("files")) {
          const files = db.createObjectStore("files", { keyPath: "path" });
          files.createIndex("unit", "unit", { unique: false });
        }
        if (!db.objectStoreNames.contains("units")) db.createObjectStore("units", { keyPath: "id" });
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => { dbPromise = null; reject(new Error("the database is open in another tab")); };
    });
    return dbPromise;
  }

  const request = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
  const prefixRange = (prefix) => IDBKeyRange.bound(prefix, prefix + "￿", false, true);

  async function get(store, key) {
    const db = await openDb();
    return request(db.transaction(store, "readonly").objectStore(store).get(key));
  }
  async function put(store, value) {
    const db = await openDb();
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    return done(tx);
  }
  async function remove(store, key) {
    const db = await openDb();
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    return done(tx);
  }
  async function getAll(store) {
    const db = await openDb();
    return request(db.transaction(store, "readonly").objectStore(store).getAll());
  }

  /**
   * Write files: entries [{path, blob, unit?}] (blob a Blob or a Uint8Array),
   * tagged with `unit` unless the entry names its own. Written in
   * transactions of BATCH records so a large package never sits in one
   * transaction.
   */
  async function putFiles(entries, unit, onProgress) {
    const db = await openDb();
    let written = 0;
    for (let i = 0; i < entries.length; i += BATCH) {
      const tx = db.transaction("files", "readwrite");
      const store = tx.objectStore("files");
      for (const e of entries.slice(i, i + BATCH)) {
        const blob = e.blob instanceof Blob ? e.blob : new Blob([e.blob], { type: mimeOf(e.path) });
        store.put({ path: e.path, blob, size: blob.size, type: mimeOf(e.path), unit: e.unit || unit, mtime: Date.now() });
      }
      await done(tx);
      written += Math.min(BATCH, entries.length - i);
      if (onProgress) onProgress(written, entries.length);
    }
    return written;
  }

  /** Delete every file under a path prefix; returns how many. */
  async function deletePrefix(prefix) {
    const db = await openDb();
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    let n = 0;
    await new Promise((resolve, reject) => {
      const req = store.openKeyCursor(prefixRange(prefix));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        store.delete(cur.primaryKey);
        n++;
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await done(tx);
    return n;
  }

  /** Delete every file an install wrote, and its record. */
  async function deleteUnit(id) {
    const db = await openDb();
    const tx = db.transaction(["files", "units"], "readwrite");
    const files = tx.objectStore("files");
    let n = 0;
    await new Promise((resolve, reject) => {
      const req = files.index("unit").openKeyCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        files.delete(cur.primaryKey);
        n++;
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    tx.objectStore("units").delete(id);
    await done(tx);
    return n;
  }

  /** The files under a prefix: [{path, size, unit}], in key order. */
  async function list(prefix) {
    const db = await openDb();
    const out = [];
    const store = db.transaction("files", "readonly").objectStore("files");
    await new Promise((resolve, reject) => {
      const req = store.openCursor(prefix ? prefixRange(prefix) : null);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const v = cur.value;
        out.push({ path: v.path, size: v.size, unit: v.unit });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return out;
  }

  /** The level directories: the distinct first segments under levels/. */
  async function levelDirs() {
    const db = await openDb();
    const dirs = [];
    const store = db.transaction("files", "readonly").objectStore("files");
    await new Promise((resolve, reject) => {
      const req = store.openKeyCursor(prefixRange("levels/"));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const rest = cur.key.slice("levels/".length);
        const slash = rest.indexOf("/");
        if (slash < 0) { cur.continue(); return; } // a loose file (the index)
        const dir = rest.slice(0, slash);
        dirs.push(dir);
        cur.continue("levels/" + dir + "/￿"); // skip the rest of this directory
      };
      req.onerror = () => reject(req.error);
    });
    return dirs;
  }

  /**
   * The text of every file under a prefix that `wanted(path)` selects, as a
   * Map path -> text; every other file under it maps to null (so a listing
   * of the directories stays complete). For the index generators.
   */
  async function readTexts(prefix, wanted) {
    const db = await openDb();
    const out = new Map();
    const pending = [];
    const store = db.transaction("files", "readonly").objectStore("files");
    await new Promise((resolve, reject) => {
      const req = store.openCursor(prefixRange(prefix));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const v = cur.value;
        if (wanted(v.path)) {
          out.set(v.path, null);
          pending.push(v.blob.text().then((t) => { out.set(v.path, t); }));
        } else {
          out.set(v.path, null);
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await Promise.all(pending);
    return out;
  }

  async function has(path) {
    const db = await openDb();
    const key = await request(db.transaction("files", "readonly").objectStore("files").getKey(path));
    return key !== undefined;
  }
  async function readText(path) {
    const rec = await get("files", path);
    return rec ? rec.blob.text() : null;
  }
  async function readBlob(path) {
    const rec = await get("files", path);
    return rec ? rec.blob : null;
  }

  async function estimate() {
    const out = { usage: null, quota: null, persisted: null };
    if (navigator.storage) {
      try { const e = await navigator.storage.estimate(); out.usage = e.usage; out.quota = e.quota; } catch (e) {}
      try { if (navigator.storage.persisted) out.persisted = await navigator.storage.persisted(); } catch (e) {}
    }
    return out;
  }
  async function persist() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; }
    catch (e) { return false; }
  }

  // ---- the mode -----------------------------------------------------------

  let mode = null;

  /** The remembered mode, if any. */
  function savedMode() {
    try {
      const s = localStorage.getItem(MODE_KEY);
      return s === "static" || s === "server" ? s : null;
    } catch (e) { return null; }
  }

  /** Remember a mode (the URL and the setup page's switch do this). */
  function saveMode(m) {
    try { localStorage.setItem(MODE_KEY, m); } catch (e) {}
  }

  /** Store the mode where the worker reads it, and tell the worker. */
  async function setMode(m) {
    mode = m;
    try { await put("settings", { key: "assets", value: m }); } catch (e) {}
    await tellWorker(m);
  }

  /**
   * The mode in force: URL, then the remembered choice, then a probe of the
   * server (`root` is the page's path to the repo root). The probe carries
   * ?probe so the worker leaves it alone whatever mode it is in.
   */
  async function resolveMode(root) {
    let m = null;
    const p = (new URLSearchParams(location.search).get(PARAM) || "").toLowerCase();
    if (p === "static" || p === "server") { m = p; saveMode(m); }
    if (!m) m = savedMode();
    if (!m) {
      try {
        const res = await fetch(root + INDEX_PATH + "?probe=1", { method: "HEAD", cache: "no-store" });
        m = res.ok ? "server" : "static";
      } catch (e) { m = "static"; }
    }
    await setMode(m);
    return m;
  }

  /** Whether the game has levels to play in the mode in force. */
  async function playable(root) {
    if (mode !== "static") return true;
    try { return await has(INDEX_PATH); } catch (e) { return false; }
  }

  const setupSeen = () => { try { return !!localStorage.getItem(SEEN_KEY); } catch (e) { return false; } };
  const markSetupSeen = () => { try { localStorage.setItem(SEEN_KEY, "1"); } catch (e) {} };

  /**
   * What a page does before touching any asset: wait for the worker, settle
   * the mode, and - in static mode, with nothing installed and the setup
   * page never shown - go to the setup page instead (`setupUrl`). Resolves
   * {mode, sw} otherwise; never resolves after a redirect.
   */
  async function boot(root, setupUrl) {
    const sw = await swReady;
    const m = await resolveMode(root);
    if (setupUrl && m === "static" && !setupSeen() && !(await playable(root))) {
      location.replace(setupUrl);
      return new Promise(() => {});
    }
    return { mode: m, sw };
  }

  root.Vfs = {
    DB_NAME, MODE_KEY, SEEN_KEY, PARAM, INDEX_PATH, STORE_PREFIXES, MIME, mimeOf,
    swReady, boot, resolveMode, setMode, saveMode, savedMode,
    get mode() { return mode; },
    playable, setupSeen, markSetupSeen,
    openDb, get, put, remove, getAll,
    putFiles, deletePrefix, deleteUnit, list, levelDirs, has, readText, readTexts, readBlob,
    estimate, persist,
  };
})(typeof window !== "undefined" ? window : globalThis);
