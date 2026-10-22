'use strict';
// Alt-account signals: Steam account facts (age, level, game count, privacy), IP history from RCon,
// shared-IP matching between players, a suspicion score, and an alert when a flagged player joins.
// Nothing here proves an alt; it surfaces the signals a human would look at.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const settings = require('./settings');
const lists = require('./lists');

let db = null, emitRef = () => {}, onlineGuids = new Set(), checking = false;
const file = () => path.join(app.getPath('userData'), 'accounts.json');
function load() { if (!db) { try { db = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { db = {}; } db.ips = db.ips || {}; db.names = db.names || {}; db.steam = db.steam || {}; db.guidBySteam = db.guidBySteam || {}; } return db; }
function save() { try { fs.writeFileSync(file(), JSON.stringify(load())); } catch { /* ignore */ } }
function apiKey() { return ((settings.load().discord || {}).steamApiKey || '').trim(); }
function cfg() { const s = settings.load(); return { alertScore: 4, newAccountDays: 90, fewGames: 3, ...(s.accounts || {}) }; }

// BattlEye GUID = md5("BE" + Steam64 as 8 little-endian bytes). RCon shows this GUID; it lets us link RCon rows to Steam IDs.
function beGuid(steam64) {
  if (!lists.isSteam64(steam64)) return null;
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(steam64));
  return crypto.createHash('md5').update(Buffer.concat([Buffer.from('BE'), b])).digest('hex');
}

// ---------- RCon snapshots → IP history ----------
function record(players) {
  if (!Array.isArray(players) || !players.length) return;
  const d = load(); const now = Date.now(); let changed = false;
  const nowOnline = new Set();
  for (const p of players) {
    if (!p.guid || !/^[0-9a-f]{32}$/i.test(p.guid)) continue;
    const guid = p.guid.toLowerCase(); nowOnline.add(guid);
    const ip = (p.ip || '').split(':')[0];
    if (p.name) d.names[guid] = p.name;
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      const rec = (d.ips[guid] = d.ips[guid] || {});
      if (!rec[ip]) { rec[ip] = { first: now, last: now, count: 0 }; changed = true; }
      if (now - rec[ip].last > 60000) { rec[ip].count++; changed = true; }
      rec[ip].last = now;
    }
    if (!onlineGuids.has(guid)) joined(guid, p.name).catch(() => {});
  }
  onlineGuids = nowOnline;
  if (changed) save();
}

function steamForGuid(guid) {
  const d = load();
  for (const [sid, g] of Object.entries(d.guidBySteam)) if (g === guid) return sid;
  // learn from every Steam64 the tool knows
  const ids = new Set();
  for (const kind of ['whitelist', 'priority', 'ban']) { try { for (const e of lists.read(kind).entries) if (e.steamId) ids.add(e.steamId); } catch { /* ignore */ } }
  try { for (const a of Object.values(require('./discord').store().applications)) if (a.steamId) ids.add(a.steamId); } catch { /* ignore */ }
  for (const sid of ids) { if (!d.guidBySteam[sid]) d.guidBySteam[sid] = beGuid(sid); if (d.guidBySteam[sid] === guid) return sid; }
  return null;
}

// Other GUIDs that used any of this player's IPs.
function sharedIps(guid) {
  const d = load(); const mine = d.ips[guid] || {}; const out = {};
  for (const [other, rec] of Object.entries(d.ips)) {
    if (other === guid) continue;
    const common = Object.keys(rec).filter(ip => mine[ip]);
    if (common.length) out[other] = { name: d.names[other] || other.slice(0, 8), steamId: steamForGuid(other), ips: common };
  }
  return out;
}

