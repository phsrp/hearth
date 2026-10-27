// Tiny parser for Valve's text KeyValues format (.vdf / .acf). Keys are lower-cased so lookups don't care about Steam's casing.
function parse(text) {
  let i = 0;
  const n = text.length;
  const skip = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      break;
    }
  };
  const str = () => {
    if (text[i] === '"') {
      let s = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) { const c = text[++i]; s += c === 'n' ? '\n' : c === 't' ? '\t' : c; } else s += text[i];
        i++;
      }
      i++;
      return s;
    }
    const st = i;
    while (i < n && !/[\s{}"]/.test(text[i])) i++;
    return text.slice(st, i);
  };
  const obj = () => {
    const o = {};
    for (;;) {
      skip();
      if (i >= n) return o;
      if (text[i] === '}') { i++; return o; }
      const k = str().toLowerCase();
      skip();
      if (text[i] === '{') { i++; o[k] = obj(); } else o[k] = str();
      // Conditionals like [$WIN32] trail some values
      skip();
      if (text[i] === '[') { while (i < n && text[i] !== ']') i++; i++; }
    }
  };
  return obj();
}

module.exports = { parse };
