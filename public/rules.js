// Shared between the browser and the Node server: title normalisation and
// rule checks, so the UI and the referee always agree.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WikiRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const MONTH_RE = MONTHS.join('|');
  const DATE_PATTERNS = [
    /^\d{1,4}$/,                                   // 1066, 2004
    /^\d{1,4} (BC|BCE|AD|CE)$/i,                   // 44 BC
    /^(AD|CE) \d{1,4}$/i,                          // AD 79
    /^\d{1,4}0s( (BC|BCE))?$/i,                    // 1990s
    /^\d{1,2}(st|nd|rd|th) (century|millennium)( (BC|BCE|AD|CE))?$/i,
    new RegExp('^(' + MONTH_RE + ') \\d{1,2}$'),   // July 4
    new RegExp('^\\d{1,2} (' + MONTH_RE + ')$'),   // 4 July
    new RegExp('^(' + MONTH_RE + ') \\d{3,4}$'),   // July 1969
    /^\d{3,4}s? in .+/,                             // 2004 in film, 1990s in music
    /^List of .*/i,                                // lists are basically link dumps
  ];

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  // Turn "/wiki/Domestic_cat", "Domestic_cat" or "domestic cat" into "Domestic cat".
  function normalizeTitle(raw) {
    if (raw == null) return '';
    let t = String(raw);
    t = t.replace(/^\.\//, '').replace(/^\/wiki\//, '');
    const hash = t.indexOf('#');
    if (hash >= 0) t = t.slice(0, hash);
    t = safeDecode(t).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function sameTitle(a, b) {
    return normalizeTitle(a) === normalizeTitle(b);
  }

  function isDateLike(title) {
    const t = normalizeTitle(title);
    return DATE_PATTERNS.some((re) => re.test(t));
  }

  function bannedSet(rules) {
    // Case-insensitive: people type ban lists by hand.
    return new Set((rules && rules.bannedPages || []).map((t) => normalizeTitle(t).toLowerCase()).filter(Boolean));
  }

  // Returns a human reason string if the page is off limits, otherwise null.
  function banReason(title, rules, set) {
    if (!rules) return null;
    const t = normalizeTitle(title);
    if ((set || bannedSet(rules)).has(t.toLowerCase())) return 'This page is banned for this race';
    if (rules.banDates && isDateLike(t)) return 'Year, date and list pages are banned for this race';
    return null;
  }

  const DEFAULT_RULES = {
    lang: 'en',
    timeLimit: 0,          // seconds, 0 = none
    clickLimit: 0,         // 0 = none
    allowBack: true,
    backCountsAsClick: true,
    banDates: false,
    bannedPages: [],
  };

  function cleanRules(input) {
    const r = Object.assign({}, DEFAULT_RULES, input || {});
    const lang = String(r.lang || 'en').toLowerCase();
    return {
      lang: /^[a-z][a-z-]{1,15}$/.test(lang) ? lang : 'en',
      timeLimit: clampInt(r.timeLimit, 0, 24 * 3600),
      clickLimit: clampInt(r.clickLimit, 0, 1000),
      allowBack: !!r.allowBack,
      backCountsAsClick: !!r.backCountsAsClick,
      banDates: !!r.banDates,
      bannedPages: (Array.isArray(r.bannedPages) ? r.bannedPages : String(r.bannedPages || '').split(/\n|,/))
        .map(normalizeTitle).filter(Boolean).slice(0, 100),
    };
  }

  function clampInt(v, min, max) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  return { normalizeTitle, sameTitle, isDateLike, bannedSet, banReason, DEFAULT_RULES, cleanRules };
});
