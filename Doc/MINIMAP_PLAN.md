# Plan: the minimap, in both engines, for the 3D/VR diorama

## Context

NeoLemmix's skill panel ends in a small overview of the level: the terrain
shrunk down, one green dot per lemming, and a white rectangle marking the part
of the level on screen; clicking (or dragging) on it scrolls the screen so
that point is at its centre. The DOS panel bitmap has the same red-framed box
at its right end, and neither the original `GameGui` nor our 3D toolbar has
ever drawn anything in it. This plan adds the minimap to both engines
(classic and Lemmix) in the 3D/VR app, on branch `lemmix`. The "viewport" in
our case is not a 2D scroll offset but whatever the three.js camera (or the
headset) currently sees of the diorama, so the rectangle is derived from the
camera and grows or shrinks with the zoom, and a click moves the camera
(desktop) or the board (VR) without changing zoom, orbit or scale.

Decisions taken with the user: terrain in the minimap is drawn in the level's
real colours, downscaled, for both engines (not NeoLemmix's flat theme
colour); the Lemmix panel is widened from 320 to 352 px so NeoLemmix's
104×34 window and its 111×38 frame fit after the 15 button cells; Lemmix
levels use NeoLemmix's fixed scale of 8 level px per minimap px and the map
scrolls inside the window when the level is larger than it. Classic levels
use the DOS scale (16 horizontally, 8 vertically: 1600×160 → 100×20), so the
whole level always fits its box. `js/lemmings.js` stays untouched.

## What the code looks like today (findings)

- **DOS panel** (`js/lemmings.js` `GameGui`, 8639+): 320×40 bitmap, 13
  buttons of 16 px (x 0..207), counters strip y 0..15. The status box's red
  border starts at x=207 (`3d/js/gui.js:26-28`); nothing is ever drawn at
  x ≥ 208, y ≥ 16. `GameGui.render()` re-blits the whole bitmap whenever a
  count or the selection changes, so anything painted into the bitmap would
  need repainting every tick. A raw click at x ≥ 208 still reaches
  `handleSkillMouseDown` and clears `game.nukePrepared` (8677), so minimap
  clicks must be intercepted before they are forwarded to the display.
- **3D toolbar** (`3d/js/gui.js` `GuiPanel`): the panel is a unit plane
  scaled to `mesh.scale` with a `CanvasTexture` of the display buffer; all
  input funnels through `onMouseDown/onMouseUp/onDoubleClick(uv)` (597-599)
  via `_uvToPixels`. `_buttonIndexAt` returns null past `GUI_LAST_BUTTON`, and
  every relief/checksum scan stops before the free area, so the slot is
  outside all relief machinery. `_layoutSocket` (392-402) is the panel-pixel
  rect → world transform to copy for a mesh over the slot. `update()` uploads
  the canvas only when `dirty`, i.e. once per sim tick and never while paused
  — a camera-tracking rectangle needs its own mesh and its own refresh.
  `GUI_BUTTONS` is set per session from `game.panelLayout` (13 DOS, 15
  Lemmix); `_applyPlacement` keeps the aspect from the canvas size.
- **Lemmix panel** (`lemmix/js/panel.js`): `PANEL_W = 320`, 15 cells
  (2 RR + 10 skills + pause/nuke/speed = 240 px), the rest black. The base is
  built once in `_buildBase` and re-blitted every `render()`; `layout` is
  handed to `gui.js` as `game.panelLayout`. `PANEL_FILES` omits
  `minimap_region.png` (111×38, a 1 px red frame around black, on disk in
  `gfx/panel/`). `handleMouseDown` treats every x as a 16 px cell.
- **Camera/viewport** (`3d/js/app.js`): no code computes what part of the
  level is visible. Desktop: `PerspectiveCamera(50)` + `OrbitControls`
  (1220); the only recentre primitive is `frameDesktopCamera(level)` (1820,
  target = `screenPositionX + 200`, `height/2`, `TERRAIN_DEPTH/2`). Arrow
  panning (2647-2662) moves `camera.position` and `controls.target` by the
  same offset. VR: the player never moves; `dioramaRoot` (scale
  `VR_PIXEL_SCALE` = 0.0025 m/px, rotated, positioned by
  `placeDioramaForXR` 2331) is translated/rotated/scaled instead
  (`panDioramaBy`, `scaleDioramaAbout`). Level pixel → world:
  `session.worldGroup.localToWorld(new Vector3(simX, simY, z))`
  (`worldGroup` flips y; `sfxPos` 1321 is the existing example).
  `mouseRaycaster` (1972) shows how to unproject NDC through the XR eye camera
  (`renderer.xr.getCamera()`), and `pickWithRaycaster` (1932) converts a hit
  to sim coordinates. `dioramaFocusWorld()` (2100) bypasses the y-flip — do
  not generalise from it.
