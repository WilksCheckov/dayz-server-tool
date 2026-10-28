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
  ['lists.view', 'See the ban list, whitelist, priority queue and player notes', 'Players'],
  ['lists.manage', 'Add to and remove from the ban list, whitelist and priority queue; edit player notes', 'Players'],
  ['admin.menu', 'Open the in-game admin menu (DRP_Admin); needs a Steam id on the user', 'In-game admin'],
  ['admin.players', 'See and inspect players in game; the in-game map', 'In-game admin'],
  ['admin.heal', 'Heal', 'In-game admin'],
  ['admin.teleport', 'Teleport players (to a player, a map point, their death)', 'In-game admin'],
  ['admin.teleport.manage', 'Save and delete the server teleport spots (in game)', 'In-game admin'],
  ['admin.spawn', 'Give or spawn any item by class name', 'In-game admin'],
  ['admin.spawn.forbidden', 'Spawn items on the forbidden items list (in game)', 'In-game admin'],
  ['admin.weather', 'Change the weather and the time of day (in game)', 'In-game admin'],
  ['admin.kits', 'Give or spawn saved kits', 'In-game admin'],
  ['admin.vehicles', 'Spawn vehicles', 'In-game admin'],
  ['admin.god', 'God mode', 'In-game admin'],
  ['admin.kill', 'Kill a player (and respawn: kill with the body removed)', 'In-game admin'],
  ['admin.afflict', 'Afflictions and punishments: sickness, injuries, freeze, strip gear, invisible', 'In-game admin'],
  ['admin.refund', 'Refund a death', 'In-game admin'],
  ['admin.industry', 'Take, carry and place industrial building kits and pack buildings up (DRP_Industry)', 'In-game admin'],
  ['admin.delete', 'Delete objects in game: base parts, locks, items, vehicles (Cheats → Delete tool)', 'In-game admin'],
  ['admin.freecam', 'Freecam in game (fly the camera; the body stays behind)', 'In-game admin'],
  ['admin.editor', 'Object editor in game: place objects and run object sets for events', 'In-game admin'],
  ['admin.esp', 'ESP in game: labels for players, vehicles, creatures, base parts and items', 'In-game admin'],
  ['deaths.view', 'Death log', 'Records'],
  ['tickets.view', 'See tickets', 'Records'],
  ['tickets.manage', 'Assign, note, link and close tickets', 'Records'],
  ['logs.view', 'Server logs and the tool console', 'Records'],
  ['audit.view', 'Audit log', 'Records'],
  ['requests.approve', 'Approve or deny requests from other staff', 'Portal'],
  ['portal.users', 'Manage portal users, groups and permissions', 'Portal']
];
// what an action counts as for approval rules, blocked classes and daily limits
const { CATEGORY, PERM: ACTION_PERM, VEHICLE_ACTIONS, LABEL: ACTION_LABEL } = require('./admin-actions');
const CATEGORIES = [['refund', 'Refunds'], ['spawn', 'Items by class name'], ['kits', 'Kits'], ['vehicles', 'Vehicles'], ['teleport', 'Teleports'], ['heal', 'Heals'], ['afflict', 'Afflictions'], ['god', 'God mode'], ['kill', 'Kills']];
const ALL = PERMS.map(p => p[0]);
const DEFAULT_GROUPS = {
  owner: { name: 'Owner', perms: ALL, builtin: true },
  admin: { name: 'Admin', perms: ALL.filter(p => p !== 'portal.users'), approval: {} },
  moderator: { name: 'Moderator', perms: ['server.view', 'players.view', 'players.message', 'players.kick', 'players.ban', 'lists.view', 'lists.manage', 'deaths.view', 'tickets.view', 'tickets.manage', 'audit.view'] },
  gm: { name: 'Game master', perms: ['admin.menu', 'admin.players', 'server.view', 'players.view', 'players.message', 'lists.view', 'admin.heal', 'admin.teleport', 'admin.spawn', 'admin.kits', 'admin.vehicles', 'admin.god', 'admin.refund', 'deaths.view', 'tickets.view'] },
  developer: { name: 'Developer', perms: ['server.view', 'server.control', 'server.backup', 'logs.view', 'audit.view', 'deaths.view'] }
};
// which permission each in-game action needs

