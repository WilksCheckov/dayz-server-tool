'use strict';
// Discord buttons for step 9: in-game ticket posts carry "Reply to the player" (admins only; the reply reaches the
// player in game as an admin message), a player's reply from the game is posted with the same button, and death posts
// with a known position carry "Teleport me there" (admins name their character once; it is remembered).
const path = require('path');
const t = require('./harness').setup({ name: 'discordbuttons', stubs: { './server@deathlog': { status: () => ({ running: true }) } } });
const settings = t.mod('settings'); settings.save({ installDir: path.join(t.S, 'i'), discord: { guildId: '1', adminLogChannelId: '777', deathLogChannelId: '778' }, adminLog: { adminName: 'Chris' } });
t.mission();
t.mod('audit').init(t.emit);
const now = Date.now();
t.mod('jsonstore').write(path.join(t.S, 'deathlog.json'), { deaths: [
  { id: 1, ts: now - 60000, name: 'Bob', key: 'BOBKEY', cause: 'player', causeText: 'Killed by a player', killer: { name: 'Al' }, pos: { x: 1000, z: 2000 }, hits: [], byPart: {}, totalDamage: 1, gear: [], refunds: [], attackers: [] },
  { id: 2, ts: now - 50000, name: 'Cat', key: 'CATKEY', cause: 'infected', causeText: 'Killed by infected', killer: null, hits: [], byPart: {}, totalDamage: 1, gear: [], refunds: [], attackers: [] },
], nextId: 3, pending: {}, gear: {}, gearFile: { offset: 0, rest: '' }, lastDeathAt: {} });
const posted = [];
const discord = t.mod('discord'); discord.init(t.emit);
const chan = (id) => ({ id, isTextBased: () => true, send: async (p) => { posted.push({ ch: id, ...p }); return { id: 'm' }; } });
discord._tail.useStubClient({ channels: { fetch: async (id) => id === '777' || id === '778' ? chan(id) : null } });
t.mod('adminlog').init(t.emit); const tk = t.mod('tickets'); tk.init(t.emit);
const dl = t.mod('deathlog'); dl.init(t.emit);
const gt = t.mod('gametickets'); gt.init(t.emit);

const admin = { id: 'D-ADMIN', tag: 'Chris#1', username: 'Chris' };
const adminMember = { displayName: 'Chris', permissions: { has: () => true }, roles: { cache: new Map() } };
const playerMember = { displayName: 'Bob', permissions: { has: () => false }, roles: { cache: new Map() } };
function base(extra) {
  const i = { isAutocomplete: () => false, isChatInputCommand: () => false, isButton: () => false, isModalSubmit: () => false, user: admin, member: adminMember, deferred: false, replied: false, out: null, modal: null,
    deferReply: async () => { i.deferred = true; }, editReply: async (p) => { i.out = p; }, reply: async (p) => { i.out = p; i.replied = true; }, showModal: async (m) => { i.modal = m; }, ...extra };
  return i;
}
const button = (customId, extra = {}) => base({ isButton: () => true, customId, message: { embeds: [] }, ...extra });
const modal = (customId, values, extra = {}) => base({ isModalSubmit: () => true, customId, fields: { getTextInputValue: (k) => values[k] }, ...extra });
const tick = () => new Promise(r => setTimeout(r, 50));
const rowIds = (p) => (p.components || []).flatMap(r => r.toJSON().components.map(c => c.custom_id));

(async () => {
  gt.apply({ op: 'create', steam: '76561198000000002', guid: 'BOBKEY', name: 'Bob', ref: 'r1', category: 'other', title: 'Stuck in a rock', text: 'Help please' });
  await tick();
  const tid = tk.all()[0].id;
  t.ok('the new in-game ticket post has a Reply button', posted.some(p => p.ch === '777' && rowIds(p).includes(`gtreply-${tid}`)));

  const refused = button(`gtreply-${tid}`, { user: { id: 'D-BOB', tag: 'bob#1' }, member: playerMember });
  await discord._onInteraction(refused);
  t.ok('players cannot use Reply', !refused.modal && /Only admins/.test(JSON.stringify(refused.out)));
  const b = button(`gtreply-${tid}`); await discord._onInteraction(b);
  t.ok('admins get the reply form', b.modal && b.modal.toJSON().custom_id === `modal-gtreply-${tid}`);

  const m = modal(`modal-gtreply-${tid}`, { text: 'On my way' }); await discord._onInteraction(m);
  const tt = tk.all().find(x => x.id === tid);
  t.ok('the reply goes to the player as an admin message', tt.messages.some(x => x.role === 'admin' && x.text === 'On my way' && /Chris#1 \(Discord\)/.test(x.by)) && tt.game.noticeId === 1);

  posted.length = 0;
  gt.apply({ op: 'reply', ticket: tid, steam: '76561198000000002', name: 'Bob', text: 'Thanks!' }); await tick();
  t.ok("the player's reply from the game is posted with the Reply button", posted.some(p => rowIds(p).includes(`gtreply-${tid}`) && /Bob replied/.test(JSON.stringify(p.embeds))));

  posted.length = 0;
  await discord.postDeath(dl.get(1)); await discord.postDeath(dl.get(2)); await tick();
  t.ok('a death with a position gets Teleport me there', posted.some(p => p.ch === '778' && rowIds(p).includes('deathtp-1')));
  t.ok('a death without a position gets no button', posted.filter(p => p.ch === '778').length === 2 && posted.filter(p => rowIds(p).length).length === 1);

  const tb = button('deathtp-1'); await discord._onInteraction(tb);
  t.ok('admins are asked for their character', tb.modal && tb.modal.toJSON().custom_id === 'modal-deathtp-1');
  const tm = modal('modal-deathtp-1', { player: 'Nobody' }); await discord._onInteraction(tm);
  t.ok('an unknown character is reported', /No player called "Nobody"/.test(tm.out.content));
  t.ok('players cannot teleport', await (async () => { const x = button('deathtp-1', { user: { id: 'D-BOB', tag: 'bob#1' }, member: playerMember }); await discord._onInteraction(x); return !x.modal; })());
  t.done();
})().catch(e => { t.ok('no crash', false, e.stack); t.done(); });
