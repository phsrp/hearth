// Hearth - window logic.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const svg = (n) => (/-filled$/.test(n)
  ? `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">${window.TABLER[n] || ''}</svg>`
  : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${window.TABLER[n] || ''}</svg>`);
const icon = (n, cls = '') => `<span class="i ${cls}">${svg(n)}</span>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hydrateIcons(root = document) {
  for (const el of $$('.i[data-i]', root)) { el.innerHTML = svg(el.dataset.i); el.removeAttribute('data-i'); }
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('hearth.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hearth.' + k, JSON.stringify(v)); } catch {} },
};
const state = {
  games: [],
  settings: {},
  hasApiKey: false,
  meta: {},
  filter: store.get('filter', 'all'),
  query: '',
  sort: store.get('sort', { key: 'lastPlayed', dir: -1 }),
  view: store.get('view', 'grid'),
  installedOnly: store.get('installedOnly', false),
  focused: null,
  exeIcons: new Map(),
  loaded: false,
};
const SOURCES = {
  steam: { label: 'Steam', icon: 'brand-steam' },
  itch: { label: 'itch.io', icon: 'brand-itch' },
  other: { label: 'Other', icon: 'device-desktop' },
};

// ---------- formatting ----------
const nameOf = (g) => g.customName || g.name || 'Untitled';
function fmtTime(sec, { short = false } = {}) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return sec ? '< 1 min' : (short ? '-' : '0 min');
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = sec / 3600;
  if (h < 10) return `${h.toFixed(1).replace(/\.0$/, '')} h`;
  return `${Math.round(h).toLocaleString()} h`;
}
function fmtLong(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (!h && !m) return sec ? 'Under a minute' : 'Not played yet';
  return [h && `${h.toLocaleString()} h`, m && `${m} min`].filter(Boolean).join(' ');
}
function fmtAgo(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const days = Math.floor((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function fmtBytes(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`;
}
function highlight(text, q) {
  const t = esc(text);
  if (!q) return t;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t;
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}
// Local files go through the ghimg: protocol; web images (Steam CDN, itch.io) load directly.
const imgUrl = (p) => (!p ? null : /^(https?:|data:)/i.test(p) ? p : 'ghimg://img/' + encodeURIComponent(p));
const coverOf = (g) => imgUrl(g.customCover || g.cover);
const heroOf = (g) => imgUrl(g.customCover ? null : g.hero || g.header) || coverOf(g);
const smallOf = (g) => (g.source === 'steam' && g.icon ? imgUrl(g.icon) : null);

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#btn-theme').innerHTML = icon(t === 'light' ? 'moon' : 'sun');
  const cs = getComputedStyle(document.documentElement);
  window.hub.titlebar({ color: cs.getPropertyValue('--surface').trim(), symbol: cs.getPropertyValue('--subtle').trim() });
  store.set('theme', t);
}

// ---------- data ----------
function apply(snap) {
  state.games = snap.games;
  state.settings = snap.settings;
  state.hasApiKey = snap.hasApiKey;
  state.meta = snap.meta || {};
  state.loaded = true;
  $('#loading').hidden = true;
  render();
}

function visible() {
  const q = state.query.toLowerCase();
  let list = state.games.filter((g) => !g.hidden);
  if (state.installedOnly) list = list.filter((g) => g.installed);
  if (state.filter === 'fav') list = list.filter((g) => g.favorite);
  else if (state.filter !== 'all') list = list.filter((g) => g.source === state.filter);
  if (q) list = list.filter((g) => nameOf(g).toLowerCase().includes(q));
  const { key, dir } = state.sort;
  const val = (g) => (key === 'name' ? nameOf(g).toLowerCase() : key === 'source' ? g.source + nameOf(g).toLowerCase() : g[key] || 0);
  return list.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : nameOf(a).localeCompare(nameOf(b))) * dir;
  });
}

// ---------- rendering ----------
function iconHtml(g) {
  const small = smallOf(g);
  if (small) return `<img src="${esc(small)}" alt="" loading="lazy">`;
  const exe = state.exeIcons.get(g.id);
  if (exe) return `<img class="exe" src="${exe}" alt="">`;
  const c = coverOf(g);
  if (c) return `<img src="${esc(c)}" alt="" loading="lazy">`;
  return icon(SOURCES[g.source]?.icon || 'device-gamepad-2');
}

function rowHtml(g) {
  const src = SOURCES[g.source] || SOURCES.other;
  const t = g.playSeconds;
  return `<div class="row${g.id === state.focused ? ' focused' : ''}${g.installed ? '' : ' dim'}" data-id="${esc(g.id)}">
    <span class="g-icon">${iconHtml(g)}</span>
    <span class="cell name"><span class="t">${highlight(nameOf(g), state.query)}</span>${g.favorite ? icon('star-filled', 'fav') : ''}${g.running ? '<span class="pill live">Playing</span>' : ''}${g.installed ? '' : '<span class="pill muted">Not installed</span>'}</span>
    <span class="cell"><span class="src ${g.source}">${icon(src.icon)}${src.label}</span></span>
    <span class="cell num time${t < 60 ? ' zero' : ''}">${fmtTime(t, { short: true })}</span>
    <span class="cell num date">${fmtAgo(g.lastPlayed) || '<span style="color:var(--muted)">Never</span>'}</span>
  </div>`;
}

function cardHtml(g) {
  const c = coverOf(g);
  const exe = state.exeIcons.get(g.id);
  const ph = `<div class="ph">${exe ? `<img src="${exe}" alt="">` : icon(SOURCES[g.source]?.icon || 'device-gamepad-2')}<span>${esc(nameOf(g))}</span></div>`;
  const meta = g.running ? `<span class="pill live">Playing</span>`
    : `${icon('clock')}${g.playSeconds >= 60 ? fmtTime(g.playSeconds) : 'Not played'}`;
  return `<div class="card${g.id === state.focused ? ' focused' : ''}" data-id="${esc(g.id)}">
    <div class="cover${g.installed ? '' : ' dim'}">
      ${ph}
      ${c ? `<img src="${esc(c)}" alt="" loading="lazy">` : ''}
      <div class="badges">${g.installed ? '' : '<span class="pill muted">Not installed</span>'}${g.favorite ? icon('star-filled', 'star') : ''}</div>
    </div>
    <div class="card-name" title="${esc(nameOf(g))}">${highlight(nameOf(g), state.query)}</div>
    <div class="card-meta">${meta}</div>
  </div>`;
}

function render() {
  const list = visible();
  const all = state.games.filter((g) => !g.hidden && (!state.installedOnly || g.installed));
  $('#list-wrap').classList.toggle('view-grid', state.view === 'grid');
  $('#list').innerHTML = list.map(state.view === 'grid' ? cardHtml : rowHtml).join('');
  const n = all.length;
  $('#game-count').textContent = `${n} game${n === 1 ? '' : 's'}`;
  for (const t of $$('.tab')) {
    const f = t.dataset.f;
    t.classList.toggle('on', f === state.filter);
    $('.n', t).textContent = f === 'all' ? n : f === 'fav' ? all.filter((g) => g.favorite).length : all.filter((g) => g.source === f).length;
  }
  for (const b of $$('#view-seg button')) b.classList.toggle('on', b.dataset.v === state.view);
  for (const c of $$('[data-sort]')) {
    const on = c.dataset.sort === state.sort.key;
    c.classList.toggle('on', on);
    $('.sort', c).innerHTML = on ? icon(state.sort.dir > 0 ? 'arrow-up' : 'arrow-down') : '';
  }
  $('#installed-only').checked = state.installedOnly;
  renderEmpty(list);
  renderFooter();
  renderDetails(state.games.find((g) => g.id === state.focused));
  loadExeIcons(list);
}

function renderEmpty(list) {
  const empty = state.loaded && !list.length;
  $('#empty').hidden = !empty;
  if (!empty) return;
  const none = !state.games.filter((g) => !g.hidden).length;
  $('#empty-text').innerHTML = none
    ? 'No games yet. Steam and itch.io games show up on their own,<br>everything else you can add yourself.'
    : state.query ? 'Nothing matches your search.' : state.filter === 'fav' ? 'Star a game to keep it here.' : 'No games here yet.';
  $('#empty-actions').innerHTML = none || state.filter === 'other' ? `<button class="btn primary" data-act="add">${icon('plus')}Add games</button>` : '';
}

function renderFooter() {
  const shown = state.games.filter((g) => !g.hidden);
  const total = shown.reduce((s, g) => s + g.playSeconds, 0);
  $('#total-time').textContent = fmtTime(total);
  const week = weekSeconds();
  $('#week-time').textContent = week >= 60 ? `· ${fmtTime(week)} this week` : '';
  const playing = shown.filter((g) => g.running);
  const np = $('#now-playing');
  np.hidden = !playing.length;
  if (playing.length) {
    np.innerHTML = `<span class="t">Playing ${esc(playing.map(nameOf).join(', '))}</span>`;
    np.onclick = () => focusGame(playing[0], true);
  }
  const st = state.meta.status || {};
  const last = state.meta.lastApiSync || state.meta.lastScan;
  let txt = '';
  if (st.api && !st.api.ok && state.hasApiKey) txt = `${icon('alert-triangle')}Steam sync failed`;
  else if (last) txt = `${icon('brand-steam')}Synced ${ago(last)}`;
  $('#sync-state').innerHTML = txt;
  $('#sync-state').title = st.api && !st.api.ok && state.hasApiKey ? st.api.error : '';
}
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(ms).toLocaleDateString(); };

let history = {};
function weekSeconds() {
  let s = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (const v of Object.values(history[k] || {})) s += v;
  }
  return s;
}

async function loadExeIcons(list) {
  const todo = list.filter((g) => g.source !== 'steam' && !state.exeIcons.has(g.id) && (g.exe || g.customExe));
  if (!todo.length) return;
  for (const g of todo) state.exeIcons.set(g.id, null);
  await window.hub.icons(todo.map((g) => g.id));
  let changed = false;
  for (const g of todo) {
    const url = await window.hub.icon(g.id);
    if (url) { state.exeIcons.set(g.id, url); changed = true; }
  }
  if (changed) render();
}

// ---------- details ----------
function renderDetails(g) {
  const d = $('#details');
  if (!g) {
    d.innerHTML = `<div class="details-empty">${icon('device-gamepad-2', 'big')}<p>Pick a game to see its playtime.</p><p class="hint">Double-click a game to play it.</p></div>`;
    return;
  }
  const src = SOURCES[g.source] || SOURCES.other;
  const hero = heroOf(g);
  const exe = state.exeIcons.get(g.id);
  const facts = [];
  const fact = (i, k, v, link) => facts.push(`<div class="fact">${icon(i)}<div><div class="k">${k}</div><div class="v${link ? ' link' : ''}"${link ? ` data-open="${esc(link)}"` : ''}>${esc(v)}</div></div></div>`);
  if (g.lastPlayed) fact('calendar', 'Last played', new Date(g.lastPlayed * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  if (g.dir) fact('folder', 'Location', g.dir, g.dir);
  if (g.source !== 'steam' && (g.customExe || g.exe)) fact('file', 'Game file', (g.customExe || g.exe).split('\\').pop(), g.customExe || g.exe);
  if (g.sizeBytes) fact('database', 'Size on disk', fmtBytes(g.sizeBytes));
  if (g.addedAt && g.source === 'other') fact('plus', 'Added', new Date(g.addedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }));
  const sessions = (g.sessions || []).length;
  const twoWeeks = g.source === 'steam' ? (g.twoWeeksMinutes || 0) * 60 : recentSeconds(g.id, 14);
  const howTracked = g.source === 'steam' ? 'Synced from Steam' : g.source === 'itch' ? 'itch.io app + Hearth' : 'Tracked by Hearth';
  const playLabel = g.running ? 'Playing now' : g.source === 'steam' && !g.installed ? 'Install' : 'Play';
  d.innerHTML = `
    <div class="d-hero">
      <div class="ph">${exe ? `<img src="${exe}" alt="">` : icon(src.icon)}</div>
      ${hero ? `<img class="bg" src="${esc(hero)}" alt="">` : ''}
    </div>
    <div class="d-body">
      <div class="d-name">${esc(nameOf(g))}</div>
      <div class="d-sub"><span class="pill ${g.source}">${src.label}</span>${g.running ? '<span class="pill live">Playing</span>' : ''}${g.installed ? '' : '<span class="pill muted">Not installed</span>'}</div>
      <div class="d-play">
        <button class="btn primary" data-act="play" ${g.running || (!g.installed && g.source !== 'steam') ? 'disabled' : ''}>${icon(g.source === 'steam' && !g.installed ? 'download' : 'player-play-filled')}${playLabel}</button>
        <button class="btn icon${g.favorite ? ' on' : ''}" data-act="fav" title="${g.favorite ? 'Remove from favourites' : 'Add to favourites'}">${icon(g.favorite ? 'star-filled' : 'star')}</button>
        <button class="btn icon" data-act="menu" title="More">${icon('dots-vertical')}</button>
      </div>
      <div class="playtime">
        <div class="stat big">${icon('hourglass')}<div><b id="d-time">${fmtLong(g.playSeconds)}</b><span>${howTracked}</span></div></div>
        <div class="stat"><b>${fmtTime(twoWeeks)}</b><span>Last 2 weeks</span></div>
        <div class="stat"><b>${g.lastPlayed ? esc(fmtAgo(g.lastPlayed)) : 'Never'}</b><span>Last played</span></div>
      </div>
      <div class="facts">${facts.join('')}</div>
      <div class="links">
        ${g.dir ? `<button class="btn small" data-act="folder">${icon('folder-open')}Open folder</button>` : ''}
        <button class="btn small" data-act="edit">${icon('pencil')}Edit</button>
        ${g.source !== 'steam' ? `<button class="btn small" data-act="playtime">${icon('clock')}Set playtime</button>` : ''}
        ${g.source === 'steam' ? `<button class="btn small" data-act="store">${icon('external-link')}Store page</button>` : ''}
        ${g.url ? `<button class="btn small" data-act="page">${icon('external-link')}itch.io page</button>` : ''}
        <button class="btn small danger-ghost" data-act="remove">${icon('trash')}Remove</button>
      </div>
    </div>`;
  if (sessions && g.source !== 'steam') $('.facts', d).insertAdjacentHTML('beforeend', `<div class="fact">${icon('clock-play')}<div><div class="k">Sessions</div><div class="v">${sessions} tracked by Hearth</div></div></div>`);
}
function recentSeconds(id, days) {
  let s = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    s += (history[k] || {})[id] || 0;
  }
  return s;
}

function focusGame(g, scroll = false) {
  state.focused = g ? g.id : null;
  for (const r of $$('#list [data-id]')) r.classList.toggle('focused', r.dataset.id === state.focused);
  renderDetails(g);
  if (scroll && g) $(`#list [data-id="${CSS.escape(g.id)}"]`)?.scrollIntoView({ block: 'nearest' });
}
const byId = (id) => state.games.find((g) => g.id === id);

// ---------- actions ----------
async function play(g) {
  if (!g) return;
  if (g.running) return toast(`${nameOf(g)} is already running.`);
  if (!g.installed && g.source !== 'steam') return toast(`${nameOf(g)} isn't installed.`, true);
  const r = await window.hub.launch(g.id);
  if (!r.ok) return toast(r.error || 'Could not start the game.', true);
  toast(r.install ? `Opening Steam to install ${nameOf(g)}` : r.viaSteam ? `Starting ${nameOf(g)} through Steam` : `Starting ${nameOf(g)}`);
}

async function doAction(act, g) {
  switch (act) {
    case 'play': return play(g);
    case 'fav': return window.hub.update(g.id, { favorite: !g.favorite });
    case 'folder': if (!(await window.hub.show(g.dir))) toast('That folder no longer exists.', true); return;
    case 'edit': return editGame(g);
    case 'playtime': return setPlaytime(g);
    case 'store': return window.hub.url(`https://store.steampowered.com/app/${g.appid}`);
    case 'page': return window.hub.url(g.url);
    case 'remove': {
      // Steam and itch.io games would come back on the next scan, so they're kept out instead of deleted (and can be restored).
      const local = g.source === 'other';
      const ok = await confirmBox({
        title: `Remove ${nameOf(g)} from Hearth?`,
        text: local
          ? 'It goes off your list, along with the playtime Hearth tracked for it. The game itself stays on your PC.'
          : `It stays off your list, even after ${SOURCES[g.source].label} rescans. Nothing is uninstalled. You can bring it back from Settings.`,
        ok: 'Remove', danger: true, iconName: 'trash',
      });
      if (!ok) return;
      const list = visible();
      const next = list[list.findIndex((x) => x.id === g.id) + 1] || list[list.findIndex((x) => x.id === g.id) - 1];
      await window.hub.remove(g.id);
      if (state.focused === g.id) focusGame(next && next.id !== g.id ? next : null);
      return toast(`Removed ${nameOf(g)}.`);
    }
    case 'add': return addGames();
    case 'menu': {
      const b = $('#details [data-act="menu"]').getBoundingClientRect();
      return openMenu(b.right - 230, b.bottom + 4, g);
    }
  }
}

function openMenu(x, y, g) {
  const m = $('#menu');
  const item = (act, i, label, cls = '', dis = false) => `<button data-act="${act}" class="${cls}" ${dis ? 'disabled' : ''}>${icon(i)}${label}</button>`;
  m.innerHTML = [
    item('play', g.source === 'steam' && !g.installed ? 'download' : 'player-play', g.source === 'steam' && !g.installed ? 'Install' : 'Play', '', g.running || (!g.installed && g.source !== 'steam')),
    item('fav', 'star', g.favorite ? 'Remove from favourites' : 'Add to favourites'),
    '<hr>',
    item('folder', 'folder-open', 'Open folder', '', !g.dir),
    item('edit', 'pencil', 'Edit name, cover, file'),
    g.source !== 'steam' ? item('playtime', 'clock', 'Set playtime') : '',
    g.source === 'steam' ? item('store', 'external-link', 'Steam store page') : '',
    g.url ? item('page', 'external-link', 'itch.io page') : '',
    '<hr>',
    item('remove', 'trash', 'Remove from Hearth<kbd>Del</kbd>', 'danger'),
  ].join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; m.hidden = true; doAction(b.dataset.act, g); };
}

// ---------- toasts and modals ----------
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.innerHTML = icon(err ? 'alert-triangle' : 'circle-check') + `<span>${esc(msg)}</span>`;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3500);
}
let modalClose = null;
function modal(html, cls = '') {
  const m = $('#modal');
  m.className = 'modal ' + cls;
  m.innerHTML = html;
  $('#overlay').hidden = false;
  return m;
}
function closeModal(v) {
  $('#overlay').hidden = true;
  $('#modal').innerHTML = '';
  const f = modalClose;
  modalClose = null;
  if (f) f(v);
}
const head = (i, title, sub, danger) => `<div class="modal-head">${icon(i, danger ? 'danger' : '')}<h2>${esc(title)}</h2></div>${sub ? `<div class="modal-sub">${sub}</div>` : ''}`;
function confirmBox({ title, text, iconName = 'alert-triangle', danger = false, ok = 'Continue' }) {
  return new Promise((resolve) => {
    modal(`${head(iconName, title, esc(text), danger)}<div class="modal-foot"><div class="spacer"></div><button class="btn ghost" data-x>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>`, 'narrow');
    modalClose = resolve;
    $('#modal [data-x]').onclick = () => closeModal(false);
    $('#modal [data-ok]').onclick = () => closeModal(true);
  });
}

