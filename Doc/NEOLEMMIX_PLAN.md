# Plan: NeoLemmix (.nxlv) support via a "Lemmix" engine variant, and a level-pack directory

## Context

`Doc/PROJECT.md` describes the project: LemmingsJS (`js/lemmings.js`, never modified) rendered as a 3D/VR diorama from `3d/`. The user wants to play NeoLemmix custom levels, starting with the 10 "Lemmings Plus" packs installed at `LemmingsPlus_All_20201114/` (796 `.nxlv` levels). Research (three parallel surveys: the pack, the engine, and the NeoLemmix source/format) established that NeoLemmix is a different game from DOS Lemmings in level format, assets, physics, skills, gadgets, panel and audio. The user's decisions:

1. **Keep the current engine for DOS levels at high fidelity; build a separate "Lemmix" engine variant that replicates NeoLemmix behaviour**, ported from the open NeoLemmix source.
2. Target the 3D/VR app only. Vendor the full NeoLemmix styles package. Add tracker/ogg music playback.
3. **Levels live in one `levels/` directory, one subdirectory per pack** (the classic `lemmings/` and `lemmings_ohNo/` move there too), and the "worlds" browser becomes a **directory-style navigator**: pick a pack, then a subdirectory where the pack has one (the Lemmings Plus collection holds ten packs, each with rank folders), then the miniatures. Every directory row shows its level count, how many are cleared, and whether it is *classic* or *lemmix*.

This document records the research findings and the implementation plan.

---

## Part 1 — Research findings

### 1.1 The `.nxlv` format (NeoLemmix 12.10; source: `LemLevel.pas`, `LemNeoParser.pas` at github.com/andersmelander/neolemmixplayer; forum doc lemmingsforums.net topic 4336)

Text format. Line = `KEYWORD[ value]`; value is everything after the first space; keywords case-insensitive; `#` comments; `$NAME … $END` sections; flags are keys present without a value; repeated keys: last wins; hex numbers `x…`; **values ≥ 32768 must be read as signed 16-bit** (one file has `Y 65483` = −53). Five NLEditor 1.21 files indent every line and write `$SKILLSET ` with a trailing space, so trim before matching.

Top level: `TITLE AUTHOR THEME MUSIC ID LEMMINGS SAVE_REQUIREMENT TIME_LIMIT MAX_SPAWN_INTERVAL SPAWN_INTERVAL_LOCKED WIDTH HEIGHT START_X START_Y BACKGROUND`.
- `START_X/Y` = **viewport centre** (not left edge). Absent → auto (average of entrance trigger points).
- Spawn interval: frames between releases at 17 fps, range 4–102; panel release rate = 103 − SI; initial countdown 20 frames. `LEMMINGS` includes preplaced lemmings.
- `TIME_LIMIT` in seconds; absent = no limit. `SAVE_REQUIREMENT` absolute.
- `BACKGROUND style:name` → `styles/<style>/backgrounds/<name>.png` (tiled).

Sections:
- `$SKILLSET`: skill names (panel order) `WALKER JUMPER SHIMMIER SLIDER CLIMBER SWIMMER FLOATER GLIDER DISARMER BOMBER STONER BLOCKER PLATFORMER BUILDER STACKER LASERER BASHER FENCER MINER DIGGER CLONER`, value = count or `INFINITE` (=100). Max 10 skill types per level; count 0 = only via pickups.
- `$TERRAIN`: `STYLE PIECE X Y [WIDTH HEIGHT] ROTATE FLIP_HORIZONTAL FLIP_VERTICAL NO_OVERWRITE ERASE ONE_WAY`. Drawn in file order; `NO_OVERWRITE` paints only where nothing exists yet ("behind"); `ERASE` subtracts; `ONE_WAY` marks the piece *eligible* for one-way-arrow overlays; steel comes only from the piece's `.nxmt STEEL`. Rotation (90° CW) is applied before flips. `STYLE *GROUP` references a `$TERRAINGROUP` (not used in this pack).
- `$GADGET`: `STYLE PIECE X Y WIDTH HEIGHT ROTATE FLIP_HORIZONTAL FLIP_VERTICAL NO_OVERWRITE ONLY_ON_TERRAIN` plus per type: `PAIRING` (teleporter↔receiver), `SKILL`/`SKILL_COUNT` (pickup), `LEMMINGS` (exit capacity / window count), `DIRECTION` (splitter), `CLIMBER SWIMMER FLOATER GLIDER DISARMER ZOMBIE NEUTRAL` flags on windows, `ANGLE`/`SPEED` (moving background decorations). WIDTH/HEIGHT only honoured for resizable gadgets (nine-slice; default margins 0 = tile the whole image); the trigger area grows with the resize. Window facing = `FLIP_HORIZONTAL`. Gadgets at `X/Y −32768` are parked placeholders and must be skipped.
- Gadget draw layers: backgrounds → NO_OVERWRITE-and-not-ONLY_ON_TERRAIN (reverse order) → ONLY_ON_TERRAIN → one-way arrows (masked to solid + one-way-eligible pixels) → everything else.
- `$LEMMING`: `X Y` (foot position) `FLIP_HORIZONTAL` + permanent-skill/`BLOCKER`/`ZOMBIE`/`NEUTRAL` flags.
- `$TALISMAN`: `TITLE ID COLOR SAVE_REQUIREMENT TIME_LIMIT(frames) SKILL_LIMIT <SKILL>_LIMIT …`.
- `$PRETEXT` / `$POSTTEXT`: repeated `LINE`.

