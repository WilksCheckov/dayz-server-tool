'use strict';
// Server health: CPU %, memory, server FPS (from the RPT) and player count, sampled while the server runs,
// aggregated per minute, kept for 24 h and persisted so the Dashboard graphs survive a restart of the tool.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const settings = require('./settings');
const server = require('./server');
const rcon = require('./rcon');
const alerts = require('./alerts');

let emitRef = () => {};
let timer = null;
let minutes = []; // [{t, cpu, ram, fps, players, n}] one per minute, newest last
let current = { at: null, cpu: null, ramMB: null, fps: null, players: null, pid: null };
let lastCpu = null; // { pid, cpuSeconds, at }
let lastPlayersAt = 0, lastPlayers = null;
let lowFpsSince = null;
let lastSave = 0, busy = false;

function file() { return path.join(app.getPath('userData'), 'health.json'); }
function load() { try { minutes = JSON.parse(fs.readFileSync(file(), 'utf8')).minutes || []; } catch { minutes = []; } prune(); }
function save() { try { fs.writeFileSync(file(), JSON.stringify({ minutes })); } catch { /* ignore */ } }
function prune() { const cutoff = Date.now() - 24 * 3600 * 1000; minutes = minutes.filter(m => m.t >= cutoff); }

// One PowerShell call returns CPU seconds and working set for the server process.
function processStats(pid) {
  return new Promise(resolve => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){ $c=[cultureinfo]::InvariantCulture; "$($p.CPU.ToString($c))|$($p.WorkingSet64)" }`], { windowsHide: true });
    let out = '';
    const kill = setTimeout(() => { try { ps.kill(); } catch { /* gone */ } }, 15000);
    ps.on('close', () => clearTimeout(kill));
    ps.stdout.on('data', d => { out += d; });
    ps.on('close', () => { const m = out.trim().match(/^([\d.]+)\|(\d+)$/); resolve(m ? { cpuSeconds: Number(m[1]), ram: Number(m[2]) } : null); });
    ps.on('error', () => resolve(null));
  });
}

function latestFps() {
  try {
    const p = settings.paths();
    const files = fs.readdirSync(p.profilesDir).filter(f => /\.rpt$/i.test(f)).map(f => ({ f: path.join(p.profilesDir, f), m: fs.statSync(path.join(p.profilesDir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    if (!files[0]) return null;
    const st = fs.statSync(files[0].f);
    const len = Math.min(st.size, 64 * 1024);
    const fd = fs.openSync(files[0].f, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const matches = [...buf.toString('utf8').matchAll(/Average server FPS:\s*([\d.]+)/gi)];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  } catch { return null; }
}

async function sample() {
  const st = server.status();
  if (!st.running) { if (current.pid) { current = { at: Date.now(), cpu: null, ramMB: null, fps: null, players: null, pid: null }; emitRef('health:sample', current); save(); } lastCpu = null; lowFpsSince = null; return; }
  const stats = await processStats(st.pid);
  let cpu = null, ramMB = null;
  if (stats) {
    ramMB = Math.round(stats.ram / 1048576);
    const now = Date.now();
    if (lastCpu && lastCpu.pid === st.pid) {
      const dt = (now - lastCpu.at) / 1000;
      if (dt > 0) cpu = Math.min(100, Math.round(((stats.cpuSeconds - lastCpu.cpuSeconds) / dt) * 100 / require('os').cpus().length));
    }
    lastCpu = { pid: st.pid, cpuSeconds: stats.cpuSeconds, at: now };
  }
  const fps = latestFps();
  if (rcon.status().connected && Date.now() - lastPlayersAt > 20000) { try { lastPlayers = (await rcon.players()).players.length; } catch { lastPlayers = null; } lastPlayersAt = Date.now(); }
  const players = rcon.status().connected ? lastPlayers : null;
  current = { at: Date.now(), cpu, ramMB, fps, players, pid: st.pid };
  emitRef('health:sample', current);
  // Minute buckets (average cpu/ram/fps, max players)
  const t = Math.floor(Date.now() / 60000) * 60000;
  let b = minutes[minutes.length - 1];
  if (!b || b.t !== t) { b = { t, cpu: null, ram: null, fps: null, players: null, n: 0 }; minutes.push(b); prune(); }
  const avg = (old, v) => v === null ? old : (old === null ? v : Math.round((old * b.n + v) / (b.n + 1)));
  b.cpu = avg(b.cpu, cpu); b.ram = avg(b.ram, ramMB); b.fps = avg(b.fps, fps); b.players = players === null ? b.players : Math.max(b.players || 0, players); b.n++;
  if (Date.now() - lastSave > 30000) { lastSave = Date.now(); save(); }
  // Thresholds
  const th = alerts.cfg().thresholds;
  if (fps !== null && fps < th.fpsBelow) { if (!lowFpsSince) lowFpsSince = Date.now(); else if (Date.now() - lowFpsSince > th.fpsForSec * 1000) alerts.alert('low-fps', `Server FPS is ${fps}`, `Below ${th.fpsBelow} for over ${Math.round(th.fpsForSec / 60)} minutes. ${players !== null ? players + ' players online.' : ''}`); }
  else lowFpsSince = null;
  if (ramMB !== null && ramMB > th.ramAboveMB) alerts.alert('high-ram', `Server memory is ${(ramMB / 1024).toFixed(1)} GB`, `Above the ${(th.ramAboveMB / 1024).toFixed(1)} GB threshold. A restart is usually the cure.`);
}

function history(rangeMinutes = 180) {
  const cutoff = Date.now() - rangeMinutes * 60000;
  return minutes.filter(m => m.t >= cutoff);
}

function init(emit) {
  emitRef = emit;
  load();
  clearInterval(timer);
  timer = setInterval(() => { if (busy) return; busy = true; sample().catch(() => {}).finally(() => { busy = false; }); }, 10000);
}

module.exports = { init, current: () => current, history, sample };