// Add: one game by its exe, or a whole folder of games at once.
function addGames() {
  const m = modal(`${head('plus', 'Add games', 'Steam and itch.io games appear on their own. Add anything else here, like DRM-free, cracked or emulated games.')}
    <div class="modal-body"><div class="choices">
      <button class="choice" data-c="one">${icon('file')}<div><b>One game</b><small>Pick a standalone game's .exe or shortcut. Dropping it on the window works too.</small></div></button>
      <button class="choice" data-c="folder">${icon('folder-plus')}<div><b>A folder of games</b><small>Pick a folder like D:\\Games and tick the games found inside.</small></div></button>
    </div></div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn ghost" data-x>Cancel</button></div>`, 'narrow');
  $('[data-x]', m).onclick = () => closeModal();
  $('[data-c="one"]', m).onclick = async () => { const p = await window.hub.pickExe(); if (p) addOne(p); };
  $('[data-c="folder"]', m).onclick = async () => { const f = await window.hub.pickFolder('Pick your games folder'); if (f) scanFolder(f); };
}

function gameForm(v) {
  return `<div class="form">
    <label class="field"><span>Name</span><input class="input" id="f-name" value="${esc(v.name)}" spellcheck="false"></label>
    ${v.showExe ? `<div class="field"><span>Game file</span><div class="input-row"><input class="input mono" id="f-exe" value="${esc(v.exe)}" spellcheck="false"><button class="btn" id="f-browse">${icon('folder-open')}Browse</button></div>${v.exeHint ? `<small>${v.exeHint}</small>` : ''}</div>` : ''}
    ${v.showArgs ? `<label class="field"><span>Launch options</span><input class="input mono" id="f-args" value="${esc(v.args)}" placeholder="Optional, for example -windowed" spellcheck="false"></label>` : ''}
    <div class="field"><span>Cover</span><div class="cover-pick"><div class="thumb" id="f-thumb">${v.cover ? `<img src="${esc(imgUrl(v.cover))}" alt="">` : icon('photo')}</div>
      <div class="input-row"><button class="btn" id="f-cover">${icon('photo')}Pick image</button><button class="btn ghost" id="f-cover-x" ${v.cover ? '' : 'hidden'}>Use default</button></div></div>
      <small>A portrait image looks best (600 × 900).</small></div>
  </div>`;
}
function wireForm(m, v) {
  if ($('#f-browse', m)) $('#f-browse', m).onclick = async () => { const p = await window.hub.pickExe($('#f-exe', m).value || undefined); if (p) { $('#f-exe', m).value = p.exe; if (!$('#f-name', m).value) $('#f-name', m).value = p.name; } };
  $('#f-cover', m).onclick = async () => {
    const p = await window.hub.pickImage();
    if (!p) return;
    v.cover = p;
    $('#f-thumb', m).innerHTML = `<img src="${esc(imgUrl(p))}" alt="">`;
    $('#f-cover-x', m).hidden = false;
  };
  $('#f-cover-x', m).onclick = () => { v.cover = null; $('#f-thumb', m).innerHTML = icon('photo'); $('#f-cover-x', m).hidden = true; };
}

