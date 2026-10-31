# Spades Arena live game server

Authoritative Spades 2v2 server. Rooms live in memory; no database.
The server owns the engine, validates every bid and play, and only
sends each player their own hand (opponents arrive as counts).

Seats 0 & 2 play against seats 1 & 3. Target 500, nil allowed at
+100/−100, blind nil disabled, strict spades-breaking — the same
rules as the local game.

`engine.mjs` at this repo's root is a copy of the game engine
from the Spades Arena web build. If the Spades rules change,
copy the engine file over again so the server and the game agree.

## Run

```sh
npm install --prefix server
node server/server.mjs   # listens on $PORT or 3000
```

`GET /` returns `{ ok: true, rooms: n }` for health checks.

## Protocol (JSON over WebSocket)

Client → server:

- `{ type: 'create', name }` — open a room, take seat 0.
- `{ type: 'join', code, name }` — take the next free seat; the game
  starts when seat 3 joins.
- `{ type: 'action', kind: 'bid', bid }` — bid 0–13 (0 = nil).
- `{ type: 'action', kind: 'play', card }` — play a card id ('AS', '10H').
- `{ type: 'action', kind: 'rematch' }` — new match after a match ends.

Server → client:

- `{ type: 'room', code, seat }`
- `{ type: 'state', ... }` — full public snapshot for your seat:
  names, team scores, bags, bids, tricks won, phase, hand number,
  dealer, turn, current trick, last trick, your hand, opponents'
  hand counts, public log.
- `{ type: 'error', message }`
- `{ type: 'opponentLeft' }` — a player disconnected; the room
  closes (v1: no reconnect/resume yet).

## Deploy (Render free tier)

This repo deploys as a Node web service from its root (see
`render.yaml`): free plan, no card. Note the free tier sleeps after
15 minutes without traffic and takes about a minute to wake — the
game client should show a "waking up the server" state on first
connect.
