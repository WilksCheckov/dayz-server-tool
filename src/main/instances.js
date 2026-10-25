'use strict';
// Server instances. The main window is the main instance; every other instance lives in its own folder
//   <root>\<name>\server      the DayZ server files, missions, keys and local mods
//   <root>\<name>\steamcmd    its own SteamCMD with its own Workshop mods
//   <root>\<name>\tool        its own settings, logs, death log, players, statistics …
//   <root>\<name>\backups     its backups
// and runs as its own background process of this app, so it keeps working on its own (restarts, RCon, backups,
// bot, website) whether or not the main window is open. The registry of instances belongs to the main instance.
const fs = require('fs');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const { spawn, execFile } = require('child_process');
const { app } = require('electron');
const instance = require('./instance');
const control = require('./control');
const settings = require('./settings');
const jsonstore = require('./jsonstore');

let emitRef = () => {};
const managerData = () => instance.isChild ? instance.managerData : app.getPath('userData');
const regFile = () => path.join(managerData(), 'instances.json');
function registry() { return { root: '', list: [], ...(jsonstore.readOr(regFile(), {}) || {}) }; }
function saveRegistry(r) { if (!jsonstore.write(regFile(), r, true)) throw new Error('Could not save the instance list (see the console).'); }
function readSettings(dataDir) { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')); } catch { return {}; } }
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

// Every instance, main one first: { name, main, dir (its install folder), data (its tool data folder) }
function entries() {
  const ms = readSettings(managerData());
  const main = { name: ms.instanceName || 'Main', main: true, dir: ms.installDir || 'C:\\DayZServer', data: managerData(), autoStart: false };
  return [main, ...registry().list.map(x => ({ ...x, main: false, data: path.join(x.dir, 'tool') }))];
}
const self = () => entries().find(e => instance.isChild ? path.resolve(e.data) === path.resolve(app.getPath('userData')) : e.main);
const byName = (name) => { const e = entries().find(x => x.name.toLowerCase() === String(name || '').toLowerCase()); if (!e) throw new Error(`No instance called ${name}.`); return e; };

// ---------- ports ----------
// Each instance gets a block: game port and port+1, RCon, Steam query and the website. Block i: 2302+100i, 2306+100i,
// 27016+100i, 8080+i (the main instance keeps whatever it has).
function queryPortOf(dir, s) {
  try { const m = fs.readFileSync(path.join(dir, 'server', s.configFile || 'serverDZ.cfg'), 'utf8').match(/^\s*steamQueryPort\s*=\s*(\d+)/mi); if (m) return Number(m[1]); } catch { /* no cfg */ }
  return Number(s.steamQueryPort) || 27016;
}
function portsOf(e) {
  const s = readSettings(e.data); const game = Number(s.port) || 2302;
  return { game, game2: game + 1, rcon: Number((s.rcon || {}).port) || 2306, query: queryPortOf(e.dir, s), web: Number((s.website || {}).port) || 8080, webOn: !!(s.website || {}).enabled };
}
const blockFor = (i) => ({ game: 2302 + 100 * i, game2: 2303 + 100 * i, rcon: 2306 + 100 * i, query: 27016 + 100 * i, web: 8080 + i });
const udpFree = (port) => new Promise(res => { const s = dgram.createSocket('udp4'); s.once('error', () => res(false)); s.bind(port, '0.0.0.0', () => s.close(() => res(true))); });
const tcpFree = (port) => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port, '0.0.0.0', () => s.close(() => res(true))); });
// Ports another instance has configured, with who owns them.
function takenPorts(exceptData) {
  const out = [];
  for (const e of entries()) { if (exceptData && path.resolve(e.data) === path.resolve(exceptData)) continue; const p = portsOf(e); for (const k of ['game', 'game2', 'rcon', 'query']) out.push({ port: p[k], proto: 'UDP', by: e.name, what: k }); out.push({ port: p.web, proto: 'TCP', by: e.name, what: 'web' }); }
  return out;
}
// Conflicts between this instance's ports and the other instances' (checked before every server start).
function conflicts(dataDir = app.getPath('userData')) {
  const me = entries().find(e => path.resolve(e.data) === path.resolve(dataDir)); if (!me) return [];
  const p = portsOf(me); const taken = takenPorts(me.data);
  const mine = [['game', 'UDP'], ['game2', 'UDP'], ['rcon', 'UDP'], ['query', 'UDP']].map(([k, proto]) => ({ k, port: p[k], proto }));
  if (p.webOn) mine.push({ k: 'web', port: p.web, proto: 'TCP' });
  return mine.flatMap(m => taken.filter(t => t.port === m.port && t.proto === m.proto && (t.what !== 'web' || m.k === 'web')).map(t => ({ port: m.port, proto: m.proto, mine: m.k, by: t.by })));
}
async function freeBlock(exceptData) {
  const taken = new Set(takenPorts(exceptData).map(t => t.proto + t.port));
  for (let i = 1; i < 300; i++) {
    const b = blockFor(i);
    if (['game', 'game2', 'rcon', 'query'].some(k => taken.has('UDP' + b[k])) || taken.has('TCP' + b.web)) continue;
    if (!(await udpFree(b.game)) || !(await udpFree(b.game2)) || !(await udpFree(b.rcon)) || !(await udpFree(b.query)) || !(await tcpFree(b.web))) continue;
    return b;
  }
  throw new Error('No free port block found.');
}
function writeQueryPort(cfgPath, port) {
  let t = ''; try { t = fs.readFileSync(cfgPath, 'utf8'); } catch { return; }
  t = /^\s*steamQueryPort\s*=/mi.test(t) ? t.replace(/^(\s*steamQueryPort\s*=\s*)\d+/mi, `$1${port}`) : t.replace(/\s*$/, '') + `\r\nsteamQueryPort = ${port};\r\n`;
  fs.writeFileSync(cfgPath, t);
}
function writePorts(e, b) {
  const s = jsonstore.read(path.join(e.data, 'settings.json')) || {};
  s.port = b.game; s.steamQueryPort = b.query;
  s.rcon = { ...(s.rcon || {}), port: b.rcon };
  s.website = { ...(s.website || {}), port: b.web };
  s.firewallVerified = '';
  fs.mkdirSync(e.data, { recursive: true });
  fs.writeFileSync(path.join(e.data, 'settings.json'), JSON.stringify(s, null, 2));
  writeQueryPort(path.join(e.dir, 'server', s.configFile || 'serverDZ.cfg'), b.query);
}
// Move a stopped background instance to the next free block (used by "Fix ports" and when creating it).
async function reassignPorts(name) {
  const e = byName(name); if (e.main) throw new Error('The main instance keeps its ports; change them on its Launch page.');
  if (control.info(e.data)) { const st = await status(e).catch(() => null); if (st && st.server && st.server.running) throw new Error('Stop that server first.'); }
  const b = await freeBlock(e.data);
  if (control.info(e.data)) await control.call(e.data, 'instances:applyPorts', b); else writePorts(e, b);
  return b;
}

