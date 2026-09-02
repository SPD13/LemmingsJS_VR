"use strict";

const $ = (id) => document.getElementById(id);

// ---- tabs ----
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) {
      t.classList.toggle("active", t === tab);
    }
    $("tab-server").hidden = tab.dataset.tab !== "server";
    $("tab-setup").hidden = tab.dataset.tab !== "setup";
  });
}

// ---- server tab ----
let current = null;

function renderStatus(s) {
  current = s;
  $("toggle").textContent = s.running ? "STOP" : "START";
  $("toggle").classList.toggle("running", s.running);
  $("status-pill").textContent = s.running ? "RUNNING · PORT " + s.port : "STOPPED";
  $("status-pill").classList.toggle("running", s.running);

  const setUrl = (id, url) => {
    const el = $(id);
    if (s.running && url) {
      el.textContent = url;
      el.classList.remove("disabled");
    } else {
      el.textContent = url ? url + " (stopped)" : "no network connection";
      el.classList.add("disabled");
    }
  };
  setUrl("internal-url", s.internalUrl);
  setUrl("external-url", s.externalUrl);
  // one line for both: a failure in red, a remark (the port was reclaimed)
  // in the muted colour
  $("error").textContent = s.error || s.notice || "";
  $("error").classList.toggle("notice", !s.error && !!s.notice);

  if (!$("port").matches(":focus")) $("port").value = s.port;
  $("https-toggle").checked = !!s.https;
}

$("toggle").addEventListener("click", async () => {
  $("toggle").disabled = true;
  renderStatus(current.running ? await window.launcher.stop() : await window.launcher.start());
  $("toggle").disabled = false;
});

for (const id of ["internal-url", "external-url"]) {
  $(id).addEventListener("click", () => {
    if (current && current.running) {
      const url = id === "internal-url" ? current.internalUrl : current.externalUrl;
      if (url) window.launcher.openUrl(url);
    }
  });
}

// ---- setup tab ----
$("save-port").addEventListener("click", async () => {
  const msg = $("setup-msg");
  const s = await window.launcher.setPort($("port").value);
  renderStatus(s);
  if (s.error) {
    msg.textContent = s.error;
    msg.className = "err";
  } else {
    msg.textContent = "saved — port " + s.port + (s.running ? " (server restarted)" : "");
    msg.className = "ok";
  }
});

$("https-toggle").addEventListener("change", async () => {
  const msg = $("setup-msg");
  const s = await window.launcher.setHttps($("https-toggle").checked);
  renderStatus(s);
  if (s.error) {
    msg.textContent = s.error;
    msg.className = "err";
  } else {
    msg.textContent = (s.https ? "HTTPS on" : "HTTPS off") + (s.running ? " (server restarted)" : "");
    msg.className = "ok";
  }
});

// ---- boot ----
window.launcher.onStatus(renderStatus);
window.launcher.getStatus().then(renderStatus);
