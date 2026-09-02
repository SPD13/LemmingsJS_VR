"use strict";
/**
 * Taking the port back from a previous run of this same launcher.
 *
 * Quitting is not always tidy - a crash, a killed terminal, an Electron that
 * never got its will-quit - and what is left behind is a node process still
 * holding the port, so the next start fails with EADDRINUSE and the only way
 * out is a terminal. Since that stray process is ours, the launcher can clear
 * it itself.
 *
 * The one rule: **only ever kill our own program.** Something else on the
 * port - another dev server, a colleague's app, anything at all - is reported
 * and left strictly alone. A process counts as ours only if its executable or
 * arguments name this launcher's own directory, or it is a node/Electron
 * process running out of it. That is what separates "a previous launcher"
 * from "whatever happens to be on 8123".
 *
 * POSIX only: it reads the port's owner with lsof. Where there is no lsof
 * (Windows) nothing is found, nothing is killed, and the caller falls back to
 * reporting the port as busy.
 */

const { execFileSync } = require("child_process");
const path = require("path");

const TERM_WAIT_MS = 2000;   // how long a polite SIGTERM gets to work
const KILL_WAIT_MS = 1000;   // and SIGKILL after it
const POLL_MS = 50;

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
    });
  } catch (e) {
    return ""; // no lsof, no match, or it exited non-zero: nothing to report
  }
}

/** PIDs listening on `port`, ours excluded. */
function listeningPids(port) {
  const out = run("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"]);
  return out.split("\n")
    .map((line) => parseInt(line.trim(), 10))
    .filter((pid) => pid > 0 && pid !== process.pid);
}

/** What a process is: its command line and its working directory. */
function describe(pid) {
  const command = run("ps", ["-o", "command=", "-p", String(pid)]).trim();
  // lsof -Fn prints one field per line; the cwd's path is the "n" line
  const cwdOut = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const cwdLine = cwdOut.split("\n").find((l) => l.startsWith("n"));
  return { pid, command, cwd: cwdLine ? cwdLine.slice(1) : "" };
}

// The only files that are this program. A process is ours if it is running
// one of them, and not otherwise.
const ENTRY_POINTS = new Set([
  ".", "./", "main.js", "./main.js", "server.js", "./server.js",
]);

/**
 * Is this process another run of this launcher?
 *
 * `dir` is the launcher's own folder, and the test is what the process is
 * *running*, never where it was started from. Two ways it can name us:
 *
 * - the path is in the command line — `node <dir>/server.js`, or the Electron
 *   binary, which lives under `<dir>/node_modules/electron/dist/...`
 * - it is a node or electron process whose working directory is `<dir>` and
 *   which was given one of our own entry points by relative name: `electron
 *   .`, `node main.js`
 *
 * "A node process started from this folder" is deliberately *not* enough. Any
 * unrelated script run from here would match that, and killing someone's
 * unrelated server because it shares a working directory is precisely the
 * mistake this file exists to avoid.
 */
function isOurs(info, dir) {
  if (!info.command) return false;
  const args = info.command.split(/\s+/);
  const exe = path.basename(args[0] || "");
  if (!/^(node|electron)/i.test(exe)) return false;
  if (args.some((a) => a.includes(dir + path.sep))) return true;
  return info.cwd === dir && args.slice(1).some((a) => ENTRY_POINTS.has(a));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Wait for the port to come free, up to `ms`. */
async function waitForFree(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (listeningPids(port).length === 0) return true;
    await sleep(POLL_MS);
  }
  return listeningPids(port).length === 0;
}

/**
 * Clear `port` of previous runs of this launcher.
 *
 * Returns `{killed, skipped, free}`: which of our own processes were stopped,
 * which processes were left alone because they are not ours (with enough of
 * their command line to name them), and whether the port ended up free.
 */
async function reclaimPort(port, dir) {
  const killed = [];
  const skipped = [];
  for (const pid of listeningPids(port)) {
    const info = describe(pid);
    if (!isOurs(info, dir)) {
      skipped.push({ pid, name: (info.command.split(/\s+/)[0] || "?").split("/").pop() });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch (e) { /* already gone, or not ours to signal */ }
  }
  if (killed.length === 0) {
    return { killed, skipped, free: listeningPids(port).length === 0 };
  }
  if (!(await waitForFree(port, TERM_WAIT_MS))) {
    // it did not go quietly; it is still our own process, so insist
    for (const pid of killed) {
      try { process.kill(pid, "SIGKILL"); } catch (e) { /* gone */ }
    }
    await waitForFree(port, KILL_WAIT_MS);
  }
  return { killed, skipped, free: listeningPids(port).length === 0 };
}

module.exports = { reclaimPort, listeningPids, describe, isOurs };
