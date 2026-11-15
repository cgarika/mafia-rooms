/* The role pick (2026-11-13): in the lobby a player may ask for one role for the next game, with a pick they bought.

   The rules, all of them the server's (the app is never trusted with one):
     - what can be asked for is every special role the room deals as it stands (never "villager", which is "No pick");
     - a player with no pick cannot ask; a bot never asks; an app that does not say "rolepick" in its caps cannot ask
       and is sent nothing about it;
     - the host's switch (settings.rolePicks, on by default) turns every ask away;
     - on the deal each role's seats go first to those who asked for it, by lot when they are more than the seats, and
       everything else is dealt as ever. A drawn ask costs one pick; one that was not drawn costs nothing; the ask of a
       player who is not connected when the cards are dealt is dropped, nothing spent;
     - NOBODY ever learns who asked or whose ask was drawn: every word of it goes to the asker alone.

   The picks live on the player's phone, as Power's stock does. The app says how many it owns on create, join and quick
   (`picks: n`, with `pickSeen: "<game>"`) and again when it buys (`pickStock`, the same two fields); the server clamps
   the count to 0..STOCK_MAX and counts every spent pick itself. `pickSeen` is the last game whose spent pick the app has
   already taken off its own count, so a count said in the same moment as a deal (a reconnect) is not counted twice. */
"use strict";
const crypto = require("crypto");

const CAP = "rolepick";
const STOCK_MAX = 99;
const ROLES = ["mafia", "detective", "doctor", "jester", "mayor", "bodyguard"];   // "mafia" is the app's Shadow
const NAME = { mafia: "The Shadow", detective: "The Detective", doctor: "The Doctor", jester: "The Jester", mayor: "The Mayor", bodyguard: "The Bodyguard" };
const LINES = {
  cap: "Update GameNest to pick a role.",
  lobby: "Roles are picked in the lobby.",
  off: "The host turned role picks off.",
  role: "No such role to pick.",
  none: "You have no role picks.",
  noneLeft: "You have no role picks left.",
  away: "You were away when the game began.",
  notIn: (role) => `${NAME[role]} is not in this game.`,
  gone: (role) => `${NAME[role]} is not in this game any more.`,
};

const knows = (caps) => Array.isArray(caps) && caps.includes(CAP);
const cleanN = (n) => (Number.isInteger(n) ? Math.min(STOCK_MAX, Math.max(0, n)) : 0);

/* What the app says it owns: its count is the truth, less the picks this room spent that it has not counted yet.
   An app that does not know the role pick owns nothing here. True when the count was taken. */
function take(pk, picks, seen) {
  if (!pk || !pk.knows) return false;
  if (typeof seen === "string") { const i = pk.unseen.indexOf(seen); if (i >= 0) pk.unseen.splice(0, i + 1); }
  pk.stock = Math.max(0, cleanN(picks) - pk.unseen.length);
  return true;
}

/* A seat's role-pick state: whether its app knows the feature, the picks it owns, the spent ones its app has not counted
   yet (game ids), what it asks for, what the last deal answered (told) and an ask this lobby dropped (dropped). */
function seat(caps, picks, seen) {
  const pk = { knows: knows(caps), stock: 0, unseen: [], ask: null, told: null, dropped: null };
  take(pk, picks, seen);
  return pk;
}

/* The seat count of each role that can be asked for, from a deck's counts: { mafia: 2, detective: 1, doctor: 1, jester: 1 }. */
function seats(count) {
  const o = {};
  for (const r of ROLES) if (count && count[r] > 0) o[r] = count[r];
  return o;
}

/* An ask (or, with no role, taking it back). Null when it was taken, else the plain line that turns it away. */
function ask(pk, role, on, seatsNow) {
  if (!pk || !pk.knows) return LINES.cap;
  if (role == null) { pk.ask = null; pk.dropped = null; return null; }
  if (!on) return LINES.off;
  if (typeof role !== "string" || !ROLES.includes(role)) return LINES.role;
  if (!(seatsNow && seatsNow[role] > 0)) return LINES.notIn(role);
  if (pk.stock < 1) return LINES.none;
  pk.ask = role; pk.dropped = null;
  return null;
}

/* The lobby changed (a switch, a seat, a count): an ask the room no longer takes is dropped, nothing spent, with a line
   for its asker alone. Returns how many were dropped. */
function prune(seated, seatsNow, on) {
  let n = 0;
  for (const p of seated) {
    const pk = p && p.pk;
    if (!pk || !pk.ask) continue;
    if (!pk.knows || p.bot) { pk.ask = null; continue; }   // an app that no longer knows the feature is told nothing
    const why = !on ? LINES.off : !(seatsNow && seatsNow[pk.ask] > 0) ? LINES.gone(pk.ask) : pk.stock < 1 ? LINES.noneLeft : null;
    if (!why) continue;
    pk.dropped = { role: pk.ask, message: why };
    pk.ask = null; n++;
  }
  return n;
}

/* The deal's part. `seated` are the seats being dealt and `count` the deck's counts. For each role the askers are put
   in an order by lot and the first of them, as many as the role has seats, get it. Returns Map(seat -> role) of the drawn;
   every asker is answered on their own seat (told), a drawn one's pick is spent, and every ask is used up. */
function draw(seated, count, on, game, randomInt = crypto.randomInt) {
  const drawn = new Map(), by = {};
  for (const p of seated) {
    const pk = p && p.pk;
    if (!pk) continue;
    pk.told = null;
    if (!pk.ask) { pk.dropped = null; continue; }
    const role = pk.ask;
    pk.ask = null;
    if (!pk.knows || p.bot) { pk.dropped = null; continue; }
    /* Not connected when the cards are dealt: their ask is dropped, nothing spent. A pick is never spent on a game its
       owner is not at, and the seat goes to someone who is. */
    const why = !on ? LINES.off : !(count && count[role] > 0) ? LINES.gone(role) : pk.stock < 1 ? LINES.noneLeft : p.connected === false ? LINES.away : null;
    if (why) { pk.dropped = { role, message: why }; continue; }
    pk.dropped = null;
    (by[role] = by[role] || []).push(p);
  }
  for (const role of ROLES) {
    const askers = by[role];
    if (!askers) continue;
    for (let i = askers.length - 1; i > 0; i--) { const j = randomInt(i + 1); [askers[i], askers[j]] = [askers[j], askers[i]]; }
    askers.forEach((p, i) => {
      const got = i < count[role];
      p.pk.told = { game, role, spent: got };
      if (!got) return;
      drawn.set(p, role);
      p.pk.stock -= 1;
      p.pk.unseen.push(game);
      if (p.pk.unseen.length > 16) p.pk.unseen.shift();
    });
  }
  return drawn;
}

/* What a player is told about their own picks, and nobody else: { stock, ask } and, after a deal that answered an ask of
   theirs, { game, role, spent }; an ask the lobby dropped is { dropped: { role, message } }. */
function me(pk) {
  return { stock: pk.stock, ask: pk.ask, ...(pk.told ? { game: pk.told.game, role: pk.told.role, spent: pk.told.spent } : {}), ...(pk.dropped ? { dropped: { role: pk.dropped.role, message: pk.dropped.message } } : {}) };
}

module.exports = { CAP, STOCK_MAX, ROLES, NAME, LINES, knows, cleanN, take, seat, seats, ask, prune, draw, me };
