'use strict';
// Combat statistics from the admin log: damage dealt and taken, hits by weapon, body parts, kill distances,
// kills per weapon per player, rivalries and base-building actions. Aggregated counters in userData/combat.json.
const fs = require('fs');
const jsonstore = require('./jsonstore');
const path = require('path');
const { app } = require('electron');

let db = null, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'combat.json');
function load() { if (!db) { db = jsonstore.readOr(file(), {}); db.players = db.players || {}; db.weapons = db.weapons || {}; db.parts = db.parts || {}; db.pairs = db.pairs || {}; db.totals = db.totals || { hits: 0, damage: 0, kills: 0, pveHitsTaken: 0 }; } return db; }
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { jsonstore.write(file(), load()); }, 2000); }
function player(key, name) { const d = load(); if (!d.players[key]) d.players[key] = { name, dealt: 0, taken: 0, hits: 0, hitsTaken: 0, headshots: 0, kills: 0, killsBy: {}, deathsBy: {}, longestKill: 0, distSum: 0, distN: 0, builds: 0, pveTaken: 0, parts: {}, hitDistSum: 0, hitDistN: 0, recentHits: [], recentKills: [], lastPos: null, flags: {}, flagScore: 0, lastFlagAt: 0 }; const p = d.players[key]; if (name) p.name = name; p.parts = p.parts || {}; p.recentHits = p.recentHits || []; p.recentKills = p.recentKills || []; p.flags = p.flags || {}; p.flagScore = p.flagScore || 0; p.hitDistSum = p.hitDistSum || 0; p.hitDistN = p.hitDistN || 0; return p; }

// ---------- suspicious activity ----------
// Thresholds (settings.combatFlags) and what they catch. None of this is proof; it points an admin at a replay or a closer look.
function flagCfg() { try { return { headshotRate: 0.55, minHitsForRate: 25, longHeadshotM: 400, extremeKillM: 900, burstHits: 4, burstWindowMs: 1500, killBurst: 3, killBurstMs: 10000, speedMps: 80, alertScore: 3, relogCount: 4, relogWindowMs: 600000, combatLogSec: 20, ...(require('./settings').load().combatFlags || {}) }; } catch { return { headshotRate: 0.55, minHitsForRate: 25, longHeadshotM: 400, extremeKillM: 900, burstHits: 4, burstWindowMs: 1500, killBurst: 3, killBurstMs: 10000, speedMps: 80, alertScore: 3, relogCount: 4, relogWindowMs: 600000, combatLogSec: 20 }; }
}
const FLAG_WEIGHT = { 'duplicate item': 4, 'headshot rate': 2, 'long-range headshot': 2, 'multi-target burst': 3, 'impossible movement': 3, 'extreme-range kill': 1, 'kill burst': 2, 'rapid relogs': 3, 'combat logging': 1, 'BattlEye kick': 4 };
function raise(p, reason, detail, ts) {
  p.flags[reason] = (p.flags[reason] || 0) + 1;
  p.flagScore = Object.entries(p.flags).reduce((a, [r, n]) => a + (FLAG_WEIGHT[r] || 1) * Math.min(n, 5), 0);
  p.lastFlag = { reason, detail, ts }; p.lastFlagAt = ts;
  p.flagEvents = p.flagEvents || []; p.flagEvents.push([ts, reason, String(detail || '').slice(0, 120)]); if (p.flagEvents.length > 300) p.flagEvents.shift();
  const c = flagCfg();
  if (p.flagScore >= c.alertScore) { try { require('./alerts').alert('suspicious-activity', `Suspicious combat: ${p.name}`, `${reason}: ${detail}\nScore ${p.flagScore}: ${Object.entries(p.flags).map(([r, n]) => r + ' ×' + n).join(', ')}`); } catch { /* ignore */ } }
  emitRef('players:changed', {});
}
function checkMovement(p, pos, ts) {
  if (!pos) return;
  const c = flagCfg();
  if (p.lastPos && ts > p.lastPos.ts + 2000) { const dt = (ts - p.lastPos.ts) / 1000; const dist = Math.hypot(pos.x - p.lastPos.x, pos.z - p.lastPos.z); const mps = dist / dt; if (mps > c.speedMps && dist > 300) raise(p, 'impossible movement', `${Math.round(dist)} m in ${Math.round(dt)} s (${Math.round(mps)} m/s)`, ts); }
  p.lastPos = { x: pos.x, z: pos.z, ts };
}
function weapon(name) { const d = load(); if (!d.weapons[name]) d.weapons[name] = { hits: 0, damage: 0, kills: 0, headshots: 0, distSum: 0, distN: 0, maxDist: 0, ammo: {} }; return d.weapons[name]; }