Pack metadata (`.nxmi`): pack root `levels.nxmi` = `BASE` + `$GROUP {NAME, FOLDER}` per rank in play order; each rank folder's `levels.nxmi` = one `LEVEL <file>.nxlv` per level in play order; `info.nxmi` = `TITLE AUTHOR VERSION [$SCROLLER LINE…]`; `music.nxmi` = `TRACK` rotation indexed by level ordinal; `postview.nxmi` = `$RESULT {CONDITION, LINE…}`. `MUSIC` resolves `music/<name>.<ext>` trying `.ogg .wav .mp3 .it .mod .xm …`; `orig_NN`/`ohno_NN` come from NeoLemmix's separate music packs.

### 1.2 Styles (not in the pack)

`styles/<style>/`: `theme.nxtm` (`LEMMINGS <spriteset>`, `$COLORS MASK MINIMAP BACKGROUND ONE_WAYS PICKUP_BORDER PICKUP_INSIDE`), `terrain/<piece>.png` [+ `.nxmt`: `STEEL RESIZE_* DEFAULT_WIDTH/HEIGHT NINE_SLICE_*`], `objects/<piece>.nxmo` (`EFFECT TRIGGER_X/Y/WIDTH/HEIGHT DEFAULT_WIDTH/HEIGHT RESIZE_* SOUND KEY_FRAME DIGIT_* $PRIMARY_ANIMATION{FRAMES NAME COLOR HORIZONTAL_STRIP Z_INDEX INITIAL_FRAME OFFSET_X/Y STATE HIDE $TRIGGER{CONDITION HIDE STATE}} $ANIMATION…`) + one PNG per animation (frames stacked vertically unless `HORIZONTAL_STRIP`), `backgrounds/*.png`, `lemmings/*.png` + `scheme.nxmi` (per-animation `FRAMES PEAK_FRAME LOOP_TO_FRAME $LEFT/$RIGHT FOOT_X FOOT_Y`, `$STATE_RECOLORING` athlete/zombie/neutral/selected), optional `alias.nxmi`.
Lemming sprites of the `default` style: ascender basher blocker bomber builder burner climber dehoister digger disarmer drowner exiter faller fencer floater glider hoister jumper laserer miner ohnoer platformer reacher shimmier shrugger slider splatter stacker stoner swimmer walker.
Download: full styles package https://www.neolemmix.com/download.php?program=52 (88 MB current; Oct-2020 41 MB build closest to these 12.10 packs). Also mirrored at `data/external/styles/` in the GitHub repo. Non-style engine assets are in the same repo: `data/external/gfx/panel/` (`skill_panels.png skill_count_digits.png skill_count_erase.png skill_selected.png empty_slot.png icon_rr_minus/plus/pause/nuke/ff/restart/frameskip.png panel_font.png panel_icons.png minimap_region.png`), `data/external/gfx/mask/` (`basher bomber fencer miner stoner countdown highlight laser warp .png`), `data/external/sound/` (~180 `.wav` + a few `.ogg/.mp3`), `data/external/music/`. Licence: author-owned, `orig_*/ohno_*` are Psygnosis-derived; treat like the DAT files already in the repo.

### 1.3 What the pack actually uses (796 levels, 10 packs, 40 ranks)

- Sizes: 258 distinct W×H; only 1 level is 1600×160; widths 124–1600 (median 476), heights 80–800 (84 % are 160). Negative coordinates are common (4 222 terrain pieces with negative Y); 192 pieces hang past the right/bottom edge.
- Skills used (17): the 8 DOS skills plus `PLATFORMER GLIDER WALKER STACKER STONER SWIMMER CLONER FENCER DISARMER`. No Jumper/Shimmier/Slider/Laserer; no `INFINITE`.
- Terrain flags: `ONE_WAY` 33 403, `NO_OVERWRITE` 11 959, `ROTATE` 4 969, `FLIP_H` 4 352, `FLIP_V` 3 764, `ERASE` 3 010. Terrain never has WIDTH/HEIGHT.
- Gadgets (76 piece names, 33 styles): window, exit (+ `exit_locked`/`locked_exit`, `exit_alt`, `exit_01/02`, `exit_flame`, `exit_text`, `exit_invisible`), water (+`acid`, `water_red`, `invert_water`), traps (`trap*`, `shredder`, `weight_trap`, `bee_trap`, `flytrap`, `spike_trap_*`, `rope_trap`, `lizard_trap_01`, `weed_trap`, `mine`, `radiating_ball`, `laser_*`, `lightning_*`), fire (`flame`, `flamethrower*`, `firepit`, `fire_*`, `iceblower`), one-way arrows (`owa_left/right/down`, `owa`, `owa_left_invisible`) and one-way **fields** (`owf_left/right`), `teleporter`/`receiver` (PAIRING), `pickup` (SKILL, 203 uses), `button` (89) + locked exits (7 levels have no ordinary exit), `updraft`/`steam`/`updraft_*` (286), `splitter` (15), `splat_wire`/`antisplat_wire`, decorations with ANGLE/SPEED (`star`, `bee_decoration`, `lights`, `earth`, `snowman`, `jack*`, `zombee`, `flag_*`, `fireplace`, `spinning_arrow`), `exhaust`, `flamelight`.
- 16 levels have no window (all lemmings preplaced via `$LEMMING`, 132 sections, incl. zombies and blockers); 95+ levels have 2–6 windows; windows carry CLIMBER/GLIDER/FLOATER/SWIMMER/ZOMBIE presets in 29 cases.
- 110 levels carry talismans; 8 pretexts, 12 posttexts. `SPAWN_INTERVAL_LOCKED` in 24; `TIME_LIMIT` in 107.
- Music: 52 files (`.it` 37, `.ogg` 10, `.mod` 3, `.xm` 2); 315 levels set `MUSIC`; rotations reference `orig_01–17`, `ohno_01–06`, `beastii` (not in pack); one typo (`machine2` → `Lemmings_Plus_V/machine2`).
- The 103 PNGs are menu/panel skins only (logos, rank plates, custom `skill_panels.png` for 7 packs).
- Pack layout on disk: `<collection>/levels/<pack>/{info,levels,music,postview}.nxmi + logo.png + <rank folder>/levels.nxmi + *.nxlv`, and `<collection>/music/<pack>/*.it|ogg|…`. Rank `FOLDER` can differ from `NAME` (`01 Mutilation` vs `Mutilation`).

