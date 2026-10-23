'use strict';
// The tool's own JSON data files (death log, players, statistics, registry …). Three rules so data is never lost
// quietly:
//  - a write goes to a temp file first and is then renamed over the old one, so a crash or power cut mid-write
//    leaves the previous version, not half a file
//  - a file that exists but cannot be parsed is kept aside as <name>.corrupt-<time> and reported, instead of being
//    treated as "no data yet" and overwritten by the next save
//  - a failed write is reported (once per file every 10 minutes), since the data otherwise only lives in memory
const fs = require('fs');
const path = require('path');

let emitRef = () => {};
const lastWarn = {};
function warn(file, line) {
  const now = Date.now();
  if (lastWarn[file] && now - lastWarn[file] < 600000) return;
  lastWarn[file] = now;
  emitRef('console', { source: 'data', line });
  try { require('./alerts').alert('tool-problem', 'Tool data problem', line); } catch { /* alerts not ready */ }
}

// The parsed file, or null when it does not exist yet. A file that cannot be read for another reason throws, so a
// caller never mistakes "unreadable" for "empty" and writes an empty file over it.
function read(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; warn(file, `Could not read ${path.basename(file)}: ${e.message}`); throw e; }
  try { return JSON.parse(text); }
  catch (e) {
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.renameSync(file, aside); } catch { /* keep going: at least it is reported */ }
    warn(file, `${path.basename(file)} was damaged (${e.message}); kept it as ${path.basename(aside)} and started a new one.`);
    return null;
  }
}
// Like read, for callers that must go on: an unreadable file gives the fallback (and is reported by read).
// The data then lives in memory only: saves to that file are refused, so the unreadable original is not replaced by it.
const blocked = new Set();
function readOr(file, fallback) { try { const v = read(file); return v === null ? fallback : v; } catch { blocked.add(file); return fallback; } }

function write(file, data, pretty = false) {
  if (blocked.has(file)) { warn(file, `Not saving ${path.basename(file)}: it could not be read at start, so saving would replace its contents. Restart the tool once whatever locks it is closed.`); return false; }
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    warn(file, `Could not save ${path.basename(file)}: ${e.message}. The data is kept in memory until the tool closes; free disk space or close what locks the file.`);
    return false;
  }
}

function init(emit) { emitRef = emit; }

module.exports = { init, read, readOr, write };
