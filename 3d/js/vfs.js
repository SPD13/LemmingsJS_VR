"use strict";
/**
 * Vfs - the browser's own copy of the game's assets, and the choice between
 * the two ways the page gets them.
 *
 * Two asset modes:
 * - server: neolemmix/ and levels/ are files on the web server (the launcher,
 *   any static server, a checkout with the folders on disk). Today's mode.
 * - static: they live in this browser's IndexedDB, installed from the setup
 *   page (setup.html), and a service worker at the repo root (sw.js)
 *   answers the game's requests for them. What a static host such as GitHub
 *   Pages runs, since it ships the engine only.
 *
 * The mode comes from the URL (?assets=static|server forces one, and the
 * pages carry the flag along while it is set), else from the launcher's
 * health check: a server that answers health.json is a server, anything
 * else is a static host. The worker only intercepts in static mode;
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
  const HEALTH_PATH = "health.json";    // the launcher answers it (launcher/server.js)
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

  // this script sits at <repo>/3d/js/vfs.js (the pages at <repo>/); the worker at <repo>/sw.js
  const scriptSrc = (document.currentScript && document.currentScript.src) || location.href;
  const SW_URL = new URL("../../sw.js", scriptSrc).href;

  // ---- the service worker -------------------------------------------------

  /**
   * Registers the worker (once); resolves {controlled, reason} once it
   * controls this page. Called for the static mode only: the worker serves
   * nothing in server mode, and registering it on the launcher's
   * self-signed https makes the browser log a certificate warning.
   *
   * A page load that bypassed the worker - a hard reload (which the
   * version banner asks for), or DevTools' "Bypass for network" - leaves an
   * active worker that never controls this page. One normal reload puts
   * the page under it, so that is what happens, once: the guard in
   * sessionStorage keeps a bypass that survives the reload (DevTools) from
   * looping, and that case is reported instead.
   */
  let swReady = null;
  function registerWorker() {
    if (!swReady) swReady = doRegisterWorker();
    return swReady;
  }
  const RELOAD_KEY = "lem3d-sw-reload"; // sessionStorage: this page reloaded itself to get under the worker
  const reloaded = () => { try { return !!sessionStorage.getItem(RELOAD_KEY); } catch (e) { return false; } };
  const setReloaded = (on) => {
    try { on ? sessionStorage.setItem(RELOAD_KEY, "1") : sessionStorage.removeItem(RELOAD_KEY); } catch (e) {}
  };
  const waitControl = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
  async function doRegisterWorker() {
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
    if (navigator.serviceWorker.controller) {
      setReloaded(false);
      return { controlled: true, registration };
    }
    // first visit: the worker claims the page once active (ready resolves
    // on an active worker, controlled page or not)
    const claimed = waitControl(15000);
    const active = await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
    ]);
    const controlled = active ? await Promise.race([claimed, waitControl(2000)]) : await claimed;
    if (controlled) {
      setReloaded(false);
      return { controlled, registration };
    }
    if (!active) return { controlled, registration, reason: "the service worker did not become active" };
    if (!reloaded()) {
      // this load bypassed the worker; a normal reload runs under it
      setReloaded(true);
      location.reload();
      return new Promise(() => {});
    }
    return {
      controlled, registration,
      reason: "this page load bypassed it (a hard reload, or DevTools' \"Bypass for network\"): reload the page normally",
    };
  }

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
  let forced = false; // the URL named the mode
  let health = null;  // what the launcher answered, null on a static host

  /**
   * The launcher's health check: {launcher: true, version, levels (how
   * many level directories), neolemmix: {engine, styles}}, or null when no
   * launcher serves this page. Fetched past every cache, with ?probe so
   * the worker leaves it alone.
   */
  async function fetchHealth(root) {
    try {
      const res = await fetch(root + HEALTH_PATH + "?probe=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return null;
      const h = await res.json();
      return h && h.launcher ? h : null;
    } catch (e) { return null; }
  }

  /**
   * A page's URL carrying the mode flag: the one in force when the URL
   * forced it (so moving between the pages never drops a forced mode), or
   * `m` to switch. Without either, no flag.
   */
  function link(url, m) {
    const u = new URL(url, location.href);
    const want = m || (forced ? mode : null);
    if (want) u.searchParams.set(PARAM, want);
    else u.searchParams.delete(PARAM);
    return u.href;
  }

  /** Store the mode where the worker reads it, and tell the worker. */
  async function setMode(m) {
    mode = m;
    try { await put("settings", { key: "assets", value: m }); } catch (e) {}
    await tellWorker(m);
  }

  /**
   * The mode in force: the URL when it names one, else server when the
   * launcher answers its health check, static otherwise (`root` is the
   * page's path to the repo root). The health check runs either way, so a
   * page knows whether a launcher is there to switch to.
   */
  async function resolveMode(root) {
    const p = (new URLSearchParams(location.search).get(PARAM) || "").toLowerCase();
    forced = p === "static" || p === "server";
    health = await fetchHealth(root);
    const m = forced ? p : health ? "server" : "static";
    await setMode(m);
    return m;
  }

  /** Whether the game has levels to play in the mode in force. */
  async function playable(root) {
    if (mode !== "static") return true;
    try { return await has(INDEX_PATH); } catch (e) { return false; }
  }

  /**
   * What the game needs, in the mode in force: {engine, styles, levels} as
   * booleans - NeoLemmix, the styles package, at least one level. The
   * browser's store answers in static mode; the launcher's health check in
   * server mode, and without a launcher (a plain server, forced) the
   * folders are probed the way setup.html does.
   */
  async function ready(root) {
    const count = (index) => ((index && index.children) || []).reduce((n, c) => n + (c.count || 0), 0);
    if (mode === "static") {
      const [engine, styles, index] = await Promise.all([
        get("units", "engine").catch(() => null),
        get("units", "styles").catch(() => null),
        readText(INDEX_PATH).then(JSON.parse).catch(() => null),
      ]);
      return { engine: !!engine, styles: !!styles, levels: count(index) > 0 };
    }
    if (health) {
      const nx = health.neolemmix || {};
      return { engine: !!nx.engine, styles: !!nx.styles, levels: health.levels > 0 };
    }
    const probe = async (path, json) => {
      try {
        const res = await fetch(root + path + "?probe=" + Date.now(), { method: json ? "GET" : "HEAD", cache: "no-store" });
        return res.ok ? (json ? await res.json() : true) : null;
      } catch (e) { return null; }
    };
    const [engine, styles, index] = await Promise.all([
      probe("neolemmix/gfx/panel/empty_slot.png"),
      probe("neolemmix/styles/index.json", true),
      probe(INDEX_PATH, true),
    ]);
    return { engine: !!engine, styles: !!(styles && styles.count), levels: count(index) > 0 };
  }

  // ---- the release version ------------------------------------------------

  const VERSION_FILE = "version.json";

  /** The version this page was built as: its marker (builder/ stamps it). */
  function pageVersion() {
    const meta = document.querySelector('meta[name="lem3d-version"]');
    return meta ? meta.content : null;
  }

  /**
   * The version on the server against this page's: {page, server, stale}.
   * Fetched past every cache, since a stale page is what a cache gives; a
   * server that does not answer is no news (stale false, server null).
   */
  async function checkVersion(root) {
    const page = pageVersion();
    let server = null;
    try {
      const res = await fetch(root + VERSION_FILE + "?probe=" + Date.now(), { cache: "no-store" });
      if (res.ok) server = String((await res.json()).version || "") || null;
    } catch (e) { server = null; }
    return { page, server, stale: !!(page && server && page !== server) };
  }

  const setupSeen = () => { try { return !!localStorage.getItem(SEEN_KEY); } catch (e) { return false; } };
  const markSetupSeen = () => { try { localStorage.setItem(SEEN_KEY, "1"); } catch (e) {} };

  /**
   * What a page does before touching any asset: settle the mode, register
   * the worker when the mode is static (and tell it the mode), and go to
   * the setup page instead (`setupUrl`, carrying a forced mode) when there
   * is nothing to play. With `need` "game" (the root page) that is whenever
   * NeoLemmix, the styles package or a level is missing (`ready`), every
   * time; otherwise (the classic page) with no levels at all - nothing
   * installed in static mode, none on the launcher in server mode - and
   * the setup page never shown. Resolves {mode, sw} otherwise; never
   * resolves after a redirect.
   */
  async function boot(root, setupUrl, need) {
    const m = await resolveMode(root);
    let sw = { controlled: false, reason: "the worker is registered in static mode only" };
    if (m === "static") {
      sw = await registerWorker();
      if (sw.controlled) await tellWorker(m);
    }
    if (setupUrl) {
      let bare;
      if (need === "game") {
        const r = await ready(root);
        bare = !(r.engine && r.styles && r.levels);
      } else {
        bare = !setupSeen() && (m === "static" ? !(await playable(root)) : !!(health && health.levels === 0));
      }
      if (bare) {
        location.replace(link(setupUrl));
        return new Promise(() => {});
      }
    }
    return { mode: m, sw };
  }

  root.Vfs = {
    DB_NAME, SEEN_KEY, PARAM, INDEX_PATH, HEALTH_PATH, STORE_PREFIXES, MIME, mimeOf,
    registerWorker, boot, resolveMode, setMode, fetchHealth, link,
    VERSION_FILE, pageVersion, checkVersion,
    get mode() { return mode; },
    get forced() { return forced; },
    get health() { return health; },
    playable, ready, setupSeen, markSetupSeen,
    openDb, get, put, remove, getAll,
    putFiles, deletePrefix, deleteUnit, list, levelDirs, has, readText, readTexts, readBlob,
    estimate, persist,
  };
})(typeof window !== "undefined" ? window : globalThis);
