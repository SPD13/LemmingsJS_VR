# Lemmings 3D

Desktop 3D rendering of LemmingsJS (Phase 1–2 of the VR plan): the untouched
2D simulation rendered as an extruded Three.js diorama in a normal browser
tab. It runs in two modes — **play**, the game, which is the default; and
**edit**, the tagging workbench that bills itself as validation mode and lets
the 3D port be developed and tested without a headset. The same
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

The page opens on the world library, at the root of `levels/`, and nothing
plays until a level is chosen there; a level named in the URL loads straight
away instead.

URL params: `?level=<id>` (a level's path in `levels/index.json`, e.g.
`lemmings/0/3` or
`LemmingsPlus_All_20201114/Lemmings_Plus_I/Mild/Just_Walk!.nxlv`; the old
`?type=1|2&group=N&level=N` still name a classic level), `?speed=N`,
`?replay=<string>` (from the `r` key dump), `?nxrp=<url>` (a NeoLemmix
`.nxrp` replay, for a Lemmix level), and the render settings
`?emboss=`, `?smooth=`, `?doors=`, `?skillbar=` and `?edit=` (`1`/`on`/`true` or
`0`/`off`/`false`). Those are normally toggled with the buttons and
kept in localStorage; the URL overrides both, which is how you ask for them
on a headset — its browser is a different machine with its own empty
localStorage, and the buttons are DOM, so they cannot be reached from inside
a session. `?emboss=1&smooth=1` is the usual VR URL.

## Controls

- drag or shift+arrows = orbit, right-drag or arrows = pan, wheel or
  PgUp/PgDn = zoom, Home, double right-click or the crosshair icon =
  reset view (all of these
  also work inside a controller-less VR session, moving the diorama instead
  of the camera)
- click a lemming = assign the selected skill; click the panel = exactly the
  original panel (release rate, skills, pause, nuke, speed)
- on a NeoLemmix level, with a skill selected and a lemming under the
  pointer, a shadow shows what the skill would do: the builder's bricks,
  the basher's, miner's or digger's tunnel, the bomber's crater, the
  jumper's arc and so on, in a contrasting grey over the level
- with the NeoLemmix assets installed the pointer is NeoLemmix's cursor on
  every level: a cross, a square over a lemming, an arrow beside it while
  the direction filter is on (in VR, at the end of the beam)
- the minimap at the panel's right end shows the level, the lemmings as
  green dots and a frame around what is in view; click or drag on it to
  centre the view there, keeping the zoom (in VR, the trigger held on it)
- on a NeoLemmix level the panel ends with NeoLemmix's own four cells:
  replay (the level from the start, paused, your attempt replaying - take
  control at any point and the rest of the attempt is dropped), frame back
  over frame forward (right-click 17 frames, middle-click 85, hold to
  repeat), direction left over direction right (pick only lemmings facing
  that way), clear physics (the level as its physics map: grey terrain,
  darker steel, a blue tint on the one-way walls like the one under the
  pointer, trigger areas in pink, a blocker's fields, an orange mark at each
  hatch's spawn point, lemmings in flat colours - blue, cyan for an athlete,
  reddened under the pointer; key `t`), and load replay (a `.nxrp` file
  picked from the desktop, with a warning first when it names another
  level, then played from the start at normal speed; in a headset the
  button only says to load it from the desktop). An R in the info strip
  and a red REPLAY over the play area (in a headset, above the status
  strip) mean the attempt is
  replaying. Keys: `r` replay, `b` frame back, `n` frame forward, `i`
  replay-insert mode (your actions add to the replay instead of cutting it)
- `space` pause, `n` single tick while paused, `+`/`-` speed, `,`/`.` prev/next
  level, `R` dump the replay string to the console
- the prev, restart and next icons ask before throwing away a level in progress —
  cancel with the button, `Escape`, or a click off the dialog; `Enter` takes
  it. The `,` and `.` keys still jump straight there, since a shortcut that
  stops to ask is no longer a shortcut.
