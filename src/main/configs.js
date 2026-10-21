'use strict';
// Config file browser, read/write, and validation ("debug") for DayZ server configs.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { XMLValidator, XMLParser } = require('fast-xml-parser');

const TEXT_EXT = /\.(cfg|xml|json|c|txt|ini|csv)$/i;
const MAX_FILES = 600;

// ---------- paths ----------
function roots() {
  const s = settings.load();
  const p = settings.paths(s);
  return { s, p, allowed: [path.resolve(p.serverDir), path.resolve(p.profilesDir), path.resolve(path.dirname(p.configPath))] };
}

function safeAbs(file) {
  const { allowed } = roots();
  const abs = path.resolve(file);
  if (!allowed.some(a => abs === a || abs.startsWith(a + path.sep))) throw new Error('File is outside the server folder.');
  return abs;
}

function exists(f) { try { fs.accessSync(f); return true; } catch { return false; } }

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xml') return 'xml';
  if (ext === '.json') return 'json';
  if (ext === '.c') return 'c';
  return 'cfg';
}

// Mission template name from serverDZ.cfg (class Missions { class DayZ { template = "..."; }; };)
function missionName(cfgText) {
  const m = cfgText && cfgText.match(/template\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function readCfgText() {
  const { p } = roots();
  try { return fs.readFileSync(p.configPath, 'utf8'); } catch { return ''; }
}

function missionDir() {
  const { p } = roots();
  const name = missionName(readCfgText());
  return name ? path.join(p.serverDir, 'mpmissions', name) : null;
}

function walk(dir, depth, out, rel = '') {
  if (depth > 4 || out.length >= MAX_FILES) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? 1 : -1));
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!/^(storage_\d+|\.git)$/i.test(e.name)) walk(full, depth + 1, out, r); }
    else if (TEXT_EXT.test(e.name)) {
      let size = 0; try { size = fs.statSync(full).size; } catch { /* ignore */ }
      out.push({ name: r, abs: full, kind: kindOf(e.name), size });
    }
  }
}

function listFiles() {
  const { p } = roots();
  const groups = [];
  const server = [];
  if (exists(p.configPath)) server.push({ name: path.basename(p.configPath), abs: p.configPath, kind: 'cfg', size: fs.statSync(p.configPath).size });
  for (const extra of ['serverDZ.cfg', 'cfgGameplay.json']) {
    const f = path.join(p.serverDir, extra);
    if (exists(f) && f !== p.configPath) server.push({ name: extra, abs: f, kind: kindOf(f), size: fs.statSync(f).size });
  }
  groups.push({ group: 'Server', files: server });
  const be = path.join(p.serverDir, 'battleye');
  if (exists(be)) { const files = []; walk(be, 3, files); groups.push({ group: 'BattlEye', files }); }
  const md = missionDir();
  if (md && exists(md)) { const files = []; walk(md, 0, files); groups.push({ group: `Mission: ${path.basename(md)}`, files, dir: md }); }
  else if (md) groups.push({ group: `Mission: ${path.basename(md)} (folder missing)`, files: [], dir: md });
  // Other missions, listed shallow so users can inspect them.
  const mp = path.join(p.serverDir, 'mpmissions');
  try {
    for (const e of fs.readdirSync(mp, { withFileTypes: true })) {
      if (!e.isDirectory() || (md && path.join(mp, e.name) === md)) continue;
      const files = []; walk(path.join(mp, e.name), 2, files);
      if (files.length) groups.push({ group: `Other mission: ${e.name}`, files, dir: path.join(mp, e.name), collapsed: true });
    }
  } catch { /* no mpmissions */ }
  return { groups, serverDir: p.serverDir, missionDir: md };
}

function read(file) {
  const abs = safeAbs(file);
  return { abs, text: fs.readFileSync(abs, 'utf8'), kind: kindOf(abs), mtime: fs.statSync(abs).mtimeMs };
}

function write(file, text) {
  const abs = safeAbs(file);
  // Keep one .bak of the previous version next to the file.
  try { if (exists(abs)) fs.copyFileSync(abs, abs + '.bak'); } catch { /* ignore */ }
  fs.writeFileSync(abs, text, 'utf8');
  return { abs, mtime: fs.statSync(abs).mtimeMs };
}

function createFile(file, text = '') {
  const abs = safeAbs(file);
  if (exists(abs)) throw new Error('File already exists.');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return abs;
}

// ---------- helpers for problems ----------
function P(list, severity, line, message, col = 1) { list.push({ severity, line: Math.max(1, line | 0), col, message }); }
function lineAt(text, index) { let n = 1; for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; }
function lineOfMatch(text, re, from = 0) { re.lastIndex = from; const m = re.exec(text); return m ? lineAt(text, m.index) : 1; }
function num(v) { return v === undefined || v === null || v === '' ? NaN : Number(v); }

