# Plan: a solver for NeoLemmix levels, its solutions stored as replays the player can watch

Repo: `/Users/sebastienbock/claude-workspace/lemmings-vr/LemmingsJS`, branch `landscape` (the Lemmix engine is fully merged there).

## Context

The game plays NeoLemmix (`.nxlv`) levels through the Lemmix engine (`lemmix/js/`), and the player can already record, save, load and watch `.nxrp` replays (Doc/REPLAY_PLAN.md, shipped). What is missing is a way to *find* a solution automatically and hand it to the player as a replay. The user's decisions:

- **Scope**: NeoLemmix levels only (the classic DOS engine has no headless harness and a weaker replay model; later).
- **Best solution** = lexicographic: most lemmings saved, then fewest skills used, then earliest completion frame.
- **Runtime**: a Node batch tool `tools/nx-solve.js` (one level, a prefix, or all 1076 lemmix levels; resumable; `worker_threads`), writing `solutions/<pack path>/<level>.nxrp` and `solutions/index.json`, committed to git so both asset modes serve them. The 3D page fetches them and offers **Watch solution**.
- **Budget**: escalating tiers of 10 s, 2 min, 15 min per level; unsolved levels are recorded as unsolved, never claimed impossible (Lemmings is NP-hard; the search is best-effort within its budget).

### Engine facts the design rests on (verified)

- `tools/lemmix-node.js` loads the engine headlessly (`globalThis.Lemmix`); `tools/nx-run.js` is the harness pattern: `parseLevel` → `LevelBuilder.build(data, styles, {seed: entry.id})` → `new LemGame(level, masks)` → `start()` → `update()` loop; `Lemmix.Replay.serialize(sim, extra)` writes the `.nxrp`. Page and node use the **same seed** (`3d/js/app.js:5751`), and the only RNG is a gadget animation start frame, so a replay solved in node reproduces in the page.
- ~90,000 `update()`/s on a 680×160 level; `saveState()` 0.15 ms, `loadState()` 0.075 ms (`lemmix/js/lemgame.js:327-381`). A state copies `physics` (Uint16, all physics needs) plus the cosmetic `groundImage`/`groundMask` (~3× the size, useless to a solver). `loadState` writes back **into the level's own arrays**: one `LemGame` per worker, strict save/restore.
- **Record-then-apply**: `assignSkillTo(L, skill)` (`:2482`) only records `{type:"assignment", frame, skill, lemIndex, lemId, x, y, dx}` into `recorded[]` after `mayAssign` (`:761`) and `checkSkillAvailable` (`:747`); the next `update()` applies it in `checkForReplayAction` (`:303`, lemming resolved by `lemId` then `lemIndex`); **one assignment per frame** (`doneAssignmentThisFrame`, and `_record` keeps one entry of a type per frame). `adjustSpawnInterval(si)` (`:2227`) records and applies at once; `nuke()` (`:2495`) records. `recorded[]` is **not** in a saved state.
- End tests: `stateIsUnplayable` (`:739`), `isOutOfTime` (`:735`), `result()` (`:2508`). Counters `lemmingsIn/Out/Removed/ToRelease`, `currSkillCount`/`usedSkillCount` by action, `currSpawnInterval` (legal 4..level.spawnInterval, `checkIfLegalSI` `:2216`, not when `spawnLocked`). Hatches open at frame 35; per-frame sound cues in `game.sounds` (`splat`, `glug`, `yippee`, …) are a free event stream.
- `rewind.js` `runUntil(sim, states, stop, maxFrames)`; `shadows.js` shows the single-lemming simulation pattern (`simulateTransitionLem`/`simulateLem` with the physics map put back).
- Page side: `?nxrp=<url>` loads a replay at level start (`app.js:3068-3076`); `game.loadReplayFile(parsed)` (`lemmix/js/game.js:281`) restarts at frame 0 at normal speed; `setReplayBadge(game.replaying)` (`app.js:5563`); `onGameEnd` records a clear (`app.js:3309-3345`); progress `LevelProgress` (`3d/js/library.js:196-263`, localStorage `lem3d-cleared`), catalog tile (`library.js:1031-1043`); hotkey table `3d/js/hotkeys.js:75-78`, dispatch `app.js:5363`. Level ids are tree paths (`NeoLemmix_Introduction_Pack/Skills/Just_Nuke_Them!.nxlv`), `level.url` = `levels/<pack>/…`.
- Serving: the launcher's static fallback serves any path under the repo root (`launcher/server.js:312-326`; `.nxrp` is not in its `MIME` map); `sw.js` only intercepts `neolemmix/` and `levels/`, so `solutions/` goes to the network in static mode too. `.gitignore` excludes `levels/*` and `neolemmix/*`, not `solutions/`.
- Test pattern: `tools/nx-physics-test.js` `makeLevel/makeGame/run` (`:19-54`), a WINDOW gadget mock (`:237-239`), `fingerprint(game)` (`:299-307`).

## Design

### 1. Engine touch-ups (`lemmix/js/lemgame.js`, `lemmix/js/replay.js`)

