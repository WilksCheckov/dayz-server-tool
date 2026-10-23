'use strict';
// Scheduled auto-update: stop server -> update server + outdated mods -> start again.
const settings = require('./settings');
const steamcmd = require('./steamcmd');
const mods = require('./mods');
const server = require('./server');
const alerts = require('./alerts');

let timer = null;
let tickTimer = null;
let running = false;
let checking = false;
let emitRef = () => {};
let lastRun = null;
let lastCheck = null; // { at, server: {installed, latest, available}, mods: [...], error }
let firedMinute = null;

function cfg() {
  const s = settings.load();
  return { enabled: false, intervalHours: 6, mode: 'interval', times: [], onlyIfUpdates: true, checkEveryMinutes: 60, ...(s.autoUpdate || {}) };
}

// Find out what is out of date without changing anything.
async function check({ quiet = false } = {}) {
  if (checking) return lastCheck;
  checking = true;
  const log = line => { if (!quiet) emitRef('console', { source: 'updater', line }); };
  const result = { at: Date.now(), server: { installed: null, latest: null, available: false }, mods: [], error: null };
  try {
    const st = steamcmd.status();
    result.server.installed = st.serverBuild ? st.serverBuild.buildId : null;
    if (st.steamcmdInstalled) {
      try { result.server.latest = await steamcmd.getLatestBuild(emitRef); } catch (e) { log('Could not read the latest server build: ' + e.message); }
      result.server.available = !!(result.server.installed && result.server.latest && String(result.server.installed) !== String(result.server.latest));
    }
    try { result.mods = (await mods.checkUpdates()).map(m => ({ id: m.id, title: m.title })); } catch (e) { log('Mod update check failed: ' + e.message); }
    if (result.server.available || result.mods.length) {
      const what = [result.server.available ? `server build ${result.server.installed} → ${result.server.latest}` : null, result.mods.length ? `${result.mods.length} mod(s): ${result.mods.map(m => m.title).join(', ')}` : null].filter(Boolean).join('; ');
      log('Updates available: ' + what);
      alerts.alert('update-available', 'Updates available', what);
    } else log('Server and mods are up to date.');
  } catch (e) { result.error = e.message; }
  finally { checking = false; lastCheck = result; emitRef('updater:state', state()); }
  return result;
}

function schedule() {
  clearInterval(timer); timer = null;
  clearInterval(tickTimer); tickTimer = null;
  const c = cfg();
  // Dashboard check: periodic, independent of whether automatic installs are on.
  const every = Math.max(15, Number(c.checkEveryMinutes) || 60);
  tickTimer = setInterval(() => tick().catch(() => {}), 30000);
  setTimeout(() => check({ quiet: true }).catch(() => {}), 20000);
  tickTimer._every = every;
  if (!c.enabled) return;
  if (c.mode === 'interval') {
    const hours = Math.max(0.25, Number(c.intervalHours) || 6);
    timer = setInterval(() => (c.onlyIfUpdates ? runIfNeeded() : runNow()).catch(() => {}), hours * 3600 * 1000);
  }
}

async function tick() {
  const c = cfg();
  const now = new Date();
  if (!lastCheck || Date.now() - lastCheck.at > (Math.max(15, Number(c.checkEveryMinutes) || 60)) * 60000) await check({ quiet: true });
  if (!c.enabled || c.mode !== 'times') return;
  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`;
  if (firedMinute === key) return;
  if ((c.times || []).some(t => { const [h, m] = t.split(':').map(Number); return h === now.getHours() && m === now.getMinutes(); })) {
    firedMinute = key;
    await (c.onlyIfUpdates ? runIfNeeded() : runNow());
  }
}

// Scheduled slot: check first, and only stop/update/restart when something is actually out of date.
async function runIfNeeded() {
  const r = await check();
  if (!r.server.available && !r.mods.length) { emitRef('console', { source: 'updater', line: 'Scheduled check: nothing to update, server left running.' }); return { skipped: true, reason: 'up to date' }; }
  return runNow({ force: true });
}

async function runNow({ force = false } = {}) {
  if (running) return { skipped: true, reason: 'already running' };
  running = true;
  emitRef('updater:state', { running: true });
  const log = line => emitRef('console', { source: 'updater', line });
  const result = { server: false, mods: [], failed: [], restarted: false, error: null };
  try {
    log('Update run started.');
    let outdated = [];
    try { outdated = await mods.checkUpdates(); } catch (e) { log(`Mod update check failed: ${e.message}`); }
    const missing = mods.list().filter(m => !m.installed);
    const needMods = [...outdated, ...missing];
    const wasRunning = server.status().running;
    if (!force && !needMods.length && !wasRunning) {
      // Nothing is known to be outdated; still let SteamCMD check the server build.
    }
    if (wasRunning) { server.setMaintenance('update'); log('Stopping server for update...'); await server.stop(); }
    if (cfg().backupBefore !== false) {
      try { log('Backing up before the update...'); await require('./backups').create('update'); }
      catch (e) { log(`Backup before update failed: ${e.message}`); result.failed.push({ what: 'backup', error: e.message }); }
    }
    try { await steamcmd.updateServer(emitRef); result.server = true; }
    catch (e) { result.failed.push({ what: 'server', error: e.message }); log(`Server update failed: ${e.message}`); }
    if (needMods.length && steamcmd.hasCredentials()) {
      for (const m of needMods) {
        try { await mods.update(m.id); result.mods.push(m.id); }
        catch (e) { result.failed.push({ what: m.id, error: e.message }); }
      }
    } else if (needMods.length) {
      log(`${needMods.length} mod(s) need updating but no Steam login is set. Skipping mods.`);
    }
    if (wasRunning) { log('Starting server again...'); try { server.start(); result.restarted = true; } finally { server.setMaintenance(null); } }
    log('Update run finished.');
    if (result.failed.length) alerts.alert('update-failed', 'Update run had failures', result.failed.map(f => `${f.what}: ${f.error}`).join('\n'));
    else alerts.alert('update-done', 'Update run finished', `Server ${result.server ? 'updated' : 'unchanged'}, ${result.mods.length} mod(s) updated${result.restarted ? ', server restarted' : ''}.`);
  } catch (e) {
    result.error = e.message;
    log(`Update run error: ${e.message}`);
    alerts.alert('update-failed', 'Update run failed', e.message);
  } finally {
    running = false;
    lastRun = { at: Date.now(), result };
    setTimeout(() => check({ quiet: true }).catch(() => {}), 2000);
    emitRef('updater:state', { running: false, lastRun });
    emitRef('mods:changed', {});
  }
  return result;
}

function state() {
  const s = settings.load();
  return { running, checking, lastRun, lastCheck, config: cfg(), lastUpdateCheck: s.lastUpdateCheck };
}

function init(emit) { emitRef = emit; schedule(); }

module.exports = { init, schedule, runNow, check, state };
