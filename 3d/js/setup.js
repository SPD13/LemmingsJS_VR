"use strict";
/**
 * The setup page: what the static asset mode plays from - NeoLemmix, its
 * styles package and the level packs - installed into this browser's
 * storage (see vfs.js), plus the download/upload of the player's
 * configuration files. Everything here works on the store, whatever asset
 * mode the game page is in; the mode itself is shown and switched at the top.
 *
 * neolemmix.com sends no CORS headers, so a page cannot download its zips
 * itself: the NeoLemmix buttons open the official download and the zip the
 * user picks (or drops on the row) is unpacked here, with the vendored
 * fflate. The classic games come straight from the LemmingsJS repository
 * through jsDelivr, which does send them.
 */
(function () {
  const ROOT = "";
  const BATCH = 200; // files per write, while unpacking

  const OFFICIAL = {
    site: "https://www.neolemmix.com/?page=neolemmix",
    engine: { url: "https://www.neolemmix.com/download.php?program=16", name: "NeoLemmix V12.14.0", size: "7 MB" },
    styles: { url: "https://www.neolemmix.com/download.php?program=52", name: "the styles package", size: "92 MB" },
    packs: { url: "https://www.neolemmix.com/download.php?program=47", name: "Lemmings Plus (every pack)", size: "22 MB" },
  };
  const GITHUB = {
    repo: "oklemenz/LemmingsJS",
    dirs: ["lemmings", "lemmings_ohNo"],
    list: "https://data.jsdelivr.com/v1/packages/gh/oklemenz/LemmingsJS@master?structure=flat",
    apiList: (dir) => "https://api.github.com/repos/oklemenz/LemmingsJS/contents/" + dir + "?ref=master",
    file: (p) => "https://cdn.jsdelivr.net/gh/oklemenz/LemmingsJS@master/" + p.split("/").map(encodeURIComponent).join("/"),
    parallel: 4,
  };

  // the player's files: what each one holds (config-store.js builds and
  // reads them; in server mode the server keeps them)
  const PREFS_FORMAT = ConfigStore.FILES.prefs.format;
  const PROGRESS_FORMAT = ConfigStore.FILES.progress.format;
  const CLEARED_KEY = ConfigStore.CLEARED_KEY;
  const TALISMANS_KEY = ConfigStore.TALISMANS_KEY;
  const SCAN_CACHE_KEY = "lem3d-worlds-v4"; // library.js: the classic packs' scan, rebuilt on demand

  const $ = (id) => document.getElementById(id);
  const fmtMB = (n) => n == null ? "?" : n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB";
  const fmtDate = (t) => t ? new Date(t).toLocaleString() : "";
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---- the modal confirm (index.html's, as a promise) ----
  function askConfirm(title, verb, body) {
    return new Promise((resolve) => {
      const box = $("confirm");
      $("confirm-title").textContent = title;
      $("confirm-body").textContent = body || "";
      $("confirm-yes").textContent = verb;
      const close = (ok) => {
        box.hidden = true;
        $("confirm-yes").onclick = $("confirm-no").onclick = box.onclick = null;
        document.removeEventListener("keydown", onKey);
        resolve(ok);
      };
      const onKey = (e) => { if (e.key === "Escape") close(false); };
      $("confirm-yes").onclick = () => close(true);
      $("confirm-no").onclick = () => close(false);
      box.onclick = (e) => { if (e.target === box) close(false); };
      document.addEventListener("keydown", onKey);
      box.hidden = false;
      $("confirm-yes").focus();
    });
  }

  // ---- status lines and the progress bar ----
  function say(id, text, bad) {
    const el = $(id);
    el.textContent = text || "";
    el.className = "msg" + (text ? (bad ? " err" : " ok") : "");
  }
  let busy = false;
  function progress(label, frac) {
    const bar = $("progress");
    if (label === null) { bar.hidden = true; busy = false; setButtons(); return; }
    bar.hidden = false;
    busy = true;
    setButtons();
    $("progress-label").textContent = label;
    const w = frac == null ? 0 : Math.max(0, Math.min(1, frac)) * 100;
    $("progress-fill").style.width = w + "%";
    $("progress-fill").classList.toggle("indeterminate", frac == null);
  }
  function setButtons() {
    for (const b of document.querySelectorAll("button[data-busy]")) b.disabled = busy;
  }

  // ---- the zip: its names first (the central directory), then the entries ----

  /** Every file name of a zip, from its central directory (no unpacking). */
  async function zipNames(file) {
    const tailSize = Math.min(file.size, 70000);
    let tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file (no central directory)");
    const dv = new DataView(tail.buffer, tail.byteOffset + eocd);
    const count = dv.getUint16(10, true);
    const cdSize = dv.getUint32(12, true);
    const cdOffset = dv.getUint32(16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
    const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const names = [];
    const decoder = new TextDecoder("utf-8");
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      const v = new DataView(cd.buffer, cd.byteOffset + p);
      if (v.getUint32(0, true) !== 0x02014b50) break;
      const nameLen = v.getUint16(28, true), extraLen = v.getUint16(30, true), commentLen = v.getUint16(32, true);
      const size = v.getUint32(24, true);
      const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
      names.push({ name: normName(name), size });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names.filter((e) => e.name && !e.name.endsWith("/"));
  }

  /** A zip entry's name as a repo path: forward slashes, no leading ./ or /. */
  const normName = (name) => name.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");

  /**
   * Unpack a zip into the store: `map(name)` says where an entry goes (null
   * drops it) and with which unit: {path, unit}. Streams the file through
   * fflate and writes every BATCH entries, so the package never sits in
   * memory whole. Returns {files, bytes}.
   */
  async function unpackZip(file, map, label, put = browserLevels.put) {
    const unzipper = new fflate.Unzip();
    unzipper.register(fflate.UnzipInflate);
    let ready = [];
    let failed = null;
    let files = 0, bytes = 0;
    unzipper.onfile = (f) => {
      const name = normName(f.name);
      if (!name || name.endsWith("/")) return;
      const where = map(name);
      if (!where) return;
      const chunks = [];
      f.ondata = (err, chunk, final) => {
        if (err) { failed = failed || err; return; }
        if (chunk && chunk.length) chunks.push(chunk);
        if (final) {
          const blob = new Blob(chunks, { type: Vfs.mimeOf(where.path) });
          ready.push({ path: where.path, unit: where.unit, blob });
          files++;
          bytes += blob.size;
        }
      };
      f.start();
    };
    const flush = async () => {
      if (!ready.length) return;
      const batch = ready;
      ready = [];
      await put(batch);
    };
    const reader = file.stream().getReader();
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      unzipper.push(value, false);
      read += value.length;
      if (failed) throw failed;
      progress(label + " — " + fmtMB(read) + " of " + fmtMB(file.size) + ", " + files + " files", read / file.size);
      if (ready.length >= BATCH) await flush();
    }
    unzipper.push(new Uint8Array(0), true);
    if (failed) throw failed;
    await flush();
    return { files, bytes };
  }

  // ---- what a zip is, and where its entries go ----

  const KINDS = {
    engine: {
      label: "NeoLemmix",
      detect: (names) => names.some((n) => /^neolemmix\.exe$/i.test(n)) || names.some((n) => n.startsWith("gfx/panel/")),
      // a level directory in the zip is its own unit, deletable like any other
      map: (n) => {
        const top = n.split("/")[0];
        if (["gfx", "sound", "music", "data", "styles"].includes(top)) return { path: "neolemmix/" + n, unit: "engine" };
        if (top === "levels" && n.split("/").length > 2) return { path: n, unit: "levels/" + n.split("/")[1] };
        return null;
      },
    },
    styles: {
      label: "the styles package",
      detect: (names) => names.some((n) => n === "styles/styles.ini") ||
        (!names.some((n) => n.startsWith("gfx/")) && names.filter((n) => n.startsWith("styles/")).length > names.length / 2),
      map: (n) => {
        const top = n.split("/")[0];
        if (top === "styles" || top === "sound") return { path: "neolemmix/" + n, unit: "styles" };
        return null;
      },
    },
    levels: {
      label: "a level pack",
      detect: (names) => names.some((n) => /\.nxlv$/i.test(n) || /\.DAT$/i.test(n) || /(^|\/)levels\.nxmi$/i.test(n)),
    },
  };

  /** The kind a zip's names say it is, or null. */
  function detectKind(names) {
    const list = names.map((e) => e.name);
    if (KINDS.engine.detect(list)) return "engine";
    if (KINDS.styles.detect(list)) return "styles";
    if (KINDS.levels.detect(list)) return "levels";
    return null;
  }

  /**
   * Where a level zip's entries go: under the one folder they all share, or
   * under a folder named after the zip. A collection wrapping packs in
   * levels/ (and music/) keeps that layout - the index collapses it.
   */
  function levelZipMap(names, fileName) {
    const list = names.map((e) => e.name);
    const tops = new Set(list.map((n) => n.split("/")[0]));
    const nested = list.every((n) => n.includes("/"));
    let dir;
    if (tops.size === 1 && nested && !["levels", "music"].includes(Array.from(tops)[0])) {
      dir = Array.from(tops)[0];
      return { dirs: [dir], map: (n) => n.startsWith(dir + "/") ? { path: "levels/" + n, unit: "levels/" + dir } : null };
    }
    dir = fileName.replace(/\.zip$/i, "").replace(/[^\w.\- ]+/g, "_") || "levels";
    return { dirs: [dir], map: (n) => ({ path: "levels/" + dir + "/" + n, unit: "levels/" + dir }) };
  }

  // ---- where the levels go: this browser's store, or the server's levels/ folder ----

  /** The browser's store (static mode): what the service worker serves. */
  const browserLevels = {
    where: "browser",
    writable: true,
    async dirs() {
      const units = await unitsById();
      return (await Vfs.levelDirs()).map((dir) => {
        const u = units["levels/" + dir];
        return { dir, files: u ? u.files : null, bytes: u ? u.bytes : null, source: u ? u.source : "", installedAt: u ? u.installedAt : null };
      });
    },
    async index() { try { return JSON.parse(await Vfs.readText(Vfs.INDEX_PATH)); } catch (e) { return null; } },
    persist: () => Vfs.persist(),
    put: (batch) => Vfs.putFiles(batch, null),
    async deleteDir(dir) {
      await Vfs.deleteUnit("levels/" + dir);
      await Vfs.deletePrefix("levels/" + dir + "/"); // whatever else landed there
    },
    record: (dir, source) => recordLevelDir(dir, source),
    changed: () => rebuildIndexes(),
  };

  /**
   * The server's levels/ folder (server mode): the launcher lists it,
   * takes a pack file by file and removes a directory (launcher/README.md).
   * A plain web server answers none of that: its index names the
   * directories, read-only.
   */
  const serverLevels = {
    where: "server",
    writable: false, // until dirs.json answers
    async dirs() {
      const list = await fetchJson("levels/dirs.json");
      this.writable = Array.isArray(list);
      if (list) return list.map((d) => ({ dir: d.dir, files: d.files, bytes: d.bytes, source: "", installedAt: d.mtime }));
      const index = await this.index();
      const dirs = Array.from(new Set(((index && index.children) || []).map((n) => n.path.split("/")[0])));
      return dirs.map((dir) => ({ dir, files: null, bytes: null, source: "", installedAt: null }));
    },
    index: () => fetchJson(Vfs.INDEX_PATH),
    persist: async () => {},
    async put(batch) {
      const queue = batch.slice();
      const worker = async () => {
        for (;;) {
          const e = queue.shift();
          if (!e) return;
          const res = await fetch(ROOT + e.path.split("/").map(encodeURIComponent).join("/"), { method: "PUT", body: e.blob });
          if (!res.ok) throw new Error("the server answered " + res.status + " for " + e.path);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    },
    async deleteDir(dir) {
      const res = await fetch(ROOT + "levels/" + encodeURIComponent(dir), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error("the server answered " + res.status);
    },
    record: async () => {},
    // the launcher builds levels/index.json live; only the classic scan cache is stale
    async changed() { try { localStorage.removeItem(SCAN_CACHE_KEY); } catch (e) {} },
  };

  /** The store the Levels section works on, in the mode in force. */
  const levels = () => Vfs.mode === "server" ? serverLevels : browserLevels;

  /** False, with a message, when the server in force takes no installs. */
  function levelsWritable() {
    if (levels().writable) return true;
    say("msg-levels", "this server does not take level installs (only the launcher does)", true);
    return false;
  }

  // ---- installs ----

  async function installZip(file, expected) {
    if (busy) return;
    say("msg-" + (expected === "levels" ? "levels" : "nx"), "");
    let names;
    try { names = await zipNames(file); }
    catch (e) { say(expected === "levels" ? "msg-levels" : "msg-nx", file.name + ": " + e.message, true); return; }
    const kind = detectKind(names);
    const msgId = expected === "levels" ? "msg-levels" : "msg-nx";
    if (!kind) { say(msgId, file.name + " does not look like NeoLemmix, its styles package or a level pack", true); return; }
    if (kind !== expected) {
      const ok = await askConfirm(file.name + " is " + KINDS[kind].label, "install it as that",
        "It was dropped on " + KINDS[expected].label + ".");
      if (!ok) return;
    }
    try {
      if (kind === "engine" || kind === "styles") await installUnit(kind, file, names);
      else await installLevelZip(file, names);
    } catch (e) {
      say(msgId, "install failed: " + (e && e.message ? e.message : e), true);
      console.error(e);
    } finally {
      progress(null);
    }
    await refresh();
  }

  /** NeoLemmix or the styles package: replaces the previous install of the same kind. */
  async function installUnit(kind, file, names) {
    const units = await unitsById();
    const label = KINDS[kind].label;
    if (units[kind]) {
      const ok = await askConfirm("Replace " + label + "?", "replace",
        "The " + units[kind].files + " files installed on " + fmtDate(units[kind].installedAt) + " are removed first.");
      if (!ok) return;
    }
    // the level directories NeoLemmix's zip carries replace their namesakes
    const dirs = kind === "engine" ? levelDirsIn(names.map((e) => e.name)) : [];
    if (dirs.length && !(await confirmReplaceDirs(dirs, browserLevels))) return;
    await Vfs.persist();
    progress("removing the previous " + label, null);
    if (units[kind]) await Vfs.deleteUnit(kind);
    for (const d of dirs) await Vfs.deleteUnit("levels/" + d);
    const { files, bytes } = await unpackZip(file, KINDS[kind].map, "unpacking " + file.name);
    const version = kind === "engine" ? (/(V?\d+\.\d+(\.\d+)?(-\w+)?)/i.exec(file.name) || [null, ""])[1] : "";
    await Vfs.put("units", { id: kind, name: label, version, source: file.name, installedAt: Date.now(), files, bytes });
    for (const d of dirs) await recordLevelDir(d, file.name);
    await rebuildIndexes();
    say("msg-nx", label + " installed: " + files + " files, " + fmtMB(bytes));
  }

  const levelDirsIn = (list) => Array.from(new Set(list.filter((n) => n.startsWith("levels/") && n.split("/").length > 2).map((n) => n.split("/")[1])));

  async function confirmReplaceDirs(dirs, store = levels()) {
    const have = new Set((await store.dirs()).map((d) => d.dir));
    const clash = dirs.filter((d) => have.has(d));
    if (!clash.length) return true;
    return askConfirm("Replace " + (clash.length === 1 ? "the level directory " + clash[0] : clash.length + " level directories") + "?",
      "replace", clash.join(", ") + " already installed: removed first.");
  }

  async function recordLevelDir(dir, source) {
    const files = await Vfs.list("levels/" + dir + "/");
    await Vfs.put("units", {
      id: "levels/" + dir, name: dir, version: "", source, installedAt: Date.now(),
      files: files.length, bytes: files.reduce((n, f) => n + f.size, 0),
    });
  }

  async function installLevelZip(file, names) {
    const store = levels();
    if (!levelsWritable()) return;
    const { dirs, map } = levelZipMap(names, file.name);
    if (!(await confirmReplaceDirs(dirs))) return;
    await store.persist();
    for (const d of dirs) await store.deleteDir(d);
    const { files, bytes } = await unpackZip(file, map, "unpacking " + file.name, store.put);
    for (const d of dirs) await store.record(d, file.name);
    await store.changed();
    say("msg-levels", dirs.join(", ") + " installed on the " + store.where + ": " + files + " files, " + fmtMB(bytes));
  }

  /** A folder picked with the directory input: levels/<its name>/... */
  async function installFolder(fileList) {
    if (busy || !fileList.length) return;
    const files = Array.from(fileList).filter((f) => f.webkitRelativePath && !/(^|\/)\./.test(f.webkitRelativePath));
    const dirs = Array.from(new Set(files.map((f) => f.webkitRelativePath.split("/")[0])));
    if (!dirs.length) { say("msg-levels", "nothing to install in that folder", true); return; }
    const store = levels();
    if (!levelsWritable()) return;
    try {
      if (!(await confirmReplaceDirs(dirs))) return;
      await store.persist();
      for (const d of dirs) await store.deleteDir(d);
      progress("storing " + dirs.join(", "), 0);
      let done = 0, bytes = 0;
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH).map((f) => ({
          path: "levels/" + f.webkitRelativePath, unit: "levels/" + f.webkitRelativePath.split("/")[0], blob: f,
        }));
        await store.put(batch);
        done += batch.length;
        bytes += batch.reduce((n, e) => n + e.blob.size, 0);
        progress("storing " + dirs.join(", ") + " — " + done + " of " + files.length + " files", done / files.length);
      }
      for (const d of dirs) await store.record(d, "folder upload");
      await store.changed();
      say("msg-levels", dirs.join(", ") + " installed on the " + store.where + ": " + done + " files, " + fmtMB(bytes));
    } catch (e) {
      say("msg-levels", "install failed: " + (e && e.message ? e.message : e), true);
      console.error(e);
    } finally {
      progress(null);
    }
    await refresh();
  }

  /** The two classic games, file by file from the LemmingsJS repository. */
  async function installClassic() {
    if (busy) return;
    say("msg-levels", "");
    const store = levels();
    if (!levelsWritable()) return;
    try {
      if (!(await confirmReplaceDirs(GITHUB.dirs))) return;
      progress("listing " + GITHUB.repo, null);
      const paths = await classicFileList();
      if (!paths.length) throw new Error("no files listed for " + GITHUB.dirs.join(", "));
      await store.persist();
      for (const d of GITHUB.dirs) await store.deleteDir(d);
      let done = 0, bytes = 0;
      const entries = [];
      const queue = paths.slice();
      const worker = async () => {
        for (;;) {
          const p = queue.shift();
          if (!p) return;
          const res = await fetch(GITHUB.file(p));
          if (!res.ok) throw new Error(res.status + " for " + p);
          const blob = await res.blob();
          entries.push({ path: "levels/" + p, unit: "levels/" + p.split("/")[0], blob });
          done++;
          bytes += blob.size;
          progress("downloading " + GITHUB.repo + " — " + done + " of " + paths.length + " files", done / paths.length);
        }
      };
      await Promise.all(Array.from({ length: GITHUB.parallel }, worker));
      progress("storing " + GITHUB.dirs.join(", ") + " on the " + store.where, null);
      await store.put(entries);
      for (const d of GITHUB.dirs) await store.record(d, "github.com/" + GITHUB.repo);
      await store.changed();
      say("msg-levels", GITHUB.dirs.join(", ") + " installed on the " + store.where + ": " + done + " files, " + fmtMB(bytes));
    } catch (e) {
      say("msg-levels", "download failed: " + (e && e.message ? e.message : e), true);
      console.error(e);
    } finally {
      progress(null);
    }
    await refresh();
  }

  async function classicFileList() {
    const wanted = (p) => GITHUB.dirs.some((d) => p.startsWith(d + "/"));
    try {
      const res = await fetch(GITHUB.list);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const paths = (data.files || []).map((f) => f.name.replace(/^\//, "")).filter(wanted);
      if (paths.length) return paths;
    } catch (e) { /* the GitHub API lists the same */ }
    const out = [];
    for (const d of GITHUB.dirs) {
      const res = await fetch(GITHUB.apiList(d));
      if (!res.ok) throw new Error("GitHub answered " + res.status + " for " + d);
      for (const f of await res.json()) if (f.type === "file") out.push(d + "/" + f.name);
    }
    return out;
  }

  async function deleteLevelDir(dir) {
    if (busy) return;
    const store = levels();
    if (!levelsWritable()) return;
    const ok = await askConfirm("Delete " + dir + "?", "delete",
      "Its levels leave " + (store.where === "server" ? "the server's levels/ folder" : "this browser's storage") + "; your progress on them stays.");
    if (!ok) return;
    try {
      progress("deleting " + dir, null);
      await store.deleteDir(dir);
      await store.changed();
      say("msg-levels", dir + " deleted from the " + store.where);
    } catch (e) {
      say("msg-levels", "delete failed: " + e.message, true);
    } finally {
      progress(null);
    }
    await refresh();
  }

  // ---- the indexes, rebuilt from the store ----

  const INDEX_UNIT = "index";
  async function rebuildIndexes() {
    progress("indexing the levels", null);
    const wanted = (p) => /\.(nxmi|nxlv|nxtm|nxmt|ini)$/i.test(p);
    const files = await Vfs.readTexts("levels/", wanted);
    files.delete(Vfs.INDEX_PATH);
    let config = [];
    try { config = await (await fetch(ROOT + "config.json", { cache: "no-store" })).json(); } catch (e) {}
    const hasLevels = Array.from(files.keys()).some((p) => p.split("/").length > 2);
    if (hasLevels) {
      const index = LevelsIndex.buildIndex(LevelsIndex.snapshotIO(files), config);
      await Vfs.putFiles([{ path: Vfs.INDEX_PATH, blob: new Blob([JSON.stringify(index)], { type: "application/json" }) }], INDEX_UNIT);
    } else {
      await Vfs.remove("files", Vfs.INDEX_PATH);
    }
    try { localStorage.removeItem(SCAN_CACHE_KEY); } catch (e) {}

    progress("indexing the styles", null);
    const stylesPath = StylesIndex.STYLES_DIR + "/" + StylesIndex.INDEX_FILE;
    const styles = await Vfs.readTexts(StylesIndex.STYLES_DIR + "/", wanted);
    styles.delete(stylesPath);
    if (styles.size) {
      const index = StylesIndex.buildStylesIndex(LevelsIndex.snapshotIO(styles));
      await Vfs.putFiles([{ path: stylesPath, blob: new Blob([JSON.stringify(index)], { type: "application/json" }) }], INDEX_UNIT);
    } else {
      await Vfs.remove("files", stylesPath);
    }
  }

  // ---- the page's state ----

  // ---- the Play link: NeoLemmix, the styles package and a level, in the mode in force ----

  const levelCount = (index) => ((index && index.children) || []).reduce((n, c) => n + (c.count || 0), 0);
  const fetchJson = async (path) => {
    try {
      const res = await fetch(ROOT + path + "?probe=" + Date.now(), { cache: "no-store" });
      return res.ok ? await res.json() : null;
    } catch (e) { return null; }
  };
  const fetchOk = async (path) => {
    try { return (await fetch(ROOT + path + "?probe=" + Date.now(), { method: "HEAD", cache: "no-store" })).ok; }
    catch (e) { return false; }
  };

  /**
   * What the game page needs before it can play: {engine, styles, levels}
   * as booleans - from the store in static mode (`units` and the index the
   * store holds), from the server otherwise (a panel bitmap of the engine,
   * the styles index and the levels index, fetched past the worker with
   * ?probe like Vfs' own probes).
   */
  async function playState(units, index) {
    if (Vfs.mode === "static") {
      return { engine: !!units.engine, styles: !!units.styles, levels: levelCount(index) > 0 };
    }
    const [engine, styles, levels] = await Promise.all([
      fetchOk("neolemmix/gfx/panel/empty_slot.png"),
      fetchJson("neolemmix/styles/index.json").then((i) => !!(i && i.count)),
      fetchJson(Vfs.INDEX_PATH).then((i) => levelCount(i) > 0),
    ]);
    return { engine, styles, levels };
  }

  /** The Play link when everything is there, else what is missing. */
  function renderPlay(ready) {
    const missing = [];
    if (!ready.engine) missing.push("NeoLemmix");
    if (!ready.styles) missing.push("the styles package");
    if (!ready.levels) missing.push("a level pack");
    $("play").hidden = missing.length > 0;
    $("play-why").hidden = missing.length === 0;
    $("play-why").textContent = missing.length
      ? "to play, install " + missing.join(", ").replace(/, ([^,]*)$/, " and $1") +
        (Vfs.mode === "static" ? " below" : " on the server")
      : "";
  }

  async function unitsById() {
    const out = {};
    for (const u of await Vfs.getAll("units")) out[u.id] = u;
    return out;
  }

  async function refresh() {
    const units = await unitsById();
    // NeoLemmix and the styles
    for (const kind of ["engine", "styles"]) {
      const u = units[kind];
      $("dot-" + kind).className = "dot " + (u ? "on" : "off");
      $("state-" + kind).textContent = u
        ? "installed" + (u.version ? " (" + u.version + ")" : "") + ": " + u.files + " files, " + fmtMB(u.bytes) + ", " + fmtDate(u.installedAt)
        : "not installed";
      $("btn-zip-" + kind).textContent = u ? "re-install zip…" : "install zip…";
    }
    // the level directories of the store in force, named by its index when it knows them
    const store = levels();
    const dirs = await store.dirs();
    const index = await store.index();
    const nodes = new Map();
    for (const n of (index && index.children) || []) nodes.set(n.path.split("/")[0], n);
    $("levels-where").textContent = store.where === "server"
      ? (store.writable
        ? "In server mode this is the server's levels/ folder: installs land there and delete removes from it."
        : "In server mode this is the server's levels/ folder, as its index names it; this server takes no installs (only the launcher does).")
      : "In static mode this is this browser's storage: installs land here.";
    const list = $("level-list");
    list.innerHTML = "";
    if (!dirs.length) list.innerHTML = '<div class="empty">no level directory installed</div>';
    for (const d of dirs) {
      const node = nodes.get(d.dir);
      const row = document.createElement("div");
      row.className = "row" + (node ? "" : " empty");
      const engine = node ? node.engine : "";
      const about = [d.bytes != null ? fmtMB(d.bytes) : "", d.files != null ? d.files + " files" : "", d.source].filter(Boolean).join(" · ");
      row.innerHTML =
        '<span class="where ' + store.where + '">' + store.where + "</span>" +
        '<span class="lib-row-name">' + escapeHtml(node ? node.name : d.dir) + (node && node.name !== d.dir ? ' <span class="dim">' + escapeHtml(d.dir) + "</span>" : "") + "</span>" +
        (engine ? '<span class="lib-badge ' + engine + '">' + engine + "</span>" : '<span class="lib-badge none">no levels found</span>') +
        '<span class="lib-count">' + (node ? node.count + " levels" : "") + "</span>" +
        '<span class="dim">' + escapeHtml(about) + "</span>" +
        (store.writable ? '<button data-busy data-del="' + escapeHtml(d.dir) + '" title="delete this directory">delete</button>' : "");
      if (store.writable) row.querySelector("button").addEventListener("click", () => deleteLevelDir(d.dir));
      list.appendChild(row);
    }
    // storage
    const est = await Vfs.estimate();
    $("storage").textContent = "storage used by this site: " + fmtMB(est.usage) +
      (est.quota ? " of " + fmtMB(est.quota) + " available" : "") +
      (est.persisted === true ? " · persistent" : est.persisted === false ? " · not marked persistent (the browser may reclaim it)" : "");
    renderPlay(await playState(units, index));
    setButtons();
  }

  // ---- the configuration files ----

  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function pickFile(input, onText) {
    input.value = "";
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (f) onText(await f.text(), f.name);
    };
    input.click();
  }
  const parseJSON = (text, name) => {
    try { return JSON.parse(text); } catch (e) { throw new Error(name + " is not a JSON file"); }
  };

  /**
   * A download of one of the three files: the server's copy in server mode
   * (the one in force there), else - or when the server has none - the
   * file built from this browser's settings.
   */
  async function exportFile(kind, local) {
    const name = ConfigStore.FILES[kind].name;
    const text = ConfigStore.active ? await ConfigStore.serverFile(kind) : null;
    download(name, text !== null ? text : local());
  }
  // where an upload lands: the browser, and the server's file in server mode
  const landed = () => ConfigStore.active ? ", saved on the server" : "";

  // a table of its own, so an upload's validation is the hotkey dialog's;
  // its save lands in localStorage, and on the server in server mode
  let hotkeys = null;
  const controls = () => hotkeys || (hotkeys = new Hotkeys.HotkeyManager());
  function exportControls() { exportFile("controls", () => controls().exportJSON()); }
  function importControls(text, name) {
    try {
      const r = controls().importJSON(text);
      say("msg-controls", name + ": " + r.loaded + " bindings loaded" + (r.skipped ? ", " + r.skipped + " skipped" : "") + landed());
    } catch (e) { say("msg-controls", name + ": " + e.message, true); }
  }

  function exportPrefs() {
    exportFile("prefs", () => JSON.stringify(ConfigStore.build("prefs") || { format: PREFS_FORMAT, version: 1, values: {} }, null, 2));
  }
  function importPrefs(text, name) {
    try {
      const data = parseJSON(text, name);
      if (data.format !== PREFS_FORMAT || !data.values || typeof data.values !== "object") throw new Error("not a preferences file");
      let n = 0;
      for (const k of ConfigStore.PREFS_KEYS) {
        if (typeof data.values[k] === "string") { localStorage.setItem(k, data.values[k]); n++; }
      }
      say("msg-prefs", name + ": " + n + " preferences loaded" + landed() + " (in force when the game page reloads)");
    } catch (e) { say("msg-prefs", name + ": " + e.message, true); }
  }

  const readJSONKey = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (e) { return {}; } };
  function exportProgress() {
    exportFile("progress", () => JSON.stringify(ConfigStore.build("progress") || { format: PROGRESS_FORMAT, version: 1, cleared: {}, talismans: {} }, null, 2));
  }
  /** Merge: the best of both for every level, so a file never loses a clear. */
  function importProgress(text, name) {
    try {
      const data = parseJSON(text, name);
      if (data.format !== PROGRESS_FORMAT || !data.cleared || typeof data.cleared !== "object") throw new Error("not a progress file");
      const cleared = readJSONKey(CLEARED_KEY);
      let n = 0;
      for (const [id, rec] of Object.entries(data.cleared)) {
        if (!rec || typeof rec !== "object") continue;
        const mine = cleared[id] || { best: null, clears: 0 };
        const best = typeof rec.best === "number" ? rec.best : null;
        const merged = {
          best: mine.best === null ? best : best === null ? mine.best : Math.min(mine.best, best),
          clears: Math.max(mine.clears || 0, rec.clears || 0),
        };
        const saved = Math.max(mine.saved || 0, rec.saved || 0);
        if (saved) merged.saved = saved;
        cleared[id] = merged;
        n++;
      }
      localStorage.setItem(CLEARED_KEY, JSON.stringify(cleared));
      const talismans = readJSONKey(TALISMANS_KEY);
      for (const [id, list] of Object.entries(data.talismans || {})) {
        if (!Array.isArray(list)) continue;
        talismans[id] = Array.from(new Set([...(talismans[id] || []), ...list]));
      }
      localStorage.setItem(TALISMANS_KEY, JSON.stringify(talismans));
      say("msg-progress", name + ": " + n + " levels merged" + landed());
    } catch (e) { say("msg-progress", name + ": " + e.message, true); }
  }

  // ---- the credits: the README's own "Credits" section, so the two never drift ----

  async function loadCredits() {
    const box = $("credits-list");
    let text = "";
    try {
      const res = await fetch(ROOT + "README.md", { cache: "no-store" });
      if (res.ok) text = await res.text();
    } catch (e) { /* no README on this host */ }
    const m = /^## Credits\s*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m.exec(text);
    if (!m) { box.textContent = "see the README's Credits section"; return; }
    // bullets: "- text", continuation lines indented; a URL becomes a link
    const items = [];
    for (const line of m[1].split("\n")) {
      if (/^- /.test(line)) items.push(line.slice(2).trim());
      else if (items.length && line.trim()) items[items.length - 1] += " " + line.trim();
    }
    box.innerHTML = "";
    for (const item of items) {
      const div = document.createElement("div");
      div.innerHTML = escapeHtml(item).replace(/(https?:\/\/[^\s<)]+)/g, (u) =>
          '<a href="' + u + '" target="_blank" rel="noopener">' + u.replace(/^https?:\/\/(www\.)?/, "") + "</a>");
      box.appendChild(div);
    }
  }

  // ---- wiring ----

  function dropZone(el, kind) {
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop");
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) installZip(f, kind);
    });
  }

  async function main() {
    Vfs.markSetupSeen();
    const booted = await Vfs.boot(ROOT);
    // the player's files: the server's in server mode
    const syncConfig = async () => {
      hotkeys = null; // read again from what the sync leaves
      await ConfigStore.sync(Vfs.mode, ROOT);
      for (const el of document.querySelectorAll("#config .where")) {
        el.className = "where " + (ConfigStore.active ? "server" : "browser");
        el.textContent = ConfigStore.active ? "server" : "browser";
      }
      $("config-where").textContent = ConfigStore.active
        ? "In server mode they are kept on the server too, in its config/ folder, and take precedence over this browser's copy: the downloads are those files and the uploads change them."
        : Vfs.mode === "server"
          ? "This server does not keep them (only the launcher does): they stay in this browser."
          : "Your settings live in this browser too.";
    };
    await syncConfig();
    // the mode
    const renderMode = () => {
      const m = Vfs.mode;
      $("mode-name").textContent = m;
      $("mode-what").textContent = m === "static"
        ? "NeoLemmix and the levels come from this browser's storage, installed below."
        : "NeoLemmix and the levels come from the web server (the launcher, or the folders on disk).";
      $("btn-mode").textContent = "switch to " + (m === "static" ? "server" : "static");
    };
    renderMode();
    $("btn-mode").addEventListener("click", async () => {
      const next = Vfs.mode === "static" ? "server" : "static";
      Vfs.saveMode(next);
      await Vfs.setMode(next);
      await syncConfig();
      renderMode();
      say("msg-mode", "the game page now plays in " + next + " mode");
      await refresh();
    });
    $("version").textContent = "v" + (Vfs.pageVersion() || "?");
    Vfs.checkVersion(ROOT).then((v) => {
      if (!v.stale) return;
      $("version-warning").hidden = false;
      $("version-warning").textContent = "Version " + v.server + " is on the server and this page is " + v.page +
        ": hard reload the page (⇧ reload, or Ctrl+F5) to load the update.";
    });
    if (!booted.sw.controlled) {
      $("sw-warning").hidden = false;
      $("sw-warning").textContent = "The service worker that serves the static mode is not running: " + booted.sw.reason +
        ". Installs still land in this browser's storage, but the game cannot play from it here.";
    }
    $("official").href = OFFICIAL.site;
    for (const kind of ["engine", "styles"]) {
      const o = OFFICIAL[kind];
      $("btn-get-" + kind).textContent = "get " + o.name + " (" + o.size + ")";
      $("btn-get-" + kind).addEventListener("click", () => window.open(o.url, "_blank", "noopener"));
      $("btn-zip-" + kind).addEventListener("click", () => {
        const input = $("file-" + kind);
        input.value = "";
        input.onchange = () => { if (input.files[0]) installZip(input.files[0], kind); };
        input.click();
      });
      dropZone($("row-" + kind), kind);
    }
    $("btn-get-packs").textContent = "get " + OFFICIAL.packs.name + " (" + OFFICIAL.packs.size + ")";
    $("btn-get-packs").addEventListener("click", () => window.open(OFFICIAL.packs.url, "_blank", "noopener"));
    $("btn-zip-levels").addEventListener("click", () => {
      const input = $("file-levels");
      input.value = "";
      input.onchange = () => { if (input.files[0]) installZip(input.files[0], "levels"); };
      input.click();
    });
    $("btn-folder-levels").addEventListener("click", () => {
      const input = $("folder-levels");
      input.value = "";
      input.onchange = () => installFolder(input.files);
      input.click();
    });
    $("btn-classic").addEventListener("click", installClassic);
    dropZone($("levels"), "levels");

    $("btn-dl-controls").addEventListener("click", exportControls);
    $("btn-ul-controls").addEventListener("click", () => pickFile($("file-controls"), importControls));
    $("btn-dl-prefs").addEventListener("click", exportPrefs);
    $("btn-ul-prefs").addEventListener("click", () => pickFile($("file-prefs"), importPrefs));
    $("btn-dl-progress").addEventListener("click", exportProgress);
    $("btn-ul-progress").addEventListener("click", () => pickFile($("file-progress"), importProgress));

    await refresh();
    loadCredits();
  }

  main().catch((e) => {
    console.error(e);
    say("msg-mode", "the setup page failed to start: " + e.message, true);
  });

  // for checks without a file picker: install a zip fetched from a URL, and the rest
  window.__setup = {
    installZip, installClassic, installFolder, deleteLevelDir, rebuildIndexes, refresh, zipNames, detectKind,
    async installUrl(url, kind) {
      const res = await fetch(url);
      const blob = await res.blob();
      const name = url.split("/").pop();
      return installZip(new File([blob], name, { type: "application/zip" }), kind);
    },
    exportPrefs, importPrefs, exportProgress, importProgress, exportControls, importControls,
  };
})();
