'use strict';
// Death log: one record per player death built from the admin log (cause, killer, weapon, range, every hit that
// led up to it with damage per body part), the gear the player carried (from the bridge script's snapshots), and
// refunds (the bridge script spawns the gear at the player's feet). The bridge script is a small Enforce class the
// tool writes into the mission's init.c between markers; the game loads mission scripts unpacked, so no mod is needed.
const fs = require('fs');
const jsonstore = require('./jsonstore');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const settings = require('./settings');

let db = null, saveTimer = null, emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'deathlog.json');
function load() {
  if (db) return db;
  db = jsonstore.readOr(file(), null);
  db = { deaths: [], nextId: 1, pending: {}, gear: {}, gearFile: { offset: 0, rest: '' }, lastDeathAt: {}, ...(db || {}) };
  return db;
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { jsonstore.write(file(), load()); }, 500); }

const MAX_DEATHS = 5000, MAX_PENDING = 300, PENDING_MS = 20 * 60000, GEAR_PER_PLAYER = 30;

// ---------- classification ----------
function causeOf(a, body) {
  if (a && a.attackerName) return { cause: 'player', text: `killed by ${a.attackerName}` };
  const c = a && a.attackerClass ? a.attackerClass : '';
  if (/suicide/i.test(body)) return { cause: 'suicide', text: 'committed suicide' };
  if (/bled out/i.test(body)) return { cause: 'bleeding', text: 'bled out' };
  if (c) {
    if (/^zmb|zombie|infected/i.test(c)) return { cause: 'infected', text: `killed by infected (${c})` };
    if (/^animal_|wolf|bear/i.test(c)) return { cause: 'animal', text: `killed by animal (${c})` };
    if (/fall/i.test(c)) return { cause: 'fall', text: 'fall damage' };
    if (/explo|grenade|mine|claymore/i.test(c)) return { cause: 'explosion', text: `explosion (${c})` };
    if (/fire|barrel|fireplace|burn/i.test(c)) return { cause: 'fire', text: `fire (${c})` };
    if (/vehicle|car|truck|offroad|sedan|hatchback|boat|heli/i.test(c)) return { cause: 'vehicle', text: `vehicle (${c})` };
    if (/contaminat|gas|toxic/i.test(c)) return { cause: 'gas', text: `contaminated area (${c})` };
    return { cause: 'environment', text: `killed by ${c}` };
  }
  const st = body.match(/Stats>\s*Water:\s*([\d.]+)\s*Energy:\s*([\d.]+)\s*Bleed sources:\s*(\d+)/i);
  if (st) {
    if (Number(st[3]) > 0) return { cause: 'bleeding', text: `bled out (${st[3]} bleed sources)` };
    if (Number(st[1]) < 100) return { cause: 'dehydration', text: 'dehydration' };
    if (Number(st[2]) < 100) return { cause: 'starvation', text: 'starvation' };
  }
  return { cause: 'unknown', text: 'died' };
}

