/* Nightfall's bots talk about the game (2026-10-18): a line of their own from what happened (the night, yesterday's
   votes, who has been quiet, what people said), never a role and never a fellow Shadow named. draft(room, p)
   is our line, on the spot; say(line, ...) may give it a person's voice through a small local model (Qwen3-4B, Apache-2.0,
   in llama.cpp's server at $LLM_URL), kept only if it means the same: no role, no number, the same people and no one
   else, the speaker's own name never. Without $LLM_URL, or slow, or off, the draft is said as it is. */
"use strict";
const http = require("http");
const crypto = require("crypto");

const pick = (arr) => arr[crypto.randomInt(arr.length)];
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k]);

/* Lines by intent; {T} the one talked about, {V} a second name, {H} the person being answered. Several per intent, so a
   table of bots does not repeat itself: each line is used once a game (the room remembers) until an intent runs out. */
const LINES = {
  died: ["We lost {T} last night. Let's not waste today's vote.", "{T} is gone. Somebody here did that, and I want to know who.",
    "Rough night. {T} didn't make it. Let's think before we vote.", "{T} was taken in the night. Who was acting strange?", "Poor {T}. Whoever did it is sitting right here."],
  saved: ["Nobody died last night. Someone was protected, nice.", "Everyone's still here? Somebody got saved last night.",
    "A quiet morning, but I think someone was attacked and saved.", "Nobody died, which means somebody out there is doing their job."],
  quiet: ["Nobody was even attacked last night? That's odd.", "Quiet night. Too quiet, if you ask me.", "No kill? Somebody is playing a long game."],
  silent: ["{T} has barely said a word. I want to hear from {T}.", "{T} has been really quiet. What are you thinking, {T}?",
    "Why so quiet, {T}? Talk to us.", "Silence is a choice, {T}. Say something."],
  votedOut: ["{T} pushed to vote out {V}, and {V} was innocent. Explain that, {T}.", "{T} voted against {V} yesterday, and {V} was on our side.",
    "Funny how {T} wanted {V} gone, and {V} was clean."],
  voted: ["{T} voted for {V} yesterday. Why {V}?", "I keep thinking about {T} voting for {V} yesterday.", "{T}, what made you pick {V} last time?"],
  echo: ["I agree, {T} is acting strange.", "Yeah, I've got a bad feeling about {T} too.", "Same here. {T} doesn't add up.", "{T} keeps coming up. That's not nothing."],
  accuse: ["My money is on {T} today.", "I'm leaning {T}. Change my mind.", "If I had to pick right now, it's {T}.", "{T} is my suspect. Convince me otherwise.", "Something's off about {T}."],
  disagree: ["I'm not sold on {T}. Where's the proof?", "Hold on, why {T}? That doesn't fit what I saw.", "Let's not pile onto {T} without a reason."],
  ask: ["{H}, what makes you say that?", "{H}, who are you voting for, then?", "Fair point, {H}. Anyone else see it?", "{H}, you might be onto something."],
  hint: ["I have a strong feeling about {T}. Trust me on this one.", "Look hard at {T} today. I'm pretty sure.", "My gut says {T}. I wouldn't ignore it."],
  clear: ["Trust me on this one: {T} is fine.", "Leave {T} alone, I'm pretty sure {T} is with us.", "{T} is not the one. I'd bet on it."],
  defend: ["I'm innocent, I promise. Look at {T} instead.", "Why me? I've been helping. {T} is the one dodging.", "Not me! If you want a lead, try {T}.", "Easy, easy. I'm no threat. {T} is more your type."],
  filler: ["Let's think before we vote.", "Count the votes, not the words.", "We can't afford a wrong vote.", "Anyone else feel like someone's steering this?", "Stay sharp, everyone.",
    "I'm still making up my mind.", "Somebody here is putting on a good act.", "Let's hear a few more voices.", "Watch who changes their story.", "Don't just follow the loudest voice.", "Slow down, we have time.", "One of us is lying and smiling about it."],
};
/* The same line said TO the person it names (2026-11-01): the viewer who is {T}, {V} or {H} reads "you", not their own name (state
   builds the chat per viewer from these). Keyed by the template above; a line with no form here is read with the name. */
