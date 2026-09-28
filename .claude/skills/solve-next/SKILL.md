---
name: solve-next
description: Take the next NeoLemmix level the solver has not solved, run it at tier 1 then tier 2, and when neither finds a solution, work out from the level's structure which capability the solver lacks, then add it as a general tool (not a fix for this one level). Use when asked to "solve the next level", "try the next unsolved puzzle", "what is the solver missing", or to continue the solver work level by level.
argument-hint: "[level name or pack prefix] [analyze]"
---

# Solve the next unsolved level

The solver (`tools/nx-solve.js`, `tools/solver/`) grows one capability at a
time: each unsolved level shows a situation it cannot yet handle. This skill
is one turn of that loop. All commands run from the repo root (the folder
holding `tools/` and `solutions/`).

Arguments: a level name (a unique part of its id) studies that level; a pack
prefix (`Lemmings_Redux/Quirky`, `NeoLemmix`) picks the next unsolved level
under it; nothing picks the next one overall. The word `analyze` stops after
the diagnosis (step 4) with no change to the solver.

Read first, once per session: the last two "Later" sections and "What limits
the solver now" in `3d/plans/solver-plan.md`, and the header comment of
`tools/solver/regions.js`. They say what the planner already models, so you
do not rediscover or duplicate a tool that exists.

## 1. Pick the level

```
node .claude/skills/solve-next/next-unsolved.js [prefix] [--count N] [--after <id>]
```

It follows the packs' order (Redux Gentle first) and skips solved levels
and those parked in `3d/plans/solver-parked.md`. Say which level you took.

## 2. Run tier 1, then tier 2

```
node tools/nx-solve.js "<level id>" --tier 1
node tools/nx-solve.js "<level id>" --tier 2      # only if tier 1 failed
```

- One level at a time, one run at a time, never a batch and never two runs
  side by side: the budget is wall-clock (10 s, 120 s) and a loaded machine
  makes runs fail that would pass.
- Exit code 0 = solved (the replay and `solutions/index.json` are written,
  the solution already verified through a fresh game), 3 = unsolved,
  1 = error. An error is a bug to fix before anything else.
- Tier 3 is not part of this skill. Do not run it unless the user asks.

**If it solves:** report saved/needed, skills, tier and the "watch it" URL,
then take the next level (`--after <id>`) and repeat from step 2. Stop at the
first level that fails both tiers; that is the level under study.

## 3. Look at the level before the trace

Build your own idea of the intended solution first, then see where the
solver departs from it.

```
node tools/nx-render.js "<level id>" --out <scratchpad>    # the picture; Read the PNG
node tools/nx-solve.js "<level>" --events                   # size, counts, skills, features, what the crowd does untouched
node tools/nx-probe.js pic "<level>"                        # cells: # solid, S steel, ~ water, ! hazard, letters regions, H hatch, E exit
node tools/nx-probe.js graph "<level>"                      # regions, their ends and gates, each lemming's plan
node tools/nx-probe.js reach "<level>"                      # regions one lemming reaches with the level's skills
```

Write down, in a few lines: where the hatch(es) and exit are, the skills and
their counts, how many must be saved of how many, what kills or stops the
untouched crowd, and the route a player would take (which skill, where, in
which order, and how the crowd is held or follows).

## 4. Find where the solver loses the route

Work down this list; the first "no" is the diagnosis.

1. **Does the graph hold the route?** In `graph`, is there a chain of gates
   from the hatch region to the EXIT region that matches the player's route?
   `reach` missing the exit region, or a `plan none`, means a gate is
   missing or wrongly refused. Check the spot at the pixels
   (`nx-probe pixels <level> x0 x1 y0 y1`): the cells are 4 px, and what
   they hide (a slit, a lip, a 1-px step) is a common cause.
   `NX_PLAN_DEBUG=1` makes the planner say what it tried.
2. **Is the plan affordable and sane?** `nx-probe plan "<level>"`: a plan
   exists but costs more skills than the level gives, takes a detour, or
   picks a lead that cannot do the job.
3. **Does the search get the candidate?** Run
   `node tools/nx-solve.js "<level>" --tier 1 --trace --no-index` and find
   where the plan cost stops falling. Then
   `nx-probe cands "<level>" '<plan json>' '<regex>'` at that node: is the
   action the route needs among the candidates, at the right lemming and
   frame (or pixel), with a prior that lets it be popped?
   `NX_CAND_DEBUG=<lemId>` shows what each event yields.
