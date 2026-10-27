'use strict';
// Starts, stops and watches the DayZServer_x64.exe process.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const settings = require('./settings');
const mods = require('./mods');
const alerts = require('./alerts');
const crashes = require('./crashes');
let crashLoop = false;
// The running server is remembered on disk, so a tool restart (an app update, a crash of the tool) picks it up again
// instead of losing track of it and starting a second copy on the same port.
let adopted = false;
const procFile = () => path.join(require('electron').app.getPath('userData'), 'server-process.json');
function rememberProc(pid, at) { try { fs.writeFileSync(procFile(), JSON.stringify({ pid, startedAt: at, exe: settings.paths().serverExe })); } catch { /* ignore */ } }
function forgetProc() { try { fs.unlinkSync(procFile()); } catch { /* none */ } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// A process this tool did not start gives no exit event: watch it.
function watchPid(pid) {
  const ee = new (require('events'))(); ee.pid = pid; ee.adopted = true;
  ee.kill = () => { try { process.kill(pid); } catch { /* gone */ } };
  const t = setInterval(() => { if (!alive(pid)) { clearInterval(t); ee.emit('exit', null, null); } }, 2000);
  return ee;
}
// This instance's server by its exe path among the running DayZ servers (no admin rights needed for own processes).
function findOwnServer() {
  return new Promise(res => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='DayZServer_x64.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)|$(if ($_.CreationDate) { $_.CreationDate.ToString('o') })\" }"],
  { windowsHide: true, timeout: 30000 }, (e, out) => {
    const mine = path.resolve(settings.paths().serverExe).toLowerCase();
    for (const l of String(out || '').split(/\r?\n/)) { const [pid, exe, created] = l.trim().split('|'); if (pid && exe && path.resolve(exe).toLowerCase() === mine) return res({ pid: Number(pid), startedAt: Date.parse(created) || Date.now(), found: true }); }
    res(null);
  }));
}
async function adopt() {
  if (proc) return false;
  let rec = null; try { rec = JSON.parse(fs.readFileSync(procFile(), 'utf8')); } catch { rec = null; }
  if (!rec || !rec.pid || !alive(rec.pid)) { if (rec) forgetProc(); rec = await findOwnServer(); if (!rec || proc) return false; rememberProc(rec.pid, rec.startedAt); }
  // the pid may have been reused by another program: check it is this server's exe (by its path; when Windows is
  // too busy to answer that, by its image name, so a slow start of the tool does not lose the server)
  const run = (file, args) => new Promise(res => require('child_process').execFile(file, args, { windowsHide: true, timeout: 30000 }, (e, out) => res(String(out || '').trim())));
  const exe = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(rec.pid)} -ErrorAction SilentlyContinue).Path`]);
  const mine = path.resolve(settings.paths().serverExe).toLowerCase();
  if (exe && path.resolve(exe).toLowerCase() !== mine) { emitRef('console', { source: 'server', line: `The remembered server pid ${rec.pid} now belongs to ${exe}; not taking it over.` }); forgetProc(); return false; }
  if (!exe) { const img = await run('tasklist', ['/FI', `PID eq ${Number(rec.pid)}`, '/FO', 'CSV', '/NH']); if (!/"DayZServer_x64\.exe"/i.test(img)) { if (img && !/No tasks/i.test(img)) forgetProc(); return false; } }
  if (proc) return false;
  adopted = true;
  proc = watchPid(rec.pid);
  startedAt = rec.startedAt || Date.now();
  startedModParam = currentModParam();
  emitRef('console', { source: 'server', line: `Found the server ${rec.found ? 'running' : 'still running'} (pid ${rec.pid}, started ${new Date(startedAt).toLocaleString()}); managing it${rec.found ? '' : ' again'}.` });
  startRptTail(); rptStartedAt = startedAt;
  stage = null; setStage(0);
  attachExit(proc);
  try { require('./cpu').apply(rec.pid); } catch { /* ignore */ }
  emitRef('server:status', status());
  return true;
}

let proc = null;
let startedAt = null;
let manualStop = false;
let maintenance = null; // { kind: 'restart' | 'update', since }
// Set by the restart scheduler and the updater around their stop/start, so RCon and the status bar know the
// server is down on purpose. Cleared once the server has been started again.
function setMaintenance(kind) { maintenance = kind ? { kind, since: Date.now() } : null; emitRef('server:maintenance', maintenance); }
let restartTimer = null;
let emitRef = () => {};
let lastExit = null;
// Loading stages, read from the RPT as it is written. BattlEye answers RCon only after "Init sequence finished".
const STAGES = [
  { key: 'starting', label: 'starting the process' },
  { key: 'data', label: 'loading game data', re: /./ },
  { key: 'steam', label: 'Steam ready, loading the world', re: /SteamGameServer_Init/ },
  { key: 'economy', label: 'economy starting', re: /\[CE\]\[Hive\] :: (Initializing OFFLINE|Loading core data)/ },
  { key: 'map', label: 'economy loading map data', re: /\[CE\]\[Hive\] :: Loading map data/ },
  { key: 'storage', label: 'persistence loaded, spawning loot', re: /\[CE\]\[Hive\] :: (Storage load took|Initializing spawners)/ },
  { key: 'ready', label: 'ready', re: /\[CE\]\[Hive\] :: Init sequence finished/ }
];
let stage = null;
// Share of a whole start at which each step begins. Defaults from measured starts; replaced by this machine's own
// timings after its first complete start, so the loading bar fills evenly and can estimate the time left.
const DEFAULT_PROFILE = { fractions: [0, 0.03, 0.4, 0.6, 0.62, 0.97, 1], totalMs: 0 };
let stageTimes = [];
function loadProfile() { const p = settings.load().loadProfile; return p && Array.isArray(p.fractions) && p.fractions.length === STAGES.length && p.totalMs > 0 ? p : DEFAULT_PROFILE; }
function setStage(i) {
  if (stage && i <= stage.index) return;
  const st = STAGES[i];
  if (i === 0) stageTimes = [];
  for (let k = 0; k <= i; k++) if (stageTimes[k] === undefined) stageTimes[k] = Date.now() - (startedAt || Date.now());
  stage = { key: st.key, label: st.label, index: i, total: STAGES.length - 1, at: Date.now(), ready: st.key === 'ready', profile: loadProfile() };
  if (stage.ready && !adopted && stageTimes.length === STAGES.length && stageTimes[i] > 5000) {
    const total = stageTimes[i]; settings.save({ loadProfile: { fractions: stageTimes.map(t => Math.min(1, t / total)), totalMs: total, at: Date.now() } });
  }
  emitRef('server:stage', { ...stage, startedAt });
  if (stage.ready) emitRef('console', { source: 'server', line: `Server finished loading in ${Math.round((Date.now() - startedAt) / 1000)} s.` });
}
function stageFromLines(lines) {
  if (!stage || stage.ready) return;
  for (const l of lines) { for (let i = STAGES.length - 1; i > stage.index; i--) { const re = STAGES[i].re; if (re && re.test(l)) { setStage(i); break; } } if (stage.ready) return; }
}
let startedModParam = null;

function currentModParam(s = settings.load()) {
  return mods.modParam(s, false) + '|' + mods.modParam(s, true);
}

function status() {
  return {
    running: !!proc,
    pid: proc ? proc.pid : null,
    startedAt,
    lastExit,
    restartPending: !!restartTimer,
    crashLoop,
    modsChanged: !!proc && startedModParam !== currentModParam(),
    stage: proc ? stage : null,
    maintenance,
    stopping: !!proc && manualStop,
    adopted: !!proc && adopted
  };
}

function buildArgs(s) {
  const args = [
    `-config=${s.configFile}`,
    `-port=${s.port}`,
    `-profiles=${s.profilesDir}`
  ];
  try { const be = require('./rcon').beArg(s); if (be) args.push(be); } catch { /* ignore */ }
  { let n = Number(s.cpuCount) || 0; try { n = require('./cpu').cpuCountArg(s); } catch { /* ignore */ } if (n > 0) args.push(`-cpuCount=${n}`); }
  for (const part of (s.extraParams || '').split(/\s+/)) if (part) args.push(part);
  const modList = mods.modParam(s, false);
  const serverModList = mods.modParam(s, true);
  if (modList) args.push(`-mod=${modList}`);
  if (serverModList) args.push(`-serverMod=${serverModList}`);
  return args;
}

// ---------- live RPT tail: the server's real console output, streamed line by line ----------
let rptTimer = null, rptFile = null, rptOffset = 0, rptRest = '', rptStartedAt = 0, rptGen = 0;
function newestRpt() {
  const p = settings.paths();
  try { return fs.readdirSync(p.profilesDir).filter(f => /\.rpt$/i.test(f)).map(f => ({ f: path.join(p.profilesDir, f), m: fs.statSync(path.join(p.profilesDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0] || null; } catch { return null; }
}
// Each server start follows its own RPT. The previous file gets a last read first, and the delayed stop scheduled
// when that server exited must not end the new follower (a restart starts the new server within seconds).
function startRptTail() {
  if (rptFile) { try { pollRpt(); } catch { /* ignore */ } }
  stopRptTail(false);
  rptGen++;
  rptStartedAt = Date.now(); rptFile = null; rptOffset = 0; rptRest = '';
  rptTimer = setInterval(pollRpt, 1500);
}
function stopRptTail(final) { if (final) pollRpt(); clearInterval(rptTimer); rptTimer = null; }
function pollRpt() {
  try {
    if (!rptFile) {
      // wait for the RPT the new server process creates (its mtime is after our start)
      const n = newestRpt(); if (!n || n.m < rptStartedAt - 5000) return;
      rptFile = n.f; rptOffset = 0; rptRest = '';
      emitRef('console', { source: 'rpt', line: `--- following ${path.basename(rptFile)} ---` });
    }
    const st = fs.statSync(rptFile);
    if (st.size < rptOffset) { rptOffset = 0; rptRest = ''; }
    if (st.size === rptOffset) return;
    const len = Math.min(st.size - rptOffset, 256 * 1024);
    const buf = Buffer.alloc(len); const fd = fs.openSync(rptFile, 'r');
    try { fs.readSync(fd, buf, 0, len, rptOffset); } finally { fs.closeSync(fd); }
    rptOffset += len;
    const lines = (rptRest + buf.toString('utf8')).split(/\r?\n/); rptRest = lines.pop() || '';
    stageFromLines(lines);
    let n = 0;
    for (const l of lines) { if (!l.trim()) continue; if (++n > 1500) { emitRef('console', { source: 'rpt', line: `(… ${lines.length - 1500} more lines, open the Logs page for the full file)` }); break; } emitRef('console', { source: 'rpt', line: l }); }
  } catch { /* file not readable yet */ }
}

function start() {
  if (proc) return status();
  const s = settings.load();
  const p = settings.paths(s);
  if (!fs.existsSync(p.serverExe)) throw new Error('DayZServer_x64.exe not found. Install the server first.');
  if (!fs.existsSync(p.configPath)) throw new Error(`Config file not found: ${p.configPath}`);
  try {
    const pf = require('./preflight').checks();
    for (const w of pf.warn) emitRef('console', { source: 'preflight', line: 'Check: ' + w });
    const pre = require('./preflight');
    const onlyRuntimes = pf.fixes && pf.fixes.length && pf.error.every(e => /Visual C\+\+|DirectX/.test(e));
    if (pf.fixes && pf.fixes.length && s.autoRuntimes !== false && (onlyRuntimes || !pf.error.length)) {
      if (pre.isInstalling()) return { ...status(), installingRuntimes: true };
      const names = pf.fixes.map(k => k === 'vc' ? 'Visual C++ 2015-2022 x64' : 'DirectX June 2010').join(' and ');
      emitRef('console', { source: 'preflight', line: `Installing the missing ${names} runtime${pf.fixes.length > 1 ? 's' : ''} automatically, then starting the server (Windows asks for permission)…` });
      pre.installMissing(pf.fixes, emitRef).then(() => {
        const again = pre.checks();
        if (again.fixes && again.fixes.length) { emitRef('console', { source: 'preflight', line: 'The runtime installers finished but these are still missing: ' + again.error.filter(e => /Visual C\+\+|DirectX/.test(e)).join(' ') + ' Reboot once, then start the server.' }); try { require('./alerts').alert('server-critical', 'Server not started: runtime still missing after install', 'Reboot the PC once, then start the server.'); } catch { /* ignore */ } return; }
        emitRef('console', { source: 'preflight', line: 'Runtimes installed; starting the server.' }); try { start(); } catch (e) { emitRef('console', { source: 'server', line: e.message }); }
      }).catch(e => {
        emitRef('console', { source: 'preflight', line: 'Runtime install failed: ' + e.message + '. Install it by hand or use Launch → Check before start.' });
        try { require('./alerts').alert('server-critical', 'Server not started: runtime install failed', e.message); } catch { /* ignore */ }
      });
      return { ...status(), installingRuntimes: true };
    }
    if (pf.error.length) { for (const e of pf.error) emitRef('console', { source: 'preflight', line: 'Problem: ' + e }); throw new Error('Not started: ' + pf.error[0] + (pf.error.length > 1 ? ` (+${pf.error.length - 1} more, see the console)` : '')); }
  } catch (e) { if (/^Not started:/.test(e.message)) throw e; emitRef('console', { source: 'preflight', line: `The checks before start failed to run (${e.message}); starting without them.` }); }
  try { require('./rcon').ensureConfigured(); } catch (e) { emitRef('console', { source: 'rcon', line: 'RCon auto-configuration failed: ' + e.message }); }
  try { require('./drpadmin').ensure(); } catch (e) { emitRef('console', { source: 'drpadmin', line: 'DRP_Admin mod: ' + e.message }); }
  try { require('./deathlog').ensureBridge(); } catch (e) { emitRef('console', { source: 'deathlog', line: 'Bridge script: ' + e.message }); }
  try { require('./anticheat').ensure(); } catch (e) { emitRef('console', { source: 'anticheat', line: 'Anti-dupe mod: ' + e.message }); }
  fs.mkdirSync(p.profilesDir, { recursive: true });
  clearTimeout(restartTimer); restartTimer = null;
  manualStop = false;
  if (crashLoop) { crashLoop = false; crashes.resetLoop(); }
  const args = buildArgs(s);
  emitRef('console', { source: 'server', line: `Starting: DayZServer_x64.exe ${args.join(' ')}` });
  const showWindow = !!((s.app || {}).showServerWindow);
  // The server must outlive the tool (app updates, a tool crash, background instances): its own process group and
  // its console output in a file, not a pipe that breaks when the tool exits. Everything it logs is in the RPT anyway.
  let out = 'ignore'; try { out = fs.openSync(path.join(p.profilesDir, 'server-console.log'), 'w'); } catch { /* no file: drop the output */ }
  proc = spawn(p.serverExe, args, { cwd: p.serverDir, stdio: ['ignore', out, out], windowsHide: !showWindow, detached: true });
  if (typeof out === 'number') { try { fs.closeSync(out); } catch { /* ignore */ } }
  startedAt = Date.now(); adopted = false;
  startRptTail();
  stage = null; setStage(0);
  startedModParam = currentModParam(s);
  lastExit = null;
  rememberProc(proc.pid, startedAt);
  attachExit(proc);
  try { require('./cpu').apply(proc.pid); } catch { /* ignore */ }
  proc.on('error', err => {
    emitRef('console', { source: 'server', line: `Failed to start: ${err.message}` });
    // no exit event follows a spawn error: clear the state so the server does not show as running
    if (proc && !proc.pid) { proc = null; startedAt = null; stage = null; forgetProc(); stopRptTail(false); emitRef('server:status', status()); }
    alerts.alert('server-critical', 'Server failed to start', err.message);
  });
  emitRef('server:status', status());
  if (proc && proc.pid) alerts.alert('server-up', 'Server started', `pid ${proc.pid}`);
  return status();
}

function attachExit(p) {
  p.on('exit', (code, signal) => {
    const ranFor = Math.round((Date.now() - startedAt) / 1000);
    lastExit = { code, signal, at: Date.now(), ranFor };
    emitRef('console', { source: 'server', line: `Server exited (code ${code}) after ${ranFor}s` });
    if (proc !== p) return;
    forgetProc(); adopted = false;
    proc = null; startedAt = null; stage = null; emitRef('server:stage', null);
    { const gen = rptGen; setTimeout(() => { if (gen === rptGen) stopRptTail(true); }, 3000); }
    const wasManual = manualStop;
    manualStop = false;
    emitRef('server:status', status());
    const cfg = settings.load();
    if (!wasManual) {
      const loop = crashes.recordExit();
      const info = { code, startedAt: lastExit.at - ranFor * 1000, ranFor };
      crashes.report(info).then(meta => {
        const top = meta.topErrors.slice(0, 3).map(g => `${g.label} ×${g.count}: ${g.sample}`).join('\n');
        alerts.alert('crash', `Server exited unexpectedly (code ${code}) after ${Math.round(ranFor / 60)} min`, `${meta.verdict.text}${top ? '\n' + top : ''}\nReport: ${meta.name}.zip`);
      }).catch(e => { emitRef('console', { source: 'crash', line: 'Crash report failed: ' + e.message }); alerts.alert('crash', `Server exited unexpectedly (code ${code})`, ''); });
      if (loop) {
        crashLoop = true;
        const suspect = crashSuspects();
        alerts.alert('crash-loop', 'Crash loop: auto-restart paused', `The server exited ${alerts.cfg().thresholds.crashLoopCount} times within ${alerts.cfg().thresholds.crashLoopMinutes} minutes. Check the crash reports, then start it manually.${suspect ? '\n' + suspect : ''}`);
        if (suspect) emitRef('console', { source: 'server', line: suspect });
        emitRef('console', { source: 'server', line: 'Crash loop detected: auto-restart paused until you start the server manually.' });
      }
    }
    if (!wasManual && cfg.autoRestart && !crashLoop) {
      emitRef('console', { source: 'server', line: 'Auto-restart in 10s...' });
      restartTimer = setTimeout(() => { restartTimer = null; try { start(); } catch (e) { emitRef('console', { source: 'server', line: `Auto-restart failed: ${e.message}` }); alerts.alert('server-critical', 'Auto-restart failed: the server is down', e.message); } }, 10000);
      emitRef('server:status', status());
    }
  });
}

// Force: end the process now (taskkill /F), for a frozen server or one that ignores the shutdown request.
function forceKill(pid, why) {
  emitRef('console', { source: 'server', line: `${why}: ending the server process (pid ${pid}) now; progress since the last autosave is lost.` });
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  setTimeout(() => { if (proc && proc.pid === pid) { try { proc.kill(); } catch { /* ignore */ } } }, 8000);
}
let stopping = null;
// Likely cause of a crash loop: mods added or updated in the last 24 hours, and mod scripts the server could not
// compile in its last log ("Can't find variable/class" in a mod's script path means a missing dependency or a mod built
// for another game version).
function crashSuspects() {
  const out = [];
  try {
    const since = Date.now() - 24 * 3600000; const cache = settings.load().modCache || {};
    const ids = [...new Set(require('./audit').list({ limit: 300 }).filter(e => e.ts > since && /^mods:(add|update|addMany)$/.test(e.action)).flatMap(e => String(e.details || '').match(/\d{6,}/g) || []))];
    const enabled = new Set(settings.load().mods.filter(m => m.enabled !== false).map(m => m.id));
    const names = ids.filter(id => enabled.has(id)).map(id => (cache[id] || {}).title || id);
    if (names.length) out.push(`Changed in the last 24 h: ${names.join(', ')}. Disable ${names.length > 1 ? 'them' : 'it'} on the Installed mods page and start the server again to confirm.`);
  } catch { /* no audit yet */ }
  try {
    const r = newestRpt(); const txt = r ? fs.readFileSync(r.f, 'utf8') : '';
    const bad = [...new Set([...txt.matchAll(/SCRIPT\s+\(E\): @"([^/"]+)\/[^"]*": Can't find (variable|class|type) '([^']+)'/g)].filter(m => !/^scripts$/i.test(m[1])).map(m => `${m[1]} needs '${m[3]}'`))].slice(0, 3);
    if (bad.length) out.push(`Mod scripts that did not compile: ${bad.join('; ')}. That usually means a required mod is missing (check the mod's Workshop page for what it needs) or the mod does not match this game version.`);
  } catch { /* no log */ }
  return out.join(' ');
}
function stop({ force = false } = {}) {
  clearTimeout(restartTimer); restartTimer = null;
  if (!proc) { emitRef('server:status', status()); return Promise.resolve(status()); }
  // already stopping: a second Stop forces it
  if (stopping) { if (force) forceKill(proc.pid, 'Force stop'); return stopping; }
  manualStop = true;
  stopping = new Promise(resolve => {
    const pid = proc.pid;
    const done = () => { stopping = null; resolve(status()); };
    proc.once('exit', done);
    emitRef('server:status', status());
    if (force) { forceKill(pid, 'Force stop'); return; }
    emitRef('console', { source: 'server', line: `Stopping server (pid ${pid}): asking it to save and shut down...` });
    // 1. RCon #shutdown when connected (the cleanest: the server saves the world and BattlEye restores its config)
    let viaRcon = false;
    try { const rcon = require('./rcon'); if (rcon.status().connected) { viaRcon = true; rcon.command('#shutdown').catch(e => { emitRef('console', { source: 'server', line: `RCon #shutdown failed (${e.message}); asking Windows to close it instead.` }); spawn('taskkill', ['/PID', String(pid)], { windowsHide: true }); }); } } catch { /* ignore */ }
    // 2. otherwise a normal close request to the process (same as closing its console window)
    if (!viaRcon) spawn('taskkill', ['/PID', String(pid)], { windowsHide: true });
    // 3. force only if it is still running after the grace period
    const graceMs = (Number(settings.load().stopGraceSec) || 120) * 1000;
    setTimeout(() => {
      if (proc && proc.pid === pid) {
        forceKill(pid, `Server did not stop within ${graceMs / 1000}s`);
      }
    }, graceMs);
  });
  return stopping;
}

async function restart() {
  await stop();
  return start();
}

function init(emit) { emitRef = emit; adopt().catch(() => {}); setInterval(() => { if (!proc) adopt().catch(() => {}); }, 60000); }

module.exports = { init, start, stop, restart, status, setMaintenance, _tail: { startRptTail, stopRptTail } };
