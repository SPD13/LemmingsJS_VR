#!/usr/bin/env node
"use strict";
/**
 * The environment's pictures offline: the collage the page would draw for a
 * style (or a level) written as PNGs to look at - and, with a Stable
 * Diffusion server answering the Automatic1111 API (Draw Things with its API
 * server on, ComfyUI behind a bridge, A1111 itself), each collage polished
 * through img2img at a low denoise, so the tileset's own pieces and layout
 * stay and the model only adds atmosphere; the result is brought back to
 * the plane's pixel size and quantised to the style's palette, so it is
 * pixel art in the level's colours again. The page prefers those files
 * (3d/env/<style>/) over its live collage.
 *
 * Usage:
 *   node tools/env-gen.js <style|level-id> [<style|level-id> ...] [options]
 *     --dry              the collages only, no model (default out: tmp/env-dry/)
 *     --out <dir>        where to write (default 3d/env/ unless --dry)
 *     --planes a,b       floor, wall (default both; the ceiling is fog alone)
 *     --layers 0,1       which depth layers (default: every one the model can
 *                        work on; a far layer's picture too flat to send is
 *                        kept as its collage)
 *     --api <url>        the server (default http://127.0.0.1:7860; https with a
 *                        self-signed certificate is accepted)
 *     --probe            ask the server what model and LoRAs it has, and stop
 *     --as <style>       write a level's pictures under this style's folder
 *                        (a level is otherwise written under its own name)
 *     --denoise <0..1>   img2img strength (default 0.45)
 *     --steps <n>        sampling steps (default 24)
 *     --cfg <n>          guidance (default 7)
 *     --seed <n>         the model's seed (default from the name)
 *     --lora <file[:w]>  a LoRA file the server has (Draw Things: its .ckpt
 *                        name from /sdapi/v1/options), with a weight; a bare
 *                        name goes into the prompt as <lora:name:w>; "none"
 *                        switches the app's own LoRA off for the run
 *     --model <file>     the model file (Draw Things: its .ckpt name)
 *     --sampler <name>   the sampler
 *     --prompt "<text>"  extra words for every plane
 *     --trigger "<w>"    the LoRA's trigger words, first in the prompt
 *     --no-quantise      keep the model's colours (still pixel-sized)
 *     --colors <n>       how many colours to snap to (default 32)
 *     --palette raw|collage  whose colours: the model's own picture, reduced
 *                        (default: clean, the hues the model kept), or the
 *                        collage's (the tileset's exactly, but speckled)
 *     --dither           dither between neighbouring palette colours (off: nearest only)
 *     --requantise       redo the finish from the saved <plane>-raw.png, no model call
 *   A picture wider than about four times its height goes through the model
 *   in overlapping strips (the last running round into the first, since the
 *   pictures wrap) that are blended back together.
 *     --keep-raw         also write the model's output as-is (<plane>-raw.png)
 *   Every run also writes contact.html next to the pictures: the collage,
 *   the model's answer and the finished picture side by side, with scores.
 */
const fs = require("fs");
const path = require("path");
const { Lemmix, nodeIO, writePng, findRepoRoot, listLevels } = require("./lemmix-node");
const EnvGen = require("../3d/js/envgen.js");
const { ProfileStore } = require("../3d/js/profile-store.js");

const PX_PER_METRE = 400; // 1 / VR_PIXEL_SCALE (vr.js)
const KINDS = ["floor", "wall", "ceiling"];

