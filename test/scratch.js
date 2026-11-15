/* The tests' scratch folder (2026-11-13). The same file in every GameNest room server; `npm test` runs through it.

   A server writes files as it runs: the ratings (ranked.js, RANK_DIR) in every server, the stats in chess (STATS_DIR,
   PLUS_STATS_FILE) and the card tables' own data (DATA_DIR, AGE_DIR). Left unset, those settings point into
   ~/Library/GameNest/Data, the Mac's real folder, and a test that started a server without them wrote the test's
   players and games there.

   This file runs the tests with every one of those settings pointing into a fresh folder under the system's temp
   folder, and removes the folder at the end. A setting the caller already gave is left exactly as it is.

     npm test                                        package.json's "test:suites", as `npm test` always ran it
     node test/scratch.js node test/run.js rules.js  any one command, in the same scratch folder */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const pkg = require(path.join(ROOT, "package.json"));
const args = process.argv.slice(2);
const chain = pkg.scripts && pkg.scripts["test:suites"];
if (!args.length && !chain) { console.error('scratch.js: package.json has no "test:suites" to run'); process.exit(2); }

/* Every setting a server of ours reads for a folder or a file it writes, and where it goes in the scratch folder. */
const SETTINGS = { RANK_DIR: "ratings", STATS_DIR: "stats", PLUS_STATS_FILE: "plus_stats.json", DATA_DIR: "data", AGE_DIR: "data" };

const env = { ...process.env };
const given = (k) => typeof process.env[k] === "string" && process.env[k] !== "";
let dir = null;
const set = [];
for (const [k, sub] of Object.entries(SETTINGS)) {
  if (given(k)) continue;
  if (k === "AGE_DIR" && given("DATA_DIR")) continue;   // unset, the age locks follow DATA_DIR: the caller's folder
  if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), "gn-test-" + String(pkg.name || "server").replace(/[^A-Za-z0-9-]/g, "") + "-"));
  env[k] = path.join(dir, sub);
  set.push(k);
}
if (dir) console.log(`scratch.js: ${set.join(", ")} -> ${dir} (removed at the end)`);

let removed = false;
function cleanup() {
  if (!dir || removed) return;
  removed = true;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* the system clears its temp folder */ }
}

const child = args.length
  ? spawn(args[0] === "node" ? process.execPath : args[0], args.slice(1), { cwd: ROOT, env, stdio: "inherit" })
  : spawn("/bin/sh", ["-c", chain], { cwd: ROOT, env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { try { child.kill(sig); } catch (_) {} });
process.on("exit", cleanup);
child.on("error", (e) => { console.error("scratch.js: " + e.message); process.exit(2); });
child.on("exit", (code) => process.exit(code == null ? 1 : code));
