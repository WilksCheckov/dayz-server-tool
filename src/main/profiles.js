'use strict';
// Server profiles: each profile is its own settings file. Switching relaunches the tool so every module starts clean.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function file() { return path.join(app.getPath('userData'), 'profiles.json'); }
function load() { try { return { active: 'default', list: ['default'], ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch { return { active: 'default', list: ['default'] }; } }
function save(p) { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(p, null, 2)); }

// Settings file for a profile. "default" keeps the original settings.json so existing installs carry on unchanged.
function settingsFile(name = load().active) { return path.join(app.getPath('userData'), name === 'default' ? 'settings.json' : `settings.${name}.json`); }
function clean(name) { return String(name || '').trim().replace(/[^a-z0-9 _-]/gi, '').slice(0, 40); }

function list() { const p = load(); return { active: p.active, profiles: p.list.map(n => ({ name: n, active: n === p.active, exists: fs.existsSync(settingsFile(n)) })) }; }

function create(name, { copyFrom = null } = {}) {
  name = clean(name); if (!name) throw new Error('Give the profile a name.');
  const p = load();
  if (p.list.includes(name)) throw new Error('A profile with that name already exists.');
  const dest = settingsFile(name);
  if (copyFrom && fs.existsSync(settingsFile(copyFrom))) fs.copyFileSync(settingsFile(copyFrom), dest);
  else fs.writeFileSync(dest, JSON.stringify({ installDir: `C:\\DayZServer-${name}`, port: 2302 }, null, 2));
  p.list.push(name); save(p);
  return list();
}
function remove(name) {
  const p = load();
  if (name === 'default') throw new Error('The default profile cannot be deleted.');
  if (name === p.active) throw new Error('Switch to another profile before deleting this one.');
  p.list = p.list.filter(n => n !== name); save(p);
  try { fs.unlinkSync(settingsFile(name)); } catch { /* ignore */ }
  return list();
}
function activate(name) {
  const p = load();
  if (!p.list.includes(name)) throw new Error('Unknown profile.');
  p.active = name; save(p);
  app.relaunch(); app.exit(0);
}

module.exports = { list, create, remove, activate, settingsFile, load };
