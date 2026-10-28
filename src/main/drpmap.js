'use strict';
// Map layers for DRP_Admin's in-game Map window (Phase D). The app writes small, already-aggregated files into
// $profile:DayZAdminTools/map/, which the server mod sends to admins on request:
//   timed_1h.json, timed_24h.json, timed_7d.json  deaths (coloured by cause, linked to the death log) and activity heat
//                                                 (a grid per kind: travel, hits, building, logins)
//   static.json                                   vehicle spawns, DRP_Factions territories, loot zones and caches,
//                                                 open tickets with a position
//   loot.json                                     where one item can spawn, answering the item the game asked for in
//                                                 loot_req.txt
// Written at most once a minute (loot answers at once); a file is only rewritten when its content changed.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const RANGES = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };
const MAX_DEATHS = 300, MAX_CELLS = 700, MAX_LOOT = 500, MAX_VSPAWNS = 400;
// heat kinds (heat.js: 0 travel, 1 hit, 2 build, 3 logout, 4 login, 5 death) to the game's four grids
const HEAT_KIND = { 0: 'travel', 1: 'hit', 2: 'build', 3: 'login', 4: 'login' };

const dir = () => path.join(settings.paths().profilesDir, 'DayZAdminTools', 'map');
const now = () => Math.floor(Date.now() / 1000);

function writeIfChanged(f, obj) {
  // "now" changes every write: compare without it
  const body = JSON.stringify({ ...obj, now: 0 });
  let cur = null; try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); cur = JSON.stringify({ ...j, now: 0 }); } catch { /* new */ }
  if (cur === body) return false;
  fs.writeFileSync(f + '.tmp', JSON.stringify(obj)); fs.renameSync(f + '.tmp', f); return true;
}

// ---------- timed layers ----------
function deathsSince(since) {
  let dl = null; try { dl = require('./deathlog'); } catch { return []; }
  const out = [];
  for (const s of dl.list({ since, limit: MAX_DEATHS * 2 })) {
    if (!s.hasPos) continue;
    const d = dl.get(s.id); if (!d || !d.deathPos) continue;
    const killer = d.killer ? ` by ${d.killer.name}` : '';
    out.push({ id: d.id, x: Math.round(d.deathPos[0]), z: Math.round(d.deathPos[1]), cause: d.cause || 'unknown', text: `${d.name}: ${d.causeText || d.cause}${killer && !String(d.causeText || '').includes(d.killer.name) ? killer : ''}${d.weapon ? ' (' + d.weapon + ')' : ''}`.slice(0, 120), ago: Math.max(0, Math.round((Date.now() - d.ts) / 1000)) });
    if (out.length >= MAX_DEATHS) break;
  }
  return out;
}
// counts per grid cell, the busiest MAX_CELLS cells per kind, flattened as [ix, iz, n, ix, iz, n, ...]
function heatSince(since) {
  let s = null; try { s = require('./heat').summary(null, since); } catch { /* no heat data */ }
  const empty = { cell: 120, travel: [], hit: [], build: [], login: [] };
  if (!s) return empty;
  const cell = s.size / s.N;
  const grids = { travel: new Map(), hit: new Map(), build: new Map(), login: new Map() };
  for (const e of s.events) {
    const kind = HEAT_KIND[e[3]]; if (!kind) continue;
    const ix = Math.floor(e[1] / cell), iz = Math.floor(e[2] / cell);
    if (ix < 0 || iz < 0 || ix >= s.N || iz >= s.N) continue;
    const k = ix * 1000 + iz; const g = grids[kind]; g.set(k, (g.get(k) || 0) + 1);
  }
  const out = { cell: Math.round(cell * 100) / 100 };
  for (const [kind, g] of Object.entries(grids)) {
    out[kind] = [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CELLS).flatMap(([k, n]) => [Math.floor(k / 1000), k % 1000, n]);
  }
  return out;
}
function timed(range) {
  const since = Date.now() - RANGES[range];
  return { now: now(), range, deaths: deathsSince(since), heat: heatSince(since) };
}