// Label a damage source: a player name stays as is; a class name becomes "infected", "animal", "fall" and so on.
function sourceKind(name, isPlayer) {
  if (isPlayer) return 'player';
  const c = String(name || '');
  if (/^zmb|zombie|infected/i.test(c)) return 'infected';
  if (/^animal_|wolf|bear|boar|cow|deer|goat|sheep|hen|pig/i.test(c)) return 'animal';
  if (/fall/i.test(c)) return 'fall';
  if (/explo|grenade|mine|claymore/i.test(c)) return 'explosion';
  if (/fire|barrel|fireplace|burn/i.test(c)) return 'fire';
  if (/vehicle|car|truck|offroad|sedan|hatchback|boat|heli/i.test(c)) return 'vehicle';
  if (/contaminat|gas|toxic/i.test(c)) return 'gas';
  if (/bleed/i.test(c)) return 'bleeding';
  return 'environment';
}
function sourceLabel(a) { return a.player ? a.name : `${a.name} (${a.kind || sourceKind(a.name, false)})`; }
// ---------- recording (fed by players.ingest with every parsed admin-log event) ----------
function pendingFor(key) { const d = load(); if (!d.pending[key]) d.pending[key] = []; return d.pending[key]; }
function record(ev) {
  if (!ev || !ev.body || !ev.name) return;
  if (ev.type !== 'hit' && ev.type !== 'kill' && ev.type !== 'death') return;
  const parseAttack = require('./combat').parseAttack;
  const key = ev.id || ev.name; const ts = ev.ts || Date.now();
  const a = parseAttack(ev.body);
  if (ev.type === 'hit') {
    if (!a) return;
    const list = pendingFor(key);
    list.push({ ts, by: a.attackerName || a.attackerClass || 'unknown', byId: a.attackerId || null, player: !!a.attackerName, weapon: a.weapon || null, ammo: a.ammo || null, part: a.part || null, damage: a.damage || 0, distance: a.distance, dead: !!ev.dead });
    while (list.length > MAX_PENDING || (list.length && ts - list[0].ts > PENDING_MS)) list.shift();
    save(); return;
  }
  const d = load();
  // the same death can produce a "killed by" line and a "died" line: merge them
  const last = d.lastDeathAt[key];
  let rec = last && Math.abs(ts - last.ts) <= 5000 ? d.deaths.find(x => x.id === last.id) : null;
  const { cause, text } = causeOf(a, ev.body);
  if (rec) {
    if (rec.cause === 'unknown' && cause !== 'unknown') { rec.cause = cause; rec.causeText = text; }
    if (!rec.source && a && (a.attackerName || a.attackerClass)) rec.source = a.attackerName ? { name: a.attackerName, kind: 'player' } : { name: a.attackerClass, kind: sourceKind(a.attackerClass, false) };
    if (!rec.killer && a && a.attackerName) { rec.killer = { name: a.attackerName, id: a.attackerId || null }; rec.weapon = a.weapon || rec.weapon; rec.distance = a.distance !== null && a.distance !== undefined ? a.distance : rec.distance; }
    save(); return;
  }
  const hits = (d.pending[key] || []).filter(h => ts - h.ts <= PENDING_MS && h.ts <= ts + 2000);
  d.pending[key] = [];
  const byPart = {}, attackers = {};
  let total = 0;
  for (const h of hits) {
    const part = h.part || 'unknown';
    byPart[part] = byPart[part] || { hits: 0, damage: 0 }; byPart[part].hits++; byPart[part].damage += h.damage; total += h.damage;
    attackers[h.by] = attackers[h.by] || { name: h.by, id: h.byId, player: h.player, kind: sourceKind(h.by, h.player), hits: 0, damage: 0 }; attackers[h.by].hits++; attackers[h.by].damage += h.damage;
  }
  const lastHit = hits.length ? hits[hits.length - 1] : null;
  rec = {
    id: d.nextId++, ts, name: ev.name, key, pos: ev.pos || null,
    cause, causeText: text,
    killer: a && a.attackerName ? { name: a.attackerName, id: a.attackerId || null } : null,
    weapon: (a && a.weapon) || (lastHit && lastHit.weapon) || null,
    ammo: (a && a.ammo) || (lastHit && lastHit.ammo) || null,
    distance: a && a.distance !== null && a.distance !== undefined ? a.distance : (lastHit && lastHit.distance !== null ? lastHit.distance : null),
    finalPart: lastHit ? lastHit.part : null, finalDamage: lastHit ? lastHit.damage : null,
    hits, byPart, totalDamage: Math.round(total * 10) / 10, attackers: Object.values(attackers).sort((x, y) => y.damage - x.damage),
    gear: null, gearTs: null, refunds: [],
    source: a && a.attackerName ? { name: a.attackerName, kind: 'player' } : a && a.attackerClass ? { name: a.attackerClass, kind: sourceKind(a.attackerClass, false) } : lastHit ? { name: lastHit.by, kind: sourceKind(lastHit.by, lastHit.player) } : null
  };
  // a plain "died" with a player hit moments before is for practical purposes a player kill
  if (rec.cause === 'unknown' && lastHit && ts - lastHit.ts <= 60000) {
    if (lastHit.player) { rec.cause = 'player'; rec.causeText = `killed by ${lastHit.by} (from the last hit)`; rec.killer = { name: lastHit.by, id: lastHit.byId }; }
    else { const c2 = causeOf({ attackerClass: lastHit.by }, ''); rec.cause = c2.cause; rec.causeText = c2.text + ' (from the last hit)'; }
  }
  attachGear(rec);
  d.deaths.push(rec); if (d.deaths.length > MAX_DEATHS) d.deaths.splice(0, d.deaths.length - MAX_DEATHS);
  d.lastDeathAt[key] = { ts, id: rec.id };
  save();
  emitRef('deathlog:changed', { id: rec.id });
  // the corpse snapshot arrives a few seconds after the admin-log line: post once it had a chance to attach
  const postId = rec.id; setTimeout(() => { try { const r = get(postId); if (r) require('./discord').postDeath(r); } catch { /* bot not loaded */ } }, 15000);
}

