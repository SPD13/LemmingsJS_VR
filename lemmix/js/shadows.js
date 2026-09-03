"use strict";
/**
 * Skill shadows (LemRendering.pas DrawShadows and its Draw*Shadow): with a
 * skill selected and a lemming under the cursor, NeoLemmix shows what the
 * skill would do - the bricks a builder would lay, the tunnel a basher
 * would cut, a jumper's arc, a bomber's crater - by simulating a copy of
 * the lemming with the skill, frame by frame, and marking pixels as it
 * goes: "low" shadow pixels lie under the terrain (paths, bricks), "high"
 * ones over it, where destructible terrain would go (tunnels, craters).
 * The physics map is put back afterwards; the game never knows.
 *
 * compute(sim, lemming, skill) returns { low: [[x, y]...], high: [[x, y]...] }.
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});
  const { BA, ACTION_TO_SKILL } = Lemmix;

  /** The skills that cast one (CheckForNewShadow's ShadowSkillSet). */
  const SHADOW_SKILLS = new Set(["JUMPER", "SHIMMIER", "PLATFORMER", "BUILDER", "STACKER", "DIGGER",
    "MINER", "BASHER", "FENCER", "BOMBER", "GLIDER", "CLONER", "LASERER"]);

  const BASHER_END = [[6, -1], [6, -2], [7, -2], [7, -3], [7, -4], [7, -5], [7, -6], [7, -7], [6, -7], [6, -8], [5, -8]];
  const FENCER_END = [[6, -4], [6, -5], [6, -6], [6, -7], [6, -8], [6, -9]];
  const MINER_TURN = [[1, -1], [1, 0], [2, 0], [3, 0], [3, 1], [4, 1], [3, -12], [4, -12], [5, -12], [5, -11], [6, -11], [6, -10]];
  const MINER_END = [[5, 1], [6, 1], [6, 0], [7, 0], [7, -1], [8, -1], [8, -2], [8, -3], [8, -4], [8, -5], [8, -6], [8, -7], [7, -7], [7, -8], [7, -9], [7, -10]];
  // the right half of the bomber's crater outline; the left is its mirror
  const BOMBER_SHADOW = [[0, 7], [1, 7], [2, 7], [2, 6], [3, 6], [4, 6], [4, 5], [5, 5], [5, 4], [6, 4], [6, 3], [6, 2], [6, 1], [7, 1], [7, 0],
    [7, -1], [7, -2], [7, -3], [7, -4], [6, -4], [6, -5], [6, -6], [6, -7], [6, -8], [5, -8], [5, -9], [5, -10], [5, -10], [4, -11], [4, -12],
    [3, -12], [3, -13], [2, -13], [2, -14], [1, -14], [0, -14]];

  class ShadowSet {
    constructor(sim) { this.sim = sim; this.low = []; this.high = []; this._seen = new Set(); }
    _put(list, x, y) {
      if (x < 0 || x >= this.sim.width || y < 0 || y >= this.sim.height) return;
      const key = (list === this.low ? "l" : "h") + x + "," + y;
      if (this._seen.has(key)) return;
      this._seen.add(key);
      list.push([x, y]);
    }
    lowAt(x, y) { this._put(this.low, x, y); }
    highAt(x, y) { this._put(this.high, x, y); }
  }

  /** Run `fn` with the physics map and the game's frame scratch put back afterwards. */
  function withPhysicsSaved(sim, fn) {
    const saved = sim.physics.slice();
    const nextAction = sim.lemNextAction, hoist = sim.lemJumpToHoistAdvance, done = sim.doneAssignmentThisFrame;
    sim.lemNextAction = BA.NONE; sim.lemJumpToHoistAdvance = false;
    try { fn(); } finally {
      sim.physics.set(saved);
      sim.lemNextAction = nextAction; sim.lemJumpToHoistAdvance = hoist; sim.doneAssignmentThisFrame = done;
    }
  }

  function drawJumper(sim, L, out) {
    let frames = 0;
    out.lowAt(L.x, L.y - 1);
    const follow = new Set([BA.JUMPING, BA.CLIMBING, BA.HOISTING, BA.FALLING, BA.FLOATING, BA.GLIDING, BA.SLIDING]);
    while (frames < 2000 && follow.has(L.action)) {
      frames++;
      const pos = sim.simulateLem(L, true);
      for (const [x, y] of pos) {
        if (x < 0 || x >= sim.width || y <= 0) return;
        out.lowAt(x, y - 1); out.highAt(x, y - 1);
        if (L.x === x && L.y === y) break;
      }
    }
  }

  function drawShimmier(sim, L, out) {
    let frames = 0, pos = null;
    out.lowAt(L.x, L.y - 1);
    while (frames < 2000 && (L.action === BA.REACHING || L.action === BA.SHIMMYING)) {
      frames++;
      if (pos) for (const [x, y] of pos) { out.lowAt(x, y - 1); if (L.x === x && L.y === y) break; }
      pos = sim.simulateLem(L, true);
    }
  }

  function drawGlider(sim, L, out) {
    let frames = 0, pos = null;
    out.lowAt(L.x, L.y - 1);
    while (frames < 2000 && (L.action === BA.GLIDING || (frames < 15 && (L.action === BA.FALLING || L.action === BA.JUMPING)))) {
      frames++;
      if (pos) for (const [x, y] of pos) { out.lowAt(x, y - 1); if (L.x === x && L.y === y) break; }
      pos = sim.simulateLem(L, true);
    }
  }

  function drawBuilder(sim, L, out) {
    let done = false;
    withPhysicsSaved(sim, () => {
      while (L.action === BA.BUILDING) {
        if (L.physicsFrame >= 8 && !done) {
          for (let i = 0; i <= 5; i++) out.lowAt(L.x + i * L.dx, L.y - 1);
          done = true;
        } else if (L.physicsFrame === 0) done = false;
        sim.simulateLem(L, true);
      }
    });
  }

  function drawPlatformer(sim, L, out) {
    withPhysicsSaved(sim, () => {
      while (L.action === BA.PLATFORMING) {
        if (L.physicsFrame + 1 === 9) for (let i = 0; i <= 5; i++) out.lowAt(L.x + i * L.dx, L.y);
        sim.simulateLem(L, true);
      }
    });
  }

  function drawStacker(sim, L, out) {
    withPhysicsSaved(sim, () => {
      let brickY = L.y - 9 + L.bricksLeft;
      if (L.stackLow) brickY++;
      const yOffset = (L.action === BA.STACKING && L.physicsFrame === 7) ? -1 : 0;
      while (L.action === BA.STACKING) {
        if (L.physicsFrame + 1 === 7) {
          for (let i = 1; i <= 3; i++) out.lowAt(L.x + i * L.dx, brickY + yOffset);
          brickY--;
        }
        sim.simulateLem(L, true);
      }
    });
  }

  function drawBasher(sim, L, out) {
    withPhysicsSaved(sim, () => {
      let px = L.x, py = L.y, pdx = L.dx, frames = 0;
      while (L.action === BA.BASHING && frames < 10000) {
        if ((L.physicsFrame + 1) % 16 === 2) {
          px = L.x; py = L.y; pdx = L.dx;
          for (let i = 0; i <= 5; i++) { out.highAt(L.x + i * L.dx, L.y - 1); out.highAt(L.x + i * L.dx, L.y - 9); }
        }
        sim.simulateLem(L, true);
        frames++;
      }
      for (const [ex, ey] of BASHER_END) out.highAt(px + ex * pdx, py + ey);
    });
  }

  function drawFencer(sim, L, out) {
    withPhysicsSaved(sim, () => {
      let px = L.x, py = L.y, pdx = L.dx, frames = 0;
      while (L.action === BA.FENCING && frames < 10000) {
        if ((L.physicsFrame + 1) % 16 === 2) {
          px = L.x; py = L.y; pdx = L.dx;
          let dy = 0;
          for (let i = 0; i <= 5; i++) {
            if (i > 0) out.highAt(L.x + i * L.dx, L.y - 2 - dy);
            if (i === 2 || i === 4) dy++;
            out.highAt(L.x + i * L.dx, L.y - 8 - dy);
          }
        }
        sim.simulateLem(L, true);
        frames++;
      }
      for (const [ex, ey] of FENCER_END) out.highAt(px + ex * pdx, py + ey);
    });
  }

  function drawMiner(sim, L, out) {
    withPhysicsSaved(sim, () => {
      let px = L.x, py = L.y, pdx = L.dx, frames = 0;
      while (L.action === BA.MINING && frames < 10000) {
        if (L.physicsFrame + 1 === 1) {
          px = L.x; py = L.y; pdx = L.dx;
          for (const [tx, ty] of MINER_TURN) out.highAt(px + tx * pdx, py + ty);
        }
        sim.simulateLem(L, true);
        frames++;
      }
      for (const [ex, ey] of MINER_END) out.highAt(px + ex * pdx, py + ey);
    });
  }

  function drawDigger(sim, L, out) {
    withPhysicsSaved(sim, () => {
      const dx = L.x; let dy = L.y, frames = 0;
      while (L.action === BA.DIGGING && frames < 10000) {
        if ((L.physicsFrame + 1) % 8 === 0) { out.highAt(dx - 4, dy - 1); out.highAt(dx + 4, dy - 1); dy++; }
        sim.simulateLem(L, true);
        frames++;
      }
      out.highAt(dx - 4, dy - 1); out.highAt(dx + 4, dy - 1);
      for (let i = -4; i <= 4; i++) out.highAt(dx + i, dy);
    });
  }

  function drawExploder(sim, L, out) {
    const px = L.x + (L.dx === 1 ? 1 : 0);
    for (const [bx, by] of BOMBER_SHADOW) { out.highAt(px + bx, L.y + by); out.highAt(px - bx - 1, L.y + by); }
  }

  /** The laserer's beam: the diamond around each hit point, its rim drawn where it is not overwritten. */
  function drawLaserer(sim, L, out) {
    withPhysicsSaved(sim, () => {
      const counts = new Map(); // "x,y" -> { edge, inner, flag }
      let last = null;
      const minX = L.dx === 1 ? L.x : 0, maxX = L.dx === 1 ? sim.width : L.x + 1, maxY = L.y;
      while (L.action === BA.LASERING) {
        if (L.laserHit && L.laserHitPoint) {
          const [hx, hy] = L.laserHitPoint;
          for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
            const total = Math.abs(x) + Math.abs(y);
            if (total > 5) continue;
            const tx = hx + x, ty = hy + y;
            if (tx < 0 || ty < 0 || tx >= sim.width || ty >= sim.height) continue;
            const key = tx + "," + ty;
            const c = counts.get(key) || { edge: 0, inner: 0, flag: false };
            if (total === 5 || (total === 4 && (x === 0 || y === 0))) {
              c.edge++;
              if (total === 5 && ((L.dx < 0 && ((x < 0) !== (y < 0))) || (L.dx > 0 && ((x < 0) === (y < 0))))) c.flag = true;
            } else c.inner++;
            counts.set(key, c);
          }
        }
        sim.simulateLem(L, true);
        if (!L.laserHit || !L.laserHitPoint || (last && last[0] === L.laserHitPoint[0] && last[1] === L.laserHitPoint[1])) break;
        last = L.laserHitPoint.slice();
      }
      for (const [key, c] of counts) {
        if (!(c.flag || (c.edge === 1 && c.inner === 0))) continue;
        const [x, y] = key.split(",").map(Number);
        if (x >= minX && x < maxX && y < maxY) out.highAt(x, y);
      }
    });
  }

  /** DrawShadows: the pixels the skill would touch, for this lemming as it stands now. */
  function draw(sim, L, skill, out) {
    const copy = L.clone();
    switch (skill) {
      case "JUMPER": sim.simulateTransitionLem(copy, BA.JUMPING); drawJumper(sim, copy, out); break;
      case "SHIMMIER":
        sim.simulateTransitionLem(copy, (copy.action === BA.CLIMBING || copy.action === BA.JUMPING) ? BA.SHIMMYING : BA.REACHING);
        drawShimmier(sim, copy, out); break;
      case "BUILDER": sim.simulateTransitionLem(copy, BA.BUILDING); drawBuilder(sim, copy, out); break;
      case "PLATFORMER": sim.simulateTransitionLem(copy, BA.PLATFORMING); drawPlatformer(sim, copy, out); break;
      case "STACKER": sim.simulateTransitionLem(copy, BA.STACKING); drawStacker(sim, copy, out); break;
      case "DIGGER": sim.simulateTransitionLem(copy, BA.DIGGING); drawDigger(sim, copy, out); break;
      case "MINER": sim.simulateTransitionLem(copy, BA.MINING); drawMiner(sim, copy, out); break;
      case "BASHER": sim.simulateTransitionLem(copy, BA.BASHING); drawBasher(sim, copy, out); break;
      case "FENCER": sim.simulateTransitionLem(copy, BA.FENCING); drawFencer(sim, copy, out); break;
      case "BOMBER": drawExploder(sim, copy, out); break;
      case "GLIDER": copy.isGlider = true; drawGlider(sim, copy, out); break;
      case "LASERER": sim.simulateTransitionLem(copy, BA.LASERING); drawLaserer(sim, copy, out); break;
      case "CLONER": {
        // the clone goes the other way, doing what this one does
        copy.dx = -copy.dx;
        const doing = ACTION_TO_SKILL[copy.action];
        if (doing && SHADOW_SKILLS.has(doing) && doing !== "CLONER") draw(sim, copy, doing, out);
        break;
      }
      default: break;
    }
  }

  function compute(sim, L, skill) {
    const out = new ShadowSet(sim);
    if (!L || L.removed || !SHADOW_SKILLS.has(skill)) return { low: [], high: [] };
    withPhysicsSaved(sim, () => draw(sim, L, skill, out));
    return { low: out.low, high: out.high };
  }

  Lemmix.Shadows = { compute, SHADOW_SKILLS };
  if (typeof module !== "undefined" && module.exports) module.exports = Lemmix.Shadows;
})(typeof window !== "undefined" ? window : globalThis);
