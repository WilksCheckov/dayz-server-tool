'use strict';
// Discord pickers: open tickets on /refund and /ticket, player names on /deaths, a player's own deaths on /mydeath;
// /refund ticket: logs the refund on the ticket and takes its linked death; /mydeath links only inside the owner's ticket.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'ticketpick', stubs: { './server@deathlog': { status: () => ({ running: true }) } } });
const settings = t.mod('settings'); settings.save({ installDir: path.join(t.S, 'i'), discord: { guildId: '1', adminLogChannelId: '777' }, adminLog: { adminName: 'Chris', requireReason: true } });
t.mission();
t.mod('audit').init(t.emit);
const lists = t.mod('lists');
const BOB = '76561198000000002', BOBKEY = lists.steamIdToDayzId(BOB);
const now = Date.now();
t.mod('jsonstore').write(path.join(t.S, 'deathlog.json'), { deaths: [
  { id: 1, ts: now - 7200000, name: 'Bob', key: BOBKEY, cause: 'player', causeText: 'Killed by a player', killer: { name: 'Al' }, weapon: 'AKM', hits: [], byPart: {}, totalDamage: 1, gear: [{ c: 'AKM' }], refunds: [], attackers: [] },
  { id: 2, ts: now - 3600000, name: 'Cat', key: 'CATKEY', cause: 'infected', causeText: 'Killed by infected', killer: null, hits: [], byPart: {}, totalDamage: 1, gear: [{ c: 'Rag' }], refunds: [], attackers: [] },
  { id: 3, ts: now - 60000, name: 'Bob', key: BOBKEY, cause: 'bleeding', causeText: 'Bled out', killer: null, hits: [], byPart: {}, totalDamage: 1, gear: [{ c: 'Rag' }, { c: 'Apple' }], refunds: [], attackers: [] }
], nextId: 4, pending: {}, gear: {}, gearFile: { offset: 0, rest: '' }, lastDeathAt: {} });
const posted = [];
const discord = t.mod('discord'); discord.init(t.emit);
discord._tail.useStubClient({ channels: { fetch: async (id) => id === '777' ? { id, isTextBased: () => true, send: async (p) => { posted.push(p); return { id: 'm' }; } } : null } });
t.mod('adminlog').init(t.emit); const tk = t.mod('tickets'); tk.init(t.emit);
const dl = t.mod('deathlog'); dl.init(t.emit); dl.installBridge();
// Bob has a whitelist application; the tickets: Bob's own (Discord), and one made in the app for Cat
discord.store().applications['D-BOB'] = { steamId: BOB, characterName: 'Bob', status: 'accepted' };
discord.store().tickets = [{ id: '0001', subject: 'Lost my gear at Tisy', discordId: 'D-BOB', channelId: 'CH-1', status: 'open', createdAt: new Date().toISOString(), deaths: [], notes: [], actions: [] }];
discord.store().ticketSeq = 1; discord.saveStore();
tk.create({ subject: 'Cat fell off a roof', player: 'Cat', by: 'app' });
// the game answers refunds
setInterval(() => { const q = path.join(dl.bridgeDir(), 'commands.txt'); if (!fs.existsSync(q)) return; const line = fs.readFileSync(q, 'utf8').trim(); if (!line) return; fs.unlinkSync(q); const f = line.split('|'); fs.appendFileSync(path.join(dl.bridgeDir(), 'results.log'), `${f[0]}|done|${f[6].split(',').length}|0|body\r\n`); }, 100).unref();
const admin = { id: 'D-ADMIN', tag: 'Chris#1', username: 'Chris' };
async function pick(commandName, field, value, user = admin, member = { displayName: 'Chris', permissions: { has: () => true }, roles: { cache: new Map() } }) { let out = null; await discord._onInteraction({ isAutocomplete: () => true, commandName, user, member, options: { getFocused: () => ({ name: field, value }) }, respond: async (c) => { out = c; } }); return out; }
async function slash(commandName, options, { user = admin, member = { displayName: 'Chris', permissions: { has: () => true }, roles: { cache: new Map() } }, channelId = 'X' } = {}) {
  let reply = null; const i = { isAutocomplete: () => false, isChatInputCommand: () => true, isButton: () => false, isModalSubmit: () => false, commandName, user, member, channelId, guild: { name: 'G', iconURL: () => null }, deferred: false, replied: false,
    options: { getSubcommand: () => null, data: Object.entries(options).map(([name, value]) => ({ name, type: 3, value })) },
    deferReply: async () => { i.deferred = true; }, editReply: async (p) => { reply = p; }, deleteReply: async () => {}, followUp: async (p) => { reply = p; }, reply: async (p) => { reply = p; } };
  await discord._onInteraction(i); return reply;
}
(async () => {
  const tp = await pick('refund', 'ticket', '');
  t.ok('open tickets offered on /refund', tp.length === 2 && tp.some(c => c.value === '0001' && /Lost my gear/.test(c.name)) && tp.some(c => c.value === '0002' && /Cat/.test(c.name)), tp.map(c => c.name).join(' | '));
  t.ok('ticket search by player or subject', (await pick('refund', 'ticket', 'cat')).map(c => c.value).join() === '0002' && (await pick('ticket', 'id', 'tisy')).map(c => c.value).join() === '0001');
  t.ok('player names offered on /deaths', (await pick('deaths', 'player', 'b')).map(c => c.value).join() === 'Bob');
  const bob = { id: 'D-BOB', tag: 'bob#1', username: 'bob' }, bobMember = { displayName: 'Bobby', permissions: { has: () => false }, roles: { cache: new Map() } };
  const mine = await pick('mydeath', 'death', '', bob, bobMember);
  t.ok('a player sees only their own deaths, newest first', mine.map(c => c.value).join() === '3,1' && !mine.some(c => /Cat/.test(c.name)), mine.map(c => c.name).join(' | '));
  const noapp = await pick('mydeath', 'death', '', { id: 'D-NEW', tag: 'n', username: 'n' }, { displayName: 'Cat', permissions: { has: () => false }, roles: { cache: new Map() } });
  t.ok('without an application: by display name', noapp.map(c => c.value).join() === '2');
  let r = await slash('mydeath', { death: '3' }, { user: bob, member: bobMember, channelId: 'CH-1' });
  t.ok('player links their own death inside their ticket', /Linked death #3/.test(r.content) && tk.get('0001').deaths.map(d => d.id).join() === '3', r.content);
  r = await slash('mydeath', { death: '2' }, { user: bob, member: bobMember, channelId: 'CH-1' });
  t.ok("someone else's death refused", /not one of your deaths/.test(r.content), r.content);
  r = await slash('mydeath', { death: '3' }, { user: bob, member: bobMember, channelId: 'CH-other' });
  t.ok('outside the ticket channel refused', /inside your ticket/.test(r.content), r.content);
  r = await slash('refund', { ticket: '0001' });
  t.ok("/refund ticket: takes the ticket's linked death, logs it on the ticket, removes the body", /Refunded 2 of 2 items to \*\*Bob\*\*/.test(r.content) && /body was removed/.test(r.content) && tk.get('0001').actions.length === 1 && tk.get('0001').actions[0].action === 'refund', r.content);
  t.ok('the refund reason carries the ticket', tk.get('0001').actions[0].reason === '#0001');
  r = await slash('refund', { ticket: '0002', reason: 'approved' });
  t.ok("a ticket without a linked death falls back to the player's latest death", /\*\*Cat\*\*/.test(r.content) && tk.get('0002').deaths.map(d => d.id).join() === '2' && tk.get('0002').actions[0].reason === '#0002 approved', r.content);
  r = await slash('refund', { id: '1' });
  t.ok('a refund needs no reason (its death and ticket explain it)', /Refunded 1 of 1 items to \*\*Bob\*\*/.test(r.content), r.content);
  t.done();
})();
