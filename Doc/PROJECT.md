# Lemmings 3D / VR — project context

*Last updated: 2 September 2026 (commit `6cec53e`).*

This document is the standing context for the project: what it is, how it is
put together, what has been built, and what is left. `3d/README.md` is the
user-facing manual (controls, switches, how to run); this is the engineering
account behind it.

---

## 1. What this is

An existing 2D browser reimplementation of *Lemmings* — [LemmingsJS by
oklemenz](https://github.com/oklemenz/LemmingsJS) — rendered as a **3D
diorama** and playable in a **VR headset**, without rewriting the game.

The whole project rests on one rule:

> **`js/lemmings.js` is never modified.** It is loaded as-is and every hook is
> an instance-level wrapper installed from the 3D layer.

The simulation is the original's: the same 60 ms tick, the same collision
mask, the same command stream, the same replay format. What changed is that
the pixels are no longer blitted to a canvas — they are captured and turned
into geometry. That is why the 3D port can claim to be the same game and not a
lookalike, and why a replay recorded in one can be played back in the other.

Everything the port adds lives in `3d/`:

```
3d/
  index.html          the page: canvas, DOM HUD, dialogs, script tags
  js/
    app.js     2664   boot, scene, camera, input, level lifecycle, VR UI
    portals.js  898   objects that are not flat sprites: openings and water
    gui.js      560   the original skill panel, extruded and made pickable
    vr.js       549   WebXR: session, placement, controllers, thumbsticks
    terrain.js  469   destructible extruded terrain, greedy-meshed in chunks
    library.js  441   the world catalog, level progress, level miniatures
    bridge.js   416   the sim/scene boundary: sprite capture and voxelisation
    editor.js   331   the piece-tagging workbench
    depth.js    231   per-pixel depth classes, profile loading
    audio.js    224   music and SFX through the engine's own AdLib synth
    steel.js    114   steel areas, which the engine parses and never uses
  profiles/           per-tileset depth profiles (one so far)
launcher/             Electron app that serves the repo over HTTPS for headsets
levels/               level packs, one folder each (classic games committed, the rest drop-in)
lemmix/js/            the Lemmix engine: NeoLemmix levels, styles, physics, panel (§2.9)
tools/                levels-index (the catalog tree), nx-check / nx-render / nx-run /
                      nx-physics-test (the Lemmix engine's checks), lemmix-node (node loader)
styles/ gfx/ sound/   NeoLemmix assets, downloaded and ignored by git (README, "Levels and assets")
```

About 6,900 lines of JavaScript plus a 205-line page, in 136 commits on top
of upstream (first port commit `d8bfddc`, 31 August 2026).

### How to run

```sh
# from the repo root
npx http-server -p 8123 -c-1
# desktop:  http://127.0.0.1:8123/3d/
# original: http://127.0.0.1:8123/
```

WebXR needs a secure context. Three ways in: the `launcher/` Electron app
(HTTPS with a self-signed cert, shows the LAN URL a headset should open); the
Immersive Web Emulator extension for a desktop check; or `adb reverse tcp:8123
tcp:8123` on a Quest, since localhost counts as secure.

---

## 2. How the 3D layer works

### 2.1 The sim/scene boundary (`bridge.js`)

`SpriteCapture` is a fake display handed to the game's own render methods.
Every `drawFrame` / `drawMask` / `setPixel` the engine performs is recorded
instead of drawn. Each captured animation frame is greedy-meshed **once** into
a `SPRITE_DEPTH = 2` relief with shaded edge walls and cached, so lemmings,
objects, countdown digits and explosion particles have volume rather than
being flat cutouts. `HeadlessStage` satisfies the Stage contract so
`DisplayImage` works with no canvas behind it.

### 2.2 Depth classes (`depth.js`)

A per-pixel depth-class buffer is built by replaying the compositor's terrain
piece list with the original draw-flag semantics. Four classes, each with its
own Z band:

| class | back | front | note |
|---|---|---|---|
| BACKDROP | 0 | 3 | recessed and dimmed (`frontShade` 0.62) |
| TERRAIN | 0 | 16 | the main slab |
| RELIEF | 0 | 22 | proud of the slab |
| OVERLAY | 0 | 18 | thin decal layer |

Everything drawn defaults to TERRAIN — in Lemmings almost every drawn pixel is
standable ground — and the other classes come only from per-tileset JSON
profiles in `3d/profiles/`, tagged per piece id in the editor. A reconcile
pass enforces `depth > 0 ⇔ pixel-solid`, so the classification can never
disagree with collision.

The scene's own planes: `LEMMING_Z = TERRAIN_DEPTH/2 − SPRITE_DEPTH/2` (mid-slab,
so lemmings are embedded in the ground rather than floating in front of it),
`OBJECT_Z = LEMMING_Z − 0.8`, `OBJECT_BG_Z = −1.4`, `OBJECT_DECAL_Z = 16.25`.

