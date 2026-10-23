'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
// Keep the data from a previous app name (the userData folder is named after productName). Electron creates the new
// folder for its caches before this code runs, so "does it exist" is no test: copy the tool's own files across once,
// whenever the old folder has settings and the new one has not been migrated yet. settings.json is only taken from the
// old folder while the new one still holds untouched defaults.
try {
  const newDir = app.getPath('userData');
  const marker = path.join(newDir, '.migrated');
  if (!fs.existsSync(marker)) {
    for (const old of ['DayZ Server Tool', 'DayZ Admin Tool']) {
      const oldDir = path.join(path.dirname(newDir), old);
      if (!fs.existsSync(path.join(oldDir, 'settings.json'))) continue;
      fs.mkdirSync(newDir, { recursive: true });
      const newSettings = path.join(newDir, 'settings.json');
      let fresh = true; try { const cur = JSON.parse(fs.readFileSync(newSettings, 'utf8')); fresh = !cur.mods || !cur.mods.length && !cur.rcon && !cur.discord; } catch { fresh = true; }
      for (const name of fs.readdirSync(oldDir)) {
        if (!/^(settings\.json|.*\.json|audit\.log|tool\.log(\.\d+)?|\.updaterId)$/.test(name)) continue;
        const src = path.join(oldDir, name), dst = path.join(newDir, name);
        if (name === 'settings.json' ? !fresh : fs.existsSync(dst)) continue;
        try { fs.copyFileSync(src, dst); } catch { /* keep going */ }
      }
      fs.writeFileSync(marker, old + ' ' + new Date().toISOString());
      break;
    }
  }
} catch { /* ignore */ }
const settings = require('./settings');
const steamcmd = require('./steamcmd');
const server = require('./server');
const mods = require('./mods');
const logs = require('./logs');
const toollog = require('./toollog');
const servererrors = require('./servererrors');
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
const accounts = require('./accounts');
const domain = require('./domain');
const heat = require('./heat');
const lootmap = require('./lootmap');
const stats = require('./stats');
const audit = require('./audit');
const combat = require('./combat');
const deathlog = require('./deathlog');
const anticheat = require('./anticheat');
const upnp = require('./upnp');
const zip = require('./zip');
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

function appPrefs() { return { closeToTray: true, startMinimized: false, launchAtLogin: false, autoUpdate: true, autoStartServer: false, autoStartDelaySec: 10, theme: 'dark', autoFirewall: true, showServerWindow: false, ...(settings.load().app || {}) }; }

