'use strict';
// Shared bot: per-server feed channels created next to the main feed channels, reused when present, saved on the instance.
const fs = require('fs'); const path = require('path'); const http = require('http');
const t = require('./harness').setup({ name: 'feeds' });
const child = path.join(t.S, 'inst', 'Livonia Hard'); fs.mkdirSync(path.join(child, 'tool'), { recursive: true });
fs.writeFileSync(path.join(t.S, 'instances.json'), JSON.stringify({ root: path.join(t.S, 'inst'), list: [{ name: 'Livonia Hard', dir: child }] }));
fs.writeFileSync(path.join(child, 'tool', 'settings.json'), JSON.stringify({ discord: { mode: 'shared' } }));
fs.writeFileSync(path.join(t.S, 'settings.json'), JSON.stringify({ discord: { guildId: '1', killFeedChannelId: '500' } }));
let got = null;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { got = JSON.parse(b); res.end(JSON.stringify({ ok: true, data: true })); }); });
const { ChannelType } = require('discord.js');
srv.listen(0, '127.0.0.1', async () => {
  fs.writeFileSync(path.join(child, 'tool', 'control.json'), JSON.stringify({ pid: process.pid, port: srv.address().port, token: 'x' }));
  const chans = new Map([['500', { id: '500', name: 'kill-feed', type: ChannelType.GuildText, parentId: '900', isTextBased: () => true }], ['501', { id: '501', name: 'livonia-hard-joins', type: ChannelType.GuildText, parentId: '900', isTextBased: () => true }]]);
  let nextId = 600; let denied = false; const created = [];
  const guild = { channels: { fetch: async () => chans, create: async (o) => { if (denied) throw new Error('Missing Permissions'); const c = { id: String(nextId++), name: o.name, type: o.type, parentId: o.parent || null, isTextBased: () => true }; chans.set(c.id, c); created.push(o); return c; } } };
  const discord = t.mod('discord'); discord.init(t.emit); discord._tail.useStubClient({ guilds: { fetch: async () => guild }, channels: { fetch: async (id) => chans.get(id) || null } });
  const r = await discord.createFeedChannels('Livonia Hard');
  t.ok('missing channels created, existing reused', r.created.join(',') === 'livonia-hard-kill-feed,livonia-hard-death-log');
  t.ok('created in the same category as the main feeds', created.every(o => o.parent === '900'));
  t.ok('ids saved on the instance', got && got.channel === 'discord:setChannels' && got.args[0].joinFeedChannelId === '501' && got.args[0].killFeedChannelId === '600');
  t.ok('second run creates nothing', (await discord.createFeedChannels('Livonia Hard')).created.length === 0);
  denied = true; for (const k of [...chans.keys()]) if (k >= '600') chans.delete(k);
  let msg = ''; try { await discord.createFeedChannels('Livonia Hard'); } catch (e) { msg = e.message; }
  t.ok('missing permission explained', /Manage Channels/.test(msg));
  msg = ''; try { await discord.createFeedChannels('Main'); } catch (e) { msg = e.message; }
  t.ok('main instance refused', /main instance/.test(msg));
  srv.close(); t.done();
});