// ---------- static layers ----------
// mod colours are signed ARGB ints; keep them as the game reads them
const argb = (c) => (Number(c) | 0) || -6576979;
function staticLayers() {
  const out = { now: now(), vspawns: [], zones: [], caches: [], cellSize: 0, cells: [], tickets: [] };
  try {
    for (const e of require('./lootmap').vehicleSpawns()) {
      const label = e.types.length ? e.types.slice(0, 3).join(', ') : e.event;
      for (const p of e.positions) { out.vspawns.push({ x: Math.round(p.x), z: Math.round(p.z), text: label }); if (out.vspawns.length >= MAX_VSPAWNS) break; }
      if (out.vspawns.length >= MAX_VSPAWNS) break;
    }
  } catch { /* no mission */ }
  try {
    const z = require('./drpzones').state();
    if (z.available) {
      // the mod's own file has colours as ints: read them from there
      let facs = []; try { facs = JSON.parse(fs.readFileSync(path.join(settings.paths().profilesDir, 'DRP_Factions', 'factions.json'), 'utf8').replace(/^﻿/, '')).factions || []; } catch { /* none */ }
      const colourOf = new Map(facs.map(f => [f.id, argb(f.color)]));
      out.cellSize = z.cellSize;
      for (const f of z.factions) {
        for (const c of f.cells) out.cells.push({ x: c.x, z: c.z, color: colourOf.get(f.id) || -6576979, text: `${f.name}${c.kind === 'home' ? ' (home)' : ''}` });
        if (f.cache) out.caches.push({ x: Math.round(f.cache.x), z: Math.round(f.cache.z), text: `${f.name} cache` });
      }
      for (const zone of z.zones) if (!String(zone.id).startsWith('new:')) out.zones.push({ x: Math.round(zone.x), z: Math.round(zone.z), text: `${zone.name}${zone.holder ? ' - ' + zone.holder.name : ''}` });
    }
  } catch { /* DRP_Factions not here */ }
  try {
    for (const t of require('./tickets').all()) {
      if (t.status !== 'open' || !t.game || !t.game.context) continue;
      const c = t.game.context; if (!c.x && !c.z) continue;
      out.tickets.push({ ticket: t.id, x: Math.round(c.x), z: Math.round(c.z), text: `#${t.id} ${t.player || ''}: ${(t.game.title || t.subject || '').slice(0, 60)}` });
    }
  } catch { /* no tickets */ }
  return out;
}

// ---------- loot search from the game ----------
let lootReqAt = 0, lootReqItem = null;
function answerLoot() {
  const req = path.join(dir(), 'loot_req.txt');
  let st; try { st = fs.statSync(req); } catch { return false; }
  const item = fs.readFileSync(req, 'utf8').trim().slice(0, 80);
  // a new request: a new time, other text, or the answer gone (the game deletes it when it asks again)
  if (st.mtimeMs === lootReqAt && item === lootReqItem && fs.existsSync(path.join(dir(), 'loot.json'))) return false;
  lootReqAt = st.mtimeMs; lootReqItem = item;
  const out = { now: now(), item, found: false, reason: '', buildings: 0, spots: [] };
  try {
    const lm = require('./lootmap');
    // exact class first, then the first item whose name contains the text (case-insensitive)
    let name = item; const all = lm.items();
    if (!all.some(i => i.name === name)) { const low = item.toLowerCase(); const m = all.find(i => i.name.toLowerCase() === low) || all.find(i => i.name.toLowerCase().includes(low)); if (m) name = m.name; }
    const r = lm.spawns(name);
    out.item = name; out.found = true; out.buildings = r.buildings;
    out.spots = r.spots.sort((a, b) => b.points - a.points).slice(0, MAX_LOOT).map(s => ({ x: Math.round(s.x), z: Math.round(s.z), n: s.points }));
  } catch (e) { out.reason = e.message; }
  writeIfChanged(path.join(dir(), 'loot.json'), out);
  return true;
}

let lastAt = 0;
// called from the ingest loop: loot answers at once, the other layers once a minute
function ingest({ force = false } = {}) {
  if (!fs.existsSync(settings.paths().profilesDir)) return 0;
  fs.mkdirSync(dir(), { recursive: true });
  let written = answerLoot() ? 1 : 0;
  if (!force && Date.now() - lastAt < 60000) return written;
  lastAt = Date.now();
  for (const r of Object.keys(RANGES)) if (writeIfChanged(path.join(dir(), `timed_${r}.json`), timed(r))) written++;
  if (writeIfChanged(path.join(dir(), 'static.json'), staticLayers())) written++;
  return written;
}

module.exports = { ingest, timed, staticLayers, answerLoot, RANGES };