- **Input plumbing**: desktop `pointerdown/up/move` (2210-2320), VR trigger
  → `actOnPick(p)` panel branch does a synthetic down+up (2463); the
  `scrubbing` mechanism in `vr.js _updateDrag` (376) re-picks every frame
  while the trigger is held (used by the volume slider and the catalog
  scrollbar) and is the way to get drag on the minimap in VR.
- **NeoLemmix reference** (`Doc/neolemmix-src/GameBaseSkillPanel.pas`,
  `LemRendering.pas:216-281`): window 104×34 at `MinimapRect`, frame drawn at
  `(Left−3, Top−2)`; map = `Width div 8 × Height div 8`; lemmings one pixel at
  `(x div 8, y div 8)`, green `$FF00FF00`, zombies red `$FFFF0000`, removed
  skipped; the map is padded 1 px on each side and the view rect
  (`DisplayWidth div 8 + 2` wide) is a 1 px `$FFF0D0D0` frame; the map's
  offset keeps the view rect centred and is clamped to the edges
  (`DrawMinimap` 1055-1073), frozen while the mouse is down on it
  (`fMinimapScrollFreeze`); mouse-move with the button held keeps firing the
  click, leaving the map ends the drag; the click handler (in the
  un-vendored `GameWindow.pas`) centres the screen on `P × 8`, clamped to
  the level.

## Design

### 1. `3d/js/minimap.js` — `MiniMap`, engine-neutral (new file)

```
class MiniMap {
  constructor(gui, game, level, spec, parentScene, resources)
  // spec: { x, y, w, h, scaleX, scaleY }  window rect in panel px + level px per map px
  setViewRect(rect)      // {x0, y0, x1, y1} in level px, or null (unknown: keep the last)
  update()               // called from GuiPanel.update() every rendered frame
  layout()               // place the mesh over the window, from the panel's mesh transform
  contains(px, py)       // panel px inside the window?
  pointToLevel(px, py)   // window px → level {x, y}, undoing pad, offset and scale
  setFreeze(on)          // NeoLemmix's fMinimapScrollFreeze
  markTerrainDirty()
  dispose()
}
```

