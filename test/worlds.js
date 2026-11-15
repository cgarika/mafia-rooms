/*
 Nightfall — the "worlds" additions (2026-09), run from test/rules.js.
 Unit: the original stateFor as an oracle (every old field unchanged), who the night waits for with and without
 the hunch capability, who "Ready to vote" waits for, text cuts at character boundaries.
 Sockets (a server copy on the spawned port): S1 "Ready to vote", S2 hidden night acts (hunches), refusal codes,
 one room per socket, a second socket for the same player, the seat secret, serverNow, features and the ping.
*/
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- the original stateFor, copied from main (c0745ed), as the compatibility oracle ---------- */
const MIN_PLAYERS = 5, MAX_PLAYERS = 12;
function mafiaCountFor(n) { return n >= 11 ? 3 : n >= 8 ? 2 : 1; }
function oldStateFor(room, seat) {
  const me = room.players[seat];
  const over = room.status === "over";
  const revealed = {};
  for (const s of room.deaths || []) revealed[s] = room.players[s].role;
  if (over) room.players.forEach((p, s) => { revealed[s] = p.role; });
  const iAmDeadOrOver = over || (me && !me.alive);
  const voteTally = {};
  if (room.phase === "vote" || room.phase === "day") {
    for (const [s, t] of Object.entries(room.votes || {})) if (t >= 0) voteTally[t] = (voteTally[t] || 0) + 1;
  }
  const st = {
    code: room.code,
    status: room.status, phase: room.phase, day: room.day,
    phaseEndsAt: room.phaseEndsAt, log: room.log, winner: room.winner,
    hostSeat: room.players.findIndex((p) => p.id === room.host),
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, voteRule: room.voteRule === "plurality" ? "plurality" : "majority",
    roles: { jester: !!(room.roles && room.roles.jester), mayor: !!(room.roles && room.roles.mayor) }, mafiaCount: mafiaCountFor(room.players.length),
    players: room.players.map((p, s) => ({
      name: p.name, avatar: p.avatar, bot: !!p.bot, botControlled: !!p.botControlled, left: p.left,
      connected: p.connected, alive: p.alive !== false,
      voted: room.phase === "vote" ? room.votes[s] !== undefined : false,
    })),
    revealed,
    voteTally,
    voice: room.voice ? Array.from(room.voice) : [],
    yourRole: me ? me.role || null : null,
    yourVote: me && room.votes ? room.votes[seat] : undefined,
    yourAct: me && room.nightActs ? room.nightActs[seat] || null : null,
  };
  if (me && (me.role === "mafia" || iAmDeadOrOver)) {
    st.mafiaSeats = room.players.map((p, s) => (p.role === "mafia" ? s : -1)).filter((s) => s >= 0);
  }
  if (me && me.role === "mafia" && room.phase === "night") {
    st.mafiaPicks = {};
    for (const s of st.mafiaSeats) {
      const a = room.nightActs[s];
      if (a && a.kill != null) st.mafiaPicks[s] = a.kill;
    }
  }
  if (me && me.role === "detective") st.probeLog = room.probeLog[seat] || [];
  st.chat = (room.chat || []).filter((m) => m.ch === "day" || me && (me.role === "mafia" || iAmDeadOrOver)).slice(-60);
  return st;
}
/* the original night rule, for the "nothing changes without the cap" check */
function oldNightDone(room) { return room.players.filter((p) => !p.left && p.alive && ["mafia", "doctor", "detective"].includes(p.role)).every((p) => room.nightActs[room.players.indexOf(p)] != null); }

const ROLES8 = ["mafia", "mafia", "doctor", "detective", "villager", "jester", "mayor", "villager"];
function mkRoom(phase, opts = {}) {
  const players = ROLES8.map((role, i) => ({ id: "p" + i, name: "P" + i, avatar: "🙂", bot: i === 7, botControlled: false, left: false, connected: i !== 6, alive: i !== 5, role, secret: "SECRET-" + i, caps: opts.caps ? { hunch: true, ready: true } : undefined }));
  const room = { code: "NFTEST", host: "p0", players, status: phase === "lobby" ? "lobby" : phase === "over" ? "over" : "playing", phase, day: 2, phaseEndsAt: phase === "over" || phase === "lobby" ? null : 99, log: "x", winner: phase === "over" ? "village" : null,
    deaths: [5], nightActs: { 0: { kill: 4 }, 2: { save: 4 } }, votes: phase === "vote" ? { 0: 4, 1: -1 } : {}, probeLog: { 3: [{ t: 0, mafia: true }] }, voice: new Set([2]),
    chat: [{ n: "P0", a: "🙂", t: "hi", ch: "day", s: 0 }, { n: "P1", a: "🙂", t: "psst", ch: "maf", s: 1 }], roles: { jester: true, mayor: true }, voteRule: "majority",
    hunches: { 4: 1, 0: 3 }, hunchLog: { 4: [{ day: 1, t: 2, took: null }, { day: 2, t: 1 }] }, ready: { 4: true, 6: true } };
  return room;
}

