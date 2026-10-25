'use strict';
// Web portal (/portal on the built-in website): accounts, groups and per-feature permissions for moderators, admins,
// game masters and developers. Every action a portal user takes runs through the same code as the app and the bot
// (live.act, tickets, deathlog, server) under their name, so the admin action channel and the audit log say who did it.
// Data: <userData>\portal.json (passwords as scrypt hashes). Sessions are cookies (HttpOnly, SameSite=Strict).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const jsonstore = require('./jsonstore');

let emitRef = () => {};
const file = () => path.join(require('electron').app.getPath('userData'), 'portal.json');

// ---------- permissions ----------
const PERMS = [
  ['server.view', 'See the server status, who is online and the server health', 'Server'],
  ['server.control', 'Start, stop and restart the server', 'Server'],
  ['server.backup', 'Take a backup', 'Server'],
  ['players.view', 'See online players and where they are on the map', 'Players'],
  ['players.message', 'Message a player', 'Players'],
  ['players.kick', 'Kick a player', 'Players'],
  ['players.ban', 'Ban a player', 'Players'],
  ['admin.heal', 'Heal', 'In-game admin'],
  ['admin.teleport', 'Teleport players (to a player, a map point, their death)', 'In-game admin'],
  ['admin.spawn', 'Give items, kits and vehicles; spawn at a map point', 'In-game admin'],
  ['admin.god', 'God mode', 'In-game admin'],
  ['admin.kill', 'Kill a player', 'In-game admin'],
  ['admin.refund', 'Refund a death', 'In-game admin'],
  ['deaths.view', 'Death log', 'Records'],
  ['tickets.view', 'See tickets', 'Records'],
  ['tickets.manage', 'Assign, note, link and close tickets', 'Records'],
  ['logs.view', 'Server logs and the tool console', 'Records'],
  ['audit.view', 'Audit log', 'Records'],
  ['portal.users', 'Manage portal users, groups and permissions', 'Portal']
];
const ALL = PERMS.map(p => p[0]);
const DEFAULT_GROUPS = {
  owner: { name: 'Owner', perms: ALL, builtin: true },
  admin: { name: 'Admin', perms: ALL.filter(p => p !== 'portal.users') },
  moderator: { name: 'Moderator', perms: ['server.view', 'players.view', 'players.message', 'players.kick', 'players.ban', 'deaths.view', 'tickets.view', 'tickets.manage', 'audit.view'] },
  gm: { name: 'Game master', perms: ['server.view', 'players.view', 'players.message', 'admin.heal', 'admin.teleport', 'admin.spawn', 'admin.god', 'admin.refund', 'deaths.view', 'tickets.view'] },
  developer: { name: 'Developer', perms: ['server.view', 'server.control', 'server.backup', 'logs.view', 'audit.view', 'deaths.view'] }
};
// which permission each in-game action needs
const ACTION_PERM = { heal: 'admin.heal', tp: 'admin.teleport', tpto: 'admin.teleport', bring: 'admin.teleport', tpdeath: 'admin.teleport', give: 'admin.spawn', kit: 'admin.spawn', vehicle: 'admin.spawn', god: 'admin.god', kill: 'admin.kill', refund: 'admin.refund', message: 'players.message', kick: 'players.kick', ban: 'players.ban' };

