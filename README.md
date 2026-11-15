# Mafia Rooms

Social-deduction party game for 5–12 players in the browser. Share a 6-letter code,
get a secret role, survive the nights, argue through the days.

## Roles
1–3 Mafia (by player count) · 1 Detective · 1 Doctor · Villagers.
Mafia see each other and share a private night chat. The Detective's findings are
private. Roles reveal on death; everything reveals at game over.

## The architecture point
The server keeps all secrets. Every player receives an individually filtered view
of the room (`stateFor(room, seat)`) — your role, your team's knowledge, your file,
and nothing else. Verified by a test harness that plays full 7-client games while
asserting a villager's stream never contains mafia data.

## Run
    npm install && node server.js          # http://localhost:3000
Timers (ms): REVEAL_MS, NIGHT_MS, DAY_MS, VOTE_MS. Bot pacing: BOT_MS.

## Deploy (path-routed under one domain)
Runs behind the needasix arcade proxy with BASE_PATH=/mafia — see the arcade
repo's Caddyfile + docker-compose.yml. Standalone: `node server.js` serves at /.
Voice requires HTTPS, so play at https://needasix.com/mafia.

## The bots talk about the game (2026-10-18)

`bot_talk.js`: each bot's day line comes from what happened (the night's loss or save, yesterday's votes, who has been quiet, what people said, a detective's hunch without saying how it knows, or a defence when accused), never a role, a number or a fellow Shadow's name. With `LLM_URL` set (llama.cpp's `llama-server` with [Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B-GGUF), Apache-2.0, Q4_K_M), the line is given a person's voice, and kept only if it means the same (the same names and no others, no role or number, the intent's key words) and passes moderation; else the bot says its own line. `LLM_TIMEOUT_MS` (2500). Without `LLM_URL` the bots say their own lines.
