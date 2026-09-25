#!/usr/bin/env node
// WikiRace Local: a self-hosted Wikipedia racing game. The browser only ever
// talks to this server; this server only ever talks to Wikipedia.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { WikiClient, WikiError } = require('./lib/wiki');
const { GameManager, GameError } = require('./lib/game');
const { RoomManager } = require('./lib/rooms');
const { Picker, todayKey } = require('./lib/picker');
const { Store } = require('./lib/store');
const { cleanRules, normalizeTitle, sameTitle } = require('./public/rules');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lan') out.host = '0.0.0.0';
    else if (a === '--no-disk-cache') out.noDiskCache = true;
    else if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function createApp(options = {}) {
  const dataDir = options.dataDir === undefined ? path.join(__dirname, 'data') : options.dataDir;
  const wiki = new WikiClient({
    template: options.wikiUrl,
    cacheDir: dataDir && !options.noDiskCache ? path.join(dataDir, 'cache') : null,
  });
  const store = new Store(dataDir);
  const games = new GameManager({ wiki, store });
  const picker = new Picker(wiki);

  async function resolveOne(lang, title, label) {
    const canon = await wiki.resolveTitle(lang, title);
    if (!canon) throw new GameError(`Couldn't find a Wikipedia article called "${title}" (${label})`, 404);
    return canon;
  }

  async function resolvePair({ rules, difficulty, start, target, via }) {
    const lang = rules.lang;
    let pair;
    let daily = null;
    if (difficulty === 'daily') {
      const d = await picker.daily(lang);
      pair = d;
      daily = d.date;
    } else if (difficulty === 'custom') {
      pair = {
        start: start || await picker.pick(lang, 'medium', 'start'),
        target: target || await picker.pick(lang, 'medium', 'target'),
      };
    } else {
      pair = await picker.pair(lang, difficulty);
    }
    const out = {
      start: await resolveOne(lang, pair.start, 'start'),
      target: await resolveOne(lang, pair.target, 'target'),
      via: via ? await resolveOne(lang, via, 'checkpoint') : null,
      daily,
    };
    if (sameTitle(out.start, out.target)) throw new GameError('Start and target resolve to the same article');
    if (out.via && (sameTitle(out.via, out.start) || sameTitle(out.via, out.target))) out.via = null;
    return out;
  }

  const rooms = new RoomManager({ games, resolvePair });

  function pageView(page) {
    return { title: page.title, displayTitle: page.displayTitle, html: page.html, links: page.links };
  }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/config$/, () => ({
    today: todayKey(),
    lanUrls: lanUrls(options.port, options.host),
    version: require('./package.json').version,
  }));

  route('GET', /^\/api\/pair$/, async ({ query }) => {
    const lang = cleanRules({ lang: query.get('lang') }).lang;
    return picker.pair(lang, query.get('difficulty') || 'medium');
  });

  route('GET', /^\/api\/random$/, async ({ query }) => {
    const lang = cleanRules({ lang: query.get('lang') }).lang;
    const exclude = query.getAll('exclude');
    return { title: await picker.pick(lang, query.get('difficulty') || 'medium', query.get('role') || 'start', exclude) };
  });

  route('GET', /^\/api\/daily$/, async ({ query }) => {
    const lang = cleanRules({ lang: query.get('lang') }).lang;
    return picker.daily(lang);
  });

  route('GET', /^\/api\/search$/, async ({ query }) => {
    const lang = cleanRules({ lang: query.get('lang') }).lang;
    return { results: await wiki.search(lang, query.get('q')) };
  });

  route('GET', /^\/api\/summary$/, async ({ query }) => {
    const lang = cleanRules({ lang: query.get('lang') }).lang;
    const s = await wiki.summary(lang, query.get('title'));
    return { ...s, thumbnail: s.thumbnail ? '/api/img?u=' + encodeURIComponent(s.thumbnail) : null };
  });

  route('GET', /^\/api\/img$/, async ({ query, res }) => {
    const upstream = await wiki.fetchImage(query.get('u') || '');
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    if (!/^image\//.test(type)) throw new WikiError('Not an image', 415);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    return undefined;
  });

  route('POST', /^\/api\/games$/, async ({ body }) => {
    const rules = cleanRules(body.rules);
    const pair = await resolvePair({
      rules,
      difficulty: body.daily ? 'daily' : 'custom',
      start: normalizeTitle(body.start),
      target: normalizeTitle(body.target),
      via: normalizeTitle(body.via),
    });
    const game = await games.create({ ...pair, rules, playerName: body.playerName });
    const page = await games.currentPage(game.id);
    return { game: games.view(game), page: pageView(page) };
  });

  route('GET', /^\/api\/games\/([a-f0-9]+)$/, ({ params }) => ({ game: games.view(games.get(params[0])) }));

  route('GET', /^\/api\/games\/([a-f0-9]+)\/page$/, async ({ params }) => {
    const page = await games.currentPage(params[0]);
    return { game: games.view(games.get(params[0])), page: pageView(page) };
  });

  route('POST', /^\/api\/games\/([a-f0-9]+)\/move$/, async ({ params, body }) => {
    const { game, page } = await games.move(params[0], body.title);
    return { game: games.view(game), page: page && pageView(page) };
  });

  route('POST', /^\/api\/games\/([a-f0-9]+)\/back$/, async ({ params }) => {
    const { game, page } = await games.back(params[0]);
    return { game: games.view(game), page: pageView(page) };
  });

  route('POST', /^\/api\/games\/([a-f0-9]+)\/giveup$/, ({ params }) => ({ game: games.view(games.giveUp(params[0])) }));

  route('GET', /^\/api\/history$/, () => ({ history: store.list() }));
  route('DELETE', /^\/api\/history$/, () => { store.clear(); return { ok: true }; });

  route('GET', /^\/api\/cache$/, () => wiki.cacheInfo());
  route('DELETE', /^\/api\/cache$/, () => { wiki.clearCache(); return { ok: true }; });

  route('POST', /^\/api\/rooms$/, ({ body }) => {
    const { room, player } = rooms.create(body.name, body.settings);
    return { roomId: room.id, playerId: player.id, token: player.token };
  });

  route('POST', /^\/api\/rooms\/([A-Za-z0-9]+)\/join$/, ({ params, body }) => {
    const { room, player } = rooms.join(params[0], body.name);
    return { roomId: room.id, playerId: player.id, token: player.token };
  });

  route('GET', /^\/api\/rooms\/([A-Za-z0-9]+)\/events$/, ({ params, query, res }) => {
    const room = rooms.get(params[0]);
    const player = rooms.auth(room, query.get('player'), query.get('token'));
    rooms.subscribe(room, player, res);
    return undefined;
  });

  const roomAction = (fn) => async ({ params, body }) => {
    const room = rooms.get(params[0]);
    const player = rooms.auth(room, body.player, body.token);
    await fn(room, player, body);
    return { ok: true };
  };
  route('POST', /^\/api\/rooms\/([A-Za-z0-9]+)\/settings$/, roomAction((room, p, b) => rooms.updateSettings(room, p, b.settings)));
  route('POST', /^\/api\/rooms\/([A-Za-z0-9]+)\/start$/, roomAction((room, p) => rooms.startRound(room, p)));
  route('POST', /^\/api\/rooms\/([A-Za-z0-9]+)\/leave$/, roomAction((room, p) => rooms.leave(room, p)));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (url.pathname.startsWith('/api/')) {
      const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
      if (!r) return sendJSON(res, 404, { error: 'Not found' });
      try {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const params = url.pathname.match(r.pattern).slice(1);
        const result = await r.handler({ req, res, query: url.searchParams, params, body });
        if (result !== undefined) sendJSON(res, 200, result);
      } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, e.message);
        if (!res.headersSent) sendJSON(res, status, { error: e.message || 'Server error' });
        else res.end();
      }
      return undefined;
    }
    return serveStatic(url.pathname, res);
  }

  return { handle, wiki, games, rooms, store };
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 200 * 1024) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  if (pathname === '/' || !path.extname(pathname)) pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
    });
    return res.end(data);
  });
  return undefined;
}

