'use strict';
// Movement watch: a jump is held until DRP_Admin's teleport events have been read; one that an in-game admin
// teleport explains (the admin or the target) is dropped, one that nothing explains is a "teleport without admin
// action", and fast movement over two samples stays "impossible movement".
const flags = []; let pos = {}; let at = 0; let ingests = 0;
const t = require('./harness').setup({ name: 'netwatch', stubs: {
  './live@netwatch': { players: () => ({ available: true, at, players: Object.entries(pos).map(([id, [x, z]]) => ({ id, steam: 'S' + id, name: 'P' + id, x, y: 0, z, alive: true, vehicle: null, god: false, frozen: false, invisible: false })) }) },
  './combat@netwatch': { flagExternal: (id, name, reason, detail) => flags.push({ id, reason, detail }) },
  './drpadmin@netwatch': { ingest: () => { ingests++; return 0; } },
} });
const nw = t.mod('netwatch'); const { sampleMovement } = nw._test;
const T0 = Date.now() - 60000;

at = T0; pos = { A: [0, 0], B: [0, 0], C: [0, 0], D: [0, 0] }; sampleMovement();
at = T0 + 4000; pos = { A: [500, 0], B: [500, 0], C: [50, 0], D: [0, 600] }; sampleMovement();
at = T0 + 8000; pos.C = [100, 0]; sampleMovement();
t.ok('nothing is flagged while the flags are held', flags.length === 0);

nw.noteGameTeleport({ action: 'bring', by: { id: 'ADM', steam: 'SADM' }, target: { id: 'B', steam: 'SB' }, ts: T0 + 3000 });
nw.noteGameTeleport({ action: 'tp_cursor', by: { id: 'X', steam: 'SD' }, ts: T0 + 5000 });
t.ok('only teleport actions count', nw.noteGameTeleport({ action: 'heal', by: { id: 'A' }, ts: T0 }) === false);

nw._test.releaseHeld(Date.now() + 21000);
const of = id => flags.filter(f => f.id === id).map(f => f.reason);
t.ok('the mod events are read before releasing', ingests >= 1);
t.ok('a jump nothing explains is a teleport without admin action', of('A').join() === 'teleport without admin action');
t.ok('the target of an in-game Bring is not flagged', of('B').length === 0);
t.ok('an admin teleporting themselves (matched by Steam64) is not flagged', of('D').length === 0);
t.ok('fast movement over two samples is impossible movement', of('C').join() === 'impossible movement');
t.done();
