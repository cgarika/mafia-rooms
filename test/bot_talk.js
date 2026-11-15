/* Nightfall's bots talk about the game (bot_talk.js): their lines come from the room's facts and never give a role
   away; a Shadow never names a fellow Shadow; a detective hints at what it found; a restyled line is kept only if it
   means the same (a fake model server here), else the bot says its own; and in a real game the bots talk this way.
   Ports: TEST_PORTS="a,b" (defaults 3472, 3473). */
const assert = require("assert");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const T = require("../bot_talk");

const TP = (process.env.TEST_PORTS || "").split(",").map(Number).filter(Boolean);
const PORT = TP[0] || 3472, LLM_PORT = TP[1] || 3473;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("  ok " + name); };
const ROLE = /\b(shadows?|mafia|doctor|detective|bodyguard|villagers?|jester|mayor|roles?)\b|\d/i;

// A table on day 2: Finn died in the night; Ben and Gus are Shadows; Dan the detective found Ben and cleared Cleo.
function table() {
  const P = (name, role, extra = {}) => ({ name, role, alive: true, left: false, bot: true, chatN: 1, ...extra });
  const players = [P("Ava", "villager", { bot: false }), P("Ben", "mafia"), P("Cleo", "villager", { bot: false }), P("Dan", "detective"),
    P("Eli", "villager", { chatN: 0 }), P("Finn", "villager", { alive: false }), P("Gus", "mafia")];
  return {
    code: "TEST", status: "playing", phase: "day", day: 2, players,
    lastNight: { day: 2, died: 5, attacked: true, saved: false },
    lastVotes: { day: 1, votes: { 0: 4, 1: 2, 2: 1, 3: 1, 4: 6, 6: 2 }, tally: { 1: 2, 2: 2, 4: 1, 6: 1 }, out: null },
    probeLog: { 3: [{ t: 1, mafia: true }, { t: 2, mafia: false }] },
    chat: [{ n: "Ava", t: "I think Gus is lying", ch: "day", s: 0 }, { n: "Cleo", t: "Gus has been weird", ch: "day", s: 2 }],
  };
}