// ---------- gear snapshots from the bridge script ----------
function bridgeDir() { return path.join(settings.paths().profilesDir, 'DayZAdminTools'); }
function parseStamp(s) { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : Date.now(); }
function ingestGear() {
  const d = load(); const f = path.join(bridgeDir(), 'gear.log');
  let st; try { st = fs.statSync(f); } catch { return 0; }
  const meta = d.gearFile;
  if (st.size < meta.offset) { meta.offset = 0; meta.rest = ''; }
  if (st.size === meta.offset) return 0;
  const fd = fs.openSync(f, 'r'); let n = 0;
  try {
    const len = Math.min(st.size - meta.offset, 8 * 1024 * 1024); const buf = Buffer.alloc(len);
    n = fs.readSync(fd, buf, 0, len, meta.offset); meta.offset += n;
    const lines = (meta.rest + buf.toString('utf8', 0, n)).split(/\r?\n/); meta.rest = lines.pop() || '';
    let added = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!j || !j.id) continue;
      const snap = { ts: parseStamp(j.t), dead: !!j.dead, steam: j.steam || null, name: j.name || null, pos: Array.isArray(j.pos) ? j.pos.map(Number) : null, items: Array.isArray(j.items) ? j.items.map(it => ({ c: String(it.c || ''), p: it.p || '', q: Number(it.q), h: Number(it.h) })).filter(it => it.c) : [] };
      const list = d.gear[j.id] = d.gear[j.id] || []; list.push(snap); if (list.length > GEAR_PER_PLAYER) list.shift();
      if (j.steam) { d.gear['steam:' + j.steam] = j.id; }
      added++;
    }
    if (added) {
      // deaths from the last quarter hour may now have a matching snapshot
      const now = Date.now();
      for (const rec of d.deaths.slice(-50)) if (!rec.gear && now - rec.ts < 15 * 60000) attachGear(rec);
      save(); emitRef('deathlog:changed', {});
    }
    return added;
  } finally { fs.closeSync(fd); }
}
// Pick the snapshot that best represents what the player had when they died: the corpse snapshot shortly after,
// otherwise the last one taken before the death (within ten minutes).
function attachGear(rec) {
  const d = load(); const list = d.gear[rec.key] || (d.gear['steam:' + rec.key] && d.gear[d.gear['steam:' + rec.key]]) || [];
  let best = null;
  for (const s of list) {
    if (s.dead && s.ts >= rec.ts - 120000 && s.ts <= rec.ts + 180000) { best = s; break; }
    if (!s.dead && s.ts <= rec.ts + 5000 && rec.ts - s.ts <= 10 * 60000 && (!best || s.ts > best.ts)) best = s;
  }
  if (best) { rec.gear = best.items; rec.gearTs = best.ts; rec.gearFromCorpse = best.dead; }
  return !!best;
}

