const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const Reactions = require("./reactions");   // the cartoon stickers (2026-10-15)
const Quick = require("./quickmatch");   // Quick Play: 2.5 s to find people, bots fill the empty seats (2026-11-01; the file every server shares)
const Plus = require("./plus");   // GameNest Plus: the room's flag and each player's look (2026-10-16)
const Moderation = require("./moderation");
const BotTalk = require("./bot_talk");   // the bots talk about the game (2026-10-18)   // what players type, kept friendly (2026-10-18)
const Pick = require("./rolepick");   // the role pick (2026-11-13): a lobby ask for one role, each role's seats going first to its askers

const app = express();
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
/* GN-07/T9: notice a dead link in about 10 s instead of socket.io's 45 s (25 s + 20 s): a Wi-Fi handoff or a phone
   that slept shows as reconnecting sooner, and the app's watchdog (which reads these from the handshake) redials sooner. */
const PING_INTERVAL_MS = Math.max(1000, Number(process.env.PING_INTERVAL_MS || 5000));
const PING_TIMEOUT_MS = Math.max(1000, Number(process.env.PING_TIMEOUT_MS || 5000));
const EVENTS_PER_SEC = Math.max(1, Number(process.env.EVENTS_PER_SEC || 20));   // the flood guard (see on() below)
const EVENTS_BURST = Math.max(1, Number(process.env.EVENTS_BURST || 40));
const io = new Server(server, { path: BASE + "/socket.io", cors: { origin: true }, pingInterval: PING_INTERVAL_MS, pingTimeout: PING_TIMEOUT_MS });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 5;
const T = {
  reveal: Number(process.env.REVEAL_MS || 9000),
  night: Number(process.env.NIGHT_MS || 40000),
  day: Number(process.env.DAY_MS || 75000),
  vote: Number(process.env.VOTE_MS || 25000),
};
const T_BOT = {   // a room with bots in it: short reveal, short night, a 40 s day (all by env for tests)
  reveal: Number(process.env.REVEAL_BOT_MS || 5000),
  night: Number(process.env.NIGHT_BOT_MS || 22000),
  day: Number(process.env.DAY_BOT_MS || 40000),
  vote: Number(process.env.VOTE_BOT_MS || 18000),
};
const BOT_MS = Math.max(1, Number(process.env.BOT_MS || 1200));
/* A bot thinks before it acts (2026-11-01): a night move 1.5-4 s into the night, a vote 2-5.5 s into the vote, each its own time, and
   the thinking is logged ("bot_think", with how long). Test rooms (BOT_MS 5-20) think in proportion: THINK_SCALE is BOT_MS over its 1.2 s. */
const THINK_SCALE = Math.min(1, BOT_MS / 1200);
const THINK = { night: [1500, 4000], vote: [2000, 5500] };
const thinkMs = (kind) => Math.max(1, Math.round((THINK[kind][0] + crypto.randomInt(THINK[kind][1] - THINK[kind][0] + 1)) * THINK_SCALE));
const AFK_MS = Math.max(200, Number(process.env.AFK_MS || 5000));   // T1: the phase ends this soon once only disconnected players are still to act
const TIMEOUTS_TO_BOT = 3;                                              // consecutive missed phases before a bot takes the seat
/* What this server understands beyond the original protocol; a client shows a feature only when it is listed.
   ready: S1, "Ready to vote" ends the day early. hunch: S2, every living player makes a night choice, so dawn's
   timing never shows who holds a power. (A plain array: a frozen one slows JSON.stringify.) */
const FEATURES = ["ready", "hunch", "refusalCodes", "serverNow", "secret", "waitList", "reactions"];

/* One JSON line to the log for what is worth measuring afterwards (GN_EVENT_LOG=0 silences it): phase changes with why they ended,
   what the bots thought and for how long. */
const evlog = (ev, data) => { if (process.env.GN_EVENT_LOG !== "0" && !process.env.TEST_QUIET) console.log(JSON.stringify({ ev, game: "mafia", t: Date.now(), ...data })); };
/* Why the phase just ended, for the table to read ("Everyone voted"): why is "all" (everyone who had to act did), "ready" (everyone
   pressed Ready) or "time" (the clock). The state carries the last one as lastEnd until the next phase ends. */
const END_TEXT = {
  reveal: { all: "Everyone has seen their card", ready: "Everyone has seen their card", time: "Roles are set" },
  night: { all: "Everyone has acted", ready: "Everyone has acted", time: "The night is over" },
  day: { all: "Everyone is ready", ready: "Everyone is ready", time: "Time to vote" },
  vote: { all: "Everyone voted", ready: "Everyone voted", time: "Time's up" },
};
function endNote(room, why) {
  const t = (END_TEXT[room.phase] || {})[why] || null;
  if (!t) return;
  room.lastEnd = { phase: room.phase, day: room.day, why, text: t, at: Date.now() };
  evlog("phase_end", { room: room.code, day: room.day, phase: room.phase, why, ms: Date.now() - (room.phaseStartedAt || Date.now()) });
}

const rooms = new Map();
app.get("/internal/roster/:code", Plus.rosterHandler((code) => rooms.get(code)));   // who is at a table, for the wallet's Treat the room (404 without GN_INTERNAL_SECRET)
/* GameNest Plus: a player says on create and join that they own Plus; a room
   whose host owns it is a Plus room, and every client shows its extras.
   The client's word is taken for now (checking Apple's receipt is a later step). */
function stampPlus(code, socket, said) {
  const room = rooms.get(code);
  const p = room && socket && socket.data && room.players.find((q) => q.id === socket.data.playerId);
  if (p) { Plus.stampFor(p, said, socket); Plus.dedupe(room, p); }
}
const roomSockets = new Map();
const timers = new Map();
const botTimers = new Map();

const newId = () => crypto.randomBytes(8).toString("hex");
const newCode = () => {
  const A = "ABCDEFGHJKMNPRTWXYZ";
  let c = "";
  for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)];
  return rooms.has(c) ? newCode() : c;
};
const BOT_NAMES = ["Robo", "Chip", "Bolt", "Dicey", "Turbo", "Pixel", "Gizmo", "Widget", "Servo", "Nutmeg"];
/* GN-30: cut text to n UTF-16 units without splitting a character (an emoji, a flag, a family). Only the first
   n+8 units are segmented, so a 100 KB name costs no more than a short one. */
