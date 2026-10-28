'use strict';
// Watchlist (LBmaster's "watchlist"): players staff want an eye on, with a confidence and a note. Added from the app
// (Statistics page, Player database), from the game (DRP_Admin's Player info) or automatically when a player's
// suspicious-activity score reaches the alert level. When one joins, admins get an alert (the app's alert channels,
// Discord) and DRP_Admin tells the admins in game: the mod reads DayZAdminTools/watchlist.json, written here.
// Keyed by the DayZ id (GUID) the admin log uses; the Steam64 is kept when known.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const jsonstore = require('./jsonstore');
const settings = require('./settings');

const CONFIDENCE = { low: 'Low', medium: 'Medium', high: 'High' };
const SOURCES = { app: 'the app', game: 'in game', auto: 'automatic (suspicious activity)' };
let db = null, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'watchlist.json');
function load() { if (!db) { db = jsonstore.readOr(file(), { entries: {} }) || { entries: {} }; db.entries = db.entries || {}; } return db; }
function save() { jsonstore.write(file(), load()); writeOut(); emitRef('watchlist:changed', {}); }
function cfg() { return { autoFromFlags: true, alertJoins: true, ...(settings.load().watchlist || {}) }; }

// the DayZ id for a Steam64 (the same hash the server uses), so either one finds the entry
function keyOf({ guid, steam }) {
  if (guid) return String(guid);
  if (steam && /^7656\d{13}$/.test(String(steam))) return require('./lists').steamIdToDayzId(String(steam));
  throw new Error('Give a Steam64 id or the player\'s DayZ id.');
}
function find(idOrSteam) {
  const d = load(); const s = String(idOrSteam || '');
  if (d.entries[s]) return d.entries[s];
  if (/^7656\d{13}$/.test(s)) { const k = require('./lists').steamIdToDayzId(s); if (d.entries[k]) return d.entries[k]; }
  return Object.values(d.entries).find(e => e.steam === s) || null;
}

function add({ guid, steam, name, confidence = 'medium', reason = '', note = '' }, by = 'app', source = 'app') {
  const key = keyOf({ guid, steam });
  if (!CONFIDENCE[confidence]) confidence = 'medium';
  reason = String(reason || '').trim().slice(0, 200);
  if (!reason && source !== 'auto') throw new Error('Give a reason for watching this player.');
  const d = load(); const was = d.entries[key];
  // a name from the player database when none was given
  if (!name) { try { const p = require('./players').get(key); if (p) name = p.name; } catch { /* no player db */ } }
  d.entries[key] = { ...(was || { joins: 0, lastJoinAt: null, addedAt: new Date().toISOString() }), guid: key, steam: steam || (was && was.steam) || null, name: String(name || (was && was.name) || '').slice(0, 64), confidence, reason: reason || (was && was.reason) || '', note: String(note || '').slice(0, 500) || (was && was.note) || '', by, source, updatedAt: new Date().toISOString() };
  save(); audit(by, was ? 'watchlist updated' : 'watchlist added', `${d.entries[key].name || key} (${CONFIDENCE[confidence]}): ${d.entries[key].reason}`);
  return d.entries[key];
}
function remove(idOrSteam, by = 'app') {
  const e = find(idOrSteam); if (!e) throw new Error('That player is not on the watchlist.');
  delete load().entries[e.guid]; save(); audit(by, 'watchlist removed', e.name || e.guid);
  return true;
}

// every entry with what the app knows about the player: online, playtime, sessions, deaths, suspicious-activity score
function list() {
  const out = [];
  for (const e of Object.values(load().entries)) {
    let p = null; try { p = require('./players').get(e.guid); } catch { /* no player db */ }
    let c = null; try { const cb = require('./combat'); c = cb.forPlayer(e.guid) || (e.name ? cb.forPlayer(e.name) : null); } catch { /* no combat data */ }
    out.push({ ...e, online: !!(p && p.online), lastSeen: p ? p.lastSeen : null, playtimeSec: p ? p.playtimeSec : 0, sessions: p ? (p.sessions || []).length : 0, kills: p ? p.kills : 0, deaths: p ? p.deaths : 0, steam: e.steam || (p && p.steamId) || null, flagScore: c ? c.flagScore : 0, flags: c ? c.flags : [] });
  }
  return out.sort((a, b) => (b.online - a.online) || ((CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
const CONF_RANK = { low: 1, medium: 2, high: 3 };

// players.js: a player connected
function onConnect(ev) {
  if (!cfg().alertJoins || !ev || !ev.id) return;
  const e = load().entries[ev.id]; if (!e) return;
  e.joins = (e.joins || 0) + 1; e.lastJoinAt = new Date(ev.ts || Date.now()).toISOString(); if (ev.name) e.name = ev.name;
  jsonstore.write(file(), load()); emitRef('watchlist:changed', {});
  try { require('./alerts').alert('watchlist-join', `Watched player joined: ${e.name || e.guid}`, `${CONFIDENCE[e.confidence] || ''} confidence: ${e.reason}${e.note ? '\nNote: ' + e.note : ''}${e.steam ? '\nSteam64 ' + e.steam : ''}`); } catch { /* alerts off */ }
  emitRef('console', { source: 'watchlist', line: `Watched player joined: ${e.name || e.guid} (${e.reason})` });
}

// combat.js: a player's suspicious-activity score reached the alert level
function autoFlag(key, name, score, alertScore, summary) {
  if (!cfg().autoFromFlags || !key) return;
  const d = load(); const e = d.entries[key];
  // staff decisions win: an entry added by hand is never overwritten
  if (e && e.source !== 'auto') return;
  const confidence = score >= alertScore * 2 ? 'high' : 'medium';
  if (e && e.confidence === confidence) return;
  add({ guid: key, name, confidence, reason: `Suspicious activity, score ${score}`, note: summary }, 'automatic', 'auto');
}

// for the mod: who is watched, and why (staff see this in game)
function writeOut() {
  try {
    const dir = path.join(settings.paths().profilesDir, 'DayZAdminTools');
    if (!fs.existsSync(settings.paths().profilesDir)) return;
    fs.mkdirSync(dir, { recursive: true });
    const entries = Object.values(load().entries).map(e => ({ guid: e.guid, steam: e.steam || '', name: e.name || '', confidence: e.confidence, reason: e.reason, note: e.note || '', by: e.by || '' }));
    const f = path.join(dir, 'watchlist.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify({ entries }, null, 1)); fs.renameSync(f + '.tmp', f);
  } catch { /* no server folder */ }
}
function audit(by, action, details) { try { require('./audit').log('app', by, action, details); } catch { /* ignore */ } }

function init(emit) { emitRef = emit; load(); writeOut(); }
module.exports = { init, add, remove, find, list, onConnect, autoFlag, writeOut, cfg, CONFIDENCE, SOURCES };