// ---------- serverDZ.cfg ----------
const CFG_KEYS = {
  hostname: 'string', password: 'string', passwordAdmin: 'string', enableWhitelist: 'bool', maxPlayers: 'int:1:127',
  verifySignatures: 'int:0:2', forceSameBuild: 'bool', disableVoN: 'bool', vonCodecQuality: 'int:0:30', disable3rdPerson: 'bool',
  disableCrosshair: 'bool', serverTime: 'string', serverTimeAcceleration: 'num:0:24', serverNightTimeAcceleration: 'num:0:64',
  serverTimePersistent: 'bool', guaranteedUpdates: 'int', loginQueueConcurrentPlayers: 'int', loginQueueMaxPlayers: 'int',
  instanceId: 'int', storageAutoFix: 'bool', steamQueryPort: 'int:1:65535', respawnTime: 'int', timeStampFormat: 'string',
  logAverageFps: 'int', logMemory: 'int', logPlayers: 'int', logFile: 'string', adminLogPlayerHitsOnly: 'bool', adminLogPlacement: 'bool',
  adminLogBuildActions: 'bool', adminLogPlayerList: 'bool', disableMultiAccountMitigation: 'bool', enableDebugMonitor: 'bool',
  allowFilePatching: 'bool', simulatedPlayersBatch: 'int', multithreadedReplication: 'bool', speedhackDetection: 'int',
  networkRangeClose: 'int', networkRangeNear: 'int', networkRangeFar: 'int', networkRangeDistantEffect: 'int', networkObjectBatchLogSlow: 'int',
  networkObjectBatchEnforceBandwidthLimits: 'bool', networkObjectBatchUseEstimatedBandwidth: 'bool', networkObjectBatchUseDynamicMaximumBandwidth: 'bool',
  networkObjectBatchBandwidthLimit: 'int', networkObjectBatchCompute: 'int', networkObjectBatchSendCreate: 'int', networkObjectBatchSendDelete: 'int',
  defaultVisibility: 'int', defaultObjectViewDistance: 'int', lightingConfig: 'int:0:1', disablePersonalLight: 'bool', disableBaseDamage: 'bool',
  disableContainerDamage: 'bool', disableRespawnDialog: 'bool', pingWarning: 'int', pingCritical: 'int', MaxPing: 'int', serverFpsWarning: 'int',
  shardId: 'string', lootHistory: 'int', storeHouseStateDisabled: 'bool', enableCfgGameplayFile: 'bool', motdInterval: 'int', motd: 'array',
  template: 'string', clientPort: 'int', BattlEye: 'bool', vppDisablePassword: 'bool', disableBanlist: 'bool', disablePrioritylist: 'bool',
  autoRespawn: 'bool', respawnTimeDefault: 'int'
};
const CFG_REQUIRED = ['hostname', 'maxPlayers', 'verifySignatures', 'instanceId'];

