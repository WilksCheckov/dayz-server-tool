'use strict';
// DRP Factions loot zones on the Map page. The mod keeps its zones in profiles\DRP_Factions\reward_zones.json and
// rewrites that file itself, so the tool never writes it: every change goes in as its own inbox file
// (zones_inbox_<time>.json), which the mod applies within a few seconds while the server runs, or at the next start.
// The mod reports what it did in zones_result.json. Changes not picked up yet are shown as pending and can be undone.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const dir = () => path.join(settings.paths().profilesDir, 'DRP_Factions');
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return def; } };
const INBOX = /^(admin|zones)_inbox_(\d+)\.json$/;
// the mod stores colours as signed ARGB ints
const css = (argb) => { const n = (Number(argb) >>> 0) & 0xffffff; return '#' + n.toString(16).padStart(6, '0'); };

function inboxFiles() {
  let names = []; try { names = fs.readdirSync(dir()); } catch { return []; }
  return names.filter(n => INBOX.test(n)).sort().map(n => ({ name: n, op: readJson(path.join(dir(), n), null) })).filter(f => f.op);
}

// The sector map the mod made (profiles\DRP_Factions\sectors.json): sector list and RLE raster rows. Read again only
// when the file changes; the renderer fetches it when state().sectorsAt moves.
let sectorCache = { at: 0, data: null };
function sectorsAt() { try { return fs.statSync(path.join(dir(), 'sectors.json')).mtimeMs; } catch { return 0; } }
function sectors() {
  const at = sectorsAt();
  if (!at) return { available: false, reason: 'The mod has not made its sector map yet (start the server once).' };
  if (sectorCache.at !== at) {
    const d = readJson(path.join(dir(), 'sectors.json'), null);
    if (!d || !Array.isArray(d.rows)) return { available: false, reason: 'sectors.json could not be read.' };
    sectorCache = { at, data: { available: true, at, raster: d.raster, n: d.n, world: d.world, sectors: (d.sectors || []).map(s => ({ id: s.id, name: s.name, kind: s.kind, cx: s.cx, cz: s.cz, cells: s.cells, nb: s.nb || [] })), rows: d.rows, borders: d.borders || [] } };
  }
  return sectorCache.data;
}
function logos() { return (readJson(path.join(dir(), 'logos.json'), { logos: [] }).logos || []).filter(Boolean); }

function state() {
  const d = dir(); const zf = path.join(d, 'reward_zones.json');
  if (!fs.existsSync(zf)) return { available: false, reason: 'DRP Factions is not on this server: there is no profiles\\DRP_Factions\\reward_zones.json (it appears after the mod has run once).' };
  const store = readJson(zf, { zones: [] }); const facs = readJson(path.join(d, 'factions.json'), { factions: [] }); const cfg = readJson(path.join(d, 'settings.json'), {});
  const cellSize = Number(cfg.cellSizeMeters) > 0 ? Number(cfg.cellSizeMeters) : 512;
  const factions = (facs.factions || []).map(f => ({
    id: f.id, name: f.name, tag: f.tag, color: f.color ? css(f.color) : '#9aa3ad', logo: f.logo || '',
    cells: [...(f.claims || []).map(c => ({ x: c.cellX, z: c.cellZ, kind: c.kind === 0 ? 'home' : 'outpost', claimId: c.id, pending: (c.readyAt || 0) > 0 })), ...(f.captured || []).map(c => ({ x: c.cellX, z: c.cellZ, kind: 'captured', pending: false }))],
    cache: f.hasCache ? { x: f.cacheX, z: f.cacheZ } : null
  }));
  const byId = new Map(factions.map(f => [f.id, f]));
  const zones = (store.zones || []).map(z => ({ id: z.id, name: z.name, x: z.x, y: z.y, z: z.z, intervalMinutes: z.intervalMinutes, lastPaidAt: z.lastPaidAt, holder: z.holderFactionId >= 0 && byId.get(z.holderFactionId) ? { id: z.holderFactionId, name: byId.get(z.holderFactionId).name, tag: byId.get(z.holderFactionId).tag } : null, items: (z.items || []).map(i => ({ className: i.className, min: i.min, max: i.max, chance: i.chance })) }));
  // changes the mod has not picked up yet: shown on top of what it has
  const pending = inboxFiles();
  for (const { name, op } of pending) {
    if (op.op === 'delete') { const z = zones.find(x => x.id === op.id); if (z) z.pendingDelete = name; continue; }
    if (op.op !== 'save' || !op.zone) continue;
    const z = zones.find(x => x.id === op.zone.id && op.zone.id > 0);
    const shown = { ...op.zone, items: op.zone.items || [], pending: name, holder: z ? z.holder : null, lastPaidAt: z ? z.lastPaidAt : 0 };
    if (z) Object.assign(z, shown); else zones.push({ ...shown, id: 'new:' + name });
  }
  const result = readJson(path.join(d, 'admin_result.json'), null) || readJson(path.join(d, 'zones_result.json'), { seq: 0, messages: [] });
  return { available: true, enabled: store.enabled !== 0 && store.enabled !== false, cellSize, sectorsAt: sectorsAt(), logos: logos(), zones, factions, pending: pending.length, result: { seq: result.seq || 0, messages: result.messages || [] } };
}

