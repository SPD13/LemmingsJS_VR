"use strict";
/** A worker of nx-solve's pool: the engine loaded once, then one level per message, answered with { record, nxrp }. */
const { parentPort, workerData } = require("worker_threads");
const { Lemmix, nodeIO } = require("../lemmix-node");
require("./index");
const { solveLevel } = require("../nx-solve");

let env = null;
parentPort.on("message", async (msg) => {
  try {
    if (!env) {
      const io = nodeIO(workerData.repoRoot);
      env = { repoRoot: workerData.repoRoot, styles: new Lemmix.StyleManager(io), masks: await Lemmix.loadMasks(io) };
    }
    const result = await solveLevel(msg.entry, env, { tier: msg.tier, budgetMs: msg.budgetMs, trace: false, log: () => {} });
    parentPort.postMessage(result);
  } catch (e) {
    parentPort.postMessage({ record: { status: "error", error: String(e && e.stack || e).split("\n").slice(0, 2).join(" | "), tier: msg.tier, file: "" }, nxrp: null });
  }
});
