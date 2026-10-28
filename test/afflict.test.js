'use strict';
// Afflictions and the extended player commands (bridge v6): the command lines the bridge receives, validation, the
// frozen / invisible flags read back from players.txt, and the accountability record.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'afflict', stubs: { './server@deathlog': { status: () => ({ running: true }) }, './server@live': { status: () => ({ running: true }) } } });
t.settings(); t.mission();
t.mod('audit').init(t.emit); t.mod('adminlog').init(t.emit);
const dl = t.mod('deathlog'); dl.init(t.emit); dl.installBridge();
const live = t.mod('live'); live.init(t.emit);
const dir = dl.bridgeDir(); fs.mkdirSync(dir, { recursive: true });
const q = path.join(dir, 'commands.txt'), res = path.join(dir, 'results.log');
const write = (name, lines) => fs.writeFileSync(path.join(dir, name), ['#begin|2026-10-25 12:00:00', ...lines, '#end'].join('\r\n') + '\r\n');
function game(answer = 'done|1|0') { const tm = setInterval(() => { if (!fs.existsSync(q)) return; const line = fs.readFileSync(q, 'utf8').trim(); if (!line) return; fs.unlinkSync(q); const f = line.split('|'); game.last = f; fs.appendFileSync(res, `${f[0]}|${answer}\r\n`); clearInterval(tm); }, 100); }
(async () => {
  const initc = fs.readFileSync(dl.bridgeStatus().file, 'utf8');
  t.ok('bridge v7 installed with afflict, freeze, invisible, strip and respawn', /bridge v7/.test(initc) && ['"afflict"', '"freeze"', '"invisible"', '"strip"', '"respawn"'].every(k => initc.includes(k)));
  write('players.txt', ['P1|7656P1|Bob|1000|10|2000|90|1|5000|true|-|false|true|false', 'P2|7656P2|Ann|1100|10|2100|0|1|5000|true|-|true']);
  const L = live.players();
  t.ok('frozen / invisible flags read (and absent on an older bridge line)', L.players[0].frozen === true && L.players[0].invisible === false && L.players[1].frozen === false && L.players[1].god === true, JSON.stringify(L.players));
  let err = ''; try { await live.act('afflict', 'P1', { what: 'sick:plague', reason: 'x' }); } catch (e) { err = e.message; } t.ok('unknown affliction refused', /Unknown affliction/.test(err), err);
  try { await live.act('afflict', 'P1', { what: 'sick:cholera' }); } catch (e) { err = e.message; } t.ok('a reason is required', /reason/.test(err), err);
  game(); let r = await live.act('afflict', 'P1', { what: 'sick:cholera', reason: 'event zombie' });
  t.ok('sickness command line', game.last[1] === 'afflict' && game.last[2] === 'P1' && game.last[3] === 'sick:cholera' && r.status === 'done', game.last.join('|'));
  game(); r = await live.act('afflict', 'P1', { what: 'health:25', reason: 'duel' });
  t.ok('health with a number', game.last[3] === 'health:25', game.last.join('|'));
  game(); r = await live.act('afflict', 'P1', { what: 'BLEED:5', reason: 'rp' });
  t.ok('case-insensitive, bleed count kept', game.last[3] === 'bleed:5', game.last.join('|'));
  game(); r = await live.act('freeze', 'P2', { on: true, reason: 'afk in the safezone' }); t.ok('freeze on', game.last[1] === 'freeze' && game.last[3] === 'on');
  game(); r = await live.act('freeze', 'P2', { on: false, reason: 'back' }); t.ok('freeze off', game.last[3] === 'off');
  game(); r = await live.act('invisible', 'P1', { on: true, reason: 'spectating' }); t.ok('invisible on', game.last[1] === 'invisible' && game.last[3] === 'on');
  game('done|9|0'); r = await live.act('strip', 'P1', { reason: 'cheating' }); t.ok('strip reports the dropped count', game.last[1] === 'strip' && r.ok === 9);
  game(); r = await live.act('respawn', 'P1', { reason: 'stuck under the map' }); t.ok('respawn is one command', game.last[1] === 'respawn' && game.last[2] === 'P1');
  game('nobleed|0|0'); try { await live.act('afflict', 'P1', { what: 'bleed:2', reason: 'x' }); err = ''; } catch (e) { err = e.message; } t.ok('bleeding refusal explained', /could not add a wound/.test(err), err);
  const au = t.mod('audit').list({ limit: 30 });
  t.ok('audited with the affliction name and reason', au.some(a => a.action === 'admin:afflict' && /Bob/.test(a.details) && /cholera/.test(a.details) && /event zombie/.test(a.details)) && au.some(a => a.action === 'admin:strip' && /9 item/.test(a.details)) && au.some(a => a.action === 'admin:respawn'), JSON.stringify(au.filter(a => /admin:/.test(a.action)).map(a => a.action + ' ' + a.details)));
  const A = t.mod('admin-actions');
  t.ok('catalogue: afflictions under admin.afflict, respawn under admin.kill', A.PERM.afflict === 'admin.afflict' && A.PERM.freeze === 'admin.afflict' && A.PERM.strip === 'admin.afflict' && A.PERM.respawn === 'admin.kill' && A.CATEGORY.respawn === 'kill' && A.AFFLICTIONS.length === 19 && A.afflictionLabel('blood:40') === 'Blood down to 40%' && A.afflictionLabel('blood:33') === 'blood down to 33%' && A.afflictionLabel('nope') === null);
  // portal: the new permission exists, admins got it on migration, game masters did not
  const portal = t.mod('portal'); portal.init(t.emit); portal.setOwner('Chris', 'hunter2hunter2');
  const groups = portal.listGroups();
  t.ok('portal: admin.afflict in the catalogue; Admin has it, Game master does not', portal.PERMS.some(p => p[0] === 'admin.afflict') && groups.find(g => g.id === 'admin').perms.includes('admin.afflict') && !groups.find(g => g.id === 'gm').perms.includes('admin.afflict') && portal.CATEGORIES.some(c => c[0] === 'afflict'));
  t.done();
})();
