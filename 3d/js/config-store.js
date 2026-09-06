/**
 * The player's configuration on the server, for the server asset mode.
 *
 * Every setting the pages keep - the controls (hotkeys.js), the
 * preferences (app.js, audio.js, library.js, galleries.js) and the
 * progress (library.js, app.js) - lives in localStorage. In server mode the
 * launcher also keeps them as three JSON files in config/ (the same files
 * the setup page downloads and uploads), so they follow the installation
 * rather than the browser:
 *
 * - at start (`sync`) the files on the server are read and written into
 *   localStorage, taking precedence over what the browser had; a file the
 *   server lacks is seeded from the browser's copy;
 * - from then on every write to one of those localStorage keys is pushed
 *   to the server (`PUT config/<file>`, debounced per file), through a hook
 *   on Storage.prototype.setItem so the writers need not know.
 *
 * In static mode nothing here is active. A server without the endpoint (a
 * plain static server) is left alone after its first refusal.
 */
(function (global) {
  "use strict";

  const DIR = "config/";
  const DEBOUNCE_MS = 250;

  // localStorage keys that are preferences
  const PREFS_KEYS = [
    "lem3d-emboss", "lem3d-smooth", "lem3d-doors", "lem3d-skillbar", "lem3d-flatskills", "lem3d-flat", "lem3d-shadows",
    "lem3d-music", "lem3d-sound", "lem3d-volume", "lem3d-bar", "lem3d-lib-order", "lem3d-lib-path",
    "lem3d-gal-open", "lem3d-favorites",
  ];
  const HOTKEYS_KEY = "lem3d-hotkeys";     // hotkeys.js HotkeyManager
  const CLEARED_KEY = "lem3d-cleared";     // library.js LevelProgress
  const TALISMANS_KEY = "lem3d-talismans"; // app.js, the NeoLemmix talismans earned

  const FILES = {
    controls: { name: "lemmings-3d-controls.json", format: "lemmings-3d-controls", keys: [HOTKEYS_KEY] },
    prefs: { name: "lemmings-3d-preferences.json", format: "lemmings-3d-preferences", keys: PREFS_KEYS },
    progress: { name: "lemmings-3d-progress.json", format: "lemmings-3d-progress", keys: [CLEARED_KEY, TALISMANS_KEY] },
  };
  const KIND_OF_KEY = new Map();
  for (const kind of Object.keys(FILES)) for (const k of FILES[kind].keys) KIND_OF_KEY.set(k, kind);

  const getItem = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const getJSON = (k) => { try { return JSON.parse(getItem(k)) || {}; } catch (e) { return {}; } };

  /**
   * The file's object built from localStorage, or null when the browser
   * holds nothing of that kind (the file's `format` names it).
   */
  function build(kind) {
    const f = FILES[kind];
    if (kind === "controls") {
      const stored = getJSON(HOTKEYS_KEY);
      if (!stored.keys || typeof stored.keys !== "object") return null;
      return { format: f.format, version: stored.version, keys: stored.keys };
    }
    if (kind === "prefs") {
      const values = {};
      let n = 0;
      for (const k of PREFS_KEYS) {
        const v = getItem(k);
        if (v !== null) { values[k] = v; n++; }
      }
      return n ? { format: f.format, version: 1, values } : null;
    }
    if (kind === "progress") {
      const cleared = getJSON(CLEARED_KEY), talismans = getJSON(TALISMANS_KEY);
      if (!Object.keys(cleared).length && !Object.keys(talismans).length) return null;
      return { format: f.format, version: 1, cleared, talismans };
    }
    return null;
  }

  /**
   * A file's object written into localStorage, replacing what was there:
   * the server's copy wins. Throws on a file of the wrong kind. Preferences
   * the file does not name are left as they are.
   */
  function apply(kind, data) {
    const f = FILES[kind];
    if (!data || typeof data !== "object" || (data.format && data.format !== f.format)) throw new Error("not a " + kind + " file");
    applying++;
    try {
      if (kind === "controls") {
        if (!data.keys || typeof data.keys !== "object") throw new Error("not a controls file");
        // `vr` says the file carried the controllers; without it hotkeys.js
        // puts the default controller setup back rather than leaving them dead
        const vr = Object.keys(data.keys).some((code) => code.startsWith("Vr"));
        localStorage.setItem(HOTKEYS_KEY, JSON.stringify({ version: data.version, vr, keys: data.keys }));
      } else if (kind === "prefs") {
        if (!data.values || typeof data.values !== "object") throw new Error("not a preferences file");
        for (const k of PREFS_KEYS) if (typeof data.values[k] === "string") localStorage.setItem(k, data.values[k]);
      } else if (kind === "progress") {
        if (!data.cleared || typeof data.cleared !== "object") throw new Error("not a progress file");
        localStorage.setItem(CLEARED_KEY, JSON.stringify(data.cleared));
        localStorage.setItem(TALISMANS_KEY, JSON.stringify(data.talismans && typeof data.talismans === "object" ? data.talismans : {}));
      }
    } finally { applying--; }
  }

  // ---- the server ----------------------------------------------------------

  let root = "";
  let active = false;    // server mode: the files are read and written there
  let writable = true;   // until the server refuses a PUT
  let applying = 0;      // writes of our own, not to be pushed back
  const timers = {};
  const pending = new Set();

  const fileUrl = (kind) => root + DIR + FILES[kind].name;

  /** The file's text as the server has it, or null (missing, or no server). */
  async function serverFile(kind) {
    try {
      const res = await fetch(fileUrl(kind) + "?probe=" + Date.now(), { cache: "no-store" });
      return res.ok ? await res.text() : null;
    } catch (e) { return null; }
  }

  /** Write the file built from localStorage to the server (nothing when the browser holds nothing). */
  async function push(kind, keepalive) {
    pending.delete(kind);
    if (!active || !writable) return false;
    const data = build(kind);
    if (!data) return false;
    try {
      const res = await fetch(fileUrl(kind), {
        method: "PUT", cache: "no-store", keepalive: !!keepalive,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        writable = false;
        console.warn("[config] the server does not take " + FILES[kind].name + " (HTTP " + res.status + "): settings stay in this browser only");
      }
      return res.ok;
    } catch (e) {
      console.warn("[config] " + FILES[kind].name + " not saved on the server: " + e.message);
      return false;
    }
  }

  /** A push soon, one per file however many keys changed. */
  function schedule(kind) {
    pending.add(kind);
    clearTimeout(timers[kind]);
    timers[kind] = setTimeout(() => push(kind), DEBOUNCE_MS);
  }

  /** Every pending push now (the page is going away: keepalive requests). */
  function flush() {
    for (const kind of Array.from(pending)) {
      clearTimeout(timers[kind]);
      push(kind, true);
    }
  }

  let hooked = false;
  function hook() {
    if (hooked || typeof Storage === "undefined") return;
    hooked = true;
    const proto = Storage.prototype;
    const setItem = proto.setItem, removeItem = proto.removeItem;
    const touched = (store, k) => {
      if (!active || applying || store !== global.localStorage) return;
      const kind = KIND_OF_KEY.get(k);
      if (kind) schedule(kind);
    };
    proto.setItem = function (k, v) { setItem.call(this, k, v); touched(this, k); };
    proto.removeItem = function (k) { removeItem.call(this, k); touched(this, k); };
    global.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  }

  /**
   * Settle the configuration for `mode` (`root` is the page's path to the
   * repo root): in server mode read the three files, apply them over the
   * browser's copy, seed the ones the server lacks from it, and push every
   * later change; in static mode leave the browser to itself. Resolves
   * {pulled, seeded}: the kinds read from the server and written to it.
   */
  async function sync(mode, pageRoot) {
    root = pageRoot || "";
    active = mode === "server";
    const out = { pulled: [], seeded: [] };
    if (!active) return out;
    writable = true;
    hook();
    await Promise.all(Object.keys(FILES).map(async (kind) => {
      const text = await serverFile(kind);
      if (text !== null) {
        try {
          const data = JSON.parse(text);
          apply(kind, data);
          out.pulled.push(kind);
          // preferences the browser has and the file lacks: the file completed
          if (kind === "prefs" && PREFS_KEYS.some((k) => getItem(k) !== null && typeof data.values[k] !== "string")) push(kind);
        } catch (e) { console.warn("[config] " + FILES[kind].name + " on the server ignored: " + e.message); }
      } else if (build(kind) && await push(kind)) {
        out.seeded.push(kind);
      }
    }));
    return out;
  }

  global.ConfigStore = {
    FILES, PREFS_KEYS, HOTKEYS_KEY, CLEARED_KEY, TALISMANS_KEY,
    build, apply, sync, serverFile, push, flush,
    get active() { return active && writable; },
  };
})(window);
