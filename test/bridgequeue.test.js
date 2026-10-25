'use strict';
// The bridge command queue: a command the game never picks up is withdrawn; one it picks up late is tracked to its
// result; stale commands are dropped before a start.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'bridgequeue', stubs: { './server@deathlog': { status: () => ({ running: true }) } } });
t.settings(); t.mission();
const dl = t.mod('deathlog'); dl.init(t.emit);
dl.installBridge();
const q = path.join(dl.bridgeDir(), 'commands.txt');
(async () => {
  const r1 = await dl.sendCommand({ type: 'heal', id: 'P1', what: 'all' }, { by: 'test', timeoutMs: 2500 });
  t.ok('unanswered command withdrawn', r1.status === 'timeout' && r1.withdrawn && !(fs.existsSync(q) && fs.readFileSync(q, 'utf8').trim()), JSON.stringify(r1));
  // a game that takes the command and answers 4 s later
  const watcher = setInterval(() => { if (!fs.existsSync(q)) return; const line = fs.readFileSync(q, 'utf8').trim(); if (!line) return; const nonce = line.split('|')[0]; fs.unlinkSync(q); setTimeout(() => fs.appendFileSync(path.join(dl.bridgeDir(), 'results.log'), `${nonce}|done|1|0\r\n`), 4000); clearInterval(watcher); }, 100);
  const r2 = await dl.sendCommand({ type: 'heal', id: 'P1', what: 'all' }, { by: 'test', timeoutMs: 2500, onLate: (res) => { t.ok('late result delivered to the caller', res.status === 'done' && res.ok === 1); } });
  t.ok('picked up but slow: pending, not withdrawn', r2.status === 'pending');
  await t.sleep(7000);
  t.ok('late result reported', t.lines.some(l => /finished late: done/.test(l)), t.lines.filter(l => /late/.test(l)).slice(-1)[0]);
  fs.writeFileSync(q, 'abc|refund|x|-|-|-|A\r\ndef|tp|y|-|1|2|-\r\n');
  dl.ensureBridge();
  t.ok('stale queue dropped before a start', !fs.existsSync(q) && t.lines.some(l => /Dropped 2 refund/.test(l)));
  t.done();
})();
