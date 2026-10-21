'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const steamcmd = require('./steamcmd');
const server = require('./server');
const mods = require('./mods');
const logs = require('./logs');
const updater = require('./updater');
const backups = require('./backups');
const configs = require('./configs');
const rcon = require('./rcon');
const lists = require('./lists');
const discord = require('./discord');
const workshop = require('./workshop');
const website = require('./website');
const alerts = require('./alerts');
const health = require('./health');
const crashes = require('./crashes');
const players = require('./players');
const steambans = require('./steambans');
const economy = require('./economy');
const mission = require('./mission');
const tasks = require('./tasks');
const network = require('./network');
const offsite = require('./offsite');
const modcheck = require('./modcheck');
const profiles = require('./profiles');
const scheduler = require('./scheduler');

let win = null;
let tray = null;
let quitting = false;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

function appPrefs() { return { closeToTray: true, startMinimized: false, launchAtLogin: false, autoUpdate: true, autoStartServer: false, autoStartDelaySec: 10, theme: 'dark', autoFirewall: true, ...(settings.load().app || {}) }; }

// ----- system tray -----
function buildTray() {
  if (tray) return;
  try { tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 })); } catch { return; }
  tray.setToolTip('DayZ Server Tool');
  tray.on('click', () => showWindow());
  refreshTray();
}
function showWindow() { if (!win) createWindow(); else { win.show(); win.focus(); } }
function refreshTray() {
  if (!tray) return;
  const st = server.status();
  let h = null; try { h = health.current(); } catch { /* ignore */ }
  const players = h && h.players !== null && h.players !== undefined ? ` · ${h.players} players` : '';
  tray.setToolTip(`DayZ Server Tool — ${st.running ? 'server on' + players : 'server off'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DayZ Server Tool', click: () => showWindow() },
    { type: 'separator' },
    { label: st.running ? 'Stop server' : 'Start server', click: () => { try { st.running ? server.stop() : server.start(); } catch (e) { emit('console', { source: 'server', line: e.message }); } } },
    { label: 'Restart server', enabled: st.running, click: () => server.restart().catch(() => {}) },
    { label: 'Backup now', click: () => backups.create('tray').catch(() => {}) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
}

// ----- self-update (GitHub Releases via electron-updater) -----
let autoUpd = null;
let updateState = { status: 'idle', version: null, progress: null, error: null, current: app.getVersion() };
function setUpdate(partial) { updateState = { ...updateState, ...partial }; emit('update:state', updateState); }
function initUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpd = autoUpdater;
    autoUpd.autoDownload = false;
    autoUpd.autoInstallOnAppQuit = true;
    autoUpd.on('checking-for-update', () => setUpdate({ status: 'checking', error: null }));
    autoUpd.on('update-available', info => { setUpdate({ status: 'available', version: info.version }); alerts.alert('update-available', `DayZ Server Tool ${info.version} is available`, 'Open Settings to download and install it.'); });
    autoUpd.on('update-not-available', () => setUpdate({ status: 'none' }));
    autoUpd.on('download-progress', p => setUpdate({ status: 'downloading', progress: Math.round(p.percent) }));
    autoUpd.on('update-downloaded', info => setUpdate({ status: 'downloaded', version: info.version, progress: 100 }));
    autoUpd.on('error', e => setUpdate({ status: 'error', error: String(e && e.message || e).split('\n')[0] }));
    if (appPrefs().autoUpdate && app.isPackaged) { setTimeout(() => autoUpd.checkForUpdates().catch(() => {}), 8000); setInterval(() => autoUpd.checkForUpdates().catch(() => {}), 6 * 3600 * 1000); }
  } catch (e) { updateState.error = e.message; }
}

let firewallChecked = false;
// When the server comes up, make sure the Windows firewall allows its ports (one elevation prompt per session at most).
async function ensureFirewall() {
  if (firewallChecked || !appPrefs().autoFirewall) return;
  firewallChecked = true;
  try {
    const have = await network.rules();
    const need = network.ports().filter(p => !have.some(r => String(r.port) === String(p.port) && r.proto === p.proto && r.enabled));
    if (!need.length) return;
    emit('console', { source: 'network', line: 'Adding firewall rules for ' + need.map(p => p.proto + ' ' + p.port).join(', ') + ' (Windows asks for permission)...' });
    await network.addRules();
    emit('console', { source: 'network', line: 'Firewall rules added.' });
  } catch (e) { emit('console', { source: 'network', line: 'Firewall rules not added: ' + e.message + '. Add them on the Network page.' }); }
}
function emit(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  discord.notify(channel);
  if (channel === 'server:status') { refreshTray(); if (data && data.running) ensureFirewall(); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'DayZ Server Tool',
    autoHideMenuBar: true,
    icon: ICON,
    show: !appPrefs().startMinimized,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', e => { if (!quitting && appPrefs().closeToTray && !process.env.DZ_SCREENSHOT) { e.preventDefault(); win.hide(); buildTray(); } });
  win.on('closed', () => { win = null; });
  // Dev helper: DZ_SCREENSHOT=<file.png> captures the window after load and quits.
  if (process.env.DZ_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.DZ_THEME) await win.webContents.executeJavaScript('document.documentElement.dataset.theme = ' + JSON.stringify(process.env.DZ_THEME));
      if (process.env.DZ_PAGE) await win.webContents.executeJavaScript(`document.querySelector('[data-page="${process.env.DZ_PAGE}"]').click()`);
      await new Promise(r => setTimeout(r, Number(process.env.DZ_WAIT || 1500)));
      if (process.env.DZ_DEBUG) console.log('[shot] page:', await win.webContents.executeJavaScript("document.querySelector('.page.active').id + ' title=' + document.getElementById('pageTitle').textContent + ' navbtn=' + !!document.querySelector('[data-page=' + JSON.stringify(" + JSON.stringify(process.env.DZ_PAGE || '') + ") + ']')"));
      // An occluded window is not repainted, so bring it to the front before capturing.
      win.setAlwaysOnTop(true); win.show(); win.focus(); win.webContents.invalidate();
      await new Promise(r => setTimeout(r, 600));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.DZ_SCREENSHOT, img.toPNG());
      app.quit();
    }, 2500));
  }
}

// Wrap handlers so errors reach the renderer as { error } instead of opaque IPC failures.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
}

// Settings
handle('settings:get', () => ({ settings: settings.load(), paths: settings.paths() }));
handle('settings:set', (partial) => {
  const s = settings.save(partial);
  updater.schedule();
  scheduler.reschedule();
  try { mods.writeLaunchFiles(); } catch { /* ignore */ }
  return { settings: s, paths: settings.paths(s) };
});
handle('dialog:pickFolder', async (current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: current || undefined });
  return r.canceled ? null : r.filePaths[0];
});
handle('shell:openPath', (p) => shell.openPath(p));
handle('dialog:pickFile', async (opts) => { const r = await dialog.showOpenDialog(win, { properties: ['openFile'], ...(opts || {}) }); return r.canceled ? null : r.filePaths[0]; });
handle('shell:openExternal', (url) => shell.openExternal(url));

// Steam / install
handle('steam:status', () => steamcmd.status());
handle('steam:setCredentials', (c) => { steamcmd.setCredentials(c); return steamcmd.status(); });
handle('steam:installSteamcmd', () => steamcmd.ensureSteamcmd(emit));
handle('steam:updateServer', (opts) => steamcmd.updateServer(emit, opts || {}));
handle('steam:cancel', () => steamcmd.cancel());

// Server
handle('server:status', () => server.status());
handle('server:start', () => server.start());
handle('server:stop', () => server.stop());
handle('server:restart', () => server.restart());
handle('server:args', () => server.buildArgs(settings.load()));
handle('server:readConfig', () => {
  const p = settings.paths();
  return fs.existsSync(p.configPath) ? fs.readFileSync(p.configPath, 'utf8') : null;
});
handle('server:writeConfig', (text) => {
  const p = settings.paths();
  fs.mkdirSync(path.dirname(p.configPath), { recursive: true });
  fs.writeFileSync(p.configPath, text, 'utf8');
  return true;
});

// Mods
handle('mods:list', () => mods.list());
handle('mods:plan', (id) => mods.plan(id));
handle('mods:add', (id, opts) => mods.add(id, opts || {}));
handle('mods:update', (id) => mods.update(id));
handle('mods:updateAll', (onlyOutdated) => mods.updateAll(onlyOutdated !== false));
handle('mods:remove', (id, opts) => mods.remove(id, opts));
handle('mods:setFlags', (id, flags) => mods.setFlags(id, flags));
handle('mods:reorder', (ids) => mods.reorder(ids));
handle('mods:autoSort', () => mods.autoSort());
handle('mods:checkUpdates', () => mods.checkUpdates());
handle('mods:relink', (id) => mods.link(id));
handle('mods:details', (ids) => mods.fetchDetails(ids));
handle('mods:scanUnmanaged', () => mods.scanUnmanaged());
handle('mods:autoOrganize', () => mods.autoOrganize());
handle('mods:dependents', (id) => mods.dependents(id));
handle('mods:launchLines', () => mods.launchLines());
handle('mods:addMany', async (ids, opts) => {
  const failed = [];
  for (const id of ids) { try { await mods.add(id, opts || {}); } catch (e) { failed.push({ id, error: e.message }); } }
  return { added: ids.length - failed.length, failed };
});

// Health, alerts, crash reports
handle('health:current', () => health.current());
handle('health:history', (minutes) => health.history(minutes || 180));
handle('alerts:config', () => alerts.cfg());
handle('alerts:recent', () => alerts.recent());
handle('alerts:test', () => alerts.alert('test', 'Test alert from DayZ Server Tool', 'If you can read this, alerts are wired up.', { force: true }));
handle('crashes:list', () => crashes.list());
handle('crashes:remove', (name) => crashes.remove(name));
handle('crashes:openFolder', () => { const d = crashes.dir(); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
handle('crashes:post', async (name) => { const r = crashes.list().reports.find(x => x.name === name); if (!r) throw new Error('Report not found'); return alerts.alert('crash', `Crash report ${r.name}`, `${r.verdict.text}\n${r.topErrors.map(g => g.label + ' ×' + g.count + ': ' + g.sample).join('\n')}`, { force: true }); });

// Player database
handle('players:all', (q) => players.all(q || {}));
handle('players:get', (key) => players.get(key));
handle('players:setNote', (key, text) => players.setNote(key, text));
handle('players:remove', (key) => players.remove(key));
handle('players:stats', () => players.stats());
handle('players:rebuild', () => players.rebuild());
handle('players:ingest', () => players.ingest());
handle('players:discordRoles', (ids) => discord.rolesFor(ids || []));
handle('steam:state', () => steambans.state());
handle('steam:all', () => steambans.all());
handle('steam:check', (id) => steambans.check(id));
handle('steam:checkAll', () => steambans.checkAll());

// Economy editor
handle('economy:files', () => economy.files());
handle('economy:limits', () => economy.limits());
handle('economy:loadTypes', (abs) => economy.loadTypes(abs));
handle('economy:saveTypes', (abs, rows) => economy.saveTypes(abs, rows));
handle('economy:loadEvents', (abs) => economy.loadEvents(abs));
handle('economy:saveEvents', (abs, rows) => economy.saveEvents(abs, rows));
handle('economy:loadSpawnable', (abs) => economy.loadSpawnable(abs));
handle('economy:saveSpawnable', (abs, rows) => economy.saveSpawnable(abs, rows));

// App preferences + self-update
handle('app:prefs', () => ({ ...appPrefs(), version: app.getVersion(), packaged: app.isPackaged, dataDir: app.getPath('userData'), loginItem: app.getLoginItemSettings().openAtLogin }));
handle('app:setPrefs', (prefs) => {
  const p = { ...appPrefs(), ...prefs };
  settings.save({ app: p });
  try { app.setLoginItemSettings({ openAtLogin: !!p.launchAtLogin, args: p.startMinimized ? ['--minimized'] : [] }); } catch { /* ignore */ }
  if (p.closeToTray) buildTray(); else if (tray) { tray.destroy(); tray = null; }
  return p;
});
handle('app:openDataDir', () => shell.openPath(app.getPath('userData')));
handle('app:exportSettings', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: 'dayz-server-tool-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled) return null;
  const s = { ...settings.load() }; if (s.discord) s.discord = { ...s.discord, token: '' }; if (s.rcon) s.rcon = { ...s.rcon, password: '' };
  fs.writeFileSync(r.filePath, JSON.stringify(s, null, 2)); return r.filePath;
});
handle('app:importSettings', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  settings.save(data); return true;
});
handle('update:state', () => updateState);
handle('update:check', async () => { if (!autoUpd) throw new Error('Updater not available.'); if (!app.isPackaged) throw new Error('Updates only work in the installed app, not when running from source.'); await autoUpd.checkForUpdates(); return updateState; });
handle('update:download', async () => { if (!autoUpd) throw new Error('Updater not available.'); await autoUpd.downloadUpdate(); return updateState; });
handle('update:install', () => { if (!autoUpd) throw new Error('Updater not available.'); quitting = true; autoUpd.quitAndInstall(); return true; });

// Mission tools
handle('mission:list', () => mission.list());
handle('mission:switch', (name) => mission.switchMission(name));
handle('mission:wipe', (kind) => mission.wipe(kind));
handle('mission:gameplay', () => mission.gameplay());
handle('mission:saveGameplay', (changes) => mission.saveGameplay(changes));
handle('mission:mapInfo', () => mission.mapInfo());
handle('mission:setMapImage', (src) => mission.setMapImage(src));
handle('mission:openMapsDir', () => { const d = mission.mapInfo().mapsDir; fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });

// Scheduled tasks
handle('tasks:all', () => ({ tasks: tasks.all(), next: tasks.nextRuns(), types: tasks.TYPES }));
handle('tasks:upsert', (t) => tasks.upsert(t));
handle('tasks:remove', (id) => tasks.remove(id));
handle('tasks:run', (id) => { const t = tasks.all().find(x => x.id === id); if (!t) throw new Error('Task not found'); return tasks.runTask(t, 'manual'); });

// Network helper
handle('network:report', () => network.report());
handle('network:addRules', () => network.addRules());
handle('network:removeRules', () => network.removeRules());

// Off-site backups
handle('offsite:config', () => offsite.cfg());
handle('offsite:test', (c) => offsite.testFtp(c));

// Mod checks
handle('mods:check', () => modcheck.run());

// Profiles
handle('profiles:list', () => profiles.list());
handle('profiles:create', (name, copyFrom) => profiles.create(name, { copyFrom }));
handle('profiles:remove', (name) => profiles.remove(name));
handle('profiles:activate', (name) => profiles.activate(name));

// Website
handle('website:status', () => website.status());
handle('website:start', (port) => website.start(port));
handle('website:stop', () => website.stop());
handle('website:preview', (slug) => website.preview(slug));
handle('website:defaults', () => website.DEFAULT_PAGES);
handle('website:files', () => website.listFiles());
handle('website:addFiles', async (subdir) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'Add files to the website folder' });
  if (r.canceled || !r.filePaths.length) return website.listFiles();
  return website.addFiles(r.filePaths, subdir || '');
});
handle('website:removeFile', (rel) => website.removeFile(rel));
handle('website:starter', (kind) => website.writeStarter(kind));
handle('website:importSite', (src) => website.importSite(src));
handle('website:pickSite', async (kind) => {
  const r = await dialog.showOpenDialog(win, kind === 'zip'
    ? { properties: ['openFile'], filters: [{ name: 'Zip archive', extensions: ['zip'] }], title: 'Choose a .zip of your website' }
    : { properties: ['openDirectory'], title: 'Choose your website folder (must contain index.html)' });
  if (r.canceled || !r.filePaths.length) return null;
  return website.importSite(r.filePaths[0]);
});
handle('website:removeSite', () => website.removeSite());
handle('website:openSiteFolder', () => { const d = website.siteDir(); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
handle('website:openFolder', () => { const d = website.publicDir(); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });

// Workshop browser
handle('workshop:search', (q) => workshop.search(q || {}));
handle('workshop:details', (id) => workshop.details(id));
handle('workshop:collection', (id) => workshop.collection(id));
handle('workshop:meta', () => ({ tags: workshop.TAGS, sorts: workshop.SORTS }));
handle('mods:importUnmanaged', (items) => mods.importUnmanaged(items));

// Config editor
handle('configs:list', () => configs.listFiles());
handle('configs:read', (file) => configs.read(file));
handle('configs:write', (file, text) => configs.write(file, text));
handle('configs:create', (file, text) => configs.createFile(file, text));
handle('configs:validate', (file, text) => configs.validate(file, text));
handle('configs:validateAll', () => configs.validateAll());

// RCon (BattlEye)
handle('rcon:status', () => rcon.status());
handle('rcon:connect', (opts) => rcon.connect(opts || {}));
handle('rcon:disconnect', () => rcon.disconnect());
handle('rcon:command', (cmd) => rcon.command(cmd));
handle('rcon:players', () => rcon.players());
handle('rcon:bans', () => rcon.bans());
handle('rcon:say', (msg, player) => rcon.say(msg, player ?? -1));
handle('rcon:kick', (num, reason) => rcon.kick(num, reason));
handle('rcon:ban', (num, minutes, reason) => rcon.ban(num, minutes, reason));
handle('rcon:addBan', (guid, minutes, reason) => rcon.addBan(guid, minutes, reason));
handle('rcon:removeBan', (num) => rcon.removeBan(num));

// Player lists
handle('lists:all', () => lists.allLists());
handle('lists:read', (kind) => lists.read(kind));
handle('lists:add', (kind, entry, meta) => lists.add(kind, entry, meta));
handle('lists:remove', (kind, id) => lists.remove(kind, id));
handle('lists:recentPlayers', () => lists.recentPlayers());
handle('lists:note', (id, meta) => lists.saveNote(id, meta));

// Discord bot
handle('discord:status', () => discord.status());
handle('discord:start', () => discord.start());
handle('discord:stop', () => discord.stop());
handle('discord:applyLiveLog', () => discord.applyLiveLog());
handle('discord:commands', () => discord.buildCommands().map(c => ({ name: c.name, description: c.description, subs: (c.options || []).filter(o => o.type === 1).map(o => o.name) })));

// Backups
handle('backups:state', () => backups.state());
handle('backups:list', () => backups.list());
handle('backups:create', (label) => backups.create(label || 'manual'));
handle('backups:remove', (name) => backups.remove(name));
handle('backups:restore', async (name) => {
  if (server.status().running) throw new Error('Stop the server before restoring a backup.');
  return backups.restore(name);
});

// Scheduler (restarts)
handle('scheduler:state', () => scheduler.state());
handle('scheduler:restartNow', () => scheduler.restartNow());

// Logs
handle('logs:list', () => logs.list());
handle('logs:read', (name, maxBytes) => logs.read(name, maxBytes));
handle('logs:summary', (name) => logs.summarize(name));

// Updater
handle('updater:state', () => updater.state());
handle('updater:runNow', (opts) => updater.runNow(opts || {}));
handle('updater:check', () => updater.check());
handle('updater:runIfNeeded', () => updater.runIfNeeded());

// Keep settings from the previous app name (the userData folder is named after productName).
try {
  const newDir = app.getPath('userData');
  const oldDir = path.join(path.dirname(newDir), 'DayZ Admin Tool');
  if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) fs.renameSync(oldDir, newDir);
} catch { /* ignore */ }

app.whenReady().then(() => {
  alerts.init(emit);
  crashes.init(emit);
  mods.init(emit);
  server.init(emit);
  updater.init(emit);
  backups.init(emit);
  scheduler.init(emit);
  rcon.init(emit);
  discord.init(emit);
  website.init(emit);
  health.init(emit);
  initUpdater();
  mission.init(emit); tasks.init(emit); offsite.init(emit);
  // Optional: bring the DayZ server up a few seconds after the tool starts (for unattended reboots).
  if (appPrefs().autoStartServer) setTimeout(() => { try { if (!server.status().running) { emit('console', { source: 'server', line: 'Auto-starting the server (Settings → start with the tool).' }); server.start(); } } catch (e) { emit('console', { source: 'server', line: 'Auto-start failed: ' + e.message }); } }, Math.max(3, Number(appPrefs().autoStartDelaySec) || 10) * 1000);
  if (appPrefs().closeToTray || process.argv.includes('--minimized')) buildTray();
  setInterval(refreshTray, 15000);
  players.init(emit);
  steambans.init(emit);
  createWindow();
});

app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('before-quit', () => { quitting = true; });
app.on('activate', () => showWindow());