function parseArgs(argv) {
  const o = { names: [], planes: ["floor", "wall"], api: "http://127.0.0.1:7860", denoise: 0.45, steps: 24, cfg: 7, quantise: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === "--dry") o.dry = true;
    else if (a === "--out") o.out = next();
    else if (a === "--planes") o.planes = next().split(",").map((s) => s.trim()).filter((p) => KINDS.includes(p));
    else if (a === "--layers") o.layers = next().split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    else if (a === "--api") o.api = next();
    else if (a === "--probe") o.probe = true;
    else if (a === "--as") o.as = next();
    else if (a === "--denoise") o.denoise = parseFloat(next());
    else if (a === "--steps") o.steps = parseInt(next(), 10);
    else if (a === "--cfg") o.cfg = parseFloat(next());
    else if (a === "--seed") o.seed = parseInt(next(), 10);
    else if (a === "--lora") o.lora = next();
    else if (a === "--model") o.model = next();
    else if (a === "--sampler") o.sampler = next();
    else if (a === "--prompt") o.prompt = next();
    else if (a === "--trigger") o.trigger = next();
    else if (a === "--no-quantise") o.quantise = false;
    else if (a === "--colors") o.colors = parseInt(next(), 10);
    else if (a === "--palette") o.paletteFrom = next();
    else if (a === "--dither") o.dither = true;
    else if (a === "--requantise") o.requantise = true;
    else if (a === "--keep-raw") o.keepRaw = true;
    else if (a === "--keep-raw") o.keepRaw = true; // twice is fine
    else if (a.startsWith("--")) throw new Error("unknown option " + a);
    else o.names.push(a);
  }
  return o;
}

