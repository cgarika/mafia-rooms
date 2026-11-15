/* Nightfall: a chat line carries a quiet timestamp (NF4, party r2, 2026-11-02).  node test/chat_time.js   (its own server on TEST_PORT7, default 3611)
   Proves: every line of the chat the server sends, a person's and a bot's, says when it was said ("at": the server's clock in milliseconds), and the
   lines are in the order they were said. The app shows the time quietly beside the speaker's name; a server without it shows none. */
"use strict";
const assert = require("assert");
const H = require("./helpers");

(async () => {
  const port = H.portOf("TEST_PORT7", 3611);
  console.log("chat time: a server of our own (port " + port + ")");
  const srv = await H.server(port, { REVEAL_MS: "300", NIGHT_MS: "1200", DAY_MS: "9000", VOTE_MS: "4000", BOT_MS: "100" });
  try {
    const [h] = await H.lobby(port, 1, "T");
    h.emit("quick", {});
    assert.ok(await H.wait(() => h.st.status === "playing", 3000), "the game never started");
    assert.ok(await H.wait(() => h.st.phase === "day" && h.st.yourRole, 9000), "no day came");
    const before = Date.now();
    // A person who was taken in the first night watches quietly (the server drops a dead seat's lines), so only a living seat says something and is checked for it.
    const alive = !h.st.players || !h.st.players[h.seat] || h.st.players[h.seat].alive !== false;
    if (alive) {
      h.emit("chat", { t: "Good morning, village." });
      assert.ok(await H.wait(() => (h.st.chat || []).some((m) => m.s === h.seat && /Good morning/.test(m.t)), 2500), "my line never came back");
    }
    assert.ok(await H.wait(() => (h.st.chat || []).some((m) => m.s !== h.seat), 9000), "no bot spoke");
    const lines = h.st.chat;
    for (const m of lines) {
      assert.ok(typeof m.at === "number", "a line with no time: " + JSON.stringify(m));
      assert.ok(m.at >= before - 30000 && m.at <= Date.now() + 100, "a line from another time: " + JSON.stringify(m) + " (now " + Date.now() + ")");
    }
    for (let i = 1; i < lines.length; i++) assert.ok(lines[i].at >= lines[i - 1].at, "lines out of order");
    let note = "";
    if (alive) {
      const mine = lines.find((m) => m.s === h.seat);
      assert.ok(mine.at >= before - 50 && mine.at <= Date.now() + 100, "my line's time is not when I said it: " + (mine.at - before));
      note = " (mine " + (mine.at - before) + " ms after I said it)";
    }
    console.log(`  ok ${lines.length} lines, ${alive ? "a person's and the bots'" : "the bots' (this seat was out)"}, each with the time it was said, in order${note}`);
    h.close();
  } finally { srv.stop(); }
  process.exit(0);
})().catch((e) => { console.error("FAIL", (e && e.stack) || e); process.exit(1); });