### 1.4 Capability gap: NeoLemmix vs our engine (`js/lemmings.js` + `3d/`)

| Area | NeoLemmix 12.10 | Our engine | Gap |
|---|---|---|---|
| Level source | text `.nxlv`, named style/piece refs, packs via `.nxmi` | `LEVELxxx.DAT` + `GROUND/VGAGR` DAT readers, `config.json` order | new parser, pack index, style loader (no directory listing on any server → manifest) |
| Level size | any; coordinates may be negative/off-edge | `LevelReader` hardcodes 1600×160 but `Level`/display/3D are size-generic | fine |
| Terrain composition | rotate/flip/erase/no-overwrite, resizable nine-slice pieces, steel from metadata, one-way eligibility map | upside-down/erase/no-overwrite only; steel parsed and ignored (fixed in `3d/js/steel.js`) | rotate, flip-H, steel map, one-way map, backgrounds |
| Skills | 21 (17 used here) incl. permanent Swimmer/Glider/Disarmer, instant Walker/Cloner/Stoner | 8; `SkillTypes` length 9; `GameGui` 13 fixed cells with 8 skill cells | 9 new skills, 10-slot panel |
| Physics | 17 fps; splat > 62 px; 12 bricks; instant bombers/stoners; nuke = 84-frame timers; one-way rules per skill; updraft; zombies/neutrals | 60 ms tick; DOS-ish approximations; 5-s bomber countdown | port from `LemGame.pas` |
| Gadgets | exit (capacity), locked exit + button, water, fire, trap (busy/re-usable, single-use), teleporter/receiver, pickup, updraft, splitter, splat/antisplat pads, force fields, one-way L/R/D/U, entrance (presets, multi-window round-robin), moving backgrounds, animation gadgets | `TriggerTypes` EXIT/TRAP/DROWN/KILL/blocker; ONWAY parsed and ignored; traps never disarm; only `entrances[0]` releases (fixed in `app.js`) | most of it |
| Lemming sprites | PNG sprite sets + `scheme.nxmi`, theme recolouring | `MAIN.DAT` sprites for 20 states | new sprite pipeline |
| Panel | 10 skill slots, RR ±, pause, nuke, FF, restart, skip, `gfx/panel` art; per-pack `skill_panels.png` | hardcoded bitmap layout, mirrored by `3d/js/gui.js` (13 cells) | new panel renderer |
| Audio | `.it/.xm/.mod/.ogg` music, `.wav/.ogg` SFX per gadget (`SOUND` key) | AdLib OPL only, no external audio | tracker + WebAudio path |
| Meta | talismans, pre/post text, postview messages, level ID | none | optional UI |
| Replay | own `.nxrp` (text) | `CommandManager` string | keep ours; import `.nxrp` for verification |

The DOS engine cannot be extended without editing `js/lemmings.js`, and its physics is not NeoLemmix's; hence the separate engine variant.

### 1.5 Source of truth for the physics

- **NeoLemmix is open source** (Delphi/Pascal): github.com/andersmelander/neolemmixplayer — namida's canonical repo history, archived read-only Jan 2025, `master` = Community Edition 1.0 (12.14 lineage). Active continuation: github.com/Willicious/NeoLemmixCommunityEdition (pushed Aug 2026). SuperLemmix is a diverged fork (different physics) — do not use.
- **Licence** (`License.txt`): CC BY-NC 4.0 for the code; translation to other languages explicitly permitted; credit Eric Langedijk (Lemmix), Stephan Neupert, Namida Verasche; no commercial use. Assets (graphics, music, sound) stay copyrighted by their creators, "for running NeoLemmix".
- **Physics = `LemGame.pas`**: 6 807 lines, 187 methods on `TLemmingGame`: 48 `Handle*` (one per lemming action + one per gadget effect), 20 `MayAssign*` rules, `Apply*Mask` (basher/miner/fencer/laser/explosion/stoner), `CheckTriggerArea`, `CheckReleaseLemming`, `CheckUpdateNuking`, `UpdateExplosionTimer`, `Transition`. **No randomness anywhere** — fully deterministic integer physics, so a port can be checked frame-for-frame. Supporting units: `LemLemming.pas` (lemming record), `LemGadgets.pas`, `LemGadgetsConstants.pas`, `LemGadgetsMeta.pas`, `LemCore.pas`, masks in `gfx/mask`.
- **Existing ports**: none in JavaScript (LemmingsJS-MIDI only parses nxlv). github.com/tan-x-dx/NeoLemmixSharp is a C# port (GPL-3, active Aug 2026, completeness unknown) — usable as a second reading of ambiguous Pascal, not as source, and not to copy from (licence).
- **Approach**: port `LemGame.pas` method for method, keeping NeoLemmix's names, constants and check order; pin the commit; vendor the referenced `.pas` files under `Doc/neolemmix-src/` for reference; verify with NeoLemmix's own text replays (`.nxrp`) driven through our engine.

