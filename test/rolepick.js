/* Nightfall: the role pick (2026-11-13).  node test/rolepick.js   (part 2 runs its own server on TEST_PORT8, default 3621)
   Part 1, scripted tables on the server's own functions: the count of picks an app says (0..99, nothing for an app without the cap), what can be
   asked for and every refusal, the seat counts a lobby shows, the asks a changed lobby drops, the deal (each role's seats first to its askers, by
   lot when they are more; a drawn ask costs one pick, any other costs nothing), 2,000-deal simulations of the lot and of what everyone else is
   dealt, and that nothing of it is in what another seat is sent.
   Part 2, over the wire: the same from the lobby to the deal with real apps (one of them an older app), the host's switch, a reconnect, quick play,
   the waiting line and a rematch, and that an ask is heard by nobody but its asker. */
"use strict";
const assert = require("assert");
const { io } = require("socket.io-client");
process.env.TEST_QUIET = "1";   // no event lines in the scripted half
const S = require("../server.js");
const Pick = require("../rolepick.js");
const H = require("./helpers");

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const CAPS = ["ready", "hunch", "waitList", "rolepick"];
const OLD = ["ready", "hunch", "waitList"];   // an app from before the role pick

/* a scripted lobby of n seats: `caps` says which seats' apps know the role pick (all by default), every one of them owning 3 picks */
function mock(n, o = {}) {
  const players = Array.from({ length: n }, (_, i) => ({
    id: "p" + i, name: "P" + i, avatar: "x", bot: !!(o.bots && o.bots.includes(i)), botControlled: false, left: false, connected: true, alive: true, role: null,
    plus: !!o.plus, pk: o.bots && o.bots.includes(i) ? undefined : Pick.seat(o.old && o.old.includes(i) ? OLD : CAPS, 3),
  }));
  return { code: "PICKED", host: "p0", players, status: "lobby", phase: "lobby", day: 0, phaseEndsAt: null, log: "", winner: null, deaths: [], nightActs: {}, votes: {},
    probeLog: {}, voice: new Set(), chat: [], roles: o.roles || {}, voteRule: "majority" };
}
const on = (room) => room.rolePicks !== false;
const askAs = (room, seat, role) => Pick.ask(room.players[seat].pk, role, on(room), S.roleSeatsNow(room));
const deal = (room) => { S.dealRoles(room); room.status = "playing"; room.phase = "reveal"; return room.players.map((p) => p.role); };
const tally = (rs) => rs.reduce((a, r) => (a[r] = (a[r] || 0) + 1, a), {});
/* what the seat's client is sent: the old state and, after it, the role pick's fields */
const sent = (room, seat) => Object.assign(S.stateFor(room, seat), S.pickView(room, seat));
/* a rate seen over n trials against the rate expected: within 5.5 standard deviations (one false alarm in about twenty-six million checks) */
function near(seen, p, n, what) {
  const sd = Math.sqrt(Math.max(p * (1 - p), 1e-9) / n);
  assert.ok(Math.abs(seen - p) <= 5.5 * sd + 1e-9, `${what}: ${seen.toFixed(4)} where ${p.toFixed(4)} was expected (5.5 sd = ${(5.5 * sd).toFixed(4)})`);
}

/* ---------- part 1: scripted tables ---------- */
test("the picks an app says: 0..99, a whole number or nothing; an app without the cap owns none", () => {
  assert.deepStrictEqual(Pick.me(Pick.seat(CAPS, 4)), { stock: 4, ask: null });
  for (const [said, kept] of [[150, 99], [99, 99], [-3, 0], [2.5, 0], ["7", 0], [null, 0], [undefined, 0], [NaN, 0], [{ n: 3 }, 0], [0, 0], [1, 1]]) {
    assert.strictEqual(Pick.seat(CAPS, said).stock, kept, JSON.stringify(said) + " should be kept as " + kept);
  }
  const old = Pick.seat(OLD, 9);
  assert.strictEqual(old.knows, false); assert.strictEqual(old.stock, 0, "an older app owns nothing here");
  assert.strictEqual(Pick.take(old, 9), false);
  assert.strictEqual(Pick.seat(undefined, 9).stock, 0); assert.strictEqual(Pick.seat("rolepick", 9).stock, 0, "caps must be a list");
});

test("what can be asked for: every special role the room deals, never the villager, and each refusal in plain words", () => {
  const room = mock(6, { roles: { jester: true } });
  assert.deepStrictEqual(S.roleSeatsNow(room), { mafia: 1, detective: 1, doctor: 1, jester: 1 });
  for (const role of ["mafia", "detective", "doctor", "jester"]) {
    assert.strictEqual(askAs(room, 1, role), null, role); assert.strictEqual(room.players[1].pk.ask, role);
  }
  assert.strictEqual(askAs(room, 1, "villager"), "No such role to pick.");
  for (const bad of ["Mafia", "shadow", "", 3, {}, [], true]) assert.strictEqual(askAs(room, 1, bad), "No such role to pick.", JSON.stringify(bad));
  assert.strictEqual(askAs(room, 1, "mayor"), "The Mayor is not in this game.");
  assert.strictEqual(askAs(room, 1, "bodyguard"), "The Bodyguard is not in this game.");
  assert.strictEqual(room.players[1].pk.ask, "jester", "a refused ask leaves the standing one alone");
  // none owned
  room.players[2].pk = Pick.seat(CAPS, 0);
  assert.strictEqual(askAs(room, 2, "doctor"), "You have no role picks."); assert.strictEqual(room.players[2].pk.ask, null);
  // an older app
  room.players[3].pk = Pick.seat(OLD, 5);
  assert.strictEqual(askAs(room, 3, "doctor"), "Update GameNest to pick a role.");
  // taking it back: null, or nothing at all
  assert.strictEqual(askAs(room, 1, null), null); assert.strictEqual(room.players[1].pk.ask, null);
  askAs(room, 1, "mafia"); assert.strictEqual(askAs(room, 1, undefined), null); assert.strictEqual(room.players[1].pk.ask, null);
  // the host's switch
  room.rolePicks = false;
  assert.strictEqual(askAs(room, 1, "mafia"), "The host turned role picks off."); assert.strictEqual(room.players[1].pk.ask, null);
  assert.strictEqual(askAs(room, 1, "villager"), "The host turned role picks off.", "off comes before everything else");
  assert.strictEqual(askAs(room, 1, null), null, "taking back is never refused");
});