/** The profile file of a style, empty when there is none. */
function loadProfile(repoRoot, style) {
  const file = path.join(repoRoot, "3d", "profiles", "nx-" + style + ".json");
  try { return ProfileStore.normalize(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (e) { return ProfileStore.emptyProfile(); }
}

/** A style's environment context: every terrain piece it has, its theme and a background. */
async function styleContext(repoRoot, styles, name) {
  const index = await styles.index();
  const entry = index && index.get(name);
  if (!entry) throw new Error("no such style: " + name);
  const style = await styles.style(name);
  const profile = loadProfile(repoRoot, name);
  const steel = new Set(entry.steel || []);
  const pieces = [];
  for (const piece of entry.pieces) {
    const meta = await styles.terrain(name, piece);
    if (!meta || !meta.base || !meta.base.image) continue;
    const image = meta.base.image;
    pieces.push({ x: 0, y: 0, drawn: { key: name + ":" + piece, variantKey: "", image, width: image.width, height: image.height, steel: meta.steel || steel.has(piece) } });
  }
  // a contact sheet of the pieces stands in for the level's picture (the palette is read from it)
  const sheet = contactSheet(pieces.map((p) => p.drawn.image));
  const wallpaper = await findWallpaper(repoRoot, styles, name, profile);
  return {
    ctx: {
      engine: "lemmix", levelId: "style:" + name, width: sheet.width, height: sheet.height,
      theme: style.theme, background: null, backgroundName: null,
      groundImage: sheet.data, groundMask: null, donors: null, groundData: null, profile,
      lemmixPieces: pieces, lemmixObjects: null, dosPalette: null,
    },
    wallpaper, title: entry.title || name, name, sheet,
  };
}

/** A level's environment context, from the level as the game builds it. */
async function levelContext(repoRoot, styles, id) {
  const entry = listLevels(repoRoot).find((l) => l.id === id || l.id.startsWith(id));
  if (!entry) throw new Error("no such level: " + id);
  const text = fs.readFileSync(path.join(repoRoot, entry.url), "utf8");
  const data = Lemmix.LevelBuilder.parseLevel(text);
  const level = await Lemmix.LevelBuilder.build(data, styles, { seed: entry.id });
  const profile = loadProfile(repoRoot, level.themeName);
  let wallpaper = null;
  if (level.background && level.background.image) {
    const key = level.info.background || "";
    wallpaper = { image: level.background.image, key, kind: EnvGen.classifyBackground(level.background.image, key, profile) };
  } else wallpaper = await findWallpaper(repoRoot, styles, level.themeName, profile);
  return {
    ctx: {
      engine: "lemmix", levelId: entry.id, width: level.width, height: level.height,
      theme: level.theme, background: level.background, backgroundName: level.info.background,
      groundImage: level.groundImage, groundMask: level.groundMask.groundMask, donors: null, groundData: null, profile,
      lemmixPieces: level.pieces, lemmixObjects: level.objects, dosPalette: null,
    },
    wallpaper, title: level.name, name: entry.id.replace(/[^a-z0-9]+/gi, "_"), sheet: null,
  };
}

/** The profile's wallpaper, else the first background the style folder has. */
async function findWallpaper(repoRoot, styles, style, profile) {
  const env = profile.environment || {};
  let key = env.wallpaper || null;
  if (!key) {
    const dir = path.join(repoRoot, "neolemmix", "styles", style, "backgrounds");
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png")).sort(); } catch (e) {}
    if (files.length) key = style + ":" + files[0].replace(/\.png$/i, "");
  }
  if (!key) return null;
  const id = Lemmix.splitIdentifier(key, style);
  const image = await styles.background(id.gs, id.piece);
  if (!image) return null;
  return { image, key, kind: EnvGen.classifyBackground(image, key, profile) };
}

/** The pieces side by side on a transparent sheet. */
function contactSheet(images) {
  const cols = Math.ceil(Math.sqrt(images.length)) || 1;
  const cw = Math.max(1, ...images.map((i) => i.width)), ch = Math.max(1, ...images.map((i) => i.height));
  const rows = Math.ceil(images.length / cols) || 1;
  const sheet = new Lemmix.Bitmap(cols * cw, rows * ch);
  images.forEach((img, i) => {
    Lemmix.Pixels.blit(sheet, (i % cols) * cw, Math.floor(i / cols) * ch, img, 0, 0, img.width, img.height, Lemmix.Pixels.combineGadget);
  });
  return sheet;
}

// ------------------------------------------------------------ the model
/** A JSON call to the server; a self-signed certificate (Draw Things) is let through. */
async function api(base, ep, body) {
  if (/^https:/i.test(base)) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const url = base.replace(/\/$/, "") + ep;
  const res = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const text = await res.text();
  if (!res.ok) throw new Error(ep + ": HTTP " + res.status + " " + text.slice(0, 200));
  if (!text) throw new Error(ep + ": an empty answer - is this the HTTP API server (Draw Things: Settings > API Server), not its gRPC one?");
  try { return JSON.parse(text); } catch (e) { throw new Error(ep + ": not JSON: " + text.slice(0, 120)); }
}

/** What the server has: its model, the LoRAs it knows. */
async function probe(base) {
  const out = {};
  for (const ep of ["/sdapi/v1/options", "/sdapi/v1/sd-models", "/sdapi/v1/loras", "/sdapi/v1/samplers"]) {
    try { out[ep] = await api(base, ep); } catch (e) { out[ep] = "error: " + e.message; }
  }
  return out;
}

/** A bitmap as a PNG buffer / base64, and back. */
function pngBuffer(bmp) {
  const { PNG } = require("pngjs");
  const png = new PNG({ width: bmp.width, height: bmp.height });
  png.data = Buffer.from(bmp.data.buffer, bmp.data.byteOffset, bmp.data.length);
  return PNG.sync.write(png);
}
function fromPngBuffer(buf) {
  const { PNG } = require("pngjs");
  const png = PNG.sync.read(buf);
  return new Lemmix.Bitmap(png.width, png.height, new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length));
}

/** A bitmap scaled by an integer factor, nearest pixel. */
function enlarge(bmp, f) {
  const w = bmp.width * f, h = bmp.height * f, out = new Lemmix.Bitmap(w, h);
  const s = bmp.words(), d = out.words();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = s[((y / f) | 0) * bmp.width + ((x / f) | 0)];
  return out;
}

/** A bitmap at exactly `w` x `h`, nearest pixel (the server wants the init image at the size it is asked for). */
function resizeNearest(bmp, w, h) {
  const out = new Lemmix.Bitmap(w, h), s = bmp.words(), d = out.words();
  for (let y = 0; y < h; y++) {
    const sy = Math.min(bmp.height - 1, Math.floor(y * bmp.height / h));
    for (let x = 0; x < w; x++) d[y * w + x] = s[sy * bmp.width + Math.min(bmp.width - 1, Math.floor(x * bmp.width / w))];
  }
  return out;
}

/** A bitmap brought to `w` x `h` by box filtering (each pixel the mean of its box). */
function boxDown(bmp, w, h) {
  const out = new Lemmix.Bitmap(w, h), d = out.data, s = bmp.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * bmp.height / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * bmp.height / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * bmp.width / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * bmp.width / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const p = (yy * bmp.width + xx) * 4;
        r += s[p]; g += s[p + 1]; b += s[p + 2]; n++;
      }
      const o = (y * w + x) * 4;
      d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n; d[o + 3] = 255;
    }
  }
  return out;
}

