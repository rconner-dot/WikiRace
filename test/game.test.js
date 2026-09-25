const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock } = require('./mock-wiki');
const { createApp } = require('../server');
const R = require('../public/rules');

let mock;
let server;
let base;
let app;
let dataDir;

test.before(async () => {
  mock = await startMock();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wikirace-test-'));
  app = createApp({ dataDir, wikiUrl: `http://127.0.0.1:${mock.address().port}` });
  server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections();
  server.close();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

const newGame = (extra = {}) => call('POST', '/api/games', { start: 'Cat', target: 'Moon', rules: {}, ...extra });

test('rules: normalisation and date detection', () => {
  assert.equal(R.normalizeTitle('/wiki/Domestic_cat#Diet'), 'Domestic cat');
  assert.equal(R.normalizeTitle('caf%C3%A9'), 'Café');
  assert.equal(R.normalizeTitle('bad%E0%A4%A'), 'Bad%E0%A4%A');
  for (const t of ['1999', '44 BC', '1990s', '19th century', 'July 4', '4 July', 'List of cats', '2004 in film']) {
    assert.ok(R.isDateLike(t), t);
  }
  for (const t of ['Cat', 'Apollo 11', 'Moon', 'Formula One']) assert.ok(!R.isDateLike(t), t);
  const rules = R.cleanRules({ bannedPages: 'united States,  Moon ', timeLimit: -5, lang: '../evil' });
  assert.deepEqual(rules.bannedPages, ['United States', 'Moon']);
  assert.equal(rules.timeLimit, 0);
  assert.equal(rules.lang, 'en');
});

test('a full race: valid moves, rejected moves, win and history', async () => {
  const { status, data } = await newGame();
  assert.equal(status, 200);
  assert.equal(data.game.current, 'Cat');
  assert.ok(data.page.links.includes('Pet'));
  assert.ok(!data.page.links.includes('Nope'), 'red links are not playable');
  assert.ok(!data.page.links.includes('File:X.jpg'), 'non-article links are not playable');
  const id = data.game.id;

  let r = await call('POST', `/api/games/${id}/move`, { title: 'Moon' });
  assert.equal(r.status, 400, 'cannot jump to a page that is not linked');

  r = await call('POST', `/api/games/${id}/move`, { title: 'Pet' });
  assert.equal(r.status, 200);
  assert.equal(r.data.game.current, 'Pet');
  r = await call('POST', `/api/games/${id}/move`, { title: 'Human' });
  r = await call('POST', `/api/games/${id}/move`, { title: 'Moon' });
  assert.equal(r.data.game.status, 'won');
  assert.equal(r.data.game.clicks, 3);

  r = await call('POST', `/api/games/${id}/move`, { title: 'Earth' });
  assert.equal(r.status, 409, 'finished games are frozen');

  app.store.flush();
  const { data: h } = await call('GET', '/api/history');
  const entry = h.history.find((x) => x.id === id);
  assert.equal(entry.result, 'won');
  assert.deepEqual(entry.path, ['Cat', 'Pet', 'Human', 'Moon']);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8')).length >= 1);
});

test('redirects resolve and targets are canonicalised', async () => {
  const { data } = await newGame({ start: 'Dog', target: 'The Moon' });
  assert.equal(data.game.target, 'Moon');
  const r = await call('POST', `/api/games/${data.game.id}/move`, { title: 'Cat' });
  const r2 = await call('POST', `/api/games/${data.game.id}/move`, { title: 'Kitty' });
  assert.equal(r.data.game.current, 'Cat');
  assert.equal(r2.data.game.current, 'Cat', 'redirect Kitty -> Cat');
});

test('missing articles are reported', async () => {
  const r = await newGame({ target: 'Not a real page' });
  assert.equal(r.status, 404);
  assert.match(r.data.error, /Not a real page/);
});

test('banned pages and date bans', async () => {
  const { data } = await newGame({ rules: { banDates: true, bannedPages: ['united states'] } });
  const id = data.game.id;
  let r = await call('POST', `/api/games/${id}/move`, { title: '1999' });
  assert.equal(r.status, 400);
  r = await call('POST', `/api/games/${id}/move`, { title: 'Pet' });
  r = await call('POST', `/api/games/${id}/move`, { title: 'United States' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /banned/);
});

test('back button rules', async () => {
  let { data } = await newGame({ rules: { allowBack: true, backCountsAsClick: false } });
  let id = data.game.id;
  await call('POST', `/api/games/${id}/move`, { title: 'Pet' });
  let r = await call('POST', `/api/games/${id}/back`);
  assert.equal(r.data.game.current, 'Cat');
  assert.equal(r.data.game.clicks, 1);
  assert.equal(r.data.game.backs, 1);

  ({ data } = await newGame({ rules: { allowBack: false } }));
  id = data.game.id;
  await call('POST', `/api/games/${id}/move`, { title: 'Pet' });
  r = await call('POST', `/api/games/${id}/back`);
  assert.equal(r.status, 400);
});

test('click limit and checkpoint', async () => {
  let { data } = await newGame({ rules: { clickLimit: 2 } });
  let id = data.game.id;
  await call('POST', `/api/games/${id}/move`, { title: 'Pet' });
  let r = await call('POST', `/api/games/${id}/move`, { title: 'Human' });
  assert.equal(r.data.game.status, 'lost');
  assert.equal(r.data.game.reason, 'Out of clicks');

  // Reaching the target on the last allowed click still wins.
  ({ data } = await newGame({ start: 'Human', rules: { clickLimit: 1 } }));
  r = await call('POST', `/api/games/${data.game.id}/move`, { title: 'Moon' });
  assert.equal(r.data.game.status, 'won');

  // Must pass through the checkpoint first.
  ({ data } = await newGame({ start: 'Human', via: 'Earth' }));
  id = data.game.id;
  r = await call('POST', `/api/games/${id}/move`, { title: 'Moon' });
  assert.equal(r.data.game.status, 'active');
  await call('POST', `/api/games/${id}/move`, { title: 'Earth' });
  r = await call('POST', `/api/games/${id}/move`, { title: 'Human' });
  r = await call('POST', `/api/games/${id}/move`, { title: 'Moon' });
  assert.equal(r.data.game.status, 'won');
  assert.equal(r.data.game.viaReached, true);
});

test('time limit is enforced by the server', async () => {
  const { data } = await newGame({ rules: { timeLimit: 1 } });
  await new Promise((r) => setTimeout(r, 1200));
  const r = await call('POST', `/api/games/${data.game.id}/move`, { title: 'Pet' });
  assert.equal(r.status, 409);
  const g = await call('GET', `/api/games/${data.game.id}`);
  assert.equal(g.data.game.status, 'lost');
  assert.equal(g.data.game.reason, 'Time ran out');
  assert.equal(g.data.game.elapsed, 1000);
});

test('pair picking, daily, search, summary', async () => {
  const pair = await call('GET', '/api/pair?difficulty=hard');
  assert.equal(pair.status, 200);
  assert.notEqual(pair.data.start, pair.data.target);
  const d1 = await call('GET', '/api/daily');
  const d2 = await call('GET', '/api/daily');
  assert.deepEqual(d1.data, d2.data, 'daily is deterministic');
  const s = await call('GET', '/api/search?q=ph');
  assert.deepEqual(s.data.results, ['Philosophy']);
  const sum = await call('GET', '/api/summary?title=Cat');
  assert.match(sum.data.extract, /testing/);
});

test('caching avoids repeat requests to Wikipedia', async () => {
  await call('GET', '/api/summary?title=Whale');
  const before = mock.requests;
  await call('GET', '/api/summary?title=Whale');
  assert.equal(mock.requests, before);
});

test('image proxy only allows Wikimedia hosts', async () => {
  const r = await call('GET', '/api/img?u=' + encodeURIComponent('https://example.com/a.png'));
  assert.equal(r.status, 403);
  const r2 = await call('GET', '/api/img?u=' + encodeURIComponent('http://upload.wikimedia.org/a.png'));
  assert.equal(r2.status, 403);
});

test('static files are served with a same-origin CSP', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /connect-src 'self'/);
  const traversal = await fetch(base + '/..%2fserver.js');
  assert.notEqual(traversal.status, 200);
});

function listen(url) {
  const messages = [];
  const waiters = [];
  const req = http.get(base + url, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const msg = JSON.parse(line.slice(6));
        messages.push(msg);
        for (const w of waiters.splice(0)) w();
      }
    });
  });
  return {
    close: () => req.destroy(),
    async until(pred, ms = 6000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = messages.slice().reverse().find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error('timeout waiting for room state');
        await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
      }
    },
  };
}

