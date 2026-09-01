# Lemmings 3D — validation mode

Desktop 3D rendering of LemmingsJS (Phase 1–2 of the VR plan): the untouched
2D simulation rendered as an extruded Three.js diorama in a normal browser
tab, so the 3D port can be developed and tested without a headset. The same
scene graph, bridge, and input paths will back the WebXR build; only the
camera (orbit controls vs. headset pose) and pointer (mouse ray vs. controller
ray) differ.

## Run

```sh
# from the repo root (one level up from this folder)
npx http-server -p 8123 -c-1
# then open http://127.0.0.1:8123/3d/
# (the original 2D game stays at http://127.0.0.1:8123/)
```

URL params: `?type=1|2` (Lemmings / Oh No! More Lemmings), `?group=N`,
`?level=N`, `?speed=N`, `?replay=<string>` (from the `r` key dump).

## Controls

- drag = orbit, right-drag = pan, wheel = zoom, double right-click = reset
  view (all four also work with the mouse inside a controller-less VR
  session, moving the diorama instead of the camera)
- click a lemming = assign the selected skill; click the panel = exactly the
  original panel (release rate, skills, pause, nuke, speed)
- `space` pause, `n` single tick while paused, `+`/`-` speed, `,`/`.` prev/next
  level, `r` dump the replay string to the console
- `w` (or the "worlds" button) opens the world library: every level of both
  games, grouped by tileset, one miniature tile per level — click any tile to
  jump straight to that level with the piece editor already enabled. A world
  header shows its level count and a green "✔ tagged" mark when a profile
  file exists in `profiles/`. The catalog is cached in localStorage ("rescan"
  rebuilds it); miniatures render lazily as you scroll.
- `e` toggles the piece editor (pauses the sim): click a terrain piece to
  select it — every placement of that piece id highlights — then pick a depth
  class (or `c` to cycle, `auto` to revert to flag defaults); the diorama
  re-meshes live. "export JSON" downloads the profile for `profiles/`; a tag
  applies to the piece id, so it covers every level of the same tileset.

## VR (Phase 4)

The same page is the VR build: an ENTER VR button appears bottom-center when
WebXR is available. In the headset the diorama is scaled to 2.5&nbsp;mm per
game pixel (a 1600&nbsp;px level is a 4&nbsp;m tabletop strip) and placed just
below eye level, 0.9&nbsp;m in front of wherever you are actually standing
and facing (not the room-calibration origin), focused on the level's
intended start area.