// ---------- data ----------
let db = null;
function load() {
  if (db) return db;
  db = { enabled: false, users: {}, groups: {}, sessions: {}, ...(jsonstore.readOr(file(), {}) || {}) };
  for (const [id, g] of Object.entries(DEFAULT_GROUPS)) if (!db.groups[id]) db.groups[id] = { ...g, perms: g.perms.slice() };
  return db;
}
function save() { jsonstore.write(file(), load(), true); }
const idOf = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, 32);
function hash(pw, salt) { return crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'); }
function check(pw, u) { try { const a = Buffer.from(hash(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; } }
function permsOf(u) {
  const set = new Set();
  for (const g of u.groups || []) for (const p of ((load().groups[g] || {}).perms || [])) set.add(p);
  for (const p of u.allow || []) set.add(p);
  for (const p of u.deny || []) set.delete(p);
  return set;
}
const publicUser = (u) => ({ id: u.id, name: u.name, groups: u.groups || [], allow: u.allow || [], deny: u.deny || [], enabled: u.enabled !== false, createdAt: u.createdAt, createdBy: u.createdBy || null, lastLogin: u.lastLogin || null, lastIp: u.lastIp || null, perms: [...permsOf(u)] });

function listUsers() { return Object.values(load().users).map(publicUser).sort((a, b) => a.name.localeCompare(b.name)); }
function listGroups() { return Object.entries(load().groups).map(([id, g]) => ({ id, name: g.name, perms: g.perms || [], builtin: !!g.builtin, members: Object.values(load().users).filter(u => (u.groups || []).includes(id)).length })); }
function createUser({ name, password, groups = [], allow = [], deny = [] }, by = 'app') {
  const d = load(); const id = idOf(name); name = String(name || '').trim();
  if (!id || name.length < 2 || name.length > 32) throw new Error('Give a user name of 2 to 32 characters.');
  if (d.users[id]) throw new Error(`There is already a user called ${d.users[id].name}.`);
  if (String(password || '').length < 8) throw new Error('The password needs at least 8 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  d.users[id] = { id, name, salt, hash: hash(password, salt), groups: groups.filter(g => d.groups[g]), allow: allow.filter(p => ALL.includes(p)), deny: deny.filter(p => ALL.includes(p)), enabled: true, createdAt: new Date().toISOString(), createdBy: by };
  save(); audit(by, 'portal: user created', name); return publicUser(d.users[id]);
}
function updateUser(id, patch, by = 'app') {
  const d = load(); const u = d.users[id]; if (!u) throw new Error('No such user.');
  // worked out on a copy and checked before anything changes, so a refused change leaves the user as they were
  const next = { ...u };
  if (patch.groups) next.groups = patch.groups.filter(g => d.groups[g]);
  if (patch.allow) next.allow = patch.allow.filter(p => ALL.includes(p));
  if (patch.deny) next.deny = patch.deny.filter(p => ALL.includes(p));
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.password) { if (String(patch.password).length < 8) throw new Error('The password needs at least 8 characters.'); next.salt = crypto.randomBytes(16).toString('hex'); next.hash = hash(patch.password, next.salt); }
  // the last user who can manage the portal cannot lose that (by groups, permissions or being disabled)
  const stillManaged = (next.enabled !== false && permsOf(next).has('portal.users')) || Object.values(d.users).some(x => x.id !== id && x.enabled !== false && permsOf(x).has('portal.users'));
  if (!stillManaged) throw new Error('That would leave nobody who can manage the portal.');
  Object.assign(u, next);
  if (patch.enabled === false || patch.password) for (const [t, s] of Object.entries(d.sessions)) if (s.user === id && !(patch.password && t === patch._keepSession && patch.enabled !== false)) delete d.sessions[t];
  save(); audit(by, 'portal: user updated', `${u.name}: ${Object.keys(patch).filter(k => k !== 'password' && !k.startsWith('_')).join(', ')}${patch.password ? ', password' : ''}`); return publicUser(u);
}
function deleteUser(id, by = 'app') {
  const d = load(); const u = d.users[id]; if (!u) throw new Error('No such user.');
  if (permsOf(u).has('portal.users') && !Object.values(d.users).some(x => x.id !== id && x.enabled !== false && permsOf(x).has('portal.users'))) throw new Error('That would leave nobody who can manage the portal.');
  delete d.users[id]; for (const [t, s] of Object.entries(d.sessions)) if (s.user === id) delete d.sessions[t];
  save(); audit(by, 'portal: user deleted', u.name); return true;
}
function upsertGroup({ id, name, perms }, by = 'app') {
  const d = load(); id = idOf(id || name); name = String(name || '').trim();
  if (!id || !name) throw new Error('Give the group a name.');
  const g = d.groups[id] || {}; if (g.builtin && id === 'owner') perms = ALL;
  d.groups[id] = { ...g, name, perms: (perms || []).filter(p => ALL.includes(p)) };
  save(); audit(by, 'portal: group saved', name); return listGroups();
}
function deleteGroup(id, by = 'app') {
  const d = load(); if (!d.groups[id]) throw new Error('No such group.'); if (d.groups[id].builtin) throw new Error('The Owner group cannot be deleted.');
  delete d.groups[id]; for (const u of Object.values(d.users)) u.groups = (u.groups || []).filter(g => g !== id);
  save(); audit(by, 'portal: group deleted', id); return listGroups();
}
function audit(by, action, details) { try { require('./audit').log('web', by, action, details); } catch { /* ignore */ } }

// ---------- sessions and login ----------
const fails = new Map(); // ip -> { n, until }
function login(name, password, ip) {
  const f = fails.get(ip); if (f && f.until > Date.now()) throw new Error(`Too many failed logins; try again in ${Math.ceil((f.until - Date.now()) / 60000)} min.`);
  const u = load().users[idOf(name)];
  if (!u || u.enabled === false || !check(password, u)) {
    const n = (f && f.until > Date.now() - 600000 ? f.n : 0) + 1; fails.set(ip, { n, until: n >= 5 ? Date.now() + 600000 : Date.now() });
    audit(`${ip}`, 'portal login failed', String(name || '').slice(0, 40)); throw new Error('Wrong user name or password.');
  }
  fails.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  load().sessions[token] = { user: u.id, expires: Date.now() + 12 * 3600000, ip };
  u.lastLogin = new Date().toISOString(); u.lastIp = ip;
  for (const [t, s] of Object.entries(load().sessions)) if (s.expires < Date.now()) delete load().sessions[t];
  save(); audit(`${u.name} (portal)`, 'portal login', ip); return token;
}
function logout(token) { if (load().sessions[token]) { delete load().sessions[token]; save(); } }
function sessionUser(req) {
  const m = (req.headers.cookie || '').match(/dzportal=([a-f0-9]{48})/); if (!m) return null;
  const s = load().sessions[m[1]]; if (!s || s.expires < Date.now()) return null;
  const u = load().users[s.user]; if (!u || u.enabled === false) return null;
  s.expires = Date.now() + 12 * 3600000; return { ...publicUser(u), token: m[1], permSet: permsOf(u) };
}

// ---------- what the pages show ----------
let consoleLines = []; // the tool console, for logs.view
function notify(channel, data) { if (channel === 'console' && data) { consoleLines.push({ at: Date.now(), source: data.source, line: data.line }); if (consoleLines.length > 600) consoleLines.splice(0, consoleLines.length - 600); } }
function overview() {
  const server = require('./server').status();
  let h = null; try { h = require('./health').current(); } catch { /* ignore */ }
  let rcon = false; try { rcon = require('./rcon').status().connected; } catch { /* ignore */ }
  let online = null; try { const L = require('./live').players(); online = L.available ? L.players.length : (h ? h.players : null); } catch { /* ignore */ }
  let map = null; try { map = require('./mission').mapInfo(); } catch { /* ignore */ }
  return { server: { running: server.running, startedAt: server.startedAt, stage: server.stage, stopping: server.stopping, restartPending: server.restartPending, crashLoop: server.crashLoop }, rcon, health: h, online, map: map ? { key: map.map, label: map.label, size: map.size } : null, instance: settings.load().instanceName || 'Main' };
}
function newestLog(kind) {
  const l = require('./logs').list(); const re = kind === 'adm' ? /\.adm$/i : /\.rpt$/i;
  const f = l.files.find(x => re.test(x.name)); if (!f) return { name: null, text: '' };
  const r = require('./logs').read(f.name, 128 * 1024); return { name: f.name, text: r.text || r };
}
function mapFile(rel) {
  // tiles and the overview image of the active map, for the portal's map page
  const info = require('./mission').mapInfo(); if (!info) return null;
  if (rel === 'image' && info.image) return info.image;
  const m = String(rel).match(/^tiles\/(\d{1,2})\/(\d{1,3})_(\d{1,3})\.jpg$/); if (!m || !info.tiles) return null;
  const f = path.join(info.tiles.dir, m[1], `${m[2]}_${m[3]}.jpg`); return f.startsWith(info.tiles.dir) && fs.existsSync(f) ? f : null;
}

// ---------- HTTP ----------
let uiCache = null;
function ui() { if (!uiCache || !require('electron').app.isPackaged) uiCache = fs.readFileSync(path.join(__dirname, 'portal-ui.html'), 'utf8'); return uiCache; }
function readBody(req) { return new Promise((res, rej) => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { rej(new Error('bad json')); } }); req.on('error', rej); }); }
async function handle(req, res, p, send, url) {
  const json = (code, obj) => send(code, 'application/json', JSON.stringify(obj));
  const ip = String(req.socket.remoteAddress || '');
  if (!load().enabled) return send(404, 'text/html', '<h1>The portal is off</h1><p>Turn it on in DayZ Admin Tools → Website → Portal.</p>');
  if (p === '/portal') return send(200, 'text/html', ui());
  if (p.startsWith('/portal/map/')) { const f = mapFile(p.slice('/portal/map/'.length)); if (!f) return send(404, 'text/plain', 'no'); res.writeHead(200, { 'Content-Type': /\.png$/i.test(f) ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }); return fs.createReadStream(f).pipe(res); }
  if (!p.startsWith('/portal/api/')) return send(404, 'text/plain', 'Not found');
  const route = p.slice('/portal/api/'.length);
  const secure = req.socket.encrypted ? '; Secure' : '';
  if (route === 'login' && req.method === 'POST') {
    try { const b = await readBody(req); const token = login(b.name, b.password, ip); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `dzportal=${token}; HttpOnly; SameSite=Strict; Path=/portal; Max-Age=43200${secure}` }); return res.end(JSON.stringify({ ok: true })); }
    catch (e) { return json(401, { ok: false, error: e.message }); }
  }
  const user = sessionUser(req);
  if (!user) return json(401, { ok: false, error: 'Sign in.' });
  if (route === 'logout') { logout(user.token); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `dzportal=; Path=/portal; Max-Age=0${secure}` }); return res.end('{"ok":true}'); }
  if (req.method === 'POST' && req.headers['x-portal'] !== '1') return json(403, { ok: false, error: 'bad request' });
  const by = `${user.name} (portal)`;
  const need = (perm) => { if (!user.permSet.has(perm)) { const e = new Error(`You do not have permission: ${perm}.`); e.code = 403; throw e; } };
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const data = await api(route, body, url, user, need, by);
    return json(200, { ok: true, data });
  } catch (e) { return json(e.code === 403 ? 403 : 200, { ok: false, error: e.message || String(e) }); }
}
async function api(route, b, url, user, need, by) {
  const q = (k) => url.searchParams.get(k) || '';
  switch (route) {
    case 'me': return { name: user.name, groups: user.groups, perms: [...user.permSet], catalogue: PERMS, instance: settings.load().instanceName || 'Main' };
    case 'status': need('server.view'); return overview();
    case 'players': { need('players.view'); const L = require('./live').players(); return L; }
    case 'act': {
      need(ACTION_PERM[b.action] || 'portal.none');
      return require('./live').act(b.action, b.id, b.args || {}, by);
    }
    case 'spawnAt': need('admin.spawn'); return require('./live').spawnAt(b, by);
    case 'kits': need('admin.spawn'); return require('./live').kits();
    case 'vehicles': need('admin.spawn'); return require('./live').vehicles();
    case 'map': { need('players.view'); const i = require('./mission').mapInfo(); return { key: i.map, label: i.label, size: i.size, image: !!i.image, tiles: i.tiles ? { tile: i.tiles.tile, width: i.tiles.width, maxZ: i.tiles.maxZ, minZ: i.tiles.minZ } : null }; }
    case 'deaths': { need('deaths.view'); const dl = require('./deathlog'); const tk = require('./tickets'); return dl.list({ q: q('q'), limit: Math.min(300, Number(q('limit')) || 100) }).map(r => ({ ...r, tickets: tk.forDeath(r.id) })); }
    case 'death': { need('deaths.view'); const r = require('./deathlog').get(Number(q('id'))); return r ? { ...r, tickets: require('./tickets').forDeath(r.id) } : null; }
    case 'refund': {
      need('admin.refund'); const dl = require('./deathlog'); const al = require('./adminlog');
      const d = dl.get(Number(b.id)); if (!d) throw new Error('No such death record.');
      const r = await dl.refund(d.id, { by }); al.record({ action: 'refund', by, source: 'web', target: { name: d.name, steam: d.key }, details: `death #${d.id}: ${r.items} item(s)`, reason: String(b.reason || '').trim(), result: r }); return r;
    }
    case 'tickets': need('tickets.view'); return require('./tickets').list({ status: q('status'), q: q('q') });
    case 'ticket': need('tickets.view'); return require('./tickets').get(q('id'));
    case 'ticketOp': {
      need('tickets.manage'); const tk = require('./tickets');
      if (b.op === 'create') return tk.create({ subject: b.subject, description: b.description, player: b.player, deathId: b.deathId, by });
      if (b.op === 'note') return tk.note(b.id, b.text, by);
      if (b.op === 'assign') return tk.assign(b.id, b.assignee, by);
      if (b.op === 'link') return tk.link(b.id, b.deathId, by);
      if (b.op === 'unlink') return tk.unlink(b.id, b.deathId, by);
      if (b.op === 'status') return tk.setStatus(b.id, b.status, by, b.reason || '');
      throw new Error('Unknown ticket operation.');
    }
    case 'server': {
      need('server.control'); const server = require('./server');
      audit(by, 'server:' + b.what, '');
      if (b.what === 'start') return server.start();
      if (b.what === 'stop') { const pr = server.stop({ force: !!b.force }); pr.catch(() => {}); return server.status(); }
      if (b.what === 'restart') return require('./scheduler').restartNow();
      throw new Error('Unknown server action.');
    }
    case 'backup': { need('server.backup'); audit(by, 'backups:create', ''); return require('./backups').create('portal'); }
    case 'logs': { need('logs.view'); const kind = q('kind'); if (kind === 'console') return { name: 'console', lines: consoleLines.slice(-400) }; return newestLog(kind === 'adm' ? 'adm' : 'rpt'); }
    case 'audit': need('audit.view'); return require('./audit').list({ limit: 300, q: q('q') });
    case 'users': need('portal.users'); return { users: listUsers(), groups: listGroups(), catalogue: PERMS };
    case 'user': {
      need('portal.users');
      if (b.op === 'create') return createUser(b, by);
      if (b.op === 'update') return updateUser(b.id, { ...b.patch, _keepSession: b.id === user.id ? user.token : null }, by);
      if (b.op === 'delete') { if (b.id === user.id) throw new Error('You cannot delete yourself.'); return deleteUser(b.id, by); }
      throw new Error('Unknown user operation.');
    }
    case 'group': { need('portal.users'); if (b.op === 'upsert') return upsertGroup(b, by); if (b.op === 'delete') return deleteGroup(b.id, by); throw new Error('Unknown group operation.'); }
    case 'password': { if (String(b.password || '').length < 8) throw new Error('The password needs at least 8 characters.'); const u = load().users[user.id]; if (!check(b.current, u)) throw new Error('The current password is wrong.'); updateUser(user.id, { password: b.password, _keepSession: user.token }, by); return true; }
    default: throw new Error('Unknown route ' + route);
  }
}

