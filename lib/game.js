      // Server-side referee. The browser only asks to follow a link; this module
// checks the link really is on the current page, applies the rules, keeps the
// clock and decides wins and losses.
const crypto = require('crypto');
const { normalizeTitle, sameTitle, banReason, bannedSet, cleanRules } = require('../public/rules');

class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const GAME_TTL_MS = 12 * 3600 * 1000;

class GameManager {
  constructor({ wiki, store }) {
    this.wiki = wiki;
    this.store = store;
    this.games = new Map();
    this.listeners = new Set();
    this.sweeper = setInterval(() => this.sweep(), 1000);
    this.sweeper.unref();
  }

  onChange(fn) { this.listeners.add(fn); }

  emit(game) { for (const fn of this.listeners) fn(game); }

  // start/target/via must already be canonical titles.
  async create({ start, target, via, rules, playerName, daily, roomId, playerId, startAt }) {
    rules = cleanRules(rules);
    if (sameTitle(start, target)) throw new GameError('Start and target must be different pages');
    const page = await this.wiki.getPage(rules.lang, start);
    const now = Date.now();
    const game = {
      id: crypto.randomBytes(12).toString('hex'),
      lang: rules.lang,
      start: page.title,
      target,
      via: via || null,
      viaReached: false,
      rules,
      stack: [page.title],
      path: [{ title: page.title, t: 0 }],
      clicks: 0,
      backs: 0,
      status: 'active',
      reason: null,
      playerName: String(playerName || 'Player').slice(0, 40),
      daily: daily || null,
      roomId: roomId || null,
      playerId: playerId || null,
      createdAt: now,
      startedAt: startAt || now,
      finishedAt: null,
      lastActive: now,
    };
    this.games.set(game.id, game);
    return game;
  }

  get(id) {
    const game = this.games.get(id);
    if (!game) throw new GameError('Game not found (it may have expired)', 404);
    game.lastActive = Date.now();
    this.checkClock(game);
    return game;
  }

  elapsed(game, now = Date.now()) {
    const end = game.finishedAt || now;
    return Math.max(0, end - game.startedAt);
  }

  checkClock(game, now = Date.now()) {
    if (game.status !== 'active' || !game.rules.timeLimit) return false;
    if (now - game.startedAt >= game.rules.timeLimit * 1000) {
      this.finish(game, 'lost', 'Time ran out', game.startedAt + game.rules.timeLimit * 1000);
      return true;
    }
    return false;
  }

  assertPlayable(game) {
    if (game.status !== 'active') throw new GameError('This race is already over', 409);
    if (Date.now() < game.startedAt) throw new GameError('The race has not started yet', 425);
  }

  async currentPage(id) {
    const game = this.get(id);
    if (Date.now() < game.startedAt) throw new GameError('The race has not started yet', 425);
    return this.wiki.getPage(game.lang, game.stack[game.stack.length - 1]);
  }

  async move(id, rawTitle) {
    const game = this.get(id);
    this.assertPlayable(game);
    const wanted = normalizeTitle(rawTitle);
    if (!wanted) throw new GameError('No link given');
    const here = await this.wiki.getPage(game.lang, game.stack[game.stack.length - 1]);
    if (!here.links.includes(wanted)) throw new GameError('That link is not on the current page');
    const reason = banReason(wanted, game.rules, bannedSet(game.rules));
    if (reason) throw new GameError(reason);
    // The fetch may take a moment; re-check nothing changed meanwhile.
    const page = await this.wiki.getPage(game.lang, wanted);
    this.assertPlayable(game);
    if (this.checkClock(game)) return { game, page: null };
    const canonReason = banReason(page.title, game.rules, bannedSet(game.rules));
    if (canonReason) throw new GameError(canonReason);
    game.clicks++;
    game.stack.push(page.title);
    game.path.push({ title: page.title, t: this.elapsed(game) });
    this.afterMove(game, page.title);
    return { game, page };
  }

  async back(id) {
    const game = this.get(id);
    this.assertPlayable(game);
    if (!game.rules.allowBack) throw new GameError('The back button is disabled for this race');
    if (game.stack.length < 2) throw new GameError('Nothing to go back to');
    game.stack.pop();
    const title = game.stack[game.stack.length - 1];
    const page = await this.wiki.getPage(game.lang, title);
    game.backs++;
    if (game.rules.backCountsAsClick) game.clicks++;
    game.path.push({ title, t: this.elapsed(game), back: true });
    this.afterMove(game, title);
    return { game, page };
  }

  afterMove(game, title) {
    if (game.via && sameTitle(title, game.via)) game.viaReached = true;
    if (sameTitle(title, game.target) && (!game.via || game.viaReached)) {
      this.finish(game, 'won', null);
    } else if (game.rules.clickLimit && game.clicks >= game.rules.clickLimit) {
      this.finish(game, 'lost', 'Out of clicks');
    } else {
      this.emit(game);
    }
  }

  giveUp(id) {
    const game = this.get(id);
    if (game.status === 'active') this.finish(game, 'gaveup', 'Gave up');
    return game;
  }

  finish(game, status, reason, at = Date.now()) {
    if (game.status !== 'active') return;
    game.status = status;
    game.reason = reason;
    game.finishedAt = Math.max(at, game.startedAt);
    this.store.add(this.historyEntry(game));
    this.emit(game);
  }

  historyEntry(game) {
    return {
      id: game.id,
      date: new Date(game.startedAt).toISOString(),
      lang: game.lang,
      start: game.start,
      target: game.target,
      via: game.via,
      result: game.status,
      reason: game.reason,
      clicks: game.clicks,
      backs: game.backs,
      timeMs: this.elapsed(game),
      path: game.path.map((p) => (p.back ? '↩ ' : '') + p.title),
      playerName: game.playerName,
      daily: game.daily,
      multiplayer: !!game.roomId,
      rules: game.rules,
    };
  }

  view(game) {
    const now = Date.now();
    return {
      id: game.id,
      lang: game.lang,
      start: game.start,
      target: game.target,
      via: game.via,
      viaReached: game.viaReached,
      rules: game.rules,
      current: game.stack[game.stack.length - 1],
      canGoBack: game.rules.allowBack && game.stack.length > 1,
      path: game.path,
      clicks: game.clicks,
      backs: game.backs,
      status: game.status,
      reason: game.reason,
      daily: game.daily,
      roomId: game.roomId,
      playerName: game.playerName,
      startedAt: game.startedAt,
      finishedAt: game.finishedAt,
      elapsed: this.elapsed(game, now),
      serverNow: now,
    };
  }

  sweep() {
    const now = Date.now();
    for (const [id, game] of this.games) {
      this.checkClock(game, now);
      if (now - game.lastActive > GAME_TTL_MS) this.games.delete(id);
    }
  }
}

module.exports = { GameManager, GameError };