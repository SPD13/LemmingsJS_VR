"use strict";
/**
 * The wait rollout: the game run on with no further action until it ends,
 * gets stuck, or a frame cap, watching every controllable lemming for the
 * moments a skill could matter - the decision points the search branches
 * on. Per lemming, frame by frame: a spawn, a landing, the step off an edge
 * (with where the lemming stood on the frames before it, so a skill can be
 * placed k pixels short of the edge), a turn at a wall, a shrug, the end of
 * a job, a death and its cause, an exit, a gadget triggered; and a tick
 * when nothing else happened for a while.
 *
 * "Stuck" is NeoLemmix's own experience of a level going nowhere: every
 * controllable lemming alive is pacing a loop (the same spot, the same way,
 * walking, with the terrain unchanged since) or blocking, with nothing left
 * to release and nothing working - only a skill or the nuke can end it.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const Solver = Lemmix.Solver || (Lemmix.Solver = {});
  const { BA } = Lemmix;

  const RING = 24; // positions kept per lemming for the "k pixels before" anchors
  const TICK_EVERY = 32; // a tick on a walk this often, its ring the last 24 frames: every stretch of floor gets an anchor
  const MAX_ROLLOUT = 17 * 60 * 12;
  const STUCK_AFTER = 170; // frames of nothing changing before a pacing crowd counts as stuck

  const WORKING = new Set([BA.DIGGING, BA.BUILDING, BA.BASHING, BA.MINING, BA.PLATFORMING, BA.STACKING,
    BA.FENCING, BA.LASERING, BA.CLIMBING, BA.HOISTING, BA.SHIMMYING, BA.REACHING, BA.JUMPING, BA.FALLING,
    BA.FLOATING, BA.GLIDING, BA.SWIMMING, BA.SLIDING, BA.DEHOISTING, BA.OHNOING, BA.EXPLODING, BA.STONING,
    BA.STONEFINISH, BA.EXITING, BA.SPLATTING, BA.DROWNING, BA.VAPORIZING, BA.FIXING]);
  const AIRBORNE = new Set([BA.FALLING, BA.FLOATING, BA.GLIDING]);
  const CYCLIC = new Set([BA.WALKING, BA.ASCENDING, BA.FALLING, BA.FLOATING, BA.GLIDING, BA.SWIMMING, BA.CLIMBING,
    BA.HOISTING, BA.DEHOISTING, BA.SLIDING, BA.SHIMMYING, BA.JUMPING]);
  const DYING = { [BA.SPLATTING]: "splat", [BA.DROWNING]: "water", [BA.VAPORIZING]: "fire", [BA.EXPLODING]: "explode", [BA.STONING]: "stone" };
  const JOBS = new Set([BA.DIGGING, BA.BUILDING, BA.BASHING, BA.MINING, BA.PLATFORMING, BA.STACKING, BA.FENCING, BA.LASERING]);

  /** What the rollout watches per lemming. */
  class Watch {
    constructor(L) {
      this.index = L.index; this.id = L.identifier;
      this.action = L.action; this.dx = L.dx; this.x = L.x; this.y = L.y; this.removed = L.removed;
      this.ring = [];         // [frame, x, y] of the last RING frames
      this.lastAnchor = null; // the last FALL or TURN event
      this.lastEvent = -1;    // frame of the last event
      this.seen = new Set();  // positions since the terrain last changed, for the loop test
      this.emitted = new Set(); // events already given, by place
      this.looping = false;
    }
    push(frame, L) {
      this.ring.push([frame, L.x, L.y]);
      if (this.ring.length > RING) this.ring.shift();
    }
  }

  /**
   * Run `world` on until it ends or `maxFrames` pass. Returns
   * { events, outcome, frames } where outcome = { saved, lost, alive,
   * toRelease, endFrame, stuck, ended, outOfTime, skillsUsed }.
   */
  function rollout(world, opts) {
    opts = opts || {};
    const game = world.game;
    const level = world.level;
    const cap = opts.maxFrames !== undefined ? opts.maxFrames : (level.timeLimitSeconds > 0 ? Math.min(level.timeLimitSeconds * 17 + 40, MAX_ROLLOUT) : MAX_ROLLOUT);
    const events = [];
    const watches = [];
    const startFrame = game.currentIteration;
    const startSaved = game.lemmingsIn, startRemoved = game.lemmingsRemoved;
    let lastTerrain = world.terrainVersion, lastCounters = startSaved + startRemoved, lastChange = startFrame;
    let stuck = false, frames = 0, leadDone = false;
    const field = opts.field || null;
    const leadId = opts.leadId ? String(opts.leadId).toUpperCase() : null; // the lead pass: the rollout is over when this lemming is
    let minDist = Infinity; // the nearest any controllable lemming came to an exit
    const permsOf = (L) => (L.isClimber ? 1 : 0) | (L.isFloater ? 2 : 0) | (L.isGlider ? 4 : 0) | (L.isSwimmer ? 8 : 0) | (L.isDisarmer ? 16 : 0) | (L.isSlider ? 32 : 0);
    const emit = (type, w, L, frame, extra) => {
      const e = { type, lemIndex: w.index, lemId: w.id, frame, x: L.x, y: L.y, dx: L.dx, action: L.action, perms: permsOf(L) };
      if (extra) Object.assign(e, extra);
      w.lastEvent = frame;
      // the same event at the same place again (a lemming pacing): the first one is the decision
      const key = type + ":" + (L.x >> 1) + ":" + L.y + ":" + L.dx;
      if (w.emitted.has(key)) { e.repeat = true; return e; }
      w.emitted.add(key);
      events.push(e);
      return e;
    };
    // the lemmings already out get a watch (and a SPAWN-like anchor for early skills)
    for (const L of game.lemmings) {
      const w = new Watch(L); watches.push(w);
      if (!L.removed && !L.cannotReceiveSkills) {
        emit("PRESENT", w, L, startFrame);
        if (L.action === BA.BLOCKING) emit("BLOCK", w, L, startFrame); // a blocker at its post already: to be freed later
      }
    }

    while (frames < cap && !world.ended) {
      const frame0 = game.currentIteration;
      game.update();
      world.frames++;
      frames++;
      const frame = game.currentIteration;
      if (game.isOutOfTime) break;
      // new lemmings
      for (let i = watches.length; i < game.lemmings.length; i++) {
        const L = game.lemmings[i];
        const w = new Watch(L); watches.push(w);
        if (!L.cannotReceiveSkills && !L.removed) emit("SPAWN", w, L, frame);
      }
      const terrainChanged = world.terrainVersion !== lastTerrain;
      if (terrainChanged) lastTerrain = world.terrainVersion;
      for (let i = 0; i < watches.length; i++) {
        const w = watches[i], L = game.lemmings[i];
        if (w.removed) continue;
        const wasControllable = !L.isZombie && !L.isNeutral && !L.hasBeenOhnoer;
        if (L.removed) {
          w.removed = true;
          if (w.action !== BA.EXITING && !DYING[w.action]) {
            const offscreen = L.x < 0 || L.x >= level.width || L.y <= 0 || L.y > level.height + 9;
            if (wasControllable) emit("DEATH", w, L, frame, { cause: offscreen ? "offscreen" : "trap", anchor: w.lastAnchor });
          }
          continue;
        }
        if (L.isZombie && wasControllable !== false) { /* a zombie now: uncontrollable, watched no more */ }
        if (L.cannotReceiveSkills) { w.action = L.action; w.dx = L.dx; w.x = L.x; w.y = L.y; continue; }
        const a = L.action, was = w.action;
        if (a !== was) {
          if (a === BA.EXITING) emit("EXIT", w, L, frame);
          else if (DYING[a] && DYING[a] !== "explode" && DYING[a] !== "stone") emit("DEATH", w, L, frame, { cause: DYING[a], anchor: w.lastAnchor });
          else if (a === BA.WALKING && AIRBORNE.has(was)) emit("LAND", w, L, frame);
          else if (a === BA.FALLING && !L.initialFall && (was === BA.WALKING || was === BA.ASCENDING || JOBS.has(was))) {
            w.lastAnchor = emit("FALL", w, L, frame, { edgeX: w.x, edgeY: w.y, ring: w.ring.slice() });
          } else if (a === BA.FALLING && (was === BA.CLIMBING || was === BA.SHIMMYING || was === BA.REACHING)) {
            // off the wall or the ceiling: an anchor too (a shimmier, a floater), its ring the climb
            w.lastAnchor = emit("FALL", w, L, frame, { edgeX: w.x, edgeY: w.y, ring: w.ring.slice(), offWall: true });
          } else if (a === BA.SHRUGGING) emit("SHRUG", w, L, frame);
          else if (a === BA.BLOCKING) emit("BLOCK", w, L, frame); // a blocker at its post: freed later with a bomber
          else if (JOBS.has(was) && !JOBS.has(a) && a !== BA.SHRUGGING) emit("WORK_END", w, L, frame, { job: was });
          else if (a === BA.CLIMBING && was === BA.WALKING) w.lastAnchor = emit("TURN", w, L, frame, { wallX: L.x, ring: w.ring.slice(), climbing: true });
        } else if (a === BA.WALKING && L.dx !== w.dx) {
          w.lastAnchor = emit("TURN", w, L, frame, { wallX: w.x, ring: w.ring.slice() });
        }
        // the loop test: the same spot, the same way, the same action and animation frame, with the
        // terrain unchanged since - a cycle the lemming will not leave by itself
        if (terrainChanged) { w.seen.clear(); w.looping = false; }
        if (CYCLIC.has(a)) {
          const key = ((L.x + 1) * 4096 + (L.y + 16)) * 512 + (L.dx > 0 ? 256 : 0) + a * 8 + (L.physicsFrame & 7);
          if (w.seen.has(key)) w.looping = true; else w.seen.add(key);
        } else if (a === BA.BLOCKING) w.looping = true;
        else { w.seen.clear(); w.looping = false; }
        if (w.lastEvent >= 0 && frame - w.lastEvent >= TICK_EVERY && a === BA.WALKING) {
          emit("TICK", w, L, frame, { ring: w.ring.slice() });
        }
        // up a wall: every few pixels a moment for a shimmier (the ceiling above) or a jump off
        if (a === BA.CLIMBING && (L.y & 7) === 0) emit("CLIMB", w, L, frame);
        w.push(frame, L);
        w.action = a; w.dx = L.dx; w.x = L.x; w.y = L.y;
      }
      if (field && (frame & 3) === 0) {
        for (const L of game.lemmings) {
          if (L.removed || L.cannotReceiveSkills) continue;
          const d = field.at(L.x, L.y);
          if (d < minDist) minDist = d;
        }
      }
      // gadgets: a button pressed, a pickup taken (through the sounds of the frame)
      for (const s of game.sounds) {
        if (s.name === "oing2" || s.name === "skill_add") events.push({ type: "TRIGGER", kind: "pickup", frame, x: s.x, y: s.y });
        else if (s.name === "portal") events.push({ type: "TRIGGER", kind: "portal", frame, x: s.x, y: s.y });
      }
      // the lead pass: the lead gone (saved or lost) or pacing a loop for a while ends the rollout
      if (leadId) {
        const wi = watches.findIndex((w) => w.id.toUpperCase() === leadId);
        if (wi >= 0) {
          const L = game.lemmings[wi], w = watches[wi];
          if (L.removed || L.cannotReceiveSkills) { if (frame - w.lastEvent > 2) { leadDone = true; break; } }
          else if (w.looping && frame - w.lastEvent > STUCK_AFTER && world.terrainVersion === lastTerrain && !WORKING.has(L.action)) { stuck = true; break; }
        }
      }
      // stuck: the counters and terrain unchanged, nothing to release, everyone pacing or blocking
      const counters = game.lemmingsIn + game.lemmingsRemoved;
      if (counters !== lastCounters || terrainChanged) { lastCounters = counters; lastChange = frame; }
      if (frame - lastChange > STUCK_AFTER && (game.lemmingsToRelease === 0 || game.userSetNuking)) {
        let all = true, any = false;
        for (let i = 0; i < watches.length && all; i++) {
          const L = game.lemmings[i];
          if (L.removed || L.cannotReceiveSkills) continue;
          any = true;
          if (L.explosionTimer > 0 || WORKING.has(L.action) || !watches[i].looping) all = false;
        }
        if (all && any && !game.userSetNuking) { stuck = true; break; }
      }
    }
    const outcome = {
      saved: game.lemmingsIn, lost: game.lemmingsRemoved - game.lemmingsIn, alive: game.lemmingsOut,
      toRelease: game.lemmingsToRelease, endFrame: world.ended ? game.currentIteration : Infinity,
      stuck, ended: world.ended, outOfTime: game.isOutOfTime, capped: !world.ended && !stuck && !game.isOutOfTime && !leadDone, leadDone,
      lastFrame: game.currentIteration, skillsUsed: world.skillsUsed(), need: level.needCount, minDist,
    };
    if (outcome.outOfTime && !outcome.ended) outcome.endFrame = game.currentIteration;
    outcome.solved = outcome.saved >= level.needCount && level.needCount > 0 && (outcome.ended || outcome.outOfTime || stuck || leadDone);
    return { events, outcome, frames };
  }

  Solver.rollout = rollout;
  Solver.ROLLOUT = { RING, TICK_EVERY, MAX_ROLLOUT };
  if (typeof module !== "undefined" && module.exports) module.exports = { rollout };
})(typeof window !== "undefined" ? window : globalThis);
