'use strict';
// In-game tickets (DRP_Admin): players open and answer tickets in game (key K), admins work them in game, in the app,
// the portal or Discord. They are ordinary tickets (tickets.js) with a `game` part (reporter, category, context) and a
// `messages` conversation the player sees; internal notes stay internal.
//
// Game → app: the server mod appends one JSON line per action to profiles/DayZAdminTools/tickets_in.jsonl:
//   { op: create|reply|seen|admin_reply|admin_note|claim|close|reopen|refund, ... }
// App → game: after every ticket change, profiles/DayZAdminTools/tickets_out/<steam64>.json (that player's tickets as
// the player may see them, an unread count, a counter that moves on every admin reply) and tickets_out/_admin.json
// (open and recent tickets with everything an admin needs). Files are rewritten only when their content changed.
// Tickets opened while the app is closed wait in the file and are picked up when it reads it.
const fs = require('fs');
const path = require('path');
const jsonstore = require('./jsonstore');
const { app } = require('electron');
const settings = require('./settings');

// urgency the player picks; the admin list sorts by it
const URGENCY = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const URGENCY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const CATEGORIES = { death: 'I died / lost gear', report: 'Report a player', base: 'Base or building', bug: 'Bug', question: 'Question', other: 'Other' };
const DEATH_WINDOW_MS = 30 * 60000;		// a death this recent is linked to a new ticket automatically
const ADMIN_RECENT_MS = 24 * 3600000;	// closed tickets stay in the in-game admin list this long
let db = null, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'gametickets.json');
function load() { if (db) return db; db = { file: { offset: 0, rest: '' }, ...(jsonstore.readOr(file(), null) || {}) }; return db; }
function saveDb() { jsonstore.write(file(), load()); }
function dir() { return path.join(settings.paths().profilesDir, 'DayZAdminTools'); }
function inFile() { return path.join(dir(), 'tickets_in.jsonl'); }
function outDir() { return path.join(dir(), 'tickets_out'); }
const tickets = () => require('./tickets');

// ---------- game → app ----------
function ingest() {
  const d = load(); const f = inFile();
  let st; try { st = fs.statSync(f); } catch { return 0; }
  const meta = d.file;
  if (st.size < meta.offset) { meta.offset = 0; meta.rest = ''; }
  if (st.size === meta.offset) return 0;
  const fd = fs.openSync(f, 'r'); const lines = [];
  try {
    const len = Math.min(st.size - meta.offset, 4 * 1024 * 1024); const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, meta.offset); meta.offset += n;
    const parts = (meta.rest + buf.toString('utf8', 0, n)).split(/\r?\n/); meta.rest = parts.pop() || '';
    for (const l of parts) { if (!l.trim()) continue; try { lines.push(JSON.parse(l)); } catch { /* broken line */ } }
  } finally { fs.closeSync(fd); }
  saveDb();
  let applied = 0;
  for (const j of lines) { try { if (apply(j)) applied++; } catch (e) { emitRef('console', { source: 'tickets', line: `In-game ticket ${j.op || '?'} not applied: ${e.message}` }); } }
  return applied;
}

const byRef = (ref) => tickets().all().find(t => t.game && t.game.ref === ref);
const isPlayers = (t, steam) => t && t.game && t.game.steam === steam;
function adminBy(j) { return `${j.by || 'admin'} (in game)`; }
// The reporter's in-game name, Steam64 and GUID are filled in by the server from the identity (never typed) and kept
// on the ticket when it is made; a staff reply keeps who answered.
const staffIdent = (j) => ({ name: j.by || '', steam: j.bySteam || '', guid: j.byGuid || '' });

