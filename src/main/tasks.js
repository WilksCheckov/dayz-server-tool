'use strict';
// Generic scheduled tasks: in-game messages, RCon commands, backups, updates, restarts, or any command line,
// at fixed daily times or on an interval. Runs alongside the restart/backup scheduler.
const { spawn } = require('child_process');
const settings = require('./settings');
const rcon = require('./rcon');
const server = require('./server');
const backups = require('./backups');
const updater = require('./updater');
const scheduler = require('./scheduler');

let emitRef = () => {};
let timer = null;
let firedMinute = {};
const lastRun = {};

const TYPES = {
  'wipe-full': 'Full wipe (stop, back up, wipe storage and players, start)',
  'wipe-characters': 'Character wipe (stop, back up, wipe players only, start)',
  message: 'In-game message (RCon say)',
  rcon: 'RCon command',
  backup: 'Backup',
  update: 'Update server and mods',
  restart: 'Restart server',
  start: 'Start server if stopped',
  stop: 'Stop server',
  command: 'Run a command line'
};

function all() { return (settings.load().tasks || []).map(t => ({ ...t, lastRun: lastRun[t.id] || t.lastRun || null })); }
function save(list) { settings.save({ tasks: list }); emitRef('tasks:changed', {}); return all(); }

function upsert(task) {
  const list = settings.load().tasks || [];
  const t = { id: task.id || String(Date.now()), name: task.name || 'Task', type: task.type || 'message', payload: task.payload || '', mode: task.mode || 'times', times: (task.times || []).filter(x => /^\d{1,2}:\d{2}$/.test(x)), intervalMinutes: Number(task.intervalMinutes) || 60, onlyWhenRunning: task.onlyWhenRunning !== false, enabled: task.enabled !== false, lastRun: task.lastRun || null };
  const i = list.findIndex(x => x.id === t.id);
  if (i >= 0) list[i] = t; else list.push(t);
  return save(list);
}
function remove(id) { return save((settings.load().tasks || []).filter(t => t.id !== id)); }

async function runTask(t, reason = 'manual') {
  const log = line => emitRef('console', { source: 'tasks', line: `[${t.name}] ${line}` });
  const running = server.status().running;
  if (t.onlyWhenRunning && !running && !['start', 'backup', 'update', 'command', 'wipe-full', 'wipe-characters'].includes(t.type)) { log(`skipped (${reason}): server not running`); return false; }
  try {
    switch (t.type) {
      case 'message': if (!rcon.status().connected) throw new Error('RCon not connected'); await rcon.say(t.payload); break;
      case 'rcon': if (!rcon.status().connected) throw new Error('RCon not connected'); log('-> ' + (await rcon.command(t.payload) || 'ok')); break;
      case 'backup': await backups.create('task'); break;
      case 'wipe-full': case 'wipe-characters': {
        const mission = require('./mission'); const kind = t.type === 'wipe-full' ? 'full' : 'characters';
        if (running) { try { if (rcon.status().connected) await rcon.say(`Server wipe in 1 minute (${kind}).`); } catch { /* ignore */ } await new Promise(r => setTimeout(r, 60000)); log('Stopping server for wipe'); await server.stop(); }
        await backups.create('pre-wipe');
        await mission.wipe(kind); log(`${kind} wipe done`);
        if (running) { server.start(); log('Server started again'); }
        break;
      }
      case 'update': await updater.runNow({ force: true }); break;
      case 'restart': await scheduler.restartNow(); break;
      case 'start': if (!running) server.start(); break;
      case 'stop': await server.stop(); break;
      case 'command': await new Promise((resolve, reject) => { const p = spawn('cmd.exe', ['/c', t.payload], { windowsHide: true }); let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('close', code => { log(`exit ${code}${out.trim() ? ': ' + out.trim().split('\n').slice(-3).join(' | ') : ''}`); code === 0 ? resolve() : reject(new Error('exit ' + code)); }); p.on('error', reject); }); break;
      default: throw new Error('unknown task type');
    }
    log(`ran (${reason})`);
    lastRun[t.id] = Date.now();
    const list = settings.load().tasks || []; const i = list.findIndex(x => x.id === t.id); if (i >= 0) { list[i].lastRun = lastRun[t.id]; settings.save({ tasks: list }); }
    emitRef('tasks:changed', {});
    return true;
  } catch (e) { log(`failed: ${e.message}`); return false; }
}

function tick() {
  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`;
  for (const t of settings.load().tasks || []) {
    if (!t.enabled) continue;
    if (t.mode === 'times') {
      if (firedMinute[t.id] === minuteKey) continue;
      if ((t.times || []).some(x => { const [h, m] = x.split(':').map(Number); return h === now.getHours() && m === now.getMinutes(); })) { firedMinute[t.id] = minuteKey; runTask(t, 'scheduled time').catch(() => {}); }
    } else {
      const last = lastRun[t.id] || t.lastRun || 0;
      if (Date.now() - last >= (Number(t.intervalMinutes) || 60) * 60000) { lastRun[t.id] = Date.now(); runTask(t, 'interval').catch(() => {}); }
    }
  }
}

function nextRuns() {
  const now = Date.now();
  return all().map(t => {
    if (!t.enabled) return { id: t.id, next: null };
    if (t.mode === 'times') { const c = (t.times || []).map(x => { const [h, m] = x.split(':').map(Number); const d = new Date(now); d.setHours(h, m, 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1); return d.getTime(); }); return { id: t.id, next: c.length ? Math.min(...c) : null }; }
    return { id: t.id, next: (t.lastRun || now) + (Number(t.intervalMinutes) || 60) * 60000 };
  });
}

function init(emit) { emitRef = emit; clearInterval(timer); timer = setInterval(tick, 20000); }
module.exports = { init, all, upsert, remove, runTask, nextRuns, TYPES };