// ----- system tray -----
function buildTray() {
  if (tray) return;
  try { tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 })); } catch { return; }
  tray.setToolTip('DayZ Admin Tools');
  tray.on('click', () => showWindow());
  refreshTray();
}
function showWindow() { if (!win) createWindow(); else { win.show(); win.focus(); } }
function refreshTray() {
  if (!tray) return;
  const st = server.status();
  let h = null; try { h = health.current(); } catch { /* ignore */ }
  const players = h && h.players !== null && h.players !== undefined ? ` · ${h.players} players` : '';
  tray.setToolTip(`DayZ Admin Tools — ${st.running ? 'server on' + players : 'server off'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DayZ Admin Tools', click: () => showWindow() },
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
    autoUpd.on('update-available', info => { setUpdate({ status: 'available', version: info.version }); alerts.alert('update-available', `DayZ Admin Tools ${info.version} is available`, 'Open Settings to download and install it.'); });
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
  const key = network.ports().map(p => p.proto + p.port).join(',');
  if ((settings.load().firewallVerified || '') === key) return; // verified before for exactly these ports: no check, no prompt
  try {
    let have; try { have = await network.rules(); } catch (e) { emit('console', { source: 'network', line: e.message + ' Skipping the automatic firewall rules; add them on the Network page if players cannot connect.' }); return; }
    const need = network.ports().filter(p => !have.some(r => String(r.port) === String(p.port) && r.proto === p.proto && r.enabled));
    if (!need.length) { settings.save({ firewallVerified: key }); return; }
    emit('console', { source: 'network', line: 'Adding firewall rules for ' + need.map(p => p.proto + ' ' + p.port).join(', ') + ' (Windows asks for permission)...' });
    await network.addRules();
    settings.save({ firewallVerified: key });
    emit('console', { source: 'network', line: 'Firewall rules added.' });
  } catch (e) { emit('console', { source: 'network', line: 'Firewall rules not added: ' + e.message + '. Add them on the Network page.' }); }
}
function emit(channel, data) {
  if (channel === 'console' && data) { try { servererrors.handleLine(data.source, data.line); } catch { /* ignore */ } if ((data.source === 'rpt' || data.source === 'server') && /BattlEye/i.test(data.line || '')) { try { const k = combat.beKick(data.line); if (k) audit.log('system', 'BattlEye', 'kick', `${k.name}: ${k.reason}`); } catch { /* ignore */ } } }
  if (channel === 'console' && data) toollog.write(/error|fail|invalid|exception|cannot/i.test(data.line || '') && !/(0 failed)|0 error|no error|failed: 0\b|fails?: ?0\b/i.test(data.line || '') ? 'error' : 'info', `[${data.source}] ${data.line}`);
  else if (channel === 'alerts:new' && data) toollog.warn(`alert ${data.kind}: ${data.title} ${data.details || ''}`);
  if (channel === 'health:sample' && data) stats.recordSample(data);
  if (channel === 'alerts:new' && data && (data.kind === 'crash' || data.kind === 'crash-loop')) stats.recordCrash();
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  discord.notify(channel);
  if (channel === 'server:status') { refreshTray(); if (data && !data.running) { try { deathlog.housekeeping(); } catch { /* ignore */ } try { anticheat.housekeeping(); } catch { /* ignore */ } rcon.stopAuto(); if (rcon.status().connected) rcon.disconnect(true); } if (data && data.running) { rcon.autoConnectLoop(); servererrors.reset(); ensureFirewall(); setTimeout(() => network.webStacks().then(w => { const vuln = (w.found || []).filter(f => f.vulnerable); if (vuln.length && w.running.length) alerts.alert('web-stack', 'Vulnerable PHP is running on this machine', `${vuln.map(f => `${f.name} PHP ${f.version} (fix: ${f.fixed})`).join(', ')} with ${w.running.join(', ')} running. Stop it or update it; see the Network page.`); }).catch(() => {}), 20000); setTimeout(() => logs.cleanupIfEnabled(emit), 15000); } }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'DayZ Admin Tools',
    autoHideMenuBar: true,
    icon: ICON,
    show: !appPrefs().startMinimized,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // The window only ever shows our own page: block navigation away from it and open links outside instead.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', e => { if (!quitting && appPrefs().closeToTray && !process.env.DZ_SCREENSHOT) { e.preventDefault(); win.hide(); buildTray(); } });
  win.on('closed', () => { win = null; });
  // Dev helper: DZ_SCREENSHOT=<file.png> captures the window after load and quits.
  if (process.env.DZ_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => { toollog.info(`startup: window loaded after ${Date.now() - T0} ms; init times: ${initTimes.filter(([, ms]) => ms >= 5).sort((a, b) => b[1] - a[1]).map(([n, ms]) => n + ' ' + ms + 'ms').join(', ') || 'all under 5 ms'}`); });
  win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.DZ_THEME) await win.webContents.executeJavaScript('document.documentElement.dataset.theme = ' + JSON.stringify(process.env.DZ_THEME));
      if (process.env.DZ_PAGE) await win.webContents.executeJavaScript(`document.querySelector('[data-page="${process.env.DZ_PAGE}"]').click()`);
      if (process.env.DZ_SIZE) { const [w, h] = process.env.DZ_SIZE.split('x').map(Number); win.setSize(w, h); await new Promise(r => setTimeout(r, 300)); }
      if (process.env.DZ_CLICK) for (const sel of process.env.DZ_CLICK.split('||')) { await win.webContents.executeJavaScript(`(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); })()`); await new Promise(r => setTimeout(r, 700)); }
      if (process.env.DZ_SCROLL) await win.webContents.executeJavaScript(`document.querySelector('.page.active').scrollTop = ${Number(process.env.DZ_SCROLL)}`);
      if (process.env.DZ_JS) { await win.webContents.executeJavaScript(process.env.DZ_JS); await new Promise(r => setTimeout(r, 800)); }
      if (process.env.DZ_FAKE_LINES) for (const l of process.env.DZ_FAKE_LINES.split('||')) { const [source, line] = l.split('::'); emit('console', { source, line }); }
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
const AUDITED = /^(server:(start|stop|restart)|lists:(add|remove)|mission:(wipe|switch|saveGameplay)|configs:(write|createFile)|cfgform:write|economy:(save\w+|createFile|unregisterFile)|backups:(create|restore|remove)|rcon:(kick|ban|say|command|addBan)|tasks:(upsert|remove|run)|mods:(add|remove|update|updateAll|reorder|toggle|setServerSide)|steam:setCredentials|discord:(start|stop)|website:(start|stop|importSite|removeSite)|updates?:(runNow|run)|app:setPrefs|settings:(set|import)|domain:(save|issue)|heat:(clear|rebuild)|players:(remove|rebuild)|logs:cleanup)$/;
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(...args);
      if (AUDITED.test(channel)) { try { const detail = channel === 'steam:setCredentials' ? { user: args[0] && args[0].user } : channel === 'settings:set' ? Object.keys(args[0] || {}) : args.filter(a => typeof a !== 'object' || Array.isArray(a) ? true : JSON.stringify(a).length < 300); audit.log('app', 'local', channel, detail); } catch { /* ignore */ } }
      return { ok: true, data };
    }
    catch (e) { toollog.error(`ipc ${channel}: ${e && e.stack || e}`); return { ok: false, error: e.message || String(e) }; }
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
// Only folders and files inside the server install or the tool's data folder may be opened from the page.
function insideKnownRoots(p) { const abs = path.resolve(String(p || '')); const roots = [settings.load().installDir, app.getPath('userData'), settings.paths().serverDir].filter(Boolean).map(r => path.resolve(r)); return roots.some(r => abs === r || abs.startsWith(r + path.sep)); }
handle('shell:openPath', (p) => { if (!insideKnownRoots(p)) throw new Error('Refusing to open a path outside the server or data folder.'); return shell.openPath(p); });
const pickedFiles = new Set(); // files the user chose through a dialog this session; the only ones fs:readText may read
handle('dialog:pickFile', async (opts) => { const r = await dialog.showOpenDialog(win, { properties: ['openFile'], ...(opts || {}) }); if (r.canceled) return null; pickedFiles.add(path.resolve(r.filePaths[0])); return r.filePaths[0]; });
handle('shell:openExternal', (url) => { if (!/^https?:\/\/[^\s]+$/i.test(String(url || ''))) throw new Error('Only http(s) links can be opened.'); return shell.openExternal(url); });

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
handle('server:preflight', () => require('./preflight').checks());
handle('server:installVcRedist', () => require('./preflight').installVcRedist(emit));
handle('server:readConfig', () => {
  const p = settings.paths();
  return fs.existsSync(p.configPath) ? fs.readFileSync(p.configPath, 'utf8') : null;
});
handle('cfgform:read', () => configs.cfgFormRead());
handle('cfgform:write', (changes) => configs.cfgFormWrite(changes || {}));

// Mods
handle('mods:list', () => mods.list());
handle('mods:plan', (id) => mods.plan(id));
handle('mods:add', (id, opts) => mods.add(id, opts || {}));
handle('mods:update', (id) => mods.update(id));
handle('mods:updateAll', (onlyOutdated) => mods.updateAll(onlyOutdated !== false));
handle('mods:remove', (id, opts) => mods.remove(id, opts));
handle('mods:setFlags', (id, flags) => mods.setFlags(id, flags));
handle('mods:reorder', (ids) => mods.reorder(ids));
handle('mods:checkUpdates', () => mods.checkUpdates());
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
handle('alerts:test', () => alerts.alert('test', 'Test alert from DayZ Admin Tools', 'If you can read this, alerts are wired up.', { force: true }));
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
handle('accounts:check', (id) => accounts.checkSteam(id));

// Economy editor
handle('economy:files', () => economy.files());
handle('economy:limits', () => economy.limits());
handle('economy:loadTypes', (abs) => economy.loadTypes(abs));
handle('economy:saveTypes', (abs, rows) => economy.saveTypes(abs, rows));
handle('economy:loadEvents', (abs) => economy.loadEvents(abs));
handle('economy:saveEvents', (abs, rows) => economy.saveEvents(abs, rows));
handle('economy:loadSpawnable', (abs) => economy.loadSpawnable(abs));
handle('economy:saveSpawnable', (abs, rows) => economy.saveSpawnable(abs, rows));
handle('economy:parse', (kind, text) => economy.rowsFromText(kind, text));
handle('economy:createFile', (opts) => economy.createFile(opts || {}));
handle('economy:unregisterFile', (abs) => economy.unregisterFile(abs));
handle('fs:readText', (abs) => { if (!pickedFiles.has(path.resolve(String(abs || '')))) throw new Error('Pick the file through the file dialog first.'); return fs.readFileSync(abs, 'utf8'); });

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
handle('app:rendererError', (msg) => { toollog.error(`renderer: ${msg}`); return true; });
function scrubbedSettings() {
  const s = JSON.parse(JSON.stringify(settings.load()));
  if (s.discord) { s.discord.token = ''; s.discord.steamApiKey = ''; }
  if (s.rcon) s.rcon.password = '';
  if (s.offsite) { for (const k of Object.keys(s.offsite)) if (/pass/i.test(k)) s.offsite[k] = ''; if (s.offsite.ftp) s.offsite.ftp.password = ''; }
  if (s.alerts) s.alerts.webhookUrl = '';
  if (s.website) { delete s.website.admin; if (s.website.domain) { s.website.domain.certPem = ''; s.website.domain.keyPem = ''; if (s.website.domain.ddns) s.website.domain.ddns.token = ''; } }
  delete s.steamPassEnc; delete s.steamUser;
  return s;
}
handle('app:exportSettings', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: 'dayz-admin-tools-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled) return null;
  const s = JSON.parse(JSON.stringify(settings.load()));
  // never export credentials: bot token, API keys, passwords, DNS tokens, certificates, the remembered Steam password
  if (s.discord) { s.discord.token = ''; s.discord.steamApiKey = ''; }
  if (s.rcon) s.rcon.password = '';
  if (s.offsite) { for (const k of Object.keys(s.offsite)) if (/pass/i.test(k)) s.offsite[k] = ''; }
  if (s.alerts) s.alerts.webhookUrl = '';
  if (s.website) { delete s.website.admin; if (s.website.domain) { s.website.domain.certPem = ''; s.website.domain.keyPem = ''; if (s.website.domain.ddns) s.website.domain.ddns.token = ''; } }
  delete s.steamPassEnc;
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
handle('mission:buildMap', (opts) => mission.buildMapImage(opts || {}));
handle('heat:summary', (since) => heat.summary(null, Number(since) || 0));
handle('lootmap:items', () => lootmap.items());
handle('lootmap:spawns', (name) => lootmap.spawns(name));
handle('stats:overview', () => stats.overview());
handle('stats:reset', () => { stats.clear(); return true; });
handle('stats:summaryText', () => stats.summaryText());
handle('stats:postSummary', () => stats.postSummaryNow());
handle('audit:list', (o) => audit.list(o || {}));
handle('combat:overview', () => combat.overview());
handle('deathlog:list', (q) => deathlog.list(q || {}));
handle('anticheat:status', () => anticheat.status());
handle('anticheat:setEnabled', (on) => anticheat.setEnabled(!!on));
handle('anticheat:install', () => anticheat.install());
handle('anticheat:remove', () => anticheat.remove());
handle('anticheat:list', (q) => anticheat.list(q || {}));
handle('deathlog:get', (id) => deathlog.get(id));
handle('deathlog:forPlayer', (key) => deathlog.forPlayer(key));
handle('deathlog:stats', () => deathlog.stats());
handle('deathlog:refund', (id, items) => deathlog.refund(id, { by: 'app', items: items || null }));
handle('deathlog:bridgeStatus', () => deathlog.bridgeStatus());
handle('deathlog:heal', (key, what) => deathlog.heal(key, what || 'all', { by: 'app' }));
handle('deathlog:teleportToDeath', (id) => deathlog.teleportToDeath(id, { by: 'app' }));
handle('deathlog:installBridge', () => deathlog.installBridge());
handle('deathlog:removeBridge', () => deathlog.removeBridge());
handle('deathlog:openBridgeDir', () => { const d = deathlog.bridgeDir(); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
handle('combat:suspicious', (since) => combat.suspicious(Number(since) || 0));
handle('combat:rebuild', () => combat.rebuild());
// ---- diagnostics: the tool's own log and a shareable bundle ----
handle('app:openLogDir', () => { const p = toollog.path(); if (p && fs.existsSync(p)) shell.showItemInFolder(p); else shell.openPath(app.getPath('userData')); return p; });
handle('app:exportDiagnostics', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: `dayz-admin-tools-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] });
  if (r.canceled) return null;
  const ud = app.getPath('userData'); const staging = path.join(ud, '_diag'); fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
  const copy = (name) => { try { if (fs.existsSync(path.join(ud, name))) fs.copyFileSync(path.join(ud, name), path.join(staging, name)); } catch { /* ignore */ } };
  for (const n of ['tool.log', 'tool.log.1', 'audit.log', 'stats.json', 'health.json', 'steam-bans.json']) copy(n);
  fs.writeFileSync(path.join(staging, 'settings-scrubbed.json'), JSON.stringify(scrubbedSettings(), null, 2));
  const st = { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node, os: `${require('os').platform()} ${require('os').release()}`, arch: process.arch, exportedAt: new Date().toISOString(), server: (() => { try { return server.status(); } catch { return null; } })(), steam: (() => { try { const x = steamcmd.status(); return { steamcmdInstalled: x.steamcmdInstalled, serverInstalled: x.serverInstalled, serverBuild: x.serverBuild, loggedIn: x.loggedIn }; } catch { return null; } })(), mods: (() => { try { return mods.list().map(m => ({ id: m.id, title: m.title, enabled: m.enabled, installed: m.installed })); } catch { return null; } })(), recentAlerts: (() => { try { return alerts.recent(50); } catch { return null; } })() };
  fs.writeFileSync(path.join(staging, 'system.json'), JSON.stringify(st, null, 2));
  try { const crashesDir = path.join(settings.load().installDir, 'crashes'); const latest = fs.readdirSync(crashesDir).filter(f => f.endsWith('.json')).sort().slice(-3); for (const f of latest) fs.copyFileSync(path.join(crashesDir, f), path.join(staging, 'crash-' + f)); } catch { /* none */ }
  try { const p = settings.paths(); const rpts = fs.readdirSync(p.profilesDir).filter(f => /\.rpt$/i.test(f)).map(f => ({ f, m: fs.statSync(path.join(p.profilesDir, f)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 1); for (const x of rpts) { const buf = fs.readFileSync(path.join(p.profilesDir, x.f)); fs.writeFileSync(path.join(staging, 'latest-' + x.f), buf.subarray(Math.max(0, buf.length - 512 * 1024))); } } catch { /* none */ }
  await zip.zipDir(staging, r.filePath); fs.rmSync(staging, { recursive: true, force: true });
  shell.showItemInFolder(r.filePath); return r.filePath;
});
handle('audit:export', () => { const p = path.join(app.getPath('userData'), 'audit-export.csv'); fs.writeFileSync(p, audit.exportCsv()); shell.showItemInFolder(p); return p; });
handle('heat:rebuild', () => heat.rebuild());
handle('heat:clear', () => heat.clear());
handle('mission:openMapsDir', () => { const d = mission.mapInfo().mapsDir; fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });

// Scheduled tasks
handle('tasks:all', () => ({ tasks: tasks.all(), next: tasks.nextRuns(), types: tasks.TYPES }));
handle('tasks:upsert', (t) => tasks.upsert(t));
handle('tasks:remove', (id) => tasks.remove(id));
handle('tasks:run', (id) => { const t = tasks.all().find(x => x.id === id); if (!t) throw new Error('Task not found'); return tasks.runTask(t, 'manual'); });

// Network helper
handle('network:report', () => network.report());
handle('network:upnpStatus', () => upnp.status(network.ports()));
handle('network:upnpMap', (names) => upnp.map(network.ports().filter(p => !names || !names.length || names.includes(p.name))));
handle('network:upnpUnmap', (names) => upnp.unmap(network.ports().filter(p => !names || !names.length || names.includes(p.name))));
handle('network:addresses', async () => ({ lan: network.lanIps(), publicIp: await network.publicIp(), port: (settings.load().website || {}).port || 8080, gamePort: settings.load().port || 2302 }));
handle('logs:cleanup', (opts) => logs.cleanup(opts || {}));
handle('logs:cleanupCfg', () => logs.cleanupCfg());
handle('steam:forgetPassword', () => { settings.save({ steamPassEnc: '' }); return steamcmd.status(); });
handle('network:addRules', () => network.addRules());
handle('network:removeRules', () => network.removeRules());

// Off-site backups
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
handle('domain:status', () => domain.status());
handle('domain:save', (d) => { domain.saveCfg(d || {}); domain.applyTimers(); return domain.status(); });
handle('domain:issue', (opts) => domain.issue(opts || {}));
handle('domain:updateDns', () => domain.updateDns({ force: true }));
handle('website:start', (port) => website.start(port));
handle('website:stop', () => website.stop());
handle('website:preview', (slug) => website.preview(slug));
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
handle('rcon:ensure', (o) => rcon.ensureConfigured(o || {}));
handle('rcon:disconnect', () => rcon.disconnect());
handle('rcon:command', (cmd) => rcon.command(cmd));
handle('rcon:players', () => rcon.players());
handle('rcon:say', (msg, player) => rcon.say(msg, player ?? -1));
handle('rcon:kick', (num, reason) => rcon.kick(num, reason));
handle('rcon:ban', (num, minutes, reason) => rcon.ban(num, minutes, reason));

// Player lists
handle('lists:all', () => lists.allLists());
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


const T0 = Date.now(); const initTimes = [];
function timed(name, fn) { const t = Date.now(); try { fn(); } finally { initTimes.push([name, Date.now() - t]); } }
app.whenReady().then(() => {
  toollog.init();
  toollog.info(`startup: process had been running for ${Math.round(process.uptime() * 1000)} ms before Electron was ready`);
  timed('alerts', () => alerts.init(emit));
  try { if (steamcmd.loadSavedCredentials()) emit('console', { source: 'steamcmd', line: `Using remembered Steam login for ${settings.load().steamUser}.` }); } catch { /* ignore */ }
  timed('crashes', () => crashes.init(emit));
  timed('mods', () => mods.init(emit));
  timed('server', () => server.init(emit));
  timed('updater', () => updater.init(emit));
  timed('backups', () => backups.init(emit));
  timed('scheduler', () => scheduler.init(emit));
  timed('rcon', () => rcon.init(emit));
  timed('discord', () => discord.init(emit));
  timed('website', () => website.init(emit));
  timed('health', () => health.init(emit));
  initUpdater();
  mission.init(emit); tasks.init(emit); offsite.init(emit);
  // Optional: bring the DayZ server up a few seconds after the tool starts (for unattended reboots).
  if (appPrefs().autoStartServer) setTimeout(() => { try { if (!server.status().running) { emit('console', { source: 'server', line: 'Auto-starting the server (Settings → start with the tool).' }); server.start(); } } catch (e) { emit('console', { source: 'server', line: 'Auto-start failed: ' + e.message }); } }, Math.max(3, Number(appPrefs().autoStartDelaySec) || 10) * 1000);
  if (appPrefs().closeToTray || process.argv.includes('--minimized')) buildTray();
  setInterval(refreshTray, 15000);
  timed('players', () => players.init(emit));
  timed('steambans', () => steambans.init(emit));
  timed('accounts', () => accounts.init(emit));
  timed('domain', () => domain.init(emit));
  timed('heat', () => heat.init(emit));
  timed('stats', () => stats.init());
  timed('audit', () => audit.init(emit));
  timed('combat', () => combat.init(emit));
  timed('deathlog', () => deathlog.init(emit));
  timed('anticheat', () => anticheat.init(emit));
  createWindow();
});

app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('before-quit', () => { quitting = true; });
app.on('activate', () => showWindow());
