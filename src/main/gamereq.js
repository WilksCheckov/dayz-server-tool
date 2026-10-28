'use strict';
// Moderation from the game (DRP_Admin, plan steps B3/B4). The mod appends one line per request to
// $profile:DayZAdminTools/requests_in.jsonl; the app runs it through its own code and answers in requests_out.json,
// which the mod reads every 10 s to tell the admin how it went and to run approved actions.
//   ban        target, reason, note, days (0 = permanent)  -> the Discord bot's ban (lists, Discord notice, expiry)
//   list       kind whitelist | priority, on               -> whitelist.txt / priority.txt
//   watch      confidence, reason, note, on                -> the watchlist
//   approval   rid, cat, desc                              -> a portal request; the decision goes back to the game
// Every request names the admin (Steam64); the app checks their in-game permissions again before doing anything.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const jsonstore = require('./jsonstore');
const settings = require('./settings');

const MAX_RESULTS = 60;
let db = null, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'gamereq.json');
function load() { if (!db) db = { file: { offset: 0, rest: '' }, results: [], approvals: {}, ...(jsonstore.readOr(file(), null) || {}) }; return db; }
function saveDb() { jsonstore.write(file(), load()); }
const dir = () => path.join(settings.paths().profilesDir, 'DayZAdminTools');

// the admin's in-game permissions, as admins.json gives them to the mod ("*" = everything)
function adminPerms(steam) {
  let admins = []; try { admins = require('./drpadmin').computeAdmins(); } catch { /* none */ }
  const a = admins.find(x => x.steam === steam); return a ? a.perms : null;
}
function may(steam, perm) { const p = adminPerms(steam); return !!p && (p.includes('*') || p.includes(perm)); }
const who = (j) => `${(j.by && j.by.name) || 'admin'} (in game)`;

function result(j, ok, text) {
  const d = load(); d.results.push({ rid: String(j.rid || ''), steam: (j.by && j.by.steam) || '', ok: !!ok, text: String(text).slice(0, 200), ts: Date.now() });
  if (d.results.length > MAX_RESULTS) d.results.splice(0, d.results.length - MAX_RESULTS);
}

async function apply(j) {
  const by = j.by || {}; const t = j.target || {};
  if (!/^7656\d{13}$/.test(String(by.steam || ''))) throw new Error('no admin on the request');
  if (j.op === 'ban') {
    if (!may(by.steam, 'players.ban')) return result(j, false, 'You may not ban (players.ban).');
    if (!/^7656\d{13}$/.test(String(t.steam || ''))) return result(j, false, 'No Steam64 for that player.');
    const days = Math.max(0, Math.min(3650, Number(j.days) || 0));
    const reason = String(j.reason || '').trim().slice(0, 200);
    if (!reason) return result(j, false, 'A ban needs a reason.');
    const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
    await require('./discord').banUser({ steamId: t.steam, discordId: null, name: t.name || '', reason: j.note ? `${reason} (note: ${String(j.note).slice(0, 200)})` : reason, bannedBy: null, expiresAt });
    try { require('./adminlog').record({ action: 'ban', by: who(j), source: 'game', target: { name: t.name || t.steam, steam: t.steam }, details: days ? `${days} day(s)` : 'permanent', reason, result: { status: 'done' } }); } catch { /* ignore */ }
    return result(j, true, `${t.name || t.steam} banned ${days ? 'for ' + days + ' day(s)' : 'permanently'}.`);
  }
  if (j.op === 'list') {
    const kind = j.kind === 'priority' ? 'priority' : j.kind === 'whitelist' ? 'whitelist' : null;
    if (!kind) return result(j, false, 'Unknown list.');
    if (!may(by.steam, 'lists.manage')) return result(j, false, 'You may not change the lists (lists.manage).');
    if (!/^7656\d{13}$/.test(String(t.steam || ''))) return result(j, false, 'No Steam64 for that player.');
    const lists = require('./lists');
    if (j.on) lists.add(kind, { id: t.steam, name: t.name || '', reason: `added in game by ${by.name || by.steam}` }, { name: t.name || '', note: `added in game by ${by.name || by.steam}` });
    else lists.remove(kind, t.steam);
    try { require('./audit').log('game', who(j), `${kind} ${j.on ? 'add' : 'remove'}`, t.name || t.steam); } catch { /* ignore */ }
    return result(j, true, `${t.name || t.steam} ${j.on ? 'added to' : 'removed from'} the ${kind === 'priority' ? 'priority queue' : 'whitelist'}.`);
  }
  if (j.op === 'watch') {
    if (!may(by.steam, 'admin.players')) return result(j, false, 'You may not change the watchlist (admin.players).');
    const wl = require('./watchlist');
    if (!j.on) { wl.remove(t.guid || t.steam, who(j)); return result(j, true, `${t.name || t.steam} taken off the watchlist.`); }
    wl.add({ guid: t.guid, steam: t.steam, name: t.name, confidence: j.confidence, reason: j.reason, note: j.note }, who(j), 'game');
    return result(j, true, `${t.name || t.steam} is on the watchlist.`);
  }
  if (j.op === 'approval') {
    const rid = String(j.rid || ''); if (!rid) return result(j, false, 'No request id.');
    try {
      const r = require('./portal').requestFromGame(by.steam, j.cat, String(j.desc || '').slice(0, 200), rid, String(j.reason || ''));
      load().approvals[rid] = { status: 'pending', portal: r.id, ts: Date.now() };
      return result(j, true, `Sent for approval (#R${r.id}).`);
    } catch (e) { load().approvals[rid] = { status: 'denied', ts: Date.now() }; return result(j, false, 'Not sent for approval: ' + e.message); }
  }
  throw new Error('unknown operation ' + j.op);
}

