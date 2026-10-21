'use strict';
// Player lists that the DayZ server reads from the profiles folder, plus recent players from the admin log.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const settings = require('./settings');

// DayZ identifies players by sha256(SteamID64) in base64 with URL-safe characters.
// whitelist.txt / ban.txt / priority.txt take that DayZ ID; a trailing comment keeps the Steam64 readable.
function steamIdToDayzId(steam64) {
  return createHash('sha256').update(String(steam64)).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
}
function isSteam64(id) { return /^7656119\d{10}$/.test(String(id)); }
function parseComment(c) {
  const out = {};
  const s = c.match(/SteamID64\s+(\d{17})/); if (s) out.steamId = s[1];
  const d = c.match(/DiscordID\s+(\d{15,22})/); if (d) out.discordId = d[1];
  const r = c.match(/Reason:\s*(.*)$/); if (r) out.reason = r[1].trim();
  const n = c.match(/Name:\s*([^-]+?)(?:\s+-|$)/); if (n) out.name = n[1].trim();
  return out;
}
function buildComment({ steamId, discordId, name, reason }) {
  const parts = [];
  if (steamId) parts.push(`SteamID64 ${steamId}`);
  if (discordId) parts.push(`DiscordID ${discordId}`);
  if (name) parts.push(`Name: ${name}`);
  if (reason) parts.push(`Reason: ${reason}`);
  return parts.length ? '\t//' + parts.join(' - ') : '';
}

const KINDS = {
  ban: { file: 'ban.txt', where: 'profiles', label: 'Game bans (ban.txt)', help: 'One Steam64 ID or DayZ ID per line. Reloaded by the server on restart.' },
  whitelist: { file: 'whitelist.txt', where: 'profiles', label: 'Whitelist (whitelist.txt)', help: 'Steam64 IDs allowed to join when enableWhitelist = 1 in serverDZ.cfg.' },
  priority: { file: 'priority.txt', where: 'profiles', label: 'Priority queue (priority.txt)', help: 'Steam64 IDs that skip the login queue.' },
  bebans: { file: path.join('battleye', 'bans.txt'), where: 'server', label: 'BattlEye bans (bans.txt)', help: 'GUID or IP, minutes (0 = permanent) and reason. BattlEye reloads this via RCon "loadBans" or on restart.' }
};

function fileFor(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error('Unknown list ' + kind);
  const p = settings.paths();
  return path.join(k.where === 'profiles' ? p.profilesDir : p.serverDir, k.file);
}

function notes() { return settings.load().playerNotes || {}; }
function saveNote(id, meta) {
  const n = { ...notes() };
  n[id] = { ...(n[id] || {}), ...meta };
  settings.save({ playerNotes: n });
}

function parseLine(kind, line) {
  const t = line.trim();
  if (!t || t.startsWith('#') || t.startsWith('//')) return null;
  if (kind === 'bebans') {
    const m = t.match(/^(\S+)\s+(-?\d+|perm)\s*(.*)$/);
    return m ? { id: m[1], minutes: m[2], reason: m[3] } : { id: t, minutes: '0', reason: '' };
  }
  const [idPart, ...rest] = t.split(/\s*\/\/\s*/);
  const id = idPart.trim().split(/\s+/)[0];
  const meta = rest.length ? parseComment(rest.join(' ')) : {};
  if (!meta.steamId && isSteam64(id)) meta.steamId = id;
  return { id, ...meta };
}

function read(kind) {
  const file = fileFor(kind);
  const n = notes();
  let entries = [], exists = false;
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    exists = true;
    entries = lines.map(l => parseLine(kind, l)).filter(Boolean);
  } catch { /* missing file */ }
  entries = entries.map(e => {
    const note = n[e.id] || (e.steamId && n[e.steamId]) || {};
    return { ...e, name: e.name || note.name || '', note: e.reason || note.note || '', added: note.added || null };
  });
  return { kind, label: KINDS[kind].label, help: KINDS[kind].help, file, exists, entries };
}

