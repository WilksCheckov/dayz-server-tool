'use strict';
// DRP_Admin server mod: the in-game companion of the tool. Built by the tool into @DayZAdminTools (loaded with
// -serverMod, next to the anti-dupe PBO) from src/main/drpadmin plus bridge.c, so the admin actions are the bridge's
// own code and the command channel (commands.txt / results.log / players.txt ...) is unchanged. While it is on, the
// bridge is not written into init.c (both would run every command). It adds hooks a mission script cannot have and
// writes them to events.jsonl: connects, disconnects, hits and kills on players, base building, placing, vehicles.
const fs = require('fs');
const jsonstore = require('./jsonstore');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const settings = require('./settings');

const MOD_FOLDER = '@DayZAdminTools';
const PBO = 'drp_admin_server.pbo';
const PREFIX = 'DRP_Admin';
const MAX_EVENTS = 3000;
// bump when the event format or the hooks change in a way the tool must know about
const MOD_VERSION = 1;
let db = null, saveTimer = null, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'drpadmin.json');
function load() { if (db) return db; db = jsonstore.readOr(file(), null); db = { events: [], file: { offset: 0, rest: '' }, lastStart: null, ...(db || {}) }; return db; }
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { jsonstore.write(file(), load()); }, 500); }
function cfg() { return { enabled: false, ...(settings.load().drpadmin || {}) }; }
function srcDir() { return path.join(__dirname, 'drpadmin'); }
function modDir() { return path.join(settings.paths().serverDir, MOD_FOLDER); }
function eventsFile() { return path.join(settings.paths().profilesDir, 'DayZAdminTools', 'events.jsonl'); }