### 2.3 Terrain (`terrain.js`)

The level's solidity mask — which *is* the collision data — plus the depth
buffer are greedy-meshed per 32×32-pixel chunk: front and back faces per class
at its own Z band, step walls where classes of different heights meet, all
UV-mapped onto one level texture built from `groundImage`.

`Level.setGroundAt` / `clearGroundAt` are wrapped, so every dig, bash, mine,
explosion and built brick keeps the depth buffer and texture in step and marks
its chunk dirty; dirty chunks are re-meshed with a per-tick budget.

Two optional treatments sit on top:

- **3D terrain** ("emboss"): within a tileset's shading of one hue, lighter
  pixels are pushed up to 4 px toward the viewer, giving rock and grass real
  texture. It multiplies triangle count, so it is switchable; individual
  pieces can opt out, or invert the mapping when they are drawn with dark
  highlights.
- **smooth**: slopes the relief between neighbouring heights by averaging the
  pixel heights meeting at each quad corner, staying crisp at depth-class
  boundaries and silhouettes.

### 2.4 Objects that are not sprites (`portals.js`)

**Entrances.** The hatch is a horizontal panel lying overhead with two doors
hinged along its left and right edges. The trapezoid in the artwork is
un-projected back into a flat panel as wide as the opening is drawn and as
deep as the terrain slab. The doors swing on real hinges, their angle read
from how far each animation frame has the opening revealed.