function write(kind, entries) {
  const file = fileFor(kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = entries.map(e => kind === 'bebans'
    ? `${e.id} ${e.minutes || 0}${e.reason ? ' ' + e.reason : ''}`
    : e.id + buildComment({ steamId: e.steamId && e.steamId !== e.id ? e.steamId : (isSteam64(e.id) ? null : e.steamId), discordId: e.discordId, name: e.name, reason: e.reason }));
  fs.writeFileSync(file, lines.join('\r\n') + (lines.length ? '\r\n' : ''), 'utf8');
  return read(kind);
}

// Does a list entry refer to this id (DayZ ID, Steam64 or Discord ID)?
function matches(e, id) { return e.id === id || e.steamId === id || e.discordId === id || (isSteam64(id) && e.id === steamIdToDayzId(id)); }

// Add to a list. A Steam64 is stored as its DayZ ID with a //SteamID64 comment (what the server expects).
function add(kind, entry, meta = {}) {
  let id = String(entry.id || '').trim();
  if (!id) throw new Error('ID is required.');
  if (kind !== 'bebans' && !/^[A-Za-z0-9_=\-]{8,}$/.test(id)) throw new Error('That does not look like a Steam64 ID or DayZ ID.');
  const cur = read(kind).entries.filter(e => !matches(e, id));
  if (kind === 'bebans') cur.push({ id, minutes: String(entry.minutes ?? 0), reason: entry.reason || '' });
  else {
    const steamId = isSteam64(id) ? id : (entry.steamId || null);
    if (steamId) id = steamIdToDayzId(steamId);
    cur.push({ id, steamId, discordId: entry.discordId || meta.discordId || null, name: meta.name || entry.name || '', reason: meta.note || entry.reason || '' });
  }
  const noteKey = kind === 'bebans' ? id : (isSteam64(String(entry.id).trim()) ? String(entry.id).trim() : id);
  saveNote(noteKey, { ...(meta.name ? { name: meta.name } : {}), ...(meta.note ? { note: meta.note } : {}), added: Date.now() });
  return write(kind, cur);
}

function remove(kind, id) {
  const cur = read(kind).entries.filter(e => !matches(e, id));
  return write(kind, cur);
}

function has(kind, id) { return read(kind).entries.some(e => matches(e, id)); }

// Recent players parsed from .ADM / .RPT logs: name, id, last seen, connect count.
function recentPlayers(limit = 200) {
  const p = settings.paths();
  let files = [];
  try { files = fs.readdirSync(p.profilesDir).filter(f => /\.(adm|rpt)$/i.test(f)).map(f => ({ f, m: fs.statSync(path.join(p.profilesDir, f)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 4); } catch { return []; }
  const seen = new Map();
  const n = notes();
  const events = [];
  for (const { f } of files.reverse()) { // oldest first so "last seen" ends up newest
    let text = '';
    try { text = fs.readFileSync(path.join(p.profilesDir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('Player "')) continue;
      const name = (line.match(/Player\s+"([^"]+)"/) || [])[1];
      if (!name) continue;
      const id = (line.match(/\(id=([^\s)]+)/) || [])[1] || null;
      const ev = (line.match(/\b(has been disconnected|is connected|disconnected|connected|kicked|banned)\b/i) || [])[1];
      if (!ev) continue;
      const time = (line.match(/^\s*(\d{1,2}:\d{2}:\d{2})/) || [])[1] || null;
      events.push({ name, id, ev: ev.replace(/^has been /i, '').replace(/^is /i, '').toLowerCase(), time, file: f });
    }
  }
  // First pass: learn which name goes with which id, so lines without an id still group correctly.
  const idByName = new Map();
  for (const e of events) if (e.id) idByName.set(e.name, e.id);
  for (const e of events) {
    const id = e.id || idByName.get(e.name) || null;
    const key = id || e.name;
    const cur = seen.get(key) || { id, name: e.name, connects: 0, lastSeen: null, lastEvent: '', file: e.file };
    cur.name = e.name;
    if (e.ev === 'connected') cur.connects++;
    cur.lastEvent = e.ev;
    cur.lastSeen = e.time || cur.lastSeen;
    cur.file = e.file;
    seen.delete(key); seen.set(key, cur); // re-insert so newest activity sorts last
  }
  return [...seen.values()].slice(-limit).reverse().map(x => ({ ...x, note: x.id && n[x.id] ? n[x.id].note || '' : '' }));
}

function allLists() {
  return { ban: read('ban'), whitelist: read('whitelist'), priority: read('priority'), bebans: read('bebans') };
}

module.exports = { KINDS, read, write, add, remove, has, recentPlayers, allLists, saveNote, steamIdToDayzId, isSteam64 };
