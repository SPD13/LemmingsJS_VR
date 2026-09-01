"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  getStatus: () => ipcRenderer.invoke("get-status"),
  start: () => ipcRenderer.invoke("start"),
  stop: () => ipcRenderer.invoke("stop"),
  setPort: (port) => ipcRenderer.invoke("set-port", port),
  setHttps: (enabled) => ipcRenderer.invoke("set-https", enabled),
  openUrl: (url) => ipcRenderer.invoke("open-url", url),
  onStatus: (cb) => ipcRenderer.on("status", (e, s) => cb(s)),
});