/** The colours a picture is made of: the most common, 5 bits a channel, `n` at most. */
function topColors(bmp, n) {
  const bins = new Map(), d = bmp.data;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] < 0x80) continue;
    const key = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  return Array.from(bins.entries()).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k]) => ((((k >> 10) & 31) << 3) << 16) | ((((k >> 5) & 31) << 3) << 8) | ((k & 31) << 3));
}

/**
 * Every pixel of the model's answer snapped to the collage's own colours -
 * the tileset's, as many as it uses - with the ordered dither of the
 * gradients, so the result is pixel art in the level's palette again
 * without losing the shading the model added.
 */
function quantise(bmp, collage, palette, opts) {
  const from = opts.paletteFrom === "collage" ? collage : bmp;
  const pal = EnvGen.quantPalette(topColors(from, opts.colors || 32).concat(palette.material), palette.dark);
  const dither = !!opts.dither;
  const out = bmp.clone(), d = out.data;
  const BAYER = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25], [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
  const dist = (a, r, g, b) => {
    const dr = ((a >> 16) & 255) - r, dg = ((a >> 8) & 255) - g, db = (a & 255) - b;
    return dr * dr * 2 + dg * dg * 4 + db * db * 3;
  };
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const p = (y * out.width + x) * 4, r = d[p], g = d[p + 1], b = d[p + 2];
      let a = pal[0], da = Infinity, s = pal[0], ds = Infinity;
      for (const c of pal) { const dd = dist(c, r, g, b); if (dd < da) { s = a; ds = da; a = c; da = dd; } else if (dd < ds) { s = c; ds = dd; } }
      // dither only between two colours close enough to be shades of one another
      const frac = dither && da + ds > 0 && ds < 4 * da + 2000 ? da / (da + ds) : 0;
      const c = frac > BAYER[y & 7][x & 7] / 64 ? s : a;
      d[p] = (c >> 16) & 255; d[p + 1] = (c >> 8) & 255; d[p + 2] = c & 255; d[p + 3] = 255;
    }
  }
  return out;
}

/** Scores of a picture against the level: how far its colours are from the
 *  palette (0 is on it), its mean brightness (the board should stay the brightest thing). */
function score(bmp, collage, palette) {
  const pal = EnvGen.quantPalette(topColors(collage, 48).concat(palette.material), palette.dark), d = bmp.data;
  let far = 0, lum = 0, n = 0;
  for (let p = 0; p < d.length; p += 4 * 7) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    let best = Infinity;
    for (const c of pal) {
      const dr = ((c >> 16) & 255) - r, dg = ((c >> 8) & 255) - g, db = (c & 255) - b;
      const dd = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dd < best) best = dd;
    }
    far += best; lum += (r * 299 + g * 587 + b * 114) / 1000; n++;
  }
  return { paletteDistance: +(far / n).toFixed(1), meanLuma: +(lum / n).toFixed(1) };
}

/** The file a plane is kept in: floor.png for the first layer, floor-1.png for the next... */
const fileFor = (name) => { const { kind, i } = EnvGen.parsePlane(name); return kind + (i ? "-" + i : ""); };

const PLANE_WORDS = {
  floor: "ground seen from above, rocks and soil in the foreground, cave floor",
  wall: "distant background wall, far away, atmospheric depth, seamless tileable",
  ceiling: "cave ceiling seen from below, overhangs and stalactites, dark",
};

/** Can the model work on a picture this shape? A strip too low to scale up is left alone. */
function modelable(bmp) {
  return Math.min(bmp.width, bmp.height) >= 64;
}

