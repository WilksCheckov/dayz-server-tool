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

// ---------- log cleanup ----------
// What gets cleaned is configurable: the server's own logs by kind, and log folders in the profiles folder (vanilla
// ones like EventManagerLog and those mods create). Only files matching a rule's pattern are ever deleted, and the
// newest file of each rule is always kept, so a mod's current log is never removed while it writes to it.
const KINDS = [
  { key: 'rpt', label: 'Server reports (.RPT)', test: n => /\.rpt$/i.test(n) },
  { key: 'adm', label: 'Admin logs (.ADM)', test: n => /\.adm$/i.test(n) },
  { key: 'script', label: 'Script logs (script_*.log)', test: n => /^script.*\.log$/i.test(n) },
  { key: 'error', label: 'Error logs (error_*.log)', test: n => /^error.*\.log$/i.test(n) },
  { key: 'crash', label: 'Crash logs and dumps (crash_*.log, .mdmp)', test: n => /^crash.*\.log$/i.test(n) || /\.mdmp$/i.test(n) },
  { key: 'other', label: 'Other .log files in the profiles folder', test: n => /\.log$/i.test(n) && !/^(script|error|crash)/i.test(n) }
];
// Folders that hold data, not logs: never offered. DayZAdminTools holds the gear, dupe and command files this tool reads.
const PROTECTED_DIRS = /^(DayZAdminTools|BattlEye|DataCache|Users|storage_\d+)$/i;
// Patterns that could match settings or persistence are refused.
const UNSAFE_PATTERN = /^\*(\.\*)?$|\.(json|xml|cfg|cpp|c|bin|db|pbo|bikey|dll|exe|ini|bak)$/i;

function globToRe(glob) { return new RegExp('^' + glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'); }
function patterns(str) { return String(str || '').split(/[;,\s]+/).map(x => x.trim()).filter(Boolean).filter(x => !UNSAFE_PATTERN.test(x) && !/[\\/]/.test(x)); }

function cleanupCfg() {
  const s = settings.load(); const c = s.logCleanup || {};
  const kinds = {}; for (const k of KINDS) kinds[k.key] = { on: true, days: null, ...((c.kinds || {})[k.key] || {}) };
  return { enabled: !!c.enabled, keepDays: Number(c.keepDays) || 14, kinds, folders: c.folders || {} };
}

// Log folders under profiles (two levels: some mods write to <Mod>/Logs). Folders with "log" in the name are cleaned
// by default; others (mods often keep settings next to their logs) only when ticked.
function logFolders(cfg = cleanupCfg()) {
  const root = settings.paths().profilesDir; const out = [];
  const visit = (rel, depth) => {
    let es = []; try { es = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (!e.isDirectory()) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (depth === 0 && PROTECTED_DIRS.test(e.name)) continue;
      let files = []; try { files = fs.readdirSync(path.join(root, r), { withFileTypes: true }).filter(f => f.isFile()).map(f => f.name); } catch { /* unreadable */ }
      const logish = /log/i.test(e.name);
      const hasLogs = files.some(f => /\.(log|txt|rpt|adm)$/i.test(f));
      if (logish || hasLogs || cfg.folders[r]) {
        const saved = cfg.folders[r] || {};
        const pattern = saved.pattern !== undefined ? saved.pattern : (logish ? '*.log;*.txt' : '*.log');
        out.push({ folder: r, on: saved.on !== undefined ? !!saved.on : logish, days: saved.days || null, pattern, suggested: logish, exists: true });
      }
      if (depth < 1) visit(r, depth + 1);
    }
  };
  visit('', 0);
  for (const [r, v] of Object.entries(cfg.folders)) if (!out.some(o => o.folder === r)) out.push({ folder: r, on: !!v.on, days: v.days || null, pattern: v.pattern || '*.log', exists: false });
  return out;
}

// Every rule with the files it covers and which of them are past their age.
function cleanupPlan(opts = {}) {
  const cfg = cleanupCfg();
  const def = Number(opts.keepDays) || cfg.keepDays;
  const root = settings.paths().profilesDir;
  const statAll = (dir, names) => names.map(n => { try { const st = fs.statSync(path.join(dir, n)); return st.isFile() ? { name: n, full: path.join(dir, n), size: st.size, mtime: st.mtimeMs } : null; } catch { return null; } }).filter(Boolean);
  let rootFiles = []; try { rootFiles = statAll(root, fs.readdirSync(root)); } catch { /* no profiles yet */ }
  const rules = [];
  const add = (r, files) => {
    const days = Number(r.ownDays) || def; const cutoff = Date.now() - days * 86400000;
    const newest = files.reduce((m, f) => (!m || f.mtime > m.mtime ? f : m), null);
    const old = files.filter(f => f.mtime < cutoff && f !== newest);
    rules.push({ ...r, days, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), old: old.length, oldBytes: old.reduce((n, f) => n + f.size, 0), _old: old });
  };
  for (const k of KINDS) { const c = cfg.kinds[k.key]; add({ type: 'kind', key: k.key, label: k.label, on: c.on !== false, ownDays: c.days || null }, rootFiles.filter(f => k.test(f.name))); }
  for (const f of logFolders(cfg)) {
    const res = patterns(f.pattern).map(globToRe);
    let files = []; try { files = statAll(path.join(root, f.folder), fs.readdirSync(path.join(root, f.folder))).filter(x => res.some(re => re.test(x.name))); } catch { /* gone */ }
    add({ type: 'folder', key: f.folder, label: f.folder, on: f.on, ownDays: f.days, pattern: f.pattern, suggested: f.suggested, exists: f.exists }, files);
  }
  return { keepDays: def, enabled: cfg.enabled, rules };
}

function cleanup(opts = {}) {
  const plan = cleanupPlan(opts);
  let removed = 0, bytes = 0; const perRule = [];
  for (const r of plan.rules) {
    if (!r.on) continue;
    let n = 0;
    for (const f of r._old) { try { fs.unlinkSync(f.full); removed++; n++; bytes += f.size; } catch { /* in use */ } }
    if (n) perRule.push(`${r.label} ${n}`);
  }
  return { removed, bytes, keepDays: plan.keepDays, perRule };
}
// for the settings dialog: no file lists
function cleanupPreview(opts) { const p = cleanupPlan(opts); return { ...p, rules: p.rules.map(({ _old, ...r }) => r) }; }
function saveCleanupCfg(c) {
  const folders = {};
  for (const [k, v] of Object.entries(c.folders || {})) { if (/(^|[\\/])\.\.([\\/]|$)/.test(k) || path.isAbsolute(k)) continue; folders[k] = { on: !!v.on, days: Number(v.days) || null, pattern: patterns(v.pattern).join(';') || '*.log' }; }
  const kinds = {}; for (const k of KINDS) { const v = (c.kinds || {})[k.key] || {}; kinds[k.key] = { on: v.on !== false, days: Number(v.days) || null }; }
  settings.save({ logCleanup: { enabled: !!c.enabled, keepDays: Number(c.keepDays) || 14, kinds, folders } });
  return cleanupPreview();
}
function cleanupIfEnabled(emit) { const c = cleanupCfg(); if (!c.enabled) return null; try { const r = cleanup(); if (r.removed && emit) emit('console', { source: 'logs', line: `Log cleanup: removed ${r.removed} file(s), ${(r.bytes / 1048576).toFixed(1)} MB (${r.perRule.join(', ')})` }); return r; } catch { return null; } }

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

module.exports = { list, read, summarize, cleanup, cleanupIfEnabled, cleanupCfg, cleanupPreview, saveCleanupCfg };
