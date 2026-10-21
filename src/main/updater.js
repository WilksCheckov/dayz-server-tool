'use strict';
// Scheduled auto-update: stop server -> update server + outdated mods -> start again.
const settings = require('./settings');
const steamcmd = require('./steamcmd');
const mods = require('./mods');
const server = require('./server');
const alerts = require('./alerts');

let timer = null;
let running = false;
let emitRef = () => {};
let lastRun = null;

function schedule() {
  clearInterval(timer); timer = null;
  const s = settings.load();
  if (!s.autoUpdate || !s.autoUpdate.enabled) return;
  const hours = Math.max(0.25, Number(s.autoUpdate.intervalHours) || 6);
  timer = setInterval(() => runNow().catch(() => {}), hours * 3600 * 1000);
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
    if (wasRunning) { log('Stopping server for update...'); await server.stop(); }
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
    if (wasRunning) { log('Starting server again...'); server.start(); result.restarted = true; }
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
    emitRef('updater:state', { running: false, lastRun });
    emitRef('mods:changed', {});
  }
  return result;
}

function state() {
  const s = settings.load();
  return { running, lastRun, config: s.autoUpdate, lastUpdateCheck: s.lastUpdateCheck };
}

function init(emit) { emitRef = emit; schedule(); }

module.exports = { init, schedule, runNow, state };