// ---------- build ----------
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
// bridge.c as the mod's class: renamed so it can never clash with an init.c copy, world size read at mission start
function bridgeSource() {
  const src = read(path.join(__dirname, 'bridge.c'));
  const out = src.replace(/\bclass DZAT_Bridge\b/, 'class DRPA_Bridge').replace(/\bDZAT_Bridge\./g, 'DRPA_Bridge.')
    .replace(/static const float WORLD = __DZAT_WORLD__;/, `static float WORLD = 15360;\n\tstatic const int VERSION = ${MOD_VERSION};`);
  if (!/class DRPA_Bridge/.test(out) || /__DZAT_WORLD__/.test(out)) throw new Error('bridge.c no longer has the shape the DRP_Admin build expects');
  return out;
}
function sources() {
  return [
    { name: 'config.cpp', text: read(path.join(srcDir(), 'config.cpp')) },
    { name: 'scripts\\4_World\\drpa_events.c', text: read(path.join(srcDir(), '4_World', 'drpa_events.c')) },
    { name: 'scripts\\5_Mission\\drpa_bridge.c', text: bridgeSource() },
    { name: 'scripts\\5_Mission\\drpa_mission.c', text: read(path.join(srcDir(), '5_Mission', 'drpa_mission.c')) }
  ];
}
// the build is identified by a hash of what goes into it, so any edit to bridge.c or the hooks rebuilds the PBO
function buildHash(src = sources()) { const h = crypto.createHash('sha1'); for (const f of src) h.update(f.name + '\0' + f.text + '\0'); return h.digest('hex').slice(0, 12); }
function status() {
  const dir = modDir(); const pbo = path.join(dir, 'addons', PBO);
  let built = null; try { built = fs.readFileSync(path.join(dir, 'drp_admin.txt'), 'utf8').trim() || null; } catch { /* not installed */ }
  let current = null, error = null; try { current = buildHash(); } catch (e) { error = e.message; }
  const installed = fs.existsSync(pbo);
  const d = load();
  return { enabled: cfg().enabled, installed, version: MOD_VERSION, build: built, current, upToDate: installed && built === current, dir, error, events: d.events.length, lastStart: d.lastStart };
}
function install() {
  const dir = modDir();
  fs.mkdirSync(path.join(dir, 'addons'), { recursive: true });
  const src = sources();
  require('./anticheat').writePbo(path.join(dir, 'addons', PBO), PREFIX, src.map(f => ({ name: f.name, data: Buffer.from(f.text) })));
  require('./anticheat').writeModCpp(dir);
  fs.writeFileSync(path.join(dir, 'drp_admin.txt'), buildHash(src));
  emitRef('console', { source: 'drpadmin', line: `DRP_Admin server mod written to ${dir}. It loads at the next server start.` });
  return status();
}
function remove() {
  const dir = modDir();
  for (const f of [path.join(dir, 'addons', PBO), path.join(dir, 'drp_admin.txt')]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
  require('./anticheat').pruneModDir();
  return status();
}
function setEnabled(on) {
  settings.save({ drpadmin: { ...cfg(), enabled: !!on } });
  // a running server holds the PBO open: the change is made by ensure() at the next start
  let running = false; try { running = require('./server').status().running; } catch { /* not loaded */ }
  if (!running) { if (on) install(); else remove(); }
  return { ...status(), pendingRestart: running };
}
// before each start: keep the PBO current while it is on, take it out while it is off
function ensure() {
  try {
    if (!cfg().enabled) { if (status().installed) { remove(); return { action: 'removed' }; } return { action: 'off' }; }
    const st = status(); if (st.upToDate) return { action: 'ok' };
    install(); return { action: st.installed ? 'updated' : 'installed' };
  } catch (e) { emitRef('console', { source: 'drpadmin', line: 'DRP_Admin mod: ' + e.message }); return { action: 'error', error: e.message }; }
}
function active() { return cfg().enabled && fs.existsSync(path.join(modDir(), 'addons', PBO)); }
function launchMod() { return active() ? MOD_FOLDER : null; }

// ---------- events ----------
function parseStamp(s) { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : Date.now(); }
function ingest() {
  const d = load(); const f = eventsFile();
  let st; try { st = fs.statSync(f); } catch { return 0; }
  const meta = d.file;
  if (st.size < meta.offset) { meta.offset = 0; meta.rest = ''; }
  if (st.size === meta.offset) return 0;
  const fd = fs.openSync(f, 'r'); const fresh = [];
  try {
    const len = Math.min(st.size - meta.offset, 8 * 1024 * 1024); const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, meta.offset); meta.offset += n;
    const lines = (meta.rest + buf.toString('utf8', 0, n)).split(/\r?\n/); meta.rest = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!j || typeof j.ev !== 'string') continue;
      j.ts = parseStamp(j.t); delete j.t;
      if (j.ev === 'start') d.lastStart = { ts: j.ts, world: j.world || null, version: j.version || null };
      fresh.push(j);
    }
  } finally { fs.closeSync(fd); }
  if (!fresh.length) { save(); return 0; }
  d.events.push(...fresh); if (d.events.length > MAX_EVENTS) d.events.splice(0, d.events.length - MAX_EVENTS);
  save();
  emitRef('drpadmin:events', { count: fresh.length });
  return fresh.length;
}
function list({ ev = '', q = '', limit = 300 } = {}) {
  const needle = String(q || '').toLowerCase(); const kinds = ev ? String(ev).split(',') : null;
  const out = []; const d = load();
  for (let i = d.events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = d.events[i];
    if (kinds && !kinds.includes(e.ev)) continue;
    if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out;
}
// trim the event file while the server is down so it does not grow forever
function housekeeping() {
  try { ingest(); } catch { /* ignore */ }
  try { if (fs.statSync(eventsFile()).size > 8 * 1024 * 1024) { fs.unlinkSync(eventsFile()); load().file = { offset: 0, rest: '' }; save(); } } catch { /* none */ }
}

function init(emit) { emitRef = emit; load(); }
module.exports = { init, status, install, remove, setEnabled, ensure, active, launchMod, ingest, list, housekeeping, sources, buildHash, MOD_FOLDER };