(async () => {
  console.log("nightfall bots' talk: the lines");
  await ok("never a role or a number, never the bot's own name, only the table's names", () => {
    const room = table(), names = room.players.map((p) => p.name);
    for (const s of [1, 3, 4, 6]) for (let k = 0; k < 300; k++) {
      const d = T.draft((room.usedLines = new Set(), room), room.players[s]);
      assert.ok(d && d.text, "no line for " + names[s]);
      assert.ok(!ROLE.test(d.text), d.text);
      assert.ok(!new RegExp(`\\b${names[s]}\\b`).test(d.text), names[s] + " named itself: " + d.text);
      assert.ok(d.names.every((n) => names.includes(n) && n !== names[s]), JSON.stringify(d));
    }
  });
  await ok("a Shadow never points at a fellow Shadow (Ben never names Gus, nor Gus Ben)", () => {
    const room = table();
    for (let k = 0; k < 500; k++) {
      assert.ok(!/\bGus\b/.test(T.draft((room.usedLines = new Set(), room), room.players[1]).text));
      assert.ok(!/\bBen\b/.test(T.draft((room.usedLines = new Set(), room), room.players[6]).text));
    }
  });
  await ok("the detective hints at the Shadow it found, and vouches for the one it cleared (never says how)", () => {
    const room = table(); const seen = new Set();
    for (let k = 0; k < 400; k++) seen.add(T.draft((room.usedLines = new Set(), room), room.players[3]).intent);
    assert.ok(seen.has("hint") && seen.has("clear"), [...seen].join(","));
    for (let k = 0; k < 200; k++) { const d = T.draft((room.usedLines = new Set(), room), room.players[3]); if (d.intent === "hint") assert.deepStrictEqual(d.names, ["Ben"]); }
  });
  await ok("the night and what people said come up (Finn's loss; the table's talk about Gus)", () => {
    const room = table(); const texts = [];
    for (let k = 0; k < 400; k++) texts.push(T.draft((room.usedLines = new Set(), room), room.players[4]).text);
    assert.ok(texts.some((t) => /\bFinn\b/.test(t)) && texts.some((t) => /\bGus\b/.test(t)));
  });
  await ok("a restyled line counts only if it means the same", () => {
    const d = { text: "I think Ben is suspicious.", names: ["Ben"] }, all = ["Ava", "Ben", "Dan"];
    assert.ok(T.faithful("Honestly, Ben's giving me weird vibes.", d, "Dan", all));
    assert.ok(!T.faithful("Ben is the mafia for sure.", d, "Dan", all));        // a role
    assert.ok(!T.faithful("Dan here: Ben is weird.", d, "Dan", all));           // its own name
    assert.ok(!T.faithful("Ava is weird.", d, "Dan", all));                     // lost Ben, added Ava
    assert.ok(!T.faithful("Ben voted 3 times.", d, "Dan", all));                // a number
    const died = { intent: "died", text: "We lost Finn last night. Let's not waste today's vote.", names: ["Finn"] };
    assert.ok(!T.faithful("We lost Finn last night. Let's skip today's vote.", died, "Dan", [...all, "Finn"]));   // the meaning turned
    const voted = { intent: "voted", text: "Ava voted for Ben yesterday. Why Ben?", names: ["Ava", "Ben"] };
    assert.ok(!T.faithful("Why Ben? Ava said Ben was the best choice.", voted, "Dan", all));   // a fact made up
    assert.ok(T.faithful("Ava voting for Ben yesterday still bugs me.", voted, "Dan", all));
  });

  console.log("nightfall bots' talk: the model, faked");
  let reply = "", delay = 0;
  const fake = http.createServer((req, res) => { req.resume(); req.on("end", () => setTimeout(() => {
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  }, delay)); }).listen(LLM_PORT);
  const url = `http://127.0.0.1:${LLM_PORT}`, d = { text: "We lost Finn last night. Let's not waste today's vote.", names: ["Finn"] }, all = ["Ava", "Dan", "Finn"];
  await ok("a faithful line from the model is said; a leak, a slow answer or no model gives the bot's own", async () => {
    reply = "<think></think>Ugh, Finn's gone. Let's make today's vote count.";
    assert.strictEqual(await T.say(d, "Dan", all, { url }), "Ugh, Finn's gone. Let's make today's vote count.");
    reply = "Finn was killed by the Shadows, I'm the detective.";
    assert.strictEqual(await T.say(d, "Dan", all, { url }), d.text);
    reply = "Ugh, Finn's gone."; delay = 600;
    assert.strictEqual(await T.say(d, "Dan", all, { url, timeoutMs: 200 }), d.text);
    delay = 0;
    assert.strictEqual(await T.say(d, "Dan", all, { url: "" }), d.text);
  });
  fake.close();

  console.log("nightfall bots' talk: a real game");
  await ok("bots talk about the game in the day's chat, never a role", async () => {
    const free = await new Promise((r) => { const c = net.connect(PORT, "127.0.0.1"); c.once("connect", () => { c.destroy(); r(false); }); c.once("error", () => r(true)); });
    assert.ok(free, "port " + PORT + " in use");
    const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(PORT), LLM_URL: "", BOT_MS: "20", REVEAL_MS: "300", NIGHT_MS: "700", DAY_MS: "1500", VOTE_MS: "700", AFK_MS: "200" }, stdio: "ignore" });
    try {
      await sleep(900);
      const a = io(`http://127.0.0.1:${PORT}`, { transports: ["websocket"], forceNew: true });
      let st = null; a.on("state", (s) => { st = s.room || s; });
      a.emit("create", { name: "Ava", playerId: "p_talk_a" });
      await sleep(300);
      for (let k = 0; k < 6; k++) a.emit("addBot");
      await sleep(400);
      a.emit("start");
      const lines = new Set(); const t0 = Date.now();
      while (Date.now() - t0 < 25000 && lines.size < 4) {
        await sleep(100);
        for (const m of (st && st.chat) || []) if (m.s !== 0 && m.t) lines.add(m.t);
        if (st && st.status === "over") break;
      }
      a.close();
      const all = [...lines];
      assert.ok(all.length >= 2, "bot lines: " + all.length);
      for (const t of all) assert.ok(!ROLE.test(t) || Object.values(require("../server.js").BOT_LINES || {}).flat().includes(t), "a role in: " + t);
      const ours = all.filter((t) => Object.values(T.LINES).flat().some((tpl) => new RegExp("^" + tpl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[TV]\\\}/g, "[A-Za-z' ]+") + "$").test(t)));
      assert.ok(ours.length >= 1, "no line from the game's facts: " + JSON.stringify(all));
      console.log("     (" + all.slice(0, 4).join(" | ") + ")");
    } finally { srv.kill(); }
  });

  console.log(`nightfall bots' talk: all ${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL", e && e.message); process.exit(1); });