// portal.js: a request from the game was decided
function decided(rid, approved, byName) {
  const d = load(); d.approvals[rid] = { ...(d.approvals[rid] || {}), status: approved ? 'approved' : 'denied', by: byName || '', ts: Date.now() };
  saveDb(); writeOut();
}

function writeOut() {
  try {
    if (!fs.existsSync(settings.paths().profilesDir)) return;
    fs.mkdirSync(dir(), { recursive: true });
    const d = load(); const week = Date.now() - 7 * 86400000;
    for (const [k, v] of Object.entries(d.approvals)) if (v.ts < week) delete d.approvals[k];
    const approvals = Object.entries(d.approvals).filter(([, v]) => v.status !== 'pending').map(([rid, v]) => ({ rid, status: v.status, by: v.by || '' }));
    const f = path.join(dir(), 'requests_out.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify({ results: d.results, approvals }, null, 1)); fs.renameSync(f + '.tmp', f);
  } catch { /* no server folder */ }
}

let lastExpiry = 0;
async function ingest() {
  // temporary bans run out even while the Discord bot is off
  if (Date.now() - lastExpiry > 60000) { lastExpiry = Date.now(); try { await require('./discord').checkExpiredBans(); } catch { /* bot module */ } }
  const d = load(); const f = path.join(dir(), 'requests_in.jsonl');
  let st; try { st = fs.statSync(f); } catch { return 0; }
  if (st.size < d.file.offset) { d.file.offset = 0; d.file.rest = ''; }
  if (st.size === d.file.offset) return 0;
  const fd = fs.openSync(f, 'r'); const lines = [];
  try {
    const len = Math.min(st.size - d.file.offset, 1024 * 1024); const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, d.file.offset); d.file.offset += n;
    const parts = (d.file.rest + buf.toString('utf8', 0, n)).split(/\r?\n/); d.file.rest = parts.pop() || '';
    for (const l of parts) { if (!l.trim()) continue; try { lines.push(JSON.parse(l)); } catch { /* broken line */ } }
  } finally { fs.closeSync(fd); }
  let done = 0;
  for (const j of lines) {
    try { await apply(j); done++; } catch (e) { result(j, false, e.message); emitRef('console', { source: 'gamereq', line: `In-game request ${j.op || '?'} not done: ${e.message}` }); }
  }
  saveDb(); writeOut();
  return done;
}

function init(emit) { emitRef = emit; load(); writeOut(); }
module.exports = { init, ingest, apply, decided, writeOut, may };