- `saveState(opts)`: with `opts.physicsOnly`, `groundImage`/`groundMask` are `null`; `loadState` restores them only when present. Gadget scalars and animation frames stay (they drive traps' busy state). Physics reads only `physics`, so the cosmetic drift is confined to the solver process.
- `Replay.serialize(sim, extra)`: `AUTHOR` from `extra.author` when given (else the level's), so a solution file says who made it; `USER` = `nx-solve/<version>`.
- Replay change tracking for the page: `recordVersion` (bumped in `_record` and `loadReplay`) and `cutVersion` (bumped in `cutReplay` when it actually removes an entry). The page rebuilds the action markers when the first changes and disengages replay mode when the second does; no callback plumbing into the sim.

### 2. The solver (`tools/solver/`, engine-only modules, no `fs`)

Every module depends only on `globalThis.Lemmix` and `performance.now()`, in the `(function (root) {...})` style of `rewind.js`, so it can later run in a Web Worker; `worker.js` and `nx-solve.js` are the only node-specific files.

```
tools/solver/world.js       World: one LemGame; save/restore(state, plan), step, assign/setSI/nuke, rollout, hash
tools/solver/events.js      rollout event detection (decision points)
tools/solver/analysis.js    static level analysis: exits, hazards, exit-distance field, maxSavable, feature tags
tools/solver/candidates.js  event → (lemming, skill, frame) candidates; RR and nuke candidates
tools/solver/heuristics.js  score, dead-state and stuck tests, state hashes, TIERS table
tools/solver/solver.js      best-first search with budget, single-lemming seed, best-so-far
tools/solver/optimise.js    improve a found solution toward the objective
tools/solver/verify.js      fresh-game round trip of the .nxrp text
tools/solver/worker.js      worker_threads entry: styles+masks once, then one level per message
tools/nx-solve.js           CLI, pool, index.json, logging
tools/nx-fixtures.js        makeLevel/makeGame/makeGadget/run, extracted from nx-physics-test.js
tools/nx-solve-test.js      solver fixtures
```

**Node / plan model.** A node is the game at frame F before anything is recorded on F: `{frame, plan: Entry[] (all frames < F), state|null (LRU-cached physicsOnly state), parent, saved, lost, alive, toRelease, skillsUsed, endFrame, stuck, score, hash}`. Invariant: `node.plan` is exactly `game.recorded` at F. Materialising a child from `(node, candidate at frame A ≥ F)`: `world.restore(node.state, node.plan)` (or restore the nearest cached ancestor and `step` forward, the plan re-firing through `checkForReplayAction`), `step(A − F)`, record (`assignSkillTo` / `adjustSpawnInterval` / `nuke`; a second assignment wanted on the same frame goes one frame later), `step(1)` to apply it, then child = `{frame: A+1, plan: recorded.slice(), state: save()}` and its rollout. Backtracking is a restore; `cutReplay` is never needed since plans hold no future entries (assert it in `World.assign`).

**Decision points (`events.js`).** A node is evaluated by one *wait rollout*: no further actions until `stateIsUnplayable || gameFinished || isOutOfTime`, a frame cap (`min(timeLimit·17 + 34, 17·60·12)`), or a *stuck* verdict. Per frame, diff each controllable lemming (`!removed && !cannotReceiveSkills`) on `(action, dx, x, y, removed)` and read `game.sounds`, emitting per lemming: `SPAWN`, `LAND`, `FALL` (with the edge x and, from a 24-position ring buffer, the frames at edge − k), `TURN` (wall x, frames at wall − k), `SHRUG`, `WORK_END`, `DEATH` (cause from sounds/bounds, plus its last FALL/TURN anchor), `EXIT`, `TRIGGER` (pickup/button/teleport), and `TICK` every 85 frames without an event. States are snapshotted at event frames during the rollout (physicsOnly) and dropped after expansion. Outcome `{saved, lost, alive, toRelease, endFrame, stuck, solved: saved ≥ needCount}`; with no skills left it is exact.

**Pruning (`heuristics.js`).** Dead when: out of time; `lemmingsIn + aliveControllable + lemmingsToRelease + clonersLeft < needCount`; no skill left and the rollout did not reach `needCount`; stuck with no candidate applicable. *Stuck* = 170 frames with no terrain change, no saved/removed change, nothing to release, no working lemming and a repeating loose hash. Transposition table `Map<exactHash, bestSkillsUsed>`; `exactHash` = FNV-1a 64 over `physics`, per-lemming `(x, y, dx, action, physicsFrame, removed, permanent-skill bits, explosionTimer)`, skill counts, spawn interval, release counters, `buttonsRemain`, gadget `triggered/remainingLemmings`, `currentIteration`; `looseHash` drops the frame and buckets x by 4 px, used to cap frontier duplicates.

**Candidates (`candidates.js`)**, only from a node's events (macro-actions, never per-frame branching), each `{kind: assign|si|nuke, lemId, skill, frame, why, prior}`, skill only if `currSkillCount > 0` and legal at materialisation:
- `FALL` at edge E: BUILDER, PLATFORMER, STACKER, BLOCKER, DIGGER at frames where x = E − k (k ∈ K(tier)); JUMPER at E; FLOATER/GLIDER/SLIDER at the lemming's previous LAND/SPAWN (timing-insensitive).
- `DEATH` by water → SWIMMER early, BUILDER/PLATFORMER/BLOCKER at the anchor; trap → DISARMER early, BLOCKER/BOMBER/STONER at the anchor; fire/offscreen → route change at the anchor (BLOCKER, BASHER/MINER/DIGGER, BUILDER).
- `TURN` at wall W: BASHER, MINER, FENCER, LASERER, CLIMBER (early), JUMPER, SHIMMIER, BUILDER, STACKER at W − k; BLOCKER on the tail lemming (crowd control).
- `LAND`/`SPAWN`: DIGGER, MINER, permanent skills, CLONER; at the first spawn also release-rate candidates. `SHRUG`: BUILDER, WALKER, BASHER, PLATFORMER, STACKER. `WORK_END`: as TURN. `TICK` in a loop: DIGGER/BASHER/MINER/BOMBER at the loop's turn points, BLOCKER.
- Release rate: at the root `SI ∈ {level.spawnInterval, 4, midpoint}` when legal; after a branch's first EXIT, one `SI = 4` candidate (objective 3).
- Nuke: when `lemmingsIn ≥ needCount` and the rollout is stuck or runs > 340 frames past the last save, `nuke` at last EXIT + 1 (ranked below anything that saves more).
- Lemming choice: controllable lemmings ranked by `analysis.exitDist`, deduped by `(x, y, dx, action)`; tier 1 lead + tail, tier 2 up to 4, tier 3 up to 8. Terrain-changing skills go to the lead, blockers to the tail, permanent skills to the event's own lemming. `prior` = template affinity × skill scarcity × lemming rank.

**Search (`solver.js`).** Best-first over *edges* (node, candidate) in a max-heap keyed by parent score + prior, children materialised lazily; frontier capped (beam) and cached states LRU-evicted (nodes keep `plan` + `parent`, so they can be rebuilt). Score = `1000·saved + 300·min(upperBound, needCount) − 120·skillsUsed − 40·lost − 2·leadExitDist/100 − endFrame/500 − 20·stuck`. A solved child updates `best` lexicographically; the search continues until the budget (10 % reserved for optimisation) or a provably optimal result (`saved === maxSavable && skillsUsed === 0`). **Single-lemming seed**: first, with `lemmingsToRelease = 1` after `start()`, the same search scored by that lemming's exit distance finds a hatch→exit skill path; its assignments (lemId `N0`) are pre-loaded as the crowd search's first expansions (≤ 30 % of tier 1's budget, ≤ 15 % of the others'). Tier table:

| | tier 1 (10 s) | tier 2 (2 min) | tier 3 (15 min) |
|---|---|---|---|
| lemmings considered | lead + tail | 4 | 8 |
| K offsets (px before the anchor) | {0, 4} | {0, 2, 4, 8} | {0, 1, 2, 4, 8, 12, 16} |
| skills per event | top 3 | top 6 | all |
| beam (edges) | 64 | 512 | 4096 |
| cached states | 32 | 128 | 512 (scaled down by level area) |
| max plan depth | 4 | 8 | 16 |
| restarts with prior noise | – | – | 3 |

Cost: a rollout ≤ 2000 frames ≈ 20 ms, so ~25–40 ms per expansion: ≈ 300 expansions at tier 1, ≈ 4k at tier 2, ≈ 30k at tier 3. Tier 1 over all 1076 levels on 7 workers ≈ 25 min.

**Optimisation (`optimise.js`)**, each step a full replay from frame 0, accepted only if `(saved, −skills, −frame)` does not get worse: drop each entry last-to-first to a fixpoint (spawn-interval entries too); try `SI = 4` at frame 0 and shifting assignments 1..8 frames earlier (entry `x, y, dx` refreshed); with budget left and `saved < maxSavable`, one expansion layer at each remaining DEATH's anchor.

**Verification (`verify.js`)**: fresh `LevelBuilder.build` with the same seed, fresh `LemGame`, `loadReplay(Replay.parse(text))`, update until the end, mirroring the page's time-out nuke (`game.js:311`): `if (isOutOfTime && !userSetNuking) nuke()`. Result must equal the solver's claim, else `status: "error"` and no file is written. Same as `nx-run --nxrp`.

### 3. Output

- `solutions/<level.url without "levels/", .nxlv → .nxrp>` written after verification (`COMPLETION_FRAME` is then the verified end frame; `TITLE`/`ID` from the level so real NeoLemmix loads it).
- `solutions/index.json`: `{version, generated, solverVersion, levels: {<id>: {status: solved|unsolved|error, file, saved, needed, count, maxSavable, skillsUsed, completionFrame, optimal, tier, elapsedMs, expansions, features[], error?}}}`, rewritten atomically after every level (tmp + rename). `optimal` only when provable (`saved === maxSavable && skillsUsed === 0`).
- Resume rules: skip `solved && optimal`, and any record with `tier ≥ requested`; retry `unsolved`/`error`/non-optimal at a higher tier, replacing the file only when the new result is lexicographically better; `--force` ignores the index.

### 4. CLI `tools/nx-solve.js`

```
node tools/nx-solve.js <level-id | prefix> [--tier 1|2|3|all] [--budget <s>] [--jobs N] [--force]
                       [--verify] [--out <dir>] [--list] [--verbose]
node tools/nx-solve.js <level-id> [--budget <s>] [--nxrp <file>] [--trace] [--events] [--no-index]
```

**One level at a time (the testing mode, built first).** A positional that matches a level id **exactly** (`NeoLemmix_Introduction_Pack/Skills/Just_Nuke_Them!.nxlv`, or the same without `.nxlv`, or a unique case-insensitive substring such as `Just_Nuke`) selects that one level and runs it **in-process** (no worker pool), so a stack trace or a debugger reaches the solver directly. Options of that mode:
- `--budget <s>` any budget (default the tier's); `--tier` still picks the tier's search parameters.
- `--trace`: one line per expansion (`#412 f=1543 lead=N3 BUILDER@1520 why=FALL saved=8/10 lost=1 skills=2 score=…`), the events of the root rollout, every improvement of the best solution, and the optimiser's accepted steps — what tells why a level is not solved.
- `--events`: print the root wait rollout's event list and stop (no search), to check the decision points a level yields before searching it.
- `--nxrp <file>`: write the verified replay there (default `solutions/<path>.nxrp`); `--no-index`: leave `solutions/index.json` alone, for experiments that must not count as the level's record. `--stdout` prints the replay text.
- On success it prints the outcome line and the link to watch it: `http://127.0.0.1:8123/3d/?level=<id>&solution=1` (or `&nxrp=<file url>` when written elsewhere).
- Exit 0 solved, 3 unsolved within the budget, 1 error or a failed verification.

**Batch.** Any other positional is a prefix (as `nx-run`); no positional means every lemmix level. `--tier all` runs the passes in turn on what the previous pass left non-optimal; `--jobs` defaults to cpus − 1; `--verify` re-checks every existing `.nxrp` without solving; `--list` prints the index like `env-gen-all --list`. Pool: one `Worker(solver/worker.js)` per job, styles and masks loaded once per worker, the level built per job (the game mutates it); a worker past `budget × 1.5 + 30 s` is terminated, the level marked `error: timeout`, a new worker spawned. The worker calls the same `solveLevel()` the single-level mode calls. Log lines like `[nx-solve] 17/1076 <id>  solved 10/10 need 8, 2 skills, frame 1543, tier 1, 4.1 s`, a summary, exit 0 / 1 (errors or verify mismatches) / 2 (usage).

**The ladder.** Levels of increasing difficulty to take the solver through, one at a time, in this order (ids under `NeoLemmix_Introduction_Pack/`; the `Skills` rank introduces one skill per level, `Objects_&_Functions` one gadget per level, `Basic_Training_1` combines them; the lemming counts are release / save):
1. synthetic fixture 1 (walk to the exit, 0 skills) — the root rollout alone solves it;
2. one skill each, few lemmings: `Skills/Just_Digging_Into_NeoLemmix` (20/5), `Skills/Let's_Take_A_Bash_At_It!` (30/10), `Skills/A_Float,_A_Glide,_Puts_Any_Abyss_Aside!` (8/6), `Skills/Building_Flat_And_Building_High` (30/5), `Skills/Jumping_Lem_Flash` (2/1), `Skills/Laserslide` (3/2) — the single-lemming seed should solve these;
3. crowd control and two skills: `Skills/Block_And_Blow_In_The_Snow` (25/5), `Skills/Climb_Up,_Hang_On,_Get_Along!` (3/2), `Skills/Fence_&Mine_For_A_Diagonal_Line` (15/5), `Skills/Stacks_And_Stones_Saved_Our_Bones` (20/5), `Skills/Walking_On_The_Cloner_Cliffs` (1/5, cloner: `maxSavable` above the release count), `Skills/Just_Nuke_Them!` (80/8, the nuke candidate);
4. gadgets: `Objects_&_Functions/Up_For_A_Walk_` (40/40, updraft), `Objects_&_Functions/Follow_The_Arrow!` (one-way), `Objects_&_Functions/Pick_Them_Up_And_Push_Them_Down` (pickups), `Objects_&_Functions/Beam_Them_Over` (teleporter), `Objects_&_Functions/Trap_Roulette` (traps), `Objects_&_Functions/Scrap…`/`Basic_Training_1/Scrap_The_Buttons!` (buttons), `Objects_&_Functions/Time_Crime` (100/95, time limit), `Objects_&_Functions/Night_Of_The_Living_Lems` (zombies), `Objects_&_Functions/Neutral_Response` (neutrals);
5. high save requirements and combinations: `Basic_Training_1/Blocker_Rocker` (100/99), `Basic_Training_1/Limited_Release` (100/100), `Basic_Training_1/The_Graveyard` (114/37), `Basic_Training_1/Containment_Breach!` (88/35), then the rest of `Basic_Training_1` in order;
6. `Lemmings_Redux` and `LemmingsPlus_All_20201114` rank 1, then higher ranks.
Each rung is run with `--trace` first at tier 1; a rung that fails goes to `--events` to see whether the missing action is a candidate at all (a heuristic gap) or ranked too low (a scoring gap) before the next rung is attempted. `Doc`'s results section records per rung: tier, expansions, seconds, saved/skills/frame.

### 5. Game integration

- `3d/js/library.js`: `Solutions` beside `LevelProgress`: `load(root)` fetches `solutions/index.json` once (404 → empty), `has(id)`, `info(id)`, `url(root, level)`; called next to `LevelTree.load`. Tile (`:1031-1043`): a `span.lib-solution` "▶ solution" before the star when `has(id)`; CSS beside `.lib-best` in `index.html`. The VR catalog cell gets a small "▶" glyph from the same flag.
- **Replay mode, one notion for the page** (`lemmix/js/game.js`): `engageReplay(kind)` sets `this.replayMode = {kind: "solution"|"attempt"|"file", cutVersion: sim.cutVersion}`; called by `loadReplayFile(parsed, {kind})`, `restartReplay()` (the panel's replay button: kind "attempt"), `loadStateMark()` and the `?nxrp=`/`?solution=1` load. `get replayEngaged()` = `replayMode && sim.cutVersion === replayMode.cutVersion` (the player taking control cuts the replay, which ends the mode by itself; replay-insert mode adds without cutting, so it stays engaged); `cancelReplay()` and a new level clear it. `get watchingSolution()` = engaged with kind "solution". The REPLAY badge keeps NeoLemmix's meaning (actions ahead); the markers below follow `replayEngaged`, which outlives the last action.
- **Solution mode** (`3d/js/app.js`): `watchSolution()` near `saveReplayFile` (`:5237`): fetch the file, `Lemmix.Replay.parse`, `game.loadReplayFile(parsed, {kind: "solution"})`: the level restarts at frame 0 at normal speed with the solution replaying, the badge on, and the markers shown; status "SOLUTION". HUD button `#btn-solution` in the `.btnrow` (`index.html:263-272`), iconised like `btn-restart`, shown only for a lemmix level that has a solution, pressed-state (`aria-pressed`) while `watchingSolution`; pressing it again while engaged restarts the solution from frame 0; taking control (any assignment, release-rate change or nuke) leaves solution mode as it leaves any replay. VR bar tool beside the restart button through `askVrConfirm`; hotkey `watch_solution` in `hotkeys.js` (no default key) dispatched at `app.js:5363`; `?solution=1` routes through the `?nxrp=` path with kind "solution". `onGameEnd` (`:3309`): no `LevelProgress.record` and no talisman write while `game.watchingSolution`; banner "SOLUTION — LEVEL COMPLETE".
- **Action markers on the board** (`3d/js/replay-markers.js`, new, ~250 lines; built in `loadLevel` next to the shadow overlay `app.js:2926`, disposed with the session): while `game.replayEngaged`, every entry of `sim.recorded` is shown on the board **from the start of the replay**, future and past alike, so the whole plan is visible at once:
  - an *assignment* → a marker at the entry's own `(x, y)` (the lemming's feet when the skill was given, stored in the entry) on the lemming plane (`LEMMING_Z + 2`, like the hover ring, in `worldGroup`'s level coordinates): a small pin (a ring of 3–4 px radius on the spot with a short stem up) and, beside it, the **skill's icon** — the panel's own picture of the skill, `panel._skillIcon(name)` (`lemmix/js/panel.js:276`, a 16×23 bitmap drawn from the sprite set, the same the skill button shows), as a billboard sprite 16×23 level pixels, edge-outlined so it reads on any terrain;
  - a *spawn-interval change* → the panel's `icon_rr_plus`/`icon_rr_minus` picture with the new rate as a small number, at the hatch the next lemming comes from (`level.spawnOrder`, entrance trigger rect), stacked when several changes hit the same hatch;
  - a *nuke* → the panel's `icon_nuke` at the centre of the hatches.
  Markers carry their frame; each tick (`syncScene`) compares it with `sim.currentIteration`: **future** ones are drawn translucent (opacity 0.45) with a small countdown of seconds until the action beside the icon, the **next** one to fire pulses, and a **played** one turns solid and stays — the marker never disappears once played, so the past of the replay is readable. A step back (`backFrames`, `restartReplay`) simply flips played markers back to future by the same comparison. The set is rebuilt whenever `sim.recordVersion` changes (a loaded file, a replay-insert addition) and cleared the moment `replayEngaged` turns false (control taken, replay cancelled, level changed): all markers go at once. Icons are canvas textures cached per skill in a `SpriteMaterialCache`-like map; a level with a 300-entry solution stays at 300 sprites plus 300 pins in one group, cheap. Nothing is drawn while the clear-physics overlay is on except the pins (NeoLemmix's clear-physics look is flat), and nothing for the DOS engine (its replay stores no positions). The markers show in the 2D flat view and in a headset the same way, being scene objects.
- `launcher/server.js`: `".nxrp": "text/plain"` in `MIME`. `sw.js`: nothing.

### 6. Tests

- `tools/nx-fixtures.js`: `makeLevel/makeGame/run` moved out of `nx-physics-test.js` (which imports them; must stay green), plus `makeGadget`, `makeWindow`, `makeExit` modelled on the WINDOW mock.
- `tools/nx-solve-test.js` (exit 1 on failure): (1) walk to the exit → solved, 0 skills, optimal; (2) a 40 px gap → exactly one BUILDER at the FALL anchor; (3) a wall → one BASHER, a steel wall → CLIMBER or unsolved; (4) a crowd needing a BLOCKER; (5) water → SWIMMER or BUILDER, trap → DISARMER; (6) determinism: serialize → parse → fresh game gives the same `(saved, completionFrame)` and physics fingerprint; (7) the optimiser removes a redundant DIGGER; (8) an impossible level is `unsolved` in < 5 expansions; (9) two same-frame assignments land on consecutive frames; (10) end to end, skipped without the pack: `nx-solve NeoLemmix_Introduction_Pack/Skills --tier 1 --jobs 2 --out <scratch>` solves the rank, `--verify` passes, `nx-run <id> --nxrp <file>` agrees.

### 7. Docs

This plan lives at `3d/plans/solver-plan.md` (kept in step with the work, with a results section after the first run); `Doc/PROJECT.md` §2.9 checks paragraph and a §2.10 "Solutions" (index schema, watch flow, no clear recorded), tools list in the tree; `README.md` tools block (`node tools/nx-solve.js [prefix] --tier all`, what `solutions/` is).

### Implementation order

1. `lemgame.js` `saveState({physicsOnly})`; `replay.js` author.
2. `tools/nx-fixtures.js` extraction, `nx-physics-test.js` green.
3. `world.js`, `events.js`, `analysis.js`, `heuristics.js`.
4. `candidates.js`, `solver.js`, `optimise.js`, `verify.js`.
5. `nx-solve.js` single-level mode (`solveLevel()`, `--trace`, `--events`, `--nxrp`, `--no-index`); climb the ladder rung by rung, fixing the solver as each rung shows a gap.
6. `nx-solve-test.js` fixtures 1–9.
7. `worker.js`, the batch mode of `nx-solve.js`; fixture 10; tier 1 over `NeoLemmix_Introduction_Pack`, then all packs.
8. Page: `Solutions`, tile marker, replay mode in `game.js` (`engageReplay`, `replayEngaged`, `watchingSolution`), the solution button / VR tool / hotkey / `?solution=1`, `onGameEnd` gate, launcher MIME; then `3d/js/replay-markers.js` and its hook in `syncScene` and `refreshAfterRestore`.
9. Docs; commit `solutions/` from a tier-1 run over everything, tiers 2–3 on the leftovers.

## Verification

- `node --check` on every touched file; `node tools/nx-physics-test.js` unchanged; `node tools/nx-solve-test.js` all green.
- The ladder: `node tools/nx-solve.js <one level> --trace` per rung, each solved before the next is tried; a written `.nxrp` opens in the page through `?level=<id>&solution=1` and completes with the recorded `saved`.
- `node tools/nx-solve.js NeoLemmix_Introduction_Pack/Skills --tier 1` → every level solved; `node tools/nx-solve.js --verify` → 0 mismatches; `node tools/nx-run.js <id> --nxrp solutions/<file>` reports `saved ≥ need` at `COMPLETION_FRAME`.
- Full tier-1 run (`--tier 1`, all levels): report solved / unsolved / error counts and wall time in `Doc/SOLVER_PLAN.md`; `--tier 2` on the leftovers overnight.
- Browser (`npx http-server -p 8124 -c-1`, driven through `window.__lem3d`): a solved level's tile shows "▶ solution"; the solution button loads the replay at frame 0 with the REPLAY badge and the level completes with the recorded `saved`; `lem3d-cleared` is unchanged afterwards; taking control mid-replay clears the badge and a subsequent win records normally; `?solution=1` on a level link does the same; a level without a solution shows no button.
- Markers: on engaging, the marker group holds one pin and icon per recorded assignment plus the hatch markers, all present at frame 0 (count them in the scene); before an action's frame its marker is translucent, after it solid, and it is still there at the level's end; a frame back (`b`) turns the last one translucent again; an assignment by the player (a click on a lemming) removes every marker in the same tick and the badge goes; the panel's replay button on a player's own attempt shows that attempt's markers; the icon beside each pin is the same picture as the panel's button for that skill; screenshots of the desktop view, the flat view and a simulated XR session.

## Risks and open points

- Level features the heuristic handles weakly: teleporters (add receiver edges to the exit-distance field), buttons and locked exits (the button as an intermediate goal), zombies/neutrals (rollout only), cloners (`maxSavable` includes them), time limits (rollout stops at time-out), very long levels (rollout capped at 12 game minutes). Each is a `features[]` tag so unsolved levels are attributable.
- Solutions needing a skill at a frame no event anchors are missed at low tiers; tier 3's K set and TICK sampling narrow that gap. Unsolved ≠ impossible.
- Memory: a state ≈ 2·W·H bytes + ~1 KB per lemming (≈ 1.1 MB on 1600×320 with 80 lemmings); tier 3's cache scales down by level area; lower `--jobs` for tier 3.
- Objective details: "skills used" = Σ `usedSkillCount` (a walker counts, nuke and release-rate changes do not); completion frame = the first frame `stateIsUnplayable` holds (what `COMPLETION_FRAME` writes).


## Results (8 September 2026)

What is built, on branch `solution`: the engine touch-ups, `tools/solver/`
(world, events, analysis, heuristics, candidates, solver, optimise, verify,
worker), `tools/nx-solve.js` in both modes, `tools/nx-fixtures.js` and
`tools/nx-solve-test.js` (30 fixtures, all green; the physics fixtures
untouched at 74), the page's solution mode (button, VR tool, hotkey,
`?solution=1`, no clear recorded) and the action markers
(`3d/js/replay-markers.js`), the docs. Checked in the browser: a solution
loads at frame 0 with the badge and every marker; the countdowns run; a
played marker stays solid; the level completes as "SOLUTION — LEVEL
COMPLETE" with `lem3d-cleared` unchanged; a click on a lemming removes
every marker and the badge in the same tick; the tiles say "▶ solution";
the flat view shows the same markers.

### What the search does, as it stands

Against the plan: the frontier is one heap per depth, the depth with the
fewest pops so far (weighted toward the shallow ones) taking the turn - a
single best-first heap plunged, since a parent that saved two lemmings
outranks the seed whatever its followers' prospects, and a plain rotation
over depths went straight down, every expansion opening a new deeper heap.
Seeds carry their plan in the state hash (else a seeded node hashed like the
root and was dropped as seen). The world runs in replay-insert mode so a
seeded plan's later entries survive an insertion. A pass that runs dry with
time to spare runs again at the next tier's breadth. The lead pass's
rollouts end when the lead is saved or lost, and stop at once when the
target is met with no skill. The nuke is a plan of its own when there is no
skill at all (every ten seconds of the rollout tried) and an option when the
crowd stalls. Every dying lemming gets its own rescue at its own anchor
(a follower dies at the end of the partial bridge, not at the first edge),
unranked lemmings get permanent skills at every event, the lead and tail get
everything. Loop detection keys (x, y, dx, action, animation frame) with
the terrain unchanged. A gadget's `effect` is now part of a saved state -
without it a disarmed trap came back on a restore and a solution failed its
verification.

### The ladder

| rung | level | tier 1 (10 s) |
|---|---|---|
| 1 | synthetic walk / gap / wall / crowd / water / trap fixtures | all solved (`nx-solve-test`) |
| 2 | Just Digging Into NeoLemmix (20/5) | 20/20, 2 diggers |
| 2 | Let's Take A Bash At It! (30/10) | 30/30, 5 bashers |
| 2 | A Float, A Glide (8/6) | 8/8, 8 skills |
| 2 | Building Flat And Building High (30/5) | unsolved: a staircase of builders with no progress signal between them |
| 2 | Jumping Lem Flash (2/1) | unsolved: a chain of eight or more jumps; the exit-distance field pulls the wrong way (it ignores gravity) |
| 2 | Laserslide (3/2) | 3/3, 6 skills |
| 3 | Fence & Mine For A Diagonal Line (15/5) | 15/15, 4 skills |
| 3 | Amphibious Engineer Squad (4/3) | 4/4, 6 skills |
| 3 | Just Nuke Them! (80/8) | 29/80 with the nuke alone |
| 3 | They Can't Mash Us All! (60/6) | 12/60 with a release-rate change alone |
| 3 | Climb Up, Hang On, Get Along! (3/2) | unsolved: the shimmier's moment on the wall is not found (10k refused assignments) |
| 3 | Block And Blow, Stacks And Stones, Cloner Cliffs | unsolved: two- and three-skill combinations whose first step shows no progress |
| 4 | Up For A Walk (40/40, updraft) | 40/40, 2 skills |
| 4 | Split And Splat (60/40) | 51/60, 5 skills |
| 5 | Platstop (5/5), Concentrated Force (50/44) | solved |

Introduction pack, 120 levels: **12 solved at tier 1** (2.6 min on 7
workers), 10 at tier 2 (92 min) - both before the planner; the tier-1
pass over every installed pack (1076 levels) that followed found 62. No
verification mismatch remains.

### Later (8 September, evening)

- **Keep at it** (`repeat` candidates): a terrain skill given again each
  time its job ends, a search node per repetition (three floors dug, not
  four), a fall out of the job waited to its landing, and a variant with a
  dozen pixels' walk between repeats so holes stagger and a crowd drops one
  floor at a time. Found: *You need bashers this time* (a mesh cut link by
  link, 20/20 with 3 skills) and *Snuggle up to a Lemming* (three floors
  dug, two pillars bashed, 20/20 with 4 skills).
- **The lead pass's score**: a skill costs 20 there, not 120, and progress
  weighs twice - the lead pass looks for a way in whatever it costs, the
  crowd pass pays the objective's price. Before this, three digs with no
  visible gain in the exit-distance field lost to any one-skill node.
- A walk sampled every 32 frames for anchors, ranked after the anchored
  moments; the search's memory bounded (a node's events and candidates
  freed once its edges are queued, the frontier per depth capped, a 4 GB
  heap for the launcher's jobs and the batch's workers).

- **One-way walls and steel**: a basher, miner, fencer or laserer into a
  wall the terrain forbids (steel, a one-way wall met from the wrong side)
  and a digger over steel no longer take a candidate slot, so the slot goes
  to a skill that can act (a bomber, a climber). A blocker at its post is
  a `BLOCK` event, with a bomber to free it later as a candidate.
- *Keep your hair on, Mr. Lemming* (Redux, Gentle) stays unsolved and shows
  the limit: the crowd sits left of a one-way-left wall over a steel floor;
  the way through is two climber-floaters over it, a blocker on the far
  side so the second turns back, a basher from the far side (the allowed
  way), then a bomber on the blocker - seven skills, checked by hand
  (20 saved by frame 1070), with no gain the score can see until the
  last two. The lead pass finds the athlete's way in at once; the crowd
  pass does not get there at tier 1 or 2. What it would take: a notion of
  *turning a lemming round* (a blocker as a tool, not a wall) and *a job
  done to be undone* (the blocker freed) - two-step macros the search
  could take as one edge, the way the keep-at-it step does.

### Later (9 September): the region-and-gate planner

`tools/solver/regions.js` gives the search the forward look the
exit-distance field lacks. The terrain (four-pixel cells) is cut into
*regions* - floor a walker crosses on its own, a step up or down at a
time - each with two ends, a wall or a drop, and *gates* out of it: a drop
(free under the splat height, a floater per lemming beyond it), a wall
bashed level, mined down or climbed to its top (steel and the wrong side
of a one-way wall forbid what they forbid), a gap or a rise built across
(k builders for its width and height), the floor dug through, and a
**blocker** standing there - the graph is rebuilt whenever the terrain or
the set of blockers changes, a blocker cutting its floor in two with a
bomber on it as the gate between the halves. A plan is a Dijkstra over
(region, heading): a lemming heading one way reaches that end first; a
gate the other way costs a *turn* (a blocker and a bomber, 2) unless a
wall or a blocker ahead turns it for nothing - and not in the exit's
region, where the exit takes it first.

The plan for everyone (`planAll`): the lemmings grouped by region (those
still to come at the hatch's landing), one lemming first - the *lead*,
tried from every group, the one of the group with the most permanent
skills - through the terrain gates it will open, free for everyone after
it and walked back through the other way (a bash from the far side of a
one-way wall); which gates to open is chosen outright - none, each one,
then greedily one more while the total falls - because the lead's cheapest
way alone (over the wall and back down with its floater, cost 0) is never
the one that digs the crowd's tunnel. Then every group pays its own way,
per-lemming gates by those lacking the skill and closed to a group with
more lacking it than there are of the skill (twenty lemmings and ten
climbers: the climb is not the crowd's way). Only the lemmings still needed
count, the dearest left out.

In the search: the plan's cost is a score term (80 a skill, a level the
graph sees no way through 25), so a blocker set where the plan wants a
turn scores *above* its parent - the crux of every "two-step" - and the
plan's gates boost the candidates that match them (×2.5 the right skill at
the gate's spot and heading, ×2 a blocker in the region that wants a
turn, the bomber on the blocker the plan bombs, a permanent skill on the
lead or on a group that pays it). The trace prints the plan's cost and
lead per node.

Results: *Keep your hair on, Mr. Lemming* - unsolved before at tiers 1
and 2, 24 skills at tier 3 - is solved at **tier 1** (29/30 with 11
skills, four athletes over the wall) and at **tier 2** the by-hand way
(29/30 with 7 skills, 82 s; the blocker bombed is the one lost, so the
30/30 builders' staircase of tier 3 stays the record under the saved-first
objective). Plan costs along the way: 5 at the root, 3 with the second
athlete over, 2 with the blocker set, 1 after the bash, 0 after the
bomber. No regression: the fixtures (25), *Snuggle up* (4 skills), *You
need bashers* (3), *Just Digging* (2), *Fence & Mine* (4), *Up For A Walk*
(2), *Amphibious* (6), all at tier 1. A plan is computed at every node
(the graph cached by terrain version and blocker set); on a 320×160 level
it is a few milliseconds.

Modelled since (9 September, later): **water, fire and traps** as region
ends (their cells are no floor; water swum by a swimmer along the surface
to the bank it climbs out on, a trap walked through by a disarmer and gone
for everyone after, a once-only trap taking one lemming as a half-cost
gate, a repeating trap a gauntlet at a lemming's worth; all crossed above
like a gap), **platformers** (flat, as far as builders), **jumpers** (the
engine's arc: 18 px up over 38 px, a ledge within 5 px of its head hoisted
onto - so up to 5 cells up, across 9), **stackers** up a wall of three
cells, **shimmiers** (a ceiling within 8-13 px of the floor followed its
way, stepping a cell up or down as the hang does, to where it ends - the
fall - or a ledge at hanging height - walked onto - or a wall at head
height - let go), **stoners** cutting a deadly drop into safe pieces for
everyone after, **arrows down and up** (no basher through arrows down or
up, no miner through arrows up), and **slopes** the cells take for walls,
walked at the pixels (six up, three down, a step at a time) into the
region above - the biggest single gain, since every NeoLemmix hill was a
wall before. The permanent-skill boost goes only to the lead (or to a
group whose own step it is); a jumper or shimmier is boosted at its spot.

And after that: **ways to turn round** besides a blocker and a bomber -
a stacker in the lemming's way (1), or a jump into an overhang the region
has (terrain within a jump's height over some cell of it: the engine turns
a jumper that meets a wall mid-air, 1) - the plan's step says which
(`how`) and the candidates of that skill in that region get the turn's
boost; **force fields** as region ends (a lemming against the field is
turned for nothing, one with it walks through); a **climber under a
ceiling** too close over the wall's top (within two cells: no room to
hoist) gets a climb-and-shimmy gate (a climber and a shimmier) along that
ceiling; and the **shimmier's walk as the engine has it** - the ceiling
must stay level (a cell's step up or down in front drops the lemming, so a
toothed ceiling drops it at the first tooth), a ledge two cells under the
ceiling is hoisted onto, a wall at head height lets it go.

*Jumping Lem Flash* is solved with this at tier 2: the plan reads nine
jumps with a turn into the pillar over the long floor (cost 9 from the
hatch), the search lands them in 81 s (1/2 saved, 9 skills; tier 1 runs
out with the plan in hand - each jump is a precise moment). Still
unsolved: *Stacks And Stones* (the wall up to the exit is 92 px; stacks
are 8 px walls and stones 10 px blocks, neither a step a walker climbs -
the level's route is not a staircase and I have not found it), *Climb Up,
Hang On* (with the teeth dropping every shimmier, the way from the
plateau to the exit is not in the graph), *Trap Roulette* (the only
non-steel terrain below the corridor is the level's edge block, which no
gate opens). *Split And Splat* stays at 54/60 with 5 skills, everything
else holds. The blocker itself has no group: a blocking lemming stands in
no region and counts as spent.

### Later (10 September): the plan's leftovers

- **Restarts with prior noise** (tier 3's table promised three): once the
  crowd pass has run dry at the widest breadth with time to spare, the
  search runs again with every prior jiggled by up to ±30 % (a seeded
  generator, so a run repeats), seeded from the root, the lead's way in
  and the best so far, keeping what comes out better; skipped when no
  frontier ever lost an edge to its cap, since it would only repeat itself.
- **A finer sweep along a walk**: the `TICK` sample every 32 frames at
  tier 1, 16 at tier 2, 8 at tier 3 - the timing anchors a jumper or a
  shimmier mid-walk asks for, at the breadth that can afford them.
- **The followers' fate foretold**: a lemming at the very state a
  predecessor was in - spot, way, action, animation frame, fall so far,
  permanent skills, the flipper it is in - with the terrain and the
  blockers unchanged since, nothing pending in the plan and nothing left
  to release, goes where the predecessor went, the physics being
  deterministic; so once every lemming still out is on such a trail to an
  exit (or at the exit), the crowd rollout ends there with the count and
  the end frame foretold. Only a happy end is foretold: a death foretold
  would hide the next lemming's death anchor from the candidates and score
  the branch more harshly than the cap would its siblings (Split And Splat
  went unsolved that way). No foretelling with zombies, traps, teleporters,
  splitters or a counted exit about, and none for a trail walked before the
  plan's last action (the action changed that walker's future - the first
  version foretold thirty saved from the athlete's walk to the wall). The
  trail table is open-addressed over typed arrays: a Map cost a rollout a
  fifth of its time.
- **The planner's route budget**: a plan whose skills, summed over every
  step of every lemming, exceed the stock is no plan (four climbs for one
  lemming with three climbers), where the sweep checked each gate alone.
- **Blockers in the plan**: a blocking lemming is spent - out of the count
  and the groups - unless a walker is in stock, in which case it is a
  lemming of the region beside it and the plan pays a walker for it.

All regressions hold (Keep your hair 29/30 with 11, Snuggle 4, bashers 3,
Up For A Walk 40/40 with 2, Split And Splat 47/60). The fixtures: 53. A
batch over the packs has not been run since the planner landed (the
recorded solutions predate it); it is the next thing to run when the
machine is free for half an hour.

### Later (13-14 September): CindyLand, and what a Gentle level asked for

*CindyLand* (Redux, Gentle: 40 lemmings, save 33, seven of each of eight
skills) was unsolved at every tier. Working out why turned up gaps in the
graph, the candidates and the search, each fixed in turn:

- **An exit under the surface**: the left exit's trigger lies a few pixels
  below the hill it sits on, so the graph never attached it to a region and
  the planner knew only the far exit. The nearest floor cell up to four
  cells above the trigger's bottom is now the exit's region.
- **Walls built up and blown through**: a staircase of builders up a wall
  (one per three cells of height, given the run-up and an open shaft above
  the wall's foot - a builder under a roof meets it at once), a bomber
  through a thin wall, a bomber up through a thin roof (fourteen pixels of
  blast over the feet, the tunnel's own ten counted).
- **Bridges along their line**: a builder's or platformer's bridge is
  walked cell by cell, with headroom, to where it meets terrain (a floor
  above the meeting point is the landing; a wall in the way blocks it - the
  column beside a hill is not built over) or where a builder's last brick
  lets the lemming walk off onto a floor within a safe fall. The old
  bounding-box test invented bridges through columns.
- **The basher's tunnel measured at its height**: a cell over the feet,
  where the tunnel runs, so a hollow at a column's foot is a way out; the
  tunnel's floor stays at the feet, so a hollow higher up is passed under.
- **Tunnels as regions in waiting**: a tunnel a basher would dig into
  bedrock up to steel is a floor of its own once dug, so it is a region
  before the first stroke, reached by the bash and left by a bomber up
  through a thin roof or by a miner's ramp from any floor above within
  reach (two cells along for one down, through plain terrain); ramps are
  walked both ways, so the crowd below gets up one mined from above.
- **The crowd's heading from the hatch**: those still to come face the
  hatch's way, so a route the other way costs a turn - and a blocker at the
  landing gets the turn's boost.
- **The hold**: when the crowd dies past the count's allowance, a blocker
  short of the edge (or the wall) the first death came from, on the lemming
  that died - so the crowd behind it stays put while the way is made - comes
  first among the candidates; modest when no one dies past the allowance
  (it would otherwise bury the mesh level's winning basher).
- **Candidates the plan points at**: a lemming standing where a plan's gate
  is worked gets every template there whatever its rank; the tier's cap on
  skills per event falls after the plan's boost, so a boosted blocker is
  never the fourth template cut; a boosted moment weighs at least 0.8 and
  carries no rank discount; a moment reached from two events keeps the
  better reason; the gate's second skill (the builder of a bash-and-build,
  the bomber of a bash-and-bomb) is boosted at the far wall only; a
  staircase's builder is placed at its run-up, not at the wall; a group's
  permanent-skill boost goes to that group's lemmings only; matches are
  allowed in terrain the node's graph did not know (the tunnel dug in the
  rollout). A node's list is cut to 600, the plan's picks and macros first.
- **The planner's greedy against its own best**: each lead's chain of gates
  climbs against that lead's best, seeded with the crowd's own route (its
  terrain gates in order), one gate per crossing in the ranked list.
- **The crowd term kept as it was**: counting the lost at the level's span,
  or capping the term, both lost *You need bashers* (the mesh is cut link
  by link, and the crowd's mean distance is what shows it); a held crowd is
  told from a dead one by the count bound instead.

CindyLand's plan now reads the intended way from the hatch: hold, bash
into the bedrock, a bomber up through the thin roof under the hill,
two builders up to the ledge over the steel, the exit (cost 4.5). The
search follows it as far as the staircase at tier 2 (81 s: the rollouts
run 60-90 ms with forty lemmings) and not further: tier 3 (810 s, 6051
crowd expansions) ends unsolved too. What stands in the way is ordering,
not budget. Two rules followed from it: **a lemming with a free way out
of its own** - the planner's word, or one that gets out in the node's own
rollout with nothing more done (the athlete that led the way in) - is left
alone: none of the plan's boosts but the turn it wants and its very next
gate, and its ordinary moments weigh little (it stood where the crowd's
gates are worked and drew every boost to its own pointless moves); and
**the plan's next step outranks the ones after it** (3 against 2.5).
With them the plan's per-lemming gates boost the lead only (a crowd
member made an athlete only makes itself the plan's new lead, cheaper on
paper and nothing gained), and the plan's pick worked by a dozen lemmings
one after the other is kept for three of them at three moments each.
Keep your hair improved to the by-hand 7 skills at tier 1 on the way.
Then two more for the search's shape: **the plan scored after the
action** - when the action changed the terrain or the blockers and
nobody died, the plan is computed again at the rollout's end and the
better of the two is the node's (the bash node reads its tunnel at once,
not one node later; the candidates match the gates of both graphs, the
pre-action steps marked so the route below ignores them) - and **the
plan's route as one edge**: a `plan` candidate carries the crowd's route
(its terrain gates in order, by a gate key that survives the graph's
renumbering) and its own first pick; expanded, it works gate after gate,
each by the boosted moment nearest that gate's spot among the child's
candidates, a node per gate, up to four. A bomber's moment must be within
six pixels of its gate's row (the athlete landing on the hill over the
tunnel matched the roof gate from sixteen above).

And one model taken back: **bomb-up**. A bomber under a thin roof does
blow the roof open (the pixels show the crater joining the bowl above),
but the hole is over the walker's head - a ten-pixel step no walker
climbs - so it is no way up and its gates are gone, the bash-and-bomb
with them. What the plan reads for CindyLand now is the intended
solution outright: the lead climbs the column, builds across to the
block, drops down to the hill, mines a ramp down into the tunnel the
crowd bashed, and builds twice up to the ledge; the crowd bashes into
the bedrock, walks up the ramp and the staircase, and exits (cost 6,
plus the hold).

### Later (18 September): CindyLand solved - the two lanes, and what the pixels said

The three mechanisms the level asked for, as planned: **the post-action
plan at the moment the node's own action finished its work** (the
basher's WORK_END, the blocker's BLOCK), with the lemmings as they stood
then, and the cheaper of the two plans the node's - the other's steps
kept, marked, for the boosts; **the route as two lanes**
(`Solver.planRoute`): the crowd's paid gates in order, and before any
crowd step that rides on a gate the lead opens (`via`, set by the
planner), the lead's gates up to that one; a lead gate into a tunnel in
waiting before the crowd's bash that makes it; gates already worked by
the plan's own entries left out (matched by place - an entry's `dx` at a
turn is the way the lemming came); **the plan macro** follows that
route gate after gate from each node's own plan, six at most, and the
boosts go to the route's first gate and the first of the other lane
only (the bash under way drew second bashers before). Pending permanent
skills count in the plan (the athlete-to-be is planned as an athlete);
a climbing lemming belongs to its wall's top; an exit region absorbs
(nothing leads out of it); a climber is not turned by a wall it can
climb; ramps are found both ways, into real regions too, from any floor
to a floor within twelve cells below; the planner's greedy keys its
gates by way as well as by pair; a group's boosted moments are kept by
fit to the gate (the earliest three moments were never the nearest).

Then the pixels overruled two of the planner's ideas. A ramp mined into
an existing tunnel breaks in through the roof and ends ten pixels over
the floor - no walker comes back up (so ramps into real regions must
enter at floor level). A ramp mined before the bash runs down to the
tunnel's floor only over steel: CindyLand's floor under the tunnel is
plain terrain, and the miner keeps going through it and out of the level
- everyone who walked the tunnel fell out at x 973 (so ramps into a
tunnel in waiting need steel under the landing). Neither order of ramp
and bash works here. What works is the classic move the graph had no
gate for: **a raised bash** - one builder's staircase at the pit's wall
lifts the basher six pixels, and the tunnel from the staircase top comes
out level (a step at most) into the notch in the column; from the notch
a plain bash runs level into the bowl; two builders up to the ledge; the
exit. The gate is a **sequence of skills at their spots**
(`gate.sequence`: the builder at its run-up, the basher at the wall, and
where the opening's floor is higher, one more builder from the tunnel's
floor), taken in order by the boosts, the "worked" test and the macro
(`Solver.wantedSkill`); the boost matches an event at the item's spot or
at the gate's wall (the run-up's moment is taken at the wall the lemming
turns at), and the fit is measured to the item's spot.

