/* WikiRace Local: browser client. Talks only to this server (same origin). */
(() => {
  'use strict';
  const R = window.WikiRules;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ------------------------------------------------------------------ settings
  const RULE_KEYS = ['lang', 'timeLimit', 'clickLimit', 'allowBack', 'backCountsAsClick', 'banDates', 'bannedPages'];
  const DEFAULT_SETTINGS = {
    ...R.DEFAULT_RULES,
    preset: 'classic',
    playerName: '',
    showImages: true,
    hideInfobox: false,
    hideNavboxes: false,
    hideSeeAlso: false,
    hideReferences: false,
    hideDeadText: false,
    showTargetPreview: true,
    showPath: true,
    highlightTarget: false,
    confirmGiveUp: true,
    theme: 'auto',
    fontSize: '16',
    width: 'normal',
  };
  const BASE_RULES = { timeLimit: 0, clickLimit: 0, allowBack: true, backCountsAsClick: true, banDates: false, bannedPages: [] };
  const PRESETS = {
    classic: { ...BASE_RULES },
    speedrun: { ...BASE_RULES, timeLimit: 180 },
    sixdegrees: { ...BASE_RULES, clickLimit: 6 },
    nousa: { ...BASE_RULES, bannedPages: ['United States'] },
    purist: { ...BASE_RULES, allowBack: false, banDates: true },
    hardcore: { ...BASE_RULES, timeLimit: 90, clickLimit: 10, allowBack: false, banDates: true, showImages: false, highlightTarget: false },
  };

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
    sget(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch (e) { return null; } },
    sset(key, value) { try { if (value == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ } },
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS, ...store.get('wikirace.settings', {}) },
    mode: store.get('wikirace.mode', 'random'),
    pair: { start: null, target: null },
    game: null,
    page: null,
    clockOffset: 0,
    busy: false,
    config: null,
    lastSetup: null,
    session: store.sget('wikirace.room'),
    room: null,
    es: null,
    countdownTimer: null,
    view: 'home',
  };

  const rules = () => R.cleanRules(Object.fromEntries(RULE_KEYS.map((k) => [k, state.settings[k]])));
  const saveSettings = () => store.set('wikirace.settings', state.settings);
  const now = () => Date.now() + state.clockOffset;

  // ------------------------------------------------------------------ helpers
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) e.append(c);
    return e;
  }

  function toast(msg, type) {
    const t = el('div', { class: 'toast' + (type ? ' ' + type : ''), text: msg });
    $('#toasts').append(t);
    setTimeout(() => t.remove(), type === 'error' ? 4500 : 2500);
  }

  function fmtTime(ms) {
    if (ms == null) return '–';
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function fmtPrecise(ms) {
    return `${fmtTime(ms)}.${String(Math.floor((ms % 1000) / 100))}`;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied to clipboard');
  }

  let loadingTimer;
  function setLoading(on) {
    clearTimeout(loadingTimer);
    if (on) loadingTimer = setTimeout(() => $('#loading').classList.remove('hidden'), 150);
    else $('#loading').classList.add('hidden');
  }

  // ------------------------------------------------------------------ appearance
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function applyAppearance() {
    const s = state.settings;
    const theme = s.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : s.theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--article-size', `${Number(s.fontSize) || 16}px`);
    document.documentElement.style.setProperty('--article-width', s.width === 'narrow' ? '720px' : '900px');
    document.body.dataset.width = s.width;
    document.body.dataset.dim = s.hideDeadText ? '1' : '0';
  }
  darkQuery.addEventListener('change', applyAppearance);

  // ------------------------------------------------------------------ navigation
  function show(view) {
    state.view = view;
    for (const v of $$('.view')) v.classList.toggle('hidden', v.id !== 'view-' + view);
    for (const b of $$('.nav [data-nav]')) b.classList.toggle('active', b.dataset.nav === view);
    if (view === 'home') renderHome();
    if (view === 'history') renderHistory();
    if (view === 'multi') renderMulti();
    if (view !== 'game') window.scrollTo(0, 0);
  }

  for (const b of $$('[data-nav]')) {
    b.addEventListener('click', () => {
      if (b.dataset.nav === 'multi' && state.room && state.game && state.game.roomId && state.game.status === 'active' && state.view === 'game') {
        show('multi');
        return;
      }
      show(b.dataset.nav);
    });
  }

  // ------------------------------------------------------------------ home
  const summaries = new Map();
  async function getSummary(title, lang = rules().lang) {
    const key = lang + '|' + title;
    if (!summaries.has(key)) {
      summaries.set(key, api('GET', `/api/summary?lang=${encodeURIComponent(lang)}&title=${encodeURIComponent(title)}`)
        .catch((e) => { summaries.delete(key); throw e; }));
    }
    return summaries.get(key);
  }

  function summaryNode(sum, big) {
    const frag = document.createDocumentFragment();
    if (sum.thumbnail && state.settings.showImages) frag.append(el('img', { src: sum.thumbnail, alt: '' }));
    frag.append(el(big ? 'h4' : 'strong', { text: sum.title }));
    frag.append(el('p', { text: sum.extract || 'No summary available.' }));
    return frag;
  }
  async function fillPairCard(which, title) {
    const body = $(`#pair-${which} .pair-body`);
    if (!title) { body.replaceChildren(el('span', { class: 'muted', text: 'Random' })); return; }
    body.replaceChildren(el('h4', { text: title }), el('p', { class: 'muted', text: 'Loading summary…' }));
    try {
      const sum = await getSummary(title);
      if (state.pair[which] === title) body.replaceChildren(summaryNode(sum, true));
    } catch (e) {
      body.replaceChildren(el('h4', { text: title }), el('p', { class: 'muted', text: e.message }));
    }
  }

  function setPair(start, target) {
    state.pair = { start, target };
    fillPairCard('start', start);
    fillPairCard('target', target);
    if (state.mode === 'custom') {
      $('#custom-start').value = start || '';
      $('#custom-target').value = target || '';
    }
  }

  function setMode(mode) {
    state.mode = mode;
    store.set('wikirace.mode', mode);
    for (const b of $$('#mode-tabs button')) b.classList.toggle('active', b.dataset.mode === mode);
    for (const p of $$('.mode-panel')) p.classList.toggle('hidden', p.dataset.panel !== mode);
    $('#pick').textContent = mode === 'custom' ? 'Fill blanks randomly' : mode === 'daily' ? "Show today's pair" : 'Pick pages';
    $$('[data-reroll]').forEach((b) => b.classList.toggle('hidden', mode === 'daily'));
    $('#swap').classList.toggle('hidden', mode === 'daily');
    $('.via-row').classList.toggle('hidden', mode === 'daily');
    if (mode === 'daily') loadDaily();
    else if (mode === 'custom') setPair($('#custom-start').value.trim() || null, $('#custom-target').value.trim() || null);
    else setPair(null, null);
  }

  async function loadDaily() {
    try {
      const d = await api('GET', `/api/daily?lang=${rules().lang}`);
      $('#daily-date').textContent = d.date;
      if (state.mode === 'daily') setPair(d.start, d.target);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function pickPages() {
    const lang = rules().lang;
    const diff = $('#difficulty').value;
    const btn = $('#pick');
    btn.disabled = true;
    try {
      if (state.mode === 'daily') await loadDaily();
      else if (state.mode === 'random') {
        const p = await api('GET', `/api/pair?lang=${lang}&difficulty=${diff}`);
        setPair(p.start, p.target);
      } else {
        let s = $('#custom-start').value.trim();
        let t = $('#custom-target').value.trim();
        if (!s) s = (await api('GET', `/api/random?lang=${lang}&difficulty=medium&role=start`)).title;
        if (!t) t = (await api('GET', `/api/random?lang=${lang}&difficulty=medium&role=target&exclude=${encodeURIComponent(s)}`)).title;
        setPair(s, t);
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function reroll(which) {
    const lang = rules().lang;
    const diff = state.mode === 'random' ? $('#difficulty').value : 'medium';
    const other = which === 'start' ? state.pair.target : state.pair.start;
    try {
      const q = `/api/random?lang=${lang}&difficulty=${diff}&role=${which}` + (other ? `&exclude=${encodeURIComponent(other)}` : '');
      const { title } = await api('GET', q);
      setPair(which === 'start' ? title : state.pair.start, which === 'target' ? title : state.pair.target);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function renderRulesSummary(target, r, extra = {}) {
    const chips = [];
    chips.push(r.lang + '.wikipedia');
    chips.push(r.timeLimit ? `${fmtTime(r.timeLimit * 1000)} limit` : 'no time limit');
    chips.push(r.clickLimit ? `${r.clickLimit} clicks max` : 'unlimited clicks');
    chips.push(r.allowBack ? (r.backCountsAsClick ? 'back costs a click' : 'free back') : 'no back button');
    if (r.banDates) chips.push('no dates/lists');
    if (r.bannedPages.length) chips.push('banned: ' + r.bannedPages.join(', '));
    if (extra.via) chips.push('via ' + extra.via);
    target.replaceChildren('Rules: ', ...chips.map((c) => el('span', { class: 'chip', text: c })),
      extra.noEdit ? '' : el('button', { class: 'icon-btn', text: 'edit', onclick: openSettings }));
  }

  async function renderHome() {
    renderRulesSummary($('#rules-summary'), rules(), { via: state.mode !== 'daily' && $('#custom-via').value.trim() });
    const box = $('#home-stats');
    box.replaceChildren();
    if (state.game && state.game.status === 'active' && !state.game.roomId) {
      box.append(el('div', { class: 'hint' }, `You have a race in progress: ${state.game.start} → ${state.game.target}. `,
        el('button', { class: 'primary', text: 'Resume', onclick: () => show('game') })));
    }
    try {
      const { history } = await api('GET', '/api/history');
      if (!history.length) {
        box.append(el('p', { class: 'muted', text: 'No races yet. Your results are saved on this computer.' }));
        return;
      }
      box.append(el('h3', { text: 'Recent races' }));
      for (const h of history.slice(0, 5)) box.append(historyRow(h));
    } catch (e) { /* offline server */ }
  }

  async function startSolo(setup) {
    setup = setup || currentSetup();
    if (!setup) return;
    const btn = $('#go');
    btn.disabled = true;
    setLoading(true);
    try {
      const resp = await api('POST', '/api/games', { ...setup, rules: rules(), playerName: state.settings.playerName || 'Player' });
      state.lastSetup = { ...setup, start: resp.game.start, target: resp.game.target, via: resp.game.via };
      if (setup.daily) state.lastSetup = { daily: true };
      enterGame(resp);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      setLoading(false);
    }
  }

  function currentSetup() {
    const via = $('#custom-via').value.trim() || null;
    if (state.mode === 'daily') return { daily: true };
    if (state.mode === 'custom') {
      return { start: $('#custom-start').value.trim() || state.pair.start, target: $('#custom-target').value.trim() || state.pair.target, via };
    }
    return { start: state.pair.start, target: state.pair.target, via };
  }

  $('#mode-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('#pick').addEventListener('click', pickPages);
  $('#go').addEventListener('click', async () => {
    if (state.mode === 'random' && (!state.pair.start || !state.pair.target)) await pickPages();
    if (state.mode === 'random' && (!state.pair.start || !state.pair.target)) return;
    if (state.mode === 'custom' && (!$('#custom-start').value.trim() || !$('#custom-target').value.trim())) await pickPages();
    startSolo();
  });
  $('#swap').addEventListener('click', () => setPair(state.pair.target, state.pair.start));
  for (const b of $$('[data-reroll]')) b.addEventListener('click', () => reroll(b.dataset.reroll));
  $('#custom-start').addEventListener('change', (e) => { state.pair.start = e.target.value.trim() || null; fillPairCard('start', state.pair.start); });
  $('#custom-target').addEventListener('change', (e) => { state.pair.target = e.target.value.trim() || null; fillPairCard('target', state.pair.target); });
  $('#custom-via').addEventListener('input', debounce(() => renderRulesSummary($('#rules-summary'), rules(), { via: $('#custom-via').value.trim() }), 200));
  $('#difficulty').addEventListener('change', () => { store.set('wikirace.difficulty', $('#difficulty').value); setPair(null, null); });

  // Title autocomplete for every input bound to one of our datalists.
  const searchFor = debounce(async (input) => {
    const list = document.getElementById(input.getAttribute('list'));
    const q = input.value.trim();
    if (!list || q.length < 2) return;
    try {
      const lang = input.form && input.form.id === 'room-settings' && state.room ? state.room.settings.rules.lang : rules().lang;
      const { results } = await api('GET', `/api/search?lang=${lang}&q=${encodeURIComponent(q)}`);
      list.replaceChildren(...results.map((t) => el('option', { value: t })));
    } catch (e) { /* ignore */ }
  }, 250);
  document.addEventListener('input', (e) => {
    const l = e.target.getAttribute && e.target.getAttribute('list');
    if (l && l.startsWith('dl-') && l !== 'dl-langs') searchFor(e.target);
  });

  // ------------------------------------------------------------------ game
  function enterGame(resp) {
    closeModal('#result-modal');
    state.game = resp.game;
    state.clockOffset = resp.game.serverNow - Date.now();
    show('game');
    renderGameBar();
    renderSidebar();
    if (resp.page) renderPage(resp.page);
    startTicker();
  }

  function renderGameBar() {
    const g = state.game;
    if (!g) return;
    $('#g-start').textContent = g.start;
    $('#g-target').textContent = g.target;
    const via = $('#g-via');
    via.classList.toggle('hidden', !g.via);
    if (g.via) {
      via.textContent = (g.viaReached ? '✓ via ' : 'via ') + g.via;
      via.classList.toggle('done', g.viaReached);
    }
    const lim = g.rules.clickLimit;
    $('#g-clicks').textContent = lim ? `${g.clicks}/${lim}` : g.clicks;
    const clicksStat = $('#g-clicks').parentElement;
    clicksStat.classList.toggle('warn', !!lim && lim - g.clicks <= 2 && lim - g.clicks > 1);
    clicksStat.classList.toggle('crit', !!lim && lim - g.clicks <= 1);
    const back = $('#g-back');
    back.classList.toggle('hidden', !g.rules.allowBack);
    back.disabled = !g.canGoBack || g.status !== 'active';
    $('#g-giveup').disabled = g.status !== 'active';
    $('#g-giveup').textContent = g.status === 'active' ? 'Give up' : 'Results';
    if (g.status !== 'active') $('#g-giveup').disabled = false;
    tick();
  }

  let ticker;
  function startTicker() {
    clearInterval(ticker);
    ticker = setInterval(tick, 200);
    tick();
  }let refreshing = false;
  function tick() {
    const g = state.game;
    if (!g) return;
    const elapsed = g.finishedAt ? g.finishedAt - g.startedAt : Math.max(0, now() - g.startedAt);
    const stat = $('#g-timer').parentElement;
    if (g.rules.timeLimit) {
      const left = g.rules.timeLimit * 1000 - elapsed;
      $('#g-timer').textContent = fmtTime(Math.max(0, left + 999));
      $('#g-timer-l').textContent = 'left';
      stat.classList.toggle('warn', left < 30000 && left >= 10000);
      stat.classList.toggle('crit', left < 10000);
      if (left <= 0 && g.status === 'active' && !refreshing) {
        refreshing = true;
        api('GET', `/api/games/${g.id}`).then(({ game }) => updateGame(game)).catch(() => {}).finally(() => { refreshing = false; });
      }
    } else {
      $('#g-timer').textContent = fmtTime(elapsed);
      $('#g-timer-l').textContent = 'time';
      stat.classList.remove('warn', 'crit');
    }
    if (g.status !== 'active') clearInterval(ticker);
  }

  function updateGame(game, page) {
    const wasActive = state.game && state.game.status === 'active';
    state.game = game;
    state.clockOffset = game.serverNow - Date.now();
    if (page) renderPage(page);
    renderGameBar();
    renderSidebar();
    if (wasActive && game.status !== 'active') showResult();
  }

  async function act(fn) {
    if (state.busy) return;
    state.busy = true;
    setLoading(true);
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'error');
      if (e.status === 409 && state.game) {
        const { game } = await api('GET', `/api/games/${state.game.id}`).catch(() => ({}));
        if (game) updateGame(game);
      }
    } finally {
      state.busy = false;
      setLoading(false);
    }
  }

  function follow(title) {
    const g = state.game;
    if (!g) return;
    if (g.status !== 'active') { toast('This race is over. Start a new one!'); return; }
    act(async () => {
      const { game, page } = await api('POST', `/api/games/${g.id}/move`, { title });
      updateGame(game, page);
    });
  }

  function goBack() {
    const g = state.game;
    if (!g || !g.canGoBack || g.status !== 'active') return;
    act(async () => {
      const { game, page } = await api('POST', `/api/games/${g.id}/back`);
      updateGame(game, page);
    });
  }

  function giveUp() {
    const g = state.game;
    if (!g) return;
    if (g.status !== 'active') { showResult(); return; }
    if (state.settings.confirmGiveUp && !confirm('Give up this race?')) return;
    act(async () => {
      const { game } = await api('POST', `/api/games/${g.id}/giveup`);
      updateGame(game);
    });
  }

  $('#g-back').addEventListener('click', goBack);
  $('#g-giveup').addEventListener('click', giveUp);
  $('#g-target').addEventListener('click', () => openTargetModal());
  $('#g-sidebar').addEventListener('click', () => {
    const sb = $('#sidebar');
    if (window.innerWidth <= 800) sb.classList.toggle('force-open');
    else sb.classList.toggle('collapsed');
  });

  $('#article').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains('game-link')) {
      const reason = R.banReason(a.dataset.title, state.game && state.game.rules);
      if (reason) { toast(reason, 'error'); return; }
      follow(a.dataset.title);
    } else if (a.dataset.anchor) {
      const target = $('#article').querySelector(`[id="${CSS.escape('w-' + a.dataset.anchor)}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  $('#article').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('game-link')) e.target.click();
  });
  // Middle-click / ctrl-click would otherwise escape the game.
  $('#article').addEventListener('auxclick', (e) => { if (e.target.closest('a')) e.preventDefault(); });

  // ------------------------------------------------------------------ article rendering
  const IMAGE_HOSTS = ['upload.wikimedia.org', 'wikimedia.org'];
  function proxyImage(src) {
    if (!src) return null;
    try {
      const u = new URL(src, 'https://upload.wikimedia.org/');
      if (u.protocol !== 'https:' || !IMAGE_HOSTS.includes(u.hostname)) return null;
      return '/api/img?u=' + encodeURIComponent(u.href);
    } catch (e) {
      return null;
    }
  }

  function headingOf(node) {
    if (!node || node.nodeType !== 1) return 0;
    if (/^H[1-6]$/.test(node.tagName)) return Number(node.tagName[1]);
    if (node.classList.contains('mw-heading')) {
      const h = node.querySelector('h1,h2,h3,h4,h5,h6');
      return h ? Number(h.tagName[1]) : 0;
    }
    return 0;
  }

  function removeSections(root, ids) {
    for (const id of ids) {
      const marker = root.querySelector(`[id="${CSS.escape(id)}"]`);
      const h = marker && marker.closest('h1,h2,h3,h4,h5,h6');
      if (!h) continue;
      const level = Number(h.tagName[1]);
      const block = h.parentElement && h.parentElement.classList.contains('mw-heading') ? h.parentElement : h;
      let n = block.nextElementSibling;
      while (n) {
        const lv = headingOf(n);
        if (lv && lv <= level) break;
        const next = n.nextElementSibling;
        n.remove();
        n = next;
      }
      block.remove();
    }
  }

  function unwrap(a) {
    const span = document.createElement('span');
    span.className = 'dead-link';
    if (a.title) span.title = a.title;
    while (a.firstChild) span.append(a.firstChild);
    a.replaceWith(span);
  }

  function buildArticle(page, game) {
    const s = state.settings;
    const doc = new DOMParser().parseFromString('<!doctype html><body><div id="wr-root"></div></body>', 'text/html');
    const root = doc.getElementById('wr-root');
    root.innerHTML = page.html; // inert document: nothing loads or runs here

    $$('script,link,meta,iframe,frame,object,embed,form,input,button,textarea,select,video,audio,source,track,noscript,base,map,area,svg foreignObject', root)
      .forEach((n) => n.remove());
    for (const st of $$('style', root)) {
      st.textContent = st.textContent.replace(/@import[^;]*;?/gi, '').replace(/url\s*\([^)]*\)/gi, 'none');
    }

    if (s.hideInfobox) $$('.infobox, .infobox_v2, .infobox_v3, table.vcard, .taxobox', root).forEach((n) => n.remove());
    if (s.hideNavboxes) $$('.navbox, .vertical-navbox, .navbox-styles, .sidebar, .portal-bar, .portalbox, .sistersitebox', root).forEach((n) => n.remove());
    if (s.hideSeeAlso) removeSections(root, ['See_also']);
    if (s.hideReferences) {
      removeSections(root, ['References', 'Notes', 'Citations', 'Footnotes', 'Sources', 'Bibliography', 'Notes_and_references', 'External_links', 'Further_reading']);
      $$('.reflist, .references, .mw-references-wrap, sup.reference, .refbegin, .mw-cite-backlink', root).forEach((n) => n.remove());
    }

    if (!s.showImages) {
      $$('figure, .thumb, .gallery, [typeof~="mw:File"], .infobox-image, img', root).forEach((n) => n.remove());
    } else {
      for (const img of $$('img', root)) {
        const src = proxyImage(img.getAttribute('src'));
        if (!src) { img.remove(); continue; }
        img.setAttribute('src', src);
        img.setAttribute('loading', 'lazy');
        const srcset = img.getAttribute('srcset');
        if (srcset) {
          const parts = srcset.split(',').map((p) => {
            const [u, d] = p.trim().split(/\s+/);
            const pu = proxyImage(u);
            return pu ? `${pu}${d ? ' ' + d : ''}` : null;
          }).filter(Boolean);
          if (parts.length) img.setAttribute('srcset', parts.join(', '));
          else img.removeAttribute('srcset');
        }
      }
    }

    const r = game.rules;
    const links = new Set(page.links);
    const banned = R.bannedSet(r);
    const visited = new Set(game.path.map((p) => R.normalizeTitle(p.title)));
    for (const a of $$('a', root)) {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#') && href.length > 1) {
        a.setAttribute('data-anchor', href.slice(1));
        a.setAttribute('href', '#');
        continue;
      }
      const m = href.match(/^(?:\.\/|\/wiki\/)([^?]+)$/);
      const title = m && !a.classList.contains('new') ? R.normalizeTitle(m[1]) : null;
      if (!title || !links.has(title)) { unwrap(a); continue; }
      a.removeAttribute('href');
      a.className = 'game-link';
      a.dataset.title = title;
      a.setAttribute('role', 'link');
      a.tabIndex = 0;
      if (R.banReason(title, r, banned)) a.classList.add('banned');
      if (visited.has(title)) a.classList.add('visited');
      if (s.highlightTarget && R.sameTitle(title, game.target)) a.classList.add('is-target');
      if (s.highlightTarget && game.via && !game.viaReached && R.sameTitle(title, game.via)) a.classList.add('is-via');
    }

    for (const n of $$('*', root)) {
      for (const attr of [...n.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'formaction' || name === 'xlink:href') n.removeAttribute(attr.name);
        else if (name === 'style' && /url\s*\(|expression\s*\(|position\s*:\s*fixed/i.test(attr.value)) n.removeAttribute(attr.name);
        else if (name === 'id') n.setAttribute('id', 'w-' + attr.value);
        else if (name === 'href' && n.tagName !== 'A') n.removeAttribute(attr.name);
      }
    }
    return root;
  }

  function renderPage(page) {
    state.page = page;
    const article = $('#article');
    const g = state.game;
    let content;
    try {
      content = buildArticle(page, g);
    } catch (e) {
      console.error(e);
      content = el('div', { class: 'page-error', text: 'Could not display this article.' });
    }
    const titleDoc = new DOMParser().parseFromString(page.displayTitle || page.title, 'text/html');
    const h1 = el('h1', { class: 'page-title', text: titleDoc.body.textContent || page.title });
    article.replaceChildren(h1, document.importNode(content, true));
    if (!$$('.game-link', article).length) {
      article.append(el('p', { class: 'page-error', text: 'This article has no playable links. Use the back button.' }));
    }
    document.title = `${page.title} · WikiRace`;
    window.scrollTo(0, 0);
    article.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ sidebar
  async function renderSidebar() {
    const g = state.game;
    if (!g) return;
    const s = state.settings;
    $('#side-path').classList.toggle('hidden', !s.showPath);
    $('#side-target').classList.toggle('hidden', !s.showTargetPreview);
    const list = $('#path');
    list.replaceChildren(...g.path.map((p, i) => el('li', {
      class: [p.back ? 'back' : '', i === g.path.length - 1 ? 'here' : '', R.sameTitle(p.title, g.target) ? 'target' : ''].join(' '),
      text: (p.back ? '↩ ' : '') + p.title,
      title: fmtTime(p.t),
    })));
    renderOpponents();
    if (s.showTargetPreview) {
      const box = $('#target-preview');
      if (box.dataset.for !== g.target) {
        box.dataset.for = g.target;
        box.replaceChildren(el('strong', { text: g.target }), el('p', { text: 'Loading…' }));
        try {
          const sum = await getSummary(g.target, g.lang);
          if (box.dataset.for === g.target) box.replaceChildren(summaryNode(sum));
        } catch (e) {
          box.replaceChildren(el('strong', { text: g.target }));
        }
      }
    }
  }

  async function openTargetModal() {
    const g = state.game;
    if (!g) return;
    $('#tm-title').textContent = g.target;
    $('#tm-body').replaceChildren(el('p', { text: 'Loading…' }));
    openModal('#target-modal');
    try {
      const sum = await getSummary(g.target, g.lang);
      $('#tm-body').replaceChildren(summaryNode(sum));
      if (g.via) $('#tm-body').append(el('p', {}, el('strong', { text: 'Checkpoint: ' }), `${g.via} ${g.viaReached ? '(reached ✓)' : '(not reached yet)'}`));
    } catch (e) {
      $('#tm-body').replaceChildren(el('p', { text: e.message }));
    }
  }

  function renderOpponents() {
    const box = $('#side-opponents');
    const room = state.room;
    const inRoomGame = room && state.game && state.game.roomId === room.id;
    box.classList.toggle('hidden', !inRoomGame);
    if (!inRoomGame) return;
    const players = room.players.filter((p) => p.game).sort((a, b) => {
      const rank = (p) => (p.game.status === 'won' ? 0 : p.game.status === 'active' ? 1 : 2);
      return rank(a) - rank(b) || (rank(a) === 0 ? a.game.finishedAt - b.game.finishedAt : b.game.clicks - a.game.clicks);
    });
    $('#opponents').replaceChildren(...players.map((p) => el('li', {},
      el('strong', { text: p.name }),
      p.id === room.you.id ? el('span', { class: 'badge me', text: 'you' }) : null,
      p.game.status !== 'active' ? el('span', { class: 'badge ' + p.game.status, text: p.game.status === 'won' ? 'finished' : 'out' }) : null,
      el('span', { class: 'badge', text: `${p.game.clicks} clicks` }),
      p.game.current ? el('span', { class: 'opp-page', text: p.game.current }) : null)));
  }

  // ------------------------------------------------------------------ results
  function shareText(g) {
    const res = g.status === 'won' ? `✅ ${g.clicks} clicks · ${fmtPrecise(g.finishedAt - g.startedAt)}` : `❌ ${g.reason || 'Did not finish'}`;
    const head = g.daily ? `WikiRace daily ${g.daily}` : 'WikiRace';
    const route = g.path.filter((p) => !p.back).map((p) => p.title).join(' → ');
    return `${head}: ${g.start} → ${g.target}${g.via ? ` (via ${g.via})` : ''}\n${res}\n${route}`;
  }

  async function showResult() {
    const g = state.game;
    if (!g) return;
    const won = g.status === 'won';
    const title = $('#r-title');
    title.textContent = won ? '🏁 You made it!' : g.status === 'gaveup' ? 'You gave up' : g.reason === 'Time ran out' ? '⏱ Out of time' : g.reason === 'Out of clicks' ? 'Out of clicks' : 'Race over';
    title.className = won ? 'won' : 'lost';
    $('#r-sub').textContent = `${g.start} → ${g.target}${g.via ? ` via ${g.via}` : ''}`;
    const elapsed = (g.finishedAt || now()) - g.startedAt;
    const tiles = [
      [g.clicks, 'clicks'],
      [fmtPrecise(elapsed), 'time'],
      [g.backs, 'backs'],
    ];
    try {
      const { history } = await api('GET', '/api/history');
      const same = history.filter((h) => h.result === 'won' && R.sameTitle(h.start, g.start) && R.sameTitle(h.target, g.target) && h.id !== g.id);
      if (same.length) {
        const best = same.reduce((a, b) => (b.clicks < a.clicks || (b.clicks === a.clicks && b.timeMs < a.timeMs) ? b : a));
        tiles.push([`${best.clicks} · ${fmtTime(best.timeMs)}`, 'previous best']);
      }
    } catch (e) { /* ignore */ }
    $('#r-tiles').replaceChildren(...tiles.map(([v, l]) => el('div', { class: 'tile' }, el('div', { class: 'v', text: String(v) }), el('div', { class: 'l', text: l }))));
    $('#r-path').replaceChildren(...g.path.map((p) => el('li', { class: p.back ? 'back' : '', text: `${p.back ? '↩ ' : ''}${p.title}  (${fmtTime(p.t)})` })));
    const inRoom = !!g.roomId;
    $('#r-retry').classList.toggle('hidden', inRoom || !!g.daily);
    $('#r-new').textContent = inRoom ? 'Room standings' : 'New race';
    renderRoomResultsInto($('#r-room'));
    openModal('#result-modal');
  }

  $('#r-copy').addEventListener('click', () => state.game && copyText(shareText(state.game)));
  $('#r-view').addEventListener('click', () => closeModal('#result-modal'));
  $('#r-retry').addEventListener('click', () => {
    const g = state.game;
    closeModal('#result-modal');
    startSolo({ start: g.start, target: g.target, via: g.via });
  });
  $('#r-new').addEventListener('click', () => {
    closeModal('#result-modal');
    if (state.game && state.game.roomId) { show('multi'); return; }
    show('home');
    if (state.mode === 'random') pickPages();
  });

  // ------------------------------------------------------------------ history
  function historyRow(h) {
    const res = h.result === 'won' ? `✓ ${h.clicks} clicks · ${fmtTime(h.timeMs)}` : h.reason || h.result;
    const tags = [h.daily ? `daily ${h.daily}` : null, h.multiplayer ? 'multiplayer' : null, h.lang !== 'en' ? h.lang : null].filter(Boolean).join(' · ');
    return el('details', { class: 'hist' },
      el('summary', {},
        el('span', { class: 'when', text: new Date(h.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }),
        el('span', { class: 'pairname', text: `${h.start} → ${h.target}${h.via ? ` (via ${h.via})` : ''}` }),
        tags ? el('span', { class: 'badge', text: tags }) : null,
        el('span', { class: 'res ' + h.result, text: res })),
      el('div', { class: 'detail' },
        el('ol', { class: 'path' }, ...h.path.map((p) => el('li', { class: p.startsWith('↩') ? 'back' : '', text: p }))),
        el('div', { class: 'actions' },
          el('span', { class: 'muted', text: `${h.playerName} · ${h.backs || 0} backs` }),
          el('button', {
            class: 'secondary',
            text: 'Race this pair again',
            onclick: () => {
              if (h.lang !== rules().lang) { state.settings.lang = h.lang; saveSettings(); }
              startSolo({ start: h.start, target: h.target, via: h.via });
            },
          }))));
  }

  function dailyStreak(history) {
    const days = new Set(history.filter((h) => h.daily && h.result === 'won').map((h) => h.daily));
    let streak = 0;
    const d = new Date();
    const key = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    if (!days.has(key(d))) d.setDate(d.getDate() - 1);
    while (days.has(key(d))) { streak++; d.setDate(d.getDate() - 1); }
    return streak;
  }

  async function renderHistory() {
    const list = $('#history-list');
    list.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
    let history;
    try {
      ({ history } = await api('GET', '/api/history'));
    } catch (e) {
      list.replaceChildren(el('p', { class: 'empty', text: e.message }));
      return;
    }
    const f = $('#history-filter').value;
    const shown = history.filter((h) => f === 'all' || (f === 'won' && h.result === 'won') || (f === 'solo' && !h.multiplayer)
      || (f === 'multi' && h.multiplayer) || (f === 'daily' && h.daily));
    const wins = shown.filter((h) => h.result === 'won');
    const avg = wins.length ? (wins.reduce((a, h) => a + h.clicks, 0) / wins.length).toFixed(1) : '–';
    const fastest = wins.length ? Math.min(...wins.map((h) => h.timeMs)) : null;
    const fewest = wins.length ? Math.min(...wins.map((h) => h.clicks)) : '–';
    const tiles = [
      [shown.length, 'races'],
      [wins.length, 'wins'],
      [shown.length ? Math.round((wins.length / shown.length) * 100) + '%' : '–', 'win rate'],
      [avg, 'avg clicks (wins)'],
      [fewest, 'fewest clicks'],
      [fastest == null ? '–' : fmtPrecise(fastest), 'fastest win'],
      [dailyStreak(history), 'daily streak'],
    ];
    $('#history-tiles').replaceChildren(...tiles.map(([v, l]) => el('div', { class: 'tile' }, el('div', { class: 'v', text: String(v) }), el('div', { class: 'l', text: l }))));
    if (!shown.length) {
      list.replaceChildren(el('p', { class: 'empty', text: 'No races here yet.' }));
      return;
    }
    list.replaceChildren(...shown.slice(0, 300).map(historyRow));
  }

  $('#history-filter').addEventListener('change', renderHistory);
  $('#history-clear').addEventListener('click', async () => {
    if (!confirm('Delete all saved race history?')) return;
    await api('DELETE', '/api/history');
    renderHistory();
  });
  $('#history-export').addEventListener('click', async () => {
    const { history } = await api('GET', '/api/history');
    const url = URL.createObjectURL(new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `wikirace-history-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ------------------------------------------------------------------ settings modal
  const form = $('#settings-form');

  function fillSettingsForm() {
    const s = state.settings;
    for (const input of form.elements) {
      if (!input.name || !(input.name in s)) continue;
      if (input.type === 'checkbox') input.checked = !!s[input.name];
      else if (input.name === 'bannedPages') input.value = (s.bannedPages || []).join('\n');
      else input.value = s[input.name];
    }
  }

  async function refreshCacheInfo() {
    try {
      const c = await api('GET', '/api/cache');
      $('#cache-info').textContent = `${c.diskFiles} cached files (${(c.diskBytes / 1048576).toFixed(1)} MB) · ${c.requests} requests to Wikipedia since start · ${c.memoryHits + c.diskHits} served from cache`;
    } catch (e) {
      $('#cache-info').textContent = e.message;
    }
  }

  function openSettings() {
    fillSettingsForm();
    refreshCacheInfo();
    openModal('#settings-modal');
  }

  form.addEventListener('input', (e) => {
    const input = e.target;
    if (!input.name) return;
    const s = state.settings;
    if (input.name === 'preset') {
      if (input.value && PRESETS[input.value]) Object.assign(s, PRESETS[input.value]);
      s.preset = input.value;
      fillSettingsForm();
    } else {
      let v = input.type === 'checkbox' ? input.checked : input.value;
      if (input.type === 'number') v = Math.max(0, Number(v) || 0);
      if (input.name === 'bannedPages') v = v.split('\n').map((x) => x.trim()).filter(Boolean);
      if (input.name === 'lang') v = v.trim().toLowerCase() || 'en';
      s[input.name] = v;
      if (RULE_KEYS.includes(input.name) && input.name !== 'lang') { s.preset = ''; form.elements.preset.value = ''; }
    }
    saveSettings();
    applyAppearance();
    if (input.name === 'lang') { summaries.clear(); if (state.mode === 'daily') loadDaily(); else if (state.mode === 'random') setPair(null, null); }
    renderRulesSummary($('#rules-summary'), rules(), { via: $('#custom-via').value.trim() });
    if (state.game && state.page && ['showImages', 'hideInfobox', 'hideNavboxes', 'hideSeeAlso', 'hideReferences', 'highlightTarget'].includes(input.name)) {
      const y = window.scrollY;
      renderPage(state.page);
      window.scrollTo(0, y);
    }
    if (state.game && ['showPath', 'showTargetPreview'].includes(input.name)) renderSidebar();
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#open-settings').addEventListener('click', openSettings);
  $('#settings-reset').addEventListener('click', () => {
    if (!confirm('Reset all settings to defaults?')) return;
    state.settings = { ...DEFAULT_SETTINGS, playerName: state.settings.playerName };
    saveSettings();
    applyAppearance();
    fillSettingsForm();
    renderRulesSummary($('#rules-summary'), rules(), {});
  });
  $('#cache-clear').addEventListener('click', async () => {
    await api('DELETE', '/api/cache');
    summaries.clear();
    toast('Cache cleared');
    refreshCacheInfo();
  });

  // ------------------------------------------------------------------ modals & keys
  function openModal(sel) { $(sel).classList.remove('hidden'); }
  function closeModal(sel) { $(sel).classList.add('hidden'); }
  for (const m of $$('.modal')) {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.classList.add('hidden'); });
  }
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') $$('.modal').forEach((m) => m.classList.add('hidden'));
    if (typing) return;
    if (state.view === 'game' && ((e.altKey && e.key === 'ArrowLeft') || e.key === 'Backspace')) { e.preventDefault(); goBack(); }
    if (e.key === ',') openSettings();
    if (state.view === 'game' && e.key === 't') openTargetModal();
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.game && state.game.status === 'active' && state.game.clicks > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------------ multiplayer
  const roomForm = $('#room-settings');

  function roomSettingsFromForm() {
    const f = roomForm.elements;
    return {
      difficulty: f.difficulty.value,
      start: f.start.value.trim(),
      target: f.target.value.trim(),
      via: f.via.value.trim(),
      scoring: f.scoring.value,
      showOpponentPages: f.showOpponentPages.checked,
      rules: {
        lang: f.lang.value.trim() || 'en',
        timeLimit: Number(f.timeLimit.value) || 0,
        clickLimit: Number(f.clickLimit.value) || 0,
        allowBack: f.allowBack.checked,
        backCountsAsClick: f.backCountsAsClick.checked,
        banDates: f.banDates.checked,
        bannedPages: f.bannedPages.value.split('\n').map((x) => x.trim()).filter(Boolean),
      },
    };
  }

  function fillRoomForm(s) {
    const f = roomForm.elements;
    f.difficulty.value = s.difficulty;
    f.start.value = s.start || '';
    f.target.value = s.target || '';
    f.via.value = s.via || '';
    f.scoring.value = s.scoring;
    f.showOpponentPages.checked = s.showOpponentPages;
    f.lang.value = s.rules.lang;
    f.timeLimit.value = s.rules.timeLimit;
    f.clickLimit.value = s.rules.clickLimit;
    f.allowBack.checked = s.rules.allowBack;
    f.backCountsAsClick.checked = s.rules.backCountsAsClick;
    f.banDates.checked = s.rules.banDates;
    f.bannedPages.value = s.rules.bannedPages.join('\n');
    $$('.custom-only', roomForm).forEach((n) => n.classList.toggle('hidden', s.difficulty !== 'custom'));
  }

  const pushRoomSettings = debounce(async () => {
    const sess = state.session;
    if (!sess) return;
    try {
      await api('POST', `/api/rooms/${sess.roomId}/settings`, { player: sess.playerId, token: sess.token, settings: roomSettingsFromForm() });
    } catch (e) { toast(e.message, 'error'); }
  }, 400);
  roomForm.addEventListener('input', () => {
    $$('.custom-only', roomForm).forEach((n) => n.classList.toggle('hidden', roomForm.elements.difficulty.value !== 'custom'));
    pushRoomSettings();
  });
  roomForm.addEventListener('submit', (e) => e.preventDefault());

  function playerName() {
    const n = $('#mp-name').value.trim() || state.settings.playerName || 'Player';
    if (n !== state.settings.playerName) { state.settings.playerName = n; saveSettings(); }
    return n;
  }

  async function createRoom() {
    try {
      const r = rules();
      const sess = await api('POST', '/api/rooms', {
        name: playerName(),
        settings: { difficulty: 'medium', rules: r, scoring: 'time', showOpponentPages: true },
      });
      connectRoom(sess);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function joinRoom(code) {
    code = String(code || '').trim().toUpperCase();
    if (code.length !== 4) { toast('Enter the 4-letter room code', 'error'); return; }
    try {
      const sess = await api('POST', `/api/rooms/${code}/join`, { name: playerName() });
      connectRoom(sess);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function joinRoom(code) {
    code = String(code || '').trim().toUpperCase();
    if (code.length !== 4) { toast('Enter the 4-letter room code', 'error'); return; }
    try {
      const sess = await api('POST', `/api/rooms/${code}/join`, { name: playerName() });
      connectRoom(sess);
    } catch (e) { toast(e.message, 'error'); }
  }

  function connectRoom(sess) {
    if (state.es) state.es.close();
    state.session = sess;
    store.sset('wikirace.room', sess);
    const es = new EventSource(`/api/rooms/${sess.roomId}/events?player=${sess.playerId}&token=${sess.token}`);
    state.es = es;
    es.onmessage = (e) => onRoomState(JSON.parse(e.data));
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        toast('Lost connection to the room', 'error');
        leaveRoomLocal();
      }
    };
    show('multi');
  }

  function leaveRoomLocal() {
    if (state.es) state.es.close();
    state.es = null;
    state.session = null;
    state.room = null;
    store.sset('wikirace.room', null);
    clearInterval(state.countdownTimer);
    $('#countdown').classList.add('hidden');
    if (state.view === 'multi') renderMulti();
  }

  async function onRoomState(room) {
    const prev = state.room;
    state.room = room;
    state.clockOffset = room.serverNow - Date.now();
    if (state.view === 'multi') renderMulti();
    renderOpponents();
    if (state.game && state.game.roomId === room.id && !$('#result-modal').classList.contains('hidden')) renderRoomResultsInto($('#r-room'));

    const myGame = room.you.gameId;
    const racing = room.status === 'countdown' || room.status === 'racing';
    if (racing && myGame && (!state.game || state.game.id !== myGame)) {
      await startRoomGame(room);
    }
    if (prev && prev.status !== 'results' && room.status === 'results' && state.view === 'multi') {
      toast('Race finished!');
    }
  }

  async function startRoomGame(room) {
    const gameId = room.you.gameId;
    closeModal('#result-modal');
    state.game = null;
    show('game');
    $('#article').replaceChildren(el('div', { class: 'page-error', text: `Get ready: ${room.round.start} → ${room.round.target}` }));
    $('#g-start').textContent = room.round.start;
    $('#g-target').textContent = room.round.target;
    const cd = $('#countdown');
    clearInterval(state.countdownTimer);
    await new Promise((resolve) => {
      const step = () => {
        const left = room.round.startAt - now();
        if (left <= 0) {
          clearInterval(state.countdownTimer);
          cd.textContent = 'GO!';
          setTimeout(() => cd.classList.add('hidden'), 500);
          resolve();
          return;
        }
        cd.classList.remove('hidden');
        cd.textContent = String(Math.ceil(left / 1000));
      };
      state.countdownTimer = setInterval(step, 100);
      step();
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const resp = await api('GET', `/api/games/${gameId}/page`);
        if (state.room && state.room.you.gameId === gameId) enterGame(resp);
        return;
      } catch (e) {
        if (e.status !== 425) { toast(e.message, 'error'); return; }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  function renderRoomResultsInto(box) {
    const room = state.room;
    box.replaceChildren();
    if (!room || !room.round || !state.game || state.game.roomId !== room.id) return;
    if (room.status === 'results' && room.round.results) {
      box.append(el('h3', { text: 'Standings' }), resultsTable(room.round.results));
    } else {
      const left = room.players.filter((p) => p.game && p.game.status === 'active').length;
      box.append(el('p', { class: 'muted', text: `Waiting for ${left} racer${left === 1 ? '' : 's'} to finish…` }));
    }
  }

  function resultsTable(results) {
    return el('table', { class: 'results-table' },
      el('thead', {}, el('tr', {}, ...['#', 'Racer', 'Result', 'Clicks', 'Time'].map((h) => el('th', { text: h })))),
      el('tbody', {}, ...results.map((r) => el('tr', {},
        el('td', { text: r.rank ? String(r.rank) : '–' }),
        el('td', {}, el('strong', { text: r.name }), el('div', { class: 'p', text: r.path.join(' → ') })),
        el('td', { text: r.status === 'won' ? 'Finished' : r.reason || r.status }),
        el('td', { text: String(r.clicks) }),
        el('td', { text: r.status === 'won' ? fmtPrecise(r.timeMs) : '–' })))));
  }

  function renderMulti() {
    const room = state.room;
    const inRoom = !!(state.session && room);
    $('#mp-entry').classList.toggle('hidden', inRoom);
    $('#mp-room').classList.toggle('hidden', !inRoom);
    if (!inRoom) {
      $('#mp-name').value = $('#mp-name').value || state.settings.playerName || '';
      const cfg = state.config;
      const hint = $('#lan-hint');
      if (cfg && cfg.lanUrls && cfg.lanUrls.length) {
        hint.textContent = `Friends on your network can open: ${cfg.lanUrls.join('  or  ')}`;
      } else {
        hint.textContent = 'This server only accepts connections from this computer. To race people on your network, restart it with "npm run lan".';
      }
      return;
    }
    const isHost = room.hostId === room.you.id;
    $('#room-code').textContent = room.id;
    const base = state.config && state.config.lanUrls && state.config.lanUrls[0] ? state.config.lanUrls[0] : location.origin;
    $('#room-link').value = `${base}/?room=${room.id}`;
    $('#room-players').replaceChildren(...room.players.map((p) => el('li', {},
      el('span', { class: 'dot' + (p.online ? ' on' : '') }),
      el('span', { text: p.name }),
      p.isHost ? el('span', { class: 'badge', text: 'host' }) : null,
      p.id === room.you.id ? el('span', { class: 'badge me', text: 'you' }) : null,
      p.game ? el('span', { class: 'badge ' + (p.game.status === 'active' ? '' : p.game.status), text: p.game.status === 'active' ? `racing · ${p.game.clicks}` : p.game.status }) : null)));

    roomForm.dataset.readonly = isHost ? '0' : '1';
    for (const input of roomForm.elements) input.tabIndex = isHost ? 0 : -1;
    $('#room-host-note').textContent = isHost ? '(you are the host)' : '(set by the host)';
    if (!isHost || !roomForm.contains(document.activeElement)) fillRoomForm(room.settings);

    const racing = room.status === 'countdown' || room.status === 'racing';
    const start = $('#room-start');
    start.classList.toggle('hidden', !isHost);
    start.disabled = racing || room.starting;
    start.textContent = room.starting ? 'Picking pages…' : room.status === 'results' ? 'Next race' : 'Start race';
    const status = {
      lobby: isHost ? 'Start whenever everyone is in.' : 'Waiting for the host to start…',
      countdown: 'Starting…',
      racing: `Race ${room.roundNo} in progress: ${room.round && room.round.start} → ${room.round && room.round.target}`,
      results: `Race ${room.roundNo} finished.`,
    }[room.status];
    $('#room-status').textContent = status;
    const mine = state.game && state.game.id === room.you.gameId;
    $('#room-rejoin').classList.toggle('hidden', !(racing && mine));

    const res = $('#room-results');
    res.classList.toggle('hidden', !(room.round && room.round.results));
    if (room.round && room.round.results) {
      res.replaceChildren(el('h3', { text: `Race ${room.roundNo}: ${room.round.start} → ${room.round.target}` }), resultsTable(room.round.results));
    }
  }

  $('#mp-create').addEventListener('click', createRoom);
  $('#mp-join').addEventListener('click', () => joinRoom($('#mp-code').value));
  $('#mp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(e.target.value); });
  $('#room-copy').addEventListener('click', () => copyText($('#room-link').value));
  $('#room-rejoin').addEventListener('click', () => show('game'));
  $('#room-start').addEventListener('click', async () => {
    const sess = state.session;
    $('#room-start').disabled = true;
    try {
      await api('POST', `/api/rooms/${sess.roomId}/settings`, { player: sess.playerId, token: sess.token, settings: roomSettingsFromForm() });
      await api('POST', `/api/rooms/${sess.roomId}/start`, { player: sess.playerId, token: sess.token });
    } catch (e) {
      toast(e.message, 'error');
      $('#room-start').disabled = false;
    }
  });
  $('#room-leave').addEventListener('click', async () => {
    const sess = state.session;
    if (!sess) return;
    if (!confirm('Leave this room?')) return;
    try { await api('POST', `/api/rooms/${sess.roomId}/leave`, { player: sess.playerId, token: sess.token }); } catch (e) { /* already gone */ }
    if (state.game && state.game.roomId === sess.roomId) state.game = null;
    leaveRoomLocal();
  });

  // ------------------------------------------------------------------ boot
  async function boot() {
    applyAppearance();
    $('#difficulty').value = store.get('wikirace.difficulty', 'medium');
    setMode(['random', 'daily', 'custom'].includes(state.mode) ? state.mode : 'random');
    try {
      state.config = await api('GET', '/api/config');
      $('#daily-date').textContent = state.config.today;
    } catch (e) {
      toast('Cannot reach the WikiRace server', 'error');
    }
    const params = new URLSearchParams(location.search);
    const code = params.get('room');
    if (state.session) {
      connectRoom(state.session);
    } else if (code) {
      show('multi');
      $('#mp-code').value = code.toUpperCase();
      if (!state.settings.playerName) toast('Enter your name, then press Join');
      else joinRoom(code);
    } else {
      show('home');
    }
    if (code) history.replaceState(null, '', location.pathname);
  }

  boot();
})();