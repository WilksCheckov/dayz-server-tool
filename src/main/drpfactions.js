'use strict';
// DRP Factions (the faction / territory / loot zone mod) run from the tool: installing it on the server, its settings
// and admins, and every admin action on factions, members, territory, wars and players.
//
// The mod owns factions.json, players.json, wars.json and reward_zones.json and rewrites them while it runs, so the tool
// only reads those. Actions go in as command files (profiles\DRP_Factions\admin_inbox_<ms>.json, one per action) that
// the mod applies within a few seconds while the server runs, or at its next start, and reports in admin_result.json.
// settings.json and admins.json are read by the mod only at start or on a reload, so the tool writes them and then
// sends a reload.
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('./settings');

// All DRP mods ship as one mod folder, @DRP_Core, with one PBO per sub-mod (DRP_Factions.pbo, DRP_DoorLocks.pbo, …).
const MOD = '@DRP_Core';
const PBO = 'DRP_Factions.pbo';
const dir = () => path.join(settings.paths().profilesDir, 'DRP_Factions');
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return def; } };
const css = (argb) => '#' + (((Number(argb) >>> 0) & 0xffffff).toString(16).padStart(6, '0'));
const INBOX = /^(admin|zones)_inbox_(\d+)\.json$/;
const RESULT = 'admin_result.json';

function adminName() { try { return require('./adminlog').cfg().adminName; } catch { return 'admin'; } }
function audit(action, what) { try { require('./audit').log('app', adminName(), 'factions:' + action, what); } catch { /* ignore */ } }
function serverRunning() { try { return !!require('./server').status().running; } catch { return false; } }

// ----- setup: the built mod folder (addons + keys) copied into the server and put on the mod list -----

// Where a freshly built mod usually is: the folder used last, else the DayZ Developer Tools workspace.
function sourceCandidates() {
  const s = settings.load(); const home = os.homedir();
  const c = [(s.drpFactions || {}).source,
    path.join(home, 'OneDrive', 'Desktop', 'DayZ Developer Tools', 'workspace', 'mods', MOD),
    path.join(home, 'Desktop', 'DayZ Developer Tools', 'workspace', 'mods', MOD)];
  return [...new Set(c.filter(Boolean))];
}
const pboIn = (folder) => path.join(folder, 'addons', PBO);
const pbosIn = (folder) => { try { return fs.readdirSync(path.join(folder, 'addons')).filter(f => /\.pbo$/i.test(f)); } catch { return []; } };
// Mods on the server list that hold one of the core's PBOs: the separate @DRP_Factions (etc.) of before the core.
// Loading those next to @DRP_Core would load the same addon twice.
function strayMods(s, p) {
  const core = new Set(pbosIn(path.join(p.serverDir, MOD)).map(f => f.toLowerCase()));
  if (!core.size) core.add(PBO.toLowerCase());
  return (s.mods || []).filter(m => m.id !== MOD && String(m.id).startsWith('@') && pbosIn(path.join(p.serverDir, m.id)).some(f => core.has(f.toLowerCase())));
}
function fileInfo(f) { try { const st = fs.statSync(f); return { size: st.size, mtime: st.mtimeMs }; } catch { return null; } }