function addOne(p) {
  const v = { name: p.name, exe: p.exe, args: '', cover: null, showExe: true, showArgs: true };
  const m = modal(`${head('plus', 'Add a game')}<div class="modal-body">${gameForm(v)}</div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${icon('plus')}Add game</button></div>`, 'narrow');
  wireForm(m, v);
  $('[data-x]', m).onclick = () => closeModal();
  $('[data-ok]', m).onclick = async () => {
    const r = await window.hub.add({ name: $('#f-name', m).value.trim(), exe: $('#f-exe', m).value.trim(), args: $('#f-args', m).value.trim(), cover: v.cover });
    if (!r.ok) return toast(r.error, true);
    closeModal();
    state.filter = state.filter === 'all' || state.filter === 'other' ? state.filter : 'all';
    state.focused = r.id;
    toast(r.existed ? 'That game is already in your library.' : 'Game added. Hearth tracks its playtime from now on.');
  };
  $('#f-name', m).select();
}

async function scanFolder(dir) {
  modal(`${head('folder-plus', 'Looking for games', esc(dir))}<div class="modal-body"><div class="loading" style="position:static;padding:30px">${icon('loader-2', 'spin')} Reading folders</div></div>`, 'narrow');
  const found = await window.hub.scanFolder(dir);
  if (!found.length) {
    modal(`${head('ghost', 'No games found', `Nothing in <b>${esc(dir)}</b> looked like a game. Each game should be in its own folder with an .exe inside.`)}
      <div class="modal-foot"><div class="spacer"></div><button class="btn primary" data-x>OK</button></div>`, 'narrow');
    $('#modal [data-x]').onclick = () => closeModal();
    return;
  }
  const fresh = found.filter((f) => !f.known).length;
  const m = modal(`${head('folder-plus', `Found ${found.length} game${found.length === 1 ? '' : 's'}`, `Check the names, untick anything that isn't a game, then add them. ${fresh < found.length ? 'Faded ones are already in your library.' : ''}`)}
    <div class="modal-body"><div class="scan-list">${found.map((f, i) => `
      <div class="scan-item${f.known ? ' known' : ''}">
        <label class="cb"><input type="checkbox" data-i="${i}" ${f.known ? 'disabled' : 'checked'}><span></span></label>
        <div class="nm"><input class="input" data-n="${i}" value="${esc(f.name)}" spellcheck="false"><div class="p" title="${esc(f.exe)}"><bdi>${esc(f.exe)}</bdi></div></div>
      </div>`).join('')}</div></div>
    <div class="modal-foot"><span class="muted" id="scan-n"></span><div class="spacer"></div><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${icon('plus')}Add</button></div>`);
  const count = () => { const n = $$('input[type=checkbox]:checked', m).length; $('#scan-n', m).textContent = `${n} selected`; $('[data-ok]', m).disabled = !n; };
  m.addEventListener('change', count);
  count();
  $('[data-x]', m).onclick = () => closeModal();
  $('[data-ok]', m).onclick = async () => {
    const pick = $$('input[type=checkbox]:checked', m).map((c) => { const i = +c.dataset.i; return { ...found[i], name: $(`[data-n="${i}"]`, m).value.trim() || found[i].name }; });
    const n = await window.hub.addMany(pick);
    closeModal();
    toast(`Added ${n} game${n === 1 ? '' : 's'}.`);
  };
}

function editGame(g) {
  const v = { name: nameOf(g), exe: g.customExe || g.exe || '', args: g.args || '', cover: g.customCover || null, showExe: g.source !== 'steam', showArgs: g.source !== 'steam',
    exeHint: g.source === 'itch' ? 'Hearth tracks playtime for whatever runs from the game folder.' : '' };
  const m = modal(`${head('pencil', 'Edit ' + nameOf(g))}<div class="modal-body">${gameForm(v)}</div>
    <div class="modal-foot">${g.customName ? '<button class="btn ghost" data-reset>Reset name</button>' : ''}<div class="spacer"></div><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${icon('check')}Save</button></div>`, 'narrow');
  wireForm(m, v);
  $('[data-x]', m).onclick = () => closeModal();
  if ($('[data-reset]', m)) $('[data-reset]', m).onclick = () => { $('#f-name', m).value = g.name; };
  $('[data-ok]', m).onclick = async () => {
    const name = $('#f-name', m).value.trim();
    const patch = { customName: name && name !== g.name ? name : null, customCover: v.cover };
    if (v.showExe) {
      const exe = $('#f-exe', m).value.trim();
      if (exe !== (g.customExe || g.exe || '')) patch.customExe = exe || null;
      patch.args = $('#f-args', m).value.trim();
    }
    await window.hub.update(g.id, patch);
    state.exeIcons.delete(g.id);
    closeModal();
  };
}

function setPlaytime(g) {
  const h = Math.floor(g.playSeconds / 3600), mn = Math.floor((g.playSeconds % 3600) / 60);
  const m = modal(`${head('clock', 'Set playtime', `Already played <b>${esc(nameOf(g))}</b> before Hearth? Enter the total and tracking carries on from there.`)}
    <div class="modal-body"><div class="form"><div class="hms"><input class="input" id="p-h" type="number" min="0" value="${h}"> hours <input class="input" id="p-m" type="number" min="0" max="59" value="${mn}"> minutes</div></div></div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${icon('check')}Save</button></div>`, 'narrow');
  $('[data-x]', m).onclick = () => closeModal();
  $('[data-ok]', m).onclick = async () => {
    const s = (Math.max(0, +$('#p-h', m).value || 0) * 3600) + (Math.max(0, +$('#p-m', m).value || 0) * 60);
    await window.hub.setPlaytime(g.id, s);
    closeModal();
  };
  $('#p-h', m).select();
}

// ---------- settings ----------
function settings() {
  const s = state.settings;
  const st = state.meta.status || {};
  const steamUser = st.steam?.user;
  const hidden = state.games.filter((g) => g.hidden);
  const m = modal(`${head('settings', 'Settings')}
    <div class="modal-body"><div class="form">
      <div class="section-title">${icon('brand-steam')}Steam</div>
      <div class="field"><small>${st.steam?.found ? `Found Steam in <b>${esc(st.steam.path)}</b>${steamUser?.persona ? `, signed in as <b>${esc(steamUser.persona)}</b>` : ''}. Installed games and their playtime are read straight from Steam's files.` : 'Steam was not found on this PC.'}</small></div>
      <label class="field"><span>Steam Web API key (optional)</span>
        <input class="input mono" id="s-key" placeholder="${state.hasApiKey ? esc(s.steamApiKey) + ' (saved)' : 'Paste your key'}" spellcheck="false" autocomplete="off">
        <small>Adds exact playtime for every game you own, including ones that aren't installed. Get a free key at <a data-url="https://steamcommunity.com/dev/apikey">steamcommunity.com/dev/apikey</a>. Your profile's game details need to be public.</small></label>
      <label class="field"><span>SteamID64</span><input class="input mono" id="s-id" value="${esc(s.steamId)}" placeholder="7656119..." spellcheck="false"></label>
      <div class="input-row"><button class="btn small" id="s-test">${icon('key')}Test connection</button>${state.hasApiKey ? `<button class="btn small ghost" id="s-clear">Remove key</button>` : ''}<span class="muted" id="s-test-r" style="align-self:center;font-size:12px"></span></div>

      <div class="section-title">${icon('brand-itch')}itch.io</div>
      <div class="field"><small>${st.itch?.found ? `Reading the itch app's library (${st.itch.count} installed).` : 'The itch app was not found. Games installed with it show up here on their own.'}</small></div>
      <div class="field"><span>Extra itch install folders</span>
        <div id="s-itch">${(s.itchDirs || []).map((d, i) => `<div class="input-row" style="margin-bottom:6px"><input class="input mono" value="${esc(d)}" readonly><button class="btn ghost" data-rm="${i}">${icon('x')}</button></div>`).join('')}</div>
        <div><button class="btn small" id="s-itch-add">${icon('folder-plus')}Add folder</button></div></div>

      <div class="section-title">${icon('clock-play')}Tracking</div>
      <div class="toggle-row"><div class="t"><b>Keep running in the tray</b><small>Closing the window keeps tracking playtime. Quit from the tray icon.</small></div><label class="toggle"><input type="checkbox" id="s-tray" ${s.trayOnClose ? 'checked' : ''}><span class="track"></span></label></div>
      <div class="toggle-row"><div class="t"><b>Start with Windows</b><small>Opens hidden in the tray, so games you start from anywhere get tracked.</small></div><label class="toggle"><input type="checkbox" id="s-boot" ${s.startWithWindows ? 'checked' : ''}><span class="track"></span></label></div>
      <div class="section-title">${icon('download')}Updates</div>
      <div class="update-row"><span>Hearth <b>${esc(update.current || '')}</b></span><span class="muted" id="s-upd">${esc(updateText(update))}</span>
        <span class="spacer"></span><button class="btn small" id="s-upd-check">${icon('refresh')}Check now</button></div>
      <div class="field"><small>Hearth checks for a new version every time it starts.${update.portable ? ' The portable version can’t update itself, so it tells you when there’s a new download.' : ' New versions download in the background and install when you restart Hearth.'}</small></div>

      <div class="section-title">${icon('brand-discord')}Discord</div>
      <div class="toggle-row"><div class="t"><b>Show what I'm playing on Discord</b><small>Your status shows the game, how long this session has run and your total playtime.</small></div><label class="toggle"><input type="checkbox" id="s-rpc" ${s.discordRpc ? 'checked' : ''}><span class="track"></span></label></div>
      <label class="field"><span>Discord application ID</span><input class="input mono" id="s-rpc-id" value="${esc(s.discordClientId)}" placeholder="Paste the Application ID" spellcheck="false">
        <small>One-time setup: open the <a data-url="https://discord.com/developers/applications">Discord Developer Portal</a>, click <b>New Application</b>, name it <b>Hearth</b> and copy its <b>Application ID</b> here. <span id="s-rpc-state"></span></small></label>
      <div class="toggle-row"><div class="t"><b>Use the game's own icon</b><small>Discord can only show pictures from a web link, so each game's icon is uploaded once to catbox.moe (a public image host). Steam games use Steam's icon and need no upload.</small></div><label class="toggle"><input type="checkbox" id="s-rpc-ico" ${s.discordIcons ? 'checked' : ''}><span class="track"></span></label></div>
      ${hidden.length ? `<div class="section-title">${icon('trash')}Removed games</div><div class="scan-list">${hidden.map((g) => `<div class="toggle-row"><span>${esc(nameOf(g))} <span class="pill ${g.source}">${SOURCES[g.source].label}</span></span><button class="btn small" data-unhide="${esc(g.id)}">${icon('arrow-back-up')}Restore</button></div>`).join('')}</div>` : ''}
    </div></div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${icon('check')}Save</button></div>`, 'narrow');
  const itchDirs = [...(s.itchDirs || [])];
  $('#s-upd-check', m).onclick = () => { bannerDismissed = false; window.hub.update.check(); };
  window.hub.discordStatus().then((d) => {
    const el = $('#s-rpc-state', m);
    if (el && d.enabled && d.hasId) {
      el.innerHTML = d.connected ? '<b style="color:var(--foam)">Connected to Discord.</b>'
        : d.error ? `<b style="color:var(--love)">Discord says: ${esc(d.error)}</b>` : 'Connects when you start a game with Discord open.';
    }
  });
  m.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-url]');
    if (a) window.hub.url(a.dataset.url);
    const rm = e.target.closest('[data-rm]');
    if (rm) { itchDirs.splice(+rm.dataset.rm, 1); rm.parentElement.remove(); }
    const un = e.target.closest('[data-unhide]');
    if (un) { await window.hub.update(un.dataset.unhide, { hidden: false }); un.parentElement.remove(); }
  });
  $('#s-itch-add', m).onclick = async () => {
    const f = await window.hub.pickFolder('Pick an itch.io install folder');
    if (f && !itchDirs.includes(f)) { itchDirs.push(f); $('#s-itch', m).insertAdjacentHTML('beforeend', `<div class="input-row" style="margin-bottom:6px"><input class="input mono" value="${esc(f)}" readonly></div>`); }
  };
  $('#s-test', m).onclick = async () => {
    const r$ = $('#s-test-r', m);
    r$.textContent = 'Checking...';
    const r = await window.hub.testApi($('#s-key', m).value.trim() || null, $('#s-id', m).value.trim() || null);
    r$.textContent = r.ok ? `Works: ${r.count} games on your account.` : r.error;
    r$.style.color = r.ok ? 'var(--foam)' : 'var(--love)';
  };
  if ($('#s-clear', m)) $('#s-clear', m).onclick = async () => { await window.hub.setSettings({ steamApiKey: '' }); state.hasApiKey = false; closeModal(); toast('Steam Web API key removed.'); };
  $('[data-x]', m).onclick = () => closeModal();
  $('[data-ok]', m).onclick = async () => {
    const patch = { steamId: $('#s-id', m).value.trim(), trayOnClose: $('#s-tray', m).checked, startWithWindows: $('#s-boot', m).checked, itchDirs,
      discordRpc: $('#s-rpc', m).checked, discordClientId: $('#s-rpc-id', m).value.trim().replace(/\D/g, ''), discordIcons: $('#s-rpc-ico', m).checked };
    const key = $('#s-key', m).value.trim();
    if (key) patch.steamApiKey = key;
    apply(await window.hub.setSettings(patch));
    closeModal();
    refresh(true);
  };
}

// ---------- stats ----------
async function stats() {
  history = await window.hub.history();
  const games = state.games.filter((g) => !g.hidden);
  const total = games.reduce((s, g) => s + g.playSeconds, 0);
  const bySrc = Object.fromEntries(Object.keys(SOURCES).map((k) => [k, games.filter((g) => g.source === k).reduce((s, g) => s + g.playSeconds, 0)]));
  const top = [...games].sort((a, b) => b.playSeconds - a.playSeconds).filter((g) => g.playSeconds >= 60).slice(0, 10);
  const max = top[0]?.playSeconds || 1;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ d, s: Object.values(history[k] || {}).reduce((a, b) => a + b, 0), today: i === 0 });
  }
  const dmax = Math.max(3600, ...days.map((x) => x.s));
  const played = games.filter((g) => g.playSeconds >= 60).length;
  const m = modal(`${head('chart-bar', 'Playtime')}
    <div class="modal-body">
      <div class="summary">
        <div class="stat"><b>${fmtTime(total)}</b><span>${icon('hourglass')}All games</span></div>
        <div class="stat"><b>${fmtTime(bySrc.steam)}</b><span>${icon('brand-steam')}Steam</span></div>
        <div class="stat"><b>${fmtTime(bySrc.itch)}</b><span>${icon('brand-itch')}itch.io</span></div>
        <div class="stat"><b>${fmtTime(bySrc.other)}</b><span>${icon('device-desktop')}Other</span></div>
      </div>
      <div class="stats-cols">
        <div><p class="sub-h">Most played · ${played} of ${games.length} games played</p><div class="bars">${top.map((g) => `
          <div class="bar-row"><span class="nm">${esc(nameOf(g))}</span><span class="val">${fmtTime(g.playSeconds)}</span><div class="track2"><div class="fill ${g.source}" style="width:${Math.max(2, (g.playSeconds / max) * 100)}%"></div></div></div>`).join('') || '<p class="muted">Nothing played yet.</p>'}</div>
          <div class="legend"><span><i class="dot steam"></i>Steam</span><span><i class="dot itch"></i>itch.io</span><span><i class="dot other"></i>Other</span></div>
        </div>
        <div><p class="sub-h">Last 14 days · ${fmtTime(days.reduce((a, x) => a + x.s, 0))}</p>
          <div class="days">${days.map((x) => `<div class="day${x.today ? ' today' : ''}" title="${x.d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}: ${fmtLong(x.s)}">
            <div class="b${x.s ? '' : ' zero'}" style="height:${x.s ? Math.max(4, (x.s / dmax) * 100) : 2}%"></div><span class="l">${x.d.toLocaleDateString(undefined, { weekday: 'narrow' })}</span></div>`).join('')}</div>
          <p class="hint" style="margin-top:12px;line-height:1.5">Daily history starts when you start using Hearth. Steam time is counted each time Hearth syncs.</p>
        </div>
      </div>
    </div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn primary" data-x>Done</button></div>`);
  $('[data-x]', m).onclick = () => closeModal();
}

// ---------- refresh ----------
let refreshing = false;
async function refresh(manual = false) {
  if (refreshing) return;
  refreshing = true;
  const b = $('#btn-refresh');
  b.innerHTML = icon('loader-2', 'spin');
  try {
    const snap = await window.hub.refresh();
    history = await window.hub.history();
    apply(snap);
    const api = snap.meta?.status?.api;
    if (manual) {
      if (api && !api.ok) toast('Steam sync: ' + api.error, true);
      else toast(api?.ok ? `Synced playtime for ${api.count} Steam games.` : 'Library refreshed.');
    }
  } catch (e) { toast('Refresh failed: ' + e.message, true); }
  b.innerHTML = icon('refresh');
  refreshing = false;
}

// ---------- events ----------
$('#list').addEventListener('click', (e) => {
  const r = e.target.closest('[data-id]');
  if (r) focusGame(byId(r.dataset.id));
});
$('#list').addEventListener('dblclick', (e) => {
  const r = e.target.closest('[data-id]');
  if (r) play(byId(r.dataset.id));
});
$('#list').addEventListener('contextmenu', (e) => {
  const r = e.target.closest('[data-id]');
  if (!r) return;
  e.preventDefault();
  const g = byId(r.dataset.id);
  focusGame(g);
  openMenu(e.clientX, e.clientY, g);
});
$('#details').addEventListener('click', (e) => {
  const g = byId(state.focused);
  const b = e.target.closest('[data-act]');
  if (b && g) return doAction(b.dataset.act, g);
  const l = e.target.closest('[data-open]');
  if (l) window.hub.show(l.dataset.open).then((ok) => ok || toast('That path no longer exists.', true));
});
$('#empty').addEventListener('click', (e) => { if (e.target.closest('[data-act="add"]')) addGames(); });
document.addEventListener('click', (e) => { if (!e.target.closest('#menu') && !e.target.closest('[data-act="menu"]')) $('#menu').hidden = true; });
$('#overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'overlay') closeModal(); });

for (const t of $$('.tab')) t.addEventListener('click', () => { state.filter = t.dataset.f; store.set('filter', state.filter); render(); });
for (const b of $$('#view-seg button')) b.addEventListener('click', () => { state.view = b.dataset.v; store.set('view', state.view); render(); });
for (const c of $$('[data-sort]')) c.addEventListener('click', () => {
  const k = c.dataset.sort;
  state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === 'name' || k === 'source' ? 1 : -1 };
  store.set('sort', state.sort);
  render();
});
$('#installed-only').addEventListener('change', (e) => { state.installedOnly = e.target.checked; store.set('installedOnly', state.installedOnly); render(); });

const search = $('#search');
search.addEventListener('input', () => { state.query = search.value.trim(); search.parentElement.classList.toggle('has-text', !!search.value); render(); });
$('#clear-search').addEventListener('click', () => { search.value = ''; search.dispatchEvent(new Event('input')); search.focus(); });
$('#btn-refresh').addEventListener('click', () => refresh(true));
$('#btn-add').addEventListener('click', addGames);
$('#btn-add-game').addEventListener('click', addGames);

// Drop an .exe or shortcut to add that game, or a folder to scan it for games.
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length || !$('#overlay').hidden) return;
  const info = await window.hub.inspect(window.hub.pathOf(files[0]));
  if (!info || info.bad) return toast('Drop a game .exe, a shortcut or a folder of games.', true);
  if (info.dir) scanFolder(info.path);
  else addOne(info);
});
$('#btn-stats').addEventListener('click', stats);
$('#btn-settings').addEventListener('click', settings);
$('#btn-theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));

document.addEventListener('keydown', (e) => {
  if (!$('#overlay').hidden) { if (e.key === 'Escape') closeModal(); return; }
  if (e.key === 'Escape') { $('#menu').hidden = true; if (search.value) { search.value = ''; search.dispatchEvent(new Event('input')); } return; }
  if (e.key === 'F5') { e.preventDefault(); refresh(true); return; }
  if ((e.ctrlKey && e.key === 'f')) { e.preventDefault(); search.focus(); search.select(); return; }
  if (e.ctrlKey && e.key === 'n') { e.preventDefault(); addGames(); return; }
  const inInput = e.target.matches('input, textarea');
  const list = visible();
  const i = list.findIndex((g) => g.id === state.focused);
  const cols = state.view === 'grid' ? Math.max(1, Math.round($('#list').clientWidth / ($('#list .card')?.offsetWidth + 14 || 150))) : 1;
  const move = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: state.view === 'grid' ? 1 : 0, ArrowLeft: state.view === 'grid' ? -1 : 0 }[e.key];
  if (move && list.length && (!inInput || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    focusGame(list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + move))], true);
    return;
  }
  if (e.key === 'Enter' && i >= 0) { e.preventDefault(); play(list[i]); return; }
  if (e.key === 'Delete' && i >= 0 && !inInput) { e.preventDefault(); doAction('remove', list[i]); return; }
  if (!inInput && e.key.length === 1 && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) search.focus();
});

