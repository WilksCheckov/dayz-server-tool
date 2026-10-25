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
    out.push({ id: f[0], steam: f[1], name: f[2], x: +f[3], y: +f[4], z: +f[5], heading: +f[6], health: +f[7], blood: +f[8], alive: f[9] === 'true', vehicle: f[10] === '-' ? null : f[10], god: f[11] === 'true' });
  }
  const data = { available: true, at: st.mtimeMs, players: out };
  last = { mtime: st.mtimeMs, data };
  return data;
}

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
  const log = (line) => { emitRef('console', { source: 'admin', line: `${p.name}: ${line}` }); try { require('./audit').log('app', by, 'admin:' + action, `${p.name} (${p.steam}) ${line}`); } catch { /* ignore */ } };
  switch (action) {
    case 'heal': { const what = args.what || 'all'; const r = said(await dl.heal(p.id, what, { by }), 'heal'); log(`healed (${dl.HEAL_KINDS[what] || what})`); return r; }
    case 'tp': { const r = said(await dl.teleport(p.id, [Number(args.x), Number(args.z)], { by }), 'teleport'); log(`teleported to ${Math.round(args.x)}, ${Math.round(args.z)}`); return r; }
    case 'tpto': { const o = find(args.to); const r = said(await dl.sendCommand({ type: 'tpto', id: p.id, what: o.id }, { by }), 'teleport'); log(`teleported to ${o.name}`); return r; }
    case 'bring': { const o = find(args.to); const r = said(await dl.sendCommand({ type: 'tpto', id: o.id, what: p.id }, { by }), 'teleport'); log(`brought ${o.name} to them`); return r; }
    case 'kill': { const r = said(await dl.sendCommand({ type: 'kill', id: p.id }, { by }), 'kill'); log('killed'); return r; }
    case 'god': { const on = !!args.on; const r = said(await dl.sendCommand({ type: 'god', id: p.id, what: on ? 'on' : 'off' }, { by }), 'god mode'); log(`god mode ${on ? 'on' : 'off'}`); return r; }
    case 'give': {
      const cls = String(args.item || '').trim(); const n = Math.max(1, Math.min(50, Number(args.count) || 1));
      if (!/^[A-Za-z0-9_]+$/.test(cls)) throw new Error('Give a class name, for example AKM or BandageDressing.');
      const r = said(await dl.sendCommand({ type: 'give', id: p.id, items: Array(n).fill(cls) }, { by }), 'give');
      log(`given ${r.ok} × ${cls}${r.fail ? ` (${r.fail} failed: is the class name right?)` : ''}`); return r;
    }
    case 'refund': {
      const d = dl.forPlayer(p.id, 1)[0] || dl.forPlayer(p.steam, 1)[0]; if (!d) throw new Error(`No recorded death for ${p.name}.`);
      const r = await dl.refund(d.id, { by }); if (r.status === 'done' && r.ok > 0) log(`refunded ${r.ok}/${r.items} items from death #${d.id}`); return { ...said(r, 'refund'), deathId: d.id };
    }
    case 'tpdeath': {
      const d = dl.forPlayer(p.id, 1)[0] || dl.forPlayer(p.steam, 1)[0]; if (!d) throw new Error(`No recorded death for ${p.name}.`);
      const r = said(await dl.teleportToDeath(d.id, { by }), 'teleport'); log(`teleported to their death #${d.id}`); return r;
    }
    case 'message': { const msg = String(args.text || '').trim(); if (!msg) throw new Error('Write a message.'); const m = await rconNum(p); await require('./rcon').say(msg, m.num); log(`messaged: ${msg}`); return { status: 'done' }; }
    case 'kick': { const m = await rconNum(p); await require('./rcon').kick(m.num, args.reason || 'Kicked by an admin'); log(`kicked${args.reason ? ': ' + args.reason : ''}`); return { status: 'done' }; }
    case 'ban': {
      // game ban (ban.txt by Steam64, survives restarts) and a kick now
      require('./lists').add('ban', { id: p.steam, name: p.name, reason: args.reason || '' }, { name: p.name, note: args.reason || 'banned from the map' });
      try { const m = await rconNum(p); await require('./rcon').kick(m.num, args.reason || 'Banned'); } catch (e) { emitRef('console', { source: 'admin', line: `${p.name} is banned but could not be kicked now (${e.message}); the ban applies at their next join.` }); }
      log(`banned${args.reason ? ': ' + args.reason : ''}`); return { status: 'done' };
    }
    default: throw new Error('Unknown action.');
  }
}

function init(emit) { emitRef = emit; }

module.exports = { init, players, act };
