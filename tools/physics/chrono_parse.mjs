// Chrono's JSON parser (RapidJSON) accepts // comments and trailing commas; this strips both without touching strings.
/** Chrono's parser (RapidJSON) accepts // comments and trailing commas: strip both without touching strings. */
export function parseChrono(text) {
  let out = '', str = false, esc = false, i = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (str) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; i++; continue; }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, '$1'));
}

