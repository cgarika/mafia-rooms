/* Nightfall: the bots' talk and thought (NF5), 2026-11-01.  node test/botlife.js   (its own server on TEST_PORT5, default 3591)
   Proves: a bot names only seats that are still at the table (a seat that left or is dead is named only where the line is about its
   death or its being voted out); a line that names a person is said to them as "you" (and reads the name to everyone else); a bot's
   vote follows what it said in the day's chat; the whole of each day's vote, and what each bot made of it, is kept from day to day;
   each bot has a timeline of its own, 2 or 3 lines with 2-9 s between them; and the bots' thinking is logged ("bot_think"). */
"use strict";
const assert = require("assert");
process.env.TEST_QUIET = "1";   // no event lines in the unit half
const S = require("../server.js");
const BT = require("../bot_talk");
const H = require("./helpers");

let passed = 0;
const ok = (name) => { passed++; console.log("  ok " + name); };

/* day 3 at a table of eight: Ava and Cleo are people; Finn died in the night; Hal left the game; Ben and Gus are Shadows */
function table() {
  const P = (name, role, extra = {}) => ({ id: name, name, role, alive: true, left: false, bot: true, chatN: 1, accuseN: 0, ...extra });
  const players = [P("Ava", "villager", { bot: false }), P("Ben", "mafia"), P("Cleo", "villager", { bot: false }), P("Dan", "detective"), P("Eli", "villager", { chatN: 0 }),
    P("Finn", "villager", { alive: false }), P("Gus", "mafia"), P("Hal", "villager", { left: true, alive: false })];
  players.forEach((p, i) => { p.persona = BT.PERSONA_NAMES[i % BT.PERSONA_NAMES.length]; });
  return {
    code: "BL", status: "playing", phase: "day", day: 3, players, host: "Ava", deaths: [5, 7], votes: {}, nightActs: {}, lastTally: {}, roles: {}, voice: new Set(),
    lastNight: { day: 3, died: 5, attacked: true, saved: false },
    lastVotes: { day: 2, votes: { 0: 4, 1: 2, 2: 1, 3: 1, 4: 6, 6: 2 }, tally: { 1: 2, 2: 2, 4: 1, 6: 1 }, out: 7 },
    voteHistory: [{ day: 1, votes: { 0: 2, 1: 4, 2: 4, 3: 4, 4: 2 }, tally: { 2: 2, 4: 3 }, out: 4 }, { day: 2, votes: { 0: 4, 1: 2, 2: 1, 3: 1, 4: 6, 6: 2 }, tally: { 1: 2, 2: 2, 4: 1, 6: 1 }, out: 7 }],
    probeLog: { 3: [{ t: 1, mafia: true }, { t: 2, mafia: false }] },
    chat: [{ n: "Ava", t: "I think Gus is lying", ch: "day", s: 0 }, { n: "Cleo", t: "Gus has been weird", ch: "day", s: 2 }, { n: "Hal", t: "I'm out of here", ch: "day", s: 7 }],
  };
}
const fresh = (room) => { room.usedLines = new Set(); return room; };