/** A cut-out (a wall that is not the last) over the fog, so the model sees a whole picture. */
function overFog(bmp, fog) {
  const out = bmp.clone(), d = out.data;
  const fr = (fog >> 16) & 255, fg = (fog >> 8) & 255, fb = fog & 255;
  for (let p = 0; p < d.length; p += 4) {
    const a = d[p + 3] / 255;
    d[p] = d[p] * a + fr * (1 - a); d[p + 1] = d[p + 1] * a + fg * (1 - a); d[p + 2] = d[p + 2] * a + fb * (1 - a); d[p + 3] = 255;
  }
  return out;
}

/** The collage's alpha put back on the model's answer: the skyline stays a cut-out. */
function withAlphaOf(bmp, collage) {
  const out = bmp.clone(), d = out.data, c = collage.data;
  for (let p = 3; p < d.length; p += 4) d[p] = c[p];
  return out;
}

/** A column range of a picture that wraps round, as its own bitmap. */
function wrappedCrop(bmp, x0, w) {
  const out = new Lemmix.Bitmap(w, bmp.height), s = bmp.words(), d = out.words(), W = bmp.width;
  for (let y = 0; y < bmp.height; y++) for (let x = 0; x < w; x++) d[y * w + x] = s[y * W + (((x0 + x) % W) + W) % W];
  return out;
}

/**
 * The strips a wide picture is cut into for the model - each about 3.5
 * times as wide as high, overlapping its neighbours, the last one running
 * round into the first since the picture wraps - and how they are laid
 * back: blended across the overlaps.
 */
function stripsOf(bmp) {
  const aspect = bmp.width / bmp.height;
  // a strip must also fit the model's 1024 width once its height is brought to the model's
  const sc = Math.max(1, 256 / Math.min(bmp.width, bmp.height));
  const gh = Math.min(768, Math.max(256, Math.round(bmp.height * sc / 64) * 64));
  const maxW = Math.floor(1024 * bmp.height / gh);
  if (aspect <= 4.5 && bmp.width <= maxW) return [{ x: 0, w: bmp.width, ov: 0 }];
  const n = Math.max(Math.ceil(aspect / 3.5), Math.ceil(bmp.width / maxW));
  const cw = Math.ceil(bmp.width / n), ov = Math.min(64, cw >> 2);
  return Array.from({ length: n }, (_, i) => ({ x: i * cw - ov, w: Math.min(cw, bmp.width - i * cw) + 2 * ov, ov }));
}

function layStrips(strips, pieces, width, height) {
  const acc = new Float32Array(width * height * 4), wsum = new Float32Array(width * height);
  strips.forEach((st, i) => {
    const pc = pieces[i], d = pc.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < st.w; x++) {
        const wgt = st.ov ? Math.min(1, (x + 1) / st.ov, (st.w - x) / st.ov) : 1;
        const gx = (((st.x + x) % width) + width) % width, o = y * width + gx, p = (y * st.w + x) * 4;
        acc[o * 4] += d[p] * wgt; acc[o * 4 + 1] += d[p + 1] * wgt; acc[o * 4 + 2] += d[p + 2] * wgt;
        wsum[o] += wgt;
      }
    }
  });
  const out = new Lemmix.Bitmap(width, height), od = out.data;
  for (let o = 0; o < width * height; o++) {
    const w = wsum[o] || 1;
    od[o * 4] = acc[o * 4] / w; od[o * 4 + 1] = acc[o * 4 + 1] / w; od[o * 4 + 2] = acc[o * 4 + 2] / w; od[o * 4 + 3] = 255;
  }
  return out;
}

/** One strip through the model: the collage as the init image at a size
 *  the model likes (its short side at least 256, its long side 1024 at
 *  most, multiples of 64), back down to the strip's size afterwards. */
