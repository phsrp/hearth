// Hearth - main process. Keeps the game library, reads Steam and itch.io, launches games and tracks how long they run.
const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, protocol, net, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const steam = require('./lib/steam');
const itch = require('./lib/itch');
const { pickExe, scanFolder, prettyName, listExes } = require('./lib/exe');
const { Tracker } = require('./lib/tracker');
const { DiscordRpc } = require('./lib/discord');
const { DiscordKnown } = require('./lib/discord-known');
const { createUpdater } = require('./lib/updater');

if (process.env.HEARTH_USERDATA) app.setPath('userData', process.env.HEARTH_USERDATA);
if (!app.requestSingleInstanceLock()) app.quit();
protocol.registerSchemesAsPrivileged([{ scheme: 'ghimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win = null;
let tray = null;
let quitting = false;
const TICK = 10;

// ---------- storage ----------
const dataFile = () => path.join(app.getPath('userData'), 'library.json');
const DEFAULT_SETTINGS = { steamApiKey: '', steamId: '', showUninstalled: true, trayOnClose: true, startWithWindows: false, itchDirs: [], autoSyncMinutes: 15,
  discordRpc: true, discordClientId: '', discordIcons: true, discordSkipKnown: true };
let db = { games: {}, settings: { ...DEFAULT_SETTINGS }, history: {}, meta: {} };
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    db = { games: d.games || {}, settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) }, history: d.history || {}, meta: d.meta || {} };
  } catch {}
}
let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      const tmp = dataFile() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, dataFile());
    } catch {}
  };
  if (now) write(); else saveTimer = setTimeout(write, 1500);
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function addHistory(id, seconds) {
  if (seconds <= 0) return;
  const day = (db.history[today()] ||= {});
  day[id] = (day[id] || 0) + seconds;
}

// ---------- playtime ----------
function playSeconds(g) {
  const src = (g.sourceMinutes || 0) * 60;
  const off = g.offsetSeconds || 0;
  if (g.source === 'steam') return Math.max(src, (g.apiMinutes || 0) * 60) + off;
  if (g.source === 'itch') return Math.max(src, g.trackedSeconds || 0) + off;
  return (g.trackedSeconds || 0) + off;
}

const running = new Map(); // id -> session start (ms)
const runningPaths = new Map(); // id -> the game's running process paths (Discord matches on these)
function publicGame(g) {
  return { ...g, playSeconds: Math.max(0, Math.round(playSeconds(g))), running: running.has(g.id), runningSince: running.get(g.id) || null };
}
function snapshot() {
  return {
    games: Object.values(db.games).map(publicGame),
    settings: { ...db.settings, steamApiKey: db.settings.steamApiKey ? '••••' + db.settings.steamApiKey.slice(-4) : '' },
    hasApiKey: !!db.settings.steamApiKey,
    meta: db.meta,
  };
}
const notify = () => { if (win && !win.isDestroyed()) win.webContents.send('library:changed', snapshot()); };

// ---------- scanning ----------
// Scanned games are merged into what we already have, so user edits (name, cover, exe, favourite, hidden) and tracked time survive.
const KEEP = ['customName', 'customCover', 'customExe', 'args', 'favorite', 'hidden', 'trackedSeconds', 'offsetSeconds', 'addedAt', 'apiMinutes', 'sessions'];
function upsertScanned(list, source) {
  const seen = new Set();
  for (const s of list) {
    seen.add(s.id);
    const old = db.games[s.id];
    const g = { ...s, addedAt: Date.now() };
    if (old) {
      for (const k of KEEP) if (old[k] !== undefined) g[k] = old[k];
      g.lastPlayed = Math.max(old.lastPlayed || 0, s.lastPlayed || 0);
      // Steam only tells us totals, so growth between syncs is what got played today.
      if (source === 'steam' && old.sourceMinutes > 0 && s.sourceMinutes > old.sourceMinutes) addHistory(s.id, (s.sourceMinutes - old.sourceMinutes) * 60);
      if (old.sourceMinutes > (s.sourceMinutes || 0) && source === 'steam') g.sourceMinutes = old.sourceMinutes;
    }
    db.games[s.id] = g;
  }
  for (const g of Object.values(db.games)) {
    if (g.source === source && !seen.has(g.id) && g.installed && !g.fromApi) g.installed = false;
  }
}

