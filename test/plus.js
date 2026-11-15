/* plus.js on its own: node Tools/servers/plus_test.js (exit 1 on a failure). Each server's copy runs the same checks. */
"use strict";
const assert = require("assert");
const Plus = require(process.argv[2] || "../plus");

const look = Plus.cleanLook({ ball: "galaxy", trail: "unicorn", frame: 7, chess: "crystal", dice: "plaid" });
assert.deepStrictEqual(look, { ...Plus.DEFAULT_LOOK, ball: "galaxy", chess: "crystal" }, "unknown ids are the default");
assert.deepStrictEqual(Object.keys(Plus.DEFAULT_LOOK), ["ball", "trail", "frame", "cheer", "chess", "cards", "felt", "dice", "pawns", "snakes", "mafia", "spies"], "every slot");
assert.deepStrictEqual(Plus.cleanLook({ pawns: "robots", snakes: "space", mafia: "noir", spies: "lava" }).pawns + "," + Plus.cleanLook({ snakes: "space" }).snakes + "," + Plus.cleanLook({ mafia: "noir" }).mafia + "," + Plus.cleanLook({ spies: "lava" }).spies, "robots,space,noir,classic", "the more looks (an unknown id the default)");
assert.deepStrictEqual([Plus.DEFAULT_LOOK.chess, Plus.DEFAULT_LOOK.cards, Plus.DEFAULT_LOOK.felt, Plus.DEFAULT_LOOK.dice], ["toy", "classic", "classic", "classic"], "the table looks' defaults");
assert.deepStrictEqual(Plus.cleanLook(null), Plus.DEFAULT_LOOK, "no look is the default look");
assert.deepStrictEqual(Plus.cleanLook("gold"), Plus.DEFAULT_LOOK, "a look that isn't an object is the default");
assert.strictEqual(Plus.cleanLook({ ball: "__proto__" }).ball, "classic", "nothing outside the lists gets through");

const host = Plus.stamp({ id: "a" }, { plus: true, look: { ball: "gold", frame: "crown" } });
const guest = Plus.stamp({ id: "b" }, { plus: "yes", look: { ball: "lava" } });
const bot = { id: "c", bot: true, plus: true };
assert.strictEqual(host.plus, true);
assert.strictEqual(guest.plus, false, "only true is Plus");
assert.deepStrictEqual(Plus.seat(host), { plus: true, look: { ...Plus.DEFAULT_LOOK, ball: "gold", frame: "crown" } });
assert.deepStrictEqual(Plus.seat(bot), { plus: false, look: Plus.DEFAULT_LOOK }, "a bot never owns Plus");
assert.deepStrictEqual(Plus.seat({}), { plus: false, look: Plus.DEFAULT_LOOK }, "a player from before plus.js");
assert.strictEqual(Plus.stamp(null, { plus: true }), null);

const room = { players: [guest, bot] };
assert.strictEqual(Plus.isPlusRoom(room), false, "a bot's flag doesn't make a Plus room");
assert.strictEqual(Plus.gate(room, 18, 9), 9, "a Plus-only option falls back to the free one");
room.players.push(host);
assert.strictEqual(Plus.isPlusRoom(room), true);
assert.strictEqual(Plus.gate(room, 18, 9), 18);
assert.deepStrictEqual(Plus.view(room), { plusRoom: true });
host.left = true;
assert.strictEqual(Plus.isPlusRoom(room), true, "the Plus player left mid-game: the game ends as it began, as the app sees it");
room.players.pop();
assert.strictEqual(Plus.isPlusRoom(room), false, "their seat gone: an ordinary room");
assert.strictEqual(Plus.isPlusRoom(null), false);

// The crew code: a Plus player's own when free, else the room's own.
const taken = new Map([["HJKL23", {}]]);
const own = () => "RANDOM";
assert.strictEqual(Plus.crewCode({ plus: true, crew: "abcd23" }, taken, own), "ABCD23", "a Plus player's crew code");
assert.strictEqual(Plus.crewCode({ plus: false, crew: "ABCD23" }, taken, own), "RANDOM", "without Plus: the room's own");
assert.strictEqual(Plus.crewCode({ plus: true, crew: "HJKL23" }, taken, own), "RANDOM", "a code in use: the room's own");
assert.strictEqual(Plus.crewCode({ plus: true, crew: "AB0D23" }, taken, own), "RANDOM", "no 0, O, 1 or I");
assert.strictEqual(Plus.crewCode({ plus: true }, taken, own), "RANDOM");
assert.strictEqual(Plus.crewCode(undefined, taken, own), "RANDOM");

console.log("plus.js: ok");
