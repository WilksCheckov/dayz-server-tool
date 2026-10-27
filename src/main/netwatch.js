'use strict';
// Movement and ping watch: flags speed hacks, teleports and lag switching from live data instead of only from fights.
//
// Movement: the bridge's live positions (live.players(), rewritten every 1.5 s) are sampled every 4 s for every
// player. On foot faster than footMps, or in a vehicle faster than vehicleMps, on two samples in a row is flagged as
// "impossible movement"; a single jump of teleportM or more on foot (vehicleTeleportM in a vehicle) is flagged at once.
// Not checked: dead players, players the tool just teleported (map, Discord, death teleports; noteTeleport), the first
// position after a login or respawn, and players in god mode, frozen or invisible (admins at work).
//
// Ping: RCon's player list (BattlEye's ping per player) is sampled every 15 s and matched to players by name.
//   high ping     the median of the last 2 minutes is above highPingMs
//   ping spikes   spikeCount or more spikes within 10 minutes: a sample above spikeMs and 4× the player's usual ping,
//                 back to normal by the next sample (the pattern of a lag switch)
//   lag switch    impossible movement within 30 s of a ping spike or during high ping
// Every flag's detail also carries the player's ping at the time (pingNote), so a jump during lag is easy to tell
// apart from a speed hack. Thresholds live in settings.combatFlags with the other flag settings.
const settings = require('./settings');

const MOVE_EVERY_MS = 4000;
const PING_EVERY_MS = 15000;
const PING_KEEP_MS = 30 * 60000;
const TP_GRACE_MS = 20000;
let emitRef = () => {};
let moveTimer = null, pingTimer = null;
const state = new Map();          // identity id -> { name, pos, fast, lastMoveFlag, ... }
const pings = new Map();          // lower-case name -> { name, samples: [[ts, ms]], spikes: [ts], lastHighFlag, lastSpikeFlag }
const teleported = new Map();     // identity id or Steam id -> until (ts)
let vehicleGraceUntil = 0;
let liveAt = 0;                   // when live positions were last read (combat.js skips its own fight-only check then)

function cfg() {
  return { footMps: 9, vehicleMps: 55, teleportM: 100, vehicleTeleportM: 400, highPingMs: 300, spikeMs: 500, spikeCount: 3, ...(settings.load().combatFlags || {}) };
}
function combat() { return require('./combat'); }

// ---------- teleports the tool makes ----------
// deathlog.sendCommand calls this for every teleport-type command, whoever sent it (app, map, Discord, portal).
function noteTeleport(cmd) {
  const until = Date.now() + TP_GRACE_MS;
  if (cmd.type === 'vtp') { vehicleGraceUntil = until; return; }
  if (cmd.id && cmd.id !== '-') teleported.set(String(cmd.id), until);
}
const graced = (p) => [p.id, p.steam].some(k => k && (teleported.get(k) || 0) > Date.now()) || (p.vehicle && vehicleGraceUntil > Date.now());

// ---------- movement ----------
function sampleMovement() {
  let data;
  try { data = require('./live').players(); } catch { return; }
  if (!data.available) return;
  liveAt = Date.now();
  const c = cfg();
  const ts = data.at || Date.now();
  const seen = new Set();
  for (const p of data.players) {
    seen.add(p.id);
    let s = state.get(p.id);
    if (!s) { s = { name: p.name, pos: null, fast: 0, lastMoveFlag: 0 }; state.set(p.id, s); }
    s.name = p.name;
    const here = { x: p.x, y: p.y, z: p.z, ts, vehicle: !!p.vehicle };
    // Positions that say nothing about speed: start again from here.
    if (!p.alive || p.god || p.frozen || p.invisible || graced(p) || !isFinite(p.x) || !isFinite(p.z) || (p.x === 0 && p.z === 0)) { s.pos = p.alive ? here : null; s.fast = 0; continue; }
    const prev = s.pos;
    s.pos = here;
    if (!prev || ts <= prev.ts) continue;
    const dt = (ts - prev.ts) / 1000;
    if (dt > 30) { s.fast = 0; continue; }          // a gap (server hitch): too long to say anything
    const dist = Math.hypot(p.x - prev.x, p.z - prev.z);
    const mps = dist / dt;
    // Getting in or out of a vehicle between two samples: the vehicle limits apply.
    const inVehicle = here.vehicle || prev.vehicle;
    const limit = inVehicle ? c.vehicleMps : c.footMps;
    const jump = inVehicle ? c.vehicleTeleportM : c.teleportM;
    const fast = mps > limit;
    s.fast = fast ? s.fast + 1 : 0;
    if ((dist >= jump || s.fast >= 2) && ts - s.lastMoveFlag > 60000) {
      s.lastMoveFlag = ts;
      s.fast = 0;
      const how = inVehicle ? `in ${p.vehicle || 'a vehicle'}` : 'on foot';
      const detail = `${Math.round(dist)} m in ${dt.toFixed(1)} s ${how} (${Math.round(mps)} m/s, limit ${limit})`;
      combat().flagExternal(p.id, p.name, 'impossible movement', detail, ts);
      const pk = pings.get(p.name.toLowerCase());
      // A spike that is still going on counts too (its ping has not come back down yet).
      const spike = pk && (pk.spikes.some(t => Math.abs(ts - t) <= 30000) || (pk.pendingSpike && Math.abs(ts - pk.pendingSpike.ts) <= 30000)
        || pk.samples.some(([t, ms]) => Math.abs(ts - t) <= 30000 && ms > c.spikeMs));
      const high = pk && median(recent(pk, 120000)) > c.highPingMs;
      if (spike || high) combat().flagExternal(p.id, p.name, 'lag switch', `${detail} during ${spike ? 'a ping spike' : 'high ping'}`, ts);
    }
  }
  for (const id of state.keys()) if (!seen.has(id)) state.delete(id);   // logged out: the next login starts fresh
}