async function polishStrip(bmp, prompt, opts, seed) {
  const sc = Math.max(1, 256 / Math.min(bmp.width, bmp.height));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v / 64) * 64));
  const gw = clamp(bmp.width * sc, 256, 1024), gh = clamp(bmp.height * sc, 256, 768);
  const body = {
    init_images: [pngBuffer(resizeNearest(bmp, gw, gh)).toString("base64")],
    prompt, negative_prompt: "blurry, photo, realistic, text, watermark, smooth gradient, 3d render, noise",
    denoising_strength: opts.denoise, steps: opts.steps, cfg_scale: opts.cfg, seed,
    width: gw, height: gh,
  };
  // Draw Things validates the keys it gets: only what it knows goes in. Its
  // own `loras` list (a file name, a weight) replaces the app's selection;
  // an empty list switches the app's LoRA off for this call.
  if (opts.lora === "none") body.loras = [];
  else if (opts.lora && /\.(ckpt|safetensors)$/i.test(opts.lora.split(":")[0])) {
    const [file, w] = opts.lora.split(":");
    body.loras = [{ file, weight: w ? parseFloat(w) : 0.8 }];
  }
  if (opts.model) body.model = opts.model;
  if (opts.sampler) body.sampler_name = opts.sampler;
  const json = await api(opts.api, "/sdapi/v1/img2img", body);
  if (!json.images || !json.images[0]) throw new Error("img2img: no image in the answer");
  const raw = fromPngBuffer(Buffer.from(json.images[0].split(",").pop(), "base64"));
  return { raw, small: boxDown(raw, bmp.width, bmp.height) };
}

/** One plane through the model, in strips when it is wide, blended back together. */
async function polish(bmp, name, info, opts, seed) {
  const { kind, i } = EnvGen.parsePlane(name);
  const loraInPrompt = opts.lora && opts.lora !== "none" && !/\.(ckpt|safetensors)$/i.test(opts.lora.split(":")[0]);
  const lora = loraInPrompt ? " <lora:" + (opts.lora.includes(":") ? opts.lora : opts.lora + ":0.8") + ">" : "";
  const distance = i === 0 ? "" : i === 1 ? "middle distance" : "far away, hazy, atmospheric perspective";
  const prompt = [
    opts.trigger || "", "pixel art", "16-bit video game background", info.title + " tileset", PLANE_WORDS[kind], distance,
    "flat shading, limited palette, crisp pixels, no text", opts.prompt || "",
  ].filter(Boolean).join(", ") + lora;
  const strips = stripsOf(bmp);
  const pieces = [];
  for (let k = 0; k < strips.length; k++) {
    const st = strips[k];
    process.stdout.write(strips.length > 1 ? (k + 1) + "/" + strips.length + " " : "");
    const { small } = await polishStrip(wrappedCrop(bmp, st.x, st.w), prompt, opts, seed + k * 7919);
    pieces.push(small);
  }
  const small = strips.length === 1 ? pieces[0] : layStrips(strips, pieces, bmp.width, bmp.height);
  // the raw picture kept is the answer laid back at the plane's size (the strips do not survive as one)
  return { raw: small, small, prompt, strips: strips.length };
}

