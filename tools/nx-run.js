#!/usr/bin/env node
"use strict";
/**
 * Run NeoLemmix levels headlessly through the Lemmix physics with no input
 * (or a replay), and report what happened: how many lemmings came out, were
 * saved, were lost, at which frame the level ended, and any exception. A
 * sweep over every level exercises every gadget the packs use.
 *
 * Usage: node tools/nx-run.js [level-id-prefix] [--frames N] [--replay "<ticks=cmd&...>"]
 */
const { Lemmix, nodeIO, findRepoRoot, listLevels } = require("./lemmix-node");
const fs = require("fs");
const path = require("path");

async function main() {
  const args = process.argv.slice(2);
  const framesIdx = args.indexOf("--frames");
  const frames = framesIdx >= 0 ? parseInt(args[framesIdx + 1], 10) : 1500;
  const replayIdx = args.indexOf("--replay");
  const replay = replayIdx >= 0 ? args[replayIdx + 1] : null;
  const prefix = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--frames" && args[i - 1] !== "--replay");
  const repoRoot = findRepoRoot();
  const io = nodeIO(repoRoot);
  const styles = new Lemmix.StyleManager(io);
  const masks = await Lemmix.loadMasks(io);
  const levels = listLevels(repoRoot, prefix);
  if (!levels.length) { console.error("no levels match " + prefix); process.exit(1); }
  const t0 = Date.now();
  let failures = 0;
  for (const entry of levels) {
    let line = entry.id + "  ";
    try {
      const data = Lemmix.LevelBuilder.parseLevel(fs.readFileSync(path.join(repoRoot, entry.url), "utf8"));
      const level = await Lemmix.LevelBuilder.build(data, styles, { seed: entry.id });
      const game = new Lemmix.LemGame(level, masks);
      game.start();
      // a replay in the DOS command string: "<tick>=l<lemming>" or "s<skill index>"
      const commands = {};
      if (replay) {
        for (const part of replay.split("&")) {
          const [tick, cmd] = part.split("=");
          commands[+tick] = cmd;
        }
      }
      let ended = -1;
      const actions = {};
      for (let f = 1; f <= frames; f++) {
        const cmd = commands[f - 1];
        if (cmd) {
          if (cmd[0] === "s") game.setSelectedSkill(game.activeSkills[+cmd.slice(1)]);
          else if (cmd[0] === "l") game.assignSkillTo(game.lemmings[+cmd.slice(1)], game.selectedSkill);
          else if (cmd[0] === "n") game.nuke();
        }
        game.update();
        for (const L of game.lemmings) if (!L.removed) actions[Lemmix.ACTION_NAMES[L.action]] = (actions[Lemmix.ACTION_NAMES[L.action]] || 0) + 1;
        if (game.stateIsUnplayable) { ended = f; break; }
      }
      const seen = Object.keys(actions).sort().join(",");
      line += JSON.stringify({ out: game.lemmingsOut, saved: game.lemmingsIn, removed: game.lemmingsRemoved,
        toRelease: game.lemmingsToRelease, ended, need: level.needCount, count: level.releaseCount, seen });
    } catch (e) {
      failures++;
      line += "ERROR " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e);
    }
    console.log(line);
  }
  console.log(levels.length + " levels in " + ((Date.now() - t0) / 1000).toFixed(1) + " s, " + failures + " errors");
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(2); });
