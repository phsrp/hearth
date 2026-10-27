// Steam: installed games come from the library folders on disk, playtime from the logged-in user's localconfig.vdf,
// and (optionally) from the Steam Web API, which also knows owned games that aren't installed.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const vdf = require('./vdf');

const STEAMID64_BASE = 76561197960265728n;
// Runtimes and redistributables that live in steamapps but aren't games
const NOT_GAMES = /^(proton|steam linux runtime|steamworks common|steamvr|steam audio|spacewar$|source sdk|dedicated server)/i;

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readVdf = (f) => { const t = readText(f); try { return t ? vdf.parse(t) : null; } catch { return null; } };

function regSteamPath() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (err, out) => {
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out || '');
      resolve(m ? path.normalize(m[1].trim()) : null);
    });
  });
}

async function findSteam() {
  const cands = [await regSteamPath(), 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  return cands.find((p) => p && fs.existsSync(path.join(p, 'steam.exe'))) || cands.find((p) => p && fs.existsSync(path.join(p, 'steamapps'))) || null;
}

// The account Steam last signed in with, as both the 64-bit id (Web API) and the 32-bit account id (userdata folder).
function currentUser(steam) {
  const users = readVdf(path.join(steam, 'config', 'loginusers.vdf'))?.users || {};
  const rank = (u) => (u.mostrecent === '1' ? 1e12 : 0) + (+u.timestamp || 0);
  const best = Object.entries(users).map(([id64, u]) => ({ id64, u })).sort((a, b) => rank(b.u) - rank(a.u))[0] || null;
  const dirs = (() => { try { return fs.readdirSync(path.join(steam, 'userdata')).filter((d) => /^\d+$/.test(d) && d !== '0'); } catch { return []; } })();
  let accountId = best ? String(BigInt(best.id64) - STEAMID64_BASE) : null;
  if (!accountId || !dirs.includes(accountId)) {
    // Fall back to whichever profile was written to most recently
    const mt = (d) => { try { return fs.statSync(path.join(steam, 'userdata', d, 'config', 'localconfig.vdf')).mtimeMs; } catch { return 0; } };
    accountId = dirs.sort((a, b) => mt(b) - mt(a))[0] || null;
  }
  const id64 = accountId ? String(BigInt(accountId) + STEAMID64_BASE) : null;
  const persona = best && best.id64 === id64 ? best.u.personaname : null;
  return { accountId, id64, persona };
}

function localPlaytime(steam, accountId) {
  const cfg = accountId && readVdf(path.join(steam, 'userdata', accountId, 'config', 'localconfig.vdf'));
  const apps = cfg?.userlocalconfigstore?.software?.valve?.steam?.apps || {};
  const out = {};
  for (const [id, a] of Object.entries(apps)) {
    if (a.playtime || a.lastplayed) out[id] = { minutes: +a.playtime || 0, twoWeeks: +a.playtime2wks || 0, lastPlayed: +a.lastplayed || 0 };
  }
  return out;
}

// Library art lives in appcache/librarycache, either flat (<id>_library_600x900.jpg) or in per-app folders with hashed subfolders.
function art(steam, appid) {
  const root = path.join(steam, 'appcache', 'librarycache');
  const res = {};
  const flat = (n) => { const f = path.join(root, `${appid}_${n}`); return fs.existsSync(f) ? f : null; };
  res.cover = flat('library_600x900.jpg');
  res.header = flat('header.jpg');
  res.hero = flat('library_hero.jpg');
  res.icon = flat('icon.jpg');
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(f, depth + 1); continue; }
      const n = e.name.toLowerCase();
      if (n === 'library_600x900.jpg' || n === 'library_capsule.jpg') res.cover ||= f;
      else if (n === 'header.jpg') res.header ||= f;
      else if (n === 'library_hero.jpg') res.hero ||= f;
      else if (/^[0-9a-f]{40}\.jpg$/.test(n) && depth === 0) res.icon ||= f;
    }
  };
  walk(path.join(root, String(appid)), 0);
  return res;
}

const cdn = (appid, file) => `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/${file}`;

async function scan() {
  const steam = await findSteam();
  if (!steam) return { found: false, games: [] };
  const lf = readVdf(path.join(steam, 'steamapps', 'libraryfolders.vdf'))?.libraryfolders || {};
  // libraryfolders.vdf has the real casing; the registry path is often all lower-case
  const libs = new Map();
  for (const p of [...Object.values(lf).map((l) => l && l.path).filter(Boolean), steam].map((x) => path.normalize(x))) if (!libs.has(p.toLowerCase())) libs.set(p.toLowerCase(), p);
  const user = currentUser(steam);
  const played = localPlaytime(steam, user.accountId);
  const games = [];
  const seen = new Set();
  for (const lib of libs.values()) {
    const sa = path.join(lib, 'steamapps');
    let files = [];
    try { files = fs.readdirSync(sa).filter((f) => /^appmanifest_\d+\.acf$/i.test(f)); } catch { continue; }
    for (const f of files) {
      const m = readVdf(path.join(sa, f))?.appstate;
      if (!m || !m.appid || seen.has(m.appid) || NOT_GAMES.test(m.name || '')) continue;
      seen.add(m.appid);
      const a = art(steam, m.appid);
      const p = played[m.appid] || {};
      games.push({
        id: 'steam:' + m.appid, source: 'steam', appid: m.appid, name: m.name || `App ${m.appid}`, installed: true,
        dir: path.join(sa, 'common', m.installdir || ''), sizeBytes: +m.sizeondisk || 0,
        cover: a.cover || cdn(m.appid, 'library_600x900.jpg'), header: a.header || cdn(m.appid, 'header.jpg'), hero: a.hero || null, icon: a.icon || null,
        sourceMinutes: p.minutes || 0, twoWeeksMinutes: p.twoWeeks || 0, lastPlayed: p.lastPlayed || +m.lastplayed || 0,
      });
    }
  }
  return { found: true, path: steam, user, played, games };
}

// Steam Web API: authoritative playtime for every owned game, including ones that aren't installed.
async function webOwned(fetch, key, id64) {
  const u = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(id64)}&include_appinfo=1&include_played_free_games=1&format=json`;
  const r = await fetch(u);
  if (r.status === 401 || r.status === 403) throw new Error('Steam rejected the Web API key.');
  if (!r.ok) throw new Error(`Steam Web API answered ${r.status}.`);
  const j = await r.json();
  if (!j.response || !j.response.games) throw new Error('No games returned. Is your Steam profile and game details visibility set to Public?');
  return j.response.games.map((g) => ({
    appid: String(g.appid), name: g.name, minutes: g.playtime_forever || 0, twoWeeks: g.playtime_2weeks || 0, lastPlayed: g.rtime_last_played || 0,
    iconUrl: g.img_icon_url ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg` : null,
  }));
}

module.exports = { scan, webOwned, art, cdn, findSteam, localPlaytime, currentUser };
