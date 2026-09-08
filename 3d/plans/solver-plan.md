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
