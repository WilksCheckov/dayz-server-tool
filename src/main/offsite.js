'use strict';
// Off-site copies of backups: FTP/FTPS upload and/or a copy into another folder (a OneDrive/Dropbox/Google Drive folder, a NAS share).
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

let emitRef = () => {};

function cfg() {
  const s = settings.load();
  return { enabled: false, folder: '', ftp: { enabled: false, host: '', port: 21, user: '', password: '', secure: false, dir: '/backups' }, keepRemote: 10, ...(s.offsite || {}) };
}

async function uploadFtp(file, c) {
  const { Client } = require('basic-ftp');
  const client = new Client(30000);
  try {
    await client.access({ host: c.host, port: Number(c.port) || 21, user: c.user, password: c.password, secure: !!c.secure, secureOptions: { rejectUnauthorized: false } });
    await client.ensureDir(c.dir || '/');
    await client.uploadFrom(file, path.basename(file));
    // retention on the remote side
    const keep = Math.max(1, Number(cfg().keepRemote) || 10);
    const list = (await client.list()).filter(f => /^backup_.*\.zip$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    for (const f of list.slice(0, Math.max(0, list.length - keep))) await client.remove(f.name).catch(() => {});
  } finally { client.close(); }
}

async function send(zipPath) {
  const c = cfg();
  if (!c.enabled) return { skipped: true };
  const log = line => emitRef('console', { source: 'backup', line });
  const result = { folder: null, ftp: null };
  if (c.folder) {
    try {
      fs.mkdirSync(c.folder, { recursive: true });
      fs.copyFileSync(zipPath, path.join(c.folder, path.basename(zipPath)));
      const keep = Math.max(1, Number(c.keepRemote) || 10);
      const list = fs.readdirSync(c.folder).filter(f => /^backup_.*\.zip$/i.test(f)).sort();
      for (const f of list.slice(0, Math.max(0, list.length - keep))) fs.rmSync(path.join(c.folder, f), { force: true });
      result.folder = 'ok'; log(`Off-site copy saved to ${c.folder}`);
    } catch (e) { result.folder = e.message; log(`Off-site folder copy failed: ${e.message}`); try { require('./alerts').alert('backup-failed', 'Off-site copy failed', `${c.folder}: ${e.message}`); } catch { /* ignore */ } }
  }
  if (c.ftp && c.ftp.enabled && c.ftp.host) {
    try { await uploadFtp(zipPath, c.ftp); result.ftp = 'ok'; log(`Uploaded to ${c.ftp.host}${c.ftp.dir}`); }
    catch (e) { result.ftp = e.message; log(`FTP upload failed: ${e.message}`); try { require('./alerts').alert('backup-failed', 'Off-site upload failed', e.message); } catch { /* ignore */ } }
  }
  return result;
}

async function testFtp(c) {
  const { Client } = require('basic-ftp');
  const client = new Client(15000);
  try { await client.access({ host: c.host, port: Number(c.port) || 21, user: c.user, password: c.password, secure: !!c.secure, secureOptions: { rejectUnauthorized: false } }); await client.ensureDir(c.dir || '/'); const n = (await client.list()).length; return `Connected. ${n} item(s) in ${c.dir || '/'}.`; }
  finally { client.close(); }
}

function init(emit) { emitRef = emit; }
module.exports = { init, cfg, send, testFtp };