### 1.6 The current level browser (what the refactor replaces)

`3d/js/library.js` (`WorldLibrary`, `LevelProgress`) and the VR twin in `3d/js/app.js` (`loadVrCatalog` ~line 825, `layoutVrCatalogList`, `vrCatalogPick`, tiles painted on a canvas texture). Both are keyed by `(gameType 1|2, group, level)`: `LevelProgress` keys are `"<gameType>/<group>/<level>"` in localStorage `lem3d-cleared`; the catalog cache `lem3d-worlds-v3` maps gameType → tilesets → levels from a one-time scan; `enterWorld(gameType, group, level)` sets `state.gameType/group/level` and reloads; `moveLevel(delta)` (app.js ~1705) walks `config.level.order`. The DOM panel is `#library` in `3d/index.html` (`#lib-head` with order/rescan/close buttons, `#lib-status`, `#lib-grid` of `.lib-game` / `.lib-world` headers and `.lib-tiles` of `.lib-tile`). The DOS packs are found through `config.json` entries whose `path` is the folder under the repo root (`FileProvider` = `rootPath + path + "/" + file`), so moving them only needs the `path` values changed.

---

## Part 2 — Architecture

### 2.1 The `levels/` directory: packs as subdirectories

```
levels/
  lemmings/                         classic  (moved from ./lemmings;      config.json path → "levels/lemmings")
  lemmings_ohNo/                    classic  (moved from ./lemmings_ohNo; config.json path → "levels/lemmings_ohNo")
  LemmingsPlus_All_20201114/        lemmix   (moved as-is: levels/<pack>/<rank>/*.nxlv, music/<pack>/*)
  <any future folder>/              classic if it holds MAIN.DAT + a config.json entry; lemmix if it holds .nxlv files
  index.json                        generated tree (see below)
```

Detection rule for a pack directory: **classic** = a `config.json` entry whose `path` points at it (the engine still needs the audio offsets and level order from there; `config.json` becomes the registry of classic packs); **lemmix** = contains `levels.nxmi` or any `.nxlv` under it. A lemmix collection folder whose only content is a `levels/` folder plus `music/` is collapsed: its packs are the entries of `levels/`.

Because neither `npx http-server` nor `launcher/server.js` can list directories, the tree is materialised as `levels/index.json` by `tools/levels-index.js` (node, no dependencies), and **the launcher serves the same tree live** from a shared module (`launcher/levels-index.js` required by both the tool and `server.js` at `GET /levels/index.json`), so dropping a folder in needs no build step when running through the launcher. The tree:

```json
{ "kind": "dir", "name": "levels", "children": [
  { "kind": "pack", "engine": "classic", "dir": "lemmings", "name": "Lemmings", "gameType": 1,
    "children": [ { "kind": "dir", "name": "Fun", "levels": [ { "id": "lemmings/0/0", "group": 0, "index": 0 }, … ] }, … ] },
  { "kind": "dir", "engine": "lemmix", "dir": "LemmingsPlus_All_20201114", "name": "Lemmings Plus (all)", "children": [
    { "kind": "pack", "engine": "lemmix", "dir": "LemmingsPlus_All_20201114/levels/Lemmings_Plus_I",
      "name": "Lemmings Plus I", "author": "by namida", "logo": "…/logo.png", "musicRotation": [ … ],
      "children": [ { "kind": "dir", "name": "Wimpy", "folder": "Wimpy",
        "levels": [ { "id": "LemmingsPlus_All_20201114/levels/Lemmings_Plus_I/Wimpy/Just_Walk!.nxlv",
                      "file": "Just_Walk!.nxlv", "title": "Just Walk!", "theme": "orig_dirt", "width": 320, "height": 160 } ] } ] } ] } ] }
```
Every node carries `count` (levels beneath it); cleared counts are computed client-side from `LevelProgress`. Level ids are path-like and stable: `<classic dir>/<group>/<index>` and `<lemmix path>/<file>` (the NeoLemmix level `ID` is kept as `nxId` for talismans/replays). Titles, theme and size are pre-extracted so the browser never fetches 796 files to draw a list. Classic level names still come from the tileset scan (as today) or from the level file when a tile is drawn.

### 2.2 The directory-style browser (DOM `#library` and the VR catalog)

One navigation model shared by both fronts, in `3d/js/library.js`:

