"use strict";
/**
 * The minimap in the skill panel's last box: the level shrunk down in its
 * own colours, one dot per lemming, and a frame around the part of the level
 * the viewer is looking at. It follows NeoLemmix's (GameBaseSkillPanel.pas
 * DrawMinimap, LemRendering.pas RenderMinimap): a fixed scale per engine,
 * green dots (red for zombies), a 1-px frame in the panel's brick colour,
 * the map padded by a pixel so the frame shows at the level's edges, and a
 * map larger than its window scrolling to keep the frame centred - frozen
 * while the player drags on it, or the map would run away from the hand.
 *
 * The 3D twist: there is no scroll offset to draw. The "viewport" is what
 * the camera (or the headset) sees of the diorama, so the page hands in the
 * level-space rectangle it worked out from the camera each frame
 * (setViewRect), and a press hands back the level point under it
 * (pointToLevel) for the page to centre the view on.
 *
 * The map lives on its own small plane over the panel's box rather than in
 * the panel bitmap: the DOS GameGui re-blits its whole bitmap whenever a
 * count changes, and the panel texture only uploads once per sim tick,
 * while the frame has to follow a camera that moves between ticks.
 */

const MINIMAP_ORDER = 51;             // over the panel, under the raised buttons
const MINIMAP_FRAME = "#f0d0d0";      // fRectColor, the brick colour
const MINIMAP_DOT = "#00ff00";
const MINIMAP_ZOMBIE = "#ff0000";

class MiniMap {
  /**
   * @param gui   the GuiPanel whose mesh the map rides
   * @param spec  { x, y, w, h } window in panel px; scaleX/scaleY level px
   *              per map px; pad (1 = NeoLemmix's frame room, 0 = none)
   */
  constructor(gui, game, level, spec, scene, resources) {
    this.gui = gui;
    this.game = game;
    this.level = level;
    this.spec = spec;
    this.scene = scene;
    this.pad = spec.pad == null ? 1 : spec.pad;
    this.mapW = Math.ceil(level.width / spec.scaleX);
    this.mapH = Math.ceil(level.height / spec.scaleY);
    // the terrain at map scale, rebuilt when the ground changes
    this.map = document.createElement("canvas");
    this.map.width = this.mapW;
    this.map.height = this.mapH;
    this.mapCtx = this.map.getContext("2d");
    this.mapImage = this.mapCtx.createImageData(this.mapW, this.mapH);
    // what the window shows: the map at its offset, the dots, the frame
    this.view = document.createElement("canvas");
    this.view.width = spec.w;
    this.view.height = spec.h;
    this.ctx = this.view.getContext("2d");

    this.texture = resources.track(new THREE.CanvasTexture(this.view));
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.mesh = new THREE.Mesh(
      resources.track(new THREE.PlaneGeometry(1, 1)),
      resources.track(new THREE.MeshBasicMaterial({
        map: this.texture, depthTest: false, depthWrite: false,
      })));
    this.mesh.name = "gui-minimap";
    this.mesh.renderOrder = MINIMAP_ORDER;
    scene.add(this.mesh);

    this.rect = null;        // {x0, y0, x1, y1} level px, the last known view
    this.offX = 0;           // where the padded map sits in the window
    this.offY = 0;
    this.frozen = false;
    this.terrainDirty = true;
    this._lastKey = "";
    this._hookTerrain();
  }

  /** Every dig, bash, brick and crater passes through these two. */
  _hookTerrain() {
    const level = this.level, self = this;
    const set = level.setGroundAt, clear = level.clearGroundAt;
    const wrappedSet = function () { self.terrainDirty = true; return set.apply(this, arguments); };
    const wrappedClear = function () { self.terrainDirty = true; return clear.apply(this, arguments); };
    level.setGroundAt = wrappedSet;
    level.clearGroundAt = wrappedClear;
    this._unhook = () => {
      if (level.setGroundAt === wrappedSet) level.setGroundAt = set;
      if (level.clearGroundAt === wrappedClear) level.clearGroundAt = clear;
    };
  }

  /** The map pixels: a block with any solid pixel takes that pixel's colour. */
  _buildMap() {
    const { level, spec } = this;
    const W = level.width, H = level.height;
    const img = level.groundImage;
    const layer = level.getGroundMaskLayer();
    const m = layer.groundMask || layer.mask || null;
    const out = this.mapImage.data;
    out.fill(0);
    for (let my = 0; my < this.mapH; my++) {
      const y0 = my * spec.scaleY, y1 = Math.min(H, y0 + spec.scaleY);
      for (let mx = 0; mx < this.mapW; mx++) {
        const x0 = mx * spec.scaleX, x1 = Math.min(W, x0 + spec.scaleX);
        let found = -1;
        scan: for (let y = y0; y < y1; y++) {
          let i = y * W + x0;
          for (let x = x0; x < x1; x++, i++) {
            if (m ? m[i] : layer.hasGroundAt(x, y)) { found = i; break scan; }
          }
        }
        if (found < 0) continue;
        const o = (my * this.mapW + mx) * 4, p = found * 4;
        out[o] = img[p]; out[o + 1] = img[p + 1]; out[o + 2] = img[p + 2]; out[o + 3] = 255;
      }
    }
    this.mapCtx.putImageData(this.mapImage, 0, 0);
  }

