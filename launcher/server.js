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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

        // profile save endpoint: the piece editor POSTs its depth profile
        // here so it lands in 3d/profiles/ and auto-loads on the next game
        // load. The strict path suffix (any nesting depth, so serving a
        // parent folder still works) is the only writable location.
        if ((req.method === "POST" || req.method === "PUT") &&
            /\/3d\/profiles\/[a-z0-9]+-g\d+\.json$/.test(urlPath)) {
          const savePath = path.normalize(path.join(absRoot, urlPath));
          if (!savePath.startsWith(absRoot + path.sep)) {
            res.writeHead(403);
            res.end("forbidden");
            return;
          }
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1e6) req.destroy();
          });
          req.on("end", () => {
            try {
              const json = JSON.stringify(JSON.parse(body), null, 2) + "\n";
              fs.writeFileSync(savePath, json);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end('{"ok":true}');
            } catch (e) {
              res.writeHead(400);
              res.end("invalid JSON");
            }
          });
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
        port,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

module.exports = { createStaticServer };
