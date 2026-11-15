/* Nightfall: the one outcome (NF1), the side sizes (NF2) and why a phase ended (NF4), 2026-11-01.  node test/outcome.js   (its own servers on TEST_PORT4, default 3581)
   Proves: once a game is over every seat reads ONE outcome from the server: the sides win together (a villager voted out still shares the
   village's win; a Shadow still alive shares its defeat; the Jester wins alone), a loser's title is "Defeat" with the winner named and no
   confetti, a watcher is told so; the state names the sides' sizes from the real deal; and each phase says why it ended ("Everyone voted",
   "Everyone is ready", "Everyone has acted", "Time's up"...) once everyone who had to act did, or the clock ran out. */
"use strict";
const assert = require("assert");
process.env.TEST_QUIET = "1";   // no event lines in the unit half
const S = require("../server.js");
const H = require("./helpers");

let passed = 0;
const ok = (name) => { passed++; console.log("  ok " + name); };

function roomOf(roles, alive, winner, winReason, extra = {}) {
  const players = roles.map((role, i) => ({ id: "p" + i, name: "P" + i, avatar: "x", bot: false, botControlled: false, left: false, connected: true, alive: alive[i], role }));
  const count = {}; roles.forEach((r) => { count[r] = (count[r] || 0) + 1; });
  return { code: "OUT", host: "p0", players, status: "over", phase: "over", day: 3, phaseEndsAt: null, log: "The village has spoken.", winner, winReason, deaths: [], nightActs: {}, votes: {}, probeLog: {}, voice: new Set(), chat: [], roles: {}, voteRule: "majority", deck: { n: roles.length, count, settings: {} }, ...extra };
}

console.log("outcome: who won, read by every seat");
{
  const roles = ["mafia", "mafia", "doctor", "detective", "villager", "villager", "mayor", "jester"];
  // the village wins: both Shadows are out; the doctor and one villager died on the way, the Jester is alive
  const v = roomOf(roles, [false, false, false, true, true, false, true, true], "village", "lastShadow");
  for (let seat = -1; seat < roles.length; seat++) {
    const o = S.stateFor(v, seat).outcome;
    assert.ok(o, "no outcome for seat " + seat); assert.strictEqual(o.winner, "village");
    const winning = seat >= 0 && !["mafia", "jester"].includes(roles[seat]);
    assert.strictEqual(o.you, seat < 0 ? "watch" : winning ? "win" : "lose", `seat ${seat} (${roles[seat]}): ${o.you}`);
    assert.strictEqual(o.confetti, winning, "confetti for a " + o.you);
    assert.strictEqual(o.title, winning ? "Victory" : seat < 0 ? "Game over" : "Defeat");
    assert.strictEqual(o.subtitle, "Village wins");
    assert.deepStrictEqual(o.winners, [2, 3, 4, 5, 6]); assert.deepStrictEqual(o.losers, [0, 1, 7]);
    assert.ok(/last Shadow is gone/.test(o.reason), o.reason);
  }
  ok("the village wins: a villager who was voted out (seat 5) and the dead Doctor (2) share the win; a dead Shadow (0) and the live Jester (7) share the defeat; a watcher is told so; confetti only for a win");
  const m = roomOf(roles, [true, false, false, true, false, true, true, true], "mafia", "shadowsMatch");
  for (let seat = -1; seat < roles.length; seat++) {
    const o = S.stateFor(m, seat).outcome, winning = seat >= 0 && roles[seat] === "mafia";
    assert.strictEqual(o.you, seat < 0 ? "watch" : winning ? "win" : "lose"); assert.strictEqual(o.confetti, winning);
    assert.strictEqual(o.subtitle, "Shadows win"); assert.deepStrictEqual(o.winners, [0, 1]);
    if (!winning && seat >= 0) { assert.strictEqual(o.title, "Defeat"); assert.strictEqual(o.faction, seat === 7 ? "jester" : "village"); }
  }
  ok("the Shadows win: both Shadows (the dead one too) win, everyone else loses with 'Defeat' and 'Shadows win', no confetti");
  const j = roomOf(roles, [true, true, true, true, true, true, true, false], "jester", "jester");
  for (let seat = 0; seat < roles.length; seat++) { const o = S.stateFor(j, seat).outcome; assert.strictEqual(o.you, seat === 7 ? "win" : "lose"); assert.strictEqual(o.confetti, seat === 7); assert.strictEqual(o.subtitle, "The Jester wins"); assert.deepStrictEqual(o.winners, [7]); }
  ok("the Jester wins alone: seat 7 wins, all seven others lose");
  // a seat that left is in neither list; a losing Shadow sees nothing of a win
  const left = roomOf(roles, [false, false, true, true, true, true, true, true], "village", "lastShadow"); left.players[6].left = true;
  const o6 = S.stateFor(left, 0).outcome; assert.ok(!o6.winners.includes(6) && !o6.losers.includes(6));
  const loser = S.stateFor(v, 0).outcome; assert.strictEqual(loser.you, "lose"); assert.strictEqual(loser.title, "Defeat"); assert.strictEqual(loser.confetti, false);
  assert.strictEqual(`${loser.title} — ${loser.subtitle}`, "Defeat — Village wins");
  ok("a losing Shadow reads 'Defeat — Village wins': no trophy word, no confetti; a seat that left is on neither list");
  // not over: no outcome; the sides' sizes are the real deal's
  const playing = roomOf(roles, roles.map(() => true), null, null, { status: "playing", phase: "day" });
  assert.strictEqual(S.stateFor(playing, 0).outcome, undefined);
  assert.deepStrictEqual(S.stateFor(playing, 0).teams, { village: 5, shadows: 2, jester: 1 });
  const lobbyRoom = roomOf(roles, roles.map(() => true), null, null, { status: "lobby", phase: "lobby", deck: undefined });
  assert.strictEqual(S.stateFor(lobbyRoom, 0).teams, null);
  ok("no outcome while the game is on; teams { village: 5, shadows: 2, jester: 1 } come from the real deal (null in the lobby)");
}

