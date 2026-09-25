// Chooses start/target pairs for each difficulty and for the daily challenge.
const ARTICLES = require('./articles');
const { normalizeTitle } = require('../public/rules');
const { WikiError } = require('./wiki');

const DIFFICULTIES = ['easy', 'medium', 'hard'];

function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

class Picker {
  constructor(wiki) { this.wiki = wiki; }

  async curated(lang, rand = Math.random, exclude = []) {
    const skip = new Set(exclude.map(normalizeTitle));
    for (let attempt = 0; attempt < 8; attempt++) {
      const en = ARTICLES[Math.floor(rand() * ARTICLES.length)];
      const title = lang === 'en' ? en : await this.wiki.translate(en, lang);
      if (title && !skip.has(normalizeTitle(title))) return title;
    }
    return this.wiki.randomSubstantial(lang);
  }

  async pick(lang, difficulty, role, exclude = []) {
    if (!DIFFICULTIES.includes(difficulty)) difficulty = 'medium';
    const skip = new Set(exclude.map(normalizeTitle));
    for (let attempt = 0; attempt < 5; attempt++) {
      let title;
      if (difficulty === 'easy') title = await this.curated(lang, Math.random, exclude);
      else if (difficulty === 'medium') {
        title = role === 'target' ? await this.curated(lang, Math.random, exclude) : await this.wiki.randomSubstantial(lang);
      } else {
        title = role === 'target' ? await this.wiki.randomSubstantial(lang, 10) : (await this.wiki.randomTitles(lang, 1))[0];
      }
      if (title && !skip.has(normalizeTitle(title))) return title;
    }
    throw new WikiError('Could not pick a page, try again');
  }

  async pair(lang, difficulty) {
    const start = await this.pick(lang, difficulty, 'start');
    const target = await this.pick(lang, difficulty, 'target', [start]);
    return { start, target };
  }

  // Same pair for everyone on the same calendar day (translated for other languages).
  async daily(lang, dateKey = todayKey()) {
    const rand = mulberry32(hashSeed(`wikirace-daily|${dateKey}`));
    const start = await this.curated(lang, rand);
    const target = await this.curated(lang, rand, [start]);
    return { start, target, date: dateKey };
  }
}

module.exports = { Picker, todayKey, DIFFICULTIES };