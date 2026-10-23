'use strict';
// Anti-dupe: builds and installs a server-only mod (@DayZAdminTools) that gives every item a hidden ID saved with
// its persistence data and reports two live items sharing one ID. Also ingests the engine persistent-ID check the
// bridge script does across online players. Detections go to the alert channels and the suspicious flags.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const settings = require('./settings');

const MOD_FOLDER = '@DayZAdminTools';
const MOD_VERSION = 3;
let db = null, saveTimer = null, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'anticheat.json');
function load() { if (db) return db; try { db = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { db = null; } db = { dupes: [], nextId: 1, log: { offset: 0, rest: '' }, lastStats: null, ...(db || {}) }; return db; }
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(file(), JSON.stringify(load())); } catch { /* ignore */ } }, 500); }
function cfg() { return { mod: false, ...(settings.load().anticheat || {}) }; }

// ---------- PBO writer (unpacked entries, "prefix" property, trailing SHA1 as the game tools write it) ----------
function writePbo(outFile, prefix, files) {
  const parts = [];
  const cstr = s => Buffer.from(s + '\0', 'latin1');
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const entry = (name, packing, orig, reserved, ts, size) => Buffer.concat([cstr(name), u32(packing), u32(orig), u32(reserved), u32(ts), u32(size)]);
  parts.push(entry('', 0x56657273, 0, 0, 0, 0), cstr('prefix'), cstr(prefix), cstr(''));
  const now = Math.floor(Date.now() / 1000);
  for (const f of files) parts.push(entry(f.name, 0, f.data.length, 0, now, f.data.length));
  parts.push(entry('', 0, 0, 0, 0, 0));
  for (const f of files) parts.push(f.data);
  const body = Buffer.concat(parts);
  const sha = crypto.createHash('sha1').update(body).digest();
  fs.writeFileSync(outFile, Buffer.concat([body, Buffer.from([0]), sha]));
}

// ---------- install into the server folder ----------
function modDir() { return path.join(settings.paths().serverDir, MOD_FOLDER); }
function srcDir() { return path.join(__dirname, 'mod'); }
function status() {
  const dir = modDir(); const pbo = path.join(dir, 'addons', 'dzat_anticheat.pbo');
  let version = null; try { version = Number(fs.readFileSync(path.join(dir, 'version.txt'), 'utf8').trim()) || null; } catch { /* not installed */ }
  const d = load();
  return { enabled: cfg().mod, installed: fs.existsSync(pbo), version, current: MOD_VERSION, upToDate: version === MOD_VERSION && fs.existsSync(pbo), dir, lastStats: d.lastStats, dupes: d.dupes.length, bridgeEngineCheck: true };
}
function install() {
  const dir = modDir();
  fs.mkdirSync(path.join(dir, 'addons'), { recursive: true });
  const files = [
    { name: 'config.cpp', data: Buffer.from(fs.readFileSync(path.join(srcDir(), 'config.cpp'), 'utf8').replace(/\r\n/g, '\n')) },
    { name: 'scripts\\4_World\\dzat_dupe.c', data: Buffer.from(fs.readFileSync(path.join(srcDir(), 'dzat_dupe.c'), 'utf8').replace(/\r\n/g, '\n')) }
  ];
  writePbo(path.join(dir, 'addons', 'dzat_anticheat.pbo'), 'DayZAdminTools', files);
  fs.writeFileSync(path.join(dir, 'mod.cpp'), 'name = "DayZ Admin Tools anti-dupe";\nauthor = "DayZ Admin Tools";\n');
  fs.writeFileSync(path.join(dir, 'version.txt'), String(MOD_VERSION));
  emitRef('console', { source: 'anticheat', line: `Anti-dupe server mod v${MOD_VERSION} written to ${dir}. It loads at the next server start.` });
  return status();
}
function remove() { try { fs.rmSync(modDir(), { recursive: true, force: true }); } catch { /* ignore */ } return status(); }
function setEnabled(on) { settings.save({ anticheat: { ...cfg(), mod: !!on } }); if (on) install(); return status(); }
// before each start: keep the mod current while it is enabled; tell server.js whether to load it
function ensure() {
  if (!cfg().mod) return { action: 'off' };
  try { const st = status(); if (st.upToDate) return { action: 'ok' }; install(); return { action: st.installed ? 'updated' : 'installed' }; } catch (e) { emitRef('console', { source: 'anticheat', line: 'Anti-dupe mod: ' + e.message }); return { action: 'error', error: e.message }; }
}
function launchMod() { return cfg().mod && status().installed ? MOD_FOLDER : null; }

