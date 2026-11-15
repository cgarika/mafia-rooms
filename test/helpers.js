/* Shared bits for the 2026-11-01 suites (outcome, botlife, quick): a private server on a port the caller names, with its log kept, and
   clients that keep their last state. Never starts on 3111-3124 (the live servers). */
"use strict";
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, ms = 5000, step = 8) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return !!fn(); }
function portOf(envName, dflt) {
  const p = Number(process.env[envName] || dflt);
  if (p >= 3111 && p <= 3124) { console.error(`refusing ${p}: 3111-3124 are the live servers`); process.exit(2); }
  return p;
}
/* a server of our own: the clocks this test wants (env), the rest as the code has them; srv.out is everything it logged */
async function server(port, env = {}) {
  const full = { ...process.env, PORT: String(port), RANK_DIR: path.join(os.tmpdir(), "gn_rank_" + port), LLM_URL: "", ...env };
  delete full.TEST_QUIET;   // a unit half silences its own event lines; a server of our own logs them (srv.events)
  const srv = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: full, stdio: ["ignore", "pipe", "pipe"] });
  srv.out = "";
  srv.stdout.on("data", (d) => { srv.out += d; });
  srv.stderr.on("data", (d) => { srv.out += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) { try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status) break; } catch (e) { /* not up yet */ } await sleep(60); }
  srv.stop = () => { try { srv.kill("SIGTERM"); } catch (e) { /* gone */ } };
  srv.events = (ev) => srv.out.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((o) => o && (!ev || o.ev === ev));
  return srv;
}
function client(port, name, extra = {}) {
  const c = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false, forceNew: true });
  Object.assign(c, { nm: name, st: null, seat: -1, logs: [], errs: [], states: [], pid: extra.playerId || "p_" + name + "_" + Math.random().toString(16).slice(2, 8), caps: extra.caps });
  c.on("state", ({ room, mySeat }) => { c.st = room; c.seat = mySeat; c.states.push({ t: Date.now(), room }); if (room && room.log) c.logs.push(room.log); });
  c.on("err", (m) => c.errs.push(m));
  c.on("joined", (j) => { c.code = j.code; });
  return c;
}
/* n humans in one lobby (the first is the host) */
async function lobby(port, n, prefix = "H", caps) {
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(client(port, prefix + i, { caps }));
  await wait(() => cs.every((c) => c.connected), 4000);
  cs[0].emit("create", { name: cs[0].nm, playerId: cs[0].pid, avatar: "\u{1F642}", caps });
  await wait(() => cs[0].code, 3000);
  for (let i = 1; i < n; i++) cs[i].emit("join", { code: cs[0].code, name: cs[i].nm, playerId: cs[i].pid, avatar: "\u{1F642}", caps });
  await wait(() => cs[0].st && cs[0].st.players.length === n, 3000);
  return cs;
}
module.exports = { sleep, wait, portOf, server, client, lobby };