// ---------- CPU plan (read by cpu.js) ----------
function cpuPlan() {
  const me = self();
  return entries().map(e => ({ name: e.name, self: !!me && e.data === me.data, mode: ((readSettings(e.data).cpu || {}).mode) || 'all' }));
}

// ---------- background processes ----------
function exe() { return { file: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, pre: app.isPackaged ? [] : [app.getAppPath()] }; }
function startTool(name) {
  const e = byName(name); if (e.main) throw new Error('The main instance runs in this window.');
  if (control.info(e.data)) return { already: true };
  if (!fs.existsSync(e.dir)) throw new Error(`Folder ${e.dir} is missing.`);
  const x = exe();
  const child = spawn(x.file, [...x.pre, `--dzat-instance=${e.dir}`, `--dzat-manager=${managerData()}`], { detached: true, stdio: 'ignore', windowsHide: true, env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e; })() });
  child.unref();
  emitRef('console', { source: 'instances', line: `Starting the tool for instance ${e.name}…` });
  waitFor(async () => !!control.info(e.data), 45000).then(up => {
    if (up) emitRef('console', { source: 'instances', line: `${e.name}'s tool is running.` });
    else { emitRef('console', { source: 'instances', line: `${e.name}'s tool did not start within 45 s. Open its folder's tool\\tool.log for the reason.` }); try { require('./alerts').alert('tool-problem', `Instance ${e.name} did not start`, 'Its restarts, backups, RCon and bot are not running.'); } catch { /* ignore */ } }
  });
  return { pid: child.pid };
}
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 500)); } return false; }
async function stopTool(name, { stopServer = false } = {}) {
  const e = byName(name); if (e.main) throw new Error('Use Quit for the main window.');
  const c = control.info(e.data); if (!c) return { already: true };
  if (stopServer) await control.call(e.data, 'server:stop').catch(() => {});
  await control.request(e.data, 'quit', {}).catch(() => {});
  await waitFor(async () => !control.alive(c.pid), 20000);
  return { stopped: !control.alive(c.pid) };
}
async function status(e) {
  if (e.main && !instance.isChild) return localStatus();
  if (!control.info(e.data)) return null;
  return control.request(e.data, 'status', undefined, 3000);
}
// What this process reports about itself (control route "status").
let localStatusFn = () => ({});
function setLocalStatus(fn) { localStatusFn = fn; }
function localStatus() { return localStatusFn(); }