const YOU = {
  "{T} has barely said a word. I want to hear from {T}.": { T: "You've barely said a word. I want to hear from you." },
  "{T} has been really quiet. What are you thinking, {T}?": { T: "You've been really quiet. What are you thinking?" },
  "Why so quiet, {T}? Talk to us.": { T: "Why so quiet? Talk to us." },
  "Silence is a choice, {T}. Say something.": { T: "Silence is a choice. Say something." },
  "{T} pushed to vote out {V}, and {V} was innocent. Explain that, {T}.": { T: "You pushed to vote out {V}, and {V} was innocent. Explain that." },
  "{T} voted against {V} yesterday, and {V} was on our side.": { T: "You voted against {V} yesterday, and {V} was on our side." },
  "Funny how {T} wanted {V} gone, and {V} was clean.": { T: "Funny how you wanted {V} gone, and {V} was clean." },
  "{T} voted for {V} yesterday. Why {V}?": { T: "You voted for {V} yesterday. Why {V}?", V: "{T} voted for you yesterday. Why you?" },
  "I keep thinking about {T} voting for {V} yesterday.": { T: "I keep thinking about you voting for {V} yesterday.", V: "I keep thinking about {T} voting for you yesterday." },
  "{T}, what made you pick {V} last time?": { T: "What made you pick {V} last time?" },
  "I agree, {T} is acting strange.": { T: "I agree, you're acting strange." },
  "Yeah, I've got a bad feeling about {T} too.": { T: "Yeah, I've got a bad feeling about you too." },
  "Same here. {T} doesn't add up.": { T: "Same here. You don't add up." },
  "{T} keeps coming up. That's not nothing.": { T: "You keep coming up. That's not nothing." },
  "My money is on {T} today.": { T: "My money is on you today." },
  "I'm leaning {T}. Change my mind.": { T: "I'm leaning towards you. Change my mind." },
  "If I had to pick right now, it's {T}.": { T: "If I had to pick right now, it's you." },
  "{T} is my suspect. Convince me otherwise.": { T: "You're my suspect. Convince me otherwise." },
  "Something's off about {T}.": { T: "Something's off about you." },
  "I'm not sold on {T}. Where's the proof?": { T: "I'm not sold on the case against you. Where's the proof?" },
  "Hold on, why {T}? That doesn't fit what I saw.": { T: "Hold on, why you? That doesn't fit what I saw." },
  "Let's not pile onto {T} without a reason.": { T: "Let's not pile onto you without a reason." },
  "{H}, what makes you say that?": { H: "What makes you say that?" },
  "{H}, who are you voting for, then?": { H: "Who are you voting for, then?" },
  "Fair point, {H}. Anyone else see it?": { H: "Fair point. Anyone else see it?" },
  "{H}, you might be onto something.": { H: "You might be onto something." },
  "I have a strong feeling about {T}. Trust me on this one.": { T: "I have a strong feeling about you. Trust me on this one." },
  "Look hard at {T} today. I'm pretty sure.": { T: "I'm keeping an eye on you today. I'm pretty sure." },
  "My gut says {T}. I wouldn't ignore it.": { T: "My gut says you. I wouldn't ignore it." },
  "Trust me on this one: {T} is fine.": { T: "Trust me on this one: you're fine." },
  "Leave {T} alone, I'm pretty sure {T} is with us.": { T: "I'm pretty sure you're with us." },
  "{T} is not the one. I'd bet on it.": { T: "You're not the one. I'd bet on it." },
  "I'm innocent, I promise. Look at {T} instead.": { T: "I'm innocent, I promise. Look at you instead." },
  "Why me? I've been helping. {T} is the one dodging.": { T: "Why me? I've been helping. You are the one dodging." },
};
/* A bot's simple persona: how much it talks and what it leans to say. */
const PERSONAS = {
  hothead: { lines: 3, w: { accuse: 3, echo: 2, voted: 1, defend: 2 } },
  skeptic: { lines: 3, w: { disagree: 3, ask: 2, voted: 2, silent: 2 } },
  analyst: { lines: 3, w: { voted: 3, votedOut: 3, silent: 2, died: 2 } },
  chatty: { lines: 3, w: { ask: 3, echo: 2, filler: 2, saved: 1 } },
  quiet: { lines: 2, w: { accuse: 1, echo: 1, filler: 1 } },
};
const PERSONA_NAMES = Object.keys(PERSONAS);
const personaOf = (p) => PERSONAS[p.persona] || PERSONAS.chatty;
const escRe = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text, n) => !!text && new RegExp(`\\b${escRe(n)}\\b`, "i").test(text);

/* Lines said so far this game are not said again (an intent whose lines are all used says one anyway). */
function pickLine(room, intent, vars) {
  const used = (room.usedLines = room.usedLines || new Set());
  const pool = LINES[intent].filter((l) => !used.has(l));
  if (!pool.length) return null;
  const line = pick(pool);
  used.add(line);
  return { tpl: line, text: fill(line, vars) };
}