const SEG = typeof Intl === "object" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
function cutUnits(s, n) {
  if (s.length <= n) return s;
  if (!SEG) { let out = s.slice(0, n); if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1); return out; }
  let out = "";
  for (const { segment } of SEG.segment(s.slice(0, n + 8))) { if (out.length + segment.length > n) break; out += segment; }
  return out;
}
const clean = (s, n) => cutUnits(String(s || "").replace(/[<>]/g, "").trim(), n);
/* An avatar is one emoji. Up to 4 units as before; a longer single emoji (a ZWJ family, up to 32 units) is kept whole. */
function cleanAvatar(a) {
  const s = String(a || "").replace(/[<>]/g, "").trim();
  if (SEG && s.length > 4) { const first = SEG.segment(s.slice(0, 40)).containing(0); if (first && first.segment.length > 4 && first.segment.length <= 32) return first.segment; }
  return cutUnits(s, 4);
}
/* GN-26: a per-seat secret. It is issued in "joined"; once a join (or "claim") has presented it, every later join for that seat must. */
/* Compared as bytes: a string as long as the secret but not ASCII has more bytes, and timingSafeEqual throws on unequal lengths. */
const sameSecret = (a, b) => { if (typeof a !== "string" || typeof b !== "string") return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
/* GN-05: every refusal also says why in a machine-readable code (an extra "refusal" event, and a second argument on "err"). */
function refuse(socket, code, message) { socket.emit("refusal", { code, message }); socket.emit("err", message, { code }); }
/* Capabilities a client declares in create/join ("caps": ["ready", "hunch", ...]); today's app declares none. */
function applyCaps(p, caps) { if (!Array.isArray(caps)) return; p.caps = {}; for (const c of caps.slice(0, 16)) if (typeof c === "string" && c.length <= 24) p.caps[c] = true; }

function clearT(map, code) { const t = map.get(code); if (t) { clearTimeout(t); map.delete(code); } }
function deleteRoom(code) { clearT(timers, code); clearT(botTimers, code); rooms.delete(code); roomSockets.delete(code); }

function alive(room) { return room.players.filter((p) => !p.left && p.alive); }
function mafiaAlive(room) { return alive(room).filter((p) => p.role === "mafia"); }

/* T16: 1 Shadow at 5–7, 2 at 8–10, 3 at 11–12; optional Jester and Mayor when the host turns them on */
/* GameNest Plus's Bodyguard (2026-10-17), a Plus room's optional role: each night they guard someone else; an attack on
   that player, the Doctor's save aside, takes the Bodyguard instead. */
const NIGHT_ROLES = ["mafia", "doctor", "detective", "bodyguard"];
function mafiaCountFor(n) { return n >= 11 ? 3 : n >= 8 ? 2 : 1; }
function rolesFor(n, opts) {
  const roles = ["detective", "doctor"];
  for (let i = 0; i < mafiaCountFor(n); i++) roles.push("mafia");
  if (opts && opts.jester && roles.length < n) roles.push("jester");
  if (opts && opts.mayor && roles.length < n) roles.push("mayor");
  if (opts && opts.bodyguard && roles.length < n) roles.push("bodyguard");
  while (roles.length < n) roles.push("villager");
  return roles;
}
/* The finalized settings a deal may use: only what the host switched ON in this room (a Bodyguard only in a Plus room).
   Nothing else (a stale flag, a client's guess) can put a role in the deck. */
function finalSettings(room) {
  const r = room.roles || {};
  return { jester: r.jester === true, mayor: r.mayor === true, bodyguard: r.bodyguard === true && Plus.isPlusRoom(room) };
}
/* The deck for n seats from those settings, checked: exactly n cards, no role the settings leave out, at most one of each
   optional role, the right number of Shadows. Throws on a deck that breaks any of it (the deal must never go ahead). */
function buildDeck(n, opts) {
  const roles = rolesFor(n, opts);
  const count = {};
  for (const r of roles) count[r] = (count[r] || 0) + 1;
  if (roles.length !== n) throw new Error(`deck has ${roles.length} cards for ${n} seats`);
  for (const r of ["jester", "mayor", "bodyguard"]) {
    if ((count[r] || 0) > 1 || ((count[r] || 0) > 0 && !(opts && opts[r]))) throw new Error(`deck holds ${r} that the settings do not allow`);
  }
  if ((count.mafia || 0) !== mafiaCountFor(n) || count.detective !== 1 || count.doctor !== 1) throw new Error("deck is missing a core role");
  return { roles, count };
}
function dealRoles(room) {
  const seats = room.players.filter((p) => !p.left);
  const settings = finalSettings(room);
  const { roles, count } = buildDeck(seats.length, settings);
  /* The role pick (2026-11-13): each role's seats go first to those who asked for it, by lot when they are more than the
     seats. Their cards leave the deck; the rest is shuffled and dealt as ever, so a table where nobody asked is dealt
     exactly as before. Who asked and who was drawn is on each asker's own seat (p.pk) and nowhere else. */
  const drawn = Pick.draw(seats, count, room.rolePicks !== false, crypto.randomBytes(4).toString("hex"));
  for (const role of drawn.values()) roles.splice(roles.indexOf(role), 1);
  // Fisher-Yates with CSPRNG
  for (let i = roles.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  room.players.forEach((p) => { p.alive = !p.left; p.role = null; });
  let next = 0;
  seats.forEach((p) => { p.role = drawn.has(p) ? drawn.get(p) : roles[next++]; });
  room.deck = { n: seats.length, count, settings };   // what was dealt, public to the table (the roles in play, never who holds them)
}
/* The seat count of each role that can be asked for: in the lobby the deck for the seats as they stand (never fewer than
   the game's minimum, which a short lobby is filled to before it deals), once dealt what was dealt. */
function roleSeatsNow(room) {
  if (room.deck && room.status !== "lobby") return Pick.seats(room.deck.count);
  const n = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, room.players.filter((p) => !p.left).length));
  try { return Pick.seats(buildDeck(n, finalSettings(room)).count); } catch (_) { return {}; }
}
/* The role pick as one client sees it, after every older field: roleSeats for everyone; the host's switch and the player's
   own picks, ask and answer only for a seated player whose app said "rolepick". Nothing here names another player. */
function pickView(room, seat) {
  const me = room.players[seat];
  const view = { roleSeats: roleSeatsNow(room) };
  if (me && me.pk && me.pk.knows) { view.rolePicks = room.rolePicks === false ? "off" : "on"; view.rolePick = Pick.me(me.pk); }
  return view;
}
/* Bot rooms run to a brisker clock: the bots never need the long beats a table of people does. */
function hasBots(room) { return room.players.some((p) => p.bot && !p.left); }
function clock(room, key) {
  if (!hasBots(room)) return T[key];
  return Math.min(T[key], { reveal: T_BOT.reveal, night: T_BOT.night, day: T_BOT.day, vote: T_BOT.vote }[key]);
}

function setPhase(room, phase, ms) {
  room.phase = phase;
  room.phaseStartedAt = Date.now();
  for (const p of room.players) {   // when each bot (or bot-played seat) has thought it through
    const kind = phase === "vote" ? "vote" : phase === "night" && NIGHT_ROLES.includes(p.role) ? "night" : null;
    p.thinkKind = kind; p.thinkAt = kind ? Date.now() + thinkMs(kind) : 0;
  }
  room.phaseEndsAt = ms ? Date.now() + ms : null;
  clearT(timers, room.code);
  if (ms) timers.set(room.code, setTimeout(() => onPhaseTimeout(room.code), ms));
  scheduleBots(room);
}

function startGame(room) {
  dealRoles(room);
  room.day = 0;
  room.winner = null;
  room.winReason = null; room.lastEnd = null; room.voteHistory = [];
  room.nightActs = {};    // seat -> {kill|save|probe: targetSeat}
  room.votes = {};        // seat -> targetSeat | -1 (skip)
  room.probeLog = {};     // detectiveSeat -> [{t, mafia}]
  room.deaths = [];       // seats revealed (dead)
  room.chat = [];
  room.lastTally = {};    // T10: votes received on the last day (doctor's guide)
  room.mafiaPlan = null;
  room.hunches = {};      // S2: seat -> the seat a player chose at night without a power (no effect on the night)
  room.hunchLog = {};     // S2: seat -> [{day, t, took}] that player's own hunches, for their Secrets and a rejoin
  room.ready = {};        // S1: seat -> true, living humans who are ready to vote
  room.players.forEach((p) => { p.chatN = 0; p.accuseN = 0; p.selfSaves = 0; p.chatDay = -1; });
  room.log = "Roles are dealt. Check yours — and keep it to yourself.";
  room.status = "playing";
  setPhase(room, "reveal", clock(room, "reveal"));
}

function beginNight(room, why) {
  if (why && room.phase === "reveal") endNote(room, why);
  room.day++;
  room.ready = {};
  room.nightActs = {};
  room.hunches = {};
  room.log = `Night ${room.day}. The village sleeps.`;
  setPhase(room, "night", clock(room, "night"));
}

/* S2: a player whose client declared "hunch" owes a night choice too, whatever their role, so the night ends when
   the last living human has chosen and its timing never points at a power. Without the cap nothing changes. */
function owesHunch(p) { return !!(p.caps && p.caps.hunch) && !p.bot && !p.botControlled && !NIGHT_ROLES.includes(p.role); }
function owesNight(room, p) {
  const s = seatOf(room, p);
  if (NIGHT_ROLES.includes(p.role)) return room.nightActs[s] == null;
  return owesHunch(p) && !(room.hunches && room.hunches[s] != null);
}
function nightDone(room) {
  return alive(room).every((p) => !owesNight(room, p));
}
function seatOf(room, p) { return room.players.indexOf(p); }

/* T1 AFK policy helpers. "Pending" = alive humans who still owe an action in this phase. */
function pendingActors(room) {
  if (room.phase === "night") return alive(room).filter((p) => !p.bot && !p.botControlled && owesNight(room, p));
  if (room.phase === "vote") return alive(room).filter((p) => !p.bot && !p.botControlled && room.votes[seatOf(room, p)] === undefined);
  return [];
}
/* Once everyone still to act is disconnected, the phase ends within AFK_MS instead of the full clock. */
function refreshAfkClock(room) {
  if (room.status !== "playing" || !["night", "vote"].includes(room.phase)) return;
  const pend = pendingActors(room);
  if (!pend.length || pend.some((p) => p.connected)) return;
  const soon = Date.now() + AFK_MS;
  if (room.phaseEndsAt && room.phaseEndsAt <= soon) return;
  room.phaseEndsAt = soon;
  clearT(timers, room.code);
  timers.set(room.code, setTimeout(() => onPhaseTimeout(room.code), AFK_MS));
}
/* T10: bots that play properly. All state used here is internal (chatN / accuseN per player, lastTally per day). */
const BOT_LINES = {
  villager: ["Quiet night. Too quiet.", "Who was last to vote yesterday?", "I'm just a villager, promise.", "Someone's lying and it isn't me.", "Let's not rush this.", "Anyone else notice who went silent?", "I trust nobody right now.", "Follow the votes, they don't lie.", "If I'm wrong, vote me out tomorrow.", "Think. Who benefits?"],
  mafia: ["I was asleep, honest.", "We should vote together or we lose.", "Whoever's quiet is suspicious.", "Not me. Look elsewhere.", "I'll go with the majority.", "This is getting tense.", "Someone is steering this. Who?", "Let's stop guessing and vote.", "I've got a feeling about someone.", "Doctor, if you're out there, nice work."],
  doctor: ["Rough night for somebody.", "I'm keeping an eye on the quiet ones.", "Don't waste the vote today.", "We need to be careful here.", "Who's pushing hardest? That's a tell.", "I'll follow the evidence.", "Stay calm, count the votes.", "Let's hear from everyone first.", "Nobody skip, please.", "One wrong vote and it's over."],
  detective: ["I've been paying attention.", "Some of you are too eager.", "Let me think this through.", "Patterns matter. Watch the votes.", "I'm not saying anything yet.", "Trust me on this one.", "Whoever flips first is worth a look.", "Hold your vote a second.", "The numbers don't add up.", "I might know something."],
};
const rnd = (arr) => arr[crypto.randomInt(arr.length)];
/* highest-scoring seats (ties kept) */
function topSeats(scoreOf, seats) {
  let best = -Infinity, top = [];
  for (const t of seats) { const v = scoreOf(t); if (v > best) { best = v; top = [t]; } else if (v === best) top.push(t); }
  return { best, top };
}
/* the seat the town is leaning towards right now (votes cast so far this vote phase), or null */
function crowdPick(room, exclude) {
  const tally = {};
  for (const [s, t] of Object.entries(room.votes || {})) { const v = room.players[Number(s)]; if (v && v.alive && !v.left && t >= 0 && t !== exclude) tally[t] = (tally[t] || 0) + 1; }
  const seats = Object.keys(tally).map(Number);
  if (!seats.length) return null;
  return rnd(topSeats((t) => tally[t], seats).top);
}
/* one night target for the whole mafia: an agreed pick if any mafia already chose, else the most active / most
   accusatory living non-mafia (ties broken once per night so every mafia bot lands on the same seat) */
