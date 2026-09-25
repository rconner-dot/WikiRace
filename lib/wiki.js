// The only part of the app that talks to the outside world. Everything goes to
// <lang>.wikipedia.org (or upload.wikimedia.org for images) and is cached in
// memory and on disk so repeat visits never leave the machine.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeTitle } = require('../public/rules');

const USER_AGENT = 'WikiRaceLocal/1.0 (self-hosted game; https://github.com/rconner-dot/WikiRace)';
const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'wikimedia.org']);

class WikiError extends Error {
  constructor(message, status = 502, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class LRU {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

class WikiClient {
  constructor(opts = {}) {
    this.template = opts.template || 'https://{lang}.wikipedia.org';
    this.cacheDir = opts.cacheDir || null;
    this.ttlMs = opts.ttlMs ?? 7 * 24 * 3600 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.pages = new LRU(opts.memoryPages || 300);
    this.small = new LRU(2000); // summaries, resolved titles, translations
    this.inflight = new Map();
    this.stats = { requests: 0, memoryHits: 0, diskHits: 0 };
  }

  base(lang) {
    if (!/^[a-z][a-z-]{1,15}$/.test(lang)) throw new WikiError('Invalid language code', 400);
    return this.template.replace('{lang}', lang);
  }

  async api(lang, params) {
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    const url = `${this.base(lang)}/w/api.php?${qs}`;
    this.stats.requests++;
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new WikiError(`Could not reach Wikipedia (${e.cause?.code || e.name || e.message})`, 502);
    }
    if (!res.ok) throw new WikiError(`Wikipedia returned HTTP ${res.status}`, 502);
    const json = await res.json();
    if (json.error) {
      const status = json.error.code === 'missingtitle' || json.error.code === 'invalidtitle' ? 404 : 502;
      throw new WikiError(json.error.info || json.error.code, status, json.error.code);
    }
    return json;
  }

  // Deduplicate identical concurrent lookups (e.g. eight racers loading the same start page).
  once(key, fn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  diskPath(kind, lang, key) {
    if (!this.cacheDir) return null;
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(this.cacheDir, kind, lang, hash.slice(0, 2), hash + '.json');
  }

  readDisk(file) {
    if (!file) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - entry.fetchedAt > this.ttlMs) return null;
      return entry.data;
    } catch (e) {
      return null;
    }
  }

  writeDisk(file, data) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), data }));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.warn('[cache] write failed:', e.message);
    }
  }

  // Full article: rendered HTML plus the list of article links it contains.
  async getPage(lang, rawTitle) {
    const title = normalizeTitle(rawTitle);
    if (!title) throw new WikiError('Missing page title', 400);
    const key = `${lang}|${title}`;
    const mem = this.pages.get(key);
    if (mem) { this.stats.memoryHits++; return mem; }
    const file = this.diskPath('pages', lang, title);
    const disk = this.readDisk(file);
    if (disk) {
      this.stats.diskHits++;
      this.pages.set(key, disk);
      return disk;
    }
    return this.once('page:' + key, async () => {
      const json = await this.api(lang, {
        action: 'parse',
        page: title,
        redirects: '1',
        prop: 'text|links|displaytitle',
        disableeditsection: '1',
        disabletoc: '1',
        disablelimitreport: '1',
      });
      const p = json.parse;
      const page = {
        title: p.title,
        displayTitle: p.displaytitle || p.title,
        pageId: p.pageid,
        html: p.text,
        links: [...new Set((p.links || [])
          .filter((l) => l.ns === 0 && l.exists !== false)
          .map((l) => normalizeTitle(l.title)))],
      };
      this.pages.set(key, page);
      this.writeDisk(file, page);
      // Also cache under the canonical title so redirects share one entry.
      const canon = `${lang}|${normalizeTitle(page.title)}`;
      if (canon !== key) this.pages.set(canon, page);
      return page;
    });
  }

  // Resolve redirects / capitalisation. Returns the canonical title or null if missing.
  async resolveTitle(lang, rawTitle) {
    const title = normalizeTitle(rawTitle);
    if (!title) return null;
    const key = `resolve|${lang}|${title}`;
    const hit = this.small.get(key);
    if (hit !== undefined) return hit;
    const json = await this.once(key, () => this.api(lang, { action: 'query', titles: title, redirects: '1' }));
    const page = json.query && json.query.pages && json.query.pages[0];
    const result = !page || page.missing || page.invalid || page.ns !== 0 ? null : page.title;
    this.small.set(key, result);
    return result;
  }

  async randomTitles(lang, count = 1) {
    const json = await this.api(lang, { action: 'query', list: 'random', rnnamespace: '0', rnlimit: String(count) });
    return json.query.random.map((r) => r.title);
  }

  // Pull a batch of random articles and keep the longest: biased toward real,
  // well-linked articles instead of one-line stubs.
  async randomSubstantial(lang, batch = 20) {
    const json = await this.api(lang, {
      action: 'query', generator: 'random', grnnamespace: '0', grnlimit: String(batch), prop: 'info',
    });
    const pages = (json.query && json.query.pages) || [];
    pages.sort((a, b) => (b.length || 0) - (a.length || 0));
    if (!pages.length) throw new WikiError('Wikipedia returned no random pages');
    return pages[0].title;
  }

  async summary(lang, rawTitle) {
    const title = normalizeTitle(rawTitle);
    const key = `summary|${lang}|${title}`;
    const hit = this.small.get(key);
    if (hit) return hit;
    const file = this.diskPath('summaries', lang, title);
    const disk = this.readDisk(file);
    if (disk) { this.small.set(key, disk); return disk; }
    return this.once(key, async () => {
      const json = await this.api(lang, {
        action: 'query', titles: title, redirects: '1',
        prop: 'extracts|pageimages', exintro: '1', explaintext: '1', exsentences: '4',
        piprop: 'thumbnail', pithumbsize: '320',
      });
      const page = json.query && json.query.pages && json.query.pages[0];
      if (!page || page.missing) throw new WikiError('Page not found', 404);
      const data = {
        title: page.title,
        extract: page.extract || '',
        thumbnail: page.thumbnail ? page.thumbnail.source : null,
      };
      this.small.set(key, data);
      this.writeDisk(file, data);
      return data;
    });
  }

  async search(lang, q) {
    q = String(q || '').trim().slice(0, 100);
    if (!q) return [];
    const key = `search|${lang}|${q.toLowerCase()}`;
    const hit = this.small.get(key);
    if (hit) return hit;
    const json = await this.api(lang, {
      action: 'query', list: 'prefixsearch', pssearch: q, psnamespace: '0', pslimit: '10',
    });
    const results = ((json.query && json.query.prefixsearch) || []).map((r) => r.title);
    this.small.set(key, results);
    return results;
  }

  // Translate an English title into another language via interlanguage links.
  async translate(title, toLang) {
    if (toLang === 'en') return title;
    const key = `translate|${toLang}|${title}`;
    const hit = this.small.get(key);
    if (hit !== undefined) return hit;
    const json = await this.api('en', {
      action: 'query', titles: title, redirects: '1', prop: 'langlinks', lllang: toLang,
    });
    const page = json.query && json.query.pages && json.query.pages[0];
    const ll = page && page.langlinks && page.langlinks[0];
    const result = ll ? ll.title : null;
    this.small.set(key, result);
    return result;
  }

  // Images are proxied so the browser only ever talks to this server.
  async fetchImage(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl);
    } catch (e) {
      throw new WikiError('Bad image URL', 400);
    }
    if (u.protocol !== 'https:' || !IMAGE_HOSTS.has(u.hostname)) throw new WikiError('Image host not allowed', 403);
    this.stats.requests++;
    const res = await fetch(u, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new WikiError(`Image fetch failed (${res.status})`, 502);
    return res;
  }

  clearCache() {
    this.pages.clear();
    this.small.clear();
    if (this.cacheDir) {
      for (const kind of ['pages', 'summaries']) {
        fs.rmSync(path.join(this.cacheDir, kind), { recursive: true, force: true });
      }
    }
  }

  cacheInfo() {
    let files = 0;
    let bytes = 0;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { files++; try { bytes += fs.statSync(p).size; } catch (err) { /* raced */ } }
      }
    };
    if (this.cacheDir) walk(this.cacheDir);
    return { ...this.stats, memoryPages: this.pages.size, diskFiles: files, diskBytes: bytes };
  }
}

module.exports = { WikiClient, WikiError, IMAGE_HOSTS };