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

// the level directories the setup page writes in server mode: a name
// without slashes or a leading dot, then any path below it; files up to
// MAX_UPLOAD bytes each
const LEVEL_DIR_RE = /^\/levels\/([^\/.][^\/]*)\/?$/;
const LEVEL_FILE_RE = /^\/levels\/([^\/.][^\/]*\/.+[^\/])$/;
const MAX_UPLOAD = 200e6;

/** Every folder under `levelsRoot`: [{dir, files, bytes, mtime}], the files counted through the folder. */
function levelDirs(levelsRoot) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(levelsRoot); } catch (e) { return out; }
  for (const dir of names.sort()) {
    if (dir.startsWith(".")) continue;
    const full = path.join(levelsRoot, dir);
    let stat;
    try { stat = fs.statSync(full); } catch (e) { continue; }
    if (!stat.isDirectory()) continue;
    let files = 0, bytes = 0;
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else { files++; bytes += st.size; }
      }
    };
    try { walk(full); } catch (e) { /* unreadable: counted so far */ }
    out.push({ dir, files, bytes, mtime: stat.mtimeMs });
  }
  return out;
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

        // the setup page installs a level pack on the server: one PUT per
        // file under levels/<dir>/, and DELETE levels/<dir> removes a
        // directory. Nothing above levels/ is reachable, and no dot names.
        const levelFile = req.method === "PUT" && LEVEL_FILE_RE.exec(urlPath);
        if (levelFile) {
          const savePath = path.normalize(path.join(absRoot, "levels", levelFile[1]));
          if (!savePath.startsWith(path.join(absRoot, "levels") + path.sep) || /(^|\/)\.\.?(\/|$)/.test(levelFile[1])) {
            res.writeHead(403);
            res.end("forbidden");
            return;
          }
          fs.mkdirSync(path.dirname(savePath), { recursive: true });
          let size = 0;
          const out = fs.createWriteStream(savePath);
          req.on("data", (chunk) => { size += chunk.length; if (size > MAX_UPLOAD) req.destroy(); });
          req.pipe(out);
          out.on("finish", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true}');
          });
          out.on("error", () => { res.writeHead(500); res.end("not written"); });
          return;
        }
        const levelDir = req.method === "DELETE" && LEVEL_DIR_RE.exec(urlPath);
        if (levelDir) {
          const dir = path.join(absRoot, "levels", levelDir[1]);
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
