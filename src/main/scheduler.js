'use strict';
// Scheduled restarts (interval and/or fixed daily times) and scheduled backups.
const settings = require('./settings');
const server = require('./server');
const backups = require('./backups');
const rcon = require('./rcon');
const alerts = require('./alerts');

let timer = null;
let warned = {}; // nextRestart timestamp -> Set of minutes already announced
let emitRef = () => {};
let lastRestartAt = null;
let firedMinute = null;
let restartInProgress = false;

function restartCfg() {
  const s = settings.load();
  return { enabled: false, mode: 'times', intervalHours: 4, times: ['04:00'], backupBefore: true, onlyWhenRunning: true, warnMinutes: [15, 5, 1], warnMessage: 'Server restart in {min} minute(s). Please log out safely.', ...(s.restarts || {}) };
}

function parseTimes(times) {
  return (times || []).map(t => String(t).trim()).filter(t => /^\d{1,2}:\d{2}$/.test(t)).map(t => {
    const [h, m] = t.split(':').map(Number);
    return { h: Math.min(23, h), m: Math.min(59, m) };
  });
}

// Next restart as a timestamp (ms), or null when nothing is scheduled.
function nextRestart(now = Date.now()) {
  const c = restartCfg();
  if (!c.enabled) return null;
  const candidates = [];
  if (c.mode === 'interval' || c.mode === 'both') {
    const base = lastRestartAt || (server.status().startedAt) || now;
    const hours = Math.max(0.25, Number(c.intervalHours) || 4);
    candidates.push(base + hours * 3600 * 1000);
  }
  if (c.mode === 'times' || c.mode === 'both') {
    for (const t of parseTimes(c.times)) {
      const d = new Date(now);
      d.setHours(t.h, t.m, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      candidates.push(d.getTime());
    }
  }
  return candidates.length ? Math.min(...candidates) : null;
}

function nextBackup(now = Date.now()) {
  const c = backups.cfg();
  if (!c.enabled) return null;
  const s = settings.load();
  const hours = Math.max(0.25, Number(c.intervalHours) || 6);
  const base = s.lastBackup || s.firstScheduledAt || now;
  return base + hours * 3600 * 1000;
}

// true when the server is back up, false when the restart was skipped or failed (callers report it)
async function doRestart(reason) {
  if (restartInProgress) { emitRef('console', { source: 'scheduler', line: `Restart (${reason}) not started: another restart is still in progress.` }); return false; }
  restartInProgress = true;
  const log = line => emitRef('console', { source: 'scheduler', line });
  try {
    const c = restartCfg();
    const wasRunning = server.status().running;
    if (c.onlyWhenRunning && !wasRunning) { log(`Scheduled restart (${reason}) skipped: server not running.`); return false; }
    log(`Scheduled restart (${reason}).`);
    alerts.alert('restart', 'Scheduled restart', reason);
    if (wasRunning && rcon.status().connected) {
      try { await rcon.say('Server is restarting now.'); await new Promise(r => setTimeout(r, 1500)); } catch { /* ignore */ }
    }
    server.setMaintenance('restart');
    if (wasRunning) await server.stop();
    if (c.backupBefore) { try { await backups.create('restart'); } catch (e) { log(`Backup before restart failed: ${e.message}`); } }
    try { server.start(); } finally { server.setMaintenance(null); }
    return true;
  } catch (e) {
    log(`Scheduled restart failed: ${e.message}`);
    alerts.alert('server-critical', 'Restart failed: the server may be down', `${reason}: ${e.message}`);
    return false;
  } finally {
    lastRestartAt = Date.now();
    restartInProgress = false;
    emitRef('scheduler:state', state());
  }
}

// Announce an upcoming restart through RCon at the configured minute marks.
let rconNudgedFor = 0;
async function warnPlayers(now) {
  const c = restartCfg();
  if (!c.enabled || !server.status().running) return;
  const next = nextRestart(now);
  if (!next) return;
  const firstWarn = Math.max(0, ...(c.warnMinutes || []).map(Number).filter(Number.isFinite));
  if (!rcon.status().connected) {
    // within the warning window (plus 3 minutes of lead time) without RCon: connect now so the warnings can go out
    if ((next - now) / 60000 <= firstWarn + 3 && rconNudgedFor !== next) { rconNudgedFor = next; emitRef('console', { source: 'scheduler', line: 'Restart warnings are due soon and RCon is not connected; connecting now.' }); try { rcon.reconcile({ force: true }); } catch { /* ignore */ } }
    if (!warned[next]) warned = { [next]: new Set() };
    const missed = (c.warnMinutes || []).filter(m => !warned[next].has(m) && (next - now) / 60000 <= m);
    for (const m of missed) { warned[next].add(m); emitRef('console', { source: 'scheduler', line: `Restart warning (${m} min) not sent: RCon is not connected.` }); }
    if (missed.length) alerts.alert('rcon-lost', 'Restart warnings not sent', `RCon is not connected, so players were not warned ${missed.join(', ')} minute(s) before the restart.`);
    return;
  }
  if (!warned[next]) warned = { [next]: new Set() };
  const minsLeft = (next - now) / 60000;
  for (const m of (c.warnMinutes || [])) {
    // Fire once when we are within the mark but not more than one tick (20s) past it.
    if (!warned[next].has(m) && minsLeft <= m && minsLeft > m - 0.4) {
      warned[next].add(m);
      const msg = (c.warnMessage || 'Server restart in {min} minute(s).').replace('{min}', String(m));
      try { await rcon.say(msg); emitRef('console', { source: 'scheduler', line: `Warned players: ${msg}` }); } catch (e) { emitRef('console', { source: 'scheduler', line: `RCon warning failed: ${e.message}` }); }
    }
  }
}

async function tick() {
  const now = Date.now();
  const c = restartCfg();
  await warnPlayers(now).catch(() => {});
  if (c.enabled) {
    const d = new Date(now);
    const minuteKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}:${d.getMinutes()}`;
    if ((c.mode === 'times' || c.mode === 'both') && firedMinute !== minuteKey) {
      if (parseTimes(c.times).some(t => t.h === d.getHours() && t.m === d.getMinutes())) {
        firedMinute = minuteKey;
        await doRestart(`daily time ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
      }
    }
    if (c.mode === 'interval' || c.mode === 'both') {
      const st = server.status();
      const base = lastRestartAt || st.startedAt;
      const hours = Math.max(0.25, Number(c.intervalHours) || 4);
      if (st.running && base && now - base >= hours * 3600 * 1000) await doRestart(`every ${hours}h`);
    }
  }
  const b = backups.cfg();
  if (b.enabled) {
    const nb = nextBackup(now);
    if (nb && now >= nb) {
      try { await backups.create('auto'); } catch (e) { emitRef('console', { source: 'backup', line: `Scheduled backup failed: ${e.message}` }); settings.save({ lastBackup: now }); }
    }
  }
  emitRef('scheduler:state', state());
}

function state() {
  return { restarts: restartCfg(), nextRestart: nextRestart(), nextBackup: nextBackup(), lastRestartAt };
}

function reschedule() {
  const s = settings.load();
  if (backups.cfg().enabled && !s.lastBackup) settings.save({ firstScheduledAt: Date.now() });
  emitRef('scheduler:state', state());
}

function init(emit) {
  emitRef = emit;
  clearInterval(timer);
  timer = setInterval(() => tick().catch(() => {}), 20000);
  reschedule();
}

module.exports = { init, state, reschedule, restartNow: () => doRestart('manual') };
