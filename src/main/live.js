'use strict';
// Live players for the map and the admin actions on them. Positions come from the bridge script in the mission
// (profiles\DayZAdminTools\players.txt, rewritten every 1.5 s); in-game actions go through its command queue
// (deathlog.sendCommand); kick, ban and messages go through RCon.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

let emitRef = () => {};
const file = () => path.join(settings.paths().profilesDir, 'DayZAdminTools', 'players.txt');
let last = null;

// { available, reason, at, players: [{ id, steam, name, x, y, z, heading, health, blood, alive, vehicle, god }] }
function players() {
  const server = require('./server').status();
  if (!server.running) return { available: false, reason: 'The server is not running.', players: [] };
  let st; try { st = fs.statSync(file()); } catch {
    let bridge = null; try { bridge = require('./deathlog').bridgeStatus(); } catch { /* ignore */ }
    return { available: false, reason: bridge && !bridge.installed ? 'Live positions need the bridge script: Death log page → Install, then restart the server.' : 'Waiting for the first positions (the bridge writes them once the server has finished loading).', players: [] };
  }
  // the bridge rewrites the file every 1.5 s; older than 20 s means the mission script is not running (old bridge or frozen server)
  if (Date.now() - st.mtimeMs > 20000) return { available: false, reason: `No live positions for ${Math.round((Date.now() - st.mtimeMs) / 1000)} s: the server is frozen or still runs an older bridge script (restart it to load the new one).`, at: st.mtimeMs, players: [] };
  if (last && last.mtime === st.mtimeMs) return last.data;
  const text = fs.readFileSync(file(), 'utf8');
  if (!text.startsWith('#begin') || !/\n#end\s*$/.test(text)) return last ? last.data : { available: false, reason: 'Reading…', players: [] }; // caught mid-write
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l || l[0] === '#') continue;
    const f = l.split('|'); if (f.length < 12) continue;
    out.push({ id: f[0], steam: f[1], name: f[2], x: +f[3], y: +f[4], z: +f[5], heading: +f[6], health: +f[7], blood: +f[8], alive: f[9] === 'true', vehicle: f[10] === '-' ? null : f[10], god: f[11] === 'true', frozen: f[12] === 'true', invisible: f[13] === 'true' });
  }
  const data = { available: true, at: st.mtimeMs, players: out };
  last = { mtime: st.mtimeMs, data };
  return data;
}

