'use strict';
// In-game tickets: lines from the game open and answer tickets; the reporter's in-game name, Steam64 and GUID are on
// the ticket, a staff reply keeps who answered; urgency and type are kept and order the admin list; a recent death is linked, players only see their own tickets (staff as "Admin"), the admin file
// has the context and links, files change only when the tickets do, and a line read twice opens one ticket.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'gametickets' });
const settings = t.mod('settings'); settings.save({ installDir: path.join(t.S, 'i'), adminLog: { adminName: 'Chris' } });
fs.mkdirSync(settings.paths().profilesDir, { recursive: true });
t.mod('audit').init(t.emit);
// Bob (GUID GBOB) died 5 minutes ago at 1200 / 3400
t.mod('jsonstore').write(path.join(t.S, 'deathlog.json'), { deaths: [{ id: 7, ts: Date.now() - 300000, name: 'Bob', key: 'GBOB', cause: 'player', causeText: 'Killed by Al', killer: { name: 'Al' }, weapon: 'AKM', pos: { x: 1200, y: 3400 }, hits: [], byPart: { head: { hits: 1, damage: 60 }, torso: { hits: 2, damage: 30 } }, totalDamage: 90, distance: 85.2, gear: [{ c: 'AKM', q: -1, h: 0.5 }, { c: 'Rag', q: 4, h: 1 }], refunds: [], attackers: [] }], nextId: 8, pending: {}, gear: {}, gearFile: { offset: 0, rest: '' }, lastDeathAt: {} });
const discord = t.mod('discord'); discord.init(t.emit);
t.mod('adminlog').init(t.emit);
const tk = t.mod('tickets'); tk.init(t.emit);
t.mod('deathlog').init(t.emit);
const gt = t.mod('gametickets'); gt.init(t.emit);
const dir = path.join(settings.paths().profilesDir, 'DayZAdminTools');
const inFile = path.join(dir, 'tickets_in.jsonl');
const out = (n) => JSON.parse(fs.readFileSync(path.join(dir, 'tickets_out', n + '.json'), 'utf8'));
const send = (...lines) => { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(inFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n'); return gt.ingest(); };
// the server's admin log: one line a minute ago (inside the ticket's two-minute window), one ten minutes ago (outside)
const hms = (ms) => new Date(ms).toTimeString().slice(0, 8);
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
fs.writeFileSync(path.join(settings.paths().profilesDir, 'server.ADM'), `AdminLog started on ${today} at 00:00:00\n${hms(Date.now() - 600000)} | Player "Bob" (id=GBOB) old line\n${hms(Date.now() - 60000)} | Player "Al" (id=GAL) hit by Player "Bob"\n`);
const BOB = { name: 'Bob', steam: '76561198000000005', guid: 'GBOB' };
const ADA = { by: 'Ada', bySteam: '76561198000000004', byGuid: 'GADA' };

// a player opens a ticket
const create = { op: 'create', ref: 'r1', ...BOB, category: 'death', urgency: 'high', title: 'Lost my gear', text: 'Died to a glitch at the factory', context: { x: 1210, z: 3390, nearby: [{ name: 'Al', steam: '76561198000000006', dist: 42.4 }] } };
t.ok('one line, one ticket, even when read twice', send(create, create) === 1 && tk.all().length === 1);
const id = tk.all()[0].id;
let full = tk.get(id);
t.ok('ticket subject has the type, a high urgency and the title', full.subject === '[I died / lost gear · High] Lost my gear' && full.player === 'Bob', full.subject);
t.ok('the ticket keeps the reporter: in-game name, Steam64, GUID', full.game.name === 'Bob' && full.game.steam === BOB.steam && full.game.guid === 'GBOB' && full.game.urgency === 'high');
t.ok('the opening message is the description, without ids', full.messages[0].role === 'player' && full.messages[0].text === 'Died to a glitch at the factory' && !full.messages[0].guid);
t.ok('the recent death is linked', full.deaths.length === 1 && full.deaths[0].id === 7);

// the player's file: only what they may see, staff as "Admin"
let mine = out(BOB.steam);
t.ok('player file lists the ticket', mine.tickets.length === 1 && mine.tickets[0].id === id && mine.tickets[0].status === 'open' && mine.unread === 0 && mine.noticeId === 0);

// staff reply in game: identity kept, player notified, shown as Admin
send({ op: 'admin_reply', ticket: id, ...ADA, text: 'Looking into it' });
full = tk.get(id);
const reply = full.messages[full.messages.length - 1];
t.ok('a staff reply keeps name, Steam64 and GUID', reply.role === 'admin' && reply.name === 'Ada' && reply.steam === ADA.bySteam && reply.guid === 'GADA' && reply.by === 'Ada (in game)');
mine = out(BOB.steam);
t.ok('the player sees it as Admin, unread, with a new notice', mine.tickets[0].messages[1].by === 'Admin' && mine.unread === 1 && mine.noticeId === 1);
t.ok('the player file has no Steam ids or GUIDs of staff', !JSON.stringify(mine).includes('GADA') && !JSON.stringify(mine).includes(ADA.bySteam));

// the player reads and answers
send({ op: 'seen', ticket: id, ...BOB });
t.ok('seen clears unread', out(BOB.steam).unread === 0);
send({ op: 'reply', ticket: id, ...BOB, text: 'Thanks' });
full = tk.get(id);
t.ok('a player reply is added', full.messages.pop().text === 'Thanks');
const before = tk.get(id).messages.length;
send({ op: 'reply', ticket: id, name: 'Eve', steam: '76561198000000007', guid: 'GEVE', text: 'not mine' });
t.ok('nobody else can answer the ticket', tk.get(id).messages.length === before);

// the admin file: context, links, the whole conversation with identities
const adm = out('_admin');
const a = adm.tickets.find(x => x.id === id);
t.ok('admin file: player, Steam64, GUID, position, nearby', a.player === 'Bob' && a.steam === BOB.steam && a.guid === 'GBOB' && a.x === 1210 && a.nearby === 'Al (42 m)');
t.ok('admin file: the linked death with its spot', a.deathId === 7 && a.deathX === 1200 && a.deathZ === 3400 && /Killed by Al with AKM, 2 items/.test(a.deathText), a.deathText);
t.ok('admin file: the death in full (killer, weapon, range, hits per part)', /Killer: Al/.test(a.deathDetail) && /Weapon: AKM/.test(a.deathDetail) && /Range: 85.2 m/.test(a.deathDetail) && /head ×1 \(60\), torso ×2 \(30\)/.test(a.deathDetail), a.deathDetail);
t.ok('admin file: the gear list with amounts and condition', a.gear.join('|') === 'AKM · 50%|Rag ×4', a.gear.join('|'));
t.ok('admin file: the player history', /0 other tickets · 0 refunds/.test(a.history), a.history);
t.ok('admin file: the admin log around the ticket, not before it', a.adm.length === 1 && /hit by Player "Bob"/.test(a.adm[0]), JSON.stringify(a.adm));
t.ok('the app can ask for the same context', gt.contextFor(id).adm.length === 1);
t.ok('admin file: the staff reply keeps who answered', a.messages.some(m => m.guid === 'GADA' && m.steam === ADA.bySteam) && a.urgency === 'high');
t.ok('admin file: counts and the newest ticket', adm.open === 1 && adm.unassigned === 1 && adm.latestId === id);

// claim, note, close
send({ op: 'claim', ticket: id, ...ADA });
send({ op: 'admin_note', ticket: id, ...ADA, text: 'checked the logs' });
t.ok('claimed by the admin', tk.get(id).assignee === 'Ada');
t.ok('internal notes stay out of the player file', !JSON.stringify(out(BOB.steam)).includes('checked the logs'));
t.ok('internal notes are in the admin file with the staff identity', out('_admin').tickets[0].notes.some(n => n.text === 'checked the logs' && /76561198000000004/.test(n.by)));
send({ op: 'close', ticket: id, ...ADA, text: 'refunded' });
t.ok('closed in game, the player sees it', tk.get(id).status === 'closed' && out(BOB.steam).tickets[0].status === 'closed');
send({ op: 'reply', ticket: id, ...BOB, text: 'one more thing' });
t.ok('a closed ticket takes no player replies', !tk.get(id).messages.some(m => m.text === 'one more thing'));

// urgency orders the admin list: an urgent ticket opened later comes first, a low one last
send({ op: 'create', ref: 'r2', ...BOB, category: 'bug', urgency: 'low', title: 'Door', text: 'stuck' }, { op: 'create', ref: 'r3', name: 'Al', steam: '76561198000000006', guid: 'GAL', category: 'report', urgency: 'urgent', title: 'Cheater', text: 'flying' });
t.ok('open tickets by urgency', out('_admin').tickets.filter(x => x.status === 'open').map(x => x.urgency).join(',') === 'urgent,low', out('_admin').tickets.map(x => x.urgency + x.status).join(','));

// files change only with the tickets
const f = path.join(dir, 'tickets_out', '_admin.json'); const m1 = fs.statSync(f).mtimeMs;
t.ok('nothing changed, nothing written', gt.writeOut() === 0 && fs.statSync(f).mtimeMs === m1);

// a reply from the app reaches the player as Admin too
send({ op: 'reopen', ticket: id, ...ADA });
tk.message(id, 'From the desk', 'app', 'admin');
t.ok('an app reply reaches the player', out(BOB.steam).tickets.find(x => x.id === id).messages.pop().text === 'From the desk');
t.done();
