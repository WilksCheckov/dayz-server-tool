'use strict';
// Player database built incrementally from the admin logs (.ADM): sessions, playtime, kills/deaths, name history,
// last position, joined with the whitelist/ban lists and the Discord bot's applications.
const fs = require('fs');
const jsonstore = require('./jsonstore');
const path = require('path');
const { app } = require('electron');
const settings = require('./settings');
const lists = require('./lists');
const server = require('./server');

let emitRef = () => {};
let timer = null;
// A reader that keeps failing (a locked .ADM, a log line it cannot parse) is said once per kind every 10 minutes:
// the player database, kill feed, combat flags, death log, gear snapshots and dupe check all depend on it.
const lastProblem = {};
function problem(what, e) { const now = Date.now(); const k = what + '|' + (e && e.message); if (lastProblem[k] && now - lastProblem[k] < 600000) return; lastProblem[k] = now; emitRef('console', { source: 'players', line: `${what} failed: ${e && e.message || e}` }); }
let db = null; // { players: {key: rec}, files: {name: {offset, date, lastTime}}, peaks: {YYYY-MM-DD: n}, online: {key: startTs} }

function file() { return path.join(app.getPath('userData'), 'players.json'); }
function load() { if (db) return db; db = jsonstore.readOr(file(), null); db = { players: {}, files: {}, peaks: {}, online: {}, ...(db || {}) }; return db; }
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { jsonstore.write(file(), load()); }, 2000); }

function rec(key, name, id) {
  const d = load();
  let r = d.players[key];
  if (!r) { r = { key, id: id || null, names: [], firstSeen: null, lastSeen: null, sessions: [], playtimeSec: 0, kills: 0, deaths: 0, lastPos: null, lastEvent: '', connects: 0 }; d.players[key] = r; }
  if (name && !r.names.includes(name)) r.names.push(name);
  if (id && !r.id) r.id = id;
  return r;
}

// Merge a name-only record into an id record once the id is learned.
function mergeNameInto(name, idKey) {
  const d = load();
  const a = d.players[name];
  if (!a || name === idKey) return;
  const b = rec(idKey, name, idKey);
  for (const n of a.names) if (!b.names.includes(n)) b.names.push(n);
  b.firstSeen = Math.min(a.firstSeen || Infinity, b.firstSeen || Infinity) === Infinity ? null : Math.min(a.firstSeen || Infinity, b.firstSeen || Infinity);
  b.lastSeen = Math.max(a.lastSeen || 0, b.lastSeen || 0) || null;
  b.sessions.push(...a.sessions); b.playtimeSec += a.playtimeSec; b.kills += a.kills; b.deaths += a.deaths; b.connects += a.connects;
  if (!b.notes && a.notes) b.notes = a.notes;
  delete d.players[name];
}

const P = (x, y, z) => ({ x: Number(x), y: Number(y), z: Number(z) });

function parseLine(line, ctx) {
  const tm = line.match(/^\s*(\d{1,2}):(\d{2}):(\d{2})\s*\|?\s*(.*)$/);
  if (!tm) {
    const hdr = line.match(/AdminLog started on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}:\d{2})/);
    if (hdr) { ctx.date = hdr[1]; ctx.lastSec = -1; }
    return null;
  }
  const sec = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]);
  if (ctx.lastSec !== undefined && ctx.lastSec >= 0 && sec < ctx.lastSec - 60) { // midnight rollover
    const d = new Date(ctx.date + 'T00:00:00'); d.setDate(d.getDate() + 1); ctx.date = d.toISOString().slice(0, 10);
  }
  ctx.lastSec = sec;
  const ts = new Date(ctx.date + 'T00:00:00').getTime() + sec * 1000;
  const body = tm[4];
  if (!body.includes('Player "')) return { ts };
  const m = body.match(/Player\s+"([^"]+)"\s*(\(DEAD\)\s*)?(?:\(id=([^\s)]+)(?:\s+pos=<([^,]+),\s*([^,]+),\s*([^>]+)>)?[^)]*\))?/);
  if (!m) return { ts };
  const ev = { ts, name: m[1], dead: !!m[2], id: m[3] || null, pos: m[4] ? P(m[4], m[5], m[6]) : null, body };
  if (/is connected/.test(body)) { ev.type = 'connect'; const idAfter = body.match(/is connected\s*\(id=([^\s)]+)/); if (idAfter) ev.id = ev.id || idAfter[1]; }
  else if (/has been disconnected|disconnected/.test(body)) ev.type = 'disconnect';
  else if (/killed by Player\s+"([^"]+)"\s*\(id=([^\s)]+)/.test(body)) { const k = body.match(/killed by Player\s+"([^"]+)"\s*\(id=([^\s)]+)[^)]*\)(?:\s+with\s+(.+?))?(?:\s+from|\s*$)/); ev.type = 'kill'; ev.killer = { name: k[1], id: k[2] }; ev.weapon = k[3] || null; }
  else if (/\bhit by\b/.test(body)) ev.type = 'hit';
  else if (ev.dead || /\bdied\b|bled out|committed suicide|killed by\b/.test(body)) ev.type = 'death';
  else if (/placed|built|dismantled|folded|unpacked/.test(body)) ev.type = 'build';
  else ev.type = 'other';
  return ev;
}