// --------------------------------------------------------------- the run
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.probe) {
    const p = await probe(opts.api);
    for (const [ep, v] of Object.entries(p)) {
      if (typeof v === "string") { console.log(ep + ": " + v); continue; }
      if (ep.endsWith("options")) console.log(ep + ": model " + JSON.stringify(v.sd_model_checkpoint) + ", " + Object.keys(v).length + " keys");
      else if (Array.isArray(v)) console.log(ep + ": " + v.map((m) => m.title || m.name || m.model_name || JSON.stringify(m)).join(" | "));
      else console.log(ep + ": " + JSON.stringify(v).slice(0, 300));
    }
    return;
  }
  if (!opts.names.length) { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].split("\n").slice(2).map((l) => l.replace(/^ \* ?/, "")).join("\n")); return; }
  const repoRoot = findRepoRoot();
  const styles = new Lemmix.StyleManager(nodeIO(repoRoot));
  const outRoot = path.resolve(repoRoot, opts.out || (opts.dry ? "tmp/env-dry" : "3d/env"));
  const report = [];
  for (const name of opts.names) {
    const isLevel = /\.nxlv$/i.test(name) || name.includes("/");
    const t0 = Date.now();
    const loaded = isLevel ? await levelContext(repoRoot, styles, name) : await styleContext(repoRoot, styles, name);
    const { ctx, wallpaper, title } = loaded;
    const outName = opts.as || loaded.name;
    const room = EnvGen.roomFor(isLevel ? ctx.width : 1600, isLevel ? ctx.height : 160, PX_PER_METRE);
    const palette = EnvGen.derivePalette(ctx);
    const names = EnvGen.planeNames(room).filter((n) => {
      const { kind, i } = EnvGen.parsePlane(n);
      return KINDS.includes(kind) && opts.planes.includes(kind) && (!opts.layers || opts.layers.includes(i));
    });
    const built = EnvGen.build(ctx, { room, full: true, palette, wallpaper }, names.concat(["backdrop"]));
    const lastWall = "wall" + (room.layers.length - 1);
    const dir = path.join(outRoot, outName);
    fs.mkdirSync(dir, { recursive: true });
    const rows = [];
    const seedBase = opts.seed !== undefined ? opts.seed : EnvGen.seededRandom(outName)() * 1e9 | 0;
    for (const plane of names) {
      const file = fileFor(plane);
      const collage = built.planes[plane];
      const cutout = EnvGen.parsePlane(plane).kind === "wall" && plane !== lastWall;
      const row = { plane, w: collage.width, h: collage.height, collage: file + "-collage.png", scores: {} };
      writePng(path.join(dir, row.collage), collage.width, collage.height, collage.data);
      row.scores.collage = score(collage, collage, palette);
      if (!opts.dry) {
        if (!modelable(collage)) {
          // too low and wide for the model: the collage is the picture
          row.final = file + ".png";
          row.note = "the collage, kept: too flat for the model";
          writePng(path.join(dir, row.final), collage.width, collage.height, collage.data);
          row.scores.final = row.scores.collage;
          rows.push(row);
          continue;
        }
        let raw, small, prompt, strips = 0;
        const init = cutout ? overFog(collage, built.fog) : collage;
        if (opts.requantise) {
          process.stdout.write("  " + plane + " from its raw picture... ");
          raw = fromPngBuffer(fs.readFileSync(path.join(dir, file + "-raw.png")));
          small = boxDown(raw, collage.width, collage.height);
          prompt = "(as before)";
        } else {
          process.stdout.write("  " + plane + " through the model... ");
          ({ raw, small, prompt, strips } = await polish(init, plane, { title }, opts, seedBase + names.indexOf(plane)));
        }
        let finished = opts.quantise ? quantise(small, collage, palette, opts) : small;
        if (cutout) finished = withAlphaOf(finished, collage);
        row.prompt = prompt;
        if (opts.keepRaw) { row.raw = file + "-raw.png"; writePng(path.join(dir, row.raw), raw.width, raw.height, raw.data); }
        if (strips) row.strips = strips;
        row.final = file + ".png";
        writePng(path.join(dir, row.final), finished.width, finished.height, finished.data);
        row.scores.final = score(finished, collage, palette);
        console.log("done");
      }
      rows.push(row);
    }
    if (built.backdrop) {
      const b = built.backdrop.bitmap;
      writePng(path.join(dir, "backdrop.png"), b.width, b.height, b.data);
    }
    const meta = {
      name: outName, title, level: isLevel ? name : null, style: isLevel ? ctx.theme && ctx.levelId : name,
      generated: new Date().toISOString(), mode: built.mode, palette: {
        source: palette.source, material: palette.material.map((c) => "#" + c.toString(16).padStart(6, "0")),
        bg: "#" + palette.bg.toString(16).padStart(6, "0"), dark: "#" + palette.dark.toString(16).padStart(6, "0"),
      },
      wallpaper: wallpaper ? { key: wallpaper.key, kind: wallpaper.kind } : null,
      fog: "#" + built.fog.toString(16).padStart(6, "0"),
      room: { layers: room.layers.map((l) => ({ d: l.d, kFloor: l.floor.k, kWall: l.wall.k, fog: +l.fog.toFixed(2) })) },
      model: opts.dry ? null : { api: opts.api, denoise: opts.denoise, steps: opts.steps, cfg: opts.cfg, seed: seedBase, lora: opts.lora || null, model: opts.model || null },
      planes: rows,
    };
    fs.writeFileSync(path.join(dir, "env.json"), JSON.stringify(meta, null, 2));
    report.push(meta);
    console.log(outName + ": " + rows.map((r) => r.plane + " " + r.w + "x" + r.h).join(", ") + " (" + (built.mode || "ambient") + ", palette " + palette.source + (wallpaper ? ", " + wallpaper.kind + " " + wallpaper.key : "") + ") in " + (Date.now() - t0) + " ms -> " + path.relative(repoRoot, dir));
  }
  writeContact(outRoot, report);
  console.log("contact sheet: " + path.relative(repoRoot, path.join(outRoot, "contact.html")));
  if (!opts.dry && path.resolve(outRoot) === path.resolve(repoRoot, "3d/env")) writeShippedIndex(outRoot);
}