/* How suspicious each living seat looks to bot p: from what was said (accusations by others), yesterday's votes, silence,
   and what a Detective found. A Shadow looks for the ones who threaten its mates (the accusers), never a mate.
   Returns {seat: score} for living seats other than p's own (and, for a Shadow, other than its mates). */
function suspicion(room, p, opts = {}) {
  const seat = room.players.indexOf(p);
  const mafia = p.role === "mafia";
  const out = {};
  const living = room.players.map((q, s) => (q.alive && !q.left && s !== seat && !(mafia && q.role === "mafia") ? s : -1)).filter((s) => s >= 0);
  const mates = room.players.map((q, s) => (q.role === "mafia" && !q.left && q.alive ? s : -1)).filter((s) => s >= 0);
  for (const t of living) out[t] = 0;
  const day = (room.chat || []).filter((m) => m.ch === "day" && m.t).slice(-40);
  for (const m of day) {
    if (m.s === seat) continue;
    for (const t of living) {
      if (m.s === t) continue;
      if (mentions(m.t, room.players[t].name)) out[t] += mafia ? 0 : 1.5;   // named by someone else
    }
    if (mafia) for (const mt of mates) if (m.s !== mt && mentions(m.t, room.players[mt].name) && out[m.s] !== undefined) out[m.s] += 2;   // whoever points at a mate
    if (mentions(m.t, p.name) && out[m.s] !== undefined) out[m.s] += 1;   // whoever pointed at me
  }
  /* every day's vote counts (the room keeps them: voteHistory), the nearer the more: what a table did on day 1 is still remembered on day 4 */
  const hist = room.voteHistory && room.voteHistory.length ? room.voteHistory : room.lastVotes ? [room.lastVotes] : [];
  for (const lv of hist) {
    const w = Math.pow(0.6, Math.max(0, (room.day || 1) - 1 - (lv.day || 0)));
    const outSeat = lv.out != null && room.players[lv.out] ? lv.out : null;
    for (const [v, t] of Object.entries(lv.votes || {})) {
      const vs = Number(v);
      if (out[vs] === undefined || t < 0) continue;
      if (t === seat) out[vs] += 2 * w;   // voted for me
      if (mafia) { if (mates.includes(t)) out[vs] += 3 * w; }
      else if (outSeat === t && room.players[t].role !== "mafia") out[vs] += 2 * w;   // pushed out an innocent
    }
  }
  for (const t of living) out[t] += 0.5 * ((p.mem && p.mem[t]) || 0);   // and what this bot already thought of them
  if (room.day > 1) for (const t of living) if (!(room.players[t].chatN > 0)) out[t] += 1;
  if (p.role === "detective") for (const e of (room.probeLog && room.probeLog[seat]) || []) if (out[e.t] !== undefined) out[e.t] += e.mafia ? 30 : -10;
  if (opts.noise !== false) for (const t of living) out[t] += Math.random() * 0.9;   // a little human noise
  return out;
}
/* The seat to pick from a score map (best, with noise already in). null if none. */
function bestOf(scores) {
  let best = null, v = -Infinity;
  for (const [t, x] of Object.entries(scores)) if (x > v) { v = x; best = Number(t); }
  return best;
}

/* Whether a line speaks only of people who are in this match (no name of any player who is not at the table). */
function namesOk(room, text, extraPool) {
  const here = new Set(room.players.map((q) => q.name.toLowerCase()));
  for (const n of (extraPool || [])) if (!here.has(n.toLowerCase()) && mentions(text, n)) return false;
  return true;
}

/* The line a bot would say now, from the room's own facts, or null (then the old lines). p: the bot.
   Mixes accusations, defences and replies to what a person just said, by persona. */