test('multiplayer room: lobby, race, results', async () => {
  const host = (await call('POST', '/api/rooms', { name: 'Ana', settings: { difficulty: 'custom', start: 'Cat', target: 'Moon' } })).data;
  const guest = (await call('POST', `/api/rooms/${host.roomId.toLowerCase()}/join`, { name: 'ana' })).data;
  const bad = await call('POST', `/api/rooms/${host.roomId}/start`, { player: guest.playerId, token: guest.token });
  assert.equal(bad.status, 403, 'only the host can start');

  const hs = listen(`/api/rooms/${host.roomId}/events?player=${host.playerId}&token=${host.token}`);
  const gs = listen(`/api/rooms/${host.roomId}/events?player=${guest.playerId}&token=${guest.token}`);
  const lobby = await gs.until((m) => m.players.length === 2);
  assert.deepEqual(lobby.players.map((p) => p.name).sort(), ['Ana', 'ana 2']);

  const st = await call('POST', `/api/rooms/${host.roomId}/start`, { player: host.playerId, token: host.token });
  assert.equal(st.status, 200);
  const hState = await hs.until((m) => m.status === 'countdown');
  const gState = await gs.until((m) => m.status === 'countdown');
  assert.notEqual(hState.you.gameId, gState.you.gameId);
  assert.equal(hState.round.start, 'Cat');

  const early = await call('POST', `/api/games/${hState.you.gameId}/move`, { title: 'Pet' });
  assert.equal(early.status, 425, 'no moves before the countdown ends');
  await hs.until((m) => m.status === 'racing');

  for (const t of ['Pet', 'Human', 'Moon']) await call('POST', `/api/games/${gState.you.gameId}/move`, { title: t });
  await call('POST', `/api/games/${hState.you.gameId}/giveup`);
  const done = await hs.until((m) => m.status === 'results');
  assert.equal(done.round.results[0].name, 'ana 2');
  assert.equal(done.round.results[0].rank, 1);
  assert.equal(done.round.results[1].status, 'gaveup');
  hs.close();
  gs.close();
});
