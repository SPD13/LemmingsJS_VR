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

Levels live in `levels/`, one subdirectory per level pack. The two classic
games (`levels/lemmings`, `levels/lemmings_ohNo`) are committed and registered
in `config.json` (the `path` of each entry). Every other pack is a drop-in and
is **not** committed: `.gitignore` excludes everything else under `levels/`.

- **NeoLemmix packs** (`.nxlv` levels): copy the pack folder into `levels/`
  as downloaded, e.g. `levels/LemmingsPlus_All_20201114/`. The Lemmings Plus
  packs by namida are published on the NeoLemmix site and the Lemmings
  Forums (https://www.neolemmix.com, https://www.lemmingsforums.net,
  "NeoLemmix Level Packs").
- **NeoLemmix itself** (styles, panel graphics, masks, sound effects and
  music): the `neolemmix/` folder is laid out like a NeoLemmix install, so
  the NeoLemmix zip and the styles package from
  https://www.neolemmix.com/?page=neolemmix unpack straight into it, giving
  `neolemmix/styles/`, `neolemmix/gfx/`, `neolemmix/sound/` and
  `neolemmix/music/`. See `neolemmix/README.md`. Nothing in it is committed.

Tracker music (`.it/.xm/.mod`) plays through libopenmpt via chiptune3,
vendored under `lemmix/vendor/chiptune3/` (MIT, libopenmpt BSD).

The level browser reads `levels/index.json`. Regenerate it after adding or
removing a pack:

```
node tools/levels-index.js
```

The 3D page's sprite galleries (`3d/galleries.html`) read
`neolemmix/styles/index.json`, the terrain pieces of every NeoLemmix style.
Write it after unpacking the styles package:

```
node tools/styles-index.js
```

The Electron launcher (`launcher/`) serves both indexes live from the
folders, so with it no regeneration step is needed; it is also what saves the
tagging done in the piece editor and the galleries page (`3d/profiles/`).
`node launcher/server.js [port]` runs the same server from a terminal without
Electron, over plain HTTP.

## Credits

- https://github.com/tomsoftware