// Parses the attacker part of "hit by …" / "killed by …" bodies.
// Examples: hit by Player "Eve" (id=… pos=<…>) into Torso(5) for 54.6 damage (Bullet_556x45) with M4A1 from 21.49 meters
//           hit by ZmbM_PrisonerSkinny into RightArm(2) for 10 damage (MeleeInfected)
//           killed by Player "Eve" (id=… pos=<…>) with M4A1 from 12.3 meters
function parseAttack(body) {
  const m = body.match(/(?:hit|killed) by (?:Player\s+"([^"]+)"\s*\(id=([^\s)]+)(?:\s+pos=<([^,]+),\s*[^,]+,\s*([^>]+)>)?[^)]*\)|([A-Za-z0-9_]+))(?:\s+into\s+([A-Za-z_]+)\((\d+)\))?(?:\s+for\s+([\d.]+)\s+damage(?:\s+\(([^)]*)\))?)?(?:\s+with\s+(.+?))?(?:\s+from\s+([\d.]+)\s+meters)?\s*$/);
  if (!m) return null;
  return { attackerName: m[1] || null, attackerId: m[2] || null, attackerPos: m[3] !== undefined ? { x: Number(m[3]), z: Number(m[4]) } : null, attackerClass: m[5] || null, part: m[6] || null, damage: m[8] !== undefined ? Number(m[8]) : null, ammo: m[9] || null, weapon: m[10] ? m[10].trim() : null, distance: m[11] !== undefined ? Number(m[11]) : null };
}

