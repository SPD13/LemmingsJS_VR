# config/

The player's configuration when the game runs in **server mode** (the
launcher, or `node launcher/server.js`): the server keeps these three files
here, and they take precedence over the browser's own copy when a page loads.

- `lemmings-3d-controls.json` — keyboard, mouse and VR controller bindings
- `lemmings-3d-preferences.json` — 3D effects, the 2D/3D default, sound and
  music, the VR bar's place, the library's order and place
- `lemmings-3d-progress.json` — the levels cleared, best times, most
  lemmings saved, talismans

The game writes them itself (`PUT /config/<name>.json`) whenever a setting
changes, and the setup page's download / upload buttons read and write them
in server mode. Only the three names above are accepted. Nothing in this
folder is committed except this file.
