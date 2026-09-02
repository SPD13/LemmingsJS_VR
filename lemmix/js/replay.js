"use strict";
/**
 * NeoLemmix replays (.nxrp), as LemReplay.pas reads and writes them: a
 * header (TITLE, AUTHOR, GAME, GROUP, LEVEL, ID, VERSION, USER,
 * COMPLETION_FRAME) and one $ASSIGNMENT, $SPAWN_INTERVAL or $NUKE section
 * per action, each with the FRAME it happens on. An assignment names its
 * lemming by LEM_IDENTIFIER (the "N<n>", "P<x>.<y>" or "C<frame>" tag the
 * game gives it) and by LEM_INDEX, and its ACTION by skill name.
 *
 * parse() turns a file into what LemGame.loadReplay plays back; serialize()
 * writes what a game recorded, so a run here can be replayed in NeoLemmix
 * and a NeoLemmix solution can be checked here.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const { NxParser } = Lemmix;

  function parse(text) {
    const nx = NxParser.parse(text);
    const meta = {
      title: nx.get("TITLE") || "", author: nx.get("AUTHOR") || "", game: nx.get("GAME") || "",
      group: nx.get("GROUP") || "", level: nx.int("LEVEL", 0), id: nx.get("ID") || "", user: nx.get("USER") || "",
      completionFrame: nx.int("COMPLETION_FRAME", 0),
    };
    const assignments = nx.sectionsNamed("ASSIGNMENT").map((s) => ({
      frame: s.int("FRAME", 0),
      skill: String(s.get("ACTION") || "").trim().toUpperCase(),
      lemIndex: s.has("LEM_INDEX") ? s.int("LEM_INDEX", -1) : -1,
      lemId: String(s.get("LEM_IDENTIFIER") || "").trim().toUpperCase(),
      x: s.int("LEM_X", 0), y: s.int("LEM_Y", 0),
      dx: String(s.get("LEM_DIR") || "").trim().toLowerCase().startsWith("l") ? -1 : 1,
    }));
    const spawnIntervals = nx.sectionsNamed("SPAWN_INTERVAL").map((s) => ({
      frame: s.int("FRAME", 0),
      interval: s.has("INTERVAL") ? s.int("INTERVAL", 53) : s.int("RATE", 53),
      spawned: s.int("SPAWNED", 0),
    }));
    const nukes = nx.sectionsNamed("NUKE").map((s) => ({ frame: s.int("FRAME", 0) }));
    return { meta, assignments, spawnIntervals, nukes };
  }

  /** The .nxrp text for what `sim` (a LemGame) recorded on `level`. */
  function serialize(sim, extra) {
    const info = sim.level.info || {};
    extra = extra || {};
    const lines = [];
    const line = (k, v) => { if (v !== undefined && v !== null && v !== "") lines.push(k + " " + v); };
    line("TITLE", info.title);
    line("AUTHOR", info.author);
    line("GAME", extra.game);
    line("GROUP", extra.group);
    line("LEVEL", extra.level);
    line("ID", info.id);
    line("USER", extra.user || "LemmingsJS");
    if (sim.lemmingsIn >= sim.level.needCount && sim.lemmingsIn > 0) line("COMPLETION_FRAME", sim.currentIteration);
    lines.push("");
    for (const r of sim.recorded) {
      if (r.type === "assignment") {
        lines.push("$ASSIGNMENT", "  FRAME " + r.frame, "  LEM_INDEX " + r.lemIndex, "  LEM_IDENTIFIER " + r.lemId,
          "  LEM_X " + r.x, "  LEM_Y " + r.y, "  LEM_DIR " + (r.dx < 0 ? "left" : "right"), "  ACTION " + r.skill, "$END", "");
      } else if (r.type === "spawn_interval") {
        lines.push("$SPAWN_INTERVAL", "  FRAME " + r.frame, "  RATE " + r.interval, "  SPAWNED " + r.spawned, "$END", "");
      } else if (r.type === "nuke") {
        lines.push("$NUKE", "  FRAME " + r.frame, "$END", "");
      }
    }
    return lines.join("\n");
  }

  Lemmix.Replay = { parse, serialize };
  if (typeof module !== "undefined" && module.exports) module.exports = Lemmix.Replay;
})(typeof window !== "undefined" ? window : globalThis);
