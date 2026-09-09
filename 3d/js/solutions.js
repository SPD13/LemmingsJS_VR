"use strict";
/**
 * The solutions page (solutions.html): every level of every pack as a row,
 * a check when a solution exists, and what the solution is worth - lemmings
 * saved, skills used, the clock at the end, the tier that found it. The
 * head says how many levels have one. A fuzzy search (library.js's) and a
 * pack filter narrow the rows; "Play solution" opens the level in a new tab
 * with ?solution=1, the solution replaying from the start.
 *
 * In server mode (the launcher answered) a row's "solve" button, or "solve
 * selected" over the checked rows, sends the levels to the launcher's solver
 * queue (POST /solve, launcher/server.js), which runs tools/nx-solve.js on
 * them one after the other; the page polls the queue and refreshes the
 * solutions index as each level finishes, marking a new solution green.
 */
Vfs.boot("").then(async () => {
  const ROOT = "";
  const $ = (id) => document.getElementById(id);
  const dom = {
    summary: $("summary"), search: $("search"), pack: $("pack"), show: $("show"), selectAll: $("select-all"), note: $("note"),
    server: $("server"), tier: $("tier"), budget: $("budget"), solveSelected: $("solve-selected"), cancel: $("cancel-queue"),
    queue: $("queue"), rows: $("rows"), empty: $("empty"), table: $("table"),
  };
  $("back").href = Vfs.link("index.html");
  const serverMode = Vfs.mode === "server" && !!Vfs.health;
  dom.server.hidden = !serverMode;

  await LevelTree.load(ROOT);
  await Solutions.load(ROOT);

  // the lemmix levels, flat, with where they live
  const levels = [];
  let order = 0;
  for (const [id, rec] of LevelTree.byId) {
    if (rec.node.engine !== "lemmix") continue;
    const where = [];
    for (let n = rec.node; n && n.parent; n = n.parent) where.unshift(n.name);
    levels.push({ id, level: rec.level, node: rec.node, folder: where[0] || "", pack: rec.pack ? rec.pack.name : where[0] || "", where, ordinal: rec.node.levels.indexOf(rec.level) + 1, order: order++ });
  }
  // the pack filter: the level folders (a downloaded collection, a pack on its own) and the packs inside each
  const folders = new Map();
  for (const l of levels) { if (!folders.has(l.folder)) folders.set(l.folder, new Set()); folders.get(l.folder).add(l.pack); }
  const packs = Array.from(new Set(levels.map((l) => l.pack)));
  for (const [folder, subs] of folders) {
    const o = document.createElement("option"); o.value = "folder:" + folder; o.textContent = folder; dom.pack.appendChild(o);
    if (subs.size > 1 || !subs.has(folder)) for (const p of subs) { const so = document.createElement("option"); so.value = "pack:" + p; so.textContent = "\u00a0\u00a0\u00a0" + p; dom.pack.appendChild(so); }
  }
  const selected = new Set();
  const fresh = new Set();       // solved since the page opened
  const jobState = new Map();    // level id -> "queued" | "running" | "solved" | "unsolved" | "error" | "cancelled"
  let sortKey = "level", sortDir = 1;

  const mmss = (frames) => { const s = Math.floor(frames / 17); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const rowData = (l) => {
    const rec = Solutions.info(l.id);
    return {
      solved: !!rec, saved: rec ? rec.saved : -1, skills: rec ? rec.skillsUsed : Infinity, time: rec ? rec.completionFrame : Infinity,
      tier: rec ? rec.tier : 0, state: jobState.get(l.id) || "", rec,
    };
  };

  function summary() {
    const total = levels.length, solved = levels.filter((l) => Solutions.has(l.id)).length;
    const pct = total ? Math.round(1000 * solved / total) / 10 : 0;
    dom.summary.innerHTML = "<b>" + solved + "</b> of <b>" + total + "</b> levels have a solution <span class='pct'>(" + pct + "%)</span>"
      + "<span class='sub'>" + folders.size + " level folders, " + packs.length + " packs · " + (serverMode ? "server mode: the launcher can solve levels" : "static mode: solutions are those shipped") + "</span>";
  }

  /** The rows to show, filtered and sorted. */
  function visible() {
    const q = dom.search.value.trim(), pack = dom.pack.value, show = dom.show.value;
    let out = [];
    for (const l of levels) {
      if (pack.startsWith("folder:") && l.folder !== pack.slice(7)) continue;
      if (pack.startsWith("pack:") && l.pack !== pack.slice(5)) continue;
      const d = rowData(l);
      if (show === "solved" && !d.solved) continue;
      if (show === "unsolved" && d.solved) continue;
      let score = 0;
      if (q) {
        score = fuzzyScore(q, l.where.join(" ") + " " + l.level.title + " " + l.id.replace(/[_/]/g, " "));
        if (score < 0) continue;
      }
      out.push({ l, d, score });
    }
    const cmp = (a, b) => {
      if (dom.search.value.trim() && sortKey === "level") return b.score - a.score;
      const k = sortKey;
      let x = k === "level" ? a.l.order : k === "solved" ? (a.d.solved ? 1 : 0) : k === "state" ? a.d.state : a.d[k];
      let y = k === "level" ? b.l.order : k === "solved" ? (b.d.solved ? 1 : 0) : k === "state" ? b.d.state : b.d[k];
      if (x === y) return a.l.order - b.l.order;
      return (x < y ? -1 : 1) * sortDir;
    };
    out.sort(cmp);
    return out;
  }

  function render() {
    summary();
    const rows = visible();
    dom.rows.textContent = "";
    dom.empty.hidden = rows.length > 0;
    for (const { l, d } of rows) {
      const tr = document.createElement("tr");
      tr.dataset.id = l.id;
      tr.className = (d.solved ? "solved " : "") + (fresh.has(l.id) ? "fresh " : "") + (d.state === "queued" ? "queued" : d.state === "running" ? "running" : d.state === "error" || d.state === "unsolved" ? "failed" : "");
      const td = (cls, html) => { const c = document.createElement("td"); if (cls) c.className = cls; c.innerHTML = html; tr.appendChild(c); return c; };
      // the checkbox
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = selected.has(l.id);
      cb.addEventListener("change", () => { if (cb.checked) selected.add(l.id); else selected.delete(l.id); syncButtons(); });
      const c0 = document.createElement("td"); c0.appendChild(cb); tr.appendChild(c0);
      const title = l.level.title && l.level.title !== l.where[l.where.length - 1] ? "<span class='title'>" + escape(l.level.title) + "</span>" : "";
      td("level", "<span class='where'>" + escape(l.where.join(" › ")) + " </span><span class='name'>" + l.ordinal + "</span>" + title).title = l.id;
      td("mark", d.solved ? "✔" : "");
      const rec = d.rec;
      td("num" + (rec ? "" : " dim"), rec ? rec.saved + " / " + rec.count + " <span class='dim'>(" + rec.needed + ")</span>" : (l.level.lemmings || "") + " <span class='dim'>(" + (l.level.save || "") + ")</span>");
      td("num" + (rec ? "" : " dim"), rec ? String(rec.skillsUsed) : "");
      td("num" + (rec ? "" : " dim"), rec ? mmss(rec.completionFrame) : "");
      td("num" + (rec ? "" : " dim"), rec ? rec.tier + " <span class='dim'>· " + Math.round(rec.elapsedMs / 1000) + " s</span>" : "");
      td("state", d.state === "running" ? "solving…" : d.state || "");
      const act = td("actions", "");
      if (d.solved) {
        const play = document.createElement("button"); play.textContent = "▶ play solution"; play.className = "primary";
        play.title = "the level in a new tab, its solution replaying from the start";
        play.addEventListener("click", () => window.open(Vfs.link("index.html?level=" + encodeURIComponent(l.id) + "&solution=1"), "_blank"));
        act.appendChild(play);
      }
      if (serverMode && (d.state === "queued" || d.state === "running")) {
        // in the queue: no second press - "Queued" with its place, or the search's progress bar, and a cancel
        const job = document.createElement("span"); job.className = "job";
        if (d.state === "queued") {
          const q = document.createElement("span"); q.className = "queued";
          const at = lastStatus ? lastStatus.pending.findIndex((j) => j.id === l.id) + 1 : 0;
          q.textContent = "queued" + (at > 0 ? " #" + at : "");
          job.appendChild(q);
        } else {
          const bar = document.createElement("div"); bar.className = "bar";
          bar.innerHTML = "<div class='fill'></div><div class='txt'>solving…</div>";
          job.appendChild(bar);
        }
        const cancel = document.createElement("button"); cancel.textContent = "cancel"; cancel.className = "cancel";
        cancel.title = d.state === "queued" ? "take this level out of the queue" : "stop the search on this level";
        cancel.addEventListener("click", () => cancelLevel(l.id));
        job.appendChild(cancel);
        act.appendChild(job);
      } else if (serverMode) {
        const solve = document.createElement("button"); solve.textContent = d.solved ? "solve again" : "solve";
        solve.title = "run the solver on this level at the chosen tier (a better solution replaces the old one)";
        solve.addEventListener("click", () => { solve.disabled = true; enqueue([l.id]); });
        act.appendChild(solve);
      }
      dom.rows.appendChild(tr);
    }
    syncButtons();
    dom.note.textContent = rows.length + " shown" + (selected.size ? ", " + selected.size + " selected" : "");
  }
  const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function syncButtons() {
    dom.solveSelected.disabled = !selected.size;
    dom.solveSelected.textContent = selected.size ? "solve selected (" + selected.size + ")" : "solve selected";
    const shown = Array.from(dom.rows.querySelectorAll("tr")).map((tr) => tr.dataset.id);
    dom.selectAll.checked = shown.length > 0 && shown.every((id) => selected.has(id));
    dom.note.textContent = shown.length + " shown" + (selected.size ? ", " + selected.size + " selected" : "");
  }

  // ---- the filters
  let searchTimer = null;
  dom.search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); });
  dom.search.addEventListener("keydown", (e) => { if (e.key === "Escape") { dom.search.value = ""; render(); } });
  dom.pack.addEventListener("change", render);
  dom.show.addEventListener("change", render);
  dom.selectAll.addEventListener("change", () => {
    const shown = Array.from(dom.rows.querySelectorAll("tr")).map((tr) => tr.dataset.id);
    for (const id of shown) { if (dom.selectAll.checked) selected.add(id); else selected.delete(id); }
    render();
  });
  for (const th of dom.table.querySelectorAll("th[data-sort]")) {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === "solved" || k === "saved" ? -1 : 1; }
      for (const t of dom.table.querySelectorAll("th")) t.classList.toggle("sorted", t === th);
      render();
    });
  }

  // ---- the server's queue
  let lastSerial = -1, polling = null, lastStatus = null, ticker = null;

  /** The running level's bar: how far into its budget the search is, its phase and its best so far. */
  function updateBars() {
    const st = lastStatus;
    if (!st || !st.running) return;
    const tr = Array.from(dom.rows.querySelectorAll("tr")).find((t) => t.dataset.id === st.running.id);
    if (!tr) return;
    const bar = tr.querySelector(".bar");
    if (!bar) return;
    const p = st.running.progress || {};
    const elapsed = Date.now() - st.running.startedAt;
    const budget = st.running.budgetMs || 1;
    const done = p.phase === "done" || p.phase === "verifying";
    const frac = done ? 1 : Math.min(0.97, elapsed / budget);
    const fill = bar.querySelector(".fill");
    fill.style.width = Math.round(frac * 100) + "%";
    fill.classList.toggle("done", done);
    let text = p.phase || "starting";
    if (p.best) text += " · best " + p.best.saved + "/" + (p.needed || "?") + ", " + p.best.skillsUsed + " skills";
    else if (p.expansions) text += " · " + p.expansions + " tries";
    // past the budget the search is finishing (the optimiser's last trials, the verification); a job long past it is stuck
    if (elapsed > budget * 1.5 + 5000) text += " · " + Math.round(elapsed / 1000) + " s, past its " + Math.round(budget / 1000) + " s budget";
    else text += " · " + Math.min(Math.round(elapsed / 1000), Math.round(budget / 1000)) + "/" + Math.round(budget / 1000) + " s";
    bar.querySelector(".txt").textContent = text;
    bar.title = text;
  }

  async function cancelLevel(id) {
    try {
      const res = await fetch(ROOT + "solve/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ levels: [id] }) });
      applyStatus(await res.json());
    } catch (e) {}
    jobState.delete(id);
    render();
  }
  async function enqueue(ids) {
    const body = { levels: ids, tier: parseInt(dom.tier.value, 10) };
    const budget = parseFloat(dom.budget.value);
    if (budget > 0) body.budget = budget;
    try {
      const res = await fetch(ROOT + "solve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      applyStatus(await res.json());
    } catch (e) {
      // a 404: the launcher's server was started before this page's routes existed - it re-reads its code on a stop and start
      const hint = /404/.test(e.message) ? " - the launcher's server predates the solver routes: stop and start it from the launcher window (or restart the launcher)" : "";
      dom.queue.innerHTML = "<span class='err'>the solver could not be started: " + escape(e.message) + hint + "</span>";
    }
    for (const id of ids) selected.delete(id);
    render();
    startPolling();
  }
  dom.solveSelected.addEventListener("click", () => enqueue(Array.from(selected)));
  dom.cancel.addEventListener("click", async () => {
    try {
      const res = await fetch(ROOT + "solve/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ running: true }) });
      applyStatus(await res.json());
    } catch (e) {}
    render();
  });

  /** The queue's state into the rows; a job just finished refreshes the index and marks a new solution. */
  async function applyStatus(st) {
    const finishedNow = st.serial !== lastSerial;
    lastSerial = st.serial;
    lastStatus = st;
    for (const j of st.pending) jobState.set(j.id, "queued");
    if (st.running) jobState.set(st.running.id, "running");
    for (const d of st.done) if (jobState.get(d.id) !== "running" || !st.running || st.running.id !== d.id) jobState.set(d.id, d.status);
    // whatever is neither pending nor running keeps its last verdict; a queued/running mark that vanished is done
    const live = new Set(st.pending.map((j) => j.id).concat(st.running ? [st.running.id] : []));
    for (const [id, s] of jobState) if ((s === "queued" || s === "running") && !live.has(id)) jobState.set(id, (st.done.slice().reverse().find((d) => d.id === id) || {}).status || "");
    if (finishedNow) {
      const before = new Set(levels.filter((l) => Solutions.has(l.id)).map((l) => l.id));
      Solutions.ready = null;
      await Solutions.load(ROOT);
      for (const l of levels) if (Solutions.has(l.id) && !before.has(l.id)) fresh.add(l.id);
      for (const d of st.done) if (d.status === "solved") fresh.add(d.id);
    }
    const parts = [];
    if (st.running) parts.push("<span class='running'>solving <b>" + escape(st.running.id.split("/").slice(-1)[0]) + "</b> (tier " + st.running.tier + ", " + Math.round((Date.now() - st.running.startedAt) / 1000) + " s)</span>");
    if (st.pending.length) parts.push("<b>" + st.pending.length + "</b> queued");
    const done = st.done.slice(-1)[0];
    if (done && !st.running && !st.pending.length) parts.push("last: " + escape(done.id.split("/").slice(-1)[0]) + " " + (done.status === "error" ? "<span class='err'>" + escape(done.line) + "</span>" : escape(done.line)));
    dom.queue.innerHTML = parts.join(" · ");
    dom.cancel.hidden = !st.running && !st.pending.length;
    return !!(st.running || st.pending.length);
  }

  async function poll() {
    try {
      const res = await fetch(ROOT + "solve/status.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const st = await res.json();
      const changed = st.serial !== lastSerial;
      const busy = await applyStatus(st);
      if (changed) render();
      updateBars();
      if (!busy) { clearInterval(polling); polling = null; clearInterval(ticker); ticker = null; }
    } catch (e) { clearInterval(polling); polling = null; clearInterval(ticker); ticker = null; }
  }
  function startPolling() {
    if (!polling) polling = setInterval(poll, 1500);
    if (!ticker) ticker = setInterval(updateBars, 1000);
  }

  render();
  if (serverMode) { await poll(); render(); if (lastStatus && (lastStatus.running || lastStatus.pending.length)) startPolling(); }
}).catch((e) => { document.getElementById("summary").textContent = "failed to load: " + e.message; console.error(e); });
