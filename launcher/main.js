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
const { createStaticServer } = require("./server");

const WEB_ROOT = path.join(__dirname, "..");
const DEFAULT_PORT = 8123;
const PORT_MIN = 1024;
const PORT_MAX = 65535;

let win = null;
let server = null;
let config = { port: DEFAULT_PORT };
let lastError = null;

function configPath() {
  return path.join(app.getPath("userData"), "launcher-config.json");
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const port = parseInt(raw.port, 10);
    if (port >= PORT_MIN && port <= PORT_MAX) config.port = port;
  } catch (e) { /* first run: defaults */ }
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
  return {
    running: !!server,
    port: config.port,
    internalUrl: "http://localhost:" + config.port + "/3d/",
    externalUrl: ip ? "http://" + ip + ":" + config.port + "/3d/" : null,
    error: lastError,
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send("status", status());
}

async function startServer() {
  if (server) return;
  lastError = null;
  try {
    server = await createStaticServer(WEB_ROOT, config.port);
  } catch (e) {
    server = null;
    lastError = e.code === "EADDRINUSE"
      ? "port " + config.port + " is already in use"
      : e.message;
  }
  broadcast();
}

async function stopServer() {
  if (!server) return;
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
