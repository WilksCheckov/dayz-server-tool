'use strict';
// CPU cores: detect them, decide which ones each server instance may use, and pin the server process to them.
// Settings per instance: cpu = { mode: 'all' | 'auto' | 'manual', cores: [logical processor numbers], priority }.
//   all    - Windows decides (the default; best with a single server)
//   auto   - the cores are split between every instance set to auto, keeping core 0 for Windows and the tools
//            when the PC has 4 or more cores, so two servers never fight over the same core
//   manual - exactly the logical processors ticked
// Pinning and priority are set on the running process (no admin rights needed); -cpuCount follows the core count.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const settings = require('./settings');

let emitRef = () => {};
const cacheFile = () => path.join(require('electron').app.getPath('userData'), 'cpu.json');
let topo = null;

function ps(cmd, timeout = 20000) {
  return new Promise((res, rej) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout }, (e, out, err) => e ? rej(new Error(String(err || e.message).trim().split('\n')[0])) : res(String(out || '').trim())));
}

// Physical cores and logical processors. Windows numbers the two threads of a core next to each other (0-1, 2-3, …)
// when hyper-threading / SMT is on, which is what the grouping below relies on.
function fallback() { const l = os.cpus().length; return { logical: l, physical: l, smt: 1, name: (os.cpus()[0] || {}).model || 'CPU', guessed: true }; }
function topology() {
  if (topo) return topo;
  try { const t = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); if (t.logical === os.cpus().length) return (topo = t); } catch { /* not detected yet */ }
  return fallback();
}
async function detect() {
  try {
    const out = await ps('$c = @(Get-CimInstance Win32_Processor); "$(($c | Measure-Object NumberOfCores -Sum).Sum)|$(($c | Measure-Object NumberOfLogicalProcessors -Sum).Sum)|$($c[0].Name)"');
    const [phys, logi, name] = out.split('|');
    const physical = Number(phys) || os.cpus().length, logical = Number(logi) || os.cpus().length;
    topo = { physical, logical, smt: logical % physical === 0 ? logical / physical : 1, name: (name || '').trim(), sockets: undefined, at: Date.now() };
    try { fs.writeFileSync(cacheFile(), JSON.stringify(topo)); } catch { /* ignore */ }
  } catch { topo = fallback(); }
  return topo;
}
// logical processors of physical core c
const threadsOf = (t, c) => Array.from({ length: t.smt }, (_, k) => c * t.smt + k);

function cfg(s = settings.load()) { return { mode: 'all', cores: [], priority: 'normal', ...(s.cpu || {}) }; }

// The share of an auto instance: every instance set to auto (main one first), split over the cores left after
// keeping core 0 free. With more instances than cores, they share round-robin.
function autoCores(t = topology()) {
  let list = []; try { list = require('./instances').cpuPlan(); } catch { /* registry unreadable */ }
  const me = list.findIndex(x => x.self);
  if (me < 0) list = [{ self: true, mode: 'auto' }];
  const autos = list.filter(x => x.mode === 'auto');
  const idx = Math.max(0, autos.findIndex(x => x.self));
  const reserve = t.physical >= 4 ? 1 : 0;
  const avail = Array.from({ length: t.physical - reserve }, (_, i) => i + reserve);
  const n = autos.length;
  let mine;
  if (n <= avail.length) { const per = Math.floor(avail.length / n); const extra = avail.length - per * n; const start = idx * per + Math.min(idx, extra); mine = avail.slice(start, start + per + (idx < extra ? 1 : 0)); }
  else mine = [avail[idx % avail.length]];
  return mine.flatMap(c => threadsOf(t, c));
}

// Logical processors this instance's server may use, or null for all of them.
function chosen(s = settings.load()) {
  const c = cfg(s), t = topology();
  if (c.mode === 'manual') { const l = [...new Set((c.cores || []).map(Number).filter(n => n >= 0 && n < t.logical))].sort((a, b) => a - b); return l.length ? l : null; }
  if (c.mode === 'auto') return autoCores(t);
  return null;
}
// -cpuCount for the server: the number of cores it may use (unless set by hand on the Launch page)
function cpuCountArg(s = settings.load()) { if (Number(s.cpuCount) > 0) return Number(s.cpuCount); const l = chosen(s); return l ? l.length : 0; }

const PRIORITY = { normal: 'Normal', abovenormal: 'AboveNormal', high: 'High' };
async function apply(pid, s = settings.load()) {
  const c = cfg(s); const list = chosen(s);
  const pri = PRIORITY[c.priority] || 'Normal';
  if (!list && pri === 'Normal') return null;
  const mask = list ? list.filter(n => n < 63).reduce((m, n) => m | (1n << BigInt(n)), 0n).toString() : null;
  const cmd = `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop;` + (mask ? ` $p.ProcessorAffinity = [IntPtr][Int64]${mask};` : '') + (pri !== 'Normal' ? ` $p.PriorityClass = '${pri}';` : '');
  try {
    await ps(cmd);
    emitRef('console', { source: 'cpu', line: `Server pinned to ${list ? 'logical processor' + (list.length > 1 ? 's ' : ' ') + list.join(', ') : 'all processors'}${pri !== 'Normal' ? `, priority ${pri}` : ''}.` });
    return { list, priority: pri };
  } catch (e) { emitRef('console', { source: 'cpu', line: 'Could not set the CPU cores: ' + e.message }); return null; }
}

function status() { const t = topology(); return { topology: t, config: cfg(), chosen: chosen(), cpuCount: cpuCountArg(), autoPreview: autoCores(t) }; }

function init(emit) { emitRef = emit; if (!fs.existsSync(cacheFile())) detect().catch(() => {}); }

module.exports = { init, detect, topology, status, chosen, cpuCountArg, apply, threadsOf };
