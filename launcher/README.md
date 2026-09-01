# Lemmings VR Launcher

Small Electron app that controls the dev server for this repo.

```sh
cd launcher
npm install
npm start
```

- **Server tab** — start/stop the server and see its status. When running, it
  shows the internal URL (`http://localhost:<port>/3d/`) and the external URL
  (this machine's LAN IPv4) — the address a headset or another device on the
  same network would use. Click a URL to open it in the browser.
- **Setup tab** — configure the port (1024–65535, default 8123), persisted in
  the app's user-data folder. If the server is running when you save, it
  restarts on the new port automatically.

The server itself is `server.js`: a dependency-free static file server for
the repo root (the game at `/`, the 3D/VR app at `/3d/`), started in-process
by the Electron main process — no `http-server` child process to manage. It
listens on all interfaces so headsets on the LAN can reach it; note WebXR on
a headset still needs a secure context (see `3d/README.md` for the
`adb reverse` route).