// ---------- updates ----------
let update = {};
let bannerDismissed = false;
function updateText(u) {
  switch (u.status) {
    case 'checking': return 'Checking for updates...';
    case 'latest': return 'You have the newest version.';
    case 'downloading': return `Downloading ${u.version || 'update'}${u.percent ? ` (${u.percent}%)` : ''}...`;
    case 'ready': return `Version ${u.version} is ready. Restart to update.`;
    case 'available': return `Version ${u.version} is out.`;
    case 'error': return `Couldn't check for updates: ${u.error}`;
    default: return '';
  }
}
function renderUpdate(u) {
  update = u;
  const b = $('#update-banner');
  const show = !bannerDismissed && (u.status === 'ready' || u.status === 'available');
  b.hidden = !show;
  if (show) {
    $('#update-text').innerHTML = u.status === 'ready'
      ? `<b>Hearth ${esc(u.version)}</b> is downloaded. Restart Hearth to finish updating.`
      : `<b>Hearth ${esc(u.version)}</b> is out. Download it to update.`;
    $('#update-go').innerHTML = u.status === 'ready' ? icon('refresh') + 'Restart now' : icon('download') + 'Download';
  }
  const s = $('#s-upd');
  if (s) s.textContent = updateText(u);
}
$('#update-go').addEventListener('click', () => (update.status === 'ready' ? window.hub.update.install() : window.hub.update.open()));
$('#update-later').addEventListener('click', () => { bannerDismissed = true; $('#update-banner').hidden = true; });
window.hub.update.onState(renderUpdate);
window.hub.update.get().then(renderUpdate);

window.hub.onChange((snap) => apply(snap));
// While a game runs, keep its playtime ticking in the details panel and footer without a full re-render.
window.hub.onTick((live) => {
  for (const u of live) {
    const g = byId(u.id);
    if (!g) continue;
    g.playSeconds = u.playSeconds;
    if (state.focused === g.id && $('#d-time')) $('#d-time').textContent = fmtLong(g.playSeconds);
  }
  renderFooter();
});
setInterval(renderFooter, 60000);

(async function init() {
  hydrateIcons();
  applyTheme(store.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  history = await window.hub.history();
  const snap = await window.hub.get();
  if (snap.games.length || snap.meta?.lastScan) apply(snap);
  // The first scan happens in the background at startup; the list fills in when it's done.
  if (!snap.meta?.lastScan) $('#loading').hidden = false;
})();
// Covers that fail to load (no art on the Steam CDN, offline) fall back to the placeholder underneath.
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);