function stripComments(text) {
  // Replace comments with spaces so indexes stay the same.
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') { while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

function validateCfg(text, abs) {
  const problems = [];
  const src = stripComments(text);
  // Unterminated strings per line
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const noComment = l.replace(/\/\/.*$/, '');
    const quotes = (noComment.match(/(?<!\\)"/g) || []).length;
    if (quotes % 2) P(problems, 'error', i + 1, 'Unterminated string (odd number of quotes).');
  });
  // Brace balance
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth < 0) { P(problems, 'error', lineAt(src, i), 'Unexpected closing brace.'); depth = 0; } }
  }
  if (depth > 0) P(problems, 'error', lines.length, `${depth} unclosed brace(s).`);
  // Statements
  const seen = {};
  const stmtRe = /([A-Za-z_][A-Za-z0-9_]*)\s*(\[\])?\s*=\s*([^;{}]*?|\{[^}]*\})\s*;/g;
  let m;
  while ((m = stmtRe.exec(src))) {
    const key = m[1], isArr = !!m[2], raw = m[3].trim(), line = lineAt(src, m.index);
    if (seen[key] !== undefined) P(problems, 'warning', line, `Duplicate key "${key}" (first on line ${seen[key]}); the last one wins.`);
    seen[key] = line;
    const spec = CFG_KEYS[key];
    if (!spec) { P(problems, 'warning', line, `Unknown setting "${key}". The server ignores keys it does not know.`); continue; }
    if (spec === 'array') { if (!isArr || !raw.startsWith('{')) P(problems, 'error', line, `"${key}" must be an array: ${key}[] = { "a", "b" };`); continue; }
    if (isArr) { P(problems, 'error', line, `"${key}" is not an array setting.`); continue; }
    const [type, lo, hi] = spec.split(':');
    const isStr = /^".*"$/s.test(raw);
    if (type === 'string' && !isStr) P(problems, 'error', line, `"${key}" must be a quoted string.`);
    if ((type === 'bool' || type === 'int' || type === 'num') && isStr) P(problems, 'error', line, `"${key}" must be a number, not a quoted string.`);
    if (type === 'bool' && !isStr && !/^[01]$/.test(raw)) P(problems, 'error', line, `"${key}" must be 0 or 1.`);
    if ((type === 'int' || type === 'num') && !isStr) {
      const v = Number(raw);
      if (!Number.isFinite(v) || (type === 'int' && !Number.isInteger(v))) P(problems, 'error', line, `"${key}" must be a${type === 'int' ? 'n integer' : ' number'}.`);
      else if (lo !== undefined && (v < Number(lo) || v > Number(hi))) P(problems, 'error', line, `"${key}" must be between ${lo} and ${hi}.`);
    }
    if (key === 'verifySignatures' && raw !== '2') P(problems, 'warning', line, 'verifySignatures should be 2; anything else is unsupported on modern DayZ.');
    if (key === 'serverTime' && isStr && raw !== '"SystemTime"' && !/^"\d{4}\/\d{1,2}\/\d{1,2}\/\d{1,2}\/\d{1,2}"$/.test(raw)) P(problems, 'error', line, 'serverTime must be "SystemTime" or "YYYY/MM/DD/HH/MM".');
    if (key === 'timeStampFormat' && isStr && !/^"(Short|Full)"$/.test(raw)) P(problems, 'warning', line, 'timeStampFormat is usually "Short" or "Full".');
    if (key === 'hostname' && raw === '""') P(problems, 'warning', line, 'hostname is empty.');
    if (key === 'passwordAdmin' && raw === '""') P(problems, 'warning', line, 'passwordAdmin is empty, so #login will not work.');
  }
  // Missing semicolons: a line that looks like key = value but has no ';' and is not a block opener
  lines.forEach((l, i) => {
    const t = l.replace(/\/\/.*$/, '').trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*(\[\])?\s*=\s*[^{]*[^;{\s]\s*$/.test(t) && !t.endsWith(',')) P(problems, 'error', i + 1, 'Missing semicolon at end of statement.');
    if (/^\}\s*$/.test(t)) P(problems, 'error', i + 1, 'Closing brace of a class must be followed by a semicolon: };');
  });
  for (const k of CFG_REQUIRED) if (seen[k] === undefined) P(problems, 'warning', 1, `"${k}" is not set.`);
  if (!/class\s+Missions\s*\{\s*class\s+DayZ\s*\{\s*template\s*=\s*"[^"]+"\s*;\s*\}\s*;\s*\}\s*;/.test(src)) {
    if (seen.template === undefined) P(problems, 'error', lines.length, 'No mission template. Expected: class Missions { class DayZ { template = "dayzOffline.chernarusplus"; }; };');
    else P(problems, 'warning', seen.template, 'template should live inside class Missions { class DayZ { ... }; };');
  }
  const tmpl = missionName(text);
  if (tmpl) {
    const { p } = roots();
    if (!exists(path.join(p.serverDir, 'mpmissions', tmpl))) P(problems, 'error', seen.template || 1, `Mission folder mpmissions\\${tmpl} does not exist.`);
  }
  if (seen.enableCfgGameplayFile !== undefined) {
    const md = missionDir();
    if (md && !exists(path.join(md, 'cfggameplay.json'))) P(problems, 'warning', seen.enableCfgGameplayFile, 'enableCfgGameplayFile is set but the mission has no cfggameplay.json.');
  }
  return problems;
}

// ---------- BattlEye ----------
function validateBeCfg(text) {
  const problems = [];
  const lines = text.split('\n');
  let hasPass = false, hasPort = false;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t || t.startsWith('//')) return;
    const m = t.match(/^(\w+)\s+(.*)$/);
    if (!m) { P(problems, 'error', i + 1, 'Expected "Setting value".'); return; }
    if (/^RConPassword$/i.test(m[1])) { hasPass = true; if (m[2].length < 4) P(problems, 'warning', i + 1, 'RCon password is very short.'); }
    if (/^RConPort$/i.test(m[1])) { hasPort = true; if (!/^\d+$/.test(m[2])) P(problems, 'error', i + 1, 'RConPort must be a number.'); }
    if (/^RestrictRCon$/i.test(m[1]) && !/^[01]$/.test(m[2])) P(problems, 'error', i + 1, 'RestrictRCon must be 0 or 1.');
  });
  if (!hasPass) P(problems, 'warning', 1, 'No RConPassword set; RCon tools will not connect.');
  if (!hasPort) P(problems, 'info', 1, 'No RConPort set; BattlEye uses the default (game port + 2).');
  return problems;
}

// ---------- XML ----------
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', allowBooleanAttributes: true, parseTagValue: false, parseAttributeValue: false, trimValues: true, isArray: (name) => ['type', 'event', 'child', 'item', 'attachments', 'cargo', 'file', 'ce', 'message', 'usage', 'value', 'category', 'tag', 'flags', 'var', 'spawn', 'pos', 'zone', 'rootclass', 'default', 'player', 'group'].includes(name) });