function mafiaNightTarget(room, livingSeats) {
  for (const m of mafiaAlive(room)) { const a = room.nightActs[seatOf(room, m)]; if (a && a.kill != null && room.players[a.kill] && room.players[a.kill].alive) return a.kill; }
  if (room.mafiaPlan && room.mafiaPlan.day === room.day && room.players[room.mafiaPlan.target] && room.players[room.mafiaPlan.target].alive) return room.mafiaPlan.target;
  const targets = livingSeats.filter((t) => room.players[t].role !== "mafia");
  if (!targets.length) return null;
  /* the ones who threaten the Shadows (they named a mate, or pushed a mate's vote) first, then the most active */
  const cand = mafiaAlive(room)[0];
  const sus = cand ? BotTalk.suspicion(room, cand) : {};
  const score = (t) => (sus[t] || 0) + (room.players[t].chatN || 0) + 2 * (room.players[t].accuseN || 0);
  const target = rnd(topSeats(score, targets).top);
  room.mafiaPlan = { day: room.day, target };
  return target;
}
function botDecide(room, p) {
  const s = seatOf(room, p);
  const livingSeats = room.players.map((q, i) => (q.alive && !q.left ? i : -1)).filter((i) => i >= 0);
  if (room.phase === "night" && NIGHT_ROLES.includes(p.role) && !room.nightActs[s]) {
    if (p.role === "mafia") { const t = mafiaNightTarget(room, livingSeats); if (t != null) room.nightActs[s] = { kill: t }; }
    else if (p.role === "doctor") {
      const tally = room.lastTally || {};
      const accused = livingSeats.filter((t) => tally[t] > 0);
      let save = null;
      if (accused.length) {
        const ranked = accused.slice().sort((a, b) => tally[b] - tally[a] || a - b);
        for (const t of ranked) { if (t === s) { if ((p.selfSaves || 0) < 1) { p.selfSaves = (p.selfSaves || 0) + 1; save = t; break; } continue; } save = t; break; }
      }
      if (save == null) { const others = livingSeats.filter((t) => t !== s); save = others.length ? rnd(others) : s; }
      room.nightActs[s] = { save };
    }
    else if (p.role === "bodyguard") {
      // Guards the most accused (the likeliest target by day's talk), else anyone but themselves.
      const tally = room.lastTally || {};
      const others = livingSeats.filter((t) => t !== s);
      const accused = others.filter((t) => tally[t] > 0).sort((a, b) => tally[b] - tally[a] || a - b);
      if (others.length) room.nightActs[s] = { guard: accused.length ? accused[0] : rnd(others) };
    }
    else if (p.role === "detective") {
      const known = new Set((room.probeLog[s] || []).map((e) => e.t));
      const fresh = livingSeats.filter((t) => t !== s && !known.has(t));
      const targets = fresh.length ? fresh : livingSeats.filter((t) => t !== s);
      room.nightActs[s] = { probe: targets.length ? rnd(targets) : s };
    }
    return true;
  }
  if (room.phase === "vote" && room.votes[s] === undefined) {
    let targets = livingSeats.filter((t) => t !== s);
    if (p.role === "mafia") targets = targets.filter((t) => room.players[t].role !== "mafia");
    const P_FOLLOW = [30, 50, 70, 90][Math.min(Math.max((room.day || 1) - 1, 0), 3)];
    let vote;
    if (p.role === "detective") {
      const caught = (room.probeLog[s] || []).filter((e) => e.mafia && room.players[e.t] && room.players[e.t].alive).map((e) => e.t);
      if (caught.length) vote = caught[0];
    }
    if (vote === undefined && p.role === "mafia" && (room.day || 1) <= 2 && crypto.randomInt(4) === 0) {   // now and then a mafia votes a mate, so "never votes each other" is no tell
      const mates = livingSeats.filter((t) => t !== s && room.players[t].role === "mafia");
      if (mates.length) vote = rnd(mates);
    }
    const said = p.said && p.said.day === room.day ? p.said : null;
    if (vote === undefined && said) {   // what it said today it votes: the call it made in the chat, not a different one (unless the seat is gone)
      const mine = said.accused.filter((t) => targets.includes(t) && !said.cleared.includes(t));
      if (mine.length && crypto.randomInt(100) < 92) vote = mine[mine.length - 1];
    }
    if (said) targets = targets.filter((t) => !said.cleared.includes(t) || targets.length < 2);   // and never the one it vouched for
    if (vote === undefined) {
      const crowd = crowdPick(room, s);
      if (crowd != null && targets.includes(crowd) && (p.role === "detective" || crypto.randomInt(100) < P_FOLLOW)) vote = crowd;
    }
    if (vote === undefined) {   // no crowd to follow: the one that looks worst from the chat and the votes, not a dice roll
      const sus = BotTalk.suspicion(room, p);
      const scored = targets.filter((t) => sus[t] !== undefined);
      const top = scored.length ? BotTalk.bestOf(Object.fromEntries(scored.map((t) => [t, sus[t]]))) : null;
      vote = top != null ? top : targets.length ? rnd(targets) : -1;
    }
    room.votes[s] = vote;
    return true;
  }
  return false;
}
/* Bot talk: each day every talking bot gets 2-3 lines (by persona), staggered 2-4 s apart in a shuffled round robin, trimmed to
   the first 85% of the day; a person's line that names a bot (or, half the time, any line) also draws a reply 2-4 s later.
   Times scale down in test rooms whose day is short. Nobody speaks twice at once, and no line is a duplicate (bot_talk.js). */
