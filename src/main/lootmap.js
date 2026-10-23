'use strict';
// Where an item can spawn, computed from the mission: building positions (mapgrouppos.xml), each building's loot
// containers and their usage/category/tag flags (mapgroupproto.xml), the item's flags (types files) and the tier
// regions in areaflags.map. The same rules the central economy applies, so the result is "every building where
// this item is eligible", weighted by the number of matching loot points.
const fs = require('fs');
const path = require('path');
const configs = require('./configs');
const { xmlParser } = configs;

const arr = x => x === undefined ? [] : Array.isArray(x) ? x : [x];
const attr = (o, n) => o && o['@_' + n];
let cache = { mission: null, protos: null, groups: null, area: null, items: null, itemsAt: 0 };

function mission() { const m = configs.missionDir(); if (!m || !fs.existsSync(m)) throw new Error('No active mission folder.'); return m; }
function ensure() {
  const m = mission();
  if (cache.mission === m && cache.protos) return cache;
  // prototypes: group name -> containers [{usage:[], category:[], tag:[], points:n, lootmax}] + group-level usage
  const protos = {};
  try {
    // the root element is <prototype>, which the XML parser refuses as a property name; rename it before parsing
    const doc = xmlParser.parse(fs.readFileSync(path.join(m, 'mapgroupproto.xml'), 'utf8').replace(/<(\/?)prototype\b/g, '<$1protoroot'));
    for (const g of arr(doc.protoroot && doc.protoroot.group)) {
      const gUsage = arr(g.usage).map(u => attr(u, 'name')).filter(Boolean);
      const containers = arr(g.container).map(c => ({ name: attr(c, 'name'), lootmax: Number(attr(c, 'lootmax')) || 0, usage: arr(c.usage).map(u => attr(u, 'name')).filter(Boolean), category: arr(c.category).map(u => attr(u, 'name')).filter(Boolean), tag: arr(c.tag).map(u => attr(u, 'name')).filter(Boolean), points: arr(c.point).length }));
      protos[attr(g, 'name')] = { usage: gUsage, lootmax: Number(attr(g, 'lootmax')) || 0, containers };
    }
  } catch (e) { throw new Error('Could not read mapgroupproto.xml: ' + e.message); }
  // building instances
  const groups = [];
  try {
    const text = fs.readFileSync(path.join(m, 'mapgrouppos.xml'), 'utf8');
    for (const mm of text.matchAll(/<group\s+name="([^"]+)"\s+pos="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/g)) groups.push({ name: mm[1], x: Number(mm[2]), z: Number(mm[4]) });
  } catch (e) { throw new Error('Could not read mapgrouppos.xml: ' + e.message); }
  // area flags (tier regions): header of six uint32, then W*H uint32 usage bits, then W*H uint8 tier bits
  let area = null;
  try {
    const f = path.join(m, 'areaflags.map'); const fd = fs.openSync(f, 'r'); const h = Buffer.alloc(24); fs.readSync(fd, h, 0, 24, 0);
    const W = h.readUInt32LE(0), H = h.readUInt32LE(4), WX = h.readUInt32LE(8), WZ = h.readUInt32LE(12);
    const total = fs.statSync(f).size;
    if (W && H && total >= 24 + W * H * 5) {
      const tierBuf = Buffer.alloc(W * H); fs.readSync(fd, tierBuf, 0, W * H, 24 + W * H * 4);
      const usageBuf = Buffer.alloc(W * H * 4); fs.readSync(fd, usageBuf, 0, W * H * 4, 24);
      area = { W, H, WX, WZ, tier: tierBuf, usage: usageBuf };
    }
    fs.closeSync(fd);
  } catch { area = null; }
  let lim = null; try { lim = require('./economy').limits(); } catch { lim = null; }
  cache = { mission: m, protos, groups, area, limits: lim, items: null, itemsAt: 0 };
  return cache;
}
function limitsOf(c) { return c.limits || { usages: [], values: [], categories: [], tags: [] }; }
function areaAt(c, x, z) {
  const a = c.area; if (!a) return { tiers: null, usages: [] };
  const cx = Math.min(a.W - 1, Math.max(0, Math.floor(x / a.WX * a.W))), cz = Math.min(a.H - 1, Math.max(0, Math.floor(z / a.WZ * a.H)));
  const i = cz * a.W + cx; const t = a.tier[i]; const u = a.usage.readUInt32LE(i * 4);
  const lim = limitsOf(c);
  return { tiers: lim.values.filter((_, k) => t & (1 << k)), usages: lim.usages.filter((_, k) => u & (1 << k)) };
}

