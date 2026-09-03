"use strict";
/**
 * NeoLemmix's cursor, for both engines: a cross over the level, a square
 * once a lemming is under it, and a small arrow beside either while the
 * direction filter is on - six pictures composed from gfx/cursor's
 * standard.png, focused.png, direction_left.png and direction_right.png
 * (GameWindow.pas LoadCursors / SetCurrentCursor), 16 px with a 32 px
 * twin from gfx/cursor-hr for dense screens. The hot spot is the cross's
 * centre, pixel (8, 8) of the 16 px picture.
 *
 * On the desktop the picture becomes the canvas's CSS cursor. In a headset
 * it becomes a sprite where the beam lands on the board (vr.js), sized to
 * sixteen level pixels at the board's scale. When the NeoLemmix assets are
 * not installed nothing changes: the page keeps its own pointer and ring.
 */

const CURSOR_FILES = ["standard", "focused", "direction_left", "direction_right"];
const CURSOR_HOTSPOT = 8;   // of 16
const CURSOR_LEVEL_PX = 16; // how many level pixels the picture spans

class GameCursor {
  constructor() {
    this.ok = false;
    this.css = {};        // key -> the cursor value, with the 2x picture where it exists
    this.cssPlain = {};   // key -> the 1x-only value, set first in case image-set is refused
    this.canvases = {};   // key -> the largest picture, for textures
    this._textures = {};
  }

  /** Load from `root` (the repo root as seen from the page); resolves to a cursor that may not be `ok`. */
  static async load(root) {
    const cursor = new GameCursor();
    const dir = (typeof Lemmix !== "undefined" && Lemmix.ASSET_DIR) || "neolemmix/";
    const fetchImage = (sub, name) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = root + dir + "gfx/" + sub + "/" + name + ".png";
    });
    const lo = {}, hi = {};
    await Promise.all(CURSOR_FILES.map(async (n) => { lo[n] = await fetchImage("cursor", n); hi[n] = await fetchImage("cursor-hr", n); }));
    if (CURSOR_FILES.some((n) => !lo[n])) return cursor;
    const hasHi = CURSOR_FILES.every((n) => !!hi[n]);
    const compose = (set, kind, side, size) => {
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(set[kind], 0, 0, size, size);
      if (side) ctx.drawImage(set["direction_" + side], 0, 0, size, size);
      return canvas;
    };
    for (const kind of ["standard", "focused"]) {
      for (const side of ["", "left", "right"]) {
        const key = kind + (side ? "-" + side : "");
        const c16 = compose(lo, kind, side, 16);
        const c32 = hasHi ? compose(hi, kind, side, 32) : null;
        cursor.canvases[key] = c32 || c16;
        const hot = CURSOR_HOTSPOT + " " + CURSOR_HOTSPOT;
        cursor.cssPlain[key] = 'url("' + c16.toDataURL() + '") ' + hot + ", crosshair";
        cursor.css[key] = c32
          ? '-webkit-image-set(url("' + c16.toDataURL() + '") 1x, url("' + c32.toDataURL() + '") 2x) ' + hot + ", crosshair"
          : cursor.cssPlain[key];
      }
    }
    cursor.ok = true;
    return cursor;
  }

  /** Which of the six: a lemming under the pointer, and the direction filter. */
  static key(focused, selectDx) {
    return (focused ? "focused" : "standard") + (selectDx < 0 ? "-left" : selectDx > 0 ? "-right" : "");
  }

  /** The page's pointer over `element` becomes this cursor. */
  apply(element, focused, selectDx) {
    if (!this.ok || !element) return;
    const key = GameCursor.key(focused, selectDx);
    if (element.dataset.gameCursor === key) return;
    element.dataset.gameCursor = key;
    element.style.cursor = this.cssPlain[key];
    element.style.cursor = this.css[key];
  }

  clear(element) {
    if (!element || !element.dataset.gameCursor) return;
    delete element.dataset.gameCursor;
    element.style.cursor = "";
  }

  /** The picture as a texture for a sprite in the scene (cached). */
  texture(focused, selectDx) {
    if (!this.ok) return null;
    const key = GameCursor.key(focused, selectDx);
    if (!this._textures[key]) {
      const t = new THREE.CanvasTexture(this.canvases[key]);
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      this._textures[key] = t;
    }
    return this._textures[key];
  }

  /** A sprite to put where a beam lands on the board. */
  makeSprite(renderOrder) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.texture(false, 0), transparent: true, depthTest: false, depthWrite: false,
    }));
    sprite.renderOrder = renderOrder;
    sprite.visible = false;
    return sprite;
  }

  /** Dress a sprite for the moment: its picture, and its size for a board drawn at `pixelScale` world units per level pixel. */
  dressSprite(sprite, focused, selectDx, pixelScale) {
    const t = this.texture(focused, selectDx);
    if (sprite.material.map !== t) { sprite.material.map = t; sprite.material.needsUpdate = true; }
    const size = CURSOR_LEVEL_PX * pixelScale;
    sprite.scale.set(size, size, 1);
  }
}
