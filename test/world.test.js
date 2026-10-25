'use strict';
// Vehicles and flags from the bridge (vehicles.txt / flags.txt) and the vehicle actions: parsing, the command line the
// bridge receives, the answers it can give, reasons, and the accountability record.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'world', stubs: { './server@deathlog': { status: () => ({ running: true }) }, './server@live': { status: () => ({ running: true }) } } });
t.settings(); t.mission();
t.mod('audit').init(t.emit); t.mod('adminlog').init(t.emit);
const dl = t.mod('deathlog'); dl.init(t.emit); dl.installBridge();
const live = t.mod('live'); live.init(t.emit);
const dir = dl.bridgeDir(); fs.mkdirSync(dir, { recursive: true });
const q = path.join(dir, 'commands.txt'), res = path.join(dir, 'results.log');
const write = (name, lines) => fs.writeFileSync(path.join(dir, name), ['#begin|2026-10-25 12:00:00', ...lines, '#end'].join('\r\n') + '\r\n');
function game(answer = 'done|1|0') { const tm = setInterval(() => { if (!fs.existsSync(q)) return; const line = fs.readFileSync(q, 'utf8').trim(); if (!line) return; fs.unlinkSync(q); const f = line.split('|'); game.last = f; fs.appendFileSync(res, `${f[0]}|${answer}\r\n`); clearInterval(tm); }, 100); }
(async () => {
  const initc = fs.readFileSync(path.join(require('path').dirname(dl.bridgeStatus().file), 'init.c'), 'utf8');
  t.ok('bridge installed with the world size filled in', /bridge v\d+/.test(initc) && /static const float WORLD = 15360;/.test(initc) && !initc.includes('__DZAT_WORLD__') && /RunVehicle/.test(initc));
  write('players.txt', ['P1|7656P1|Bob|1000|10|2000|90|1|5000|true|-|false']);
  let W = live.world(); t.ok('no vehicles file: says the bridge is needed', !W.available && /bridge script v5/.test(W.reason), W.reason);
  write('vehicles.txt', ['1-2-3-4|OffroadHatchback|4500.5|200|10200.25|45|0.8|0.5|true|Bob|2|false', 't1|CivilianSedan|100|5|200|0|0.1|-|false|-|0|true']);
  write('flags.txt', ['7000|120|7500|0.75']);
  W = live.world();
  t.ok('vehicles parsed', W.available && W.vehicles.length === 2 && W.vehicles[0].id === '1-2-3-4' && W.vehicles[0].cls === 'OffroadHatchback' && W.vehicles[0].x === 4500.5 && W.vehicles[0].z === 10200.25 && W.vehicles[0].heading === 45 && W.vehicles[0].health === 0.8 && W.vehicles[0].fuel === 0.5 && W.vehicles[0].engine === true && W.vehicles[0].driver === 'Bob' && W.vehicles[0].crew === 2, JSON.stringify(W));
  t.ok('a ruined one without fuel data', W.vehicles[1].ruined && W.vehicles[1].fuel === null && W.vehicles[1].driver === null);
  t.ok('flags parsed', W.flags.length === 1 && W.flags[0].x === 7000 && W.flags[0].refresher === 0.75);
  let err = ''; try { await live.vact('vrepair', '1-2-3-4', {}); } catch (e) { err = e.message; } t.ok('a reason is required', /reason/.test(err), err);
  try { await live.vact('vrepair', 'nope', { reason: 'x' }); } catch (e) { err = e.message; } t.ok('unknown vehicle refused before anything is sent', /not on the map/.test(err), err);
  try { await live.vact('vbreak', '1-2-3-4', { reason: 'x', what: 'doors' }); } catch (e) { err = e.message; } t.ok('break needs a known kind', /tyres, fuel, engine, battery or all/.test(err), err);
  game(); let r = await live.vact('vrepair', '1-2-3-4', { reason: 'event car' });
  t.ok('repair command line: type and vehicle id', game.last[1] === 'vrepair' && game.last[2] === '1-2-3-4' && r.status === 'done', game.last.join('|'));
  game(); r = await live.vact('vbreak', '1-2-3-4', { reason: 'punish', what: 'tyres' });
  t.ok('break sends the kind', game.last[1] === 'vbreak' && game.last[3] === 'tyres', game.last.join('|'));
  game(); r = await live.vact('vtp', 't1', { reason: 'stuck', x: 1234.4, z: 5678 });
  t.ok('move sends the position', game.last[1] === 'vtp' && game.last[2] === 't1' && game.last[4] === '1234.4' && game.last[5] === '5678', game.last.join('|'));
  game(); r = await live.vact('vbring', 't1', { reason: 'to bob', to: 'P1' });
  t.ok('bring sends the player id', game.last[1] === 'vbring' && game.last[3] === 'P1', game.last.join('|'));
  game('occupied|0|0'); try { await live.vact('vdelete', '1-2-3-4', { reason: 'x' }); err = ''; } catch (e) { err = e.message; } t.ok('delete refused while occupied', /get them out/.test(err), err);
  game('noveh|0|0'); try { await live.vact('vdestroy', 't1', { reason: 'x' }); err = ''; } catch (e) { err = e.message; } t.ok('vehicle gone in the game', /no longer has/.test(err), err);
  const au = t.mod('audit').list({ limit: 20 });
  t.ok('vehicle actions are admin actions with the vehicle and reason', au.some(a => a.action === 'admin:vrepair' && /OffroadHatchback \(1-2-3-4\) at 4501, 10200/.test(a.details) && /event car/.test(a.details)) && au.some(a => a.action === 'admin:vbring' && /Bob/.test(a.details)), JSON.stringify(au.filter(a => /admin:v/.test(a.action)).map(a => a.details)));
  t.ok('console line names the action', t.lines.some(l => /Repair vehicle · OffroadHatchback/.test(l)));
  const A = t.mod('admin-actions');
  t.ok('catalogue: every vehicle action needs admin.vehicles and the vehicles approval category', A.VEHICLE_ACTIONS.length === 8 && A.VEHICLE_ACTIONS.every(k => A.PERM[k] === 'admin.vehicles' && A.CATEGORY[k] === 'vehicles' && A.NEEDS_REASON.includes(k)));
  t.ok('catalogue: refund and message need no reason', !A.NEEDS_REASON.includes('refund') && !A.NEEDS_REASON.includes('message') && A.NEEDS_REASON.includes('kill'));
  t.done();
})();
