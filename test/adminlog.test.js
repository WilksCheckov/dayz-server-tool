'use strict';
// Admin action log: reason enforcement, audit entry, console line, Discord embed, Discord users named.
const t = require('./harness').setup({ name: 'adminlog' });
const path = require('path');
const settings = t.mod('settings'); settings.save({ installDir: path.join(t.S, 'i'), discord: { adminLogChannelId: '777', guildId: '1' }, adminLog: { adminName: 'Chris' } });
t.mod('audit').init(t.emit);
const posted = [];
const discord = t.mod('discord'); discord.init(t.emit);
discord._tail.useStubClient({ channels: { fetch: async (id) => id === '777' ? { id, isTextBased: () => true, send: async (p) => { posted.push(p); return { id: 'm1' }; } } : null } });
const al = t.mod('adminlog'); al.init(t.emit);
(async () => {
  let threw = null; try { al.check('heal', ''); } catch (e) { threw = e.message; }
  t.ok('heal without a reason refused', !!threw, threw);
  for (const a of ['give', 'kit', 'vehicle', 'spawn', 'tp', 'tpto', 'bring', 'tpdeath', 'kill', 'god', 'kick', 'ban']) { let x = null; try { al.check(a, ''); } catch (e) { x = e; } if (!x) threw = null; }
  t.ok('every other action needs a reason too', !!threw);
  threw = null; try { al.check('refund', ''); al.check('message', ''); } catch (e) { threw = e.message; }
  t.ok('refunds and messages need none', !threw);
  al.record({ action: 'refund', by: 'map', target: { name: 'Bob', steam: '76561198000000002' }, details: 'death #12: 9 item(s)', reason: 'Ticket glitched through floor', result: { status: 'done', ok: 9, fail: 0 } });
  await t.sleep(200);
  t.ok('console line', t.lines.some(l => /\[admin\] Chris: ↩️ Refund · Bob · death #12: 9 item\(s\) · reason: Ticket glitched through floor · 9 ok/.test(l)), t.lines.filter(l => /\[admin\]/.test(l)).slice(-1)[0]);
  const audit = t.mod('audit').list({ limit: 5 })[0];
  t.ok('audit entry', audit && audit.who === 'Chris' && audit.action === 'admin:refund' && /glitched/.test(audit.details), JSON.stringify(audit));
  const j = posted[0] && posted[0].embeds[0].toJSON();
  t.ok('Discord embed', !!j && /Refund · Bob/.test(j.title) && j.fields.some(f => f.name === 'Reason / ticket' && /glitched/.test(f.value)) && j.fields.some(f => f.name === 'Admin' && f.value === 'Chris'), j && j.title);
  al.record({ action: 'give', by: 'Admin Cat#1234', source: 'discord', target: { name: 'Bob', steam: '7656' }, details: 'AKM × 1', reason: 'event prize', result: { status: 'done', ok: 1, fail: 0 } });
  await t.sleep(200);
  t.ok('Discord user named as the admin', posted[1].embeds[0].toJSON().fields.some(f => f.name === 'Admin' && f.value === 'Admin Cat#1234'));
  settings.save({ adminLog: { requireReason: false } }); threw = null; try { al.check('heal', ''); } catch (e) { threw = e.message; }
  t.ok('reason not required when switched off', !threw);
  t.done();
})();