function setupStatus() {
  const s = settings.load(); const p = settings.paths(s);
  const dest = path.join(p.serverDir, MOD);
  const installed = fileInfo(pboIn(dest));
  const source = sourceCandidates().find(f => fileInfo(pboIn(f))) || null;
  const built = source ? fileInfo(pboIn(source)) : null;
  const entry = (s.mods || []).find(m => m.id === MOD);
  const keys = (() => { try { return fs.readdirSync(path.join(dest, 'keys')).filter(k => /\.bikey$/i.test(k)); } catch { return []; } })();
  const keysInstalled = keys.length > 0 && keys.every(k => fs.existsSync(path.join(p.keysDir, k)));
  const d = dir(); const ran = fs.existsSync(path.join(d, 'settings.json'));
  let version = null, lastStart = null;
  try { const log = fs.readFileSync(path.join(d, 'factions.log'), 'utf8'); const m = [...log.matchAll(/^(\S+ \S+) Started v(\S+?):/gm)].pop(); if (m) { lastStart = m[1]; version = m[2]; } } catch { /* never ran */ }
  const admins = readJson(path.join(d, 'admins.json'), { admins: [] }).admins || [];
  const subs = pbosIn(dest).map(f => f.replace(/\.pbo$/i, ''));
  const stray = strayMods(s, p);
  const steps = [
    { key: 'files', ok: !!installed, label: 'DRP Core in the server folder', detail: installed ? `${MOD} with ${subs.join(', ')}; DRP_Factions built ${new Date(installed.mtime).toLocaleString()}` : `No ${MOD}\\addons\\${PBO} in ${p.serverDir}` },
    { key: 'current', ok: !!installed && (!built || built.mtime <= installed.mtime + 1000), label: 'Up to date with the latest build', detail: !built ? 'No build folder found: pick the @DRP_Factions folder to install from' : !installed ? 'Install the mod first' : installed && built.mtime > installed.mtime + 1000 ? `A newer build is in ${source} (${new Date(built.mtime).toLocaleString()})` : `Same as ${source}` },
    { key: 'key', ok: keysInstalled, label: 'Signing key in keys\\', detail: !installed ? 'Installed with the mod' : keys.length ? keys.join(', ') : 'The mod folder has no .bikey' },
    { key: 'single', ok: !stray.length, label: 'No separate copies of its sub-mods', detail: stray.length ? `${stray.map(m => m.id).join(', ')} also hold DRP PBOs: installing removes them from the mod list` : 'Each DRP PBO loads once, from @DRP_Core' },
    { key: 'modlist', ok: !!entry && entry.enabled !== false && !entry.serverSide, label: 'On the mod list for clients and server (-mod)', detail: !entry ? 'Not on the mod list' : entry.enabled === false ? 'On the list but switched off' : entry.serverSide ? 'Marked server-only: players need it too (it has the faction menu), so it belongs in -mod' : 'Loaded with -mod' },
    { key: 'admins', ok: admins.length > 0, label: 'At least one in-game faction admin', detail: admins.length ? `${admins.length} admin(s)` : 'Nobody gets the in-game Admin and Loot zones tabs yet (everything is also here in the tool)' },
    { key: 'ran', ok: ran, label: 'The server has run with the mod', detail: ran ? `Last start ${lastStart || '?'}${version ? ', mod v' + version : ''}` : 'Start the server once: the mod writes its settings, zones and data files on the first start' }
  ];
  return { installed: !!installed, subMods: subs, source, sourceCandidates: sourceCandidates(), serverRunning: serverRunning(), steps, ready: steps.every(st => st.ok), version, profilesDir: d };
}

// Copies the mod in (replacing the old files), installs its key, puts it on the mod list, creates admins.json.
async function install({ source, admins } = {}) {
  const src = source || setupStatus().source;
  if (!src || !fileInfo(pboIn(src))) throw new Error(`No ${PBO} in ${src ? path.join(src, 'addons') : 'any known build folder'}. Pick the ${MOD} folder that has addons\\${PBO}.`);
  if (serverRunning()) throw new Error('Stop the server first: it keeps the mod files open while it runs.');
  const s = settings.load(); const p = settings.paths(s);
  const dest = path.join(p.serverDir, MOD);
  if (path.resolve(src) !== path.resolve(dest)) {
    fs.mkdirSync(dest, { recursive: true });
    for (const sub of ['addons', 'keys']) { fs.rmSync(path.join(dest, sub), { recursive: true, force: true }); if (fs.existsSync(path.join(src, sub))) fs.cpSync(path.join(src, sub), path.join(dest, sub), { recursive: true }); }
    for (const f of fs.readdirSync(src)) { const full = path.join(src, f); if (fs.statSync(full).isFile()) fs.copyFileSync(full, path.join(dest, f)); }
  }
  const mods = require('./mods');
  for (const m of strayMods(settings.load(), p)) {
    mods.remove(m.id);
    const old = path.join(p.serverDir, m.id);
    // only a folder that is nothing but a built mod (addons, keys, mod.cpp) is deleted
    try { if (fs.readdirSync(old).every(n => ['addons', 'keys', 'mod.cpp', 'meta.cpp'].includes(n.toLowerCase()))) fs.rmSync(old, { recursive: true, force: true }); } catch { /* gone */ }
    audit('install', `Removed ${m.id}: its PBOs now come with ${MOD}`);
  }
  const entry = (settings.load().mods || []).find(m => m.id === MOD);
  if (!entry) await mods.importUnmanaged([{ id: MOD, kind: 'local', folderName: MOD, title: 'DRP Core' }]);
  else { if (entry.enabled === false || entry.serverSide) mods.setFlags(MOD, { enabled: true, serverSide: false }); mods.link(MOD); }
  settings.save({ drpFactions: { ...(settings.load().drpFactions || {}), source: src } });
  const d = dir(); fs.mkdirSync(d, { recursive: true });
  const ids = (admins || []).map(String).map(x => x.trim()).filter(x => /^7656\d{13}$/.test(x));
  if (ids.length || !fs.existsSync(path.join(d, 'admins.json'))) {
    const cur = readJson(path.join(d, 'admins.json'), { admins: [] }).admins || [];
    fs.writeFileSync(path.join(d, 'admins.json'), JSON.stringify({ admins: [...new Set([...cur, ...ids])] }, null, 4));
  }
  audit('install', `Installed ${MOD} from ${src}`);
  return setupStatus();
}