async function list() {
  const es = entries();
  return Promise.all(es.map(async e => {
    const s = readSettings(e.data);
    let st = null; try { st = await status(e); } catch { st = null; }
    return { name: e.name, main: e.main, dir: e.dir, data: e.data, autoStart: !!e.autoStart, toolRunning: e.main ? true : !!control.info(e.data), status: st,
      ports: portsOf(e), conflicts: conflicts(e.data), cpu: { mode: 'all', ...(s.cpu || {}) }, bot: (s.discord || {}).mode || ((s.discord || {}).token ? 'own' : 'off'),
      exists: fs.existsSync(e.dir), serverInstalled: fs.existsSync(path.join(e.dir, 'server', 'DayZServer_x64.exe')), version: st && st.version };
  }));
}

async function action(name, what) {
  const e = byName(name);
  const local = (e.main && !instance.isChild) || (instance.isChild && self() && self().data === e.data);
  if (what === 'open') {
    if (local) { localOpen(); return true; }
    if (!e.main && !control.info(e.data)) { startTool(name); await waitFor(async () => !!control.info(e.data), 30000); }
    return control.request(e.data, 'window', { show: true });
  }
  const [ch, ...args] = { start: ['server:start'], stop: ['server:stop', { wait: false }], kill: ['server:stop', { force: true, wait: false }], restart: ['server:restart'], update: ['updater:runNow'], backup: ['backups:create'] }[what] || [];
  if (!ch) throw new Error('Unknown action.');
  if (local) return localCall(ch, ...args);
  if (!control.info(e.data)) { if (e.main) throw new Error('The main window is not running.'); startTool(name); await waitFor(async () => !!control.info(e.data), 30000); }
  return control.call(e.data, ch, ...args);
}
let localOpen = () => {}, localCall = () => {};
function setLocal({ open, call }) { localOpen = open; localCall = call; }

