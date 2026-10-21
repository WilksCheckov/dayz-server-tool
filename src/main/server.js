'use strict';
// Starts, stops and watches the DayZServer_x64.exe process.
const fs = require('fs');
const { spawn } = require('child_process');
const settings = require('./settings');
const mods = require('./mods');
const alerts = require('./alerts');
const crashes = require('./crashes');
let crashLoop = false;

let proc = null;
let startedAt = null;
let manualStop = false;
let restartTimer = null;
let emitRef = () => {};
let lastExit = null;
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
    modsChanged: !!proc && startedModParam !== currentModParam()
  };
}

function buildArgs(s) {
  const args = [
    `-config=${s.configFile}`,
    `-port=${s.port}`,
    `-profiles=${s.profilesDir}`
  ];
  if (s.cpuCount > 0) args.push(`-cpuCount=${s.cpuCount}`);
  for (const part of (s.extraParams || '').split(/\s+/)) if (part) args.push(part);
  const modList = mods.modParam(s, false);
  const serverModList = mods.modParam(s, true);
  if (modList) args.push(`-mod=${modList}`);
  if (serverModList) args.push(`-serverMod=${serverModList}`);
  return args;
}

function start() {
  if (proc) return status();
  const s = settings.load();
  const p = settings.paths(s);
  if (!fs.existsSync(p.serverExe)) throw new Error('DayZServer_x64.exe not found. Install the server first.');
  if (!fs.existsSync(p.configPath)) throw new Error(`Config file not found: ${p.configPath}`);
  fs.mkdirSync(p.profilesDir, { recursive: true });
  clearTimeout(restartTimer); restartTimer = null;
  manualStop = false;
  if (crashLoop) { crashLoop = false; crashes.resetLoop(); }
  const args = buildArgs(s);
  emitRef('console', { source: 'server', line: `Starting: DayZServer_x64.exe ${args.join(' ')}` });
  proc = spawn(p.serverExe, args, { cwd: p.serverDir, stdio: 'ignore', windowsHide: false, detached: false });
  startedAt = Date.now();
  startedModParam = currentModParam(s);
  lastExit = null;
  proc.on('exit', (code, signal) => {
    const ranFor = Math.round((Date.now() - startedAt) / 1000);
    lastExit = { code, signal, at: Date.now(), ranFor };
    emitRef('console', { source: 'server', line: `Server exited (code ${code}) after ${ranFor}s` });
    proc = null; startedAt = null;
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
    emitRef('console', { source: 'server', line: `Stopping server (pid ${pid})...` });
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    setTimeout(() => { if (proc && proc.pid === pid) { try { proc.kill(); } catch { /* ignore */ } } done(); }, 8000);
  });
}

async function restart() {
  await stop();
  return start();
}

function init(emit) { emitRef = emit; }

module.exports = { init, start, stop, restart, status, buildArgs };