- `LevelTree.load()` fetches `levels/index.json`; `LevelTree.node(path)`, `.levelsUnder(node)`, `.next(levelId, ±1)`.
- `LevelBrowser` state = current node path, remembered in localStorage (`lem3d-lib-path`), opened on the directory of the level being played.
- **Directory view** (a node with children): a breadcrumb (`levels › LemmingsPlus_All_20201114 › Lemmings Plus I`) and one row per child: name (pack title/author or rank name; logo where a pack has one), a badge **classic** / **lemmix** (from the pack's `engine`, inherited by its subfolders), `N levels`, `M / N cleared` (green when complete), and in edit mode the "✔ tagged" mark for classic tilesets. Click descends; a "‹ back" row and the breadcrumb ascend.
- **Level view** (a node with `levels`): the existing miniature tiles (`_buildTile`, `_drawMiniature`), one heading; the "order: level / world" toggle stays available inside classic packs (it regroups that pack's levels by tileset, as today) and is hidden for lemmix nodes, where the tile's sub-line shows the THEME instead. Clicking a tile loads it.
- **VR catalog** (`app.js` `loadVrCatalog`/`layoutVrCatalogList`/`vrCatalogPick`): the same nodes, painted as rows for directories (with the same badge and counts) and tiles for levels; a row press descends, a back row ascends, the thumbstick still scrolls. Items get `nodePath`/`levelId` instead of `gameType/group/level`.
- `LevelProgress` keys become level ids; a one-time migration converts existing `"<1|2>/<g>/<l>"` records to `"lemmings/<g>/<l>"` / `"lemmings_ohNo/<g>/<l>"`.
- `state` in `app.js` becomes `{ levelId, engine, … }` with `?level=<id>` in the URL; the old `?type=&group=&level=` are accepted and mapped to the classic ids so existing headset bookmarks keep working. `moveLevel(delta)` walks the pack's flattened level order (across its ranks, wrapping), for either engine.
- `thumbnail(levelId, w, h)` and the tile loader pick the engine from the level's pack (`Lemmings.GameFactory` for classic, `Lemmix.LevelBuilder` for lemmix).

### 2.3 The Lemmix engine (`lemmix/`)

A second engine under namespace `Lemmix`, in ES5-style script files like the rest of `3d/js` (no bundler), loaded by `3d/index.html` after `js/lemmings.js`. It **reuses by reference** the generic infrastructure of the untouched DOS engine — `Lemmings.DisplayImage`, `Lemmings.Frame`, `Lemmings.Animation`, `Lemmings.GameTimer`, `Lemmings.EventHandler`, `Lemmings.CommandManager` and the `Command*` classes, `Lemmings.SolidLayer`, `Lemmings.GameStateTypes` — and reimplements everything game-specific. `js/lemmings.js` stays byte-identical.

```
lemmix/
  js/
    parser.js     Lemmix.NxParser — the generic NeoLemmix text format (nxlv, nxmi, nxmo, nxmt, nxtm, scheme)
    packs.js      Lemmix.PackIndex — reads the pack's info/levels/music/postview .nxmi (via levels/index.json)
    styles.js     Lemmix.StyleManager — lazy per-piece loading: PNG → Frame (RGBA + mask), .nxmt/.nxmo meta,
                  theme.nxtm, alias.nxmi, backgrounds, lemming sprite sets; in-memory cache keyed "style:piece"
    level.js      Lemmix.LevelBuilder — nxlv → Lemmix.Level: terrain composition (order, rotate/flip/erase/
                  no-overwrite, nine-slice resize), physics maps (solid, steel, one-way-eligible),
                  gadget instantiation + one-way stamping, preplaced lemmings, START_X/Y → screenPositionX
    gadgets.js    Lemmix.Gadget / GadgetManager — animation state machine (READY/BUSY/DISABLED/EXHAUSTED,
                  secondary animations, KEY_FRAME), trigger rects, pairing, buttons/locked exits, pickups
    lemming.js    Lemmix.Lemming — the NeoLemmix lemming record (x, y, dx, action, fallen, permanent skills,
                  zombie/neutral, explosion timer, …) + sprite drawing from scheme.nxmi with recolouring
    physics/      one file per action, ported from LemGame.pas HandleXxx: walker faller floater glider
                  swimmer climber hoister dehoister builder platformer stacker basher fencer miner digger
                  blocker stoner bomber(ohno/explode) shrugger exiter vaporizer drowner splatter disarmer
                  (fixing) reacher; masks from gfx/mask; MayAssign* rules
    manager.js    Lemmix.LemmingManager — per-frame loop (spawn, triggers, action, removal), nuke,
                  getLemmingAt/doLemmingAction, entrance round-robin with per-window caps and presets
    skills.js     Lemmix.SkillTypes (21) + Lemmix.GameSkills (counts, INFINITE, pickups, selection)
    panel.js      Lemmix.GamePanel — draws the NeoLemmix skill panel into a Lemmings.DisplayImage
                  (16-px cells: RR−, RR+, up to 10 skill slots, pause, nuke, speed) and handles mouse
    audio.js      Lemmix.Audio — music via libopenmpt (wasm) for .it/.xm/.mod, WebAudio for .ogg/.wav;
                  SFX from sound/ by gadget SOUND key and action events; MUSIC key + rotation resolution
    game.js       Lemmix.Game — the duck-typed Game the 3D layer drives (see 2.4), timer at 1000/17 ms,
                  victory (save requirement, exit capacity), time limit, talisman evaluation, pre/post text
    factory.js    Lemmix.GameFactory(rootPath) — getGame(), getLevel(levelId)
  vendor/         libopenmpt.js + .wasm (pinned version, served locally; CDN is not reachable on a headset)
styles/           the full NeoLemmix styles package (vendored)
gfx/ sound/       vendored from NeoLemmix data/external (panel, mask, sound effects)
music/            vendored NeoLemmix music packs for orig_01–17, ohno_01–06, beastii
tools/
  levels-index.js node: builds levels/index.json (shared with launcher/levels-index.js)
  nx-check.js     node: parses every .nxlv, resolves every style:piece against styles/, reports missing pieces, prints stats
  nx-render.js    node + pngjs: headless LevelBuilder render of any/all levels to PNG for visual checks
```

Assets are static files, so both `npx http-server` and `launcher/server.js` serve them unchanged; add `.nxlv/.nxmi/.nxmo/.nxmt/.nxtm/.ogg/.it/.xm/.mod/.wasm` to the MIME table in `launcher/server.js`.

### 2.4 The contract the 3D layer already depends on (must be satisfied by `Lemmix.Game`/`Lemmix.Level`)

From `3d/js/app.js`, `gui.js`, `bridge.js`, `portals.js`, `depth.js`, `terrain.js`, `library.js`, `audio.js`:

- `game.loadLevel(...)`, `game.level`, `game.getGameTimer()` (`onGameTick`, `getGameTicks()`, `getGameTime()`, `isRunning()`, `suspend()`, `continue()`, `tick()`, `speedFactor`, `TIME_PER_FRAME_MS`), `game.getLemmingManager()` (`.lemmings[]`, `getLemmingAt(x,y)`, `addNewLemmings`), `game.getCommandManager()` (`loadReplay`, `serialize`), `game.queueCmmand(cmd)`, `game.onGameEnd.on(result => result.state)`, `game.setGuiDisplay(display)`, `game.objectManager.render(display)`, `game.triggerManager.trigger(x,y)`, `game.stop()/dispose()`.
- Lemming: `id, x, y, removed, state, action.getActionName(), render(display)`.
- Commands: `Lemmings.CommandLemmingsAction(id)`, `CommandNuke`, `CommandSelectSkill` — reuse the DOS classes; they call `game.getGameSkills()`, `game.getLemmingManager()`, `game.getVictoryCondition()`, so `Lemmix.Game` exposes those with the same method names (`canReduseSkill/reduseSkill/getSelectedSkill/setSelectedSkill`, `doLemmingAction`, `doNuke`, `changeReleaseRate`).
- Level: `width, height, name, needCount, releaseCount, screenPositionX, groundImage (RGBA Uint8ClampedArray), getGroundMaskLayer().groundMask (Int8Array), setGroundAt/clearGroundAt (wrapped by terrain.js), objects[] ({x, y, animation.frames[], drawProperties}), entrances[]`.
- Display API used for capture: `drawFrame, drawFrameFlags, drawFrameCovered, drawMask, setPixel, drawRect, …` — all via `Lemmings.DisplayImage`, so drawing through it keeps `SpriteCapture` working unchanged.
- Global stashes the 3D layer reads: `window.__lem3dGroundData = {lr:{levelWidth, levelHeight, terrains[{x,y,id,drawProperties}], graphicSet1, steel[]}, terraImages[id].frames[0]}` (depth classes, piece editor, catalog worlds) and `window.__lem3dObjectData = {objects, objectImg[id].trigger_*}` (portals, water). These are DOS-shaped and keyed by numeric ids; Phase 7 generalises them.

---

## Status (2 September 2026)

Done on branch `lemmix`: Phase 0 (assets fetched, ignored by git; README
says where from), Phase 1 (`levels/` directory, index, directory-style
browser, legacy URLs, progress migration), Phase 2 (parser, styles, level
builder, node tools, miniatures), Phase 3 with most of 4 and 5 (the full
LemGame.pas port bar Jumper/Shimmier/Slider/Laserer/Portal; gadgets
including teleporters, pickups, buttons, updrafts, splitters, pads, force
fields; the Game wrapper and the NeoLemmix panel; `nx-run` over all 796
levels; 23 physics fixtures), Phase 6 (file SFX, tracker and ogg music,
AdLib fallback), Phase 7 (portal/water descriptors for Lemmix objects,
pre/post text and talismans, depth profiles by piece name with the editor
and the catalog marks, per-pack panel skins) and Phase 8 (`.nxrp` replays
read and written with a verified round trip, countdown digits, gadget
count digits, moving backgrounds behind the terrain, and the last skills
and gadgets: jumper, shimmier, slider, laserer, portals), and the minimap
in both panels (`Doc/MINIMAP_PLAN.md`). Nothing from the
plan is open; what remains is fidelity work against real NeoLemmix
replays as they become available.

## Part 3 — Phases

Each phase ends in something runnable. Verify per phase (Part 4).

### Phase 0 — Assets and tooling (no engine code)
1. Download the styles package (prefer the Oct-2020 build matching 12.10; fall back to current) → `styles/`. Copy `gfx/panel`, `gfx/mask`, `sound/` from the NeoLemmix repo `data/external/`, and the DOS/OhNo music packs → `music/`. Vendor `libopenmpt.js` (+wasm) → `lemmix/vendor/`. Vendor the referenced `.pas` files → `Doc/neolemmix-src/` with the licence and the pinned commit hash.
2. `tools/nx-check.js`: every one of the 872 terrain + 76 gadget + 19 background references must resolve (list any `alias.nxmi` hits). Decide committing `styles/` (88 MB) vs `.gitignore` + documented download; recommend committing like the DAT files unless the user objects.
3. `launcher/server.js` MIME additions.

### Phase 1 — `levels/` directory and the directory-style browser (classic packs first)
1. `git mv lemmings levels/lemmings`, `git mv lemmings_ohNo levels/lemmings_ohNo`, `git mv LemmingsPlus_All_20201114 levels/`; update the two `path` values in `config.json`; confirm the 2D page and the 3D app still load DOS levels unchanged (`FileProvider` composes `rootPath + path`).
2. `tools/levels-index.js` + `launcher/levels-index.js` (shared) producing the tree of 2.1; the launcher route `GET /levels/index.json`; commit a generated `levels/index.json` for `http-server` users. Lemmix packs are indexed now (titles/theme/size pre-extracted with a minimal nxlv header read) even though they cannot be played yet; their rows show the **lemmix** badge and a "needs the Lemmix engine" note until Phase 3.
3. `library.js`: `LevelTree`, `LevelBrowser` (directory view, level view, breadcrumb, back, badges, counts, remembered path), `LevelProgress` id keys + migration, `thumbnail(levelId)`. Keep `_buildTile`, `_drawMiniature`, the lazy `IntersectionObserver` queue and the tileset scan (`_discover`, now per classic pack and cached per pack dir).
4. `index.html`: breadcrumb and row styles in `#library` (`.lib-crumb`, `.lib-row`, `.lib-badge.classic/.lemmix`, `.lib-count`); the order toggle only shown in classic level views.
5. `app.js`: `state.levelId`/`engine`, URL `?level=`, legacy param mapping, `moveLevel` over the tree, VR catalog rows + back + badges (`loadVrCatalog`, `layoutVrCatalogList`, `vrCatalogPick`, the paint routine), status strip meta from the node names (`Lemmings Plus I · Wimpy 3`).
6. `Doc/PROJECT.md` §2.8/§5: document the directory model and the new URL/localStorage keys.

### Phase 2 — Lemmix parser, styles, static level render
1. `lemmix/js/parser.js`: tokenizer per 1.1 (trim, `#`, `$…$END` nesting, signed-16 fix, hex `x…`, flags, `INFINITE`). Unit-test against all 796 files + all `.nxmi/.nxmo/.nxmt/.nxtm` in `styles/` (every file parses, section counts match the survey: 76 178 terrain / 12 188 gadget / 132 lemming / 112 talisman).
2. `packs.js`: per-pack metadata (info, ranks, music rotation, postview) from the `.nxmi` files the index points at.
3. `styles.js`: PNG decode via `Image` + offscreen canvas → `Lemmings.Frame` (RGBA + alpha mask); animation strips split by `FRAMES`/`HORIZONTAL_STRIP`; `.nxmt/.nxmo/theme.nxtm/alias.nxmi` parsed once per style; missing piece → `default:fallback` + warning list (NeoLemmix behaviour).
4. `level.js` `LevelBuilder.build(nxlv, styles)` → `Lemmix.Level` (same field set as `Lemmings.Level`): compose terrain in file order with rotate → flip-H → flip-V, `NO_OVERWRITE`, `ERASE`, nine-slice for resizable pieces, negative/off-edge clipping; build parallel maps `solid` (→ `SolidLayer`), `steel`, `oneWayEligible`, then gadgets (skip −32768, resize triggers, `ONLY_ON_TERRAIN`), stamp one-way arrows into the `oneWay` map (L/R/D/U), background tile, preplaced lemmings, `screenPositionX = START_X − viewportWidth/2`.
5. Browser: lemmix tiles now get real miniatures through `LevelBuilder`; `tools/nx-render.js` headless render of every level to PNG; spot-check ~20 levels.

### Phase 3 — Minimal playable Lemmix game (DOS-8 skills) inside the 3D app
1. `game.js`, `manager.js`, `lemming.js`, `skills.js`, `gadgets.js` skeleton; timer at `1000/17` ms.
2. Lemming sprites: `styles/<theme.LEMMINGS>/lemmings/*.png` + `scheme.nxmi`; `Lemming.render(display)` draws at `x − FOOT_X, y − FOOT_Y` via `display.drawFrame` (captured by `SpriteCapture` as-is). Recolouring per `$STATE_RECOLORING` applied at load into cached variants.
3. Port from `LemGame.pas`: spawn (`CheckReleaseLemming`: countdown 20, SI, round-robin windows with caps/presets, facing from FLIP_H), walker, faller (3 px/frame, `MAX_FALLDISTANCE 62`, updraft 2 px + reset), splatter, exiter (capacity), drowner, vaporizer, blocker (force fields), climber/hoister, floater, builder (12 bricks, shrug), basher/miner/digger with masks from `gfx/mask` and the one-way/steel rules, bomber (instant, ohno → explode, crater mask), nuke, time limit, victory/`onGameEnd` with `Lemmings.GameStateTypes`.
4. `app.js`: engine chosen from the level's pack; **skip the DOS-only instance wrappers for Lemmix games** (`installSteel`, the `addNewLemmings` round-robin, the ADLIB music call); publish `__lem3dGroundData`/`__lem3dObjectData` in a shape depth.js/portals.js accept (interim numeric id table; Phase 7 makes it engine-neutral).
5. Panel: `panel.js` first version = RR ± / skill slots / pause / nuke / speed with `gfx/panel` art into the `DisplayImage` handed by `game.setGuiDisplay`; same 16-px cell geometry so `3d/js/gui.js` works, with `GUI_BUTTONS` read from the panel width and the digit/icon rows parameterised.

### Phase 4 — Full skill set
Platformer, stacker (8), fencer (mask), glider (opens after 8/6, updraft interaction, floater/glider exclusive), swimmer, disarmer, stoner (instant, mask into terrain), walker (instant turn/cancel), cloner (duplicate, opposite direction, cap 99); permanent-skill stacking, zombies (infect on contact, no assignment, count as lost), neutrals. Jumper/Shimmier/Slider/Laserer out of scope (unused by the packs; enum slots kept).

### Phase 5 — Full gadget set
Trigger dispatch per `CheckTriggerArea` order; gadget animation state machine (READY/BUSY/DISABLED/EXHAUSTED, `$TRIGGER` conditions, secondary animations, `KEY_FRAME`): traps (busy while animating, single-use `traponce`), teleporter→receiver, pickup (skill + count, hide after pickup, `DIGIT_*`), button → locked exit (`ButtonsRemain`), updraft, splitter, splat/antisplat pads, force fields (`owf_*`), one-way up/down, moving backgrounds (`ANGLE`/`SPEED`), `animation` gadgets, exit capacity, invisible variants. Gadget `SOUND` keys → SFX.

### Phase 6 — Audio
`lemmix/js/audio.js`: music resolution per 1.1 (`MUSIC` key, `;` fallback list, rotation by level ordinal, typo tolerance), tracker playback through libopenmpt (`AudioWorklet`, gain node into the existing `3d/js/audio.js` volume chain), `.ogg/.wav` via `decodeAudioData`; SFX from `sound/`. Extend `3d/js/audio.js` with a "file source" alongside the OPL source, keeping VR panning.

### Phase 7 — 3D-layer generalisation
1. Engine-neutral piece data: string piece keys (`"g0/12"` for DOS, `"orig_fire:bricks_01"` for Lemmix) in `depth.js`, `editor.js`, `DepthProfiles` (`profiles/<slug>-g<n>.json` stays for DOS; `profiles/nx-<style>.json` for Lemmix); the launcher's profile POST route accepts the new pattern; edit-mode "tagged" marks on lemmix directory rows per style.
2. Engine-neutral object descriptors for `portals.js` (`{kind, x, y, trigger, animation, closedFrame}`) produced by both engines, so entrances/exits/water get doors and bodies in Lemmix levels too.
3. `app.js` status strip: pre-text before start, post-text and postview result line on end, talisman achievements (`lem3d-talismans`); custom per-pack `skill_panels.png` honoured by `panel.js`.

### Phase 8 — Fidelity and polish
`.nxrp` replay importer (verification), `SPAWN_INTERVAL_LOCKED`, `START_X/Y` auto mode, second pass over `LemGame.pas` details (dehoister, reacher, blocker/force-field edge cases, builder brick colour from theme, recolourable sprite sets, exit capacity sanitisation, zombie/neutral counters), minimap region (optional).

---

## Part 4 — Verification

- **Directory and browser (Phase 1)**: `node tools/levels-index.js` produces a tree with 220 classic + 796 lemmix levels, counts per node matching the survey (10 packs / 40 ranks); the launcher's `GET /levels/index.json` equals the file; in the 3D app the worlds button opens on the current level's directory, rows show badge + counts, clearing a level updates its row counts, old `?type=1&group=0&level=3` URL still loads Fun 4, the migrated `lem3d-cleared` records still show as cleared, VR catalog descends/ascends with the beam and thumbstick.
- **Parsing**: `node tools/nx-check.js` — 796/796 files parse, section/key counts equal the survey numbers in 1.3, zero unresolved `style:piece` refs after aliasing.
- **Rendering**: `node tools/nx-render.js --all` writes PNGs; compare a fixed sample of 20 levels against NeoLemmix editor renders; pixel counts of solid/steel/one-way maps recorded as fixtures so later changes are diffed (measure-first, PROJECT.md §6).
- **Ground truth**: a `.nxrp` importer (NeoLemmix 12.x replays are text: per-frame skill assignments, RR changes, nuke) so a solution recorded in NeoLemmix drives `Lemmix.Game`; the level must end with the same result and lemming counts. Sources: the Lemmings Forums pack threads, or NeoLemmix under Wine on this Mac.
- **Physics**: per-action fixture tests in node (no DOM) driving `Lemmix.Game` tick-by-tick on synthetic mini-levels: fall 62 vs 63 px, floater/glider open frames, 12 bricks + shrug frame, basher/miner/digger vs steel and each one-way direction, bomber crater, stoner mask, teleporter key-frame timing, button count → locked exit, pickup count, exit capacity, nuke ordering, spawn cadence at SI 53/4/102 with 2 windows and caps. Then end-to-end: play the intended solution of known easy levels (`Lemmings_Plus_I/Mild/Just_Walk!`, the bricks level `(Also_they_are_ninjas.)`, a teleporter level, a button level, a preplaced-zombie level) and record their replay strings via the `r` dump / `?replay=` as regression fixtures.
- **3D app**: `npx http-server -p 8123 -c-1`, open `3d/?level=LemmingsPlus_All_20201114/levels/Lemmings_Plus_I/Wimpy/Just_Walk!.nxlv`; confirm diorama, doors/water, panel interaction, SFX/music, catalog navigation, VR status strip; run a DOS level afterwards to prove the DOS path is untouched (`git diff --stat js/lemmings.js` empty; a DOS replay still matches).

---

## Part 5 — Risks and open points

- **Physics exactness** is the bulk of the work: `LemGame.pas` is 6 807 lines and the packs are precision puzzles. Budget the port phase by phase and keep fixtures; use `.nxrp` replays as ground truth.
- **Styles version drift**: current styles (2026) may rename/alias pieces vs the 2020 packs; `alias.nxmi` handles most; `nx-check.js` reports the rest. Prefer the 2020-10-29b package if downloadable.
- **Repo size**: +88 MB styles, + music packs, + libopenmpt. Confirm committing is acceptable (option: `.gitignore` them and document the download step in `Doc/PROJECT.md`).
- **Moving the DOS folders** changes the 2D page's asset paths only through `config.json`; `GameView` hardcodes `new GameFactory("./")` and reads `config.json` from the root, so it keeps working. The launcher's static root is unchanged.
- **Panel art**: NeoLemmix's `skill_panels.png` order and icon set must be confirmed against the panel code; `panel_font.png` glyph layout likewise.
- **Side finding, DOS engine**: `ConfigReader` reads `"level.useoddtable"` while `config.json` writes `"level.useOddTable"`, so the odd-table path may never be taken (survey claim, unverified). Not in scope; worth a separate check since it bears on the "high fidelity" DOS goal.
- **Not in scope**: the 2D page's browser, Jumper/Shimmier/Slider/Laserer (enum slots kept), NeoLemmix menus/level-select skins, `-hr` graphics.