Where the opening *is* comes from the animation, not the palette: with the
doors shut they cover the hole, so the colours that gain pixels as the hatch
opens are the landscape's, and the opening is the blob painted in them around
the commonest one. (A colour-based reading fails on tilesets where the opening
touches the sprite's edge — group 0 level 6 was the case that forced this.)

**Exits.** Built the same way in miniature: a slab deep enough to hold its own
tunnel, with the opening sunk into the door's thickness rather than bulging
out behind it. The frame around the opening falls away over
`PORTAL_FUNNEL_RINGS` pixels shaped by an S-curve, with corner heights
averaged exactly as the terrain's "smooth" does — which is why the distance
into the opening is measured with a chamfer transform rather than counted in
whole rings, since averaging needs a height that varies pixel to pixel.

Two details that cost real debugging time: gaps *enclosed* by a door's outline
(a skull's sockets, the hollows of an arch) are filled and painted from the
nearest drawn pixel, because a door is solid and its own texel is blank; and a
door is often **two level objects** (an exit plus its cap), so a piece
abutting an opening along most of a side is built as the same slab at the same
depth, or the door renders as two halves on two planes.

Both carve the terrain behind them out of the render-only depth map, being a
hole a lemming really falls through. **Collision is never touched.**

**Water.** The wave sprite is a few pixels tall and used to be drawn flat, so a
pool read as a decal and a drowning lemming drowned in front of it. The level
data does describe the pool, just not obviously: the drowning trigger is the
surface, and the hollow under it is whatever the terrain leaves empty. The
body is built from both — as wide as the sprite, starting just under the
waves, reaching down column by column to whatever ground stops it — in the
average colour of the sprite's own pixels, translucent, deep enough to fill
the slab. The waves go on animating on top of it as the surface they are.

Which objects are openings comes from the profile
(`objects.byId[<id>] = {shape, depth}`), defaulting to entrances (object id 1)
and anything carrying the `EXIT_LEVEL` trigger; water defaults to anything
carrying `DROWN`.

### 2.5 The skill panel (`gui.js`)

The original `GameGui` renders its pixel buffer as usual; it is uploaded as a
texture on an in-scene plane, and ray-hit UVs are forwarded as the mouse
events it already listens for. The panel is one composited bitmap, so the
lemming pictures on the buttons are colour-keyed off the yellow/grey tile
dither and extruded 1 px; the hovered button and its figure rise toward the
player. The counter text along the top gets the same 1 px relief on its light
highlights, smoothed into a bevel, rebuilt whenever the counters change.

Render orders matter here and are worth knowing, because three draws *all*
opaque objects before *any* transparent one — an overlay needs both a render
order and `transparent: true` to win:

```
50 panel · 51 socket · 52 relief · 53 hover · 54 hover relief
55 bar tools · 56 modal · 57 modal buttons · 60 aiming marks (beam, dot, hands)
```

### 2.6 Sim corrections (`steel.js`, and one wrapper in `app.js`)

Two things the engine gets wrong, fixed without touching it:

**Steel.** `LevelReader.steel` is parsed and then has no consumer anywhere in
`lemmings.js` — a digger goes straight down through a steel floor. The parse
is wrong too: the file format packs nine bits of x above seven of y, and width
in the high nibble, and the reader reads both the other way round, throwing
most areas off the level entirely. Measured against the level's own solidity
(steel is always painted onto solid ground), the reader's boxes land on **16 %**
solid pixels and the re-derived ones on **87 %**. `steel.js` recovers the raw
words from what the reader wrote, unpacks them properly, and wraps the three
destructive actions on their own instances: a digger stops and walks, a basher
or miner turns round, each with a short clang, and no ground is removed on the
way.

**Multiple entrances.** `LemmingManager.addNewLemmings` releases every lemming
from `entrances[0]`, where the original takes the entrances in turn. The
release loop is small enough to restate on the manager's own instance;
Compression Method 1 now sends them out 872, 808, 744, 680, round again.

> **Trade-off:** both corrections deliberately part company with the 2D page,
> in the direction of the original game. Replays of levels with steel or
> several entrances will not match it.

### 2.7 Audio (`audio.js`)

Music and effects play through the engine's own AdLib/OPL synthesizer
(`ADLIB.DAT` via `getMusicPlayer` / `getSoundPlayer`) — authentic FM audio, no
external assets. Browsers refuse audio before a gesture, so playback arms
itself on the first pointer or key event and any music requested before that
starts then.

Every player brings its own `AudioContext`, so there is no single node to turn
down: each is routed through a `GainNode` of ours before the destination, and
`setVolume` walks them all. In VR a positioned effect goes through an HRTF
`PannerNode` at the emitter's diorama position with the listener taken from
the headset pose. The distance rolloff is deliberately shallow
(`refDistance 1.5`, `rolloffFactor 0.5`): the board is a 4 m strip an arm's
length away, and a realistic curve left its far end 17 dB under the music.

Cues: the level's "let's go", the entrance hatch, a press on the skill panel,
a skill assigned, the builder's warning three bricks from the end, a skill
stopped by steel, the nuke, and the rare ones (oh-no, explosion, splat,
drowning, the exit, a trap).

ADLIB track indexes are undocumented. The first six were a best-effort guess;
the four added later were chosen by **measuring** all 18 tracks for length and
spectral centroid, and the table records those numbers so re-mapping by ear
starts from data rather than from nothing.

### 2.8 The catalog (`library.js`)

Levels live in `levels/`, one subdirectory per pack: the two classic games
(registered in `config.json`, whose `path` points into `levels/`) and any
number of drop-in NeoLemmix packs, which stay out of git. Nothing here can
list a directory, so `tools/levels-index.js` writes the tree down as
`levels/index.json` (packs → ranks → levels, with a NeoLemmix level's title,
theme and size pre-extracted so lists draw without fetching level files); the
launcher serves the same tree live from the folders. A downloaded collection
that wraps its packs in a `levels/` folder is collapsed to its packs.

The browser walks that tree like a file manager: a directory shows one row
per child — name, a **classic**/**lemmix** badge, its level count and how
many are cleared — and a directory of levels shows their miniature tiles.
The DOM panel and the VR window are two views of the same `WorldLibrary`
state (`navigate`, `up`, `currentNode`), remembered in localStorage and
opened on the directory of the level being played. A level is addressed by
its id, its path in the tree (`lemmings/0/3`,
`LemmingsPlus_All_20201114/Lemmings_Plus_I/Wimpy/Just_Walk!.nxlv`); `?level=`
takes it, the old `?type=&group=&level=` are mapped onto classic ids, and
prev/next walk the pack's play order. Progress records are keyed by id, with
a one-time migration of the old `<game>/<group>/<level>` keys.

Classic packs are scanned once for level names and tilesets (a VGASPEC
special level carries no piece list, so it belongs to no tileset and is
grouped as "Special"), cached in localStorage per pack (`lem3d-worlds-v4`,
about 1.6 s for both games); the scan also feeds the "order: world" layout
and the tagging marks of edit mode. Miniatures render lazily through an
`IntersectionObserver` and a sequential load queue, through a per-engine
loader — the classic one is built in, a NeoLemmix one is registered when the
Lemmix engine exists; until then those tiles list but do not draw or play.

Clears are recorded per browser in localStorage (`lem3d-cleared`): a cleared
tile is green and carries the best time.

### 2.9 The Lemmix engine (`lemmix/`)

A second engine for NeoLemmix levels (`.nxlv` packs), kept entirely apart
from `js/lemmings.js`, which still plays the DOS games untouched. It reuses
the DOS engine's generic parts by reference — `DisplayImage`, `Frame`,
`GameTimer`'s surface, `EventHandler`, the `Command*` classes and
`CommandManager` — and reimplements what is NeoLemmix's own:

| file | what |
|---|---|
| `parser.js` | the NeoLemmix text format (nxlv, nxmi, nxmo, nxmt, nxtm, scheme) |
| `pixels.js` | bitmaps and LemRendering.pas's combine rules: no-overwrite, erase, the solidity/steel/one-way channels, nine-slice |
| `styles.js` | terrain, gadget and background pieces from `styles/`, with their metadata, aliases and rotated/flipped variations |
| `level.js` | `.nxlv` → `Lemmix.Level`: the picture, the physics map cut at NeoLemmix's alpha cutoff, one-way arrows stamped, gadgets with trigger rectangles, receivers paired, spawn order and save requirement as PrepareForUse computes them |
| `lemgame.js` | `TLemmingGame` from LemGame.pas, method for method: all 21 skills (jumper, shimmier, slider and laserer included), every gadget effect including portals, spawning, nuke, time, talismans; records what the player did |
| `replay.js` | NeoLemmix `.nxrp` replays read (`?nxrp=<url>`, `nx-run --nxrp`) and written (the `r` key, `nx-run --save-nxrp`) |
| `sprites.js` | a sprite set (`styles/<set>/lemmings/`) with its scheme and state recolouring; pickup pictures; the `gfx/mask` masks |
| `game.js` | `Lemmix.Game`: the same surface `app.js` drives for the DOS game (timer at 17 fps, lemming manager with NeoLemmix's cursor priority, skills, victory condition, command manager) |
| `panel.js` | the NeoLemmix skill panel drawn on the DOS panel's 320×40 canvas, so `gui.js` extrudes it unchanged; a pack's own panel graphics when it ships them |

The physics runs on integer maps only and has no randomness, so a run is
reproducible from its inputs; `Doc/neolemmix-src/COMMIT` pins the
NeoLemmix commit the port follows. Terrain changes go through the level's
`setGroundAt`/`clearGroundAt`, which is why the diorama's terrain hooks
(§2.3) need nothing new. Sound cues come out of the simulation by name
(`game.sounds`) and play from `sound/` through the same gain and VR panner
as the AdLib effects (`GameAudio.playCue`, with an AdLib stand-in when a
file is missing); a level's music - its `MUSIC` line or the pack's rotation
- plays from the pack's music folder or `music/`, tracker modules through
libopenmpt (chiptune3, `lemmix/vendor/`) in an AudioWorklet, other files
decoded and looped, the AdLib track when nothing is found. Pre-level text
shows in the status line, post-level text and talismans with the result
(`lem3d-talismans` records them). Nuked lemmings carry their countdown
digits; pickups and capped exits carry their counts; moving backgrounds
draw behind the terrain.

Edit mode works on Lemmix levels too: the placed pieces go to `depth.js`
and the piece editor as an id per distinct drawn image, and tags are kept
by piece *name* (`namida_abstract:bar_purple_arrows`) in a profile per theme
style, `profiles/nx-<style>.json`, which the launcher's save route accepts;
the catalog's rank view says which styles have one.

Checks (all under `tools/`, run with node): `nx-check` resolves every piece
reference of every level against `styles/`; `nx-render` draws levels
headlessly and its physics counts are kept as `tools/fixtures/nx-physics.txt`;
`nx-run` plays every level for N frames with no input or with a replay
(796 levels, no exceptions, 12 s) and can write the run out as `.nxrp`;
`nx-physics-test` holds 23 fixtures of the numbers the packs depend on —
splat height, brick counts, tunnel shapes, steel and one-way rules, spawn
cadence, the jumper's arc, the shimmier, the slider and the laserer. A
run written as `.nxrp` and played back gives the same outcome.
---

## 3. Play mode and edit mode

**Play** is the game and is the default. **Edit** is the tagging workbench: it
bills itself as validation mode, opens the piece editor, and turns the catalog
over to tagging status. The mode is remembered, and `?edit=1` or `e` selects
it.

The piece editor (`editor.js`) is how depth profiles are authored: click a
terrain piece to select it — every placement of that piece id highlights —
then pick a depth class, and the diorama re-meshes live. "export JSON"
downloads the profile for `3d/profiles/`; a tag applies to the piece id, so it
covers every level of the same tileset.

---

## 4. VR

The same page is the VR build; an ENTER VR button appears when WebXR is
available. In the headset the diorama is scaled to 2.5 mm per game pixel (a
1600 px level becomes a 4 m tabletop strip) and placed just below eye level,
0.9 m in front of **wherever the player is actually standing and facing** —
the head pose from the XR frame, not the reference-space origin, whose −Z axis
follows room calibration and can point anywhere.

### Interaction

- **Trigger** is the desktop click: aim at a lemming to assign the selected
  skill, or at the skill panel to use it as in the game. One hand points at a
  time — it alone carries a beam and drives the highlight ring — and a trigger
  pull on the other hand takes the beam over.
- **Trigger + move** drags the board in all three axes, so pulling back walks
  it in along Z. A click only counts if the hand stayed put.
- **Thumbsticks**: the pointing hand's pans, the other tilts; they swap with
  the beam. With the catalog open, both scroll it instead and neither moves
  the board.
- **Grip** drags the diorama, **both grips** scale it (0.15×–8×), **A/X**
  recentres. The world itself never moves, so there is nothing to feel sick
  about.
- **No controllers?** The session still runs: a warning sign appears, the
  desktop mouse becomes the pointer (aim on the mirrored view), and it reaches
  every in-scene control, scrubbers included.

### The in-scene interface

The DOM around the canvas does not exist in a headset, so everything the HUD
does has an in-scene twin, all of it riding the toolbar so it follows the bar
wherever it is dragged or unpinned to:

- **Status strip** above the button row: level name, game and difficulty, save
  target, "loading…" while a level is on its way in, and how the last one
  ended — COMPLETE with the time (and whether it is a best) or FAILED, framed
  green or red.
- **A row of seven buttons**: padlock (unpin the bar from the head) and
  four-way arrows (grab handle) at the left; pause in the middle, tracking the
  clock however it was stopped; globe, prev, restart and next at the right.
- **Sound**, off the bar's right end: a mute switch with a volume slider that
  appears when the beam is on either and lingers a couple of seconds.
- **Confirm dialogs** in the toolbar's plane for restart, prev and next —
  while one is up its two answers are the only things the ray can hit.
- **The world catalog**: every level in play order, a heading per difficulty,
  each tile with its miniature, the world it is built from, and a green ground
  and best time once cleared. It opens on the level being played, outlined in
  yellow. The list scrolls with either thumbstick or by pressing and dragging
  its scrollbar.
- **Settings**: 3D terrain, 3D doors, smooth, and recentre — calling exactly
  what the DOM buttons call, so a framerate that suffers mid-session no longer
  means taking the headset off.

Anything the player has to deal with holds the clock while it is up, through
counted holders: only what was stopped gets restarted, so a game already
paused stays paused and two overlapping dialogs do not resume it between them.

---

## 5. Settings and state

| where | what |
|---|---|
| URL | `?level=<id>` (or the old `?type= ?group= ?level=`), `?speed= ?replay=` and the render switches `?emboss= ?smooth= ?doors= ?edit=` |
| localStorage | `lem3d-emboss` `lem3d-smooth` `lem3d-doors` `lem3d-edit` `lem3d-sound` `lem3d-volume` `lem3d-cleared` `lem3d-worlds-v4` `lem3d-lib-order` `lem3d-lib-path` |

The URL overrides both for one load. This matters more than it sounds: the
switches are DOM buttons, invisible inside a session, and the headset is
usually a different machine with its own empty localStorage — so `?emboss=1&smooth=1`
is the usual VR URL. 3D terrain, 3D doors, smooth and sound all start on.

`window.__lem3d` exposes `{state, session, camera, renderer, controls, library,
vr, dioramaRoot, placeDioramaForXR, audio}` for the console and for automated
checks.

---

## 6. How this project verifies things

A pattern that has paid for itself repeatedly: **reproduce numerically in the
browser before changing code.** Several reported "bugs" turned out not to be
where they seemed, and several real causes were nowhere near the obvious one.

Techniques in regular use: pixel sums and bounding boxes over the ground mask;
magenta-backdrop tests to see what is actually being drawn; reconstructing
three's render order from material flags; simulating an XR session with
`Object.defineProperty(renderer.xr, "isPresenting", {value: true})` plus fake
controller matrices; driving the sim by calling `timer.tick()` in a loop
rather than waiting on rAF; and tapping the audio graph with an
`AnalyserNode` to measure what actually leaves a player.

Some findings that only measurement produced:

- The VR wheel zoom threw the board away because
  `position.copy(pivot).add(position.sub(pivot).mul(k))` writes the receiver
  before reading the argument — it yields (0,0,0) every time.
- The next level was invisible in VR because `loadLevel` called
  `frameDesktopCamera` during a session, and the placement code read that back
  as the head pose, putting the board 836 m away.
- Nuke particles filled the eye because `PointsMaterial` size is a view-space
  constant and does not follow object scale: 2.2 became ~2200 px.
- VR sound effects were silent because the panner was inserted into the chain
  but never given its input — measured 0.39 unpositioned, exactly 0.0000
  through the panner, at every distance.
- Steel's two parses, 16 % vs 87 % solidity, decided which was right.
- A test rig bug worth remembering: `Object3D.lookAt` points **+Z** at the
  target (only cameras and lights point −Z), so a fake controller aimed with
  it fires its ray backwards.

Caveats for anyone writing browser checks here: XR controller spaces have
`matrixAutoUpdate = false`, so tests must set `controller.matrix`; three's
raycaster ignores `visible`, so pickers check it explicitly; a hidden tab
freezes rAF (so the render loop stops) though timers keep running while audio
plays; and a caching dev server will serve a stale script through a plain
reload — `http-server -c-1` does not cache, `python3 -m http.server` does, in
which case `fetch(url, {cache: "reload"})` before reloading is the way out.

---

## 7. Progress

### Phases

| phase | state |
|---|---|
| 1–2 desktop 3D rendering | done |
| 3 depth compositing + tagging tools | tooling done, content pending |
| 4 WebXR | done, running on real hardware |

### Built

- The Lemmix engine (§2.9): NeoLemmix packs parse, build from the styles,
  and play in the diorama with NeoLemmix's physics and panel; the catalog
  browses them like a directory of packs (§2.8).

- The 2D sim rendered as an extruded diorama, destructible in 3D, with
  colour-keyed relief and optional smoothing.
- Entrances and exits as real openings with hinged doors; water as a body.
- The skill panel recycled as in-scene geometry with 1 px relief.
- Steel implemented; multi-entrance release corrected.
- Music and 12 sound-effect cues, spatialised in VR.
- The world catalog: 220 levels, two orderings, miniatures, clear records.
- Play mode and edit mode, with the piece-tagging workbench.
- A complete VR interface: status, seven-button toolbar, sound, dialogs,
  catalog, settings — plus a mouse fallback that reaches all of it.
- An Electron launcher serving HTTPS for headsets.

### Open

1. **Tagging** — only `profiles/lemmings-g0.json` exists (seven pieces of the
   dirt set marked backdrop). The other eight tilesets fall back to
   "everything is terrain". This is the content work the whole depth system is
   waiting on, and the largest remaining item.
2. **Automated replay comparison** — 2D vs 3D end states are still compared by
   hand (`r` dump plus `?replay=`). Phase 0 debt, now with the caveat in §2.6.
3. **Remaining object shape classes** — objects that are not openings or water
   still extrude like any sprite at fixed depths.
4. **The piece editor has no in-scene equivalent** — it is a desktop
   workbench, and edit mode is not offered in a headset. This is a decision,
   not an omission.

### Recent work (2 September 2026)

Nine gaps closed in six commits: special levels back in the catalogs
(`d62f3a2`); water given a body (`53aab93`); steel and multi-entrance fixed
(`a8b62da`); the headset given its status strip, settings window and mouse
reach (`0669252`); four sound cues added and the trap/climb mix-up fixed
(`acca56a`); and the README brought back in line (`6cec53e`).
