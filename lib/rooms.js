// Multiplayer rooms for racing friends on the same network. State is pushed to
// every player over Server-Sent Events.
const crypto = require('crypto');
const { cleanRules, normalizeTitle } = require('../public/rules');
const { GameError } = require('./game');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COUNTDOWN_MS = 3500;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_PLAYERS = 16;

function cleanRoomSettings(input = {}, prev = {}) {
  const s = Object.assign({}, prev, input);
  return {
    rules: cleanRules(s.rules),
    difficulty: ['easy', 'medium', 'hard', 'daily', 'custom'].includes(s.difficulty) ? s.difficulty : 'medium',
    start: normalizeTitle(s.start || '').slice(0, 200),
    target: normalizeTitle(s.target || '').slice(0, 200),
    via: normalizeTitle(s.via || '').slice(0, 200),
    scoring: s.scoring === 'clicks' ? 'clicks' : 'time',
    showOpponentPages: s.showOpponentPages !== false,
  };
}

class RoomManager {
  constructor({ games, resolvePair }) {
    this.games = games;
    this.resolvePair = resolvePair; // async (settings) => { start, target, via, daily }
    this.rooms = new Map();
    games.onChange((game) => {
      if (game.roomId && this.rooms.has(game.roomId)) this.onGameChange(this.rooms.get(game.roomId));
    });
    this.sweeper = setInterval(() => this.sweep(), 15000);
    this.sweeper.unref();
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  create(name, settings) {
    const room = {
      id: this.newCode(),
      hostId: null,
      settings: cleanRoomSettings(settings),
      players: new Map(),
      status: 'lobby',
      round: null,
      roundNo: 0,
      starting: false,
      lastActive: Date.now(),
    };
    this.rooms.set(room.id, room);
    const player = this.addPlayer(room, name);
    room.hostId = player.id;
    return { room, player };
  }

  get(id) {
    const room = this.rooms.get(String(id || '').toUpperCase());
    if (!room) throw new GameError('Room not found', 404);
    room.lastActive = Date.now();
    return room;
  }

  addPlayer(room, name) {
    if (room.players.size >= MAX_PLAYERS) throw new GameError('Room is full');
    let base = String(name || '').trim().slice(0, 24) || 'Player';
    let finalName = base;
    const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
    for (let n = 2; taken.has(finalName.toLowerCase()); n++) finalName = `${base} ${n}`;
    const player = {
      id: crypto.randomBytes(6).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      name: finalName,
      clients: new Set(),
      gameId: null,
      joinedAt: Date.now(),
    };
    room.players.set(player.id, player);
    this.broadcast(room);
    return player;
  }

  join(id, name) {
    const room = this.get(id);
    return { room, player: this.addPlayer(room, name) };
  }

  auth(room, playerId, token) {
    const player = room.players.get(playerId);
    if (!player || player.token !== token) throw new GameError('Not a member of this room', 403);
    return player;
  }

  leave(room, player) {
    for (const res of player.clients) res.end();
    room.players.delete(player.id);
    if (player.gameId) {
      try { this.games.giveUp(player.gameId); } catch (e) { /* expired */ }
    }
    if (room.hostId === player.id) {
      const next = room.players.values().next().value;
      room.hostId = next ? next.id : null;
    }
    this.onGameChange(room);
    this.broadcast(room);
  }

  updateSettings(room, player, settings) {
    if (room.hostId !== player.id) throw new GameError('Only the host can change settings', 403);
    if (room.status === 'countdown' || room.status === 'racing') throw new GameError('Wait for the race to finish');
    room.settings = cleanRoomSettings(settings, room.settings);
    this.broadcast(room);
  }

  async startRound(room, player) {
    if (room.hostId !== player.id) throw new GameError('Only the host can start the race', 403);
    if (room.status === 'countdown' || room.status === 'racing' || room.starting) throw new GameError('A race is already running');
    room.starting = true;
    this.broadcast(room);
    try {
      const pair = await this.resolvePair(room.settings);
      const startAt = Date.now() + COUNTDOWN_MS;
      room.roundNo++;
      room.round = { ...pair, startAt, results: null };
      for (const p of room.players.values()) {
        const game = await this.games.create({
          start: pair.start, target: pair.target, via: pair.via, daily: pair.daily,
          rules: room.settings.rules, playerName: p.name, roomId: room.id, playerId: p.id, startAt,
        });
        p.gameId = game.id;
      }
      room.status = 'countdown';
      setTimeout(() => {
        if (room.status === 'countdown') { room.status = 'racing'; this.broadcast(room); }
      }, COUNTDOWN_MS).unref();
    } finally {
      room.starting = false;
      this.broadcast(room);
    }
  }

  onGameChange(room) {
    if (room.status !== 'racing' && room.status !== 'countdown') { this.broadcast(room); return; }
    const games = this.roundGames(room);
    if (games.length && games.every((g) => g.status !== 'active')) {
      room.status = 'results';
      room.round.results = this.ranking(room, games);
    }
    this.broadcast(room);
  }

  roundGames(room) {
    const out = [];
    for (const p of room.players.values()) {
      const g = p.gameId && this.games.games.get(p.gameId);
      if (g && g.roomId === room.id) out.push(g);
    }
    return out;
  }

  ranking(room, games) {
    const byClicks = room.settings.scoring === 'clicks';
    const el = (g) => this.games.elapsed(g);
    return games.slice().sort((a, b) => {
      const aw = a.status === 'won' ? 0 : 1;
      const bw = b.status === 'won' ? 0 : 1;
      if (aw !== bw) return aw - bw;
      if (byClicks && a.clicks !== b.clicks) return a.clicks - b.clicks;
      if (el(a) !== el(b)) return el(a) - el(b);
      return a.clicks - b.clicks;
    }).map((g, i) => ({
      rank: g.status === 'won' ? i + 1 : null,
      playerId: g.playerId,
      name: g.playerName,
      status: g.status,
      reason: g.reason,
      clicks: g.clicks,
      timeMs: el(g),
      path: g.path.map((p) => (p.back ? '↩ ' : '') + p.title),
    }));
  }

  view(room, forPlayer) {
    const racing = room.status === 'countdown' || room.status === 'racing';
    const players = [...room.players.values()].map((p) => {
      const g = p.gameId && this.games.games.get(p.gameId);
      const inRound = g && g.roomId === room.id;
      const showPage = inRound && (room.settings.showOpponentPages || g.status !== 'active' || p.id === forPlayer.id);
      return {
        id: p.id,
        name: p.name,
        isHost: p.id === room.hostId,
        online: p.clients.size > 0,
        game: inRound ? {
          status: g.status,
          clicks: g.clicks,
          current: showPage ? g.stack[g.stack.length - 1] : null,
          startedAt: g.startedAt,
          finishedAt: g.finishedAt,
        } : null,
      };
    });
    return {
      id: room.id,
      status: room.status,
      starting: room.starting,
      settings: room.settings,
      hostId: room.hostId,
      roundNo: room.roundNo,
      round: room.round && {
        start: room.round.start,
        target: room.round.target,
        via: room.round.via,
        startAt: room.round.startAt,
        results: room.round.results,
      },
      players,
      you: { id: forPlayer.id, gameId: racing || room.status === 'results' ? forPlayer.gameId : null },
      serverNow: Date.now(),
    };
  }

  subscribe(room, player, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    player.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    res.on('close', () => {
      clearInterval(ping);
      player.clients.delete(res);
      this.broadcast(room);
    });
    this.broadcast(room);
  }

  broadcast(room) {
    for (const p of room.players.values()) {
      if (!p.clients.size) continue;
      const data = `data: ${JSON.stringify(this.view(room, p))}\n\n`;
      for (const res of p.clients) res.write(data);
    }
  }

  sweep() {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      const online = [...room.players.values()].some((p) => p.clients.size);
      if (online) room.lastActive = now;
      else if (now - room.lastActive > EMPTY_ROOM_TTL_MS) this.rooms.delete(id);
    }
  }
}

module.exports = { RoomManager, cleanRoomSettings };