// All item rows across the mission's types files (cached for a minute).
function items() {
  const c = ensure();
  if (c.items && Date.now() - c.itemsAt < 60000) return c.items;
  const eco = require('./economy'); const out = new Map();
  for (const f of eco.files().types.filter(x => x.exists)) { try { for (const r of eco.loadTypes(f.abs)) if (!out.has(r.name)) out.set(r.name, { name: r.name, nominal: r.nominal, min: r.min, usage: r.usage, category: r.category, value: r.value, tag: r.tag, flags: r.flags }); } catch { /* skip */ } }
  c.items = [...out.values()].sort((a, b) => a.name.localeCompare(b.name)); c.itemsAt = Date.now();
  return c.items;
}
const inter = (a, b) => a.some(x => b.includes(x));

// Buildings where the item can spawn: [{x, z, name, points}] plus a summary.
function spawns(itemName) {
  const c = ensure();
  const item = items().find(i => i.name === itemName);
  if (!item) throw new Error('Unknown item ' + itemName);
  const result = []; let buildings = 0, points = 0; const byBuilding = {};
  const protoMatch = {}; // prototype name -> matching points per area usage set (cache per proto + area usages key)
  for (const g of c.groups) {
    const p = c.protos[g.name]; if (!p) continue;
    const area = areaAt(c, g.x, g.z);
    if (item.value.length && area.tiers && !inter(item.value, area.tiers)) continue; // wrong tier region
    const key = g.name + '|' + area.usages.join(',');
    let n = protoMatch[key];
    if (n === undefined) {
      n = 0;
      for (const ct of p.containers) {
        const usage = [...ct.usage, ...p.usage, ...area.usages];
        if (item.usage.length && usage.length && !inter(item.usage, usage)) continue;
        if (item.usage.length && !usage.length) continue;
        if (ct.category.length && item.category.length && !inter(item.category, ct.category)) continue;
        if (item.tag.length && ct.tag.length && !inter(item.tag, ct.tag)) continue;
        n += ct.points || 1;
      }
      protoMatch[key] = n;
    }
    if (!n) continue;
    result.push({ x: g.x, z: g.z, name: g.name, points: n }); buildings++; points += n; byBuilding[g.name] = (byBuilding[g.name] || 0) + 1;
  }
  const top = Object.entries(byBuilding).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
  return { item, buildings, points, spots: result, top, tiers: !!c.area, totalBuildings: c.groups.length };
}

// Vehicle spawns: events named Vehicle* in db/events.xml (with the vehicle types they spawn and their counts) and
// their positions in cfgeventspawns.xml.
let vehCache = { key: '', data: null };
function vehicleSpawns() {
  const m = mission(); const ev = path.join(m, 'db', 'events.xml'), sp = path.join(m, 'cfgeventspawns.xml');
  let key = ''; try { key = fs.statSync(ev).mtimeMs + '|' + fs.statSync(sp).mtimeMs; } catch { return []; }
  if (vehCache.key === key) return vehCache.data;
  const evText = fs.readFileSync(ev, 'utf8'), spText = fs.readFileSync(sp, 'utf8');
  const num = (body, tag) => { const r = body.match(new RegExp('<' + tag + '>\\s*(-?\\d+)\\s*</' + tag + '>')); return r ? Number(r[1]) : null; };
  const events = new Map();
  for (const e of evText.matchAll(/<event\s+name="(Vehicle[^"]*)"\s*>([\s\S]*?)<\/event>/gi)) {
    const body = e[2];
    events.set(e[1], { event: e[1], nominal: num(body, 'nominal'), min: num(body, 'min'), max: num(body, 'max'), active: num(body, 'active') !== 0, types: [...body.matchAll(/<child\b[^>]*\btype="([^"]+)"/gi)].map(x => x[1]), positions: [] });
  }
  for (const e of spText.matchAll(/<event\s+name="([^"]+)"\s*>([\s\S]*?)<\/event>/gi)) {
    const ev2 = events.get(e[1]); if (!ev2) continue;
    for (const p of e[2].matchAll(/<pos\b[^>]*\bx="([-\d.]+)"[^>]*\bz="([-\d.]+)"/gi)) ev2.positions.push({ x: Number(p[1]), z: Number(p[2]) });
  }
  vehCache = { key, data: [...events.values()].filter(e => e.positions.length || e.types.length).sort((a, b) => a.event.localeCompare(b.event)) };
  return vehCache.data;
}
module.exports = { items, spawns, vehicleSpawns };
