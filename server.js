const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server, { path: BASE + "/socket.io", cors: { origin: true } });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 5;
const T = {
  reveal: Number(process.env.REVEAL_MS || 9000),
  night: Number(process.env.NIGHT_MS || 40000),
  day: Number(process.env.DAY_MS || 75000),
  vote: Number(process.env.VOTE_MS || 25000),
};
const BOT_MS = Math.max(1, Number(process.env.BOT_MS || 1200));

const rooms = new Map();
const roomSockets = new Map();
const timers = new Map();
const botTimers = new Map();

const newId = () => crypto.randomBytes(8).toString("hex");
const newCode = () => {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)];
  return rooms.has(c) ? newCode() : c;
};
const BOT_NAMES = ["Robo", "Chip", "Bolt", "Dicey", "Turbo", "Pixel", "Gizmo", "Widget", "Servo", "Nutmeg"];
const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);

function clearT(map, code) { const t = map.get(code); if (t) { clearTimeout(t); map.delete(code); } }
function deleteRoom(code) { clearT(timers, code); clearT(botTimers, code); rooms.delete(code); roomSockets.delete(code); }

function alive(room) { return room.players.filter((p) => !p.left && p.alive); }
function mafiaAlive(room) { return alive(room).filter((p) => p.role === "mafia"); }

function dealRoles(room) {
  const n = room.players.length;
  const nMafia = n >= 10 ? 3 : n >= 7 ? 2 : 1;
  const roles = ["detective", "doctor"];
  for (let i = 0; i < nMafia; i++) roles.push("mafia");
  while (roles.length < n) roles.push("villager");
  // Fisher-Yates with CSPRNG
  for (let i = roles.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  room.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; });
}

function setPhase(room, phase, ms) {
  room.phase = phase;
  room.phaseEndsAt = ms ? Date.now() + ms : null;
  clearT(timers, room.code);
  if (ms) timers.set(room.code, setTimeout(() => onPhaseTimeout(room.code), ms));
  scheduleBots(room);
}

function startGame(room) {
  dealRoles(room);
  room.day = 0;
  room.winner = null;
  room.nightActs = {};    // seat -> {kill|save|probe: targetSeat}
  room.votes = {};        // seat -> targetSeat | -1 (skip)
  room.probeLog = {};     // detectiveSeat -> [{t, mafia}]
  room.deaths = [];       // seats revealed (dead)
  room.chat = [];
  room.log = "Roles are dealt. Check yours — and keep it to yourself.";
  room.status = "playing";
  setPhase(room, "reveal", T.reveal);
}

function beginNight(room) {
  room.day++;
  room.nightActs = {};
  room.log = `Night ${room.day}. The town sleeps.`;
  setPhase(room, "night", T.night);
}

function nightDone(room) {
  const need = alive(room).filter((p) => p.role !== "villager");
  return need.every((p) => room.nightActs[seatOf(room, p)] != null);
}
function seatOf(room, p) { return room.players.indexOf(p); }

function resolveNight(room) {
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
  let msg;
  if (victim != null && victim !== saved && room.players[victim] && room.players[victim].alive) {
    const v = room.players[victim];
    v.alive = false;
    room.deaths.push(victim);
    msg = `Dawn breaks. ${v.name} was killed in the night — they were ${label(v.role)}.`;
  } else if (victim != null && victim === saved) {
    msg = "Dawn breaks. There was an attack — but the doctor got there first. Everyone lived.";
  } else {
    msg = "Dawn breaks. A quiet night. Everyone wakes up.";
  }
  room.log = msg;
  if (checkWin(room)) return;
  room.votes = {};
  setPhase(room, "day", T.day);
}

function beginVote(room) {
  room.votes = {};
  room.log = "Time to vote. Tap a player, or skip.";
  setPhase(room, "vote", T.vote);
}

function resolveVote(room) {
  const tally = {};
  let cast = 0;
  for (const [s, t] of Object.entries(room.votes)) {
    const voter = room.players[Number(s)];
    if (!voter || !voter.alive || voter.left) continue;
    cast++;
    if (t >= 0) tally[t] = (tally[t] || 0) + 1;
  }
  let best = 0; const top = [];
  for (const [s, c] of Object.entries(tally)) {
    if (c > best) { best = c; top.length = 0; top.push(Number(s)); }
    else if (c === best) top.push(Number(s));
  }
  const majorityNeeded = Math.floor(alive(room).length / 2) + 1;
  if (top.length === 1 && best >= Math.min(2, majorityNeeded)) {
    const out = room.players[top[0]];
    out.alive = false;
    room.deaths.push(top[0]);
    room.log = `The town has spoken. ${out.name} is out — they were ${label(out.role)}.`;
  } else {
    room.log = "No agreement. Nobody is voted out.";
  }
  if (checkWin(room)) return;
  beginNight(room);
}

