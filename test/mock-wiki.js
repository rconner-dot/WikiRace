// A tiny fake of the MediaWiki API endpoints WikiRace uses, for offline tests
// and development: WIKI_URL=http://127.0.0.1:8081 node server.js
const http = require('http');

const GRAPH = {
  Cat: ['Dog', 'Pet', 'Mammal', '1999', 'Kitty'],
  Dog: ['Pet', 'Cat'],
  Pet: ['Dog', 'Cat', 'Human', 'United States'],
  Mammal: ['Human', 'Whale'],
  Human: ['Earth', 'Moon', 'Philosophy'],
  Earth: ['Moon', 'Human', 'United States'],
  Moon: ['Earth'],
  Whale: ['Mammal'],
  Philosophy: ['Earth', 'Human'],
  'United States': ['Moon', 'Earth'],
  1999: ['Moon'],
  'Dead end': [],
};
const REDIRECTS = { Kitty: 'Cat', 'The Moon': 'Moon' };
const TRANSLATIONS = { de: { Cat: 'Hauskatze', Moon: 'Mond' } };

function resolve(title) {
  const t = String(title || '').replace(/_/g, ' ');
  const n = t.charAt(0).toUpperCase() + t.slice(1);
  return REDIRECTS[n] || n;
}

function html(title) {
  const links = GRAPH[title] || [];
  const a = links.map((l) => `<a href="/wiki/${encodeURIComponent(l.replace(/ /g, '_'))}" title="${l}">${l}</a>`).join(', ');
  return `<div class="mw-parser-output"><p><b>${title}</b> is a test article linking to ${a || 'nothing'}.</p>`
    + '<p><a href="https://example.com/">External</a> <a href="/wiki/File:X.jpg">File</a> '
    + '<a href="/w/index.php?title=Nope&amp;action=edit&amp;redlink=1" class="new">Nope</a>'
    + '<img src="//upload.wikimedia.org/x.png" onerror="alert(1)"><script>alert(1)</script></p>'
    + '<div class="mw-heading mw-heading2"><h2 id="See_also">See also</h2></div><ul><li>More</li></ul></div>';
}

function handle(q) {
  const action = q.get('action');
  if (action === 'parse') {
    const title = resolve(q.get('page'));
    if (!(title in GRAPH)) return { error: { code: 'missingtitle', info: "The page you specified doesn't exist." } };
    return {
      parse: {
        title,
        pageid: Object.keys(GRAPH).indexOf(title) + 1,
        displaytitle: `<span class="mw-page-title-main">${title}</span>`,
        text: html(title),
        links: [
          ...GRAPH[title].map((l) => ({ ns: 0, title: l, exists: true })),
          { ns: 0, title: 'Nope', exists: false },
          { ns: 6, title: 'File:X.jpg', exists: true },
        ],
      },
    };
  }
  if (action === 'query') {
    if (q.get('list') === 'random') {
      const all = Object.keys(GRAPH);
      return { query: { random: [{ ns: 0, title: all[Math.floor(Math.random() * all.length)] }] } };
    }
    if (q.get('generator') === 'random') {
      const all = Object.keys(GRAPH).filter((t) => t !== 'Dead end');
      return { query: { pages: all.slice(0, 5).map((t) => ({ ns: 0, title: t, length: Math.floor(Math.random() * 1000) })) } };
    }
    if (q.get('list') === 'prefixsearch') {
      const s = String(q.get('pssearch')).toLowerCase();
      return { query: { prefixsearch: Object.keys(GRAPH).filter((t) => t.toLowerCase().startsWith(s)).map((title) => ({ ns: 0, title })) } };
    }
    const title = resolve(q.get('titles'));
    if (q.get('prop') === 'langlinks') {
      const tr = TRANSLATIONS[q.get('lllang')] || {};
      return { query: { pages: [{ ns: 0, title, langlinks: tr[title] ? [{ lang: q.get('lllang'), title: tr[title] }] : undefined }] } };
    }
    if (!(title in GRAPH)) return { query: { pages: [{ ns: 0, title, missing: true }] } };
    return { query: { pages: [{ ns: 0, title, extract: `${title} is an article used for testing.` }] } };
  }
  return { error: { code: 'badaction', info: 'Unsupported' } };
}

function startMock(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    server.requests = (server.requests || 0) + 1;
    const body = JSON.stringify(url.pathname === '/w/api.php' ? handle(url.searchParams) : { error: { code: 'notfound' } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  return new Promise((resolveP) => server.listen(port, '127.0.0.1', () => resolveP(server)));
}

if (require.main === module) {
  startMock(Number(process.env.PORT || 8081)).then((s) => console.log(`Mock wiki on http://127.0.0.1:${s.address().port}`));
}

module.exports = { startMock, GRAPH };