function xmlSyntax(text, problems) {
  const r = XMLValidator.validate(text, { allowBooleanAttributes: true });
  if (r !== true) { P(problems, 'error', r.err.line, `XML syntax: ${r.err.msg}`, r.err.col); return null; }
  try { return xmlParser.parse(text); } catch (e) { P(problems, 'error', 1, `XML parse: ${e.message}`); return null; }
}

function arr(x) { return x === undefined ? [] : Array.isArray(x) ? x : [x]; }
function attr(o, n) { return o && o['@_' + n]; }
function nameLine(text, name, from = 0) { return lineOfMatch(text, new RegExp(`name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'), from); }

function loadLimits(md) {
  const out = { categories: null, usages: null, values: null, tags: null };
  try {
    const doc = xmlParser.parse(fs.readFileSync(path.join(md, 'cfglimitsdefinition.xml'), 'utf8'));
    const l = doc.lists || {};
    out.categories = new Set(arr(l.categories && l.categories.category).map(c => attr(c, 'name')));
    out.usages = new Set(arr(l.usageflags && l.usageflags.usage).map(c => attr(c, 'name')));
    out.values = new Set(arr(l.valueflags && l.valueflags.value).map(c => attr(c, 'name')));
    out.tags = new Set(arr(l.tags && l.tags.tag).map(c => attr(c, 'name')));
  } catch { /* no limits file */ }
  return out;
}

// All type names across db/types.xml and every types file registered in cfgeconomycore.xml.
function loadTypeNames(md) {
  const names = new Set();
  const files = [path.join(md, 'db', 'types.xml')];
  try {
    const core = xmlParser.parse(fs.readFileSync(path.join(md, 'cfgeconomycore.xml'), 'utf8'));
    for (const ce of arr(core.economycore && core.economycore.ce)) {
      for (const f of arr(ce.file)) if (attr(f, 'type') === 'types') files.push(path.join(md, attr(ce, 'folder') || '', attr(f, 'name') || ''));
    }
  } catch { /* ignore */ }
  for (const f of files) {
    try {
      const doc = xmlParser.parse(fs.readFileSync(f, 'utf8'));
      for (const t of arr(doc.types && doc.types.type)) if (attr(t, 'name')) names.add(attr(t, 'name'));
    } catch { /* ignore */ }
  }
  return names;
}

function loadEventNames(md) {
  const names = new Set();
  try {
    const doc = xmlParser.parse(fs.readFileSync(path.join(md, 'db', 'events.xml'), 'utf8'));
    for (const e of arr(doc.events && doc.events.event)) if (attr(e, 'name')) names.add(attr(e, 'name'));
  } catch { /* ignore */ }
  return names;
}

function validateTypes(doc, text, problems, md) {
  const types = arr(doc.types && doc.types.type);
  if (!doc.types) { P(problems, 'error', 1, 'Root element must be <types>.'); return; }
  const limits = md ? loadLimits(md) : {};
  const seen = new Map();
  let pos = 0;
  for (const t of types) {
    const name = attr(t, 'name');
    const line = name ? nameLine(text, name, pos) : 1;
    if (name) pos = Math.max(pos, text.indexOf(`name="${name}"`, pos) + 1);
    if (!name) { P(problems, 'error', line, '<type> without a name attribute.'); continue; }
    if (seen.has(name)) P(problems, 'warning', line, `Duplicate type "${name}" (also on line ${seen.get(name)}).`);
    seen.set(name, line);
    const nominal = num(t.nominal), min = num(t.min), lifetime = num(t.lifetime), restock = num(t.restock);
    const qmin = num(t.quantmin), qmax = num(t.quantmax), cost = num(t.cost);
    if (Number.isNaN(nominal)) P(problems, 'error', line, `${name}: missing <nominal>.`);
    if (Number.isNaN(min)) P(problems, 'error', line, `${name}: missing <min>.`);
    if (Number.isNaN(lifetime)) P(problems, 'error', line, `${name}: missing <lifetime>.`);
    if (Number.isNaN(restock)) P(problems, 'warning', line, `${name}: missing <restock>.`);
    if (!Number.isNaN(nominal) && !Number.isNaN(min) && min > nominal) P(problems, 'error', line, `${name}: min (${min}) is greater than nominal (${nominal}).`);
    if (!Number.isNaN(nominal) && nominal < 0) P(problems, 'error', line, `${name}: nominal cannot be negative.`);
    if (!Number.isNaN(lifetime) && lifetime <= 0) P(problems, 'warning', line, `${name}: lifetime ${lifetime} means items despawn immediately.`);
    if (!Number.isNaN(qmin) && !Number.isNaN(qmax)) {
      const ok = (qmin === -1 && qmax === -1) || (qmin >= 0 && qmax <= 100 && qmin <= qmax);
      if (!ok) P(problems, 'error', line, `${name}: quantmin/quantmax must both be -1, or 0..100 with quantmin <= quantmax.`);
    }
    if (!Number.isNaN(cost) && cost < 0) P(problems, 'warning', line, `${name}: negative cost.`);
    const flags = arr(t.flags)[0];
    if (!flags) P(problems, 'warning', line, `${name}: missing <flags>.`);
    else for (const f of ['count_in_cargo', 'count_in_hoarder', 'count_in_map', 'count_in_player', 'crafted', 'deloot']) {
      const v = attr(flags, f); if (v !== undefined && !/^[01]$/.test(v)) P(problems, 'error', line, `${name}: flag ${f} must be 0 or 1.`);
    }
    if (limits.categories) {
      for (const c of arr(t.category)) if (attr(c, 'name') && !limits.categories.has(attr(c, 'name'))) P(problems, 'error', line, `${name}: category "${attr(c, 'name')}" is not defined in cfglimitsdefinition.xml.`);
      for (const u of arr(t.usage)) if (attr(u, 'name') && !limits.usages.has(attr(u, 'name'))) P(problems, 'error', line, `${name}: usage "${attr(u, 'name')}" is not defined in cfglimitsdefinition.xml.`);
      for (const v of arr(t.value)) if (attr(v, 'name') && !limits.values.has(attr(v, 'name'))) P(problems, 'error', line, `${name}: value "${attr(v, 'name')}" is not defined in cfglimitsdefinition.xml.`);
      for (const g of arr(t.tag)) if (attr(g, 'name') && !limits.tags.has(attr(g, 'name'))) P(problems, 'error', line, `${name}: tag "${attr(g, 'name')}" is not defined in cfglimitsdefinition.xml.`);
    }
    if (!Number.isNaN(nominal) && nominal > 0 && !arr(t.usage).length && !arr(t.tag).length && !arr(t.category).length && !(flags && attr(flags, 'crafted') === '1')) {
      P(problems, 'info', line, `${name}: nominal > 0 but no <usage>, <tag> or <category>, so the CE has nowhere to spawn it.`);
    }
  }
}

function validateEvents(doc, text, problems, md) {
  if (!doc.events) { P(problems, 'error', 1, 'Root element must be <events>.'); return; }
  const typeNames = md ? loadTypeNames(md) : null;
  const seen = new Set();
  let pos = 0;
  for (const e of arr(doc.events.event)) {
    const name = attr(e, 'name');
    const line = name ? nameLine(text, name, pos) : 1;
    if (name) pos = Math.max(pos, text.indexOf(`name="${name}"`, pos) + 1);
    if (!name) { P(problems, 'error', line, '<event> without a name.'); continue; }
    if (seen.has(name)) P(problems, 'warning', line, `Duplicate event "${name}".`);
    seen.add(name);
    if (!/^(Static|Vehicle|Animal|Infected|Loot|Ambient|Item|Trajectory)/.test(name)) P(problems, 'warning', line, `${name}: event names must start with a known prefix (Static, Vehicle, Animal, Infected, Loot, Ambient, Item, Trajectory).`);
    const nominal = num(e.nominal), min = num(e.min), max = num(e.max);
    if ([nominal, min, max].some(Number.isNaN)) P(problems, 'error', line, `${name}: nominal, min and max are required.`);
    else if (min > max || nominal > max || min > nominal) P(problems, 'error', line, `${name}: expected min <= nominal <= max (got ${min}/${nominal}/${max}).`);
    if (!arr(e.children)[0] && num(e.nominal) > 0 && !/^(Static)/.test(name)) P(problems, 'info', line, `${name}: no <children>; nothing will spawn unless this is a static event.`);
    if (typeNames && typeNames.size) {
      for (const c of arr(arr(e.children)[0] && arr(e.children)[0].child)) {
        const t = attr(c, 'type');
        if (t && !typeNames.has(t)) P(problems, 'error', line, `${name}: child type "${t}" does not exist in any types.xml.`);
      }
    }
  }
}

function validateEconomyCore(doc, text, problems, md) {
  if (!doc.economycore) { P(problems, 'error', 1, 'Root element must be <economycore>.'); return; }
  let pos = 0;
  for (const ce of arr(doc.economycore.ce)) {
    const folder = attr(ce, 'folder') || '';
    const dir = path.join(md, folder);
    const line = lineOfMatch(text, new RegExp(`folder="${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'), pos);
    pos = Math.max(pos, text.indexOf(`folder="${folder}"`, pos) + 1);
    if (!exists(dir)) { P(problems, 'error', line, `CE folder "${folder}" does not exist in the mission.`); continue; }
    for (const f of arr(ce.file)) {
      const name = attr(f, 'name'), type = attr(f, 'type');
      if (!name) { P(problems, 'error', line, 'A <file> entry has no name.'); continue; }
      if (!exists(path.join(dir, name))) P(problems, 'error', nameLine(text, name), `File "${folder}/${name}" does not exist.`);
      if (!['types', 'spawnabletypes', 'globals', 'economy', 'events', 'messages'].includes(type)) P(problems, 'error', nameLine(text, name), `"${name}": unknown type "${type}". Use types, spawnabletypes, globals, economy, events or messages.`);
    }
  }
}

function validateSpawnableTypes(doc, text, problems, md) {
  if (!doc.spawnabletypes) { P(problems, 'error', 1, 'Root element must be <spawnabletypes>.'); return; }
  const typeNames = md ? loadTypeNames(md) : new Set();
  let pos = 0;
  for (const t of arr(doc.spawnabletypes.type)) {
    const name = attr(t, 'name');
    const line = name ? nameLine(text, name, pos) : 1;
    if (name) pos = Math.max(pos, text.indexOf(`name="${name}"`, pos) + 1);
    if (!name) { P(problems, 'error', line, '<type> without a name.'); continue; }
    if (typeNames.size && !typeNames.has(name)) P(problems, 'warning', line, `${name}: not found in types.xml (fine for mod base classes, otherwise a typo).`);
    for (const grp of [...arr(t.attachments), ...arr(t.cargo)]) {
      const chance = num(attr(grp, 'chance'));
      if (!Number.isNaN(chance) && (chance < 0 || chance > 1)) P(problems, 'error', line, `${name}: chance must be between 0 and 1.`);
      for (const it of arr(grp.item)) {
        const n = attr(it, 'name');
        if (n && typeNames.size && !typeNames.has(n)) P(problems, 'error', line, `${name}: item "${n}" does not exist in any types.xml.`);
        const c = num(attr(it, 'chance'));
        if (!Number.isNaN(c) && (c < 0 || c > 1)) P(problems, 'error', line, `${name}: item "${n}" chance must be between 0 and 1.`);
      }
    }
  }
}

function validateEventSpawns(doc, text, problems, md) {
  if (!doc.eventposdef) { P(problems, 'error', 1, 'Root element must be <eventposdef>.'); return; }
  const events = md ? loadEventNames(md) : new Set();
  let pos = 0;
  for (const e of arr(doc.eventposdef.event)) {
    const name = attr(e, 'name');
    const line = name ? nameLine(text, name, pos) : 1;
    if (name) pos = Math.max(pos, text.indexOf(`name="${name}"`, pos) + 1);
    if (name && events.size && !events.has(name)) P(problems, 'warning', line, `Event "${name}" has spawn positions but is not defined in db/events.xml.`);
    for (const p of arr(e.pos)) {
      if ([num(attr(p, 'x')), num(attr(p, 'z'))].some(Number.isNaN)) P(problems, 'error', line, `${name}: <pos> needs numeric x and z.`);
    }
  }
}

const GLOBALS = new Set(['AnimalMaxCount', 'CleanupAvoidance', 'CleanupLifetimeDeadAnimal', 'CleanupLifetimeDeadInfected', 'CleanupLifetimeDeadPlayer', 'CleanupLifetimeDefault', 'CleanupLifetimeLimit', 'CleanupLifetimeRuined', 'FlagRefreshFrequency', 'FlagRefreshMaxDuration', 'FoodDecay', 'IdleModeCountdown', 'IdleModeStartup', 'InitialSpawn', 'LootDamageMax', 'LootDamageMin', 'LootProxyPlacement', 'LootSpawnAvoidance', 'RespawnAttempt', 'RespawnLimit', 'RespawnTypes', 'RestartSpawnID', 'SpawnInitial', 'TimeHopping', 'TimeLogin', 'TimeLogout', 'TimePenalty', 'WorldWetTempUpdate', 'ZombieMaxCount', 'ZoneSpawnDist']);
function validateGlobals(doc, text, problems) {
  if (!doc.variables) { P(problems, 'error', 1, 'Root element must be <variables>.'); return; }
  for (const v of arr(doc.variables.var)) {
    const name = attr(v, 'name'), line = name ? nameLine(text, name) : 1;
    if (name && !GLOBALS.has(name)) P(problems, 'warning', line, `Unknown global "${name}".`);
    if (!/^[01]$/.test(attr(v, 'type') || '')) P(problems, 'error', line, `${name}: type must be 0 (int) or 1 (float).`);
    if (Number.isNaN(num(attr(v, 'value')))) P(problems, 'error', line, `${name}: value must be numeric.`);
  }
}

function validateMessages(doc, text, problems) {
  if (!doc.messages) { P(problems, 'error', 1, 'Root element must be <messages>.'); return; }
  arr(doc.messages.message).forEach((m, i) => {
    const line = lineOfMatch(text, /<message>/g, 0) + 0;
    if (!m.text) P(problems, 'error', line, `Message ${i + 1}: missing <text>.`);
    if (m.delay === undefined && m.deadline === undefined && m.onconnect === undefined) P(problems, 'warning', line, `Message ${i + 1}: needs <delay>, <deadline> or <onconnect> to ever show.`);
    if (m.shutdown !== undefined && m.shutdown === '1' && m.deadline === undefined) P(problems, 'warning', line, `Message ${i + 1}: shutdown=1 without <deadline>.`);
  });
}

function validateXml(text, abs) {
  const problems = [];
  const doc = xmlSyntax(text, problems);
  if (!doc) return problems;
  const md = missionDir();
  const base = path.basename(abs).toLowerCase();
  const inMission = md && path.resolve(abs).startsWith(path.resolve(md));
  if (doc.types) validateTypes(doc, text, problems, inMission ? md : null);
  else if (doc.events) validateEvents(doc, text, problems, inMission ? md : null);
  else if (doc.economycore) validateEconomyCore(doc, text, problems, inMission ? md : path.dirname(abs));
  else if (doc.spawnabletypes) validateSpawnableTypes(doc, text, problems, inMission ? md : null);
  else if (doc.eventposdef) validateEventSpawns(doc, text, problems, inMission ? md : null);
  else if (doc.variables) validateGlobals(doc, text, problems);
  else if (doc.messages) validateMessages(doc, text, problems);
  else if (base === 'types.xml' || base === 'events.xml') P(problems, 'error', 1, `Unexpected root element for ${base}.`);
  return problems;
}

// ---------- JSON ----------
const GAMEPLAY_SECTIONS = ['version', 'general', 'PlayerData', 'WorldsData', 'BaseBuildingData', 'UIData', 'MapData'];
function validateJson(text, abs) {
  const problems = [];
  let data;
  try { data = JSON.parse(text); }
  catch (e) {
    const m = e.message.match(/position (\d+)/);
    const idx = m ? Number(m[1]) : 0;
    P(problems, 'error', lineAt(text, idx), `JSON syntax: ${e.message}`);
    // Common mistakes
    text.split('\n').forEach((l, i) => { if (/,\s*[}\]]\s*$/.test(l) || /^\s*[}\]]\s*$/.test(l) && /,\s*$/.test(text.split('\n')[i - 1] || '')) P(problems, 'warning', i + 1, 'Trailing comma before a closing bracket is not allowed in JSON.'); });
    return problems;
  }
  if (/cfggameplay\.json$/i.test(abs)) {
    if (typeof data !== 'object' || Array.isArray(data)) { P(problems, 'error', 1, 'cfggameplay.json must be an object.'); return problems; }
    for (const k of Object.keys(data)) if (!GAMEPLAY_SECTIONS.includes(k)) P(problems, 'warning', lineOfMatch(text, new RegExp(`"${k}"\\s*:`, 'g')), `Unknown section "${k}".`);
    if (data.version === undefined) P(problems, 'warning', 1, 'Missing "version".');
    const gen = data.general || {};
    for (const k of ['disableBaseDamage', 'disableContainerDamage', 'disableRespawnDialog']) if (gen[k] !== undefined && typeof gen[k] !== 'boolean') P(problems, 'error', lineOfMatch(text, new RegExp(`"${k}"`, 'g')), `general.${k} must be true or false.`);
    const wd = data.WorldsData || {};
    if (wd.lightingConfig !== undefined && ![0, 1].includes(wd.lightingConfig)) P(problems, 'error', lineOfMatch(text, /"lightingConfig"/g), 'WorldsData.lightingConfig must be 0 or 1.');
    const walk = (obj, pathStr) => {
      for (const [k, v] of Object.entries(obj || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, pathStr + k + '.');
        else if (typeof v === 'string' && /^(true|false|\d+(\.\d+)?)$/.test(v)) P(problems, 'warning', lineOfMatch(text, new RegExp(`"${k}"\\s*:\\s*"`, 'g')), `${pathStr}${k}: "${v}" is quoted; it should probably be ${v} without quotes.`);
      }
    };
    walk(data, '');
  }
  return problems;
}