test("the seat counts a lobby shows are the deck it would deal: every size, every switch, a short lobby counted as five", () => {
  for (let n = 1; n <= 12; n++) for (const jester of [false, true]) for (const mayor of [false, true]) for (const bodyguard of [false, true]) for (const plus of [false, true]) {
    const room = mock(n, { roles: { jester, mayor, bodyguard }, plus });
    const seats = S.roleSeatsNow(room), m = Math.max(5, n);
    const { count } = S.buildDeck(m, S.finalSettings(room));
    const want = {}; for (const r of Pick.ROLES) if (count[r]) want[r] = count[r];
    assert.deepStrictEqual(seats, want, `n=${n} ${JSON.stringify({ jester, mayor, bodyguard, plus })}`);
    assert.strictEqual(seats.villager, undefined); assert.strictEqual(seats.mafia, S.mafiaCountFor(m));
    assert.strictEqual(!!seats.bodyguard, bodyguard && plus && !(m === 5 && jester && mayor), "the Bodyguard only in a Plus room with a card to spare");
    if (n >= 5) {   // and the deal gives exactly those
      const got = tally(deal(room)); delete got.villager;
      assert.deepStrictEqual(Object.fromEntries(Pick.ROLES.filter((r) => got[r]).map((r) => [r, got[r]])), want);
      assert.deepStrictEqual(S.roleSeatsNow(room), want, "once dealt, what was dealt");
    }
  }
});

test("a lobby that changed drops the asks it no longer takes: nothing spent, a line for the asker alone", () => {
  // the room shrinks from six to five: with the Jester and the Mayor in, the Bodyguard has no card left
  const room = mock(6, { roles: { jester: true, mayor: true, bodyguard: true }, plus: true });
  assert.strictEqual(askAs(room, 2, "bodyguard"), null); assert.strictEqual(askAs(room, 3, "mayor"), null); assert.strictEqual(askAs(room, 4, "mafia"), null);
  room.players.pop();
  assert.strictEqual(Pick.prune(room.players, S.roleSeatsNow(room), on(room)), 1);
  assert.deepStrictEqual(Pick.me(room.players[2].pk), { stock: 3, ask: null, dropped: { role: "bodyguard", message: "The Bodyguard is not in this game any more." } });
  assert.deepStrictEqual(Pick.me(room.players[3].pk), { stock: 3, ask: "mayor" }); assert.deepStrictEqual(Pick.me(room.players[4].pk), { stock: 3, ask: "mafia" });
  // the host switches the Mayor off
  room.roles.mayor = false;
  assert.strictEqual(Pick.prune(room.players, S.roleSeatsNow(room), on(room)), 1);
  assert.deepStrictEqual(Pick.me(room.players[3].pk), { stock: 3, ask: null, dropped: { role: "mayor", message: "The Mayor is not in this game any more." } });
  // a new ask clears the note
  assert.strictEqual(askAs(room, 3, "doctor"), null); assert.deepStrictEqual(Pick.me(room.players[3].pk), { stock: 3, ask: "doctor" });
  // the picks are gone (the app said so)
  Pick.take(room.players[3].pk, 0);
  assert.strictEqual(Pick.prune(room.players, S.roleSeatsNow(room), on(room)), 1);
  assert.deepStrictEqual(Pick.me(room.players[3].pk), { stock: 0, ask: null, dropped: { role: "doctor", message: "You have no role picks left." } });
  // the host turns role picks off: every ask that stands
  room.rolePicks = false;
  assert.strictEqual(Pick.prune(room.players, S.roleSeatsNow(room), on(room)), 1);
  assert.deepStrictEqual(Pick.me(room.players[4].pk), { stock: 3, ask: null, dropped: { role: "mafia", message: "The host turned role picks off." } });
  assert.strictEqual(Pick.prune(room.players, S.roleSeatsNow(room), on(room)), 0, "nothing is dropped twice");
  // an app that no longer says the cap: its ask goes, and it is told nothing
  const r2 = mock(6); askAs(r2, 1, "mafia"); r2.players[1].pk.knows = false;
  assert.strictEqual(Pick.prune(r2.players, S.roleSeatsNow(r2), true), 0); assert.strictEqual(r2.players[1].pk.ask, null); assert.strictEqual(r2.players[1].pk.dropped, null);
});

test("the deal: a lone asker gets the role every time and pays one pick; the deck is still the deck", () => {
  for (const role of Pick.ROLES) for (let i = 0; i < 70; i++) {
    const n = 6 + (i % 7), room = mock(n, { roles: { jester: true, mayor: true, bodyguard: true }, plus: true }), seat = i % n;
    assert.strictEqual(askAs(room, seat, role), null);
    const want = S.buildDeck(n, S.finalSettings(room)).count;
    const rs = deal(room);
    assert.strictEqual(rs[seat], role, `${role} asked at seat ${seat} of ${n}`);
    assert.deepStrictEqual(tally(rs), want);
    const me = Pick.me(room.players[seat].pk);
    assert.ok(/^[0-9a-f]{8}$/.test(me.game), "a game id");
    assert.deepStrictEqual(me, { stock: 2, ask: null, game: me.game, role, spent: true });
    room.players.forEach((p, s) => { if (s !== seat) assert.deepStrictEqual(Pick.me(p.pk), { stock: 3, ask: null }); });
  }
});

test("more askers than seats: the lot draws exactly as many as the role has seats, and the rest pay nothing", () => {
  for (let i = 0; i < 200; i++) {
    const room = mock(9);   // nine seats: two Shadows
    for (const s of [1, 3, 4, 7]) assert.strictEqual(askAs(room, s, "mafia"), null);
    askAs(room, 2, "detective"); askAs(room, 8, "detective");
    const rs = deal(room);
    assert.strictEqual([1, 3, 4, 7].filter((s) => rs[s] === "mafia").length, 2, "both Shadows are askers");
    assert.strictEqual([2, 8].filter((s) => rs[s] === "detective").length, 1);
    assert.deepStrictEqual(tally(rs), S.buildDeck(9, {}).count, "no card more, no card less");
    for (const [s, role] of [[1, "mafia"], [3, "mafia"], [4, "mafia"], [7, "mafia"], [2, "detective"], [8, "detective"]]) {
      const me = Pick.me(room.players[s].pk), got = rs[s] === role;
      assert.deepStrictEqual(me, { stock: got ? 2 : 3, ask: null, game: me.game, role, spent: got });
      if (!got) assert.ok(["doctor", "villager"].includes(rs[s]), "an asker who was not drawn is dealt from what is left: " + rs[s]);
    }
    assert.strictEqual(new Set([1, 3, 4, 7, 2, 8].map((s) => room.players[s].pk.told.game)).size, 1, "one game id for the deal");
    for (const s of [0, 5, 6]) assert.ok(rs[s] !== "mafia" && rs[s] !== "detective", "a taken role reached someone who did not ask");
  }
});