// ---------- refunds ----------
function online(key) {
  try { const p = require('./players').get(key); if (p && p.online) return true; } catch { /* ignore */ }
  return false;
}
function requireBridge() {
  if (!require('./server').status().running) throw new Error('The server is not running');
  if (!bridgeStatus().installed) throw new Error('The bridge script is not installed in the mission (Death log page → Install)');
}
// Queue one command for the bridge script and wait for its answer (it polls every three seconds).
async function sendCommand(cmd, { by = 'app', timeoutMs = 25000, onLate = null } = {}) {
  requireBridge();
  const nonce = crypto.randomBytes(6).toString('hex');
  const dir = bridgeDir(); fs.mkdirSync(dir, { recursive: true });
  const cmdFile = path.join(dir, 'commands.txt');
  const clean = v => String(v === undefined || v === null || v === '' ? '-' : v).replace(/[|\r\n]/g, ' ');
  const line = [nonce, cmd.type || 'refund', clean(cmd.id), clean(cmd.what), cmd.pos ? clean(cmd.pos[0]) : '-', cmd.pos ? clean(cmd.pos[1]) : '-', cmd.items && cmd.items.length ? cmd.items.map(clean).join(',') : '-'].join('|');
  fs.appendFileSync(cmdFile, line + '\r\n');
  const resFile = path.join(dir, 'results.log');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise(r => setTimeout(r, 700));
    let txt = ''; try { txt = fs.readFileSync(resFile, 'utf8'); } catch { /* not yet */ }
    const m = txt.match(new RegExp('^' + nonce + '\\|(\\w+)\\|(\\d+)\\|(\\d+)', 'm'));
    if (m) { const res = { status: m[1], ok: Number(m[2]), fail: Number(m[3]) }; try { require('./audit').log('app', by, 'bridge:' + (cmd.type || 'refund'), `${cmd.id}: ${res.status}${cmd.what ? ' (' + cmd.what + ')' : ''}`); } catch { /* ignore */ } return res; }
  }
  // No answer in time. If the game has not picked the command up, take it back out of the queue so it cannot run
  // later (an admin who clicks again would otherwise refund twice). If it was picked up, keep watching for the result.
  const label = `${cmd.type || 'refund'} for ${cmd.id}`;
  let queued = null; try { queued = fs.readFileSync(cmdFile, 'utf8'); } catch { /* the bridge took the file */ }
  if (queued !== null && queued.includes(nonce + '|')) {
    try { fs.writeFileSync(cmdFile, queued.split(/\r?\n/).filter(l => l && !l.startsWith(nonce + '|')).map(l => l + '\r\n').join('')); }
    catch (e) { emitRef('console', { source: 'deathlog', line: `Could not withdraw the ${label} from the queue (${e.message}); it may still run when the game reads it.` }); return { status: 'pending', ok: 0, fail: 0 }; }
    emitRef('console', { source: 'deathlog', line: `The game did not pick up the ${label} within ${Math.round(timeoutMs / 1000)} s; it was withdrawn and nothing was done.` });
    return { status: 'timeout', withdrawn: true, ok: 0, fail: 0 };
  }
  emitRef('console', { source: 'deathlog', line: `The game picked up the ${label} but has not answered yet; its result is recorded when it does.` });
  (async () => {
    const end = Date.now() + 180000;
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, 3000));
      let txt = ''; try { txt = fs.readFileSync(resFile, 'utf8'); } catch { /* not yet */ }
      const m = txt.match(new RegExp('^' + nonce + '\\|(\\w+)\\|(\\d+)\\|(\\d+)', 'm'));
      if (m) { const res = { status: m[1], ok: Number(m[2]), fail: Number(m[3]) }; emitRef('console', { source: 'deathlog', line: `The ${label} finished late: ${res.status}${res.status === 'done' ? ` (${res.ok} ok, ${res.fail} failed)` : ''}.` }); if (onLate) onLate(res); return; }
    }
    emitRef('console', { source: 'deathlog', line: `No result for the ${label} after 3 minutes; check in game whether it happened before trying again.` });
  })().catch(() => {});
  return { status: 'pending', ok: 0, fail: 0 };
}
function findPlayer(ref) {
  const players = require('./players');
  const direct = players.get(ref); if (direct) return direct;
  const rows = players.all({ query: ref, limit: 5 });
  return rows.find(r => r.name.toLowerCase() === String(ref).toLowerCase()) || rows[0] || null;
}
const HEAL_KINDS = { all: 'everything', health: 'health, blood and shock', bleeding: 'bleeding and cuts', bones: 'broken bones', cure: 'diseases and infections', food: 'food and water' };
async function heal(key, what = 'all', { by = 'app' } = {}) {
  if (!HEAL_KINDS[what]) throw new Error('Unknown heal kind: ' + what);
  return sendCommand({ type: 'heal', id: key, what }, { by });
}
async function teleport(key, pos, { by = 'app' } = {}) {
  if (!Array.isArray(pos) || pos.length < 2 || pos.some(v => !isFinite(v))) throw new Error('Give a position as x and z');
  return sendCommand({ type: 'tp', id: key, pos: [Number(pos[0]), Number(pos[1])] }, { by });
}
// Where did they die? The bridge's corpse snapshot has exact coordinates; the admin log gives the horizontal pair.
function deathPos(rec) {
  const d = load(); const list = d.gear[rec.key] || [];
  const corpse = list.find(s => s.dead && s.pos && Math.abs(s.ts - rec.ts) <= 180000);
  if (corpse) return [corpse.pos[0], corpse.pos[2]];
  if (rec.pos) return [rec.pos.x, rec.pos.y];
  return null;
}
async function teleportToDeath(deathId, { by = 'app' } = {}) {
  const rec = load().deaths.find(x => x.id === Number(deathId)); if (!rec) throw new Error('Death record not found');
  const pos = deathPos(rec); if (!pos) throw new Error('No position recorded for that death');
  const res = await teleport(rec.key, pos, { by }); res.pos = pos; return res;
}
async function refund(deathId, { by = 'app', items = null } = {}) {
  const d = load(); const rec = d.deaths.find(x => x.id === Number(deathId));
  if (!rec) throw new Error('Death record not found');
  const list = (items || (rec.gear || []).map(i => i.c)).filter(Boolean);
  if (!list.length) throw new Error('No gear recorded for this death');
  const keep = (r) => { rec.refunds.push({ ts: Date.now(), by, ...r, items: list.length }); save(); emitRef('deathlog:changed', { id: rec.id }); };
  const res = await sendCommand({ type: 'refund', id: rec.key, items: list }, { by, onLate: keep }); res.items = list.length;
  if (res.status !== 'timeout' && res.status !== 'pending') keep(res);
  return res;
}