function draft(room, p) {
  const seat = room.players.indexOf(p);
  const name = (s) => room.players[s] && room.players[s].name;
  const living = room.players.map((q, s) => (q.alive && !q.left && s !== seat ? s : -1)).filter((s) => s >= 0);
  if (!living.length) return null;
  const mafia = p.role === "mafia";
  const mate = (s) => mafia && room.players[s].role === "mafia";
  const fair = living.filter((s) => !mate(s));   // a Shadow never points at a fellow Shadow
  const per = personaOf(p);
  const options = [];   // [weight, intent, T, V]
  const add = (w, intent, T, V) => options.push([w * (per.w[intent] || 1), intent, T, V]);
  const ln = room.lastNight && room.lastNight.day === room.day ? room.lastNight : null;
  if (ln && !(room.chat || []).some((m) => m.ch === "day" && m.s === seat)) {   // the night is talked about once, first
    if (ln.died != null && !mafia) add(3, "died", ln.died);
    else if (ln.died != null) add(2, "died", ln.died);
    else if (ln.saved) add(2, "saved");
    else add(1, "quiet");
  }
  const chat = (room.chat || []).filter((m) => m.ch === "day" && m.t);
  // what people said today: the living name said most in the day's chat, not by this bot
  const told = {};
  for (const m of chat.slice(-30)) {
    if (m.s === seat) continue;
    for (const s of living) if (mentions(m.t, name(s))) told[s] = (told[s] || 0) + 1;
  }
  const last = chat[chat.length - 1];
  const mentionedMe = chat.slice(-15).some((m) => m.s !== seat && mentions(m.t, p.name));
  const echo = Object.keys(told).map(Number).filter((s) => !mate(s)).sort((a, b) => told[b] - told[a])[0];
  const lastHuman = [...chat].reverse().find((m) => m.s !== seat && room.players[m.s] && !room.players[m.s].bot && room.players[m.s].alive && !room.players[m.s].left);   // only a seat still at the table is answered by name
  const lastHumanNamed = lastHuman && living.filter((s) => s !== lastHuman.s && mentions(lastHuman.t, name(s)));
  if (echo !== undefined) {
    // a reply to a person's accusation: agree, or push back; a Shadow never backs a call against a mate
    add(3, "echo", echo);
    if (lastHumanNamed && lastHumanNamed.length && lastHumanNamed[0] === echo) {
      add(2, "disagree", echo);
      add(2, "ask", echo, lastHuman.s);
    }
  }
  if (lastHuman && last && last.s === lastHuman.s) add(2, "ask", undefined, lastHuman.s);
  // yesterday's votes
  const lv = room.lastVotes && room.lastVotes.day === room.day - 1 ? room.lastVotes : null;
  if (lv) {
    const out = lv.out != null && room.players[lv.out] && !room.players[lv.out].alive ? lv.out : null;
    for (const [v, t] of Object.entries(lv.votes || {})) {
      const vs = Number(v);
      if (!fair.includes(vs) || t < 0 || !room.players[t] || mate(t)) continue;   // nor a fellow Shadow as the one voted for
      if (out === t && room.players[t].role !== "mafia") add(3, "votedOut", vs, t);
      else if (t !== seat && room.players[t].alive && !room.players[t].left) add(1, "voted", vs, t);   // a seat that is gone is not named, unless it is the one voted out
    }
    if ((lv.tally || {})[seat] > 0 || mentionedMe) add(4, "defend", fair.length ? pick(fair) : living[0]);
  } else if (mentionedMe) add(4, "defend", fair.length ? pick(fair) : living[0]);
  // the quiet ones (nothing said all game, by day two)
  for (const s of fair) if (room.day > 1 && !(room.players[s].chatN > 0)) add(1, "silent", s);
  // a call of its own, from its suspicion
  const sus = suspicion(room, p), top = bestOf(sus);
  if (top != null) add(2, "accuse", top);
  add(0.5, "filler");
  // what a detective knows, without saying how
  if (p.role === "detective") for (const e of (room.probeLog && room.probeLog[seat]) || []) {
    if (!room.players[e.t] || !room.players[e.t].alive) continue;
    options.push(e.mafia ? [6, "hint", e.t] : [2, "clear", e.t]);
  }
  let ok = options.filter((o) => o[1] === "filler" || o[1] === "saved" || o[1] === "quiet" || o[2] !== undefined || o[1] === "ask");
  // a weighted pick; an intent whose lines have all been said this game is passed over for the next best, so the bot says something fresh or nothing
  while (ok.length) {
    const total = ok.reduce((a, o) => a + o[0], 0);
    let r = crypto.randomInt(Math.max(1, Math.round(total * 1000))) / 1000, o = ok[0];
    for (const x of ok) { if ((r -= x[0]) < 0) { o = x; break; } }
    const [, intent, T, V] = o;
    const H = intent === "ask" ? V : undefined;
    const names = (intent === "ask" ? [H] : [T, V]).filter((s) => s != null).map(name);
    const vars = { T: T != null ? name(T) : "", V: V != null ? name(V) : "", H: H != null ? name(H) : "" };
    const picked = pickLine(room, intent, vars);
    if (!picked) { ok = ok.filter((x) => x[1] !== intent); continue; }
    // the same line for each person it names, said to them ("you"); the rest read the names
    const y = {}, forms = YOU[picked.tpl];
    if (forms) for (const [slot, who] of [["T", T], ["V", V], ["H", H]]) {
      const q = who != null ? room.players[who] : null;
      if (!forms[slot] || !q || q.bot || !q.alive || q.left) continue;
      y[who] = fill(forms[slot], vars);
    }
    return { intent, text: picked.text, names, seats: [T, V, H].filter((x) => x != null), target: intent === "ask" ? null : T, y };
  }
  return null;
}