// ---------- data ----------
let db = null;
function load() {
  if (db) return db;
  db = { enabled: false, users: {}, groups: {}, sessions: {}, ...(jsonstore.readOr(file(), {}) || {}) };
  for (const [id, g] of Object.entries(DEFAULT_GROUPS)) if (!db.groups[id]) db.groups[id] = { ...g, perms: g.perms.slice() };
  // permissions added in a later version join the built-in groups that had them by default (your own groups are left alone)
  const PERMS_VERSION = 7;
  const was = db.permsVersion || 1;
  if (was < 2) for (const [id, g] of Object.entries(DEFAULT_GROUPS)) if (db.groups[id]) db.groups[id].perms = [...new Set([...(db.groups[id].perms || []), ...g.perms.filter(p => ['lists.view', 'lists.manage'].includes(p))])];
  // v3 split "give items, kits and vehicles" into three: whoever had it keeps all three; Owner and Admin may approve
  if (was < 3) { for (const g of Object.values(db.groups)) if ((g.perms || []).includes('admin.spawn')) g.perms = [...new Set([...g.perms, 'admin.kits', 'admin.vehicles'])]; for (const u of Object.values(db.users)) if ((u.allow || []).includes('admin.spawn')) u.allow = [...new Set([...u.allow, 'admin.kits', 'admin.vehicles'])]; for (const id of ['owner', 'admin']) if (db.groups[id]) db.groups[id].perms = [...new Set([...db.groups[id].perms, 'requests.approve'])]; }
  if (was < 4) { for (const g of Object.values(db.groups)) if ((g.perms || []).includes('admin.kill') && !g.builtin) g.perms = [...new Set([...g.perms, 'admin.afflict'])]; for (const id of ['owner', 'admin']) if (db.groups[id]) db.groups[id].perms = [...new Set([...db.groups[id].perms, 'admin.afflict'])]; }
  // v5 added the in-game admin permissions (DRP_Admin): Owner and Admin get them all, Game master the menu and players
  if (was < 5) { const inGame = ['admin.menu', 'admin.players', 'admin.teleport.manage', 'admin.spawn.forbidden', 'admin.weather']; for (const id of ['owner', 'admin']) if (db.groups[id]) db.groups[id].perms = [...new Set([...db.groups[id].perms, ...inGame])]; if (db.groups.gm && db.groups.gm.builtin !== false) db.groups.gm.perms = [...new Set([...db.groups.gm.perms, 'admin.menu', 'admin.players'])]; }
  // v6 added DRP_Industry's staff kits: Owner and Admin
  if (was < 6) for (const id of ['owner', 'admin']) if (db.groups[id]) db.groups[id].perms = [...new Set([...db.groups[id].perms, 'admin.industry'])];
  if (was < 7) for (const id of ['owner', 'admin']) if (db.groups[id]) db.groups[id].perms = [...new Set([...db.groups[id].perms, 'admin.delete', 'admin.freecam', 'admin.editor', 'admin.esp'])];
  if (was < PERMS_VERSION) { db.permsVersion = PERMS_VERSION; if (Object.keys(db.users).length) save(); }
  db.requests = db.requests || []; db.usage = db.usage || {}; db.policy = { blockedClasses: [], ...(db.policy || {}) };
  return db;
}
// every change to users and groups also refreshes the in-game admin list (written only when it changed)
function save() { jsonstore.write(file(), load(), true); try { require('./drpadmin').syncAdmins(); } catch { /* not available */ } }
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
const publicUser = (u) => ({ id: u.id, name: u.name, steam: u.steam || '', groups: u.groups || [], allow: u.allow || [], deny: u.deny || [], enabled: u.enabled !== false, trusted: !!u.trusted, createdAt: u.createdAt, createdBy: u.createdBy || null, lastLogin: u.lastLogin || null, lastIp: u.lastIp || null, perms: [...permsOf(u)] });