function lanUrls(port, host) {
  if (!port || (host && host !== '0.0.0.0' && host !== '::')) return [];
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${port}`);
    }
  }
  return urls;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node server.js [--port 3000] [--lan] [--host 127.0.0.1] [--no-disk-cache]

  --lan            listen on all interfaces so others on your network can join rooms
  --port, -p       port to listen on (default 3000, or $PORT)
  --host           interface to bind (default 127.0.0.1, or $HOST)
  --no-disk-cache  keep the Wikipedia cache in memory only

Environment: PORT, HOST, DATA_DIR (default ./data), WIKI_URL (default https://{lang}.wikipedia.org)`);
    return;
  }
  const port = Number(args.port || process.env.PORT || 3000);
  const host = args.host || process.env.HOST || '127.0.0.1';
  const app = createApp({
    port, host,
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
    wikiUrl: process.env.WIKI_URL,
    noDiskCache: args.noDiskCache,
  });
  const server = http.createServer((req, res) => app.handle(req, res));
  server.listen(port, host, () => {
    console.log(`\n  WikiRace Local is running\n`);
    console.log(`  → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    for (const u of lanUrls(port, host)) console.log(`  → ${u}  (LAN)`);
    if (host === '127.0.0.1') console.log(`\n  Run with --lan to let others on your network join multiplayer rooms.`);
    console.log('');
  });
  const shutdown = () => { app.store.flush(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createApp };
