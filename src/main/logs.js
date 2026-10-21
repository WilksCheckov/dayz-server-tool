'use strict';
// Log listing, tail reading and error summarisation for the server profiles folder.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const LOG_EXT = /\.(rpt|log|adm|mdmp)$/i;

function list() {
  const p = settings.paths();
  let entries = [];
  try { entries = fs.readdirSync(p.profilesDir, { withFileTypes: true }); } catch { return { dir: p.profilesDir, files: [] }; }
  const files = entries
    .filter(e => e.isFile() && LOG_EXT.test(e.name))
    .map(e => {
      const st = fs.statSync(path.join(p.profilesDir, e.name));
      return { name: e.name, size: st.size, mtime: st.mtimeMs, kind: path.extname(e.name).slice(1).toUpperCase() };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return { dir: p.profilesDir, files };
}

function resolve(name) {
  const p = settings.paths();
  const dir = path.resolve(p.profilesDir);
  const full = path.resolve(dir, path.basename(name));
  if (!full.startsWith(dir)) throw new Error('Invalid log path');
  return full;
}

// Read up to maxBytes from the end of a file.
function read(name, maxBytes = 512 * 1024) {
  const full = resolve(name);
  const st = fs.statSync(full);
  const start = Math.max(0, st.size - maxBytes);
  const fd = fs.openSync(full, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, size: st.size, truncated: start > 0, mtime: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

const CATEGORIES = [
  { key: 'crash', label: 'Crash / fatal', re: /access violation|unhandled exception|fatal error|out of memory|freeze detected|Crash|EXCEPTION/i },
  { key: 'script-error', label: 'Script error', re: /SCRIPT\s+\(E\)|SCRIPT\s+ERROR|Can't compile|Can't find|Can't open|Can't load|NULL pointer|Null pointer|Runtime Error|\bERROR\b/i },
  { key: 'mod', label: 'Mod / PBO', re: /Missing addon|Addon .* requires|Warning Message: .*(addon|pbo|bikey|signature)|Unable to (load|open) (pbo|addon)|No entry .*CfgPatches|Cannot register|Cannot open file .*\.pbo/i },
  { key: 'network', label: 'Network / BattlEye', re: /BattlEye.*(fail|error|unable|not |kick|ban)|BEServer.*(fail|error)|Timeout|timed out|Connection refused|Server is not responding|Port already in use|bind failed|Steam.*(fail|error)/i },
  { key: 'mission', label: 'Mission / config', re: /Mission .*(fail|error|not found)|No entry|Cannot load|Cannot find|Warning Message|Invalid|missing .*cfg/i },
  { key: 'script-warning', label: 'Script warning', re: /SCRIPT\s+\(W\)|SCRIPT\s+WARNING|\bWarning\b|\bWARNING\b/i },
  { key: 'other-error', label: 'Other errors', re: /\bError\b|failed|Failed|Cannot|Unable to|not found/i }
];

const NOISE = /^(={3,}|== |Exe timestamp|Current time|Version \d|Player .*(connected|disconnected)|Mission read|Mission .*loaded|Connected to Steam|Entity .* spawned|.*Executing script.*)/i;

// Strip volatile parts so similar lines group together.
function normalize(line) {
  return line
    .replace(/^\s*\d{1,2}:\d{2}:\d{2}(\.\d+)?\s*/, '')
    .replace(/^\[?\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}[^\]]*\]?\s*/, '')
    .replace(/0x[0-9a-f]+/gi, '0x?')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\b\d{5,}\b/g, '#')
    .replace(/\b\d+(\.\d+)?\b/g, '#')
    .replace(/"[^"]{0,40}"/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function extractTime(line) {
  const m = line.match(/^\s*(\d{1,2}:\d{2}:\d{2})/) || line.match(/(\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function summarize(name, maxBytes = 20 * 1024 * 1024) {
  const { text, size, truncated } = read(name, maxBytes);
  const lines = text.split(/\r?\n/);
  const groups = new Map();
  const perCategory = {};
  let firstTime = null, lastTime = null;
  let playersConnected = 0, missionLoads = 0, modLines = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const t = extractTime(line);
    if (t) { if (!firstTime) firstTime = t; lastTime = t; }
    if (/Player .*connected/i.test(line) && !/disconnected/i.test(line)) playersConnected++;
    if (/Mission read from/i.test(line)) missionLoads++;
    if (/^(=+\s*)?(Mod|Addon)\b.*(loaded|list)|^Mod:/i.test(line) && modLines.length < 60) modLines.push(line);
    if (NOISE.test(line)) continue;
    let cat = null;
    for (const c of CATEGORIES) if (c.re.test(line)) { cat = c; break; }
    if (!cat) continue;
    perCategory[cat.key] = (perCategory[cat.key] || 0) + 1;
    const key = cat.key + '|' + normalize(line);
    const g = groups.get(key);
    if (g) { g.count++; g.lastTime = t || g.lastTime; g.last = line; }
    else groups.set(key, { category: cat.key, label: cat.label, count: 1, sample: line, last: line, firstTime: t, lastTime: t });
  }
  const sorted = [...groups.values()].sort((a, b) => {
    const order = CATEGORIES.findIndex(c => c.key === a.category) - CATEGORIES.findIndex(c => c.key === b.category);
    return order !== 0 ? order : b.count - a.count;
  });
  const totalIssues = Object.values(perCategory).reduce((a, b) => a + b, 0);
  return {
    file: name,
    size,
    truncated,
    lineCount: lines.length,
    firstTime,
    lastTime,
    totalIssues,
    perCategory: CATEGORIES.map(c => ({ key: c.key, label: c.label, count: perCategory[c.key] || 0 })).filter(c => c.count),
    groups: sorted.slice(0, 200),
    stats: { playersConnected, missionLoads },
    modLines,
    verdict: verdict(perCategory, totalIssues, lines.length)
  };
}

function verdict(per, total, lineCount) {
  if (per.crash) return { level: 'critical', text: 'Crash or fatal error detected. Check the Crash section first.' };
  if ((per['script-error'] || 0) > 50) return { level: 'bad', text: 'Many script errors. A mod is probably broken or out of date.' };
  if (per.mod) return { level: 'warn', text: 'Mod or PBO loading problems found. Verify mod order, keys and that every dependency is enabled.' };
  if (per.network) return { level: 'warn', text: 'Network or BattlEye issues found. Check the port, firewall and BattlEye folder.' };
  if (total === 0) return { level: 'ok', text: `No errors found in ${lineCount} lines.` };
  if (per['script-error']) return { level: 'warn', text: 'Some script errors found. Usually harmless unless they repeat every frame.' };
  return { level: 'ok', text: 'Only warnings. Server looks healthy.' };
}

module.exports = { list, read, summarize };
