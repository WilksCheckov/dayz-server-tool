'use strict';
// Portal: accounts, groups, effective permissions, login and lockout, sessions, the HTTP API gating every route by
// permission, and the audit trail under the user's name.
const http = require('http'); const path = require('path');
const t = require('./harness').setup({ name: 'portal', stubs: { './server@deathlog': { status: () => ({ running: false }) } } });
t.settings();
t.mod('audit').init(t.emit);
const portal = t.mod('portal'); portal.init(t.emit);
// a tiny server that routes like website.js does
const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname.replace(/\/+$/, '') || '/';
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' }); res.end(body); };
  portal.handle(req, res, p, send, url).catch(e => send(500, 'text/plain', e.stack));
});
let base = ''; let cookie = '';
const call = async (route, body, params = {}, extraHeaders = {}) => {
  const r = await fetch(`${base}/portal/api/${route}?${new URLSearchParams(params)}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Portal': '1', cookie, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, ...(await r.json()) };
};
srv.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const off = await fetch(base + '/portal'); t.ok('portal off until enabled', off.status === 404 && /portal is off/.test(await off.text()));
    portal.setOwner('Chris', 'hunter2hunter2');
    t.ok('owner account turns it on with the Owner group', portal.status().enabled && portal.listUsers()[0].groups.join() === 'owner' && portal.listUsers()[0].perms.length === portal.PERMS.length);
    let r = await call('me'); t.ok('no session: 401', r.status === 401);
    r = await call('login', { name: 'chris', password: 'wrong' }); t.ok('wrong password refused', r.status === 401 && /Wrong/.test(r.error));
    for (let i = 0; i < 4; i++) await call('login', { name: 'chris', password: 'wrong' });
    r = await call('login', { name: 'chris', password: 'hunter2hunter2' }); t.ok('locked out after 5 failures even with the right password', r.status === 401 && /Too many/.test(r.error), r.error);
    portal._load().users.chris && (await (async () => { const f = require(path.join(t.SRC, 'portal.js')); return f; })());
    // a fresh "ip" is not possible on loopback: clear the lockout the way time would
    const since = Date.now(); while (Date.now() - since < 50) { /* spin a little */ }
    // reach into the module's fail map through a new owner password reset path: simplest is a second account from another "ip" is not available, so test the rest with the lockout cleared
    delete require.cache[require.resolve(path.join(t.SRC, 'portal.js'))];
  } catch (e) { t.ok('setup', false, e.stack); }
  // reload the module (the lockout map is in memory) and carry on
  const p2 = require(path.join(t.SRC, 'portal.js')); p2.init(t.emit);
  srv.removeAllListeners('request'); srv.on('request', (req, res) => { const url = new URL(req.url, 'http://x'); const p = url.pathname.replace(/\/+$/, '') || '/'; const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' }); res.end(body); }; p2.handle(req, res, p, send, url).catch(e => send(500, 'text/plain', e.stack)); });
  let r = await call('login', { name: 'Chris', password: 'hunter2hunter2' }); t.ok('login (case-insensitive name) sets a session cookie', r.ok && /^dzportal=[a-f0-9]{48}$/.test(cookie));
  r = await call('me'); t.ok('me: name, groups, every permission', r.ok && r.data.name === 'Chris' && r.data.perms.length === p2.PERMS.length);
  r = await fetch(`${base}/portal/api/user`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' }); t.ok('POST without the X-Portal header refused (CSRF)', r.status === 403);
  // a moderator
  r = await call('user', { op: 'create', name: 'Mod Mike', password: 'password123', groups: ['moderator'] }); t.ok('user created', r.ok && r.data.perms.includes('players.kick') && !r.data.perms.includes('admin.spawn'), r.error);
  r = await call('user', { op: 'update', id: 'mod-mike', patch: { allow: ['admin.heal'], deny: ['players.ban'] } }); t.ok('own grants and denies', r.ok && r.data.perms.includes('admin.heal') && !r.data.perms.includes('players.ban'));
  r = await call('user', { op: 'update', id: 'chris', patch: { groups: [] } }); t.ok('the last portal manager cannot lose the permission', !r.ok && /nobody who can manage/.test(r.error), r.error);
  r = await call('group', { op: 'upsert', name: 'Event team', perms: ['players.view', 'admin.spawn', 'admin.teleport'] }); t.ok('group created', r.ok && r.data.some(g => g.id === 'event-team' && g.perms.length === 3));
  r = await call('group', { op: 'delete', id: 'owner' }); t.ok('the Owner group cannot be deleted', !r.ok);
  const ownerCookie = cookie;
  cookie = ''; r = await call('login', { name: 'mod mike', password: 'password123' }); t.ok('moderator signs in', r.ok);
  r = await call('me'); const mod = r.data;
  t.ok('moderator sees only their pages', !mod.perms.includes('portal.users') && mod.perms.includes('tickets.manage'));
  r = await call('users'); t.ok('a route without permission: 403', r.status === 403 && /permission: portal.users/.test(r.error));
  r = await call('act', { action: 'give', id: 'x', args: {} }); t.ok('an action without permission: 403', r.status === 403 && /admin.spawn/.test(r.error));
  r = await call('act', { action: 'heal', id: 'nobody', args: { reason: 'test' } }); t.ok('a permitted action reaches live.act (server off → not online)', r.status === 200 && !r.ok && /not online|not running/.test(r.error), r.error);
  r = await call('ticketOp', { op: 'create', subject: 'From the portal', player: 'Bob' }); t.ok('ticket created under the portal user', r.ok && r.data.createdBy === 'Mod Mike (portal)');
  r = await call('status'); t.ok('status for server.view', r.ok && r.data.server && r.data.instance === 'Main');
  r = await call('password', { current: 'password123', password: 'newpassword1' }); t.ok('own password change', r.ok);
  r = await call('me'); t.ok('session survives the password change', r.ok);
  r = await call('logout', {}); r = await call('me'); t.ok('logout ends the session', r.status === 401);
  cookie = ownerCookie;
  r = await call('user', { op: 'update', id: 'mod-mike', patch: { enabled: false } }); t.ok('disabling a user', r.ok && r.data.enabled === false);
  const audit = t.mod('audit').list({ limit: 50 });
  t.ok('audit trail names the portal user', audit.some(a => a.who === 'Chris (portal)' && /user created/.test(a.action)) && audit.some(a => /login failed/.test(a.action)));
  r = await call('user', { op: 'delete', id: 'chris' }); t.ok('cannot delete yourself', !r.ok && /yourself/.test(r.error));
  // lists and the player profile (owner)
  r = await call('listOp', { op: 'add', kind: 'ban', id: '76561198000000009', name: 'Griefer', reason: '' }); t.ok('a ban through the lists needs a reason', !r.ok && /reason/.test(r.error), r.error);
  r = await call('listOp', { op: 'add', kind: 'ban', id: '76561198000000009', name: 'Griefer', reason: 'duping' }); t.ok('ban added by Steam64', r.ok && r.data.entries.some(e => e.steamId === '76561198000000009' && e.name === 'Griefer'), r.error);
  r = await call('listOp', { op: 'add', kind: 'whitelist', id: '76561198000000009', name: 'Griefer' }); t.ok('whitelist needs no reason', r.ok, r.error);
  r = await call('lists'); t.ok('lists for lists.view', r.ok && r.data.ban.entries.length === 1 && r.data.whitelist.entries.length === 1 && r.data.bebans);
  r = await call('listOp', { op: 'remove', kind: 'ban', id: '76561198000000009', name: 'Griefer' }); t.ok('unban', r.ok && r.data.entries.length === 0);
  const au = t.mod('audit').list({ limit: 10 });
  t.ok('list changes are admin actions under the portal user', au.some(a => a.action === 'admin:ban' && a.who === 'Chris (portal)' && /duping/.test(a.details)) && au.some(a => a.action === 'admin:unban'));
  // a player in the database, then the profile
  const pl = t.mod('players'); pl.init(t.emit); const dbf = require('path').join(t.S, 'players.json');
  t.mod('jsonstore').write(dbf, { players: { 'KEY1': { key: 'KEY1', id: 'KEY1', names: ['Bob'], name: 'Bob', firstSeen: Date.now() - 86400000, lastSeen: Date.now() - 3600000, playtimeSec: 7200, kills: 3, deaths: 2, sessions: [], notes: 'watch him' } }, files: {}, peaks: {}, online: {} });
  delete require.cache[require.resolve(require('path').join(t.SRC, 'players.js'))];
  r = await call('playerSearch', null, { q: 'bo' }); t.ok('player search', r.ok && r.data.length === 1 && r.data[0].name === 'Bob' && r.data[0].key === 'KEY1', JSON.stringify(r.data));
  r = await call('player', null, { key: 'KEY1' }); t.ok('profile: record, lists, deaths, tickets, actions', r.ok && r.data.name === 'Bob' && r.data.playtimeSec === 7200 && r.data.lists && r.data.lists.whitelist === false && r.data.deaths === 2 && Array.isArray(r.data.recentDeaths) && Array.isArray(r.data.tickets) && Array.isArray(r.data.actions) && r.data.notes === 'watch him', r.error || Object.keys(r.data || {}).join(','));
  r = await call('player', null, { key: 'Bob' }); t.ok('profile by name', r.ok && r.data.key === 'KEY1');
  r = await call('playerNote', { key: 'KEY1', text: 'cleared' }); t.ok('note saved', r.ok && (await call('player', null, { key: 'KEY1' })).data.notes === 'cleared');
  cookie = ''; r = await call('login', { name: 'mod mike', password: 'newpassword1' }); t.ok('disabled user cannot sign in', r.status === 401);
  // approvals, blocked classes and daily limits
  cookie = ownerCookie;
  r = await call('group', { op: 'upsert', name: 'Helpers', perms: ['players.view', 'admin.spawn', 'admin.kits', 'admin.refund', 'deaths.view'], approval: { spawn: true, refund: true }, itemsPerDay: 20 }); const helpers = r.data.find(g => g.id === 'helpers');
  t.ok('group with approval rules and a daily limit', r.ok && helpers && helpers.approval.spawn && helpers.approval.refund && !helpers.approval.kits && helpers.itemsPerDay === 20, r.error);
  r = await call('setPolicy', { blockedClasses: 'M4*\nSVD' }); t.ok('blocked classes saved', r.ok && r.data.blockedClasses.join() === 'M4*,SVD', r.error);
  r = await call('user', { op: 'create', name: 'Helper Hal', password: 'password123', groups: ['helpers'] }); t.ok('helper created', r.ok, r.error);
  cookie = ''; r = await call('login', { name: 'helper hal', password: 'password123' }); t.ok('helper signs in', r.ok);
  const halCookie = cookie;
  r = await call('spawnAt', { x: 100, z: 200, item: 'M4A1', count: 1, reason: 'test' }); t.ok('a blocked class is refused before anything happens', !r.ok && /blocked class/.test(r.error), r.error);
  r = await call('spawnAt', { x: 100, z: 200, item: 'BandageDressing', count: 30, reason: 'test' }); t.ok('over the daily limit is refused', !r.ok && /limit of 20/.test(r.error), r.error);
  r = await call('spawnAt', { x: 100, z: 200, item: 'BandageDressing', count: 2, reason: 'for the event' }); t.ok('a category under approval becomes a request', r.ok && r.data.status === 'approval' && r.data.request === '0001', JSON.stringify(r));
  r = await call('act', { action: 'kit', id: 'nobody', args: { kit: 'Medic', reason: 'x' } }); t.ok('kits are not under approval for this group (reaches the game → not online)', !r.ok && /not online|not running/.test(r.error), r.error);
  r = await call('requests'); t.ok('helper sees only their own pending request', r.ok && !r.data.canApprove && r.data.requests.length === 1 && r.data.requests[0].status === 'pending' && /2 × BandageDressing at 100, 200 — for the event/.test(r.data.requests[0].text) && r.data.policy.needs.join() === 'refund,spawn' && r.data.policy.itemsPerDay === 20, JSON.stringify(r.data));
  r = await call('requestOp', { op: 'approve', id: '0001' }); t.ok('helper cannot approve', r.status === 403);
  cookie = ownerCookie;
  r = await call('requests'); t.ok('owner sees it with canApprove', r.ok && r.data.canApprove && r.data.requests.some(x => x.id === '0001' && x.byName === 'Helper Hal'));
  r = await call('requestOp', { op: 'approve', id: '0001' }); t.ok('approving runs it under the helper (server off → error recorded, request approved)', r.ok && r.data.status === 'approved' && r.data.decidedBy === 'Chris' && r.data.result && r.data.result.status === 'error', JSON.stringify(r));
  r = await call('requestOp', { op: 'approve', id: '0001' }); t.ok('cannot decide twice', !r.ok && /already approved/.test(r.error), r.error);
  cookie = halCookie; r = await call('spawnAt', { x: 1, z: 2, item: 'Rag', count: 1, reason: 'again' }); const id2 = r.data.request;
  r = await call('requestOp', { op: 'cancel', id: id2 }); t.ok('requester can cancel their own', r.ok && r.data.status === 'cancelled', r.error);
  cookie = ownerCookie; r = await call('requestOp', { op: 'deny', id: id2 }); t.ok('a cancelled request cannot be denied', !r.ok && /already cancelled/.test(r.error), r.error);
  r = await call('spawnAt', { x: 1, z: 2, item: 'Rag', count: 1, reason: 'again' }); t.ok('the owner needs no approval', !r.ok && !/approval/.test(JSON.stringify(r)) && !(r.data && r.data.status === 'approval'), JSON.stringify(r));
  r = await call('user', { op: 'update', id: 'helper-hal', patch: { trusted: true } }); t.ok('trusted flag saved', r.ok && r.data.trusted === true, r.error);
  cookie = halCookie; r = await call('spawnAt', { x: 1, z: 2, item: 'Rag', count: 1, reason: 'trusted now' }); t.ok('a trusted user skips approval (goes straight to the game)', !(r.ok && r.data.status === 'approval'), JSON.stringify(r));
  r = await call('spawnAt', { x: 1, z: 2, item: 'SVD', count: 1, reason: 'x' }); t.ok('blocked classes still apply to trusted users', !r.ok && /blocked class/.test(r.error), r.error);
  const au2 = t.mod('audit').list({ limit: 20 }); t.ok('requests and decisions are audited', au2.some(a => /portal: request 0001/.test(a.action) && a.who === 'Helper Hal (portal)') && au2.some(a => /portal: approved 0001/.test(a.action) && a.who === 'Chris (portal)'));
  srv.close(); t.done();
});