function applyEvent(ev, d) {
  if (!ev || !ev.name) return;
  const key = ev.id || ev.name;
  if (ev.id && d.players[ev.name] && !d.players[ev.id]) mergeNameInto(ev.name, ev.id);
  const existed = !!d.players[key];
  const r = rec(key, ev.name, ev.id); ev._new = !existed;
  r.lastSeen = Math.max(r.lastSeen || 0, ev.ts); if (!r.firstSeen || ev.ts < r.firstSeen) r.firstSeen = ev.ts;
  if (ev.pos) r.lastPos = { ...ev.pos, at: ev.ts };
  r.lastEvent = ev.type;
  if (ev.type === 'connect') { r.connects++; d.online[key] = ev.ts; }
  else if (ev.type === 'disconnect') { const start = d.online[key]; if (start) { const dur = Math.max(0, Math.round((ev.ts - start) / 1000)); if (dur < 48 * 3600) { r.sessions.push({ start, end: ev.ts }); r.playtimeSec += dur; if (r.sessions.length > 200) r.sessions.shift(); } delete d.online[key]; } }
  else if (ev.type === 'kill') { r.deaths++; const kk = ev.killer.id || ev.killer.name; const kr = rec(kk, ev.killer.name, ev.killer.id); kr.kills++; kr.lastSeen = Math.max(kr.lastSeen || 0, ev.ts); kr.lastKill = { victim: ev.name, weapon: ev.weapon, at: ev.ts }; r.lastDeath = { killer: ev.killer.name, weapon: ev.weapon, at: ev.ts }; }
  else if (ev.type === 'death') { r.deaths++; r.lastDeath = { killer: null, weapon: null, at: ev.ts }; }
  // Peak concurrency per day
  if (ev.type === 'connect' || ev.type === 'disconnect') { const day = new Date(ev.ts).toISOString().slice(0, 10); const n = Object.keys(d.online).length; d.peaks[day] = Math.max(d.peaks[day] || 0, n); }
}

// Read new bytes from the newest ADM files and apply them.
function ingest() {
  try { require('./deathlog').ingestGear(); } catch (e) { if (e.code !== 'ENOENT') problem('Reading the gear snapshots (refunds need them)', e); }
  try { require('./anticheat').ingest(); } catch (e) { if (e.code !== 'ENOENT') problem('Reading the dupe detector\'s log', e); }
  try { require('./drpadmin').ingest(); } catch (e) { if (e.code !== 'ENOENT') problem('Reading the DRP_Admin event log', e); }
  const d = load();
  const p = settings.paths();
  let files = [];
  try { files = fs.readdirSync(p.profilesDir).filter(f => /\.adm$/i.test(f)).map(f => ({ f, full: path.join(p.profilesDir, f), st: fs.statSync(path.join(p.profilesDir, f)) })).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs).slice(-3); } catch { return 0; }
  let applied = 0;
  for (const x of files) {
    const meta = d.files[x.f] || { offset: 0, date: new Date(x.st.mtimeMs).toISOString().slice(0, 10), lastSec: -1, rest: '' };
    if (x.st.size < meta.offset) { meta.offset = 0; meta.rest = ''; } // rotated in place
    if (x.st.size === meta.offset) { d.files[x.f] = meta; continue; }
    const fd = fs.openSync(x.full, 'r');
    try {
      const len = Math.min(x.st.size - meta.offset, 8 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, meta.offset);
      meta.offset += n;
      const lines = (meta.rest + buf.toString('utf8', 0, n)).split(/\r?\n/);
      meta.rest = lines.pop() || '';
      const ctx = { date: meta.date, lastSec: meta.lastSec };
      for (const line of lines) { const ev = parseLine(line, ctx); if (ev && ev.type) { applyEvent(ev, d); applied++; try { require('./discord').feedEvent(ev); } catch { /* bot not loaded */ } try { require('./heat').record(ev); } catch (e) { problem('Heatmap', e); } try { require('./combat').record(ev); } catch (e) { problem('Combat log', e); } try { require('./deathlog').record(ev); } catch (e) { problem('Death log', e); } try { require('./stats').recordEvent(ev, ev.type === 'connect' && !!ev._new); } catch (e) { problem('Statistics', e); } } }
      meta.date = ctx.date; meta.lastSec = ctx.lastSec;
    } finally { fs.closeSync(fd); }
    d.files[x.f] = meta;
  }
  // When the server is not running nobody is online; close dangling sessions without counting them.
  if (!server.status().running && Object.keys(d.online).length) d.online = {};
  if (applied) { save(); emitRef('players:changed', { applied }); }
  return applied;
}