function label(role) {
  return role === "mafia" ? "MAFIA" : role === "detective" ? "the Detective" : role === "doctor" ? "the Doctor" : "a Villager";
}

function checkWin(room) {
  const m = mafiaAlive(room).length;
  const o = alive(room).length - m;
  if (m === 0) { room.winner = "village"; }
  else if (m >= o) { room.winner = "mafia"; }
  if (room.winner) {
    room.status = "over";
    room.phase = "over";
    room.phaseEndsAt = null;
    clearT(timers, room.code); clearT(botTimers, room.code);
    room.log = room.winner === "village"
      ? "The last mafioso is gone. The village wins! All roles are revealed."
      : "The mafia now outnumber the town. Mafia wins! All roles are revealed.";
    return true;
  }
  return false;
}

function onPhaseTimeout(code) {
  const room = rooms.get(code);
  if (!room || room.status !== "playing") return;
  if (room.phase === "reveal") beginNight(room);
  else if (room.phase === "night") resolveNight(room);
  else if (room.phase === "day") beginVote(room);
  else if (room.phase === "vote") resolveVote(room);
  bump(room);
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
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    players: room.players.map((p, s) => ({
      name: p.name, avatar: p.avatar, bot: !!p.bot, left: p.left,
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
  st.chat = (room.chat || []).filter((m) => m.ch === "day" || me && (me.role === "mafia" || iAmDeadOrOver)).slice(-60);
  return st;
}

function bump(room) {
  room.v = (room.v || 0) + 1;
  room.touched = Date.now();
  sendState(room.code);
}
function sendState(code) {
  const room = rooms.get(code);
  const socks = roomSockets.get(code);
  if (!room || !socks) return;
  for (const s of socks) {
    const seat = room.players.findIndex((p) => p.id === s.data.playerId);
    s.emit("state", { room: stateFor(room, seat), mySeat: seat, v: room.v });
  }
}

/* ---------- bots ---------- */
function addBotTo(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const used = room.players.map((q) => q.name);
  const name = BOT_NAMES.find((n) => !used.includes(n)) || "Bot" + (room.players.length + 1);
  const p = { id: "bot_" + newId(), name, avatar: "\u{1F916}", bot: true, left: false, connected: true, alive: true, role: null };
  room.players.push(p);
  return p;
}
function scheduleBots(room) {
  clearT(botTimers, room.code);
  if (room.status !== "playing") return;
  botTimers.set(room.code, setTimeout(() => botsAct(room.code), BOT_MS + crypto.randomInt(BOT_MS)));
}
function botsAct(code) {
  const room = rooms.get(code);
  if (!room || room.status !== "playing") return;
  const livingSeats = room.players.map((p, s) => (p.alive && !p.left ? s : -1)).filter((s) => s >= 0);
  const pick = (arr) => arr[crypto.randomInt(arr.length)];
  let acted = false;
  for (const p of room.players) {
    const s = seatOf(room, p);
    if (!p.bot || !p.alive || p.left) continue;
    if (room.phase === "night" && p.role !== "villager" && !room.nightActs[s]) {
      if (p.role === "mafia") {
        const targets = livingSeats.filter((t) => room.players[t].role !== "mafia");
        if (targets.length) room.nightActs[s] = { kill: pick(targets) };
      } else if (p.role === "doctor") {
        room.nightActs[s] = { save: pick(livingSeats) };
      } else if (p.role === "detective") {
        const targets = livingSeats.filter((t) => t !== s);
        room.nightActs[s] = { probe: targets.length ? pick(targets) : s };
      }
      acted = true;
    }
    if (room.phase === "vote" && room.votes[s] === undefined) {
      let targets = livingSeats.filter((t) => t !== s);
      if (p.role === "mafia") targets = targets.filter((t) => room.players[t].role !== "mafia");
      room.votes[s] = targets.length && crypto.randomInt(4) > 0 ? pick(targets) : -1;
      acted = true;
    }
  }
  if (room.phase === "night" && nightDone(room)) { resolveNight(room); bump(room); return; }
  if (room.phase === "vote" && alive(room).every((p) => room.votes[seatOf(room, p)] !== undefined)) { resolveVote(room); bump(room); return; }
  if (acted) bump(room);
  scheduleBots(room);
}

/* ---------- sockets ---------- */
io.on("connection", (socket) => {
  socket.data.playerId = null;
  socket.data.code = null;
  const currentRoom = () => rooms.get(socket.data.code);
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

  socket.on("create", ({ name, playerId, avatar } = {}) => {
    name = clean(name, 18); if (!name) return socket.emit("err", "Pick a name first.");
    const code = newCode();
    const room = {
      code, status: "lobby", host: playerId, players: [], chat: [], log: "", v: 1,
      touched: Date.now(), voice: new Set(), phase: "lobby", phaseEndsAt: null,
      day: 0, winner: null, deaths: [], nightActs: {}, votes: {}, probeLog: {},
    };
    room.players.push({ id: playerId, name, avatar: clean(avatar, 4) || "\u{1F642}", bot: false, left: false, connected: true, alive: true, role: null });
    rooms.set(code, room);
    socket.data.playerId = playerId;
    attach(code);
    socket.emit("joined", { code });
    bump(room);
  });

  socket.on("join", ({ code, name, playerId, avatar } = {}) => {
    code = clean(code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit("err", "No room with that code.");
    socket.data.playerId = playerId;
    const existing = room.players.find((p) => p.id === playerId);
    if (existing) { existing.connected = true; existing.left = false; attach(code); socket.emit("joined", { code }); bump(room); return; }
    if (room.status !== "lobby") return socket.emit("err", "That game already started.");
    if (room.players.length >= MAX_PLAYERS) return socket.emit("err", "Room is full (12).");
    name = clean(name, 18); if (!name) return socket.emit("err", "Pick a name first.");
    room.players.push({ id: playerId, name, avatar: clean(avatar, 4) || "\u{1F642}", bot: false, left: false, connected: true, alive: true, role: null });
    attach(code);
    socket.emit("joined", { code });
    room.log = `${name} joined.`;
    bump(room);
  });

  socket.on("addBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    const b = addBotTo(room);
    if (b) { room.log = `${b.name} (bot) joined.`; bump(room); }
  });
  socket.on("removeBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    for (let i = room.players.length - 1; i >= 0; i--) if (room.players[i].bot) { room.players.splice(i, 1); break; }
    bump(room);
  });

  socket.on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    if (room.players.length < MIN_PLAYERS) return socket.emit("err", `Mafia needs at least ${MIN_PLAYERS} players — add bots to fill.`);
    startGame(room);
    bump(room);
  });

  socket.on("act", ({ kill, save, probe } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "night") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    const me = room.players[seat];
    if (!me || !me.alive || me.left) return;
    const t = kill ?? save ?? probe;
    if (!Number.isInteger(t) || !room.players[t] || !room.players[t].alive) return;
    if (me.role === "mafia" && kill != null && room.players[t].role !== "mafia") room.nightActs[seat] = { kill: t };
    else if (me.role === "doctor" && save != null) room.nightActs[seat] = { save: t };
    else if (me.role === "detective" && probe != null && t !== seat) room.nightActs[seat] = { probe: t };
    else return;
    if (nightDone(room)) resolveNight(room);
    bump(room);
  });

  socket.on("vote", ({ target } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "vote") return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    const me = room.players[seat];
    if (!me || !me.alive || me.left) return;
    if (target === -1) room.votes[seat] = -1;
    else if (Number.isInteger(target) && room.players[target] && room.players[target].alive && target !== seat) room.votes[seat] = target;
    else return;
    if (alive(room).every((p) => room.votes[seatOf(room, p)] !== undefined)) resolveVote(room);
    bump(room);
  });

  socket.on("chat", ({ t } = {}) => {
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
    room.chat.push({ n: me.name, a: me.avatar, t, ch, s: seat });
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
    bump(room);
  });

  socket.on("voice", ({ kind, to, data } = {}) => {
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

  socket.on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
    room.players = room.players.filter((p) => !p.left);
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
    if (!p) return detach();
    if (room.voice) { const s = room.players.indexOf(p); room.voice.delete(s); }
    if (room.status === "lobby") {
      room.players = room.players.filter((q) => q.id !== p.id);
      if (room.players.length === 0 || room.players.every((q) => q.bot)) { detach(); deleteRoom(room.code); return; }
      if (room.host === p.id) room.host = (room.players.find((q) => !q.bot) || room.players[0]).id;
      room.log = `${p.name} left.`;
    } else {
      p.left = true; p.connected = false;
      const wasAlive = p.alive;
      p.alive = false;
      if (room.players.every((q) => q.bot || q.left)) { detach(); deleteRoom(room.code); return; }
      if (room.host === p.id) room.host = (room.players.find((q) => !q.bot && !q.left) || room.players[0]).id;
      room.log = `${p.name} left the game.`;
      if (room.status === "playing" && wasAlive) {
        if (!checkWin(room)) {
          if (room.phase === "night" && nightDone(room)) resolveNight(room);
          if (room.phase === "vote" && alive(room).every((q) => room.votes[seatOf(room, q)] !== undefined)) resolveVote(room);
        }
      }
    }
    detach();
    bump(room);
  }
  socket.on("leave", () => handleLeave());
  socket.on("disconnect", () => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p) {
      p.connected = false;
      if (room.voice) room.voice.delete(room.players.indexOf(p));
      room.v++;
    }
    detach();
    if (rooms.has(room.code)) sendState(room.code);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.touched > 2 * 60 * 60 * 1000) deleteRoom(code);
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log("Mafia Rooms running on port " + PORT));