// ----- state: everything the mod keeps, for the Factions page -----

function state() {
  const d = dir();
  if (!fs.existsSync(path.join(d, 'factions.json')) && !fs.existsSync(path.join(d, 'settings.json'))) return { available: false, reason: 'DRP Factions has not run on this server yet (Setup tab).' };
  const cfg = readJson(path.join(d, 'settings.json'), {});
  const facs = readJson(path.join(d, 'factions.json'), { factions: [] }).factions || [];
  const players = readJson(path.join(d, 'players.json'), { players: [] }).players || [];
  const wars = readJson(path.join(d, 'wars.json'), { wars: [] }).wars || [];
  const zones = readJson(path.join(d, 'reward_zones.json'), { zones: [] }).zones || [];
  const admins = readJson(path.join(d, 'admins.json'), { admins: [] }).admins || [];
  const result = readJson(path.join(d, RESULT), { seq: 0, messages: [] });
  const cellSize = Number(cfg.cellSizeMeters) > 0 ? Number(cfg.cellSizeMeters) : 512;
  const nameOf = new Map(players.map(p => [p.id, p.name]));
  const factions = facs.map(f => ({
    id: f.id, name: f.name, tag: f.tag, description: f.description, color: f.color ? css(f.color) : '#9aa3ad', logo: f.logo || '', points: f.points, solo: !!f.solo,
    founderId: f.founderId, founderName: f.founderName, createdAt: f.createdAt,
    members: (f.members || []).map(m => ({ id: m.id, name: m.name, role: ((f.roles || []).find(r => r.id === m.roleId) || {}).name || '?', leader: m.id === f.founderId, joinedAt: m.joinedAt })),
    claims: (f.claims || []).map(c => ({ id: c.id, kind: c.kind === 0 ? 'home' : 'outpost', x: c.x, z: c.z, cellX: c.cellX, cellZ: c.cellZ, powered: !!c.powered, powerLeft: c.powerLeft, pending: (c.readyAt || 0) > 0, source: c.source })),
    captured: (f.captured || []).map(c => ({ cellX: c.cellX, cellZ: c.cellZ, at: c.at })),
    cache: f.hasCache ? { x: f.cacheX, z: f.cacheZ } : null,
    kits: (f.kits || []).map(k => ({ id: k.id, name: k.name, cost: k.cost, items: (k.items || []).length })),
    roles: (f.roles || []).map(r => ({ id: r.id, name: r.name, permissions: r.permissions })),
    zones: zones.filter(z => z.holderFactionId === f.id).map(z => z.name)
  }));
  return {
    available: true, cellSize, adminName: adminName(),
    factions,
    wars: wars.map(w => ({ id: w.id, state: ['declared', 'scheduled', 'active', 'ended'][w.state] || String(w.state), attacker: { id: w.attackerId, name: w.attackerName, tag: w.attackerTag }, defender: { id: w.defenderId, name: w.defenderName, tag: w.defenderTag }, cellX: w.cellX, cellZ: w.cellZ, declaredAt: w.declaredAt, scheduleDeadline: w.scheduleDeadline, startAt: w.startAt, endAt: w.endAt, endedAt: w.endedAt, attackerScore: w.attackerScore, defenderScore: w.defenderScore, attackerKills: w.attackerKills, defenderKills: w.defenderKills, winnerId: w.winnerId })).sort((a, b) => b.id - a.id),
    players: players.map(p => ({ id: p.id, name: p.name, factionId: p.factionId, lastSeen: p.lastSeen, cooldowns: (p.cooldowns || []).length, hasFlag: !!p.hasFlag })).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)),
    admins: admins.map(id => ({ id, name: nameOf.get(id) || '' })),
    settings: { ...DEFAULTS, ...cfg },
    sectorsAt: require('./drpzones').state().sectorsAt || 0,
    logos: require('./drpzones').logos(),
    logoDir: logoDir(),
    pending: inboxFiles().length,
    result: { seq: result.seq || 0, messages: result.messages || [] },
    // the mod counts time as local time written as if it were UTC
    clockOffset: -new Date().getTimezoneOffset() * 60
  };
}