// ---------- queries ----------
function enrich(r) {
  const s = settings.load();
  const notes = s.playerNotes || {};
  let steamId = null, discordId = null, characterName = null, application = null;
  // Steam64 known from a list comment, or from a Discord application whose hash matches.
  for (const kind of ['whitelist', 'ban', 'priority']) { try { const e = lists.read(kind).entries.find(x => x.id === r.id); if (e && e.steamId) { steamId = e.steamId; discordId = discordId || e.discordId || null; break; } } catch { /* ignore */ } }
  try {
    const apps = Object.values(require('./discord').store().applications);
    const a = apps.find(x => (steamId && x.steamId === steamId) || (r.id && lists.steamIdToDayzId(x.steamId) === r.id));
    if (a) { steamId = steamId || a.steamId; discordId = discordId || a.discordId; characterName = a.characterName; application = a.status; }
  } catch { /* bot module not loaded */ }
  const note = (r.id && notes[r.id] && notes[r.id].note) || (steamId && notes[steamId] && notes[steamId].note) || r.notes || '';
  const online = !!load().online[r.key] && server.status().running;
  let steam = null; try { steam = steamId ? require('./steambans').get(steamId) : null; } catch { /* ignore */ }
  let account = null; try { account = require('./accounts').summary({ steamId, names: r.names }); } catch { /* ignore */ }
  let combat = null; try { const cb = require('./combat'); combat = cb.forPlayer(r.id || r.key) || cb.forPlayer(r.names[r.names.length - 1]); } catch { /* ignore */ }
  return { ...r, name: r.names[r.names.length - 1] || r.key, steamId, discordId, characterName, application, note, online, steam, account, combat,
    whitelisted: !!(r.id && lists.has('whitelist', r.id)), banned: !!(r.id && lists.has('ban', r.id)), priority: !!(r.id && lists.has('priority', r.id)) };
}

function all({ query = '', sort = 'lastSeen', limit = 500 } = {}) {
  const d = load();
  const q = query.trim().toLowerCase();
  let rows = Object.values(d.players).map(enrich);
  if (q) rows = rows.filter(r => r.names.some(n => n.toLowerCase().includes(q)) || (r.id || '').toLowerCase().includes(q) || (r.steamId || '').includes(q) || (r.characterName || '').toLowerCase().includes(q));
  const cmp = { lastSeen: (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0), playtime: (a, b) => b.playtimeSec - a.playtimeSec, kills: (a, b) => b.kills - a.kills, deaths: (a, b) => b.deaths - a.deaths, name: (a, b) => a.name.localeCompare(b.name), suspicious: (a, b) => ((b.account && b.account.score) || 0) - ((a.account && a.account.score) || 0), firstSeen: (a, b) => (b.firstSeen || 0) - (a.firstSeen || 0) }[sort] || ((a, b) => 0);
  rows.sort((a, b) => (b.online - a.online) || cmp(a, b));
  return rows.slice(0, limit);
}
function get(key) { const r = load().players[key]; return r ? enrich(r) : null; }
function setNote(key, text) { const r = load().players[key]; if (!r) throw new Error('Unknown player'); r.notes = text; if (r.id) lists.saveNote(r.id, { note: text, name: r.names[r.names.length - 1] }); save(); return enrich(r); }
function remove(key) { delete load().players[key]; save(); emitRef('players:changed', {}); return true; }
function stats() {
  const d = load();
  const now = Date.now(), day = 86400000;
  const seen = (ms) => Object.values(d.players).filter(r => (r.lastSeen || 0) >= now - ms).length;
  const today = new Date().toISOString().slice(0, 10);
  const days = [...Array(14)].map((_, i) => { const t = new Date(now - i * day).toISOString().slice(0, 10); return { day: t, peak: d.peaks[t] || 0 }; }).reverse();
  return { total: Object.keys(d.players).length, today: seen(day), week: seen(7 * day), onlineNow: server.status().running ? Object.keys(d.online).length : 0, peakToday: d.peaks[today] || 0, peakDays: days, totalPlaytimeSec: Object.values(d.players).reduce((a, r) => a + r.playtimeSec, 0) };
}
function rebuild() { db = { players: {}, files: {}, peaks: {}, online: {} }; try { fs.unlinkSync(file()); } catch { /* ignore */ } const n = ingest(); save(); emitRef('players:changed', {}); return n; }

function init(emit) {
  emitRef = emit;
  load();
  try { ingest(); } catch (e) { problem('Reading the admin logs', e); }
  clearInterval(timer);
  timer = setInterval(() => { if (server.status().running) { try { ingest(); } catch (e) { problem('Reading the admin logs', e); } } }, 10000);
}

module.exports = { init, ingest, all, get, setNote, remove, stats, rebuild, parseLine };