// ---------- init.c ----------
function validateInitC(text) {
  const problems = [];
  const src = stripComments(text);
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const stack = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') { i++; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; } continue; }
    if (pairs[c]) stack.push({ c, i });
    else if (Object.values(pairs).includes(c)) {
      const top = stack.pop();
      if (!top || pairs[top.c] !== c) P(problems, 'error', lineAt(src, i), `Unexpected "${c}".`);
    }
  }
  for (const s of stack) P(problems, 'error', lineAt(src, s.i), `Unclosed "${s.c}".`);
  if (!/void\s+main\s*\(/.test(src)) P(problems, 'error', 1, 'init.c needs a "void main()" function.');
  if (!/CreateCustomMission/.test(src)) P(problems, 'warning', 1, 'No CreateCustomMission() found; the mission class will not be created.');
  if (/class\s+CustomMission\s*:\s*MissionServer/.test(src) && !/Mission\s+CreateCustomMission\s*\(\s*string\s+path\s*\)/.test(src)) P(problems, 'warning', 1, 'CustomMission exists but CreateCustomMission(string path) signature looks off.');
  // Lines ending without semicolon that look like statements
  text.split('\n').forEach((l, i) => {
    const t = l.replace(/\/\/.*$/, '').trim();
    if (/^(return|break|continue)\b[^;]*$/.test(t)) P(problems, 'error', i + 1, 'Missing semicolon.');
    if (/\b(GetGame\(\)|CreateObject|SetPosition|SetOrientation)\b.*[^;{}\s,(]\s*$/.test(t) && !/\)\s*$/.test(t)) P(problems, 'warning', i + 1, 'Possible missing semicolon.');
  });
  return problems;
}

