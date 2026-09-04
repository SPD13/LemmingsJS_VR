# Lemmings VR Launcher

Small Electron app that controls the dev server for this repo.

```sh
cd launcher
npm install
npm start
```

- **Server tab** — start/stop the server and see its status. If the port is
  still held by a previous run of this launcher — a crash, a hard quit, an
  Electron that never got its `will-quit` — that stale process is stopped and
  the server starts anyway, with a line saying which pid was cleared. Only
  this program is ever killed: anything else on the port is named in an error
  and left strictly alone (`port.js` decides, by what a process is *running*,
  not where it was started). When running, it
  shows the internal URL (`http://localhost:<port>/`) and the external URL
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
(the 3D/VR app at `/`, the classic 2D page at `/classic.html`), started in-process by the
Electron main process — no `http-server` child process to manage. It listens
on all interfaces so headsets and other machines on the LAN can reach it.
`node launcher/server.js [port]` runs it from a terminal without Electron,
over plain HTTP (default port 8123).

Besides the files it serves three things of its own:

- `GET /levels/index.json` — the level browser's tree, built from `levels/`
  as it is now (`tools/levels-index.js`).
- `GET /neolemmix/styles/index.json` — the sprite galleries' list of every
  NeoLemmix style's terrain pieces, built from `neolemmix/styles/`
  (`tools/styles-index.js`).
- `POST /3d/profiles/<pack>-g<set>.json` and `POST /3d/profiles/nx-<style>.json`
  — the depth profile of a sprite gallery, written by the 3D page's piece
  editor and its galleries page. Only those names are writable; the reply
  is `{"ok":true}` once the file is on disk.
- `GET /health.json` — `{"launcher":true, "version", "levels", "neolemmix":
  {"engine","styles"}}`: the page takes server mode when this answers
  (`?assets=` in the URL overrides), and goes to the setup page first when
  `levels` is 0.
- `GET /levels/dirs.json`, `GET /neolemmix/state.json`, `POST /upload`,
  `DELETE /levels/<dir>`, `DELETE /neolemmix/<folder>` — the setup page in
  server mode: the level directories on disk with their file count and
  size, NeoLemmix's own folders (`gfx data music sound styles`) likewise, a
  batch of files written under `levels/<dir>/` or `neolemmix/<folder>/`
  (the page unpacks the zip, or reads the folder or GitHub, and sends the
  files a couple of hundred at a time: for each, a little-endian u32 path
  length, the path, a u32 byte length, the bytes), a directory removed.
  Nothing else is reachable, and no name starting with a dot.
- `PUT /config/lemmings-3d-controls.json`, `…-preferences.json`,
  `…-progress.json` — the player's configuration in server mode: the game
  page writes them whenever a setting, a binding or the progress changes,
  and reads them back at start (a plain `GET`), where they take precedence
  over the browser's own copy. The setup page's download / upload buttons
  work on these files in server mode. Only those three names are accepted;
  `config/README.md` says more. The folder is in git, its files are not.
