'use strict';
// Minimal parser for Valve's KeyValues / .acf text format.
function parse(text) {
  const tokens = [];
  const re = /"((?:\\.|[^"\\])*)"|(\{)|(\})/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) tokens.push({ t: 's', v: m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') });
    else if (m[2]) tokens.push({ t: '{' });
    else tokens.push({ t: '}' });
  }
  let i = 0;
  function obj() {
    const out = {};
    while (i < tokens.length) {
      const tok = tokens[i++];
      if (tok.t === '}') return out;
      if (tok.t !== 's') continue;
      const key = tok.v;
      const next = tokens[i++];
      if (!next) break;
      if (next.t === '{') out[key] = obj();
      else if (next.t === 's') out[key] = next.v;
    }
    return out;
  }
  return obj();
}

module.exports = { parse };