// ---------- entry points ----------
function validate(file, text) {
  const abs = safeAbs(file);
  if (text === undefined) text = fs.readFileSync(abs, 'utf8');
  const base = path.basename(abs).toLowerCase();
  let problems;
  if (/\.xml$/i.test(abs)) problems = validateXml(text, abs);
  else if (/\.json$/i.test(abs)) problems = validateJson(text, abs);
  else if (base === 'init.c' || /\.c$/i.test(abs)) problems = validateInitC(text);
  else if (/^beserver(_x64)?.*\.cfg$/i.test(base)) problems = validateBeCfg(text);
  else if (/\.cfg$/i.test(abs)) problems = validateCfg(text, abs);
  else problems = [];
  if (/\r(?!\n)/.test(text)) P(problems, 'info', 1, 'File uses bare CR line endings; use CRLF or LF.');
  if (text.charCodeAt(0) === 0xFEFF && /\.(xml|json)$/i.test(abs)) P(problems, 'warning', 1, 'File starts with a UTF-8 BOM; some parsers choke on it.');
  const order = { error: 0, warning: 1, info: 2 };
  problems.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  return { abs, problems, counts: { error: problems.filter(p => p.severity === 'error').length, warning: problems.filter(p => p.severity === 'warning').length, info: problems.filter(p => p.severity === 'info').length } };
}

