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
function setStage(i) {
  if (stage && i <= stage.index) return;
  const st = STAGES[i];
  stage = { key: st.key, label: st.label, index: i, total: STAGES.length - 1, at: Date.now(), ready: st.key === 'ready' };
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
    stopping: !!proc && manualStop
  };
}

function buildArgs(s) {
  const args = [
    `-config=${s.configFile}`,
    `-port=${s.port}`,
    `-profiles=${s.profilesDir}`
  ];
  try { const be = require('./rcon').beArg(s); if (be) args.push(be); } catch { /* ignore */ }
  if (s.cpuCount > 0) args.push(`-cpuCount=${s.cpuCount}`);
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
  } catch (e) { if (/^Not started:/.test(e.message)) throw e; }
  try { require('./rcon').ensureConfigured(); } catch (e) { emitRef('console', { source: 'rcon', line: 'RCon auto-configuration failed: ' + e.message }); }
  try { require('./deathlog').ensureBridge(); } catch (e) { emitRef('console', { source: 'deathlog', line: 'Bridge script: ' + e.message }); }
  try { require('./anticheat').ensure(); } catch (e) { emitRef('console', { source: 'anticheat', line: 'Anti-dupe mod: ' + e.message }); }
  fs.mkdirSync(p.profilesDir, { recursive: true });
  clearTimeout(restartTimer); restartTimer = null;
  manualStop = false;
  if (crashLoop) { crashLoop = false; crashes.resetLoop(); }
  const args = buildArgs(s);
  emitRef('console', { source: 'server', line: `Starting: DayZServer_x64.exe ${args.join(' ')}` });
  const showWindow = !!((s.app || {}).showServerWindow);
  proc = spawn(p.serverExe, args, { cwd: p.serverDir, stdio: showWindow ? 'ignore' : ['ignore', 'pipe', 'pipe'], windowsHide: !showWindow, detached: false });
  if (proc.stdout) { const onOut = d => { for (const l of d.toString('utf8').split(/\r?\n/)) if (l.trim()) emitRef('console', { source: 'server', line: l.trim() }); }; proc.stdout.on('data', onOut); proc.stderr.on('data', onOut); }
  startedAt = Date.now();
  startRptTail();
  stage = null; setStage(0);
  startedModParam = currentModParam(s);
  lastExit = null;
  proc.on('exit', (code, signal) => {
    const ranFor = Math.round((Date.now() - startedAt) / 1000);
    lastExit = { code, signal, at: Date.now(), ranFor };
    emitRef('console', { source: 'server', line: `Server exited (code ${code}) after ${ranFor}s` });
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
        alerts.alert('crash-loop', 'Crash loop: auto-restart paused', `The server exited ${alerts.cfg().thresholds.crashLoopCount} times within ${alerts.cfg().thresholds.crashLoopMinutes} minutes. Check the crash reports, then start it manually.`);
        emitRef('console', { source: 'server', line: 'Crash loop detected: auto-restart paused until you start the server manually.' });
      }
    }
    if (!wasManual && cfg.autoRestart && !crashLoop) {
      emitRef('console', { source: 'server', line: 'Auto-restart in 10s...' });
      restartTimer = setTimeout(() => { restartTimer = null; try { start(); } catch (e) { emitRef('console', { source: 'server', line: `Auto-restart failed: ${e.message}` }); } }, 10000);
      emitRef('server:status', status());
    }
  });
  proc.on('error', err => {
    emitRef('console', { source: 'server', line: `Failed to start: ${err.message}` });
  });
  emitRef('server:status', status());
  alerts.alert('server-up', 'Server started', `pid ${proc.pid}`);
  return status();
}

function stop() {
  clearTimeout(restartTimer); restartTimer = null;
  if (!proc) { emitRef('server:status', status()); return Promise.resolve(status()); }
  manualStop = true;
  return new Promise(resolve => {
    const pid = proc.pid;
    const done = () => resolve(status());
    proc.once('exit', done);
    emitRef('console', { source: 'server', line: `Stopping server (pid ${pid}): asking it to save and shut down...` });
    // 1. RCon #shutdown when connected (the cleanest: the server saves the world and BattlEye restores its config)
    let viaRcon = false;
    try { const rcon = require('./rcon'); if (rcon.status().connected) { viaRcon = true; rcon.command('#shutdown').catch(() => {}); } } catch { /* ignore */ }
    // 2. otherwise a normal close request to the process (same as closing its console window)
    if (!viaRcon) spawn('taskkill', ['/PID', String(pid)], { windowsHide: true });
    // 3. force only if it is still running after the grace period
    const graceMs = (Number(settings.load().stopGraceSec) || 120) * 1000;
    setTimeout(() => {
      if (proc && proc.pid === pid) {
        emitRef('console', { source: 'server', line: `Server did not stop within ${graceMs / 1000}s; forcing it closed (unsaved progress since the last autosave is lost).` });
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        setTimeout(() => { if (proc && proc.pid === pid) { try { proc.kill(); } catch { /* ignore */ } } done(); }, 8000);
      }
    }, graceMs);
  });
}

async function restart() {
  await stop();
  return start();
}

function init(emit) { emitRef = emit; }

module.exports = { init, start, stop, restart, status, setMaintenance, _tail: { startRptTail, stopRptTail } };