const chatScale = (room) => Math.min(1, Math.max(0.002, (room.phaseEndsAt ? room.phaseEndsAt - room.phaseStartedAt : T.day) / 30000));
function planChatter(room) {
  const sc = chatScale(room), now = Date.now();
  const end = room.phaseStartedAt + (room.phaseEndsAt - room.phaseStartedAt) * 0.85;
  const bots = room.players.map((p, s) => ({ p, s })).filter((x) => x.p.bot && x.p.alive && !x.p.left);
  for (let i = bots.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [bots[i], bots[j]] = [bots[j], bots[i]]; }
  const items = [], placed = [];
  /* a time in [lo, hi], drawn at random, that is at least 0.8 s from every line already given (up to 24 draws; if the table is that crowded,
     the draw that was furthest from the rest), so nobody speaks over somebody and a bot's own gap stays inside its 2-9 s */
  const place = (lo, hi) => {
    let best = lo, bestD = -1;
    for (let k = 0; k < 24; k++) {
      const c = lo + crypto.randomInt(Math.max(1, Math.round(hi - lo)) + 1), d = placed.reduce((m, q) => Math.min(m, Math.abs(q - c)), Infinity);
      if (d > bestD) { best = c; bestD = d; }
      if (d >= 800 * sc) break;
    }
    placed.push(best); return best;
  };
  /* every bot has a timeline of its own: its first line 1.5-9 s into the day, each next one 2-9 s after the last, 2 or 3 lines by
     persona (the longest, 9 + 9 + 9 s, still ends inside the 85% of a 40 s day), so the table never talks in turns */
  const last = new Map();   // seat -> the time of its latest line (Infinity once it is out of day)
  for (let k = 0; k < 3; k++) for (const { s, p } of bots) {   // everyone's first line, then everyone's second, so the first ones are not pushed out by the later ones
    if (k >= BotTalk.personaOf(p).lines || last.get(s) === Infinity) continue;
    const prev = last.get(s);
    const t = k === 0 ? place(now + 1500 * sc, now + 9000 * sc) : place(prev + 2000 * sc, prev + 9000 * sc);
    if (t > end) { last.set(s, Infinity); continue; }
    items.push({ at: t, seat: s }); last.set(s, t);
  }
  items.sort((x, y) => x.at - y.at);
  room.chatPlan = { day: room.day, items, said: {}, started: now };
}
/* a person spoke: maybe a bot answers soon */
function queueReply(room, speakerSeat, text) {
  if (room.phase !== "day" || !room.chatPlan || room.chatPlan.day !== room.day) return;
  const sc = chatScale(room), now = Date.now();
  const bots = room.players.map((p, s) => ({ p, s })).filter((x) => x.p.bot && x.p.alive && !x.p.left && x.s !== speakerSeat);
  if (!bots.length) return;
  const named = bots.filter((x) => new RegExp("\\b" + x.p.name + "\\b", "i").test(text));
  const who = named.length ? named[0] : (crypto.randomInt(2) === 0 ? bots[crypto.randomInt(bots.length)] : null);
  if (!who) return;
  const pl = room.chatPlan;
  if (pl.items.some((i) => i.seat === who.s && i.reply && i.at > now)) return;
  pl.items.push({ at: now + (2000 + crypto.randomInt(2000)) * sc, seat: who.s, reply: true });
  pl.items.sort((x, y) => x.at - y.at);
}
const FORBIDDEN_POOL = BOT_NAMES.concat(["Ben", "Ava", "Finn", "Cleo", "Dan", "Gus"]);   // names that are only ever in a match when a player holds them
function botChatter(room) {
  if (room.phase !== "day") return false;
  if (!room.chatPlan || room.chatPlan.day !== room.day) planChatter(room);
  const now = Date.now(), pl = room.chatPlan;
  const i = pl.items.findIndex((x) => x.at <= now);
  if (i < 0) return false;
  const item = pl.items.splice(i, 1)[0];
  const p = room.players[item.seat];
  if (!p || !p.bot || !p.alive || p.left) return false;
  const seat = item.seat, d = BotTalk.draft(room, p);
  const safe = (t) => BotTalk.namesOk(room, t, FORBIDDEN_POOL);
  const put = (t) => {
    let said = d;   // what the bot meant by it (kept for its vote); a line swapped for a filler means nothing in particular
    if (!safe(t)) { t = rnd(BotTalk.LINES.filler); said = null; }
    room.chat.push({ n: p.name, a: p.avatar, t, ch: "day", s: seat, at: Date.now(), ...(said && said.y && Object.keys(said.y).length ? { y: said.y } : {}) });
    if (said) BotTalk.remember(room, p, said);
    p.chatN = (p.chatN || 0) + 1;
    evlog("bot_think", { room: room.code, day: room.day, seat, kind: "chat", intent: said ? said.intent : "filler", ms: Date.now() - (room.chatPlan ? room.chatPlan.started : room.phaseStartedAt) });
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
  };
  if (!d) {   // nothing of its own to say: one of the old canned lines not yet said this game, else silence
    const used = (room.usedLines = room.usedLines || new Set());
    const fresh = (BOT_LINES[p.role] || BOT_LINES.villager).filter((l) => !used.has(l));
    if (!fresh.length) return false;
    const line = rnd(fresh); used.add(line); put(line); return true;
  }
  if (!process.env.LLM_URL) { put(d.text); return true; }
  // A person's voice from the local model, if it keeps the meaning; said only while it is still that day.
  const code = room.code, day = room.day, everyone = room.players.filter((q) => !q.left).map((q) => q.name);
  BotTalk.say(d, p.name, everyone).then((t) => Moderation.chat(t)).then((t) => {
    const r = rooms.get(code);
    if (!r || r !== room || r.status !== "playing" || r.phase !== "day" || r.day !== day || !p.alive || p.left) return;
    put(t === Moderation.REMOVED ? d.text : t);
    bump(r);
  });
  return false;
}
/* The human acts (or reconnects): take the seat back from the bot and reset the timeout streak. */
function humanIsBack(room, p, reason) {
  const wasBot = !!p.botControlled;
  p.timeouts = 0;
  if (!wasBot) return false;
  p.botControlled = false;
  room.log = `${p.name} is back at the table${reason ? " (" + reason + ")" : ""}.`;
  return true;
}

function resolveNight(room, why = "all") {
  endNote(room, why);
  // mafia plurality
  const tally = {};
  for (const p of mafiaAlive(room)) {
    const a = room.nightActs[seatOf(room, p)];
    if (a && a.kill != null) tally[a.kill] = (tally[a.kill] || 0) + 1;
  }
  let victim = null, best = 0;
  const top = [];
  for (const [s, c] of Object.entries(tally)) {
    if (c > best) { best = c; top.length = 0; top.push(Number(s)); }
    else if (c === best) top.push(Number(s));
  }
  if (top.length) victim = top[crypto.randomInt(top.length)];
  // doctor save
  let saved = null;
  for (const p of alive(room)) {
    if (p.role === "doctor") {
      const a = room.nightActs[seatOf(room, p)];
      if (a && a.save != null) saved = a.save;
    }
  }
  // the Bodyguard's guard: an attack on that player, unsaved, takes the Bodyguard instead
  let guard = null;
  for (const p of alive(room)) {
    if (p.role === "bodyguard") {
      const a = room.nightActs[seatOf(room, p)];
      if (a && a.guard != null) guard = { by: seatOf(room, p), t: a.guard };
    }
  }
  if (victim != null && victim !== saved && guard && guard.t === victim && room.players[guard.by] && room.players[guard.by].alive) {
    const bg = room.players[guard.by];
    bg.alive = false;
    room.deaths.push(guard.by);
    room.guardFell = { by: guard.by, for: victim };
    victim = null;
    Reactions.event(room, guard.by, "bad", bump);
  }
  // detective result
  for (const p of alive(room)) {
    if (p.role === "detective") {
      const s = seatOf(room, p);
      const a = room.nightActs[s];
      if (a && a.probe != null && room.players[a.probe]) {
        (room.probeLog[s] = room.probeLog[s] || []).push({ t: a.probe, mafia: room.players[a.probe].role === "mafia" });
      }
    }
  }
  let msg, died = null;
  if (victim != null && victim !== saved && room.players[victim] && room.players[victim].alive) {
    const v = room.players[victim];
    v.alive = false;
    died = victim;
    room.deaths.push(victim);
    msg = `Dawn breaks. ${v.name} was killed in the night — they were ${label(v.role)}.`;
    Reactions.event(room, victim, "bad", bump);   // the bots' reactions (2026-10-15)
  } else if (room.guardFell && room.guardFell.for != null && victim == null) {
    const bg = room.players[room.guardFell.by], who = room.players[room.guardFell.for];
    died = room.guardFell.by;
    msg = `Dawn breaks. The Shadows came for ${who.name} — but ${bg.name}, the Bodyguard, stepped in and fell instead.`;
    room.guardFell = null;
  } else if (victim != null && victim === saved) {
    msg = "Dawn breaks. There was an attack — but the doctor got there first. Everyone lived.";
  } else {
    msg = "Dawn breaks. A quiet night. Everyone wakes up.";
  }
  room.log = msg;
  room.lastNight = { day: room.day, died, attacked: victim != null, saved: victim != null && victim === saved };   // for the bots' talk (the day after this night)
  for (const list of Object.values(room.hunchLog || {})) { const e = list[list.length - 1]; if (e && e.day === room.day) e.took = died; }   // S2: who the Shadows took (null: nobody died)
  if (checkWin(room)) return;
  room.votes = {};
  room.ready = {};
  setPhase(room, "day", clock(room, "day"));
}

function beginVote(room, log, why = "time") {
  endNote(room, why);
  room.votes = {};
  room.ready = {};
  room.log = log || "Time to vote. Tap a player, or skip.";
  setPhase(room, "vote", clock(room, "vote"));
}
/* S1: "Ready to vote". The day ends early once every living, connected human (bots and bot-played seats never
   hold it up) has pressed it; the day clock still ends it as before. */
function readyStatus(room, inReveal) {
  let need = 0, count = 0;
  if (room.status === "playing" && room.phase === (inReveal ? "reveal" : "day")) for (const p of alive(room)) {
    if (p.bot || p.botControlled || !p.connected) continue;
    need++;
    if (room.ready && room.ready[seatOf(room, p)]) count++;
  }
  return { need, count };
}
function maybeEndDay(room) {
  if (room.status !== "playing" || (room.phase !== "day" && room.phase !== "reveal")) return false;
  const { need, count } = readyStatus(room, room.phase === "reveal");
  if (!need || count < need) return false;
  if (room.phase === "reveal") { room.ready = {}; beginNight(room, "ready"); return true; }   // everyone has seen their card
  beginVote(room, "Everyone is ready. Time to vote. Tap a player, or skip.", "ready");
  return true;
}

