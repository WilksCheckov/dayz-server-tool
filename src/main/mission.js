'use strict';
// Mission tools: list and switch missions, wipe storage or just player data (with a backup first), cfggameplay.json form data.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const configs = require('./configs');
const server = require('./server');
const backups = require('./backups');

let emitRef = () => {};

function list() {
  const p = settings.paths();
  const mp = path.join(p.serverDir, 'mpmissions');
  const current = configs.missionDir();
  let dirs = [];
  try { dirs = fs.readdirSync(mp, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { /* none */ }
  return {
    current: current ? path.basename(current) : null,
    missions: dirs.map(name => {
      const dir = path.join(mp, name);
      const storage = fs.existsSync(path.join(dir, 'storage_1'));
      let playersDb = null; try { playersDb = fs.statSync(path.join(dir, 'storage_1', 'players.db')).size; } catch { /* none */ }
      const map = (name.match(/\.(\w+)$/) || [])[1] || '';
      return { name, dir, map, hasInit: fs.existsSync(path.join(dir, 'init.c')), hasEconomy: fs.existsSync(path.join(dir, 'cfgeconomycore.xml')), hasGameplay: fs.existsSync(path.join(dir, 'cfggameplay.json')), storage, playersDb, active: current && path.basename(current) === name };
    })
  };
}

function requireStopped() { if (server.status().running) throw new Error('Stop the server first.'); }

// Change the mission template in serverDZ.cfg.
function switchMission(name) {
  requireStopped();
  const p = settings.paths();
  if (!fs.existsSync(path.join(p.serverDir, 'mpmissions', name))) throw new Error('Mission folder not found.');
  let text = fs.readFileSync(p.configPath, 'utf8');
  if (/template\s*=\s*"[^"]*"/.test(text)) text = text.replace(/template\s*=\s*"[^"]*"/, `template = "${name}"`);
  else text += `\nclass Missions\n{\n    class DayZ\n    {\n        template = "${name}";\n    };\n};\n`;
  fs.copyFileSync(p.configPath, p.configPath + '.bak');
  fs.writeFileSync(p.configPath, text, 'utf8');
  emitRef('console', { source: 'mission', line: `Mission switched to ${name}` });
  return list();
}

// Wipe: 'all' deletes storage_1 (everything persistent), 'players' deletes only players.db (characters), 'vehicles' etc. are inside the data folder.
async function wipe(kind) {
  requireStopped();
  const md = configs.missionDir();
  if (!md) throw new Error('No active mission.');
  const storage = path.join(md, 'storage_1');
  if (!fs.existsSync(storage)) throw new Error('No storage_1 folder: nothing to wipe.');
  const bk = await backups.create('pre-wipe');
  if (kind === 'all') fs.rmSync(storage, { recursive: true, force: true });
  else if (kind === 'players') { for (const f of ['players.db', 'players.db-journal']) fs.rmSync(path.join(storage, f), { force: true }); }
  else if (kind === 'world') { for (const f of fs.readdirSync(storage)) { if (/^players\.db/i.test(f)) continue; fs.rmSync(path.join(storage, f), { recursive: true, force: true }); } }
  else if (kind === 'vehicles') { const data = path.join(storage, 'data'); try { for (const f of fs.readdirSync(data)) if (/^(vehicles|dynamic)/i.test(f) || /\.bin$/i.test(f) && /vehicle/i.test(f)) fs.rmSync(path.join(data, f), { force: true }); } catch { /* ignore */ } }
  else throw new Error('Unknown wipe kind.');
  emitRef('console', { source: 'mission', line: `Wiped ${kind} (backup ${bk.name})` });
  return { backup: bk.name, ...list() };
}

// cfggameplay.json as a flat list of editable leaves (path, value, type).
function gameplay() {
  const md = configs.missionDir();
  const file = md && path.join(md, 'cfggameplay.json');
  if (!file || !fs.existsSync(file)) return { file, exists: false, fields: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fields = [];
  const walk = (obj, prefix) => { for (const [k, v] of Object.entries(obj)) { const pth = prefix ? prefix + '.' + k : k; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, pth); else fields.push({ path: pth, value: v, type: Array.isArray(v) ? 'array' : typeof v }); } };
  walk(data, '');
  return { file, exists: true, fields };
}
function saveGameplay(changes) {
  const md = configs.missionDir();
  const file = path.join(md, 'cfggameplay.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const { path: pth, value } of changes) {
    const parts = pth.split('.'); let o = data;
    for (const k of parts.slice(0, -1)) { if (o[k] === undefined || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    o[parts[parts.length - 1]] = value;
  }
  fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, JSON.stringify(data, null, 4) + '\n', 'utf8');
  return configs.validate(file);
}

// World sizes in metres, keyed by the map name at the end of the mission template (dayzOffline.<map>).
const WORLDS = { chernarusplus: 15360, enoch: 12800, sakhal: 10240, namalsk: 12800, deerisle: 16384, esseker: 12800, takistanplus: 12800, banov: 10240, chiemsee: 10240, iztek: 12800, melkart: 15360, valning: 10240 };
const MAP_LABELS = { chernarusplus: 'Chernarus', enoch: 'Livonia', sakhal: 'Sakhal', namalsk: 'Namalsk', deerisle: 'Deer Isle', esseker: 'Esseker', takistanplus: 'Takistan', banov: 'Banov', chiemsee: 'Chiemsee', iztek: 'Iztek', melkart: 'Melkart', valning: 'Valning' };
function mapsDir() { return path.join(settings.load().installDir, 'maps'); }
// Which map the active mission uses, its size, and the image for it if one has been added to <installDir>\maps\<map>.(png|jpg).
function mapInfo() {
  const md = configs.missionDir();
  const name = md ? path.basename(md) : null;
  const map = name ? (name.match(/\.([A-Za-z0-9_]+)$/) || [])[1] || null : null;
  const key = map ? map.toLowerCase() : null;
  let image = null;
  try { fs.mkdirSync(mapsDir(), { recursive: true }); for (const ext of ['png', 'jpg', 'jpeg', 'webp']) { const f = path.join(mapsDir(), key + '.' + ext); if (key && fs.existsSync(f)) { image = f; break; } } } catch { /* ignore */ }
  return { mission: name, map: key, label: key ? (MAP_LABELS[key] || key) : null, size: key ? (WORLDS[key] || null) : null, known: !!(key && WORLDS[key]), image, mapsDir: mapsDir() };
}
function setMapImage(src) {
  const info = mapInfo();
  if (!info.map) throw new Error('No active mission, so the map is unknown.');
  const ext = (path.extname(src).toLowerCase().replace('.', '') || 'png');
  const dest = path.join(mapsDir(), info.map + '.' + ext);
  fs.mkdirSync(mapsDir(), { recursive: true });
  for (const e of ['png', 'jpg', 'jpeg', 'webp']) { try { fs.unlinkSync(path.join(mapsDir(), info.map + '.' + e)); } catch { /* none */ } }
  fs.copyFileSync(src, dest);
  return mapInfo();
}

function init(emit) { emitRef = emit; }
module.exports = { init, list, switchMission, wipe, gameplay, saveGameplay, mapInfo, setMapImage };
