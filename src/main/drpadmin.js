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
// not DRP_Admin: that is the client PBO's prefix in @DRP_Core, and both load on the server
const PREFIX = 'DRP_Admin_Server';
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
  for (const e of fresh) if (e.ev === 'admin') auditAdmin(e);
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
// ---------- in-game admin actions into the audit trail ----------
// The client mod (DRP_Admin in @DRP_Core) writes one ev:"admin" line per action: { action, by {id, steam, name},
// target?, detail }. Each becomes an adminlog record (audit log, console, Discord admin action channel), named after
// the catalogue action where there is one. Only recent lines: a first read of an old file must not replay history.
const INGAME_ACTION = {
  heal: 'heal', repairgear: 'heal', repairhands: 'heal', stopbleed: 'heal', kill: 'kill', god: 'god',
  freeze: 'freeze', invisible: 'invisible', strip: 'strip', message: 'message', kick: 'kick', bring: 'bring', tpto: 'tpto',
  tp_cursor: 'tp', tp_spot: 'tp', spawn: 'spawn', admin_mode: 'adminmode', weather: 'weather', time: 'weather',
  tp_spot_save: 'tpspot', tp_spot_delete: 'tpspot'
};
const INGAME_TEXT = {
  admin_mode: 'admin mode', tp_cursor: 'teleported to where they looked', tp_spot: 'teleported to a place', time: 'time of day',
  clear: 'cleared the inventory', stat: 'set a stat', sick: 'gave a sickness', clearsick: 'cured sicknesses', knockout: 'knocked out',
  breaklegs: 'broke the legs', bleed: 'made bleed', stopbleed: 'stopped the bleeding', vomit: 'made vomit', bloodyhands: 'bloody hands',
  dry: 'dried off', repairgear: 'repaired all gear', repairhands: 'repaired the item in hands', ammo: 'unlimited ammo',
  stamina: 'unlimited stamina', aiignore: 'AI ignores them', tp_spot_save: 'saved a teleport spot', tp_spot_delete: 'deleted a teleport spot',
  delete: 'deleted', moderate_ban: 'ban requested', moderate_list: 'list change requested', moderate_watch: 'watchlist change requested'
};
const AUDIT_WINDOW_MS = 15 * 60000;
function detailText(e) {
  const d = e.detail;
  const what = INGAME_TEXT[e.action] || '';
  if (d === undefined || d === null || d === true) return what;
  if (d === false) return `${what || e.action} off`.trim();
  if (Array.isArray(d)) return `${what}${what ? ' ' : ''}at ${Math.round(d[0])}, ${Math.round(d[2])}`;
  if (typeof d === 'object') {
    if (d.stat) return `${d.stat} set to ${Math.round(d.share * 100)}%`;
    if (d.cls) return `${what ? what + ' ' : ''}${d.count || 1} × ${d.cls}${d.vehicle ? ` (vehicle, ${d.parts || 0} parts)` : ''}${Array.isArray(d.pos) ? ` at ${Math.round(d.pos[0])}, ${Math.round(d.pos[2])}` : ''}`;
    if (d.name) return `${what} "${d.name}"`;
    return `${what} ${Object.entries(d).map(([k, v]) => `${k} ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`).join(', ')}`.trim();
  }
  return `${what}${what ? ': ' : ''}${d}`;
}
function auditAdmin(e) {
  if (!e.ts || Date.now() - e.ts > AUDIT_WINDOW_MS) return;
  const by = e.by && e.by.name ? `${e.by.name} (in game)` : 'in game';
  const action = INGAME_ACTION[e.action] || 'afflict';
  let details = detailText(e);
  if (action === 'afflict' && !INGAME_TEXT[e.action]) details = `${e.action}${details ? ': ' + details : ''}`;
  if (e.action === 'message' || e.action === 'kick') details = typeof e.detail === 'string' ? e.detail : details;
  try {
    require('./adminlog').record({ action, by, source: 'game', target: e.target && e.target.name ? { name: e.target.name, steam: e.target.steam || null } : null, details, reason: '', result: { status: 'done' } });
  } catch (err) { emitRef('console', { source: 'drpadmin', line: 'In-game admin action not recorded: ' + err.message }); }
}