function unit(S) {
  const { stateFor, nightDone, pendingActors, readyStatus, clean, cleanAvatar, FEATURES } = S;
  // ---- oracle: every original field unchanged, for every seat, in every phase ----
  const NEW_KEYS = ["deck", "seats", "botRoom", "readyCount", "readyNeed", "yourHunch", "hunchLog", "features", "serverNow", "reactionsOn", "reactions", "quick", "ranked", "rankedModel", "rankedOn", "rated", "teams", "lastEnd", "outcome"];
  for (const phase of ["lobby", "reveal", "night", "day", "vote", "over"]) {
    for (const caps of [false, true]) {
      const room = mkRoom(phase, { caps });
      for (let seat = -1; seat < 8; seat++) {
        const o = oldStateFor(room, seat), n = stateFor(room, seat);
        const ok = Object.keys(o), nk = Object.keys(n);
        assert(JSON.stringify(nk.slice(0, ok.length)) === JSON.stringify(ok), `oracle ${phase}/${seat}: original keys moved: ${nk.slice(0, ok.length)}`);
        assert(nk.slice(ok.length).every((k) => NEW_KEYS.includes(k)), `oracle ${phase}/${seat}: unexpected new keys ${nk.slice(ok.length)}`);
        for (const k of ok) {
          if (k === "players") {
            o.players.forEach((op, i) => { const np = n.players[i]; const pk = Object.keys(np).filter((k) => k !== "plus" && k !== "look");   // GameNest Plus's flag (2026-09-28) and look (2026-10-16) are the keys added since
              assert(JSON.stringify(pk) === JSON.stringify([...Object.keys(op), "ready"]), `oracle ${phase}/${seat}: players[${i}] keys ${pk}`);
              for (const f of Object.keys(op)) assert(JSON.stringify(op[f]) === JSON.stringify(np[f]), `oracle ${phase}/${seat}: players[${i}].${f} changed`);
              assert(np.ready === (phase === "day" && (i === 4 || i === 6)), `oracle ${phase}/${seat}: players[${i}].ready = ${np.ready}`); });
          } else assert(JSON.stringify(o[k]) === JSON.stringify(n[k]), `oracle ${phase}/${seat}: field ${k} changed: ${JSON.stringify(o[k])} vs ${JSON.stringify(n[k])}`);
        }
        const js = JSON.stringify(n);
        assert(!js.includes("SECRET-"), `oracle ${phase}/${seat}: a seat secret leaked`);
        // hunches never reach anyone but their maker
        assert(n.yourHunch === (phase === "night" && seat === 4 ? 1 : phase === "night" && seat === 0 ? 3 : null), `oracle ${phase}/${seat}: yourHunch ${n.yourHunch}`);
        assert(seat === 4 ? JSON.stringify(n.hunchLog) === JSON.stringify(room.hunchLog[4]) : n.hunchLog === undefined, `oracle ${phase}/${seat}: hunchLog reached the wrong seat`);
        assert(!/"hunches"/.test(js), "oracle: the hunch map leaked");
        assert(n.features === FEATURES && typeof n.serverNow === "number", "oracle: features / serverNow");
      }
    }
  }
  console.log("PASS worlds: stateFor keeps every original field, name and order for every seat in all six phases; players gain only 'ready'; hunches reach only their maker; no secret in any frame");

  // ---- the night waits for: without the cap, exactly the old rule; with it, every living human too ----
  for (let k = 0; k < 400; k++) {
    const room = mkRoom("night", { caps: false });
    room.nightActs = {}; room.hunches = {};
    for (const p of room.players) { p.alive = Math.random() < 0.8; p.botControlled = Math.random() < 0.2; }
    for (const s of [0, 1, 2, 3]) if (Math.random() < 0.6) room.nightActs[s] = { x: 1 };
    for (const s of [4, 5, 6]) if (Math.random() < 0.5) room.hunches[s] = 0;
    assert(nightDone(room) === oldNightDone(room), "S2: without the cap nightDone must be the old rule");
    const old = room.players.filter((p) => p.alive && !p.left && ["mafia", "doctor", "detective"].includes(p.role) && !p.bot && !p.botControlled && room.nightActs[room.players.indexOf(p)] == null);
    assert(JSON.stringify(pendingActors(room)) === JSON.stringify(old), "S2: without the cap pendingActors must be the old list");
  }
  { const room = mkRoom("night", { caps: true }); room.nightActs = { 0: { kill: 4 }, 1: { kill: 4 }, 2: { save: 4 }, 3: { probe: 0 } }; room.hunches = {};
    for (const p of room.players) { p.alive = true; p.connected = true; }
    assert(!nightDone(room), "S2: with the cap the night must wait for the villagers' hunches");
    assert(JSON.stringify(pendingActors(room).map((p) => p.name)) === JSON.stringify(["P4", "P5", "P6"]), "S2: pending should be the three sleepers (the bot never owes a hunch): " + pendingActors(room).map((p) => p.name));
    room.hunches = { 4: 0, 5: 5, 6: 1 };
    assert(nightDone(room), "S2: every hunch in: the night is done");
    room.hunches = { 4: 0, 5: 5, 6: 1, 0: 2 }; delete room.nightActs[2];
    assert(!nightDone(room), "S2: a Doctor's hunch must not stand in for the save");
    room.nightActs[2] = { save: 4 }; room.players[6].botControlled = true; delete room.hunches[6];
    assert(nightDone(room), "S2: a bot-played seat owes no hunch"); }
  console.log("PASS worlds: S2 the night rule is unchanged without the cap (400 random rooms); with it the night also waits for every living human's hunch; a power's hunch never stands in for the power; bot-played seats owe none");

  // ---- who "Ready to vote" waits for ----
  { const room = mkRoom("day", { caps: true }); room.ready = {};
    // living: 0,1,2,3,4,6,7 (5 dead); 7 is a bot; 6 is disconnected -> need 0,1,2,3,4
    assert(JSON.stringify(readyStatus(room)) === JSON.stringify({ need: 5, count: 0 }), "S1: need " + JSON.stringify(readyStatus(room)));
    room.players[1].botControlled = true; room.ready = { 0: true, 6: true, 5: true };
    assert(JSON.stringify(readyStatus(room)) === JSON.stringify({ need: 4, count: 1 }), "S1: bot-played, disconnected and dead seats never count: " + JSON.stringify(readyStatus(room)));
    room.phase = "night"; assert(JSON.stringify(readyStatus(room)) === JSON.stringify({ need: 0, count: 0 }), "S1: nothing outside the day"); }
  console.log("PASS worlds: S1 ready waits for living, connected humans only (bots, bot-played, disconnected and dead seats never hold it up), and only by day");

  // ---- GN-30 ----
  const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  assert(clean("a".repeat(17) + "😀", 18) === "a".repeat(17) && clean("😀".repeat(10), 18) === "😀".repeat(9) && clean("Chanakya", 18) === "Chanakya", "cut: names");
  for (let k = 0; k < 300; k++) { const s = Array.from({ length: 80 }, () => ["a", "é", "😀", "👍🏽", "🇮🇳", "👨‍👩‍👧‍👦", "ह", "ि", " "][Math.floor(Math.random() * 9)]).join(""); for (const n of [18, 140]) { const c = clean(s, n); assert(c.length <= n && !lone(c), "cut: bad cut"); } }
  assert(cleanAvatar("👨‍👩‍👧‍👦") === "👨‍👩‍👧‍👦" && cleanAvatar("🦊") === "🦊" && cleanAvatar("robot") === "robo", "avatar cuts");
  console.log("PASS worlds: GN-30 names (18) and chat (140) are cut at character boundaries; family avatars kept whole");
}

