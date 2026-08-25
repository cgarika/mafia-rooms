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
