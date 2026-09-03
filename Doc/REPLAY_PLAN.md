# Plan: NeoLemmix's replay, frame-skip and the last panel buttons (Lemmix engine)

## Context

NeoLemmix's skill panel has 19 cells; ours stops after "speed" (15 cells)
and the manual's buttons 15–20 are missing: **replay** (restart the level in
replay mode, paused), **one frame back / one frame forward**, clear physics,
directional select and load replay. The user wants 15–17 with NeoLemmix's
exact behaviour: the level restarts paused and replays the current attempt;
frame back rewinds; the player can take control at any point, which forks the
replay there and erases its future. Decisions taken: **Lemmix levels only**
(the classic panel and engine stay as they are); **draw all 19 cells**, wire
directional select (19) and load replay (20), leave clear physics (18) drawn
but inert.

Research (`Doc/neolemmix-src/`, incl. `GameWindow.pas` fetched for this at the
pinned commit) settled how NeoLemmix does it, and the port follows it:

- **The replay is the authority and a click never mutates a lemming.** A
  player action is *recorded* at the current frame (`RecordSkillAssignment`,
  after `RegainControl`), and the next `UpdateLemmings` applies it through
  `CheckForReplayAction` — live play and playback are one code path. That is
  why a click while paused forces one frame (`fForceUpdateOneFrame`).
- **Taking control = `RegainControl` = `TReplay.Cut(frame)`**: delete
  assignments and nukes at ≥ frame, spawn-interval changes at ≥ frame+1
  (≥ frame if the one on this frame disagrees with the live interval). No-op
  when past the last action or in Replay Insert mode (unless forced).
  "Replaying" is simply `currentIteration ≤ lastActionFrame`.
- **There is no reverse simulation.** `GotoSaveState(target)` loads the
  nearest saved state strictly before the target (or restarts), clears later
  states, then "hyperspeed" runs updates with no rendering or sound until the
  target. States are saved at frame 0 and every 170 frames, thinned to one
  per 10 s in the last minute, per 30 s in the last three, per minute beyond.
  Restart is `GotoSaveState(0)`; back one frame is `GotoSaveState(cur−1)`;
  forward one frame while paused is a forced single update; right/middle
  click on back/forward skip 17/85 frames. Backward skips pause the game.
  Forward skips never cancel the replay; backward ones only if an option says
  so (we keep the replay, as NeoLemmix does by default).
- Saved state = lemming list, physics map, terrain image, zombie map,
  gadget state, counters, skill counts, spawn interval, nuke flags,
  iteration and clock. Not restored: the replay, the selected skill,
  cursor/highlight state; the blocker map is recomputed.
- Panel: `FirstButtonRect = (1,16)–(15,38)`, split cells use the upper half
  y 16..26 and lower y 28..37 (y 27 dead); each split cell's icon is one
  full-cell PNG (`icon_frameskip.png`, `icon_directional.png`,
  `icon_cpm_and_replay.png`); the replay "R" is **a character of the info
  string at column 13** drawn from `panel_icons.png` (cell 0 normal, cell 6
  in insert mode); back/forward auto-repeat when held (250 ms, then 100 ms).
  Standard panel: 416 px wide, `MinimapRect (308,3)–(412,37)`.

Our engine today (`lemmix/js/lemgame.js`): actions are applied immediately
and also pushed to `recorded[]`; a parsed `.nxrp` sits in a separate
`sim.replay` consumed by `checkForReplayAction`; no saved states; the DOS
`CommandManager` executes a command at queue time and logs it by timer tick.
So the port's core is: make `recorded[]` the single replay, applied by
`checkForReplayAction`, add `Cut`, saved states and hyperspeed, then the
panel cells and the 3D layer's refresh after a restore.

## Design

### 1. `lemmix/js/lemgame.js` — one replay, record-then-apply, saved states

- **Replay as authority.** Keep `recorded[]` (`{type:"assignment"|
  "spawn_interval"|"nuke", frame, …}`) as the only replay. `loadReplay(parsed)`
  now *converts* a `Lemmix.Replay.parse` result into `recorded` entries (same
  shape) and drops `sim.replay`. `checkForReplayAction()` reads `recorded`:
  spawn intervals first, then assignments and nukes on `frame ===
  currentIteration`, resolving the lemming by `identifier` then `lemIndex`
  (as now). `Lemmix.Replay.serialize` is unchanged.