function resolveVote(room, why = "all") {
  endNote(room, why);
  const tally = {};
  let cast = 0;
  for (const [s, t] of Object.entries(room.votes)) {
    const voter = room.players[Number(s)];
    if (!voter || !voter.alive || voter.left) continue;
    cast++;
    if (t >= 0) { tally[t] = (tally[t] || 0) + (voter.role === "mayor" ? 2 : 1); voter.accuseN = (voter.accuseN || 0) + 1; }   // T16: the Mayor's vote counts double
  }
  room.lastTally = tally;
  room.lastVotes = { day: room.day, votes: { ...room.votes }, tally, out: null };   // for the bots' talk tomorrow
  (room.voteHistory = room.voteHistory || []).push(room.lastVotes);   // and every day's after it: what a table did on day 1 is still known on day 4
  let best = 0; const top = [];
  for (const [s, c] of Object.entries(tally)) {
    if (c > best) { best = c; top.length = 0; top.push(Number(s)); }
    else if (c === best) top.push(Number(s));
  }
  // T2: "majority" (default) = more than half of the living players; "plurality" = most votes; ties never eliminate
  const rule = room.voteRule === "plurality" ? "plurality" : "majority";
  const needed = rule === "majority" ? Math.floor(alive(room).length / 2) + 1 : 1;
  if (top.length === 1 && best >= needed) {
    const out = room.players[top[0]];
    room.lastVotes.out = top[0];
    room.lastVotes.outRole = out.role;
    out.alive = false;
    room.deaths.push(top[0]);
    room.log = `The village has spoken. ${out.name} is out — they were ${label(out.role)}.`;
    Reactions.event(room, top[0], out.role === "jester" ? "win" : "bad", bump);
    if (out.role === "jester") {   // T16: the Jester wanted exactly this
      room.winner = "jester"; room.winReason = "jester";
      room.status = "over"; room.phase = "over"; room.phaseEndsAt = null;
      clearT(timers, room.code); clearT(botTimers, room.code);
      room.log = `The village has spoken. ${out.name} is out — they were the Jester, and that is exactly what they wanted. The Jester wins alone! All roles are revealed.`;
      return;
    }
  } else {
    room.log = "No agreement. Nobody is voted out.";
  }
  for (const p of room.players) {   // what each bot makes of everyone is kept for tomorrow (a half-life of a day), not worked out fresh
    if (!p.bot || p.left || !p.alive) continue;
    try { const base = BotTalk.suspicion(room, p, { noise: false }); p.mem = p.mem || {}; for (const [t, v] of Object.entries(base)) p.mem[t] = 0.5 * (p.mem[t] || 0) + 0.5 * v; } catch (e) { /* a bare room (a unit test's) has nothing to remember */ }
  }
  if (checkWin(room)) return;
  beginNight(room);
}

function label(role) {
  return role === "mafia" ? "a Shadow" : role === "detective" ? "the Detective" : role === "doctor" ? "the Doctor" : role === "jester" ? "the Jester" : role === "mayor" ? "the Mayor" : role === "bodyguard" ? "the Bodyguard" : "a Villager";
}

function checkWin(room) {
  const m = mafiaAlive(room).length;
  const o = alive(room).length - m;
  if (m === 0) { room.winner = "village"; room.winReason = "lastShadow"; }
  else if (m >= o) { room.winner = "mafia"; room.winReason = "shadowsMatch"; }
  if (room.winner) {
    const champ = room.players.findIndex((p) => p.alive && !p.left && (room.winner === "mafia") === (p.role === "mafia"));
    if (champ >= 0) Reactions.event(room, champ, "win", bump);
    room.status = "over";
    room.phase = "over";
    room.phaseEndsAt = null;
    clearT(timers, room.code); clearT(botTimers, room.code);
    room.log = room.winner === "village"
      ? "The last Shadow is gone. The village wins! All roles are revealed."
      : "The Shadows now match the village. The Shadows win! All roles are revealed.";
    return true;
  }
  return false;
}

function onPhaseTimeout(code) {
  const room = rooms.get(code);
  if (!room || room.status !== "playing") return;
  const notes = [];
  for (const p of pendingActors(room)) {            // humans who never acted this phase: play it for them
    p.timeouts = (p.timeouts || 0) + 1;
    if (p.timeouts >= TIMEOUTS_TO_BOT && !p.botControlled) { p.botControlled = true; notes.push(`A bot is playing for ${p.name} (missed ${TIMEOUTS_TO_BOT} in a row).`); }
    botDecide(room, p);
  }
  if (room.phase === "reveal") beginNight(room, "time");
  else if (room.phase === "night") resolveNight(room, "time");
  else if (room.phase === "day") beginVote(room, undefined, "time");
  else if (room.phase === "vote") resolveVote(room, "time");
  if (notes.length) room.log = `${notes.join(" ")} ${room.log || ""}`.trim();
  bump(room);
}

/* The optional roles as the table sees them: in the lobby the host's switches; once dealt, what was dealt. */
function dealtOrLobbyRoles(room) {
  const o = room.deck && room.status !== "lobby" ? room.deck.settings : finalSettings(room);
  return { jester: !!o.jester, mayor: !!o.mayor, ...(o.bodyguard ? { bodyguard: true } : {}) };
}
/* ---------- the outcome (NF1, 2026-11-01): one answer, from the server, to "who won, and did I?" ---------- */
const FACTION_NAME = { village: "Village", mafia: "Shadows", jester: "The Jester" };
const factionOf = (p) => (!p || !p.role ? null : p.role === "mafia" ? "mafia" : p.role === "jester" ? "jester" : "village");
const WIN_REASON = { lastShadow: "The last Shadow is gone.", shadowsMatch: "The Shadows now match the village.", jester: "The Jester got voted out, just as planned." };
/* the sizes of the sides (counts are public: the deal's counts), null in the lobby */
function teamsOf(room) {
  if (!room.deck || room.status === "lobby") return null;
  const c = room.deck.count || {};
  return { village: room.deck.n - (c.mafia || 0) - (c.jester || 0), shadows: c.mafia || 0, jester: c.jester || 0 };
}
/* What the result says to the player in `seat` (-1 for someone watching). The sides win together: a villager who was voted out
   still shares the village's win; a Shadow who is still alive still shares the village's defeat; the Jester wins alone.
   title/subtitle are the screen's words ("Victory" / "Defeat", "Village wins"); confetti is for a win only. */
function outcomeFor(room, seat) {
  const me = room.players[seat];
  const winner = room.winner, mine = factionOf(me);
  const you = !me ? "watch" : mine === winner ? "win" : "lose";
  const winners = [], losers = [];
  room.players.forEach((p, s) => { if (p.left) return; (factionOf(p) === winner ? winners : losers).push(s); });
  const winName = FACTION_NAME[winner] || "Nobody", verb = winner === "mafia" ? "win" : "wins";
  return {
    winner, winnerName: winName, you, faction: mine, factionName: FACTION_NAME[mine] || null,
    title: you === "win" ? "Victory" : you === "lose" ? "Defeat" : "Game over",
    subtitle: `${winName} ${verb}`,
    reason: WIN_REASON[room.winReason] || room.log || "",
    line: room.log || "",
    winners, losers,
    confetti: you === "win",   // a win and nothing else: a loser sees no trophy, no confetti
  };
}

/* ---------- per-player filtered state: the whole point ---------- */
function stateFor(room, seat) {
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
    roles: dealtOrLobbyRoles(room), mafiaCount: room.deck && room.status !== "lobby" ? room.deck.count.mafia : mafiaCountFor(room.players.filter((p) => !p.left).length),
    players: room.players.map((p, s) => ({
      name: p.name, avatar: p.avatar, ...Plus.seat(p), bot: !!p.bot, botControlled: !!p.botControlled, left: p.left,
      connected: p.connected, alive: p.alive !== false,
      voted: room.phase === "vote" ? room.votes[s] !== undefined : false,
      ready: room.phase === "day" && !!(room.ready && room.ready[s]),   // S1 (new)
    })),
    revealed,
    voteTally,
    voice: room.voice ? Array.from(room.voice) : [],
    yourRole: me ? me.role || null : null,
    yourVote: me && room.votes ? room.votes[seat] : undefined,
    yourAct: me && room.nightActs ? room.nightActs[seat] || null : null,
  };
  // mafia see each other + teammates' picks; the dead and the finished see everything they earned
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
  // chat: day channel for all; mafia channel only for mafia (or dead/over)
  st.chat = (room.chat || []).filter((m) => m.ch === "day" || me && (me.role === "mafia" || iAmDeadOrOver)).slice(-60)
    .map((m) => { if (!m.y) return m; const { y, ...rest } = m; return y[seat] != null ? { ...rest, t: y[seat] } : rest; });   // a bot's line that names this player says "you" to them (2026-11-01)
  // ---- new fields (2026-09); every field above (and mafiaSeats, mafiaPicks, probeLog, chat) keeps its name and meaning ----
  const rs = readyStatus(room);
  st.readyCount = rs.count;   // S1: living, connected humans who pressed "Ready to vote" ...
  st.readyNeed = rs.need;     // ... out of this many; the vote starts when they match (0 outside the day)
  st.yourHunch = me && room.phase === "night" && room.hunches && room.hunches[seat] != null ? room.hunches[seat] : null;   // S2
  if (me && room.hunchLog && room.hunchLog[seat] && room.hunchLog[seat].length) st.hunchLog = room.hunchLog[seat];      // S2: [{day, t, took}]
  st.deck = room.deck && room.status !== "lobby" ? { n: room.deck.n, count: room.deck.count } : null;   // the roles in play (counts), once dealt
  st.seats = room.players.filter((p) => !p.left).length;
  st.botRoom = hasBots(room);   // a room with bots runs the brisk clock
  st.features = FEATURES;
  st.serverNow = Date.now();  // GN-48: the server's clock, for phones whose clock is off
  Object.assign(st, Reactions.view(room));   // 2026-10-15: reactionsOn and the last reactions
  Object.assign(st, Quick.view(room));   // quick play (2026-11-01): quick { searching, seats, fillAt, now } while a quick room is finding people
  /* 2026-11-01 (after every old field): the sizes of the sides, why the last phase ended, and, once the game is over, the one
     outcome every result screen reads (outcomeFor). */
  st.teams = teamsOf(room);
  st.lastEnd = room.lastEnd || null;
  if (over) st.outcome = outcomeFor(room, seat);
  return st;
}

function bump(room) {
  room.v = (room.v || 0) + 1;
  room.touched = Date.now();
  // The role pick: a lobby that changed (a switch, a seat) drops the asks it no longer takes; each asker reads why in their own state.
  if (room.status === "lobby") Pick.prune(room.players, roleSeatsNow(room), room.rolePicks !== false);
  sendState(room.code);
}