console.log("nightfall bots: what they say");
{
  const room = table(), alive = (s) => room.players[s].alive && !room.players[s].left, seatOf = (n) => room.players.findIndex((p) => p.name === n);
  let n = 0, withY = 0;
  for (const bot of [1, 3, 4, 6]) for (let k = 0; k < 400; k++) {
    const d = BT.draft(fresh(room), room.players[bot]);
    assert.ok(d && d.text, "no line for " + room.players[bot].name); n++;
    for (const s of d.seats) {
      if (d.intent === "died") assert.strictEqual(s, 5, "died names the one who died: " + d.text);
      else if (d.intent === "votedOut") assert.ok(s === 7 || alive(s), "votedOut names the voter, or the one voted out: " + d.text);
      else assert.ok(alive(s), `${room.players[bot].name} named ${room.players[s].name} (gone) in "${d.text}" [${d.intent}]`);
    }
    assert.ok(!/\bHal\b/.test(d.text) || d.intent === "votedOut", "a seat that left was named: " + d.text);
    for (const [seat, you] of Object.entries(d.y)) {
      withY++;
      const name = room.players[seat].name;
      assert.ok([0, 2].includes(Number(seat)), "a 'you' for a bot or a gone seat: " + seat);
      assert.ok((d.intent === "ask" || /\b(you|You|your)/.test(you)) && !new RegExp("\\b" + name + "\\b").test(you), `${name} should read "you", got: ${you}`);   // an answer to a person ("Fair point. Anyone else see it?") says it by not naming them
      assert.ok(new RegExp("\\b" + name + "\\b").test(d.text), "the others should read " + name + ": " + d.text);
      assert.ok(!/\{[TVH]\}/.test(you), "an unfilled slot: " + you);
    }
  }
  assert.ok(withY > 80, "only " + withY + " of " + n + " lines were ever said to a person as 'you'");
  ok(`${n} drafts across four bots: only seats still at the table named (Finn only in the night's loss, Hal never); ${withY} lines named a person and each has a 'you' form that does not name them`);
}
{   // the state: the person a line names reads "you"; everyone else reads the name; nobody sees the other forms
  const room = table();
  room.chat = [{ n: "Ben", a: "x", t: "Ava has barely said a word. I want to hear from Ava.", ch: "day", s: 1, y: { 0: "You've barely said a word. I want to hear from you." } },
    { n: "Dan", a: "x", t: "Nobody died last night. Someone was protected, nice.", ch: "day", s: 3 }];
  const forAva = S.stateFor(room, 0).chat, forCleo = S.stateFor(room, 2).chat, watcher = S.stateFor(room, -1).chat;
  assert.strictEqual(forAva[0].t, "You've barely said a word. I want to hear from you."); assert.strictEqual(forCleo[0].t, "Ava has barely said a word. I want to hear from Ava."); assert.strictEqual(watcher[0].t, forCleo[0].t);
  assert.strictEqual(forAva[1].t, forCleo[1].t);
  assert.ok(!/"y"/.test(JSON.stringify([forAva, forCleo, watcher])), "the other forms leaked into the state");
  assert.deepStrictEqual(Object.keys(forAva[0]).sort(), ["a", "ch", "n", "s", "t"]);
  ok("Ava's screen says \"You've barely said a word...\" where Cleo's and a watcher's say Ava's name; the other forms never leave the server");
}
{   // what it says in the chat is what it votes
  let hit = 0, N = 300;
  for (let k = 0; k < N; k++) {
    const room = table(); room.phase = "vote";
    const dan = room.players[3];   // the detective, who already voted its find? no: remove the probe so it follows what it said
    room.probeLog = {};
    BT.remember(room, dan, { intent: "accuse", target: 4 });
    S.botDecide(room, dan);
    if (room.votes[3] === 4) hit++;
  }
  assert.ok(hit / N >= 0.88, "voted what it said only " + hit + "/" + N);
  let off = 0;
  for (let k = 0; k < 200; k++) { const room = table(); room.phase = "vote"; room.probeLog = {}; const eli = room.players[4]; BT.remember(room, eli, { intent: "clear", target: 2 }); S.botDecide(room, eli); if (room.votes[4] === 2) off++; }
  assert.ok(off < 60, "voted for the one it vouched for " + off + "/200 (a crowd may carry it, but rarely)");
  ok(`a bot that accused Eli votes Eli ${hit}/${N} times, and the one it vouched for is not voted by choice`);
}
{   // every day's vote is kept, and each bot's mind about everyone with it
  const P = (name, role, bot = true) => ({ id: name, name, role, alive: true, left: false, bot, chatN: 1, accuseN: 0, persona: "chatty" });
  const room = { code: "H", status: "playing", phase: "vote", day: 1, votes: {}, deaths: [], nightActs: {}, probeLog: {}, chat: [], lastTally: {}, voteHistory: [],
    players: [P("A", "villager", false), P("B", "mafia"), P("C", "villager"), P("D", "villager"), P("E", "villager"), P("F", "villager"), P("G", "doctor")] };
  const sus = (p) => BT.suspicion(room, p, { noise: false });
  // day 1: B, C, E and G vote for D, who is out (4 of 7) and was innocent
  room.votes = { 0: -1, 1: 3, 2: 3, 3: -1, 4: 3, 5: 1, 6: 3 }; S.resolveVote(room);
  assert.strictEqual(room.voteHistory.length, 1); assert.ok(room.players[3].alive === false, "D should be out (4 of 7)");
  room.day = 2; room.phase = "vote"; room.votes = { 0: -1, 1: -1, 2: -1, 4: -1, 5: -1, 6: -1 }; S.resolveVote(room);
  room.day = 3; room.phase = "vote"; room.votes = { 0: -1, 1: -1, 2: -1, 4: -1, 5: -1, 6: -1 }; S.resolveVote(room);
  assert.strictEqual(room.voteHistory.length, 3, "every day's vote is kept"); assert.strictEqual(room.voteHistory[0].out, 3);
  const g = room.players[6]; room.day = 4;
  const s4 = sus(g);
  assert.ok(s4[2] > s4[5] + 0.5, `on day 4 the one who pushed out an innocent on day 1 (C: ${s4[2].toFixed(2)}) should still look worse than one who did not (F: ${s4[5].toFixed(2)})`);
  assert.ok(g.mem && g.mem[2] > 0.3, "the bot kept no memory of C: " + JSON.stringify(g.mem));
  ok(`three days of votes kept in voteHistory; on day 4 a bot still holds day 1 against the voters who pushed out an innocent (C ${s4[2].toFixed(2)} vs F ${s4[5].toFixed(2)}), and remembers it (mem)`);
}
{   // each bot has a timeline: 2 or 3 lines, the first 1.5-9 s in, 2-9 s between its lines, nobody over anybody
  const room = table(); room.phase = "day"; room.players[5].alive = true; room.players[7].alive = true; room.players[7].left = false; room.players[7].bot = true; room.players[5].bot = true;
  let lines = 0, bots = 0, gaps = [], apart = 0, close = 0;
  for (let rep = 0; rep < 40; rep++) {
    const now = Date.now(); room.phaseStartedAt = now; room.phaseEndsAt = now + 40000;
    S.planChatter(room);
    const items = room.chatPlan.items, by = {};
    items.forEach((i) => (by[i.seat] = by[i.seat] || []).push(i.at - now));
    for (let k = 1; k < items.length; k++) { const g = items[k].at - items[k - 1].at; apart++; if (g < 800) close++; assert.ok(g >= 150, "two lines " + g + " ms apart"); }
    for (const [seat, ts] of Object.entries(by)) {
      assert.ok(ts.length >= 2 && ts.length <= 3, `seat ${seat} has ${ts.length} lines`); bots++; lines += ts.length;
      assert.ok(ts[0] >= 1499 && ts[0] <= 9001, "first line at " + ts[0]);
      for (let k = 1; k < ts.length; k++) { const g = ts[k] - ts[k - 1]; gaps.push(g); assert.ok(g >= 1999 && g <= 9001, "a gap of " + g); }
      assert.ok(ts[ts.length - 1] <= 34000 + 800, "a line after the 85% mark: " + ts[ts.length - 1]);
    }
    for (const s of [0, 2]) assert.ok(!by[s], "a person got a bot's lines");
  }
  gaps.sort((a, b) => a - b);
  assert.ok(close / apart < 0.3, `${close} of ${apart} neighbouring lines were under 0.8 s apart`);
  ok(`40 days of plans (six bots): ${bots} bots, ${lines} lines (2-3 each), first line 1.5-9 s in, gaps of the same bot ${Math.round(gaps[0] / 100) / 10}-${Math.round(gaps[gaps.length - 1] / 100) / 10} s (median ${Math.round(gaps[gaps.length >> 1] / 100) / 10} s), ${Math.round(100 * close / apart)}% of neighbouring lines under 0.8 s apart, none under 0.15 s`);
}

