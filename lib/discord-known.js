// Works out whether Discord already shows a game by itself, so Hearth doesn't add a second status for it:
// either Discord detects the game's exe (its public "detectable" list), or the game ships Discord's own SDK
// and sets its own Rich Presence.
const fs = require('fs');
const path = require('path');

const LIST_URL = 'https://discord.com/api/v9/applications/detectable';
const MAX_AGE = 7 * 24 * 3600 * 1000;
const SDK = /^(discord_game_sdk|discord_partner_sdk|discord_social_sdk|discord-rpc|discord_rpc|discordrpc|discord-game-sdk)(_x86|_x64)?\.dll$/i;

class DiscordKnown {
  constructor(cacheFile, fetch) {
    this.cacheFile = cacheFile;
    this.fetch = fetch;
    this.exes = null; // Set of "name.exe" and "folder/name.exe", lower-case
    this.sdkCache = new Map();
    this.loading = null;
  }

  // Loads the cached list, refreshing it from Discord once a week.
  load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let cached = null;
      try { cached = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')); } catch {}
      if (cached?.exes) this.exes = new Set(cached.exes);
      if (cached && Date.now() - cached.at < MAX_AGE) return;
      try {
        const r = await this.fetch(LIST_URL);
        if (!r.ok) return;
        const apps = await r.json();
        const exes = [];
        for (const a of apps) for (const e of a.executables || []) if (e.os === 'win32' && e.name && !e.is_launcher) exes.push(e.name.toLowerCase().replace(/\\/g, '/'));
        this.exes = new Set(exes);
        fs.writeFileSync(this.cacheFile, JSON.stringify({ at: Date.now(), exes }));
      } catch {}
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  // Discord matches either the bare exe name or "parent folder/exe name".
  detects(procPath) {
    if (!this.exes) return false;
    const parts = procPath.toLowerCase().replace(/\\/g, '/').split('/');
    const exe = parts[parts.length - 1];
    const withDir = parts.slice(-2).join('/');
    return this.exes.has(exe) || this.exes.has(withDir);
  }

  hasSdk(dir) {
    if (!dir) return false;
    const key = dir.toLowerCase();
    if (this.sdkCache.has(key)) return this.sdkCache.get(key);
    let seen = 0;
    const walk = (d, depth) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
      for (const e of ents) {
        if (++seen > 4000) return false;
        if (e.isFile() && SDK.test(e.name)) return true;
      }
      if (depth >= 4) return false;
      return ents.some((e) => e.isDirectory() && !/^(\.|_commonredist|redist|logs?|cache|shadercache|movies|videos|sounds?|audio|localization)$/i.test(e.name) && walk(path.join(d, e.name), depth + 1));
    };
    const found = walk(dir, 0);
    this.sdkCache.set(key, found);
    return found;
  }

  // Why Discord already covers this game, or null when Hearth should show it.
  reason(dir, procPaths) {
    if (procPaths.some((p) => this.detects(p))) return 'detected';
    if (this.hasSdk(dir)) return 'sdk';
    return null;
  }
}

module.exports = { DiscordKnown };