// ----- commands -----

function inboxFiles() { let n = []; try { n = fs.readdirSync(dir()); } catch { return []; } return n.filter(x => INBOX.test(x)).sort(); }
function writeOp(op) {
  const d = dir();
  if (!fs.existsSync(d)) throw new Error('DRP Factions is not set up on this server (Setup tab).');
  let stamp = Date.now(); let name; do { name = `admin_inbox_${String(stamp).padStart(15, '0')}.json`; stamp++; } while (fs.existsSync(path.join(d, name)));
  const tmp = path.join(d, name + '.tmp'); fs.writeFileSync(tmp, JSON.stringify({ by: adminName(), ...op }, null, 1)); fs.renameSync(tmp, path.join(d, name));
  return name;
}
const COMMANDS = {
  set_points: ['factionId', 'points'], rename: ['factionId', 'name', 'tag'], set_color: ['factionId', 'color'], set_logo: ['factionId', 'name?'],
  transfer_owner: ['factionId', 'targetId'], kick_member: ['factionId', 'targetId'], remove_claim: ['factionId', 'claimId'],
  grant_cell: ['factionId', 'cellX', 'cellZ'], remove_cell: ['factionId', 'cellX', 'cellZ'], clear_cache: ['factionId'], delete_faction: ['factionId'],
  war_start: ['warId'], war_end: ['warId'], war_cancel: ['warId'], war_score: ['warId', 'attackerScore', 'defenderScore'],
  reset_cooldowns: ['targetId'], reload: []
};
// { op, ...args }: checked here so a typo never reaches the server
function command(cmd = {}) {
  const need = COMMANDS[cmd.op]; if (!need) throw new Error('Unknown command ' + cmd.op);
  const op = { op: cmd.op };
  for (const k0 of need) {
    const optional = k0.endsWith('?'); const k = optional ? k0.slice(0, -1) : k0;
    const v = optional && (cmd[k] === undefined || cmd[k] === null) ? '' : cmd[k];
    if (!optional && (v === undefined || v === null || v === '')) throw new Error(`${cmd.op} needs ${k}`);
    op[k] = ['name', 'tag', 'targetId'].includes(k) ? String(v).trim() : k === 'color' ? (parseInt(String(v).replace('#', ''), 16) | 0) : Math.round(Number(v));
    if (typeof op[k] === 'number' && !Number.isFinite(op[k])) throw new Error(`${cmd.op}: ${k} must be a number`);
  }
  const file = writeOp(op);
  audit(cmd.op, Object.entries(op).map(([k, v]) => `${k}=${v}`).join(' ') + (cmd.reason ? ` — reason: ${cmd.reason}` : ''));
  return { file, pending: inboxFiles().length };
}
function undo(file) {
  if (!INBOX.test(String(file))) throw new Error('Not a pending command.');
  try { fs.unlinkSync(path.join(dir(), file)); } catch { throw new Error('The server has already applied it.'); }
  return { pending: inboxFiles().length };
}

