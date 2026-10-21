'use strict';
// Crash reports: when the server exits unexpectedly, bundle the relevant logs, dump, config and launch line into a zip
// next to a JSON summary, and raise an alert with the log analyser's verdict.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const logs = require('./logs');
const mods = require('./mods');
const zip = require('./zip');
const alerts = require('./alerts');

let emitRef = () => {};
const exits = []; // timestamps of unexpected exits, for crash-loop detection

function dir() { return path.join(settings.load().installDir, 'crashes'); }
function stamp(d = new Date()) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; }

// Returns true when the exit pushed us over the crash-loop threshold.
function recordExit() {
  const th = alerts.cfg().thresholds;
  const now = Date.now();
  exits.push(now);
  while (exits.length && now - exits[0] > th.crashLoopMinutes * 60000) exits.shift();
  return exits.length >= th.crashLoopCount;
}
function resetLoop() { exits.length = 0; }

async function report({ code, startedAt, ranFor }) {
  const s = settings.load();
  const p = settings.paths(s);
  const out = dir();
  fs.mkdirSync(out, { recursive: true });
  const name = `crash_${stamp()}`;
  const staging = path.join(out, `_${name}`);
  fs.mkdirSync(staging, { recursive: true });
  const since = (startedAt || Date.now() - 3600000) - 60000;
  const collected = [];
  try {
    let files = [];
    try { files = fs.readdirSync(p.profilesDir).map(f => ({ f, full: path.join(p.profilesDir, f), st: fs.statSync(path.join(p.profilesDir, f)) })); } catch { /* no profiles */ }
    const pick = (re, max) => files.filter(x => re.test(x.f) && x.st.mtimeMs >= since).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, max);
    const chosen = [...pick(/\.rpt$/i, 1), ...pick(/\.adm$/i, 1), ...pick(/\.mdmp$/i, 2), ...pick(/^script.*\.log$/i, 2), ...pick(/crash|error/i, 2)];
    for (const x of chosen) { if (x.st.size < 200 * 1024 * 1024) { fs.copyFileSync(x.full, path.join(staging, x.f)); collected.push(x.f); } }
    if (fs.existsSync(p.configPath)) { fs.copyFileSync(p.configPath, path.join(staging, path.basename(p.configPath))); collected.push(path.basename(p.configPath)); }
    const ll = mods.launchLines(s);
    fs.writeFileSync(path.join(staging, 'launch.txt'), `DayZServer_x64.exe ${ll.full}\r\n\r\nMods:\r\n${s.mods.map(m => `${m.enabled === false ? '[off] ' : ''}${(s.modCache[m.id] || {}).title || m.id} (${m.id})${m.serverSide ? ' [serverMod]' : ''}`).join('\r\n')}\r\n`);
    let summary = null;
    const rpt = chosen.find(x => /\.rpt$/i.test(x.f));
    if (rpt) { try { summary = logs.summarize(rpt.f); } catch { summary = null; } }
    const meta = {
      name, at: Date.now(), exitCode: code, ranForSec: ranFor || null, files: collected,
      verdict: summary ? summary.verdict : { level: 'warn', text: 'No RPT found to analyse.' },
      topErrors: summary ? summary.groups.slice(0, 5).map(g => ({ label: g.label, count: g.count, sample: g.sample.slice(0, 200) })) : [],
      counts: summary ? summary.perCategory : []
    };
    fs.writeFileSync(path.join(staging, 'summary.json'), JSON.stringify(meta, null, 2));
    await zip.zipDir(staging, path.join(out, name + '.zip'));
    fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(meta, null, 2));
    emitRef('console', { source: 'crash', line: `Crash report saved: ${name}.zip (${collected.length} files)` });
    emitRef('crashes:changed', {});
    return meta;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function list() {
  const out = dir();
  let names = [];
  try { names = fs.readdirSync(out).filter(f => /^crash_.*\.json$/.test(f)); } catch { return { dir: out, reports: [] }; }
  const reports = names.map(f => { try { const m = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); let size = 0; try { size = fs.statSync(path.join(out, m.name + '.zip')).size; } catch { /* ignore */ } return { ...m, size }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.at - a.at);
  return { dir: out, reports };
}

function remove(name) {
  const out = dir();
  for (const ext of ['.zip', '.json']) { try { fs.unlinkSync(path.join(out, path.basename(name) + ext)); } catch { /* ignore */ } }
  emitRef('crashes:changed', {});
  return list();
}

function init(emit) { emitRef = emit; }

module.exports = { init, report, list, remove, dir, recordExit, resetLoop };
