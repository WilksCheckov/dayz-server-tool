'use strict';
// Simple JSON settings store kept in Electron's userData folder.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  installDir: 'C:\\DayZServer',
  steamUser: '',
  serverAppId: 223350, // 1042420 = Experimental server
  workshopAppId: 221100,
  port: 2302,
  configFile: 'serverDZ.cfg',
  profilesDir: 'profiles',
  cpuCount: 0,
  extraParams: '-dologs -adminlog -netlog -freezecheck',
  autoRestart: true,
  mods: [],            // [{ id: '1559212036', enabled: true, serverSide: false }]
  modCache: {},        // id -> { title, timeUpdated, folderName, keys: [] }
  autoUpdate: { enabled: false, intervalHours: 6 },
  lastUpdateCheck: null
};

let cache = null;

// Each server profile has its own settings file (see profiles.js); "default" is settings.json.
function file() {
  try { return require('./profiles').settingsFile(); } catch { return path.join(app.getPath('userData'), 'settings.json'); }
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(partial) {
  const s = load();
  Object.assign(s, partial);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
  return s;
}

// Derived absolute paths.
function paths(s = load()) {
  const steamcmdDir = path.join(s.installDir, 'steamcmd');
  const serverDir = path.join(s.installDir, 'server');
  return {
    steamcmdDir,
    steamcmdExe: path.join(steamcmdDir, 'steamcmd.exe'),
    serverDir,
    serverExe: path.join(serverDir, 'DayZServer_x64.exe'),
    profilesDir: path.isAbsolute(s.profilesDir) ? s.profilesDir : path.join(serverDir, s.profilesDir),
    configPath: path.isAbsolute(s.configFile) ? s.configFile : path.join(serverDir, s.configFile),
    keysDir: path.join(serverDir, 'keys'),
    workshopDir: path.join(steamcmdDir, 'steamapps', 'workshop', 'content', String(s.workshopAppId)),
    workshopAcf: path.join(steamcmdDir, 'steamapps', 'workshop', `appworkshop_${s.workshopAppId}.acf`),
    serverManifest: path.join(serverDir, 'steamapps', `appmanifest_${s.serverAppId}.acf`)
  };
}

module.exports = { DEFAULTS, load, save, paths };
