'use strict';
// SteamCMD wrapper: download/bootstrap, run scripts, install/update the server, download workshop items.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const settings = require('./settings');
const vdf = require('./vdf');

const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';

// Credentials live only in memory for the lifetime of the app.
const creds = { user: '', pass: '', guard: '' };
let current = null; // currently running steamcmd process

function setCredentials(c) {
  creds.user = (c.user || '').trim();
  creds.pass = c.pass || '';
  creds.guard = (c.guard || '').trim();
  if (creds.user) settings.save({ steamUser: creds.user });
  // Opt-in: keep the password encrypted with the Windows user account (Electron safeStorage) so scheduled
  // mod updates still work after the tool restarts. Anything else clears a stored password.
  if (c.remember && creds.pass) {
    try { const { safeStorage } = require('electron'); if (safeStorage && safeStorage.isEncryptionAvailable()) settings.save({ steamPassEnc: safeStorage.encryptString(creds.pass).toString('base64') }); }
    catch { /* no safeStorage in this environment */ }
  } else if (c.remember === false) settings.save({ steamPassEnc: '' });
}
// The login this tool has in memory, for handing to a new instance on the same PC (never written anywhere by this).
function sharedLogin() { return hasCredentials() ? { user: creds.user, pass: creds.pass, remember: !!settings.load().steamPassEnc } : null; }
// Called once at startup: restore a remembered password.
function loadSavedCredentials() {
  const s = settings.load();
  if (!s.steamPassEnc || !s.steamUser) return false;
  try { const { safeStorage } = require('electron'); creds.user = s.steamUser; creds.pass = safeStorage.decryptString(Buffer.from(s.steamPassEnc, 'base64')); return true; }
  catch { return false; }
}