/** 3d/env/index.json: the styles with a finished picture, which the page reads so it never probes for one. */
function writeShippedIndex(outRoot) {
  const styles = fs.readdirSync(outRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && KINDS.some((p) => fs.existsSync(path.join(outRoot, d.name, p + ".png"))))
    .map((d) => d.name).sort();
  fs.writeFileSync(path.join(outRoot, "index.json"), JSON.stringify({ styles }, null, 2) + "\n");
  console.log("3d/env/index.json: " + styles.length + " style(s)");
}

/** The contact sheet: every run's pictures side by side, with the scores. */
function writeContact(outRoot, report) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let html = "<!doctype html><meta charset=utf-8><title>environment contact sheet</title>" +
    "<style>body{background:#10141c;color:#dfe5ee;font:14px/1.4 system-ui,sans-serif;margin:16px}" +
    "h2{margin:24px 0 4px}img{image-rendering:pixelated;max-width:100%;background:#000;display:block}" +
    ".row{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin:8px 0 20px}" +
    ".pal span{display:inline-block;width:22px;height:22px;margin-right:2px;border:1px solid #444}small{color:#9aa4b2}</style>";
  // older runs stay on the sheet
  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(path.join(outRoot, "contact.json"), "utf8")); } catch (e) {}
  const all = previous.filter((p) => !report.some((r) => r.name === p.name)).concat(report);
  fs.writeFileSync(path.join(outRoot, "contact.json"), JSON.stringify(all, null, 2));
  for (const m of all) {
    html += "<h2>" + esc(m.title) + " <small>" + esc(m.name) + " · " + esc(m.mode || "ambient") + " · palette " + esc(m.palette.source) +
      (m.wallpaper ? " · " + esc(m.wallpaper.kind) + " " + esc(m.wallpaper.key) : "") + "</small></h2>";
    html += "<div class=pal>" + m.palette.material.map((c) => "<span style='background:" + c + "' title='" + c + "'></span>").join("") + "</div>";
    for (const r of m.planes) {
      html += "<div class=row>";
      const cell = (label, file, sc) => "<div><small>" + esc(label) + (sc ? " · Δpalette " + sc.paletteDistance + " · luma " + sc.meanLuma : "") +
        "</small><img src='" + esc(m.name + "/" + file) + "' width=" + r.w * 2 + "></div>";
      html += cell(r.plane + " collage " + r.w + "x" + r.h + (r.note ? " · " + r.note : ""), r.collage, r.scores.collage);
      if (r.raw) html += cell(r.plane + " model, raw", r.raw, null);
      if (r.final) html += cell(r.plane + " finished", r.final, r.scores.final);
      html += "</div>";
      if (r.prompt) html += "<small>prompt: " + esc(r.prompt) + "</small>";
    }
  }
  fs.writeFileSync(path.join(outRoot, "contact.html"), html);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(1); });