// ----- settings.json and admins.json (written here, then a reload) -----

// [key, label, min, max, group, hint]; booleans have min null
const SETTINGS = [
  ['maxFactions', 'Most factions on the server', 0, 1000, 'Factions', '0 = no limit'],
  ['maxMembers', 'Most members per faction', 1, 200, 'Factions'],
  ['nameMinLength', 'Name: shortest', 1, 40, 'Factions'], ['nameMaxLength', 'Name: longest', 1, 60, 'Factions'],
  ['tagMinLength', 'Tag: shortest', 1, 10, 'Factions'], ['tagMaxLength', 'Tag: longest', 1, 10, 'Factions'],
  ['maxFlagsFaction', 'Base units per faction (home + outposts)', 1, 50, 'Territory'],
  ['maxFlagsSolo', 'Base units for a one-person faction', 0, 50, 'Territory'],
  ['cellSizeMeters', 'Grid cell size (m)', 64, 4096, 'Territory', 'Needs a server restart; existing claims move to the cell they are in'],
  ['outpostClaimHours', 'Hours to secure an outpost', 0, 240, 'Territory', 'The home is instant'],
  ['claimDecayHours', 'Hours an unpowered claim survives', 1, 720, 'Territory'],
  ['tableDrainPerSecond', 'Radio drain per second (battery energy)', 0, 100, 'Territory', 'Car battery 500, truck 1500'],
  ['tableChargePerSecond', 'Charge per second per battery', 0, 100, 'Territory'],
  ['spawnCooldownSeconds', 'Spawn cooldown per spawn point (s)', 0, 31536000, 'Spawning', '604800 = 7 days'],
  ['spawnScatter', 'Spawn scatter around the point (m)', 0, 200, 'Spawning'],
  ['warScheduleWindowHours', 'Hours the defender has to pick the start', 1, 720, 'Wars', 'Starts by itself after that'],
  ['warDurationHours', 'War length (hours)', 1, 720, 'Wars'],
  ['warSpawnCooldownMinutes', 'Spawn cooldown while at war (min)', 0, 1440, 'Wars'],
  ['warKillPoints', 'Points per counted kill', 1, 1000, 'Wars'],
  ['warMinVictimAliveMinutes', 'Victim alive at least (min) to count', 0, 600, 'Wars'],
  ['warSameVictimMinutes', 'Same victim counts once per (min)', 0, 1440, 'Wars'],
  ['warCellCooldownHours', 'Hours before a cell can be contested again', 0, 720, 'Wars'],
  ['maxKitsPerFaction', 'Kits per faction', 0, 100, 'Kits'], ['maxKitItems', 'Items per kit', 1, 60, 'Kits'],
  ['deleteDepositedClothing', 'Deposit crate turns clothing into points', null, null, 'Kits'],
  ['minDepositHealthPercent', 'Deposit: lowest clothing health (%)', 0, 100, 'Kits']
];
// the mod's own defaults (DRPF_Settings.Defaults); it also falls back to them when a key is missing, as in files
// written by older versions of the mod, so they are what the server really uses
const DEFAULTS = { maxFactions: 0, maxMembers: 20, maxFlagsSolo: 1, maxFlagsFaction: 2, spawnCooldownSeconds: 604800, spawnScatter: 12, maxKitsPerFaction: 10, maxKitItems: 8, deleteDepositedClothing: 1, minDepositHealthPercent: 30, nameMinLength: 3, nameMaxLength: 24, tagMinLength: 2, tagMaxLength: 5, tableDrainPerSecond: 0.02, claimDecayHours: 24, tableChargePerSecond: 1, cellSizeMeters: 512, outpostClaimHours: 12, warScheduleWindowHours: 48, warDurationHours: 72, warSpawnCooldownMinutes: 30, warKillPoints: 10, warMinVictimAliveMinutes: 15, warSameVictimMinutes: 30, warCellCooldownHours: 24 };
const FLOATS = new Set(['tableDrainPerSecond', 'tableChargePerSecond', 'spawnScatter']);
const LISTS = [['kitAllowedSlots', 'Slots a kit may fill'], ['kitBannedClasses', 'Classes never allowed in a kit (prefix)'], ['depositSlots', 'Slots the deposit crate accepts']];

