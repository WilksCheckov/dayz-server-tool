'use strict';
// Audit log: who did what, from the app, the Discord bot and the web admin panel. Append-only JSON lines in
// userData/audit.log, rotated at 5 MB (one older copy kept).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let emitRef = () => {};
const file = () => path.join(app.getPath('userData'), 'audit.log');
// Secrets never reach the audit log: RCon and admin passwords in config text, password/token fields in arguments.
function redact(text) {
  return String(text)
    .replace(/(RConPassword\s+)[^\s\\"]+/gi, '$1***')
    .replace(/((?:password\w*|passwordAdmin|adminPassword)\s*=\s*)("[^"]*"|[^;\s\\]+)/gi, '$1"***"')
    .replace(/("(?:password|pass|passwordHash|passwordAdmin|token|secret|apiKey|webhookUrl|steamPass\w*|keyPem|certPem)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"***"');
}
function log(source, who, action, details) {
  const entry = { ts: Date.now(), source, who: who || '', action, details: details === undefined ? '' : redact(typeof details === 'string' ? details : JSON.stringify(details)).slice(0, 600) };
  try {
    try { if (fs.statSync(file()).size > 5 * 1024 * 1024) fs.renameSync(file(), file() + '.1'); } catch { /* none */ }
    fs.appendFileSync(file(), JSON.stringify(entry) + '\n');
  } catch { /* ignore */ }
  emitRef('audit:new', entry);
  return entry;
}
function list({ limit = 500, q = '', source = '' } = {}) {
  let lines = [];
  for (const f of [file() + '.1', file()]) { try { lines.push(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)); } catch { /* none */ } }
  let out = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (source) out = out.filter(e => e.source === source);
  if (q) { const s = q.toLowerCase(); out = out.filter(e => (e.who + ' ' + e.action + ' ' + e.details).toLowerCase().includes(s)); }
  return out.slice(-limit).reverse();
}
function exportCsv() {
  const rows = list({ limit: 100000 }).reverse();
  const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
  return 'time,source,who,action,details\n' + rows.map(e => [new Date(e.ts).toISOString(), e.source, e.who, e.action, e.details].map(esc).join(',')).join('\n');
}
function init(emit) {
  emitRef = emit;
  // one-time clean-up of entries written before redaction existed
  for (const f of [file(), file() + '.1']) { try { const raw = fs.readFileSync(f, 'utf8'); const clean = raw.split('\n').map(l => { if (!l) return l; try { const e = JSON.parse(l); e.details = redact(e.details || ''); return JSON.stringify(e); } catch { return l; } }).join('\n'); if (clean !== raw) fs.writeFileSync(f, clean); } catch { /* none */ } }
}
module.exports = { init, log, list, exportCsv, file, redact };
