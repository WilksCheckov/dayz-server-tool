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
  const [media, defender, cpuLoad] = await Promise.all([
    drive ? ps(`$d=Get-Partition -DriveLetter ${drive} -ErrorAction SilentlyContinue | Get-Disk -ErrorAction SilentlyContinue; if($d){ $pd=Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object DeviceId -eq $d.Number; "$($pd.MediaType)|$($pd.BusType)|$($d.FriendlyName)" }`) : null,
    ps(`$m=Get-MpPreference -ErrorAction SilentlyContinue; $s=Get-MpComputerStatus -ErrorAction SilentlyContinue; if($m){ "$($s.RealTimeProtectionEnabled)|$(($m.ExclusionPath | Where-Object { '${settings.load().installDir.replace(/'/g, "''")}'.StartsWith($_, 'OrdinalIgnoreCase') }) -ne $null)" }`),
    ps(`(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average).Average`)
  ]);
  if (media) { const [type, bus, name] = media.split('|'); out.disk = { mediaType: type || 'unknown', bus: bus || 'unknown', name: name || '' }; }
  if (defender) { const [rt, excluded] = defender.split('|'); out.defender = { realTime: rt === 'True', serverFolderExcluded: excluded === 'True' }; }
  if (cpuLoad) out.cpuLoadPercent = Number(cpuLoad) || null;
  return out;
}
module.exports = { collect };
