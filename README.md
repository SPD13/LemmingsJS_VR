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
- **NeoLemmix styles** (the graphics those levels reference, ~90 MB): the
  styles package from https://www.neolemmix.com/download.php?program=52,
  unpacked so that `styles/orig_dirt/`, `styles/namida_abstract/` ... sit at
  the repo root. Not committed (`styles/` is ignored).
- **NeoLemmix panel graphics, masks and sound effects**: the `gfx/` and
  `sound/` folders of a NeoLemmix player install, or of
  https://github.com/andersmelander/neolemmixplayer (`data/external/`),
  placed at the repo root. Not committed.
- **Music packs** (`orig_01`.. and `ohno_01`.. that the packs' rotations
  name): https://www.neolemmix.com/?page=music_packs, unpacked into `music/`.
  Not committed.

The level browser reads `levels/index.json`. Regenerate it after adding or
removing a pack:

```
node tools/levels-index.js
```

The Electron launcher (`launcher/`) serves that index live from the folders,
so with it no regeneration step is needed.

## Credits

- https://github.com/tomsoftware