// ---------- queries ----------
function summary(r) {
  return { id: r.id, hasPos: !!deathPos(r), ts: r.ts, name: r.name, key: r.key, cause: r.cause, causeText: r.causeText, killer: r.killer, weapon: r.weapon, ammo: r.ammo, distance: r.distance, finalPart: r.finalPart, totalDamage: r.totalDamage, hitCount: r.hits.length, source: r.source || null, sources: (r.attackers || []).map(x => ({ name: x.name, kind: x.kind || sourceKind(x.name, x.player), hits: x.hits, damage: Math.round(x.damage) })), gearCount: r.gear ? r.gear.length : null, refunds: r.refunds.filter(f => f.status === 'done' && f.ok > 0).length, refundAttempts: r.refunds.length, online: online(r.key) };
}
function list({ q = '', cause = '', since = 0, limit = 300 } = {}) {
  const needle = String(q || '').toLowerCase();
  const out = [];
  const d = load();
  for (let i = d.deaths.length - 1; i >= 0 && out.length < limit; i--) {
    const r = d.deaths[i];
    if (since && r.ts < since) break;
    if (cause && r.cause !== cause) continue;
    if (needle && !(r.name.toLowerCase().includes(needle) || (r.killer && r.killer.name.toLowerCase().includes(needle)) || (r.weapon || '').toLowerCase().includes(needle) || (r.key || '').toLowerCase().includes(needle) || r.causeText.toLowerCase().includes(needle))) continue;
    out.push(summary(r));
  }
  return out;
}
function get(id) { const r = load().deaths.find(x => x.id === Number(id)); return r ? { ...r, online: online(r.key), deathPos: deathPos(r) } : null; }
function forPlayer(key, limit = 20) { return load().deaths.filter(r => r.key === key || r.name === key).slice(-limit).reverse().map(summary); }
function stats() { const d = load(); const causes = {}; for (const r of d.deaths) causes[r.cause] = (causes[r.cause] || 0) + 1; return { deaths: d.deaths.length, causes, snapshots: Object.values(d.gear).filter(Array.isArray).reduce((n, l) => n + l.length, 0), players: Object.keys(d.gear).filter(k => !k.startsWith('steam:')).length }; }