let scanning = null;
async function rescan({ api = true } = {}) {
  if (scanning) return scanning;
  scanning = (async () => {
    const status = { steam: null, itch: null, api: null };
    try {
      const st = await steam.scan();
      status.steam = { found: st.found, path: st.path || null, user: st.user || null };
      if (st.found) {
        upsertScanned(st.games, 'steam');
        // Played-but-uninstalled games we already know about still get their local playtime refreshed
        for (const [appid, p] of Object.entries(st.played || {})) {
          const g = db.games['steam:' + appid];
          if (g && !g.installed && p.minutes > (g.sourceMinutes || 0)) { g.sourceMinutes = p.minutes; g.lastPlayed = Math.max(g.lastPlayed || 0, p.lastPlayed); }
        }
        if (!db.settings.steamId && st.user?.id64) db.settings.steamId = st.user.id64;
      }
    } catch (e) { status.steam = { found: false, error: e.message }; }
    try {
      const it = itch.scan(db.settings.itchDirs);
      status.itch = { found: it.found, count: it.games.length };
      upsertScanned(it.games, 'itch');
    } catch (e) { status.itch = { found: false, error: e.message }; }
    if (api && db.settings.steamApiKey) status.api = await syncApi();
    db.meta.lastScan = Date.now();
    db.meta.status = status;
    save();
    notify();
    return snapshot();
  })();
  try { return await scanning; } finally { scanning = null; }
}

