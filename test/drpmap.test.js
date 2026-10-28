'use strict';
// Map layers for DRP_Admin's in-game Map window: admin log positions use the game's axes (z north, y height), old
// death records are migrated, deaths and heat are written per time range, static layers carry vehicle spawns and
// tickets, a loot search from the game is answered, and unchanged files are not rewritten.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'drpmap', stubs: {
  './mission@heat': { mapInfo: () => ({ map: 'chernarusplus', size: 15360 }) },
  './lootmap@drpmap': {
    items: () => [{ name: 'AKM', nominal: 20, min: 10 }, { name: 'Mosin9130', nominal: 30, min: 15 }],
    spawns: (n) => { if (n !== 'AKM') throw new Error('Unknown item ' + n); return { buildings: 2, spots: [{ x: 100.4, z: 200.6, points: 1 }, { x: 300, z: 400, points: 5 }] }; },
    vehicleSpawns: () => [{ event: 'VehicleCivilianSedan', types: ['CivilianSedan'], positions: [{ x: 5000, z: 6000 }] }]
  },
  './anticheat@drpmap': { liveLoot: () => ({ available: true, at: Date.now() - 120000, classes: ['AKM', 'Rag'], places: ['-', 'Land_Barn'], items: [[0, 100, 200, 1], [0, 300, 400, 0], [1, 5, 5, 0]] }) },
  './live@drpmap': { kits: () => [{ name: 'Medic', lines: ['BandageDressing x2', 'Morphine'] }], kitItems: () => ['BandageDressing', 'BandageDressing', 'Morphine'] },
  './tickets@drpmap': { all: () => [
    { id: '0007', status: 'open', player: 'Bob', subject: 's', game: { title: 'Lost gear', context: { x: 1210.2, z: 3390.7 } } },
    { id: '0008', status: 'closed', player: 'Al', game: { title: 'x', context: { x: 1, z: 1 } } }
  ] }
} });
const settings = t.mod('settings'); settings.save({ installDir: path.join(t.S, 'i') });
fs.mkdirSync(settings.paths().profilesDir, { recursive: true });

// the admin log writes pos=<x, north, height>
const players = t.mod('players');
const ev = players.parseLine('12:00:00 | Player "Bob" (id=GBOB pos=<10853.4, 2318.9, 3.6>) placed Fireplace', { date: '2026-10-27', lastSec: -1 });
t.ok('admin log positions use the game axes: z north, y height', ev.pos.x === 10853.4 && ev.pos.z === 2318.9 && ev.pos.y === 3.6, JSON.stringify(ev.pos));

// a death record from before the fix: north in pos.y, height in pos.z
t.mod('jsonstore').write(path.join(t.S, 'deathlog.json'), { deaths: [{ id: 7, ts: Date.now() - 600000, name: 'Bob', key: 'GBOB', cause: 'player', causeText: 'killed by Al', killer: { name: 'Al' }, weapon: 'AKM', pos: { x: 1200, y: 3400, z: 5 }, hits: [], byPart: {}, totalDamage: 90, gear: null, refunds: [], attackers: [] }], nextId: 8, pending: {}, gear: {}, gearFile: { offset: 0, rest: '' }, lastDeathAt: {} });
const dl = t.mod('deathlog'); dl.init(t.emit);
t.ok('old death records are migrated to the game axes', JSON.stringify(dl.get(7).deathPos) === '[1200,3400]', JSON.stringify(dl.get(7).deathPos));

// heat: a fresh store, then positions recorded the new way
const heat = t.mod('heat'); heat.init(t.emit);
const at = (min) => Date.now() - min * 60000;
heat.record({ ...ev, ts: at(5), type: 'other' });
heat.record({ ...ev, ts: at(6), type: 'other' });
heat.record({ ...ev, ts: at(90), type: 'build' });
const map = t.mod('drpmap');
const h1 = map.timed('1h'), h24 = map.timed('24h');
const cell = 15360 / 128;
t.ok('heat cell from the north axis, two travel positions in the last hour', h1.heat.travel.join(',') === `${Math.floor(10853.4 / cell)},${Math.floor(2318.9 / cell)},2`, h1.heat.travel.join(','));
t.ok('the 90-minute-old build is only in the 24 h range', h1.heat.build.length === 0 && h24.heat.build[2] === 1);
t.ok('deaths carry id, position, cause and text', h1.deaths.length === 1 && h1.deaths[0].id === 7 && h1.deaths[0].x === 1200 && h1.deaths[0].z === 3400 && h1.deaths[0].cause === 'player' && /Bob: killed by Al \(AKM\)/.test(h1.deaths[0].text), JSON.stringify(h1.deaths));

// the files the game reads
const dir = path.join(settings.paths().profilesDir, 'DayZAdminTools', 'map');
t.ok('first run writes the three ranges, the static layers and the kits', map.ingest({ force: true }) === 5 && ['timed_1h', 'timed_24h', 'timed_7d', 'static'].every(n => fs.existsSync(path.join(dir, n + '.json'))));
const kits = JSON.parse(fs.readFileSync(path.join(settings.paths().profilesDir, 'DayZAdminTools', 'kits.json'), 'utf8'));
t.ok('kits for the game: one line per item', kits.kits.length === 1 && kits.kits[0].name === 'Medic' && kits.kits[0].items.join(',') === 'BandageDressing,BandageDressing,Morphine');
const st = JSON.parse(fs.readFileSync(path.join(dir, 'static.json'), 'utf8'));
t.ok('static: vehicle spawns with their types', st.vspawns.length === 1 && st.vspawns[0].x === 5000 && st.vspawns[0].text === 'CivilianSedan');
t.ok('static: open tickets with a position only', st.tickets.length === 1 && st.tickets[0].ticket === '0007' && st.tickets[0].x === 1210 && /#0007 Bob: Lost gear/.test(st.tickets[0].text));
t.ok('nothing changed, nothing rewritten', map.ingest({ force: true }) === 0);

// loot search: the game writes the item, the app answers at once (fuzzy name allowed)
fs.writeFileSync(path.join(dir, 'loot_req.txt'), 'akm');
t.ok('a loot request is answered without waiting for the minute', map.ingest() === 1);
const loot = JSON.parse(fs.readFileSync(path.join(dir, 'loot.json'), 'utf8'));
t.ok('loot: the matched class, busiest building first', loot.found && loot.item === 'AKM' && loot.buildings === 2 && loot.spots[0].n === 5 && loot.spots[1].x === 100, JSON.stringify(loot));
fs.writeFileSync(path.join(dir, 'loot_req.txt'), 'nosuchthing');
map.ingest();
const miss = JSON.parse(fs.readFileSync(path.join(dir, 'loot.json'), 'utf8'));
t.ok('an unknown item says why', !miss.found && /Unknown item/.test(miss.reason), JSON.stringify(miss));

// live items: where an item is now, with the economy's nominal and min
fs.writeFileSync(path.join(dir, 'items_req.txt'), 'akm');
map.ingest();
const now = JSON.parse(fs.readFileSync(path.join(dir, 'items.json'), 'utf8'));
t.ok('live items: count, positions, places, nominal and min', now.found && now.item === 'AKM' && now.count === 2 && now.spots[0].text === 'Land_Barn' && now.nominal === 20 && now.min === 10 && now.ago >= 119, JSON.stringify(now));
fs.writeFileSync(path.join(dir, 'items_req.txt'), 'Mosin');
map.ingest();
t.ok('an item that is nowhere says so', /No Mosin in the world/.test(JSON.parse(fs.readFileSync(path.join(dir, 'items.json'), 'utf8')).reason));
t.done();