test("an ask is for one game: the next deal owes it nothing, and the answer is kept only until the next cards", () => {
  const room = mock(6); askAs(room, 2, "doctor"); deal(room);
  assert.strictEqual(room.players[2].role, "doctor");
  let doc = 0;
  for (let i = 0; i < 600; i++) {
    room.status = "over"; const rs = deal(room);
    if (rs[2] === "doctor") doc++;
    assert.deepStrictEqual(Pick.me(room.players[2].pk), { stock: 2, ask: null });
  }
  near(doc / 600, 1 / 6, 600, "the old asker as the Doctor in later games");
});

test("at the deal an ask that cannot stand is dropped, nothing spent: a bot's, an older app's, an empty stock's, an away player's, a role not in the deck", () => {
  const second = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 700; i++) {
    const room = mock(8, { bots: [5] });   // eight seats: two Shadows
    room.players[5].pk = Pick.seat(CAPS, 3); room.players[5].pk.ask = "mafia";    // an ask forged onto a bot's seat
    room.players[1].pk.ask = "mafia"; room.players[1].pk.knows = false;           // an app that no longer says the cap
    room.players[2].pk.ask = "mafia"; room.players[2].pk.stock = 0;               // nothing to pay with
    room.players[3].pk.ask = "mafia"; room.players[3].connected = false;          // away when the cards are dealt
    room.players[4].pk.ask = "jester";                                            // a role this room does not deal
    assert.strictEqual(askAs(room, 6, "mafia"), null);                            // the one ask that stands
    const rs = deal(room);
    assert.strictEqual(rs[6], "mafia"); assert.strictEqual(Pick.me(room.players[6].pk).spent, true);
    assert.deepStrictEqual(Pick.me(room.players[2].pk), { stock: 0, ask: null, dropped: { role: "mafia", message: "You have no role picks left." } });
    assert.deepStrictEqual(Pick.me(room.players[3].pk), { stock: 3, ask: null, dropped: { role: "mafia", message: "You were away when the game began." } });
    assert.deepStrictEqual(Pick.me(room.players[4].pk), { stock: 3, ask: null, dropped: { role: "jester", message: "The Jester is not in this game any more." } });
    assert.deepStrictEqual(Pick.me(room.players[1].pk), { stock: 3, ask: null }); assert.deepStrictEqual(Pick.me(room.players[5].pk), { stock: 3, ask: null });
    rs.forEach((r, s) => { if (r === "mafia" && s !== 6) second[s]++; });
  }
  // the other Shadow's card went by the ordinary deal: one in seven for each of the rest, the dropped askers no more than anyone
  for (const s of [0, 1, 2, 3, 4, 5, 7]) near(second[s] / 700, 1 / 7, 700, "seat " + s + " as the second Shadow");
  // the host's switch off at the deal (an ask that somehow still stood)
  let det = 0;
  for (let i = 0; i < 600; i++) {
    const room = mock(6); room.players[1].pk.ask = "detective"; room.rolePicks = false;
    if (deal(room)[1] === "detective") det++;
    assert.deepStrictEqual(Pick.me(room.players[1].pk), { stock: 3, ask: null, dropped: { role: "detective", message: "The host turned role picks off." } });
  }
  near(det / 600, 1 / 6, 600, "the asker as the Detective with role picks off");
});

/* `deals` deals of an n-seat room with these asks ({ seat: role }): how often each seat got each role, how often each ask was drawn */
function simulate(n, o, asks, deals) {
  const got = Array.from({ length: n }, () => ({})), drawn = {};
  let count = null;
  for (let d = 0; d < deals; d++) {
    const room = mock(n, o);
    for (const [s, role] of Object.entries(asks)) assert.strictEqual(askAs(room, Number(s), role), null);
    const rs = deal(room);
    count = room.deck.count;
    assert.deepStrictEqual(tally(rs), count);
    rs.forEach((r, s) => { got[s][r] = (got[s][r] || 0) + 1; });
    for (const s of Object.keys(asks)) { const t = room.players[s].pk.told; assert.strictEqual(t.spent, rs[s] === asks[s]); if (t.spent) drawn[s] = (drawn[s] || 0) + 1; }
  }
  return { got, drawn, count };
}
/* The rule, as rates: an asker is drawn seats/askers of the time (always, when the askers are no more than the seats); the cards the askers
   did not take are dealt evenly over every seat that was not drawn, so a seat that did not ask gets each role at left/pool, and an asker who
   was not drawn the same. */
function checkRates(n, o, asks, deals = 2000) {
  const { got, drawn, count } = simulate(n, o, asks, deals);
  const k = {}; for (const r of Object.values(asks)) k[r] = (k[r] || 0) + 1;
  const left = { ...count }; let taken = 0;
  for (const r of Object.keys(k)) { const d = Math.min(k[r], count[r]); left[r] -= d; taken += d; }
  const pool = n - taken;
  let lines = 0;
  for (let s = 0; s < n; s++) {
    const asked = asks[s];
    const p = asked ? Math.min(1, count[asked] / k[asked]) : 0;
    if (asked) { near((drawn[s] || 0) / deals, p, deals, `seat ${s} asked ${asked} (${k[asked]} askers, ${count[asked]} seats): drawn`); lines++; }
    for (const r of Object.keys(count)) {
      const want = (asked === r ? p : 0) + (1 - p) * left[r] / pool;
      near((got[s][r] || 0) / deals, want, deals, `seat ${s} (${asked ? "asked " + asked : "no ask"}) dealt ${r}`); lines++;
    }
  }
  return { count, k, lines };
}

test("2,000 deals each: k askers for a role with s seats are each drawn s/k of the time, and every other seat gets every role at the rate the remaining cards give", () => {
  const runs = [
    [8, {}, { 0: "mafia", 3: "mafia", 5: "mafia" }],                                                        // 3 ask for 2 Shadow seats
    [6, {}, { 1: "detective", 4: "detective" }],                                                             // 2 ask for the 1 Detective
    [12, { roles: { jester: true, mayor: true } }, { 0: "mafia", 1: "mafia", 2: "mafia", 3: "mafia", 4: "mafia", 7: "jester", 8: "jester", 9: "doctor" }],   // 5 for 3, 2 for 1, 1 for 1
    [8, {}, { 2: "mafia" }],                                                                                 // 1 asks for 2 seats: always drawn, the other Shadow is anyone
    [7, { roles: { jester: true, mayor: true, bodyguard: true }, plus: true }, { 0: "bodyguard", 1: "bodyguard", 2: "bodyguard", 3: "mayor" }],   // 3 for 1, in a Plus room
    [10, {}, { 0: "mafia", 1: "mafia", 2: "detective", 3: "doctor", 4: "doctor", 5: "doctor", 6: "doctor" }],   // 2 for 2, 1 for 1, 4 for 1: only villagers are left
    [9, {}, {}],                                                                                             // nobody asks: the deal as it always was
  ];
  let lines = 0;
  for (const [n, o, asks] of runs) lines += checkRates(n, o, asks).lines;
  assert.ok(lines > 250, "rates checked: " + lines);
});