- **trigger** — the desktop click: aim the controller ray at a lemming to
  assign the selected skill, or at the skill panel to use it as in the game
  (controller&nbsp;0's ray also drives the highlight ring)
- **grip** — grab and drag the diorama; **both grips** — scale it about your
  hands (0.15×–8×)
- **A/X** (either controller) — recenter: bring the diorama back in front of
  where you are looking right now, at default scale
- **desktop keys while in VR** (handy in mouse-fallback): `v` re-places the
  diorama at your current gaze; `[` / `]` tune the pose yaw correction by 15°
  and re-place (default 0° — kept in case a runtime reports a rotated
  forward axis; a permanent value goes in `vrYawCorrection` in `js/app.js`)
- **no controllers?** The session still runs: a warning sign appears beside
  the play area and the desktop mouse becomes the pointer — aim on the
  mirrored view on the monitor; a glowing dot in the headset marks the aim
  point, and clicks work on lemmings and the panel as on desktop. As soon
  as controllers appear, they take the pointer back automatically.
- the world never moves on its own, so there is no comfort concern

WebXR needs a secure context. Ways to run it:
- over the network: the launcher app (`launcher/`) serves HTTPS by default
  with a self-signed cert — open its external URL on the VR device and
  accept the one-time certificate warning
- desktop, no headset: the Immersive Web Emulator extension in Chrome
- Quest via USB: `adb reverse tcp:8123 tcp:8123`, then open
  `http://localhost:8123/3d/` in the Quest browser (localhost is secure)

Exiting VR restores the desktop camera and scale exactly as they were.

## Architecture (mirrors the VR plan)

- `js/bridge.js` — the sim/scene boundary. `SpriteCapture` is a fake "display"
  handed to the game's own render methods: every `drawFrame`/`drawMask`/
  `setPixel` call is captured and turned into voxel sprites (lemmings,
  objects, countdown numbers, explosion particles) instead of
  software-blitted pixels. Sprites are not flat cutouts: each animation
  frame's opaque pixels are greedy-meshed once into a `SPRITE_DEPTH`-deep
  relief with shaded edge walls (the plan's "characters get volume", §5.5)
  and cached. `HeadlessStage` satisfies the Stage contract for
  `DisplayImage` without a canvas.
- `js/depth.js` — depth compositing (plan §5.1). A per-pixel depth-class
  buffer (backdrop / terrain / relief / overlay) is built by replaying the
  compositor's terrain piece list with the original draw-flag semantics.
  Everything drawn defaults to the terrain slab — in Lemmings nearly every
  drawn pixel is standable ground — and the other classes come only from
  per-tileset JSON profiles in `profiles/` (e.g. `lemmings-g0.json`), tagged
  per piece id in the editor. A reconcile pass enforces depth>0 ⇔
  pixel-solid, so classification can never disagree with collision.
- `js/terrain.js` — destructible extruded terrain. The level's solidity mask
  (which IS the collision data) plus the depth buffer are greedy-meshed per
  32×32-pixel chunk — front/back faces per class at its own Z band, step
  walls where classes of different heights meet — and UV-mapped onto one
  level texture built from `groundImage`.
  `Level.setGroundAt`/`clearGroundAt` are wrapped (every dig/bash/mine/
  explode/build funnels through them) to keep depth + texture in sync and
  mark dirty chunks, re-meshed with a per-tick budget.
- `js/gui.js` — the original skill panel recycled: `GameGui` renders its pixel
  buffer as usual; we upload it as a texture on an in-scene plane and forward
  ray-hit UVs as the mouse events it already listens for.
- `js/vr.js` — WebXR layer: ENTER VR button, session handling, meter-scale
  diorama placement, controller rays feeding the same pick path as the mouse,
  grip drag and two-grip scale on the diorama root.
- `js/app.js` — boot, scene, camera, input, level switching. The sim keeps its
  fixed 60 ms step but is driven from the rAF loop via an accumulator
  (browsers throttle `setInterval` in unfocused windows; the VR build needs a
  rAF-driven fixed step anyway). Lemming positions are interpolated between
  ticks for smooth rendering.

`../js/lemmings.js` is loaded as-is and never modified — all hooks
are instance-level wrappers. `window.__lem3d` exposes `{state, session,
camera, renderer, controls}` for console debugging and automated checks.

## Known gaps / next steps

- No tileset has been hand-tagged yet — the editor exists (`e`), the
  authoring sessions haven't happened. Exported profiles must be saved into
  `3d/profiles/` manually.
- Objects extrude like all sprites but still sit at fixed depths (background
  objects behind the slab, others in front); no shape classes (exit
  interiors, hinged hatches, water shaders) yet.
- `VGASPEC` special levels untested; steel areas and multi-entrance
  behavior inherited as-is from LemmingsJS.
- Audio (music + SFX) plays through the engine's own AdLib/OPL synth
  (`js/audio.js`; "sound" button toggles, persisted). SFX indexes into
  ADLIB.DAT are a best-effort mapping — audition with
  `__lem3d.audio.playSfx(n)` in the console and adjust the `SFX` table.
  No VR spatialization yet.
- Replay-based 2D-vs-3D end-state comparison is manual for now (`r` dump +
  `?replay=`); an automated harness is Phase 0 debt.
- The VR mode is logic-verified (placement math, controller pick path,
  desktop regression) but has not yet been run on real headset hardware; the
  DOM HUD (level name, buttons, editor) is invisible in-headset — in-scene
  equivalents are pending.
