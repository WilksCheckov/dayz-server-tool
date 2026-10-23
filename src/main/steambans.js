'use strict';
// Steam ban checks (VAC, game, trade, community bans and profile privacy) for every Steam64 the tool knows.
// Results are stored in userData/steam-bans.json so the pages can show them without calling Steam,
// and everyone is re-checked once a day so a ban that lands after acceptance is noticed.
const fs = require('fs');
const jsonstore = require('./jsonstore');
const path = require('path');
const { app } = require('electron');
const settings = require('./settings');
const lists = require('./lists');

let cache = null, timer = null, running = false, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'steam-bans.json');
function load() { if (!cache) { cache = jsonstore.readOr(file(), {}); } return cache; }
function save() { jsonstore.write(file(), load(), true); }
function apiKey() { return ((settings.load().discord || {}).steamApiKey || '').trim(); }

function get(steamId) { return steamId ? load()[steamId] || null : null; }
function all() { return load(); }
function flagged(r) { return !!(r && (r.vacBanned || r.gameBans > 0 || r.tradeBanned || r.communityBanned)); }
function summary(r) {
  if (!r) return 'Not checked';
  const parts = [];
  if (r.vacBanned) parts.push(`VAC banned (${r.vacBans})`);
  if (r.gameBans > 0) parts.push(`${r.gameBans} game ban${r.gameBans > 1 ? 's' : ''}`);
  if (r.tradeBanned) parts.push('trade banned');
  if (r.communityBanned) parts.push('community banned');
  if (!parts.length) parts.push('clean');
  if (r.isPrivate) parts.push('private profile');
  if (r.daysSinceLastBan > 0 && (r.vacBanned || r.gameBans > 0)) parts.push(`last ban ${r.daysSinceLastBan} days ago`);
  return parts.join(', ');
}

// Query Steam for up to 100 ids per request. Returns { steamId: record } for the ids Steam answered for.
async function fetchMany(ids) {
  const key = apiKey();
  if (!key) throw new Error('No Steam Web API key set on the Discord Bot page.');
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const [b, s] = await Promise.all([
      fetch(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${key}&steamids=${chunk.join(',')}`).then(r => { if (!r.ok) throw new Error(`Steam API HTTP ${r.status}`); return r.json(); }),
      fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${chunk.join(',')}`).then(r => r.ok ? r.json() : { response: { players: [] } })
    ]);
    const sums = {}; for (const p of ((s && s.response && s.response.players) || [])) sums[p.steamid] = p;
    for (const p of ((b && b.players) || [])) {
      const sum = sums[p.SteamId] || {};
      out[p.SteamId] = { vacBanned: !!p.VACBanned, vacBans: p.NumberOfVACBans || 0, gameBans: p.NumberOfGameBans || 0, tradeBanned: p.EconomyBan !== 'none', communityBanned: !!p.CommunityBanned, daysSinceLastBan: p.DaysSinceLastBan || 0, isPrivate: sum.communityvisibilitystate !== undefined ? sum.communityvisibilitystate !== 3 : null, personaName: sum.personaname || null, checkedAt: Date.now() };
    }
  }
  return out;
}

// Check one id now and store the result. Returns the record (null when Steam gave nothing or no key is set).
async function check(steamId) {
  if (!lists.isSteam64(steamId) || !apiKey()) return null;
  try {
    const r = await fetchMany([steamId]);
    if (r[steamId]) { load()[steamId] = r[steamId]; save(); emitRef('steam:changed', {}); }
    return r[steamId] || null;
  } catch { return null; }
}

// Every Steam64 the tool knows: lists, Discord applications and bans, player database.
function knownIds() {
  const ids = new Set();
  for (const kind of ['whitelist', 'priority', 'ban']) { try { for (const e of lists.read(kind).entries) if (e.steamId && lists.isSteam64(e.steamId)) ids.add(e.steamId); } catch { /* ignore */ } }
  try { const st = require('./discord').store(); for (const a of Object.values(st.applications)) if (lists.isSteam64(a.steamId)) ids.add(a.steamId); for (const b of st.bans) if (lists.isSteam64(b.steamId)) ids.add(b.steamId); } catch { /* ignore */ }
  try { for (const p of require('./players').all({ limit: 100000 })) if (p.steamId && lists.isSteam64(p.steamId)) ids.add(p.steamId); } catch { /* ignore */ }
  return [...ids];
}

// Re-check everyone. New bans on players who are whitelisted or have an accepted application raise an alert,
// and the Discord application embeds are refreshed with the new fields.
async function checkAll({ silent = false } = {}) {
  if (running) return { checked: 0, newBans: [], skipped: 'already running' };
  running = true;
  try {
    const ids = knownIds();
    if (!ids.length) return { checked: 0, newBans: [] };
    const fresh = await fetchMany(ids);
    const prev = load();
    const newBans = [];
    for (const [id, r] of Object.entries(fresh)) {
      const old = prev[id];
      const was = old ? (old.vacBans || 0) + (old.gameBans || 0) + (old.tradeBanned ? 1 : 0) + (old.communityBanned ? 1 : 0) : 0;
      const now = r.vacBans + r.gameBans + (r.tradeBanned ? 1 : 0) + (r.communityBanned ? 1 : 0);
      if (old && now > was) newBans.push({ steamId: id, ...r });
      prev[id] = r;
    }
    save(); emitRef('steam:changed', { checked: Object.keys(fresh).length, newBans: newBans.length });
    try { await require('./accounts').checkMany(ids); } catch { /* ignore */ }
    if (newBans.length && !silent) {
      try {
        const alerts = require('./alerts');
        const names = newBans.map(b => `${b.personaName || b.steamId} (${b.steamId}): ${summary(b)}`);
        await alerts.alert('steam-ban', `${newBans.length} player${newBans.length > 1 ? 's' : ''} picked up a new Steam ban`, names.join('\n'), { force: true });
      } catch { /* ignore */ }
    }
    try { await require('./discord').refreshApplicationEmbeds(newBans.length ? null : undefined); } catch { /* bot offline */ }
    return { checked: Object.keys(fresh).length, newBans, lastRun: Date.now() };
  } finally { running = false; }
}

function state() { const d = load(); const ts = Object.values(d).map(r => r.checkedAt || 0); return { count: ts.length, lastCheck: ts.length ? Math.max(...ts) : null, hasKey: !!apiKey(), running }; }

function init(emit) {
  emitRef = emit;
  load();
  clearInterval(timer);
  // once a day, first pass a minute after start so the bot and lists are loaded
  const daily = () => checkAll().catch(e => { emitRef('console', { source: 'steam', line: `Daily Steam ban check failed: ${e.message}. New VAC / game bans are not detected until it works again (check the Steam API key on the Discord Bot page).` }); try { require('./alerts').alert('update-failed', 'Daily Steam ban check failed', e.message); } catch { /* ignore */ } });
  timer = setInterval(() => { if (apiKey()) daily(); }, 24 * 3600 * 1000);
  setTimeout(() => { const st = state(); if (apiKey() && (!st.lastCheck || Date.now() - st.lastCheck > 20 * 3600 * 1000)) daily(); }, 60 * 1000);
}

module.exports = { init, get, all, check, checkAll, state, summary, flagged };
