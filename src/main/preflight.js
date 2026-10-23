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
  const out = { ok: [], warn: [], error: [] };
  const err = t => out.error.push(t), warn = t => out.warn.push(t), ok = t => out.ok.push(t);
  // install
  if (!fs.existsSync(p.serverExe)) err('DayZServer_x64.exe is missing: install or validate the server on the Installation page.');
  else {
    try { if (fs.statSync(p.serverExe).size < 1024 * 1024) err('DayZServer_x64.exe is only partly downloaded: validate the server files.'); } catch { /* ignore */ }
    for (const dll of ['steam_api64.dll', 'steamclient64.dll', 'tier0_s64.dll', 'vstdlib_s64.dll']) if (!fs.existsSync(path.join(p.serverDir, dll))) err(`${dll} is missing next to the server exe: validate the server files.`);
    if (!fs.existsSync(path.join(p.serverDir, 'dta')) || !fs.existsSync(path.join(p.serverDir, 'addons'))) err('The server\'s dta or addons folder is missing: the install is incomplete, validate the server files.');
  }
  // runtime the server needs (DayZ links the 2015-2022 x64 C++ runtime)
  if (process.platform === 'win32') {
    if (regInstalled('HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64') || regInstalled('HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64')) ok('Visual C++ 2015-2022 x64 runtime installed');
    else err('The Microsoft Visual C++ 2015-2022 x64 runtime is not installed; the server exits at once without it (exit code 0xC0000135). Install vc_redist.x64.exe from Microsoft, then start again.');
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
      if (!fs.existsSync(md)) err(`Mission folder not found: mpmissions\\${mission} (check the template line in serverDZ.cfg).`);
      else {
        if (!fs.existsSync(path.join(md, 'init.c'))) err(`mpmissions\\${mission}\\init.c is missing.`);
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
  // disk space (best effort)
  try { const st = fs.statfsSync ? fs.statfsSync(p.serverDir) : null; if (st && st.bavail * st.bsize < 2 * 1024 * 1024 * 1024) warn('Less than 2 GB free on the server drive; logs and persistence may fail to write.'); } catch { /* ignore */ }
  return out;
}

// What an exit code means when the server stopped before writing an RPT.
const CODES = {
  '-1073741515': ['A required DLL is missing (STATUS_DLL_NOT_FOUND, 0xC0000135). Almost always the Microsoft Visual C++ 2015-2022 x64 runtime: install vc_redist.x64.exe and start again.'],
  '3221225781': ['A required DLL is missing (STATUS_DLL_NOT_FOUND, 0xC0000135). Almost always the Microsoft Visual C++ 2015-2022 x64 runtime: install vc_redist.x64.exe and start again.'],
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
    const ps = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList '/install','/passive','/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`], { windowsHide: true });
    let err = ''; ps.stderr.on('data', d => err += d);
    ps.on('exit', code => (code === 0 || code === 3010 || code === 1638) ? resolve(code) : reject(new Error(code === 1 && /canceled|cancelled|denied/i.test(err) ? 'Windows permission was declined.' : `Installer exit code ${code}${err ? ': ' + err.trim().slice(0, 200) : ''}`)));
    ps.on('error', reject);
  });
  const okNow = vcInstalled();
  emit('console', { source: 'preflight', line: okNow ? 'Visual C++ runtime installed. Start the server again.' : 'The installer finished but the runtime still does not show as installed; a reboot may be needed.' });
  return { installed: okNow, action: 'installed' };
}
module.exports = { checks, exitVerdict, installVcRedist, vcInstalled };