// ev comes from players.parseLine: { type, name, id, body, killer, weapon }
function record(ev) {
  if (!ev || !ev.body) return;
  // a respawn, login or logout legitimately moves a player anywhere: forget the last position so it is not read as teleporting
  if (ev.type === 'connect' || ev.type === 'disconnect') {
    const p = player(ev.id || ev.name, ev.name); const c = flagCfg(); const ts = ev.ts || Date.now();
    p.lastPos = null;
    if (ev.type === 'connect') {
      // relog duping needs fast repeated relogs: count connects inside the window
      p.relogs = (p.relogs || []).filter(t => ts - t <= c.relogWindowMs); p.relogs.push(ts);
      if (p.relogs.length >= c.relogCount && !(p.lastRelogFlagAt && ts - p.lastRelogFlagAt < c.relogWindowMs)) { p.lastRelogFlagAt = ts; raise(p, 'rapid relogs', `${p.relogs.length} logins within ${Math.round(c.relogWindowMs / 60000)} min`, ts); }
    } else if (p.lastHitTakenAt && ts - p.lastHitTakenAt <= c.combatLogSec * 1000) {
      raise(p, 'combat logging', `logged out ${Math.round((ts - p.lastHitTakenAt) / 1000)} s after being hit by ${p.lastHitTakenBy || 'a player'}`, ts);
    }
    save(); return;
  }
  if (ev.type !== 'hit' && ev.type !== 'kill' && ev.type !== 'death' && ev.type !== 'build') return;
  const d = load(); const vkey = ev.id || ev.name;
  if (ev.type === 'build') { player(vkey, ev.name).builds++; save(); return; }
  const a = parseAttack(ev.body); if (!a) return;
  const victim = player(vkey, ev.name);
  if (ev.type === 'hit') {
    if (a.attackerName) {
      const akey = a.attackerId || a.attackerName; const att = player(akey, a.attackerName);
      const dmg = a.damage || 0; att.dealt += dmg; att.hits++; victim.taken += dmg; victim.hitsTaken++;
      if (a.part && /head/i.test(a.part)) att.headshots++;
      if (a.part) att.parts[a.part] = (att.parts[a.part] || 0) + 1;
      victim.lastHitTakenAt = ev.ts || Date.now(); victim.lastHitTakenBy = a.attackerName;
      if (a.distance !== null) { att.hitDistSum += a.distance; att.hitDistN++; }
      d.totals.hits++; d.totals.damage += dmg;
      { const c = flagCfg(); const ts = ev.ts || Date.now();
        att.recentHits.push([ts, vkey]); if (att.recentHits.length > 20) att.recentHits.shift();
        const win = att.recentHits.filter(h => ts - h[0] <= c.burstWindowMs); const victims = new Set(win.map(h => h[1]));
        if (win.length >= c.burstHits && victims.size >= 2 && !(att.lastBurstAt && ts - att.lastBurstAt < c.burstWindowMs * 4)) { att.lastBurstAt = ts; raise(att, 'multi-target burst', `${win.length} hits on ${victims.size} players within ${(c.burstWindowMs / 1000).toFixed(1)} s`, ts); }
        if (a.part && /head/i.test(a.part) && a.distance !== null && a.distance >= c.longHeadshotM) raise(att, 'long-range headshot', `${Math.round(a.distance)} m with ${a.weapon || a.ammo || '?'}`, ts);
        if (att.hits >= c.minHitsForRate && att.hits % 10 === 0 && att.headshots / att.hits >= c.headshotRate) raise(att, 'headshot rate', `${Math.round(100 * att.headshots / att.hits)}% of ${att.hits} hits`, ts);
        checkMovement(att, a.attackerPos, ts); }
      if (ev.pos) checkMovement(victim, ev.pos, ev.ts || Date.now());
      const w = weapon(a.weapon || (a.ammo ? a.ammo : 'unknown')); w.hits++; w.damage += dmg; if (a.part && /head/i.test(a.part)) w.headshots++; if (a.ammo) w.ammo[a.ammo] = (w.ammo[a.ammo] || 0) + 1;
      if (a.distance !== null) { w.distSum += a.distance; w.distN++; if (a.distance > w.maxDist) w.maxDist = a.distance; }
      if (a.part) d.parts[a.part] = (d.parts[a.part] || 0) + 1;
    } else { victim.pveTaken += a.damage || 0; d.totals.pveHitsTaken++; }
  } else {
    // kill or death: the victim will respawn somewhere else
    victim.lastPos = null;
    if (a.attackerName) {
      const akey = a.attackerId || a.attackerName; const att = player(akey, a.attackerName);
      att.kills++; const wn = a.weapon || 'unknown'; att.killsBy[wn] = (att.killsBy[wn] || 0) + 1; d.totals.kills++;
      const w = weapon(wn); w.kills++;
      if (a.distance !== null) { att.distSum += a.distance; att.distN++; if (a.distance > att.longestKill) att.longestKill = a.distance; if (a.distance > w.maxDist) w.maxDist = a.distance; }
      const pk = a.attackerName + '\u0000' + ev.name; d.pairs[pk] = (d.pairs[pk] || 0) + 1;
      { const c = flagCfg(); const ts = ev.ts || Date.now();
        att.recentKills.push(ts); if (att.recentKills.length > 10) att.recentKills.shift();
        const burst = att.recentKills.filter(t => ts - t <= c.killBurstMs).length;
        if (burst >= c.killBurst && !(att.lastKillBurstAt && ts - att.lastKillBurstAt < c.killBurstMs * 2)) { att.lastKillBurstAt = ts; raise(att, 'kill burst', `${burst} kills within ${c.killBurstMs / 1000} s`, ts); }
        if (a.distance !== null && a.distance >= c.extremeKillM) raise(att, 'extreme-range kill', `${Math.round(a.distance)} m with ${a.weapon || '?'}`, ts);
        checkMovement(att, a.attackerPos, ts); }
      victim.deathsBy[a.attackerName] = (victim.deathsBy[a.attackerName] || 0) + 1;
    } else { const c = a.attackerClass || (/suicide/i.test(ev.body) ? 'suicide' : /bled out/i.test(ev.body) ? 'bleeding' : 'environment'); victim.deathsBy[c] = (victim.deathsBy[c] || 0) + 1; }
  }
  save();
}

