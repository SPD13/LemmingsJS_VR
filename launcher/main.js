"use strict";
/**
 * Launcher main process: owns the static server (serving the repo root, one
 * level above this folder), persists the configured port, and reports
 * status + internal/external URLs to the renderer.
 */

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
/**
 * The server module, read from disk at every start rather than once at
 * launch: a stop/start from the window then serves the code as it is now
 * (its routes change with the game), with no need to quit the app.
 */
function loadServer() {
  for (const m of ["./server", "../tools/levels-index", "../tools/styles-index"]) {
    delete require.cache[require.resolve(m)];
  }
  return require("./server");
}
const { reclaimPort } = require("./port");
const selfsigned = require("selfsigned");

const WEB_ROOT = path.join(__dirname, "..");
const DEFAULT_PORT = 8123;
const PORT_MIN = 1024;
const PORT_MAX = 65535;

let win = null;
let server = null;
let config = { port: DEFAULT_PORT, https: true };
let lastError = null;
let notice = null;   // something worth saying that is not a failure

function configPath() {
  return path.join(app.getPath("userData"), "launcher-config.json");
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const port = parseInt(raw.port, 10);
    if (port >= PORT_MIN && port <= PORT_MAX) config.port = port;
    if (typeof raw.https === "boolean") config.https = raw.https;
  } catch (e) { /* first run: defaults */ }
}

/**
 * Self-signed TLS cert with localhost + the current LAN IP as subject alt
 * names, cached in the user-data folder; regenerated if the LAN IP changes.
 * Browsers warn once (self-signed), but after accepting, the origin counts
 * as secure and WebXR works.
 */
async function ensureCert() {
  const dir = app.getPath("userData");
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  const metaPath = path.join(dir, "cert-meta.json");
  const ip = externalIPv4();
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (!ip || (meta.ips || []).includes(ip)) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }
  } catch (e) { /* no cert yet, or unreadable: regenerate */ }
  const ips = ["127.0.0.1"];
  if (ip) ips.push(ip);
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "lemmings-vr-launcher" }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: false },
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            ...ips.map((v) => ({ type: 7, ip: v })),
          ],
        },
      ],
    }
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(metaPath, JSON.stringify({ ips }) + "\n");
  return { key: pems.private, cert: pems.cert };
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
  } catch (e) {
    console.error("could not save config:", e);
  }
}

/** First non-internal IPv4 address (the LAN IP a headset would use). */
function externalIPv4() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

function status() {
  const ip = externalIPv4();
  const scheme = config.https ? "https" : "http";
  return {
    running: !!server,
    port: config.port,
    https: config.https,
    internalUrl: scheme + "://localhost:" + config.port + "/",
    externalUrl: ip ? scheme + "://" + ip + ":" + config.port + "/" : null,
    error: lastError,
    notice,
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send("status", status());
}

async function startServer() {
  if (server) return;
  lastError = null;
  notice = null;
  let tls = null;
  try {
    tls = config.https ? await ensureCert() : null;
    const { createStaticServer } = loadServer();
    server = await createStaticServer(WEB_ROOT, config.port, tls);
  } catch (e) {
    server = null;
    if (e.code !== "EADDRINUSE") {
      lastError = e.message;
      broadcast();
      return;
    }
    // Ours from a previous run, most likely: a crash or a hard quit leaves the
    // server holding the port, and the only way out was a terminal. Clear it
    // and start again - but only if it really is ours. Anything else on the
    // port is left strictly alone and named in the error.
    const taken = await reclaimPort(config.port, __dirname);
    if (taken.killed.length > 0 && taken.free) {
      try {
        server = await loadServer().createStaticServer(WEB_ROOT, config.port, tls);
        notice = "port " + config.port + " was still held by a previous " +
          "launcher (pid " + taken.killed.join(", ") + ") — stopped it and " +
          "started fresh";
      } catch (e2) {
        server = null;
        lastError = e2.message;
      }
    } else if (taken.skipped.length > 0) {
      const other = taken.skipped[0];
      lastError = "port " + config.port + " is in use by " + other.name +
        " (pid " + other.pid + "), which is not this launcher — left alone";
    } else {
      lastError = "port " + config.port + " is already in use";
    }
  }
  broadcast();
}

async function stopServer() {
  if (!server) return;
  notice = null;
  const s = server;
  server = null;
  await s.close();
  broadcast();
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 420,
    resizable: false,
    title: "Lemmings VR Launcher",
    backgroundColor: "#10141c",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  loadConfig();

  ipcMain.handle("get-status", () => status());
  ipcMain.handle("start", async () => { await startServer(); return status(); });
  ipcMain.handle("stop", async () => { await stopServer(); return status(); });
  ipcMain.handle("set-port", async (e, portRaw) => {
    const port = parseInt(portRaw, 10);
    if (!(port >= PORT_MIN && port <= PORT_MAX)) {
      return { ...status(), error: "port must be between " + PORT_MIN + " and " + PORT_MAX };
    }
    const wasRunning = !!server;
    if (wasRunning) await stopServer();
    config.port = port;
    saveConfig();
    lastError = null;
    if (wasRunning) await startServer(); // apply the new port immediately
    broadcast();
    return status();
  });
  ipcMain.handle("set-https", async (e, enabled) => {
    const wasRunning = !!server;
    if (wasRunning) await stopServer();
    config.https = !!enabled;
    saveConfig();
    lastError = null;
    if (wasRunning) await startServer(); // apply the scheme immediately
    broadcast();
    return status();
  });
  ipcMain.handle("open-url", (e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  await stopServer();
  app.quit();
});

// every quit path (Cmd+Q, Dock, shutdown) stops the server before exiting
app.on("will-quit", (e) => {
  if (server) {
    e.preventDefault();
    stopServer().then(() => app.quit());
  }
});
