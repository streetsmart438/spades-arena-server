// Spades Arena live game server — authoritative Spades 2v2.
// One Node process, no database: rooms live in memory. The server owns
// the engine, validates every bid and play, and only ever sends each
// player their own hand (opponents arrive as counts) plus the public
// table: bids, tricks, scores, bags, and the current trick.
// v1 limits, stated plainly: if a player disconnects, the room closes
// and the remaining players return to the lobby. No reconnect/resume
// yet. First online game: Spades 2v2 (seats 0 & 2 vs 1 & 3, target 500).

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  createGame,
  placeBid,
  playCard,
  parseCard,
  cardId,
} from '../engine.mjs';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SEATS = 4;

export function makeRoomCode(random = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(random() * CODE_CHARS.length)];
  return code;
}

function idOf(card) {
  return typeof card === 'string' ? card : cardId(card);
}

function publicSnapshot(room, seat) {
  const g = room.game;
  return {
    type: 'state',
    code: room.code,
    seat,
    status: room.status,
    names: room.names.slice(),
    scores: g ? g.scores.slice() : [0, 0],
    bags: g ? g.bags.slice() : [0, 0],
    bids: g ? g.bids.slice() : [null, null, null, null],
    tricksWon: g ? g.tricksWon.slice() : [0, 0],
    playerTricks: g ? g.playerTricks.slice() : [0, 0, 0, 0],
    phase: g ? g.phase : 'waiting',
    handNumber: g ? g.handNumber : 0,
    dealer: g ? g.dealer : 0,
    leader: g ? g.leader : 0,
    turn: g ? g.turn : 0,
    trick: g ? g.trick.map((p) => ({ player: p.player, card: idOf(p.card) })) : [],
    lastTrick: g && g.lastTrick
      ? {
          plays: g.lastTrick.plays.map((p) => ({ player: p.player, card: idOf(p.card) })),
          winner: g.lastTrick.winner,
        }
      : null,
    trickCount: g ? g.trickCount : 0,
    spadesBroken: g ? g.spadesBroken : false,
    target: g ? g.target : 500,
    winner: g ? g.winner : null,
    hand: g ? g.hands[seat].map((c) => idOf(c)) : [],
    handCounts: g ? g.hands.map((h) => h.length) : [0, 0, 0, 0],
    log: g ? g.log.slice(-60) : [],
  };
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

export function createArenaServer({ port = 0 } = {}) {
  const rooms = new Map();

  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer });

  function broadcast(room) {
    room.sockets.forEach((ws, seat) => {
      if (ws) send(ws, publicSnapshot(room, seat));
    });
  }

  function closeRoom(room) {
    rooms.delete(room.code);
  }

  function handleAction(room, seat, msg) {
    const g = room.game;
    if (!g) return { type: 'error', message: 'Game has not started yet.' };
    try {
      if (msg.kind === 'bid') {
        if (seat !== g.turn) throw new Error('Not your turn to bid.');
        placeBid(g, seat, msg.bid);
      } else if (msg.kind === 'play') {
        if (seat !== g.turn) throw new Error('Not your turn to play.');
        playCard(g, seat, parseCard(msg.card));
      } else if (msg.kind === 'rematch') {
        if (g.phase !== 'gameOver') throw new Error('The match is not over.');
        room.game = createGame({
          seed: Math.floor(Math.random() * 1000000),
          target: 500,
        });
      } else {
        throw new Error('Unknown action.');
      }
    } catch (e) {
      return { type: 'error', message: e.message };
    }
    return null;
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        send(ws, { type: 'error', message: 'Bad message.' });
        return;
      }

      if (msg.type === 'create') {
        const name = typeof msg.name === 'string' && msg.name.trim()
          ? msg.name.trim().slice(0, 24)
          : 'Player';
        let code = makeRoomCode();
        while (rooms.has(code)) code = makeRoomCode();
        const room = {
          code,
          status: 'waiting',
          game: null,
          sockets: [ws, null, null, null],
          names: [name, null, null, null],
        };
        rooms.set(code, room);
        ws.roomCode = code;
        ws.seat = 0;
        send(ws, { type: 'room', code, seat: 0 });
        send(ws, publicSnapshot(room, 0));
        return;
      }

      if (msg.type === 'join') {
        const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', message: 'Room not found. Check the code.' });
          return;
        }
        const seat = room.sockets.indexOf(null);
        if (seat === -1) {
          send(ws, { type: 'error', message: 'Room is full.' });
          return;
        }
        const name = typeof msg.name === 'string' && msg.name.trim()
          ? msg.name.trim().slice(0, 24)
          : 'Player';
        room.sockets[seat] = ws;
        room.names[seat] = name;
        ws.roomCode = code;
        ws.seat = seat;
        send(ws, { type: 'room', code, seat });
        if (room.sockets.every((s) => s !== null)) {
          room.status = 'playing';
          room.game = createGame({
            seed: Math.floor(Math.random() * 1000000),
            target: 500,
          });
        }
        broadcast(room);
        return;
      }

      if (msg.type === 'action') {
        const room = rooms.get(ws.roomCode);
        if (!room || room.sockets[ws.seat] !== ws) {
          send(ws, { type: 'error', message: 'You are not in a room.' });
          return;
        }
        const err = handleAction(room, ws.seat, msg);
        if (err) send(ws, err);
        else broadcast(room);
        return;
      }

      send(ws, { type: 'error', message: 'Unknown message.' });
    });

    ws.on('close', () => {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      room.sockets.forEach((other) => {
        if (other && other !== ws) send(other, { type: 'opponentLeft' });
      });
      closeRoom(room);
    });
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  heartbeat.unref?.();

  httpServer.listen(port);
  return {
    httpServer,
    wss,
    rooms,
    close() {
      clearInterval(heartbeat);
      wss.close();
      httpServer.close();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const { httpServer } = createArenaServer({ port });
  httpServer.on('listening', () => {
    console.log(`Spades Arena server listening on port ${port}`);
  });
}