// Validate every known config plus cross-file server checks.
function validateAll() {
  const { s, p } = roots();
  const { groups } = listFiles();
  const results = [];
  for (const g of groups) {
    if (g.collapsed) continue;
    for (const f of g.files) {
      if (f.size > 25 * 1024 * 1024) continue;
      try { const r = validate(f.abs); if (r.problems.length) results.push({ file: f.abs, name: f.name, group: g.group, ...r }); }
      catch (e) { results.push({ file: f.abs, name: f.name, group: g.group, problems: [{ severity: 'error', line: 1, message: e.message }], counts: { error: 1, warning: 0, info: 0 } }); }
    }
  }
  // Server-level checks
  const general = [];
  if (!exists(p.serverExe)) P(general, 'error', 1, 'DayZServer_x64.exe not found. Install the server first.');
  if (!exists(p.configPath)) P(general, 'error', 1, `Config file ${p.configPath} not found.`);
  const md = missionDir();
  if (md) {
    for (const f of ['cfgeconomycore.xml', 'cfgenvironment.xml', 'cfglimitsdefinition.xml', 'db/types.xml', 'db/globals.xml', 'db/events.xml', 'init.c']) if (!exists(path.join(md, f))) P(general, 'error', 1, `Mission is missing ${f}.`);
  }
  for (const m of s.mods) {
    const c = s.modCache[m.id] || {};
    if (m.enabled === false) continue;
    const folder = c.folderName || (m.id.startsWith('@') ? m.id : null);
    if (!folder) { P(general, 'warning', 1, `Mod ${c.title || m.id} is enabled but not downloaded or linked.`); continue; }
    if (!exists(path.join(p.serverDir, folder))) P(general, 'error', 1, `Mod folder ${folder} is missing from the server directory.`);
    if (!(c.keys || []).length) P(general, 'warning', 1, `Mod ${c.title || folder} has no .bikey copied; clients will be kicked with verifySignatures=2.`);
  }
  if (general.length) results.unshift({ file: null, name: 'Server setup', group: 'General', problems: general, counts: { error: general.filter(x => x.severity === 'error').length, warning: general.filter(x => x.severity === 'warning').length, info: 0 } });
  const totals = results.reduce((a, r) => ({ error: a.error + r.counts.error, warning: a.warning + r.counts.warning, info: a.info + r.counts.info }), { error: 0, warning: 0, info: 0 });
  return { results, totals, checked: groups.reduce((n, g) => n + (g.collapsed ? 0 : g.files.length), 0) };
}

module.exports = { listFiles, read, write, createFile, validate, validateAll, missionDir, xmlParser, loadLimits, loadTypeNames };
