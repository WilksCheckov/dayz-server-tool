'use strict';
// Economy insight: live counts from the item sweep against types.xml nominal and min, each item counted by its own
// count_in_map / count_in_hoarder / count_in_cargo flags; under, over and unlisted items.
const T = (name, nominal, min, flags = {}) => ({ name, nominal, min, category: ['tools'], flags: { count_in_map: 1, count_in_hoarder: 0, count_in_cargo: 0, ...flags } });
const t = require('./harness').setup({ name: 'econinsight', stubs: {
  './anticheat@econinsight': { liveLoot: () => ({ available: true, at: 1, count: 9,
    classes: ['Hammer', 'Rope', 'Mystery', 'Apple'], places: ['-', 'MediumTent', 'Barrel_Blue', 'FieldBackpack'],
    // Hammer: 1 ground, 2 in a tent, 1 in a backpack; Rope: 3 ground; Mystery: 1 ground; Apple: 1 in a backpack
    items: [[0, 1, 1, 0], [0, 1, 1, 1], [0, 1, 1, 2], [0, 1, 1, 3], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [2, 1, 1, 0], [3, 1, 1, 3]] }) },
  './economy@econinsight': { files: () => ({ types: [{ label: 'db/types.xml', abs: 'x', exists: true }] }),
    loadTypes: () => [T('Hammer', 10, 5, { count_in_hoarder: 1 }), T('Rope', 2, 1), T('Apple', 20, 10, { count_in_cargo: 1 }), T('Shovel', 4, 2), T('Unused', 0, 0)] },
} });
const E = t.mod('econinsight');
t.ok('tents and barrels are hoarders, backpacks are not', E.isHoarder('MediumTent') && E.isHoarder('Barrel_Blue') && E.isHoarder('WoodenCrate') && !E.isHoarder('FieldBackpack'));
const r = E.insight(); const row = n => r.rows.find(x => x.name === n);
t.ok('counts split by where the item is', row('Hammer').map === 1 && row('Hammer').hoarder === 2 && row('Hammer').cargo === 1 && row('Hammer').total === 4);
t.ok('the count follows the item flags (hoarder on, cargo off)', row('Hammer').counted === 3 && row('Hammer').status === 'under');
t.ok('above nominal is over', row('Rope').counted === 3 && row('Rope').status === 'over');
t.ok('cargo counts when count_in_cargo is on', row('Apple').counted === 1 && row('Apple').status === 'under');
t.ok('in the world but not in types is unlisted', row('Mystery').status === 'unlisted' && row('Mystery').nominal === null);
t.ok('wanted but nowhere in the world is under', row('Shovel').total === 0 && row('Shovel').status === 'under');
t.ok('nominal 0 and absent is not listed', !row('Unused'));
t.ok('a summary of the states', r.summary.under === 3 && r.summary.over === 1 && r.summary.unlisted === 1);
t.done();
