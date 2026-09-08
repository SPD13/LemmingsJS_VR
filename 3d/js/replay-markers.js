"use strict";
/**
 * The action markers of a replay (Lemmix engine): while a replay is engaged
 * - a stored solution, a loaded file, the panel's replay of the player's
 * own attempt - every entry of the record stands on the board from frame 0,
 * the future ones as much as the past, so the whole plan can be read at a
 * glance. An assignment is a small ring on the spot the lemming stood when
 * the skill was given, with the skill's own picture beside it - the one the
 * panel's button shows (GamePanel._skillIcon), outlined so it reads on any
 * terrain. A release-rate change and the nuke stand at the hatch with the
 * panel's icons for them. A marker whose frame is still ahead is
 * translucent with the seconds until it beside the picture; the next one
 * to fire pulses; a played one turns solid and stays, so the past of the
 * replay stays readable. Stepping back turns markers translucent again
 * (the same frame comparison), and the moment the replay is no longer
 * engaged - the player took control, cancelled it, changed level - all of
 * them go at once.
 *
 * The group lives in worldGroup (pixel space, y down); each plane is
 * flipped back so its picture stands upright in the world.
 */
(function () {
  const ICON_W = 16, ICON_H = 23;
  const FUTURE_OPACITY = 0.45;

  /** A canvas of a Lemmix Bitmap (RGBA bytes) with a one-pixel dark outline round its opaque pixels. */
  function outlinedCanvas(bmp) {
    const w = bmp.width + 2, h = bmp.height + 2;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const cx = cv.getContext("2d");
    const img = cx.createImageData(w, h);
    const src = bmp.data, sw = bmp.width;
    const alphaAt = (x, y) => (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) ? 0 : src[(x + y * sw) * 4 + 3];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = x - 1, sy = y - 1, o = (x + y * w) * 4;
      const a = alphaAt(sx, sy);
      if (a > 0) { const i = (sx + sy * sw) * 4; img.data[o] = src[i]; img.data[o + 1] = src[i + 1]; img.data[o + 2] = src[i + 2]; img.data[o + 3] = 255; }
      else if (alphaAt(sx - 1, sy) || alphaAt(sx + 1, sy) || alphaAt(sx, sy - 1) || alphaAt(sx, sy + 1)) { img.data[o] = 10; img.data[o + 1] = 10; img.data[o + 2] = 14; img.data[o + 3] = 230; }
    }
    cx.putImageData(img, 0, 0);
    return cv;
  }

  /** A canvas with `text` in a small box, for the countdown. */
  function labelCanvas(text) {
    const cv = document.createElement("canvas");
    cv.width = 48; cv.height = 20;
    const cx = cv.getContext("2d");
    cx.fillStyle = "rgba(10, 10, 14, 0.8)";
    cx.fillRect(0, 0, cv.width, cv.height);
    cx.fillStyle = "#ffd866";
    cx.font = "bold 15px monospace";
    cx.textAlign = "center"; cx.textBaseline = "middle";
    cx.fillText(text, cv.width / 2, cv.height / 2 + 1);
    return cv;
  }

  class ReplayMarkers {
    /**
     * `opts` = { THREE, worldGroup, level, game (Lemmix.Game), z (the lemmings' plane) }.
     * The panel (game.gui) supplies the pictures; without one the pins stand alone.
     */
    constructor(opts) {
      this.THREE = opts.THREE;
      this.worldGroup = opts.worldGroup;
      this.level = opts.level;
      this.game = opts.game;
      this.z = opts.z;
      this.group = new this.THREE.Group();
      this.group.name = "replay-markers";
      this.group.visible = false;
      this.worldGroup.add(this.group);
      this.markers = [];
      this.textures = new Map();   // icon key -> {texture, w, h}
      this.labels = new Map();     // seconds -> texture
      this.ringGeometry = new this.THREE.RingGeometry(2.5, 4, 20);
      this.builtFor = -1;          // sim.recordVersion the markers were built from
      this.engaged = false;
      this.hidden = false;         // the page hides the pictures (clear physics mode)
    }

    _iconTexture(key, bitmapOf) {
      let entry = this.textures.get(key);
      if (entry) return entry;
      const bmp = bitmapOf();
      if (!bmp) return null;
      const cv = outlinedCanvas(bmp);
      const texture = new this.THREE.CanvasTexture(cv);
      texture.magFilter = this.THREE.NearestFilter;
      texture.minFilter = this.THREE.NearestFilter;
      entry = { texture, w: cv.width, h: cv.height };
      this.textures.set(key, entry);
      return entry;
    }

    _labelTexture(seconds) {
      let tex = this.labels.get(seconds);
      if (!tex) {
        tex = new this.THREE.CanvasTexture(labelCanvas(seconds + "s"));
        tex.magFilter = this.THREE.LinearFilter; tex.minFilter = this.THREE.LinearFilter;
        this.labels.set(seconds, tex);
      }
      return tex;
    }

    _plane(entry, x, y, order) {
      const THREE = this.THREE;
      const material = new THREE.MeshBasicMaterial({ map: entry.texture, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(entry.w, entry.h), material);
      mesh.position.set(x, y, this.z);
      mesh.scale.y = -1; // upright in a y-down group
      mesh.renderOrder = order;
      return mesh;
    }

    /** Where a record entry's marker stands and which picture it wears. */
    _place(entry) {
      const level = this.level, gui = this.game.gui;
      if (entry.type === "assignment") {
        const icon = gui && gui._skillIcon ? this._iconTexture("skill:" + entry.skill, () => gui._skillIcon(entry.skill)) : null;
        return { x: entry.x, y: entry.y, icon, dx: entry.dx };
      }
      // a hatch: the one the next lemming comes from, or the middle of them all for the nuke
      const hatches = level.entrances || [];
      let hx = level.width / 2, hy = level.height / 2;
      if (hatches.length) {
        let g = null;
        if (entry.type === "spawn_interval" && level.spawnOrder) {
          const pos = Math.max(0, (entry.spawned | 0) - (level.preplaced || []).length);
          const ix = level.spawnOrder[Math.min(pos, level.spawnOrder.length - 1)];
          g = ix >= 0 ? level.gadgets[ix] : null;
        }
        if (g) { hx = g.triggerRect.x0; hy = g.triggerRect.y0; }
        else { hx = 0; hy = 0; for (const h of hatches) { hx += h.triggerRect.x0; hy += h.triggerRect.y0; } hx /= hatches.length; hy /= hatches.length; }
        hy += 10;
      }
      const A = gui && gui.assets;
      let icon = null;
      if (A) {
        if (entry.type === "nuke") icon = this._iconTexture("nuke", () => A.icon_nuke);
        else {
          const faster = entry.interval < this.level.spawnInterval; // a lower interval: more lemmings per minute
          icon = this._iconTexture(faster ? "rr+" : "rr-", () => (faster ? A.icon_rr_plus : A.icon_rr_minus));
        }
      }
      return { x: hx, y: hy, icon, dx: 1, text: entry.type === "spawn_interval" ? String(103 - entry.interval) : null };
    }

    /** The markers of the record as it stands. */
    _build() {
      this._clear();
      const THREE = this.THREE;
      const recorded = this.game.sim.recorded.slice().sort((a, b) => a.frame - b.frame);
      const stacks = new Map(); // markers at the same spot stack upward
      for (const entry of recorded) {
        const at = this._place(entry);
        const key = (at.x >> 3) + ":" + (at.y >> 3);
        const n = stacks.get(key) || 0;
        stacks.set(key, n + 1);
        const lift = n * (ICON_H + 3);
        const m = { entry, frame: entry.frame, objects: [], materials: [], label: null, labelSeconds: -1, textOnly: at.text };
        const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xffd866, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
        const ring = new THREE.Mesh(this.ringGeometry, ringMaterial);
        ring.position.set(at.x, at.y - 1, this.z);
        ring.renderOrder = 20;
        m.objects.push(ring); m.materials.push(ringMaterial);
        if (at.icon) {
          const side = at.dx < 0 ? -1 : 1;
          const icon = this._plane(at.icon, at.x + side * (ICON_W / 2 + 6), at.y - 6 - ICON_H / 2 - lift, 21);
          m.objects.push(icon); m.materials.push(icon.material);
          m.iconAt = { x: icon.position.x, y: icon.position.y };
          if (at.text) {
            const tex = new THREE.CanvasTexture(labelCanvas(at.text));
            const label = this._plane({ texture: tex, w: 12, h: 5 }, icon.position.x, icon.position.y + ICON_H / 2 + 4, 22);
            m.objects.push(label); m.materials.push(label.material);
          }
        } else {
          m.iconAt = { x: at.x, y: at.y - 8 - lift };
        }
        // the countdown beside the picture, shown while the action is ahead
        const labelMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
        const label = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), labelMaterial);
        label.position.set(m.iconAt.x, m.iconAt.y - ICON_H / 2 - 4, this.z);
        label.scale.y = -1;
        label.renderOrder = 22;
        label.visible = false;
        m.label = label; m.objects.push(label);
        for (const o of m.objects) this.group.add(o);
        this.markers.push(m);
      }
      this.builtFor = this.game.sim.recordVersion;
    }

    _clear() {
      for (const m of this.markers) {
        for (const o of m.objects) { this.group.remove(o); if (o.geometry !== this.ringGeometry) o.geometry.dispose(); }
        for (const mat of m.materials) mat.dispose();
        if (m.label) m.label.material.dispose();
      }
      this.markers = [];
      this.builtFor = -1;
    }

    /** Each frame: build, clear or restyle the markers to the game's state. `now` in ms for the pulse. */
    update(now) {
      const game = this.game;
      const engaged = !!game.replayEngaged && game.sim.recorded.length > 0;
      if (!engaged) {
        if (this.markers.length) this._clear();
        this.group.visible = false;
        this.engaged = false;
        return;
      }
      this.engaged = true;
      if (this.builtFor !== game.sim.recordVersion) this._build();
      this.group.visible = true;
      const frame = game.sim.currentIteration;
      let next = null;
      for (const m of this.markers) if (m.frame >= frame && (!next || m.frame < next.frame)) next = m;
      const pulse = 0.65 + 0.35 * Math.abs(Math.sin((now || 0) / 250));
      for (const m of this.markers) {
        const played = m.frame < frame;
        const opacity = played ? 1 : m === next ? pulse : FUTURE_OPACITY;
        for (let i = 0; i < m.materials.length; i++) {
          const mat = m.materials[i];
          mat.opacity = opacity;
          if (mat.map && this.hidden) mat.opacity = 0; // the pictures put away (clear physics), the pins stay
        }
        if (played) { m.label.visible = false; continue; }
        const seconds = Math.ceil((m.frame - frame) / 17);
        if (seconds !== m.labelSeconds) {
          m.labelSeconds = seconds;
          m.label.material.map = this._labelTexture(seconds);
          m.label.material.needsUpdate = true;
        }
        m.label.material.opacity = opacity;
        m.label.visible = !this.hidden;
      }
    }

    /** The pictures hidden (the pins stay): clear physics mode. */
    setHidden(hidden) { this.hidden = !!hidden; }

    dispose() {
      this._clear();
      for (const e of this.textures.values()) e.texture.dispose();
      for (const t of this.labels.values()) t.dispose();
      this.textures.clear(); this.labels.clear();
      this.ringGeometry.dispose();
      this.worldGroup.remove(this.group);
    }
  }

  window.ReplayMarkers = ReplayMarkers;
})();
