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
 *     --planes a,b,c     floor, wall, ceiling (default all three)
 *     --api <url>        the server (default http://127.0.0.1:7860)
 *     --denoise <0..1>   img2img strength (default 0.45)
 *     --steps <n>        sampling steps (default 24)
 *     --cfg <n>          guidance (default 7)
 *     --seed <n>         the model's seed (default from the name)
 *     --lora <name[:w]>  a LoRA to name in the prompt, <lora:name:w>
 *     --model <name>     override_settings.sd_model_checkpoint
 *     --prompt "<text>"  extra words for every plane
 *     --no-quantise      keep the model's colours (still pixel-sized)
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
const PLANES = ["floor", "wall", "ceiling"];

function parseArgs(argv) {
  const o = { names: [], planes: PLANES, api: "http://127.0.0.1:7860", denoise: 0.45, steps: 24, cfg: 7, quantise: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === "--dry") o.dry = true;
    else if (a === "--out") o.out = next();
    else if (a === "--planes") o.planes = next().split(",").map((s) => s.trim()).filter((p) => PLANES.includes(p));
    else if (a === "--api") o.api = next();
    else if (a === "--denoise") o.denoise = parseFloat(next());
    else if (a === "--steps") o.steps = parseInt(next(), 10);
    else if (a === "--cfg") o.cfg = parseFloat(next());
    else if (a === "--seed") o.seed = parseInt(next(), 10);
    else if (a === "--lora") o.lora = next();
    else if (a === "--model") o.model = next();
    else if (a === "--prompt") o.prompt = next();
    else if (a === "--no-quantise") o.quantise = false;
    else if (a === "--keep-raw") o.keepRaw = true;
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
function quantise(bmp, collage, palette) {
  const pal = EnvGen.quantPalette(topColors(collage, 48).concat(palette.material), palette.dark);
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
      const frac = da + ds > 0 && ds < 4 * da + 2000 ? da / (da + ds) : 0;
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

const PLANE_WORDS = {
  floor: "ground seen from above, rocks and soil in the foreground, cave floor",
  wall: "distant background wall, far away, atmospheric depth, seamless tileable",
  ceiling: "cave ceiling seen from below, overhangs and stalactites, dark",
};

/** One plane through the model: the collage as the init image at the plane's
 *  size scaled up, back down to size afterwards. */
async function polish(bmp, plane, info, opts, seed) {
  const f = Math.max(1, Math.floor(768 / Math.max(bmp.width, bmp.height)));
  const big = enlarge(bmp, f);
  const gw = Math.max(256, Math.round(big.width / 64) * 64), gh = Math.max(256, Math.round(big.height / 64) * 64);
  const lora = opts.lora ? " <lora:" + (opts.lora.includes(":") ? opts.lora : opts.lora + ":0.8") + ">" : "";
  const prompt = [
    "pixel art", "16-bit video game background", info.title + " tileset", PLANE_WORDS[plane],
    "flat shading, limited palette, crisp pixels, no text", opts.prompt || "",
  ].filter(Boolean).join(", ") + lora;
  const body = {
    init_images: [pngBuffer(big).toString("base64")],
    prompt, negative_prompt: "blurry, photo, realistic, text, watermark, smooth gradient, 3d render, noise",
    denoising_strength: opts.denoise, steps: opts.steps, cfg_scale: opts.cfg, seed,
    width: gw, height: gh, sampler_name: "DPM++ 2M Karras", tiling: plane === "wall",
    override_settings: opts.model ? { sd_model_checkpoint: opts.model } : {},
  };
  const res = await fetch(opts.api.replace(/\/$/, "") + "/sdapi/v1/img2img", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("img2img: HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  const json = await res.json();
  if (!json.images || !json.images[0]) throw new Error("img2img: no image in the answer");
  const raw = fromPngBuffer(Buffer.from(json.images[0].split(",").pop(), "base64"));
  return { raw, small: boxDown(raw, bmp.width, bmp.height), prompt };
}

// --------------------------------------------------------------- the run
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.names.length) { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].split("\n").slice(2).map((l) => l.replace(/^ \* ?/, "")).join("\n")); return; }
  const repoRoot = findRepoRoot();
  const styles = new Lemmix.StyleManager(nodeIO(repoRoot));
  const outRoot = path.resolve(repoRoot, opts.out || (opts.dry ? "tmp/env-dry" : "3d/env"));
  const report = [];
  for (const name of opts.names) {
    const isLevel = /\.nxlv$/i.test(name) || name.includes("/");
    const t0 = Date.now();
    const { ctx, wallpaper, title, name: outName } = isLevel ? await levelContext(repoRoot, styles, name) : await styleContext(repoRoot, styles, name);
    const room = EnvGen.roomFor(isLevel ? ctx.width : 1600, isLevel ? ctx.height : 160, PX_PER_METRE);
    const palette = EnvGen.derivePalette(ctx);
    const built = EnvGen.build(ctx, { room, full: true, palette, wallpaper }, opts.planes.concat(["backdrop"]));
    const dir = path.join(outRoot, outName);
    fs.mkdirSync(dir, { recursive: true });
    const rows = [];
    const seedBase = opts.seed !== undefined ? opts.seed : EnvGen.seededRandom(outName)() * 1e9 | 0;
    for (const plane of opts.planes) {
      const collage = built.planes[plane];
      const row = { plane, w: collage.width, h: collage.height, collage: plane + "-collage.png", scores: {} };
      writePng(path.join(dir, row.collage), collage.width, collage.height, collage.data);
      row.scores.collage = score(collage, collage, palette);
      if (!opts.dry) {
        process.stdout.write("  " + plane + " through the model... ");
        const { raw, small, prompt } = await polish(collage, plane, { title }, opts, seedBase + PLANES.indexOf(plane));
        const finished = opts.quantise ? quantise(small, collage, palette) : small;
        row.prompt = prompt;
        if (opts.keepRaw) { row.raw = plane + "-raw.png"; writePng(path.join(dir, row.raw), raw.width, raw.height, raw.data); }
        row.final = plane + ".png";
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
      room: { k: { floor: room.floor.k, wall: room.wall.k } },
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
    .filter((d) => d.isDirectory() && PLANES.some((p) => fs.existsSync(path.join(outRoot, d.name, p + ".png"))))
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
      html += cell(r.plane + " collage " + r.w + "x" + r.h, r.collage, r.scores.collage);
      if (r.raw) html += cell(r.plane + " model, raw", r.raw, null);
      if (r.final) html += cell(r.plane + " finished", r.final, r.scores.final);
      html += "</div>";
      if (r.prompt) html += "<small>prompt: " + esc(r.prompt) + "</small>";
    }
  }
  fs.writeFileSync(path.join(outRoot, "contact.html"), html);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(1); });