// Vehicles and territory flags the bridge found (vehicles.txt and flags.txt, rewritten every 3 s; bridge v5).
// { available, reason, at, vehicles: [{ id, cls, x, y, z, heading, health, fuel, engine, driver, crew, ruined }], flags: [{ x, y, z, refresher }] }
const worldFile = (n) => path.join(settings.paths().profilesDir, 'DayZAdminTools', n);
let lastWorld = null;
function framed(name) {
  let st; try { st = fs.statSync(worldFile(name)); } catch { return null; }
  const text = fs.readFileSync(worldFile(name), 'utf8');
  if (!text.startsWith('#begin') || !/\n#end\s*$/.test(text)) return { mtime: st.mtimeMs, lines: null };
  return { mtime: st.mtimeMs, lines: text.split(/\r?\n/).filter(l => l && l[0] !== '#') };
}
function world() {
  const P = players(); const none = (reason) => ({ available: false, reason, vehicles: [], flags: [] });
  if (!P.available) return none(P.reason);
  const V = framed('vehicles.txt'); const F = framed('flags.txt');
  if (!V) return none('Vehicles and flags need bridge script v5: Death log page → Install, then restart the server.');
  if (Date.now() - V.mtime > 30000) return none('The bridge has not written vehicles for a while (server frozen or still loading).');
  if (lastWorld && lastWorld.mtime === V.mtime) return lastWorld.data;
  if (!V.lines) return lastWorld ? lastWorld.data : none('Reading…');
  const vehicles = [];
  for (const l of V.lines) {
    const f = l.split('|'); if (f.length < 12) continue;
    vehicles.push({ id: f[0], cls: f[1], x: +f[2], y: +f[3], z: +f[4], heading: +f[5], health: +f[6], fuel: f[7] === '-' ? null : +f[7], engine: f[8] === 'true', driver: f[9] === '-' ? null : f[9], crew: Number(f[10]) || 0, ruined: f[11] === 'true' });
  }
  const flags = [];
  for (const l of (F && F.lines) || []) { const f = l.split('|'); if (f.length < 4) continue; flags.push({ x: +f[0], y: +f[1], z: +f[2], refresher: +f[3] }); }
  const data = { available: true, at: V.mtime, vehicles, flags };
  lastWorld = { mtime: V.mtime, data }; return data;
}
function findVehicle(id) { const W = world(); if (!W.available) throw new Error(W.reason); const v = W.vehicles.find(x => x.id === id); if (!v) throw new Error('That vehicle is not on the map any more.'); return v; }
// vehicle actions: vrepair, vrefuel, vbreak (what: tyres | fuel | engine | battery | all), vflip, vtp (x, z), vbring (to: player id), vdestroy, vdelete
async function vact(action, id, args = {}, by = 'app') {
  const { VEHICLE_ACTIONS, BREAK_KINDS } = require('./admin-actions'); if (!VEHICLE_ACTIONS.includes(action)) throw new Error('Unknown vehicle action.');
  const v = findVehicle(id); const reason = String(args.reason || '').trim();
  const adminlog = require('./adminlog'); adminlog.check(action, reason);
  const cmd = { type: action, id: v.id };
  let what = '';
  if (action === 'vbreak') { if (!BREAK_KINDS.some(([k]) => k === args.what)) throw new Error('Say what to break: tyres, fuel, engine, battery or all.'); cmd.what = args.what; what = BREAK_KINDS.find(([k]) => k === args.what)[1].toLowerCase(); }
  if (action === 'vtp') { if (!isFinite(args.x) || !isFinite(args.z)) throw new Error('No position.'); cmd.pos = [Number(args.x), Number(args.z)]; what = `to ${Math.round(args.x)}, ${Math.round(args.z)}`; }
  let to = null; if (action === 'vbring') { to = find(args.to); cmd.what = to.id; what = `to ${to.name}`; }
  const res = await require('./deathlog').sendCommand(cmd, { by });
  let r;
  if (res.status === 'noveh') throw new Error('The game no longer has that vehicle.');
  if (res.status === 'occupied') throw new Error('Someone is in that vehicle: get them out first.');
  r = said(res, action === 'vbring' ? 'bring' : action.slice(1));
  adminlog.record({ action, by, source: sourceOf(by), target: to ? { name: to.name, steam: to.steam } : null, details: `${v.cls} (${v.id}) at ${Math.round(v.x)}, ${Math.round(v.z)}${what ? ' ' + what : ''}`, reason, result: r });
  return r;
}

// ---------- kits and vehicles ----------
// A kit is a named list of lines: "Class", "Class x3", or "Parent; Attachment; Attachment" (fitted onto the parent).
const CLASS_RE = /^[A-Za-z0-9_]+$/;
function parseLine(line) {
  const t = String(line || '').trim(); if (!t || t.startsWith('#')) return null;
  const m = t.match(/^(.*?)(?:\s+x\s*(\d+))?$/i); const count = Math.max(1, Math.min(100, Number(m[2]) || 1));
  const parts = m[1].split(';').map(x => x.trim()).filter(Boolean);
  if (!parts.length || !parts.every(x => CLASS_RE.test(x))) throw new Error(`Not a class name: "${t}"`);
  return { spec: parts.join(';'), count };
}
const expand = (lines) => lines.map(parseLine).filter(Boolean).flatMap(l => Array(l.count).fill(l.spec));
function kits() { return (settings.load().kits || []).map(k => ({ ...k, items: (k.lines || []).length })); }
function kitItems(name) { const k = (settings.load().kits || []).find(x => x.name === name); if (!k) throw new Error(`No kit called ${name}.`); return expand(k.lines || []); }
// class names the economy knows; others are allowed (mod items not in types.xml) but reported
function knownClasses() { const set = new Set(); try { for (const i of require('./lootmap').items()) set.add(i.name.toLowerCase()); } catch { /* no mission */ } try { for (const v of vehicles()) set.add(v.name.toLowerCase()); } catch { /* none */ } return set; }
function saveKit({ name, lines, oldName }) {
  name = String(name || '').trim(); if (!name || name.length > 40) throw new Error('Give the kit a name (up to 40 characters).');
  const clean = String(Array.isArray(lines) ? lines.join('\n') : lines || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const parsed = clean.map(parseLine).filter(Boolean); if (!parsed.length) throw new Error('Add at least one item.');
  const known = knownClasses(); const unknown = [...new Set(parsed.flatMap(l => l.spec.split(';')).filter(c => known.size && !known.has(c.toLowerCase())))];
  const list = (settings.load().kits || []).filter(k => k.name !== name && k.name !== oldName);
  list.push({ name, lines: clean }); list.sort((a, b) => a.name.localeCompare(b.name));
  settings.save({ kits: list });
  return { kits: kits(), unknown };
}
function deleteKit(name) { settings.save({ kits: (settings.load().kits || []).filter(k => k.name !== name) }); return kits(); }
// Vehicles: every type in the mission's spawnable types whose parts include wheels, with all its parts (first item of
// each attachment slot, whatever its chance), so it spawns complete; the bridge fills every fluid.
function vehicles() {
  const eco = require('./economy'); const out = new Map();
  for (const f of eco.files().spawnable.filter(x => x.exists)) {
    let rows = []; try { rows = eco.loadSpawnable(f.abs); } catch { continue; }
    for (const r of rows) {
      const parts = r.attachments.filter(g => !g.preset && g.items.length).map(g => g.items[0].name).filter(n => CLASS_RE.test(n));
      if (!parts.some(n => /wheel/i.test(n)) || out.has(r.name)) continue;
      out.set(r.name, { name: r.name, parts });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function vehicleSpec(name) { const v = vehicles().find(x => x.name === name); if (!v) throw new Error(`${name} is not a vehicle in cfgspawnabletypes.xml.`); return [v.name, ...v.parts].join(';'); }
// the bridge reads one command per line: long lists go in several commands
function chunks(items, max = 700) { const out = []; let cur = []; let len = 0; for (const it of items) { if (cur.length && len + it.length > max) { out.push(cur); cur = []; len = 0; } cur.push(it); len += it.length + 1; } if (cur.length) out.push(cur); return out; }
async function sendItems(cmd, items, by) {
  const dl = require('./deathlog'); let ok = 0, fail = 0, last = null;
  for (const part of chunks(items)) { last = await dl.sendCommand({ ...cmd, items: part }, { by }); if (last.status !== 'done') break; ok += last.ok; fail += last.fail; }
  return last && last.status === 'done' ? { status: 'done', ok, fail } : { ...(last || {}), ok, fail };
}
// a vehicle spawned for a player stands a few metres away, not on top of them
const beside = (p) => { const h = (p.heading || 0) * Math.PI / 180; return { x: p.x + Math.sin(h) * 6, z: p.z + Math.cos(h) * 6 }; };
// spawn at a map point (nobody needed): an item, a kit or a vehicle
async function spawnAt({ x, z, item, count, kit, vehicle, reason }, by = 'app', record = true) {
  if (!isFinite(x) || !isFinite(z)) throw new Error('No position.');
  if (record) require('./adminlog').check('spawn', reason);
  const items = vehicle ? [vehicleSpec(vehicle)] : kit ? kitItems(kit) : expand([`${String(item || '').trim()} x${Number(count) || 1}`]);
  const r = said(await sendItems({ type: 'spawn', id: '-', pos: [Number(x), Number(z)] }, items, by), 'spawn');
  const what = vehicle || (kit ? 'kit ' + kit : `${Number(count) || 1} × ${item}`);
  if (record) require('./adminlog').record({ action: 'spawn', by, source: sourceOf(by), details: `${what} at ${Math.round(x)}, ${Math.round(z)}`, reason: String(reason || '').trim(), result: r });
  return r;
}

// where an action came from, for the audit log: this PC's app, the web portal, or the Discord bot
const sourceOf = (by) => by === 'app' || by === 'map' ? 'app' : /\(portal\)$/.test(String(by)) ? 'web' : 'discord';
function find(id) { const p = players().players.find(x => x.id === id || x.steam === id); if (!p) throw new Error('That player is not online.'); return p; }

// RCon's player number for a live player (by name; BattlEye knows no Steam or DayZ ids)
async function rconNum(p) {
  const rcon = require('./rcon');
  if (!rcon.status().connected) throw new Error('RCon is not connected.');
  const list = (await rcon.players()).players;
  const m = list.find(x => x.name === p.name) || list.find(x => x.name.toLowerCase() === p.name.toLowerCase());
  if (!m) throw new Error(`${p.name} is not in RCon's player list.`);
  return m;
}

const said = (res, what) => {
  if (res.status === 'done') return res;
  if (res.status === 'offline') throw new Error('The player is not in game (or is dead).');
  if (res.status === 'nodest') throw new Error('The player to go to is not in game.');
  if (res.status === 'pending') return res;
  if (res.withdrawn) throw new Error(`The game did not pick up the ${what} in time (is the bridge script loaded? it loads at server start).`);
  throw new Error(`${what} failed (${res.status}).`);
};

// One entry point for the map: act(action, playerId, args)
async function act(action, id, args = {}, by = 'app') {
  const dl = require('./deathlog');
  const p = find(id);
  const reason = String(args.reason || '').trim();
  const adminlog = require('./adminlog'); adminlog.check(action, reason);
  const log = (line, r) => adminlog.record({ action, by, source: sourceOf(by), target: { name: p.name, steam: p.steam }, details: line, reason, result: r });
  switch (action) {
    case 'heal': { const what = args.what || 'all'; const r = said(await dl.heal(p.id, what, { by }), 'heal'); log(`healed (${dl.HEAL_KINDS[what] || what})`, r); return r; }
    case 'tp': { const r = said(await dl.teleport(p.id, [Number(args.x), Number(args.z)], { by }), 'teleport'); log(`teleported to ${Math.round(args.x)}, ${Math.round(args.z)}`, r); return r; }
    case 'tpto': { const o = find(args.to); const r = said(await dl.sendCommand({ type: 'tpto', id: p.id, what: o.id }, { by }), 'teleport'); log(`teleported to ${o.name}`, r); return r; }
    case 'bring': { const o = find(args.to); const r = said(await dl.sendCommand({ type: 'tpto', id: o.id, what: p.id }, { by }), 'teleport'); log(`brought ${o.name} to them`, r); return r; }
    case 'kill': { const r = said(await dl.sendCommand({ type: 'kill', id: p.id }, { by }), 'kill'); log('killed', r); return r; }
    case 'god': { const on = !!args.on; const r = said(await dl.sendCommand({ type: 'god', id: p.id, what: on ? 'on' : 'off' }, { by }), 'god mode'); log(`god mode ${on ? 'on' : 'off'}`, r); return r; }
    case 'give': {
      const items = expand([`${String(args.item || '').trim()} x${Math.max(1, Math.min(50, Number(args.count) || 1))}`]);
      const r = said(await sendItems({ type: 'give', id: p.id }, items, by), 'give');
      log(`${args.item} × ${Math.max(1, Math.min(50, Number(args.count) || 1))}`, r); return r;
    }
    case 'kit': { const r = said(await sendItems({ type: 'give', id: p.id }, kitItems(args.kit), by), 'kit'); log(`kit ${args.kit}`, r); return r; }
    case 'vehicle': { const at = beside(p); const r = await spawnAt({ ...at, vehicle: args.vehicle }, by, false); log(`${args.vehicle} next to them`, r); return r; }
    case 'refund': {
      const d = dl.forPlayer(p.id, 1)[0] || dl.forPlayer(p.steam, 1)[0]; if (!d) throw new Error(`No recorded death for ${p.name}.`);
      const r = await dl.refund(d.id, { by }); log(`death #${d.id}: ${r.items} item(s)`, r); return { ...said(r, 'refund'), deathId: d.id };
    }
    case 'tpdeath': {
      const d = dl.forPlayer(p.id, 1)[0] || dl.forPlayer(p.steam, 1)[0]; if (!d) throw new Error(`No recorded death for ${p.name}.`);
      const r = said(await dl.teleportToDeath(d.id, { by }), 'teleport'); log(`teleported to their death #${d.id}`, r); return r;
    }
    case 'afflict': {
      const { afflictionLabel } = require('./admin-actions'); const what = String(args.what || '').trim().toLowerCase(); const label = afflictionLabel(what);
      if (!label) throw new Error('Unknown affliction: ' + what);
      const res = await dl.sendCommand({ type: 'afflict', id: p.id, what }, { by });
      if (res.status === 'nobleed') throw new Error('The game could not add a wound to them right now.');
      const r = said(res, 'affliction'); log(label.toLowerCase(), r); return r;
    }
    case 'freeze': { const on = !!args.on; const r = said(await dl.sendCommand({ type: 'freeze', id: p.id, what: on ? 'on' : 'off' }, { by }), 'freeze'); log(on ? 'frozen in place' : 'unfrozen', r); return r; }
    case 'invisible': { const on = !!args.on; const r = said(await dl.sendCommand({ type: 'invisible', id: p.id, what: on ? 'on' : 'off' }, { by }), 'invisible'); log(on ? 'made invisible' : 'visible again', r); return r; }
    case 'strip': { const r = said(await dl.sendCommand({ type: 'strip', id: p.id }, { by }), 'strip'); log(`stripped: ${r.ok} item(s) dropped`, r); return r; }
    case 'respawn': { const r = said(await dl.sendCommand({ type: 'respawn', id: p.id }, { by }), 'respawn'); log('respawned (killed, body removed)', r); return r; }
    case 'message': { const msg = String(args.text || '').trim(); if (!msg) throw new Error('Write a message.'); const m = await rconNum(p); await require('./rcon').say(msg, m.num); log(`messaged: ${msg}`, { status: 'done' }); return { status: 'done' }; }
    case 'kick': { const m = await rconNum(p); await require('./rcon').kick(m.num, args.reason || 'Kicked by an admin'); log(`kicked${args.reason ? ': ' + args.reason : ''}`, { status: 'done' }); return { status: 'done' }; }
    case 'ban': {
      // game ban (ban.txt by Steam64, survives restarts) and a kick now
      require('./lists').add('ban', { id: p.steam, name: p.name, reason: args.reason || '' }, { name: p.name, note: args.reason || 'banned from the map' });
      try { const m = await rconNum(p); await require('./rcon').kick(m.num, args.reason || 'Banned'); } catch (e) { emitRef('console', { source: 'admin', line: `${p.name} is banned but could not be kicked now (${e.message}); the ban applies at their next join.` }); }
      log(`banned${args.reason ? ': ' + args.reason : ''}`, { status: 'done' }); return { status: 'done' };
    }
    default: throw new Error('Unknown action.');
  }
}

function init(emit) { emitRef = emit; }

module.exports = { init, players, world, act, vact, kits, kitItems, saveKit, deleteKit, vehicles, spawnAt };
