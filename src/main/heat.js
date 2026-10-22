'use strict';
// Heatmap data from the admin log: where players are seen (travel), where they die, and what killed them.
// Kept per map in userData/heat.json: a 128x128 count grid for travel plus a capped list of deaths.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const settings = require('./settings');

const N = 128, MAX_DEATHS = 50000;
let db = null, mapKeyCache = { at: 0, key: null }, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'heat.json');
function load() { if (!db) { try { db = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { db = { maps: {} }; } db.maps = db.maps || {}; } return db; }
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(file(), JSON.stringify(load())); } catch { /* ignore */ } }, 2000); }
function forMap(key) { const d = load(); if (!d.maps[key]) d.maps[key] = { N, travel: new Array(N * N).fill(0), deaths: [], samples: 0, since: Date.now() }; return d.maps[key]; }
function currentMap() {
  if (Date.now() - mapKeyCache.at < 60000) return mapKeyCache.key;
  let key = null; try { key = require('./mission').mapInfo().map; } catch { /* ignore */ }
  mapKeyCache = { at: Date.now(), key }; return key;
}
function worldSize(key) { try { const i = require('./mission').mapInfo(); if (i.map === key && i.size) return i.size; } catch { /* ignore */ } return 15360; }

// What killed the player, from the admin log body.
function causeOf(body) {
  const b = body || '';
  if (/killed by Player\s+"/i.test(b)) return 'player';
  const k = b.match(/killed by\s+([A-Za-z0-9_]+)/i);
  if (k) {
    const c = k[1];
    if (/^Zmb|Infected|Zombie/i.test(c)) return 'infected';
    if (/^Animal_|Bear|Wolf|Ursus|Canis|Boar/i.test(c)) return 'animal';
    if (/Car|Truck|Bus|Sedan|Hatchback|Offroad|Vehicle|Boat/i.test(c)) return 'vehicle';
    if (/explosion|Grenade|Mine|Claymore|Fireworks/i.test(c)) return 'explosion';
    if (/Fall/i.test(c)) return 'fall';
    return 'other';
  }
  if (/committed suicide/i.test(b)) return 'suicide';
  if (/bled out/i.test(b)) return 'bleeding';
  if (/\bdied\b/i.test(b)) return 'environment';
  return 'unknown';
}

// Called for every parsed admin-log event that carries a position.
function record(ev, mapKey) {
  if (!ev || !ev.pos) return;
  const key = mapKey || currentMap(); if (!key) return;
  const m = forMap(key); const size = worldSize(key);
  const gx = Math.min(N - 1, Math.max(0, Math.floor(ev.pos.x / size * N))), gz = Math.min(N - 1, Math.max(0, Math.floor(ev.pos.z / size * N)));
  m.travel[gz * N + gx]++; m.samples++;
  if (ev.type === 'kill' || ev.type === 'death') {
    m.deaths.push({ x: Math.round(ev.pos.x), z: Math.round(ev.pos.z), ts: ev.ts, cause: causeOf(ev.body), killer: ev.killer ? ev.killer.name : null, victim: ev.name, weapon: ev.weapon || null });
    if (m.deaths.length > MAX_DEATHS) m.deaths.splice(0, m.deaths.length - MAX_DEATHS);
  }
  save();
}

function summary(mapKey) {
  const key = mapKey || currentMap(); if (!key) return null;
  const m = forMap(key);
  const cells = []; let max = 0;
  for (let i = 0; i < m.travel.length; i++) if (m.travel[i]) { cells.push([i, m.travel[i]]); if (m.travel[i] > max) max = m.travel[i]; }
  const causes = {}; for (const d of m.deaths) causes[d.cause] = (causes[d.cause] || 0) + 1;
  return { map: key, N: m.N, size: worldSize(key), travel: cells, travelMax: max, samples: m.samples, deaths: m.deaths, causes, since: m.since };
}
function clear(mapKey) { const key = mapKey || currentMap(); if (key) { delete load().maps[key]; save(); } return summary(key); }

// Re-read every admin log in the profiles folder from the start for the active map.
function rebuild() {
  const key = currentMap(); if (!key) throw new Error('No active mission.');
  const players = require('./players');
  delete load().maps[key]; const m = forMap(key);
  const dir = settings.paths().profilesDir; let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.adm$/i.test(f)).sort(); } catch { /* none */ }
  let lines = 0;
  for (const f of files) {
    const ctx = { date: new Date(fs.statSync(path.join(dir, f)).mtimeMs).toISOString().slice(0, 10), lastSec: -1 };
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) { const ev = players.parseLine(line, ctx); if (ev && ev.pos) { record(ev, key); lines++; } }
  }
  m.since = Date.now();
  save(); emitRef('players:changed', {});
  return { files: files.length, positions: lines, deaths: m.deaths.length };
}

function init(emit) { emitRef = emit; load(); }
module.exports = { init, record, summary, clear, rebuild, causeOf, N };
