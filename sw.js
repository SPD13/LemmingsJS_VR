"use strict";
/**
 * The service worker of the static asset mode: answers the game's requests
 * under neolemmix/ and levels/ from the browser's IndexedDB (filled by
 * 3d/setup.html, see 3d/js/vfs.js), and lets anything it lacks - or every
 * request, in server mode - go to the network. Registered from the repo
 * root so it covers the folders the 3d/ and root pages share.
 */
const VERSION = "1"; // bump to roll out a change (pages register with updateViaCache: "none")
const DB_NAME = "lem3d-files";
const DB_VERSION = 1;
const PREFIXES = ["neolemmix/", "levels/"];
const SCOPE_PATH = new URL(self.registration.scope).pathname;

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

// ---- the database (the schema vfs.js creates) ----
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "path" }).createIndex("unit", "unit", { unique: false });
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
    req.onblocked = () => { dbPromise = null; reject(new Error("blocked")); };
  });
  return dbPromise;
}
function get(store, key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const r = db.transaction(store, "readonly").objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

// ---- the mode: "static" intercepts, anything else passes through ----
let mode = null;
let modeReady = readMode();
function readMode() {
  return get("settings", "assets").then((rec) => { mode = rec ? rec.value : null; }, () => { mode = null; });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "mode") {
    mode = data.value;
    modeReady = Promise.resolve();
  } else if (data.type === "reread") {
    modeReady = readMode();
  }
  if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true, mode, version: VERSION });
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" && req.method !== "HEAD") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  if (url.searchParams.has("probe")) return; // the page asking the server itself
  let rel;
  try { rel = decodeURIComponent(url.pathname.slice(SCOPE_PATH.length)); } catch (e) { return; }
  if (!PREFIXES.some((p) => rel.startsWith(p))) return;
  event.respondWith(serve(req, rel));
});

async function serve(req, rel) {
  await modeReady;
  if (mode !== "static") return fetch(req);
  let rec = null;
  try { rec = await get("files", rel); } catch (e) { rec = null; }
  if (!rec) return fetch(req);
  const headers = {
    "Content-Type": rec.type || mimeOf(rel),
    "Content-Length": String(rec.size),
    "Cache-Control": "no-store",
    "X-Lem3d-Store": VERSION,
  };
  return new Response(req.method === "HEAD" ? null : rec.blob, { status: 200, headers });
}
