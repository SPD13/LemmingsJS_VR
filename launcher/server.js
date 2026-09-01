"use strict";
/**
 * Minimal static file server for the game repo. Kept free of Electron
 * imports so it can be tested standalone with plain node.
 */

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");

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