**CindyLand: 39/40 with 8 skills at tier 2** (82 s, 983 crowd
expansions): the hold, the staircase and the raised bash, the bash from
the notch, the staircase to the ledge, the climber-builder athlete's own
way in. The chain the trace shows is the macro's: hold, BUILDER at the
run-up, BASHER from the staircase top, BASHER from the notch, then the
ledge. The regressions hold (Keep your hair 7, Snuggle 4, bashers 3, Up
For A Walk 2).

**The batch (18 September)**: tier 1 over every installed level with the
planner (`--force`, since every level already carried a tier-1 record;
seven workers ran the machine out of memory at 836 levels - each worker
may take 4 GB - and the rest went on three, 13 min for 264; `--only
<file>` resumes a batch from a list of ids). **75 of 1076 solved** (71
before): four newly solved (Candy Crossing, Classic Techniques, Code
PURPLE, Plethora of Presents), eleven improved (more saved or fewer
skills - The Graveyard 39 with 4 skills instead of 7, Watch Your
Lemmings 71 with 3), no error, 75 verified. Tier 2 over the thousand
unsolved would take a night on three workers. `tools/nx-probe.js` holds the probes this took (the graph,
the picture, the reach, a node's plan and candidates, a plan's rollout, the
pixels) so the next level's diagnosis starts from there.