// ---------- in-game admins from the portal ----------
// profiles/DRP_Admin/admins.json is written from the portal's users: everyone enabled with a Steam id and the
// admin.menu permission, with their in-game permissions; plus the owner Steam ids from the DRP_Admin card ("*").
// The mod re-reads it every 30 s. Written only when it changed; never emptied while it still lists someone (so a
// hand-made file survives until the portal has at least one in-game admin).
const INGAME_PERMS = ['admin.menu', 'admin.players', 'admin.teleport', 'admin.teleport.manage', 'admin.heal', 'admin.kill', 'admin.god', 'admin.afflict', 'admin.spawn', 'admin.spawn.forbidden', 'admin.weather', 'admin.vehicles', 'admin.kits', 'admin.refund', 'admin.industry', 'admin.delete', 'admin.freecam', 'admin.editor', 'admin.esp','players.message', 'players.kick', 'players.ban', 'lists.manage', 'tickets.view', 'tickets.manage'];
function adminsFile() { return path.join(settings.paths().profilesDir, 'DRP_Admin', 'admins.json'); }
function owners() { return (cfg().owners || []).map(s => String(s).trim()).filter(s => /^7656\d{13}$/.test(s)); }
function computeAdmins() {
  const out = new Map();
  for (const s of owners()) out.set(s, { steam: s, name: 'Owner', perms: ['*'] });
  let users = []; try { users = require('./portal').listUsers(); } catch { /* portal not loaded */ }
  for (const u of users) {
    if (!u.enabled || !u.steam || out.has(u.steam) || !u.perms.includes('admin.menu')) continue;
    // the categories the portal says need another admin's approval for them: the mod sends those for approval
    let approval = []; try { approval = require('./portal').approvalNeeds(u.id); } catch { /* portal not loaded */ }
    out.set(u.steam, { steam: u.steam, name: u.name, perms: u.perms.filter(p => INGAME_PERMS.includes(p)), ...(approval.length ? { approval } : {}) });
  }
  return [...out.values()];
}
function syncAdmins() {
  const admins = computeAdmins(); const f = adminsFile();
  let current = null; try { current = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* none yet */ }
  const had = current && Array.isArray(current.admins) ? current.admins.length : 0;
  if (!admins.length && had) return { written: false, admins, reason: 'no in-game admins in the portal yet; the existing file is kept' };
  const next = JSON.stringify({ admins }, null, 4);
  if (current && JSON.stringify(current, null, 4) === next) return { written: false, admins };
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, next); } catch (err) { return { written: false, admins, error: err.message }; }
  emitRef('console', { source: 'drpadmin', line: `In-game admins written: ${admins.map(a => a.name).join(', ') || 'none'} (${f}).` });
  return { written: true, admins };
}
function setOwners(list) {
  const clean = String(Array.isArray(list) ? list.join('\n') : list || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  const bad = clean.filter(s => !/^7656\d{13}$/.test(s));
  if (bad.length) throw new Error(`Not a Steam64 id: ${bad.join(', ')}`);
  settings.save({ drpadmin: { ...cfg(), owners: [...new Set(clean)] } });
  return syncAdmins();
}

// trim the event file while the server is down so it does not grow forever
function housekeeping() {
  try { ingest(); } catch { /* ignore */ }
  try { if (fs.statSync(eventsFile()).size > 8 * 1024 * 1024) { fs.unlinkSync(eventsFile()); load().file = { offset: 0, rest: '' }; save(); } } catch { /* none */ }
}

function init(emit) { emitRef = emit; load(); try { syncAdmins(); } catch { /* no server folder yet */ } }
module.exports = { init, status, install, remove, setEnabled, ensure, active, launchMod, ingest, list, housekeeping, sources, buildHash, syncAdmins, computeAdmins, setOwners, owners, auditAdmin, MOD_FOLDER };