  setViewRect(rect) {
    if (rect) this.rect = rect;
  }

  setFreeze(on) {
    this.frozen = !!on;
  }

  /** The view frame in padded-map pixels: one pixel outside the visible map pixels. */
  _frame() {
    const r = this.rect;
    if (!r) return null;
    const sx = this.spec.scaleX, sy = this.spec.scaleY, pad = this.pad;
    let l = Math.floor(r.x0 / sx) + pad - 1, t = Math.floor(r.y0 / sy) + pad - 1;
    let rr = Math.ceil(r.x1 / sx) + pad, b = Math.ceil(r.y1 / sy) + pad;
    const maxX = this.mapW + 2 * pad - 1, maxY = this.mapH + 2 * pad - 1;
    l = Math.max(0, Math.min(maxX, l)); rr = Math.max(l, Math.min(maxX, rr));
    t = Math.max(0, Math.min(maxY, t)); b = Math.max(t, Math.min(maxY, b));
    return { l, t, r: rr, b };
  }

  /** NeoLemmix's DrawMinimap offsets: a small map is centred, a large one
   *  scrolls to keep the frame in the middle and stops at its edges. */
  _updateOffset(frame) {
    if (this.frozen) return;
    const fullW = this.mapW + 2 * this.pad, fullH = this.mapH + 2 * this.pad;
    const w = this.spec.w, h = this.spec.h;
    if (fullW <= w) this.offX = Math.floor((w - fullW) / 2);
    else if (frame) {
      const fw = frame.r - frame.l + 1;
      this.offX = Math.round(-frame.l + (w - fw) / 2);
      this.offX = Math.min(Math.max(this.offX, w - fullW), 0);
    }
    if (fullH <= h) this.offY = Math.floor((h - fullH) / 2);
    else if (frame) {
      const fh = frame.b - frame.t + 1;
      this.offY = Math.round(-frame.t + (h - fh) / 2);
      this.offY = Math.min(Math.max(this.offY, h - fullH), 0);
    }
  }

  /** Repaint when something moved: the sim, the ground, the camera, the map. */
  update() {
    const tick = this.game.getGameTimer().getGameTicks();
    const frame = this._frame();
    this._updateOffset(frame);
    const key = tick + "|" + (frame ? frame.l + "," + frame.t + "," + frame.r + "," + frame.b : "-") +
      "|" + this.offX + "," + this.offY + "|" + (this.terrainDirty ? "t" : "");
    if (key === this._lastKey) return;
    this._lastKey = key;
    if (this.terrainDirty) { this._buildMap(); this.terrainDirty = false; }
    const ctx = this.ctx, pad = this.pad, ox = this.offX + pad, oy = this.offY + pad;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.spec.w, this.spec.h);
    ctx.drawImage(this.map, ox, oy);
    const sx = this.spec.scaleX, sy = this.spec.scaleY;
    const lemmings = this.game.getLemmingManager().lemmings || [];
    for (const L of lemmings) {
      if (L.removed) continue;
      ctx.fillStyle = L.isZombie ? MINIMAP_ZOMBIE : MINIMAP_DOT;
      ctx.fillRect(Math.floor(L.x / sx) + ox, Math.floor(L.y / sy) + oy, 1, 1);
    }
    if (frame) {
      const l = frame.l + this.offX, t = frame.t + this.offY;
      const w = frame.r - frame.l + 1, h = frame.b - frame.t + 1;
      ctx.fillStyle = MINIMAP_FRAME;
      ctx.fillRect(l, t, w, 1);
      ctx.fillRect(l, t + h - 1, w, 1);
      ctx.fillRect(l, t, 1, h);
      ctx.fillRect(l + w - 1, t, 1, h);
    }
    this.texture.needsUpdate = true;
  }

  /** Over the panel's box, in the panel mesh's space (the socket transform). */
  layout() {
    const m = this.gui.mesh;
    if (!m) return;
    const cw = this.gui.canvas.width, ch = this.gui.canvas.height;
    const pw = m.scale.x, ph = m.scale.y;
    const s = this.spec;
    this.mesh.scale.set((s.w / cw) * pw, (s.h / ch) * ph, 1);
    this.mesh.position.set(
      m.position.x + ((s.x + s.w / 2) / cw - 0.5) * pw,
      m.position.y + (0.5 - (s.y + s.h / 2) / ch) * ph,
      m.position.z + 0.1 * (pw / cw));
  }

  /** Is this panel pixel inside the window? */
  contains(px, py) {
    const s = this.spec;
    return px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h;
  }

  /** The level point a panel pixel in the window stands for (the middle of that map pixel). */
  pointToLevel(px, py) {
    const s = this.spec;
    const mx = px - s.x - this.offX - this.pad, my = py - s.y - this.offY - this.pad;
    return {
      x: Math.max(0, Math.min(this.level.width, (mx + 0.5) * s.scaleX)),
      y: Math.max(0, Math.min(this.level.height, (my + 0.5) * s.scaleY)),
    };
  }

  dispose() {
    this.scene.remove(this.mesh);
    if (this._unhook) this._unhook();
  }
}