### Later (19 September): Darkness of the royal family - slits, and a level the lead cannot solve alone

*Darkness of the royal family* (Redux, Gentle: 30 lemmings, save 20,
five of each skill and ten builders) - every lemming walked up the long
slope and died. The pixels showed why: a **one-pixel slit** between the
steel tower and the terrain at x 280, from the slope's top to the level's
bottom, invisible to the four-pixel cells (which read a wall there); two
more slits split the "fins" under the exit. So: a floor cell with a pixel
column whose ground lies more than eight pixels under the floor is no
floor - the region ends there in a drop as deep as the column, bridged by
a builder or a platformer to the floor beyond - a slit being a run of at
most three such columns bounded on both sides by ground at the floor's
level (a ledge's end, where the ground stays deep beyond, is the cells'
own drop; the first version cut a floor cell straddling the hatch's
ledge and lost two drop gates).

Then what the level asks: a **staircase away from a wall** (a lemming
turned at the wall builds back the way it came - three builders from the
cavity floor's top corner up onto the slope under the exit pillar), which
the bridge finder never tried (it built from drop ends only); **the lead
planned from the hatch's landing** at the root, where it has not spawned
yet (the lead pass had no plan at all before); **the plan macro in the
lead pass**; and **a dig shaft deeper than the splat height is deadly for
everyone but the digger** - a floater each for a group, so the crowd's
plan takes the miner's ramp instead (the dig route killed the crowd in
the trace: N17 splatting at the shaft's foot).

With that the crowd plan reads the level at cost 10: a miner's ramp off
the slope, a bridge over the pit, a bridge over the slit onto the plateau,
the trap (a gauntlet), down onto the cavity floor, three builders up to
the slope, a bash through the pillar into the exit. The search's chain at
tier 2 is the right one - blocker at the top, miner, pit bridge - and
fails on two things the pixels show: **a partial bridge is a cliff** (the
crowd diverted by the ramp walks up the unfinished staircase and off its
end - a bridge with a crowd behind it needs a blocker and a bomber, a
macro of its own, unpriced by the plan), and **the slit bridge is a
follower's bridge** (a builder blocked by terrain turns around, as the
engine's `transition(L, WALKING, true)` says, so the one who bridges the
slit from the low side walks back and only those behind cross; the lead
pass can never finish this level alone, and neither can a lane that
expects its builder to go on). Unsolved at tier 2 (962 expansions);
**solved at tier 3: 20/30 with 21 skills** (1087 s - past the 900 s
budget, the optimiser and the verification on top - 13817 lead and 568
crowd expansions), recorded and verified. Twenty-one skills where the
route needs ten: the crowd control (blockers and bombers around the
bridges) the plan does not price, found by the search's breadth alone.

