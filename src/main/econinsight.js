'use strict';
// Economy insight (plan Phase F): how many of each item are in the world right now against what types.xml asks for.
// Live counts come from the anti-dupe mod's item sweep (loot.txt via anticheat.liveLoot: every item not carried by a
// player, on the ground or in a container, rewritten every 5 minutes). Each item's count follows its own types.xml
// flags the way the Central Economy counts it: count_in_map for loose items, count_in_hoarder for items stored in
// tents, barrels, crates and stashes, count_in_cargo for items inside other items. Items carried by players are not
// in the sweep, so count_in_player is not applied (the count can only be lower than the CE's).
//   under: counted below min, the CE should be spawning it (check usage, value and the restock timer)
//   over: counted above nominal (players hoarding it, an event, admin spawns or dupes)
//   unlisted: in the world but not in any types file (or nominal 0)

// Containers the CE treats as hoarders: storage placed in the world (tents, barrels, sea chests, crates, stashes).
const HOARDER = /(tent$|^barrel_|^barrelholes|^seachest|crate$|stash$)/i;
const isHoarder = cls => HOARDER.test(String(cls || ''));

function typesIndex() {
  const eco = require('./economy');
  const out = new Map();
  for (const f of eco.files().types) {
    if (!f.exists) continue;
    try { for (const r of eco.loadTypes(f.abs)) out.set(r.name.toLowerCase(), { ...r, file: f.label }); } catch { /* skip a broken file */ }
  }
  return out;
}

// counts per class: { map, hoarder, cargo }
function liveCounts(live) {
  const per = new Map();
  for (const [ci, , , pi] of live.items) {
    const cls = live.classes[ci]; const place = live.places[pi];
    let c = per.get(cls); if (!c) { c = { map: 0, hoarder: 0, cargo: 0 }; per.set(cls, c); }
    if (!place || place === '-') c.map++; else if (isHoarder(place)) c.hoarder++; else c.cargo++;
  }
  return per;
}

const on = (v, def) => v === null || v === undefined ? def : !!v;
function counted(c, flags) {
  const f = flags || {};
  return (on(f.count_in_map, true) ? c.map : 0) + (on(f.count_in_hoarder, false) ? c.hoarder : 0) + (on(f.count_in_cargo, false) ? c.cargo : 0);
}

function insight({ overFactor = 1 } = {}) {
  const live = require('./anticheat').liveLoot();
  if (!live.available) return { available: false, reason: live.reason };
  const types = typesIndex();
  const counts = liveCounts(live);
  const rows = [];
  const seen = new Set();
  for (const [cls, c] of counts) {
    const t = types.get(cls.toLowerCase()); seen.add(cls.toLowerCase());
    const total = c.map + c.hoarder + c.cargo;
    if (!t) { rows.push({ name: cls, category: '', nominal: null, min: null, map: c.map, hoarder: c.hoarder, cargo: c.cargo, total, counted: total, status: 'unlisted' }); continue; }
    const n = counted(c, t.flags);
    let status = 'ok';
    if (!t.nominal) status = 'unlisted';
    else if (t.min !== null && n < t.min) status = 'under';
    else if (n > t.nominal * overFactor) status = 'over';
    rows.push({ name: t.name, category: (t.category || [])[0] || '', nominal: t.nominal, min: t.min, map: c.map, hoarder: c.hoarder, cargo: c.cargo, total, counted: n, status, file: t.file });
  }
  // Items types.xml wants (nominal > 0) that are nowhere in the world at all.
  for (const [k, t] of types) {
    if (seen.has(k) || !t.nominal || t.nominal <= 0) continue;
    rows.push({ name: t.name, category: (t.category || [])[0] || '', nominal: t.nominal, min: t.min, map: 0, hoarder: 0, cargo: 0, total: 0, counted: 0, status: t.min ? 'under' : 'ok', file: t.file });
  }
  const sum = s => rows.filter(r => r.status === s).length;
  return { available: true, at: live.at, items: live.count, classes: rows.length, summary: { under: sum('under'), over: sum('over'), unlisted: sum('unlisted'), ok: sum('ok') }, rows };
}

module.exports = { insight, liveCounts, counted, isHoarder };