function hasCredentials() {
  return !!(creds.user && creds.pass);
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

async function downloadFile(url, dest, emit) {
  emit('console', { source: 'steamcmd', line: `Downloading ${url}` });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  emit('console', { source: 'steamcmd', line: `Saved ${dest} (${(buf.length / 1024).toFixed(0)} KB)` });
}

function expandZip(zip, dir) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`
    ], { windowsHide: true });
    let err = '';
    ps.stderr.on('data', d => { err += d; });
    ps.on('close', code => code === 0 ? resolve() : reject(new Error(err || `Expand-Archive exit ${code}`)));
  });
}

// Make sure steamcmd.exe exists; download and bootstrap it when missing.
async function ensureSteamcmd(emit) {
  const p = settings.paths();
  if (exists(p.steamcmdExe)) return p.steamcmdExe;
  fs.mkdirSync(p.steamcmdDir, { recursive: true });
  const zip = path.join(p.steamcmdDir, 'steamcmd.zip');
  await downloadFile(STEAMCMD_URL, zip, emit);
  await expandZip(zip, p.steamcmdDir);
  try { fs.unlinkSync(zip); } catch { /* ignore */ }
  emit('console', { source: 'steamcmd', line: 'Bootstrapping SteamCMD (first run self-update)...' });
  await runScript(['@ShutdownOnFailedCommand 1', 'quit'], emit, { allowCodes: [0, 6, 7] });
  return p.steamcmdExe;
}

// Run a steamcmd script. Lines are plain steamcmd commands (without leading '+').
function runScript(lines, emit, opts = {}) {
  const p = settings.paths();
  const scriptPath = path.join(p.steamcmdDir, `_task_${Date.now()}.txt`);
  fs.writeFileSync(scriptPath, lines.join('\r\n') + '\r\n');
  return new Promise((resolve) => {
    const output = [];
    const proc = spawn(p.steamcmdExe, ['+runscript', scriptPath], {
      cwd: p.steamcmdDir,
      windowsHide: true
    });
    current = proc;
    proc.on('error', err => { current = null; try { fs.unlinkSync(scriptPath); } catch { /* ignore */ } resolve({ code: -1, output: [], error: 'Could not start SteamCMD: ' + err.message }); });
    let buf = '';
    const onData = d => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        output.push(line);
        emit('console', { source: 'steamcmd', line });
        if (/Steam Guard|Two-factor code|two-factor code/i.test(line)) {
          emit('steam:guardNeeded', {});
          try { require('./alerts').alert('steam-guard', 'Steam Guard code needed', 'SteamCMD is asking for a Steam Guard code, so workshop downloads are paused. Enter the code on the Installation page and retry.'); } catch { /* ignore */ }
        }
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('close', code => {
      current = null;
      try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
      const allow = opts.allowCodes || [0];
      const text = output.join('\n');
      let error = null;
      if (/Invalid Password/i.test(text)) error = 'Steam login failed: invalid password.';
      else if (/Rate Limit Exceeded/i.test(text)) error = 'Steam rate limit exceeded. Wait a few minutes and try again.';
      else if (/Steam Guard|Two-factor code/i.test(text) && !/Logged in OK|Waiting for user info/i.test(text)) error = 'Steam Guard code required. Enter the code and retry.';
      else if (/ERROR! Download item .* failed|ERROR! Timeout downloading item/i.test(text)) error = 'Workshop download failed (timeout). Retrying usually finishes it.';
      else if (/ERROR!.*app_update|Error! App '\d+' state is/i.test(text)) error = 'Server update failed. See console output.';
      else if (!allow.includes(code)) error = `SteamCMD exited with code ${code}.`;
      resolve({ code, output, error });
    });
  });
}

function cancel() {
  if (current) {
    try { spawn('taskkill', ['/PID', String(current.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
  }
}

function loginLine() {
  if (hasCredentials()) {
    return `login ${creds.user} ${creds.pass}${creds.guard ? ' ' + creds.guard : ''}`;
  }
  return 'login anonymous';
}

// Install or update the dedicated server (anonymous login works for the DayZ server app).
async function updateServer(emit, { validate = false } = {}) {
  await ensureSteamcmd(emit);
  const s = settings.load();
  const p = settings.paths(s);
  fs.mkdirSync(p.serverDir, { recursive: true });
  const r = await runScript([
    '@ShutdownOnFailedCommand 1',
    '@NoPromptForPassword 1',
    `force_install_dir "${p.serverDir}"`,
    loginLine(),
    `app_update ${s.serverAppId}${validate ? ' validate' : ''}`,
    'quit'
  ], emit, { allowCodes: [0, 6, 7] });
  const ok = !r.error && r.output.some(l => /Success! App '\d+' fully installed/i.test(l));
  if (!ok) throw new Error(r.error || 'Server update did not report success. See console.');
  // After a fresh install, give the user a config file to start with.
  const defaultCfg = path.join(p.serverDir, 'serverDZ.cfg');
  if (!exists(p.configPath) && exists(defaultCfg) && p.configPath !== defaultCfg) {
    fs.copyFileSync(defaultCfg, p.configPath);
  }
  return true;
}

// Download a workshop item. DayZ workshop content requires a Steam account that owns DayZ.
async function downloadWorkshopItem(id, emit, { retries = 3 } = {}) {
  await ensureSteamcmd(emit);
  const s = settings.load();
  const p = settings.paths(s);
  if (!hasCredentials()) {
    throw new Error('Workshop downloads need a Steam account that owns DayZ. Enter your Steam login on the Install page.');
  }
  let last = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    emit('console', { source: 'steamcmd', line: `Downloading workshop item ${id} (attempt ${attempt}/${retries})` });
    last = await runScript([
      '@ShutdownOnFailedCommand 0',
      '@NoPromptForPassword 1',
      loginLine(),
      `workshop_download_item ${s.workshopAppId} ${id}`,
      'quit'
    ], emit, { allowCodes: [0, 6, 7] });
    const ok = last.output.some(l => /Success\. Downloaded item/i.test(l));
    if (ok) {
      return path.join(p.workshopDir, String(id));
    }
    if (last.error && !/timeout/i.test(last.error)) break;
  }
  throw new Error((last && last.error) || `Workshop item ${id} did not download.`);
}

// Latest public build id on Steam (anonymous app_info_print). Cached for 30 minutes.
let latestCache = { at: 0, appId: null, buildId: null };
async function getLatestBuild(emit = () => {}) {
  const s = settings.load();
  if (latestCache.appId === s.serverAppId && Date.now() - latestCache.at < 30 * 60000) return latestCache.buildId;
  await ensureSteamcmd(emit);
  const r = await runScript(['@ShutdownOnFailedCommand 1', '@NoPromptForPassword 1', 'login anonymous', 'app_info_update 1', `app_info_print ${s.serverAppId}`, 'quit'], () => {}, { allowCodes: [0, 6, 7] });
  const text = r.output.join('\n');
  const start = text.indexOf(`"${s.serverAppId}"`);
  let buildId = null;
  if (start >= 0) {
    try {
      const data = vdf.parse(text.slice(start));
      const app = data[String(s.serverAppId)] || {};
      buildId = app.depots && app.depots.branches && app.depots.branches.public ? app.depots.branches.public.buildid : null;
    } catch { buildId = null; }
  }
  if (!buildId) { const m = text.match(/"public"\s*\{[^}]*"buildid"\s*"(\d+)"/); buildId = m ? m[1] : null; }
  if (buildId) latestCache = { at: Date.now(), appId: s.serverAppId, buildId };
  return buildId;
}

function getServerBuild() {
  const p = settings.paths();
  try {
    const data = vdf.parse(fs.readFileSync(p.serverManifest, 'utf8'));
    const st = data.AppState || {};
    return { buildId: st.buildid || null, name: st.name || null, lastUpdated: st.LastUpdated ? Number(st.LastUpdated) * 1000 : null };
  } catch {
    return null;
  }
}

function status() {
  const s = settings.load();
  const p = settings.paths(s);
  return {
    steamcmdInstalled: exists(p.steamcmdExe),
    serverInstalled: exists(p.serverExe),
    serverBuild: getServerBuild(),
    steamUser: s.steamUser,
    loggedIn: hasCredentials(),
    savedPassword: !!s.steamPassEnc,
    busy: !!current,
    paths: p
  };
}

module.exports = { sharedLogin, setCredentials, loadSavedCredentials, hasCredentials, ensureSteamcmd, updateServer, downloadWorkshopItem, getLatestBuild, status, cancel };