### Later (19 September, evening): guarded bridges, follower-only bridges

The two mechanisms left open above, and what they dragged in:

- **A guarded bridge.** When the route macro takes a bridge gate (a build,
  a platform, a staircase up a wall) and other lemmings walk close behind
  the builder - the same way, within eighty pixels - the one just behind
  is made a blocker a frame before the builder starts, and bombed once the
  bridge stands: the crowd stays held while the route goes on over
  bridges (the next gate another bridge, taken by the same hand as often
  as not) and is let go when the next gate is no bridge or the chain
  ends. On the level's pit bridge the loss went from 29 to 4. The trace
  names the guard (`plan+hold(N5@664)`).
- **A follower-only bridge.** A slit bridge whose far floor stands two
  pixels or more above the near feet blocks the builder's first bricks, and
  a blocked builder turns around (the engine's `transition(L, WALKING,
  true)`): the bridge is for those behind. Such gates are none of the
  lead's to take - not in its route, not in the greedy's order - and a
  group pays them itself. When no lead can reach an exit at all (this
  level), the plan falls back to the groups paying their own way in turn,
  the crowd's group first, what one opens open for the next, under the
  same skill budget.
- With them: a deep shaft is no one's to open for the next group (a
  follower falls it all the same); the lead's whole route opens its
  terrain for the crowd, not only the greedy's chosen gates; the
  post-action plan is taken even when someone died in the rollout (on a
  crowd level someone always has); a staircase away from a wall is
  worked the moment after the turn, facing away (the k-short moments face
  the wall); the fallback plan orders the crowd's group first.

*Darkness of the royal family* at tier 2 now runs the whole cooperative
chain inside one macro edge - hold at the top, miner, guarded pit bridge,
slit bridge, release, the cavity's staircase - and still ends unsolved
(1698 expansions): the branch that reaches the staircase has lost twelve
(dead by count), the other ten with the trap still to pass and none to
spare. The plan prices the trap as a gauntlet at one per group where it
takes five of twenty; a bridge over the trap, or a blocker beside it, is
the next thing the level asks for. **Tier 3 with all this: 20/30 with 14
skills** (814 s, within the budget; 13606 lead and 12348 crowd
expansions), against 21 skills and 1087 s before - recorded and verified.

### Later (20 September): A Beast of a level

*A Beast of a level* (Redux, Gentle: 50 lemmings, save 40, ten of
everything) - a maze of walls along a corridor: the plan reads it at
cost 10 (six bashes, a raised bash, two climbs for the lead; two builders
up the wall for the crowd). The first thing the probes found: **a turn at
a wall got no plan boost** - the wall's foot here is a step whose cell
belongs to the region above, so "in the gate's region" failed for the
very moment a wall gate wants (the basher at the turn, prior 1.0, while a
moment ten pixels short of the wall was boosted). A turn at a wall is at
the wall whatever cell the foot belongs to. With that the crowd pass
chains the route inside the macro (bashes, builders with a guarded hold,
the release) but tier 2 affords 710 crowd expansions with fifty lemmings
a rollout, and the branch seeded with the lead's way in lacks the hold at
the left ledge where the first lemmings fall. **Tier 3: 49/50 with 10
skills** (813 s; 11828 lead and 4520 crowd expansions) - the plan's
cost to the skill - recorded and verified. No mechanism missing here
beyond the turn's boost: a crowd of fifty is a budget question.

### Later (20 September, evening): Where do you see Lemmings? - the cells lie, the pixels decide

*Where do you see Lemmings?* (Redux, Gentle: 30 lemmings, save 28, ten of
everything and twenty builders): a lattice of six-pixel bricks, the hatch
on a ramp at the bottom left, the exit on a bar at the top right. Every
gate the four-pixel cells offered here was wrong at the pixels, and the
lead pass spent its budget on them:

- **A dig shaft judged on cells** landed on a three-pixel ledge of a
  pillar's decoration; the engine's digger goes on while any pixel within
  three of its centre is solid, so the shaft runs down the pillar's side
  and off the level. Dig gates are now checked by that rule (`digShaft`).
- **A ramp judged on cells** did the same; ramps are now dug as the engine
  digs them - the miner's own mask taken out twice a cycle, its tests for
  steel and for the ground gone under it (`mineFrom`, the masks passed
  into the graph) - and a ramp gate stands only where the simulation comes
  out where the cells said.
- **A bridge judged on cells** left a ledge the builder is blocked on at
  the second brick (the bar overhead), and another from a brick the
  builder's head meets a brick twelve pixels up. Every builder's bridge
  from a region's end, and every staircase away from a wall, is now laid
  by the engine's own rules (`buildFrom`: the foot, the head, the brick
  ahead, blocked builders turned back) and walked off to real ground
  (`walkOff`); a builder turned back leaves a follower-only bridge.
- **A staircase from inside a region** (`fromStep` buildup gates): a
  builder given on a step of the floor whose bricks clear a wall's top or
  reach a ledge no bridge from the end does - every fourth pixel tried,
  both ways, the moment found from the walk to the end (the run-up).
- **A six-pixel brick the cells called a wall**: the pixel walk started
  from the floor cell's bottom, inside the brick, and read eight pixels
  of rise; it starts from the ground's real top now.
- **A climber clipped by its own column**: the brick over the ramp's top
  is above the climber's body, and the engine drops a climber whose
  column meets terrain - the climb gate wants that column clear from six
  over the feet to the wall's top, the wall's pixel column found from the
  end cell (the cells put it two pixels off, inside a steel fixture's wall).
- **A bash that takes the wall's top away**: the region beyond the wall
  walked down over it, a brick's step onto the far floor; the tunnel
  leaves the wall's top ten pixels over its floor, no step, and the plan's
  cost-5 route through it was an illusion (plan 10 the moment the bash was
  done). Such a bash now comes out in a region of its own - the far floor's
  part, cut from the region it belongs to (`alias`, for the search's
  region matching) with the gates worked from there.

With the graph honest the plan reads the level at cost 17-18 for one
lemming: a staircase at the column's foot, four builders to the left
structure, four more to the top of the chain-link column, three to the
top row, then a builder or two over each fire pit, and the drop onto the
exit bar - eighteen of the twenty builders. Three things kept the search
from following it:

- **A bridge of several builders** was marked worked after its first
  (the route moved on to a gate the lemming had not reached), and a
  staircase's entry marked the bridge beside it worked (24 px, the other
  way). The worked test wants the entry's way now, and a bridge of k
  builders is worked once k are laid (`bridgeProgress`: the entries on
  its line, its way); until then the boosts match the next builder's spot,
  24 px along and 12 up from the last, so the macro lays them one after
  the other at each SHRUG.
- **A lemming on the bricks is in no region**: planned from the floor
  below, its plan jumped back to 18 mid-bridge. It is planned from the
  bridge's gate now, the builders laid so far off the gate's price (the
  gate chosen by the nearness of the first builder's spot, several gates
  sharing a line).
- **The lead pass's share** (15 % at tiers 2 and 3) is short of an
  eighteen-gate route: it runs on now, up to half the search's time,
  while its cheapest plan still fell within the last third of the share.

Also: the plan is memoised per graph version and situation (the lead
pass asks the same question from the same region hundreds of times), and
a bridge's progress once per node; the profile had the planner's greedy
sweeps and the boost at 40 % and 25 % of a run.

**Still unsolved.** At tier 3 the lead pass (4600 expansions in its
stretched share) lays the staircase, the bridges to the left structure
and to the chain-link column's top and reaches the top row - two nodes
read plan 0 - and gets no further: the bridges over the fire pits want
the builder within a pixel or two of the brick's edge (from four short
the last brick ends over the fire), and a bridge laid from a spot the
sim did not try lands on the next brick's face and is turned back. A
route of eighteen builders where each is a moment of its own is past what
the search can chain with the anchors it has; what the level asks for
next is a builder placed by the pixel (the moment computed from the
gate's own start, not the nearest sampled one) and a crowd held by one
blocker for the whole route. The fixtures gained four (57): the bridge
under a brick, the climber's column, the after-bash region, the six-pixel
step. Regressions hold (CindyLand 39/40 with 8 at tier 2; Keep your hair,
Snuggle, Up For A Walk at tier 1; You need bashers is flaky at ten seconds
on this machine today with the committed solver too).

### What limits the solver now

1. **Routes the graph does not hold.** Stacks And Stones, Climb Up Hang
   On and Trap Roulette: the way through is not one the region graph
   sees, and I could not find it by hand either. The graph is at four
   pixels; what it misses is finer than that or needs a trick (a stack as
   a step for a stoner, a shimmier let go at a chosen tooth).
2. **Timing anchors.** A jump or a shimmy at a precise pixel is found by
   the sweep at tier 2 or 3, not at tier 1 (Jumping Lem Flash takes 81 s).
3. **Cost.** A crowded level's rollout runs to the last spawn and beyond
   unless every lemming is foretold; a stuck crowd is never foretold, so
   the levels where the crowd paces still afford a few hundred expansions
   at tier 1.