async function sockets(ctx) {
  const { io, startServer, port } = ctx;
  const URL = "http://localhost:" + port;
  const DAY = 8000, NIGHT = 8000, AFK = 600;
  const srv = await startServer(port, { REVEAL_MS: "40", NIGHT_MS: String(NIGHT), DAY_MS: String(DAY), VOTE_MS: "8000", AFK_MS: String(AFK), BOT_MS: "5" });
  const all = [];
  const mk = (name) => {
    const c = io(URL, { transports: ["websocket"], reconnection: false });
    all.push(c);
    c.nm = name; c.st = null; c.seat = -1; c.role = null; c.errs = []; c.errCodes = []; c.refusals = []; c.frames = []; c.joinedMsgs = [];
    c.on("err", (m, extra) => { c.errs.push(m); c.errCodes.push(extra && extra.code); });
    c.on("refusal", (r) => c.refusals.push(r));
    c.on("joined", (j) => c.joinedMsgs.push(j));
    c.on("state", ({ room, mySeat }) => { c.st = room; c.seat = mySeat; if (room.yourRole) c.role = room.yourRole; c.frames.push({ t: Date.now(), phase: room.phase, day: room.day, code: room.code }); });
    return c;
  };
  const wait = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(5); } return false; };
  const boot = async (pfx, humans, bots, caps) => {
    const cs = []; for (let i = 0; i < humans; i++) cs.push(mk(pfx + i));
    await wait(() => cs.every((c) => c.connected));
    let code = null; cs[0].once("joined", (j) => (code = j.code));
    cs[0].emit("create", { name: pfx + "0", playerId: pfx + "id0" + Math.random(), caps: caps && caps(0) });
    await wait(() => code);
    for (let i = 1; i < humans; i++) cs[i].emit("join", { code, name: pfx + i, playerId: pfx + "id" + i + Math.random(), caps: caps && caps(i) });
    for (let b = 0; b < bots; b++) cs[0].emit("addBot");
    await wait(() => cs[0].st && cs[0].st.players.length === humans + bots);
    cs[0].emit("start");
    await wait(() => cs.every((c) => c.role));
    await wait(() => cs[0].st.phase === "night");
    cs.code = code;
    return cs;
  };
  const living = (st) => st.players.map((p, i) => (p.alive && !p.left ? i : -1)).filter((i) => i >= 0);
  /* power roles act so that nobody dies: the Shadows and the Doctor on one villager, the Detective on someone else */
  const powersAct = (cs) => {
    const st = cs[0].st; const target = cs.find((c) => c.role === "villager" && st.players[c.seat].alive) || cs.find((c) => !["mafia"].includes(c.role));
    for (const c of cs) { if (!c.st.players[c.seat].alive) continue;
      if (c.role === "mafia") c.emit("act", { kill: target.seat });
      else if (c.role === "doctor") c.emit("act", { save: target.seat });
      else if (c.role === "detective") c.emit("act", { probe: living(c.st).find((i) => i !== c.seat) }); }
  };
  const ALLCAPS = () => ["ready", "hunch", "secret"];
  try {
    // ================= S2: hidden night acts =================
    // (a) six humans with the cap: the night waits for every sleeper's hunch, and the last input ends it whoever sent it
    {
      const cs = await boot("h", 6, 0, ALLCAPS);
      assert(JSON.stringify(cs[0].st.features) === JSON.stringify(["ready", "hunch", "refusalCodes", "serverNow", "secret", "waitList", "reactions"]), "features: " + JSON.stringify(cs[0].st.features));
      assert(cs[0].io.engine._pingInterval === 5000 && cs[0].io.engine._pingTimeout === 5000, "GN-07: ping 5000/5000 expected, got " + cs[0].io.engine._pingInterval + "/" + cs[0].io.engine._pingTimeout);
      assert(Math.abs(cs[0].st.serverNow - Date.now()) < 2000, "GN-48: serverNow off");
      const sleepers = cs.filter((c) => !["mafia", "doctor", "detective"].includes(c.role));
      powersAct(cs); await sleep(250);
      assert(cs[0].st.phase === "night", "S2: the night ended before the sleepers chose (phase " + cs[0].st.phase + ")");
      let tLast = 0;
      for (const [k, c] of sleepers.entries()) {
        const t = living(c.st).filter((i) => i !== c.seat)[k % 2];
        if (k === sleepers.length - 1) { tLast = Date.now(); c.emit("act", { hunch: t }); break; }   // the last choice of the night
        c.emit("act", { hunch: c.seat }); assert(await wait(() => c.st.yourHunch === c.seat, 1000), "S2: a hunch on oneself was refused");
        c.emit("act", { hunch: t }); assert(await wait(() => c.st.yourHunch === t, 1000), "S2: the latest hunch did not replace the first");
        assert(cs[0].st.phase === "night", "S2: the night ended with a sleeper still to choose");
      }
      assert(await wait(() => cs.every((c) => c.st.phase === "day"), 1500), "S2: the last hunch did not end the night");
      const lag = Math.min(...cs.map((c) => c.frames.find((f) => f.phase === "day").t)) - tLast;
      assert(lag < 500, "S2: dawn came " + lag + " ms after the last hunch");
      for (const c of sleepers) { assert(Array.isArray(c.st.hunchLog) && c.st.hunchLog.length === 1 && c.st.hunchLog[0].day === 1 && Number.isInteger(c.st.hunchLog[0].t) && c.st.hunchLog[0].took === null, "S2: hunchLog after a quiet night: " + JSON.stringify(c.st.hunchLog)); assert(c.st.yourHunch === null, "S2: yourHunch is for the night only"); }
      for (const c of cs.filter((c) => !sleepers.includes(c))) assert(c.st.hunchLog === undefined, "S2: a power holder without hunches got a hunchLog");
      console.log("PASS worlds: S2 with the cap the night waits for every sleeper's hunch (the latest counts, oneself allowed) and ends " + lag + " ms after the last one; hunchLog records it");
      // (b) order does not matter: this time a power holder is the last to choose
      await wait(() => cs[0].st.phase === "day"); cs.forEach((c) => c.emit("ready", {})); await wait(() => cs[0].st.phase === "vote", 2000);
      cs.forEach((c) => c.emit("vote", { target: -1 })); assert(await wait(() => cs[0].st.phase === "night" && cs[0].st.day === 2, 3000), "S2: second night never came");
      const doc = cs.find((c) => c.role === "doctor");
      for (const c of cs.filter((c) => c !== doc)) { if (!c.st.players[c.seat].alive) continue; if (["mafia", "detective"].includes(c.role)) continue; c.emit("act", { hunch: living(c.st)[0] }); }
      const st = cs[0].st; const target = cs.find((c) => c.role === "villager" && st.players[c.seat].alive) || cs.find((c) => c.role !== "mafia");
      for (const c of cs) { if (c.role === "mafia") c.emit("act", { kill: target.seat }); if (c.role === "detective") c.emit("act", { probe: living(c.st).find((i) => i !== c.seat) }); }
      await sleep(250);
      assert(cs[0].st.phase === "night", "S2: the night ended without the Doctor");
      doc.emit("act", { hunch: target.seat }); await sleep(200);
      assert(cs[0].st.phase === "night", "S2: a Doctor's hunch must not stand in for the save");
      const t2 = Date.now(); doc.emit("act", { save: target.seat });
      assert(await wait(() => cs[0].st.phase === "day", 1500), "S2: the Doctor's save did not end the night");
      assert(Date.now() - t2 < 600, "S2: dawn after the Doctor took " + (Date.now() - t2) + " ms");
      console.log("PASS worlds: S2 the night ends on the last input whoever holds it (a Doctor last this time); a power holder's hunch never stands in for the power");
      cs.forEach((c) => c.disconnect());
    }
    // (c) today's app (no cap): the night ends the moment the last power acts, sleepers are never waited for
    {
      const cs = await boot("o", 5, 0, null);
      assert(cs.every((c) => c.st.readyNeed === 0 && c.st.yourHunch === null), "old clients: new fields idle");
      const t0 = Date.now(); powersAct(cs);
      assert(await wait(() => cs[0].st.phase === "day", 2000), "old clients: the night did not end after the powers acted");
      const nightMs = Date.now() - t0;
      assert(nightMs < 700, "old clients: the night took " + nightMs + " ms after the powers");
      // and the day runs its whole clock when nobody presses ready
      const dayStart = Date.now(), endsAt = cs[0].st.phaseEndsAt;
      assert(await wait(() => cs[0].st.phase === "vote", DAY + 2000), "old clients: the day never ended");
      const took = Date.now() - dayStart;
      assert(took > DAY - 800 && Math.abs(Date.now() - endsAt) < 800, "old clients: the day should run its clock (" + took + " ms)");
      console.log("PASS worlds: today's app (no caps): the night ends as soon as the last power acts (" + nightMs + " ms), the day runs its whole clock (" + took + " ms of " + DAY + "); turn flow unchanged");
      cs.forEach((c) => c.disconnect());
    }
    // (d) mixed room: only clients with the cap are waited for
    {
      const cs = await boot("m", 5, 0, (i) => (i % 2 === 0 ? ALLCAPS() : undefined));
      const capped = cs.filter((c, i) => i % 2 === 0 && !["mafia", "doctor", "detective"].includes(c.role));
      powersAct(cs); await sleep(250);
      if (capped.length) {
        assert(cs[0].st.phase === "night", "mixed: a capped sleeper was not waited for");
        for (const c of capped) c.emit("act", { hunch: living(c.st)[0] });
      }
      assert(await wait(() => cs[0].st.phase === "day", 1500), "mixed: the night did not end once the capped sleepers chose");
      console.log("PASS worlds: S2 mixed room: " + capped.length + " capped sleeper(s) waited for, uncapped ones never");
      cs.forEach((c) => c.disconnect());
    }
    // (e) a capped sleeper who drops: the night ends on the AFK clock, as it does for a dropped Doctor; hunch walls
    {
      const cs = await boot("a", 5, 0, ALLCAPS);
      const sl = cs.find((c) => !["mafia", "doctor", "detective"].includes(c.role));
      const others = cs.filter((c) => c !== sl && !["mafia", "doctor", "detective"].includes(c.role));
      // walls: a dead or junk target is ignored
      const v0 = cs[0].st.v; sl.emit("act", { hunch: 99 }); sl.emit("act", { hunch: "1" }); await sleep(150);
      assert(sl.st.yourHunch === null, "S2: a junk hunch was taken");
      powersAct(cs); for (const c of others) c.emit("act", { hunch: living(c.st)[0] });
      await sleep(200); assert(cs[0].st.phase === "night", "S2: night ended without the sleeper");
      const t0 = Date.now(); sl.disconnect();
      assert(await wait(() => cs.find((c) => c !== sl).st.phase === "day", AFK + 1500), "S2: a dropped sleeper held the night");
      const dt = Date.now() - t0; assert(dt < AFK + 900 && dt < NIGHT - 1000, "S2: AFK end took " + dt + " ms");
      console.log("PASS worlds: S2 a dropped sleeper is handled by the AFK clock like a dropped power (" + dt + " ms, AFK " + AFK + "); junk hunches ignored");
      cs.forEach((c) => c.disconnect());
    }
    // ================= S1: ready to vote =================
    {
      const cs = await boot("r", 5, 0, ALLCAPS);
      // ready means nothing at night
      cs[0].emit("ready", {}); await sleep(100); assert(cs[0].st.readyCount === 0 && !cs[0].st.players[cs[0].seat].ready, "S1: ready taken at night");
      const sleepers = cs.filter((c) => !["mafia", "doctor", "detective"].includes(c.role));
      powersAct(cs); for (const c of sleepers) c.emit("act", { hunch: living(c.st)[0] });
      assert(await wait(() => cs.every((c) => c.st.phase === "day")), "S1: no day");
      assert(cs[0].st.readyNeed === 5 && cs[0].st.readyCount === 0, "S1: need 5 / count 0, got " + cs[0].st.readyNeed + "/" + cs[0].st.readyCount);
      for (let k = 0; k < 4; k++) cs[k].emit("ready", {});
      assert(await wait(() => cs[4].st.readyCount === 4), "S1: count did not reach 4");
      assert(cs[4].st.phase === "day" && cs[4].st.players.filter((p) => p.ready).length === 4 && !cs[4].st.players[cs[4].seat].ready, "S1: ready flags wrong");
      cs[3].emit("ready", { on: false }); assert(await wait(() => cs[4].st.readyCount === 3), "S1: taking it back failed");
      cs[3].emit("ready", { on: true }); await wait(() => cs[4].st.readyCount === 4);
      const t0 = Date.now(); cs[4].emit("ready", {});
      assert(await wait(() => cs.every((c) => c.st.phase === "vote"), 1500), "S1: the vote did not start when everyone was ready");
      assert(Date.now() - t0 < 500 && cs[0].st.log === "Everyone is ready. Time to vote. Tap a player, or skip.", "S1: slow or wrong log: " + cs[0].st.log);
      assert(cs[0].st.readyNeed === 0 && cs[0].st.players.every((p) => !p.ready), "S1: ready must clear with the day");
      console.log("PASS worlds: S1 the day ends the moment every living human is ready (" + (Date.now() - t0) + " ms), not before (4 of 5 wait), can be taken back, clears with the day, ignored at night");
      cs.forEach((c) => c.disconnect());
    }
    for (let attempt = 1; attempt <= 6; attempt++) {   // bots never hold it up; a dropped human never holds it up (retried until both humans live to see day 1)
      const cs = await boot("b" + attempt, 2, 3, ALLCAPS);
      const tgt = () => { const st = cs[0].st; return living(st).find((i) => !cs.some((c) => c.seat === i)) ?? living(st)[0]; };
      // play the night: humans act as their role allows; bots act by themselves
      for (const c of cs) { if (c.role === "mafia") c.emit("act", { kill: tgt() }); else if (c.role === "doctor") c.emit("act", { save: tgt() }); else if (c.role === "detective") c.emit("act", { probe: living(c.st).find((i) => i !== c.seat) }); else c.emit("act", { hunch: tgt() }); }
      if (!(await wait(() => cs[0].st.phase === "day" || cs[0].st.status === "over", NIGHT + 2000))) throw new Error("S1: no day with bots");
      // read who lives from the day frame itself: the other client may not have received it yet
      if (cs[0].st.status === "playing" && cs[0].st.phase === "day" && cs.every((c) => cs[0].st.players[c.seat].alive)) {
        assert(cs[0].st.readyNeed === 2, "S1: bots must not count: need " + cs[0].st.readyNeed);
        cs[1].disconnect(); await wait(() => cs[0].st.readyNeed === 1, 2000);
        const t0 = Date.now(); cs[0].emit("ready", {});
        assert(await wait(() => cs[0].st.phase === "vote", 1500) && Date.now() - t0 < 600, "S1: one human plus bots and a dropped human: ready should start the vote");
        console.log("PASS worlds: S1 bots and a dropped human never hold the vote up (need 2 -> 1 after the drop; attempt " + attempt + ")");
        cs.forEach((c) => c.disconnect());
        break;
      }
      cs.forEach((c) => c.disconnect());
      assert(attempt < 6, "S1: six games in a row lost a human on night 1");
    }
    // ================= robustness: null payloads, the flood guard =================
    {
      const EVENTS = ["create", "join", "claim", "settings", "addBot", "removeBot", "start", "act", "vote", "ready", "takeSeat", "pushToken", "presence", "chat", "voice", "rematch", "leave"];
      const x = mk("nul"); await wait(() => x.connected);
      for (const ev of EVENTS) { x.emit(ev, null); x.emit(ev, 7); x.emit(ev, "str"); x.emit(ev, [1, 2]); }
      await sleep(300);
      const y = mk("nul2"); await wait(() => y.connected);
      y.emit("create", { name: "After", playerId: "nuly" + Math.random() });
      assert(await wait(() => y.st && y.st.status === "lobby", 3000), "null payloads: the server stopped answering");
      const n0 = y.frames.length;
      for (let k = 0; k < 300; k++) y.emit("settings", { voteRule: k % 2 ? "majority" : "plurality" });
      await sleep(700);
      const got = y.frames.length - n0;
      assert(got >= 30 && got <= 60, "flood guard: 300 settings in a burst gave " + got + " frames (expected about 40)");
      await sleep(1100); y.emit("settings", { jester: true });
      assert(await wait(() => y.st.roles.jester === true, 1500), "flood guard: the socket must be heard again after a pause");
      console.log("PASS worlds: null, number, string and array payloads on all " + EVENTS.length + " events leave the server running (it used to stop on 42[\"join\",null]); a 300-event burst from one socket reaches its room as " + got + " frames, then it is heard again");
      x.disconnect(); y.disconnect();
    }
    // ================= QA notes =================
    {
      const a = mk("qa"); await wait(() => a.connected);
      a.emit("join", { code: "ZZZZZZ", name: "A", playerId: "nobody" });
      assert(await wait(() => a.errs.length === 1) && a.errs[0] === "No room with that code." && a.errCodes[0] === "not_found" && a.refusals[0].code === "not_found", "GN-05: not_found");
      const pid = "qaA" + Math.random();
      a.emit("create", { name: "😀".repeat(10), playerId: pid, avatar: "👩‍🚀" });
      assert(await wait(() => a.st && a.joinedMsgs.length === 1), "create failed");
      assert(a.st.players[0].name === "😀".repeat(9) && a.st.players[0].avatar === "👩‍🚀", "GN-30: name/avatar " + a.st.players[0].name + " " + a.st.players[0].avatar);
      const code = a.st.code, secret = a.joinedMsgs[0].secret;
      assert(/^[0-9a-f]{24}$/.test(secret), "GN-26: no secret in joined");
      a.emit("start"); assert(await wait(() => a.errCodes.includes("not_enough_players")), "GN-05: not_enough_players");
      for (let i = 0; i < 4; i++) a.emit("addBot");
      await wait(() => a.st.players.length === 5);
      // second socket for the same player, then the old one drops: still connected
      const a2 = mk("qa2"); await wait(() => a2.connected);
      a2.emit("join", { code, playerId: pid });   // bare rejoin: fine while unlocked (today's app)
      assert(await wait(() => a2.st && a2.st.code === code), "GN-26: an unlocked seat refused a bare rejoin");
      a.disconnect(); await sleep(300);
      assert(a2.st.players[0].connected === true, "second socket: the seat went disconnected while its new socket is live");
      a2.emit("claim", { secret }); await sleep(100);
      const thief = mk("th"); await wait(() => thief.connected);
      thief.emit("join", { code, playerId: pid, name: "T" });
      assert(await wait(() => thief.errs.length === 1) && thief.errCodes[0] === "seat_locked", "GN-26: a claimed seat took a bare join");
      // a wrong secret as long as the right one but not ASCII (more bytes than units) is refused, not a thrown handler
      thief.emit("join", { code, playerId: pid, secret: "\u00e9".repeat(24) });
      assert(await wait(() => thief.errs.length === 2) && thief.errCodes[1] === "seat_locked", "GN-26: a same-length non-ASCII secret must be refused with seat_locked");
      thief.emit("join", { code, playerId: pid, secret });
      assert(await wait(() => thief.st && thief.st.code === code), "GN-26: the right secret must get the seat");
      // started / full
      a2.emit("start"); await wait(() => a2.st.status === "playing");
      const late = mk("late"); await wait(() => late.connected);
      late.emit("join", { code, name: "L", playerId: "late" + Math.random() });
      assert(await wait(() => late.errs.length === 1) && late.errCodes[0] === "started" && late.errs[0] === "That game already started.", "GN-05: started");
      const f = mk("f0"); await wait(() => f.connected);
      let fcode = null; f.once("joined", (j) => (fcode = j.code)); f.emit("create", { name: "F", playerId: "f0" + Math.random() }); await wait(() => fcode);
      for (let i = 0; i < 11; i++) f.emit("addBot");
      await wait(() => f.st.players.length === 12);
      const g = mk("g"); await wait(() => g.connected);
      g.emit("join", { code: fcode, name: "G", playerId: "g" + Math.random() });
      assert(await wait(() => g.errs.length === 1) && g.errCodes[0] === "full" && g.errs[0] === "Room is full (12).", "GN-05: full");
      // GN-20: g joins a room, then creates another: it leaves the first
      const h = mk("h"); await wait(() => h.connected);
      let hcode = null; h.once("joined", (j) => (hcode = j.code)); h.emit("create", { name: "H", playerId: "hh" + Math.random() }); await wait(() => hcode);
      g.emit("join", { code: hcode, name: "G", playerId: "g2" + Math.random() }); await wait(() => h.st.players.length === 2);
      g.emit("create", { name: "G", playerId: "g3" + Math.random() });
      assert(await wait(() => g.st && g.st.code !== hcode), "GN-20: create from inside a room failed");
      assert(await wait(() => h.st.players[1].connected === false), "GN-20: the seat left behind still shows connected");
      const n0 = g.frames.filter((x) => x.code === hcode).length; h.emit("chat", { t: "still there?" }); await sleep(250);
      assert(g.frames.filter((x) => x.code === hcode).length === n0, "GN-20: the socket still hears its old room");
      console.log("PASS worlds: GN-05 refusal codes (not_found, not_enough_players, seat_locked, started, full), old texts unchanged; GN-26 secret, claim, bare rejoin while unlocked; GN-20 one room per socket; second socket keeps the seat; GN-30 on the wire; GN-48 serverNow; GN-07 ping 5 s + 5 s");
    }
  } finally { all.forEach((c) => { try { c.disconnect(); } catch (_) {} }); await srv.stop(); }
}

module.exports = { unit, sockets };