(async () => {
  const port = H.portOf("TEST_PORT4", 3581);
  console.log("outcome: whole games, and why each phase ended (port " + port + ")");
  // 1. five people, quick clocks that nobody has to wait out: every phase ends because everyone did their part
  {
    const srv = await H.server(port, { REVEAL_MS: "5000", NIGHT_MS: "5000", DAY_MS: "5000", VOTE_MS: "5000", BOT_MS: "5", AFK_MS: "4000" });
    try {
      const cs = await H.lobby(port, 5, "O");
      cs[0].emit("start");
      assert.ok(await H.wait(() => cs.every((c) => c.st && c.st.yourRole), 3000), "roles were not dealt");
      const mafiaSeat = cs.find((c) => c.st.yourRole === "mafia").seat;
      const sent = new Set(), ends = [];
      cs[0].on("state", ({ room }) => { if (room.lastEnd && (!ends.length || ends[ends.length - 1].at !== room.lastEnd.at)) ends.push(room.lastEnd); });
      const t = setInterval(() => {
        for (const c of cs) {
          const st = c.st; if (!st || st.status !== "playing" || !st.players[c.seat].alive) continue;
          const key = (what) => { const k = c.nm + "|" + st.day + "|" + st.phase + "|" + what; if (sent.has(k)) return false; sent.add(k); return true; };
          const alive = st.players.map((p, s) => (p.alive ? s : -1)).filter((s) => s >= 0);
          if (st.phase === "reveal" && key("r")) c.emit("ready", {});
          else if (st.phase === "night" && key("n")) {
            if (st.yourRole === "mafia") c.emit("act", { kill: alive.find((s) => s !== mafiaSeat) });
            else if (st.yourRole === "doctor") c.emit("act", { save: alive.find((s) => s !== c.seat) });
            else if (st.yourRole === "detective") c.emit("act", { probe: mafiaSeat });
          } else if (st.phase === "day" && key("d")) c.emit("ready", {});
          else if (st.phase === "vote" && key("v")) c.emit("vote", { target: c.seat === mafiaSeat ? -1 : mafiaSeat });
        }
      }, 15);
      try { assert.ok(await H.wait(() => cs[0].st.status === "over", 15000), "the game never ended (phase " + cs[0].st.phase + ")"); } finally { clearInterval(t); }
      await H.sleep(100);
      const outs = cs.map((c) => c.st.outcome);
      assert.ok(outs.every((o) => o && o.winner === "village" && o.line === cs[0].st.outcome.line && o.reason === outs[0].reason), "the seats read different outcomes");
      cs.forEach((c) => { const o = c.st.outcome, mine = c.st.yourRole === "mafia" ? "lose" : "win"; assert.strictEqual(o.you, mine, c.nm + " " + c.st.yourRole); assert.strictEqual(o.confetti, mine === "win"); assert.strictEqual(c.st.winner, "village"); });
      assert.deepStrictEqual(cs[0].st.teams, { village: 4, shadows: 1, jester: 0 });
      const texts = ends.map((e) => `${e.phase}:${e.why}:${e.text}`);
      for (const want of ["reveal:ready:Everyone has seen their card", "night:all:Everyone has acted", "day:ready:Everyone is ready", "vote:all:Everyone voted"]) assert.ok(texts.includes(want), `no "${want}" in ${JSON.stringify(texts)}`);
      ok("five people play a game to the village's win: the same outcome on all five screens (the Shadow 'Defeat', the four 'Victory'), teams 4 / 1 / 0");
      ok("and every phase ended when everyone had done their part, and said why: " + texts.join(" -> "));
      cs.forEach((c) => c.close());
    } finally { srv.stop(); }
  }
  // 2. nobody acts: every phase ends on its clock and says so
  {
    const srv = await H.server(port, { REVEAL_MS: "250", NIGHT_MS: "300", DAY_MS: "200", VOTE_MS: "300", BOT_MS: "5", AFK_MS: "4000" });
    try {
      const cs = await H.lobby(port, 5, "T");
      const ends = []; cs[0].on("state", ({ room }) => { if (room.lastEnd && (!ends.length || ends[ends.length - 1].at !== room.lastEnd.at)) ends.push(room.lastEnd); });
      cs[0].emit("start");
      assert.ok(await H.wait(() => ends.some((e) => e.phase === "vote"), 8000), "no vote ended: " + JSON.stringify(ends.map((e) => e.phase)));
      const texts = ends.map((e) => `${e.phase}:${e.why}:${e.text}`);
      for (const want of ["reveal:time:Roles are set", "night:time:The night is over", "day:time:Time to vote", "vote:time:Time's up"]) assert.ok(texts.includes(want), `no "${want}" in ${JSON.stringify(texts)}`);
      ok("with nobody acting each phase ends on its clock and says so: " + texts.slice(0, 4).join(" -> "));
      cs.forEach((c) => c.close());
    } finally { srv.stop(); }
  }
  console.log(`outcome: ${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
