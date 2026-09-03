# Lemmings - Lemmings / Oh no! More Lemmings

Lemmings reimplementation written in HTML5 / JavaScript

## Play Online

- Browser: https://lemmingsjs.oklemenz.de
- Keyboard / Mouse Controls

## Play Mobile

- Browser: https://lemmingsjs.oklemenz.de
  - Use Landscape Mode (Single Tab, Disable Landscape Tab Bar in Browser Settings)
- Add to Home Screen to start as Fullscreen App
- Touch Controls (tap/drag area on screen):

## Play GitHub Version

- Browser: https://oklemenz.github.io/LemmingsJS

## Play Locally

- Install [Node.js](https://nodejs.org)
- Clone: `https://github.com/oklemenz/LemmingsJS.git`
- Terminal:
  - `npm install`
  - `npm start`
- Browser: `localhost:8080`

## Options

Url parameters are leveraged to save game state automatically (shortcut in brackets):

- `version (v)`:
  - 1: Lemmings (default)
  - 2: Oh no! More Lemmings 
- `difficulty (d)`: Difficulty 1-5 (default: 1)
- `level (l)`: Level 1-30 (default: 1)
- `speed (s)`: Control execution speed >0-10 (default: 1)
- `cheat (c)`: Enable cheat mode (99 for all actions) (default: false)

## Versions

- Lemmings: https://lemmingsjs.oklemenz.de?version=0
- Oh no! More Lemmings: https://lemmingsjs.oklemenz.de?version=1

## Levels and assets

Git ships the engine only. The game data - the level packs under `levels/`
and NeoLemmix's own files under `neolemmix/` (styles, panel graphics, masks,
sound effects, music) - comes from elsewhere, in one of two **asset modes**
the 3D page chooses with the URL (`?assets=static` or `?assets=server`,
remembered afterwards; without either it asks the server for
`levels/index.json` and takes *server* when there is one):

- **static** - the files live in the browser's own storage (IndexedDB),
  installed from the **setup page** (`3d/setup.html`, the *Setup* button on
  the right edge of the 3D page; the page also opens by itself the first
  time nothing is installed). A service worker at the repo root (`sw.js`)
  serves them to the game, so the site can be hosted with nothing but the
  engine - GitHub Pages, say. The setup page shows what is installed (a
  green or red dot for NeoLemmix and for the styles package, the list of
  level directories with a delete button each), and installs:
  - NeoLemmix and the styles package from https://www.neolemmix.com -
    which does not send the CORS headers a page needs to download them
    itself, so the button saves the official zip through the browser and a
    second one unpacks the zip you saved (or drop it on the row);
  - the Lemmings Plus packs the same way, the two classic games in one click
    from the LemmingsJS repository on GitHub (through jsDelivr), any other
    pack as a zip or an uploaded folder.
  Everything is kept per browser and per site address (`localhost` and
  `127.0.0.1` are two sites), and goes with the site's data if the browser
  clears it; the page asks for persistent storage. Service workers only run
  on `localhost` or over HTTPS (the launcher serves HTTPS, so a headset on
  the LAN works); a hard reload bypasses the worker for that one load.
  The same page downloads and uploads the player's configuration as JSON
  files: the controller bindings, the preferences (everything the 3D page
  keeps in localStorage) and the level progress (clears, best times, most
  lemmings saved, talismans - merged on upload, never losing a clear).
- **server** - today's layout: the files are folders on the web server.
  - **NeoLemmix packs** (`.nxlv` levels): copy the pack folder into
    `levels/` as downloaded, e.g. `levels/LemmingsPlus_All_20201114/`. The
    Lemmings Plus packs by namida are published on the NeoLemmix site and the
    Lemmings Forums (https://www.neolemmix.com, https://www.lemmingsforums.net,
    "NeoLemmix Level Packs"); the classic games (`levels/lemmings`,
    `levels/lemmings_ohNo`, registered in `config.json`) are the folders of
    https://github.com/oklemenz/LemmingsJS.
  - **NeoLemmix itself**: the `neolemmix/` folder is laid out like a
    NeoLemmix install, so the NeoLemmix zip and the styles package from
    https://www.neolemmix.com/?page=neolemmix unpack straight into it, giving
    `neolemmix/styles/`, `neolemmix/gfx/`, `neolemmix/sound/` and
    `neolemmix/music/`. See `neolemmix/README.md`.
  `.gitignore` excludes everything under `levels/` and `neolemmix/` but their
  READMEs.

Tracker music (`.it/.xm/.mod`) plays through libopenmpt via chiptune3,
vendored under `lemmix/vendor/chiptune3/` (MIT, libopenmpt BSD); the setup
page unpacks zips with fflate, vendored as `3d/lib/fflate.min.js` (MIT).

The level browser reads `levels/index.json`, the sprite galleries
(`3d/galleries.html`) `neolemmix/styles/index.json`. In static mode the
setup page writes both into the browser's storage after every change. On
disk, regenerate them after adding or removing a pack or unpacking the styles:

```
node tools/levels-index.js
node tools/styles-index.js
```

The Electron launcher (`launcher/`) serves both indexes live from the
folders, so with it no regeneration step is needed; it is also what saves the
tagging done in the piece editor and the galleries page (`3d/profiles/`).
`node launcher/server.js [port]` runs the same server from a terminal without
Electron, over plain HTTP.

## Credits

- https://github.com/tomsoftware
