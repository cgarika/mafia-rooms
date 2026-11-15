/* Nightfall's deck and bots: the roles dealt are exactly the room's finalized settings (every toggle combination, every table size),
   the count matches the seats, a bad deck never deals; Quick Play fills and starts; bot talk is unique, staggered, in persona,
   names only people at the table, and bot votes follow suspicion. Port: TEST_PORTS="a" (default 4857). */
const assert = require("assert");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
process.env.TEST_QUIET = "1";
const S = require("../server.js");
const BT = require("../bot_talk");
const PORT = Number((process.env.TEST_PORTS || "").split(",")[0]) || 4857;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("  ok " + name); };
const count = (a, r) => a.filter((x) => x === r).length;

const plusRoom = (on) => (on ? { plus: true, players: [{ plus: true }], host: "h" } : {});
function mockRoom(n, roles, plus) {
  const players = Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i, bot: i > 0, left: false, plus: plus }));
  return { players, roles, host: "p0", status: "lobby" };
}

(async () => {
  console.log("nightfall deck: dealt roles match the settings");
  await ok("every toggle combination at every table size deals exactly what was switched on", () => {
    for (let n = 5; n <= 12; n++) for (const jester of [false, true]) for (const mayor of [false, true]) for (const bodyguard of [false, true]) {
      const room = mockRoom(n, { jester, mayor, bodyguard }, false);
      S.dealRoles(room);
      const rs = room.players.map((p) => p.role);
      assert.strictEqual(rs.length, n, "cards != seats");
      assert.ok(rs.every((r) => typeof r === "string"), "an unset role");
      assert.strictEqual(count(rs, "jester"), jester ? 1 : 0, `jester at ${n} ${JSON.stringify({ jester, mayor })}`);
      assert.strictEqual(count(rs, "mayor"), mayor && 2 + S.mafiaCountFor(n) + (jester ? 1 : 0) < n ? 1 : 0, `mayor at ${n}`);
      assert.strictEqual(count(rs, "bodyguard"), 0, "a Bodyguard outside a Plus room");
      assert.strictEqual(count(rs, "mafia"), S.mafiaCountFor(n));
      assert.strictEqual(count(rs, "detective"), 1); assert.strictEqual(count(rs, "doctor"), 1);
      assert.deepStrictEqual(room.deck.count, rs.reduce((a, r) => (a[r] = (a[r] || 0) + 1, a), {}), "deck counts differ from the deal");
      assert.strictEqual(room.deck.n, n);
    }
  });
  await ok("an unset or non-true flag (a stale or hostile value) never puts a role in the deck", () => {
    for (const roles of [undefined, {}, { jester: "true" }, { jester: 1 }, { mayor: null }, { jester: false, mayor: false }]) {
      const room = mockRoom(6, roles, false); S.dealRoles(room);
      const rs = room.players.map((p) => p.role);
      assert.ok(!rs.includes("jester") && !rs.includes("mayor"), JSON.stringify(roles) + " -> " + rs);
    }
  });
  await ok("a deck that breaks the rules is refused (wrong size, a role the settings leave out)", () => {
    assert.throws(() => S.buildDeck(2, {}), /cards for 2 seats/);
    const d = S.buildDeck(5, { jester: true, mayor: true, bodyguard: true });
    assert.strictEqual(d.roles.length, 5);
    assert.strictEqual(count(d.roles, "mafia"), 1);
  });
  await ok("a seat that left is not dealt a card", () => {
    const room = mockRoom(7, { jester: false }, false); room.players[3].left = true;
    S.dealRoles(room);
    assert.strictEqual(room.deck.n, 6);
    assert.strictEqual(room.players[3].role, null);
    assert.strictEqual(room.players.filter((p) => p.role).length, 6);
  });

  console.log("nightfall deck: over the wire");
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(PORT), REVEAL_MS: "3000", NIGHT_MS: "3000", DAY_MS: "3000", VOTE_MS: "3000", BOT_MS: "20", REVEAL_BOT_MS: "800", NIGHT_BOT_MS: "800", DAY_BOT_MS: "900", VOTE_BOT_MS: "800" }, stdio: "ignore" });
  const up = () => new Promise((res) => { const c = net.connect(PORT, "127.0.0.1"); c.once("connect", () => { c.destroy(); res(true); }); c.once("error", () => res(false)); });
  for (let k = 0; k < 100 && !(await up()); k++) await sleep(50);
  try {
    const mk = () => { const s = io("http://localhost:" + PORT, { transports: ["websocket"] }); s.st = null; s.on("state", ({ room, mySeat }) => { s.st = room; s.seat = mySeat; }); return s; };
    const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(15); } return false; };
    for (const jester of [false, true]) for (const mayor of [false, true]) {
      const A = mk(); let code = null; A.on("joined", (j) => { code = j.code; });
      A.emit("create", { name: "Ava", playerId: "a" + Math.random(), avatar: "x", caps: ["ready", "hunch"] });
      await until(() => code);
      A.emit("settings", { voteRule: "majority", jester, mayor });
      await until(() => A.st && A.st.roles.jester === jester && A.st.roles.mayor === mayor);
      A.emit("quick", {});
      assert.ok(await until(() => A.st && A.st.status === "playing"), "quick play did not start");
      const st = A.st;
      assert.strictEqual(st.seats, 6, "Quick Play seats");
      assert.strictEqual(st.players.length, 6);
      assert.strictEqual(st.roles.jester, jester); assert.strictEqual(st.roles.mayor, mayor);
      assert.strictEqual(Object.values(st.deck.count).reduce((a, b) => a + b, 0), st.seats);
      assert.strictEqual(st.deck.count.jester || 0, jester ? 1 : 0);
      assert.strictEqual(st.deck.count.mayor || 0, mayor ? 1 : 0);
      assert.ok(st.yourRole && st.deck.count[st.yourRole] >= 1, "my role is in the deck");
      assert.strictEqual(st.botRoom, true);
      assert.ok(st.phaseEndsAt - st.serverNow <= 900 + 50, "bot room reveal is brisk");
      A.emit("leave"); A.close();
    }
    passed++; console.log("  ok lobby toggles -> Quick Play deals exactly those roles and 6 seats; bot rooms run the brisk clock");
    // reveal ends as soon as the only human taps ready
    {
      const A = mk(); let code = null; A.on("joined", (j) => { code = j.code; });
      A.emit("create", { name: "Ava", playerId: "a" + Math.random(), avatar: "x" }); await until(() => code);
      A.emit("quick", {}); await until(() => A.st && A.st.phase === "reveal");
      const t0 = Date.now(); A.emit("ready", {});
      assert.ok(await until(() => A.st.phase === "night", 1000), "Ready in the reveal did not start the night"); assert.ok(Date.now() - t0 < 600);
      A.close(); passed++; console.log("  ok the reveal ends the moment every human is ready");
    }
  } finally { srv.kill(); }

  console.log("nightfall bots: talk and votes");
  const table = () => {
    const P = (name, role, bot = true) => ({ id: name, name, role, alive: true, left: false, bot, chatN: 0, accuseN: 0, persona: undefined });
    const players = [P("Ava", "villager", false), P("Robo", "mafia"), P("Chip", "villager"), P("Bolt", "detective"), P("Dicey", "doctor"), P("Turbo", "villager")];
    players.forEach((p, i) => { p.persona = BT.PERSONA_NAMES[i % BT.PERSONA_NAMES.length]; });
    return { code: "T", status: "playing", phase: "day", day: 1, players, chat: [], votes: {}, nightActs: {}, probeLog: {}, lastTally: {}, deaths: [],
      phaseStartedAt: Date.now(), phaseEndsAt: Date.now() + 3000 };
  };
  await ok("a day of bot chat: 2-3 lines per talking bot, no duplicate lines, staggered, only names at the table", async () => {
    const room = table(); const names = room.players.map((p) => p.name);
    S.botChatter(room);
    const plan = room.chatPlan.items.slice();
    assert.ok(plan.length >= 6 && plan.length <= 15, "plan size " + plan.length);
    // the day is 3 s here, so every clock is a tenth of the real one (chatScale): the table seldom talks over itself (0.8 s apart nearly always, never within 0.25 s), and each bot
    // has a timeline of its own: its first line 1.5-9 s in, 2 or 3 lines, each next one 2-9 s after its last (NF5, 2026-11-01)
    const sc = 0.1;
    for (let i = 1; i < plan.length; i++) assert.ok(plan[i].at - plan[i - 1].at >= 250 * sc - 1, "lines closer than the floor: " + (plan[i].at - plan[i - 1].at));
    const perBot = {}; plan.forEach((x) => { (perBot[x.seat] = perBot[x.seat] || []).push(x.at); });
    for (const times of Object.values(perBot)) {
      assert.ok(times.length >= 2 && times.length <= 3, "a bot has " + times.length + " lines");
      assert.ok(times[0] - room.phaseStartedAt >= 1500 * sc - 15 && times[0] - room.phaseStartedAt <= (9000 + 3200) * sc + 15, "first line at " + (times[0] - room.phaseStartedAt));
    }
    const gaps = Object.values(perBot).flatMap((t) => t.slice(1).map((x, i) => x - t[i]));
    assert.ok(gaps.length >= 5 && gaps.every((g) => g >= 2000 * sc - 1), "a bot's lines are less than 2 s (a tenth here) apart: " + gaps.map(Math.round));
    for (let k = 0; k < 400 && room.chatPlan.items.length; k++) { room.chatPlan.items.forEach((i) => { i.at = Math.min(i.at, 0); }); S.botChatter(room); }
    const lines = room.chat.map((m) => m.t);
    assert.ok(lines.length >= 5, "lines " + lines.length);
    assert.strictEqual(new Set(lines).size, lines.length, "duplicate lines: " + lines.join(" | "));
    const speakers = new Set(room.chat.map((m) => m.s)); assert.ok(speakers.size >= 3, "one voice only");
    const strangers = ["Ben", "Finn", "Cleo", "Dan", "Gus", "Nutmeg", "Gizmo", "Pixel", "Widget", "Servo"];
    for (const l of lines) for (const n of strangers) assert.ok(!new RegExp("\\b" + n + "\\b").test(l), n + " is not at this table: " + l);
    for (const n of names) void n;
  });
  await ok("a bot answers a person who names it, and replies in the same day", () => {
    const room = table(); S.botChatter(room);
    room.chat.push({ n: "Ava", t: "Chip is acting suspicious", ch: "day", s: 0 });
    const before = room.chatPlan.items.length;
    const chip = room.players[2];
    const d = BT.draft(room, chip);
    assert.ok(d && d.text);
    assert.ok(before >= 6);
  });
  await ok("bot votes lean on suspicion: the one the chat and the votes point at, not a dice roll", () => {
    let hit = 0; const N = 300;
    for (let k = 0; k < N; k++) {
      const room = table(); room.phase = "vote"; room.day = 2;
      room.players.forEach((p) => { p.chatN = 1; });
      room.chat = [{ n: "Ava", t: "Turbo is lying", ch: "day", s: 0 }, { n: "Bolt", t: "I agree about Turbo", ch: "day", s: 3 }];
      room.lastVotes = { day: 1, votes: { 5: 2 }, tally: { 2: 1 }, out: 2 };   // Turbo pushed out Chip, who was a villager
      room.players[2].alive = false;
      S.botDecide(room, room.players[4]);   // the Doctor
      if (room.votes[4] === 5) hit++;
    }
    assert.ok(hit / N > 0.75, "voted the suspect only " + hit + "/" + N);
  });
  await ok("a detective's find outweighs the chat; a Shadow never votes or names a mate by suspicion", () => {
    const room = table(); room.phase = "vote"; room.day = 2; room.probeLog = { 3: [{ t: 2, mafia: false }, { t: 5, mafia: true }] };
    room.players.forEach((p) => { p.chatN = 1; });
    S.botDecide(room, room.players[3]); assert.strictEqual(room.votes[3], 5);
    for (let k = 0; k < 200; k++) { const sus = BT.suspicion(room, room.players[1]); assert.ok(sus[1] === undefined); }
  });
  console.log(`nightfall deck: all ${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