(async () => {
  const port = H.portOf("TEST_PORT5", 3591);
  console.log("nightfall bots: thinking, in a real game (port " + port + ")");
  // BOT_MS 120 is a tenth of the real tick, so every think is a tenth too: a night 150-400 ms, a vote 200-550 ms
  const srv = await H.server(port, { BOT_MS: "120", REVEAL_MS: "300", NIGHT_MS: "3000", DAY_MS: "3000", VOTE_MS: "3000", AFK_MS: "2000", NIGHT_BOT_MS: "3000", DAY_BOT_MS: "3000", VOTE_BOT_MS: "3000", REVEAL_BOT_MS: "300" });
  try {
    const [A, B] = await H.lobby(port, 2, "L");
    for (let i = 0; i < 4; i++) { const k = A.st.players.length; A.emit("addBot"); await H.wait(() => A.st.players.length > k, 1500); }
    A.emit("start"); assert.ok(await H.wait(() => A.st.status === "playing", 3000));
    const sent = new Set();
    const t = setInterval(() => { for (const c of [A, B]) { const st = c.st; if (!st || st.status !== "playing") continue; const k = (w) => { const key = c.nm + st.day + st.phase + w; if (sent.has(key)) return false; sent.add(key); return true; };
      const alive = st.players.map((p, s) => (p.alive ? s : -1)).filter((s) => s >= 0);
      if (st.phase === "reveal" && k("r")) c.emit("ready", {}); else if (st.phase === "day" && k("d")) { c.emit("chat", { t: "I have a feeling about " + st.players[alive.find((s) => s !== c.seat)].name }); }
      else if (st.phase === "night" && k("n")) { const o = alive.find((s) => s !== c.seat); if (st.yourRole === "mafia") c.emit("act", { kill: alive.find((s) => st.yourRole === "mafia" && !(st.mafiaSeats || []).includes(s)) }); else if (st.yourRole === "doctor") c.emit("act", { save: o }); else if (st.yourRole === "detective") c.emit("act", { probe: o }); }
      else if (st.phase === "vote" && k("v")) c.emit("vote", { target: alive.find((s) => s !== c.seat && !(st.mafiaSeats || []).includes(s)) ?? -1 }); } }, 20);
    try { assert.ok(await H.wait(() => A.st.status === "over", 60000), "the game never ended (day " + A.st.day + " " + A.st.phase + ")"); } finally { clearInterval(t); }
    const ev = srv.events("bot_think");
    const kinds = {}; ev.forEach((e) => (kinds[e.kind] = kinds[e.kind] || []).push(e.ms));
    assert.ok(ev.length > 0, "no bot_think in the log");
    assert.ok(kinds.vote && kinds.vote.length >= 3 && kinds.chat && kinds.chat.length >= 3, "kinds seen: " + JSON.stringify(Object.keys(kinds)));
    for (const ms of kinds.vote) assert.ok(ms >= 190 && ms <= 1200, "a vote think of " + ms + " ms");
    for (const ms of kinds.night || []) assert.ok(ms >= 140 && ms <= 1200, "a night think of " + ms + " ms");
    const phases = srv.events("phase_end"); assert.ok(phases.length >= 4, "phase_end events: " + phases.length);
    const q = (a, p) => { a = a.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
    ok(`the log has ${ev.length} bot_think lines (${Object.entries(kinds).map(([k, v]) => `${k} n=${v.length} p50=${q(v, 0.5)} max=${Math.max(...v)} ms`).join("; ")}) and ${phases.length} phase_end lines`);
    [A, B].forEach((c) => c.close());
  } finally { srv.stop(); }
  console.log(`nightfall bots: ${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
