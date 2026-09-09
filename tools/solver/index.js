"use strict";
/** The solver's modules into globalThis.Lemmix.Solver, in dependency order (the engine must be loaded first). */
for (const name of ["world", "events", "analysis", "regions", "heuristics", "candidates", "optimise", "verify", "solver"]) require("./" + name);
module.exports = globalThis.Lemmix.Solver;
