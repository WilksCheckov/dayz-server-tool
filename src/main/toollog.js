'use strict';
// Plain-text log of what the tool does and any error it hits: userData/tool.log (rotated at 2 MB, one old copy kept).
// Console lines from every module, failed IPC calls, uncaught errors and renderer errors all land here.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let file = null;
function init() {
  try { file = path.join(app.getPath('userData'), 'tool.log'); write('info', `--- DayZ Server Tool ${app.getVersion()} started (${process.platform} ${process.arch}, Electron ${process.versions.electron}) ---`); } catch { file = null; }
  process.on('uncaughtException', e => { write('error', `uncaughtException: ${e && e.stack || e}`); });
  process.on('unhandledRejection', e => { write('error', `unhandledRejection: ${e && e.stack || e}`); });
}
function write(level, msg) {
  if (!file) return;
  try {
    const line = `${new Date().toISOString()} [${level}] ${String(msg).replace(/\r?\n/g, ' | ')}\n`;
    try { if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1'); } catch { /* no file yet */ }
    fs.appendFileSync(file, line);
  } catch { /* ignore */ }
}
const info = m => write('info', m);
const warn = m => write('warn', m);
const error = m => write('error', m);
module.exports = { init, write, info, warn, error, path: () => file };
