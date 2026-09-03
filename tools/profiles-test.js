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
    check("a Lemmix key is filed under its style", ProfileStore.urlForKey("orig_marble:column_01", "profiles/lemmings-g0.json") === "profiles/nx-orig_marble.json");
    check("a DOS id is filed under the level's tileset", ProfileStore.urlForKey(33, "profiles/lemmings-g0.json") === "profiles/lemmings-g0.json");
    check("a DOS id with no tileset has no file", ProfileStore.urlForKey("33", null) === null);
    check("gallery of a Lemmix key", ProfileStore.galleryForKey("davidz_gold:bar_01", "lemmings-g0") === "nx:davidz_gold");
    check("gallery of a DOS key", ProfileStore.galleryForKey(7, "lemmings-g0") === "lemmings-g0");
    check("gallery <-> url round trip (nx)", ProfileStore.galleryForUrl(ProfileStore.urlForGallery("nx:orig_dirt")) === "nx:orig_dirt");
    check("gallery <-> url round trip (dos)", ProfileStore.galleryForUrl(ProfileStore.urlForGallery("ohno-g2")) === "ohno-g2");
    check("a bad gallery id has no url", ProfileStore.urlForGallery("../etc") === null && ProfileStore.urlForGallery("nx:Bad Name") === null);

    const lemmix = {
      lr: { terrains: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 1 }] },
      terraImages: { 0: { name: "orig_dirt:rock_01" }, 1: { name: "orig_marble:column_01" }, 2: { name: "orig_dirt:rock_02" } },
    };
    check("a Lemmix level needs one file per style, in first-seen order",
      same(ProfileStore.urlsForGroundData(lemmix, null), ["profiles/nx-orig_dirt.json", "profiles/nx-orig_marble.json"]));
    const dos = { lr: { terrains: [{ id: 3 }] }, terraImages: { 3: { width: 8 } } };
    check("a DOS level needs its tileset's file", same(ProfileStore.urlsForGroundData(dos, "profiles/lemmings-g1.json"), ["profiles/lemmings-g1.json"]));
    check("a special level needs none", same(ProfileStore.urlsForGroundData(null, "profiles/lemmings-g1.json"), []));
  }

  // ================= merging
  {
    console.log("merging");
    const a = { tileset: "A", terrain: { default: "terrain", byId: { "a:x": "backdrop" } }, emboss: { byId: { "a:x": false } }, objects: { byId: { 4: { kind: "water" } } } };
    const b = { terrain: { byId: { "b:y": "relief", "a:x": "overlay" } } };
    const m = ProfileStore.merge([{ url: "a", profile: a }, { url: "none", profile: null }, { url: "b", profile: b }]);
    check("byId maps are unioned", m.terrain.byId["b:y"] === "relief" && m.emboss.byId["a:x"] === false);
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
    check("normalize repairs a bare file", same(ProfileStore.normalize({ tileset: "x" }), { tileset: "x", terrain: { default: "terrain", byId: {} }, emboss: { byId: {} } }));

    const dom = { classBtns: ["backdrop", "terrain", "relief", "overlay"].map(fakeButton), autoBtn: fakeButton(), embossBtn: fakeButton(), invertBtn: fakeButton() };
    renderTagButtons(dom, "k", p, true);
    check("buttons: the class and inverted shade are lit", dom.classBtns[0].classList.contains("active") && !dom.autoBtn.classList.contains("active") &&
      dom.embossBtn.classList.contains("active") && dom.invertBtn.classList.contains("active"));
    renderTagButtons(dom, "other", p, true);
    check("buttons: an untagged piece lights auto and 3D shade only", dom.autoBtn.classList.contains("active") && dom.embossBtn.classList.contains("active") &&
      !dom.invertBtn.classList.contains("active") && !dom.classBtns[0].classList.contains("active"));
    renderTagButtons(dom, null, p, false);
    check("buttons: nothing selected disables them all", dom.classBtns.every((b) => b.disabled) && dom.autoBtn.disabled && dom.embossBtn.disabled);
  }

  // ================= the file cache
  {
    console.log("files");
    const table = { "profiles/nx-a.json": JSON.stringify({ terrain: { byId: { "a:p": "backdrop" } } }) };
    const ff = fakeFetch(table);
    const files = new ProfileFiles({ fetch: ff.fetch });
    const merged = await files.loadAll(["profiles/nx-a.json", "profiles/nx-b.json"]);
    check("a present file loads and exists", files.exists("profiles/nx-a.json") && merged.terrain.byId["a:p"] === "backdrop");
    check("an absent file is an empty profile", !files.exists("profiles/nx-b.json") && same(files.get("profiles/nx-b.json"), ProfileStore.emptyProfile()));
    files.setClass("b:q", "relief", "profiles/nx-b.json");
    check("a change marks its file dirty only", same(files.dirtyUrls(), ["profiles/nx-b.json"]));
    await files.loadAll(["profiles/nx-a.json", "profiles/nx-b.json"]);
    check("a clean file is fetched again, a dirty one is not", ff.calls["profiles/nx-a.json"] === 2 && ff.calls["profiles/nx-b.json"] === 1);
    check("the unsaved change survives the reload", files.merged(["profiles/nx-b.json"]).terrain.byId["b:q"] === "relief");
    const r = await files.save("profiles/nx-b.json");
    check("save writes the file and clears dirty", r.ok && !files.isDirty("profiles/nx-b.json") && files.exists("profiles/nx-b.json") &&
      JSON.parse(table["profiles/nx-b.json"]).terrain.byId["b:q"] === "relief");
    check("export is the file's JSON", JSON.parse(files.exportJson("profiles/nx-b.json")).terrain.byId["b:q"] === "relief");
    files.resetAll("profiles/nx-b.json");
    check("reset clears every tag of the file", same(files.get("profiles/nx-b.json").terrain.byId, {}) && files.isDirty("profiles/nx-b.json"));

    const st = new ProfileFiles({ fetch: fakeFetch({ "profiles/nx-c.json": "{}" }, { postAs: "static" }).fetch });
    st.setClass("c:p", "relief", "profiles/nx-c.json");
    const r2 = await st.save("profiles/nx-c.json");
    check("a static server's echo is not a save", !r2.ok && r2.error === "no write receipt" && st.isDirty("profiles/nx-c.json"));
    const mg = new ProfileFiles({ fetch: fakeFetch({}, { mangle: () => JSON.stringify({ terrain: { byId: {} } }) }).fetch });
    mg.setClass("c:p", "relief", "profiles/nx-c.json");
    const r3 = await mg.save("profiles/nx-c.json");
    check("a read-back that differs is not a save", !r3.ok && r3.error === "read-back mismatch");
    const two = new ProfileFiles({ fetch: fakeFetch({}).fetch });
    two.setClass("a:p", "relief", "profiles/nx-a.json");
    two.setEmboss(5, "invert", "profiles/lemmings-g0.json");
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
      const files = new ProfileFiles({ fetch: (u, init) => fetch(base + "/3d/" + u, init) });
      files.setClass("my_style:rock_2", "backdrop", "profiles/nx-my_style.json");
      const saved = await files.save("profiles/nx-my_style.json");
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