test("nobody else is sent a word of it: no ask, no answer, no game id in another seat's state; the log and the chat as ever; an older app and a watcher get the seat counts and nothing more", () => {
  const room = mock(7, { old: [6] });
  askAs(room, 1, "mafia"); askAs(room, 2, "mafia"); askAs(room, 3, "doctor");
  const check = (when, ids) => {
    for (let s = -1; s < 7; s++) {
      const st = sent(room, s), keys = Object.keys(st);
      assert.deepStrictEqual(st.roleSeats, S.roleSeatsNow(room), when + ": the seat counts, seat " + s);
      if (s < 0 || s === 6) {
        assert.ok(!("rolePick" in st) && !("rolePicks" in st), when + ": seat " + s + " is sent nothing of the role pick");
        assert.strictEqual(keys[keys.length - 1], "roleSeats");
      } else {
        assert.deepStrictEqual(st.rolePick, Pick.me(room.players[s].pk), when + ": seat " + s + " reads its own");
        assert.strictEqual(st.rolePicks, "on");
        assert.deepStrictEqual(keys.slice(-3), ["roleSeats", "rolePicks", "rolePick"], "the new fields come last");
      }
      const others = JSON.stringify({ ...st, rolePick: undefined });
      for (const word of ['"ask"', '"spent"', '"dropped"', '"pk"', '"stock"', '"unseen"', ...ids]) assert.ok(!others.includes(word), `${when}: seat ${s} is sent ${word} outside its own rolePick`);
      assert.strictEqual(st.log, room.log); assert.deepStrictEqual(st.chat, []);
    }
  };
  check("lobby", []);
  assert.deepStrictEqual(sent(room, 4).rolePick, { stock: 3, ask: null }, "a seat that did not ask");
  deal(room);
  const game = room.players[1].pk.told.game;
  check("dealt", [game]);
  assert.deepStrictEqual(sent(room, 3).rolePick, { stock: 2, ask: null, game, role: "doctor", spent: true });
  assert.deepStrictEqual(sent(room, 4).rolePick, { stock: 3, ask: null });
  Object.assign(room, { status: "over", phase: "over", winner: "village", winReason: "lastShadow" });   // the end, every card face up
  check("over", [game]);
});

test("a count said in the same moment as a deal is not counted twice (pickSeen), and a spent pick stays spent across a reconnect", () => {
  const room = mock(6), pk = room.players[1].pk;
  askAs(room, 1, "mafia"); deal(room);
  const g1 = pk.told.game;
  assert.strictEqual(pk.stock, 2);
  Pick.take(pk, 3); assert.strictEqual(pk.stock, 2, "the count from before the deal, said again");
  Pick.take(pk, 3, "another"); assert.strictEqual(pk.stock, 2);
  Pick.take(pk, 2, g1); assert.strictEqual(pk.stock, 2, "the app took it off and says for which game");
  Pick.take(pk, 2); assert.strictEqual(pk.stock, 2, "once counted, counted");
  Pick.take(pk, 7, g1); assert.strictEqual(pk.stock, 7, "a purchase");
  room.status = "lobby"; askAs(room, 1, "doctor"); deal(room); const g2 = pk.told.game;
  room.status = "lobby"; askAs(room, 1, "doctor"); deal(room); const g3 = pk.told.game;
  assert.ok(g1 !== g2 && g2 !== g3); assert.strictEqual(pk.stock, 5);
  Pick.take(pk, 7, g1); assert.strictEqual(pk.stock, 5, "two games not counted yet");
  Pick.take(pk, 6, g2); assert.strictEqual(pk.stock, 5);
  Pick.take(pk, 5, g3); assert.strictEqual(pk.stock, 5);
  Pick.take(pk, 5); assert.strictEqual(pk.stock, 5);
  assert.deepStrictEqual(Pick.me(pk), { stock: 5, ask: null, game: g3, role: "doctor", spent: true }, "the last answer is kept for a reconnect");
});

/* ---------- part 2: over the wire ---------- */
const wire = [];
const wtest = (name, fn) => wire.push({ name, fn });
let port = 0;
const until = async (fn, what, ms = 3000) => assert.ok(await H.wait(fn, ms), typeof what === "function" ? what() : what);
/* an app that keeps what it is sent: every state with its version, every refusal */
function app(name, o = {}) {
  const c = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false, forceNew: true });
  Object.assign(c, { nm: name, pid: o.pid || "p_" + name + "_" + Math.random().toString(16).slice(2, 8), caps: o.caps === undefined ? CAPS : o.caps, picks: o.picks,
    st: null, seat: -1, v: 0, n: 0, vs: [], all: [], refusals: [], errs: [], code: null, secret: null, waiting: false });
  c.on("state", ({ room, mySeat, v }) => { c.st = room; c.seat = mySeat; c.v = v; c.n++; c.vs.push(v); c.all.push(JSON.stringify(room)); });
  c.on("refusal", (r) => c.refusals.push(r));
  c.on("err", (m, x) => c.errs.push({ m, x }));
  c.on("joined", (j) => { c.code = j.code; c.secret = j.secret; c.waiting = !!j.waiting; });
  c.say = () => ({ name: c.nm, playerId: c.pid, avatar: "\u{1F642}", ...(c.caps ? { caps: c.caps } : {}), ...(c.picks === undefined ? {} : { picks: c.picks }) });
  return c;
}
/* the first makes the room, the rest join it in order */
async function table(specs, extra = {}) {
  const cs = specs.map(([name, o]) => app(name, o));
  await until(() => cs.every((c) => c.connected), "the apps connect");
  cs[0].emit("create", { ...cs[0].say(), ...extra });
  await until(() => cs[0].code && cs[0].st, "the room is made");
  for (let i = 1; i < cs.length; i++) { cs[i].emit("join", { ...cs[i].say(), code: cs[0].code }); await until(() => cs[i].st && cs[i].st.players.length === i + 1, cs[i].nm + " sits"); }
  await until(() => cs.every((c) => c.st.players.length === cs.length), "everyone sees the table");
  return cs;
}
async function refused(c, payload, line) {
  const n = c.refusals.length, e = c.errs.length;
  c.emit("rolePick", payload);
  await until(() => c.refusals.length > n && c.errs.length > e, `no refusal where "${line}" was due`);
  assert.deepStrictEqual(c.refusals[c.refusals.length - 1], { code: "rolepick", message: line, op: "rolePick" });
  assert.deepStrictEqual(c.errs[c.errs.length - 1], { m: line, x: { code: "rolepick" } });
}
async function pick(c, role, want = role) {
  c.emit("rolePick", { role });
  await until(() => c.st.rolePick && c.st.rolePick.ask === want, () => `${c.nm} asks ${role}: ${JSON.stringify(c.st.rolePick)}`);
}
const mine = (c, want, what) => until(() => { try { assert.deepStrictEqual(c.st.rolePick, want); return true; } catch (e) { return false; } }, () => `${what || c.nm}: ${JSON.stringify(c.st.rolePick)} where ${JSON.stringify(want)} was due`);
const rising = (c) => c.vs.every((v, i) => i === 0 || v > c.vs[i - 1]);
const T = {};   // the first table, kept from test to test: host (2 picks), ann (1), bo (none), old (an app from before the role pick)