// ---------- bridge script in the mission's init.c ----------
const BRIDGE_VERSION = 2;
const MARK_BEGIN = '// >>> DayZ Admin Tools bridge v' + BRIDGE_VERSION + ' (managed by the tool: do not edit between the markers)';
const MARK_END = '// <<< DayZ Admin Tools bridge';
const HOOK = 'DZAT_Bridge.Tick(timeslice); // DayZ Admin Tools hook';
const BRIDGE_SCRIPT = MARK_BEGIN + '\n' + fs.readFileSync(path.join(__dirname, 'bridge.c'), 'utf8').replace(/\r\n/g, '\n').replace(/\s*$/, '') + '\n' + MARK_END + '\n';
function initC() { const md = require('./configs').missionDir(); if (!md) throw new Error('No mission found: set the mission template in serverDZ.cfg first'); return path.join(md, 'init.c'); }
function bridgeStatus() {
  let f; try { f = initC(); } catch (e) { return { installed: false, file: null, error: e.message }; }
  let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch { return { installed: false, file: f, error: 'init.c not found' }; }
  const m = text.match(/\/\/ >>> DayZ Admin Tools bridge v(\d+)/);
  const hooked = text.includes('DZAT_Bridge.Tick(');
  const gearLog = path.join(bridgeDir(), 'gear.log'); let snapshots = 0; try { snapshots = fs.statSync(gearLog).size; } catch { /* none */ }
  return { installed: !!m && hooked, version: m ? Number(m[1]) : null, current: BRIDGE_VERSION, upToDate: !!m && Number(m[1]) === BRIDGE_VERSION && hooked, file: f, gearLogBytes: snapshots, hasCustomMission: /class\s+CustomMission\s*:\s*MissionServer/.test(text) };
}
function stripBridge(text) {
  text = text.replace(/[ \t]*\/\/ >>> DayZ Admin Tools bridge v\d+[^\n]*\n[\s\S]*?\/\/ <<< DayZ Admin Tools bridge[^\n]*\n?/g, '');
  text = text.replace(/\n[ \t]*\/\/ DZAT-HOOK-BEGIN[^\n]*\n[\s\S]*?\/\/ DZAT-HOOK-END[^\n]*/g, '');
  text = text.replace(/\n[^\n]*DZAT_Bridge\.Tick\([^\n]*/g, '');
  return text;
}
function installBridge() {
  const f = initC();
  if (!fs.existsSync(f)) throw new Error('init.c not found in the active mission');
  const orig = fs.readFileSync(f, 'utf8'); const crlf = orig.includes('\r\n');
  let text = stripBridge(orig.replace(/\r\n/g, '\n'));
  const cm = text.match(/class\s+CustomMission\s*:\s*MissionServer\s*\{/);
  if (!cm) throw new Error('init.c has no "class CustomMission: MissionServer" to hook into. Add one (the vanilla init.c has it) or add the DZAT_Bridge.Tick call to your mission class yourself.');
  // the bridge class goes right before the mission class
  text = text.slice(0, cm.index) + BRIDGE_SCRIPT + text.slice(cm.index);
  const cm2 = text.match(/class\s+CustomMission\s*:\s*MissionServer\s*\{/);
  const classStart = cm2.index + cm2[0].length;
  // existing OnUpdate override inside CustomMission? then add one line to it, else add the method
  const classEnd = findClassEnd(text, classStart);
  const body = text.slice(classStart, classEnd);
  const ou = body.match(/override\s+void\s+OnUpdate\s*\(\s*float\s+(\w+)\s*\)\s*\{/);
  if (ou) {
    const at = classStart + ou.index + ou[0].length;
    text = text.slice(0, at) + '\n\t\tDZAT_Bridge.Tick(' + ou[1] + '); // DayZ Admin Tools hook' + text.slice(at);
  } else {
    text = text.slice(0, classStart) + '\n\t// DZAT-HOOK-BEGIN (managed by DayZ Admin Tools)\n\toverride void OnUpdate(float timeslice)\n\t{\n\t\tsuper.OnUpdate(timeslice);\n\t\t' + HOOK + '\n\t}\n\t// DZAT-HOOK-END' + text.slice(classStart);
  }
  try { fs.copyFileSync(f, f + '.bak'); } catch { /* ignore */ }
  fs.writeFileSync(f, crlf ? text.replace(/\n/g, '\r\n') : text);
  emitRef('console', { source: 'deathlog', line: `Bridge script v${BRIDGE_VERSION} written into ${f}. It takes effect at the next server start.` });
  return bridgeStatus();
}
function findClassEnd(text, from) { let depth = 1; for (let i = from; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}') { depth--; if (!depth) return i; } } return text.length; }
function removeBridge() {
  const f = initC(); if (!fs.existsSync(f)) return bridgeStatus();
  const orig = fs.readFileSync(f, 'utf8'); const crlf = orig.includes('\r\n');
  const text = stripBridge(orig.replace(/\r\n/g, '\n'));
  fs.writeFileSync(f, crlf ? text.replace(/\n/g, '\r\n') : text);
  return bridgeStatus();
}
// Called before each server start: keep the script installed and current when the feature is on.
function ensureBridge() {
  const c = settings.load().deathlog || {};
  if (c.bridge === false) return { action: 'off' };
  try {
    try { const q = path.join(bridgeDir(), 'commands.txt'); const left = fs.readFileSync(q, 'utf8').split(/\r?\n/).filter(Boolean).length; fs.unlinkSync(q); if (left) emitRef('console', { source: 'deathlog', line: `Dropped ${left} refund / heal / teleport command(s) still queued from before; they would otherwise run now.` }); } catch { /* no queue */ }
    const st = bridgeStatus();
    if (st.error) { emitRef('console', { source: 'deathlog', line: 'Bridge script not checked: ' + st.error + '. Refunds, heals, teleports and gear snapshots will not work this run.' }); return { action: 'error', error: st.error }; }
    if (st.upToDate) return { action: 'ok' };
    installBridge(); return { action: st.installed ? 'updated' : 'installed' };
  } catch (e) { emitRef('console', { source: 'deathlog', line: 'Bridge script: ' + e.message }); return { action: 'error', error: e.message }; }
}
// Trim the bridge log files while the server is down so they do not grow forever.
function housekeeping() {
  try { ingestGear(); } catch { /* ignore */ }
  for (const name of ['gear.log', 'results.log']) {
    const f = path.join(bridgeDir(), name);
    try { if (fs.statSync(f).size > 4 * 1024 * 1024) { fs.unlinkSync(f); if (name === 'gear.log') { load().gearFile = { offset: 0, rest: '' }; save(); } } } catch { /* none */ }
  }
}

function init(emit) { emitRef = emit; load(); }
module.exports = { sendCommand, init, sourceKind, sourceLabel, record, ingestGear, list, get, forPlayer, stats, refund, heal, teleport, teleportToDeath, findPlayer, HEAL_KINDS, bridgeStatus, installBridge, removeBridge, ensureBridge, housekeeping, bridgeDir, online };