// ---------- create / remove ----------
function dirSize(d) { let n = 0; const walk = (x) => { let es = []; try { es = fs.readdirSync(x, { withFileTypes: true }); } catch { return; } for (const en of es) { const f = path.join(x, en.name); if (en.isSymbolicLink()) continue; if (en.isDirectory()) walk(f); else { try { n += fs.statSync(f).size; } catch { /* ignore */ } } } }; walk(d); return n; }
function robocopy(src, dst, extra = []) {
  return new Promise((res, rej) => {
    const p = spawn('robocopy', [src, dst, '/E', '/XJ', '/MT:8', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH', '/NJS', ...extra], { windowsHide: true });
    p.on('error', rej);
    p.on('exit', code => code < 8 ? res(code) : rej(new Error(`Copy failed (robocopy code ${code}).`))); // 0-7 = success with or without changes
  });
}
const progress = (name, step, detail = '') => emitRef('instances:progress', { name, step, detail, at: Date.now() });

function defaultRoot() { const main = entries()[0]; return registry().root || path.join(path.parse(main.dir).root, 'DayZServers'); }

// opts: { name, root, from (instance name to copy from), copyServer, copyMods, copyStorage (the world: bases, loot), copySettings, bot, cpu, autoStart }
async function create(opts) {
  const name = String(opts.name || '').trim();
  if (!NAME_RE.test(name)) throw new Error('Use 1-32 letters, numbers, spaces, - or _ for the name.');
  if (entries().some(e => e.name.toLowerCase() === name.toLowerCase())) throw new Error('An instance with that name exists.');
  const root = path.resolve(opts.root || defaultRoot());
  const dir = path.join(root, name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} already exists and is not empty.`);
  const src = opts.from ? byName(opts.from) : null;
  // disk space: the server files and mods are copied in full
  if (src && (opts.copyServer || opts.copyMods)) {
    progress(name, 'Checking free disk space');
    const need = (opts.copyServer ? dirSize(path.join(src.dir, 'server')) : 0) + (opts.copyMods ? dirSize(path.join(src.dir, 'steamcmd', 'steamapps', 'workshop')) : 0);
    fs.mkdirSync(root, { recursive: true });
    let free = Infinity; try { const st = fs.statfsSync(root); free = st.bavail * st.bsize; } catch { /* unknown */ }
    if (need * 1.1 > free) throw new Error(`Not enough disk space on ${path.parse(root).root}: needs about ${(need / 1073741824).toFixed(1)} GB, ${(free / 1073741824).toFixed(1)} GB free.`);
  }
  fs.mkdirSync(path.join(dir, 'tool'), { recursive: true });
  const e = { name, dir, data: path.join(dir, 'tool') };
  const warnings = [];
  try {
    if (src && opts.copyServer) {
      progress(name, 'Copying the server files', `from ${src.name}`);
      const xd = ['profiles', 'storage_*', 'crashes', ...(opts.copyMods ? [] : ['@*'])];
      if (opts.copyStorage) xd.splice(xd.indexOf('storage_*'), 1);
      await robocopy(path.join(src.dir, 'server'), path.join(dir, 'server'), ['/XD', ...xd, '/XF', 'BEServer_x64*.cfg', '*.RPT', '*.ADM', '*.mdmp', 'error_*.log', 'script_*.log', 'crash_*.log', 'server-process.json', 'start_server.bat', 'modlist.txt']);
      if (!opts.copyMods) { const kd = path.join(dir, 'server', 'keys'); try { for (const k of fs.readdirSync(kd)) if (!/^dayz\.bikey$/i.test(k)) fs.unlinkSync(path.join(kd, k)); } catch { /* no keys */ } }
    }
    if (src) {
      progress(name, 'Copying SteamCMD', 'so this instance can update itself');
      await robocopy(path.join(src.dir, 'steamcmd'), path.join(dir, 'steamcmd'), ['/XD', 'steamapps', 'logs', 'dumps', 'appcache', 'depotcache']).catch(e => warnings.push('SteamCMD was not copied (' + e.message + '); the instance downloads it again when it first updates.'));
      if (opts.copyMods) { progress(name, 'Copying the Workshop mods'); await robocopy(path.join(src.dir, 'steamcmd', 'steamapps', 'workshop'), path.join(dir, 'steamcmd', 'steamapps', 'workshop')).catch(e => warnings.push('The Workshop mods were not fully copied (' + e.message + '); use Update on its Installed mods page to download the missing ones.')); }
    }
    progress(name, 'Writing its settings');
    const base = src && opts.copySettings !== false ? readSettings(src.data) : {};
    // never carried over: things that belong to one instance (its paths, ports, process, verified states, encrypted secrets that only the source can read)
    for (const k of ['installDir', 'instanceName', 'port', 'steamQueryPort', 'rcon', 'firewallVerified', 'mapLink', 'steamPassEnc', 'lastUpdateCheck', 'relinkMods']) delete base[k];
    if (!opts.copyMods) { base.mods = []; base.modCache = {}; }
    base.installDir = dir;
    base.sharedMapsDir = path.join(entries()[0].dir, 'maps');
    base.cpu = { mode: opts.cpu || 'auto', cores: [], priority: 'normal' };
    const d = base.discord || {};
    base.discord = opts.bot === 'shared' ? { ...d, token: '', mode: 'shared', autoStart: true } : opts.bot === 'own' ? { ...d, token: '', mode: 'own', autoStart: false } : { ...d, token: '', mode: 'off', autoStart: false };
    if (base.website) base.website = { ...base.website, domain: undefined };
    base.relinkMods = !!opts.copyMods;
    if (base.backups) base.backups = { ...base.backups, dir: '' }; // its backups go in its own folder
    fs.writeFileSync(path.join(e.data, 'settings.json'), JSON.stringify(base, null, 2));
    progress(name, 'Assigning ports');
    const r = registry(); r.root = root; r.list.push({ name, dir, autoStart: opts.autoStart !== false, created: Date.now() }); saveRegistry(r);
    const b = await freeBlock(e.data); writePorts(e, b);
    for (const w of warnings) emitRef('console', { source: 'instances', line: `${name}: ${w}` });
    progress(name, warnings.length ? 'Done with warnings' : 'Done', warnings.length ? warnings.join(' ') : `game port ${b.game}, query ${b.query}, RCon ${b.rcon}, website ${b.web}`);
    emitRef('instances:changed', {});
    return { name, dir, ports: b, warnings };
  } catch (err) { progress(name, 'Failed', err.message); throw err; }
}

async function remove(name, { deleteFiles = false } = {}) {
  const e = byName(name); if (e.main) throw new Error('The main instance cannot be removed.');
  const st = await status(e).catch(() => null);
  if (!st && control.info(e.data)) throw new Error(`${e.name} did not answer, so it is not known whether its server runs. Open it and stop the server first.`);
  if (st && st.server && st.server.running) throw new Error('Stop its server first.');
  const stopped = await stopTool(name);
  if (stopped && stopped.stopped === false) throw new Error(`${e.name}'s tool did not close; try again.`);
  const r = registry(); r.list = r.list.filter(x => x.name !== e.name); saveRegistry(r);
  if (deleteFiles) { progress(name, 'Deleting its folder'); fs.rmSync(e.dir, { recursive: true, force: true }); }
  emitRef('instances:changed', {});
  return true;
}
function setAutoStart(name, on) { const r = registry(); const x = r.list.find(y => y.name === name); if (!x) throw new Error('Unknown instance.'); x.autoStart = !!on; saveRegistry(r); emitRef('instances:changed', {}); return true; }
function rename(newName) { if (!NAME_RE.test(newName)) throw new Error('Use 1-32 letters, numbers, spaces, - or _.'); settings.save({ instanceName: newName }); emitRef('instances:changed', {}); return true; }

// ---------- updates of the app: background tools are closed before installing and started again after ----------
async function beforeAppUpdate() {
  const r = registry(); const running = [];
  const stuck = [];
  for (const x of r.list) { const data = path.join(x.dir, 'tool'); if (control.info(data)) { running.push(x.name); const res = await stopTool(x.name).catch(() => ({ stopped: false })); if (res.stopped === false) stuck.push(x.name); } }
  r.relaunch = running; saveRegistry(r);
  if (stuck.length) throw new Error(`These instances' tools did not close: ${stuck.join(', ')}. Close them (tray or Task Manager) and install again.`);
}

// ---------- main-window side: start background tools, keep the list fresh, restart outdated ones ----------
let poll = null;
function init(emit) {
  emitRef = emit;
  if (instance.isChild) return;
  setTimeout(() => {
    const r = registry(); const again = new Set(r.relaunch || []);
    for (const x of r.list) if ((x.autoStart || again.has(x.name)) && fs.existsSync(x.dir)) { try { startTool(x.name); } catch (e) { emit('console', { source: 'instances', line: `${x.name}: ${e.message}` }); } }
    if (r.relaunch) { delete r.relaunch; saveRegistry(r); }
  }, 3000);
  poll = setInterval(async () => {
    for (const x of registry().list) {
      const c = control.info(path.join(x.dir, 'tool'));
      // a background tool left on an older version after an app update: restart it (its server keeps running)
      if (c && c.version && c.version !== app.getVersion()) { emit('console', { source: 'instances', line: `Restarting ${x.name}'s tool on version ${app.getVersion()} (its server keeps running).` }); await stopTool(x.name).catch(() => {}); try { startTool(x.name); } catch (e) { emit('console', { source: 'instances', line: `Could not restart ${x.name}'s tool: ${e.message}` }); } }
    }
  }, 60000);
}

module.exports = { writeQueryPort, init, entries, self, byName, registry, list, create, remove, action, startTool, stopTool, setAutoStart, rename, conflicts, reassignPorts, writePorts, freeBlock, cpuPlan, portsOf, beforeAppUpdate, setLocalStatus, setLocal, defaultRoot, managerData };