wtest("the lobby: everyone reads the seat counts; an app that knows the role pick reads the switch and its own picks; an older app reads nothing new", async () => {
  const [h, a, b, o] = await table([["Host", { picks: 2 }], ["Ann", { picks: 1 }], ["Bo", { picks: 0 }], ["Old", { caps: OLD, picks: 5 }]]);
  Object.assign(T, { h, a, b, o });
  for (const c of [h, a, b, o]) assert.deepStrictEqual(c.st.roleSeats, { mafia: 1, detective: 1, doctor: 1 }, "four in the lobby are counted as the five the game needs");
  assert.deepStrictEqual(h.st.rolePick, { stock: 2, ask: null }); assert.deepStrictEqual(a.st.rolePick, { stock: 1, ask: null }); assert.deepStrictEqual(b.st.rolePick, { stock: 0, ask: null });
  for (const c of [h, a, b]) { assert.strictEqual(c.st.rolePicks, "on"); assert.deepStrictEqual(Object.keys(c.st).slice(-3), ["roleSeats", "rolePicks", "rolePick"], "after every older field"); }
  assert.ok(!("rolePick" in o.st) && !("rolePicks" in o.st), "the older app is sent neither");
  assert.strictEqual(Object.keys(o.st).pop(), "roleSeats");
  assert.ok(!h.st.features.includes("rolepick") && h.st.features.length === 7, "the features list is as it was");
});