async function syncApi() {
  const id = db.settings.steamId;
  if (!db.settings.steamApiKey || !id) return { ok: false, error: 'Add a Steam Web API key and SteamID in Settings.' };
  try {
    const owned = await steam.webOwned(net.fetch, db.settings.steamApiKey, id);
    const known = steam.findSteam();
    const steamPath = await known;
    for (const o of owned) {
      const key = 'steam:' + o.appid;
      let g = db.games[key];
      if (!g) {
        const a = steamPath ? steam.art(steamPath, o.appid) : {};
        g = db.games[key] = {
          id: key, source: 'steam', appid: o.appid, name: o.name, installed: false, fromApi: true, addedAt: Date.now(),
          cover: a.cover || steam.cdn(o.appid, 'library_600x900.jpg'), header: a.header || steam.cdn(o.appid, 'header.jpg'), icon: a.icon || o.iconUrl,
          sourceMinutes: 0,
        };
      }
      const prev = Math.max(g.apiMinutes || 0, g.sourceMinutes || 0);
      if (prev > 0 && o.minutes > prev) addHistory(key, (o.minutes - prev) * 60);
      g.apiMinutes = o.minutes;
      g.twoWeeksMinutes = o.twoWeeks;
      g.lastPlayed = Math.max(g.lastPlayed || 0, o.lastPlayed || 0);
      if (!g.icon && o.iconUrl) g.icon = o.iconUrl;
    }
    db.meta.lastApiSync = Date.now();
    return { ok: true, count: owned.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- tracking ----------
const tracker = new Tracker(TICK);
let lastTick = 0;
const SHALLOW = () => [app.getPath('desktop'), app.getPath('downloads'), app.getPath('documents'), app.getPath('home'),
  process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).map((p) => p.toLowerCase());

// A game counts as running when any process runs from inside its folder. Games sitting loose in a shared folder
// (Desktop, Downloads, a drive root) only match their exact exe.
function matcher(g) {
  const exe = (g.customExe || g.exe || '').toLowerCase();
  let root = (g.dir || (exe && path.dirname(exe)) || '').toLowerCase().replace(/[\\/]+$/, '');
  if (!root && !exe) return null;
  // A folder that holds other library games too (say a loose D:\Games full of exes) can't tell them apart
  const shared = Object.values(db.games).some((o) => {
    if (o.id === g.id || !o.installed) return false;
    const r = (o.dir || path.dirname(o.customExe || o.exe || '')).toLowerCase().replace(/[\\/]+$/, '');
    return r && (r === root || r.startsWith(root + '\\'));
  });
  const shallow = shared || !root || root.startsWith((process.env.SystemRoot || 'c:\\windows').toLowerCase()) || /^[a-z]:$/.test(root) || SHALLOW().includes(root) || root.split(/[\\/]/).length < 2;
  if (shallow) return exe ? (p) => p === exe : null;
  return (p) => p.startsWith(root + '\\');
}

tracker.on('tick', (paths) => {
  const now = Date.now();
  const dt = lastTick ? Math.min((now - lastTick) / 1000, TICK * 3) : 0;
  lastTick = now;
  let changed = false;
  for (const g of Object.values(db.games)) {
    if (!g.installed) continue;
    const m = matcher(g);
    const hits = m ? paths.filter(m) : [];
    const on = hits.length > 0;
    if (on) runningPaths.set(g.id, hits); else runningPaths.delete(g.id);
    if (on && !running.has(g.id)) { running.set(g.id, now); changed = true; }
    if (on) {
      g.lastPlayed = Math.floor(now / 1000);
      // Steam counts its own games; we only add time for everything else.
      if (g.source !== 'steam') { g.trackedSeconds = (g.trackedSeconds || 0) + dt; addHistory(g.id, dt); }
    }
    if (!on && running.has(g.id)) {
      const start = running.get(g.id);
      running.delete(g.id);
      g.sessions = [...(g.sessions || []), { start, end: now }].slice(-50);
      changed = true;
      // Steam writes the new total to localconfig.vdf shortly after the game closes
      if (g.source === 'steam') setTimeout(() => rescan({ api: true }), 20000);
    }
  }
  if (running.size || changed) save();
  if (changed) { notify(); updatePresence(); }
  else if (running.size && win && !win.isDestroyed()) win.webContents.send('library:tick', [...running.keys()].map((id) => publicGame(db.games[id])));
});

// ---------- launching ----------
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push(m[1] ?? m[2]);
  return out;
}
function startElevatedOrPlain(exe, args, cwd) {
  return new Promise((resolve) => {
    try {
      const p = spawn(exe, splitArgs(args), { cwd, detached: true, stdio: 'ignore' });
      p.on('error', (e) => {
        // ERROR_ELEVATION_REQUIRED: let Windows show the admin prompt
        if (/EACCES|740|elevation/i.test(String(e.code) + e.message)) {
          const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
          execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath ${q(exe)} -WorkingDirectory ${q(cwd)}${args ? ' -ArgumentList ' + q(args) : ''}`], { windowsHide: true }, (err) => resolve(err ? err.message : null));
        } else resolve(e.message);
      });
      p.on('spawn', () => { p.unref(); resolve(null); });
    } catch (e) { resolve(e.message); }
  });
}

ipcMain.handle('game:launch', async (_e, id) => {
  const g = db.games[id];
  if (!g) return { ok: false, error: 'Game not found.' };
  if (g.source === 'steam') {
    await shell.openExternal(g.installed ? `steam://rungameid/${g.appid}` : `steam://install/${g.appid}`);
    return { ok: true, viaSteam: true, install: !g.installed };
  }
  const exe = g.customExe || g.exe;
  if (!exe || !fs.existsSync(exe)) return { ok: false, error: 'The game file is missing. Pick it again with Edit.' };
  let err = null;
  if (/\.(lnk|url|bat|cmd)$/i.test(exe)) err = (await shell.openPath(exe)) || null;
  else err = await startElevatedOrPlain(exe, g.args || '', path.dirname(exe));
  if (err) return { ok: false, error: err };
  g.lastPlayed = Math.floor(Date.now() / 1000);
  save();
  notify();
  return { ok: true };
});

// ---------- library edits ----------
// Name from the game's folder, unless the exe sits loose somewhere generic (Desktop, a bin folder), then from the file
function guessName(exe) {
  const parent = path.basename(path.dirname(exe));
  const loose = /\.(lnk|url)$/i.test(exe) || /^(desktop|downloads|documents|games?|bin|binaries|win(32|64)|x(64|86)|[a-z]:?)$/i.test(parent);
  return prettyName(loose ? path.basename(exe).replace(/\.\w+$/, '') : parent);
}
const localId = (exe) => 'local:' + crypto.createHash('sha1').update(exe.toLowerCase()).digest('hex').slice(0, 12);
function addLocal({ name, exe, args = '', cover = null }) {
  const id = localId(exe);
  if (db.games[id]) return { id, existed: true };
  db.games[id] = {
    id, source: 'other', name: name || guessName(exe), exe, args, installed: true,
    dir: path.dirname(exe), customCover: cover, trackedSeconds: 0, lastPlayed: 0, addedAt: Date.now(),
  };
  return { id, existed: false };
}

ipcMain.handle('game:add', (_e, g) => {
  if (!g.exe || !fs.existsSync(g.exe)) return { ok: false, error: 'Pick the game file first.' };
  const r = addLocal(g);
  save(); notify();
  return { ok: true, ...r };
});
ipcMain.handle('game:addMany', (_e, list) => {
  let added = 0;
  for (const g of list) if (g.exe && fs.existsSync(g.exe) && !addLocal(g).existed) added++;
  save(); notify();
  return added;
});
const EDITABLE = ['customName', 'customCover', 'customExe', 'args', 'favorite', 'hidden', 'offsetSeconds', 'discordMode'];
ipcMain.handle('game:update', (_e, id, patch) => {
  const g = db.games[id];
  if (!g) return false;
  for (const k of EDITABLE) if (k in patch) g[k] = patch[k] === '' ? null : patch[k];
  if (g.source === 'other' && patch.customExe) { g.exe = patch.customExe; g.dir = path.dirname(patch.customExe); g.customExe = null; }
  save(); notify();
  if ('discordMode' in patch || 'hidden' in patch) updatePresence();
  return true;
});
// Set the shown playtime to an exact number: stored as an offset so tracking keeps adding on top.
ipcMain.handle('game:setPlaytime', (_e, id, seconds) => {
  const g = db.games[id];
  if (!g) return false;
  g.offsetSeconds = 0;
  g.offsetSeconds = Math.round(seconds - playSeconds(g));
  save(); notify();
  return true;
});
ipcMain.handle('game:remove', (_e, id) => {
  const g = db.games[id];
  if (!g) return false;
  if (g.source === 'other') delete db.games[id];
  else g.hidden = true;
  save(); notify();
  return true;
});
// ---------- exe icons ----------
// The biggest icon inside each exe is saved as a 256 px PNG once, then reused by the window and by Discord.
const iconDir = () => path.join(app.getPath('userData'), 'icons');
function iconFile(exe) {
  let mt = 0;
  try { mt = fs.statSync(exe).mtimeMs; } catch { return null; }
  return path.join(iconDir(), crypto.createHash('sha1').update(exe.toLowerCase() + '|' + mt).digest('hex').slice(0, 16) + '.png');
}
let iconQueue = Promise.resolve();
function extractIcons(exes) {
  const todo = [...new Set(exes)].map((exe) => ({ exe, out: iconFile(exe) })).filter((t) => t.out && !fs.existsSync(t.out));
  if (!todo.length) return iconQueue;
  iconQueue = iconQueue.then(() => new Promise((resolve) => {
    fs.mkdirSync(iconDir(), { recursive: true });
    const f = path.join(iconDir(), `batch-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(todo));
    const script = app.isPackaged ? path.join(process.resourcesPath, 'icons.ps1') : path.join(__dirname, 'lib', 'icons.ps1');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InFile', f], { windowsHide: true, timeout: 60000 }, () => {
      try { fs.unlinkSync(f); } catch {}
      resolve();
    });
  }));
  return iconQueue;
}
async function exeIcon(exe) {
  if (!exe || !/\.exe$/i.test(exe) || !fs.existsSync(exe)) return null;
  await extractIcons([exe]);
  const f = iconFile(exe);
  return f && fs.existsSync(f) ? f : null;
}
ipcMain.handle('game:icon', async (_e, id) => {
  const g = db.games[id];
  const f = g && (g.customExe || g.exe);
  if (!f || !fs.existsSync(f)) return null;
  const png = await exeIcon(f);
  if (png) return 'ghimg://img/' + encodeURIComponent(png);
  try { const img = await app.getFileIcon(f, { size: 'large' }); return img.isEmpty() ? null : img.toDataURL(); } catch { return null; }
});
// Warm the cache for many games in one PowerShell run instead of one per game
ipcMain.handle('game:icons', async (_e, ids) => {
  await extractIcons(ids.map((id) => db.games[id] && (db.games[id].customExe || db.games[id].exe)).filter((f) => f && /\.exe$/i.test(f) && fs.existsSync(f)));
  return true;
});

// ---------- Discord Rich Presence ----------
const rpc = new DiscordRpc();
const known = new DiscordKnown(path.join(app.getPath('userData'), 'discord-detectable.json'), (u) => net.fetch(u));
// Discord only shows images from a public link, so an exe's icon is uploaded once to catbox.moe and the link is reused.
async function publicIcon(g) {
  if (g.source === 'steam') {
    const hash = g.icon && /([0-9a-f]{40})\.jpg$/i.exec(g.icon);
    if (hash) return `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${g.appid}/${hash[1]}.jpg`;
    if (/^https:/.test(g.icon || '')) return g.icon;
    return steam.cdn(g.appid, 'header.jpg');
  }
  const exe = g.customExe || g.exe;
  if (db.settings.discordIcons && exe) {
    const png = await exeIcon(exe);
    if (png) {
      const key = path.basename(png, '.png');
      db.meta.iconUrls ||= {};
      if (db.meta.iconUrls[key]) return db.meta.iconUrls[key];
      try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', new Blob([fs.readFileSync(png)], { type: 'image/png' }), key + '.png');
        const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
        const url = (await r.text()).trim();
        if (r.ok && /^https:\/\//.test(url)) { db.meta.iconUrls[key] = url; save(); return url; }
      } catch {}
    }
  }
  const cover = g.customCover || g.cover || '';
  return /^https:/.test(cover) ? cover : undefined;
}
const hours = (s) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${(s / 3600).toFixed(s < 36000 ? 1 : 0).replace(/\.0$/, '')} h`);
let presenceFor = null;
// Whether Hearth should set a status for this game. "auto" leaves alone games Discord already shows by itself.
function discordCovers(g) {
  const mode = g.discordMode || 'auto';
  if (mode === 'always') return null;
  if (mode === 'never') return 'off';
  if (!db.settings.discordSkipKnown) return null;
  return known.reason(g.dir || path.dirname(g.customExe || g.exe || ''), runningPaths.get(g.id) || []);
}
// Shows the game started most recently that Discord doesn't already cover: its name, how long this session
// has run, and the total playtime.
async function updatePresence() {
  rpc.setClientId(db.settings.discordRpc ? db.settings.discordClientId : '');
  if (db.settings.discordRpc && db.settings.discordSkipKnown) await known.load();
  const live = [...running.entries()].filter(([id]) => db.games[id] && !db.games[id].hidden && !discordCovers(db.games[id])).sort((a, b) => b[1] - a[1]);
  if (!db.settings.discordRpc || !live.length) { presenceFor = null; rpc.set(null); return; }
  const [id, since] = live[0];
  const g = db.games[id];
  const name = g.customName || g.name;
  const total = playSeconds(g);
  const base = {
    type: 0, status_display_type: 2, details: name, state: total >= 60 ? `${hours(total)} played in total` : 'First session',
    timestamps: { start: since }, assets: { large_text: name },
  };
  presenceFor = id;
  rpc.set(base);
  const img = await publicIcon(g);
  if (img && presenceFor === id) rpc.set({ ...base, assets: { large_image: img, large_text: name } });
}
ipcMain.handle('discord:status', () => ({ connected: rpc.ready, error: rpc.error || null, enabled: !!db.settings.discordRpc, hasId: !!db.settings.discordClientId, game: presenceFor }));
// For the details panel: does Discord already show this game, or will Hearth?
ipcMain.handle('discord:covers', async (_e, id) => {
  const g = db.games[id];
  if (!g) return null;
  await known.load();
  // As if set to Auto, so the Edit window can explain what Auto would do
  const dir = g.dir || path.dirname(g.customExe || g.exe || '');
  const paths = runningPaths.get(g.id) || (dir && fs.existsSync(dir) ? listExes(dir).map((e) => e.path) : [g.customExe || g.exe].filter(Boolean));
  return known.reason(dir, paths);
});

// ---------- dialogs and shell ----------
ipcMain.handle('pick:exe', async (_e, start) => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick the game', defaultPath: start || undefined, properties: ['openFile'],
    filters: [{ name: 'Games and shortcuts', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }, { name: 'All files', extensions: ['*'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const exe = r.filePaths[0];
  return { exe, name: guessName(exe) };
});
// Something dropped on the window: a folder gets scanned for games, a file becomes one game.
ipcMain.handle('path:inspect', (_e, p) => {
  try {
    if (fs.statSync(p).isDirectory()) return { dir: true, path: p };
  } catch { return null; }
  if (!/\.(exe|lnk|url|bat|cmd)$/i.test(p)) return { bad: true };
  return { exe: p, name: guessName(p) };
});
ipcMain.handle('pick:image', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick a cover image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] });
  return r.canceled ? null : r.filePaths[0] || null;
});
ipcMain.handle('pick:folder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Pick a folder', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0] || null;
});
ipcMain.handle('folder:scan', (_e, root) => {
  const known = new Set(Object.values(db.games).map((g) => (g.customExe || g.exe || '').toLowerCase()).filter(Boolean));
  const knownDirs = Object.values(db.games).map((g) => (g.dir || '').toLowerCase()).filter(Boolean);
  return scanFolder(root).map((f) => ({ ...f, known: known.has(f.exe.toLowerCase()) || knownDirs.includes(f.dir.toLowerCase()) }));
});
ipcMain.handle('shell:show', (_e, p) => { if (p && fs.existsSync(p)) { fs.statSync(p).isDirectory() ? shell.openPath(p) : shell.showItemInFolder(p); return true; } return false; });
ipcMain.handle('shell:url', (_e, u) => { if (/^(https?|steam):\/\//i.test(u)) shell.openExternal(u); });

// ---------- library + settings ----------
ipcMain.handle('library:get', () => snapshot());
ipcMain.handle('library:refresh', () => rescan({ api: true }));
ipcMain.handle('library:history', () => db.history);
ipcMain.handle('settings:set', async (_e, patch) => {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  for (const k of allowed) if (k in patch) db.settings[k] = patch[k];
  if ('steamApiKey' in patch) db.settings.steamApiKey = String(patch.steamApiKey || '').trim();
  if ('steamId' in patch) db.settings.steamId = String(patch.steamId || '').trim();
  if ('startWithWindows' in patch) { try { app.setLoginItemSettings({ openAtLogin: !!patch.startWithWindows, args: ['--hidden'] }); } catch {} }
  save(true);
  scheduleSync();
  updatePresence();
  return snapshot();
});
ipcMain.handle('steam:testApi', async (_e, key, id) => {
  try {
    const list = await steam.webOwned(net.fetch, String(key || db.settings.steamApiKey).trim(), String(id || db.settings.steamId).trim());
    return { ok: true, count: list.length };
  } catch (e) { return { ok: false, error: e.message }; }
});
// ---------- updates ----------
const updater = createUpdater((s) => { if (win && !win.isDestroyed()) win.webContents.send('update:state', s); });
ipcMain.handle('update:get', () => updater.get());
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:install', () => { quitting = true; tracker.stop(); save(true); updater.install(); });
ipcMain.handle('update:open', () => shell.openExternal(updater.get().url || updater.releasesUrl));

ipcMain.handle('theme:titlebar', (_e, { color, symbol }) => { try { win.setTitleBarOverlay({ color, symbolColor: symbol, height: 44 }); } catch {} });

let syncTimer = null;
function scheduleSync() {
  clearInterval(syncTimer);
  const m = Math.max(5, +db.settings.autoSyncMinutes || 15);
  syncTimer = setInterval(() => rescan({ api: true }), m * 60 * 1000);
}

// ---------- window, tray, protocol ----------
function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1240, height: 780, minWidth: 860, minHeight: 540,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191724' : '#faf4ed',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#908caa', height: 44 },
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (show) win.once('ready-to-show', () => win.show());
  if (process.env.HEARTH_SHOTS) selfTest(process.env.HEARTH_SHOTS, process.env.HEARTH_STEPS);
  win.on('close', (e) => {
    if (!quitting && db.settings.trayOnClose) { e.preventDefault(); win.hide(); }
  });
}
function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else { win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
}
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(img);
  tray.setToolTip('Hearth');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Hearth', click: showWindow },
    ...(running.size ? [{ label: 'Playing: ' + [...running.keys()].map((id) => db.games[id]?.customName || db.games[id]?.name).join(', '), enabled: false }] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

// Screenshot runner for testing and the README: HEARTH_STEPS is a JSON file of { name, js, wait } steps run in the page.
function selfTest(dir, stepsFile) {
  fs.mkdirSync(dir, { recursive: true });
  const log = (m) => fs.appendFileSync(path.join(dir, 'log.txt'), m + '\n');
  win.webContents.on('console-message', (e) => log('console: ' + (e.message || '')));
  win.webContents.once('did-finish-load', async () => {
    const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : [{ name: 'main', wait: 6000 }];
    for (const s of steps) {
      try {
        if (s.js) log(s.name + ' -> ' + JSON.stringify(await win.webContents.executeJavaScript(s.js)));
        await new Promise((r) => setTimeout(r, s.wait ?? 800));
        // A window behind others paints lazily; force a fresh frame so the shot isn't one step behind
        if (s.shot !== false) { win.webContents.invalidate(); await new Promise((r) => setTimeout(r, 400)); }
        if (s.shot !== false) fs.writeFileSync(path.join(dir, s.name + '.png'), (await win.webContents.capturePage()).toPNG());
      } catch (e) { log(s.name + ' failed: ' + e.message); }
    }
    quitting = true;
    app.quit();
  });
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; tracker.stop(); save(true); });
app.on('window-all-closed', () => { if (!db.settings.trayOnClose) app.quit(); });

app.whenReady().then(async () => {
  protocol.handle('ghimg', (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (!/\.(jpe?g|png|webp|gif|bmp|ico)$/i.test(p) || !fs.existsSync(p)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(p).toString());
  });
  load();
  createWindow(!process.argv.includes('--hidden'));
  createTray();
  tracker.start();
  scheduleSync();
  rescan({ api: true });
  // Look for a new version every launch (skipped in screenshot runs unless asked for)
  if (!process.env.HEARTH_SHOTS || process.env.HEARTH_UPDATE_TEST) setTimeout(() => updater.check(), 3000);
});