function writeOp(op) {
  const d = dir(); if (!fs.existsSync(path.join(d, 'reward_zones.json'))) throw new Error('DRP Factions is not on this server.');
  // a time-ordered name the mod sorts by; written under another name first so the mod never reads half a file
  let stamp = Date.now(); let name; do { name = `admin_inbox_${String(stamp).padStart(15, '0')}.json`; stamp++; } while (fs.existsSync(path.join(d, name)));
  const tmp = path.join(d, name + '.tmp'); fs.writeFileSync(tmp, JSON.stringify(op, null, 1)); fs.renameSync(tmp, path.join(d, name));
  return name;
}

function adminName() { try { return require('./adminlog').cfg().adminName; } catch { return 'admin'; } }
function audit(what) { try { require('./audit').log('app', adminName(), 'zones:' + what.split(' ')[0], what); } catch { /* ignore */ } }

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
// zone: { id (number, or 'new:<file>' / -1 for a new one), name, x, z, intervalMinutes, items: [{className, min, max, chance}] }
function save(zone) {
  if (!zone) throw new Error('No zone given.');
  const name = String(zone.name || '').trim().slice(0, 60) || 'Loot zone';
  const x = num(zone.x, NaN), z = num(zone.z, NaN); if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('The zone needs a position.');
  const items = (zone.items || []).map(i => {
    const className = String(i.className || '').trim(); const min = Math.max(0, Math.round(num(i.min, 1))); const max = Math.max(min, Math.round(num(i.max, min)));
    return { className, quantity: 0, min, max, chance: Math.min(100, Math.max(0, num(i.chance, 100))) };
  }).filter(i => i.className);
  // replacing a change still in the inbox: take that file back first
  let id = typeof zone.id === 'number' && zone.id > 0 ? zone.id : -1;
  if (typeof zone.id === 'string' && zone.id.startsWith('new:')) { try { fs.unlinkSync(path.join(dir(), zone.id.slice(4))); } catch { /* already picked up */ } }
  if (id > 0) for (const f of inboxFiles()) if (f.op.op === 'save' && f.op.zone && f.op.zone.id === id) { try { fs.unlinkSync(path.join(dir(), f.name)); } catch { /* picked up */ } }
  const op = { op: 'save', id, by: adminName(), zone: { id, name, x, y: 0, z, radius: 0, intervalMinutes: Math.max(1, Math.round(num(zone.intervalMinutes, 60))), lastPaidAt: 0, holderFactionId: -1, items } };
  const file = writeOp(op);
  audit(`save ${id > 0 ? '#' + id : 'new'} '${name}' at ${Math.round(x)}, ${Math.round(z)}: ${items.length} loot entries, every ${op.zone.intervalMinutes} min`);
  return { file, state: state() };
}

function remove(id) {
  if (typeof id === 'string' && id.startsWith('new:')) { try { fs.unlinkSync(path.join(dir(), id.slice(4))); } catch { /* picked up already */ } audit('delete unsaved zone'); return { state: state() }; }
  if (!(Number(id) > 0)) throw new Error('No zone given.');
  for (const f of inboxFiles()) if (f.op.op === 'save' && f.op.zone && f.op.zone.id === Number(id)) { try { fs.unlinkSync(path.join(dir(), f.name)); } catch { /* picked up */ } }
  const file = writeOp({ op: 'delete', id: Number(id), by: adminName() });
  audit(`delete #${id}`);
  return { file, state: state() };
}

// Takes back a change the mod has not picked up yet.
function undo(file) {
  if (!INBOX.test(String(file))) throw new Error('Not a pending zone change.');
  try { fs.unlinkSync(path.join(dir(), file)); } catch { throw new Error('The server has already applied it.'); }
  return { state: state() };
}

module.exports = { state, save, remove, undo, sectors, logos, _css: css };