- "mode" (top right, under "3D effects") switches between playing and
  editing. Playing is the game and is
  the default; editing is the tagging workbench — it bills itself as
  validation mode, opens the piece editor, and turns the catalog over to
  tagging status. `?edit=1` selects it too, and pressing `e` enters it, since
  the piece editor is its tool. Remembered in localStorage.
- `w` (or the globe icon) opens the world library, which is also where
  the page starts when its URL names no level (at the root, and without a
  close until a level is picked). It is browsed the way the
  `levels/` directory is laid out: a row per level pack — its name, whether
  it is **classic** (a DOS game) or **lemmix** (a NeoLemmix pack), how many
  levels it holds and how many you have cleared — and, inside a pack, a row
  per rank, then the miniature tiles of that rank's levels. A downloaded
  collection of packs shows as a directory of packs. Click a row to go in, a
  breadcrumb part or "‹ back" to come out; the library opens on the directory
  of the level being played, and where you were is remembered. In a classic
  rank, "order" lays the tiles out either by level number or grouped by the
  tileset each level is built from (the choice is remembered). Playing, a
  tile you have cleared is green and carries your best time, and a row counts
  how many of its levels are done; editing, a world header in tileset order
  shows a green "✔ tagged" mark when a profile file exists in `profiles/`,
  and entering a level opens the editor. Clears are per-browser, in
  localStorage. Classic packs are scanned once for level names and tilesets
  ("rescan" repeats it); miniatures render lazily as you scroll. Levels of a
  NeoLemmix pack play through the Lemmix engine (`lemmix/`), a port of
  NeoLemmix's own mechanics, with NeoLemmix's skill panel in place of the
  DOS one; they need the styles and player assets described in the root
  README under "Levels and assets".
- "3D effects" (top right, under "controls") unfolds the four render
  switches. "3D terrain" toggles colour-keyed relief on the terrain: within a tileset's
  shading of one hue, lighter pixels are pushed up to 4px toward the viewer,
  giving rock and grass real texture. It multiplies the terrain's triangle
  count, so turn it off if the frame rate suffers; individual pieces can
  opt out with "3D shade" in the piece editor, or flip which shades are
  raised with "invert" (some pieces are drawn with dark highlights, so
  darker pixels are the ones standing proud).
- "3D doors" builds the objects that are not flat sprites (`js/portals.js`):
  entrances and exits as real openings, and water given the body its waves
  are the surface of — as wide as the sprite, reaching down to whatever
  ground stops it. Off, they all stay the sprites the original draws and the
  terrain behind an opening is left uncarved. The carve happens as the level
  is built, so toggling this rebuilds the level rather than swapping in
  place.
- "smooth" slopes the relief between neighbouring heights instead of stepping
  them, by averaging the pixel heights that meet at each quad corner (crisp
  at depth-class boundaries and silhouettes); it only changes anything while
  "3D terrain" is on.
- "3D skills bar" extrudes the skill panel's artwork and counters off the
  panel, so they read as embossed; off, the bar is the flat original (a
  hovered button still rises, since that is how the bar answers the pointer).
- `e` enters edit mode and toggles the piece editor (pauses the sim): click a terrain piece to
  select it — every placement of that piece id highlights — then pick a depth
  class (or `c` to cycle, `auto` to revert to flag defaults); the diorama
  re-meshes live. "export JSON" downloads the profile for `profiles/`; a tag
  applies to the piece id, so it covers every level of the same tileset.

All three start on, as does "sound". Pressing a button remembers that choice
in localStorage, so only the settings you actually change are stored and the
rest follow the defaults; the `?emboss=` / `?smooth=` / `?doors=` params above
override both for one load without disturbing what is saved.

Anything you have to deal with holds the clock while it is up: the catalog and
either restart question, in both views. Only what was stopped gets restarted,
so a game you had already paused stays paused, and two of them overlapping do
not resume it between them.

## VR (Phase 4)