wtest("an ask is heard by its asker alone: the others are sent nothing, not even a version that skipped; every refusal in plain words", async () => {
  const { h, a, b, o } = T;
  const n0 = [a, b, o].map((c) => c.n), v0 = { h: h.v, a: a.v, b: b.v, o: o.v };
  await pick(h, "detective"); assert.deepStrictEqual(h.st.rolePick, { stock: 2, ask: "detective" });
  await pick(h, "mafia");                                   // a new ask replaces the old one
  await pick(h, null);                                      // taken back
  await pick(h, "doctor");
  h.emit("rolePick", null);                                 // taken back with no payload at all
  await until(() => h.st.rolePick.ask === null, "a bare rolePick takes the ask back");
  assert.strictEqual(h.v, v0.h + 5, "five answers, five versions of the host's own");
  await refused(b, { role: "doctor" }, "You have no role picks.");
  await refused(a, { role: "villager" }, "No such role to pick.");
  await refused(a, { role: 7 }, "No such role to pick.");
  await refused(a, { role: "jester" }, "The Jester is not in this game.");
  await refused(a, { role: "bodyguard" }, "The Bodyguard is not in this game.");
  await refused(o, { role: "doctor" }, "Update GameNest to pick a role.");
  await pick(a, "doctor");
  await pick(h, "detective");
  await H.sleep(250);
  assert.deepStrictEqual([a, b, o].map((c) => c.n), [n0[0] + 1, n0[1], n0[2]], "Ann heard her own ask; Bo and the older app heard nothing at all");
  assert.strictEqual(b.v, v0.b); assert.strictEqual(o.v, v0.o);
  // something everyone sees: each app's version goes on by one from where it stood, whatever was said to others in between
  h.emit("addBot");
  await until(() => [h, a, b, o].every((c) => c.st.players.length === 5), "a bot sits");
  assert.strictEqual(b.v, v0.b + 1, "no gap for Bo"); assert.strictEqual(o.v, v0.o + 1, "no gap for the older app");
  assert.strictEqual(a.v, v0.a + 2); assert.strictEqual(h.v, v0.h + 7);
  for (const c of [h, a, b, o]) assert.ok(rising(c), c.nm + "'s versions only ever rise");
  for (const c of [b, o]) assert.ok(c.all.every((s) => !/"ask":"|"spent"|"dropped"/.test(s)), c.nm + " was sent somebody's ask");
  assert.ok(a.all.every((s) => !s.includes("detective\"}") && !/"ask":"(detective|mafia)"/.test(s)), "Ann was sent the host's ask");
  assert.deepStrictEqual(a.st.rolePick, { stock: 1, ask: "doctor" }); assert.deepStrictEqual(h.st.rolePick, { stock: 2, ask: "detective" });
  assert.strictEqual(a.st.players.some((p) => "pk" in p || "ask" in p || "picks" in p), false, "nothing of it on the seats");
});

wtest("the lobby changes under an ask: the host switches a role off, or the room shrinks so the role is not dealt; the ask is dropped, nothing spent, and only its asker is told", async () => {
  const [h, a, c] = await table([["Pia", { picks: 3 }], ["Ann2", { picks: 2 }], ["Cy", { picks: 1 }]], { plus: true });
  for (let i = 0; i < 3; i++) h.emit("addBot");
  h.emit("settings", { jester: true, mayor: true }); h.emit("settings", { bodyguard: true });
  const six = { mafia: 1, detective: 1, doctor: 1, jester: 1, mayor: 1, bodyguard: 1 };
  await until(() => [h, a, c].every((x) => JSON.stringify(x.st.roleSeats) === JSON.stringify(six)), () => "six seats, every role: " + JSON.stringify(c.st.roleSeats));
  await pick(h, "jester"); await pick(a, "jester"); await pick(c, "bodyguard");
  h.emit("settings", { jester: false });
  const gone = { role: "jester", message: "The Jester is not in this game any more." };
  await mine(h, { stock: 3, ask: null, dropped: gone }); await mine(a, { stock: 2, ask: null, dropped: gone });
  assert.deepStrictEqual(c.st.rolePick, { stock: 1, ask: "bodyguard" }, "an ask for a role still dealt stands");
  assert.deepStrictEqual(c.st.roleSeats, { mafia: 1, detective: 1, doctor: 1, mayor: 1, bodyguard: 1 });
  assert.ok(c.all.every((s) => !s.includes('"dropped"')), "Cy was sent somebody's dropped ask");
  await refused(a, { role: "jester" }, "The Jester is not in this game.");
  assert.deepStrictEqual(a.st.rolePick.dropped, gone, "a refused ask leaves the note");
  await pick(a, "mayor"); assert.deepStrictEqual(a.st.rolePick, { stock: 2, ask: "mayor" }, "the note goes with the next ask");
  h.emit("rolePick", { role: null }); await mine(h, { stock: 3, ask: null }, "the note goes when the asker takes back");
  // the room shrinks: with the Jester and the Mayor in, five seats leave no card for the Bodyguard
  h.emit("settings", { jester: true });
  await until(() => c.st.roleSeats.jester === 1, "the Jester is back");
  h.emit("removeBot");
  await mine(c, { stock: 1, ask: null, dropped: { role: "bodyguard", message: "The Bodyguard is not in this game any more." } });
  assert.deepStrictEqual(c.st.roleSeats, { mafia: 1, detective: 1, doctor: 1, jester: 1, mayor: 1 });
  assert.deepStrictEqual(a.st.rolePick, { stock: 2, ask: "mayor" });
  assert.ok(a.all.every((s) => !s.includes("Bodyguard is not")) && h.all.every((s) => !s.includes("Bodyguard is not")), "the others were sent Cy's line");
  await refused(c, { role: "bodyguard" }, "The Bodyguard is not in this game.");
  h.emit("addBot");
  await until(() => c.st.roleSeats.bodyguard === 1, "six seats again");
  assert.strictEqual(c.st.rolePick.ask, null, "a dropped ask does not come back by itself");
  await pick(c, "bodyguard");
  // a person leaving the lobby shrinks it too
  a.emit("leave");
  await mine(c, { stock: 1, ask: null, dropped: { role: "bodyguard", message: "The Bodyguard is not in this game any more." } });
  Object.assign(T, { p: h, c });
  a.close();
});

wtest("the host's switch: settings.rolePicks off turns every ask away in plain words and drops the ones standing; on again and asks are taken; only the host has it", async () => {
  const { h, a, b, o } = T;   // the first table: the host asks for the Detective, Ann for the Doctor
  assert.deepStrictEqual(h.st.rolePick, { stock: 2, ask: "detective" }); assert.deepStrictEqual(a.st.rolePick, { stock: 1, ask: "doctor" });
  const log = h.st.log;
  a.emit("settings", { rolePicks: "off" });   // not the host
  await H.sleep(200);
  assert.strictEqual(h.st.rolePicks, "on"); assert.strictEqual(a.st.rolePick.ask, "doctor");
  h.emit("settings", { rolePicks: "off" });
  const off = (role) => ({ role, message: "The host turned role picks off." });
  await mine(h, { stock: 2, ask: null, dropped: off("detective") }); await mine(a, { stock: 1, ask: null, dropped: off("doctor") });
  await until(() => b.st.rolePicks === "off", "Bo reads the switch");
  assert.deepStrictEqual(b.st.rolePick, { stock: 0, ask: null });
  assert.ok(!("rolePicks" in o.st) && !("rolePick" in o.st), "the older app reads nothing of it");
  assert.strictEqual(h.st.log, log, "the switch writes no line in the log");
  assert.deepStrictEqual(h.st.roleSeats, { mafia: 1, detective: 1, doctor: 1 }, "the seat counts stay");
  await refused(a, { role: "doctor" }, "The host turned role picks off.");
  await refused(h, { role: "mafia" }, "The host turned role picks off.");
  await refused(b, { role: "mafia" }, "The host turned role picks off.");
  a.emit("rolePick", { role: null }); await mine(a, { stock: 1, ask: null }, "taking back is never refused");
  h.emit("settings", { rolePicks: 1 });   // neither on nor off: nothing changes
  await H.sleep(150); assert.strictEqual(h.st.rolePicks, "off");
  h.emit("settings", { rolePicks: true });
  await until(() => [h, a, b].every((c) => c.st.rolePicks === "on"), "on again");
  await pick(a, "doctor");
  h.emit("settings", { rolePicks: false }); await mine(a, { stock: 1, ask: null, dropped: off("doctor") });
  h.emit("settings", { rolePicks: "on" }); await until(() => a.st.rolePicks === "on", "on by its word");
  h.emit("settings", { voteRule: "plurality" });   // another setting leaves the switch alone
  await until(() => a.st.voteRule === "plurality", "the vote rule");
  assert.strictEqual(a.st.rolePicks, "on");
});

wtest("pickStock: the app says the whole count each time, 0..99; to its owner alone; a count gone to nothing drops the ask; an older app's is not heard", async () => {
  const { h, a, b, o } = T;
  const n0 = [h, a, o].map((c) => c.n), vb = b.v;
  b.emit("pickStock", { picks: 5 }); await mine(b, { stock: 5, ask: null });
  assert.strictEqual(b.v, vb + 1);
  b.emit("pickStock", { picks: 250 }); await mine(b, { stock: 99, ask: null });
  b.emit("pickStock", { picks: -3 }); await mine(b, { stock: 0, ask: null });
  b.emit("pickStock", { picks: 4 }); await mine(b, { stock: 4, ask: null });
  for (const bad of [{ picks: "7" }, { picks: 2.5 }, { picks: null }, {}, 7, null]) {
    b.emit("pickStock", { picks: 4 }); await mine(b, { stock: 4, ask: null });
    b.emit("pickStock", bad); await mine(b, { stock: 0, ask: null }, "a count that is not a whole number is none: " + JSON.stringify(bad));
  }
  b.emit("pickStock", { picks: 2 }); await mine(b, { stock: 2, ask: null });
  await pick(b, "mafia");
  b.emit("pickStock", { picks: 1 }); await mine(b, { stock: 1, ask: "mafia" }, "an ask stands while a pick is left");
  b.emit("pickStock", { picks: 0 }); await mine(b, { stock: 0, ask: null, dropped: { role: "mafia", message: "You have no role picks left." } });
  await refused(b, { role: "mafia" }, "You have no role picks.");
  b.emit("pickStock", { picks: 4 }); await mine(b, { stock: 4, ask: null, dropped: { role: "mafia", message: "You have no role picks left." } });
  const no = o.n;
  o.emit("pickStock", { picks: 9 });
  await H.sleep(200);
  assert.strictEqual(o.n, no, "the older app is answered nothing"); assert.ok(!("rolePick" in o.st));
  assert.deepStrictEqual([h, a, o].map((c) => c.n), n0, "nobody else heard any of it");
  for (const c of [h, a, b, o]) { assert.ok(rising(c), c.nm + "'s versions only ever rise"); c.close(); }
  T.p.close(); T.c.close();
});

/* the app says its count and waits for the answer (its next state) */
async function said(c, payload) { const n = c.n; c.emit("pickStock", payload); await until(() => c.n > n, c.nm + " is answered"); return c.st.rolePick; }
/* the same player on a new connection, as an app that came back does it */
async function back(old, code, o = {}, extra = {}) {
  const c = app(old.nm, { pid: old.pid, caps: old.caps, ...o });
  await until(() => c.connected, old.nm + " connects again");
  c.emit("join", { ...c.say(), code, secret: old.secret, ...extra });
  await until(() => c.st, old.nm + " is back at the table");
  return c;
}
const outside = (c, game) => c.all.every((s) => { const st = JSON.parse(s); delete st.rolePick; const rest = JSON.stringify(st); return !rest.includes(game) && !/"spent"|"ask"|"dropped"|"stock"/.test(rest); });

wtest("the deal: two ask for the one Detective and the lot picks one, who pays a pick; the other pays nothing; a lone asker gets the role; an asker who was away is dropped; nobody else is sent a trace", async () => {
  const [h, a, b, d, o] = await table([["Hal", { picks: 2 }], ["Amy", { picks: 1 }], ["Ben", { picks: 4 }], ["Dee", { picks: 1 }], ["Ole", { caps: OLD, picks: 5 }]]);
  const code = h.code;
  h.emit("addBot");
  await until(() => [h, a, b, d, o].every((c) => c.st.players.length === 6), "six seats");
  await pick(h, "detective"); await pick(a, "detective"); await pick(b, "mafia"); await pick(d, "doctor");
  d.close();
  await until(() => h.st.players[3].connected === false, "Dee drops off");
  h.emit("start");
  await until(() => [h, a, b, o].every((c) => c.st.status === "playing"), "the cards are dealt");
  const game = b.st.rolePick.game;
  assert.ok(/^[0-9a-f]{8}$/.test(game), "the deal has an id");
  assert.deepStrictEqual(b.st.rolePick, { stock: 3, ask: null, game, role: "mafia", spent: true }); assert.strictEqual(b.st.yourRole, "mafia");
  const [won, lost] = h.st.rolePick.spent ? [h, a] : [a, h], had = (c) => (c === h ? 2 : 1);
  assert.deepStrictEqual(won.st.rolePick, { stock: had(won) - 1, ask: null, game, role: "detective", spent: true }); assert.strictEqual(won.st.yourRole, "detective");
  assert.deepStrictEqual(lost.st.rolePick, { stock: had(lost), ask: null, game, role: "detective", spent: false });
  assert.ok(["doctor", "villager"].includes(lost.st.yourRole), "the asker who was not drawn is dealt from the rest: " + lost.st.yourRole);
  assert.strictEqual(h.st.log, "Roles are dealt. Check yours — and keep it to yourself.", "the log is the line it always was");
  assert.deepStrictEqual(h.st.roleSeats, { mafia: 1, detective: 1, doctor: 1 }); assert.deepStrictEqual(h.st.chat || [], []);
  for (const c of [h, a, b, o]) assert.ok(outside(c, game), c.nm + " was sent a trace of somebody's pick");
  assert.ok(o.all.every((s) => !s.includes("rolePick")), "the older app is sent nothing of it, dealt or not");
  assert.deepStrictEqual(Object.keys(h.st).slice(-3), ["roleSeats", "rolePicks", "rolePick"]);
  // a game is under way: asks wait for the lobby
  await refused(lost, { role: "doctor" }, "Roles are picked in the lobby.");
  await refused(b, { role: null }, "Roles are picked in the lobby.");
  // the app's count and the server's agree: the count from before the deal is one too many until the app says it has seen this game
  assert.deepStrictEqual(await said(b, { picks: 4 }), { stock: 3, ask: null, game, role: "mafia", spent: true });
  assert.strictEqual((await said(b, { picks: 3, pickSeen: game })).stock, 3);
  assert.strictEqual((await said(b, { picks: 3 })).stock, 3, "once counted, counted");
  assert.strictEqual((await said(b, { picks: 8, pickSeen: game })).stock, 8, "bought more in the middle of a game");
  // the drawn player's app comes back: with its old count (it never saw the deal), then with the game it has seen
  won.close();
  const w2 = await back(won, code, { picks: had(won) });
  assert.deepStrictEqual(w2.st.rolePick, { stock: had(won) - 1, ask: null, game, role: "detective", spent: true }, "the answer is kept for a reconnect, the pick stays spent");
  assert.strictEqual(w2.st.yourRole, "detective");
  w2.close();
  const w3 = await back(won, code, { picks: had(won) - 1 }, { pickSeen: game });
  assert.deepStrictEqual(w3.st.rolePick, { stock: had(won) - 1, ask: null, game, role: "detective", spent: true });
  w3.close();
  const w4 = await back(won, code, { picks: 6 }, { pickSeen: game });
  assert.strictEqual(w4.st.rolePick.stock, 6);
  // Dee was away when the cards were dealt: her ask was dropped and cost nothing
  const d2 = await back(d, code, { picks: 1 });
  assert.deepStrictEqual(d2.st.rolePick, { stock: 1, ask: null, dropped: { role: "doctor", message: "You were away when the game began." } });
  for (const c of [lost, b, o, w4, d2]) { assert.ok(outside(c, game), c.nm + " was sent a trace of somebody's pick"); c.close(); }
});

/* ---------- the second server: short clocks, so whole games are played ---------- */
wtest("quick play: the app says its picks with `quick`, asks while the table is found, and the ask is honoured when it fills", async () => {
  const q = app("Quinn", { picks: 2 }), x = app("Xan", { caps: OLD });
  await until(() => q.connected && x.connected, "they connect");
  q.emit("quick", q.say());
  await until(() => q.st && q.st.rolePick, "a table is being found");
  assert.deepStrictEqual(q.st.rolePick, { stock: 2, ask: null }); assert.strictEqual(q.st.rolePicks, "on");
  assert.deepStrictEqual(q.st.roleSeats, { mafia: 1, detective: 1, doctor: 1 });
  x.emit("quick", x.say());   // an older app is matched to the same table
  await until(() => x.st && x.st.players.length === 2, "the older app sits at it");
  assert.ok(!("rolePick" in x.st) && !("rolePicks" in x.st));
  await pick(q, "mafia");
  await until(() => q.st.status !== "lobby" && x.st.status !== "lobby", "the table fills and the cards are dealt", 9000);
  const game = q.st.rolePick.game;
  assert.deepStrictEqual(q.st.rolePick, { stock: 1, ask: null, game, role: "mafia", spent: true }); assert.strictEqual(q.st.yourRole, "mafia");
  assert.strictEqual(q.st.players.length, 6);
  assert.ok(outside(x, game) && x.all.every((s) => !s.includes("rolePick")), "the older app at the table was sent a trace");
  q.close(); x.close();
});

wtest("the host's own Quick Play fills the table and deals at once: the ask made before it is honoured", async () => {
  const [h] = await table([["Rhea", { picks: 1 }]]);
  await pick(h, "doctor");
  h.emit("quick", { n: 7 });
  await until(() => h.st.status !== "lobby", "dealt");
  assert.strictEqual(h.st.players.length, 7); assert.strictEqual(h.st.yourRole, "doctor");
  assert.deepStrictEqual(h.st.rolePick, { stock: 0, ask: null, game: h.st.rolePick.game, role: "doctor", spent: true });
  assert.deepStrictEqual(h.st.roleSeats, { mafia: 1, detective: 1, doctor: 1 });
  h.close();
});

wtest("the waiting line and a rematch: a rematch deals at once, so it takes no asks; the last answer goes with the new cards; a player seated from the line owns the picks they said", async () => {
  const [h, a] = await table([["Rex", { picks: 3 }], ["Ada", { picks: 2 }]]);
  for (let i = 0; i < 3; i++) h.emit("addBot");
  await until(() => h.st.players.length === 5, "five seats");
  await pick(h, "doctor");
  h.emit("start");
  await until(() => h.st.status === "playing", "dealt");
  const g1 = h.st.rolePick.game;
  assert.deepStrictEqual(h.st.rolePick, { stock: 2, ask: null, game: g1, role: "doctor", spent: true });
  const w = app("Wes", { picks: 4 });
  await until(() => w.connected, "Wes connects");
  w.emit("join", { ...w.say(), code: h.code });
  await until(() => w.waiting && w.st && w.st.waitPos === 1, "Wes waits in the line");
  assert.ok(!("rolePick" in w.st) && !("rolePicks" in w.st), "nothing to pick from the line");
  assert.deepStrictEqual(w.st.roleSeats, { mafia: 1, detective: 1, doctor: 1 });
  const wn = w.n;
  w.emit("rolePick", { role: "mafia" });   // not seated: not heard
  w.emit("pickStock", { picks: 6 });       // bought one while waiting
  await until(() => h.st.status === "over" && a.st.status === "over", "the game is played out", 60000);
  assert.strictEqual(w.refusals.length, 0);
  assert.deepStrictEqual(h.st.rolePick, { stock: 2, ask: null, game: g1, role: "doctor", spent: true }, "the answer stays to the end of its game");
  await refused(h, { role: "mafia" }, "Roles are picked in the lobby.");
  assert.ok(outside(a, g1) && outside(w, g1), "the others saw nothing of it, the result screen included");
  h.emit("rematch");
  await until(() => h.st.status === "playing" && w.st.status === "playing" && w.seat >= 0, "the rematch is dealt, Wes at the table");
  assert.deepStrictEqual(h.st.rolePick, { stock: 2, ask: null }, "the new cards owe the old ask nothing");
  assert.deepStrictEqual(w.st.rolePick, { stock: 6, ask: null }); assert.strictEqual(w.st.rolePicks, "on");
  assert.deepStrictEqual(a.st.rolePick, { stock: 2, ask: null });
  assert.ok(w.n > wn && rising(w) && rising(h) && rising(a));
  h.close(); a.close(); w.close();
});

wtest("words that are not words: no payload on either event stops the server or is taken for an ask", async () => {
  const [h] = await table([["Nia", { picks: 2 }]]);
  const r0 = h.refusals.length;
  const junk = [5, "mafia", ["mafia"], { role: {} }, { role: ["mafia"] }, { role: "__proto__" }, { role: "constructor" }, { role: "toString" }, { role: "Mafia" }, { role: "" }, { role: 0 }, { role: true }];
  for (const j of junk) h.emit("rolePick", j);
  for (const j of [null, "9", [3], { picks: {} }, { picks: 1e9 }, { picks: NaN }, { picks: 2, pickSeen: {} }, { picks: 2, pickSeen: ["x"] }, { picks: 2, pickSeen: 7 }]) h.emit("pickStock", j);
  await until(() => h.refusals.length === r0 + 9, () => "nine of them are refused: " + JSON.stringify(h.refusals.slice(r0)));   // the three that are not objects take back
  assert.ok(h.refusals.slice(r0).every((r) => r.code === "rolepick" && r.message === "No such role to pick." && r.op === "rolePick"));
  await mine(h, { stock: 2, ask: null });
  await pick(h, "detective");
  assert.ok(!/ failed:/.test(srv.out), "the server logged a handler that threw:\n" + srv.out.split("\n").filter((l) => / failed:/.test(l)).join("\n"));
  h.close();
});

/* ---------- the runner ---------- */
let srv = null;
async function serve(env) {
  if (srv) { const gone = new Promise((r) => srv.once("exit", r)); srv.stop(); await gone; }
  srv = await H.server(port, env);
}
const LONG = { REVEAL_MS: "40000", REVEAL_BOT_MS: "40000", NIGHT_MS: "40000", NIGHT_BOT_MS: "40000", DAY_MS: "40000", DAY_BOT_MS: "40000", VOTE_MS: "40000", VOTE_BOT_MS: "40000", AFK_MS: "40000" };
const SHORT = { REVEAL_MS: "250", REVEAL_BOT_MS: "250", NIGHT_MS: "300", NIGHT_BOT_MS: "300", DAY_MS: "200", DAY_BOT_MS: "200", VOTE_MS: "300", VOTE_BOT_MS: "300", BOT_MS: "5", AFK_MS: "300", QUICK_FILL_MS: "1200" };
const SECOND = "quick play: the app says its picks";   // the first test that wants the short clocks

(async () => {
  const run = async (t) => {
    try { await t.fn(); passed++; console.log("  ok  " + t.name); }
    catch (e) { failed++; console.log("  FAIL " + t.name + "\n" + (e && e.stack || e)); }
  };
  for (const t of tests) await run(t);
  port = H.portOf("TEST_PORT8", 3621);
  try {
    await serve(LONG);
    for (const t of wire) { if (t.name.startsWith(SECOND)) await serve(SHORT); await run(t); }
  } finally { if (srv) srv.stop(); }
  console.log(`role pick: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
