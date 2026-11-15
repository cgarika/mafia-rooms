/* Mafia: GameNest Plus's Bodyguard (2026-10-17), on the server's own functions: node test/plus_bodyguard.js */
"use strict";
const assert = require("assert");
const S = require("../server");

let passed = 0;
const ok = (m) => { passed++; console.log("  ok " + m); };
const room = (acts) => ({
  code: "BGTEST", status: "playing", phase: "night", day: 1, deaths: [], probeLog: {}, nightActs: acts, players: [
    { id: "a", name: "Ann", role: "mafia", alive: true },
    { id: "b", name: "Bo", role: "bodyguard", alive: true },
    { id: "c", name: "Cy", role: "doctor", alive: true },
    { id: "d", name: "Di", role: "villager", alive: true },
    { id: "e", name: "Ed", role: "detective", alive: true },
    { id: "f", name: "Fi", role: "villager", alive: true },
  ],
});

// Guarded and attacked: the Bodyguard falls, the target lives.
let r = room({ 0: { kill: 3 }, 1: { guard: 3 }, 2: { save: 5 } });
S.resolveNight(r);
assert.strictEqual(r.players[3].alive, true);
assert.strictEqual(r.players[1].alive, false);
assert.ok(/Bodyguard, stepped in/.test(r.log), r.log);
ok("an attack on the guarded player takes the Bodyguard instead");

// The Doctor's save comes first: nobody dies.
r = room({ 0: { kill: 3 }, 1: { guard: 3 }, 2: { save: 3 } });
S.resolveNight(r);
assert.ok(r.players.every((p) => p.alive), "everyone lives");
assert.ok(/doctor got there first/.test(r.log), r.log);
ok("the Doctor's save on the same player: nobody dies");

// An attack on someone else: as ever.
r = room({ 0: { kill: 5 }, 1: { guard: 3 }, 2: { save: 4 } });
S.resolveNight(r);
assert.strictEqual(r.players[5].alive, false);
assert.strictEqual(r.players[1].alive, true);
ok("an attack elsewhere kills as before");

// The roles: one Bodyguard when asked, none otherwise; the label.
assert.ok(S.rolesFor(8, { bodyguard: true }).includes("bodyguard"));
assert.ok(!S.rolesFor(8, {}).includes("bodyguard"));
assert.strictEqual(S.label("bodyguard"), "the Bodyguard");
ok("rolesFor deals a Bodyguard when the host asks for one");

// A bot Bodyguard guards someone other than itself.
r = room({});
S.botDecide(r, r.players[1]);
assert.ok(r.nightActs[1] && r.nightActs[1].guard != null && r.nightActs[1].guard !== 1, JSON.stringify(r.nightActs));
ok("a bot Bodyguard guards someone else");

console.log(`plus bodyguard: all ${passed} passed`);
process.exit(0);