function overview() {
  const d = load();
  const players = Object.values(d.players);
  const top = (f, n = 10, fmt = x => x) => players.filter(p => f(p) > 0).sort((a, b) => f(b) - f(a)).slice(0, n).map(p => ({ name: p.name, value: fmt(f(p)) }));
  const weapons = Object.entries(d.weapons).map(([name, w]) => ({ name, hits: w.hits, damage: Math.round(w.damage), kills: w.kills, headshots: w.headshots, avgDist: w.distN ? Math.round(w.distSum / w.distN) : null, maxDist: Math.round(w.maxDist), ammo: Object.entries(w.ammo).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]).join(', ') })).sort((a, b) => b.kills - a.kills || b.damage - a.damage).slice(0, 25);
  const parts = Object.entries(d.parts).sort((a, b) => b[1] - a[1]);
  const rivalries = Object.entries(d.pairs).map(([k, n]) => { const [a, v] = k.split('\u0000'); return { name: `${a} → ${v}`, value: n }; }).sort((a, b) => b.value - a.value).slice(0, 10);
  return {
    totals: { ...d.totals, damage: Math.round(d.totals.damage) },
    weapons, parts, rivalries,
    damageDealt: top(p => Math.round(p.dealt)), damageTaken: top(p => Math.round(p.taken)), headshots: top(p => p.headshots),
    longestKills: top(p => Math.round(p.longestKill), 10, x => x + ' m'), accuracyHits: top(p => p.hits),
    builders: top(p => p.builds),
    suspicious: suspicious(),
    headshotRate: players.filter(p => p.hits >= 20).sort((a, b) => b.headshots / b.hits - a.headshots / a.hits).slice(0, 10).map(p => ({ name: p.name, value: `${Math.round(100 * p.headshots / p.hits)}% of ${p.hits}` })),
    hitsPerKill: players.filter(p => p.kills >= 3).sort((a, b) => a.hits / a.kills - b.hits / b.kills).slice(0, 10).map(p => ({ name: p.name, value: (p.hits / p.kills).toFixed(1) })),
    favouriteWeapons: players.filter(p => p.kills > 0).sort((a, b) => b.kills - a.kills).slice(0, 10).map(p => ({ name: p.name, value: Object.entries(p.killsBy).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w, n]) => `${w} ×${n}`).join(', ') }))
  };
}
// BattlEye kick lines from the RPT / server console, e.g. "Player Bob kicked by BattlEye: Script Restriction #58"
const BE_RE = /BattlEye[^:]*:\s*(Script Restriction #\d+|Game Restriction #\d+|Global Ban|Admin Ban|Corrupted Memory #\d+|Corrupted Data #\d+|Bad Player Name|Client not responding|Invalid GUID|Failed to update|Query Timeout)/i;
// a flag raised by another module (anti-dupe): same scoring, history and alerting as the combat rules
function flagExternal(key, name, reason, detail, ts = Date.now()) { const p = player(key, name); raise(p, reason, detail, ts); save(); }
function beKick(line, ts = Date.now()) {
  const m = BE_RE.exec(line || ''); if (!m) return null;
  const reason = m[1];
  if (/Client not responding|Query Timeout|Failed to update/i.test(reason)) return null; // connectivity, not cheating
  const nm = line.match(/Player\s+(?:#\d+\s+)?"?([^"(]+?)"?\s*(?:\(|kicked|\-|$)/i); const name = nm ? nm[1].trim() : 'unknown';
  const d = load(); const p = Object.values(d.players).find(x => x.name === name) || player(name, name);
  raise(p, 'BattlEye kick', reason, ts); save();
  return { name, reason };
}
function countSince(p, since) { return (p.flagEvents || []).filter(e => e[0] >= since).length; }
function windows(p) { const now = Date.now(); return { day: countSince(p, now - 86400000), week: countSince(p, now - 7 * 86400000), month: countSince(p, now - 30 * 86400000), all: (p.flagEvents || []).length || Object.values(p.flags || {}).reduce((a, b) => a + b, 0) }; }
function accuracyOf(p) {
  const total = Object.values(p.parts || {}).reduce((a, b) => a + b, 0);
  return { hitsPerKill: p.kills ? +(p.hits / p.kills).toFixed(1) : null, headshotPct: p.hits ? Math.round(100 * p.headshots / p.hits) : null, avgHitDist: p.hitDistN ? Math.round(p.hitDistSum / p.hitDistN) : null, parts: Object.entries(p.parts || {}).sort((a, b) => b[1] - a[1]).map(([part, n]) => ({ part, n, pct: total ? Math.round(100 * n / total) : 0 })) };
}
function forPlayer(keyOrName) { const d = load(); const p = d.players[keyOrName] || Object.values(d.players).find(x => x.name === keyOrName); if (!p) return null; return { dealt: Math.round(p.dealt), taken: Math.round(p.taken), hits: p.hits, hitsTaken: p.hitsTaken, headshots: p.headshots, longestKill: Math.round(p.longestKill), avgKillDist: p.distN ? Math.round(p.distSum / p.distN) : null, favourite: Object.entries(p.killsBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ×${n}`).join(', '), deathsBy: Object.entries(p.deathsBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ×${n}`).join(', '), builds: p.builds, accuracy: accuracyOf(p), flags: Object.entries(p.flags || {}).map(([reason, n]) => ({ reason, n })), flagScore: p.flagScore || 0, lastFlag: p.lastFlag || null, flagWindows: windows(p), flagHistory: (p.flagEvents || []).slice(-20).reverse().map(e => ({ ts: e[0], reason: e[1], detail: e[2] })) }; }
// since = epoch ms (0 = all time): flags and score counted only inside the window
function suspicious(since = 0) {
  const d = load();
  return Object.values(d.players).map(p => {
    const evs = (p.flagEvents || []).filter(e => e[0] >= since);
    const counts = {}; for (const e of evs) counts[e[1]] = (counts[e[1]] || 0) + 1;
    const useAll = !since && !evs.length && p.flagScore; // records from before the history existed
    const flags = useAll ? p.flags : counts;
    const score = useAll ? p.flagScore : Object.entries(counts).reduce((a, [r, n]) => a + (FLAG_WEIGHT[r] || 1) * Math.min(n, 5), 0);
    return { name: p.name, score, count: useAll ? Object.values(p.flags).reduce((a, b) => a + b, 0) : evs.length, flags: Object.entries(flags).map(([r, n]) => `${r} ×${n}`).join(', '), last: p.lastFlag ? `${p.lastFlag.reason}: ${p.lastFlag.detail}` : '', lastAt: p.lastFlagAt, hits: p.hits, headshotPct: p.hits ? Math.round(100 * p.headshots / p.hits) : 0, windows: windows(p) };
  }).filter(p => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 30);
}
function clear() { db = null; try { fs.unlinkSync(file()); } catch { /* ignore */ } load(); }
// Re-read every admin log on disk.
function rebuild() {
  const players = require('./players'); const settings = require('./settings');
  clear(); const dir = settings.paths().profilesDir; let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.adm$/i.test(f)).sort(); } catch { /* none */ }
  let n = 0;
  for (const f of files) { const ctx = { date: new Date(fs.statSync(path.join(dir, f)).mtimeMs).toISOString().slice(0, 10), lastSec: -1 }; for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) { const ev = players.parseLine(line, ctx); if (ev && ev.type) { record(ev); n++; } } }
  save(); return { files: files.length, events: n };
}
function init(emit) { emitRef = emit; load(); }
module.exports = { init, record, overview, forPlayer, rebuild, clear, parseAttack, suspicious, beKick, flagExternal };