function apply(j) {
  const T = tickets();
  if (j.op === 'create') {
    if (!j.steam || !j.ref || byRef(j.ref)) return false;	// a line read twice opens one ticket
    const cat = CATEGORIES[j.category] ? j.category : 'other';
    const title = String(j.title || '').trim().slice(0, 100) || CATEGORIES[cat];
    const urgency = URGENCY[j.urgency] ? j.urgency : 'normal';
    const t = T.create({ subject: `[${CATEGORIES[cat]}${urgency === 'high' || urgency === 'urgent' ? ' · ' + URGENCY[urgency] : ''}] ${title}`, description: String(j.text || '').slice(0, 1500), player: j.name || j.steam, by: `${j.name || j.steam} (player, in game)` });
    T.patch(t.id, (s) => {
      s.game = { steam: j.steam, guid: j.guid || null, name: j.name || '', category: cat, urgency, ref: j.ref, title, context: j.context || {}, noticeId: 0, seenAt: null };
      s.messages = [{ ts: new Date().toISOString(), by: j.name || j.steam, role: 'player', text: String(j.text || '').slice(0, 1500) || title }];
    });
    // the player's death in the last half hour (from the app's death log) is linked at once
    try {
      const dl = require('./deathlog');
      const recent = dl.forPlayer(j.guid || j.steam, 5).find(r => Date.now() - r.ts <= DEATH_WINDOW_MS);
      if (recent) T.link(t.id, recent.id, 'game');
    } catch { /* no death log */ }
    emitRef('console', { source: 'tickets', line: `In-game ticket #${t.id} from ${j.name}: ${title}` });
    try { require('./discord').postAdminAction({ title: `🎫 New in-game ticket #${t.id}`, color: 0x4f8cff, fields: [{ name: 'Player', value: `${j.name || '?'}\nSteam64 ${j.steam}\nGUID ${j.guid || '?'}`, inline: true }, { name: 'Type', value: CATEGORIES[cat], inline: true }, { name: 'Urgency', value: URGENCY[urgency], inline: true }, { name: title.slice(0, 250), value: String(j.text || '—').slice(0, 1000) }] }).catch(() => {}); } catch { /* bot not loaded */ }
    return true;
  }
  const t = T.all().find(x => x.id === T.pad(j.ticket || ''));
  if (!t) throw new Error(`no ticket #${j.ticket}`);
  switch (j.op) {
    case 'reply':
      if (!isPlayers(t, j.steam)) throw new Error('not their ticket');
      if (t.status !== 'open') throw new Error('the ticket is closed');
      T.message(t.id, j.text, `${j.name || t.player} (player, in game)`, 'player'); return true;
    case 'seen':
      if (!isPlayers(t, j.steam)) return false;
      T.patch(t.id, (s) => { s.game.seenAt = new Date().toISOString(); }); return true;
    case 'admin_reply': T.message(t.id, j.text, adminBy(j), 'admin', staffIdent(j)); return true;
    case 'admin_note': T.note(t.id, j.text, `${adminBy(j)} · ${j.bySteam || '?'} · ${j.byGuid || '?'}`); return true;
    case 'claim': T.assign(t.id, j.by, adminBy(j)); return true;
    case 'close': T.setStatus(t.id, 'closed', adminBy(j), String(j.text || '')); return true;
    case 'reopen': T.setStatus(t.id, 'open', adminBy(j)); return true;
    case 'refund': refund(t, j); return true;
    default: throw new Error('unknown operation');
  }
}

// a refund asked for in game runs through the app's own refund (gear snapshot, body removal, audit, Discord)
function refund(t, j) {
  const deathId = Number(j.death) || (t.deaths || [])[t.deaths.length - 1];
  if (!deathId) throw new Error('no death linked to this ticket');
  const dl = require('./deathlog'); const d = dl.get(deathId); if (!d) throw new Error(`no death record #${deathId}`);
  const by = adminBy(j);
  dl.refund(deathId, { by }).then(r => {
    try { require('./adminlog').record({ action: 'refund', by, source: 'game', target: { name: d.name, steam: d.key }, details: `death #${deathId}: ${r.items} item(s)`, reason: `#${t.id}`, result: r }); } catch { /* ignore */ }
    tickets().note(t.id, `Refund of death #${deathId}: ${r.status}${r.ok !== undefined ? ` (${r.ok} items)` : ''}`, by);
  }).catch(e => { try { tickets().note(t.id, `Refund of death #${deathId} failed: ${e.message}`, by); } catch { /* ignore */ } });
}