- **Map canvas** `mapW = ceil(level.width / scaleX)`, `mapH = ceil(level.height / scaleY)`,
  plus 1 px pad on each side (NeoLemmix's `fMinimapTemp`). Rebuilt when
  terrain is dirty: a map pixel takes the ground colour of the first solid
  pixel found in its `scaleX × scaleY` block ("any solid lights the pixel",
  in the level's real colours, from `level.groundImage` and
  `level.getGroundMaskLayer().groundMask` — both engines expose these; see
  `WorldLibrary._drawMiniature` `3d/js/library.js:705` for the RGBA + mask
  read). Background black. Terrain dirtiness: wrap `level.setGroundAt` /
  `clearGroundAt` on the instance, chaining the existing functions, the way
  `terrain.js _hookLevelMutations` and `steel.js` do; rebuild at most once per
  sim tick.
- **View canvas** `spec.w × spec.h` = the texture. Each `update()`: if the
  sim tick, the terrain, the view rect or the scroll offset changed, repaint:
  black, `drawImage(map, offX, offY)`, dots, rect; `texture.needsUpdate`.
  - Dots: one pixel per living lemming at `(x / scaleX, y / scaleY)`, green
    `#00ff00`; red `#ff0000` when `lem.isZombie` (Lemmix). Skip
    `lem.removed || !lem.action` (DOS) / `lem.removed` (Lemmix).
  - Rect: the view rect in map px (`floor(x0/scaleX)`..`ceil(x1/scaleX)`
    inclusive of the pad, like `DisplayWidth div 8 + 2`), 1 px frame in
    `#f0d0d0`, clamped to the padded map.
  - Offset (NeoLemmix `DrawMinimap`): if the padded map is narrower than the
    window, centre it; else `off = -(rectCentre) + w/2`, clamped to
    `[w − mapW, 0]`; same vertically; not recomputed while frozen. For DOS the
    map (102×22 padded) fits the box, so it is simply centred.
- **Mesh**: `PlaneGeometry(1,1)` + `CanvasTexture` (Nearest filters) +
  `MeshBasicMaterial({depthTest:false, depthWrite:false})`, `renderOrder`
  `GUI_ORDER_MINIMAP = 51` (above the panel, below the raised tiles), added to
  the gui's scene (`guiRoot`, so it rides the toolbar). `layout()` uses the
  `_layoutSocket` transform for `(spec.x, spec.y, spec.w, spec.h)` at
  `mesh.position.z + 0.1 * unit`. Geometry/material tracked in `resources`.

### 2. `3d/js/gui.js` — host the minimap and route its input

- In the constructor, after `GUI_BUTTONS` is set: `const spec =
  (layout && layout.minimap) || GUI_DOS_MINIMAP`. Create `this.minimap = new
  MiniMap(...)` in `_ensureMesh` once the buffer exists (the DOS spec's window
  is the red box's interior; measure it from the DOS panel pixels at
  implementation — scan a row of the freshly painted canvas from x=200 for
  the red border — expected about `{x: 209, y: 17, w: 110, h: 22, scaleX: 16,
  scaleY: 8}`; hard-code the measured numbers as `GUI_DOS_MINIMAP`).
- `_applyPlacement`: call `this.minimap.layout()`. `update()`: call
  `this.minimap.update()` before the `dirty` early return. `dispose()`: dispose
  it. New `setViewRect(rect)` forwards to the minimap.
- Input: `onMouseDown(uv)` → pixels; if `minimap.contains(x, y)`: set
  `this.minimapDrag = true`, `minimap.setFreeze(true)`, call
  `this.onMinimapCenter(minimap.pointToLevel(x, y))` and **return without
  forwarding** (no `nukePrepared` reset, no Lemmix cell arithmetic). New
  `onMouseMove(uv)`: while `minimapDrag`, inside → centre again; outside →
  end the drag (NeoLemmix `MinimapMouseMove`). `onMouseUp(uv)`: if
  `minimapDrag` → clear it, `setFreeze(false)`, return; else forward as now.
  `onDoubleClick` on the window: ignore. New `isMinimap(uv)` for app.js.
  `onMinimapCenter` is a property app.js sets.
- `setHover`: unchanged (index null → no raised tile).

### 3. `lemmix/js/panel.js` — make room and describe the window

- `PANEL_W = 352`. Add `"minimap_region"` to `PANEL_FILES`; in
  `loadPanelAssets` keep the per-pack-then-`gfx/panel` fallback (a pack's
  panel folder never ships it; if `gfx/panel/minimap_region.png` is missing,
  synthesise the 111×38 red frame rather than throw).
- `_buildBase`: blit the region at `(n * CELL, 1)` = (240, 1) (NeoLemmix draws
  it at `MinimapRect.Left − 3, Top − 2`), so the window is at (243, 3),
  104×34, flush with the panel's right edge (240 + 111 = 351).
- `this.layout.minimap = { x: 243, y: 3, w: 104, h: 34, scaleX: 8, scaleY: 8 }`.
- `handleMouseDown` / `handleDoubleClick`: return when `x >= n * CELL`
  (defensive; gui.js no longer forwards those).
- `_drawText`: the status text (≈ 24 chars, 192 px) stays clear of x ≥ 240;
  cap the loop at `n * CELL` so a longer pre-text line cannot run under the
  frame. Nothing else reads the free area (`_refreshText` only embosses the
  three relief colours; the frame's red is not one of them, and the map
  lives on its own mesh, so the panel texture never changes for minimap
  reasons).

### 4. `3d/js/app.js` — the viewport rectangle and recentring

- `visibleLevelRect()`: eye = `renderer.xr.isPresenting ?
  renderer.xr.getCamera() : camera` (the XR array camera's projection covers
  both eyes; unproject as `mouseRaycaster` does). Plane: normal
  `(0,0,1)` and point `(0,0,LEMMING_Z)` taken through
  `session.worldGroup.matrixWorld` (`Plane.setFromNormalAndCoplanarPoint`,
  as the VR right-drag pan does at 2263). Cast the four NDC corners
  `(±1, ±1)`; convert hits with `worldGroup.worldToLocal`; fewer than two
  hits (looking away / edge-on) → return null (the minimap keeps its last
  rect); else the bounding box clamped to `[0, width] × [0, height]`. Compute
  once per rendered frame, cache; expose on `window.__lem3d`.
- `currentViewCentre()`: the level point on that plane along the eye's centre
  ray (NDC 0,0); fallback the rect's midpoint.
- `centerViewOn(simX, simY)`: NeoLemmix's clamp — with `rw, rh` the visible
  rect's size, `cx = rw >= width ? width/2 : clamp(simX, rw/2, width − rw/2)`,
  same for y; `delta = world(cx, cy) − world(currentViewCentre())`, both via
  `worldGroup.localToWorld` at `z = LEMMING_Z`. Desktop:
  `camera.position.add(delta); controls.target.add(delta); controls.update()`
  (the arrow-pan idiom — zoom and orbit angle are kept). VR:
  `dioramaRoot.position.sub(delta)` (scale and rotation kept; the world never
  moves). Expose on `window.__lem3d`.
- Wiring: after `new GuiPanel` (1508) set `gui.onMinimapCenter =
  centerViewOn`; in the frame loop before `session.gui.update()` (2788) call
  `session.gui.setViewRect(visibleLevelRect())`.
- Drag on desktop: `pointermove` → if `session.gui.minimapDrag`, pick and call
  `session.gui.onMouseMove(p.panelUv || null)`; `pointerup` already forwards
  `onMouseUp`. A press on the minimap must not start an orbit: `pointerdown`
  returns after `onMouseDown` when `session.gui.isMinimap(p.panelUv)`
  (`vrOrbit` not armed in the mouse-fallback path either).
- Drag in VR: `pickWithRaycaster` tags panel hits inside the window as
  `{ panelUv, minimap: true }`; `actOnPick` for those does `onMouseDown` only
  and returns `{scrubbing: true}`-style continuation via the existing
  `_updateDrag` mechanism (`vr.js:376`), calling `session.gui.onMouseMove(uv)`
  on each re-pick and `onMouseUp` on `_onSelectEnd` (mirror how the volume
  slider does it).
- `layoutGuiPanel` (1750-1817): multiply the panel width by
  `session.gui.canvas.width / 320` on both branches so a panel pixel keeps
  its size (Lemmix: VR 0.6 → 0.66 m; desktop 55 % → 60.5 % of the viewport
  width); check the bar tools laid out from the panel's edges still clear
  the volume switch.

### 5. `3d/index.html`, docs

- Script tag `js/minimap.js` before `js/app.js`.
- `Doc/PROJECT.md` §2.5 (the minimap: what it draws, how the rectangle is
  derived, click/drag, render order 51), the Lemmix table row for `panel.js`
  (352 px), §5 debug handle. `3d/README.md` controls ("click or drag the
  minimap"). `Doc/NEOLEMMIX_PLAN.md` status line: minimap done. Save this
  plan as `Doc/MINIMAP_PLAN.md` (the user keeps plans in `Doc/`).
- Commit on `lemmix`; no assets added to git.

## Verification

Node: `node --check` on the touched files; `node tools/nx-run.js
LemmingsPlus_All_20201114/levels/Lemmings_Plus_I --frames 300` and
`node tools/nx-physics-test.js` still pass (the panel is not in the node
path, but `panel.js` constants are). `git diff --stat js/lemmings.js` empty.

Browser (`npx http-server -p 8124 -c-1`, stop it afterwards; drive with the
Chrome tools, `dispatchEvent` for input, `__lem3d` for numbers):

1. DOS level (`3d/?level=lemmings/0/0`): a `minimap` mesh sits over the red
   box (compare its world rect with the panel's slot); the map canvas is
   100×20 (+pad); dot count equals living lemmings; the drawn rect equals
   `visibleLevelRect()` divided by 16/8. Zoom with PageUp/PageDown → the rect
   shrinks/grows; orbit → the rect follows the projected footprint; Home →
   back to the start rect.
2. Click at map pixel (px, py) → `controls.target.x ≈ px·16` (clamped so the
   rect stays inside the level), `camera.position − controls.target`
   unchanged before/after (zoom and orbit kept); `game.nukePrepared` is not
   cleared by the click; a nuke armed before still fires on the next nuke
   press. Drag across the map → the target follows; leaving the map ends it.
3. Lemmix level 320 wide (`Just_Walk!.nxlv`) and a wide/tall one (a
   1600-wide Lemmings Plus level): panel canvas is 352×40, the frame's red
   pixel at (240,1) and window black at (243,3); `_unit` (metres or units per
   panel px) equals the value before the change (panel pixels unchanged);
   all 15 buttons still hover/click; the 200×20 map scrolls to keep the rect
   centred and clamps at the ends; freezing while dragging; zombies red on a
   preplaced-zombie level.
4. Simulated XR (`Object.defineProperty(renderer.xr, "isPresenting",
   {value:true})` + fake controller, per PROJECT.md §6): `visibleLevelRect()`
   from the XR camera; a trigger press on the window moves `dioramaRoot.position`
   by `−delta` with scale and quaternion unchanged, and the chosen level point
   is afterwards at the previous view centre.
5. Terrain: dig/bash on a DOS and a Lemmix level → the map updates within one
   tick (pixel changes in the map canvas at the dig site).
6. Cost: frame time with the minimap on vs off (`performance.now()` around
   `gui.update()`), expected well under 1 ms; the map rebuild only when
   terrain changed.
7. Screenshots of both panels (DOS and Lemmix) next to `tmp/screenshot.png`
   for a visual match of the frame, dots and rectangle.
