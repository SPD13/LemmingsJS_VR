#!/usr/bin/env node
"use strict";
/**
 * Fixtures for the depth profiles: the per-gallery files (3d/js/profile-store.js),
 * the styles index (tools/styles-index.js), the styles a level uses
 * (tools/levels-index.js) and the launcher's routes (launcher/server.js).
 *
 * Usage: node tools/profiles-test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const D = require("../3d/js/depth.js");
const { ProfileStore, ProfileFiles, renderTagButtons } = require("../3d/js/profile-store.js");
const { buildStylesIndex, readStylesIni } = require("./styles-index");
const { terrainStyles } = require("./levels-index");
const { createStaticServer } = require("../launcher/server");

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "  (" + JSON.stringify(detail) + ")" : "")); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A fetch over an in-memory file table, counting the calls per url. */
function fakeFetch(table, opts) {
  const o = opts || {};
  const calls = {};
  const fetch = async (url, init) => {
    const method = (init && init.method) || "GET";
    calls[url] = (calls[url] || 0) + 1;
    if (method === "POST") {
      if (o.postAs === "static") return { ok: true, json: async () => JSON.parse(table[url]) }; // a static server echoes the file
      if (o.postAs === "fail") return { ok: false };
      table[url] = o.mangle ? o.mangle(init.body) : init.body;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (!(url in table)) return { ok: false, status: 404 };
    return { ok: true, json: async () => JSON.parse(table[url]) };
  };
  return { fetch, calls };
}

/** A button stand-in with the two things renderTagButtons touches. */
function fakeButton(cls) {
  const set = new Set();
  return {
    dataset: { class: cls }, disabled: false,
    classList: { toggle: (n, on) => { on ? set.add(n) : set.delete(n); }, contains: (n) => set.has(n) },
  };
}

async function main() {
  // ================= keys, urls, galleries
  {
    console.log("keys and files");
    check("a Lemmix key is filed under its style", ProfileStore.urlForKey("orig_marble:column_01", "3d/profiles/lemmings-g0.json") === "3d/profiles/nx-orig_marble.json");
    check("a DOS id is filed under the level's tileset", ProfileStore.urlForKey(33, "3d/profiles/lemmings-g0.json") === "3d/profiles/lemmings-g0.json");
    check("a DOS id with no tileset has no file", ProfileStore.urlForKey("33", null) === null);
    check("gallery of a Lemmix key", ProfileStore.galleryForKey("davidz_gold:bar_01", "lemmings-g0") === "nx:davidz_gold");
    check("gallery of a DOS key", ProfileStore.galleryForKey(7, "lemmings-g0") === "lemmings-g0");
    check("gallery <-> url round trip (nx)", ProfileStore.galleryForUrl(ProfileStore.urlForGallery("nx:orig_dirt")) === "nx:orig_dirt");
    check("gallery <-> url round trip (dos)", ProfileStore.galleryForUrl(ProfileStore.urlForGallery("ohno-g2")) === "ohno-g2");
    check("a bad gallery id has no url", ProfileStore.urlForGallery("../etc") === null && ProfileStore.urlForGallery("nx:Bad Name") === null);
    // app.js and library.js build a DOS tileset's url by hand off PROFILE_DIR,
    // so it has to be exported, not just a local of the module: when it was not,
    // every one of them asked for "undefinedlemmings-g0.json"
    check("the profile directory is exported, and both ways of building a url agree",
      ProfileStore.PROFILE_DIR === "3d/profiles/" &&
      ProfileStore.PROFILE_DIR + "lemmings-g0.json" === ProfileStore.urlForGallery("lemmings-g0"));

    const lemmix = {
      lr: { terrains: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 1 }] },
      terraImages: { 0: { name: "orig_dirt:rock_01" }, 1: { name: "orig_marble:column_01" }, 2: { name: "orig_dirt:rock_02" } },
    };
    check("a Lemmix level needs one file per style, in first-seen order",
      same(ProfileStore.urlsForGroundData(lemmix, null), ["3d/profiles/nx-orig_dirt.json", "3d/profiles/nx-orig_marble.json"]));
    const dos = { lr: { terrains: [{ id: 3 }] }, terraImages: { 3: { width: 8 } } };
    check("a DOS level needs its tileset's file", same(ProfileStore.urlsForGroundData(dos, "3d/profiles/lemmings-g1.json"), ["3d/profiles/lemmings-g1.json"]));
    check("a special level needs none", same(ProfileStore.urlsForGroundData(null, "3d/profiles/lemmings-g1.json"), []));
  }

  // ================= merging
  {
    console.log("merging");
    const a = { tileset: "A", terrain: { default: "terrain", byId: { "a:x": "backdrop" } }, emboss: { byId: { "a:x": false } }, blend: { byId: { "a:x": true } }, colorBlend: { byId: { "a:x": true } }, sculpt: { byId: { "a:x": true } }, objects: { byId: { 4: { kind: "water" } } } };
    const b = { terrain: { byId: { "b:y": "relief", "a:x": "overlay" } } };
    const m = ProfileStore.merge([{ url: "a", profile: a }, { url: "none", profile: null }, { url: "b", profile: b }]);
    check("byId maps are unioned", m.terrain.byId["b:y"] === "relief" && m.emboss.byId["a:x"] === false);
    check("surface blend rides along", m.blend.byId["a:x"] === true);
    check("colour blend rides along", m.colorBlend.byId["a:x"] === true);
    check("3D object rides along", m.sculpt.byId["a:x"] === true);
    check("a later file wins a duplicate key", m.terrain.byId["a:x"] === "overlay");
    check("object settings ride along", m.objects.byId[4].kind === "water");
    check("the default class is terrain", m.terrain.default === "terrain");
    check("a missing file merges as nothing", same(ProfileStore.merge([{ url: "x", profile: null }]), ProfileStore.emptyProfile()));
    check("merging leaves the files alone", a.terrain.byId["a:x"] === "backdrop" && !("b:y" in a.terrain.byId));
  }

  // ================= the tag state machine (what the buttons do)
  {
    console.log("tags");
    const p = ProfileStore.emptyProfile();
    check("untagged is auto", ProfileStore.classOf("k", p) === null);
    ProfileStore.withClass(p, "k", "relief");
    check("a class tag", ProfileStore.classOf("k", p) === "relief");
    ProfileStore.withClass(p, "k", null);
    check("auto removes the entry", !("k" in p.terrain.byId));
    check("the cycle runs terrain > relief > backdrop > overlay > auto > terrain",
      ProfileStore.nextClass(null) === "terrain" && ProfileStore.nextClass("terrain") === "relief" &&
      ProfileStore.nextClass("overlay") === null);
    check("3D shade is on by default and toggles off", ProfileStore.nextEmbossToggle("k", p) === false);
    ProfileStore.withEmboss(p, "k", false);
    check("...and back on, light raised", ProfileStore.nextEmbossToggle("k", p) === true);
    check("invert from off turns it on inverted", ProfileStore.nextEmbossInvert("k", p) === "invert");
    ProfileStore.withEmboss(p, "k", "invert");
    check("invert from inverted goes back to light raised", ProfileStore.nextEmbossInvert("k", p) === true);
    check("the depth pass reads the tag", D.depthClassForPiece({ key: "k" }, ProfileStore.withClass(p, "k", "backdrop")) === D.DepthClass.BACKDROP);
    check("normalize repairs a bare file", same(ProfileStore.normalize({ tileset: "x" }), { tileset: "x", terrain: { default: "terrain", byId: {} }, emboss: { byId: {} }, blend: { byId: {} }, colorBlend: { byId: {} }, sculpt: { byId: {} } }));

    check("3D object is off by default and toggles on", D.sculptFor("k", p) === false &&
      ProfileStore.nextSculptToggle("k", p) === true);
    ProfileStore.withSculpt(p, "k", true);
    check("...the opt-in is what the file records", p.sculpt.byId["k"] === true &&
      D.sculptFor("k", p) === true && ProfileStore.nextSculptToggle("k", p) === false);
    ProfileStore.withSculpt(p, "k", false);
    check("back off drops the entry again", !("k" in p.sculpt.byId) && D.sculptFor("k", p) === false);
    check("only a true reads as on", D.sculptFor("k", { sculpt: { byId: { k: "yes" } } }) === false &&
      D.sculptFor("k", { sculpt: { default: true } }) === true);

    check("surface blend is on by default and toggles off", D.surfaceBlendFor("k", p) === true &&
      ProfileStore.nextBlendToggle("k", p) === false);
    ProfileStore.withBlend(p, "k", false);
    check("...the exclusion is what the file records", p.blend.byId["k"] === false &&
      D.surfaceBlendFor("k", p) === false && ProfileStore.nextBlendToggle("k", p) === true);
    ProfileStore.withBlend(p, "k", true);
    check("back on drops the entry again", !("k" in p.blend.byId) && D.surfaceBlendFor("k", p) === true);
    check("an older file's redundant true still reads as on",
      D.surfaceBlendFor("k", { blend: { byId: { k: true } } }) === true);

    check("colour blend is on by default and toggles off", D.colorBlendFor("k", p) === true &&
      ProfileStore.nextColorBlendToggle("k", p) === false);
    ProfileStore.withColorBlend(p, "k", false);
    check("...the exclusion is what the file records", p.colorBlend.byId["k"] === false &&
      D.colorBlendFor("k", p) === false && ProfileStore.nextColorBlendToggle("k", p) === true);
    ProfileStore.withColorBlend(p, "k", true);
    check("back on drops the entry again", !("k" in p.colorBlend.byId) && D.colorBlendFor("k", p) === true);
    check("an older file's redundant true still reads as on",
      D.colorBlendFor("k", { colorBlend: { byId: { k: true } } }) === true);

    const dom = { classBtns: ["backdrop", "terrain", "relief", "overlay"].map(fakeButton), autoBtn: fakeButton(), embossBtn: fakeButton(), invertBtn: fakeButton(), sculptBtn: fakeButton(), blendBtn: fakeButton(), colorBlendBtn: fakeButton() };
    renderTagButtons(dom, "k", p, true);
    check("buttons: the class and inverted shade are lit", dom.classBtns[0].classList.contains("active") && !dom.autoBtn.classList.contains("active") &&
      dom.embossBtn.classList.contains("active") && dom.invertBtn.classList.contains("active"));
    check("buttons: 3D object is dark until tagged in", !dom.sculptBtn.classList.contains("active"));
    ProfileStore.withSculpt(p, "k", true);
    renderTagButtons(dom, "k", p, true);
    check("buttons: ...and lit once it is", dom.sculptBtn.classList.contains("active"));
    ProfileStore.withSculpt(p, "k", false);
    check("buttons: both blends are lit until they are tagged out",
      dom.blendBtn.classList.contains("active") && dom.colorBlendBtn.classList.contains("active"));
    ProfileStore.withColorBlend(p, "k", false);
    ProfileStore.withBlend(p, "k", false);
    renderTagButtons(dom, "k", p, true);
    check("buttons: ...and go dark once they are",
      !dom.colorBlendBtn.classList.contains("active") && !dom.blendBtn.classList.contains("active"));
    ProfileStore.withColorBlend(p, "k", true);
    ProfileStore.withBlend(p, "k", true);
    renderTagButtons(dom, "other", p, true);
    check("buttons: an untagged piece lights auto, 3D shade and both blends", dom.autoBtn.classList.contains("active") && dom.embossBtn.classList.contains("active") &&
      dom.blendBtn.classList.contains("active") && dom.colorBlendBtn.classList.contains("active") &&
      !dom.invertBtn.classList.contains("active") && !dom.classBtns[0].classList.contains("active"));
    renderTagButtons(dom, null, p, false);
    check("buttons: nothing selected disables them all", dom.classBtns.every((b) => b.disabled) && dom.autoBtn.disabled && dom.embossBtn.disabled && dom.sculptBtn.disabled);
  }

  // ================= 3D object: a shaded sprite read as a body on a lathe
  {
    console.log("3D object");
    // a strip of level with two pieces on it: a "tube" 24 wide and 6 tall,
    // shaded in upright bands (a standing cylinder), and a "rock" of two
    // alternating shades, the plain grain. The placements are what the
    // compositor would have been given, so the sculpt can read the sprites.
    const W = 40, H = 6, N = W * H;
    const TUBE_W = 24, ROCK_X = 30, ROCK_W = 6;
    const img = new Uint8Array(N * 4), mask = new Uint8Array(N), pieceMap = new Uint16Array(N);
    const paint = (i, v, id) => { img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = v; mask[i] = 1; pieceMap[i] = id + 1; };
    const level = { width: W, height: H, groundImage: img, getGroundMaskLayer: () => ({ groundMask: mask }) };
    const sprite = (name, w, h) => ({ name, width: w, height: h, frames: [new Uint8Array(w * h)] }); // all solid
    const groundData = {
      lr: { levelWidth: W, levelHeight: H, terrains: [
        { id: 0, x: 0, y: 0, drawProperties: {} }, { id: 1, x: ROCK_X, y: 0, drawProperties: {} },
      ] },
      terraImages: { 0: sprite("s:tube", TUBE_W, H), 1: sprite("s:rock", ROCK_W, H) },
    };
    const shadeTube = (shade) => { for (let y = 0; y < H; y++) for (let x = 0; x < TUBE_W; x++) paint(y * W + x, shade(x, y), 0); };
    for (let y = 0; y < H; y++) for (let x = ROCK_X; x < ROCK_X + ROCK_W; x++) paint(y * W + x, x % 2 ? 180 : 60, 1);
    const row = (map, y) => Array.from(map.slice(y * W, y * W + W));
    const col = (map, x) => Array.from({ length: H }, (_, y) => map[y * W + x]);
    const symmetric = (a) => a.every((v, i) => v === a[a.length - 1 - i]);
    const rising = (a) => a.every((v, i) => i === 0 || v >= a[i - 1]);

    check("a slice stands its radius, capped",
      D.sculptRadius(24) === 12 && D.sculptRadius(200) === D.SCULPT_MAX && D.sculptRadius(1) === 0.5);
    check("the cap is what every relief consumer sizes by", D.RELIEF_TOP >= D.SCULPT_MAX && D.RELIEF_TOP >= D.RELIEF_MAX);

    // a front-lit cylinder: light in the middle, dark at both rims, in four steps
    shadeTube((x) => 40 + 64 * Math.floor(3.99 * Math.sin(Math.PI * (x + 0.5) / TUBE_W)));
    const plain = row(D.buildReliefMap(level, pieceMap, ProfileStore.emptyProfile(), true, groundData), 2);
    check("untagged, both pieces carry the grain over one shared range",
      plain[0] === 0 && plain[11] === D.RELIEF_MAX && Math.max(...plain) === D.RELIEF_MAX &&
      plain[ROCK_X] === 0 && plain[ROCK_X + 1] < D.RELIEF_MAX);

    const tagged = ProfileStore.withSculpt(ProfileStore.emptyProfile(), "s:tube", true);
    const sculpted = row(D.buildReliefMap(level, pieceMap, tagged, true, groundData), 2);
    const tube = sculpted.slice(0, TUBE_W);
    check("tagged, the standing tube is sliced across its width and stands its radius",
      Math.max(...tube) === 12 && tube[11] === 12 && tube[12] === 12, tube);
    check("...a semicircle: both rims low and alike, rising to the middle",
      symmetric(tube) && rising(tube.slice(0, 12)) && tube[0] < 4 && new Set(tube).size > 4, tube);
    check("...the same on every row", same(row(D.buildReliefMap(level, pieceMap, tagged, true, groundData), 0).slice(0, TUBE_W), tube));
    check("the grain's range is measured without it, so the rock uses the full grain",
      sculpted[ROCK_X] === 0 && sculpted[ROCK_X + 1] === D.RELIEF_MAX, sculpted.slice(ROCK_X, ROCK_X + ROCK_W));

    // the same cylinder lit from the right: light rim, dark rim - the same body
    shadeTube((x) => 40 + 8 * x);
    const sideLit = row(D.buildReliefMap(level, pieceMap, tagged, true, groundData), 2).slice(0, TUBE_W);
    check("lit from the side, the light rim and the dark rim sit at the same depth, the middle nearest",
      same(sideLit, tube), sideLit);
    const inverted = ProfileStore.withEmboss(ProfileStore.withSculpt(ProfileStore.emptyProfile(), "s:tube", true), "s:tube", "invert");
    check("invert is the shade's business: the body is the same",
      same(row(D.buildReliefMap(level, pieceMap, inverted, true, groundData), 2).slice(0, TUBE_W), tube));

    // shaded in bands lying along it: a lying cylinder, sliced column by column
    shadeTube((x, y) => 40 + 40 * y);
    const lying = D.buildReliefMap(level, pieceMap, tagged, true, groundData);
    const slice = col(lying, 5);
    check("bands lying along the piece turn the lathe the other way: sliced down its height",
      Math.max(...slice) === 3 && symmetric(slice) && rising(slice.slice(0, 3)) && slice[0] < 3, slice);
    check("...every column alike", same(col(lying, 0), slice) && same(col(lying, 23), slice));

    // one flat colour: no bands, turned on its longer side
    shadeTube(() => 100);
    check("a piece of one flat colour is turned on its longer side",
      same(col(D.buildReliefMap(level, pieceMap, tagged, true, groundData), 5), slice));

    // the sprite's own outline, not what shows: a covering piece in front of
    // the tube leaves the tube's slice as wide as it was
    shadeTube((x) => 40 + 8 * x);
    for (let y = 0; y < H; y++) for (let x = 0; x < 6; x++) paint(y * W + x, 100, 1);
    const covered = row(D.buildReliefMap(level, pieceMap, tagged, true, groundData), 2);
    check("a part hidden behind another piece still shapes the part that shows",
      same(covered.slice(6, TUBE_W), tube.slice(6)) && covered.slice(0, 6).every((v) => v <= D.RELIEF_MAX), covered);
    check("the 3D-terrain switch off flattens the sculpt with the grain",
      D.buildReliefMap(level, pieceMap, tagged, false, groundData).every((v) => v === 0));
    check("a special level, with no placements to read, sculpts nothing",
      D.buildReliefMap(level, pieceMap, tagged, true, { terraImages: groundData.terraImages }).slice(6, TUBE_W).every((v) => v <= D.RELIEF_MAX));
  }

  // ================= surface blend: which colours a pixel may draw from
  {
    console.log("surface blend");
    // a 4x4 sprite in three stripes: dark green, light green, brown. Only the
    // light green touches the dark green - the brown is two rows away.
    const DARK = [20, 80, 20], LIGHT = [60, 180, 60], BROWN = [120, 80, 40];
    const W = 4, H = 4;
    const rows = [DARK, LIGHT, BROWN, BROWN];
    const groundImage = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, c = rows[y];
        groundImage[o] = c[0]; groundImage[o + 1] = c[1]; groundImage[o + 2] = c[2];
        groundImage[o + 3] = 255;
      }
    }
    const level = {
      width: W, height: H, groundImage,
      getGroundMaskLayer: () => ({ groundMask: new Uint8Array(W * H).fill(1) }),
    };
    const pieceMap = new Uint16Array(W * H).fill(1); // one piece, id 0
    const groundData = { terraImages: { 0: { name: "s:p" } } };
    const has = (palette, c) => palette.some((d) => d.r === c[0] && d.g === c[1] && d.b === c[2]);

    const off = D.buildBlendMap(level, pieceMap, { blend: { byId: { "s:p": false } } }, groundData);
    check("a piece tagged out of it yields no donors", off.donors.length === 0 &&
      off.slot.every((v) => v === 0));

    const on = D.buildBlendMap(level, pieceMap, { blend: { byId: {} } }, groundData);
    const dark = on.donors[on.slot[0 * W + 0] - 1];
    check("the dark green zone may use the light green that touches it",
      has(dark, DARK) && has(dark, LIGHT));
    check("...but not the brown two rows away", !has(dark, BROWN));
    const brown = on.donors[on.slot[3 * W + 0] - 1];
    check("the brown zone reaches the light green it borders, not the dark",
      has(brown, BROWN) && has(brown, LIGHT) && !has(brown, DARK));
    check("a donor is a pixel of the colour it stands for", on.donors.every((palette) =>
      palette.every((d) => {
        const o = d.index * 4;
        return groundImage[o] === d.r && groundImage[o + 1] === d.g && groundImage[o + 2] === d.b;
      })));

    const cbOn = D.buildColorBlendMap(level, pieceMap, { colorBlend: { byId: {} } }, true, groundData);
    check("colour blend marks every solid pixel of an untagged piece",
      cbOn.length === W * H && Array.from(cbOn).every((v) => v === 1));
    const cbOff = D.buildColorBlendMap(level, pieceMap, { colorBlend: { byId: {} } }, false, groundData);
    check("the master switch off leaves nothing marked", Array.from(cbOff).every((v) => v === 0));
    const cbExcluded = D.buildColorBlendMap(level, pieceMap, { colorBlend: { byId: { "s:p": false } } }, true, groundData);
    check("a piece tagged out of it is not colour blended", Array.from(cbExcluded).every((v) => v === 0));

    // one colour everywhere: nothing to blend with, so nothing is marked
    const flat = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      flat[i * 4] = DARK[0]; flat[i * 4 + 1] = DARK[1]; flat[i * 4 + 2] = DARK[2]; flat[i * 4 + 3] = 255;
    }
    const plain = D.buildBlendMap({ ...level, groundImage: flat }, pieceMap,
      { blend: { byId: {} } }, groundData);
    check("a single-colour zone is dropped", plain.donors.length === 0 &&
      plain.slot.every((v) => v === 0));

    // a near-identical shade is one colour, not two: the anti-aliasing rule
    const aa = groundImage.slice();
    for (let x = 0; x < W; x++) { // row 1 nudged a hair away from LIGHT
      const o = (1 * W + x) * 4;
      aa[o] = LIGHT[0] + 4; aa[o + 1] = LIGHT[1] + 4; aa[o + 2] = LIGHT[2] + 4;
    }
    const merged = D.buildBlendMap({ ...level, groundImage: aa }, pieceMap,
      { blend: { byId: {} } }, groundData);
    check("shades within the merge threshold count as one colour",
      merged.donors[merged.slot[0] - 1].length === 2);
  }

  // ================= the file cache
  {
    console.log("files");
    const table = { "3d/profiles/nx-a.json": JSON.stringify({ terrain: { byId: { "a:p": "backdrop" } } }) };
    const ff = fakeFetch(table);
    const files = new ProfileFiles({ fetch: ff.fetch });
    const merged = await files.loadAll(["3d/profiles/nx-a.json", "3d/profiles/nx-b.json"]);
    check("a present file loads and exists", files.exists("3d/profiles/nx-a.json") && merged.terrain.byId["a:p"] === "backdrop");
    check("an absent file is an empty profile", !files.exists("3d/profiles/nx-b.json") && same(files.get("3d/profiles/nx-b.json"), ProfileStore.emptyProfile()));
    files.setClass("b:q", "relief", "3d/profiles/nx-b.json");
    check("a change marks its file dirty only", same(files.dirtyUrls(), ["3d/profiles/nx-b.json"]));
    await files.loadAll(["3d/profiles/nx-a.json", "3d/profiles/nx-b.json"]);
    check("a clean file is fetched again, a dirty one is not", ff.calls["3d/profiles/nx-a.json"] === 2 && ff.calls["3d/profiles/nx-b.json"] === 1);
    check("the unsaved change survives the reload", files.merged(["3d/profiles/nx-b.json"]).terrain.byId["b:q"] === "relief");
    const r = await files.save("3d/profiles/nx-b.json");
    check("save writes the file and clears dirty", r.ok && !files.isDirty("3d/profiles/nx-b.json") && files.exists("3d/profiles/nx-b.json") &&
      JSON.parse(table["3d/profiles/nx-b.json"]).terrain.byId["b:q"] === "relief");
    check("export is the file's JSON", JSON.parse(files.exportJson("3d/profiles/nx-b.json")).terrain.byId["b:q"] === "relief");
    files.setBlend("b:q", false, "3d/profiles/nx-b.json");
    files.setColorBlend("b:q", false, "3d/profiles/nx-b.json");
    files.setSculpt("b:q", true, "3d/profiles/nx-b.json");
    files.resetAll("3d/profiles/nx-b.json");
    check("reset clears every tag of the file", same(files.get("3d/profiles/nx-b.json").terrain.byId, {}) &&
      same(files.get("3d/profiles/nx-b.json").blend.byId, {}) &&
      same(files.get("3d/profiles/nx-b.json").colorBlend.byId, {}) &&
      same(files.get("3d/profiles/nx-b.json").sculpt.byId, {}) && files.isDirty("3d/profiles/nx-b.json"));

    const st = new ProfileFiles({ fetch: fakeFetch({ "3d/profiles/nx-c.json": "{}" }, { postAs: "static" }).fetch });
    st.setClass("c:p", "relief", "3d/profiles/nx-c.json");
    const r2 = await st.save("3d/profiles/nx-c.json");
    check("a static server's echo is not a save", !r2.ok && r2.error === "no write receipt" && st.isDirty("3d/profiles/nx-c.json"));
    const mg = new ProfileFiles({ fetch: fakeFetch({}, { mangle: () => JSON.stringify({ terrain: { byId: {} } }) }).fetch });
    mg.setClass("c:p", "relief", "3d/profiles/nx-c.json");
    const r3 = await mg.save("3d/profiles/nx-c.json");
    check("a read-back that differs is not a save", !r3.ok && r3.error === "read-back mismatch");
    const mb = new ProfileFiles({ fetch: fakeFetch({}, { mangle: (json) => JSON.stringify({ ...JSON.parse(json), blend: { byId: {} } }) }).fetch });
    mb.setBlend("c:p", false, "3d/profiles/nx-c.json");
    const r4 = await mb.save("3d/profiles/nx-c.json");
    check("a read-back that drops the surface blend is not a save", !r4.ok && r4.error === "read-back mismatch");

    const mc = new ProfileFiles({ fetch: fakeFetch({}, { mangle: (json) => JSON.stringify({ ...JSON.parse(json), colorBlend: { byId: {} } }) }).fetch });
    mc.setColorBlend("c:p", false, "3d/profiles/nx-c.json");
    const r5 = await mc.save("3d/profiles/nx-c.json");
    check("a read-back that drops the colour blend is not a save", !r5.ok && r5.error === "read-back mismatch");

    const ms = new ProfileFiles({ fetch: fakeFetch({}, { mangle: (json) => JSON.stringify({ ...JSON.parse(json), sculpt: { byId: {} } }) }).fetch });
    ms.setSculpt("c:p", true, "3d/profiles/nx-c.json");
    const r6 = await ms.save("3d/profiles/nx-c.json");
    check("a read-back that drops the 3D object is not a save", !r6.ok && r6.error === "read-back mismatch");

    const two = new ProfileFiles({ fetch: fakeFetch({}).fetch });
    two.setClass("a:p", "relief", "3d/profiles/nx-a.json");
    two.setEmboss(5, "invert", "3d/profiles/lemmings-g0.json");
    const rs = await two.saveDirty();
    check("saveDirty saves each changed file", rs.length === 2 && rs.every((x) => x.ok) && two.dirtyUrls().length === 0);
  }

  // ================= the styles index
  {
    console.log("styles index");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "styles-"));
    const styles = path.join(tmp, "neolemmix", "styles");
    const mk = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
    mk(path.join(styles, "styles.ini"), "[my_style]\nName=My Style\nOrder=0\n\n[other]\nName=Other\n");
    mk(path.join(styles, "my_style", "theme.nxtm"), "LEMMINGS orig_dirt\n$COLORS\n$END\n");
    mk(path.join(styles, "my_style", "terrain", "rock_10.png"), "png");
    mk(path.join(styles, "my_style", "terrain", "rock_2.png"), "png");
    mk(path.join(styles, "my_style", "terrain", "Girder.PNG"), "png");
    mk(path.join(styles, "my_style", "terrain", "girder.nxmt"), "STEEL\nRESIZE_BOTH\n");
    mk(path.join(styles, "my_style", "terrain", "photo.jpg"), "jpg");
    mk(path.join(styles, "my_style", "objects", "exit.png"), "png");
    mk(path.join(styles, "empty_style", "theme.nxtm"), "");
    const index = buildStylesIndex(tmp);
    check("every style folder is listed, in order", same(index.styles.map((s) => s.name), ["empty_style", "my_style"]) && index.count === 2);
    const my = index.styles[1];
    check("pieces are the lowercased PNG names in natural order", same(my.pieces, ["girder", "rock_2", "rock_10"]) && my.count === 3);
    check("steel comes from the .nxmt", same(my.steel, ["girder"]));
    check("the title comes from styles.ini, the theme from theme.nxtm", my.title === "My Style" && my.theme === "orig_dirt");
    check("a style without terrain has no pieces", index.styles[0].count === 0 && index.styles[0].title === "empty_style" && index.styles[0].theme === "default");
    check("styles.ini names", same(readStylesIni(fs.readFileSync(path.join(styles, "styles.ini"), "utf8")), { my_style: "My Style", other: "Other" }));
    check("no styles folder: an empty index", buildStylesIndex(path.join(tmp, "nowhere")).count === 0);

    console.log("level styles");
    const nxlv = "TITLE x\nTHEME orig_dirt\n$GADGET\n STYLE orig_fire\n PIECE exit\n$END\n$TERRAIN\n STYLE Orig_Marble\n PIECE column_01\n$END\n$TERRAIN\n STYLE orig_marble\n PIECE column_02\n$END\n$TERRAIN\n STYLE *group\n PIECE g1\n$END\n$TERRAIN\n STYLE ohno_snow\n PIECE ice_01\n$END\n";
    check("the terrain styles, once each, lowercased, without groups or gadgets", same(terrainStyles(nxlv), ["ohno_snow", "orig_marble"]));

    // ================= the launcher's routes, over the loopback
    console.log("launcher routes");
    fs.mkdirSync(path.join(tmp, "3d", "profiles"), { recursive: true });
    const srv = await createStaticServer(tmp, 0);
    const base = "http://127.0.0.1:" + srv.port;
    try {
      const url = base + "/3d/profiles/nx-my_style.json";
      const post = await fetch(url, { method: "POST", body: JSON.stringify({ terrain: { byId: { "my_style:girder": "relief" } } }) });
      check("POST writes a per-style profile and answers a receipt", post.ok && (await post.json()).ok === true &&
        JSON.parse(fs.readFileSync(path.join(tmp, "3d", "profiles", "nx-my_style.json"), "utf8")).terrain.byId["my_style:girder"] === "relief");
      const back = await fetch(url);
      check("...and serves it back", back.ok && (await back.json()).terrain.byId["my_style:girder"] === "relief");
      const bad = await fetch(base + "/3d/profiles/nx-My.Style.json", { method: "POST", body: "{}" });
      check("a name outside the pattern is not written", !fs.existsSync(path.join(tmp, "3d", "profiles", "nx-My.Style.json")) && bad.status === 404);
      const idx = await fetch(base + "/neolemmix/styles/index.json");
      const body = await idx.json();
      check("the styles index is built live", idx.ok && body.count === 2 && body.styles[1].pieces.length === 3);
      const files = new ProfileFiles({ fetch: (u, init) => fetch(base + "/" + u, init) });
      files.setClass("my_style:rock_2", "backdrop", "3d/profiles/nx-my_style.json");
      const saved = await files.save("3d/profiles/nx-my_style.json");
      check("ProfileFiles saves through the route", saved.ok &&
        JSON.parse(fs.readFileSync(path.join(tmp, "3d", "profiles", "nx-my_style.json"), "utf8")).terrain.byId["my_style:rock_2"] === "backdrop");
    } finally {
      await srv.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
