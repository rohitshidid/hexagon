// LAN multiplayer server: Express static + ws realtime. Authoritative game.
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { Game, COLORS } from './game/engine.js';
import { botStep } from './game/bot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const GRACE_MS = 1000 * 60 * 10; // keep a room alive 10 min after the last socket drops

const app = express();
// Render pings this to confirm the instance is live (healthCheckPath in render.yaml).
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.use(express.static(join(__dirname, 'public')));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ---- room state ---------------------------------------------------------
const rooms = new Map(); // code -> room

function makeCode() {
  let c;
  do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(c));
  return c;
}

function getRoom(code) { return rooms.get(code); }

function broadcast(room) {
  for (const [ws, member] of room.sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    send(ws, 'state', roomView(room, member.playerId));
  }
}

function roomView(room, playerId) {
  const base = {
    code: room.code,
    hostId: room.hostId,
    started: !!room.game,
    you: playerId,
    players: room.players.map(p => ({
      id: p.id, name: p.name, color: p.color, connected: p.connected, bot: !!p.bot,
    })),
  };
  if (room.game) base.game = room.game.publicState(playerId);
  return base;
}

function send(ws, type, data) {
  try { ws.send(JSON.stringify({ type, data })); } catch {}
}

// Drive any pending bot action, one at a time, with a pause so moves animate.
function scheduleBots(room) {
  if (!room.game || room.game.phase === 'game_over') return;
  if (room.botTimer) return;
  const anyBot = room.game.players.some(p => p.isBot);
  if (!anyBot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!room.game) return;
    const acted = botStep(room.game);
    if (acted) { broadcast(room); scheduleBots(room); }
  }, 750);
}