// ---------- detections from the mod and the bridge (profiles/DayZAdminTools/dupes.log) ----------
function parseStamp(s) { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : Date.now(); }
function holder(s) {
  const p = String(s || '').split(':');
  if (p[0] === 'player') return { kind: 'player', id: p[1] || null, name: p.slice(2).join(':') || p[1] || 'player' };
  if (p[0] === 'world') return { kind: 'world', cls: p[1] || '?', pos: p[2] || '' };
  return { kind: 'unknown', name: s };
}
function describe(h) { return h.kind === 'player' ? h.name : h.kind === 'world' ? `${h.cls} at ${h.pos}` : h.name; }
function ingest() {
  const d = load(); const f = path.join(settings.paths().profilesDir, 'DayZAdminTools', 'dupes.log');
  let st; try { st = fs.statSync(f); } catch { return 0; }
  const meta = d.log;
  if (st.size < meta.offset) { meta.offset = 0; meta.rest = ''; }
  if (st.size === meta.offset) return 0;
  const fd = fs.openSync(f, 'r'); let added = 0;
  try {
    const len = Math.min(st.size - meta.offset, 4 * 1024 * 1024); const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, meta.offset); meta.offset += n;
    const lines = (meta.rest + buf.toString('utf8', 0, n)).split(/\r?\n/); meta.rest = lines.pop() || '';
    for (const line of lines) {
      const f2 = line.split('|'); if (f2.length < 3) continue;
      const ts = parseStamp(f2[0]);
      if (f2[1] === 'stats') { d.lastStats = { ts, tracked: Number(f2[2]) || 0, dupes: Number(f2[3]) || 0, version: f2[4] || '' }; continue; }
      if (f2[1] !== 'dupe' && f2[1] !== 'engine') continue;
      const rec = { id: d.nextId++, ts, source: f2[1] === 'dupe' ? 'mod' : 'engine', uid: f2[2], cls: f2[3] || '?', holders: [holder(f2[4]), holder(f2[5])] };
      d.dupes.push(rec); if (d.dupes.length > 2000) d.dupes.shift(); added++;
      const who = rec.holders.map(describe).join(' and ');
      try { require('./alerts').alert('duplicate-item', `Duplicate item: ${rec.cls}`, `${rec.source === 'mod' ? 'Hidden item ID' : 'Engine item ID'} ${rec.uid} exists twice: ${who}`); } catch { /* ignore */ }
      for (const h of rec.holders) if (h.kind === 'player' && h.id) { try { require('./combat').flagExternal(h.id, h.name, 'duplicate item', `${rec.cls} (${rec.source} ID ${rec.uid}) also held by ${describe(rec.holders.find(x => x !== h))}`, ts); } catch { /* ignore */ } }
    }
  } finally { fs.closeSync(fd); }
  if (added || meta.offset) { save(); if (added) emitRef('anticheat:changed', { added }); }
  return added;
}
function list({ since = 0, limit = 300 } = {}) { const d = load(); const out = []; for (let i = d.dupes.length - 1; i >= 0 && out.length < limit; i--) { const r = d.dupes[i]; if (since && r.ts < since) break; out.push({ ...r, who: r.holders.map(describe) }); } return out; }
function housekeeping() {
  try { ingest(); } catch { /* ignore */ }
  const f = path.join(settings.paths().profilesDir, 'DayZAdminTools', 'dupes.log');
  try { if (fs.statSync(f).size > 4 * 1024 * 1024) { fs.unlinkSync(f); load().log = { offset: 0, rest: '' }; save(); } } catch { /* none */ }
}
// ---------- live loot positions written by the mod (profiles/DayZAdminTools/loot.txt) ----------
let lootCache = { mtime: 0, data: null };
function liveLoot() {
  const f = path.join(settings.paths().profilesDir, 'DayZAdminTools', 'loot.txt');
  let st; try { st = fs.statSync(f); } catch { return lootCache.data || { available: false, reason: cfg().mod ? 'The mod has not written item positions yet (the first export comes 2 minutes after the server is up, then every 5 minutes).' : 'Needs the anti-dupe server mod (Statistics → Dupe detection): it writes where every item is every 5 minutes.' }; }
  if (lootCache.data && lootCache.mtime === st.mtimeMs) return lootCache.data;
  const text = fs.readFileSync(f, 'utf8'); const lines = text.split(/\r?\n/);
  const head = (lines[0] || '').split('|'); const endLine = lines.filter(l => l.startsWith('#end|')).pop();
  if (head[0] !== '#begin' || !endLine) return lootCache.data || { available: false, reason: 'The mod is writing item positions right now; try again in a moment.' };
  const classes = [], idx = new Map(), places = ['-'], pidx = new Map([['-', 0]]); const items = [];
  const vehicles = [];
  for (const l of lines) {
    if (l.startsWith('#veh|')) { const v = l.split('|'); vehicles.push({ cls: v[1], x: Number(v[2]) || 0, z: Number(v[3]) || 0, health: Number(v[4]) }); continue; }
    if (!l || l[0] === '#') continue;
    const p = l.split('|'); if (p.length < 4) continue;
    let ci = idx.get(p[0]); if (ci === undefined) { ci = classes.length; classes.push(p[0]); idx.set(p[0], ci); }
    let pi = pidx.get(p[3]); if (pi === undefined) { pi = places.length; places.push(p[3]); pidx.set(p[3], pi); }
    items.push([ci, Number(p[1]) || 0, Number(p[2]) || 0, pi]);
  }
  const m = String(head[1] || '').match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  const at = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : st.mtimeMs;
  // category of each class from the mission's types (lower-case match, DayZ class names are case-insensitive)
  let cats = {}; try { for (const it of require('./lootmap').items()) cats[it.name.toLowerCase()] = (it.category && it.category[0]) || ''; } catch { cats = {}; }
  const classCat = classes.map(c => cats[c.toLowerCase()] || '');
  lootCache = { mtime: st.mtimeMs, data: { available: true, at, count: items.length, classes, classCat, places, items, vehicles, vehiclesKnown: Number(String(head[2] || '').replace(/\D/g, '')) >= 3 || vehicles.length > 0 } };
  return lootCache.data;
}
function init(emit) { emitRef = emit; load(); }
module.exports = { liveLoot, init, status, install, remove, setEnabled, ensure, launchMod, ingest, list, housekeeping, MOD_FOLDER };