The same page is the VR build: an ENTER VR button appears bottom-center when
WebXR is available. In the headset the diorama is scaled to 2.5&nbsp;mm per
game pixel (a 1600&nbsp;px level is a 4&nbsp;m tabletop strip) and placed just
below eye level, 0.9&nbsp;m in front of wherever you are actually standing
and facing (not the room-calibration origin), focused on the level's
intended start area.

- **trigger** — the desktop click: aim the ray at a lemming to assign the
  selected skill, or at the skill panel to use it as in the game. One hand
  points at a time: it alone carries a beam and drives the highlight ring,
  while the other keeps its marker, its grip and its stick. The right hand
  starts with it, and a trigger pull on the other hand takes it over — that
  pull only moves the beam, since until it had one that hand was aiming at
  nothing you could see
- **sound, off the bar's right end** — a mute switch, with a volume slider
  that appears when the beam is on either of them and fades a couple of
  seconds after it leaves (long enough to cross the gap between the two). The
  slider is one surface: point anywhere on it and pull, and it takes the value
  from where the beam lands and keeps following while the trigger is held.
  Both are remembered in localStorage, and the mute switch is the same one the
  desktop speaker icon throws.
- **the row above the toolbar** — eight buttons riding the bar, so they keep
  station with it wherever it is dragged or unpinned to. Rest the beam on
  any of these icons (or a window's close) for a moment and a label says
  what it does. The bar starts in
  the room, unlocked: just below the board, centred on the part of the level
  in front of you, and a recenter (or a level change) puts it back there. At
  the left end the padlock locks it to your head instead, from wherever it
  is hanging, and a second click lets go of it again where it has ended up
  (it never jumps at the click, either way). A bar on the head would sit
  across the catalog or a question, so while one of those is up it is parked
  below the board and comes back to the head, as it was, when the window
  goes; beside it the four-way arrows
  are a grab handle — hold the trigger on them and move your hand to carry
  the bar, locked or not; the board-over-bar icon next to them puts the bar
  back where a session starts it, below the board. Leaving VR puts it back on the head, square in
  front. In the middle, pause, which becomes a play
  triangle once the game is stopped and tracks the clock however it was
  stopped: this button, the panel, the space bar or the catalog. At the right
  end, prev, restart and next, each asking before it throws the level away —
  in a panel in front of your eyes, since a DOM dialog would be invisible in
  here, and while that question is up its two answers are the only things the
  ray can hit. Beside them a globe opens the world catalog.
- **the world catalog** — the headset's twin of the library, in the dialog's
  plane: every level of both games in the order they are played, under a
  heading per difficulty, each tile carrying its miniature, the world it is
  built from and — once you have cleared it — a green ground and your best
  time. It opens on the level you are playing, outlined in yellow. Picking a
  tile enters that level; the close button in its top-right corner leaves the
  game as it was. Like the questions, it owns the ray while it is up, and it
  holds the clock.
- **either thumbstick, while the catalog is up** — scrolls the list, up and
  down. Neither stick pans or tilts the board while it is open, and a press
  that lands on any button no longer drags the board if the hand wanders
  while it is held. The scrollbar down its right edge is a handle too: press
  it to jump there, or hold and move the hand to drag it, which keeps its
  hold even if the beam slides off the bar sideways.
- **trigger + move** — drag the board about: it follows the hand in all three
  axes, so pulling back toward yourself walks it in along Z and pushing away
  sends it out. A click only counts as a click if the hand stayed put, so a
  drag never fires one; a grip overrides it
- **thumbsticks** — the pointing hand's pans the board, the other tilts it
  (yaw about the vertical, pitch about your own horizontal): the same two
  moves as right-drag and left-drag on the desktop, at 0.8&nbsp;m/s and 60°/s
  at full deflection. They swap with the beam, so the pointing thumb always
  pans. With the catalog up, both of them scroll it instead
- **grip** — grab and drag the diorama; **both grips** — scale it about your
  hands (0.15×–8×)
- **the face buttons of the other hand** — the upper one (Y, or B when the
  left hand points) zooms the board in and the lower one (X, or A) zooms it
  out, for as long as it is held. It is a dolly along your line of sight:
  whatever you are looking at stays dead centre and comes closer or
  recedes, wherever the board has been panned to, and the rest grows or
  shrinks with it in perspective.
- **A/X** (the pointing hand) — recenter: bring the diorama back in front of
  where you are looking right now, at default scale. The in-scene windows -
  the world catalog, the restart question, the settings - open centred in
  your view and then stay put in the world rather than riding your head; a
  recenter brings them to the new view too
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
- `js/portals.js` — entrances and exits as real openings (plan §5.4). The
  entrance is a hatch lying flat overhead with two doors hinged along
  its left and right edges: the trapezoid in the artwork is un-projected back
  into a horizontal panel, as wide as the opening is drawn and as deep as the
  terrain slab (its own width would stand it out of both faces of a slab less
  than half as deep). The doors swing on real hinges, their angle
  read from how far each animation frame has the opening revealed. Where the
  opening is comes from the animation too, not the palette: shut, the doors
  cover the hole, so the colours that gain pixels as the hatch opens are the
  landscape's, and the opening is the blob painted in them around the
  commonest one. Reading colours directly does not survive every tileset —
  an opening drawn touching the sprite's edge puts sky on the silhouette,
  where a colour-based reading has to call it frame. Nothing
  else from the sprite is drawn — the rest of it is the same hatch in 2D
  perspective, and rebuilding that as upright pixels only stands a wall
  behind the doors. Each door is a slab one pixel thick, laid down as one
  strip per sprite row so the perspective is undone and the artist's own
  door artwork lands square on a panel that stays flat.
  An exit is built the same way in miniature. The sprites are drawn with gaps
  inside their outline — a skull's sockets, the hollows of an arch — which on
  a flat sprite just let the scenery through; a door is solid, so a gap the
  door encloses is filled and painted from the nearest pixel that was drawn
  (its own texel is blank, and the material's alpha test would cut it away).
  Gaps that reach the outside are real background and stay open. What is left
  is a slab deep enough to hold its own tunnel — a face on the background and a back `PORTAL_FRAME_THICK + depth`
  behind it — so the opening is sunk into the door's thickness rather than
  pushed out behind it as a lump, and the tunnel's floor is simply that back.
  The pixels of frame around the opening fall away into it over
  `PORTAL_FUNNEL_RINGS` pixels, so the way in is a short funnel and not a
  shaft. How far each one falls comes from a chamfer distance transform out
  of the opening, shaped by an S-curve that eases in at both ends — a
  straight ramp leaves a crease where the funnel meets the flat of the frame.
  Corner heights are then averaged from the four pixels meeting at each,
  exactly as the terrain's "smooth" does; that averaging needs a height that
  varies pixel to pixel to have anything to smooth, which is why the distance
  is measured properly rather than counted in whole rings. And
  the walls run from the face down to those same corner heights, meeting
  exactly with no crack at the mouth. The opening is the blue (or blue and green) of the
  sky: properly saturated rather than merely bluest-of-three (stone is shaded
  in cool-tinted near-neutrals), not red-led, and standing clear of red so a
  pale yellow does not read as green. Colour alone still is not enough —
  whole tilesets are built of blue stone, the crystal set most of all — so
  the dent is the connected patch of sky nearest the exit's own trigger box,
  the spot a lemming has to reach to get out. Stray saturated pixels
  elsewhere in the artwork are left alone, and a patch under a few pixels is
  ignored so a lone pixel nearer the trigger cannot win. A door is not
  always one object either — the tilesets stack an exit and its cap as two,
  and only the piece carrying the trigger reads as an opening — so a piece
  abutting an exit along most of a side is built as the same slab at the
  same depth, or the door renders as two halves on two planes. Both carve
  the terrain behind them from
  the render-only depth map, being a hole a lemming really falls through; an
  exit's dent stays well clear of the slab, so carving there would hollow out
  the wall for nothing. Collision is never touched. Which objects are
  openings comes from the profile (`objects.byId[<id>] = {shape, depth}`),
  defaulting to entrances (object id 1) and anything carrying the EXIT_LEVEL
  trigger.
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
  ray-hit UVs as the mouse events it already listens for. The panel is one
  composited bitmap, so the lemming pictures on the buttons are color-keyed
  off the yellow/gray tile dither and extruded 1px for relief; the hovered
  button (and its figure) rises toward the player. The counters text along
  the top gets the same 1px treatment on its light highlights, smoothed into
  a bevel, and is rebuilt whenever the counters change.
- `js/vr.js` — WebXR layer: ENTER VR button, session handling, meter-scale
  diorama placement, controller rays feeding the same pick path as the mouse,
  grip drag and two-grip scale on the diorama root.
- `js/steel.js` — steel areas, which the engine reads and then never uses.
  `LevelReader.steel` has no consumer in lemmings.js, and its parse has x/y
  and width/height the wrong way round besides, so most areas land off the
  level. The ranges are recovered and unpacked properly here, and the digger,
  basher and miner are wrapped on their own instances to stop at them: a
  digger walks, a basher or miner turns round, each with a short clang, and
  no ground is removed on the way. `js/app.js` restates the release loop the
  same way, so a level with several entrances uses all of them in turn
  instead of pouring everything out of the first.
- `js/app.js` — boot, scene, camera, input, level switching. The sim keeps its
  fixed 60 ms step but is driven from the rAF loop via an accumulator
  (browsers throttle `setInterval` in unfocused windows; the VR build needs a
  rAF-driven fixed step anyway). Lemming positions are interpolated between
  ticks for smooth rendering.

`../js/lemmings.js` is loaded as-is and never modified — all hooks
are instance-level wrappers. `window.__lem3d` exposes `{state, session,
camera, renderer, controls}` for console debugging and automated checks.

## Known gaps / next steps

- Only one tileset has been hand-tagged (`profiles/lemmings-g0.json`, seven
  pieces of the dirt set marked backdrop); the other eight fall back to
  "everything is terrain". The editor exists (`e`), the authoring sessions
  have not happened. Exported profiles must be saved into `3d/profiles/`
  manually.
- Objects that are not openings or water still extrude like any sprite, at
  fixed depths (background objects behind the slab, others in front).
- Audio (music + SFX) plays through the engine's own AdLib/OPL synth
  (`js/audio.js`; "sound" button toggles, persisted). SFX indexes into
  ADLIB.DAT are a best-effort mapping — audition with
  `__lem3d.audio.playSfx(n)` in the console and adjust the `SFX` table.
  In VR, SFX are spatialized (HRTF panner at the emitting lemming/entrance's
  diorama position, listener from the headset pose); music stays ambient. The
  distance rolloff is deliberately shallow - the board is a 4m strip an arm's
  length away, and a realistic curve left its far end inaudible under the
  music. The cues are the level's "let's go", the entrance hatch, a press on
  the skill panel, a skill assigned to a lemming, the builder's warning three
  bricks from the end, a skill stopped by steel, the nuke, and the ones that
  are rare by nature (oh-no, explosion, splat, drowning, the exit, a trap).
  The four added last were mapped by measuring every ADLIB track's length and
  spectral centroid rather than by guessing; the numbers are in the table.
- Replay-based 2D-vs-3D end-state comparison is manual for now (`r` dump +
  `?replay=`); an automated harness is Phase 0 debt. Note that two fixes
  below deliberately part company with the 2D page, in the direction of the
  original game: steel stops the destructive skills, and multiple entrances
  release in turn. Replays of levels with either will not match it.
- The piece editor is the one part of the interface with no in-scene
  equivalent: it is a desktop workbench, and edit mode is not offered in a
  headset.