// ---- websocket handling -------------------------------------------------
wss.on('connection', (ws) => {
  ws.id = randomUUID();
  let joined = null; // {code, playerId}

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;

    if (type === 'create') {
      const code = makeCode();
      const playerId = randomUUID();
      const room = {
        code, hostId: playerId,
        players: [{ id: playerId, name: data.name || 'Host', color: COLORS[0], connected: true }],
        sockets: new Map(),
        game: null,
      };
      rooms.set(code, room);
      room.sockets.set(ws, { playerId });
      joined = { code, playerId };
      send(ws, 'joined', { code, playerId });
      broadcast(room);
      return;
    }

    if (type === 'join') {
      const room = getRoom((data.code || '').toUpperCase());
      if (!room) return send(ws, 'error', { msg: 'Room not found' });
      clearTimeout(room.emptyTimer);
      if (room.game) {
        // allow rejoin if name matches an existing (disconnected) player
        const existing = room.players.find(p => p.name === data.name);
        if (existing) {
          existing.connected = true;
          room.sockets.set(ws, { playerId: existing.id });
          joined = { code: room.code, playerId: existing.id };
          send(ws, 'joined', { code: room.code, playerId: existing.id });
          broadcast(room);
          return;
        }
        return send(ws, 'error', { msg: 'Game already started' });
      }
      if (room.players.length >= 10) return send(ws, 'error', { msg: 'Room full (10 max)' });
      const playerId = randomUUID();
      const color = COLORS[room.players.length % COLORS.length];
      room.players.push({ id: playerId, name: data.name || `Player ${room.players.length + 1}`, color, connected: true });
      room.sockets.set(ws, { playerId });
      joined = { code: room.code, playerId };
      send(ws, 'joined', { code: room.code, playerId });
      broadcast(room);
      return;
    }

    // Reattach a refreshed/dropped client to its existing player by id.
    if (type === 'reconnect') {
      const room = getRoom((data.code || '').toUpperCase());
      const p = room && room.players.find(x => x.id === data.playerId);
      if (!room || !p) return send(ws, 'reconnectFailed', {});
      clearTimeout(room.emptyTimer);
      p.connected = true;
      room.sockets.set(ws, { playerId: p.id });
      joined = { code: room.code, playerId: p.id };
      send(ws, 'joined', { code: room.code, playerId: p.id });
      broadcast(room);
      scheduleBots(room);
      return;
    }

    if (!joined) return;
    const room = getRoom(joined.code);
    if (!room) return;

    if (type === 'rename') {
      const p = room.players.find(x => x.id === joined.playerId);
      if (p && !room.game) p.name = (data.name || p.name).slice(0, 16);
      broadcast(room);
      return;
    }

    if (type === 'addBot') {
      if (joined.playerId !== room.hostId || room.game) return;
      if (room.players.length >= 10) return send(ws, 'error', { msg: 'Room full (10 max)' });
      const n = room.players.filter(p => p.bot).length + 1;
      const playerId = randomUUID();
      room.players.push({
        id: playerId, name: `🤖 Bot ${n}`,
        color: COLORS[room.players.length % COLORS.length], connected: true, bot: true,
      });
      broadcast(room);
      return;
    }

    if (type === 'removeBot') {
      if (joined.playerId !== room.hostId || room.game) return;
      for (let i = room.players.length - 1; i >= 0; i--) {
        if (room.players[i].bot) { room.players.splice(i, 1); break; }
      }
      broadcast(room);
      return;
    }

    if (type === 'start') {
      if (joined.playerId !== room.hostId) return send(ws, 'error', { msg: 'Only host can start' });
      if (room.players.length < 2) return send(ws, 'error', { msg: 'Need at least 2 players' });
      room.game = new Game(room.players.map(p => ({ id: p.id, name: p.name, bot: p.bot })),
        { winVP: data.winVP, botDifficulty: data.botDifficulty });
      // copy colors from game back to room players for consistency
      room.game.players.forEach((gp, i) => { room.players[i].color = gp.color; });
      broadcast(room);
      scheduleBots(room);
      return;
    }

    if (type === 'action') {
      if (!room.game) return;
      const res = room.game.act(joined.playerId, data.action, data.payload || {});
      if (!res.ok) { send(ws, 'error', { msg: res.error }); return; }
      // attach transient animation hints
      if (res.dice) room._lastDice = res.dice;
      broadcast(room);
      scheduleBots(room);
      return;
    }

    if (type === 'chat') {
      const p = room.players.find(x => x.id === joined.playerId);
      for (const [s] of room.sockets) send(s, 'chat', { from: p?.name || '?', msg: String(data.msg).slice(0, 200) });
      return;
    }
    if (type === 'adminAction') {
      if (joined.playerId !== room.hostId) return send(ws, 'error', { msg: 'Only host can perform admin actions' });
      
      if (data.action === 'endSession') {
        for (const [s] of room.sockets) send(s, 'sessionEnded', {});
        rooms.delete(room.code);
        return;
      }
      if (data.action === 'restartGame') {
        room.game = new Game(room.players.map(p => ({ id: p.id, name: p.name, bot: p.bot })),
          { winVP: room.game.winVP, radiusOverride: room.game.radiusOverride != null ? room.game.radiusOverride : room.game.board.radius, botDifficulty: room.game.botDifficulty, botTradeLimit: room.game.botTradeLimit });
        room.game.players.forEach((gp, i) => { room.players[i].color = gp.color; });
        broadcast(room);
        scheduleBots(room);
        return;
      }
      if (data.action === 'setBotTradeLimit') {
        if (room.game) room.game.botTradeLimit = data.limit;
        broadcast(room);
        return;
      }
      
      if (!room.game || room.game.setupPos > 0 || room.game.setupStep !== 'settlement') return send(ws, 'error', { msg: 'Can only modify board before first play' });

      if (data.action === 'resizeBoard') {
        const nextRadius = room.game.board.radius + data.delta;
        room.game = new Game(room.players.map(p => ({ id: p.id, name: p.name, bot: p.bot })),
          { winVP: room.game.winVP, radiusOverride: nextRadius, botDifficulty: room.game.botDifficulty, botTradeLimit: room.game.botTradeLimit });
        room.game.players.forEach((gp, i) => { room.players[i].color = gp.color; });
        broadcast(room);
        scheduleBots(room);
        return;
      }

      if (data.action === 'randomizeBoard') {
        room.game = new Game(room.players.map(p => ({ id: p.id, name: p.name, bot: p.bot })),
          { winVP: room.game.winVP, radiusOverride: room.game.radiusOverride, botDifficulty: room.game.botDifficulty, botTradeLimit: room.game.botTradeLimit });
        room.game.players.forEach((gp, i) => { room.players[i].color = gp.color; });
        broadcast(room);
        scheduleBots(room);
        return;
      }
    }
  });

  ws.on('close', () => {
    if (!joined) return;
    const room = getRoom(joined.code);
    if (!room) return;
    room.sockets.delete(ws);
    const p = room.players.find(x => x.id === joined.playerId);
    if (p) p.connected = false;
    // Don't drop the room immediately — a refresh briefly has zero sockets.
    // Keep it alive for a grace period so the player can reconnect by id.
    if (room.sockets.size === 0) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = setTimeout(() => {
        if (room.sockets.size === 0) rooms.delete(room.code);
      }, GRACE_MS);
    }
    broadcast(room);
  });
});

// ---- LAN IP for friends to connect -------------------------------------
function lanIPs() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

httpServer.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('\n  🎲  HEXAGON server running\n');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Network: http://${ip}:${PORT}   <- share this with friends on your LAN`);
  console.log('\n  Host opens the page, clicks "Create Game", shares the room code.');
  console.log('  Friends open the Network URL above and "Join" with that code.\n');
});
