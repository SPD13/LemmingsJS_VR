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
 * The room is rings around the player (ROOM.RINGS): each a band of floor
 * and of ceiling and, at its outer edge, a wall all the way round that is a
 * cut-out skyline the next ring shows through, the last one solid - the
 * sky. The pictures wrap: a band's runs round its rim, a wall's round. Every picture is a
 * Lemmix.Bitmap at its plane's own pixel size, coarser than the board's and
 * coarser with distance, so the environment reads as further away and never
 * competes with the play area; each layer is blended toward the fog by its
 * distance, and all shading is baked in, the scene being unlit. Pure pixels, no three.js: runs under node too
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
  // proportions in both views. The room is a set of rings around the
  // player: each ring a band of floor and of ceiling and, at its outer edge,
  // a wall all the way round - a cut-out skyline of the level's pieces the
  // next ring shows through, the last one solid, the sky - every ring
  // coarser and blended further toward the fog. Looking any way, the world
  // goes on; the stereo between the rings is the depth. The board stands
  // inside the first ring, in front of the player.
  const ROOM = {
    EYE_M: 0.9,       // the player's distance from the board's face (placeDioramaForXR), the desktop's centre
    CEIL_M: 2.6,      // the ceiling's height above the physical floor
    FLOOR_DROP_M: 0.5, // the desktop's floor, this far below the board's bottom edge
    RINGS: [2.0, 4.0, 8.0, 17.0], // each ring's radius from the player
    CLEAR_M: 0.5,     // the first ring stands at least this far past the board's corners
    FOG_M: 7.0,       // the distance by which the fog has taken two thirds of a colour
    SKYLINE: [0.32, 0.42, 0.52, 0.6], // how high each ring's wall band rises, of the wall's height
    TEX: { near: 1024, far: 2048, wallRows: 256, bandRows: 512 },
    WALL_K: 1.5,      // a wall's pixels, coarser again than the floor's: it is further away
  };

  /**
   * The room's sizes in board pixels for a level `W` wide and `H` high:
   * its rings, each with its pictures' sizes and pixel scales (`k` board
   * pixels per picture pixel), around a centre `opts.center` ({x, z} in
   * board pixels; the player's place, by default EYE_M in front of the
   * board's middle).
   */
  function roomFor(W, H, pxPerMetre, opts) {
    const P = pxPerMetre;
    const floorDrop = Math.round(ROOM.FLOOR_DROP_M * P);
    const wallPx = Math.round(ROOM.CEIL_M * P) + floorDrop; // the nominal wall height
    const center = (opts && opts.center) || { x: W / 2, z: 16 + ROOM.EYE_M * P };
    // the first ring clears the board's corners, wherever the player stands
    const reach = Math.max(
      Math.hypot(center.x, center.z), Math.hypot(W - center.x, center.z),
      Math.hypot(center.x, center.z - 16), Math.hypot(W - center.x, center.z - 16));
    const fogAt = (d) => 1 - Math.exp(-d / ROOM.FOG_M);
    const radii = [];
    ROOM.RINGS.forEach((rm, i) => {
      let r = rm * P;
      if (i === 0) r = Math.max(r, reach + ROOM.CLEAR_M * P);
      else r = Math.max(r, radii[i - 1] * 1.6);
      radii.push(Math.round(r));
    });
    const layers = radii.map((rOut, i) => {
      const rIn = i === 0 ? 0 : radii[i - 1];
      const circ = Math.round(2 * Math.PI * rOut);
      const texW = i >= 2 ? ROOM.TEX.far : ROOM.TEX.near;
      const d = rOut / P; // the wall's distance
      const kBand = Math.max(1, Math.ceil(circ / texW));
      const kWall = Math.max(1, Math.ceil(circ / texW * ROOM.WALL_K));
      return {
        i, rIn, rOut, circ, d,
        fog: fogAt(d), fogNear: i === 0 ? 0 : fogAt(rIn / P),
        skyline: ROOM.SKYLINE[Math.min(i, ROOM.SKYLINE.length - 1)],
        last: i === radii.length - 1,
        // a band's picture wraps round the outer rim (row 0) and runs in to the inner one
        floor: { k: kBand, w: Math.ceil(circ / kBand), h: Math.min(ROOM.TEX.bandRows, Math.ceil((rOut - rIn) / kBand)) },
        ceiling: { k: kBand, w: Math.ceil(circ / kBand), h: Math.min(ROOM.TEX.bandRows, Math.ceil((rOut - rIn) / kBand)) },
        wall: { k: kWall, w: Math.ceil(circ / kWall), h: Math.min(ROOM.TEX.wallRows, Math.ceil(wallPx / kWall)) },
      };
    });
    return { W, H, P, floorDrop, wallPx, center, reach, layers };
  }

  /** The plane names a room has: floor0, wall0, ceiling0, floor1, ..., backdrop. */
  function planeNames(room) {
    const out = [];
    for (const l of room.layers) out.push("floor" + l.i, "wall" + l.i, "ceiling" + l.i);
    out.push("backdrop");
    return out;
  }

  /** A band picture's pixel (u across, v down: rim to inner edge) in board pixels around the centre. */
  function bandToWorld(room, layer, u, v, w, h) {
    const r = layer.rOut - (layer.rOut - layer.rIn) * (v / Math.max(1, h));
    const th = (u / w) * Math.PI * 2; // u = 0 straight behind the player, u = 0.5 toward the board
    return { x: room.center.x + r * Math.sin(th), z: room.center.z + r * Math.cos(th), r, th };
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
    // the haze the far layers sink into: the material's own hue, muted and dim
    const fog = (env.palette && parseHex(env.palette.fog)) ?? mix(scale(bg, 0.8), mix(dark, light, 0.5), 0.55);
    return { material, bg, dark, light, accent, fog, source };
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

  /** A smooth wobble in -1..1 along u, three sines with seeded phases -
   *  whole numbers of waves, so it meets itself where the picture wraps. */
  function noiseFn(rng) {
    const f = [2, 5, 9], a = [0.5, 0.3, 0.2], ph = f.map(() => rng() * Math.PI * 2);
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

  /** A piece onto a picture that wraps round: what goes off one side comes in the other. */
  function stamp(dst, img, x, y) {
    x = Math.round(x); y = Math.round(y);
    const W = dst.width;
    x = ((x % W) + W) % W;
    Pixels.blit(dst, x, y, img, 0, 0, img.width, img.height, Pixels.combineTerrainDefault);
    if (x + img.width > W) Pixels.blit(dst, x - W, y, img, 0, 0, img.width, img.height, Pixels.combineTerrainDefault);
  }

  /** A piece stretched sideways by `fx` (a band's picture is narrower toward its inner edge). */
  function stretched(img, fx) {
    if (Math.abs(fx - 1) < 0.05) return img;
    const w = Math.max(1, Math.round(img.width * fx)), h = img.height;
    const out = new Bitmap(w, h), s = img.words(), d = out.words();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = s[y * img.width + Math.min(img.width - 1, (x / fx) | 0)];
    return out;
  }

  // -------------------------------------------------------------- collage
  const TINT = { floor: 0xb4b4b4, ceiling: 0x8c8c8c, wall: 0x7a7a7a, prop: 0x666666, wallpaper: 0x909090 };

  /** The mean colour of a picture's opaque pixels. */
  function meanColor(bmp) {
    const d = bmp.data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3] < Pixels.ALPHA_CUTOFF) continue;
      r += d[p]; g += d[p + 1]; b += d[p + 2]; n++;
    }
    return n ? rgbOf(r / n, g / n, b / n) : 0;
  }

  /**
   * The fog over a picture: every opaque pixel blended toward `fog` by a
   * factor running from `fFar` at row 0 to `fNear` at the last row (the
   * same at both ends for a wall).
   */
  function fogBlend(bmp, fog, fFar, fNear) {
    const w = bmp.width, h = bmp.height, d = bmp.data;
    const fr = R(fog), fg = G(fog), fb = B(fog);
    for (let y = 0; y < h; y++) {
      const f = h > 1 ? fFar + (fNear - fFar) * (y / (h - 1)) : fFar;
      if (f <= 0) continue;
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        if (d[p + 3] === 0) continue;
        d[p] += (fr - d[p]) * f; d[p + 1] += (fg - d[p + 1]) * f; d[p + 2] += (fb - d[p + 2]) * f;
      }
    }
  }

  /** The board's footprint on the first band: is this pixel of the picture under (or `margin` px from) the slab? */
  function boardDistance(room, layer, x, y, w, h) {
    const p = bandToWorld(room, layer, x, y, w, h);
    const dx = p.x < 0 ? -p.x : p.x > room.W ? p.x - room.W : 0;
    const dz = p.z < 0 ? -p.z : p.z > 16 ? p.z - 16 : 0;
    return Math.hypot(dx, dz);
  }

  /** How much wider a piece is drawn on row `y` of a band, so it keeps its size on the ground. */
  const bandStretch = (layer, h) => (y) => layer.rOut / Math.max(1, layer.rOut - (layer.rOut - layer.rIn) * (y / Math.max(1, h)));

  /**
   * A floor band: the first one - the disc the player and the board stand
   * on - a ground strip packed round its rim (row 0, where the first wall
   * stands) inward under a wavy edge, the board's shadow across it and
   * decorations beyond; the further rings ground all over, coarser and
   * deeper in the fog.
   */
  function drawFloor(bmp, room, layer, bk, mode, rng) {
    const W = bmp.width, H = bmp.height, noise = noiseFn(rng);
    const stretch = bandStretch(layer, H);
    if (layer.i === 0) {
      const hl = (u) => H * (0.5 + 0.12 * noise(u));
      if (mode === "tile") drawTiles(bmp, bk, hl, rng, TINT.floor, false, 0.08, 0.04, stretch);
      else drawClumps(bmp, bk.floor, hl, rng, TINT.floor, false, 0, stretch);
      // the board's shadow, soft-edged, on the ground under and about it
      const soft = 12 * layer.floor.k;
      darken(bmp, 0.72, 0, 0, W, H, (x, y) => 1 - smoothstep(0, soft, boardDistance(room, layer, x, y, W, H)));
      const n = Math.round((W * H) / 14000);
      scatter(bmp, bk.decor, n, rng, TINT.floor, (x, y) => y > hl(x / W) + 4 && boardDistance(room, layer, x, y, W, H) > soft);
      // under the player, the ground sinks into the dark
      darken(bmp, 0.15, 0, H * 0.8, W, H, (x, y) => smoothstep(0.8, 1, y / H));
    } else {
      const hl = () => H + 64; // everything
      if (mode === "tile") drawTiles(bmp, bk, hl, rng, TINT.floor, false, 0.05, 0.04, stretch);
      else drawClumps(bmp, bk.floor, hl, rng, TINT.floor, false, 0, stretch);
    }
  }

  /**
   * A wall, all the way round: a band of the level's pieces standing along
   * the floor line under a wavy skyline - distant ground, seen from the
   * front - the next ring showing through above it. Higher on each ring
   * out, so the far ones read as hills behind hills. The last is solid: the sky.
   */
  function drawWall(bmp, room, layer, bk, mode, rng) {
    const W = bmp.width, H = bmp.height, noise = noiseFn(rng);
    // drawn hanging from row 0 on a sheet that is then turned over, so the
    // pieces stand on the wall's bottom edge the right way up
    const sheet = new Bitmap(W, H);
    const top = layer.skyline;
    const hl = (u) => H * (top + 0.08 * noise(u) + (layer.i ? 0.06 * noise(u * 0.5 + 0.3) : 0));
    if (mode === "tile") drawTiles(sheet, bk, hl, rng, TINT.wall, true, 0.06, 0.04, null);
    else drawClumps(sheet, bk.wall.length ? bk.wall : bk.ground, hl, rng, TINT.wall, true, 0, null);
    const up = sheet.flipVertical();
    Pixels.blit(bmp, 0, 0, up, 0, 0, W, H, Pixels.combineTerrainDefault);
    if (layer.i === 0) scatter(bmp, bk.decor, Math.round(W / 300), rng, TINT.wall, (x, y) => y > H - hl(x / W) - 8);
  }

  /** Pieces packed in rows from row 0 up to the wavy limit `hl(u)`. */
  function drawClumps(bmp, list, hl, rng, tint, flipV, narrowing, stretch) {
    if (!list.length) return;
    const W = bmp.width, H = bmp.height;
    const fxAt = stretch || (() => 1);
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
        const fx = fxAt(Math.max(0, Math.min(H - 1, top + p.bbox.h / 2)));
        if (top + p.bbox.h * 0.5 <= limit) {
          const img = stretched(dressed(p, rng() < 0.5, flipV, tint), fx);
          const bx = (flipV ? p.w - p.bbox.x - p.bbox.w : p.bbox.x) * fx;
          const by = flipV ? p.h - p.bbox.y - p.bbox.h : p.bbox.y;
          stamp(bmp, img, x - bx, top - by);
        }
        x += p.bbox.w * fx * (0.55 + 0.15 * rng());
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
  function drawTiles(bmp, bk, hl, rng, tint, flipV, emptyP, turnP, stretch) {
    const tiles = tileSet(bk);
    if (!tiles.length) return;
    const cw = tiles[0].w, ch = tiles[0].h, W = bmp.width;
    const fxAt = stretch || (() => 1);
    for (let y = 0; y < bmp.height; y += ch) {
      const fx = fxAt(y + ch / 2), step = Math.max(1, cw * fx);
      for (let x = 0; x < W; x += step) {
        if (y + ch > hl((x + step / 2) / W)) continue;
        if (rng() < emptyP) continue;
        const t = pickWeighted(tiles, rng, (p) => p.count);
        let img = dressed(t, rng() < 0.5, flipV, tint);
        if (cw === ch && rng() < turnP) img = img.rotate90();
        stamp(bmp, stretched(img, fx), x, y);
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
  /** The plane name's parts: { kind: "floor"|"wall"|"ceiling"|"side"|"backdrop", i }. */
  function parsePlane(name) {
    const m = /^(floor|wall|ceiling)(\d+)$/.exec(name);
    return m ? { kind: m[1], i: parseInt(m[2], 10) } : { kind: name, i: 0 };
  }

  /**
   * The pictures of the environment for a level: `ctx` is the level's data
   * (see environment.js for the shape), `opts.room` the sizes from roomFor,
   * `opts.full` whether the collage is drawn over the ambient gradients,
   * `opts.wallpaper` `{image, key, kind}` or null. Returns `{ palette, mode,
   * fog, planes, backdrop, pieces }` with each plane a Bitmap under its name
   * (floor0, wall0, ceiling0, floor1, ...); `only` limits the planes
   * drawn (a list of names), so the caller can spread the work over frames.
   */
  function build(ctx, opts, only) {
    const room = opts.room;
    const palette = opts.palette || derivePalette(ctx);
    const env = (ctx.profile && ctx.profile.environment) || {};
    const dark = palette.dark, bg = palette.bg;
    const wp = opts.wallpaper && opts.wallpaper.image ? opts.wallpaper : null;
    // a sky wallpaper is what the far layers dissolve into; else the palette's haze
    const fog = opts.fog !== undefined ? opts.fog : (wp && wp.kind === "wallpaper" ? scale(meanColor(wp.image), 0.85) : palette.fog);
    const want = (name) => !only || only.includes(name);
    const gradientOpts = (cell) => ({ palette: palette.material, dark, cell });
    const planes = {};
    let collected = null, bk = null, mode = null;
    if (opts.full) {
      collected = opts.pieces || collectPieces(ctx);
      bk = buckets(collected, env);
      mode = chooseMode(collected.pieces, ctx.profile);
    }
    const seed = (name) => seededRandom(name + ":" + (ctx.levelId || "level"));

    for (const layer of room.layers) {
      const i = layer.i;
      if (want("floor" + i)) {
        const bmp = new Bitmap(layer.floor.w, layer.floor.h);
        const stops = i === 0
          ? [{ t: 0, rgb: scale(dark, 0.55) }, { t: 0.45, rgb: scale(dark, 0.75) }, { t: 1, rgb: scale(dark, 0.3) }]
          : [{ t: 0, rgb: scale(dark, 0.5) }, { t: 1, rgb: scale(dark, 0.6) }];
        paintGradient(bmp, stops, "v", Object.assign(gradientOpts(1), { vignette: 0 }));
        if (opts.full) drawFloor(bmp, room, layer, bk, mode, seed("floor" + i));
        fogBlend(bmp, fog, layer.fog, layer.fogNear);
        planes["floor" + i] = bmp;
      }
      if (want("ceiling" + i)) {
        // the ceiling is fog alone: a little darker overhead, the haze at the rim
        const bmp = new Bitmap(layer.ceiling.w, layer.ceiling.h);
        const overhead = scale(fog, i === 0 ? 0.55 : 0.8);
        paintGradient(bmp, [{ t: 0, rgb: fog }, { t: 1, rgb: overhead }],
          "v", { palette: [fog, scale(fog, 0.9), scale(fog, 0.8), scale(fog, 0.7), scale(fog, 0.6), scale(fog, 0.5)], dark: fog, cell: 2, vignette: 0 });
        fogBlend(bmp, fog, layer.fog, layer.fogNear);
        planes["ceiling" + i] = bmp;
      }
      if (want("wall" + i)) {
        const bmp = new Bitmap(layer.wall.w, layer.wall.h);
        if (layer.last) {
          // the sky: the wallpaper when the style has one, else the haze,
          // lighter toward the horizon where the fog is thickest
          paintGradient(bmp, [{ t: 0, rgb: scale(fog, 0.55) }, { t: 0.55, rgb: scale(fog, 0.85) }, { t: 1, rgb: fog }],
            "v", Object.assign(gradientOpts(2), { palette: [fog, scale(fog, 0.85), scale(fog, 0.7), scale(fog, 0.55), scale(fog, 0.4)], vignette: 0 }));
          if (wp) drawWallpaper(bmp, room, layer, wp, fog);
        }
        if (opts.full) drawWall(bmp, room, layer, bk, mode, seed("wall" + i));
        fogBlend(bmp, fog, layer.fog, layer.fog);
        planes["wall" + i] = bmp;
      }
    }
    let backdrop = null;
    if (want("backdrop") && wp && wp.kind === "prop") backdrop = propBackdrop(ctx, wp.image, bg);
    return { palette, mode, fog, planes, backdrop, pieces: collected };
  }

  /** The style's background on the far wall: a sky tiled at the wall's own
   *  pixel size (it is the horizon), or a prop placed once behind the board's
   *  place, dimmed into the haze. */
  function drawWallpaper(bmp, room, layer, wp, fog) {
    const k = layer.wall.k;
    // twice the board's pixels at most: a picture made for the level should
    // not loom the size of the room
    const f = Math.max(1, Math.round(k / 2));
    const img = f > 1 ? shrink(wp.image, f) : wp.image;
    if (wp.kind === "prop") {
      const x = (bmp.width / 2 - img.width / 2) | 0; // toward the board
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
    ROOM, roomFor, planeNames, parsePlane, bandToWorld, TINT, PROPS, meanColor, fogBlend, mix,
    derivePalette, paintGradient, quantPalette, darken, scale, luma,
    classifyBackground, opaqueFraction,
    collectPieces, buckets, chooseMode, measure, dosBitmap,
    seededRandom, noiseFn,
    build, drawWallpaper, propBackdrop, shrink,
  };
  root.EnvGen = EnvGen;
  if (isNode) module.exports = EnvGen;
})(typeof window !== "undefined" ? window : globalThis);
