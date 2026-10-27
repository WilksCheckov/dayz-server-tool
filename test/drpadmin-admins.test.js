'use strict';
// DRP_Admin phase B: in-game admins come from the portal (Steam id + admin.menu, in-game permissions only) and the
// owner Steam ids; admins.json is written only on change and never emptied while it lists someone. In-game admin
// events from events.jsonl reach the admin log with readable details, and old events are not replayed.
const fs = require('fs'); const path = require('path');
const recorded = [];
const t = require('./harness').setup({ name: 'drpadmin-admins', stubs: { './adminlog@drpadmin': { record: (r) => recorded.push(r) } } });
const settings = t.settings();
const portal = t.mod('portal'); portal.init && portal.init(t.emit);
const da = t.mod('drpadmin'); da.init(t.emit);
const file = path.join(settings.paths().profilesDir, 'DRP_Admin', 'admins.json');
const read = () => JSON.parse(fs.readFileSync(file, 'utf8')).admins;

// a hand-made file survives while the portal has no in-game admin
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ admins: [{ steam: '76561198000000001', name: 'hand', perms: ['*'] }] }));
let r = da.syncAdmins();
t.ok('a hand-made admins.json is kept while the portal has nobody', !r.written && read()[0].name === 'hand', JSON.stringify(r));

// portal users: Steam id validation, and only users with admin.menu and a Steam id are admins
let threw = null; try { portal.createUser({ name: 'bad', password: 'password1', steam: '12345' }); } catch (e) { threw = e.message; }
t.ok('a wrong Steam id is refused', /17 digits/.test(threw || ''));
portal.createUser({ name: 'Boss', password: 'password1', groups: ['owner'] });	// the portal always keeps a manager
portal.createUser({ name: 'Gina', password: 'password1', groups: ['gm'], steam: '76561198000000002' });
portal.createUser({ name: 'Mo', password: 'password1', groups: ['moderator'], steam: '76561198000000003' });
portal.createUser({ name: 'Ada', password: 'password1', groups: ['admin'] });
const admins = read();
t.ok('the file follows the portal: game master with a Steam id', admins.length === 1 && admins[0].name === 'Gina' && admins[0].steam === '76561198000000002', JSON.stringify(admins));
t.ok('only in-game permissions are written', admins[0].perms.includes('admin.menu') && admins[0].perms.includes('admin.spawn') && !admins[0].perms.includes('server.view') && !admins[0].perms.includes('deaths.view') && admins[0].perms.includes('tickets.view'), admins[0].perms.join(','));
t.ok('a moderator (no admin.menu) and a user without a Steam id are left out', !admins.some(a => a.name === 'Mo' || a.name === 'Ada'));
threw = null; try { portal.updateUser('ada', { steam: '76561198000000002' }); } catch (e) { threw = e.message; }
t.ok('one Steam id belongs to one user', /already belongs to Gina/.test(threw || ''));
portal.updateUser('ada', { steam: '76561198000000004' });
t.ok('giving a user a Steam id adds them at once', read().some(a => a.name === 'Ada' && a.perms.includes('admin.weather')));
portal.updateUser('gina', { enabled: false });
t.ok('a disabled user is removed', !read().some(a => a.name === 'Gina'));

// owners get everything and win over a portal user with the same id
da.setOwners('76561198000000004 76561198000000009');
const owners = read();
t.ok('owner Steam ids get "*"', owners.filter(a => a.perms[0] === '*').length === 2 && owners.find(a => a.steam === '76561198000000004').name === 'Owner');
threw = null; try { da.setOwners('not-an-id'); } catch (e) { threw = e.message; }
t.ok('a wrong owner id is refused', /Not a Steam64 id/.test(threw || ''));
const before = fs.statSync(file).mtimeMs;
r = da.syncAdmins();
t.ok('an unchanged list is not rewritten', !r.written && fs.statSync(file).mtimeMs === before);

// in-game admin events into the admin log
const ev = path.join(settings.paths().profilesDir, 'DayZAdminTools', 'events.jsonl');
fs.mkdirSync(path.dirname(ev), { recursive: true });
const stamp = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const now = stamp(new Date()); const old = stamp(new Date(Date.now() - 3600000));
const by = '{"id":"G","steam":"76561198000000004","name":"Ada"}';
const bob = '{"id":"B","steam":"76561198000000005","name":"Bob"}';
fs.writeFileSync(ev, [
  `{"t":"${old}","ev":"admin","action":"heal","by":${by},"target":${bob},"detail":true}`,
  `{"t":"${now}","ev":"admin","action":"heal","by":${by},"target":${bob},"detail":true}`,
  `{"t":"${now}","ev":"admin","action":"stat","by":${by},"target":${bob},"detail":{"stat":"blood","share":0.5}}`,
  `{"t":"${now}","ev":"admin","action":"spawn","by":${by},"detail":{"cls":"OffroadHatchback","count":1,"health":1,"vehicle":true,"parts":12,"pos":[100,2,200]}}`,
  `{"t":"${now}","ev":"admin","action":"god","by":${by},"detail":false}`,
  `{"t":"${now}","ev":"admin","action":"message","by":${by},"target":${bob},"detail":"stop that"}`,
  `{"t":"${now}","ev":"admin","action":"admin_mode","by":${by},"detail":true}`
].join('\n') + '\n');
da.ingest();
t.ok('an hour-old action is not replayed', recorded.length === 6, recorded.length);
t.ok('heal: catalogue action, in-game admin, player', recorded[0].action === 'heal' && recorded[0].by === 'Ada (in game)' && recorded[0].source === 'game' && recorded[0].target.name === 'Bob');
t.ok('a stat reads as text', recorded[1].action === 'afflict' && recorded[1].details === 'blood set to 50%', recorded[1].details);
t.ok('a vehicle spawn reads as text', recorded[2].action === 'spawn' && /1 × OffroadHatchback \(vehicle, 12 parts\) at 100, 200/.test(recorded[2].details), recorded[2].details);
t.ok('a toggle off says off', recorded[3].action === 'god' && /off/.test(recorded[3].details), recorded[3].details);
t.ok('a message keeps its text', recorded[4].action === 'message' && recorded[4].details === 'stop that');
t.ok('admin mode has its own label', recorded[5].action === 'adminmode' && t.mod('admin-actions').LABEL.adminmode);
t.ok('portal catalogue has the in-game permissions', ['admin.menu', 'admin.players', 'admin.weather', 'admin.teleport.manage', 'admin.spawn.forbidden'].every(p => portal.PERMS.some(x => x[0] === p)));
t.done();