/* The bot said it: an accusation, a hint or an echo about a seat is its call for today, and its vote follows it; a seat it cleared
   it will not vote for. Kept on the bot (p.said) so botDecide can read it. */
function remember(room, p, d) {
  if (!d || d.target == null) return;
  p.said = p.said || { day: -1, accused: [], cleared: [] };
  if (p.said.day !== room.day) p.said = { day: room.day, accused: [], cleared: [] };
  if (["accuse", "hint", "echo"].includes(d.intent)) p.said.accused.push(d.target);
  if (d.intent === "clear" || d.intent === "disagree") p.said.cleared.push(d.target);
}

/* What a restyled line must still say for its intent (the model once turned "let's not waste today's vote" into "let's
   skip today's vote", and "Gizmo voted for Pixel" into "Gizmo said Pixel was the best choice"). */
const KEEP = {
  died: [/\b(gone|lost|didn.?t make|out|died|dead|killed|taken)\b/i, /\bskip/i],
  voted: [/\bvot/i], votedOut: [/\bvot/i],
  silent: [/\b(quiet|silent|word|talk|said|say|hear)/i],
  defend: [/\b(innocent|not me|clean|why me|wasn.?t me|isn.?t me|helping)\b/i],
};
const BAD = /\b(shadows?|mafia|doctor|detective|bodyguard|guard|villagers?|jester|mayor|roles?|wolf|wolves|bot|ai)\b|\d/i;
/* Whether a restyled line still says the draft: our names and no others, no role, no number, not the speaker's name. */
function faithful(line, d, self, everyone) {
  if (!line || line.length < 6 || line.length > 120 || /["\n*:]/.test(line) || BAD.test(line)) return false;
  const has = (n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(line);
  if (has(self)) return false;
  if (!d.names.every(has)) return false;
  const keep = KEEP[d.intent];
  if (keep && (!keep[0].test(line) || (keep[1] && keep[1].test(line)))) return false;
  return everyone.filter((n) => n !== self && !d.names.includes(n)).every((n) => !has(n));
}

const SYSTEM = "You rewrite a player's chat line in a friendly party game so it sounds natural, casual and a little playful, like a "
  + "real person typing in a group chat. Keep the exact meaning and the same people. Keep it first person and short (6-16 words). "
  + "Do not add names, facts, roles or numbers. Do not address anyone by your own name. Output only the rewritten line.";

/* The line in a person's voice (or d.text, as it is): a promise of the text. */
function say(d, self, everyone, { url = process.env.LLM_URL, timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 2500) } = {}) {
  if (!url) return Promise.resolve(d.text);
  const body = JSON.stringify({ messages: [{ role: "system", content: SYSTEM },
    { role: "user", content: `Your name: ${self}. Players: ${everyone.join(", ")}. Line: ${d.text} /no_think` }],
    max_tokens: 60, temperature: 0.5, top_p: 0.9 });
  return new Promise((resolve) => {
    let done = false;
    const finish = (t) => { if (!done) { done = true; resolve(t); } };
    const u = new URL("/v1/chat/completions", url);
    const req = http.request(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; if (buf.length > 20000) req.destroy(); });
      res.on("end", () => {
        try {
          const raw = JSON.parse(buf).choices[0].message.content;
          const line = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n")[0].trim().replace(/^["']|["']$/g, "");
          finish(faithful(line, d, self, everyone) ? line : d.text);
        } catch (e) { finish(d.text); }
      });
    });
    req.on("timeout", () => { req.destroy(); finish(d.text); });
    req.on("error", () => finish(d.text));
    req.end(body);
    setTimeout(() => finish(d.text), timeoutMs + 200).unref();
  });
}

module.exports = { draft, say, faithful, remember, LINES, YOU, PERSONA_NAMES, suspicion, bestOf, namesOk, personaOf };
