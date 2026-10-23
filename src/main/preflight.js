'use strict';
// Why does the server not start? Checks run before every launch (missing runtime, broken install, bad config or
// mission, missing mod folders or keys, port already taken) and a verdict for an exit that happened before the
// server wrote an RPT, from the Windows exit code.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const settings = require('./settings');

function regInstalled(key) {
  try { const out = execSync(`reg query "${key}" /v Installed`, { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); return /Installed\s+REG_DWORD\s+0x1/i.test(out); } catch { return false; }
}
function udpListeners() {
  try { const out = execSync('netstat -an -p udp', { encoding: 'utf8', windowsHide: true, timeout: 8000 }); return [...out.matchAll(/UDP\s+(?:0\.0\.0\.0|\d+\.\d+\.\d+\.\d+):(\d+)/g)].map(m => Number(m[1])); } catch { return []; }
}
function missionName(cfgText) { const m = String(cfgText || '').match(/^\s*template\s*=\s*"([^"]+)"/mi); return m ? m[1] : null; }

// Returns { ok: [], warn: [], error: [] } of plain-language findings.
function checks() {
  const s = settings.load(); const p = settings.paths(s);
  const out = { ok: [], warn: [], error: [], fixes: [], offers: [] };
  const fix = k => { if (k && !out.fixes.includes(k)) out.fixes.push(k); };
  const err = t => out.error.push(t), warn = t => out.warn.push(t), ok = t => out.ok.push(t);
  // install
  if (!fs.existsSync(p.serverExe)) err('DayZServer_x64.exe is missing: install or validate the server on the Installation page.');
  else {
    try { if (fs.statSync(p.serverExe).size < 1024 * 1024) err('DayZServer_x64.exe is only partly downloaded: validate the server files.'); } catch { /* ignore */ }
    for (const dll of ['steam_api64.dll', 'steamclient64.dll', 'tier0_s64.dll', 'vstdlib_s64.dll']) if (!fs.existsSync(path.join(p.serverDir, dll))) err(`${dll} is missing next to the server exe: validate the server files.`);
    if (!fs.existsSync(path.join(p.serverDir, 'dta')) || !fs.existsSync(path.join(p.serverDir, 'addons'))) err('The server\'s dta or addons folder is missing: the install is incomplete, validate the server files.');
  }
  // every DLL the exe imports must exist next to it or in Windows; this names the exact missing one
  if (fs.existsSync(p.serverExe)) {
    try {
      const pe = require('./peimports'); const miss = pe.missing(p.serverExe);
      for (const dll of miss) { err(`${dll} is missing on this PC; the server exits at once without it (exit code 0xC0000135). It comes from ${pe.provider(dll)}.`); fix(pe.fixFor(dll)); }
      if (!miss.length) ok('Every DLL the server imports is present');
    } catch { /* unreadable exe: the size check above covers it */ }
  }
  // runtime the server needs (DayZ links the 2015-2022 x64 C++ runtime)
  if (process.platform === 'win32') {
    if (regInstalled('HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64') || regInstalled('HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64')) ok('Visual C++ 2015-2022 x64 runtime installed');
    else { err('The Microsoft Visual C++ 2015-2022 x64 runtime is not installed; the server exits at once without it (exit code 0xC0000135). Install vc_redist.x64.exe from Microsoft, then start again.'); fix('vc'); }
  }
  // config and mission
  let cfg = '';
  if (!fs.existsSync(p.configPath)) err(`Config file not found: ${p.configPath}`);
  else {
    cfg = fs.readFileSync(p.configPath, 'utf8');
    const mission = missionName(cfg);
    if (!mission) err('serverDZ.cfg has no template = "…" line, so the server does not know which mission to load.');
    else {
      const md = path.join(p.serverDir, 'mpmissions', mission);
      if (!fs.existsSync(md)) err(`Mission folder not found: mpmissions\\${mission}. Check the template line in serverDZ.cfg; for a stock map, validate the server files on the Installation page.`);
      else {
        if (!fs.existsSync(path.join(md, 'init.c'))) err(`mpmissions\\${mission}\\init.c is missing. The stock server ships it, so the install is incomplete: run Install / Update server on the Installation page with "Validate files" ticked and let it finish (a modded map instead needs its mission folder copied in).`);
        if (!fs.existsSync(path.join(md, 'db', 'types.xml'))) warn(`mpmissions\\${mission}\\db\\types.xml is missing; the economy cannot start.`);
        ok(`Mission ${mission} present`);
      }
    }
    if (!/^\s*hostname\s*=/mi.test(cfg)) warn('serverDZ.cfg has no hostname line.');
  }
  // profiles folder writable
  try { fs.mkdirSync(p.profilesDir, { recursive: true }); const t = path.join(p.profilesDir, '.dzat-write-test'); fs.writeFileSync(t, 'x'); fs.unlinkSync(t); } catch (e) { err(`The profiles folder is not writable (${e.message}); the server cannot write its logs there.`); }
  // mods: folders and keys
  try {
    const mods = require('./mods'); const all = [mods.modParam(s, false), mods.modParam(s, true)].join(';').split(';').map(x => x.trim()).filter(Boolean);
    const keysDir = path.join(p.serverDir, 'keys');
    for (const folder of all) {
      const dir = path.join(p.serverDir, folder);
      if (!fs.existsSync(dir)) { err(`Mod folder not found: ${folder} (listed in -mod/-serverMod). Remove it from the list or install the mod.`); continue; }
      let pbos = 0; try { pbos = fs.readdirSync(path.join(dir, 'addons')).filter(f => /\.pbo$/i.test(f)).length; } catch { /* no addons */ }
      if (!pbos) err(`${folder} has no addons\\*.pbo: the download is incomplete or the folder is wrong.`);
      let keys = []; try { keys = fs.readdirSync(path.join(dir, 'keys')).filter(f => /\.bikey$/i.test(f)); } catch { try { keys = fs.readdirSync(path.join(dir, 'key')).filter(f => /\.bikey$/i.test(f)); } catch { /* no keys */ } }
      if (keys.length && /verifySignatures\s*=\s*[12]/.test(cfg)) { const have = (() => { try { return fs.readdirSync(keysDir); } catch { return []; } })(); if (!keys.some(k => have.includes(k))) warn(`${folder}: its .bikey is not in the server's keys folder; with verifySignatures on, players with the mod are kicked. The Installed mods page can copy keys.`); }
    }
  } catch { /* mods module not available */ }
  // BattlEye
  if (!fs.existsSync(path.join(p.serverDir, 'battleye', 'BEServer_x64.dll')) && !fs.existsSync(path.join(p.profilesDir, 'BattlEye', 'BEServer_x64.dll'))) warn('BattlEye DLL not found (battleye\\BEServer_x64.dll); BattlEye downloads it on first start if it has internet access.');
  // port already in use
  const port = Number(s.port) || 2302;
  const listeners = udpListeners();
  if (listeners.includes(port)) err(`UDP port ${port} is already in use on this PC: another server (or an old one) is still running. Stop it first or change the port.`);
  // Windows Defender scanning every file the server reads is a common cause of starts that take many minutes
  try { const d = require('./sysinfo').cachedDefender(); if (d && d.present && d.realTime !== false && d.excluded !== true) { warn(d.excluded === false ? `Windows Defender scans the server folder (${s.installDir}). On slow machines that alone can stretch a start to 10+ minutes; exclude the folder (button below).` : `Windows Defender is on and probably scans the server folder (${s.installDir}); the tool cannot read the exclusion list without administrator rights. If starts are slow, exclude the folder (button below).`); out.offers.push('defender'); } else if (d && d.present && d.excluded) ok('Server folder excluded from Windows Defender'); } catch { /* ignore */ }
  // memory: the server alone wants 4-6 GB; less makes Windows page and the start takes many minutes
  try { const gb = require('os').totalmem() / 1073741824; if (gb < 8) warn(`This PC has ${gb.toFixed(1)} GB of RAM. The DayZ server wants 4-6 GB on its own, so expect very slow starts and poor performance; 8 GB or more is recommended.`); } catch { /* ignore */ }
  // disk space (best effort)
  try { const st = fs.statfsSync ? fs.statfsSync(p.serverDir) : null; if (st && st.bavail * st.bsize < 2 * 1024 * 1024 * 1024) warn('Less than 2 GB free on the server drive; logs and persistence may fail to write.'); } catch { /* ignore */ }
  return out;
}

// What an exit code means when the server stopped before writing an RPT.
const CODES = {
  '-1073741515': ['A required DLL is missing (STATUS_DLL_NOT_FOUND, 0xC0000135). On a fresh Windows that is the Visual C++ 2015-2022 x64 runtime or the DirectX June 2010 runtime (XAPOFX1_5.dll); both install with one click from Launch → Check before start.'],
  '3221225781': ['A required DLL is missing (STATUS_DLL_NOT_FOUND, 0xC0000135). On a fresh Windows that is the Visual C++ 2015-2022 x64 runtime or the DirectX June 2010 runtime (XAPOFX1_5.dll); both install with one click from Launch → Check before start.'],
  '-1073741502': ['A DLL failed to initialise (0xC0000142). Usually a broken or blocked install: validate the server files and check antivirus quarantine.'],
  '3221225794': ['A DLL failed to initialise (0xC0000142). Usually a broken or blocked install: validate the server files and check antivirus quarantine.'],
  '-1073741701': ['Bad image (0xC000007B): a DLL is corrupt or the wrong architecture. Validate the server files.'],
  '3221225595': ['Bad image (0xC000007B): a DLL is corrupt or the wrong architecture. Validate the server files.'],
  '-1073741819': ['Access violation (0xC0000005): the server crashed. Right after start this is usually a broken mod, a bad mission file or an incomplete install.'],
  '3221225477': ['Access violation (0xC0000005): the server crashed. Right after start this is usually a broken mod, a bad mission file or an incomplete install.'],
  '-1073740791': ['Stack buffer overrun (0xC0000409): the server crashed hard. Validate the files and remove recently added mods.'],
  '3221226505': ['Stack buffer overrun (0xC0000409): the server crashed hard. Validate the files and remove recently added mods.'],
  '-1073741510': ['The process was closed from its console window (Ctrl+C / window closed).'],
  '3221225786': ['The process was closed from its console window (Ctrl+C / window closed).'],
  '1': ['The server refused to start (exit code 1): a launch parameter, the config file or the mission name is wrong. The console lines above this one usually say which.'],
  '0': ['The server shut itself down cleanly (exit code 0) without running: usually a config problem such as a missing or wrong template, or a port that is already in use.']
};
function exitVerdict(code, ranForSec, hadRpt) {
  const known = CODES[String(code)];
  const early = ranForSec !== null && ranForSec !== undefined && ranForSec < 25;
  let text = known ? known[0] : `The server exited with code ${code} after ${ranForSec}s.`;
  if (!hadRpt) text += early ? ' It did not get as far as writing an RPT, so the problem is in launching the exe, not in the mission.' : ' No RPT was written during this run.';
  try { const pe = require('./peimports'); const miss = pe.missing(settings.paths().serverExe); if (miss.length) text += ' Missing: ' + miss.map(d => `${d} (from ${pe.provider(d)})`).join(', ') + '.'; } catch { /* ignore */ }
  const c = checks();
  const hints = [...c.error.map(t => 'Problem: ' + t), ...c.warn.map(t => 'Check: ' + t)];
  return { level: c.error.length || known ? 'error' : 'warn', text, hints };
}
// One-click fix for the most common fresh-Windows failure: download Microsoft's vc_redist.x64.exe and run it
// (Windows asks for permission). Resolves when the installer has finished.
const VC_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
function vcInstalled() { return regInstalled('HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64') || regInstalled('HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'); }
async function installVcRedist(emit = () => {}) {
  if (vcInstalled()) return { installed: true, action: 'already' };
  const dir = path.join(require('os').tmpdir(), 'dzat-vcredist'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vc_redist.x64.exe');
  emit('console', { source: 'preflight', line: 'Downloading the Visual C++ 2015-2022 x64 runtime from Microsoft…' });
  const res = await fetch(VC_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  if (fs.statSync(file).size < 5 * 1024 * 1024) throw new Error('The downloaded installer is too small to be real; try again later.');
  emit('console', { source: 'preflight', line: 'Running the runtime installer (Windows asks for permission)…' });
  await new Promise((resolve, reject) => {
    // Start-Process -Verb RunAs -Wait runs it elevated and waits for it to finish
    const ps = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`], { windowsHide: true });
    let err = ''; ps.stderr.on('data', d => err += d);
    ps.on('exit', code => (code === 0 || code === 3010 || code === 1638) ? resolve(code) : reject(new Error(code === 1 && /canceled|cancelled|denied/i.test(err) ? 'Windows permission was declined.' : `Installer exit code ${code}${err ? ': ' + err.trim().slice(0, 200) : ''}`)));
    ps.on('error', reject);
  });
  const okNow = vcInstalled();
  emit('console', { source: 'preflight', line: okNow ? 'Visual C++ runtime installed. Start the server again.' : 'The installer finished but the runtime still does not show as installed; a reboot may be needed.' });
  return { installed: okNow, action: 'installed' };
}
const DX_URL = 'https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe';
function dxInstalled() { const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'); return fs.existsSync(path.join(sys, 'XAPOFX1_5.dll')) && fs.existsSync(path.join(sys, 'X3DAudio1_7.dll')); }
function runElevated(file, args) {
  return new Promise((resolve, reject) => {
    const list = args.map(a => "'" + a.replace(/'/g, "''") + "'").join(',');
    const ps = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList ${list} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`], { windowsHide: true });
    let err = ''; ps.stderr.on('data', d => err += d);
    ps.on('exit', code => (code === 0 || code === 3010 || code === 1638) ? resolve(code) : reject(new Error(/canceled|cancelled|denied/i.test(err) ? 'Windows permission was declined.' : `Installer exit code ${code}${err ? ': ' + err.trim().slice(0, 200) : ''}`)));
    ps.on('error', reject);
  });
}
async function installDirectX(emit = () => {}) {
  if (dxInstalled()) return { installed: true, action: 'already' };
  const dir = path.join(require('os').tmpdir(), 'dzat-directx'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'directx_Jun2010_redist.exe');
  emit('console', { source: 'preflight', line: 'Downloading the DirectX June 2010 runtime from Microsoft (about 95 MB)…' });
  const res = await fetch(DX_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  if (fs.statSync(file).size < 50 * 1024 * 1024) throw new Error('The downloaded package is too small to be real; try again later.');
  const ext = path.join(dir, 'x');
  emit('console', { source: 'preflight', line: 'Unpacking the runtime…' });
  await new Promise((resolve, reject) => { const c = require('child_process').spawn(file, ['/Q', '/T:' + ext], { windowsHide: true }); c.on('exit', code => code === 0 ? resolve() : reject(new Error('Unpack failed with code ' + code))); c.on('error', reject); });
  const setup = path.join(ext, 'DXSETUP.exe'); if (!fs.existsSync(setup)) throw new Error('DXSETUP.exe not found after unpacking.');
  emit('console', { source: 'preflight', line: 'Running the DirectX installer (Windows asks for permission)…' });
  await runElevated(setup, ['/silent']);
  const okNow = dxInstalled();
  emit('console', { source: 'preflight', line: okNow ? 'DirectX runtime installed. Start the server again.' : 'The installer finished but XAPOFX1_5.dll is still missing; a reboot may be needed.' });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { installed: okNow, action: 'installed' };
}
// Install every runtime the checks found missing, one after the other (each asks Windows for permission once).
let installing = null;
function installMissing(fixes, emit = () => {}) {
  if (installing) return installing;
  const order = ['vc', 'dx'].filter(k => fixes.includes(k));
  installing = (async () => {
    const done = [];
    try {
      for (const k of order) { const r = k === 'vc' ? await module.exports.installVcRedist(emit) : await module.exports.installDirectX(emit); done.push({ k, installed: r.installed }); }
      return done;
    } finally { installing = null; }
  })();
  return installing;
}
function isInstalling() { return !!installing; }
function missingRuntimes() { const m = []; if (!module.exports.vcInstalled()) m.push('vc'); if (!module.exports.dxInstalled()) m.push('dx'); return m; }
async function ensureRuntimes(emit = () => {}) {
  if (process.platform !== 'win32') return { action: 'skip' };
  const need = missingRuntimes();
  if (!need.length) return { action: 'ok' };
  const names = need.map(k => k === 'vc' ? 'Visual C++ 2015-2022 x64' : 'DirectX June 2010').join(' and ');
  emit('console', { source: 'preflight', line: `First-run setup: installing the ${names} runtime${need.length > 1 ? 's' : ''} the DayZ server needs (Windows asks for permission)…` });
  const done = await installMissing(need, emit);
  const still = missingRuntimes();
  return { action: still.length ? 'incomplete' : 'installed', done, still };
}
module.exports = { checks, exitVerdict, installVcRedist, vcInstalled, installDirectX, dxInstalled, installMissing, isInstalling, missingRuntimes, ensureRuntimes };
