"use strict";
/**
 * Decals: the objects drawn on the terrain's face rather than standing in
 * front of it.
 *
 * NeoLemmix keeps two layers of them over its terrain (LemRendering.pas,
 * DrawGadgetsOnLayer; LemRenderHelpers.pas, CombineLayers): the ONLY_ON_TERRAIN
 * gadgets, cut to the pixels that were solid when the level began, and the
 * one-way arrows, cut to the pixels the physics map marks PM_ONEWAY - the
 * one-way pieces under exactly one arrow, steel excluded. The DOS game draws
 * its "only on terrain" objects (its one-way arrows among them) the same way,
 * cut to the solid pixels.
 *
 * In the diorama those objects used to be sprites on a plane a quarter pixel
 * in front of the slab (OBJECT_DECAL_Z), which drew the whole sprite - the
 * arrows' square around the piece - and put it behind any colour-keyed
 * relief the piece had. Here they are painted, cut, into one level-sized
 * texture every tick (the arrows animate), and the terrain gives the pixels
 * they can reach a second skin a hair in front of its own face, whatever
 * height that face is at (terrain.js, setDecals). A dug pixel loses its face
 * and its decal with it, as it loses its paint here.
 */

/** NeoLemmix's PM_ONEWAY (lemmix/js/level.js PM): a one-way piece under one arrow. */
const DECAL_PM_ONEWAY = 0x0004;

class TerrainDecals {
  /**
   * `coverage`: one byte per level pixel, non-zero where some decal object can
   * draw - what the terrain builds the skin for. `physics`: the Lemmix physics
   * map (null for a DOS level, which has no one-way arrows to cut by it).
   */
  constructor(level, resources, coverage, physics) {
    this.w = level.width;
    this.h = level.height;
    this.ground = level.getGroundMaskLayer().groundMask;
    this.physics = physics || null;
    this.coverage = coverage;
    this.data = new Uint8Array(this.w * this.h * 4);
    this.texture = resources.track(new THREE.DataTexture(this.data, this.w, this.h, THREE.RGBAFormat));
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
    this.painted = []; // the rects painted last time, to clear before the next
  }

  /**
   * The decals of a level, or null when it has none: every object drawn
   * "only on terrain" (a DOS draw flag, a NeoLemmix gadget flag, and every
   * one-way arrow, see gadgetAsObject in lemmix/js/level.js), covering the
   * union of its frames' rects.
   */
  static forLevel(level, resources, physics) {
    const w = level.width, h = level.height;
    const coverage = new Uint8Array(w * h);
    let any = false;
    for (const object of level.objects || []) {
      const props = object.drawProperties;
      if (!props || !props.onlyOverwrite) continue;
      const frames = (object.animation && object.animation.frames) || [];
      for (const frame of frames) {
        if (!frame) continue;
        const x0 = Math.max(0, object.x + (frame.offsetX || 0));
        const y0 = Math.max(0, object.y + (frame.offsetY || 0));
        const x1 = Math.min(w, object.x + (frame.offsetX || 0) + frame.width);
        const y1 = Math.min(h, object.y + (frame.offsetY || 0) + frame.height);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) { coverage[x + y * w] = 1; any = true; }
        }
      }
    }
    return any ? new TerrainDecals(level, resources, coverage, physics) : null;
  }

  /** May a decal of this kind show on this pixel now? */
  _admits(i, oneWay) {
    if (oneWay) return this.physics ? (this.physics[i] & DECAL_PM_ONEWAY) !== 0 : this.ground[i] !== 0;
    return this.ground[i] !== 0;
  }

  /**
   * Repaint from this tick's captured draws (bridge.js SpriteCapture items of
   * layer 1). `oneWayOnly`: clear physics mode, where NeoLemmix leaves the
   * on-terrain gadgets out and keeps the arrows.
   */
  paint(items, oneWayOnly) {
    const w = this.w, h = this.h, data = this.data;
    for (const r of this.painted) {
      for (let y = r[1]; y < r[3]; y++) data.fill(0, (y * w + r[0]) * 4, (y * w + r[2]) * 4);
    }
    this.painted.length = 0;
    for (const item of items) {
      if (!item.frame) continue;
      if (oneWayOnly && !item.oneWay) continue;
      const frame = item.frame;
      const fw = frame.width, fh = frame.height;
      const src = frame.getData();
      // where the frame is transparent: its mask (the DOS engine clears a
      // pixel to opaque black and marks the mask; a Lemmix frame's mask
      // follows its alpha, which may be partial)
      const mask = frame.getMask ? frame.getMask() : null;
      const ox = item.x + frame.offsetX, oy = item.y + frame.offsetY;
      const x0 = Math.max(0, ox), y0 = Math.max(0, oy);
      const x1 = Math.min(w, ox + fw), y1 = Math.min(h, oy + fh);
      if (x1 <= x0 || y1 <= y0) continue;
      for (let y = y0; y < y1; y++) {
        const sy = item.flipY ? fh - 1 - (y - oy) : y - oy;
        for (let x = x0; x < x1; x++) {
          const si = sy * fw + (x - ox), s = si * 4;
          if (mask && mask[si] === 0) continue;
          let a = src[s + 3];
          if (a === 0) { if (!mask) continue; a = 255; }
          const i = x + y * w;
          if (!this._admits(i, item.oneWay)) continue;
          const d = i * 4;
          if (a === 255 || data[d + 3] === 0) {
            data[d] = src[s]; data[d + 1] = src[s + 1]; data[d + 2] = src[s + 2]; data[d + 3] = a;
          } else {
            // "over": this pixel on what an earlier decal left here
            const sa = a / 255, da = data[d + 3] / 255, oa = sa + da * (1 - sa);
            for (let k = 0; k < 3; k++) {
              data[d + k] = Math.round((src[s + k] * sa + data[d + k] * da * (1 - sa)) / oa);
            }
            data[d + 3] = Math.round(oa * 255);
          }
        }
      }
      this.painted.push([x0, y0, x1, y1]);
    }
    this.texture.needsUpdate = true;
  }
}