// ---------- app side ----------
function status() {
  const d = load(); const w = require('./website');
  let urls = []; try { urls = w.status().urls || []; } catch { /* ignore */ }
  return { enabled: !!d.enabled, users: Object.keys(d.users).length, groups: Object.keys(d.groups).length, owners: Object.values(d.users).filter(u => permsOf(u).has('portal.users') && u.enabled !== false).map(u => u.name), url: urls.length ? urls[0].replace(/\/$/, '') + '/portal' : null, websiteOn: (() => { try { return w.status().running; } catch { return false; } })() };
}
function setEnabled(on) { load().enabled = !!on; save(); return status(); }
// the first (or a replacement) account that can manage the portal, made from the app so nobody can be locked out
function setOwner(name, password) {
  const d = load(); const id = idOf(name);
  if (d.users[id]) { updateUser(id, { password, groups: [...new Set([...(d.users[id].groups || []), 'owner'])], enabled: true }, 'app'); }
  else createUser({ name, password, groups: ['owner'] }, 'app');
  if (!d.enabled) { d.enabled = true; save(); }
  return status();
}

function init(emit) { emitRef = emit; }

module.exports = { init, handle, notify, status, setEnabled, setOwner, listUsers, listGroups, createUser, updateUser, deleteUser, upsertGroup, deleteGroup, login, sessionUser, PERMS, ACTION_PERM, _load: load };