// ---------- Steam account facts ----------
async function checkSteam(steamId) {
  const key = apiKey(); if (!key || !lists.isSteam64(steamId)) return null;
  const j = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.ok ? r.json() : null; };
  try {
    const [sum, lvl, games] = await Promise.all([
      j(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${steamId}`),
      j(`https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/?key=${key}&steamid=${steamId}`),
      j(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamId}&include_played_free_games=1`)
    ]);
    const p = sum && sum.response && sum.response.players && sum.response.players[0];
    if (!p) return null;
    const rec = {
      personaName: p.personaname || null, avatar: p.avatarmedium || null, profileUrl: p.profileurl || null,
      isPrivate: p.communityvisibilitystate !== 3,
      created: p.timecreated ? p.timecreated * 1000 : null,
      level: lvl && lvl.response && typeof lvl.response.player_level === 'number' ? lvl.response.player_level : null,
      games: games && games.response && typeof games.response.game_count === 'number' ? games.response.game_count : null,
      ownsDayZ: games && games.response && Array.isArray(games.response.games) ? games.response.games.some(g => g.appid === 221100) : null,
      checkedAt: Date.now()
    };
    load().steam[steamId] = rec; save(); emitRef('accounts:changed', { steamId });
    return rec;
  } catch { return null; }
}
async function checkMany(ids) {
  if (checking) return 0; checking = true; let n = 0;
  try { for (const id of ids) { if (await checkSteam(id)) n++; } } finally { checking = false; }
  return n;
}

// ---------- the summary the player database shows ----------
function score(steamId, guid, names = []) {
  const c = cfg(); const d = load(); const flags = []; let s = 0;
  const st = steamId ? d.steam[steamId] : null;
  let bans = null; try { bans = steamId ? require('./steambans').get(steamId) : null; } catch { /* ignore */ }
  if (bans && (bans.vacBanned || bans.gameBans > 0)) { s += 3; flags.push(bans.vacBanned ? 'VAC banned' : 'game banned'); }
  if (st) {
    if (st.created && Date.now() - st.created < c.newAccountDays * 86400000) { s += 3; flags.push(`account ${Math.max(1, Math.round((Date.now() - st.created) / 86400000))} days old`); }
    if (st.isPrivate) { s += 2; flags.push('private profile'); }
    if (st.level !== null && st.level <= 1) { s += 1; flags.push(`Steam level ${st.level}`); }
    if (st.games !== null && st.games <= c.fewGames) { s += 1; flags.push(`${st.games} game(s) owned`); }
    if (st.ownsDayZ === false) { s += 2; flags.push('DayZ not in library (family sharing?)'); }
  }
  const shared = guid ? sharedIps(guid) : {};
  const sharedList = Object.values(shared);
  if (sharedList.length) { s += 2; flags.push(`shares an IP with ${sharedList.map(x => x.name).slice(0, 3).join(', ')}${sharedList.length > 3 ? ' +' + (sharedList.length - 3) : ''}`); }
  return { score: s, flags, shared, steam: st || null };
}
function summary({ steamId, names = [] }) {
  const d = load();
  let guid = steamId ? (d.guidBySteam[steamId] || (d.guidBySteam[steamId] = beGuid(steamId))) : null;
  if (!guid) { for (const [g, n] of Object.entries(d.names)) if (names.includes(n)) { guid = g; break; } }
  const ips = guid ? Object.entries(d.ips[guid] || {}).map(([ip, r]) => ({ ip, ...r })).sort((a, b) => b.last - a.last) : [];
  const sc = score(steamId, guid, names);
  const q = steamId || names[names.length - 1] || '';
  return { guid, ips, ...sc, battlemetricsUrl: q ? `https://www.battlemetrics.com/players?filter[search]=${encodeURIComponent(q)}` : null, suspicious: sc.score >= cfg().alertScore };
}

// A player just appeared in the RCon list: alert if they look suspicious.
async function joined(guid, name) {
  const steamId = steamForGuid(guid);
  if (steamId && !load().steam[steamId] && apiKey()) await checkSteam(steamId);
  const sc = score(steamId, guid, [name]);
  if (sc.score < cfg().alertScore) return;
  try { require('./alerts').alert('suspicious-player', `Flagged player joined: ${name || guid.slice(0, 8)}`, `${steamId ? 'Steam64 ' + steamId + '\n' : ''}Score ${sc.score}: ${sc.flags.join('; ')}`); } catch { /* ignore */ }
}

function stats() { const d = load(); return { tracked: Object.keys(d.ips).length, steamChecked: Object.keys(d.steam).length, hasKey: !!apiKey() }; }
function init(emit) { emitRef = emit; load(); }

module.exports = { init, record, checkSteam, checkMany, summary, stats, cfg };