// ---------- app → game ----------
function lastAdminTs(t) { const m = (t.messages || []).filter(x => x.role === 'admin').pop(); return m ? m.ts : null; }
function playerView(t) {
  return { id: t.id, sref: t.game ? t.game.ref : '', title: (t.game && t.game.title) || t.subject, category: t.game ? t.game.category : 'other', urgency: t.game ? t.game.urgency || 'normal' : 'normal', status: t.status, createdAt: t.createdAt,
    messages: (t.messages || []).slice(-30).map(m => ({ ts: m.ts, by: m.role === 'admin' ? 'Admin' : m.by, role: m.role, text: m.text })) };
}
function deathInfo(t) {
  const ids = t.deaths || []; if (!ids.length) return { deathId: 0, deathX: 0, deathZ: 0, deathText: '' };
  try {
    const d = require('./deathlog').get(ids[ids.length - 1]);
    if (d) return { deathId: d.id, deathX: d.deathPos ? d.deathPos[0] : 0, deathZ: d.deathPos ? d.deathPos[1] : 0, deathText: `#${d.id} ${d.causeText}${d.weapon ? ' with ' + d.weapon : ''}${d.gear ? `, ${d.gear.length} items` : ''}${(d.refunds || []).some(f => f.status === 'done' && f.ok > 0) ? ', refunded' : ''}` };
  } catch { /* no death log */ }
  return { deathId: ids[ids.length - 1], deathX: 0, deathZ: 0, deathText: `#${ids[ids.length - 1]}` };
}
function adminView(t) {
  const g = t.game || {}; const c = g.context || {};
  const nearby = Array.isArray(c.nearby) ? c.nearby.map(n => `${n.name} (${Math.round(n.dist)} m)`).join(', ') : '';
  const death = deathInfo(t);
  // the server's own record of the last death, when the app has none
  if (!death.deathText && c.death && c.death.x) Object.assign(death, { deathX: c.death.x, deathZ: c.death.z, deathText: `${c.death.cause || 'died'} ${c.death.ago ? Math.round(c.death.ago / 60) + ' min before the ticket' : ''}`.trim() });
  return { id: t.id, title: t.subject, category: g.category || '', urgency: g.urgency || 'normal', status: t.status, player: t.player || '', steam: g.steam || '', guid: g.guid || '', assignee: t.assignee || '', createdAt: t.createdAt,
    source: g.steam ? 'game' : t.channelId ? 'discord' : 'app', description: t.description || '',
    messages: (t.messages || []).slice(-30).map(m => ({ ts: m.ts, by: m.by, role: m.role, text: m.text, name: m.name || '', steam: m.steam || '', guid: m.guid || '' })),
    notes: (t.notes || []).filter(n => !String(n.text).startsWith('[player]') && !String(n.text).startsWith('[to player]')).slice(-15).map(n => ({ ts: n.ts, by: n.by, role: 'note', text: n.text })),
    x: c.x || 0, z: c.z || 0, nearby, ...death };
}
function writeIfChanged(f, obj) {
  const text = JSON.stringify(obj, null, 1);
  let cur = null; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* new */ }
  if (cur === text) return false;
  fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); return true;
}
function writeOut() {
  if (!fs.existsSync(settings.paths().profilesDir)) return 0;
  fs.mkdirSync(outDir(), { recursive: true });
  const all = tickets().all(); let written = 0;
  // per player: their in-game tickets, newest first
  const bySteam = {};
  for (const t of all) if (t.game && t.game.steam) (bySteam[t.game.steam] = bySteam[t.game.steam] || []).push(t);
  for (const [steam, list] of Object.entries(bySteam)) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const unread = list.filter(t => { const a = lastAdminTs(t); return a && (!t.game.seenAt || a > t.game.seenAt); }).length;
    const noticeId = list.reduce((n, t) => n + (t.game.noticeId || 0), 0);
    if (writeIfChanged(path.join(outDir(), steam + '.json'), { unread, noticeId, tickets: list.slice(0, 20).map(playerView) })) written++;
  }
  // admins: open tickets and those closed in the last day, newest first, at most 60
  const since = Date.now() - ADMIN_RECENT_MS;
  const shown = all.filter(t => t.status === 'open' || (t.closedAt && Date.parse(t.closedAt) >= since)).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (URGENCY_RANK[(a.game || {}).urgency] ?? 2) - (URGENCY_RANK[(b.game || {}).urgency] ?? 2) || b.createdAt.localeCompare(a.createdAt)).slice(0, 60);
  const latest = all.reduce((m, t) => (t.id > m ? t.id : m), '');
  const latestT = all.find(t => t.id === latest);
  if (writeIfChanged(path.join(outDir(), '_admin.json'), { latestId: latest, latestTitle: latestT ? latestT.subject : '', open: all.filter(t => t.status === 'open').length, unassigned: all.filter(t => t.status === 'open' && !t.assignee).length, tickets: shown.map(adminView) })) written++;
  return written;
}

function init(emit) { emitRef = emit; load(); try { writeOut(); } catch { /* no server folder yet */ } }
module.exports = { init, ingest, writeOut, apply, CATEGORIES, URGENCY };