- **Record, don't apply.** `assignSkillTo(L, skill)` / `assignSkillAt(x, y,
  skill)`: after `mayAssign` + `checkSkillAvailable`, call
  `regainControl()`, then push the assignment record (one per frame: replace
  a same-frame assignment, like `TReplay.Add`), return true; no
  `doSkillAssignment` here. `nuke()`: `regainControl()` + push `{nuke}` (no
  `userSetNuking` write; applied by `checkForReplayAction`). Spawn-interval
  changes: `regainControl()` + record + apply at once (NeoLemmix's
  `CheckForReplayAction(True)`); the per-frame re-application is idempotent.
  `doSkillAssignment` loses its `fromReplay` recording branch. `getGameState`
  in `game.js` calls `sim.nuke()` on timeout: keep, it records once (`nuke`
  is idempotent on a same-frame record).
- **`cutReplay(frame)`** = `TReplay.Cut` exactly (assignments/nukes ≥ frame;
  spawn intervals ≥ frame+1, or ≥ frame when the one at `frame` differs from
  `currSpawnInterval`). **`regainControl(force)`**: `if (replayInsert &&
  !force) return; if (currentIteration > lastActionFrame) return;
  cutReplay(currentIteration)`. **`get lastActionFrame`** (max frame, −1 when
  empty), **`get replaying`** (`currentIteration <= lastActionFrame`),
  `replayInsert` flag, **`selectDx`** (−1/0/1) honoured in
  `getPriorityLemming` for cursor picks only (not for replay resolution).
- **`saveState()` / `loadState(s)`** per the inventory: every scalar of the
  constructor/`start()` list (iteration, clock, timePlay, the six lemming
  counters, delayEndFrames, particleFinishTimer, nextLemmingCountdown,
  hatchesOpened, buttonsRemain, currSpawnInterval, userSetNuking,
  exploderAssignInProgress, indexLemmingToBeNuked, gameFinished,
  doneAssignmentThisFrame), copies of `currSkillCount`/`usedSkillCount`,
  `talismansAchieved`, the lemmings (a `Lemming.clone()` copying every own
  field except `game`, deep-copying `jumpPositions`; restore re-indexes and
  re-attaches `game`), per-gadget `{remainingLemmings, holdActive, triggered,
  secondariesTreatAsBusy, teleLem, zombieMode, neutralMode, x, y,
  animations:[{frame,state,visible}]}` (keep the `Gadget` objects and their
  caches), and `level.physics`, `level.groundImage`,
  `level.groundMask.groundMask` as `.slice()` copies restored with `.set()`
  **into the existing arrays** (the terrain and minimap hold references).
  After a load: `setBlockerMap()`, `zombieMap.fill(0)`, `sounds = []`,
  `lastBlockerCheckLem = null`, `spawnIntervalModifier = 0`. Not restored:
  `recorded`, `selectedSkill`, `replayInsert`, `selectDx`.

### 2. `lemmix/js/rewind.js` (new) — saved-state list and `gotoFrame`

Node-testable, depends on `LemGame` only:
- `SaveStates`: `add(sim)`, `tidy(current)` (NeoLemmix's keep rule),
  `nearestBefore(target)` (strict `<`), `clearAfter(frame)`.
- `Rewind.gotoFrame(sim, states, target, {silent})`: `target = max(0,
  target)`; if `target !== current` (or always, as `fRanOneUpdate` forces):
  load `nearestBefore(target)` or state 0; `clearAfter(sim.currentIteration)`;
  then hyperspeed `while (sim.currentIteration < target && !sim.stateIsUnplayable)
  sim.update()` synchronously (bounded by target; `sounds` discarded),
  saving a state on every `mod 170` frame passed and tidying. Returns the
  frames simulated. The replay is kept (no cancel option).
- `Rewind.forwardOneFrame(sim)` = one `update()`.

### 3. `lemmix/js/game.js` — the game-side controller

- `this.states = new SaveStates()`; save at construction (frame 0) and in
  `onGameTimerTick` when `sim.currentIteration % 170 === 0`, then `tidy`.
- `restartReplay()` = `gotoFrame(0)` then pause; `backFrames(n)` =
  `gotoFrame(cur − n)` then pause; `forwardFrames(n)`: `n === 1` → one
  `timer.tick()` if paused (so the 3D layer sees a normal tick), else
  hyperspeed to `cur + n` without pausing; `forceOneFrame()` for a paused
  click on the level. After any jump: `gameTimer.tickIndex =
  sim.currentIteration`, truncate `commandManager.loggedCommads` at keys ≥
  tickIndex, `finalGameState = UNKNOWN`, `nukePrepared = false`, panel
  `render(true)`, and fire **`onRestore`** (new `Lemmings.EventHandler`) for
  the page. `loadReplayFile(parsed)`: `sim.loadReplay(parsed)` then
  `gotoFrame(0)` at normal speed. `replayInsert` toggle, `setSelectDx`.
- `checkForGameOver` unchanged; a restored game re-latches if still ended.
- Expose `get replaying()`, `get replayInsert()`, `cursorLemming` (set by the
  page from the hover ring, for the info string).

### 4. `lemmix/js/panel.js` — 19 cells, half-buttons, NeoLemmix info string

- Cells: `[...15 as now, "restart", "frameskip", "directional", "cpmreplay"]`;
  `PANEL_W = 416`; the minimap frame at `(n*CELL + 1, 1)` so the window is
  `(308, 3, 104, 34)` = NeoLemmix's; icons from `icon_restart.png`,
  `icon_frameskip.png`, `icon_directional.png`, `icon_cpm_and_replay.png`
  (add to `PANEL_FILES`, plus `panel_icons.png` and `nolems_message.png` is
  not needed). `layout.buttons = 19`, `layout.minimap` moved.
- `handleMouseDown(x, y, button)`: split cells resolve the half by
  `y <= 26` / `y >= 28` (27 dead). `restart` → `game.restartReplay()`;
  back: left 1 / right 17 / middle 85 → `game.backFrames`; forward: left 1 /
  right 17 / middle 85 → `game.forwardFrames`; dir left/right → sticky
  `selectDx` tri-state with the `skill_selected` highlight on the half;
  clear physics → nothing; load replay → `game.requestLoadReplay()` (the page
  supplies a file picker). Held back/forward auto-repeat: `pressHeld`
  timestamps polled by a new `poll(now)` the page calls every frame (250 ms
  then every 100 ms, left button only); release clears it. Pause and speed
  cells get the highlight while active (NeoLemmix's selectors).
- Info string: port `CreateNewInfoString`/`SetReplayMark` (columns: cursor
  lemming's action 1–12, replay mark 13, hatch icon 15 + out 16–18, lemming
  icon 21 + alive 22–24, exit icon 27 + saved 28–30, clock icon 33 + time
  34–38) with the seven `panel_icons.png` glyphs as characters 38–44; the R
  shows when `game.replaying` (insert mode: cell 6). Cap text at the cells'
  width as now.

### 5. `3d/js/gui.js`, `3d/js/app.js` — input, refresh after a restore, keys

- `GuiPanel.onMouseDown(uv, button = 0)` forwards the button; `onMouseUp`
  clears held state. Hover keeps raising the whole 16×23 cell for split cells
  (NeoLemmix has no hover at all). `_buttonIndexAt` unchanged (19 cells).
- Right-click reaches the panel: in `pointerdown`, before the button-2 pan
  path, if the pick is the panel → `session.gui.onMouseDown(uv, 2)` and
  return; middle button (1) likewise. The double-right-click reset stays for
  clicks off the panel. `layoutGuiPanel` already scales by canvas width
  (416/320).
- **Paused click on the level** (Lemmix engine): after queueing
  `CommandLemmingsAction`, `if (!timer.isRunning()) game.forceOneFrame()`.
- **`session.syncScene()`**: hoist the per-tick 3D work out of the
  `onGameTick` closure (captures, pools, terrain `flushDirty`, hud counters)
  and the SFX memory (`prevActions`, `prevBricks`, `doorSfxPlayed`,
  `trapSfxAt`) into `session`. **`refreshAfterRestore()`** on
  `game.onRestore`: `terrain._refillTexRect(0,0,w,h)` + `texture.needsUpdate`
  + `_rebuildAll()`; depth/relief: the page registers `game.stateHooks =
  {save(s), load(s)}` to keep `depthMap` and `terrain.relief` copies in each
  saved state and copy them back; `lemmingPool.prevPositions.clear()`; reset
  the SFX memory; `lastTickTime = now`, `tickDebt = 0`; `hud.state` cleared,
  `setVrStatus`, `setLevelText(pretext)`; cancel the 3-second auto-advance
  (`endTimeout` handle stored, and the callback checks `finalGameState`);
  `minimap.terrainDirty = true`; `syncScene()` once. Hyperspeed runs
  `sim.update()` directly, so the page's tick handler and `audio.playCue`
  never fire during a jump.
- Keys (Lemmix session): `r` → replay (restart paused); `R` → the replay
  dump that `r` did; `b` → back one frame; `n` → forward one frame (through
  `game.forwardFrames(1)`); `i` → replay insert toggle (`w` is the library).
  The 17/85-frame skips are right/middle click on the panel halves only.
- Load replay: a hidden `<input type="file" accept=".nxrp">` in `index.html`,
  opened by `game.requestLoadReplay`; parse with `Lemmix.Replay.parse`,
  `game.loadReplayFile`. Inert in VR (no file picker).
- Directional select: `game.setSelectDx` from the panel; hover ring and
  picks use `getPriorityLemming`, which now honours it.
- `window.__lem3d`: expose nothing new beyond `session.game` (already there).

### 6. Docs and checks

- `tools/nx-physics-test.js`: new fixtures — (a) record-then-apply: an
  assignment at frame f takes effect in the update of frame f, outcome
  identical to today's fixtures; (b) save/load round trip: run 300 frames
  with actions, `saveState` at 100, continue to 300 and hash the state
  (lemmings x/y/action, physics checksum, counters); `loadState`, replay
  to 300, same hash; (c) `cutReplay` semantics incl. the spawn-interval edge;
  (d) `Rewind.gotoFrame` back and forth equals straight simulation; (e)
  `lastActionFrame`/`replaying`. `nx-run --nxrp/--save-nxrp` round trip
  unchanged; `nx-run` over all 796 levels still 0 errors.
- Docs: `Doc/PROJECT.md` §2.9 (panel row 416 px, `rewind.js` row, the replay
  model in a paragraph), `3d/README.md` controls (buttons, `r`/`R`/`b`/`n`/`i`,
  right/middle click), `Doc/NEOLEMMIX_PLAN.md` status, this plan saved as
  `Doc/REPLAY_PLAN.md`. Commit on `lemmix`, staging only our own hunks
  (another session edits `3d/index.html`/`app.js` concurrently).

## Verification

Node: `node --check` on touched files; `node tools/nx-physics-test.js`
(old 23 + new fixtures); `node tools/nx-run.js LemmingsPlus_All_20201114
--frames 300` (0 errors); `.nxrp` round trip on a played run.

Browser (`npx http-server -p 8124 -c-1`, stop afterwards; drive with
`__lem3d`, `dispatchEvent`, screenshots):

1. Lemmix level: panel canvas 416×40, 19 cells, minimap window at (308,3);
   the four new icons in cells 15–18; panel pixel size unchanged (`_unit`).
2. Play 200 frames with two assignments and an RR change; press replay
   (cell 15): the game is at frame 0 and paused, terrain texture and mesh
   are the initial ones, dots/lemmings gone, the info string shows the R;
   unpause: the same assignments fire on the same frames (compare
   `sim.recorded` and the lemming actions at the recorded frames).
3. Frame back ×3 then forward ×3 while paused: `currentIteration` steps
   1 each way; a digger's hole shrinks/grows in `physics` checksum and the
   terrain texture; right-click back = 17, middle = 85 (dispatch button 2/1).
4. Take control: rewind to frame 120 of a run whose last action is at 180,
   assign a skill: `recorded` has no entry ≥ 120 except the new one, the R
   disappears at 121, and the old action at 180 never fires.
5. Paused click on a lemming advances exactly one frame and the skill is
   applied; the manual's "back two frames to undo" behaviour reproduces.
6. Restart after a FAILED result: the banner clears, no auto-advance
   happens, the level plays again; `tickIndex === currentIteration`.
7. Load a `.nxrp` (set the file input programmatically with a File):
   restarts at frame 0 in replay mode at normal speed.
8. Directional select: with left selected, hovering a right-facing lemming
   gives no ring/pick; VR simulated trigger on the halves picks the right
   action (uv y split).
9. Cost: a `gotoFrame(0)` on a 5-minute run in ms; a save state's size.
