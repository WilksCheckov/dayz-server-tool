'use strict';
// Combat statistics from the admin log: damage dealt and taken, hits by weapon, body parts, kill distances,
// kills per weapon per player, rivalries and base-building actions. Aggregated counters in userData/combat.json.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let db = null, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'combat.json');
function load() { if (!db) { try { db = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { db = {}; } db.players = db.players || {}; db.weapons = db.weapons || {}; db.parts = db.parts || {}; db.pairs = db.pairs || {}; db.totals = db.totals || { hits: 0, damage: 0, kills: 0, pveHitsTaken: 0 }; } return db; }
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(file(), JSON.stringify(load())); } catch { /* ignore */ } }, 2000); }
function player(key, name) { const d = load(); if (!d.players[key]) d.players[key] = { name, dealt: 0, taken: 0, hits: 0, hitsTaken: 0, headshots: 0, kills: 0, killsBy: {}, deathsBy: {}, longestKill: 0, distSum: 0, distN: 0, builds: 0, pveTaken: 0 }; if (name) d.players[key].name = name; return d.players[key]; }
function weapon(name) { const d = load(); if (!d.weapons[name]) d.weapons[name] = { hits: 0, damage: 0, kills: 0, headshots: 0, distSum: 0, distN: 0, maxDist: 0, ammo: {} }; return d.weapons[name]; }

// Parses the attacker part of "hit by …" / "killed by …" bodies.
// Examples: hit by Player "Eve" (id=… pos=<…>) into Torso(5) for 54.6 damage (Bullet_556x45) with M4A1 from 21.49 meters
//           hit by ZmbM_PrisonerSkinny into RightArm(2) for 10 damage (MeleeInfected)
//           killed by Player "Eve" (id=… pos=<…>) with M4A1 from 12.3 meters
function parseAttack(body) {
  const m = body.match(/(?:hit|killed) by (?:Player\s+"([^"]+)"\s*\(id=([^\s)]+)[^)]*\)|([A-Za-z0-9_]+))(?:\s+into\s+([A-Za-z_]+)\((\d+)\))?(?:\s+for\s+([\d.]+)\s+damage(?:\s+\(([^)]*)\))?)?(?:\s+with\s+(.+?))?(?:\s+from\s+([\d.]+)\s+meters)?\s*$/);
  if (!m) return null;
  return { attackerName: m[1] || null, attackerId: m[2] || null, attackerClass: m[3] || null, part: m[4] || null, damage: m[6] !== undefined ? Number(m[6]) : null, ammo: m[7] || null, weapon: m[8] ? m[8].trim() : null, distance: m[9] !== undefined ? Number(m[9]) : null };
}

// ev comes from players.parseLine: { type, name, id, body, killer, weapon }
function record(ev) {
  if (!ev || !ev.body) return;
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
      d.totals.hits++; d.totals.damage += dmg;
      const w = weapon(a.weapon || (a.ammo ? a.ammo : 'unknown')); w.hits++; w.damage += dmg; if (a.part && /head/i.test(a.part)) w.headshots++; if (a.ammo) w.ammo[a.ammo] = (w.ammo[a.ammo] || 0) + 1;
      if (a.distance !== null) { w.distSum += a.distance; w.distN++; if (a.distance > w.maxDist) w.maxDist = a.distance; }
      if (a.part) d.parts[a.part] = (d.parts[a.part] || 0) + 1;
    } else { victim.pveTaken += a.damage || 0; d.totals.pveHitsTaken++; }
  } else {
    // kill or death
    if (a.attackerName) {
      const akey = a.attackerId || a.attackerName; const att = player(akey, a.attackerName);
      att.kills++; const wn = a.weapon || 'unknown'; att.killsBy[wn] = (att.killsBy[wn] || 0) + 1; d.totals.kills++;
      const w = weapon(wn); w.kills++;
      if (a.distance !== null) { att.distSum += a.distance; att.distN++; if (a.distance > att.longestKill) att.longestKill = a.distance; if (a.distance > w.maxDist) w.maxDist = a.distance; }
      const pk = a.attackerName + '\u0000' + ev.name; d.pairs[pk] = (d.pairs[pk] || 0) + 1;
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
    favouriteWeapons: players.filter(p => p.kills > 0).sort((a, b) => b.kills - a.kills).slice(0, 10).map(p => ({ name: p.name, value: Object.entries(p.killsBy).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w, n]) => `${w} ×${n}`).join(', ') }))
  };
}
function forPlayer(keyOrName) { const d = load(); const p = d.players[keyOrName] || Object.values(d.players).find(x => x.name === keyOrName); if (!p) return null; return { dealt: Math.round(p.dealt), taken: Math.round(p.taken), hits: p.hits, hitsTaken: p.hitsTaken, headshots: p.headshots, longestKill: Math.round(p.longestKill), avgKillDist: p.distN ? Math.round(p.distSum / p.distN) : null, favourite: Object.entries(p.killsBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ×${n}`).join(', '), deathsBy: Object.entries(p.deathsBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ×${n}`).join(', '), builds: p.builds }; }
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
module.exports = { init, record, overview, forPlayer, rebuild, clear, parseAttack };