function saveSettings(changes = {}) {
  const f = path.join(dir(), 'settings.json'); const cur = readJson(f, null);
  if (!cur) throw new Error('settings.json does not exist yet: start the server once with the mod.');
  const next = { ...DEFAULTS, ...cur };
  for (const [key, label, min, max] of SETTINGS) {
    if (!(key in changes)) continue;
    if (min === null) { next[key] = changes[key] ? 1 : 0; continue; }
    if (String(changes[key]).trim() === '') continue;
    const v = Number(changes[key]); if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${label}: ${min} to ${max}`);
    next[key] = FLOATS.has(key) ? v : Math.round(v);
  }
  for (const [key] of LISTS) if (Array.isArray(changes[key])) next[key] = changes[key].map(x => String(x).trim()).filter(Boolean);
  if (Array.isArray(changes.pointValues)) next.pointValues = changes.pointValues.map(pv => ({ match: String(pv.match || '').trim(), points: Math.max(0, Math.round(Number(pv.points) || 0)) })).filter(pv => pv.match);
  if (next.nameMinLength > next.nameMaxLength || next.tagMinLength > next.tagMaxLength) throw new Error('A shortest length is longer than its longest.');
  fs.copyFileSync(f, f + '.bak');
  fs.writeFileSync(f, JSON.stringify(next, null, 4));
  const changed = Object.keys(next).filter(k => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
  audit('settings', changed.length ? 'Changed ' + changed.join(', ') : 'Saved settings (no change)');
  command({ op: 'reload' });
  return { changed, restartNeeded: changed.includes('cellSizeMeters') };
}

function saveAdmins(ids = []) {
  const list = [...new Set(ids.map(String).map(x => x.trim()).filter(Boolean))];
  const bad = list.filter(x => !/^7656\d{13}$/.test(x)); if (bad.length) throw new Error('Not a Steam64 id: ' + bad.join(', '));
  const d = dir(); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'admins.json'), JSON.stringify({ admins: list }, null, 4));
  audit('admins', `In-game faction admins: ${list.join(', ') || 'none'}`);
  if (fs.existsSync(path.join(d, 'settings.json'))) command({ op: 'reload' });
  return list;
}

// ----- loot tiers and zone classes: both painted on sectors, saved in loot_tiers.json (read by the mod at start and
// on a reload). A sector's zone class (civilian, civil, police, military) picks which types.xml usages its loot comes
// from, its tier which TierN values. Every cycle the faction holding a painted sector gets the tier's `rolls`, each
// landing with `chance` percent and picking an item by weight from the pool for that class and tier, then an amount
// from min to max, delivered to its supply cache. Unpainted classes follow the sector: bases and airfields military,
// everything else civilian.

const TIER_DEFAULTS = [{ tier: 1, rolls: 2, chance: 60 }, { tier: 2, rolls: 3, chance: 60 }, { tier: 3, rolls: 3, chance: 70 }, { tier: 4, rolls: 4, chance: 75 }];
const CLASS_DEFAULTS = [
  { id: 'civilian', name: 'Civilian', usages: ['Town', 'Village', 'Farm', 'Coast', 'Hunting', 'Lunapark'] },
  { id: 'civil', name: 'Civil', usages: ['Office', 'School', 'Medic', 'Firefighter', 'Industrial'] },
  { id: 'police', name: 'Police', usages: ['Police', 'Prison'] },
  { id: 'military', name: 'Military', usages: ['Military'] }
];
const cleanItems = (items) => (items || []).map(i => { const min = Math.max(1, Math.round(Number(i.min) || 1)); return { className: String(i.className || '').trim(), weight: Math.max(1, Math.round(Number(i.weight) || 1)), min, max: Math.max(min, Math.round(Number(i.max) || min)) }; }).filter(i => i.className);
function lootTiers() {
  const d = readJson(path.join(dir(), 'loot_tiers.json'), null) || {};
  const tiers = TIER_DEFAULTS.map(def => { const t = (d.tiers || []).find(x => x.tier === def.tier) || {}; return { ...def, ...t, items: t.items || [] }; });
  const classes = (d.classes && d.classes.length ? d.classes : CLASS_DEFAULTS).map(c => ({ id: String(c.id), name: c.name || c.id, usages: c.usages || [] }));
  const ids = new Set(classes.map(c => c.id));
  const sectors = (d.sectors || []).map(x => ({ id: x.id, tier: x.tier || 0, cls: ids.has(x.cls) ? x.cls : '' })).filter(x => x.id > 0 && ((x.tier >= 1 && x.tier <= 4) || x.cls));
  const pools = (d.pools || []).filter(pl => ids.has(pl.cls) && pl.tier >= 1 && pl.tier <= 4).map(pl => ({ cls: pl.cls, tier: pl.tier, items: pl.items || [] }));
  return { version: 2, enabled: d.enabled === undefined ? 1 : d.enabled, intervalMinutes: d.intervalMinutes || 60, tiers, classes, sectors, pools };
}
// changes: { sectors?, tiers?, classes?, pools?, intervalMinutes?, enabled? }. sectors replace the painted list:
// [{ id, tier (0 = none), cls ('' = follow the sector) }]
function saveLootTiers(changes = {}) {
  if (!fs.existsSync(dir())) throw new Error('DRP Factions is not set up on this server (Setup tab).');
  const cur = lootTiers();
  if (Array.isArray(changes.classes)) {
    const seen = new Set();
    cur.classes = changes.classes.map(c => ({ id: String(c.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, ''), name: String(c.name || c.id || '').trim(), usages: (c.usages || []).map(u => String(u).trim()).filter(Boolean) })).filter(c => c.id && !seen.has(c.id) && seen.add(c.id));
    if (!cur.classes.length) throw new Error('Keep at least one zone class.');
  }
  const ids = new Set(cur.classes.map(c => c.id));
  if (Array.isArray(changes.sectors)) cur.sectors = changes.sectors.map(x => ({ id: Math.round(Number(x.id)), tier: Math.round(Number(x.tier) || 0), cls: ids.has(x.cls) ? x.cls : '' })).filter(x => x.id > 0 && x.tier >= 0 && x.tier <= 4 && (x.tier > 0 || x.cls));
  else cur.sectors = cur.sectors.map(x => ({ ...x, cls: ids.has(x.cls) ? x.cls : '' }));
  if (changes.intervalMinutes !== undefined) { const v = Math.round(Number(changes.intervalMinutes)); if (!(v >= 1 && v <= 10080)) throw new Error('The cycle must be 1 to 10080 minutes.'); cur.intervalMinutes = v; }
  if (changes.enabled !== undefined) cur.enabled = changes.enabled ? 1 : 0;
  if (Array.isArray(changes.tiers)) for (const t of changes.tiers) {
    const into = cur.tiers.find(x => x.tier === Number(t.tier)); if (!into) continue;
    if (t.rolls !== undefined) into.rolls = Math.max(0, Math.min(50, Math.round(Number(t.rolls) || 0)));
    if (t.chance !== undefined) into.chance = Math.max(0, Math.min(100, Number(t.chance) || 0));
    if (Array.isArray(t.items)) into.items = cleanItems(t.items);
  }
  if (Array.isArray(changes.pools)) for (const pl of changes.pools) {
    if (!ids.has(pl.cls) || !(pl.tier >= 1 && pl.tier <= 4)) continue;
    const at = cur.pools.findIndex(x => x.cls === pl.cls && x.tier === pl.tier);
    const next = { cls: pl.cls, tier: pl.tier, items: cleanItems(pl.items) };
    if (at >= 0) cur.pools[at] = next; else cur.pools.push(next);
  }
  cur.pools = cur.pools.filter(pl => ids.has(pl.cls));
  fs.writeFileSync(path.join(dir(), 'loot_tiers.json'), JSON.stringify(cur, null, 1));
  audit('tiers', `Loot saved: ${cur.sectors.length} painted sector(s), ${cur.classes.length} zone classes, ${cur.pools.length} pools, every ${cur.intervalMinutes} min`);
  if (fs.existsSync(path.join(dir(), 'settings.json'))) command({ op: 'reload' });
  return cur;
}
const lc = (v) => String(v).toLowerCase();
// Pool for a zone class and tier from types.xml: an item fits when one of its usages is the class's, and its value
// list has TierN (an item with no tier value fits every tier, as in the game). Weighted by nominal.
function poolFor(cls, tier, items) {
  const uses = new Set((cls.usages || []).map(lc)); const want = 'tier' + Number(tier);
  return items.filter(i => (i.nominal || 0) > 0 && (i.usage || []).some(u => uses.has(lc(u))) && (!(i.value || []).length || (i.value || []).some(v => lc(v) === want)))
    .map(i => ({ className: i.name, weight: i.nominal, min: 1, max: 1 })).sort((a, b) => b.weight - a.weight);
}
// Every class x tier pool built again from types.xml (replacing hand edits), then saved.
function buildPools() {
  const cur = lootTiers(); const items = require('./lootmap').items();
  const pools = []; for (const c of cur.classes) for (let t = 1; t <= 4; t++) pools.push({ cls: c.id, tier: t, items: poolFor(c, t, items) });
  return saveLootTiers({ pools });
}
// one tier's pool by category, the earlier way (still used as a fallback pool per tier)
function fillTier({ tier, categories } = {}) {
  const want = 'tier' + Number(tier); const cats = (categories || []).map(lc).filter(Boolean);
  return require('./lootmap').items().filter(i => (i.nominal || 0) > 0 && (i.value || []).some(v => lc(v) === want) && (!cats.length || cats.includes(lc((i.category || [])[0] || ''))))
    .map(i => ({ className: i.name, weight: i.nominal, min: 1, max: 1 })).sort((a, b) => b.weight - a.weight);
}
function economyCategories() { return [...new Set(require('./lootmap').items().map(i => (i.category || [])[0]).filter(Boolean))].sort(); }
function economyUsages() { return [...new Set(require('./lootmap').items().flatMap(i => i.usage || []))].sort(); }

// ----- logos: images go into the mod's logos folder on the PC that builds it; the build turns them into .paa -----

// The DRP_Factions source folder's gui\logos: the one set in settings, else P:\DRP_Factions\gui\logos when it exists.
function logoDir() {
  const set = (settings.load().drpFactions || {}).logoDir;
  if (set) return set;
  const guess = 'P:\\DRP_Factions\\gui\\logos';
  return fs.existsSync(guess) ? guess : '';
}
function addLogo({ file, name } = {}) {
  if (!file || !fs.existsSync(file)) throw new Error('Pick an image file.');
  if (!/\.(png|jpe?g)$/i.test(file)) throw new Error('Logos can be PNG or JPG images.');
  const dest = logoDir();
  if (!dest) throw new Error('No logo folder: set the DRP_Factions mod source folder (gui\\logos) first. Logos are packed into the mod, so they are added on the PC that builds it.');
  const clean = String(name || path.basename(file).replace(/\.\w+$/, '')).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'logo';
  for (const ext of ['.png', '.jpg', '.jpeg']) { const old = path.join(dest, clean + ext); if (fs.existsSync(old) && path.resolve(old) !== path.resolve(file)) fs.rmSync(old); }
  const target = path.join(dest, clean + path.extname(file).toLowerCase());
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(file, target);
  audit('logo', `Added logo ${clean} (${path.basename(file)}) to ${dest}`);
  return { name: clean, file: target };
}
function setLogoDir(folder) {
  if (folder && !fs.existsSync(folder)) throw new Error('That folder does not exist.');
  settings.save({ drpFactions: { ...(settings.load().drpFactions || {}), logoDir: folder || '' } });
  return logoDir();
}

module.exports = { lootTiers, saveLootTiers, fillTier, buildPools, poolFor, economyCategories, economyUsages, CLASS_DEFAULTS, addLogo, setLogoDir, logoDir, setupStatus, install, state, command, undo, saveSettings, saveAdmins, SETTINGS, LISTS, MOD };
