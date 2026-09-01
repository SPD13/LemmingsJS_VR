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
- **Setup tab** — configure the port (1024–65535, default 8123) and toggle
  HTTPS (on by default), persisted in the app's user-data folder. Changes
  apply immediately; a running server restarts.

HTTPS uses a self-signed certificate generated on first start with
`localhost` and this machine's LAN IP as subject alt names (cached in the
user-data folder, regenerated if the LAN IP changes). Another device opening
the external URL sees a certificate warning once — Advanced → proceed — after
which the origin counts as secure and WebXR/VR works from that device.

The server itself is `server.js`: a static file server for the repo root
(the game at `/`, the 3D/VR app at `/3d/`), started in-process by the
Electron main process — no `http-server` child process to manage. It listens
on all interfaces so headsets and other machines on the LAN can reach it.
