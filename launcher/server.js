"use strict";
/**
 * Minimal static file server for the game repo. Kept free of Electron
 * imports so it can be tested standalone with plain node.
 */

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { buildIndex } = require("../tools/levels-index");
const { buildStylesIndex } = require("../tools/styles-index");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".dat": "application/octet-stream",
  // NeoLemmix level packs and assets
  ".nxlv": "text/plain; charset=utf-8",
  ".nxmi": "text/plain; charset=utf-8",
  ".nxmo": "text/plain; charset=utf-8",
  ".nxmt": "text/plain; charset=utf-8",
  ".nxtm": "text/plain; charset=utf-8",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".it": "application/octet-stream",
  ".xm": "application/octet-stream",
  ".mod": "application/octet-stream",
};

// the configuration files the game keeps on the server (config/README.md)
const CONFIG_FILE_RE = /^\/config\/lemmings-3d-(controls|preferences|progress)\.json$/;

// what the setup page writes in server mode: a level directory (a name
// without slashes or a leading dot) and NeoLemmix's own folders, any path
// below them; a batch of files up to MAX_BATCH bytes in one request
const NX_FOLDERS = ["gfx", "data", "music", "sound", "styles"];
const LEVEL_DIR_RE = /^\/(levels\/[^\/.][^\/]*)\/?$/;
const NX_DIR_RE = /^\/(neolemmix\/(?:gfx|data|music|sound|styles))\/?$/;
const UPLOAD_RE = /^(levels\/[^\/.][^\/]*|neolemmix\/(?:gfx|data|music|sound|styles))\/[^\/].*[^\/]$/;
const MAX_BATCH = 500e6;

/** The release version in version.json, or null. */
function readVersion(absRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(absRoot, "version.json"), "utf8")).version || null; }
  catch (e) { return null; }
}

/** A folder's {files, bytes, mtime}, the files counted through its subfolders; null when it is not one. */
function folderStat(dir) {
  let stat;
  try { stat = fs.statSync(dir); } catch (e) { return null; }
  if (!stat.isDirectory()) return null;
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else { files++; bytes += st.size; }
    }
  };
  try { walk(dir); } catch (e) { /* unreadable: counted so far */ }
  return { files, bytes, mtime: stat.mtimeMs };
}

/** Every folder under `levelsRoot`: [{dir, files, bytes, mtime}]. */
function levelDirs(levelsRoot) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(levelsRoot); } catch (e) { return out; }
  for (const dir of names.sort()) {
    if (dir.startsWith(".")) continue;
    const st = folderStat(path.join(levelsRoot, dir));
    if (st) out.push({ dir, ...st });
  }
  return out;
}

/**
 * A batch of files to write, as the setup page sends it: for each file a
 * little-endian u32 with the length of its repo path, the path in UTF-8,
 * a u32 with the length of its bytes, the bytes. Every path must match
 * UPLOAD_RE and stay under `absRoot`; the whole batch is checked before
 * anything is written. Answers {"ok":true,"files":n}, or 400 with why.
 */
function readBatch(req, res, absRoot) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BATCH) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const buf = Buffer.concat(chunks);
      const writes = [];
      let p = 0;
      while (p < buf.length) {
        if (p + 4 > buf.length) throw new Error("truncated batch");
        const nameLen = buf.readUInt32LE(p);
        p += 4;
        const name = buf.toString("utf8", p, p + nameLen);
        p += nameLen;
        if (p + 4 > buf.length) throw new Error("truncated batch");
        const len = buf.readUInt32LE(p);
        p += 4;
        if (p + len > buf.length) throw new Error("truncated batch");
        const full = path.normalize(path.join(absRoot, name));
        if (!UPLOAD_RE.test(name) || /(^|\/)\.\.?(\/|$)/.test(name) || !full.startsWith(absRoot + path.sep)) {
          throw new Error("path not allowed: " + name);
        }
        writes.push([full, buf.subarray(p, p + len)]);
        p += len;
      }
      for (const [full, data] of writes) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, data);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, files: writes.length }));
    } catch (e) {
      res.writeHead(400);
      res.end(e.message);
    }
  });
}

/**
 * Read a request's body as JSON (at most 1 MB), hand its pretty-printed
 * text to `write`, and answer {"ok":true} - or 400 when it is not JSON.
 */
function readJsonBody(req, res, write) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e6) req.destroy();
  });
  req.on("end", () => {
    try {
      const json = JSON.stringify(JSON.parse(body), null, 2) + "\n";
      write(json);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400);
      res.end("invalid JSON");
    }
  });
}

/**
 * Serve `root` on `port` (all interfaces). Pass `tls` ({key, cert} PEMs) to
 * serve HTTPS — required for WebXR on other devices, which refuse insecure
 * origins. Resolves to {port, close()} once listening; rejects on listen
 * errors (e.g. the port is already in use).
 */
