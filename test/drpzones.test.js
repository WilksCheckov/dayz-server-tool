'use strict';
// DRP Factions loot zones from the map: changes go in as inbox files (never into reward_zones.json, which the mod
// owns), show as pending until the mod picks them up, and can be replaced or taken back meanwhile.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'drpzones' });
const settings = t.settings();
const z = t.mod('drpzones');
const dir = path.join(settings.paths().profilesDir, 'DRP_Factions');

t.ok('no mod: not available', z.state().available === false);
let threw = false; try { z.save({ name: 'x', x: 1, z: 1 }); } catch { threw = true; }
t.ok('no mod: saving refused', threw);

fs.mkdirSync(dir, { recursive: true });
const zonesFile = { enabled: 1, nextZoneId: 3, zones: [
  { id: 1, name: 'Tisy', x: 1600, y: 0, z: 13900, intervalMinutes: 60, lastPaidAt: 5, holderFactionId: 2, items: [{ className: 'AKM', min: 1, max: 1, chance: 25 }] },
  { id: 2, name: 'Airfield', x: 4600, y: 0, z: 10300, intervalMinutes: 1440, lastPaidAt: 0, holderFactionId: -1, items: [] }
] };
fs.writeFileSync(path.join(dir, 'reward_zones.json'), JSON.stringify(zonesFile));
fs.writeFileSync(path.join(dir, 'factions.json'), JSON.stringify({ factions: [{ id: 2, name: 'Monolith', tag: 'MCRP', color: -1754827, claims: [{ cellX: 3, cellZ: 27, kind: 0, readyAt: 0 }, { cellX: 4, cellZ: 27, kind: 1, readyAt: 99 }], captured: [{ cellX: 5, cellZ: 27 }] }] }));
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ cellSizeMeters: 256 }));
const before = fs.readFileSync(path.join(dir, 'reward_zones.json'), 'utf8');

let s = z.state();
t.ok('reads zones, cell size and holder', s.available && s.cellSize === 256 && s.zones.length === 2 && s.zones[0].holder && s.zones[0].holder.tag === 'MCRP', JSON.stringify(s.zones[0].holder));
const mono = s.factions[0];
t.ok('faction colour and cells (home, pending outpost, captured)', mono.color === '#e53935' && mono.cells.length === 3 && mono.cells[1].pending === true && mono.cells[2].kind === 'captured', JSON.stringify(mono));

// edit an existing zone: an inbox file, the zone file untouched
const r1 = z.save({ id: 1, name: ' Tisy base ', x: 1610, z: 13910, intervalMinutes: 1440, items: [{ className: 'AKM', min: 3, max: 1, chance: 150 }, { className: ' ', min: 1 }] });
t.ok('zone file is never written', fs.readFileSync(path.join(dir, 'reward_zones.json'), 'utf8') === before);
const op1 = JSON.parse(fs.readFileSync(path.join(dir, r1.file), 'utf8'));
t.ok('inbox op cleaned up (trimmed name, max >= min, chance capped, blank lines dropped)', op1.op === 'save' && op1.id === 1 && op1.zone.name === 'Tisy base' && op1.zone.items.length === 1 && op1.zone.items[0].min === 3 && op1.zone.items[0].max === 3 && op1.zone.items[0].chance === 100, JSON.stringify(op1));
s = r1.state;
t.ok('pending edit shown over the saved zone, holder kept', s.zones[0].name === 'Tisy base' && s.zones[0].pending === r1.file && s.zones[0].holder && s.pending === 1);

// editing it again replaces the waiting change instead of queueing a second one
const r2 = z.save({ id: 1, name: 'Tisy base', x: 1610, z: 13910, intervalMinutes: 60, items: [] });
t.ok('second edit replaces the first', !fs.existsSync(path.join(dir, r1.file)) && fs.existsSync(path.join(dir, r2.file)) && r2.state.pending === 1);

// a new zone: shown with a temporary id, can be edited and taken back
const r3 = z.save({ id: -1, name: 'New', x: 7000, z: 7000, intervalMinutes: 60, items: [{ className: 'BandageDressing', min: 1, max: 4, chance: 50 }] });
const nz = r3.state.zones.find(x => x.name === 'New');
t.ok('new zone pending with a temporary id', nz && String(nz.id).startsWith('new:') && r3.state.pending === 2);
const r4 = z.save({ ...nz, name: 'New 2' });
t.ok('editing an unsaved zone replaces its file', !fs.existsSync(path.join(dir, r3.file)) && r4.state.zones.filter(x => /^New/.test(x.name)).length === 1);
const nz2 = r4.state.zones.find(x => x.name === 'New 2');
const r5 = z.remove(nz2.id);
t.ok('deleting an unsaved zone just drops its file', !r5.state.zones.some(x => /^New/.test(x.name)) && r5.state.pending === 1);

// delete a saved zone, then take it back
const r6 = z.remove(2);
t.ok('delete is a pending inbox change', r6.state.zones.find(x => x.id === 2).pendingDelete === r6.file);
const r7 = z.undo(r6.file);
t.ok('undo takes the change back', !r7.state.zones.find(x => x.id === 2).pendingDelete);
threw = false; try { z.undo('../reward_zones.json'); } catch { threw = true; }
t.ok('undo only touches inbox files', threw && fs.existsSync(path.join(dir, 'reward_zones.json')));

// file names sort in the order they were made (the mod applies oldest first)
const a = z.save({ id: 2, name: 'A', x: 1, z: 1, items: [] }).file; const b = z.save({ id: -1, name: 'B', x: 2, z: 2, items: [] }).file;
t.ok('inbox names sort oldest first', [b, a].sort()[0] === a, `${a} ${b}`);

// what the mod reports back
fs.writeFileSync(path.join(dir, 'admin_result.json'), JSON.stringify({ seq: 4, messages: ['18:00:00 Saved zone #2'] }));
t.ok('mod result read', z.state().result.seq === 4 && z.state().result.messages.length === 1);
t.ok('colour of a signed ARGB int', z._css(-14776091) === '#1e88e5');
t.done();
