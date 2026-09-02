"use strict";
/**
 * Bitmaps and the pixel arithmetic NeoLemmix draws with.
 *
 * A Bitmap is {width, height, data} with RGBA bytes, the layout a canvas
 * ImageData uses, so a Uint32 view of it is ABGR on a little-endian machine -
 * the same word layout Lemmings.Frame keeps. The combine rules are ported
 * from LemRendering.pas (CombineTerrain*, CombineGadgets*, the physics-prep
 * channels) and Graphics32's MergeMem; the nine-slice from LemTypes.pas.
 *
 * Usable from the page (window.Lemmix) and from node (module.exports).
 */
(function (root) {
  const Lemmix = root.Lemmix || (root.Lemmix = {});

  class Bitmap {
    constructor(width, height, data) {
      this.width = width | 0;
      this.height = height | 0;
      this.data = data || new Uint8ClampedArray(this.width * this.height * 4);
    }

    clone() { return new Bitmap(this.width, this.height, new Uint8ClampedArray(this.data)); }

    /** A Uint32 view (ABGR words), sharing the bytes. */
    words() { return new Uint32Array(this.data.buffer, this.data.byteOffset, this.width * this.height); }

    /** Rotate 90° clockwise, like TBitmap32.Rotate90. */
    rotate90() {
      const w = this.width, h = this.height;
      const out = new Bitmap(h, w);
      const s = this.words(), d = out.words();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // (x, y) -> (h - 1 - y, x)
          d[x * h + (h - 1 - y)] = s[y * w + x];
        }
      }
      return out;
    }

    flipHorizontal() {
      const w = this.width, h = this.height;
      const out = new Bitmap(w, h);
      const s = this.words(), d = out.words();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) d[y * w + (w - 1 - x)] = s[y * w + x];
      }
      return out;
    }

    flipVertical() {
      const w = this.width, h = this.height;
      const out = new Bitmap(w, h);
      const s = this.words(), d = out.words();
      for (let y = 0; y < h; y++) d.set(s.subarray(y * w, y * w + w), (h - 1 - y) * w);
      return out;
    }

    /** A sub-rectangle as its own bitmap. */
    crop(x0, y0, w, h) {
      const out = new Bitmap(w, h);
      const s = this.words(), d = out.words();
      for (let y = 0; y < h; y++) d.set(s.subarray((y0 + y) * this.width + x0, (y0 + y) * this.width + x0 + w), y * w);
      return out;
    }

    /** The frames of a strip (vertical unless `horizontal`). */
    frames(count, horizontal) {
      const out = [];
      if (horizontal) {
        const fw = Math.floor(this.width / count);
        for (let i = 0; i < count; i++) out.push(this.crop(i * fw, 0, fw, this.height));
      } else {
        const fh = Math.floor(this.height / count);
        for (let i = 0; i < count; i++) out.push(this.crop(0, i * fh, this.width, fh));
      }
      return out;
    }

    /** Multiply the colour channels by a colour (MaskImageFromImage's first step). */
    tinted(rgb) {
      const out = this.clone();
      const d = out.data;
      const mr = (rgb >> 16) & 255, mg = (rgb >> 8) & 255, mb = rgb & 255;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = (d[i] * mr / 255) | 0;
        d[i + 1] = (d[i + 1] * mg / 255) | 0;
        d[i + 2] = (d[i + 2] * mb / 255) | 0;
      }
      return out;
    }
  }

  // ------------------------------------------------------------ combining

  /**
   * Graphics32 MergeMem: `f` over `b`, both RGBA byte offsets into their
   * arrays. Writes the result into b's slot.
   */
  function mergeOver(fd, fi, bd, bi) {
    const fa = fd[fi + 3];
    if (fa === 0) return;
    if (fa === 255) {
      bd[bi] = fd[fi]; bd[bi + 1] = fd[fi + 1]; bd[bi + 2] = fd[fi + 2]; bd[bi + 3] = 255;
      return;
    }
    const ba = bd[bi + 3];
    if (ba === 0) {
      bd[bi] = fd[fi]; bd[bi + 1] = fd[fi + 1]; bd[bi + 2] = fd[fi + 2]; bd[bi + 3] = fa;
      return;
    }
    const ra = fa + ba - Math.round(fa * ba / 255);
    const wf = fa / ra, wb = (ba * (255 - fa) / 255) / ra;
    bd[bi] = Math.round(fd[fi] * wf + bd[bi] * wb);
    bd[bi + 1] = Math.round(fd[fi + 1] * wf + bd[bi + 1] * wb);
    bd[bi + 2] = Math.round(fd[fi + 2] * wf + bd[bi + 2] * wb);
    bd[bi + 3] = ra;
  }

  /** CombineTerrainDefault: paint where the piece has any alpha. */
  function combineTerrainDefault(fd, fi, bd, bi) {
    if (fd[fi + 3] !== 0) mergeOver(fd, fi, bd, bi);
  }

  /** CombineTerrainNoOverwrite: the existing pixel stays in front. */
  const scratch = new Uint8ClampedArray(4);
  function combineTerrainNoOverwrite(fd, fi, bd, bi) {
    if (fd[fi + 3] === 0) return;
    scratch[0] = fd[fi]; scratch[1] = fd[fi + 1]; scratch[2] = fd[fi + 2]; scratch[3] = fd[fi + 3];
    mergeOver(bd, bi, scratch, 0);
    bd[bi] = scratch[0]; bd[bi + 1] = scratch[1]; bd[bi + 2] = scratch[2]; bd[bi + 3] = scratch[3];
  }

  function solidityErase(f, b) {
    if (f === 0) return b;
    if (f === 255 || b === 0) return 0;
    return Math.round((1 - f / 255) * (b / 255) * 255);
  }

  function solidity(f, b) {
    if (f === 0) return b;
    if (b === 0) return f;
    if (f === 255 || b === 255) return 255;
    return Math.round((1 - (1 - f / 255) * (1 - b / 255)) * 255);
  }

  /** CombineTerrainErase: only the alpha changes. */
  function combineTerrainErase(fd, fi, bd, bi) {
    bd[bi + 3] = solidityErase(fd[fi + 3], bd[bi + 3]);
  }

  /** CombineGadgetsDefault: opaque replaces, translucent merges. */
  function combineGadget(fd, fi, bd, bi) {
    const fa = fd[fi + 3];
    if (fa === 255) {
      bd[bi] = fd[fi]; bd[bi + 1] = fd[fi + 1]; bd[bi + 2] = fd[fi + 2]; bd[bi + 3] = 255;
    } else if (fa !== 0) {
      mergeOver(fd, fi, bd, bi);
    }
  }

  // The physics-prep info map keeps four channels per pixel, in RGBA order:
  //   R = steel, G = one-way eligible, B = erase (source only), A = solidity
  // (LemRendering.pas says A/R/G/B for its own word order; same channels.)
  function property(f, b, intensity) {
    return b + Math.round((f - b) * (intensity / 255));
  }

  function physicsPrepInternal(sSol, sSteel, sOne, sErase, bd, bi) {
    let dSol = bd[bi + 3], dSteel = bd[bi], dOne = bd[bi + 1];
    if (sErase > 0) {
      dSol = solidityErase(sErase, dSol);
      if (dSol === 0) { dSteel = 0; dOne = 0; }
      else { dSteel = property(0, dSteel, sErase); dOne = property(0, dOne, sErase); }
    } else {
      dSol = solidity(sSol, dSol);
      dSteel = property(sSteel, dSteel, sSol);
      dOne = property(sOne, dOne, sSol);
    }
    bd[bi] = dSteel; bd[bi + 1] = dOne; bd[bi + 3] = dSol;
  }

  /**
   * A physics-prep combiner for one piece: `kind` is "standard", "steel",
   * "oneway" or "erase"; `noOverwrite` swaps the roles (the existing pixel
   * is drawn over the new one), except for erasers.
   */
  function physicsCombiner(kind, noOverwrite) {
    const steel = kind === "steel" ? 255 : 0;
    const oneWay = kind === "oneway" ? 255 : 0;
    if (kind === "erase") {
      return (fd, fi, bd, bi) => physicsPrepInternal(0, 0, 0, fd[fi + 3], bd, bi);
    }
    if (!noOverwrite) {
      return (fd, fi, bd, bi) => physicsPrepInternal(fd[fi + 3], steel, oneWay, 0, bd, bi);
    }
    const tmp = new Uint8ClampedArray(4);
    return (fd, fi, bd, bi) => {
      // Internal(B, F) then B := F : the new piece is the base, the old pixel is drawn onto it
      tmp[0] = steel; tmp[1] = oneWay; tmp[2] = 0; tmp[3] = fd[fi + 3];
      physicsPrepInternal(bd[bi + 3], bd[bi], bd[bi + 1], 0, tmp, 0);
      bd[bi] = tmp[0]; bd[bi + 1] = tmp[1]; bd[bi + 2] = 0; bd[bi + 3] = tmp[3];
    };
  }

  // ------------------------------------------------------------- drawing

  /** Draw src's rect (sx, sy, w, h) at (dx, dy) on dst through `combine`, clipped. */
  function blit(dst, dx, dy, src, sx, sy, w, h, combine) {
    const x0 = Math.max(0, -dx), y0 = Math.max(0, -dy);
    const x1 = Math.min(w, dst.width - dx), y1 = Math.min(h, dst.height - dy);
    if (x1 <= x0 || y1 <= y0) return;
    const sd = src.data, dd = dst.data;
    for (let y = y0; y < y1; y++) {
      let si = ((sy + y) * src.width + sx + x0) * 4;
      let di = ((dy + y) * dst.width + dx + x0) * 4;
      for (let x = x0; x < x1; x++, si += 4, di += 4) combine(sd, si, dd, di);
    }
  }

  /**
   * LemTypes.pas DrawNineSlice: fill (dx, dy, dw, dh) on dst from src, with
   * the margins {left, top, right, bottom} kept at the edges and everything
   * else tiled. With zero margins the whole image simply tiles.
   */
  function drawNineSlice(dst, dx, dy, dw, dh, src, margins, combine) {
    const sw = src.width, sh = src.height;
    if (dw === sw && dh === sh) { blit(dst, dx, dy, src, 0, 0, sw, sh, combine); return; }
    let ml = margins.left | 0, mt = margins.top | 0, mr = margins.right | 0, mb = margins.bottom | 0;
    const trim = (a, b, size) => {
      const overlap = (a + b) - size;
      if (overlap <= 0) return [a, b];
      a -= overlap >> 1; b -= overlap >> 1;
      if (overlap % 2 === 1) { if (a >= b) a--; else b--; }
      if (a < 0) { b += a; a = 0; }
      if (b < 0) { a += b; b = 0; }
      return [a, b];
    };
    [ml, mr] = trim(ml, mr, dw);
    [mt, mb] = trim(mt, mb, dh);
    const rects = (x, y, w, h) => {
      const vw = w - (ml + mr), vh = h - (mt + mb);
      return [
        [x, y, ml, mt], [x + ml, y, vw, mt], [x + ml + vw, y, mr, mt],
        [x, y + mt, ml, vh], [x + ml, y + mt, vw, vh], [x + ml + vw, y + mt, mr, vh],
        [x, y + mt + vh, ml, mb], [x + ml, y + mt + vh, vw, mb], [x + ml + vw, y + mt + vh, mr, mb],
      ];
    };
    const srcRects = rects(0, 0, sw, sh), dstRects = rects(dx, dy, dw, dh);
    for (let i = 0; i < 9; i++) {
      const [sx, sy, sww, shh] = srcRects[i];
      const [tx, ty, tw, th] = dstRects[i];
      if (sww <= 0 || shh <= 0 || tw <= 0 || th <= 0) continue;
      // DrawTiled: whole tiles, then the remainder
      const countX = Math.floor((tw - 1) / sww), countY = Math.floor((th - 1) / shh);
      for (let iy = 0; iy <= countY; iy++) {
        const h = iy === countY ? ((th - 1) % shh) + 1 : shh;
        for (let ix = 0; ix <= countX; ix++) {
          const w = ix === countX ? ((tw - 1) % sww) + 1 : sww;
          blit(dst, tx + ix * sww, ty + iy * shh, src, sx, sy, w, h, combine);
        }
      }
    }
  }

  Lemmix.Bitmap = Bitmap;
  Lemmix.Pixels = {
    mergeOver, combineTerrainDefault, combineTerrainNoOverwrite, combineTerrainErase,
    combineGadget, physicsCombiner, blit, drawNineSlice, solidity, solidityErase,
    ALPHA_CUTOFF: 0x80,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { Bitmap, Pixels: Lemmix.Pixels };
  }
})(typeof window !== "undefined" ? window : globalThis);
