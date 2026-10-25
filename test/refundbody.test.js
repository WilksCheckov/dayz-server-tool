'use strict';
// Refund: asks the bridge to remove the body (with the exact corpse position), from the app and from Discord alike;
// the body field of the result is read; the switch turns it off.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'refundbody', stubs: { './server@deathlog': { status: () => ({ running: true }) } } });
const settings = t.settings(); t.mission();
t.mod('jsonstore').write(path.join(t.S, 'deathlog.json'), { deaths: [{ id: 5, ts: 1000000, name: 'Bob', key: 'BOBID', cause: 'player', causeText: 'x', hits: [], byPart: {}, totalDamage: 1, gear: [{ c: 'AKM' }, { c: 'Rag' }], refunds: [], attackers: [] }], nextId: 6, pending: {}, gear: { BOBID: [{ ts: 1000500, dead: true, pos: [1234.5, 10, 6789.25], items: [] }] }, gearFile: { offset: 0, rest: '' }, lastDeathAt: {} });
const dl = t.mod('deathlog'); dl.init(t.emit);
dl.installBridge();
const q = path.join(dl.bridgeDir(), 'commands.txt'), res = path.join(dl.bridgeDir(), 'results.log');
function game() { const tm = setInterval(() => { if (!fs.existsSync(q)) return; const line = fs.readFileSync(q, 'utf8').trim(); if (!line) return; fs.unlinkSync(q); const f = line.split('|'); game.last = f; fs.appendFileSync(res, `${f[0]}|done|2|0|${f[3] === 'delbody' ? 'body' : 'kept'}\r\n`); clearInterval(tm); }, 100); }
(async () => {
  game(); const r1 = await dl.refund(5, { by: 'map' });
  t.ok('app refund asks for the body with the corpse position', game.last[3] === 'delbody' && game.last[4] === '1234.5' && game.last[5] === '6789.25', game.last.slice(1, 6).join('|'));
  t.ok('body result read', r1.status === 'done' && r1.ok === 2 && r1.body === 'body' && r1.items === 2, JSON.stringify(r1));
  t.ok('console says the body went', t.lines.some(l => /body and everything on it were removed/.test(l)));
  game(); const r2 = await dl.refund(5, { by: 'Admin Cat#1' });
  t.ok('Discord refund removes the body too', game.last[3] === 'delbody' && r2.body === 'body');
  settings.save({ deathlog: { deleteBody: false } }); game(); const r3 = await dl.refund(5, { by: 'app' });
  t.ok('switch off: body kept', game.last[3] === '-' && r3.body === 'kept');
  t.ok('refunds recorded on the death', dl.get(5).refunds.length === 3 && dl.get(5).refunds.every(f => f.status === 'done'));
  t.done();
})();
