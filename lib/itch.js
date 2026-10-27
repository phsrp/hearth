// itch.io: games installed with the itch app. The app keeps everything in butler.db (SQLite), including its own
// playtime counter; when that can't be read, each install folder still has a .itch/receipt.json.gz to go on.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pickExe } = require('./exe');

const itchRoot = () => path.join(process.env.APPDATA || '', 'itch');
const json = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s || null; } catch { return null; } };

function fromDb() {
  const dbFile = path.join(itchRoot(), 'db', 'butler.db');
  if (!fs.existsSync(dbFile)) return null;
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbFile, { readOnly: true });
    const locs = Object.fromEntries(db.prepare('SELECT * FROM install_locations').all().map((l) => [l.id, l.path]));
    const games = Object.fromEntries(db.prepare('SELECT * FROM games').all().map((g) => [g.id, g]));
    return db.prepare('SELECT * FROM caves').all().map((c) => {
      const g = games[c.game_id] || {};
      const verdict = json(c.verdict) || {};
      const base = c.custom_install_folder || verdict.basePath ||
        (locs[c.install_location_id] && [path.join(locs[c.install_location_id], c.install_folder_name || ''), path.join(locs[c.install_location_id], 'apps', c.install_folder_name || '')].find((p) => fs.existsSync(p)));
      const cand = (verdict.candidates || []).find((x) => /windows|native/i.test(x.flavor || '') && /\.exe$/i.test(x.path || '')) || (verdict.candidates || [])[0];
      const exe = base && (cand && fs.existsSync(path.join(base, cand.path)) ? path.join(base, cand.path) : pickExe(base));
      return {
        id: 'itch:' + c.game_id, source: 'itch', itchCave: c.id, name: g.title || c.install_folder_name || 'itch.io game', installed: !!base && fs.existsSync(base),
        dir: base || null, exe: exe || null, cover: g.still_cover_url || g.cover_url || null, url: g.url || null,
        sourceMinutes: Math.round((+c.seconds_run || 0) / 60), lastPlayed: c.last_touched_at ? Math.floor(Date.parse(c.last_touched_at) / 1000) || 0 : 0,
        sizeBytes: +c.installed_size || 0, kind: g.classification || null,
      };
    });
  } catch {
    return null;
  } finally {
    try { db && db.close(); } catch {}
  }
}

// Fallback: read receipts from the itch app's default folder and any extra folders the user added in Settings.
function fromReceipts(extraDirs = []) {
  const roots = [path.join(itchRoot(), 'apps'), ...extraDirs];
  const out = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      const dir = path.join(root, d.name);
      const rf = path.join(dir, '.itch', 'receipt.json.gz');
      if (!fs.existsSync(rf)) continue;
      let r;
      try { r = JSON.parse(zlib.gunzipSync(fs.readFileSync(rf)).toString('utf8')); } catch { continue; }
      const g = r.game || {};
      out.push({
        id: 'itch:' + (g.id || d.name), source: 'itch', name: g.title || d.name, installed: true, dir, exe: pickExe(dir),
        cover: g.stillCoverUrl || g.coverUrl || null, url: g.url || null, sourceMinutes: 0, lastPlayed: 0,
      });
    }
  }
  return out;
}

function scan(extraDirs) {
  const db = fromDb();
  const rec = fromReceipts(extraDirs);
  if (!db) return { found: rec.length > 0 || fs.existsSync(itchRoot()), games: rec };
  const ids = new Set(db.map((g) => g.id));
  return { found: true, games: [...db, ...rec.filter((g) => !ids.has(g.id))] };
}

module.exports = { scan };
