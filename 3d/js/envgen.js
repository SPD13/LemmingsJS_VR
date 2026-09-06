"use strict";
/**
 * The environment's pictures: a floor, a back wall and a ceiling around the
 * board, drawn in the level's own pixel art (environment.js hangs them in
 * the scene). Three layers, each standing on the one below:
 *
 *  - ambient: gradients dithered between the level's own colours - the
 *    style's theme colours, the colours its blend map sampled from the
 *    picture (depth.js buildBlendMap), a DOS tileset's ground palette;
 *  - wallpaper: the style's background image, the one the level names or
 *    the one its profile does, tiled on the back wall (a picture placed once
 *    when it is a prop rather than a wallpaper);
 *  - collage: the level's own terrain pieces laid as a ground strip in
 *    front of and below the board, hanging as overhangs above it, and
 *    standing far behind it, from a generator seeded with the level's id so
 *    a level always gets the same place.
 *
 * Every picture is a Lemmix.Bitmap at the plane's own pixel size, coarser
 * than the board's (ROOM.k*), so the environment reads as further away and
 * never competes with the play area; all shading is baked in, the scene
 * being unlit. Pure pixels, no three.js: runs under node too
 * (tools/env-gen.js), like depth.js and profile-store.js.
 */
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  const Lx = isNode ? require("../../lemmix/js/pixels.js") : root.Lemmix;
  const D = isNode ? require("./depth.js") : { blendLuma, blendNear };
  const PS = isNode ? require("./profile-store.js").ProfileStore : root.ProfileStore;
  const Bitmap = Lx.Bitmap, Pixels = Lx.Pixels;

  // ------------------------------------------------------------ the room
  // Metres, turned into board pixels with the pixels-per-metre the headset
  // uses (1 / VR_PIXEL_SCALE), on the desktop too so the room keeps its
  // proportions in both views.
  const ROOM = {
    SIDE_M: 1.5,      // the floor, wall and ceiling reach this far past each end of the board
    BEHIND_M: 1.0,    // the back wall stands this far behind the slab's back face
    FRONT_M: 3.0,     // the floor and ceiling reach this far toward (and past) the player
    CEIL_M: 2.6,      // the ceiling's height above the physical floor
    FLOOR_DROP_M: 0.5, // the desktop's floor, this far below the board's bottom edge
    TEX: { floor: [1024, 512], ceiling: [1024, 512], wall: [1024, 256], side: [256, 256] },
    WALL_K: 1.5,      // the wall's pixels, coarser again than the floor's: it is further away
  };

  /** The room's sizes in board pixels for a level `W` wide, and each
   *  picture's size and pixel scale (`k` board pixels per picture pixel). */
  function roomFor(W, H, pxPerMetre) {
    const P = pxPerMetre;
    const sidePx = Math.round(ROOM.SIDE_M * P), behindPx = Math.round(ROOM.BEHIND_M * P);
    const frontPx = Math.round(ROOM.FRONT_M * P);
    const floorDrop = Math.round(ROOM.FLOOR_DROP_M * P);
    const wallPx = Math.round(ROOM.CEIL_M * P) + floorDrop; // the nominal wall height
    const spanX = W + 2 * sidePx, spanZ = behindPx + frontPx;
    const kFloor = Math.max(1, Math.ceil(Math.max(spanX / ROOM.TEX.floor[0], spanZ / ROOM.TEX.floor[1])));
    const kWall = Math.max(1, Math.ceil(spanX / ROOM.TEX.wall[0] * ROOM.WALL_K));
    const pic = (k, w, h) => ({ k, w: Math.ceil(w / k), h: Math.ceil(h / k) });
    return {
      W, H, sidePx, behindPx, frontPx, floorDrop, wallPx, spanX, spanZ,
      floor: pic(kFloor, spanX, spanZ),
      ceiling: pic(kFloor, spanX, spanZ),
      wall: pic(kWall, spanX, wallPx),
      side: { k: kWall, w: ROOM.TEX.side[0], h: ROOM.TEX.side[1] },
    };
  }

  // ------------------------------------------------------------- colours
  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v) | 0;
  const rgbOf = (r, g, b) => (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);
  const R = (c) => (c >> 16) & 255, G = (c) => (c >> 8) & 255, B = (c) => c & 255;
  /** A colour with its channels multiplied by `f`. */
  const scale = (c, f) => rgbOf(R(c) * f, G(c) * f, B(c) * f);
  const mix = (a, b, t) => rgbOf(R(a) + (R(b) - R(a)) * t, G(a) + (G(b) - G(a)) * t, B(a) + (B(b) - B(a)) * t);
  const dist2 = (a, b) => {
    const dr = R(a) - R(b), dg = G(a) - G(b), db = B(a) - B(b);
    return dr * dr * 2 + dg * dg * 4 + db * db * 3; // weighted toward what the eye ranks
  };
  const luma = D.blendLuma;
  const parseHex = (s) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(s || "").trim());
    return m ? parseInt(m[1], 16) : null;
  };

  /** Keep the distinct colours of a list (BLEND_MERGE apart), in order. */
  function distinct(list) {
    const out = [];
    for (const c of list) if (!out.some((o) => D.blendNear(o, c))) out.push(c);
    return out;
  }

  /**
   * The level's colours: `material`, the colours its picture is made of,
   * lightest first; `bg`, the colour behind everything; `dark` and `light`,
   * the ends of the range; `accent`, the theme's mask colour; `source`, where
   * they came from.
   */
  function derivePalette(ctx) {
    const env = (ctx.profile && ctx.profile.environment) || {};
    const theme = ctx.theme && ctx.theme.colors ? ctx.theme.colors : {};
    let material = [], source = "fallback";
    if (env.palette && Array.isArray(env.palette.material)) {
      material = env.palette.material.map(parseHex).filter((c) => c !== null);
      if (material.length) source = "profile";
    }
    if (material.length < 3 && ctx.donors && ctx.donors.length) {
      const all = [];
      for (const slot of ctx.donors) for (const d of slot) all.push(rgbOf(d.r, d.g, d.b));
      material = distinct(material.concat(all));
      if (material.length >= 3) source = "donors";
    }
    if (material.length < 3 && ctx.groundImage && ctx.width && ctx.height) {
      material = distinct(material.concat(histogram(ctx)));
      if (material.length >= 3) source = "histogram";
    }
    if (material.length < 3 && ctx.dosPalette) {
      const pal = ctx.dosPalette, list = [];
      for (let i = 0; i < 16; i++) {
        let c;
        try { c = rgbOf(pal.getR(i), pal.getG(i), pal.getB(i)); } catch (e) { break; }
        if (luma(c) > 8) list.push(c);
      }
      material = distinct(material.concat(list));
      if (material.length >= 3) source = "dos";
    }
    if (material.length < 3) material = distinct(material.concat([0x3a4658, 0x2a3140, 0x1c2230]));
    material = material.filter((c) => luma(c) > 6).slice(0, 12);
    if (!material.length) material = [0x3a4658, 0x2a3140, 0x1c2230];
    material.sort((a, b) => luma(b) - luma(a));

    const light = material[0];
    // the darkest colour that is still a colour, not the outline black many
    // styles draw with
    const dark = material.slice().reverse().find((c) => luma(c) >= 10) || material[material.length - 1];
    const themeBg = (env.palette && parseHex(env.palette.bg)) ?? (theme.BACKGROUND !== undefined ? theme.BACKGROUND : 0);
    const bg = luma(themeBg) > 4 ? themeBg : scale(dark, 0.45);
    const accent = theme.MASK !== undefined ? theme.MASK : (theme.MINIMAP !== undefined ? theme.MINIMAP : dark);
    return { material, bg, dark, light, accent, source };
  }

  /** The most common colours of the level's solid pixels, 5 bits a channel. */
  function histogram(ctx) {
    const img = ctx.groundImage, mask = ctx.groundMask || null;
    const w = ctx.width, h = ctx.height, bins = new Map();
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 200000)));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = y * w + x, p = i * 4;
        if (mask ? !mask[i] : img[p + 3] < Pixels.ALPHA_CUTOFF) continue;
        const key = ((img[p] >> 3) << 10) | ((img[p + 1] >> 3) << 5) | (img[p + 2] >> 3);
        bins.set(key, (bins.get(key) || 0) + 1);
      }
    }
    return Array.from(bins.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k]) => rgbOf(((k >> 10) & 31) << 3, ((k >> 5) & 31) << 3, (k & 31) << 3));
  }

  // ----------------------------------------------------------- gradients
  const BAYER = [
    [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
  ];
  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  /** The colour a gradient wants at `t`, between its stops. */
  function stopColor(stops, t) {
    if (t <= stops[0].t) return stops[0].rgb;
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i].t) {
        const a = stops[i - 1], b = stops[i];
        return mix(a.rgb, b.rgb, (t - a.t) / Math.max(1e-6, b.t - a.t));
      }
    }
    return stops[stops.length - 1].rgb;
  }

  /**
   * A gradient across a bitmap, quantised to a palette with an ordered
   * dither so it reads as pixel art rather than as a smooth ramp: each pixel
   * takes the nearer of its two closest palette colours, the Bayer threshold
   * deciding between them in proportion to the distances. `stops` are
   * `{t, rgb}` along `axis` ("v" down the rows, "u" along the columns);
   * `opts.vignette` darkens toward the edges, `opts.cell` draws the dither in
   * blocks of that many pixels.
   */
  function paintGradient(bmp, stops, axis, opts) {
    const w = bmp.width, h = bmp.height, d = bmp.data;
    const pal = quantPalette(opts.palette || [], opts.dark);
    const vig = opts.vignette || 0, cell = Math.max(1, opts.cell | 0);
    const alongV = axis !== "u";
    const cache = new Map(); // target colour -> [nearest, second, fraction]
    for (let y = 0; y < h; y++) {
      const v = h > 1 ? y / (h - 1) : 0;
      for (let x = 0; x < w; x++) {
        const u = w > 1 ? x / (w - 1) : 0;
        let c = stopColor(stops, alongV ? v : u);
        if (vig) {
          const e = 2 * Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5));
          c = scale(c, 1 - vig * smoothstep(0.55, 1, e));
        }
        let q = cache.get(c);
        if (!q) { q = nearestPair(pal, c); cache.set(c, q); }
        const th = BAYER[((y / cell) | 0) & 7][((x / cell) | 0) & 7] / 64;
        const out = q[2] > th ? q[1] : q[0];
        const p = (y * w + x) * 4;
        d[p] = R(out); d[p + 1] = G(out); d[p + 2] = B(out); d[p + 3] = 255;
      }
    }
    return bmp;
  }

  /** The palette a gradient may use: the level's colours and darker rungs
   *  of its dark one, down to black. */
  function quantPalette(material, dark) {
    const base = dark !== undefined ? dark : (material[material.length - 1] || 0x202020);
    return distinct(material.concat([scale(base, 0.66), scale(base, 0.4), scale(base, 0.2), 0x000000]));
  }

  function nearestPair(pal, c) {
    let a = pal[0], da = Infinity, b = pal[0], db = Infinity;
    for (const p of pal) {
      const dd = dist2(p, c);
      if (dd < da) { b = a; db = da; a = p; da = dd; } else if (dd < db) { b = p; db = dd; }
    }
    const frac = da + db > 0 ? da / (da + db) : 0;
    return [a, b, frac];
  }

  /** Multiply a bitmap's colours by `f`, rows `y0..y1` and columns `x0..x1`,
   *  with an optional per-pixel weight `(x, y) => 0..1` of how much of the
   *  darkening applies. */
  function darken(bmp, f, x0, y0, x1, y1, weight) {
    const w = bmp.width, d = bmp.data;
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
    x1 = Math.min(w, x1 | 0); y1 = Math.min(bmp.height, y1 | 0);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const k = weight ? 1 - (1 - f) * weight(x, y) : f;
        const p = (y * w + x) * 4;
        d[p] = (d[p] * k) | 0; d[p + 1] = (d[p + 1] * k) | 0; d[p + 2] = (d[p + 2] * k) | 0;
      }
    }
  }

  // -------------------------------------------------------- backgrounds
  // Backgrounds that are a picture placed once, not a wallpaper, when the
  // heuristic below would tile them
  const PROPS = new Set(["orig_dirt:nessy", "davidz_fortune_ex:object_20", "davidz_fortune_ex:object_21"]);

  /** The fraction of a bitmap's pixels that are opaque enough to count. */
  function opaqueFraction(bmp) {
    const d = bmp.data;
    let n = 0;
    for (let p = 3; p < d.length; p += 4) if (d[p] >= Pixels.ALPHA_CUTOFF) n++;
    return n / (bmp.width * bmp.height);
  }

  /** Is a style background a wallpaper (tiled) or a prop (placed once)? */
  function classifyBackground(bmp, key, profile) {
    const env = (profile && profile.environment) || {};
    const name = String(key || "").split(":").pop();
    if (env.backgrounds && (env.backgrounds[key] || env.backgrounds[name])) {
      return env.backgrounds[key] || env.backgrounds[name];
    }
    if (PROPS.has(key)) return "prop";
    const opaque = opaqueFraction(bmp);
    if (opaque < 0.85) return "prop";
    if (bmp.width >= 4 * bmp.height && bmp.width >= 320 && opaque < 0.97) return "prop";
    return "wallpaper";
  }

  // --------------------------------------------------------------- pieces
  /** A piece's measurements: its opaque box, how full it is, whether it has a flat top. */
  function measure(img) {
    const w = img.width, h = img.height, d = img.data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, opaque = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] < Pixels.ALPHA_CUTOFF) continue;
        opaque++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    const bbox = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    let top = 0;
    for (let x = x0; x <= x1; x++) if (d[(y0 * w + x) * 4 + 3] >= Pixels.ALPHA_CUTOFF) top++;
    return { bbox, opaque, fill: opaque / (bbox.w * bbox.h), flatTop: top / bbox.w >= 0.7 };
  }

  /** A DOS terrain image (palette indices, 0x80 = transparent) as RGBA. */
  function dosBitmap(img) {
    const w = img.width, h = img.height, src = img.frames[0], pal = img.palette;
    const out = new Bitmap(w, h), d = out.data;
    for (let p = 0, o = 0; p < w * h; p++, o += 4) {
      const c = src[p];
      if ((c & 0x80) !== 0) continue;
      d[o] = pal.getR(c); d[o + 1] = pal.getG(c); d[o + 2] = pal.getB(c); d[o + 3] = 255;
    }
    return out;
  }

  /**
   * The pieces the level is made of, one entry per piece id with its
   * measurements, class and how often it is placed; and the decorations
   * (its objects that do nothing: signs, plants, the odd skull).
   */
  function collectPieces(ctx) {
    const env = (ctx.profile && ctx.profile.environment) || {};
    const exclude = new Set(env.exclude || []);
    const byKey = new Map();
    const note = (key, image, steel) => {
      if (!image || !image.width || !image.height) return;
      let e = byKey.get(key);
      if (!e) { e = { key, image, steel: !!steel, count: 0, variants: new Map() }; byKey.set(key, e); }
      e.count++;
      e.variants.set(image, (e.variants.get(image) || 0) + 1);
    };
    if (ctx.lemmixPieces) {
      for (const p of ctx.lemmixPieces) {
        if (!p.drawn || p.erase) continue;
        note(p.drawn.key, p.drawn.image, p.drawn.steel);
      }
    } else if (ctx.groundData && ctx.groundData.terraImages && ctx.groundData.lr) {
      const counts = new Map();
      for (const t of ctx.groundData.lr.terrains || []) counts.set(t.id, (counts.get(t.id) || 0) + 1);
      ctx.groundData.terraImages.forEach((img, id) => {
        if (!img || !img.frames || !img.frames[0] || !counts.get(id)) return;
        const bmp = dosBitmap(img);
        for (let i = 0; i < counts.get(id); i++) note(id, bmp, false);
      });
    }
    const pieces = [];
    for (const e of byKey.values()) {
      // the most-placed variant stands for the piece (a resized one still counts under its key)
      let image = e.image, best = -1;
      for (const [img, n] of e.variants) if (n > best) { best = n; image = img; }
      const m = measure(image);
      if (!m) continue;
      const cls = PS.classOf(String(e.key), ctx.profile);
      const area = m.bbox.w * m.bbox.h;
      const excluded = e.steel || cls === "overlay" || area < 16 || exclude.has(String(e.key));
      pieces.push({
        key: e.key, image, w: image.width, h: image.height, area, opaque: m.opaque, fill: m.fill,
        bbox: m.bbox, flatTop: m.flatTop, cls, steel: e.steel, count: e.count, excluded,
      });
    }
    const decor = [];
    for (const o of ctx.lemmixObjects || []) {
      const g = o.gadget;
      if (!g || !["NONE", "BACKGROUND", "PAINT"].includes(g.effectBase)) continue;
      const frame = o.animation && o.animation.frames && o.animation.frames[0];
      if (!frame || !frame.width || frame.width > 160 || frame.height > 160) continue;
      const m = measure(frame);
      if (!m || m.opaque < 16) continue;
      if (decor.some((d) => d.image === frame)) continue;
      decor.push({ key: "object", image: frame, w: frame.width, h: frame.height, bbox: m.bbox, area: m.bbox.w * m.bbox.h });
      if (decor.length >= 8) break;
    }
    return { pieces, decor };
  }

  /** The pieces sorted into what the collage draws with. */
  function buckets(collected, env) {
    const usable = collected.pieces.filter((p) => !p.excluded);
    const listed = (names) => (names || []).map((n) => usable.find((p) => String(p.key) === String(n))).filter(Boolean);
    let ground = usable.filter((p) => p.fill >= 0.45 && Math.max(p.bbox.w, p.bbox.h) >= 24 && p.cls !== "backdrop")
      .sort((a, b) => b.area - a.area);
    if (!ground.length) ground = usable.slice().sort((a, b) => b.area - a.area);
    const decor = usable.filter((p) => p.cls === "backdrop").concat(collected.decor);
    return {
      floor: listed(env.floor).length ? listed(env.floor) : ground,
      ceiling: listed(env.ceiling).length ? listed(env.ceiling) : ground,
      wall: listed(env.wall).length ? listed(env.wall) : ground,
      decor, ground, usable,
    };
  }

  /** "tile" for a style of small blocks of one size, else "clump". */
  function chooseMode(pieces, profile) {
    const env = (profile && profile.environment) || {};
    if (env.mode === "tile" || env.mode === "clump") return env.mode;
    const usable = pieces.filter((p) => !p.excluded);
    if (!usable.length) return "clump";
    const largest = Math.max.apply(null, usable.map((p) => Math.max(p.w, p.h)));
    const sizes = new Map();
    for (const p of usable) sizes.set(p.w + "x" + p.h, (sizes.get(p.w + "x" + p.h) || 0) + 1);
    const shared = Math.max.apply(null, Array.from(sizes.values()));
    return largest < 48 && shared >= 3 ? "tile" : "clump";
  }

  // ------------------------------------------------------------ randomness
  /** A small deterministic generator (level.js's), so a level always gets the same place. */
  function seededRandom(seed) {
    let s = 0;
    seed = String(seed);
    for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    s = s || 1;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  /** A smooth wobble in -1..1 along u, three sines with seeded phases. */
  function noiseFn(rng) {
    const f = [1.3, 2.9, 5.7], a = [0.5, 0.3, 0.2], ph = f.map(() => rng() * Math.PI * 2);
    return (u) => f.reduce((s, fi, i) => s + a[i] * Math.sin(2 * Math.PI * fi * u + ph[i]), 0);
  }

  function pickWeighted(list, rng, weight) {
    let total = 0;
    for (const p of list) total += weight(p);
    let r = rng() * total;
    for (const p of list) { r -= weight(p); if (r <= 0) return p; }
    return list[list.length - 1];
  }

  /** A piece's picture, flipped as asked and dimmed, cached per piece. */
  function dressed(piece, flipH, flipV, tint) {
    const key = (flipH ? "h" : "") + (flipV ? "v" : "") + tint;
    piece._dressed = piece._dressed || new Map();
    let img = piece._dressed.get(key);
    if (!img) {
      img = piece.image;
      if (flipH) img = img.flipHorizontal();
      if (flipV) img = img.flipVertical();
      if (tint !== 0xffffff) img = img.tinted(tint);
      piece._dressed.set(key, img);
    }
    return img;
  }

  const stamp = (dst, img, x, y) =>
    Pixels.blit(dst, x | 0, y | 0, img, 0, 0, img.width, img.height, Pixels.combineTerrainDefault);

  // -------------------------------------------------------------- collage
  const TINT = { floor: 0xb4b4b4, ceiling: 0x8c8c8c, wall: 0x6a6a6a, prop: 0x666666, wallpaper: 0x808080 };

  /**
   * The ground strip: pieces packed row by row from the wall's edge (row 0)
   * toward the player, under a wavy edge, the board's shadow across it and
   * decorations scattered beyond.
   */
  function drawFloor(bmp, room, bk, mode, rng, palette) {
    const W = bmp.width, H = bmp.height, noise = noiseFn(rng);
    const hl = (u) => H * (0.55 + 0.15 * noise(u));
    if (mode === "tile") drawTiles(bmp, bk, hl, rng, TINT.floor, false, 0.08, 0.04);
    else drawClumps(bmp, bk.floor, hl, rng, TINT.floor, false, 0);
    // the board's shadow: the slab stands over rows behindPx..behindPx+16
    const k = room.floor.k;
    const u0 = room.sidePx / k, u1 = (room.sidePx + room.W) / k;
    const v0 = room.behindPx / k, v1 = (room.behindPx + 16) / k, soft = 12;
    darken(bmp, 0.72, u0 - soft, v0 - soft, u1 + soft, v1 + soft, (x, y) => {
      const dx = x < u0 ? u0 - x : x > u1 ? x - u1 : 0;
      const dy = y < v0 ? v0 - y : y > v1 ? y - v1 : 0;
      return 1 - smoothstep(0, soft, Math.sqrt(dx * dx + dy * dy));
    });
    // decorations on the bare ground beyond the strip
    const n = Math.round((W * H) / 12000);
    scatter(bmp, bk.decor, n, rng, TINT.floor, (x, y) => y > hl(x / W) + 4 && !(x > u0 - soft && x < u1 + soft && y < v1 + soft));
    // the far end, behind the player, sinks into the dark
    darken(bmp, 0.1, 0, H * 0.85, W, H, (x, y) => smoothstep(0.85, 1, y / H));
  }

  /** The overhangs: the same pieces hanging from the wall's edge, thick at
   *  the sides and thin over the board, dimmer. Row 0 is the wall's edge. */
  function drawCeiling(bmp, room, bk, mode, rng) {
    const W = bmp.width, H = bmp.height, noise = noiseFn(rng);
    const uc = (room.sidePx + room.W / 2) / room.ceiling.k / W;
    const bump = (u) => Math.exp(-Math.pow((u - uc) / 0.35, 2));
    const hl = (u) => H * (0.5 - 0.3 * bump(u) + 0.1 * noise(u));
    if (mode === "tile") drawTiles(bmp, bk, hl, rng, TINT.ceiling, true, 0.08, 0.04);
    else drawClumps(bmp, bk.ceiling, hl, rng, TINT.ceiling, true, 24);
    darken(bmp, 0.1, 0, H * 0.8, W, H, (x, y) => smoothstep(0.8, 1, y / H));
  }

  /** The far wall: a band of the level's pieces standing along the floor
   *  line under a wavy skyline, dimmed - distant ground, seen from the front. */
  function drawWall(bmp, room, bk, mode, rng) {
    const W = bmp.width, H = bmp.height, noise = noiseFn(rng);
    // drawn hanging from row 0 on a sheet that is then turned over, so the
    // pieces stand on the wall's bottom edge the right way up
    const sheet = new Bitmap(W, H);
    const hl = (u) => H * (0.3 + 0.08 * noise(u));
    if (mode === "tile") drawTiles(sheet, bk, hl, rng, TINT.wall, true, 0.06, 0.04);
    else drawClumps(sheet, bk.wall.length ? bk.wall : bk.ground, hl, rng, TINT.wall, true, 0);
    const up = sheet.flipVertical();
    Pixels.blit(bmp, 0, 0, up, 0, 0, W, H, Pixels.combineTerrainDefault);
    scatter(bmp, bk.decor, Math.round(W / 300), rng, TINT.wall, (x, y) => y > H - hl(x / W) - 8);
  }

  /** Pieces packed in rows from row 0 up to the wavy limit `hl(u)`. */
  function drawClumps(bmp, list, hl, rng, tint, flipV, narrowing) {
    if (!list.length) return;
    const W = bmp.width, H = bmp.height;
    const heights = list.map((p) => p.bbox.h).sort((a, b) => a - b);
    const mh = heights[heights.length >> 1] || 8;
    const step = Math.max(2, mh * 0.6);
    let rowY = 0, row = 0;
    while (rowY < H) {
      let x = -rng() * 32 + row * narrowing * rng();
      while (x < W) {
        const p = pickWeighted(list, rng, (q) => q.area * (1 + q.count));
        const top = rowY - rng() * 8;
        const limit = hl(Math.min(1, Math.max(0, (x + p.bbox.w / 2) / W)));
        if (top + p.bbox.h * 0.5 <= limit) {
          const img = dressed(p, rng() < 0.5, flipV, tint);
          const bx = flipV ? p.w - p.bbox.x - p.bbox.w : p.bbox.x;
          const by = flipV ? p.h - p.bbox.y - p.bbox.h : p.bbox.y;
          stamp(bmp, img, x - bx, top - by);
        }
        x += p.bbox.w * (0.55 + 0.15 * rng());
      }
      rowY += step;
      row++;
    }
  }

  /** The tiles a block style lays: the most-placed pieces of its dominant size. */
  function tileSet(bk) {
    const sizes = new Map();
    for (const p of bk.usable) {
      const s = p.w + "x" + p.h;
      sizes.set(s, (sizes.get(s) || 0) + p.count);
    }
    let bestSize = null, best = -1;
    for (const [s, n] of sizes) if (n > best) { best = n; bestSize = s; }
    return bk.usable.filter((p) => p.w + "x" + p.h === bestSize).sort((a, b) => b.count - a.count).slice(0, 5);
  }

  /** Blocks on a grid under `hl(u)`, a few cells left empty, a few turned. */
  function drawTiles(bmp, bk, hl, rng, tint, flipV, emptyP, turnP) {
    const tiles = tileSet(bk);
    if (!tiles.length) return;
    const cw = tiles[0].w, ch = tiles[0].h, W = bmp.width;
    for (let y = 0; y < bmp.height; y += ch) {
      for (let x = 0; x < W; x += cw) {
        if (y + ch > hl((x + cw / 2) / W)) continue;
        if (rng() < emptyP) continue;
        const t = pickWeighted(tiles, rng, (p) => p.count);
        let img = dressed(t, rng() < 0.5, flipV, tint);
        if (cw === ch && rng() < turnP) img = img.rotate90();
        stamp(bmp, img, x, y);
      }
    }
  }

  /** `n` decorations dropped where `ok(x, y)` allows. */
  function scatter(bmp, decor, n, rng, tint, ok) {
    if (!decor.length || n <= 0) return;
    for (let i = 0, tries = 0; i < n && tries < n * 6; tries++) {
      const p = decor[(rng() * decor.length) | 0];
      const x = rng() * bmp.width, y = rng() * bmp.height;
      if (!ok(x, y)) continue;
      const img = dressed(p, rng() < 0.5, false, tint);
      stamp(bmp, img, x - p.bbox.x - p.bbox.w / 2, y - p.bbox.y - p.bbox.h);
      i++;
    }
  }

  // ------------------------------------------------------------- the build
  /**
   * Every picture of the environment for a level: `ctx` is the level's
   * data (see environment.js for the shape), `opts.room` the sizes from
   * roomFor, `opts.full` whether the collage is drawn over the ambient
   * gradients, `opts.wallpaper` `{image, key, kind}` or null. Returns
   * `{ palette, mode, planes: {floor, ceiling, wall, side}, backdrop, pieces }`
   * with each plane a Bitmap. `only` limits the planes drawn (a list), so
   * the caller can spread the work over frames.
   */
  function build(ctx, opts, only) {
    const room = opts.room;
    const palette = opts.palette || derivePalette(ctx);
    const env = (ctx.profile && ctx.profile.environment) || {};
    const dark = palette.dark, bg = palette.bg;
    const want = (name) => !only || only.includes(name);
    const gradientOpts = (cell) => ({ palette: palette.material, dark, cell });
    const planes = {};
    let collected = null, bk = null, mode = null;
    const rng = seededRandom("env:" + (ctx.levelId || "level"));
    if (opts.full) {
      collected = opts.pieces || collectPieces(ctx);
      bk = buckets(collected, env);
      mode = chooseMode(collected.pieces, ctx.profile);
    }

    if (want("floor")) {
      const bmp = new Bitmap(room.floor.w, room.floor.h);
      paintGradient(bmp, [{ t: 0, rgb: scale(dark, 0.55) }, { t: 0.45, rgb: scale(dark, 0.75) }, { t: 1, rgb: scale(dark, 0.3) }],
        "v", Object.assign(gradientOpts(1), { vignette: 0.35 }));
      if (opts.full) drawFloor(bmp, room, bk, mode, seededRandom("floor:" + ctx.levelId), palette);
      planes.floor = bmp;
    }
    if (want("ceiling")) {
      const bmp = new Bitmap(room.ceiling.w, room.ceiling.h);
      paintGradient(bmp, [{ t: 0, rgb: scale(dark, 0.3) }, { t: 1, rgb: scale(dark, 0.08) }],
        "v", Object.assign(gradientOpts(1), { vignette: 0.5 }));
      if (opts.full) drawCeiling(bmp, room, bk, mode, seededRandom("ceiling:" + ctx.levelId));
      planes.ceiling = bmp;
    }
    if (want("wall")) {
      const bmp = new Bitmap(room.wall.w, room.wall.h);
      // v runs top (row 0) to bottom: the wall is lightest where it meets the floor
      paintGradient(bmp, [{ t: 0, rgb: scale(dark, 0.15) }, { t: 0.4, rgb: scale(dark, 0.5) }, { t: 1, rgb: bg }],
        "v", Object.assign(gradientOpts(1), { vignette: 0.3 }));
      if (opts.wallpaper && opts.wallpaper.image) drawWallpaper(bmp, room, opts.wallpaper);
      if (opts.full) drawWall(bmp, room, bk, mode, seededRandom("wall:" + ctx.levelId));
      planes.wall = bmp;
    }
    if (want("side")) {
      const bmp = new Bitmap(room.side.w, room.side.h);
      paintGradient(bmp, [{ t: 0, rgb: scale(dark, 0.1) }, { t: 0.4, rgb: scale(dark, 0.3) }, { t: 1, rgb: scale(bg, 0.6) }],
        "v", Object.assign(gradientOpts(1), { vignette: 0.3 }));
      planes.side = bmp;
    }
    let backdrop = null;
    if (want("backdrop") && opts.wallpaper && opts.wallpaper.image && opts.wallpaper.kind === "prop") {
      backdrop = propBackdrop(ctx, opts.wallpaper.image, bg);
    }
    return { palette, mode, planes, backdrop, pieces: collected, rng };
  }

  /** The style's background on the wall: tiled at the wall's own pixel
   *  size, or a prop placed once behind the board's place. */
  function drawWallpaper(bmp, room, wp) {
    const k = room.wall.k;
    // at half the wall's coarseness: twice the board's pixels, so a picture
    // made for the level does not loom the size of the room
    const f = Math.max(1, Math.round(k / 2));
    const img = f > 1 ? shrink(wp.image, f) : wp.image;
    if (wp.kind === "prop") {
      const x = ((room.sidePx + room.W / 2) / k - img.width / 2) | 0;
      const y = (room.wallPx - room.floorDrop) / k - img.height; // its feet at the board's bottom edge
      Pixels.blit(bmp, x, y | 0, img.tinted(TINT.prop), 0, 0, img.width, img.height, Pixels.combineGadget);
      return;
    }
    const tinted = img.tinted(TINT.wallpaper);
    Pixels.drawNineSlice(bmp, 0, 0, bmp.width, bmp.height, tinted, { left: 0, top: 0, right: 0, bottom: 0 }, Pixels.combineGadget);
  }

  /** A prop background as the slab's own backdrop: the picture once, on the
   *  background colour, centred and standing on the level's bottom edge. */
  function propBackdrop(ctx, img, bg) {
    const W = ctx.width, H = ctx.height;
    const k = W > 2048 || H > 2048 ? 2 : 1;
    const out = new Bitmap(Math.ceil(W / k), Math.ceil(H / k));
    const d = out.data;
    for (let p = 0; p < d.length; p += 4) { d[p] = R(bg); d[p + 1] = G(bg); d[p + 2] = B(bg); d[p + 3] = 255; }
    const src = k === 1 ? img : shrink(img, k);
    Pixels.blit(out, ((out.width - src.width) / 2) | 0, out.height - src.height, src, 0, 0, src.width, src.height, Pixels.combineGadget);
    return { bitmap: out, k };
  }

  /** A bitmap at 1/k, nearest pixel. */
  function shrink(img, k) {
    const w = Math.ceil(img.width / k), h = Math.ceil(img.height / k);
    const out = new Bitmap(w, h), s = img.words(), d = out.words();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = s[Math.min(img.height - 1, y * k) * img.width + Math.min(img.width - 1, x * k)];
    return out;
  }

  const EnvGen = {
    ROOM, roomFor, TINT, PROPS,
    derivePalette, paintGradient, quantPalette, darken, scale, luma,
    classifyBackground, opaqueFraction,
    collectPieces, buckets, chooseMode, measure, dosBitmap,
    seededRandom, noiseFn,
    build, drawWallpaper, propBackdrop, shrink,
  };
  root.EnvGen = EnvGen;
  if (isNode) module.exports = EnvGen;
})(typeof window !== "undefined" ? window : globalThis);
