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

URL params: `?type=1|2` (Lemmings / Oh No! More Lemmings), `?group=N`,
`?level=N`, `?speed=N`, `?replay=<string>` (from the `r` key dump), and the
render settings `?emboss=`, `?smooth=`, `?doors=` and `?edit=` (`1`/`on`/`true`
or `0`/`off`/`false`). Those are normally toggled with the buttons and
kept in localStorage; the URL overrides both, which is how you ask for them
on a headset — its browser is a different machine with its own empty
localStorage, and the buttons are DOM, so they cannot be reached from inside
a session. `?emboss=1&smooth=1` is the usual VR URL.

## Controls

- drag or shift+arrows = orbit, right-drag or arrows = pan, wheel or
  PgUp/PgDn = zoom, Home or double right-click = reset view (all of these
  also work inside a controller-less VR session, moving the diorama instead
  of the camera)
- click a lemming = assign the selected skill; click the panel = exactly the
  original panel (release rate, skills, pause, nuke, speed)
- `space` pause, `n` single tick while paused, `+`/`-` speed, `,`/`.` prev/next
  level, `r` dump the replay string to the console
- "prev", "restart" and "next" ask before throwing away a level in progress —
  cancel with the button, `Escape`, or a click off the dialog; `Enter` takes
  it. The `,` and `.` keys still jump straight there, since a shortcut that
  stops to ask is no longer a shortcut.
- "mode" switches between playing and editing. Playing is the game and is
  the default; editing is the tagging workbench — it bills itself as
  validation mode, opens the piece editor, and turns the catalog over to
  tagging status. `?edit=1` selects it too, and pressing `e` enters it, since
  the piece editor is its tool. Remembered in localStorage.
- `w` (or the "worlds" button) opens the world library: every level of both
  games, grouped by tileset, one miniature tile per level — click any tile to
  jump straight to that level. Playing, a tile you have cleared is green and
  carries your best time, and a world header counts how many of its levels
  are done; editing, the header shows a green "✔ tagged" mark when a profile
  file exists in `profiles/` and entering a level opens the editor. Clears
  are per-browser, in localStorage. The catalog is cached in localStorage ("rescan"
  rebuilds it); miniatures render lazily as you scroll.
- "3D terrain" toggles colour-keyed relief on the terrain: within a tileset's
  shading of one hue, lighter pixels are pushed up to 4px toward the viewer,
  giving rock and grass real texture. It multiplies the terrain's triangle
  count, so turn it off if the frame rate suffers; individual pieces can
  opt out with "3D shade" in the piece editor, or flip which shades are
  raised with "invert" (some pieces are drawn with dark highlights, so
  darker pixels are the ones standing proud).
- "3D doors" builds entrances and exits as real openings instead of flat
  sprites (see `js/portals.js`). Off, they stay the sprites the original
  draws and the terrain behind them is left uncarved. The carve happens as
  the level is built, so toggling this rebuilds the level rather than
  swapping in place.
- "smooth" slopes the relief between neighbouring heights instead of stepping
  them, by averaging the pixel heights that meet at each quad corner (crisp
  at depth-class boundaries and silhouettes); it only changes anything while
  "3D terrain" is on.
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
- **the row above the toolbar** — six buttons riding the bar, so they keep
  station with it wherever it is dragged or unpinned to. At the left end the
  padlock unlocks the bar from your head: it stays where it is hanging in the
  room while you look around, and a second click hands it back to the head
  from wherever it has ended up (it never jumps at the click, either way);
  beside it the four-way arrows are a grab handle — hold the trigger on them
  and move your hand to carry the bar, locked or not. Leaving VR puts it back
  on the head, square in front. In the middle, pause, which becomes a play
  triangle once the game is stopped and tracks the clock however it was
  stopped: this button, the panel, the space bar or the catalog. At the right
  end, prev, restart and next, each asking before it throws the level away —
  in a panel in front of your eyes, since a DOM dialog would be invisible in
  here, and while that question is up its two answers are the only things the
  ray can hit.
- **trigger + move** — drag the board about: it follows the hand in all three
  axes, so pulling back toward yourself walks it in along Z and pushing away
  sends it out. A click only counts as a click if the hand stayed put, so a
  drag never fires one; a grip overrides it
- **thumbsticks** — the pointing hand's pans the board, the other tilts it
  (yaw about the vertical, pitch about your own horizontal): the same two
  moves as right-drag and left-drag on the desktop, at 0.8&nbsp;m/s and 60°/s
  at full deflection. They swap with the beam, so the pointing thumb always
  pans
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
  In VR, SFX are spatialized (HRTF panner at the emitting lemming/entrance's
  diorama position, listener from the headset pose); music stays ambient.
- Replay-based 2D-vs-3D end-state comparison is manual for now (`r` dump +
  `?replay=`); an automated harness is Phase 0 debt.
- The VR mode is logic-verified (placement math, controller pick path,
  desktop regression) but has not yet been run on real headset hardware; the
  DOM HUD (level name, buttons, editor) is invisible in-headset — in-scene
  equivalents are pending.
