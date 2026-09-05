"use strict";
/**
 * Steel areas: the parts of a level no skill can cut through.
 *
 * The engine reads them and then does nothing with them - `LevelReader.steel`
 * has no consumer anywhere in lemmings.js - so a digger goes straight down
 * through a steel floor and a basher walks out of a steel wall. This puts
 * them back, without touching the engine: the ranges are re-derived here and
 * the three destructive actions are wrapped on their own instances, the same
 * way every other hook in this port works.
 *
 * The re-derivation is needed because the reader has the fields the wrong way
 * round. The file format packs a steel area into four bytes:
 *
 *     xxxxxxxx xyyyyyyy  wwwwhhhh  00000000
 *
 * - nine bits of x (in units of 4px, less a 16px border), seven of y
 * - width in the high nibble, height in the low one (units of 4px, plus 4)
 *
 * `readSteelArea()` takes x from the LOW nine bits and y from the high seven,
 * and reads width and height the other way round too, which puts most areas
 * off the level entirely. Measured against the level's own solidity - steel
 * is always painted onto solid ground - the reader's boxes land on 16% solid
 * pixels and these on 87%, which is what settled it. The raw words are gone
 * by the time we see them, so they are recovered from what the reader wrote
 * and unpacked again properly.
 */

/** Steel areas of a level, or [] if it has none (VGASPEC levels never do). */
function steelRangesFrom(levelReader, level) {
  if (!levelReader || !Array.isArray(levelReader.steel)) return [];
  const out = [];
  for (const r of levelReader.steel) {
    // back to the two packed words the reader was given
    const pos = ((r.y / 4) << 9) | ((r.x + 16) / 4);
    const size = ((((r.height - 4) / 4) & 0x0F) << 4) | (((r.width - 4) / 4) & 0x0F);
    const x = (pos >> 7) * 4 - 16;
    const y = (pos & 0x7F) * 4;
    const width = ((size >> 4) & 0x0F) * 4 + 4;
    const height = (size & 0x0F) * 4 + 4;
    if (width <= 0 || height <= 0) continue;
    if (x > level.width || y > level.height || x + width < 0 || y + height < 0) continue;
    out.push({ x, y, width, height });
  }
  return out;
}

/** The areas, with the overlap tests the actions ask of them. */
class SteelMap {
  constructor(ranges) {
    this.ranges = ranges || [];
  }

  get empty() { return this.ranges.length === 0; }

  /** Does any steel overlap this box (inclusive)? */
  hits(x0, y0, x1, y1) {
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    for (const r of this.ranges) {
      if (x1 >= r.x && x0 <= r.x + r.width - 1 &&
          y1 >= r.y && y0 <= r.y + r.height - 1) return true;
    }
    return false;
  }
}

/**
 * The one-way walls of a level: the trigger areas of its arrow objects
 * (trigger effect 7, arrows pointing left; 8, pointing right), which the
 * engine reads into `level.triggers` and then never answers a lemming about.
 * A wall's arrows say which way it may be cut: pointing left, by a lemming
 * going left, so one going right is stopped - the original's rule, and
 * NeoLemmix's (LemGame.pas HasIndestructibleAt: trOWLeft and Direction = 1).
 */
function oneWayRangesFrom(level) {
  const T = (typeof Lemmings !== "undefined" && Lemmings.TriggerTypes) || {};
  const out = [];
  for (const t of (level && level.triggers) || []) {
    if (t.type !== T.ONWAY_LEFT && t.type !== T.ONWAY_RIGHT) continue;
    // the engine's own test is inclusive of x2, y2
    out.push({ x: t.x1, y: t.y1, width: t.x2 - t.x1 + 1, height: t.y2 - t.y1 + 1,
      blocks: t.type === T.ONWAY_LEFT ? 1 : -1 });
  }
  return out;
}

/** The one-way walls, with the test the actions ask of them. */
class OneWayMap {
  constructor(ranges) {
    this.ranges = ranges || [];
  }

  get empty() { return this.ranges.length === 0; }

  /** Does a wall that stops a lemming going `dir` (1 right, -1 left) overlap this box (inclusive)? */
  blocks(x0, y0, x1, y1, dir) {
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    for (const r of this.ranges) {
      if (r.blocks !== dir) continue;
      if (x1 >= r.x && x0 <= r.x + r.width - 1 &&
          y1 >= r.y && y0 <= r.y + r.height - 1) return true;
    }
    return false;
  }
}

/**
 * Stop the destructive skills at steel, on this game's own action instances,
 * and the basher and miner at a one-way wall they come at from the wrong
 * side (a digger goes down through one-way walls, in the original as in
 * NeoLemmix). `onHit(lem)` fires once each time one of them is turned back
 * by steel - the one-way wall makes no sound, it is not steel.
 *
 * What each skill does is the original's behaviour: a digger stops and walks,
 * a basher or miner turns round and walks back the way it came. The check
 * runs before the action does, so no ground is removed on the way.
 */
function installSteel(game, steel, onHit, oneWay) {
  const hasSteel = !!steel && !steel.empty;
  const hasOneWay = !!oneWay && !oneWay.empty;
  if (!hasSteel && !hasOneWay) return steel;
  const manager = game.getLemmingManager();
  const actions = manager && manager.actions;
  if (!actions) return steel;
  const T = Lemmings.LemmingStateType;

  /** Wrap one action: `reach(lem)` is the box it is about to eat into. */
  const guard = (stateType, turn, oneWayStops, reach) => {
    const system = actions[stateType];
    if (!system || system.__steelGuarded) return;
    system.__steelGuarded = true;
    const process = system.process.bind(system);
    system.process = function (level, lem) {
      const box = reach(lem);
      if (hasSteel && steel.hits(box[0], box[1], box[2], box[3])) {
        if (turn) lem.lookRight = !lem.lookRight;
        if (onHit) onHit(lem);
        return T.WALKING;
      }
      if (oneWayStops && hasOneWay && oneWay.blocks(box[0], box[1], box[2], box[3], lem.lookRight ? 1 : -1)) {
        if (turn) lem.lookRight = !lem.lookRight;
        return T.WALKING;
      }
      return process(level, lem);
    };
  };

  // a digger clears x-4..x+4 of the row under it, two rows at a time to start
  guard(T.DIGGING, false, false, (lem) =>
    [lem.x - 4, lem.y - 2, lem.x + 4, lem.y]);
  // a basher eats a corridor ahead of it, roughly ten pixels tall
  guard(T.BASHING, true, true, (lem) => {
    const dir = lem.lookRight ? 1 : -1;
    return [lem.x + dir * 4, lem.y - 10, lem.x + dir * 12, lem.y - 1];
  });
  // a miner cuts down and forward at once
  guard(T.MINEING, true, true, (lem) => {
    const dir = lem.lookRight ? 1 : -1;
    return [lem.x, lem.y - 2, lem.x + dir * 10, lem.y + 6];
  });
  return steel;
}
