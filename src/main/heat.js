'use strict';
// Heatmap data from the admin log, kept per map in userData/heat.json.
// events: compact [ts, x, z, kind] rows (kind: 0 travel/any, 1 hit, 2 build, 3 logout, 4 login, 5 death), capped;
// deaths: full records with the cause. Summaries can be filtered by time in the renderer.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const settings = require('./settings');

const N = 128, MAX_EVENTS = 300000, MAX_DEATHS = 50000;
const KIND = { travel: 0, hit: 1, build: 2, logout: 3, login: 4, death: 5 };
let db = null, mapKeyCache = { at: 0, key: null }, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'heat.json');
function load() { if (!db) { try { db = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { db = { maps: {} }; } db.maps = db.maps || {}; } return db; }
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(file(), JSON.stringify(load())); } catch { /* ignore */ } }, 2000); }
function forMap(key) { const d = load(); if (!d.maps[key] || !d.maps[key].events) d.maps[key] = { N, events: [], deaths: [], since: Date.now() }; return d.maps[key]; }
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
function kindOf(ev) {
  if (ev.type === 'kill' || ev.type === 'death') return KIND.death;
  if (ev.type === 'hit') return KIND.hit;
  if (ev.type === 'build') return KIND.build;
  if (ev.type === 'disconnect') return KIND.logout;
  if (ev.type === 'connect') return KIND.login;
  return KIND.travel;
}

// Called for every parsed admin-log event that carries a position.
function record(ev, mapKey) {
  if (!ev || !ev.pos) return;
  const key = mapKey || currentMap(); if (!key) return;
  const m = forMap(key);
  m.events.push([ev.ts, Math.round(ev.pos.x), Math.round(ev.pos.z), kindOf(ev)]);
  if (m.events.length > MAX_EVENTS) m.events.splice(0, m.events.length - MAX_EVENTS);
  if (ev.type === 'kill' || ev.type === 'death') {
    m.deaths.push({ x: Math.round(ev.pos.x), z: Math.round(ev.pos.z), ts: ev.ts, cause: causeOf(ev.body), killer: ev.killer ? ev.killer.name : null, victim: ev.name, weapon: ev.weapon || null });
    if (m.deaths.length > MAX_DEATHS) m.deaths.splice(0, m.deaths.length - MAX_DEATHS);
  }
  save();
}

// since: epoch ms (0 = everything)
function summary(mapKey, since = 0) {
  const key = mapKey || currentMap(); if (!key) return null;
  const m = forMap(key);
  const events = since ? m.events.filter(e => e[0] >= since) : m.events;
  const deaths = since ? m.deaths.filter(d => d.ts >= since) : m.deaths;
  const causes = {}; for (const d of deaths) causes[d.cause] = (causes[d.cause] || 0) + 1;
  return { map: key, N, size: worldSize(key), events, deaths, causes, since: m.since, total: m.events.length };
}
function deathsSince(since) { const key = currentMap(); if (!key) return []; return forMap(key).deaths.filter(d => d.ts >= since); }
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
module.exports = { init, record, summary, deathsSince, clear, rebuild, causeOf, N };
