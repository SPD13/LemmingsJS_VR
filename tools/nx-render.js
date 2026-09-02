#!/usr/bin/env node
"use strict";
/**
 * Render NeoLemmix levels headlessly, the way the game would show them at
 * the start: background, terrain and every gadget at its first frame. Writes
 * PNGs and prints the physics-map counts (solid / steel / one-way pixels),
 * which double as fixtures for later changes.
 *
 * Usage: node tools/nx-render.js <level-id or prefix> [--out dir] [--limit N]
 *        node tools/nx-render.js --all [--out dir]            (counts only unless --png)
 */
const { Lemmix, nodeIO, writePng, findRepoRoot, listLevels } = require("./lemmix-node");
const fs = require("fs");
const path = require("path");

async function renderLevel(repoRoot, styles, entry) {
  const text = fs.readFileSync(path.join(repoRoot, entry.url), "utf8");
  const data = Lemmix.LevelBuilder.parseLevel(text);
  const level = await Lemmix.LevelBuilder.build(data, styles, { seed: entry.id });
  const { width, height } = level;
  const out = new Lemmix.Bitmap(width, height);
  const words = out.words();
  // background colour, then the tiled image
  const bg = level.background.color;
  words.fill((0xff << 24 | (bg & 0xff) << 16 | (bg & 0xff00) | (bg >> 16) & 0xff) >>> 0);
  if (level.background.image) {
    const img = level.background.image;
    for (let y = 0; y <= Math.floor(height / img.height); y++) {
      for (let x = 0; x <= Math.floor(width / img.width); x++) {
        Lemmix.Pixels.blit(out, x * img.width, y * img.height, img, 0, 0, img.width, img.height, Lemmix.Pixels.combineGadget);
      }
    }
  }
  // gadgets behind the terrain, terrain, gadgets in front - the draw layers of DrawAllGadgets
  const mask = level.groundMask.groundMask;
  const paint = (obj, onlyOnTerrain) => {
    const frame = obj.animation.getFrame();
    const fw = frame.width, fh = frame.height;
    const fx = obj.x + frame.offsetX, fy = obj.y + frame.offsetY;
    const src = new Lemmix.Bitmap(fw, fh, new Uint8ClampedArray(frame.data.buffer));
    for (let y = 0; y < fh; y++) {
      const py = fy + y;
      if (py < 0 || py >= height) continue;
      for (let x = 0; x < fw; x++) {
        const px = fx + x;
        if (px < 0 || px >= width) continue;
        if (onlyOnTerrain && !mask[px + py * width]) continue;
        Lemmix.Pixels.combineGadget(src.data, (y * fw + x) * 4, out.data, (py * width + px) * 4);
      }
    }
  };
  const objs = level.objects;
  const isOww = (g) => /^ONEWAY/.test(g.effect);
  const backgrounds = objs.filter((o) => o.gadget.effectBase === "BACKGROUND" && !o.gadget.onlyOnTerrain);
  const low = objs.filter((o) => o.gadget.noOverwrite && !o.gadget.onlyOnTerrain && o.gadget.effectBase !== "BACKGROUND" && !isOww(o.gadget)).reverse();
  const onTerrain = objs.filter((o) => (o.gadget.onlyOnTerrain && !o.gadget.noOverwrite && !isOww(o.gadget)) || o.gadget.effectBase === "PAINT");
  const arrows = objs.filter((o) => isOww(o.gadget));
  const high = objs.filter((o) => !(o.gadget.noOverwrite !== o.gadget.onlyOnTerrain) && o.gadget.effectBase !== "BACKGROUND" && !isOww(o.gadget) && o.gadget.effectBase !== "PAINT");
  for (const o of backgrounds) paint(o, false);
  for (const o of low) paint(o, false);
  // the terrain itself
  const terrain = new Lemmix.Bitmap(width, height, level.groundImage);
  Lemmix.Pixels.blit(out, 0, 0, terrain, 0, 0, width, height, Lemmix.Pixels.combineGadget);
  for (const o of onTerrain) paint(o, true);
  for (const o of arrows) paint(o, true);
  for (const o of high) paint(o, false);

  let solid = 0, steel = 0, oneWay = 0;
  for (let i = 0; i < level.physics.length; i++) {
    const c = level.physics[i];
    if (c & Lemmix.PM.SOLID) solid++;
    if (c & Lemmix.PM.STEEL) steel++;
    if (c & (Lemmix.PM.ONEWAYLEFT | Lemmix.PM.ONEWAYRIGHT | Lemmix.PM.ONEWAYDOWN | Lemmix.PM.ONEWAYUP)) oneWay++;
  }
  return { level, image: out, stats: { width, height, solid, steel, oneWay, gadgets: level.gadgets.length,
    lemmings: level.releaseCount, save: level.needCount, skills: level.skills.map((s) => s.name[0] + s.name.slice(1, 3).toLowerCase() + s.count).join(" "),
    missing: level.missingPieces.length } };
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const png = args.includes("--png") || !all;
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(findRepoRoot(), "..", "nx-render");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  const prefix = args.find((a) => !a.startsWith("--") && a !== (outIdx >= 0 ? args[outIdx + 1] : null) && a !== (limitIdx >= 0 ? args[limitIdx + 1] : null));
  const repoRoot = findRepoRoot();
  const styles = new Lemmix.StyleManager(nodeIO(repoRoot));
  const levels = listLevels(repoRoot, all ? null : prefix).slice(0, limit);
  if (!levels.length) { console.error("no levels match " + prefix); process.exit(1); }
  if (png) fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  for (const entry of levels) {
    const { image, stats } = await renderLevel(repoRoot, styles, entry);
    if (png) {
      const file = path.join(outDir, entry.id.replace(/[\\/]/g, "__").replace(/\.nxlv$/, "") + ".png");
      writePng(file, image.width, image.height, image.data);
    }
    console.log(entry.id + "  " + JSON.stringify(stats));
  }
  console.log(levels.length + " levels in " + ((Date.now() - t0) / 1000).toFixed(1) + " s" +
    (png ? ", PNGs in " + outDir : ""));
  if (styles.missing.size) console.log("missing pieces: " + [...styles.missing].join(", "));
}

main().catch((e) => { console.error(e); process.exit(2); });
