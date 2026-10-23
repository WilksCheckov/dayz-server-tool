'use strict';
// Hardware and environment facts for the diagnostics export: why is this machine slow?
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const settings = require('./settings');

function ps(command, timeoutMs = 10000) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null);
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let out = '';
    const kill = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve(null); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => { clearTimeout(kill); resolve(out.trim()); });
    p.on('error', () => { clearTimeout(kill); resolve(null); });
  });
}
async function collect() {
  const p = settings.paths(); const gb = n => Math.round(n / 1073741824 * 10) / 10;
  const cpus = os.cpus();
  const out = {
    cpuModel: cpus[0] ? cpus[0].model.trim() : null, cores: cpus.length,
    totalMemGB: gb(os.totalmem()), freeMemGB: gb(os.freemem()), uptimeHours: Math.round(os.uptime() / 360) / 10
  };
  try { const st = fs.statfsSync(p.serverDir); out.diskFreeGB = gb(st.bavail * st.bsize); out.diskTotalGB = gb(st.blocks * st.bsize); } catch { /* ignore */ }
  const drive = (p.serverDir.match(/^([A-Za-z]):/) || [])[1];
  const [media, defenderNow, cpuLoad] = await Promise.all([
    drive ? ps(`$d=Get-Partition -DriveLetter ${drive} -ErrorAction SilentlyContinue | Get-Disk -ErrorAction SilentlyContinue; if($d){ $pd=Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object DeviceId -eq $d.Number; "$($pd.MediaType)|$($pd.BusType)|$($d.FriendlyName)" }`) : null,
    defenderStatus().catch(() => null),
    ps(`(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average).Average`)
  ]);
  if (media) { const [type, bus, name] = media.split('|'); out.disk = { mediaType: type || 'unknown', bus: bus || 'unknown', name: name || '' }; diskCache = out.disk; }
  if (defenderNow) out.defender = { present: defenderNow.present, realTime: defenderNow.realTime, serverFolderExcluded: defenderNow.excluded };
  if (cpuLoad) out.cpuLoadPercent = Number(cpuLoad) || null;
  return out;
}
// Windows Defender: present, real-time on, and whether the install folder is excluded (null when it cannot tell).
let defCache = null, defBusy = null;
function runQuick(file, args, timeoutMs = 15000) {
  return new Promise(resolve => {
    const p = spawn(file, args, { windowsHide: true }); let out = '';
    const kill = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve(null); }, timeoutMs);
    p.stdout.on('data', d => { out += d; }); p.on('close', () => { clearTimeout(kill); resolve(out); }); p.on('error', () => { clearTimeout(kill); resolve(null); });
  });
}
function defenderStatus({ refresh = false } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ present: false });
  if (defCache && !refresh) return Promise.resolve(defCache);
  if (defBusy) return defBusy;
  defBusy = (async () => {
    const dir = String(settings.load().installDir || '').replace(/[\\/]+$/, '');
    const svc = await runQuick('sc', ['query', 'WinDefend']);
    if (svc !== null && !/RUNNING/i.test(svc)) return (defCache = { present: false, checkedAt: Date.now() });
    const out = await ps("$m=Get-MpPreference -ErrorAction SilentlyContinue; if($m){ \"$($m.DisableRealtimeMonitoring)|\" + (($m.ExclusionPath) -join ';') }", 45000);
    if (!out) return (defCache = { present: true, realTime: null, excluded: null, checkedAt: Date.now(), note: 'Defender did not answer in time' });
    const [disabled, list] = [out.split('|')[0], out.split('|').slice(1).join('|')];
    const paths = list.split(';').map(x => x.trim()).filter(Boolean);
    const unknown = paths.some(p => /administrator/i.test(p));
    const excluded = unknown ? null : paths.some(p => { const q = p.replace(/[\\/]+$/, '').toLowerCase(); return dir.toLowerCase() === q || dir.toLowerCase().startsWith(q + '\\'); });
    return (defCache = { present: true, realTime: disabled !== 'True', excluded, checkedAt: Date.now(), dir });
  })().finally(() => { defBusy = null; });
  return defBusy;
}
function cachedDefender() { return defCache; }
let diskCache = null;
function cachedDisk() { return diskCache; }
// disk type of the server drive, looked up in the background (PowerShell storage cmdlets can take seconds)
async function checkDisk() {
  const p = settings.paths(); const drive = (p.serverDir.match(/^([A-Za-z]):/) || [])[1]; if (!drive) return null;
  const media = await ps(`$d=Get-Partition -DriveLetter ${drive} -ErrorAction SilentlyContinue | Get-Disk -ErrorAction SilentlyContinue; if($d){ $pd=Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object DeviceId -eq $d.Number; "$($pd.MediaType)|$($pd.BusType)|$($d.FriendlyName)" }`, 30000);
  if (media) { const [type, bus, name] = media.split('|'); diskCache = { mediaType: type || 'unknown', bus: bus || 'unknown', name: name || '' }; }
  return diskCache;
}
// Adds the install folder (and the server exe) to Defender's exclusions; Windows asks for permission.
async function addDefenderExclusion(emit = () => {}) {
  const dir = String(settings.load().installDir || '').replace(/[\\/]+$/, '');
  if (!dir) throw new Error('No install folder set.');
  const script = require('path').join(os.tmpdir(), 'dzat-defender-exclusion.ps1');
  fs.writeFileSync(script, `Add-MpPreference -ExclusionPath '${dir.replace(/'/g, "''")}'\r\nAdd-MpPreference -ExclusionProcess 'DayZServer_x64.exe'\r\n`);
  emit('console', { source: 'preflight', line: `Adding ${dir} to Windows Defender's exclusions (Windows asks for permission)…` });
  const code = await new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`], { windowsHide: true });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('exit', c => (c === 0 ? resolve(c) : reject(new Error(/cancel|denied/i.test(err) ? 'Windows permission was declined.' : `PowerShell exit code ${c}${err ? ': ' + err.trim().slice(0, 200) : ''}`))));
    p.on('error', reject);
  });
  try { fs.unlinkSync(script); } catch { /* ignore */ }
  const st = await defenderStatus({ refresh: true });
  emit('console', { source: 'preflight', line: st.excluded ? `${dir} is now excluded from Defender scans.` : 'The exclusion command finished; Defender does not report it yet (it may need a moment, or a policy blocks it).' });
  return { code, ...st };
}
module.exports = { collect, defenderStatus, cachedDefender, addDefenderExclusion, cachedDisk, checkDisk };
