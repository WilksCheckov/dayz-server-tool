'use strict';
// Zip backups of mission, profiles and config, named by date and time, with retention and restore.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const settings = require('./settings');
const zip = require('./zip');
const alerts = require('./alerts');

let emitRef = () => {};
let running = false;

function cfg() {
  const s = settings.load();
  return {
    enabled: false, intervalHours: 6, keep: 20,
    includeMission: true, includeProfiles: true, includeConfig: true, includeKeys: false, includeToolData: true,
    dir: '',
    ...(s.backups || {})
  };
}

function dir() {
  const c = cfg();
  return c.dir || path.join(settings.load().installDir, 'backups');
}

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function robocopy(src, dest) {
  return new Promise((resolve) => {
    const proc = spawn('robocopy', [src, dest, '/E', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true });
    proc.on('close', code => resolve(code)); // robocopy codes < 8 are success
  });
}

function sources() {
  const s = settings.load();
  const p = settings.paths(s);
  const c = cfg();
  const list = [];
  if (c.includeMission) list.push({ name: 'mpmissions', src: path.join(p.serverDir, 'mpmissions'), type: 'dir', restoreTo: path.join(p.serverDir, 'mpmissions') });
  if (c.includeProfiles) list.push({ name: 'profiles', src: p.profilesDir, type: 'dir', restoreTo: p.profilesDir });
  if (c.includeKeys) list.push({ name: 'keys', src: p.keysDir, type: 'dir', restoreTo: p.keysDir });
  if (c.includeConfig) list.push({ name: path.basename(p.configPath), src: p.configPath, type: 'file', restoreTo: p.configPath });
  // The tool's own data: settings, player database, Discord applications and bans, Steam ban results, health history.
  if (c.includeToolData) { try { list.push({ name: 'tool-data', src: require('electron').app.getPath('userData'), type: 'json', restoreTo: null }); } catch { /* ignore */ } }
  return list;
}

async function create(label = 'manual') {
  if (running) throw new Error('A backup is already running.');
  running = true;
  const log = line => emitRef('console', { source: 'backup', line });
  emitRef('backups:state', { running: true });
  const out = dir();
  fs.mkdirSync(out, { recursive: true });
  const name = `backup_${stamp()}_${label.replace(/[^a-z0-9-]/gi, '')}.zip`;
  const zipPath = path.join(out, name);
  const staging = path.join(out, `_staging_${Date.now()}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    let any = false;
    for (const src of sources()) {
      if (!fs.existsSync(src.src)) { log(`Skipping ${src.name} (not found)`); continue; }
      if (src.type === 'dir') await robocopy(src.src, path.join(staging, src.name));
      else if (src.type === 'json') { const dst = path.join(staging, src.name); fs.mkdirSync(dst, { recursive: true }); for (const n of fs.readdirSync(src.src)) if (/\.json$/i.test(n)) { try { fs.copyFileSync(path.join(src.src, n), path.join(dst, n)); } catch { /* ignore */ } } }
      else fs.copyFileSync(src.src, path.join(staging, src.name));
      any = true;
    }
    if (!any) throw new Error('Nothing to back up. Check the backup contents settings.');
    log(`Compressing to ${name}...`);
    await zip.zipDir(staging, zipPath);
    const size = fs.statSync(zipPath).size;
    log(`Backup done (${(size / 1048576).toFixed(1)} MB)`);
    settings.save({ lastBackup: Date.now() });
    prune();
    try { await require('./offsite').send(zipPath); } catch (e) { log(`Off-site copy failed: ${e.message}`); }
    return { name, size };
  } catch (e) {
    alerts.alert('backup-failed', 'Backup failed', e.message);
    throw e;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    running = false;
    emitRef('backups:state', { running: false });
    emitRef('backups:changed', {});
  }
}

function list() {
  const out = dir();
  let entries = [];
  try { entries = fs.readdirSync(out); } catch { return { dir: out, backups: [] }; }
  const backups = entries.filter(n => /\.zip$/i.test(n)).map(n => {
    const st = fs.statSync(path.join(out, n));
    const m = n.match(/backup_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_?([a-z0-9-]*)/i);
    return { name: n, size: st.size, mtime: st.mtimeMs, date: m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : null, label: m ? m[5] : '' };
  }).sort((a, b) => b.mtime - a.mtime);
  return { dir: out, backups };
}

function prune() {
  const c = cfg();
  const { dir: out, backups } = list();
  const keep = Math.max(1, Number(c.keep) || 20);
  for (const b of backups.slice(keep)) {
    try { fs.unlinkSync(path.join(out, b.name)); emitRef('console', { source: 'backup', line: `Pruned old backup ${b.name}` }); } catch { /* ignore */ }
  }
}

function remove(name) {
  fs.unlinkSync(path.join(dir(), path.basename(name)));
  emitRef('backups:changed', {});
  return list();
}

// Restore a backup over the live files. Caller must make sure the server is stopped.
async function restore(name) {
  const zipFile = path.join(dir(), path.basename(name));
  if (!fs.existsSync(zipFile)) throw new Error('Backup not found.');
  const log = line => emitRef('console', { source: 'backup', line });
  const staging = path.join(dir(), `_restore_${Date.now()}`);
  try {
    log(`Extracting ${name}...`);
    fs.mkdirSync(staging, { recursive: true });
    await zip.unzip(zipFile, staging);
    for (const src of sources()) {
      const from = path.join(staging, src.name);
      if (!fs.existsSync(from)) continue;
      if (src.type === 'dir') { fs.mkdirSync(src.restoreTo, { recursive: true }); await robocopy(from, src.restoreTo); }
      else fs.copyFileSync(from, src.restoreTo);
      log(`Restored ${src.name}`);
    }
    log('Restore complete.');
    return true;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function state() {
  const s = settings.load();
  return { running, config: cfg(), dir: dir(), lastBackup: s.lastBackup || null };
}

function init(emit) { emitRef = emit; }

module.exports = { init, create, list, remove, restore, state, cfg };
