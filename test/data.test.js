'use strict';
// jsonstore: atomic writes, damaged files kept aside, unreadable files never replaced; lists never overwritten after a failed read.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'data' });
const js = t.mod('jsonstore'); js.init(t.emit);
t.mod('alerts').init(t.emit);
const f = path.join(t.S, 'data.json');
js.write(f, { a: 1 });
t.ok('write then read, no temp file left', JSON.stringify(js.read(f)) === '{"a":1}' && !fs.readdirSync(t.S).some(n => n.includes('.tmp-')));
fs.writeFileSync(f, '{"a":1, broken');
const v = js.readOr(f, { fresh: true });
t.ok('damaged file kept aside and reported', v.fresh === true && fs.readdirSync(t.S).some(n => n.startsWith('data.json.corrupt-')) && t.lines.some(l => /was damaged/.test(l)));
const g = path.join(t.S, 'locked.json'); fs.mkdirSync(g);
const v2 = js.readOr(g, { empty: true }); const w = js.write(g, { x: 1 });
t.ok('unreadable file: saves refused, original untouched', v2.empty === true && w === false && fs.statSync(g).isDirectory());
const settings = t.settings(); const p = settings.paths(); fs.mkdirSync(p.profilesDir, { recursive: true });
fs.mkdirSync(path.join(p.profilesDir, 'ban.txt')); // a file that exists but cannot be read
const lists = t.mod('lists');
let threw = null; try { lists.add('ban', { id: '76561198000000001', name: 'x' }); } catch (e) { threw = e.message; }
t.ok('unreadable ban list: add refused, list not replaced', /Could not read ban.txt/.test(threw) && fs.statSync(path.join(p.profilesDir, 'ban.txt')).isDirectory());
fs.rmdirSync(path.join(p.profilesDir, 'ban.txt'));
lists.add('ban', { id: '76561198000000001', name: 'x' });
t.ok('missing ban list created normally', lists.has('ban', '76561198000000001'));
t.done();