function createStaticServer(root, port, tls = null) {
  const absRoot = path.resolve(root);
  return new Promise((resolve, reject) => {
    const handler = (req, res) => {
      try {
        const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

        // the player's configuration in server mode: the game page and the
        // setup page PUT the three files named in config/README.md here,
        // and read them back with a plain GET like any other file. Only
        // those names are writable, and only under config/.
        if ((req.method === "PUT" || req.method === "POST") && CONFIG_FILE_RE.test(urlPath)) {
          const savePath = path.join(absRoot, "config", path.basename(urlPath));
          readJsonBody(req, res, (json) => {
            fs.mkdirSync(path.dirname(savePath), { recursive: true });
            fs.writeFileSync(savePath, json);
          });
          return;
        }

        // the level directories on disk, for the setup page in server mode:
        // [{dir, files, bytes, mtime}] for every folder under levels/
        if (req.method === "GET" && /^\/levels\/dirs\.json$/.test(urlPath)) {
          const json = JSON.stringify(levelDirs(path.join(absRoot, "levels")));
          res.writeHead(200, { "Content-Type": MIME[".json"], "Content-Length": Buffer.byteLength(json), "Cache-Control": "no-store" });
          res.end(json);
          return;
        }

        // the health check: a page served by the launcher takes server mode
        // when this answers (vfs.js), and goes to the setup page when no
        // level directory is there yet
        if ((req.method === "GET" || req.method === "HEAD") && /^\/health\.json$/.test(urlPath)) {
          const json = JSON.stringify({
            launcher: true, version: readVersion(absRoot),
            levels: levelDirs(path.join(absRoot, "levels")).length,
            neolemmix: {
              engine: !!folderStat(path.join(absRoot, "neolemmix", "gfx")),
              styles: !!folderStat(path.join(absRoot, "neolemmix", "styles")),
            },
          });
          res.writeHead(200, { "Content-Type": MIME[".json"], "Content-Length": Buffer.byteLength(json), "Cache-Control": "no-store" });
          res.end(req.method === "HEAD" ? undefined : json);
          return;
        }

        // NeoLemmix on disk, for the setup page in server mode: each of
        // its folders with file count, size and date (null when missing)
        if (req.method === "GET" && /^\/neolemmix\/state\.json$/.test(urlPath)) {
          const state = {};
          for (const f of NX_FOLDERS) state[f] = folderStat(path.join(absRoot, "neolemmix", f));
          const json = JSON.stringify(state);
          res.writeHead(200, { "Content-Type": MIME[".json"], "Content-Length": Buffer.byteLength(json), "Cache-Control": "no-store" });
          res.end(json);
          return;
        }

        // the setup page installs on the server: a batch of files under
        // levels/<dir>/ or neolemmix/<folder>/ in one POST (readBatch says
        // the format), and DELETE levels/<dir> or neolemmix/<folder>
        // removes a directory. Nothing else is reachable, and no dot names.
        if (req.method === "POST" && urlPath === "/upload") {
          readBatch(req, res, absRoot);
          return;
        }
        const rmDir = req.method === "DELETE" && (LEVEL_DIR_RE.exec(urlPath) || NX_DIR_RE.exec(urlPath));
        if (rmDir) {
          const dir = path.join(absRoot, rmDir[1]);
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            res.writeHead(404);
            res.end("no such directory");
            return;
          }
          fs.rmSync(dir, { recursive: true, force: true });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
          return;
        }

        // profile save endpoint: the piece editor and the galleries page
        // POST a depth profile here - one file per DOS tileset
        // (<pack>-g<set>.json) or per NeoLemmix style folder (nx-<style>.json)
        // - so it lands in 3d/profiles/ and loads with the next level. The
        // strict path suffix (any nesting depth, so serving a parent folder
        // still works) is the only writable location.
        if ((req.method === "POST" || req.method === "PUT") &&
            /\/3d\/profiles\/([a-z0-9]+-g\d+|nx-[a-z0-9_]+)\.json$/.test(urlPath)) {
          const savePath = path.normalize(path.join(absRoot, urlPath));
          if (!savePath.startsWith(absRoot + path.sep)) {
            res.writeHead(403);
            res.end("forbidden");
            return;
          }
          readJsonBody(req, res, (json) => fs.writeFileSync(savePath, json));
          return;
        }

        // the level browser's tree, built from the folders as they are now,
        // so a pack dropped into levels/ shows up without a rebuild step
        if (req.method === "GET" && /^\/levels\/index\.json$/.test(urlPath)) {
          const json = JSON.stringify(buildIndex(absRoot));
          res.writeHead(200, {
            "Content-Type": MIME[".json"],
            "Content-Length": Buffer.byteLength(json),
            "Cache-Control": "no-cache",
          });
          res.end(json);
          return;
        }

        // the sprite galleries: every style's terrain pieces, read from the
        // style folders as they are now (tools/styles-index.js writes the
        // same file for static hosting)
        if (req.method === "GET" && /^\/neolemmix\/styles\/index\.json$/.test(urlPath)) {
          const json = JSON.stringify(buildStylesIndex(absRoot));
          res.writeHead(200, {
            "Content-Type": MIME[".json"],
            "Content-Length": Buffer.byteLength(json),
            "Cache-Control": "no-cache",
          });
          res.end(json);
          return;
        }

        let filePath = path.normalize(path.join(absRoot, urlPath));
        if (filePath !== absRoot && !filePath.startsWith(absRoot + path.sep)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        let stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          filePath = path.join(filePath, "index.html");
          stat = fs.statSync(filePath);
        }
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
          "Content-Length": stat.size,
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(filePath).pipe(res);
      } catch (e) {
        res.writeHead(404);
        res.end("not found");
      }
    };
    const srv = tls ? https.createServer(tls, handler) : http.createServer(handler);
    srv.on("error", reject);
    srv.listen(port, "0.0.0.0", () => {
      srv.removeListener("error", reject);
      resolve({
        port: srv.address().port, // the real one when 0 asked for any free port
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

// `node launcher/server.js [port]`: the same server without Electron, plain
// HTTP, for tagging sessions and checks from a terminal (default port 8123).
if (require.main === module) {
  const port = parseInt(process.argv[2], 10) || 8123;
  createStaticServer(path.join(__dirname, ".."), port).then((srv) => {
    console.log("serving on http://localhost:" + srv.port + "/  (ctrl-c stops it)");
  }).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { createStaticServer };
