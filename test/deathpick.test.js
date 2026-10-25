'use strict';
// The Discord death picker: what /refund, /death and /teleport offer while typing.
const path = require('path');
const t = require('./harness').setup({ name: 'deathpick' });
t.settings();
const now = Date.now();
t.mod('jsonstore').write(path.join(t.S, 'deathlog.json'), { deaths: [
  { id: 1, ts: now - 3 * 3600000, name: 'Bob', key: 'B', cause: 'player', causeText: 'Killed by a player', killer: { name: 'Al' }, weapon: 'AKM', hits: [], byPart: {}, totalDamage: 1, gear: [{ c: 'AKM' }, { c: 'Rag' }], refunds: [], attackers: [] },
  { id: 2, ts: now - 600000, name: 'Cat', key: 'C', cause: 'infected', causeText: 'Killed by infected', killer: null, hits: [], byPart: {}, totalDamage: 1, gear: [], refunds: [], attackers: [] },
  { id: 3, ts: now - 60000, name: 'Bob', key: 'B', cause: 'bleeding', causeText: 'Bled out', killer: null, hits: [], byPart: {}, totalDamage: 1, gear: [{ c: 'Rag' }], refunds: [{ status: 'done', ok: 1 }], attackers: [] }
], nextId: 4, pending: {}, gear: {}, gearFile: { offset: 0, rest: '' }, lastDeathAt: {} });
const discord = t.mod('discord'); discord.init(t.emit);
async function pick(commandName, field, value) { let out = null; await discord._onInteraction({ isAutocomplete: () => true, commandName, options: { getFocused: () => ({ name: field, value }) }, respond: async (c) => { out = c; } }); return out; }
(async () => {
  const all = await pick('refund', 'id', '');
  t.ok('empty search lists newest first', all.length === 3 && all[0].value === '3' && all[2].value === '1', all.map(c => c.name).join(' | '));
  t.ok('names carry the detail', /#1 · Bob · killed by Al with AKM · 2 items · 3 h ago/.test(all[2].name) && /#3 · Bob · Bled out · 1 items · refunded · 1 min ago/.test(all[0].name));
  t.ok('search by player', (await pick('death', 'id', 'bob')).every(c => /Bob/.test(c.name)));
  t.ok('search by weapon', (await pick('teleport', 'death_id', 'akm')).map(c => c.value).join() === '1');
  t.ok('search by killer', (await pick('refund', 'id', 'al')).map(c => c.value).join() === '1');
  t.ok('typing a number finds the record', (await pick('refund', 'id', '2')).map(c => c.value).join() === '2');
  t.ok('every name fits Discord', all.every(c => c.name.length <= 100));
  t.done();
})();