// ---------- ping ----------
const recent = (pk, ms) => pk.samples.filter(([t]) => t >= Date.now() - ms).map(([, v]) => v);
function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
async function samplePing() {
  let rcon;
  try { rcon = require('./rcon'); if (!rcon.status().connected) return; } catch { return; }
  let list;
  try { list = (await rcon.players()).players; } catch { return; }
  const c = cfg();
  const now = Date.now();
  // RCon names the player; the flag goes on the identity id the bridge and admin log use, when the bridge knows them.
  let live = [];
  try { const d = require('./live').players(); if (d.available) live = d.players; } catch { /* name only */ }
  for (const r of list) {
    if (r.lobby || !(r.ping >= 0)) continue;
    const k = r.name.toLowerCase();
    let pk = pings.get(k);
    if (!pk) { pk = { name: r.name, samples: [], spikes: [], lastHighFlag: 0, lastSpikeFlag: 0, pendingSpike: null }; pings.set(k, pk); }
    const before = recent(pk, 10 * 60000);
    const usual = median(before.slice(-8));
    pk.samples.push([now, r.ping]);
    pk.samples = pk.samples.filter(([t]) => t >= now - PING_KEEP_MS);
    const who = live.find(p => p.name.toLowerCase() === k);
    const key = who ? who.id : r.name;
    // A spike counts once the ping is back to normal on the next sample (a steady bad line is "high ping" instead).
    if (pk.pendingSpike && r.ping < Math.max(2 * pk.pendingSpike.usual, 150)) { pk.spikes.push(pk.pendingSpike.ts); pk.pendingSpike = null; }
    else if (pk.pendingSpike) pk.pendingSpike = null;
    if (before.length >= 4 && r.ping > c.spikeMs && r.ping > 4 * Math.max(usual, 20)) pk.pendingSpike = { ts: now, usual, ms: r.ping };
    pk.spikes = pk.spikes.filter(t => t >= now - 10 * 60000);
    if (pk.spikes.length >= c.spikeCount && now - pk.lastSpikeFlag > 10 * 60000) {
      pk.lastSpikeFlag = now;
      combat().flagExternal(key, r.name, 'ping spikes', `${pk.spikes.length} spikes above ${c.spikeMs} ms in 10 min (usual ${usual} ms)`, now);
    }
    const last2 = recent(pk, 120000);
    if (last2.length >= 6 && median(last2) > c.highPingMs && now - pk.lastHighFlag > 30 * 60000) {
      pk.lastHighFlag = now;
      combat().flagExternal(key, r.name, 'high ping', `${median(last2)} ms for 2 minutes (limit ${c.highPingMs})`, now);
    }
  }
  const online = new Set(list.map(r => r.name.toLowerCase()));
  for (const [k, pk] of pings) if (!online.has(k) && !pk.samples.some(([t]) => t >= now - PING_KEEP_MS)) pings.delete(k);
  emitRef('netwatch:ping', {});
}

// ---------- for the rest of the tool ----------
// { now, avg, max, spikes } over the last 30 minutes, or null when there are no samples.
function pingStats(name) {
  const pk = name && pings.get(String(name).toLowerCase());
  if (!pk || !pk.samples.length) return null;
  const v = pk.samples.map(([, ms]) => ms);
  return { now: v[v.length - 1], avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length), max: Math.max(...v), spikes: pk.spikes.length, at: pk.samples[pk.samples.length - 1][0], history: pk.samples.slice(-120) };
}
// " · ping 85 ms (avg 80)" for flag details, or ''.
function pingNote(name) {
  const s = pingStats(name);
  if (!s || Date.now() - s.at > 60000) return '';
  return ` · ping ${s.now} ms (avg ${s.avg}${s.spikes ? `, ${s.spikes} spike${s.spikes > 1 ? 's' : ''}` : ''})`;
}
// True while live positions are being read, so the fight-only movement check in combat.js stands down.
const liveMovement = () => Date.now() - liveAt < 20000;

function init(emit) {
  emitRef = emit;
  clearInterval(moveTimer); clearInterval(pingTimer);
  moveTimer = setInterval(() => { try { sampleMovement(); } catch { /* next round */ } }, MOVE_EVERY_MS);
  pingTimer = setInterval(() => { samplePing().catch(() => {}); }, PING_EVERY_MS);
}

module.exports = { init, noteTeleport, pingStats, pingNote, liveMovement, _test: { sampleMovement, samplePing, state, pings } };