function listUsers() { return Object.values(load().users).map(publicUser).sort((a, b) => a.name.localeCompare(b.name)); }
function listGroups() { return Object.entries(load().groups).map(([id, g]) => ({ id, name: g.name, perms: g.perms || [], approval: g.approval || {}, itemsPerDay: Number(g.itemsPerDay) || 0, builtin: !!g.builtin, members: Object.values(load().users).filter(u => (u.groups || []).includes(id)).length })); }
// ---------- policy: what a user may do without asking, how much, and with which classes ----------
// A category needs approval for a user when every group of theirs that allows it says so (a group that allows it
// without approval wins); a trusted user never needs approval; the daily item limit is the most generous of the groups.
function policyFor(u) {
  const d = load(); const groups = (u.groups || []).map(g => d.groups[g]).filter(Boolean);
  const needs = new Set();
  for (const [cat] of CATEGORIES) if (groups.length && groups.every(g => (g.approval || {})[cat])) needs.add(cat);
  let itemsPerDay = null; for (const g of groups) { const n = Number(g.itemsPerDay) || 0; if (n === 0) { itemsPerDay = 0; break; } itemsPerDay = itemsPerDay === null ? n : Math.max(itemsPerDay, n); }
  return { needs: u.trusted ? new Set() : needs, trusted: !!u.trusted, itemsPerDay: itemsPerDay || 0, blockedClasses: d.policy.blockedClasses || [] };
}
const globToRe = (g) => new RegExp('^' + String(g).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
// the classes an action would spawn (so blocked ones are refused before anything is sent to the game)
function classesOf(action, args) {
  const live = require('./live');
  if (action === 'give' || (action === 'spawn' && args.item)) return String(args.item || '').split(';').map(x => x.trim()).filter(Boolean);
  if (action === 'kit' || (action === 'spawn' && args.kit)) { try { const k = (settings.load().kits || []).find(x => x.name === args.kit); return k ? k.lines.flatMap(l => l.replace(/\s+x\s*\d+$/i, '').split(';').map(x => x.trim()).filter(Boolean)) : []; } catch { return []; } }
  if (action === 'vehicle' || (action === 'spawn' && args.vehicle)) { try { const v = live.vehicles().find(x => x.name === args.vehicle); return v ? [v.name, ...v.parts] : [args.vehicle]; } catch { return [args.vehicle]; } }
  return [];
}
function itemCount(action, args) {
  if (action === 'give' || (action === 'spawn' && args.item)) return Math.max(1, Math.min(50, Number(args.count) || 1));
  if (action === 'kit' || (action === 'spawn' && args.kit)) { try { const k = (settings.load().kits || []).find(x => x.name === args.kit); return k ? k.lines.reduce((n, l) => n + (Number((l.match(/x\s*(\d+)$/i) || [])[1]) || 1), 0) : 0; } catch { return 0; } }
  if (action === 'vehicle' || (action === 'spawn' && args.vehicle)) return 1;
  return 0;
}
function usedToday(userId) { const d = load(); const since = Date.now() - 86400000; d.usage[userId] = (d.usage[userId] || []).filter(x => x.ts > since); return d.usage[userId].reduce((n, x) => n + x.n, 0); }
function recordUsage(userId, n) { if (!n) return; const d = load(); (d.usage[userId] = d.usage[userId] || []).push({ ts: Date.now(), n }); save(); }
// Checks a user may do this now: blocked classes and the daily limit throw; a category under approval returns false.
function allowedNow(user, action, args) {
  const pol = policyFor(load().users[user.id]); const cat = CATEGORY[action];
  const classes = classesOf(action, args);
  const blocked = classes.filter(c => pol.blockedClasses.some(g => globToRe(g).test(c)));
  if (blocked.length) throw new Error(`Not allowed through the portal: ${[...new Set(blocked)].join(', ')} (blocked class${blocked.length > 1 ? 'es' : ''}).`);
  const n = itemCount(action, args);
  if (n && pol.itemsPerDay && usedToday(user.id) + n > pol.itemsPerDay) throw new Error(`That would exceed your limit of ${pol.itemsPerDay} items per day (${usedToday(user.id)} used in the last 24 h).`);
  return !(cat && pol.needs.has(cat));
}
// a Steam64 id ties a portal user to their in-game character (DRP_Admin admins.json); '' clears it
function steamId(v) { const s = String(v || '').trim(); if (s && !/^7656\d{13}$/.test(s)) throw new Error('A Steam id is 17 digits starting with 7656 (Steam64).'); return s; }
function createUser({ name, password, groups = [], allow = [], deny = [], steam = '' }, by = 'app') {
  const d = load(); const id = idOf(name); name = String(name || '').trim();
  if (!id || name.length < 2 || name.length > 32) throw new Error('Give a user name of 2 to 32 characters.');
  if (d.users[id]) throw new Error(`There is already a user called ${d.users[id].name}.`);
  if (String(password || '').length < 8) throw new Error('The password needs at least 8 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  d.users[id] = { id, name, salt, hash: hash(password, salt), groups: groups.filter(g => d.groups[g]), allow: allow.filter(p => ALL.includes(p)), deny: deny.filter(p => ALL.includes(p)), steam: steamId(steam), enabled: true, createdAt: new Date().toISOString(), createdBy: by };
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
  if (patch.trusted !== undefined) next.trusted = !!patch.trusted;
  if (patch.steam !== undefined) { next.steam = steamId(patch.steam); const taken = Object.values(d.users).find(x => x.id !== id && next.steam && x.steam === next.steam); if (taken) throw new Error(`That Steam id already belongs to ${taken.name}.`); }
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
function upsertGroup({ id, name, perms, approval, itemsPerDay }, by = 'app') {
  const d = load(); id = idOf(id || name); name = String(name || '').trim();
  if (!id || !name) throw new Error('Give the group a name.');
  const g = d.groups[id] || {}; if (g.builtin && id === 'owner') { perms = ALL; approval = {}; itemsPerDay = 0; }
  const ap = {}; for (const [cat] of CATEGORIES) if (approval && approval[cat]) ap[cat] = true;
  d.groups[id] = { ...g, name, perms: (perms || []).filter(p => ALL.includes(p)), approval: approval === undefined ? (g.approval || {}) : ap, itemsPerDay: itemsPerDay === undefined ? (Number(g.itemsPerDay) || 0) : Math.max(0, Number(itemsPerDay) || 0) };
  save(); audit(by, 'portal: group saved', name); return listGroups();
}
function setPolicy({ blockedClasses }, by = 'app') { const d = load(); d.policy.blockedClasses = String(Array.isArray(blockedClasses) ? blockedClasses.join('\n') : blockedClasses || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean).slice(0, 500); save(); audit(by, 'portal: policy saved', `${d.policy.blockedClasses.length} blocked class pattern(s)`); return d.policy; }

// ---------- requests: actions that need another pair of eyes ----------
// A request holds everything needed to run the action later; approving runs it under the requester's name and
// records who approved. Requests expire after 24 hours.
function newRequest(user, action, args, target) {
  const d = load(); d.requestSeq = (d.requestSeq || 0) + 1;
  const r = { id: String(d.requestSeq).padStart(4, '0'), action, category: CATEGORY[action] || action, args, target: target || null, by: user.id, byName: user.name, reason: String(args.reason || '').trim(), createdAt: new Date().toISOString(), status: 'pending' };
  d.requests.push(r); if (d.requests.length > 500) d.requests.splice(0, d.requests.length - 500); save();
  emitRef('console', { source: 'portal', line: `${user.name} asks for approval: ${describeRequest(r)}` });
  audit(`${user.name} (portal)`, 'portal: request ' + r.id, describeRequest(r));
  try { require('./discord').postApprovalRequest(r).catch(() => {}); } catch { /* bot not loaded */ }
  return r;
}
// An in-game action (DRP_Admin) that needs approval: the game keeps the action and runs it once approved here.
function requestFromGame(steam, cat, desc, rid, reason = '') {
  const user = Object.values(load().users).find(u => u.steam === steam && u.enabled !== false);
  if (!user) throw new Error('your Steam id is not linked to a portal user');
  const r = newRequest(user, 'ingame', { desc, rid, reason }, null);
  r.category = CATEGORIES.some(([c]) => c === cat) ? cat : 'ingame'; save();
  return r;
}
function approvalNeeds(userId) { const u = load().users[userId]; return u ? [...policyFor(u).needs] : []; }
function describeRequest(r) {
  const a = r.args || {};
  if (r.action === 'ingame') return `${a.desc || 'in-game action'} (in game)${r.reason ? ` — ${r.reason}` : ''}`; const t = r.target ? ` for ${r.target.name}` : '';
  const what = VEHICLE_ACTIONS.includes(r.action) ? `${(ACTION_LABEL[r.action] || r.action).replace(/^\S+\s/, '')}${a.what ? ' (' + a.what + ')' : ''}${a.to ? ' to ' + a.to : ''}` : r.action === 'give' ? `${a.count || 1} × ${a.item}` : r.action === 'kit' ? `kit ${a.kit}` : r.action === 'vehicle' ? `vehicle ${a.vehicle}` : r.action === 'spawn' ? `${a.vehicle || (a.kit ? 'kit ' + a.kit : `${a.count || 1} × ${a.item}`)} at ${Math.round(a.x)}, ${Math.round(a.z)}` : r.action === 'refund' ? `refund of death #${a.id}` : r.action;
  return `${what}${t}${r.reason ? ` — ${r.reason}` : ''}`;
}
function listRequests(user) {
  const d = load(); const cutoff = Date.now() - 7 * 86400000;
  for (const r of d.requests) if (r.status === 'pending' && Date.parse(r.createdAt) < Date.now() - 86400000) { r.status = 'expired'; }
  const all = d.requests.filter(r => Date.parse(r.createdAt) > cutoff);
  return (permsOf(user).has('requests.approve') ? all : all.filter(r => r.by === user.id)).map(r => ({ ...r, text: describeRequest(r) })).reverse();
}
async function decide(id, approve, approverName, approverId = null, note = '') {
  const d = load(); const r = d.requests.find(x => x.id === id); if (!r) throw new Error(`No request #${id}.`);
  if (r.status !== 'pending') throw new Error(`Request #${id} is already ${r.status}.`);
  if (approverId && approverId === r.by) throw new Error('You cannot approve your own request.');
  r.decidedBy = approverName; r.decidedAt = new Date().toISOString(); r.note = String(note || '').slice(0, 300);
  if (!approve) { r.status = 'denied'; save(); if (r.action === 'ingame') { try { require('./gamereq').decided(r.args.rid, false, approverName); } catch { /* ignore */ } } audit(`${approverName} (portal)`, 'portal: denied ' + r.id, describeRequest(r)); emitRef('console', { source: 'portal', line: `${approverName} denied ${r.byName}'s request #${r.id}: ${describeRequest(r)}` }); return r; }
  r.status = 'approved'; save();
  const by = `${r.byName} (portal, approved by ${approverName})`;
  try {
    r.result = await runAction(r.action, r.args, r.target, by);
    recordUsage(r.by, itemCount(r.action, r.args));
  } catch (e) { r.result = { status: 'error', error: e.message }; }
  save(); audit(`${approverName} (portal)`, 'portal: approved ' + r.id, describeRequest(r));
  return r;
}
async function runAction(action, args, target, by) {
  // the game runs it: tell it the decision
  if (action === 'ingame') { require('./gamereq').decided(args.rid, true, by.replace(/^.*approved by (.*)\)$/, '$1')); return { status: 'done', note: 'runs in game' }; }
  const live = require('./live');
  if (action === 'spawn') return live.spawnAt(args, by);
  if (VEHICLE_ACTIONS.includes(action)) return live.vact(action, target.id, args, by);
  if (action === 'refund') { const dl = require('./deathlog'); const al = require('./adminlog'); const dd = dl.get(Number(args.id)); if (!dd) throw new Error('No such death record.'); const res = await dl.refund(dd.id, { by }); al.record({ action: 'refund', by, source: 'web', target: { name: dd.name, steam: dd.key }, details: `death #${dd.id}: ${res.items} item(s)`, reason: String(args.reason || '').trim(), result: res }); return res; }
  return live.act(action, target.id, args, by);
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

// One player, everything the tool knows: the database record, where they are now, deaths, tickets, combat, Steam
// bans, account signals, list membership, the note, and every admin action done to them.
function profile(key) {
  const players = require('./players'); const lists = require('./lists');
  const r = players.get(key) || (() => { const row = players.all({ query: key, limit: 1 })[0]; return row ? players.get(row.key) : null; })();
  if (!r) throw new Error('No such player in the database.');
  const names = r.names || [r.name]; const name = r.name || names[names.length - 1];
  const ids = [r.key, r.id, r.steamId].filter(Boolean);
  let live = null; try { const L = require('./live').players(); if (L.available) live = L.players.find(p => ids.includes(p.id) || ids.includes(p.steam) || p.name === name) || null; } catch { /* ignore */ }
  const recentDeaths = require('./deathlog').forPlayer(r.key, 10);
  let tickets = []; try { tickets = require('./tickets').list({ q: name }).filter(t => t.player === name || (t.deaths || []).some(d => recentDeaths.some(x => x.id === d))); } catch { /* ignore */ }
  let combat = null; try { combat = require('./combat').forPlayer(r.key) || require('./combat').forPlayer(name); } catch { /* ignore */ }
  let steam = null; try { const sb = require('./steambans'); const rec = sb.get(r.steamId); if (rec) steam = { text: sb.summary(rec), flagged: sb.flagged(rec), checkedAt: rec.checkedAt || null }; } catch { /* ignore */ }
  let account = null; try { account = require('./accounts').summary({ steamId: r.steamId, names }); } catch { /* ignore */ }
  const on = (kind) => ids.some(i => { try { return lists.has(kind, i); } catch { return false; } });
  const actions = require('./audit').list({ limit: 2000 }).filter(a => /^admin:/.test(a.action) && typeof a.details === 'string' && (a.details.includes(name) || (r.steamId && a.details.includes(r.steamId)))).slice(0, 30);
  return { ...r, name, names, live, recentDeaths, tickets, combat, steam, account, lists: { ban: on('ban'), whitelist: on('whitelist'), priority: on('priority') }, actions };
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
      const args = b.args || {};
      if (!allowedNow(user, b.action, args)) { const L = require('./live').players(); const target = L.available && L.players.find(p => p.id === b.id); if (!target) throw new Error('That player is not online.'); const r = newRequest(user, b.action, args, { id: target.id, name: target.name, steam: target.steam }); return { status: 'approval', request: r.id }; }
      const r = await require('./live').act(b.action, b.id, args, by); recordUsage(user.id, itemCount(b.action, args)); return r;
    }
    case 'spawnAt': {
      need(b.vehicle ? 'admin.vehicles' : b.kit ? 'admin.kits' : 'admin.spawn');
      if (!allowedNow(user, 'spawn', b)) { const r = newRequest(user, 'spawn', b, null); return { status: 'approval', request: r.id }; }
      const r = await require('./live').spawnAt(b, by); recordUsage(user.id, itemCount('spawn', b)); return r;
    }
    case 'world': need('players.view'); return require('./live').world();
    case 'vact': {
      need(ACTION_PERM[b.action] || 'portal.none'); if (!VEHICLE_ACTIONS.includes(b.action)) throw new Error('Unknown vehicle action.');
      const args = b.args || {}; const W = require('./live').world(); const v = W.available && W.vehicles.find(x => x.id === b.id); if (!v) throw new Error('That vehicle is not on the map any more.');
      if (!allowedNow(user, b.action, args)) { const r = newRequest(user, b.action, args, { id: v.id, name: `${v.cls} at ${Math.round(v.x)}, ${Math.round(v.z)}` }); return { status: 'approval', request: r.id }; }
      return require('./live').vact(b.action, b.id, args, by);
    }
    case 'policy': need('portal.users'); return { ...load().policy, categories: CATEGORIES };
    case 'setPolicy': need('portal.users'); return setPolicy(b, by);
    case 'requests': return { requests: listRequests(user), canApprove: user.permSet.has('requests.approve'), policy: (() => { const p = policyFor(load().users[user.id]); return { needs: [...p.needs], itemsPerDay: p.itemsPerDay, usedToday: usedToday(user.id), trusted: p.trusted }; })() };
    case 'requestOp': {
      if (b.op === 'cancel') { const r = load().requests.find(x => x.id === b.id); if (!r || r.by !== user.id) throw new Error('Not your request.'); if (r.status !== 'pending') throw new Error('Already decided.'); r.status = 'cancelled'; save(); return r; }
      need('requests.approve'); return decide(b.id, b.op === 'approve', user.name, user.id, b.note);
    }
    case 'kits': need('admin.spawn'); return require('./live').kits();
    case 'vehicles': need('admin.spawn'); return require('./live').vehicles();
    case 'player': need('players.view'); return profile(q('key'));
    case 'playerSearch': need('players.view'); return require('./players').all({ query: q('q'), limit: 30 }).map(p => ({ key: p.key, name: p.name, steamId: p.steamId || null, online: !!p.online, lastSeen: p.lastSeen, playtimeSec: p.playtimeSec, kills: p.kills, deaths: p.deaths, banned: !!p.banned, whitelisted: !!p.whitelisted }));
    case 'playerNote': { need('lists.manage'); const r = require('./players').setNote(b.key, String(b.text || '').slice(0, 2000)); audit(by, 'players:setNote', `${r.name}: ${String(b.text || '').slice(0, 200)}`); return true; }
    case 'lists': need('lists.view'); return require('./lists').allLists();
    case 'listOp': {
      need('lists.manage'); const lists = require('./lists'); const kind = b.kind;
      if (!lists.KINDS[kind]) throw new Error('Unknown list.');
      const al = require('./adminlog'); const action = kind === 'ban' || kind === 'bebans' ? 'ban' : kind;
      if (b.op === 'add') {
        if (action === 'ban') al.check('ban', b.reason);
        lists.add(kind, { id: b.id, minutes: b.minutes, reason: b.reason || '', name: b.name || '' }, { name: b.name || '', note: b.reason || '' });
        al.record({ action: kind === 'ban' ? 'ban' : kind === 'bebans' ? 'beban' : kind, by, source: 'web', target: { name: b.name || b.id, steam: b.id }, details: `added to ${lists.KINDS[kind].label}${b.minutes ? ` for ${b.minutes} min` : ''}`, reason: String(b.reason || '').trim(), result: { status: 'done' } });
        return lists.read(kind);
      }
      if (b.op === 'remove') { lists.remove(kind, b.id); al.record({ action: kind === 'ban' || kind === 'bebans' ? 'unban' : 'unlist', by, source: 'web', target: { name: b.name || b.id, steam: b.id }, details: `removed from ${lists.KINDS[kind].label}`, reason: String(b.reason || '').trim(), result: { status: 'done' } }); return lists.read(kind); }
      throw new Error('Unknown list operation.');
    }
    case 'map': { need('players.view'); const i = require('./mission').mapInfo(); return { afflictions: require('./admin-actions').AFFLICTIONS, key: i.map, label: i.label, size: i.size, image: !!i.image, tiles: i.tiles ? { tile: i.tiles.tile, width: i.tiles.width, maxZ: i.tiles.maxZ, minZ: i.tiles.minZ } : null }; }
    case 'deaths': { need('deaths.view'); const dl = require('./deathlog'); const tk = require('./tickets'); return dl.list({ q: q('q'), limit: Math.min(300, Number(q('limit')) || 100) }).map(r => ({ ...r, tickets: tk.forDeath(r.id) })); }
    case 'death': { need('deaths.view'); const r = require('./deathlog').get(Number(q('id'))); return r ? { ...r, tickets: require('./tickets').forDeath(r.id) } : null; }
    case 'refund': {
      need('admin.refund'); const dl = require('./deathlog');
      const d = dl.get(Number(b.id)); if (!d) throw new Error('No such death record.');
      if (!allowedNow(user, 'refund', b)) { const r = newRequest(user, 'refund', { id: d.id, reason: b.reason }, { id: d.key, name: d.name, steam: d.key }); return { status: 'approval', request: r.id }; }
      return runAction('refund', { id: d.id, reason: b.reason }, null, by);
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
    case 'users': need('portal.users'); return { users: listUsers(), groups: listGroups(), catalogue: PERMS, categories: CATEGORIES, policy: load().policy };
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

module.exports = { requestFromGame, approvalNeeds, init, handle, notify, status, setEnabled, setOwner, listUsers, listGroups, createUser, updateUser, deleteUser, upsertGroup, deleteGroup, setPolicy, login, sessionUser, decide, describeRequest, listRequests, PERMS, ACTION_PERM, CATEGORIES, _load: load };