4. **Does the action do what the planner believed?**
   `nx-probe chain "<level>" '<plan json>' [lemId]` replays a plan: a
   builder that stops short, a basher that turns on steel, a lemming that
   dies after the gate. The planner's model and the engine disagree.
5. **Is the lead through but the crowd lost?** The followers fall, drown,
   turn back, or arrive before the way is open: a crowd-handling tool is
   missing (hold, guard, release timing, a second worker).
6. **Only budget?** The route is found piece by piece but time runs out:
   the expansions are too dear (long rollouts) or too many (priors too
   flat). This is a cost problem, not a missing tool.

State the diagnosis as one sentence of the form *"the solver has no way to
<do what> when <structural situation>"*, e.g. "no gate for a miner's
diagonal through a wall whose far side is lower than the near floor". If you
cannot find the player's route yourself after an honest try, say so and park
the level (step 7) rather than guess.

With `analyze`, stop here and report: the level, both tier results, the
route, the diagnosis, the proposed tool, and which other unsolved levels
likely share it (same features in `nx-solve --list`, similar pictures in
`../nx-render/` when present).

## 5. Design the tool as a general one

The test of generality: **describe the tool without naming the level.** It
must be triggered by structure the solver can detect anywhere (geometry at
the pixels, gadget kinds, skills in the panel, crowd state), never by a level
id, a coordinate, a frame number, or a constant tuned until this one level
passes.

- Put it where its kind lives: a new way through terrain = a gate kind (or a
  relaxed refusal) in `regions.js`, checked at the pixels by the engine's own
  rules (as `buildFrom`/`mineFrom`/`digShaft` are); a new moment to act = an
  anchor in `events.js` and a candidate in `candidates.js`; a crowd device
  (hold, guard, late bomber) = a candidate kind with its prior; a judgement =
  `heuristics.js`. Extend an existing gate or candidate before adding a new
  kind.
- Derive every threshold from the engine (splat height, builder brick count
  and rise, jump arc, mask sizes in `lemmix/js/`), not from the level.
- Think of two other shapes of the same situation (mirrored, taller, with
  steel below, with water after) and make sure the tool covers or cleanly
  refuses them.
- Keep tier 1 cheap: a new gate kind that multiplies routes, or a candidate
  that fires on every event, costs every level. Bound it.

If the change is large (a new planner concept, more than about 150 lines, or
a change to how costs compare), tell the user the diagnosis and the design in
a few lines before writing it. Otherwise go on.

## 6. Implement and prove it

1. Add a synthetic fixture that isolates the situation (`tools/nx-fixtures.js`
   helpers, a check in `tools/nx-solve-test.js`): the smallest level where the
   old solver fails and the new one succeeds. This is what keeps the tool
   general and alive.
2. Implement. Match the surrounding code's style and comment density.
3. `node tools/nx-solve-test.js --quick` must pass.
4. Run the level under study at tier 1, then tier 2. If still unsolved, go
   back to step 4 with the new trace: levels often need two tools, and the
   second shows only once the first works. After two rounds without a
   solution, stop and report rather than pile on changes.
5. Regression: re-run, one at a time with `--no-index`, three to five solved
   levels that use the code you touched (same skills or features; take them
   from `node tools/nx-solve.js --list`), at the tier the index records for
   them, tier 3 ones excepted unless the user agrees (15 min each). Tier-1
   results are timing-flaky: before calling a regression, compare with a run
   on the stashed tree (`git stash`, run, `git stash pop`).
6. Try the tool's reach: run at tier 1 the two or three unsolved levels you
   named as sharing the situation. A tool that solves only its own level is
   suspect; say so if that is the case.

## 7. Record

- Add a "Later (<date>): <level> - <the tool in a few words>" section to
  `3d/plans/solver-plan.md` in the style of the ones there: the situation,
  what was missing, what was added and where, what it solved, what remains.
  Update "What limits the solver now" when it changed.
- A level given up on goes in `3d/plans/solver-parked.md` (create it if
  absent) as a line ``- `<level id>` - <date>: <diagnosis, what was tried>``
  so the next run moves past it. Unpark levels a new tool might now reach.
- Do not commit unless asked. New solutions under `solutions/` and the index
  are part of the change.

## Report

End with: the level(s) run and their tier-1/tier-2 results; for the level
under study the route, the one-sentence diagnosis, the tool added (files,
the fixture's name), the results after (the level, the regression levels,
the sibling levels), and what is still open.