/* ---------- GameNest push (optional; no-op without PUSH_URL) ----------
   The app registers a device token per socket and reports presence; players who are away or disconnected
   get a push when it becomes their turn / a new phase starts, and when someone writes in chat. */
const PUSH_URL = process.env.PUSH_URL || "";
const PUSH_TITLE = 'Nightfall';
function pushTo(p, body, data, collapse) {
  if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;
  if (!(p.away || !p.connected)) return;
  const now = Date.now(); if (p._lastPush && now - p._lastPush < 4000) return; p._lastPush = now;
  fetch(PUSH_URL + "/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }) }).catch(() => {});
}
function pushTurn(room) {   // called after every state broadcast; only fires when the situation changes
  const key = room.status + "|" + room.phase + "|" + (room.round || room.day || 0);
  if (room._pushKey === key) return; room._pushKey = key;
  if (room.status !== "playing") return;
  const text = room.phase === "write" ? "New prompt — write your answer" : room.phase === "vote" ? "Vote for the funniest answer" : room.phase === "night" ? "Night falls — check whether you have a move" : room.phase === "day" ? "Day breaks — time to argue and vote" : null;
  if (!text) return;
  for (const p of room.players) pushTo(p, text + " · room " + room.code, { code: room.code, game: PUSH_TITLE }, room.code + "-phase");
}

/* ---------- the waiting line (the owner, 2026-09-29) ----------
   Someone who joins a game already under way (and whose app says "waitList") waits in line,
   watching. Roles here are secret and dealt at the start, so nobody takes a seat mid-game. The rest are seated at the next game, bots making room if the table is full. */
function takeLeftSeats(room) {
  if (!false || !room.waiting || !room.waiting.length || room.status === "lobby" || room.status === "over") return false;
  let seated = false;
  for (let seat = 0; seat < room.players.length && room.waiting.length; seat++) {
    const old = room.players[seat];
    if (!old.left) continue;
    const w = room.waiting.shift();
    // The seat keeps its game (its place, its cards, its score); only who sits in it changes.
    room.players[seat] = Object.assign({}, old, { id: w.id, name: w.name, avatar: w.avatar, bot: false, botControlled: false,
      left: false, connected: true, plus: w.plus, acct: w.acct, look: w.look, timeouts: 0, pk: Pick.seat(w.caps, w.picks, w.pickSeen) });   // never the last sitter's picks
    room.log = `${w.name} took ${old.name}'s seat.`;
    seated = true;
  }
  return seated;
}
function seatTheLine(room) {
  while (room.waiting && room.waiting.length) {
    if (room.players.length >= MAX_PLAYERS) {
      const bot = room.players.findIndex((p) => p.bot);
      if (bot < 0) break;
      room.players.splice(bot, 1);
    }
    const w = room.waiting.shift();
    const seat = { id: w.id, name: w.name, avatar: w.avatar, bot: false, left: false, connected: true, plus: w.plus, acct: w.acct, look: w.look };
    seat.plus = w.plus;
    seat.pk = Pick.seat(w.caps, w.picks, w.pickSeen);   // the picks they said in the line
    room.players.push(seat);
  }
}
function lineState(room, st, playerId, seat) {
  st.waiting = (room.waiting || []).map((w) => ({ name: w.name, avatar: w.avatar }));
  st.waitPos = seat < 0 ? (room.waiting || []).findIndex((w) => w.id === playerId) + 1 : 0;
  return st;
}

function sendState(code) {
  const room = rooms.get(code);
  const socks = roomSockets.get(code);
  if (!room || !socks) return;
  for (const s of socks) stateTo(room, s);
  if (socks.size) try { pushTurn(room); } catch (_) {}   // once per broadcast (it was once per socket; it only fires on a change)
}
/* One socket's state. Its version is the room's plus the count of what this player alone was told (tellAlone). */
function stateTo(room, s) {
  const seat = room.players.findIndex((p) => p.id === s.data.playerId);
  const st = Object.assign(lineState(room, stateFor(room, seat), s.data.playerId, seat), pickView(room, seat));
  s.emit("state", { room: st, mySeat: seat, v: room.v + ((room.pv && room.pv.get(s.data.playerId)) || 0) });
}
/* Something only one player may know changed (their ask, their picks): the state goes to them alone. Their own version
   count goes on, so their app takes it as news; nobody else is sent a thing, not even a version number that skipped one. */
function tellAlone(room, playerId) {
  room.pv = room.pv || new Map();
  room.pv.set(playerId, (room.pv.get(playerId) || 0) + 1);
  room.touched = Date.now();
  const socks = roomSockets.get(room.code);
  if (socks) for (const s of socks) if (s.data.playerId === playerId) stateTo(room, s);
}

/* ---------- bots ---------- */
function addBotTo(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const used = room.players.map((q) => q.name);
  const name = BOT_NAMES.find((n) => !used.includes(n)) || "Bot" + (room.players.length + 1);
  const p = { id: "bot_" + newId(), name, persona: BotTalk.PERSONA_NAMES[crypto.randomInt(BotTalk.PERSONA_NAMES.length)], avatar: "\u{1F916}", bot: true, left: false, connected: true, alive: true, role: null };
  room.players.push(p);
  return p;
}
/* The next time a bot has something to do: when the first thinking bot is done, when the next line is due, else the old tick. */
function nextWake(room) {
  const now = Date.now();
  let wake = BOT_MS + crypto.randomInt(BOT_MS);
  for (const p of room.players) if ((p.bot || p.botControlled) && p.alive && !p.left && p.thinkAt > now) wake = Math.min(wake, p.thinkAt - now);
  const due = room.chatPlan && room.chatPlan.day === room.day && room.phase === "day" ? room.chatPlan.items[0] : null;
  if (due) wake = Math.min(wake, Math.max(0, due.at - now));
  return Math.max(15, wake);
}
function scheduleBots(room) {
  clearT(botTimers, room.code);
  if (room.status !== "playing") return;
  botTimers.set(room.code, setTimeout(() => botsAct(room.code), nextWake(room)));
}
function botsAct(code) {
  const room = rooms.get(code);
  if (!room || room.status !== "playing") return;
  let acted = false;
  const now = Date.now();
  for (const p of room.players) {
    if (!(p.bot || p.botControlled) || !p.alive || p.left) continue;
    if (p.thinkAt > now) continue;   // still thinking
    const was = p.thinkKind && ((room.phase === "night" && room.nightActs[seatOf(room, p)] == null) || (room.phase === "vote" && room.votes[seatOf(room, p)] === undefined));
    if (botDecide(room, p)) {
      acted = true;
      if (was) evlog("bot_think", { room: room.code, day: room.day, seat: seatOf(room, p), kind: room.phase, ms: now - room.phaseStartedAt });
    }
  }
  if (botChatter(room)) acted = true;
  if (room.phase === "night" && nightDone(room)) { resolveNight(room); bump(room); return; }
  if (room.phase === "vote" && alive(room).every((p) => room.votes[seatOf(room, p)] !== undefined)) { resolveVote(room); bump(room); return; }
  if (acted) bump(room);
  refreshAfkClock(room);
  scheduleBots(room);
}

/* ---------- sockets ---------- */

/* T3: the host seat follows the humans — first connected human, else first human still seated, else unchanged. */
function ensureHost(room) {
  const cur = room.players.find((p) => p.id === room.host);
  if (cur && !cur.bot && !cur.left && cur.connected) return false;
  const next = room.players.find((p) => !p.bot && !p.left && p.connected) || room.players.find((p) => !p.bot && !p.left);
  if (!next || next.id === room.host) return false;
  room.host = next.id;
  room.log = `${next.name} is now the host.`;
  return true;
}

/* No ladder for a party game: rated is off, so nothing is rated and no rating is kept; the quick-play half is what is used. */
Quick.init({ game: "mafia", model: "openskill", seats: 6, codeKey: "code", app, io, rooms, base: BASE, broadcast: sendState, rated: () => false });
io.on("connection", (socket) => {
  Plus.guardSocket(socket);   // the wallet's signed entitlement: every event's `plus` is the checked answer (the Nest Wallet repo, contrib/ROLLOUT.md)
  Quick.hook(socket); Quick.connection(socket);   // before the server's own events
  socket.data.playerId = null;
  socket.data.code = null;
  /* Every client event goes through here. A payload that is not an object (null, a number, a string) arrives as {}:
     "42[\"join\",null]" used to throw inside the handler's destructuring and stop the whole process, every room
     with it. A handler that still throws is logged and the server carries on. */
  /* A flood guard: each socket may send EVENTS_PER_SEC events a second on average, in bursts of EVENTS_BURST; the
     rest are dropped. No person or app comes near it, but one socket spamming votes or toggles made its whole room
     broadcast thousands of frames a second. Voice signalling (WebRTC offers and ICE candidates come in bursts) is exempt. */
  const bucket = { n: EVENTS_BURST, t: Date.now() };
  const on = (event, fn) => socket.on(event, (payload, ...rest) => {
    if (event !== "voice") {
      const now = Date.now();
      bucket.n = Math.min(EVENTS_BURST, bucket.n + (now - bucket.t) * EVENTS_PER_SEC / 1000); bucket.t = now;
      if (bucket.n < 1) return;
      bucket.n -= 1;
    }
    try { fn(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}, ...rest); }
    catch (e) { console.error(`[${new Date().toISOString()}] ${event} failed:`, e && e.stack || e); }
  });
  const currentRoom = () => rooms.get(socket.data.code);
  Reactions.wire({ on, room: currentRoom, me: () => socket.data.playerId, isHost: (r) => r.host === socket.data.playerId, bump });
  const attach = (code) => {
    socket.data.code = code;
    if (!roomSockets.has(code)) roomSockets.set(code, new Set());
    roomSockets.get(code).add(socket);
  };
  const detach = () => {
    const set = roomSockets.get(socket.data.code);
    if (set) set.delete(socket);
    socket.data.code = null;
  };
  const mySeat = () => { const r = currentRoom(); return r ? r.players.findIndex((p) => p.id === socket.data.playerId) : -1; };
  /* This socket stops being its player's connection to its room (disconnect, or GN-20: it moves to another room).
     The seat is marked disconnected only when no other socket of the same player is still in the room: a phone
     that reconnected on a new socket before the old one timed out stays connected. */
  const dropFromRoom = () => {
    const room = currentRoom();
    if (!room) { detach(); return; }
    const p = room.players.find((q) => q.id === socket.data.playerId);
    detach();
    if (!p) return;
    const set = roomSockets.get(room.code);
    if (set) for (const s of set) if (s.data.playerId === p.id) return;   // still here on another socket
    p.connected = false;
    if (room.voice) room.voice.delete(room.players.indexOf(p));
    ensureHost(room);
    room.v++;
    if (rooms.has(room.code)) { maybeEndDay(room); refreshAfkClock(room); sendState(room.code); }   // S1: the one still talking may have dropped
  };
  const moveTo = (code, playerId) => {   // GN-20: leave the room this socket was in before sitting in another
    if (socket.data.code && socket.data.code !== code) dropFromRoom();
    socket.data.playerId = playerId;
    attach(code);
  };
  const newSeat = (playerId, name, avatar, caps, picks, pickSeen) => {
    const p = { id: playerId, name, avatar: cleanAvatar(avatar) || "\u{1F642}", bot: false, left: false, connected: true, alive: true, role: null, secret: crypto.randomBytes(12).toString("hex") };
    applyCaps(p, caps);
    p.pk = Pick.seat(caps, picks, pickSeen);   // the role pick: what this app knows and owns
    return p;
  };

  on("create", ({ name, playerId, avatar, caps, plus, look, crew, picks, pickSeen } = {}) => {
    name = clean(name, 18); if (!name) return refuse(socket, "name_required", "Pick a name first."); name = Moderation.name(name);
    const code = Plus.crewCode({ plus, crew }, rooms, newCode);   // GameNest Plus's crew code (2026-10-17)
    const room = {
      code, status: "lobby", host: playerId, players: [], chat: [], log: "", v: 1,
      touched: Date.now(), voice: new Set(), phase: "lobby", phaseEndsAt: null,
      day: 0, winner: null, deaths: [], nightActs: {}, votes: {}, probeLog: {},
    };
    const me = newSeat(playerId, name, avatar, caps, picks, pickSeen);
    room.players.push(me);
    rooms.set(code, room);
    moveTo(code, playerId);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, secret: me.secret });
    bump(room);
  });

  on("join", ({ code, name, playerId, avatar, caps, secret, plus, look, picks, pickSeen } = {}) => {
    code = clean(code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room) return refuse(socket, "not_found", "No room with that code.");
    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      // GN-26: a seat whose secret has been presented once takes only joins that present it again
      if (existing.secretLocked && !sameSecret(secret, existing.secret)) return refuse(socket, "seat_locked", "That seat belongs to someone else.");
      if (sameSecret(secret, existing.secret)) existing.secretLocked = true;
      applyCaps(existing, caps);
      // The role pick: the app says again what it knows and owns (pickSeen keeps a pick spent in the same moment from counting twice).
      if (Array.isArray(caps)) { existing.pk = existing.pk || Pick.seat(caps); existing.pk.knows = Pick.knows(caps); Pick.take(existing.pk, picks, pickSeen); }
      existing.connected = true; existing.left = false; humanIsBack(room, existing, "reconnected");
      moveTo(code, playerId);
      stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, secret: existing.secret });
      if (room.phase === "night" && room.status === "playing" && nightDone(room)) resolveNight(room);   // S2: a rejoin without the hunch cap owes no hunch
      bump(room); return;
    }
    if (room.status === "lobby" && room.players.length >= MAX_PLAYERS) return refuse(socket, "full", "Room is full (12).");
    name = clean(name, 18); if (!name) return refuse(socket, "name_required", "Pick a name first."); name = Moderation.name(name);
    // A game under way: an app that knows the line waits in it; an older one hears the game has started.
    if (room.status !== "lobby") {
      if (!(Array.isArray(caps) && caps.includes("waitList"))) return refuse(socket, "started", "That game already started.");
      room.waiting = room.waiting || [];
      if (!room.waiting.some((q) => q.id === playerId)) {
        if (room.waiting.length >= MAX_PLAYERS) return refuse(socket, "full", "Room is full (12).");
        room.waiting.push({ id: playerId, name, avatar: String(avatar || "").slice(0, 16), plus: plus === true, acct: Plus.acctOf(socket), look: Plus.cleanLook(look), caps, picks, pickSeen });
        room.log = `${name} is waiting for a seat.`;
      }
      moveTo(code, playerId);
      socket.emit("joined", { code, waiting: true });
      takeLeftSeats(room);
      bump(room);
      return;
    }
    const me = newSeat(playerId, name, avatar, caps, picks, pickSeen);
    room.players.push(me);
    moveTo(code, playerId);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, secret: me.secret });
    room.log = `${name} joined.`;
    bump(room);
  });

  /* GN-26: lock the seat to its secret right away (otherwise the first rejoin that presents it locks it) */
  on("claim", ({ secret } = {}) => {
    const room = currentRoom(); if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p && sameSecret(secret, p.secret)) p.secretLocked = true;
  });

  /* The role pick (2026-11-13). `rolePick { role }` asks for one role for the next game, `rolePick { role: null }` takes it
     back; lobby only. It is answered to the asker alone (their own state, or a refusal): the room is told nothing. */
  on("rolePick", ({ role } = {}) => {
    const room = currentRoom(); if (!room) return;
    const me = room.players.find((q) => q.id === socket.data.playerId);
    if (!me || me.left || me.bot) return;
    const no = (message) => { socket.emit("refusal", { code: "rolepick", message, op: "rolePick" }); socket.emit("err", message, { code: "rolepick" }); };
    if (!me.pk || !me.pk.knows) return no(Pick.LINES.cap);
    if (room.status !== "lobby") return no(Pick.LINES.lobby);
    const why = Pick.ask(me.pk, role, room.rolePicks !== false, roleSeatsNow(room));
    if (why) return no(why);
    tellAlone(room, me.id);
  });
  /* The app says how many picks it owns (after a purchase, after taking a spent one off): { picks: n, pickSeen: "<game>" }. */
  on("pickStock", ({ picks, pickSeen } = {}) => {
    const room = currentRoom(); if (!room) return;
    const me = room.players.find((q) => q.id === socket.data.playerId);
    if (!me) { const w = (room.waiting || []).find((q) => q.id === socket.data.playerId); if (w) { w.picks = picks; w.pickSeen = pickSeen; } return; }
    if (me.left || me.bot || !Pick.take(me.pk, picks, pickSeen)) return;
    if (room.status === "lobby") Pick.prune([me], roleSeatsNow(room), room.rolePicks !== false);
    tellAlone(room, me.id);
  });

  on("settings", ({ voteRule, jester, mayor, bodyguard, rolePicks } = {}) => {   // T2: vote rule; T16: optional roles (host, lobby only)
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    // GameNest Plus's Bodyguard, a Plus room's only.
    if (typeof bodyguard === "boolean") {
      if (bodyguard && !Plus.isPlusRoom(room)) return refuse(socket, "plus", "The Bodyguard comes with GameNest Plus.");
      room.roles = room.roles || {};
      room.roles.bodyguard = bodyguard;
      room.log = bodyguard ? "The Bodyguard is in." : "No Bodyguard.";
    }
    if (voteRule === "majority" || voteRule === "plurality") {
      room.voteRule = voteRule;
      room.log = voteRule === "majority" ? "Vote rule: a true majority of the living is needed to eliminate." : "Vote rule: the most votes wins; ties spare everyone.";
    }
    if (typeof jester === "boolean" || typeof mayor === "boolean") {
      room.roles = room.roles || {};
      if (typeof jester === "boolean") room.roles.jester = jester;
      if (typeof mayor === "boolean") room.roles.mayor = mayor;
      room.log = `Optional roles: ${[room.roles.jester && "Jester", room.roles.mayor && "Mayor"].filter(Boolean).join(" + ") || "none"}.`;
    }
    // The role pick's switch (2026-11-13), on by default; off turns every ask away (bump drops the ones that stand). No log line: an older app is shown nothing new.
    if (rolePicks === true || rolePicks === "on") room.rolePicks = true;
    else if (rolePicks === false || rolePicks === "off") room.rolePicks = false;
    bump(room);
  });

  on("addBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    const b = addBotTo(room);
    if (b) { room.log = `${b.name} (bot) joined.`; bump(room); }
  });
  on("removeBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    for (let i = room.players.length - 1; i >= 0; i--) if (room.players[i].bot) { room.players.splice(i, 1); break; }
    bump(room);
  });

  /* Quick Play: the host's table is filled with bots up to `n` seats (6 by default, never fewer than the minimum) and the deal
     starts at once; the app counts 3 s first and offers "Start now". */
  on("quick", ({ n } = {}) => {
    const room = currentRoom();
    if (!room || room.quick || room.status !== "lobby" || room.host !== socket.data.playerId) return;   // a room quickmatch.js made fills itself, 2.5 s in
    const want = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Number.isInteger(n) ? n : 6));
    while (room.players.length < want) if (!addBotTo(room)) break;
    startGame(room);
    bump(room);
  });
  on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    if (room.players.length < MIN_PLAYERS) return refuse(socket, "not_enough_players", `Mafia needs at least ${MIN_PLAYERS} players — add bots to fill.`);
    startGame(room);
    bump(room);
  });

  on("act", ({ kill, save, probe, hunch } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "night") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    const me = room.players[seat];
    if (!me || !me.alive || me.left) return;
    humanIsBack(room, me, "took the seat back");
    if (kill == null && save == null && probe == null && hunch != null) {
      /* S2: a night choice with no effect, from any living player (themselves included as a target). The latest
         counts. For a player whose client declared "hunch" it is what the night waits for; a power holder's
         hunch is only recorded (their power is what counts for them). */
      if (!Number.isInteger(hunch) || !room.players[hunch] || !room.players[hunch].alive || room.players[hunch].left) return;
      room.hunches = room.hunches || {};
      room.hunches[seat] = hunch;
      const log = (room.hunchLog = room.hunchLog || {})[seat] = room.hunchLog[seat] || [];
      const last = log[log.length - 1];
      if (last && last.day === room.day) last.t = hunch; else log.push({ day: room.day, t: hunch });
      if (nightDone(room)) resolveNight(room); else refreshAfkClock(room);
      bump(room);
      return;
    }
    const t = kill ?? save ?? probe;
    if (!Number.isInteger(t) || !room.players[t] || !room.players[t].alive) return;
    if (me.role === "mafia" && kill != null && room.players[t].role !== "mafia") room.nightActs[seat] = { kill: t };
    else if (me.role === "doctor" && save != null) room.nightActs[seat] = { save: t };
    else if (me.role === "bodyguard" && save != null && t !== seat) room.nightActs[seat] = { guard: t };   // the app's protect, as the Doctor's
    else if (me.role === "detective" && probe != null && t !== seat) room.nightActs[seat] = { probe: t };
    else return;
    if (nightDone(room)) resolveNight(room); else refreshAfkClock(room);
    bump(room);
  });

  on("vote", ({ target } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "vote") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    const me = room.players[seat];
    if (!me || !me.alive || me.left) return;
    humanIsBack(room, me, "took the seat back");
    if (target === -1) room.votes[seat] = -1;
    else if (Number.isInteger(target) && room.players[target] && room.players[target].alive && target !== seat) room.votes[seat] = target;
    else return;
    if (alive(room).every((p) => room.votes[seatOf(room, p)] !== undefined)) resolveVote(room); else refreshAfkClock(room);
    bump(room);
  });
  /* S1: ready {on: true|false} ("on" defaults to true). A living human's "Ready to vote", by day only. */
  on("ready", ({ on } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || (room.phase !== "day" && room.phase !== "reveal")) return;
    const seat = mySeat();
    const me = room.players[seat];
    if (!me || !me.alive || me.left || me.bot) return;
    const back = humanIsBack(room, me, "took the seat back");
    room.ready = room.ready || {};
    const want = on !== false, was = !!room.ready[seat];
    if (want) room.ready[seat] = true; else delete room.ready[seat];
    if (maybeEndDay(room) || want !== was || back) bump(room);
  });
  on("takeSeat", () => {
    const room = currentRoom(); if (!room) return;
    const self = room.players.find((q) => q.id === socket.data.playerId);
    if (self && humanIsBack(room, self, "took the seat back")) bump(room);
  });
  on("pushToken", ({ token } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token; });
  on("presence", ({ away } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p) p.away = !!away; });


  on("chat", ({ t } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    const me = room.players[seat];
    if (!me || me.left) return;
    const now = Date.now();
    if (me._lastChat && now - me._lastChat < 700) return;
    me._lastChat = now;
    t = clean(t, 140); if (!t) return;
    if (room.status === "playing" && !me.alive) return; // the dead watch quietly
    let ch = "day";
    if (room.status === "playing" && room.phase === "night") {
      if (me.role !== "mafia") return;
      ch = "maf";
    }
    const code = room.code, pid = me.id, phase = room.status + ":" + room.phase;
    Moderation.chat(t).then((shown) => {
      // Still the phase it was said in, or it goes unsaid: a mafia's night line must never land in the day's chat.
      const room = rooms.get(code), seat = room ? room.players.findIndex((q) => q.id === pid) : -1, me = room && room.players[seat];
      if (!me || me.left || room.status + ":" + room.phase !== phase) return;
      if (room.status === "playing" && !me.alive) return;
      if (ch === "day") me.chatN = (me.chatN || 0) + 1;
      room.chat.push({ n: me.name, a: me.avatar, t: shown, ch, s: seat, at: Date.now() }); if (ch === "day") queueReply(room, seat, shown); for (const q of room.players) if (q !== me && (ch !== "maf" || q.role === "mafia")) pushTo(q, me.name + ": " + shown, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
      if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
      bump(room);
    });
  });

  on("voice", ({ kind, to, data } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0) return;
    if (kind === "join" || kind === "leave") {
      if (!room.voice) room.voice = new Set();
      if (kind === "join") room.voice.add(seat); else room.voice.delete(seat);
      bump(room);
      return;
    }
    if (kind === "signal" && Number.isInteger(to) && data) {
      let size = 0; try { size = JSON.stringify(data).length; } catch (e) { return; }
      if (size > 20000) return;
      const socks = roomSockets.get(room.code);
      if (!socks) return;
      for (const s of socks) {
        const sSeat = room.players.findIndex((p) => p.id === s.data.playerId);
        if (sSeat === to) s.emit("voice", { kind: "signal", from: seat, data });
      }
    }
  });

  on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
    room.players = room.players.filter((p) => !p.left);
    seatTheLine(room);
    room.players.forEach((p) => { p.alive = true; p.role = null; });
    if (room.players.filter((p) => !p.bot).length === 0) { deleteRoom(room.code); return; }
    if (room.players.length < MIN_PLAYERS) { room.status = "lobby"; room.phase = "lobby"; room.log = "Back to the lobby — need more players."; bump(room); return; }
    startGame(room);
    bump(room);
  });

  function handleLeave() {
    const room = currentRoom();
    if (!room) return detach();
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (!p) {
      // Out of the waiting line.
      const before = (room.waiting || []).length;
      room.waiting = (room.waiting || []).filter((w) => w.id !== socket.data.playerId);
      detach();
      if (room.waiting.length !== before) bump(room);
      return;
    }
    if (room.voice) { const s = room.players.indexOf(p); room.voice.delete(s); }
    if (room.status === "lobby") {
      room.players = room.players.filter((q) => q.id !== p.id);
      if (room.players.length === 0 || room.players.every((q) => q.bot)) { detach(); deleteRoom(room.code); return; }
      if (room.host === p.id) room.host = (room.players.find((q) => !q.bot) || room.players[0]).id;
      room.log = `${p.name} left.`;
    } else {
      p.left = true; p.connected = false;
      // The first in line takes the seat before anything is decided for want of players.
      const taken = takeLeftSeats(room);
      const wasAlive = p.alive;
      p.alive = false;
      if (room.players.every((q) => q.bot || q.left)) { detach(); deleteRoom(room.code); return; }
      if (room.host === p.id) room.host = (room.players.find((q) => !q.bot && !q.left) || room.players[0]).id;
      if (!taken) room.log = `${p.name} left the game.`;
      if (room.status === "playing" && wasAlive) {
        if (!checkWin(room)) {
          if (room.phase === "night" && nightDone(room)) resolveNight(room);
          if (room.phase === "vote" && alive(room).every((q) => room.votes[seatOf(room, q)] !== undefined)) resolveVote(room);
          if (room.phase === "day") maybeEndDay(room);   // S1: the one still talking may have left
        }
      }
    }
    detach();
    bump(room);
  }
  on("leave", () => handleLeave());
  socket.on("disconnect", () => dropFromRoom());
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.touched > 2 * 60 * 60 * 1000) deleteRoom(code);
}, 10 * 60 * 1000).unref();   // unref: a tool that only requires this file can exit

if (require.main === module) server.listen(PORT, () => console.log("Mafia Rooms running on port " + PORT));
module.exports = { pickView, roleSeatsNow, Pick, buildDeck, finalSettings, hasBots, clock, botDecide, botChatter, BOT_LINES, rolesFor, mafiaCountFor, resolveVote, dealRoles, label, stateFor, nightDone, pendingActors, readyStatus, resolveNight, cutUnits, clean, cleanAvatar, FEATURES, outcomeFor, teamsOf, planChatter, thinkMs, THINK, endNote };
