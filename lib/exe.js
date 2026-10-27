// Guesses which .exe in a game folder is the game itself.
const fs = require('fs');
const path = require('path');

const JUNK = /unins|setup|install|redist|vc_?redist|directx|dxsetup|dotnet|crash|report|helper|updater|update|launcherpatcher|unitycrash|ue4prereq|prereq|easyanticheat|eac_|battleye|be_service|cleanup|config|settings|benchmark|server|7z|unrar|winrar|notification|overlay|cefprocess|webhelper|quicksfv|dxwebsetup|oalinst|physx|touchup|register/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function listExes(dir, depth = 0, out = []) {
  if (depth > 3 || out.length > 400) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(_commonredist|redist|redistributables?|directx|dotnet|vcredist|support|__installer|_redist|prereqs?|\.itch|mono|jre|java|crashpad|engine\\binaries\\thirdparty)$/i.test(e.name)) listExes(f, depth + 1, out);
    } else if (/\.exe$/i.test(e.name)) {
      let size = 0;
      try { size = fs.statSync(f).size; } catch {}
      out.push({ path: f, name: e.name, depth, size });
    }
  }
  return out;
}

function pickExe(dir, hint) {
  if (!dir) return null;
  const want = norm(hint || path.basename(dir));
  const exes = listExes(dir).filter((e) => !JUNK.test(e.name) && e.size > 50 * 1024);
  if (!exes.length) return null;
  const score = (e) => {
    const n = norm(e.name.replace(/\.exe$/i, ''));
    let s = Math.log2(e.size + 1) - e.depth * 3;
    if (want && (n === want || want.startsWith(n) || n.startsWith(want))) s += 12;
    else if (want && n.length > 2 && (want.includes(n) || n.includes(want))) s += 6;
    if (/shipping|win64|x64/i.test(e.name)) s += 2;
    if (/launcher/i.test(e.name)) s -= 1;
    return s;
  };
  return exes.sort((a, b) => score(b) - score(a))[0].path;
}

// Every sub-folder of a games folder that looks like a game, with its best exe.
function scanFolder(root) {
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$')); } catch { return []; }
  const found = [];
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    const exe = pickExe(dir, d.name);
    if (exe) found.push({ name: prettyName(d.name), dir, exe });
  }
  return found;
}

// "Hollow.Knight.v1.5-GOG" -> "Hollow Knight"
function prettyName(s) {
  return String(s)
    .replace(/[._]+/g, ' ')
    .replace(/\s*[\[(].*?[\])]\s*/g, ' ')
    .replace(/\s+-\s*(gog|fitgirl|dodi|elamigos|codex|plaza|skidrow|empress|tenoke|rune|razor1911|flt|cpy|repack|portable)\b.*$/i, '')
    .replace(/\b(v|build|update)\s?\d[\w.]*\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || s;
}

module.exports = { pickExe, scanFolder, prettyName, listExes };
