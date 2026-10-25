'use strict';
const $ = (id) => document.getElementById(id);
const ipc = window.api;

let state = { settings: null, paths: null, server: null, steam: null, mods: [] };
let currentLog = null;
let logTab = 'raw';

// ---------- helpers ----------
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 3500);
}
async function run(fn, busyBtn) {
  if (busyBtn) busyBtn.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message, true); logLine({ source: 'app', line: 'Error: ' + e.message }); }
  finally { if (busyBtn) busyBtn.disabled = false; }
}
function fmtBytes(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function fmtDate(ms) { return ms ? new Date(ms).toLocaleString() : '—'; }
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- console ----------
const consoleHidden = new Set();
// Pinned strip of the last critical lines from the server, so they do not scroll away in a busy console.
const criticalLines = [];
function pinCritical(source, line) {
  // called from alerts:new for server-critical / server-major only
  const key = line.replace(/^\s*\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*/, '').trim();
  const existing = criticalLines.find(c => c.key === key);
  if (existing) { existing.count++; existing.at = Date.now(); }
  else { criticalLines.push({ key, source, line, count: 1, at: Date.now() }); if (criticalLines.length > 6) criticalLines.shift(); }
  renderCritical();
}
function renderCritical() {
  const strip = $('criticalStrip'); const box = $('criticalLines');
  if (!criticalLines.length) { strip.hidden = true; box.innerHTML = ''; return; }
  strip.hidden = false;
  box.innerHTML = criticalLines.slice().reverse().map(c => `<div class="critical-line"><span class="muted">${new Date(c.at).toLocaleTimeString()} [${esc(c.source)}]</span> ${esc(c.line.slice(0, 300))}${c.count > 1 ? ` <span class="badge bad">×${c.count}</span>` : ''}</div>`).join('');
}
$('btnClearCritical').onclick = () => { criticalLines.length = 0; renderCritical(); };
ipc.on('server:status', st => { if (st && st.running && st.startedAt && Date.now() - st.startedAt < 3000) { criticalLines.length = 0; renderCritical(); } });
function logLine({ source, line }) {
  const pre = $('console');
  const span = document.createElement('span');
  span.dataset.src = ['server', 'rpt', 'steamcmd'].includes(source) ? source : 'other';
  if (consoleHidden.has(span.dataset.src)) span.hidden = true;
  const cls = /error|fail|invalid|exception|can't|cannot/i.test(line) && !/(0 failed)|0 error|no error|failed: 0\b|fails?: ?0\b/i.test(line) ? 'err' : /warn/i.test(line) ? 'warn' : '';
  span.innerHTML = `<span class="src src-${esc(source)}">[${esc(source)}]</span> <span class="${cls}">${esc(line)}</span>\n`;
  pre.appendChild(span);
  while (pre.childNodes.length > 3000) pre.removeChild(pre.firstChild);
  if ($('consoleAutoscroll').checked) pre.scrollTop = pre.scrollHeight;
}
ipc.on('console', logLine);
$('btnClearConsole').onclick = () => { $('console').textContent = ''; };
document.querySelectorAll('.console-filters input[data-src]').forEach(cb => cb.onchange = () => {
  if (cb.checked) consoleHidden.delete(cb.dataset.src); else consoleHidden.add(cb.dataset.src);
  $('console').querySelectorAll('span[data-src]').forEach(sp => { sp.hidden = consoleHidden.has(sp.dataset.src); });
});

// ---------- navigation ----------
// Sidebar structure: category -> optional subcategory -> pages. Collapsed state is remembered per group.
const ICONS = {
  instances: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
  install: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>',
  launch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l14 9-14 9V3z"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H6a2 2 0 00-2 2v14a2 2 0 002 2h2M16 3h2a2 2 0 012 2v14a2 2 0 01-2 2h-2"/><path d="M10 8l-2 4 2 4M14 8l2 4-2 4"/></svg>',
  economy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5M4 19h16"/><path d="M8 15l3-4 3 2 5-6"/></svg>',
  mission: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
  network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5M12 12l-6 5M12 12l6 5"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z"/><path d="M9 4v14M15 6v14"/></svg>',
  stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3h6l1 2h3a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h3l1-2z"/><path d="M8 11h8M8 15h5"/></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h10M4 18h14"/></svg>',
  workshop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  mods: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>',
  updates: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  backups: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7a8 3 0 0116 0v10a8 3 0 01-16 0V7z"/><path d="M4 12a8 3 0 0016 0"/></svg>',
  restarts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  players: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 20a5 5 0 015.5-5"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></svg>',
  priority: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v16M5 11l7-7 7 7"/></svg>',
  bans: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/></svg>',
  lists: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l2 2 4-4"/><rect x="3" y="4" width="18" height="16" rx="2"/></svg>',
  website: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>',
  alerts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 16V11a6 6 0 1112 0v5l2 2H4l2-2z"/><path d="M10 20a2 2 0 004 0"/></svg>',
  discord: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 5a16 16 0 018 0l1.5 2.5a13 13 0 013 8.5l-3.5 2-1.5-2.5a12 12 0 01-7 0L7 18l-3.5-2a13 13 0 013-8.5L8 5z"/><circle cx="9.5" cy="12.5" r="1"/><circle cx="14.5" cy="12.5" r="1"/></svg>'
};
const NAV = [
  { items: [{ page: 'dashboard', label: 'Dashboard', sub: 'Status, quick actions and console', icon: 'dashboard' }, { page: 'settings', label: 'Settings', sub: 'Tray, startup, updates and data', icon: 'settings' }] },
  { title: 'Server', items: [
    { page: 'instances', label: 'Instances', sub: 'Several servers on this PC: each in its own folder with its own ports, cores, mods and bot', icon: 'instances' },
    { page: 'install', label: 'Installation', sub: 'Install location, SteamCMD, server files and Steam login', icon: 'install' },
    { page: 'launch', label: 'Launch', sub: 'Launch parameters and the generated mod lines', icon: 'launch' },
    { page: 'server', label: 'Config Editor', sub: 'Edit and validate serverDZ.cfg, mission XML/JSON and BattlEye configs', icon: 'server' },
    { page: 'economy', label: 'Economy', sub: 'Loot tables: types, events and spawnable types with filters and bulk edits', icon: 'economy' },
    { page: 'mission', label: 'Mission', sub: 'Switch missions, wipe storage, edit cfggameplay.json', icon: 'mission' },
    { page: 'logs', label: 'Logs', sub: 'Live RPT / ADM logs with an error summary', icon: 'logs' }
  ] },
  { title: 'Mods', items: [
    { page: 'workshop', label: 'Workshop', sub: 'Browse and add Steam Workshop mods', icon: 'workshop' },
    { page: 'mods', label: 'Installed', sub: 'Load order, updates, dependencies, server-only flags', icon: 'mods' }
  ] },
  { title: 'Maintenance', items: [
    { page: 'updates', label: 'Updates', sub: 'Scheduled server and mod updates', icon: 'updates' },
    { page: 'alerts', label: 'Alerts', sub: 'Toasts, Discord and webhook notifications for crashes, restarts, backups and health', icon: 'alerts' },
    { page: 'backups', label: 'Backups', sub: 'Zip backups of mission, profiles and config', icon: 'backups' },
    { page: 'restarts', label: 'Restarts', sub: 'Scheduled restarts with in-game warnings', icon: 'restarts' },
    { page: 'tasks', label: 'Tasks', sub: 'Scheduled messages, commands, backups and scripts', icon: 'tasks' },
    { page: 'network', label: 'Network', sub: 'Ports, firewall rules and public IP', icon: 'network' },
    { page: 'audit', label: 'Audit log', sub: 'Who did what: app, Discord bot and web admin actions', icon: 'audit' }
  ] },
  { title: 'Players', items: [
    { page: 'stats', label: 'Statistics', sub: 'Deaths, players online, leaderboards and server health over time', icon: 'stats' },
    { page: 'players', label: 'Online', sub: 'Live players via RCon: message, kick, ban', icon: 'players' },
    { page: 'database', label: 'Database', sub: 'Every player seen in the admin logs: playtime, kills, sessions, notes', icon: 'database' },
    { page: 'deathlog', label: 'Death log', sub: 'Every death: cause, killer, weapon, range, damage per body part, gear carried, refunds', icon: 'database' },
    { page: 'bans', label: 'Bans', sub: 'Game bans and BattlEye bans', icon: 'bans' },
    { page: 'whitelist', label: 'Whitelist', sub: 'Who may join when enableWhitelist is on (whitelist.txt)', icon: 'lists' },
    { page: 'tickets', label: 'Tickets', sub: 'Support tickets with assignees, notes, linked deaths and the admin actions done for them', icon: 'lists' },
    { page: 'priority', label: 'Priority queue', sub: 'Who skips the login queue (priority.txt)', icon: 'priority' },
    { page: 'map', label: 'Map', sub: 'Live players with admin actions (right-click), loot, vehicles and heat', icon: 'map' }
  ] },
  { title: 'Integrations', items: [
    { page: 'discord', label: 'Discord Bot', sub: 'Slash commands, whitelist applications, bans, live logs', icon: 'discord' },
    { page: 'website', label: 'Website', sub: 'Public status page, mod list, custom pages and files', icon: 'website' }
  ] }
];
let navCollapsed = {};
try { navCollapsed = JSON.parse(localStorage.getItem('navCollapsed') || '{}'); } catch { navCollapsed = {}; }
function renderNav() {
  const btn = (it) => `<button class="nav-btn ${it.page === 'dashboard' ? 'active' : ''}" data-page="${it.page}">${ICONS[it.icon] || ''}<span>${esc(it.label)}</span></button>`;
  const group = (g) => !g.title ? (g.items || []).map(btn).join('') : `<div class="nav-group ${navCollapsed[g.title] ? 'collapsed' : ''}" data-key="${esc(g.title)}">
      <div class="nav-cat">${esc(g.title)}</div>
      <div class="nav-children">${(g.items || []).map(btn).join('')}${(g.groups || []).map(group).join('')}</div>
    </div>`;
  $('nav').innerHTML = NAV.map(group).join('');
  $('nav').querySelectorAll('.nav-cat').forEach(h => h.onclick = () => {
    const g = h.closest('.nav-group'); g.classList.toggle('collapsed');
    navCollapsed[g.dataset.key] = g.classList.contains('collapsed');
    try { localStorage.setItem('navCollapsed', JSON.stringify(navCollapsed)); } catch { /* ignore */ }
  });
}
renderNav();

document.querySelectorAll('.nav-btn').forEach(b => b.onclick = () => showPage(b.dataset.page));
function navItem(name) { for (const g of NAV) { for (const it of (g.items || [])) if (it.page === name) return it; for (const sg of (g.groups || [])) for (const it of sg.items) if (it.page === name) return it; } return null; }
function showPage(name) {
  const it = navItem(name); if (it) { $('pageTitle').textContent = it.label; $('pageSubtitle').textContent = it.sub || ''; }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  const activeBtn = document.querySelector(`.nav-btn[data-page="${name}"]`);
  for (let g = activeBtn && activeBtn.closest('.nav-group'); g; g = g.parentElement.closest('.nav-group')) g.classList.remove('collapsed');
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  if (name === 'logs') refreshLogList();
  if (name === 'backups') { loadScheduleForm(); refreshSchedule(); refreshBackups(); }
  if (name === 'restarts') { loadScheduleForm(); refreshSchedule(); }
  if (name === 'updates') { refreshUpdater(); refreshSteam(); }
  if (name === 'launch') { refreshLaunchLines(); loadCfgForm(); }
  if (name === 'players') { loadRconForm(); refreshPlayers(); refreshRecent(); }
  if (name === 'bans' || name === 'whitelist' || name === 'priority') refreshLists();
  if (name === 'website') refreshWebsite();
  if (name === 'alerts') loadAlertsPage();
  if (name === 'settings') loadSettingsPage();
  if (name === 'instances') refreshInstances();
  if (name === 'launch') loadCpu();
  if (name === 'mission') refreshMission();
  if (name === 'tasks') refreshTasks();
  if (name === 'network') refreshNetwork();
  if (name === 'map') { loadMapInfo().then(() => { scheduleDraw(); ensureMapImage(false); mapLive(true); }); }
  if (name === 'stats') { refreshStats(); refreshCombat(); }
  if (name === 'audit') refreshAudit();
  if (name === 'economy') refreshEconomy();
  if (name === 'database') refreshPdb();
  if (name === 'deathlog') refreshDeathLog();
  if (name === 'tickets') refreshTickets();
  if (name === 'dashboard') { refreshHealth(); refreshAlertList(); refreshUpdater(); requestAnimationFrame(() => { if ($('consoleAutoscroll').checked) $('console').scrollTop = $('console').scrollHeight; }); }
  if (name === 'discord') requestAnimationFrame(() => { const p = $('discordLog'); p.scrollTop = p.scrollHeight; });
  if (name === 'players') requestAnimationFrame(() => { const p = $('rconMessages'); p.scrollTop = p.scrollHeight; });
  if (name === 'discord') { loadDiscordForm(); refreshDiscordCommands(); ipc.invoke('discord:status').then(renderDiscord); }
  if (name === 'mods') refreshMods();
  if (name === 'workshop') { refreshMods(); wsEnsureStarted(); }
  if (name === 'server') { refreshConfigTree(); setTimeout(() => cm.refresh(), 0); }
  if (name === 'install') refreshSteam();
}

// ---------- settings ----------
async function loadSettings() {
  const r = await ipc.invoke('settings:get');
  state.settings = r.settings; state.paths = r.paths;
  const s = r.settings;
  $('installDir').value = s.installDir;
  $('serverAppId').value = String(s.serverAppId);
  $('steamUser').value = s.steamUser || '';
  $('port').value = s.port;
  $('cpuCount').value = s.cpuCount;
  $('configFile').value = s.configFile;
  $('profilesDir').value = s.profilesDir;
  { const parts = (s.extraParams || '').split(/\s+/).filter(Boolean); const rest = [];
    const has = f => parts.some(p => p.toLowerCase() === f);
    $('flagDologs').checked = has('-dologs'); $('flagAdminlog').checked = has('-adminlog'); $('flagNetlog').checked = has('-netlog'); $('flagFreezecheck').checked = has('-freezecheck');
    const lim = parts.find(p => /^-limitfps=/i.test(p)); $('flagLimitFps').value = lim ? lim.split('=')[1] : '';
    for (const p of parts) if (!['-dologs', '-adminlog', '-netlog', '-freezecheck'].includes(p.toLowerCase()) && !/^-limitfps=/i.test(p)) rest.push(p);
    $('extraParams').value = rest.join(' '); }
  $('autoRestart').checked = !!s.autoRestart;
  $('steamRemember').checked = !!s.steamPassEnc;
  const au = { enabled: false, intervalHours: 6, mode: 'times', times: [], onlyIfUpdates: true, checkEveryMinutes: 60, ...(s.autoUpdate || {}) };
  $('autoUpdateEnabled').checked = !!au.enabled; $('autoUpdateHours').value = au.intervalHours; $('autoUpdateMode').value = au.mode; $('autoUpdateTimes').value = (au.times || []).join(', '); $('autoUpdateOnlyIf').checked = au.onlyIfUpdates !== false; $('autoUpdateCheckMin').value = au.checkEveryMinutes; $('autoUpdateBackup').checked = au.backupBefore !== false;
  $('statAutoUpdate').textContent = s.autoUpdate && s.autoUpdate.enabled ? `Auto-update every ${s.autoUpdate.intervalHours}h` : 'Auto-update off';
}
async function saveSettings(partial) {
  const r = await ipc.invoke('settings:set', partial);
  state.settings = r.settings; state.paths = r.paths;
  await loadSettings();
}
$('btnPickInstall').onclick = () => run(async () => {
  const dir = await ipc.invoke('dialog:pickFolder', $('installDir').value);
  if (dir) $('installDir').value = dir;
});
$('btnSaveInstall').onclick = () => run(async () => {
  await saveSettings({ installDir: $('installDir').value.trim(), serverAppId: Number($('serverAppId').value) });
  toast('Install settings saved'); refreshSteam();
});
$('btnSaveLaunch').onclick = () => run(async () => {
  await saveSettings({
    port: Number($('port').value) || 2302,
    cpuCount: Number($('cpuCount').value) || 0,
    configFile: $('configFile').value.trim() || 'serverDZ.cfg',
    profilesDir: $('profilesDir').value.trim() || 'profiles',
    extraParams: [$('flagDologs').checked && '-dologs', $('flagAdminlog').checked && '-adminlog', $('flagNetlog').checked && '-netlog', $('flagFreezecheck').checked && '-freezecheck', Number($('flagLimitFps').value) > 0 && '-limitFPS=' + Number($('flagLimitFps').value), $('extraParams').value.trim()].filter(Boolean).join(' '),
    autoRestart: $('autoRestart').checked
  });
  toast('Launch settings saved'); refreshCmdline(); refreshConfigTree();
});
$('btnSaveAutoUpdate').onclick = () => run(async () => {
  const times = $('autoUpdateTimes').value.split(/[,\s]+/).map(t => t.trim()).filter(Boolean).map(t => t.padStart(5, '0'));
  const bad = times.filter(t => !/^\d{2}:\d{2}$/.test(t)); if (bad.length) return toast(`Invalid time: ${bad.join(', ')} (use HH:MM)`, true);
  await saveSettings({ autoUpdate: { enabled: $('autoUpdateEnabled').checked, mode: $('autoUpdateMode').value, times, intervalHours: Number($('autoUpdateHours').value) || 6, onlyIfUpdates: $('autoUpdateOnlyIf').checked, checkEveryMinutes: Number($('autoUpdateCheckMin').value) || 60, backupBefore: $('autoUpdateBackup').checked } });
  toast('Schedule saved'); refreshUpdater();
});

// ---------- steam / install ----------
async function refreshSteam() {
  const st = await ipc.invoke('steam:status');
  state.steam = st;
  const b = st.serverBuild;
  $('installStatus').innerHTML = `SteamCMD: <b>${st.steamcmdInstalled ? 'installed' : 'not installed'}</b> · Server: <b>${st.serverInstalled ? 'installed' : 'not installed'}</b>` +
    (b ? `<br>Build ${esc(b.buildId)} · last updated ${fmtDate(b.lastUpdated)}` : '');
  $('statInstall').textContent = st.serverInstalled ? 'Server installed' : (st.steamcmdInstalled ? 'SteamCMD ready, server not installed' : 'Nothing installed yet');
  $('statBuild').textContent = b ? `Build ${b.buildId} · ${fmtDate(b.lastUpdated)}` : st.paths.serverDir;
  $('btnForgetPass').hidden = !st.savedPassword; $('credStatus').textContent = st.loggedIn ? `Using account ${st.steamUser}${st.savedPassword ? ' (password remembered)' : ''}` : 'No Steam login set (workshop downloads disabled)';
}
$('btnForgetPass').onclick = (e) => run(async () => { await ipc.invoke('steam:forgetPassword'); toast('Saved Steam password forgotten'); await refreshSteam(); }, e.target);
$('btnSaveCreds').onclick = () => run(async () => {
  await ipc.invoke('steam:setCredentials', { user: $('steamUser').value, pass: $('steamPass').value, guard: $('steamGuard').value, remember: $('steamRemember').checked });
  toast('Credentials set for this session'); refreshSteam();
});
$('btnInstallSteamcmd').onclick = (e) => run(async () => { await ipc.invoke('steam:installSteamcmd'); toast('SteamCMD ready'); refreshSteam(); }, e.target);
async function updateServer(btn) {
  return run(async () => {
    if (state.server && state.server.running) { toast('Stop the server before updating', true); return; }
    showPage('dashboard');
    await ipc.invoke('steam:updateServer', { validate: $('validateInstall').checked });
    toast('Server is up to date'); refreshSteam();
  }, btn);
}
$('btnInstallServer').onclick = (e) => updateServer(e.target);
$('btnDashUpdate').onclick = (e) => updateServer(e.target);
$('btnCancelSteam').onclick = () => ipc.invoke('steam:cancel');
$('btnOpenServerDir').onclick = () => ipc.invoke('shell:openPath', state.paths.serverDir);
ipc.on('steam:guardNeeded', () => { toast('Steam Guard code required. Enter it on the Install page and retry.', true); showPage('install'); $('steamGuard').focus(); });

// ---------- updater ----------
function renderUpdateCheck(u) {
  const c = u.lastCheck;
  const banner = $('updatesBanner');
  if (!c) { $('updateCheckBox').textContent = u.checking ? 'Checking…' : 'Not checked yet.'; banner.hidden = true; return; }
  const parts = [];
  if (c.server.available) parts.push(`Server update available (build ${c.server.installed} → ${c.server.latest})`);
  if (c.mods.length) parts.push(`${c.mods.length} mod update${c.mods.length > 1 ? 's' : ''}: ${c.mods.map(m => m.title).join(', ')}`);
  const when = ' · checked ' + fmtDate(c.at);
  $('updateCheckBox').innerHTML = parts.length ? parts.map(esc).join('<br>') + `<div class="muted">${when}</div>` : `Server build ${esc(c.server.installed || '?')}${c.server.latest ? ' (latest ' + esc(c.server.latest) + ')' : ''} and all mods are up to date.${when}`;
  banner.hidden = !parts.length;
  if (parts.length) banner.innerHTML = `<span>${parts.map(esc).join(' · ')}</span><span class="row gap"><button class="btn small" id="btnBannerUpdates">Open Updates</button><button class="btn small primary" id="btnBannerUpdateNow">Update now</button></span>`;
  const b1 = $('btnBannerUpdates'); if (b1) b1.onclick = () => showPage('updates');
  const b2 = $('btnBannerUpdateNow'); if (b2) b2.onclick = (e) => run(async () => { const ok = await showModal('Update now?', '<p>The server is stopped (players are warned if RCon is connected), the server and outdated mods are installed, then it starts again.</p>', [{ label: 'Update now', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) return; await ipc.invoke('updater:runNow', { force: true }); }, e.target);
}
async function refreshUpdater() {
  const u = await ipc.invoke('updater:state');
  renderUpdateCheck(u);
  const lr = u.lastRun;
  $('updaterStatus').textContent = (u.running ? 'Update running… ' : '') +
    (lr ? `Last run ${fmtDate(lr.at)}: server ${lr.result.server ? 'ok' : 'failed'}, ${lr.result.mods.length} mod(s) updated, ${lr.result.failed.length} failed.` : 'Never run.') +
    (u.lastUpdateCheck ? ` Last mod check ${fmtDate(u.lastUpdateCheck)}.` : '');
}
$('btnCheckUpdatesNow').onclick = (e) => run(async () => { toast('Checking Steam…'); await ipc.invoke('updater:check'); refreshUpdater(); }, e.target);
$('btnRunUpdateNow').onclick = (e) => run(async () => { showPage('dashboard'); await ipc.invoke('updater:runNow', { force: true }); refreshUpdater(); refreshSteam(); }, e.target);
ipc.on('updater:state', refreshUpdater);

// ---------- server ----------
function renderServer(st) {
  state.server = st;
  const running = st.running;
  $('dotServer').className = 'dot ' + (running ? 'ok' : st.restartPending ? 'warn' : '');
  $('statServer').textContent = running ? `On (pid ${st.pid})` : st.restartPending ? 'Restarting…' : 'Off';
  $('sideStatus').textContent = running ? 'Server on' : 'Server off';
  const ps = $('pillServer'); ps.className = 'pill pill-link ' + (running ? 'ok' : st.restartPending ? 'warn' : ''); ps.innerHTML = `<span class="dot ${running ? 'ok' : st.restartPending ? 'warn' : ''}"></span>Server: ${st.maintenance ? (st.maintenance.kind === 'update' ? 'Updating' : 'Restarting') : running ? 'On' : st.restartPending ? 'Restarting' : 'Off'}`; ps.title = running ? `Running (pid ${st.pid})` : 'Server stopped';
  $('btnQuickStart').hidden = running; $('btnQuickStop').hidden = !running;
  $('btnStart').disabled = running; $('btnStop').disabled = !running && !st.restartPending; $('btnRestart').disabled = !running || !!st.stopping;
  // while a stop waits for the server to save and close, Stop becomes Force stop
  $('btnStop').textContent = st.stopping ? 'Force stop' : 'Stop'; $('btnQuickStop').textContent = st.stopping ? 'Force stop' : 'Stop server';
  $('btnStop').title = $('btnQuickStop').title = st.stopping ? 'The server has not closed yet (frozen, or still saving): end its process now' : 'Ask the server to save and shut down';
  updateUptime();
}
// Progress of a start: where the current step begins and ends in this machine's last start, filled by time spent in it.
function loadProgress(st) {
  const stg = st.stage, prof = stg.profile || { fractions: [0, 0.03, 0.4, 0.6, 0.62, 0.97, 1], totalMs: 0 };
  const f = prof.fractions, i = stg.index, f0 = f[i] || 0, f1 = f[i + 1] !== undefined ? f[i + 1] : 1;
  const now = Date.now(), elapsed = now - st.startedAt;
  let within = 0.5;
  if (prof.totalMs > 0) { const expected = Math.max(1000, (f1 - f0) * prof.totalMs); within = Math.min(0.95, (now - stg.at) / expected); }
  else within = Math.min(0.9, (now - stg.at) / 60000);
  const pct = Math.min(0.99, f0 + (f1 - f0) * within);
  // time left: from the last start's total, scaled by how this start is going so far
  let leftMs = null;
  if (prof.totalMs > 0 && pct > 0.05) { const est = Math.max(prof.totalMs, elapsed / pct); leftMs = Math.max(0, est - elapsed); }
  return { pct, leftMs };
}
function updateUptime() {
  const st = state.server;
  if (!st) return;
  const loading = st.running && st.stage && !st.stage.ready;
  $('loadBar').hidden = !loading;
  if (loading) {
    const p = loadProgress(st); $('loadFill').style.width = Math.round(p.pct * 100) + '%';
    $('statUptime').textContent = `Loading: ${st.stage.label} · ${Math.round(p.pct * 100)}% · ${fmtDuration(Date.now() - st.startedAt)}${p.leftMs !== null ? ' · about ' + fmtDuration(p.leftMs) + ' left' : ''}`;
  }
  else if (st.running) $('statUptime').textContent = 'Uptime ' + fmtDuration(Date.now() - st.startedAt);
  else if (st.lastExit) $('statUptime').textContent = `Last exit code ${st.lastExit.code} at ${fmtDate(st.lastExit.at)} after ${fmtDuration(st.lastExit.ranFor * 1000)}`;
  else $('statUptime').textContent = 'Not started this session';
}
setInterval(updateUptime, 1000);
ipc.on('server:status', (st) => { renderServer(st); updateModsBanner(); });
ipc.on('server:stage', (stg) => { if (state.server) { state.server.stage = stg; if (stg && stg.startedAt) state.server.startedAt = stg.startedAt; updateUptime(); } ipc.invoke('rcon:status').then(renderRcon).catch(() => {}); });
ipc.on('server:maintenance', (m) => { if (state.server) { state.server.maintenance = m; renderServer(state.server); } ipc.invoke('rcon:status').then(renderRcon).catch(() => {}); });
ipc.on('server:status', () => { ipc.invoke('rcon:status').then(renderRcon).catch(() => {}); });
const startServer = (e) => run(async () => renderServer(await ipc.invoke('server:start')), e.target);
const stopServer = (e) => run(async () => {
  if (state.server && state.server.stopping) {
    if (!(await showModal('Force stop?', '<p>End the server process now, without waiting for it to save and close. Use it when the server is frozen.</p><p class="muted">Progress since the last autosave (every few minutes) is lost.</p>', [{ label: 'Force stop', value: true, primary: true }, { label: 'Keep waiting', value: false }]))) return;
    return renderServer(await ipc.invoke('server:stop', { force: true, wait: false }));
  }
  renderServer(await ipc.invoke('server:stop', { wait: false }));
}, e.target);
$('btnStart').onclick = startServer; $('btnQuickStart').onclick = startServer;
$('btnStop').onclick = stopServer; $('btnQuickStop').onclick = stopServer;
$('btnRestart').onclick = (e) => run(async () => renderServer(await ipc.invoke('server:restart')), e.target);

async function refreshCmdline() { return refreshLaunchLines(); }

// ---------- serverDZ.cfg form ----------
let cfgFormData = null;
async function loadCfgForm() {
  const box = $('cfgForm');
  try { cfgFormData = await ipc.invoke('cfgform:read'); } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
  $('cfgFormFile').textContent = cfgFormData.exists ? (cfgFormData.template ? 'mission ' + cfgFormData.template : '') : 'serverDZ.cfg not found';
  if (!cfgFormData.exists) { box.innerHTML = '<div class="muted">serverDZ.cfg was not found. Install the server first; a default config is copied on the first install.</div>'; return; }
  let group = null, html = '', folded = false;
  const FOLD = ['Advanced', 'Network'];
  for (const f of cfgFormData.fields) {
    if (f.group !== group) {
      if (folded) { html += '</div></details>'; folded = false; }
      group = f.group;
      if (FOLD.includes(group)) { html += `<details class="cfg-fold"><summary class="cfg-group">${esc(group)} <span class="muted">rarely needed, click to show</span></summary><div class="cfg-form">`; folded = true; }
      else html += `<div class="cfg-group">${esc(group)}</div>`;
    }
    const v = cfgFormData.values[f.key]; const miss = v === null || v === undefined; const title = `${f.key}${f.hint ? ' — ' + f.hint : ''}${miss ? ' (not in the file yet)' : ''}`;
    if (f.type === 'bool') html += `<label class="check ${miss ? 'cfg-missing' : ''}" title="${esc(title)}"><input type="checkbox" data-key="${f.key}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
    else if (f.type === 'array') html += `<label class="field ${miss ? 'cfg-missing' : ''}" style="grid-column:1/-1" title="${esc(title)}">${esc(f.label)} <textarea class="input" data-key="${f.key}">${esc((v || []).join('\n'))}</textarea></label>`;
    else html += `<label class="field ${miss ? 'cfg-missing' : ''}" title="${esc(title)}">${esc(f.label)} <input class="input" data-key="${f.key}" type="${f.type === 'string' ? 'text' : 'number'}" ${f.min !== undefined ? 'min="' + f.min + '"' : ''} ${f.max !== undefined ? 'max="' + f.max + '"' : ''} ${f.type === 'num' ? 'step="any"' : ''} value="${esc(miss ? '' : String(v))}" placeholder="${esc(f.hint || '')}"></label>`;
  }
  if (folded) html += '</div></details>';
  box.innerHTML = html;
}
$('btnCfgFormReload').onclick = () => run(loadCfgForm);
$('btnCfgFormOpen').onclick = () => { showPage('server'); if (cfgFormData && cfgFormData.file && typeof openConfigFile === 'function') openConfigFile(cfgFormData.file); };
$('btnCfgFormSave').onclick = (e) => run(async () => {
  if (!cfgFormData) return;
  const changes = {};
  for (const f of cfgFormData.fields) {
    const el = $('cfgForm').querySelector(`[data-key="${f.key}"]`); if (!el) continue;
    const old = cfgFormData.values[f.key];
    let v;
    if (f.type === 'bool') v = el.checked; else if (f.type === 'array') v = el.value.split('\n').map(x => x.trim()).filter(Boolean); else if (f.type === 'string') v = el.value; else v = el.value === '' ? null : Number(el.value);
    // a key that is not in the file yet counts as unchanged while the field is still blank / unticked
    const same = f.type === 'array' ? JSON.stringify(v) === JSON.stringify(old || []) : (v === old || (v === null && old === null) || (old === null && (v === '' || v === false || v === null)));
    if (!same) changes[f.key] = v;
  }
  if (!Object.keys(changes).length) { toast('Nothing changed'); return; }
  cfgFormData = await ipc.invoke('cfgform:write', changes);
  toast(`Saved ${Object.keys(changes).length} setting(s) to serverDZ.cfg (takes effect on the next server start)`);
  loadCfgForm();
}, e.target);

// ---------- config editor ----------
const MODES = { xml: 'xml', json: { name: 'javascript', json: true }, c: 'text/x-c++src', cfg: 'text/x-c++src' };
const cm = CodeMirror($('editorHost'), {
  value: '', mode: 'text/x-c++src', theme: 'material-darker', lineNumbers: true, lineWrapping: false,
  matchBrackets: true, autoCloseTags: true, styleActiveLine: true, indentUnit: 4, tabSize: 4, indentWithTabs: true,
  extraKeys: { 'Ctrl-S': () => saveCurrentFile(), 'Ctrl-F': 'findPersistent', 'Alt-G': 'jumpToLine' }
});
const editor = { file: null, kind: null, dirty: false, tree: null, marks: [], fileProblems: {} };
cm.on('change', () => { if (!editor.dirty && editor.file) { editor.dirty = true; $('editorDirty').hidden = false; } });

async function refreshConfigTree() {
  const r = await ipc.invoke('configs:list');
  editor.tree = r;
  const tree = $('configTree');
  if (!r.groups.some(g => g.files.length)) { tree.innerHTML = `<div class="empty">No config files found. Install the server first.<br><code>${esc(r.serverDir)}</code></div>`; return; }
  tree.innerHTML = r.groups.map(g => `
    <div class="tree-group ${g.collapsed === false ? '' : 'collapsed'}">${esc(g.group)}</div>
    <div class="tree-files">${g.files.map(f => {
      const pr = editor.fileProblems[f.abs];
      const badge = pr ? (pr.error ? `<span class="fprob" style="color:var(--bad)">${pr.error}✕</span>` : pr.warning ? `<span class="fprob" style="color:var(--warn)">${pr.warning}▲</span>` : '<span class="fprob" style="color:var(--ok)">✓</span>') : '';
      return `<div class="tree-file ${f.abs === editor.file ? 'active' : ''}" data-abs="${esc(f.abs)}" data-kind="${f.kind}" title="${esc(f.abs)}"><span class="fname">${esc(f.name)}</span><span class="row gap">${badge}<span class="fkind">${f.kind}</span></span></div>`;
    }).join('') || '<div class="tree-file muted">(empty)</div>'}</div>`).join('');
}
$('configTree').addEventListener('click', e => {
  const g = e.target.closest('.tree-group'); if (g) { g.classList.toggle('collapsed'); return; }
  const f = e.target.closest('.tree-file'); if (f && f.dataset.abs) openConfigFile(f.dataset.abs);
});
$('btnRefreshFiles').onclick = () => run(refreshConfigTree);

async function confirmDiscard() {
  if (!editor.dirty) return true;
  const c = await showModal('Unsaved changes', `<p>${esc(editor.file)} has unsaved changes.</p>`, [{ label: 'Save', value: 'save', primary: true }, { label: 'Discard', value: 'discard' }, { label: 'Cancel', value: null }]);
  if (c === 'save') { await saveCurrentFile(); return true; }
  return c === 'discard';
}
async function openConfigFile(abs) {
  return run(async () => {
    if (editor.file === abs && editor.dirty) return;
    if (!(await confirmDiscard())) return;
    const r = await ipc.invoke('configs:read', abs);
    editor.file = r.abs; editor.kind = r.kind; editor.dirty = false;
    cm.setOption('mode', MODES[r.kind] || 'text/plain');
    cm.setValue(r.text); cm.clearHistory();
    $('editorFile').textContent = r.abs; $('editorDirty').hidden = true;
    document.querySelectorAll('.tree-file').forEach(x => x.classList.toggle('active', x.dataset.abs === abs));
    clearMarks();
    renderProblems([], null);
    setTimeout(() => cm.refresh(), 0);
  });
}
async function saveCurrentFile() {
  if (!editor.file) return toast('No file open', true);
  return run(async () => {
    await ipc.invoke('configs:write', editor.file, cm.getValue());
    editor.dirty = false; $('editorDirty').hidden = true;
    toast('Saved (previous version kept as .bak)');
    if ($('validateOnSave').checked) await validateCurrent();
  });
}
$('btnEditorSave').onclick = () => saveCurrentFile();
$('btnEditorReload').onclick = () => run(async () => { if (!editor.file) return; const f = editor.file; editor.dirty = false; await openConfigFile(f); });
$('btnEditorFind').onclick = () => cm.execCommand('findPersistent');
$('btnEditorValidate').onclick = () => run(validateCurrent);
$('btnClearProblems').onclick = () => { clearMarks(); renderProblems([], null); };
$('btnNewConfigFile').onclick = () => run(async () => {
  const base = (editor.tree && editor.tree.missionDir) || (editor.tree && editor.tree.serverDir);
  if (!base) return toast('Install the server first', true);
  const ok = await showModal('New file', `<p class="muted">Created inside ${esc(base)}</p><label class="field">File name (e.g. db/types_custom.xml) <input id="mNewFile" class="input"></label>`, [{ label: 'Create', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  const name = $('mNewFile').value.trim();
  if (!name) return;
  const starter = /\.xml$/i.test(name) ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<types>\n</types>\n' : /\.json$/i.test(name) ? '{\n}\n' : '';
  const abs = await ipc.invoke('configs:create', base + '\\' + name.replace(/\//g, '\\'), starter);
  await refreshConfigTree();
  openConfigFile(abs);
});

function clearMarks() { for (const m of editor.marks) cm.removeLineClass(m.line, 'background', m.cls); editor.marks = []; }
function markProblems(problems) {
  clearMarks();
  for (const p of problems) {
    if (p.severity === 'info') continue;
    const cls = 'cm-line-' + p.severity;
    cm.addLineClass(p.line - 1, 'background', cls);
    editor.marks.push({ line: p.line - 1, cls });
  }
}
async function validateCurrent() {
  if (!editor.file) return toast('No file open', true);
  const r = await ipc.invoke('configs:validate', editor.file, cm.getValue());
  editor.fileProblems[editor.file] = r.counts;
  markProblems(r.problems);
  renderProblems(r.problems.map(p => ({ ...p, file: editor.file })), r.counts);
  refreshConfigTree();
}
function renderProblems(items, counts, title) {
  const box = $('problems');
  $('problemsTitle').textContent = title || (counts ? `Problems — ${counts.error} errors, ${counts.warning} warnings, ${counts.info} notes` : 'Problems');
  if (!items.length) { box.innerHTML = counts ? '<div class="ok">✓ No problems found.</div>' : '<div class="muted" style="padding:6px 8px">Open a file and click "Check for errors", or "Check all files" for the whole server.</div>'; return; }
  box.innerHTML = items.map(p => `<div class="problem ${p.severity}" data-file="${esc(p.file || '')}" data-line="${p.line}"><span class="sev">${p.severity}</span><span class="pline">${p.file ? 'L' + p.line : ''}</span><span>${p.fileName ? `<span class="pfile">${esc(p.fileName)} · </span>` : ''}${esc(p.message)}</span></div>`).join('');
}
$('problems').addEventListener('click', async e => {
  const row = e.target.closest('.problem'); if (!row || !row.dataset.file) return;
  const line = Number(row.dataset.line) - 1;
  if (row.dataset.file !== editor.file) await openConfigFile(row.dataset.file);
  cm.setCursor({ line, ch: 0 }); cm.scrollIntoView({ line, ch: 0 }, 120); cm.focus();
});
$('btnValidateAll').onclick = (e) => run(async () => {
  toast('Checking all config files…');
  const r = await ipc.invoke('configs:validateAll');
  editor.fileProblems = {};
  for (const f of r.results) if (f.file) editor.fileProblems[f.file] = f.counts;
  const items = r.results.flatMap(f => f.problems.map(p => ({ ...p, file: f.file, fileName: f.name })));
  renderProblems(items, r.totals, `All files — ${r.checked} checked, ${r.totals.error} errors, ${r.totals.warning} warnings, ${r.totals.info} notes`);
  if (editor.file) { const mine = items.filter(i => i.file === editor.file); markProblems(mine); }
  refreshConfigTree();
}, e.target);


// ---------- modal ----------
function showModal(title, bodyHtml, actions) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  const box = $('modalActions');
  box.innerHTML = '';
  return new Promise(resolve => {
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.primary ? 'primary' : '');
      b.textContent = a.label;
      b.onclick = () => { $('modal').hidden = true; resolve(a.value); };
      box.appendChild(b);
    }
    $('modal').hidden = false;
  });
}

// Ask for Steam credentials inline instead of bouncing the user to another page.
async function ensureSteamLogin() {
  await refreshSteam();
  if (state.steam.loggedIn) return true;
  const ok = await showModal('Steam login needed', `
    <p class="muted">Workshop downloads need a Steam account that owns DayZ. The password is kept in memory only.</p>
    <label class="field">Username <input id="mUser" class="input" value="${esc(state.settings.steamUser || '')}"></label>
    <label class="field">Password <input id="mPass" class="input" type="password"></label>
    <label class="field">Steam Guard code (if you have one) <input id="mGuard" class="input" placeholder="optional"></label>`,
    [{ label: 'Log in', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return false;
  await ipc.invoke('steam:setCredentials', { user: $('mUser').value, pass: $('mPass').value, guard: $('mGuard').value });
  await refreshSteam();
  return state.steam.loggedIn;
}

// ---------- mods ----------
function parseModId(input) {
  const m = String(input).match(/(?:id=)?(\d{6,})/);
  return m ? m[1] : null;
}
const PROGRESS_LABEL = { queued: 'Queued', downloading: 'Downloading…', linking: 'Linking…', error: 'Failed' };
function modRow(m) {
  return `
      <div class="mod ${m.enabled ? '' : 'disabled'}" data-id="${esc(m.id)}" draggable="true">
        <span class="row gap"><span class="grip">⋮⋮</span><input type="checkbox" class="mod-enabled" ${m.enabled ? 'checked' : ''} title="Enabled"></span>
        <div>
          <div class="title" title="${esc(m.title)}">${esc(m.title)}</div>
          <div class="sub">
            ${m.local ? '<span class="badge">local</span>' : `<span>${esc(m.id)}</span>`}
            ${m.folderName && !m.local ? `<span>${esc(m.folderName)}</span>` : ''}
            ${m.progress ? `<span class="progress ${m.progress.state === 'error' ? 'error' : ''}" title="${esc(m.progress.message || '')}">${m.progress.state !== 'error' ? '<span class="spinner"></span>' : ''}${PROGRESS_LABEL[m.progress.state] || m.progress.state}</span>` :
              (m.installed ? '<span class="badge ok">installed</span>' : '<span class="badge bad">not downloaded</span>')}
            ${m.installed && !m.linked ? '<span class="badge warn">not linked</span>' : ''}
            ${m.updateAvailable ? '<span class="badge warn">update available</span>' : ''}
            ${m.missingDeps && m.missingDeps.length ? `<span class="badge bad" title="Required: ${esc(m.missingDeps.join(', '))}">missing ${m.missingDeps.length} dependency</span>` : ''}
            ${m.fileSize ? `<span>${fmtBytes(m.fileSize)}</span>` : ''}
            ${modKeyBadges(m)}
          </div>
        </div>
        <div class="actions">
          ${m.missingDeps && m.missingDeps.length ? '<button class="btn small mod-deps" title="Add missing dependencies">+deps</button>' : ''}
          <button class="btn small mod-update" title="${m.local ? 'Re-copy keys' : 'Download / update'}">⟳</button>
          <button class="btn small mod-side" title="${m.serverSide ? 'Move to -mod (clients need it)' : 'Move to -serverMod (server only)'}">${m.serverSide ? '→ mod' : '→ server'}</button>
          ${m.local ? '' : '<button class="btn small mod-open" title="Open workshop page">↗</button>'}
          <button class="btn small danger mod-remove" title="Remove">✕</button>
        </div>
      </div>`;
}
const KEY_STATUS = { ok: ['ok', 'in use'], shared: ['ok', 'shared'], base: ['', 'game key'], orphan: ['warn', 'leftover'], missing: ['bad', 'missing'], outdated: ['warn', 'outdated'], conflict: ['bad', 'name clash'], unused: ['', 'mod disabled'] };
function modKeyBadges(m) {
  const info = state.keyMap && state.keyMap.mods.find(x => x.id === m.id);
  const keys = info ? info.keys : (m.keys || []).map(file => ({ file, status: 'ok', sharedWith: [] }));
  return keys.map(k => `<span class="badge ${k.status === 'missing' || k.status === 'conflict' ? 'bad' : k.status === 'outdated' ? 'warn' : ''}" title="${esc(k.sharedWith.length ? 'Key shared with ' + k.sharedWith.join(', ') + '; kept until all of them are removed' : 'Key used only by this mod; removed with it')}">key ${esc(k.file)}${k.sharedWith.length ? ' · shared' : ''}</span>`).join('');
}
function renderKeys() {
  const km = state.keyMap; if (!km) return;
  const c = km.counts;
  $('keysSummary').textContent = `· ${km.keys.length} in total${c.shared ? `, ${c.shared} shared` : ''}${c.orphan ? `, ${c.orphan} leftover` : ''}${c.missing ? `, ${c.missing} missing` : ''}${c.outdated ? `, ${c.outdated} outdated` : ''}${c.conflict ? `, ${c.conflict} name clash` : ''}`;
  $('btnKeysOrphans').hidden = !c.orphan;
  $('btnKeysOrphans').textContent = `Remove leftover key${c.orphan > 1 ? 's' : ''} (${c.orphan})`;
  $('keysTable').querySelector('tbody').innerHTML = km.keys.map(k => {
    const [cls, label] = KEY_STATUS[k.status] || ['', k.status];
    const users = k.mods.map(x => `${esc(x.title)}${x.managed ? '' : ' <span class="muted">(not managed)</span>'}${x.enabled === false ? ' <span class="muted">(off)</span>' : ''}${x.notDownloaded ? ' <span class="muted">(not downloaded)</span>' : ''}`).join(', ') || `<span class="muted">${k.status === 'base' ? 'DayZ itself' : 'no mod'}</span>`;
    const act = k.status === 'orphan' ? `<button class="btn small danger key-del" data-file="${esc(k.file)}">Remove</button>` : (k.status === 'missing' || k.status === 'outdated') ? `<button class="btn small key-fix" data-file="${esc(k.file)}">Fix</button>` : '';
    return `<tr title="${esc(k.note + (k.sameAs ? ' Same key as ' + k.sameAs.join(', ') + '.' : ''))}"><td><code>${esc(k.file)}</code></td><td>${esc(k.authority)}</td><td>${users}</td><td><span class="badge ${cls}">${label}</span></td><td>${act}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">No keys folder yet.</td></tr>';
}
async function refreshMods() {
  state.mods = await ipc.invoke('mods:list');
  try { state.keyMap = await ipc.invoke('mods:keys'); } catch { state.keyMap = null; }
  renderKeys();
  const list = $('modList');
  if (!state.mods.length) { list.innerHTML = '<div class="empty">No mods yet. Find mods on the Workshop page, paste a workshop ID or collection above, or use Import found to pick up mods already in the server folder.</div>'; }
  else {
    const sections = [
      { title: '-mod · client + server', items: state.mods.filter(m => !m.serverSide && !m.local) },
      { title: '-serverMod · server only', items: state.mods.filter(m => m.serverSide && !m.local) },
      { title: 'Local mods (folders in the server directory)', items: state.mods.filter(m => m.local) }
    ];
    list.innerHTML = sections.filter(s => s.items.length).map(s => `<div class="mod-section">${esc(s.title)} <span class="muted">(${s.items.length})</span></div>` + s.items.map(modRow).join('')).join('');
  }
  const enabled = state.mods.filter(m => m.enabled).length;
  const outdated = state.mods.filter(m => m.updateAvailable).length;
  const missing = state.mods.filter(m => m.missingDeps && m.missingDeps.length).length;
  $('statMods').textContent = `${state.mods.length} mods, ${enabled} enabled${outdated ? `, ${outdated} outdated` : ''}${missing ? `, ${missing} with missing deps` : ''}`;
  updateModsBanner();
  refreshLaunchLines();
  if (wsState.results) renderWsGrid();
}
async function refreshLaunchLines() {
  const ll = await ipc.invoke('mods:launchLines');
  $('llMod').textContent = ll.mod || '(no client mods enabled)';
  $('llServerMod').textContent = ll.serverMod || '(no server-only mods)';
  $('llLocal').textContent = ll.local.length ? ll.local.map(l => `${l.id}${l.enabled ? '' : ' (off)'}${l.serverSide ? ' [server]' : ''}`).join(', ') : '(none — drop @folders into the server directory and use Import found)';
  $('llOther').textContent = ll.other || '(none)';
  $('llSummary').textContent = `${ll.counts.client} client, ${ll.counts.server} server-only, ${ll.counts.local} local, ${ll.counts.disabled} disabled${ll.missing.length ? ` · not downloaded yet: ${ll.missing.join(', ')}` : ''}`;
  $('cmdline').textContent = 'DayZServer_x64.exe ' + ll.full;
  $('llSaved').innerHTML = ll.savedTo ? 'Saved to the server folder as <code>start_server.bat</code> and <code>modlist.txt</code>, rewritten whenever the list changes.' : 'Once the server is installed, the strings are saved to its folder as start_server.bat and modlist.txt.';
}
function updateModsBanner() {
  const b = $('modsBanner');
  if (state.server && state.server.running && state.server.modsChanged) {
    b.innerHTML = '<span>The mod list changed since the server started. Restart to apply.</span><button class="btn small" id="btnBannerRestart">Restart now</button>';
    b.hidden = false;
    $('btnBannerRestart').onclick = (e) => run(async () => renderServer(await ipc.invoke('server:restart')), e.target);
  } else b.hidden = true;
}
$('modList').addEventListener('click', (e) => {
  const row = e.target.closest('.mod'); if (!row) return;
  const id = row.dataset.id;
  const m = state.mods.find(x => x.id === id);
  if (e.target.classList.contains('mod-enabled')) return run(async () => {
    if (!e.target.checked) { const deps = await ipc.invoke('mods:dependents', id); if (deps.length) { const ok = await showModal(`Disable ${m.title}?`, `<p>These mods require it and will fail to load: <b>${esc(deps.join(', '))}</b></p>`, [{ label: 'Disable anyway', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) { e.target.checked = true; return; } } }
    await ipc.invoke('mods:setFlags', id, { enabled: e.target.checked });
  });
  if (e.target.classList.contains('mod-update')) return run(async () => { if (!m.local && !(await confirmWhileRunning('Updating ' + m.title))) return; if (!m.local && !(await ensureSteamLogin())) return; await ipc.invoke('mods:update', id); toast(`${m.title} updated`); }, e.target);
  if (e.target.classList.contains('mod-deps')) return addMod(id, e.target);
  if (e.target.classList.contains('mod-side')) return run(async () => { await ipc.invoke('mods:setFlags', id, { serverSide: !m.serverSide }); });
  if (e.target.classList.contains('mod-open')) return ipc.invoke('shell:openExternal', `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`);
  if (e.target.classList.contains('mod-remove')) {
    return run(async () => {
      const deps = await ipc.invoke('mods:dependents', id);
      const kp = await ipc.invoke('mods:keyPlan', id);
      const keyText = (kp.remove.length ? `<p>Keys deleted with it: <b>${esc(kp.remove.join(', '))}</b></p>` : '') + kp.keep.map(k => `<p class="muted">Key ${esc(k.file)} stays: also used by ${esc(k.by.join(', '))}.</p>`).join('') || '<p class="muted">It ships no keys.</p>';
      const choice = await showModal(`Remove ${m.title}?`, `${deps.length ? `<p><b>Warning:</b> ${esc(deps.join(', '))} require this mod and will fail to load without it.</p>` : ''}<p class="muted">Removing unlinks it from the server.</p>${keyText}`,
        m.local ? [{ label: 'Remove from list', value: 'keep', primary: true }, { label: 'Cancel', value: null }]
          : [{ label: 'Remove and delete files', value: 'delete', primary: true }, { label: 'Remove, keep download', value: 'keep' }, { label: 'Cancel', value: null }]);
      if (!choice) return;
      await ipc.invoke('mods:remove', id, { deleteFiles: choice === 'delete' });
    });
  }
});
// drag & drop ordering
let dragId = null;
$('modList').addEventListener('dragstart', e => { const row = e.target.closest('.mod'); if (!row) return; dragId = row.dataset.id; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
$('modList').addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.mod').forEach(r => r.classList.remove('dragging', 'drop-before', 'drop-after')); });
$('modList').addEventListener('dragover', e => {
  const row = e.target.closest('.mod'); if (!row || !dragId || row.dataset.id === dragId) return;
  e.preventDefault();
  const before = e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
  document.querySelectorAll('.mod').forEach(r => r.classList.remove('drop-before', 'drop-after'));
  row.classList.add(before ? 'drop-before' : 'drop-after');
});
$('modList').addEventListener('drop', e => {
  const row = e.target.closest('.mod'); if (!row || !dragId || row.dataset.id === dragId) return;
  e.preventDefault();
  const before = e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
  const ids = state.mods.map(m => m.id).filter(x => x !== dragId);
  const at = ids.indexOf(row.dataset.id) + (before ? 0 : 1);
  ids.splice(at, 0, dragId);
  const target = state.mods.find(m => m.id === row.dataset.id), moved = state.mods.find(m => m.id === dragId);
  run(async () => {
    await ipc.invoke('mods:reorder', ids);
    // Dropping into another section moves the mod between -mod and -serverMod.
    if (target && moved && !moved.local && !target.local && target.serverSide !== moved.serverSide) await ipc.invoke('mods:setFlags', dragId, { serverSide: target.serverSide });
  });
});

// Downloading into a mod folder the running server has loaded can corrupt the download or crash the server.
async function confirmWhileRunning(what) {
  if (!state.server || !state.server.running) return true;
  return showModal('Server is running', `<p>${what} replaces files the running server has loaded. SteamCMD may fail on locked files, and the change only applies after a restart.</p><p>Stop the server first, or continue anyway?</p>`, [{ label: 'Continue anyway', value: true, primary: true }, { label: 'Cancel', value: false }]);
}
async function addMod(id, btn) {
  if (!id) return toast('Could not find a workshop ID', true);
  return run(async () => {
    if (!(await confirmWhileRunning('Adding a mod'))) return;
    if (!(await ensureSteamLogin())) return;
    toast('Checking mod and its dependencies…');
    const plan = await ipc.invoke('mods:plan', id);
    const deps = plan.filter(p => p.id !== id);
    const main = plan.find(p => p.id === id) || { id, title: `Mod ${id}` };
    let withDeps = true;
    if (deps.length) {
      const choice = await showModal(`Add ${main.title}`, `
        <p>This mod requires ${deps.length} other mod(s). They will be placed above it in the load order.</p>
        ${deps.map(d => `<div class="dep"><span>${esc(d.title)}</span><span class="muted">${d.already ? 'already added' : (d.fileSize ? fmtBytes(d.fileSize) : '')}</span></div>`).join('')}`,
        [{ label: 'Add with dependencies', value: 'deps', primary: true }, { label: 'Only this mod', value: 'solo' }, { label: 'Cancel', value: null }]);
      if (!choice) return;
      withDeps = choice === 'deps';
    }
    toast(`Adding ${main.title}…`);
    await ipc.invoke('mods:add', id, { withDeps });
    toast(`${main.title} is ready`);
  }, btn);
}
$('btnAddMod').onclick = (e) => run(async () => {
  const raw = $('modIdInput').value.trim();
  const id = parseModId(raw);
  if (!id) return toast('Paste a workshop ID or URL', true);
  // A collection adds every item in it; a single mod returns no items and falls through.
  {
    const items = await ipc.invoke('workshop:collection', id).catch(() => []);
    if (items.length) {
      const ok = await showModal(`Add collection (${items.length} items)`, items.map(i => `<div class="dep"><span>${esc(i.title)}</span><span class="muted">${i.added ? 'already added' : fmtBytes(i.size)}</span></div>`).join(''), [{ label: `Add ${items.filter(i => !i.added).length} mods`, value: true, primary: true }, { label: 'Cancel', value: false }]);
      if (!ok) return;
      if (!(await ensureSteamLogin())) return;
      $('modIdInput').value = '';
      const r = await ipc.invoke('mods:addMany', items.filter(i => !i.added).map(i => i.id), { withDeps: true });
      return toast(`${r.added} added, ${r.failed.length} failed`, r.failed.length > 0);
    }
  }
  await addMod(id, e.target);
  $('modIdInput').value = '';
});
$('modIdInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnAddMod').click(); });
$('btnCheckMods').onclick = (e) => run(async () => { const out = await ipc.invoke('mods:checkUpdates'); toast(out.length ? `${out.length} mod(s) have updates` : 'All mods up to date'); }, e.target);
$('btnDashCheckMods').onclick = $('btnCheckMods').onclick;
$('btnUpdateAllMods').onclick = (e) => run(async () => { if (!(await confirmWhileRunning('Updating mods'))) return; if (!(await ensureSteamLogin())) return; const r = await ipc.invoke('mods:updateAll', true); toast(`${r.updated} updated, ${r.failed.length} failed`); }, e.target);
$('btnAutoOrganize').onclick = (e) => run(async () => { await ipc.invoke('mods:autoOrganize'); toast('Organized: frameworks first, then dependency order'); }, e.target);
$('btnImportMods').onclick = (e) => run(async () => {
  const found = await ipc.invoke('mods:scanUnmanaged');
  if (!found.length) return toast('No unmanaged mods found');
  const ok = await showModal('Import mods found on disk', found.map(f => `<div class="dep"><span>${esc(f.title)}</span><span class="muted">${f.kind === 'workshop' ? 'workshop ' + esc(f.id) : f.kind}</span></div>`).join(''),
    [{ label: `Import ${found.length}`, value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  await ipc.invoke('mods:importUnmanaged', found);
  toast('Imported');
}, e.target);
document.querySelectorAll('.ll-copy').forEach(b => b.onclick = () => { const t = $(b.dataset.for).textContent; if (t.startsWith('-')) { navigator.clipboard.writeText(t); toast('Copied'); } else toast('Nothing to copy'); });
ipc.on('console', (m) => {
  if (!m || m.source !== 'preflight' || window._rtOffered || $('autoRuntimes').checked) return;
  const line = m.line || '';
  const kind = /Visual C\+\+ 2015-2022 x64 runtime is not installed|from the Microsoft Visual C\+\+/.test(line) ? 'vc' : /DirectX End-User Runtime/.test(line) ? 'dx' : null;
  if (!kind) return;
  window._rtOffered = true;
  setTimeout(async () => {
    const name = kind === 'vc' ? 'Microsoft Visual C++ 2015-2022 x64 runtime' : 'DirectX June 2010 runtime (XAPOFX1_5.dll)';
    const ok = await showModal('Runtime missing', `<p>The server cannot start because the ${name} is not installed on this PC.</p><p class="muted">The tool can download it from Microsoft and run the installer (Windows asks for permission).</p>`, [{ label: 'Install it now', value: true, primary: true }, { label: 'Not now', value: false }]);
    if (ok) { toast(`Downloading and installing the ${kind === 'vc' ? 'Visual C++' : 'DirectX'} runtime…`); try { const res = await ipc.invoke(kind === 'vc' ? 'server:installVcRedist' : 'server:installDirectX'); toast(res.installed ? 'Runtime installed. Start the server.' : 'Installer finished; if the check still fails, reboot once.', !res.installed); } catch (e) { toast(e.message, true); } }
    window._rtOffered = false;
  }, 300);
});
ipc.invoke('settings:get').then(s => { $('autoRuntimes').checked = s.autoRuntimes !== false; }).catch(() => {});
$('autoRuntimes').onchange = () => saveSettings({ autoRuntimes: $('autoRuntimes').checked });
$('btnPreflight').onclick = (e) => run(async () => {
  const r = await ipc.invoke('server:preflight');
  const li = (items, cls) => items.map(t => `<li class="${cls}">${esc(t)}</li>`).join('');
  const needsVc = r.error.some(t => /Visual C\+\+/.test(t)); const needsDx = r.error.some(t => /DirectX/.test(t)); const offerDef = (r.offers || []).includes('defender'); const offerPorts = (r.offers || []).includes('ports') && instInfo && instInfo.isChild;
  const choice = await showModal('Check before start', `<p class="muted">${r.error.length ? 'The server would not start:' : r.warn.length ? 'The server can start, with things to look at:' : 'Everything the tool checks looks fine.'}</p><ul class="checklist">${li(r.error, 'bad')}${li(r.warn, 'warn')}${li(r.ok, 'ok')}</ul>`, [...(offerPorts ? [{ label: 'Move to free ports', value: 'ports', primary: true }] : []), ...(needsVc ? [{ label: 'Install Visual C++ runtime', value: 'vc', primary: true }] : []), ...(needsDx ? [{ label: 'Install DirectX runtime', value: 'dx', primary: !needsVc }] : []), ...(offerDef ? [{ label: 'Exclude server folder from Defender', value: 'def', primary: !needsVc && !needsDx }] : []), { label: 'Close', value: true, primary: !needsVc && !needsDx && !offerDef }]);
  if (choice === 'ports') { const b = await ipc.invoke('instances:reassignPorts', instInfo.self); toast(`Moved to game port ${b.game}, query ${b.query}, RCon ${b.rcon}, website ${b.web}`); }
  if (choice === 'vc') { toast('Downloading and installing the Visual C++ runtime…'); const res = await ipc.invoke('server:installVcRedist'); toast(res.installed ? 'Visual C++ runtime installed. Start the server.' : 'Installer finished; if the check still fails, reboot once.', !res.installed); }
  if (choice === 'def') {
    const ok = await showModal('Exclude from Windows Defender', '<p>Add the server folder (and DayZServer_x64.exe) to Windows Defender\'s exclusions, so Defender stops scanning every game file as the server loads it.</p><p class="muted">This lowers protection for that folder: only do it if the folder holds just the DayZ server and mods you trust. Windows asks for permission.</p>', [{ label: 'Add the exclusion', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (ok) { try { const res = await ipc.invoke('server:addDefenderExclusion'); toast(res.excluded ? 'Server folder excluded from Defender. The next start should be much faster.' : 'Command finished, but Defender does not report the exclusion yet.', !res.excluded); } catch (err) { toast(err.message, true); } }
  }
  if (choice === 'dx') { toast('Downloading and installing the DirectX runtime (about 95 MB)…'); const res = await ipc.invoke('server:installDirectX'); toast(res.installed ? 'DirectX runtime installed. Start the server.' : 'Installer finished; if the check still fails, reboot once.', !res.installed); }
}, e.target);
$('btnCopyFullLine').onclick = () => { navigator.clipboard.writeText($('cmdline').textContent.replace(/^DayZServer_x64\.exe /, '')); toast('Launch line copied'); };
$('btnEditServerMod').onclick = () => run(async () => {
  const ll = await ipc.invoke('mods:launchLines');
  const flagged = ll.serverModFlagged.length ? ': ' + esc(ll.serverModFlagged.join(';')) : '';
  const ok = await showModal('-serverMod (manual)', '<p class="muted">Folder names for server-only mods, separated by ; (one per line also works). These go first; mods flagged server-only in the list are appended automatically' + flagged + '.</p><textarea id="mServerMod" class="input" rows="4" placeholder="@ServerSideMod;@AnotherOne">' + esc(ll.serverModManual) + '</textarea>', [{ label: 'Save', value: true, primary: true }, { label: 'Clear', value: 'clear' }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  await saveSettings({ serverModManual: ok === 'clear' ? '' : $('mServerMod').value.trim() });
  refreshLaunchLines(); toast('Saved');
});
$('btnEditOther').onclick = () => run(async () => {
  const ok = await showModal('Other launch parameters', `<p class="muted">Anything that is not a mod: logging flags, BattlEye path, limits. One line, space separated.</p><input id="mOther" class="input" value="${esc(state.settings.extraParams || '')}">`, [{ label: 'Save', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  await saveSettings({ extraParams: $('mOther').value.trim() });
  refreshLaunchLines(); toast('Saved');
});
ipc.on('mods:changed', () => { refreshMods(); });
ipc.on('mods:progress', () => refreshMods());

// ---------- workshop browser ----------
const wsState = { query: '', sort: 'trend', tags: [], page: 1, results: null, selected: new Set(), detailsId: null, loading: false };
async function wsInitMeta() {
  const meta = await ipc.invoke('workshop:meta');
  $('wsTags').innerHTML = meta.tags.map(t => `<button class="chip tag-chip" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
  $('wsTags').querySelectorAll('.tag-chip').forEach(c => c.onclick = () => { c.classList.toggle('on'); wsState.tags = [...$('wsTags').querySelectorAll('.tag-chip.on')].map(x => x.dataset.tag); wsState.page = 1; wsSearch(); });
}
async function wsSearch() {
  if (wsState.loading) return;
  wsState.loading = true;
  $('wsInfo').textContent = 'Searching…';
  $('wsGrid').classList.add('loading');
  try {
    wsState.query = $('wsQuery').value.trim(); wsState.sort = $('wsSort').value;
    wsState.results = await ipc.invoke('workshop:search', { query: wsState.query, sort: wsState.sort, tags: wsState.tags, page: wsState.page });
    renderWsGrid();
    $('wsInfo').textContent = `${wsState.results.items.length} results on this page${wsState.results.total ? ` of ${wsState.results.total.toLocaleString()}` : ''}${wsState.query ? ` for "${wsState.query}"` : ''}${wsState.tags.length ? ` · tags: ${wsState.tags.join(', ')}` : ''}`;
    $('wsPage').textContent = `Page ${wsState.page}`;
    $('wsPrev').disabled = wsState.page <= 1; $('wsNext').disabled = !wsState.results.hasMore;
  } catch (e) { $('wsInfo').textContent = 'Search failed: ' + e.message; }
  finally { wsState.loading = false; $('wsGrid').classList.remove('loading'); }
}
function renderWsGrid() {
  const have = new Set(state.mods.map(m => m.id));
  const items = wsState.results ? wsState.results.items : [];
  $('wsGrid').innerHTML = items.map(it => {
    const added = have.has(it.id);
    return `<div class="ws-card ${wsState.selected.has(it.id) ? 'selected' : ''} ${added ? 'added' : ''} ${wsState.detailsId === it.id ? 'open' : ''}" data-id="${it.id}">
      <div class="ws-thumb">${it.preview ? `<img src="${esc(it.preview)}" loading="lazy">` : ''}
        ${added ? '<span class="badge ok ws-flag">added</span>' : `<input type="checkbox" class="ws-pick" ${wsState.selected.has(it.id) ? 'checked' : ''} title="Select">`}
      </div>
      <div class="ws-title" title="${esc(it.title)}">${esc(it.title)}</div>
      <div class="ws-meta"><span>${fmtCount(it.subscriptions)} subs</span><span>${fmtBytes(it.size)}</span><span>${new Date(it.updated).toLocaleDateString()}</span></div>
      <div class="ws-tags">${it.tags.filter(t => t !== 'Mod').slice(0, 3).map(t => `<span class="badge">${esc(t)}</span>`).join('')}</div>
      <div class="row gap ws-actions">${added ? '<button class="btn small" disabled>In list</button>' : '<button class="btn small primary ws-add">Add</button>'}<button class="btn small ws-info">Details</button></div>
    </div>`;
  }).join('') || '<div class="empty">No results.</div>';
  const n = wsState.selected.size;
  $('wsAddSelected').textContent = n ? `Add selected (${n})` : 'Add selected';
  $('wsAddSelected').disabled = !n; $('wsSelectNone').hidden = !n;
}
function fmtCount(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n); }
$('wsGrid').addEventListener('click', e => {
  const card = e.target.closest('.ws-card'); if (!card) return;
  const id = card.dataset.id;
  if (e.target.classList.contains('ws-pick')) { if (e.target.checked) wsState.selected.add(id); else wsState.selected.delete(id); renderWsGrid(); return; }
  if (e.target.classList.contains('ws-add')) return addMod(id, e.target);
  showWsDetails(id);
});
async function showWsDetails(id) {
  wsState.detailsId = id; renderWsGrid();
  const box = $('wsDetails'); box.hidden = false; box.innerHTML = '<div class="muted">Loading…</div>';
  $('wsOpenSteam').disabled = false;
  try {
    const d = await ipc.invoke('workshop:details', id);
    const have = new Set(state.mods.map(m => m.id));
    box.innerHTML = `
      <div class="row between"><b>${esc(d.title)}</b><button class="btn small" id="wsCloseDetails">✕</button></div>
      ${d.preview ? `<img class="ws-detail-img" src="${esc(d.preview)}">` : ''}
      <div class="ws-meta"><span>${fmtCount(d.subscriptions)} subscribers</span><span>${fmtBytes(d.size)}</span><span>updated ${new Date(d.updated).toLocaleDateString()}</span><span>ID ${d.id}</span></div>
      <div class="ws-tags">${d.tags.map(t => `<span class="badge">${esc(t)}</span>`).join('')}</div>
      ${d.required.length ? `<div class="card-title mt">Requires</div>${d.required.map(r => `<div class="dep"><span>${esc(r.title)}</span><span class="muted">${have.has(r.id) ? 'in list' : fmtBytes(r.size)}</span></div>`).join('')}` : '<div class="muted mt">No required items listed.</div>'}
      <div class="row gap mt">${have.has(d.id) ? '<button class="btn" disabled>Already in list</button>' : `<button class="btn primary ws-add-detail" data-id="${d.id}">Add${d.required.length ? ' with dependencies' : ''}</button>`}</div>
      <div class="ws-desc">${esc(d.description)}</div>`;
    $('wsCloseDetails').onclick = () => { box.hidden = true; wsState.detailsId = null; renderWsGrid(); };
    const addBtn = box.querySelector('.ws-add-detail'); if (addBtn) addBtn.onclick = (e) => addMod(d.id, e.target);
  } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
}
$('wsSearch').onclick = () => { wsState.page = 1; wsSearch(); };
$('wsQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { wsState.page = 1; wsSearch(); } });
$('wsSort').onchange = () => { wsState.page = 1; wsSearch(); };
$('wsPrev').onclick = () => { if (wsState.page > 1) { wsState.page--; wsSearch(); } };
$('wsNext').onclick = () => { wsState.page++; wsSearch(); };
$('wsSelectNone').onclick = () => { wsState.selected.clear(); renderWsGrid(); };
$('wsOpenSteam').onclick = () => ipc.invoke('shell:openExternal', wsState.detailsId ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${wsState.detailsId}` : 'https://steamcommunity.com/app/221100/workshop/');
$('wsAddSelected').onclick = (e) => run(async () => {
  const ids = [...wsState.selected];
  if (!ids.length) return;
  if (!(await ensureSteamLogin())) return;
  const ok = await showModal(`Add ${ids.length} mod(s)`, '<p>Each mod is added with its required items placed above it in the load order. Downloads run one after another; watch progress in the mod list.</p>', [{ label: 'Add all', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  wsState.selected.clear(); renderWsGrid();
  const r = await ipc.invoke('mods:addMany', ids, { withDeps: true });
  toast(`${r.added} added, ${r.failed.length} failed`, r.failed.length > 0);
}, e.target);
let wsStarted = false;
function wsEnsureStarted() { if (!wsStarted) { wsStarted = true; wsInitMeta().then(() => wsSearch()); } }

// ---------- backups & restarts ----------
function loadScheduleForm() {
  const s = state.settings;
  const rs = { enabled: false, mode: 'times', intervalHours: 4, times: ['04:00'], backupBefore: true, onlyWhenRunning: true, ...(s.restarts || {}) };
  $('rsEnabled').checked = rs.enabled; $('rsMode').value = rs.mode; $('rsTimes').value = rs.times.join(', ');
  $('rsInterval').value = rs.intervalHours; $('rsBackupBefore').checked = rs.backupBefore; $('rsOnlyRunning').checked = rs.onlyWhenRunning;
  $('rsWarn').value = (rs.warnMinutes || [15, 5, 1]).join(', '); $('rsWarnMsg').value = rs.warnMessage || 'Server restart in {min} minute(s). Please log out safely.';
  const bk = { enabled: false, intervalHours: 6, keep: 20, includeMission: true, includeProfiles: true, includeConfig: true, includeKeys: false, dir: '', ...(s.backups || {}) };
  $('bkEnabled').checked = bk.enabled; $('bkInterval').value = bk.intervalHours; $('bkKeep').value = bk.keep;
  $('bkMission').checked = bk.includeMission; $('bkProfiles').checked = bk.includeProfiles; $('bkConfig').checked = bk.includeConfig; $('bkKeys').checked = bk.includeKeys; $('bkToolData').checked = bk.includeToolData !== false;
  $('bkDir').value = bk.dir || '';
  const os = { enabled: false, folder: '', ftp: { enabled: false, host: '', port: 21, user: '', password: '', secure: false, dir: '/backups' }, keepRemote: 10, ...(s.offsite || {}) };
  $('osEnabled').checked = os.enabled; $('osFolder').value = os.folder || ''; $('osFtpEnabled').checked = !!os.ftp.enabled; $('osHost').value = os.ftp.host || ''; $('osPort').value = os.ftp.port || 21; $('osUser').value = os.ftp.user || ''; $('osPass').value = os.ftp.password || ''; $('osDir').value = os.ftp.dir || '/backups'; $('osKeep').value = os.keepRemote || 10; $('osSecure').checked = !!os.ftp.secure;
}
$('btnSaveRestarts').onclick = (e) => run(async () => {
  const times = $('rsTimes').value.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
  const bad = times.filter(t => !/^\d{1,2}:\d{2}$/.test(t));
  if (bad.length) return toast(`Invalid time: ${bad.join(', ')} (use HH:MM)`, true);
  await saveSettings({ restarts: { enabled: $('rsEnabled').checked, mode: $('rsMode').value, times: times.map(t => t.padStart(5, '0')), intervalHours: Number($('rsInterval').value) || 4, backupBefore: $('rsBackupBefore').checked, onlyWhenRunning: $('rsOnlyRunning').checked, warnMinutes: $('rsWarn').value.split(/[,s]+/).map(Number).filter(n => n > 0).sort((x, y) => y - x), warnMessage: $('rsWarnMsg').value.trim() } });
  toast('Restart schedule saved'); refreshSchedule();
}, e.target);
$('btnRestartNowSched').onclick = (e) => run(async () => { showPage('dashboard'); await ipc.invoke('scheduler:restartNow'); }, e.target);
$('btnSaveBackups').onclick = (e) => run(async () => {
  await saveSettings({ backups: { enabled: $('bkEnabled').checked, intervalHours: Number($('bkInterval').value) || 6, keep: Number($('bkKeep').value) || 20, includeMission: $('bkMission').checked, includeProfiles: $('bkProfiles').checked, includeConfig: $('bkConfig').checked, includeKeys: $('bkKeys').checked, includeToolData: $('bkToolData').checked, dir: $('bkDir').value.trim() } });
  toast('Backup settings saved'); refreshSchedule(); refreshBackups();
}, e.target);
$('btnPickBackupDir').onclick = () => run(async () => { const d = await ipc.invoke('dialog:pickFolder', $('bkDir').value); if (d) $('bkDir').value = d; });

function offsiteForm() { return { enabled: $('osEnabled').checked, folder: $('osFolder').value.trim(), keepRemote: Number($('osKeep').value) || 10, ftp: { enabled: $('osFtpEnabled').checked, host: $('osHost').value.trim(), port: Number($('osPort').value) || 21, user: $('osUser').value.trim(), password: $('osPass').value, secure: $('osSecure').checked, dir: $('osDir').value.trim() || '/' } }; }
$('btnOsSave').onclick = (e) => run(async () => { await saveSettings({ offsite: offsiteForm() }); toast('Off-site settings saved'); }, e.target);
$('btnOsTest').onclick = (e) => run(async () => { toast('Connecting…'); const r = await ipc.invoke('offsite:test', offsiteForm().ftp); toast(r); }, e.target);
$('btnOsPick').onclick = () => run(async () => { const d = await ipc.invoke('dialog:pickFolder', $('osFolder').value); if (d) $('osFolder').value = d; });
const backupNow = (e) => run(async () => { toast('Backup started…'); const r = await ipc.invoke('backups:create', 'manual'); toast(`Backup saved: ${r.name}`); }, e.target);
$('btnBackupNow').onclick = backupNow; $('btnDashBackup').onclick = backupNow;
$('btnOpenBackupDir').onclick = () => run(async () => { const st = await ipc.invoke('backups:state'); ipc.invoke('shell:openPath', st.dir); });
async function refreshSchedule() {
  const sc = await ipc.invoke('scheduler:state');
  const bk = await ipc.invoke('backups:state');
  const nr = sc.nextRestart ? fmtDate(sc.nextRestart) : 'none scheduled';
  const nb = sc.nextBackup ? fmtDate(sc.nextBackup) : 'none scheduled';
  $('rsStatus').textContent = `Next restart: ${nr}${sc.lastRestartAt ? ` · last scheduled restart ${fmtDate(sc.lastRestartAt)}` : ''}`;
  $('bkStatus').textContent = `${bk.running ? 'Backup running… · ' : ''}Next backup: ${nb}${bk.lastBackup ? ` · last backup ${fmtDate(bk.lastBackup)}` : ''}`;
  $('statNextRestart').textContent = `Next restart: ${nr}`;
  $('statNextBackup').textContent = `Next backup: ${nb}`;
}
async function refreshBackups() {
  const r = await ipc.invoke('backups:list');
  $('bkDirLabel').textContent = r.dir;
  const list = $('backupList');
  if (!r.backups.length) { list.innerHTML = '<div class="empty">No backups yet.</div>'; return; }
  list.innerHTML = r.backups.map(b => `
    <div class="backup" data-name="${esc(b.name)}">
      <span class="name" title="${esc(b.name)}">${esc(b.name)}</span>
      <span class="muted">${b.date ? esc(b.date) : fmtDate(b.mtime)}${b.label ? ' · ' + esc(b.label) : ''}</span>
      <span class="muted">${fmtBytes(b.size)}</span>
      <span class="row gap"><button class="btn small bk-restore">Restore</button><button class="btn small danger bk-delete">✕</button></span>
    </div>`).join('');
}
$('backupList').addEventListener('click', (e) => {
  const row = e.target.closest('.backup'); if (!row) return;
  const name = row.dataset.name;
  if (e.target.classList.contains('bk-delete')) return run(async () => {
    const ok = await showModal('Delete backup?', `<div class="dep">${esc(name)}</div>`, [{ label: 'Delete', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (ok) { await ipc.invoke('backups:remove', name); refreshBackups(); }
  });
  if (e.target.classList.contains('bk-restore')) return run(async () => {
    if (state.server && state.server.running) return toast('Stop the server before restoring', true);
    const ok = await showModal('Restore backup?', `<p>This overwrites the current mission, profiles and config with the contents of:</p><div class="dep">${esc(name)}</div><p class="muted">A safety backup of the current state is taken first.</p>`,
      [{ label: 'Restore', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (!ok) return;
    showPage('dashboard');
    await ipc.invoke('backups:create', 'pre-restore');
    await ipc.invoke('backups:restore', name);
    toast('Restore complete');
  }, e.target);
});
ipc.on('backups:changed', () => { refreshBackups(); refreshSchedule(); });
ipc.on('backups:state', refreshSchedule);
ipc.on('scheduler:state', refreshSchedule);


// ---------- server management: rcon / players ----------
let rconState = null;
function renderRcon(st) {
  rconState = st;
  $('dotRcon').className = 'dot ' + (st.connected ? 'ok' : '');
  $('rconStatusText').textContent = st.connected ? `RCon connected to ${st.host}:${st.port}` : (st.error ? `RCon: ${st.error}` : 'RCon disconnected');
  $('btnRconConnect').hidden = st.connected; $('btnRconDisconnect').hidden = !st.connected;
  const dg = $('rconDiag'); if (dg) { dg.textContent = !st.connected && st.diag ? st.diag.text : ''; dg.style.color = st.diag && st.diag.step === 'failed' ? 'var(--bad)' : ''; }
  const shouldBeOn = !st.connected && st.expected && st.expected.on;
  const pr = $('pillRcon'); pr.className = 'pill pill-link ' + (st.connected ? 'ok' : shouldBeOn ? 'warn' : ''); pr.innerHTML = `<span class="dot ${st.connected ? 'ok' : shouldBeOn ? 'warn' : ''}"></span>RCon: ${st.connected ? 'On' : 'Off'}`; pr.title = st.connected ? `Connected to ${st.host}:${st.port}` : shouldBeOn ? 'Should be on (the server is up): ' + (st.diag ? st.diag.text : 'connecting…') : `Off because the ${(st.expected && st.expected.why) || 'server is not running'}.`;
}
function loadRconForm() {
  const c = (state.settings && state.settings.rcon) || {};
  $('rconHost').value = c.host || '127.0.0.1';
  $('rconPort').value = c.port || 2306;
  $('rconPass').value = c.password || '';
  $('rconAuto').checked = c.autoConnect !== false; $('rconAutoCfg').checked = c.autoConfigure !== false;
}
function rconForm() { return { autoConfigure: $('rconAutoCfg').checked, host: $('rconHost').value.trim() || '127.0.0.1', port: Number($('rconPort').value) || 2306, password: $('rconPass').value, autoConnect: $('rconAuto').checked }; }
$('btnRconSave').onclick = (e) => run(async () => { await saveSettings({ rcon: rconForm() }); toast('RCon settings saved'); }, e.target);
$('btnRconNewPw').onclick = (e) => run(async () => {
  await saveSettings({ rcon: rconForm() });
  const r = await ipc.invoke('rcon:ensure', { regenerate: true });
  if (r.action === 'error') return toast(r.error, true);
  renderRcon(await ipc.invoke('rcon:status')); loadRconForm && loadRconForm();
  toast(r.action === 'pending' ? 'New password saved. It takes effect at the next server start; RCon keeps working with the current one until then.' : 'New random RCon password written. It is used from the next server start.');
}, e.target);
$('btnRconFromBe').onclick = (e) => run(async () => {
  await saveSettings({ rcon: rconForm() });
  const r = await ipc.invoke('rcon:ensure');
  if (r.action === 'error') return toast(r.error, true);
  renderRcon(await ipc.invoke('rcon:status')); loadRconForm && loadRconForm();
  toast(r.action === 'generated' ? 'Created an RCon password in BEServer_x64.cfg. Restart the server for BattlEye to pick it up.' : r.action === 'from-battleye' ? 'Settings filled from BEServer_x64.cfg' : r.action === 'wrote-battleye' ? 'BEServer_x64.cfg updated to match. Restart the server for BattlEye to pick it up.' : 'Already in sync');
}, e.target);
$('btnRconConnect').onclick = (e) => run(async () => { await saveSettings({ rcon: rconForm() }); const r = await ipc.invoke('rcon:connect'); renderRcon(r); if (r.waiting) toast(r.message); else refreshPlayers(); }, e.target);
$('btnRconDisconnect').onclick = (e) => run(async () => { await ipc.invoke('rcon:disconnect'); }, e.target);
$('btnRconRefresh').onclick = () => run(async () => { await refreshPlayers(); await refreshRecent(); });
ipc.on('rcon:state', (st) => { renderRcon(st); if (st.connected) refreshPlayers(); else renderPlayers([]); });
ipc.on('rcon:message', (m) => { const pre = $('rconMessages'); pre.textContent += `[${new Date(m.at).toLocaleTimeString()}] ${m.text}\n`; pre.scrollTop = pre.scrollHeight; if (/connected|disconnected/i.test(m.text)) refreshPlayers(); });
$('btnRconSay').onclick = (e) => run(async () => { const t = $('rconSayText').value.trim(); if (!t) return; await ipc.invoke('rcon:say', t, -1); toast('Sent'); $('rconSayText').value = ''; }, e.target);
$('btnRconCmd').onclick = (e) => run(async () => { const c = $('rconCmd').value.trim(); if (!c) return; const out = await ipc.invoke('rcon:command', c); $('rconOut').textContent = out || '(no output)'; if (/^(players|bans|loadBans|kick|ban|removeBan)/i.test(c)) refreshPlayers(); }, e.target);
$('rconCmd').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnRconCmd').click(); });

async function refreshPlayers() {
  if (!rconState || !rconState.connected) { renderPlayers([]); return; }
  try { const r = await ipc.invoke('rcon:players'); renderPlayers(r.players); } catch (e) { $('playersCount').textContent = e.message; }
}
function renderPlayers(list) {
  $('playersCount').textContent = rconState && rconState.connected ? `${list.length} online` : 'connect RCon to see live players';
  $('playersTable').querySelector('tbody').innerHTML = list.map(p => `
    <tr data-num="${p.num}" data-guid="${esc(p.guid)}" data-name="${esc(p.name)}">
      <td>${p.num}</td><td>${esc(p.name)}</td><td class="mono">${esc(p.guid)}</td><td class="mono">${esc(p.ip)}</td><td>${p.ping}</td>
      <td>${p.lobby ? '<span class="badge">lobby</span>' : '<span class="badge ok">in game</span>'} ${p.verified ? '' : '<span class="badge warn">unverified</span>'}</td>
      <td class="row gap"><button class="btn small pl-msg">Message</button><button class="btn small pl-kick">Kick</button><button class="btn small danger pl-ban">Ban</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No players</td></tr>';
}
async function askReason(title, withMinutes = false) {
  const ok = await showModal(title, `<label class="field">Reason <input id="mReason" class="input" placeholder="optional"></label>${withMinutes ? '<label class="field">Duration in minutes (0 = permanent) <input id="mMinutes" class="input" type="number" value="0"></label>' : ''}`,
    [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return null;
  return { reason: $('mReason').value.trim(), minutes: withMinutes ? Number($('mMinutes').value) || 0 : 0 };
}
$('playersTable').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (!tr || !tr.dataset.num) return;
  const num = Number(tr.dataset.num), guid = tr.dataset.guid, name = tr.dataset.name;
  if (e.target.classList.contains('pl-msg')) return run(async () => { const ok = await showModal(`Message ${name}`, '<textarea id="mMsg" class="input" rows="3"></textarea>', [{ label: 'Send', value: true, primary: true }, { label: 'Cancel', value: false }]); if (ok && $('mMsg').value.trim()) await ipc.invoke('rcon:say', $('mMsg').value.trim(), num); });
  if (e.target.classList.contains('pl-kick')) return run(async () => { const r = await askReason(`Kick ${name}`); if (!r) return; await ipc.invoke('rcon:kick', num, r.reason); toast(`Kicked ${name}`); setTimeout(refreshPlayers, 1000); });
  if (e.target.classList.contains('pl-ban')) return run(async () => { const r = await askReason(`BattlEye ban ${name}`, true); if (!r) return; await ipc.invoke('rcon:ban', num, r.minutes, r.reason); await ipc.invoke('lists:note', guid, { name, note: r.reason }); toast(`Banned ${name}`); setTimeout(() => { refreshPlayers(); refreshLists(); }, 1000); });
});

async function refreshRecent() {
  const list = await ipc.invoke('lists:recentPlayers');
  $('recentTable').querySelector('tbody').innerHTML = list.map(p => `
    <tr data-id="${esc(p.id || '')}" data-name="${esc(p.name)}">
      <td>${esc(p.name)}</td><td class="mono">${esc(p.id || '?')}</td><td>${esc(p.lastSeen || '')}</td><td>${esc(p.lastEvent)}</td><td>${p.connects}</td><td class="muted">${esc(p.note)}</td>
      <td class="row gap">${p.id ? '<button class="btn small rc-ban">Ban</button><button class="btn small rc-white">Whitelist</button><button class="btn small rc-prio">Priority</button>' : ''}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No player events found in the admin logs yet. Enable -adminlog in Launch Settings.</td></tr>';
}
$('btnRecentRefresh').onclick = () => run(refreshRecent);
$('recentTable').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (!tr || !tr.dataset.id) return;
  const id = tr.dataset.id, name = tr.dataset.name;
  const kind = e.target.classList.contains('rc-ban') ? 'ban' : e.target.classList.contains('rc-white') ? 'whitelist' : e.target.classList.contains('rc-prio') ? 'priority' : null;
  if (!kind) return;
  run(async () => { const r = kind === 'ban' ? await askReason(`Ban ${name} (ban.txt)`) : { reason: '' }; if (!r) return; await ipc.invoke('lists:add', kind, { id }, { name, note: r.reason }); toast(`Added ${name} to ${kind}`); refreshLists(); });
});

// ---------- lists: bans / whitelist / priority ----------
function renderListTable(tableId, entries, kind) {
  const tb = $(tableId).querySelector('tbody');
  if (kind === 'bebans') {
    tb.innerHTML = entries.map(e => `<tr data-id="${esc(e.id)}"><td class="mono">${esc(e.id)}</td><td>${e.minutes === '0' || e.minutes === 'perm' || e.minutes === '-1' ? 'permanent' : esc(e.minutes)}</td><td>${esc(e.reason || '')}</td><td>${esc(e.name)}</td><td><button class="btn small danger ls-remove">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Empty</td></tr>';
    return;
  }
  tb.innerHTML = entries.map(e => `<tr data-id="${esc(e.id)}"><td class="mono">${esc(e.id)}</td><td>${esc(e.name)}</td><td class="muted">${esc(e.note)}</td><td class="muted">${e.added ? fmtDate(e.added).split(',')[0] : ''}</td><td>${e.steamId ? steamBadges(steamMap[e.steamId]) : '<span class="muted">—</span>'}</td><td><button class="btn small danger ls-remove">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Empty</td></tr>';
}
async function refreshLists() {
  await loadSteamMap();
  const all = await ipc.invoke('lists:all');
  for (const kind of ['ban', 'whitelist', 'priority']) {
    const l = all[kind];
    $(kind + 'File').textContent = l.file + (l.exists ? '' : ' (not created yet)');
    $(kind + 'Help').textContent = l.help;
    renderListTable(kind + 'Table', l.entries, kind);
  }
  $('bebanFile').textContent = all.bebans.file + (all.bebans.exists ? '' : ' (not created yet)');
  $('bebanHelp').textContent = all.bebans.help;
  renderListTable('bebanTable', all.bebans.entries, 'bebans');
  // whitelist banner
  try {
    const cfg = await ipc.invoke('server:readConfig');
    const on = cfg && /enableWhitelist\s*=\s*1\s*;/.test(cfg);
    $('whitelistBanner').hidden = false;
    $('whitelistBanner').innerHTML = on ? '<span>enableWhitelist = 1 in serverDZ.cfg: only IDs on the whitelist can join.</span>' : '<span>enableWhitelist is 0 (or unset) in serverDZ.cfg, so the whitelist is not enforced. Change it in the Config Editor.</span>';
  } catch { $('whitelistBanner').hidden = true; }
}
for (const [tableId, kind] of [['banTable', 'ban'], ['bebanTable', 'bebans'], ['whitelistTable', 'whitelist'], ['priorityTable', 'priority']]) {
  $(tableId).addEventListener('click', e => {
    const tr = e.target.closest('tr'); if (!tr || !tr.dataset.id || !e.target.classList.contains('ls-remove')) return;
    run(async () => { await ipc.invoke('lists:remove', kind, tr.dataset.id); toast('Removed'); refreshLists(); });
  });
}
$('btnAddBan').onclick = (e) => run(async () => {
  const kind = $('banTarget').value;
  const id = $('banId').value.trim(); if (!id) return toast('Enter an ID', true);
  await ipc.invoke('lists:add', kind, { id, minutes: Number($('banMinutes').value) || 0, reason: $('banReason').value.trim() }, { name: $('banName').value.trim(), note: $('banReason').value.trim() });
  toast('Ban added' + (kind === 'ban' ? ' (takes effect on next server restart)' : ' (run loadBans via RCon or restart)'));
  $('banId').value = ''; $('banName').value = ''; $('banReason').value = '';
  refreshLists();
}, e.target);
$('btnBeLoadBans').onclick = (e) => run(async () => { const out = await ipc.invoke('rcon:command', 'loadBans'); toast(out || 'Bans reloaded'); }, e.target);
const addListEntry = (kind, idEl, nameEl) => (e) => run(async () => {
  const id = $(idEl).value.trim(); if (!id) return toast('Enter a Steam64 ID', true);
  await ipc.invoke('lists:add', kind, { id }, { name: $(nameEl).value.trim() });
  toast(kind === 'whitelist' ? 'Added to the whitelist' : 'Added to the priority queue'); $(idEl).value = ''; $(nameEl).value = ''; refreshLists();
}, e.target);
$('btnAddWl').onclick = addListEntry('whitelist', 'wlId', 'wlName');
$('btnAddPr').onclick = addListEntry('priority', 'prId', 'prName');


// ---------- discord bot ----------
let discordState = null;
function renderDiscord(st) {
  discordState = st;
  $('dotDiscord').className = 'dot ' + (st.running ? 'ok' : '');
  $('discordStatusText').textContent = st.running ? `Online as ${st.tag}` : (st.error ? `Offline: ${st.error}` : 'Bot offline');
  $('btnDiscordStart').hidden = st.running; $('btnDiscordStop').hidden = !st.running;
  const pd = $('pillDiscord'); pd.className = 'pill pill-link ' + (st.running ? 'ok' : ''); pd.innerHTML = `<span class="dot ${st.running ? 'ok' : ''}"></span>Bot: ${st.running ? 'On' : 'Off'}`; pd.title = st.running ? (st.presence ? `Online as ${st.tag || 'the bot'}: ${st.presence}` : `Online as ${st.tag || 'the bot'}`) : (st.error ? 'Offline: ' + st.error : 'Bot offline');
  $('btnDiscordInvite').disabled = !st.inviteUrl;
  if (st.mode) $('discordMode').value = st.mode;
  for (const id of ['dcSteps', 'dcTokenWrap', 'dcGuildWrap']) $(id).hidden = !!st.shared;
  $('dcSharedNote').hidden = !st.shared; $('dcFeedsRow').hidden = !st.shared;
  if (st.shared) $('discordStatusText').textContent = st.running ? `Using the main instance's bot (${st.tag})` : 'Shared: the main instance\'s bot is offline';
  $('discordInfo').textContent = st.running
    ? `${st.commands} slash commands registered${st.guildName ? ' in ' + st.guildName : ''}${st.presence ? ' · status: ' + st.presence : ''}${st.liveLogPosted ? ' · ' + st.liveLogPosted + ' log batches posted' : ''}${st.error ? ' · ' + st.error : ''}`
    : (st.hasToken ? 'Token saved. Start the bot to register commands.' : 'No token saved yet.');
  if (st.sharedWith && st.sharedWith.length) $('discordInfo').textContent += ` · shared with ${st.sharedWith.join(', ')} (commands take a server option)`;
  if (st.store) $('discordStore').textContent = `${st.store.applications} application(s) on file · ${st.store.bans} active ban(s) tracked by the bot · ${st.store.tickets || 0} open ticket(s)`;
  const pre = $('discordLog');
  pre.textContent = (st.log || []).map(l => `[${new Date(l.at).toLocaleTimeString()}] ${l.line}`).join('\n');
  pre.scrollTop = pre.scrollHeight;
}
function loadDiscordForm() {
  const c = (state.settings && state.settings.discord) || {};
  $('dcToken').value = c.token || '';
  $('dcGuild').value = c.guildId || '';
  $('dcRoles').value = (c.adminRoleIds || []).join(', ');
  $('dcLog').value = c.logChannelId || '';
  $('dcAdminChannel').value = c.adminChannelId || ''; $('dcWhitelistRole').value = c.whitelistRoleId || ''; $('dcPriorityRole').value = c.priorityRoleId || ''; $('dcBannedRole').value = c.bannedRoleId || ''; $('dcMutedRole').value = c.mutedRoleId || ''; $('dcSteamKey').value = c.steamApiKey || '';
  $('dcStatusFormat').value = c.statusFormat || 'Server Online | {count}/{max} Players'; $('dcOfflineStatus').value = c.offlineStatus || 'Server Offline';
  $('dcAuto').checked = !!c.autoStart;
  $('dcSummaryChannel').value = c.summaryChannelId || ''; $('dcSummaryTime').value = c.summaryTime || '09:00';
  $('dcTicketCategory').value = c.ticketCategoryId || ''; $('dcTicketLog').value = c.ticketLogChannelId || ''; $('dcAdminLog').value = c.adminLogChannelId || ''; { const a = (state.settings && state.settings.adminLog) || {}; $('dcReasonRequired').checked = a.requireReason !== false; $('dcAdminName').value = a.adminName || ''; } $('dcKillFeed').value = c.killFeedChannelId || ''; $('dcDeathLog').value = c.deathLogChannelId || ''; $('dcJoinFeed').value = c.joinFeedChannelId || '';
  $('dcLiveChannel').value = c.liveLogChannelId || '';
  const kinds = c.liveLogKinds || ['adm'];
  $('dcLiveAdm').checked = kinds.includes('adm'); $('dcLiveRpt').checked = kinds.includes('rpt'); $('dcLiveErrors').checked = !!c.liveLogErrorsOnly;
}
function discordForm() {
  return { token: $('dcToken').value.trim(), guildId: $('dcGuild').value.trim(), adminRoleIds: $('dcRoles').value.split(/[,\s]+/).map(x => x.trim()).filter(Boolean), logChannelId: $('dcLog').value.trim(), adminLogChannelId: $('dcAdminLog').value.trim(), autoStart: $('dcAuto').checked, adminChannelId: $('dcAdminChannel').value.trim(), whitelistRoleId: $('dcWhitelistRole').value.trim(), priorityRoleId: $('dcPriorityRole').value.trim(), bannedRoleId: $('dcBannedRole').value.trim(), mutedRoleId: $('dcMutedRole').value.trim(), steamApiKey: $('dcSteamKey').value.trim(), statusFormat: $('dcStatusFormat').value.trim() || 'Server Online | {count}/{max} Players', offlineStatus: $('dcOfflineStatus').value.trim() || 'Server Offline', liveLogChannelId: $('dcLiveChannel').value.trim(), liveLogKinds: [$('dcLiveAdm').checked ? 'adm' : null, $('dcLiveRpt').checked ? 'rpt' : null].filter(Boolean), liveLogErrorsOnly: $('dcLiveErrors').checked, summaryChannelId: $('dcSummaryChannel').value.trim(), summaryTime: $('dcSummaryTime').value.trim() || '09:00', ticketCategoryId: $('dcTicketCategory').value.trim(), ticketLogChannelId: $('dcTicketLog').value.trim(), killFeedChannelId: $('dcKillFeed').value.trim(), deathLogChannelId: $('dcDeathLog').value.trim(), joinFeedChannelId: $('dcJoinFeed').value.trim() };
}
$('btnDiscordSave').onclick = (e) => run(async () => { await saveSettings({ discord: discordForm(), adminLog: { ...((state.settings && state.settings.adminLog) || {}), requireReason: $('dcReasonRequired').checked, adminName: $('dcAdminName').value.trim() } }); await ipc.invoke('discord:applyLiveLog'); toast('Bot settings saved'); renderDiscord(await ipc.invoke('discord:status')); }, e.target);
$('btnDiscordStart').onclick = (e) => run(async () => { await saveSettings({ discord: discordForm(), adminLog: { ...((state.settings && state.settings.adminLog) || {}), requireReason: $('dcReasonRequired').checked, adminName: $('dcAdminName').value.trim() } }); toast('Starting bot…'); renderDiscord(await ipc.invoke('discord:start')); toast('Bot online'); }, e.target);
$('btnDiscordStop').onclick = (e) => run(async () => { renderDiscord(await ipc.invoke('discord:stop')); }, e.target);
$('btnDiscordInvite').onclick = () => { if (discordState && discordState.inviteUrl) { navigator.clipboard.writeText(discordState.inviteUrl); toast('Invite link copied. Open it in a browser to add the bot to your server.'); } };
document.querySelectorAll('a.ext').forEach(a => a.onclick = (e) => { e.preventDefault(); ipc.invoke('shell:openExternal', a.dataset.url); });
ipc.on('discord:state', renderDiscord);
async function refreshDiscordCommands() {
  const cmds = await ipc.invoke('discord:commands');
  $('discordCmdTable').querySelector('tbody').innerHTML = cmds.map(c => `<tr><td class="mono">/${esc(c.name)}${c.subs.length ? ' ' + c.subs.map(s => `<span class="badge">${esc(s)}</span>`).join(' ') : ''}</td><td>${esc(c.description)}</td></tr>`).join('');
}


// ---------- website ----------
let webState = null;
let webPages = [];
let webEditing = -1;
function renderWeb(st) {
  webState = st;
  { const pw = $('pillWeb'); pw.className = 'pill pill-link ' + (st.running ? 'ok' : ''); pw.innerHTML = `<span class="dot ${st.running ? 'ok' : ''}"></span>Web: ${st.running ? 'On' : 'Off'}`; pw.title = st.running ? `Website running on port ${st.port}` : (st.error ? 'Stopped: ' + st.error : 'Website stopped'); }
  if (st.site) renderSite(st.site);
  $('dotWeb').className = 'dot ' + (st.running ? 'ok' : '');
  $('webStatusText').textContent = st.running ? `Website running on port ${st.port} · ${st.requests} requests` : (st.error ? `Stopped: ${st.error}` : 'Website stopped');
  $('btnWebStart').hidden = st.running; $('btnWebStop').hidden = !st.running; $('btnWebOpen').disabled = !st.running;
  $('webUrls').textContent = (st.running ? 'Reachable at ' : 'Will be reachable at ') + st.urls.join(' · ');
}
function loadWebForm() {
  const c = webState ? webState.config : {};
  $('webTitle').value = c.title || ''; $('webTagline').value = c.tagline || ''; $('webPort').value = c.port || 8080;
  $('webAccent').value = c.accent || '#4f8cff'; $('webAddress').value = c.serverAddress || ''; refreshJoinAddress(); $('webDiscord').value = c.discordInvite || '';
  $('webBanner').value = c.bannerUrl || ''; $('webDescription').value = c.description || ''; $('webCss').value = c.customCss || '';
  refreshPortal();
  $('webShowMods').checked = c.showMods !== false; $('webShowPlayers').checked = c.showPlayers !== false; $('webShowSchedule').checked = c.showSchedule !== false; $('webEnabled').checked = !!c.enabled;
  webPages = (c.pages || []).map(p => ({ type: 'markdown', ...p }));
  renderWebPages();
  $('webPreviewPage').innerHTML = '<option value="/">Home</option><option value="mods">Mods</option>' + webPages.map(p => `<option value="${esc(p.slug)}">${esc(p.title)}</option>`).join('');
}
function webForm() {
  const c = webState ? webState.config : {};
  return { ...c, title: $('webTitle').value.trim() || 'My DayZ Server', tagline: $('webTagline').value.trim(), port: Number($('webPort').value) || 8080, accent: $('webAccent').value, serverAddress: $('webAddress').value.trim(), discordInvite: $('webDiscord').value.trim(), bannerUrl: $('webBanner').value.trim(), description: $('webDescription').value, customCss: $('webCss').value, showMods: $('webShowMods').checked, showPlayers: $('webShowPlayers').checked, showSchedule: $('webShowSchedule').checked, enabled: $('webEnabled').checked, pages: webPages };
}
// ---------- portal ----------
async function refreshPortal() {
  try {
    const p = await ipc.invoke('portal:status');
    $('portalEnabled').checked = p.enabled;
    $('portalSummary').textContent = `${p.users} user${p.users === 1 ? '' : 's'}, ${p.groups} groups${p.owners.length ? ' · can manage: ' + p.owners.join(', ') : ' · no owner account yet'}${p.url ? ' · ' + p.url : ''}${p.enabled && !p.websiteOn ? ' · the website is not running' : ''}`;
    $('btnPortalOpen').disabled = !p.url || !p.enabled || !p.websiteOn;
  } catch { /* website module not ready */ }
}
$('portalEnabled').onchange = (e) => run(async () => { await ipc.invoke('portal:setEnabled', e.target.checked); refreshPortal(); });
$('btnPortalOpen').onclick = () => run(async () => { const p = await ipc.invoke('portal:status'); if (p.url) ipc.invoke('shell:openExternal', p.url); });
$('btnPortalOwner').onclick = (e) => run(async () => {
  const ok = await showModal('Owner account', '<p class="muted">The account that manages the portal. Creating one turns the portal on; naming an existing user makes them an owner and sets a new password (use this if you are locked out).</p><label class="field">User name <input id="poName" class="input" placeholder="e.g. chris"></label><label class="field">Password (8+ characters) <input id="poPass" class="input" type="password" autocomplete="new-password"></label>', [{ label: 'Save', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return; await ipc.invoke('portal:setOwner', $('poName').value.trim(), $('poPass').value); toast('Owner account saved; sign in on the portal'); refreshPortal();
}, e.target);
$('btnPortalUsers').onclick = (e) => run(async () => {
  const d = await ipc.invoke('portal:users');
  const rows = d.users.map(u => `<tr><td>${esc(u.name)}${u.enabled ? '' : ' <span class="badge">disabled</span>'}</td><td>${esc(u.groups.map(g => (d.groups.find(x => x.id === g) || { name: g }).name).join(', ') || '—')}</td><td class="muted">${u.perms.length}/${d.catalogue.length}</td><td class="muted">${u.lastLogin ? esc(fmtDate(Date.parse(u.lastLogin))) : 'never'}</td><td><button class="btn small danger po-del" data-id="${esc(u.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No users yet: create the owner account.</td></tr>';
  const groups = d.groups.map(g => `<div><b>${esc(g.name)}</b> <span class="muted">${g.perms.length === d.catalogue.length ? 'everything' : g.perms.length + ' permissions'} · ${g.members} member${g.members === 1 ? '' : 's'}</span></div>`).join('');
  const p = showModal('Portal users', `<div class="table-wrap" style="max-height:260px"><table class="table"><thead><tr><th>User</th><th>Groups</th><th>Perms</th><th>Last login</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="card-title mt">Groups</div>${groups}<p class="muted small">Add users, change groups and set each permission inside the portal (Users page) with an account that can manage the portal.</p>`, [{ label: 'Close', value: true, primary: true }]);
  setTimeout(() => { for (const b of document.querySelectorAll('.po-del')) b.onclick = async () => { try { await ipc.invoke('portal:deleteUser', b.dataset.id); toast('User deleted'); $('modalActions').lastElementChild.click(); $('btnPortalUsers').click(); } catch (err) { toast(err.message, true); } }; }, 0);
  await p; refreshPortal();
}, e.target);
async function saveWeb() { await saveSettings({ website: webForm() }); renderWeb(await ipc.invoke('website:status')); refreshWebPreview(); }
$('btnWebSave').onclick = (e) => run(async () => { await saveWeb(); toast('Website settings saved'); }, e.target);
$('btnWebStart').onclick = (e) => run(async () => { await saveWeb(); renderWeb(await ipc.invoke('website:start')); toast('Website started'); refreshWebPreview(); }, e.target);
$('btnWebStop').onclick = (e) => run(async () => { renderWeb(await ipc.invoke('website:stop')); }, e.target);
$('btnWebOpen').onclick = () => { if (webState && webState.running) ipc.invoke('shell:openExternal', `http://localhost:${webState.port}/`); };
ipc.on('website:state', renderWeb);

function renderWebPages() {
  $('webPageList').innerHTML = webPages.map((p, i) => `<div class="file ${i === webEditing ? 'active' : ''}" data-i="${i}"><span class="name">${esc(p.title)} <span class="muted">/${esc(p.slug)}</span></span><span class="meta">${p.type === 'html' ? 'HTML' : 'Markdown'}</span></div>`).join('') || '<div class="muted" style="padding:6px">No pages yet.</div>';
}
function openWebPage(i) {
  webEditing = i; renderWebPages();
  const p = webPages[i]; $('webPageEditor').hidden = !p;
  if (!p) return;
  $('webPageTitle').value = p.title; $('webPageSlug').value = p.slug; $('webPageType').value = p.type || 'markdown'; $('webPageContent').value = p.content || '';
}
$('webPageList').addEventListener('click', e => { const f = e.target.closest('.file'); if (f) openWebPage(Number(f.dataset.i)); });
$('btnWebAddPage').onclick = () => { webPages.push({ slug: 'new-page', title: 'New page', type: 'markdown', content: '# New page\n\nWrite something here.' }); openWebPage(webPages.length - 1); };
$('btnWebPageSave').onclick = (e) => run(async () => {
  const p = webPages[webEditing]; if (!p) return;
  const slug = $('webPageSlug').value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || ['mods', 'api', 'assets'].includes(slug)) return toast('Pick a different slug', true);
  if (webPages.some((x, i) => i !== webEditing && x.slug === slug)) return toast('Another page already uses that slug', true);
  Object.assign(p, { title: $('webPageTitle').value.trim() || 'Page', slug, type: $('webPageType').value, content: $('webPageContent').value });
  await saveWeb(); loadWebForm(); openWebPage(webEditing); toast('Page saved');
}, e.target);
$('btnWebPageDelete').onclick = (e) => run(async () => {
  const p = webPages[webEditing]; if (!p) return;
  const ok = await showModal(`Delete page "${p.title}"?`, '', [{ label: 'Delete', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  webPages.splice(webEditing, 1); webEditing = -1; $('webPageEditor').hidden = true;
  await saveWeb(); loadWebForm(); toast('Page deleted');
}, e.target);
$('btnWebPagePreview').onclick = () => run(async () => { const p = webPages[webEditing]; if (!p) return; $('webPreviewPage').value = p.slug; await saveWeb(); refreshWebPreview(); });

async function refreshWebPreview() {
  try { const html = await ipc.invoke('website:preview', $('webPreviewPage').value); $('webPreview').srcdoc = html.replace('<link rel="stylesheet" href="/assets/site.css">', `<style>${await previewCss()}</style>`); } catch (e) { $('webPreview').srcdoc = `<p style="color:#f66;font-family:sans-serif">${esc(e.message)}</p>`; }
}
async function previewCss() {
  // The preview is rendered without the server, so inline the stylesheet by asking for it through the preview route.
  try { return await ipc.invoke('website:preview', '__css__'); } catch { return ''; }
}
$('btnWebPreviewRefresh').onclick = () => refreshWebPreview();
$('webPreviewPage').onchange = () => refreshWebPreview();

async function refreshWebFiles() {
  const r = await ipc.invoke('website:files');
  $('webFilesDir').textContent = r.dir;
  $('webFilesTable').querySelector('tbody').innerHTML = r.files.map(f => `<tr data-name="${esc(f.name)}"><td class="mono">${esc(f.name)}${f.special ? ' <span class="badge ok">override</span>' : ''}</td><td class="muted">${fmtBytes(f.size)}</td><td class="mono muted">${esc(f.url)}</td><td><button class="btn small danger wf-del">✕</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No custom files yet.</td></tr>';
}
$('btnWebAddFiles').onclick = (e) => run(async () => { const r = await ipc.invoke('website:addFiles', ''); if (r.added && r.added.length) toast(`Added ${r.added.length} file(s)`); refreshWebFiles(); }, e.target);
$('btnWebOpenFolder').onclick = () => ipc.invoke('website:openFolder');
$('btnWebStarterTemplate').onclick = (e) => run(async () => { await ipc.invoke('website:starter', 'template.html'); toast('template.html created in the website folder'); refreshWebFiles(); }, e.target);
$('btnWebStarterCss').onclick = (e) => run(async () => { await ipc.invoke('website:starter', 'site.css'); toast('site.css created'); refreshWebFiles(); }, e.target);
$('btnWebStarterIndex').onclick = (e) => run(async () => { await ipc.invoke('website:starter', 'index.html'); toast('index.html created'); refreshWebFiles(); }, e.target);
$('webFilesTable').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (!tr || !tr.dataset.name || !e.target.classList.contains('wf-del')) return;
  run(async () => { const ok = await showModal('Delete file?', `<div class="dep">${esc(tr.dataset.name)}</div>`, [{ label: 'Delete', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) return; await ipc.invoke('website:removeFile', tr.dataset.name); refreshWebFiles(); });
});
// --- your own website: drag & drop / pick ---
function renderSite(info) {
  if (!info) return;
  $('siteActions').hidden = !info.active;
  $('siteInfo').innerHTML = info.active
    ? `<span class="badge ok">active</span> <b>${esc(info.name || 'site')}</b> · ${info.files} files · ${fmtBytes(info.bytes)}${info.importedAt ? ' · imported ' + fmtDate(info.importedAt) : ''}${info.hasStatusScript ? ' · uses live data' : ''}. Served from <code>${esc(info.dir)}</code>; edit files there and refresh.`
    : 'No custom site installed. The generated pages are being served.';
}
async function importSitePath(p) {
  if (!p) return toast('Could not read the dropped item', true);
  return run(async () => {
    toast('Importing site…');
    const info = await ipc.invoke('website:importSite', p);
    renderSite(info); toast(`Site installed: ${info.files} files`);
    refreshWebPreview();
  });
}
const dz = $('siteDrop');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return toast('Drop a folder or a .zip file', true);
  importSitePath(ipc.pathForFile(f));
});
// Stop the window from navigating when something is dropped outside the zone.
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());
$('btnSitePickFolder').onclick = (e) => run(async () => { const info = await ipc.invoke('website:pickSite', 'folder'); if (info) { renderSite(info); toast('Site installed'); refreshWebPreview(); } }, e.target);
$('btnSitePickZip').onclick = (e) => run(async () => { const info = await ipc.invoke('website:pickSite', 'zip'); if (info) { renderSite(info); toast('Site installed'); refreshWebPreview(); } }, e.target);
$('btnSiteOpenFolder').onclick = () => ipc.invoke('website:openSiteFolder');
$('btnSiteRemove').onclick = (e) => run(async () => {
  const ok = await showModal('Remove your site?', '<p>The site files are deleted from the website folder and the generated pages come back. Your original folder or zip is untouched.</p>', [{ label: 'Remove', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  renderSite(await ipc.invoke('website:removeSite')); toast('Custom site removed'); refreshWebPreview();
}, e.target);

// ----- domain / HTTPS / dynamic DNS -----
function domFormVisibility() {
  const mode = $('domHttps').value; document.querySelectorAll('.dom-manual').forEach(x => { x.hidden = mode !== 'manual'; }); document.querySelectorAll('.dom-le').forEach(x => { x.hidden = mode === 'off'; });
  document.querySelectorAll('.ddns-cf').forEach(x => { x.hidden = $('ddnsProvider').value !== 'cloudflare'; });
  $('btnDomIssue').hidden = mode !== 'letsencrypt';
}
function renderDomain(st) {
  const c = st.config;
  $('domName').value = c.name || ''; $('domHttps').value = c.https || 'off'; $('domHttpPort').value = c.httpPort || ''; $('domHttpsPort').value = c.httpsPort || 443; $('domEmail').value = c.email || ''; $('domRedirect').checked = c.redirectHttp !== false;
  $('domCert').placeholder = c.certPem ? '(certificate set; paste to replace)' : '-----BEGIN CERTIFICATE-----'; $('domKey').placeholder = c.keyPem ? '(key set; paste to replace)' : '-----BEGIN PRIVATE KEY-----';
  $('ddnsProvider').value = c.ddns.provider || 'none'; $('ddnsRecord').value = c.ddns.record || ''; $('ddnsZone').value = c.ddns.zoneId || ''; $('ddnsInterval').value = c.ddns.intervalMin || 10; $('ddnsToken').placeholder = c.ddns.token ? '(token set; paste to replace)' : 'API token';
  $('domStatus').textContent = st.publicUrl || '';
  $('domCertInfo').textContent = st.issuing ? 'Requesting certificate…' : st.cert ? `Certificate: ${st.cert.source === 'letsencrypt' ? "Let's Encrypt" : 'your own'}, ${st.cert.daysLeft !== null ? st.cert.daysLeft + ' days left' : 'expiry unknown'}${st.cert.source === 'letsencrypt' ? ' (renews automatically)' : ''}` : (c.https === 'off' ? '' : st.lastIssueError ? 'Last attempt failed: ' + st.lastIssueError : 'No certificate yet.');
  $('ddnsInfo').textContent = c.ddns.provider === 'none' ? '' : st.ddns.updating ? 'Updating…' : st.ddns.lastError ? 'Last update failed: ' + st.ddns.lastError : st.ddns.lastUpdate ? `Last update ${fmtDate(st.ddns.lastUpdate)} → ${st.ddns.lastIp}` : 'Not updated yet.';
  domFormVisibility();
}
function domForm() {
  const o = { name: $('domName').value.trim().toLowerCase(), https: $('domHttps').value, httpPort: Number($('domHttpPort').value) || 0, httpsPort: Number($('domHttpsPort').value) || 443, email: $('domEmail').value.trim(), redirectHttp: $('domRedirect').checked,
    ddns: { provider: $('ddnsProvider').value, record: $('ddnsRecord').value.trim(), zoneId: $('ddnsZone').value.trim(), intervalMin: Number($('ddnsInterval').value) || 10 } };
  if ($('domCert').value.trim()) o.certPem = $('domCert').value.trim(); if ($('domKey').value.trim()) o.keyPem = $('domKey').value.trim();
  if ($('ddnsToken').value.trim()) o.ddns.token = $('ddnsToken').value.trim();
  return o;
}
async function refreshDomain() { try { renderDomain(await ipc.invoke('domain:status')); } catch { /* ignore */ } }
$('domHttps').onchange = domFormVisibility; $('ddnsProvider').onchange = domFormVisibility;
$('btnDomSave').onclick = (e) => run(async () => {
  const f = domForm(); // blank token / PEM fields keep the stored values (the backend merges)
  renderDomain(await ipc.invoke('domain:save', f));
  $('domCert').value = ''; $('domKey').value = ''; $('ddnsToken').value = '';
  toast('Domain settings saved' + (webState && webState.running ? '. Restart the website to apply HTTPS changes.' : ''));
  if (f.https !== 'off' && (f.httpPort || 0) !== 80 && f.https === 'letsencrypt') toast("Let's Encrypt needs HTTP on port 80: set \"Listen for HTTP on port\" to 80 and forward it.", true);
  refreshNetwork && refreshNetwork().catch(() => {});
}, e.target);
$('btnDomIssue').onclick = (e) => run(async () => { toast('Requesting certificate, this takes up to a minute…'); renderDomain(await ipc.invoke('domain:issue', {})); toast('Certificate issued'); renderWeb(await ipc.invoke('website:status')); }, e.target);
$('btnDdnsNow').onclick = (e) => run(async () => { renderDomain(await ipc.invoke('domain:updateDns')); toast('DNS updated'); }, e.target);
ipc.on('domain:state', renderDomain);
ipc.on('website:state', () => { refreshDomain(); });

async function refreshWebsite() { refreshWebAddresses(); refreshDomain(); renderWeb(await ipc.invoke('website:status')); loadWebForm(); refreshWebFiles(); refreshWebPreview(); }


// what the site shows as the join address when the field is left empty
async function refreshJoinAddress() {
  let j = null; try { j = await ipc.invoke('website:joinAddress'); } catch { /* ignore */ }
  const typed = $('webAddress').value.trim();
  if (typed) { $('webAddressAuto').textContent = 'Typed by you; clear it to use the automatic address' + (j && j.source !== 'manual' && j.address ? ' (' + j.address + ')' : '') + '.'; return; }
  $('webAddress').placeholder = j && j.address ? j.address : 'automatic';
  $('webAddressAuto').textContent = j && j.address ? `Automatic: ${j.source === 'domain' ? 'your domain' : 'your public IP'} and the game port${j.source === 'public-ip' ? ' (updates if your IP changes)' : ''}. Type here to override.` : 'Automatic once the public IP can be looked up. Type here to override.';
}
$('webAddress').addEventListener('input', () => refreshJoinAddress());
async function refreshWebAddresses() {
  const box = $('webAddresses');
  let a; try { a = await ipc.invoke('network:addresses'); } catch (e) { box.innerHTML = '<div class="muted">' + esc(e.message) + '</div>'; return; }
  const row = (label, value, hint) => value ? `<div class="row gap" style="align-items:center"><span class="muted" style="width:150px">${label}</span><code class="mono">${esc(value)}</code><button class="btn small addr-copy" data-value="${esc(value)}">Copy</button>${hint ? '<span class="muted">' + esc(hint) + '</span>' : ''}</div>` : `<div class="row gap" style="align-items:center"><span class="muted" style="width:150px">${label}</span><span class="muted">${esc(hint || 'unknown')}</span></div>`;
  const rows = [];
  for (const l of a.lan) { rows.push(row('Inward (LAN) IP', l.ip, l.name)); rows.push(row('Inward website', `http://${l.ip}:${a.port}/`, 'same network')); }
  if (!a.lan.length) rows.push(row('Inward (LAN) IP', null, 'no network adapter found'));
  rows.push(row('Outward (public) IP', a.publicIp, a.publicIp ? 'what the internet sees' : 'could not reach the lookup service'));
  rows.push(row('Outward website', a.publicIp ? `http://${a.publicIp}:${a.port}/` : null, a.publicIp ? 'needs port ' + a.port + ' forwarded on your router (button above); test it from outside your network, e.g. a phone on mobile data, since many routers refuse their own public address from inside' : ''));
  rows.push(row('Game server (public)', a.publicIp ? `${a.publicIp}:${a.gamePort}` : null, a.publicIp ? 'direct connect address for players' : ''));
  box.innerHTML = rows.join('');
  box.querySelectorAll('.addr-copy').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.value); toast('Copied ' + b.dataset.value); });
}
$('btnWebAddrRefresh').onclick = () => refreshWebAddresses();
function upnpResultText(r) { return r.results.map(x => `${x.name} ${x.proto} ${x.port}: ${x.ok ? 'forwarded' : 'failed (' + x.error + ')'}`).join('\n'); }
$('btnWebUpnp').onclick = (e) => run(async () => {
  try { const r = await ipc.invoke('network:upnpMap', ['Website']); const ok = r.results.every(x => x.ok); toast((ok ? 'Router now forwards the website port to this PC' : upnpResultText(r)) + (r.externalIp ? ' · router reports public IP ' + r.externalIp : ''), !ok); }
  catch (err) { toast(err.message, true); }
}, e.target);
async function refreshUpnp() {
  const box = $('upnpBox'); box.textContent = 'Asking the router…';
  try {
    const st = await ipc.invoke('network:upnpStatus');
    box.innerHTML = `<div>Router: <b>${esc(st.router)}</b> · this PC: <span class="mono">${esc(st.lan || '?')}</span>${st.externalIp ? ' · public IP ' + esc(st.externalIp) : ''}</div>` + st.ports.map(p => `<div class="row gap"><span style="width:150px">${esc(p.name)} ${p.proto} ${p.port}</span>${p.forwarded ? (p.toThisPc ? '<span class="badge ok">forwarded to this PC</span>' : '<span class="badge warn">forwarded to ' + esc(p.client) + '</span>') : '<span class="badge">not forwarded</span>'}</div>`).join('');
  } catch (e) { box.textContent = e.message; }
}
$('btnUpnpCheck').onclick = () => refreshUpnp();
$('btnUpnpOpen').onclick = (e) => run(async () => { try { const r = await ipc.invoke('network:upnpMap', []); toast(r.results.every(x => x.ok) ? 'All ports forwarded to this PC' : upnpResultText(r), !r.results.every(x => x.ok)); } catch (err) { toast(err.message, true); } refreshUpnp(); }, e.target);
$('btnUpnpClose').onclick = (e) => run(async () => { try { const r = await ipc.invoke('network:upnpUnmap', []); toast(r.results.every(x => x.ok) ? 'Forwards removed' : upnpResultText(r), !r.results.every(x => x.ok)); } catch (err) { toast(err.message, true); } refreshUpnp(); }, e.target);

// ---------- health, alerts, crash reports ----------
function drawSpark(id, values, { max = null, color = '#4f8cff' } = {}) {
  const c = $(id); if (!c) return;
  const ctx = c.getContext('2d'); const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const vals = values.map(v => (v === null || v === undefined) ? null : v);
  const present = vals.filter(v => v !== null);
  if (!present.length) { ctx.fillStyle = '#3a4152'; ctx.fillRect(0, H - 1, W, 1); return; }
  const hi = max || Math.max(1, ...present), lo = 0;
  const x = i => (i / Math.max(1, vals.length - 1)) * (W - 2) + 1;
  const y = v => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);
  ctx.beginPath(); let started = false;
  vals.forEach((v, i) => { if (v === null) { started = false; return; } if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v)); });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.lineTo(x(vals.length - 1), H); ctx.lineTo(x(0), H); ctx.closePath();
  ctx.fillStyle = color + '22'; ctx.fill();
}
async function refreshHealth() {
  const range = Number($('healthRange').value) || 180;
  const hist = await ipc.invoke('health:history', range);
  const cur = await ipc.invoke('health:current');
  // bucket to ~120 points so the canvas stays readable
  const step = Math.max(1, Math.ceil(hist.length / 120));
  const pick = k => { const out = []; for (let i = 0; i < hist.length; i += step) { const slice = hist.slice(i, i + step).map(m => m[k]).filter(v => v !== null && v !== undefined); out.push(slice.length ? Math.round(slice.reduce((x, y) => x + y, 0) / slice.length) : null); } return out; };
  drawSpark('sparkCpu', pick('cpu'), { max: 100, color: '#4f8cff' });
  drawSpark('sparkRam', pick('ram'), { color: '#8a5cff' });
  drawSpark('sparkFps', pick('fps'), { color: '#3ddc84' });
  drawSpark('sparkPlayers', pick('players'), { color: '#f5b942' });
  $('valCpu').textContent = cur.cpu === null || cur.cpu === undefined ? '—' : cur.cpu + '%';
  $('valRam').textContent = cur.ramMB ? (cur.ramMB / 1024).toFixed(1) + ' GB' : '—';
  $('valFps').textContent = cur.fps === null || cur.fps === undefined ? '—' : String(cur.fps);
  $('valPlayers').textContent = cur.players === null || cur.players === undefined ? '—' : String(cur.players);
}
$('healthRange').onchange = () => refreshHealth();
ipc.on('health:sample', () => { if (document.querySelector('#page-dashboard.active')) refreshHealth(); });
async function refreshAlertList() {
  const list = await ipc.invoke('alerts:recent');
  $('alertList').innerHTML = list.length ? list.slice(0, 20).map(al => `<div class="alert-item"><span class="alert-ic k-${esc(al.kind)}"></span><div><div class="alert-title">${al.kind === 'server-critical' ? '<span class="badge bad">critical</span> ' : al.kind === 'server-major' ? '<span class="badge warn">major</span> ' : al.kind === 'server-minor' ? '<span class="badge">minor</span> ' : ''}${esc(al.title)}</div>${al.details ? `<div class="muted alert-details">${esc(al.details.split('\n')[0])}</div>` : ''}</div><span class="muted alert-time">${new Date(al.at).toLocaleTimeString()}</span></div>`).join('') : '<div class="muted">No alerts yet.</div>';
}
ipc.on('alerts:new', (al) => { if (al.kind === 'server-critical' || al.kind === 'server-major') pinCritical(al.kind === 'server-critical' ? 'critical' : 'major', al.details || al.title); refreshAlertList(); if (['crash', 'crash-loop', 'backup-failed', 'update-failed', 'server-critical'].includes(al.kind)) toast(al.title, true); });
$('btnAlertsPage').onclick = () => showPage('alerts');
let alertsCfg = null;
async function loadAlertsPage() {
  alertsCfg = await ipc.invoke('alerts:config');
  const kinds = { 'server-critical': 'Server critical error (from the server log)', 'server-major': 'Server error (from the server log)', 'server-minor': 'Server warning (from the server log)', crash: 'Server crashed / exited unexpectedly', 'crash-loop': 'Crash loop detected', restart: 'Scheduled restart', 'server-up': 'Server started', 'backup-failed': 'Backup failed', 'update-available': 'Mod updates available', 'update-done': 'Update run finished', 'update-failed': 'Update failed', 'low-fps': 'Low server FPS', 'high-ram': 'High memory use', 'rcon-lost': 'RCon connection lost', 'bot-offline': 'Discord bot went offline', 'steam-ban': 'Player picked up a Steam ban (VAC / game / trade)', 'suspicious-player': 'Flagged player joined (possible alt or banned account)', 'suspicious-activity': 'Suspicious combat activity (possible cheating)', 'web-stack': 'Vulnerable PHP / web server running on this machine' };
  $('alertKindsTable').querySelector('tbody').innerHTML = Object.entries(kinds).map(([k, label]) => `<tr data-kind="${k}"><td>${esc(label)}</td><td><input type="checkbox" class="al-toast" ${alertsCfg.toast[k] ? 'checked' : ''}></td><td><input type="checkbox" class="al-discord" ${alertsCfg.discord[k] ? 'checked' : ''}></td><td><input type="checkbox" class="al-webhook" ${alertsCfg.webhook[k] ? 'checked' : ''}></td></tr>`).join('');
  $('alertChannel').value = alertsCfg.alertChannelId || ''; $('alertWebhook').value = alertsCfg.webhookUrl || '';
  const t = alertsCfg.thresholds; $('thFps').value = t.fpsBelow; $('thFpsFor').value = t.fpsForSec; $('thRam').value = t.ramAboveMB; $('thLoopCount').value = t.crashLoopCount; $('thLoopMin').value = t.crashLoopMinutes;
}
$('btnAlertsSave').onclick = (e) => run(async () => {
  const toast_ = {}, discord_ = {}, webhook_ = {};
  $('alertKindsTable').querySelectorAll('tr[data-kind]').forEach(tr => { const k = tr.dataset.kind; toast_[k] = tr.querySelector('.al-toast').checked; discord_[k] = tr.querySelector('.al-discord').checked; webhook_[k] = tr.querySelector('.al-webhook').checked; });
  await saveSettings({ alerts: { toast: toast_, discord: discord_, webhook: webhook_, alertChannelId: $('alertChannel').value.trim(), webhookUrl: $('alertWebhook').value.trim(), thresholds: { fpsBelow: Number($('thFps').value) || 15, fpsForSec: Number($('thFpsFor').value) || 120, ramAboveMB: Number($('thRam').value) || 12000, crashLoopCount: Number($('thLoopCount').value) || 3, crashLoopMinutes: Number($('thLoopMin').value) || 10 } } });
  toast('Alert settings saved');
}, e.target);
$('btnAlertTest').onclick = (e) => run(async () => { await ipc.invoke('alerts:test'); toast('Test alert sent'); }, e.target);
async function refreshCrashes() {
  const r = await ipc.invoke('crashes:list');
  $('crashDir').textContent = r.dir;
  $('crashList').innerHTML = r.reports.length ? r.reports.map(c => `
    <div class="group" data-name="${esc(c.name)}">
      <div class="head"><span><span class="badge ${c.verdict.level === 'critical' || c.verdict.level === 'bad' ? 'bad' : c.verdict.level === 'warn' ? 'warn' : 'ok'}">${esc(c.verdict.level)}</span> <b>${esc(c.name)}</b> · exit code ${c.exitCode} · ran ${c.ranForSec ? Math.round(c.ranForSec / 60) + ' min' : '?'} · ${fmtBytes(c.size)}</span><span>${fmtDate(c.at)}</span></div>
      <div class="sample">${esc(c.verdict.text)}${c.topErrors.length ? '\n' + c.topErrors.map(g => `${g.label} ×${g.count}: ${g.sample}`).map(esc).join('\n') : ''}</div>
      <div class="row gap mt"><button class="btn small cr-post">Post to Discord</button><button class="btn small danger cr-del">Delete</button></div>
    </div>`).join('') : '<div class="muted">No crash reports. They are created automatically when the server exits unexpectedly.</div>';
}
$('crashList').addEventListener('click', e => {
  const g = e.target.closest('.group'); if (!g) return;
  if (e.target.classList.contains('cr-del')) return run(async () => { await ipc.invoke('crashes:remove', g.dataset.name); refreshCrashes(); });
  if (e.target.classList.contains('cr-post')) return run(async () => { await ipc.invoke('crashes:post', g.dataset.name); toast('Posted'); }, e.target);
});
$('btnCrashOpenFolder').onclick = () => ipc.invoke('crashes:openFolder');
ipc.on('crashes:changed', () => { if (logTab === 'crashes') refreshCrashes(); });


// ---------- Steam ban badges ----------
let steamMap = {};
function steamBadges(r) {
  if (!r) return '<span class="muted">—</span>';
  const b = [];
  if (r.vacBanned) b.push(`<span class="badge bad" title="${r.vacBans} VAC ban(s), last ${r.daysSinceLastBan} days ago">VAC</span>`);
  if (r.gameBans > 0) b.push(`<span class="badge bad" title="${r.gameBans} game ban(s)">game ban</span>`);
  if (r.tradeBanned) b.push('<span class="badge warn">trade ban</span>');
  if (r.communityBanned) b.push('<span class="badge warn">community ban</span>');
  if (!b.length) b.push('<span class="badge ok" title="No VAC, game, trade or community bans">clean</span>');
  if (r.isPrivate) b.push('<span class="badge" title="Private Steam profile">private</span>');
  return b.join(' ');
}
async function loadSteamMap() { try { steamMap = await ipc.invoke('steam:all'); } catch { steamMap = {}; } }
ipc.on('accounts:changed', () => { if (document.querySelector('#page-database.active')) refreshPdb(); });
ipc.on('steam:changed', async (d) => { await loadSteamMap(); if (d && d.checked) toast(`Steam check: ${d.checked} account(s)${d.newBans ? ', ' + d.newBans + ' new ban(s)' : ''}`); if (document.querySelector('#page-database.active')) refreshPdb(); else refreshLists().catch(() => {}); });

// ---------- player database ----------
let pdbRows = [], pdbSelected = null;
function fmtPlaytime(sec) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }
async function refreshPdb() {
  if (!Object.keys(steamMap).length) await loadSteamMap();
  pdbRows = await ipc.invoke('players:all', { query: $('pdbQuery').value.trim(), sort: $('pdbSort').value });
  const st = await ipc.invoke('players:stats');
  $('pdbStats').textContent = `${st.total} players · ${st.today} today · ${st.week} this week · peak today ${st.peakToday} · ${fmtPlaytime(st.totalPlaytimeSec)} total`;
  $('pdbTable').querySelector('tbody').innerHTML = pdbRows.map(r => `<tr data-key="${esc(r.key)}" class="${pdbSelected === r.key ? 'selected' : ''}">
    <td>${r.online ? '<span class="dot ok" style="margin-right:6px"></span>' : ''}${esc(r.name)}${r.characterName && r.characterName !== r.name ? ` <span class="muted">(${esc(r.characterName)})</span>` : ''}</td>
    <td class="mono">${esc(r.steamId || r.id || '?')}</td><td class="muted">${r.lastSeen ? fmtDate(r.lastSeen) : '—'}</td><td>${fmtPlaytime(r.playtimeSec)}</td><td>${r.kills} / ${r.deaths}</td>
    <td>${r.banned ? '<span class="badge bad">banned</span> ' : ''}${r.whitelisted ? '<span class="badge ok">whitelist</span> ' : ''}${r.priority ? '<span class="badge">priority</span> ' : ''}${r.application ? `<span class="badge">app: ${esc(r.application)}</span>` : ''}${r.account && r.account.suspicious ? ` <span class="badge warn" title="${esc(r.account.flags.join('; '))}">⚠ ${r.account.score}</span>` : ''}${r.combat && r.combat.flagScore ? ` <span class="badge bad" title="${esc(r.combat.flags.map(f => f.reason + ' ×' + f.n).join('; '))}">⚠ combat ${r.combat.flagScore}</span>` : ''}</td><td>${r.steamId ? steamBadges(r.steam) : '<span class="muted">—</span>'}</td><td class="pdb-roles" data-discord="${esc(r.discordId || '')}">${r.discordId ? '<span class="muted">…</span>' : '<span class="muted">—</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No players recorded yet. The database fills from the admin log (-adminlog) while the server runs.</td></tr>';
  if (pdbSelected) renderPdbDetail(pdbRows.find(r => r.key === pdbSelected) || await ipc.invoke('players:get', pdbSelected));
  fillDiscordRoles();
}
// Ask the bot which configured roles each listed member holds and compare with the list files.
let pdbRoles = {};
function roleCell(r, roles) {
  if (!roles) return '<span class="muted">bot offline</span>';
  if (!roles.member) return '<span class="muted" title="Not in the Discord server">not in server</span>';
  const want = { whitelist: r.whitelisted, priority: r.priority, banned: r.banned };
  const out = [];
  for (const k of ['whitelist', 'priority', 'banned', 'muted']) {
    if (roles[k] === null || roles[k] === undefined) continue; // role not configured
    const has = roles[k]; const expect = want[k];
    if (!has && !expect) continue;
    const mismatch = expect !== undefined && has !== expect;
    const cls = k === 'banned' || k === 'muted' ? 'bad' : 'ok';
    const title = mismatch ? (has ? 'Has the role but is not on the list' : 'On the list but missing the role (the next sync adds it)') : 'Role matches the list';
    out.push(`<span class="badge ${mismatch ? 'warn' : (has ? cls : '')}" title="${title}">${has ? '' : '⚠ no '}${k}${mismatch && has ? ' ⚠' : ''}</span>`);
  }
  return out.join(' ') || '<span class="muted">none</span>';
}
async function fillDiscordRoles() {
  const cells = [...$('pdbTable').querySelectorAll('td.pdb-roles[data-discord]')].filter(td => td.dataset.discord);
  if (!cells.length) return;
  const ids = [...new Set(cells.map(td => td.dataset.discord))];
  try { pdbRoles = await ipc.invoke('players:discordRoles', ids); } catch { pdbRoles = {}; }
  for (const td of cells) { const r = pdbRows.find(x => x.discordId === td.dataset.discord); td.innerHTML = roleCell(r || {}, pdbRoles[td.dataset.discord]); }
  if (pdbSelected) { const r = pdbRows.find(x => x.key === pdbSelected); const box = $('pdbDetail').querySelector('#pdRoles'); if (r && box) box.innerHTML = r.discordId ? roleCell(r, pdbRoles[r.discordId]) : '—'; }
}
function accountSection(r) {
  const a = r.account; if (!a) return '';
  const st = a.steam; const age = st && st.created ? Math.round((Date.now() - st.created) / 86400000) : null;
  const facts = st ? [
    age !== null ? `created ${fmtDate(st.created).split(',')[0]} (${age} days)` : 'creation date hidden',
    st.level !== null ? `level ${st.level}` : 'level unknown',
    st.games !== null ? `${st.games} games` : 'games hidden',
    st.isPrivate ? 'private profile' : 'public profile',
    st.ownsDayZ === false ? 'DayZ not in library' : ''
  ].filter(Boolean).join(' · ') + ` <span class="muted">checked ${fmtDate(st.checkedAt)}</span>` : (r.steamId ? '<span class="muted">not checked yet</span> <button class="btn small" id="pdAccCheck">Check account</button>' : '<span class="muted">Steam64 unknown</span>');
  const shared = Object.entries(a.shared || {});
  return `<div class="card-title mt row between"><span>Account check ${a.suspicious ? `<span class="badge warn">⚠ score ${a.score}</span>` : `<span class="badge ok">score ${a.score}</span>`}</span><span class="row gap">${st && r.steamId ? '<button class="btn small" id="pdAccCheck">Re-check</button>' : ''}${a.battlemetricsUrl ? '<button class="btn small" id="pdBm">BattleMetrics</button>' : ''}</span></div>
    <div class="pdb-kv">
      <div><span class="muted">Steam account</span><br>${facts}</div>
      ${a.flags.length ? `<div><span class="muted">Flags</span><br>${a.flags.map(f => `<span class="badge warn">${esc(f)}</span>`).join(' ')}</div>` : ''}
      <div><span class="muted">IPs seen (from RCon)</span><br>${a.ips.length ? a.ips.slice(0, 6).map(x => `<span class="mono">${esc(x.ip)}</span> <span class="muted">×${x.count || 1}, last ${fmtDate(x.last).split(',')[0]}</span>`).join('<br>') : '<span class="muted">none yet (needs RCon connected while they play)</span>'}</div>
      ${shared.length ? `<div><span class="muted">Shares an IP with</span><br>${shared.map(([g, x]) => `<b>${esc(x.name)}</b>${x.steamId ? ' <span class="mono muted">' + esc(x.steamId) + '</span>' : ''} <span class="muted">(${x.ips.map(esc).join(', ')})</span>`).join('<br>')}<div class="muted">Same household or carrier NAT can also cause this. Treat it as a lead, not proof.</div></div>` : ''}
    </div>`;
}
function renderPdbDetail(r) {
  const box = $('pdbDetail');
  if (!r) { box.innerHTML = '<div class="empty">Select a player to see their history.</div>'; return; }
  const sessions = r.sessions.slice(-12).reverse();
  box.innerHTML = `
    <div class="row between"><b style="font-size:15px">${esc(r.name)}</b>${r.online ? '<span class="badge ok">online</span>' : ''}</div>
    <div class="muted mono">${esc(r.id || '(no DayZ ID seen yet)')}${r.steamId ? '<br>Steam64 ' + esc(r.steamId) : ''}${r.discordId ? '<br>Discord &lt;@' + esc(r.discordId) + '&gt;' : ''}</div>
    <div class="grid-2 tight pdb-kv">
      <div><span class="muted">First seen</span><br>${r.firstSeen ? fmtDate(r.firstSeen) : '—'}</div><div><span class="muted">Last seen</span><br>${r.lastSeen ? fmtDate(r.lastSeen) : '—'}</div>
      <div><span class="muted">Playtime</span><br>${fmtPlaytime(r.playtimeSec)} over ${r.connects} join(s)</div><div><span class="muted">Kills / deaths</span><br>${r.kills} / ${r.deaths}${r.combat ? ` · <span class="muted">longest kill ${r.combat.longestKill} m, ${r.combat.headshots} headshots</span>` : ''}</div>
      ${r.combat ? `<div><span class="muted">Damage dealt / taken</span><br>${r.combat.dealt.toLocaleString()} (${r.combat.hits} hits) / ${r.combat.taken.toLocaleString()} (${r.combat.hitsTaken} hits)</div><div><span class="muted">Favourite weapons</span><br>${esc(r.combat.favourite || '—')}</div><div><span class="muted">Killed by</span><br>${esc(r.combat.deathsBy || '—')}</div><div><span class="muted">Base building actions</span><br>${r.combat.builds}</div><div><span class="muted">Accuracy</span><br>${r.combat.accuracy.hitsPerKill !== null ? r.combat.accuracy.hitsPerKill + ' hits per kill' : '—'}${r.combat.accuracy.headshotPct !== null ? ' · ' + r.combat.accuracy.headshotPct + '% headshots' : ''}${r.combat.accuracy.avgHitDist !== null ? ' · avg ' + r.combat.accuracy.avgHitDist + ' m' : ''}</div><div><span class="muted">Body parts hit</span><br>${r.combat.accuracy.parts.length ? r.combat.accuracy.parts.slice(0, 6).map(p => `${esc(p.part)} ${p.pct}%`).join(' · ') : '—'}</div>${r.combat.flagScore ? `<div style="grid-column:1/-1"><span class="muted">Suspicious activity</span><br><span class="badge bad">score ${r.combat.flagScore}</span> ${r.combat.flags.map(f => `<span class="badge warn">${esc(f.reason)} ×${f.n}</span>`).join(' ')}<div class="muted">flags: ${r.combat.flagWindows.day} in 24 h · ${r.combat.flagWindows.week} in 7 d · ${r.combat.flagWindows.month} in 30 d · ${r.combat.flagWindows.all} total</div>${r.combat.flagHistory.length ? `<div class="muted small">${r.combat.flagHistory.slice(0, 6).map(h => `${fmtDate(h.ts)} · ${esc(h.reason)}: ${esc(h.detail)}`).join('<br>')}</div>` : ''}</div>` : ''}` : ''}
      <div><span class="muted">Last position</span><br>${r.lastPos ? `${Math.round(r.lastPos.x)}, ${Math.round(r.lastPos.z)} (${fmtDate(r.lastPos.at)})` : '—'}</div><div><span class="muted">Last death</span><br>${r.lastDeath ? (r.lastDeath.killer ? `killed by ${esc(r.lastDeath.killer)}${r.lastDeath.weapon ? ' with ' + esc(r.lastDeath.weapon) : ''}` : 'died') + ' · ' + fmtDate(r.lastDeath.at) : '—'}</div>
    </div>
    <div class="grid-2 tight pdb-kv">
      <div><span class="muted">Steam bans</span><br>${r.steamId ? steamBadges(r.steam) + (r.steam ? ` <span class="muted">checked ${fmtDate(r.steam.checkedAt)}</span>` : ' <button class="btn small" id="pdSteamCheck">Check now</button>') : '<span class="muted">Steam64 unknown</span>'}</div>
      <div><span class="muted">Discord roles</span><br><span id="pdRoles">${r.discordId ? (pdbRoles[r.discordId] ? roleCell(r, pdbRoles[r.discordId]) : '<span class="muted">…</span>') : '<span class="muted">no Discord account linked</span>'}</span></div>
    </div>
    ${accountSection(r)}
    ${r.names.length > 1 ? `<div><span class="muted">Names used</span><br>${r.names.map(esc).join(', ')}</div>` : ''}
    <div class="row gap wrap">
      ${r.id ? `<button class="btn small pd-act" data-kind="ban">Ban</button><button class="btn small pd-act" data-kind="whitelist">Whitelist</button><button class="btn small pd-act" data-kind="priority">Priority</button>` : ''}
      ${r.steamId ? `<button class="btn small" id="pdSteam">Steam profile</button>` : ''}
      <button class="btn small danger" id="pdRemove" title="Delete this record (it will be rebuilt from the logs if the player appears again)">Delete record</button>
    </div>
    <div class="muted" style="margin-top:4px">In-game actions (needs the bridge script and the player online)</div>
    <div class="row gap wrap">
      <button class="btn small pd-heal" data-what="all" ${r.online ? '' : 'disabled'}>Heal everything</button>
      <button class="btn small pd-heal" data-what="health" ${r.online ? '' : 'disabled'}>Health &amp; blood</button>
      <button class="btn small pd-heal" data-what="bleeding" ${r.online ? '' : 'disabled'}>Stop bleeding</button>
      <button class="btn small pd-heal" data-what="bones" ${r.online ? '' : 'disabled'}>Fix bones</button>
      <button class="btn small pd-heal" data-what="cure" ${r.online ? '' : 'disabled'}>Cure diseases</button>
      <button class="btn small pd-heal" data-what="food" ${r.online ? '' : 'disabled'}>Food &amp; water</button>
      <button class="btn small" id="pdTpDeath" ${r.online ? '' : 'disabled'} title="Teleport them back to where they last died">Teleport to last death</button>
    </div>
    <label class="field">Notes <textarea id="pdNotes" class="input" rows="3">${esc(r.note || '')}</textarea></label>
    <div class="row gap"><button class="btn small primary" id="pdSaveNote">Save note</button></div>
    <div class="card-title mt">Recent sessions</div>
    <div class="table-wrap" style="max-height:220px"><table class="table"><thead><tr><th>Start</th><th>End</th><th>Length</th></tr></thead><tbody>${sessions.map(s => `<tr><td>${fmtDate(s.start)}</td><td>${fmtDate(s.end)}</td><td>${fmtPlaytime((s.end - s.start) / 1000)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No completed sessions.</td></tr>'}</tbody></table></div>`;
  box.querySelectorAll('.pd-heal').forEach(b => b.onclick = (e) => run(async () => { const why = await askWhy(`Heal ${r.name} (${b.textContent.trim().toLowerCase()})`); if (why === null) return; const res = await ipc.invoke('deathlog:heal', r.key, b.dataset.what, why); toast(res.status === 'done' ? `${r.name} healed (${b.textContent.trim().toLowerCase()})` : res.status === 'offline' ? `${r.name} is not in game right now` : 'The server did not answer. Is the bridge script installed (Death log page) and the server running?', res.status !== 'done'); }, e.target));
  const tpd = box.querySelector('#pdTpDeath'); if (tpd) tpd.onclick = (e) => run(async () => { const last = (await ipc.invoke('deathlog:forPlayer', r.key))[0]; if (!last) return toast('No recorded death for ' + r.name, true); const why = await askWhy(`Teleport ${r.name} to their last death`); if (why === null) return; const res = await ipc.invoke('deathlog:teleportToDeath', last.id, why); toast(res.status === 'done' ? `${r.name} teleported to ${Math.round(res.pos[0])}, ${Math.round(res.pos[1])}` : res.status === 'offline' ? `${r.name} is not in game right now` : 'The server did not answer. Is the bridge script installed and the server running?', res.status !== 'done'); }, e.target);
  box.querySelectorAll('.pd-act').forEach(b => b.onclick = (e) => run(async () => { const kind = b.dataset.kind; const rr = kind === 'ban' ? await askReason(`Ban ${r.name} (ban.txt)`) : { reason: '' }; if (!rr) return; await ipc.invoke('lists:add', kind, { id: r.steamId || r.id }, { name: r.name, note: rr.reason }); toast(`Added to ${kind}`); refreshPdb(); }, e.target));
  const ac = box.querySelector('#pdAccCheck'); if (ac) ac.onclick = (e) => run(async () => { const st = await ipc.invoke('steam:state'); if (!st.hasKey) { toast('Set a Steam Web API key on the Discord Bot page first', true); return; } const res = await ipc.invoke('accounts:check', r.steamId); toast(res ? 'Account checked' : 'Steam gave no answer', !res); refreshPdb(); }, e.target);
  const bm = box.querySelector('#pdBm'); if (bm) bm.onclick = () => ipc.invoke('shell:openExternal', r.account.battlemetricsUrl);
  const sc = box.querySelector('#pdSteamCheck'); if (sc) sc.onclick = (e) => run(async () => { const st = await ipc.invoke('steam:state'); if (!st.hasKey) { toast('Set a Steam Web API key on the Discord Bot page first', true); return; } const res = await ipc.invoke('steam:check', r.steamId); toast(res ? 'Checked' : 'Steam gave no answer', !res); refreshPdb(); }, e.target);
  const sp = box.querySelector('#pdSteam'); if (sp) sp.onclick = () => ipc.invoke('shell:openExternal', `https://steamcommunity.com/profiles/${r.steamId}`);
  box.querySelector('#pdSaveNote').onclick = (e) => run(async () => { await ipc.invoke('players:setNote', r.key, box.querySelector('#pdNotes').value); toast('Note saved'); refreshPdb(); }, e.target);
  box.querySelector('#pdRemove').onclick = (e) => run(async () => { const ok = await showModal(`Delete record for ${r.name}?`, '', [{ label: 'Delete', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) return; await ipc.invoke('players:remove', r.key); pdbSelected = null; refreshPdb(); });
}
$('pdbTable').addEventListener('click', e => { const tr = e.target.closest('tr'); if (!tr || !tr.dataset.key) return; pdbSelected = tr.dataset.key; refreshPdb(); });
$('pdbQuery').addEventListener('input', () => { clearTimeout(refreshPdb._t); refreshPdb._t = setTimeout(refreshPdb, 250); });
$('pdbSort').onchange = () => refreshPdb();
$('btnPdbRefresh').onclick = () => run(async () => { await ipc.invoke('players:ingest'); refreshPdb(); });
$('btnSteamCheck').onclick = (e) => run(async () => {
  const st = await ipc.invoke('steam:state');
  if (!st.hasKey) { toast('Set a Steam Web API key on the Discord Bot page first', true); return; }
  const r = await ipc.invoke('steam:checkAll');
  if (r.skipped) { toast('A check is already running'); return; }
  toast(`Checked ${r.checked} Steam account(s). ${r.newBans.length ? r.newBans.length + ' new ban(s)!' : 'No new bans.'}`, !!r.newBans.length);
  await loadSteamMap(); refreshPdb();
}, e.target);
$('btnPdbRebuild').onclick = (e) => run(async () => { const ok = await showModal('Rebuild the player database?', '<p>Records are re-read from the newest admin logs. Notes stored on the player lists are kept; notes typed only here are lost.</p>', [{ label: 'Rebuild', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) return; await ipc.invoke('players:rebuild'); toast('Rebuilt'); refreshPdb(); }, e.target);
ipc.on('players:changed', () => { if (document.querySelector('#page-database.active')) refreshPdb(); });

// ---------- death log ----------
let dlSelected = null;
// every admin action except a refund needs a reason (posted to the admin action channel); null = cancelled
async function askWhy(title) {
  const ok = await showModal(title, '<label class="field">Reason <input id="whyBox" class="input" placeholder="Why (posted to the admin action channel)"></label>', [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return null; const v = $('whyBox').value.trim(); if (!v) { toast('Give a reason.', true); return null; } return v;
}
function fmtShort(ms) { const d = new Date(ms); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
function srcText(x) { return `${x.name}${x.kind !== 'player' && x.name.toLowerCase() !== x.kind ? ' (' + x.kind + ')' : ''} ×${x.hits}${x.damage ? ' ' + x.damage + 'dmg' : ''}`; }
function fmtRange(m) { return m !== null && m !== undefined ? Math.round(m) + ' m' : '—'; }
async function refreshDeathLog() {
  const range = Number($('dlRange').value);
  const rows = await ipc.invoke('deathlog:list', { q: $('dlQuery').value.trim(), cause: $('dlCause').value, since: range ? Date.now() - range : 0, limit: 400 });
  const st = await ipc.invoke('deathlog:stats'); $('dlStats').textContent = `${st.deaths} deaths recorded · ${st.snapshots} gear snapshots for ${st.players} players`;
  const tb = $('dlTable').querySelector('tbody');
  tb.innerHTML = rows.length ? rows.map(r => `<tr data-id="${r.id}" class="${r.id === dlSelected ? 'selected' : ''}"><td class="mono" title="${esc(fmtDate(r.ts))}">${esc(fmtShort(r.ts))}${(r.tickets || []).length ? ` <span class="badge" title="${esc(r.tickets.map(t => '#' + t.id + ' ' + t.subject).join(', '))}">🎫 ${r.tickets.length}</span>` : ''}</td><td><b>${esc(r.name)}</b>${r.online ? ' <span class="badge ok">online</span>' : ''}</td><td>${esc(r.cause)}</td><td>${r.killer ? esc(r.killer.name) : r.source ? `${esc(r.source.name)}${r.source.name.toLowerCase() === r.source.kind ? '' : ' <span class="muted">' + esc(r.source.kind) + '</span>'}` : '<span class="muted">—</span>'}</td><td class="dl-src" title="${r.sources && r.sources.length ? esc(r.sources.map(x => srcText(x)).join(', ')) : ''}">${r.sources && r.sources.length ? esc(r.sources.map(x => srcText(x)).join(', ')) : '<span class="muted">—</span>'}</td><td>${esc(r.weapon || '—')}</td><td>${fmtRange(r.distance)}</td><td>${r.hitCount ? `${Math.round(r.totalDamage)} (${r.hitCount} hit${r.hitCount === 1 ? '' : 's'})` : '—'}</td><td>${r.gearCount === null ? '<span class="muted">none</span>' : `${r.gearCount} items${r.refunds ? ` · refunded ×${r.refunds}` : ''}`}</td></tr>`).join('') : '<tr><td colspan="9" class="muted">No deaths match.</td></tr>';
  tb.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => { dlSelected = Number(tr.dataset.id); tb.querySelectorAll('tr').forEach(x => x.classList.toggle('selected', x === tr)); showDeath(dlSelected); });
  refreshBridgeState();
}
async function refreshBridgeState() {
  const st = await ipc.invoke('deathlog:bridgeStatus'); const b = $('dlBridgeState');
  b.className = 'badge ' + (st.upToDate ? 'ok' : st.installed ? 'warn' : 'bad');
  b.textContent = st.error ? st.error : st.upToDate ? `installed (v${st.version})` : st.installed ? `installed v${st.version}, update available` : 'not installed';
  const s = await ipc.invoke('settings:get'); $('dlBridgeAuto').checked = ((s.deathlog || {}).bridge !== false); $('dlDeleteBody').checked = ((s.deathlog || {}).deleteBody !== false);
}
async function showDeath(id) {
  const r = await ipc.invoke('deathlog:get', id); const box = $('dlDetail');
  if (!r) { box.innerHTML = '<div class="empty">Record not found.</div>'; return; }
  const parts = Object.entries(r.byPart || {}).sort((a, b) => b[1].damage - a[1].damage);
  const maxDmg = Math.max(1, ...parts.map(p => p[1].damage));
  const hits = r.hits.slice().reverse();
  const groups = {}; for (const g of (r.gear || [])) { const k = g.p || 'On the player'; (groups[k] = groups[k] || []).push(g); }
  const gearHtml = r.gear && r.gear.length ? Object.entries(groups).map(([k, items]) => `<div class="muted" style="margin-top:4px">${esc(k)}</div>` + items.map(g => `<div class="row between"><span class="mono">${esc(g.c)}</span><span class="muted">${g.q >= 0 ? 'qty ' + Math.round(g.q * 100) / 100 + ' · ' : ''}${Math.round(g.h * 100)}% hp</span></div>`).join('')).join('') : '<div class="muted">No gear snapshot for this death. The bridge script records gear only while it is installed and the server has been restarted since.</div>';
  box.innerHTML = `
    <div class="row between"><b style="font-size:15px">${esc(r.name)}</b>${r.online ? '<span class="badge ok">online</span>' : '<span class="badge">offline</span>'}</div>
    <div class="muted">${esc(fmtDate(r.ts))} · record #${r.id}${r.pos ? ` · at ${Math.round(r.pos.x)}, ${Math.round(r.pos.z)}` : ''}</div>
    <div><b>${esc(r.cause === 'player' && r.killer ? `Killed by ${r.killer.name}` : r.causeText)}</b>${r.cause === 'player' ? `${r.weapon ? ' with ' + esc(r.weapon) : ''}${r.ammo ? ' (' + esc(r.ammo) + ')' : ''}${r.distance !== null && r.distance !== undefined ? ' from ' + fmtRange(r.distance) : ''}${r.finalPart ? ', final hit to the ' + esc(r.finalPart) + (r.finalDamage ? ' for ' + Math.round(r.finalDamage) + ' damage' : '') : ''}` : ''}</div>
    ${parts.length ? `<div class="muted" style="margin-top:6px">Damage by body part · ${r.hits.length} hit${r.hits.length === 1 ? '' : 's'}, ${Math.round(r.totalDamage)} total</div>` + parts.map(([p, v]) => `<div class="row gap" style="align-items:center"><span style="width:90px">${esc(p)}</span><div class="bar grow"><div class="bar-fill" style="width:${Math.round(100 * v.damage / maxDmg)}%"></div></div><span class="mono" style="width:120px;text-align:right">${Math.round(v.damage)} dmg · ${v.hits} hit${v.hits === 1 ? '' : 's'}</span></div>`).join('') : '<div class="muted" style="margin-top:6px">No hits recorded before this death.</div>'}
    ${r.source ? `<div class="muted" style="margin-top:6px">Final damage source</div><div><b>${esc(r.source.name)}</b> <span class="muted">${esc(r.source.kind)}</span></div>` : ''}
    ${r.attackers && r.attackers.length ? '<div class="muted" style="margin-top:6px">Damage sources before death</div>' + r.attackers.map(a => `<div class="row between"><span>${esc(a.name)} <span class="muted">${esc(a.kind || (a.player ? 'player' : 'environment'))}</span></span><span class="muted">${a.hits} hit${a.hits === 1 ? '' : 's'} · ${Math.round(a.damage)} dmg</span></div>`).join('') : ''}
    ${hits.length ? `<details style="margin-top:6px"><summary class="muted">Every hit (${hits.length})</summary><div class="table-wrap" style="max-height:220px"><table class="table compact"><thead><tr><th>Time</th><th>By</th><th>Part</th><th>Dmg</th><th>Range</th><th>Weapon</th></tr></thead><tbody>${hits.map(h => `<tr><td class="mono">${esc(new Date(h.ts).toLocaleTimeString())}</td><td>${esc(h.by)}</td><td>${esc(h.part || '—')}</td><td>${Math.round(h.damage)}</td><td>${fmtRange(h.distance)}</td><td>${esc(h.weapon || h.ammo || '—')}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    <div class="row between" style="margin-top:8px"><b>Gear${r.gear ? ` (${r.gear.length} items, ${r.gearFromCorpse ? 'from the body' : 'last snapshot ' + Math.round((r.ts - r.gearTs) / 1000) + ' s before death'})` : ''}</b>
      <span class="row gap"><button class="btn small" id="btnDlTp" ${r.online && r.deathPos ? '' : 'disabled'} title="${!r.deathPos ? 'No position recorded' : r.online ? 'Teleport the player back to where they died' : 'The player must be online'}">Teleport back here</button><button class="btn small" id="btnDlRefund" ${r.gear && r.gear.length && r.online ? '' : 'disabled'} title="${!r.gear || !r.gear.length ? 'No gear recorded' : r.online ? 'Spawn every item in pristine condition at the player\'s feet' : 'The player must be online'}">Refund gear</button></span></div>
    <div style="max-height:260px;overflow:auto">${gearHtml}</div>
    <div class="row between" style="margin-top:8px"><b>Tickets</b><span class="row gap"><button class="btn small" id="btnDlLinkTicket" title="Link this death to an open ticket">Link to ticket…</button><button class="btn small" id="btnDlNewTicket" title="Open a ticket for this death">New ticket</button></span></div>
    ${(r.tickets || []).length ? r.tickets.map(t => `<div class="row between"><span>#${esc(t.id)} ${esc(t.subject)} <span class="muted">${esc(t.status)}</span></span><button class="btn small dl-open-ticket" data-id="${esc(t.id)}">Open</button></div>`).join('') : '<div class="muted">Not linked to a ticket.</div>'}
    ${r.refunds && r.refunds.length ? '<div class="muted" style="margin-top:6px">Refunds</div>' + r.refunds.map(f => `<div class="row between"><span>${esc(fmtDate(f.ts))} by ${esc(f.by)}</span><span class="muted">${f.ok}/${f.items} spawned${f.fail ? `, ${f.fail} failed` : ''}${f.status !== 'done' ? ' (' + esc(f.status) + ')' : ''}</span></div>`).join('') : ''}`;
  box.querySelectorAll('.dl-open-ticket').forEach(b => b.onclick = () => { tkSelected = b.dataset.id; showPage('tickets'); });
  $('btnDlNewTicket').onclick = (e) => run(async () => { const t = await newTicketDialog(r.id, r.name); if (t) showDeath(r.id); }, e.target);
  $('btnDlLinkTicket').onclick = (e) => run(async () => {
    const open = await ipc.invoke('tickets:list', { status: 'open' });
    const ok = await showModal(`Link death #${r.id} to a ticket`, open.length ? `<label class="field">Ticket <select id="dlTicketPick" class="input">${open.map(t => `<option value="${esc(t.id)}">#${esc(t.id)} ${esc(t.subject)}${t.player ? ' · ' + esc(t.player) : ''}</option>`).join('')}</select></label>` : '<p class="muted">No open tickets. Use New ticket instead.</p>', [{ label: 'Link', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (!ok || !open.length) return; await ipc.invoke('tickets:link', $('dlTicketPick').value, r.id); toast('Linked'); showDeath(r.id);
  }, e.target);
  const tp = $('btnDlTp');
  if (tp) tp.onclick = (e) => run(async () => { const why = await askWhy(`Teleport ${r.name} back to where they died`); if (why === null) return; const res = await ipc.invoke('deathlog:teleportToDeath', r.id, why); toast(res.status === 'done' ? `${r.name} teleported to ${Math.round(res.pos[0])}, ${Math.round(res.pos[1])}` : res.status === 'offline' ? `${r.name} is not in game right now` : 'The server did not answer. Is the bridge script installed and the server running?', res.status !== 'done'); }, e.target);
  const btn = $('btnDlRefund');
  if (btn) btn.onclick = (e) => run(async () => {
    const ok = await showModal('Refund gear', `<p>Spawn the ${r.gear.length} items ${esc(r.name)} had when they died, in pristine condition, at their feet now?</p><p class="muted">Weapons come without their attachments fitted; attachments, magazines and cargo are spawned as separate items.</p><label class="field">Reason / ticket <input id="dlWhy" class="input" value="${(r.tickets || []).length ? '#' + esc(r.tickets[0].id) + ' ' : ''}" placeholder="Reason or ticket number (posted to the admin action channel)"></label>`, [{ label: 'Refund', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (!ok) return;
    const res = await ipc.invoke('deathlog:refund', r.id, null, $('dlWhy').value.trim());
    toast(res.status === 'done' && res.ok > 0 ? `Spawned ${res.ok} of ${res.items} items at ${r.name}'s feet${res.fail ? ` (${res.fail} failed)` : ''}${res.body === 'body' ? ' · body removed' : res.body === 'nobody' ? ' · no body found to remove' : ''}` : res.status === 'done' ? `Nothing could be spawned for ${r.name} (${res.fail} item(s) failed: classes from a removed mod?)` : res.status === 'offline' ? `${r.name} is not in game right now` : res.status === 'pending' ? 'The game picked the refund up but has not answered yet; the result shows in the death record when it does.' : res.withdrawn ? 'The game did not pick the refund up in time, so it was withdrawn and nothing was spawned. Is the server running with the bridge script loaded (it loads at server start)?' : 'The server did not answer. Is the bridge script installed and the server running?', !(res.status === 'done' && res.ok > 0) && res.status !== 'pending');
    showDeath(r.id); refreshDeathLog();
  }, e.target);
}
$('btnDlRefresh').onclick = () => refreshDeathLog();
let dlTimer = null; $('dlQuery').oninput = () => { clearTimeout(dlTimer); dlTimer = setTimeout(refreshDeathLog, 250); };
$('dlCause').onchange = $('dlRange').onchange = () => refreshDeathLog();
const saveDl = () => saveSettings({ deathlog: { ...((state.settings && state.settings.deathlog) || {}), bridge: $('dlBridgeAuto').checked, deleteBody: $('dlDeleteBody').checked } });
$('dlBridgeAuto').onchange = saveDl; $('dlDeleteBody').onchange = saveDl;
$('btnDlInstall').onclick = (e) => run(async () => { const st = await ipc.invoke('deathlog:installBridge'); toast(st.installed ? 'Bridge script written to init.c. Restart the server for it to load.' : 'Could not install'); refreshBridgeState(); }, e.target);
$('btnDlRemove').onclick = (e) => run(async () => { if (!await showModal('Remove bridge script', '<p>Remove the bridge script from init.c? Gear snapshots and refunds stop at the next server start. Turn off "Keep it installed" as well, or it comes back on the next start.</p>', [{ label: 'Remove', value: true, primary: true }, { label: 'Cancel', value: false }])) return; await ipc.invoke('deathlog:removeBridge'); refreshBridgeState(); }, e.target);
$('btnDlOpenDir').onclick = () => ipc.invoke('deathlog:openBridgeDir');
ipc.on('deathlog:changed', () => { if (document.querySelector('#page-deathlog.active')) refreshDeathLog(); });
ipc.on('tickets:changed', () => { if (document.querySelector('#page-tickets.active')) refreshTickets(); if (document.querySelector('#page-deathlog.active') && dlSelected) showDeath(dlSelected); });

// ---------- tickets ----------
let tkSelected = null, tkRows = [];
const tkFmt = (iso) => iso ? fmtDate(Date.parse(iso)) : '—';
async function refreshTickets() {
  tkRows = await ipc.invoke('tickets:list', { status: $('tkStatus').value, q: $('tkQuery').value.trim() });
  const st = await ipc.invoke('tickets:stats'); $('tkStats').textContent = `${st.open} open (${st.unassigned} unassigned) · ${st.closed} closed`;
  $('tkTable').querySelector('tbody').innerHTML = tkRows.map(t => `<tr data-id="${esc(t.id)}" class="${t.id === tkSelected ? 'selected' : ''}"><td class="mono">#${esc(t.id)}${t.status === 'open' ? '' : ' <span class="badge">closed</span>'}${t.source === 'discord' ? ' <span class="badge" title="Opened through the Discord bot">discord</span>' : ''}</td><td>${esc(t.subject)}</td><td>${esc(t.player || '')}</td><td>${t.assignee ? esc(t.assignee) : '<span class="muted">nobody</span>'}</td><td>${t.deaths.map(d => '#' + d).join(', ')}</td><td>${t.actions || ''}</td><td class="muted">${esc(tkFmt(t.lastActivity))}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No tickets.</td></tr>';
  if (tkSelected) showTicket(tkSelected);
}
async function showTicket(id) {
  tkSelected = id; let t; try { t = await ipc.invoke('tickets:get', id); } catch (e) { $('tkDetail').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  document.querySelectorAll('#tkTable tbody tr').forEach(tr => tr.classList.toggle('selected', tr.dataset.id === id));
  const deaths = t.deaths.map(d => `<div class="row between tk-line"><span>#${d.id} ${d.missing ? '<span class="muted">(record gone)</span>' : `${esc(d.name)} · ${esc(d.cause)}${d.killer ? ' by ' + esc(d.killer) : ''}${d.refunded ? ' <span class="badge ok">refunded</span>' : ''}`}</span><span class="row gap">${d.missing ? '' : `<button class="btn small tk-open-death" data-id="${d.id}">Open</button>`}<button class="btn small tk-unlink" data-id="${d.id}" title="Unlink">✕</button></span></div>`).join('') || '<div class="muted">No death records linked.</div>';
  const notes = t.notes.slice().reverse().map(n => `<div class="tk-line ${n.system ? 'system' : ''}"><span class="muted">${esc(tkFmt(n.ts))} · ${esc(n.by)}</span><br>${esc(n.text)}</div>`).join('') || '<div class="muted">No notes yet.</div>';
  const actions = t.actions.map(a => `<div class="tk-line"><span class="muted">${esc(tkFmt(a.ts))} · ${esc(a.by)}</span><br><b>${esc(a.action)}</b>${a.target ? ' · ' + esc(a.target) : ''}${a.details ? ' · ' + esc(a.details) : ''}${a.result ? ` <span class="muted">${esc(a.result)}</span>` : ''}${a.reason ? `<br><span class="muted">reason: ${esc(a.reason)}</span>` : ''}</div>`).join('') || '<div class="muted">No admin actions logged for this ticket yet. Put <code>#' + esc(t.id) + '</code> in the reason of a refund, spawn, heal or teleport to log it here.</div>';
  $('tkDetail').innerHTML = `
    <div class="row between"><b style="font-size:15px">#${esc(t.id)} ${esc(t.subject)}</b><span class="badge ${t.status === 'open' ? 'ok' : ''}">${esc(t.status)}</span></div>
    <div class="muted">Opened ${esc(tkFmt(t.createdAt))}${t.createdBy ? ' by ' + esc(t.createdBy) : t.discordId ? ' by Discord user ' + esc(t.discordId) : ''}${t.closedAt ? ' · closed ' + esc(tkFmt(t.closedAt)) + (t.closedBy ? ' by ' + esc(t.closedBy) : '') + (t.closeReason ? ': ' + esc(t.closeReason) : '') : ''}${t.channelUrl ? ` · <a href="#" class="ext" data-url="${esc(t.channelUrl)}">Discord channel</a>` : ''}</div>
    ${t.description ? `<div style="white-space:pre-wrap">${esc(t.description)}</div>` : ''}
    <div class="row gap wrap" style="align-items:center"><span class="muted">Player</span><b>${esc(t.player || '—')}</b><span class="grow"></span><span class="muted">Assignee</span><input id="tkAssignee" class="input" style="width:140px" value="${esc(t.assignee || '')}" placeholder="nobody"><button class="btn small" id="btnTkAssign">Assign</button></div>
    <div class="row gap wrap">${t.status === 'open' ? '<button class="btn small" id="btnTkClose">Close ticket</button>' : '<button class="btn small" id="btnTkReopen">Reopen</button>'}<button class="btn small" id="btnTkCopy" title="Copy #${esc(t.id)} to paste into a reason">Copy #${esc(t.id)}</button></div>
    <div class="card-title mt row between"><span>Linked deaths</span><span class="row gap"><input id="tkDeathId" class="input short" type="number" min="1" placeholder="death #"><button class="btn small" id="btnTkLink">Link</button></span></div>${deaths}
    <div class="card-title mt">Admin actions</div>${actions}
    <div class="card-title mt">Notes</div><div class="row gap"><input id="tkNote" class="input" placeholder="Add a note"><button class="btn small" id="btnTkNote">Add</button></div>${notes}`;
  const box = $('tkDetail');
  const act = (fn) => run(async () => { await fn(); refreshTickets(); });
  box.querySelector('#btnTkAssign').onclick = () => act(() => ipc.invoke('tickets:assign', t.id, $('tkAssignee').value));
  box.querySelector('#btnTkLink').onclick = () => act(async () => { const n = Number($('tkDeathId').value); if (!n) throw new Error('Give a death record number (Death log page).'); await ipc.invoke('tickets:link', t.id, n); toast(`Death #${n} linked`); });
  box.querySelector('#btnTkNote').onclick = () => act(async () => { await ipc.invoke('tickets:note', t.id, $('tkNote').value); });
  box.querySelector('#btnTkCopy').onclick = () => { navigator.clipboard.writeText('#' + t.id); toast('#' + t.id + ' copied'); };
  const c = box.querySelector('#btnTkClose'); if (c) c.onclick = () => act(async () => { const ok = await showModal(`Close ticket #${t.id}?`, `<label class="field">Reason (optional) <input id="tkWhy" class="input"></label>${t.channelUrl ? '<p class="muted">Its Discord channel is closed too, with the transcript posted to the ticket log.</p>' : ''}`, [{ label: 'Close ticket', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) return; await ipc.invoke('tickets:setStatus', t.id, 'closed', $('tkWhy').value.trim()); });
  const o = box.querySelector('#btnTkReopen'); if (o) o.onclick = () => act(() => ipc.invoke('tickets:setStatus', t.id, 'open'));
  box.querySelectorAll('.tk-open-death').forEach(b => b.onclick = () => { dlSelected = Number(b.dataset.id); showPage('deathlog'); });
  box.querySelectorAll('.tk-unlink').forEach(b => b.onclick = () => act(() => ipc.invoke('tickets:unlink', t.id, Number(b.dataset.id))));
}
$('tkTable').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) showTicket(tr.dataset.id); });
let tkTimer = null; $('tkQuery').oninput = () => { clearTimeout(tkTimer); tkTimer = setTimeout(refreshTickets, 250); }; $('tkStatus').onchange = refreshTickets;
async function newTicketDialog(deathId = null, player = '') {
  const ok = await showModal('New ticket', `<label class="field">Subject <input id="tkSubject" class="input" placeholder="e.g. Lost gear to a glitch at the NWAF"></label><label class="field">Player <input id="tkPlayer" class="input" value="${esc(player)}" placeholder="name"></label><label class="field">Details <textarea id="tkDesc" class="input" rows="4"></textarea></label>${deathId ? `<p class="muted">Death record #${deathId} is linked to it.</p>` : ''}`, [{ label: 'Create', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return null;
  const t = await ipc.invoke('tickets:create', { subject: $('tkSubject').value, player: $('tkPlayer').value, description: $('tkDesc').value, deathId });
  toast(`Ticket #${t.id} opened`); return t;
}
$('btnTkNew').onclick = (e) => run(async () => { const t = await newTicketDialog(); if (t) { tkSelected = t.id; refreshTickets(); } }, e.target);


// ---------- economy editor ----------
const eco = { tab: 'types', files: null, limits: { categories: [], usages: [], values: [], tags: [] }, types: null, events: null, spawn: null };
const ROW_H = 32;
function ecoState() { return eco[eco.tab === 'spawnable' ? 'spawn' : eco.tab]; }
function ecoDirtyCount(st) { return st ? st.rows.filter((r, i) => JSON.stringify(r) !== st.orig[i]).length + Math.max(0, st.orig.length - st.rows.length) : 0; }
async function refreshEconomy() {
  try { eco.files = await ipc.invoke('economy:files'); eco.limits = await ipc.invoke('economy:limits'); }
  catch (e) { $('ecoBanner').hidden = false; $('ecoBanner').textContent = e.message; return; }
  $('ecoBanner').hidden = true;
  for (const [id, list] of [['tfCategory', eco.limits.categories], ['tfUsage', eco.limits.usages], ['tfValue', eco.limits.values], ['tfTag', eco.limits.tags]]) {
    const sel = $(id); const first = sel.options[0].outerHTML; sel.innerHTML = first + list.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  }
  ecoFillFlagNames(); itemCatalog = null;
  ecoSetTab(eco.tab);
}
function ecoFillFlagNames() { const kind = $('bulkFlagKind').value; const list = { usage: eco.limits.usages, value: eco.limits.values, tag: eco.limits.tags, category: eco.limits.categories }[kind] || []; $('bulkFlagName').innerHTML = list.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''); }
$('bulkFlagKind').onchange = ecoFillFlagNames;
document.querySelectorAll('.etab').forEach(t => t.onclick = () => ecoSetTab(t.dataset.etab));
function ecoSetTab(tab) {
  eco.tab = tab;
  if (tab === 'spawnable') loadItemCatalog().then(renderItemPicker).catch(() => {});
  if (tab === 'types') renderBrush();
  document.querySelectorAll('.etab').forEach(x => x.classList.toggle('active', x.dataset.etab === tab));
  ['types', 'events', 'spawnable'].forEach(k => { $('eco-' + k).hidden = k !== tab; });
  const list = eco.files ? (tab === 'types' ? eco.files.types : tab === 'events' ? eco.files.events : eco.files.spawnable) : [];
  const sel = $('ecoFile');
  sel.innerHTML = list.map(f => `<option value="${esc(f.abs)}" ${f.exists ? '' : 'disabled'}>${esc(f.label)}${f.exists ? '' : ' (missing)'}</option>`).join('');
  const st = ecoState();
  if (st && list.some(f => f.abs === st.abs)) sel.value = st.abs; else if (list.length) { sel.value = list.find(f => f.exists) ? list.find(f => f.exists).abs : list[0].abs; ecoLoad(); return; }
  ecoRender();
}
$('ecoFile').onchange = () => ecoLoad();
$('btnEcoUnregister').onclick = (e) => run(async () => {
  const abs = $('ecoFile').value; const f = (eco.files ? [].concat(eco.files.types, eco.files.events, eco.files.spawnable) : []).find(x => x.abs === abs);
  if (!f || /\(vanilla\)/.test(f.label)) return toast('Only custom files can be unregistered', true);
  if (!await showModal('Unregister file', `<p>Remove <b>${esc(f.label)}</b> from cfgeconomycore.xml? The file itself is kept.</p>`, [{ label: 'Unregister', value: true, primary: true }, { label: 'Cancel', value: false }])) return;
  await ipc.invoke('economy:unregisterFile', abs); toast('Unregistered'); await refreshEconomy();
}, e.target);
async function ecoLoad() {
  const abs = $('ecoFile').value; if (!abs) return;
  return run(async () => {
    const st = ecoState();
    if (st && st.abs !== abs && ecoDirtyCount(st)) { const ok = await showModal('Unsaved changes', '<p>Switch files and lose the unsaved changes?</p>', [{ label: 'Discard', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) { $('ecoFile').value = st.abs; return; } }
    const rows = await ipc.invoke(eco.tab === 'types' ? 'economy:loadTypes' : eco.tab === 'events' ? 'economy:loadEvents' : 'economy:loadSpawnable', abs);
    const state = { abs, rows, orig: rows.map(r => JSON.stringify(r)), sel: new Set(), filtered: [] };
    if (eco.tab === 'types') eco.types = state; else if (eco.tab === 'events') eco.events = state; else eco.spawn = state;
    renderEcoProblems([]);
    ecoRender();
  });
}
function ecoRender() {
  const st = ecoState();
  $('ecoInfo').textContent = st ? `${st.rows.length} entries · ${ecoDirtyCount(st)} modified` : '';
  if (eco.tab === 'types') renderTypes(); else if (eco.tab === 'events') renderEvents(); else renderSpawn();
}
// ----- types: filtering + virtual table -----
function typesFilter() {
  const st = eco.types; if (!st) return [];
  const q = $('tfSearch').value.trim().toLowerCase(), c = $('tfCategory').value, u = $('tfUsage').value, v = $('tfValue').value, t = $('tfTag').value, z = $('tfZero').checked, m = $('tfModified').checked;
  st.filtered = st.rows.map((r, i) => i).filter(i => { const r = st.rows[i];
    return (!q || r.name.toLowerCase().includes(q)) && (!c || r.category.includes(c)) && (!u || r.usage.includes(u)) && (!v || r.value.includes(v)) && (!t || r.tag.includes(t)) && (!z || r.nominal === 0) && (!m || JSON.stringify(r) !== st.orig[i]); });
  return st.filtered;
}
function renderTypes() {
  const st = eco.types; const body = $('tBody');
  if (!st) { $('tRows').innerHTML = '<div class="empty">Pick a types file.</div>'; $('tSpacer').style.height = '0px'; return; }
  const idx = typesFilter();
  $('tfCount').textContent = `${idx.length} of ${st.rows.length} shown`;
  $('tSpacer').style.height = (idx.length * ROW_H) + 'px';
  const start = Math.max(0, Math.floor(body.scrollTop / ROW_H) - 5), end = Math.min(idx.length, start + Math.ceil(body.clientHeight / ROW_H) + 12);
  const chips = (arr, cls) => arr.length ? arr.map(x => `<span class="badge ${cls}">${esc(x)}</span>`).join('') : '<span class="muted">—</span>';
  const num = (r, f) => `<input type="number" class="vin" data-f="${f}" value="${r[f] === null ? '' : r[f]}">`;
  $('tRows').style.transform = `translateY(${start * ROW_H}px)`;
  $('tRows').innerHTML = idx.slice(start, end).map(i => { const r = st.rows[i]; const dirty = JSON.stringify(r) !== st.orig[i];
    return `<div class="vrow ${st.sel.has(i) ? 'selected' : ''} ${dirty ? 'dirty' : ''}" data-i="${i}"><span><input type="checkbox" class="vsel" ${st.sel.has(i) ? 'checked' : ''}></span><span class="vname" title="${esc(r.name)}">${esc(r.name)}</span><span>${num(r, 'nominal')}</span><span>${num(r, 'min')}</span><span>${num(r, 'lifetime')}</span><span>${num(r, 'restock')}</span><span>${num(r, 'quantmin')}</span><span>${num(r, 'quantmax')}</span><span>${num(r, 'cost')}</span><span class="vflags" data-k="category">${chips(r.category, '')}</span><span class="vflags" data-k="usage">${chips(r.usage, 'ok')}</span><span class="vflags" data-k="value">${chips(r.value, 'warn')}</span><span class="vflags" data-k="tag">${chips(r.tag, '')}</span></div>`; }).join('');
  $('bulkCount').textContent = `${st.sel.size} selected`;
  $('ecoBulk').classList.toggle('active', st.sel.size > 0);
  $('tfSelAll').checked = idx.length > 0 && idx.every(i => st.sel.has(i));
}
$('tBody').addEventListener('scroll', () => { document.querySelector('.vhead').style.transform = `translateX(-${$('tBody').scrollLeft}px)`; if (eco.tab === 'types') renderTypes(); });
['tfSearch', 'tfCategory', 'tfUsage', 'tfValue', 'tfTag', 'tfZero', 'tfModified'].forEach(id => $(id).addEventListener('input', () => { $('tBody').scrollTop = 0; renderTypes(); }));
$('tRows').addEventListener('change', e => {
  const row = e.target.closest('.vrow'); if (!row) return; const i = Number(row.dataset.i); const r = eco.types.rows[i];
  if (e.target.classList.contains('vsel')) { if (e.target.checked) eco.types.sel.add(i); else eco.types.sel.delete(i); renderTypes(); return; }
  if (e.target.classList.contains('vin')) { const v = e.target.value; r[e.target.dataset.f] = v === '' ? null : Number(v); $('ecoInfo').textContent = `${eco.types.rows.length} entries · ${ecoDirtyCount(eco.types)} modified`; row.classList.toggle('dirty', JSON.stringify(r) !== eco.types.orig[i]); }
});
$('tRows').addEventListener('click', e => {
  if (brush.name) return;
  const cell = e.target.closest('.vflags'); if (!cell) return;
  const row = e.target.closest('.vrow'); const i = Number(row.dataset.i); const r = eco.types.rows[i]; const k = cell.dataset.k;
  const options = { category: eco.limits.categories, usage: eco.limits.usages, value: eco.limits.values, tag: eco.limits.tags }[k];
  const labels = { category: 'Category', usage: 'Usage', value: 'Tier', tag: 'Tags' };
  run(async () => {
    const ok = await showModal(`${labels[k]} for ${r.name}`, `<div class="row gap wrap">${options.map(o => `<label class="check"><input type="checkbox" class="fp" value="${esc(o)}" ${r[k].includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('') || '<span class="muted">No values defined in cfglimitsdefinition.xml.</span>'}</div>`, [{ label: 'Apply', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (!ok) return;
    r[k] = [...document.querySelectorAll('#modalBody .fp:checked')].map(x => x.value);
    renderTypes(); ecoRender();
  });
});
// ----- brush: pick a tier / usage / tag / category, then left-click rows to add, right-click to remove -----
const brush = { kind: 'value', name: null };
function renderBrush() {
  const list = { usage: eco.limits.usages, value: eco.limits.values, tag: eco.limits.tags, category: eco.limits.categories }[brush.kind] || [];
  if (brush.name && !list.includes(brush.name)) brush.name = null;
  const cls = { usage: 'ok', value: 'warn', tag: '', category: '' }[brush.kind];
  $('brushChips').innerHTML = list.map(v => `<span class="badge chip ${cls} ${brush.name === v ? 'on' : ''}" data-v="${esc(v)}">${esc(v)}</span>`).join('') || '<span class="muted">none defined in cfglimitsdefinition.xml</span>';
  document.querySelector('#eco-types .vtable').classList.toggle('brushing', !!brush.name);
  $('brushHint').textContent = brush.name ? `Brush: ${brush.kind === 'value' ? 'tier' : brush.kind} "${brush.name}". Left-click a row to add, right-click to remove, Esc to stop.` : 'Pick a value, then left-click a row to add it, right-click to remove it. Esc clears the brush.';
}
$('brushKind').onchange = () => { brush.kind = $('brushKind').value; brush.name = null; renderBrush(); };
$('brushChips').addEventListener('click', e => { const c = e.target.closest('.chip'); if (!c) return; brush.name = brush.name === c.dataset.v ? null : c.dataset.v; renderBrush(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && brush.name) { brush.name = null; renderBrush(); } });
function brushApply(e, add) {
  if (!brush.name || !eco.types) return false;
  if (e.target.closest('input, button, select')) return false;
  const row = e.target.closest('.vrow'); if (!row || row.classList.contains('vhead')) return false;
  e.preventDefault();
  const i = Number(row.dataset.i); const r = eco.types.rows[i]; const arr = r[brush.kind];
  const has = arr.includes(brush.name);
  if (add && !has) arr.push(brush.name); else if (!add && has) arr.splice(arr.indexOf(brush.name), 1); else return true;
  renderTypes(); ecoRender(); return true;
}
$('tRows').addEventListener('click', e => { brushApply(e, true); }, true);
$('tRows').addEventListener('contextmenu', e => { brushApply(e, false); });
$('tfSelAll').onchange = (e) => { const st = eco.types; if (!st) return; for (const i of st.filtered) { if (e.target.checked) st.sel.add(i); else st.sel.delete(i); } renderTypes(); };
$('btnBulkSelectFiltered').onclick = () => { const st = eco.types; if (!st) return; for (const i of st.filtered) st.sel.add(i); renderTypes(); };
$('btnBulkClear').onclick = () => { if (eco.types) { eco.types.sel.clear(); renderTypes(); } };
$('btnBulkApply').onclick = () => {
  const st = eco.types; if (!st || !st.sel.size) return toast('Select some types first', true);
  const f = $('bulkField').value, op = $('bulkOp').value, v = Number($('bulkValue').value);
  if (Number.isNaN(v)) return toast('Enter a number', true);
  for (const i of st.sel) { const r = st.rows[i]; const cur = r[f] === null ? 0 : r[f]; r[f] = op === 'set' ? v : op === 'mul' ? Math.round(cur * v) : Math.round(cur + v); if (['nominal', 'min', 'lifetime', 'restock', 'cost'].includes(f) && r[f] < 0) r[f] = 0; }
  toast(`${st.sel.size} type(s) updated`); renderTypes(); ecoRender();
};
const bulkFlag = (add) => () => { const st = eco.types; if (!st || !st.sel.size) return toast('Select some types first', true); const k = $('bulkFlagKind').value, name = $('bulkFlagName').value; if (!name) return; for (const i of st.sel) { const r = st.rows[i]; if (add) { if (!r[k].includes(name)) r[k].push(name); } else r[k] = r[k].filter(x => x !== name); } toast(`${add ? 'Added' : 'Removed'} ${name} on ${st.sel.size} type(s)`); renderTypes(); ecoRender(); };
$('btnBulkFlagAdd').onclick = bulkFlag(true); $('btnBulkFlagRemove').onclick = bulkFlag(false);
// ----- events -----
function renderEvents() {
  const st = eco.events; const tb = $('evTable').querySelector('tbody');
  if (!st) { tb.innerHTML = ''; return; }
  const q = $('efSearch').value.trim().toLowerCase();
  const idx = st.rows.map((r, i) => i).filter(i => !q || st.rows[i].name.toLowerCase().includes(q));
  $('efCount').textContent = `${idx.length} of ${st.rows.length}`;
  const num = (r, f) => `<input type="number" class="vin" data-f="${f}" value="${r[f] === null ? '' : r[f]}">`;
  tb.innerHTML = idx.map(i => { const r = st.rows[i]; const dirty = JSON.stringify(r) !== st.orig[i];
    return `<tr data-i="${i}" class="${dirty ? 'dirty' : ''}"><td class="vname">${esc(r.name)}</td><td>${num(r, 'nominal')}</td><td>${num(r, 'min')}</td><td>${num(r, 'max')}</td><td>${num(r, 'lifetime')}</td><td>${num(r, 'restock')}</td><td>${num(r, 'saferadius')}</td><td>${num(r, 'distanceradius')}</td><td>${num(r, 'cleanupradius')}</td><td><select class="vin input" data-f="position"><option value="fixed" ${r.position === 'fixed' ? 'selected' : ''}>fixed</option><option value="player" ${r.position === 'player' ? 'selected' : ''}>player</option></select></td><td><select class="vin input" data-f="limit"><option value="child" ${r.limit === 'child' ? 'selected' : ''}>child</option><option value="custom" ${r.limit === 'custom' ? 'selected' : ''}>custom</option><option value="mixed" ${r.limit === 'mixed' ? 'selected' : ''}>mixed</option></select></td><td><input type="checkbox" class="vin" data-f="active" ${r.active ? 'checked' : ''}></td><td><button class="btn small ev-kids">${r.children.length} child(ren)</button></td><td><button class="btn small danger ev-del">✕</button></td></tr>`; }).join('');
}
$('efSearch').addEventListener('input', renderEvents);
$('evTable').addEventListener('change', e => { const tr = e.target.closest('tr'); if (!tr || !e.target.classList.contains('vin')) return; const r = eco.events.rows[Number(tr.dataset.i)]; const f = e.target.dataset.f; r[f] = e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.tagName === 'SELECT' ? e.target.value : (e.target.value === '' ? null : Number(e.target.value)); tr.classList.toggle('dirty', JSON.stringify(r) !== eco.events.orig[Number(tr.dataset.i)]); ecoRender(); });
$('evTable').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (!tr) return; const i = Number(tr.dataset.i); const r = eco.events.rows[i];
  if (e.target.classList.contains('ev-del')) return run(async () => { const ok = await showModal(`Remove event ${r.name}?`, '', [{ label: 'Remove', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) return; eco.events.rows.splice(i, 1); eco.events.orig.splice(i, 1); renderEvents(); ecoRender(); });
  if (e.target.classList.contains('ev-kids')) return run(async () => {
    const txt = r.children.map(c => `${c.type} ${c.min ?? 0} ${c.max ?? 0} ${c.lootmin ?? 0} ${c.lootmax ?? 0}`).join('\n');
    const ok = await showModal(`Children of ${r.name}`, `<p class="muted">One child per line: <code>Type min max lootmin lootmax</code>. The type must exist in a types file.</p><textarea id="mKids" class="input" rows="8" spellcheck="false">${esc(txt)}</textarea>`, [{ label: 'Apply', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (!ok) return;
    r.children = $('mKids').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [type, min, max, lootmin, lootmax] = l.split(/\s+/); return { type, min: Number(min) || 0, max: Number(max) || 0, lootmin: Number(lootmin) || 0, lootmax: Number(lootmax) || 0 }; });
    r.hasChildren = true; renderEvents(); ecoRender();
  });
});
$('btnEventAdd').onclick = () => run(async () => {
  const ok = await showModal('New event', '<label class="field">Name (must start with Static, Vehicle, Animal, Infected, Loot, Ambient, Item or Trajectory) <input id="mEvName" class="input" placeholder="VehicleMyCar"></label>', [{ label: 'Create', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok || !$('mEvName').value.trim()) return;
  eco.events.rows.push({ name: $('mEvName').value.trim(), nominal: 1, min: 0, max: 2, lifetime: 300, restock: 0, saferadius: 500, distanceradius: 500, cleanupradius: 1000, flags: { deletable: 0, init_random: 0, remove_damaged: 1 }, position: 'fixed', limit: 'child', active: 1, secondary: [], children: [], hasChildren: true });
  eco.events.orig.push('__new__'); $('efSearch').value = ''; renderEvents(); ecoRender();
});
// ----- spawnable types -----
function renderSpawn() {
  const st = eco.spawn; const box = $('spList');
  if (!st) { box.innerHTML = ''; return; }
  st.open = st.open || new Set(); for (const d of box.querySelectorAll('.sp-type')) { if (d.open) st.open.add(d.dataset.i); else st.open.delete(d.dataset.i); }
  const q = $('sfSearch').value.trim().toLowerCase();
  const idx = st.rows.map((r, i) => i).filter(i => !q || st.rows[i].name.toLowerCase().includes(q)).slice(0, 300);
  $('sfCount').textContent = `${idx.length} shown (first 300)`;
  const group = (i, kind, gi, g) => `<div class="sp-group" data-i="${i}" data-kind="${kind}" data-gi="${gi}"><div class="row gap"><b>${kind}</b>${g.preset ? `<span class="muted">preset ${esc(g.preset)}</span>` : `<span class="muted">chance</span><input type="number" step="0.01" min="0" max="1" class="input sp-gchance" value="${g.chance ?? 1}" style="width:80px">`}<span class="grow"></span>${g.preset ? '' : '<button class="btn small sp-fromlist" title="Fill this group by clicking items in the list on the right">Add from list</button><button class="btn small sp-additem">+ item</button>'}<button class="btn small danger sp-delgroup">✕</button></div>${g.preset ? '' : `<div class="sp-items">${g.items.map((it, ii) => `<div class="row gap sp-item" data-ii="${ii}"><input class="input sp-iname" value="${esc(it.name)}" style="width:220px"><span class="muted">chance</span><input type="number" step="0.01" min="0" max="1" class="input sp-ichance" value="${it.chance ?? ''}" placeholder="1" style="width:80px"><button class="btn small danger sp-delitem">✕</button></div>`).join('')}</div>`}</div>`;
  box.innerHTML = idx.map(i => { const r = st.rows[i]; const dirty = JSON.stringify(r) !== st.orig[i];
    return `<details class="sp-type ${dirty ? 'dirty' : ''}" data-i="${i}"><summary><b>${esc(r.name)}</b> <span class="muted">${r.attachments.length} attachment group(s), ${r.cargo.length} cargo group(s)${r.hoarder ? ', hoarder' : ''}${r.damage ? `, damage ${r.damage.min}–${r.damage.max}` : ''}</span></summary>
      <div class="row gap wrap sp-tools"><button class="btn small sp-addgroup" data-kind="attachments">+ attachments group</button><button class="btn small sp-addgroup" data-kind="cargo">+ cargo group</button></div>
      ${r.attachments.map((g, gi) => group(i, 'attachments', gi, g)).join('')}${r.cargo.map((g, gi) => group(i, 'cargo', gi, g)).join('')}</details>`; }).join('') || '<div class="empty">No entries.</div>';
  for (const d of box.querySelectorAll('.sp-type')) if (st.open.has(d.dataset.i)) d.open = true;
  if (st.target) { const g = box.querySelector(`.sp-group[data-i="${st.target.i}"][data-kind="${st.target.kind}"][data-gi="${st.target.gi}"]`); if (g) { g.classList.add('target'); const b = g.querySelector('.sp-fromlist'); if (b) b.classList.add('on'); } else st.target = null; }
  $('spTarget').textContent = st.target ? `Adding to ${st.rows[st.target.i].name} → ${st.target.kind} group ${st.target.gi + 1}. Click items on the right.` : 'Pick a group with "Add from list" to fill it from the item list on the right.';
}
// ----- item picker (class names and categories from the types files of the active mission) -----
let itemCatalog = null;
async function loadItemCatalog() {
  if (itemCatalog) return itemCatalog;
  const list = eco.files ? eco.files.types.filter(f => f.exists) : [];
  const seen = new Map();
  for (const f of list) { try { for (const r of await ipc.invoke('economy:loadTypes', f.abs)) if (!seen.has(r.name)) seen.set(r.name, { name: r.name, cat: r.category[0] || 'other', usage: r.usage }); } catch { /* skip */ } }
  itemCatalog = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  const cats = [...new Set(itemCatalog.map(x => x.cat))].sort();
  $('ipCat').innerHTML = '<option value="">All classes</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  return itemCatalog;
}
function renderItemPicker() {
  const q = $('ipSearch').value.trim().toLowerCase(), c = $('ipCat').value;
  const st = eco.spawn; const inGroup = new Set(st && st.target ? st.rows[st.target.i][st.target.kind][st.target.gi].items.map(x => x.name) : []);
  const rows = (itemCatalog || []).filter(x => (!q || x.name.toLowerCase().includes(q)) && (!c || x.cat === c)).slice(0, 400);
  $('ipList').innerHTML = rows.map(x => `<div class="ip-item ${inGroup.has(x.name) ? 'disabled' : ''}" data-name="${esc(x.name)}" title="${esc(x.usage.join(', ') || x.cat)}"><span>${esc(x.name)}</span><span class="muted">${esc(x.cat)}</span></div>`).join('') || '<div class="muted" style="padding:8px">No items match.</div>';
}
$('ipSearch').addEventListener('input', renderItemPicker); $('ipCat').onchange = renderItemPicker;
$('ipList').addEventListener('click', e => {
  const it = e.target.closest('.ip-item'); const st = eco.spawn; if (!it || !st || it.classList.contains('disabled')) return;
  if (!st.target) { toast('Pick a group first: open a type and press "Add from list"', true); return; }
  const grp = st.rows[st.target.i][st.target.kind][st.target.gi]; if (!grp || grp.preset) return;
  grp.items.push({ name: it.dataset.name, chance: 1 }); st.open.add(String(st.target.i));
  renderSpawn(); ecoRender(); renderItemPicker();
});
$('sfSearch').addEventListener('input', renderSpawn);
$('spList').addEventListener('change', e => {
  const st = eco.spawn; const g = e.target.closest('.sp-group'); if (!g) return; const r = st.rows[Number(g.dataset.i)]; const grp = r[g.dataset.kind][Number(g.dataset.gi)];
  if (e.target.classList.contains('sp-gchance')) grp.chance = Number(e.target.value);
  const it = e.target.closest('.sp-item'); if (it) { const item = grp.items[Number(it.dataset.ii)]; if (e.target.classList.contains('sp-iname')) item.name = e.target.value.trim(); if (e.target.classList.contains('sp-ichance')) item.chance = e.target.value === '' ? null : Number(e.target.value); }
  ecoRender();
});
$('spList').addEventListener('click', e => {
  const st = eco.spawn; const t = e.target.closest('.sp-type'); if (!t) return; const r = st.rows[Number(t.dataset.i)];
  if (e.target.classList.contains('sp-addgroup')) { r[e.target.dataset.kind].push({ chance: 1, preset: null, items: [] }); renderSpawn(); ecoRender(); return; }
  const g = e.target.closest('.sp-group'); if (!g) return; const list = r[g.dataset.kind]; const gi = Number(g.dataset.gi);
  if (e.target.classList.contains('sp-fromlist')) { const same = st.target && st.target.i === Number(t.dataset.i) && st.target.kind === g.dataset.kind && st.target.gi === gi; st.target = same ? null : { i: Number(t.dataset.i), kind: g.dataset.kind, gi }; st.open = st.open || new Set(); st.open.add(t.dataset.i); renderSpawn(); renderItemPicker(); return; }
  if (e.target.classList.contains('sp-delgroup')) { list.splice(gi, 1); if (st.target && st.target.i === Number(t.dataset.i)) st.target = null; }
  else if (e.target.classList.contains('sp-additem')) { list[gi].items.push({ name: '', chance: 1 }); }
  else if (e.target.classList.contains('sp-delitem')) { const it = e.target.closest('.sp-item'); list[gi].items.splice(Number(it.dataset.ii), 1); }
  else return;
  renderSpawn(); ecoRender(); renderItemPicker();
});
// ----- save / revert / problems -----
function renderEcoProblems(problems, counts) {
  const has = (problems && problems.length) || (counts && (counts.error || counts.warning));
  $('ecoProblemsHead').hidden = !has; $('ecoProblems').hidden = !has;
  $('ecoProblemsTitle').textContent = counts ? `Problems — ${counts.error} errors, ${counts.warning} warnings` : 'Problems';
  $('ecoProblems').innerHTML = problems.length ? problems.map(p => `<div class="problem ${p.severity}"><span class="sev">${p.severity}</span><span class="pline">L${p.line}</span><span>${esc(p.message)}</span></div>`).join('') : (counts ? '<div class="ok">✓ Saved, no problems.</div>' : '');
}
$('btnEcoSave').onclick = (e) => run(async () => {
  const st = ecoState(); if (!st) return;
  const r = await ipc.invoke(eco.tab === 'types' ? 'economy:saveTypes' : eco.tab === 'events' ? 'economy:saveEvents' : 'economy:saveSpawnable', st.abs, st.rows);
  st.orig = st.rows.map(x => JSON.stringify(x));
  renderEcoProblems(r.problems, r.counts); ecoRender();
  toast(`Saved ${r.saved} entries${r.counts.error ? ` with ${r.counts.error} error(s)` : ''}`, r.counts.error > 0);
}, e.target);
$('btnEcoRevert').onclick = (e) => run(async () => { const st = ecoState(); if (!st) return; if (ecoDirtyCount(st) && !(await showModal('Revert changes?', '', [{ label: 'Revert', value: true, primary: true }, { label: 'Cancel', value: false }]))) return; const s2 = ecoState(); if (s2) s2.abs = null; await ecoLoad(); }, e.target);
// ----- import (paste / file / drop) -----
function ecoKindLabel() { return eco.tab === 'types' ? 'types' : eco.tab === 'events' ? 'events' : 'spawnable types'; }
async function ecoImportText(text, sourceName) {
  const st = ecoState(); if (!st) { toast('Load a file first', true); return; }
  let rows;
  try { rows = await ipc.invoke('economy:parse', eco.tab, text); } catch (e) { toast(e.message, true); return; }
  const existing = new Map(st.rows.map((r, i) => [r.name, i]));
  const dup = rows.filter(r => existing.has(r.name)).length;
  const mode = await showModal(`Import ${rows.length} ${ecoKindLabel()}${sourceName ? ' from ' + esc(sourceName) : ''}`,
    `<p>${rows.length - dup} new, ${dup} already in this file.</p>${dup ? '<p class="muted">What should happen to the ones that already exist?</p>' : ''}`,
    dup ? [{ label: 'Replace existing', value: 'replace', primary: true }, { label: 'Keep existing, add new only', value: 'skip' }, { label: 'Cancel', value: null }] : [{ label: 'Add', value: 'skip', primary: true }, { label: 'Cancel', value: null }]);
  if (!mode) return;
  let added = 0, replaced = 0;
  for (const r of rows) {
    if (existing.has(r.name)) { if (mode === 'replace') { st.rows[existing.get(r.name)] = r; replaced++; } }
    else { st.rows.push(r); st.orig.push('\u0000new'); existing.set(r.name, st.rows.length - 1); added++; }
  }
  toast(`Imported: ${added} added, ${replaced} replaced. Save to write the file.`);
  if (eco.tab === 'types') { $('tfSearch').value = ''; }
  ecoRender();
}
$('btnEcoImport').onclick = () => run(async () => {
  if (!ecoState()) { toast('Load a file first', true); return; }
  const ok = await showModal(`Import ${ecoKindLabel()} into ${esc($('ecoFile').selectedOptions[0] ? $('ecoFile').selectedOptions[0].textContent : 'this file')}`,
    `<p class="muted">Paste a whole file or just the entries (for example the \u003ctype\u003e blocks from a mod's readme), or pick a file. Entries are matched by name.</p><textarea id="mImport" class="input" rows="12" spellcheck="false" placeholder="&lt;type name=&quot;MyItem&quot;&gt; … &lt;/type&gt;"></textarea><div class="row gap"><button class="btn small" id="mImportPick">Choose file…</button><span class="muted">or drop a file anywhere on the Economy page</span></div>`,
    [{ label: 'Import', value: true, primary: true }, { label: 'Cancel', value: false }]);
  const text = $('mImport') ? $('mImport').value : '';
  if (!ok) return;
  await ecoImportText(text, null);
});
document.addEventListener('click', async e => {
  if (e.target && e.target.id === 'mImportPick') {
    const f = await ipc.invoke('dialog:pickFile', { filters: [{ name: 'XML', extensions: ['xml'] }] });
    if (f) { try { $('mImport').value = await ipc.invoke('fs:readText', f); } catch (err) { toast(err.message, true); } }
  }
});
{ const page = $('page-economy'); let depth = 0;
  page.addEventListener('dragenter', e => { e.preventDefault(); depth++; page.classList.add('eco-drop'); });
  page.addEventListener('dragover', e => { e.preventDefault(); });
  page.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; page.classList.remove('eco-drop'); } });
  page.addEventListener('drop', async e => {
    e.preventDefault(); depth = 0; page.classList.remove('eco-drop');
    const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (!f) return;
    try { const text = await f.text(); await ecoImportText(text, f.name); } catch (err) { toast(err.message, true); }
  });
}
// ----- new / custom mission files -----
$('btnEcoNewFile').onclick = () => run(async () => {
  const kind = eco.tab; const suffix = kind === 'types' ? 'types' : kind === 'events' ? 'events' : 'spawnabletypes';
  const ok = await showModal(`New ${ecoKindLabel()} file`,
    `<p class="muted">The file is created inside the mission folder and registered in cfgeconomycore.xml so the server loads it. Use a sub folder such as <code>custom/</code>. If the file already exists it is only registered.</p><label class="field">File (relative to the mission) <input id="mNewFile" class="input" value="custom/my_${suffix}.xml"></label>`,
    [{ label: 'Create and register', value: true, primary: true }, { label: 'Cancel', value: false }]);
  const rel = $('mNewFile') ? $('mNewFile').value.trim() : '';
  if (!ok || !rel) return;
  const r = await ipc.invoke('economy:createFile', { kind, rel });
  eco.files = r.files;
  toast(r.registered ? 'File created and registered' : 'File already registered');
  ecoSetTab(kind); $('ecoFile').value = r.abs; await ecoLoad();
});
$('btnEcoOpenEditor').onclick = () => { const st = ecoState(); if (!st) return; showPage('server'); setTimeout(() => openConfigFile(st.abs), 300); };


// ---------- settings page: prefs, updates, data ----------
async function loadMapLink() {
  let st; try { st = await ipc.invoke('maplink:status'); } catch { return; }
  $('mlOwnKey').textContent = st.ownKey;
  $('mlWebState').textContent = st.websiteRunning ? `The website is running on port ${st.websitePort}; linked PCs send to this address.` : 'The website is off: start it on the Website page so linked PCs can send maps here.';
  $('mlUrl').value = st.target.url || ''; $('mlAuto').checked = st.target.auto !== false; $('mlKey').placeholder = st.target.hasKey ? 'saved (paste a new one to change it)' : 'paste the key shown on the server';
  renderMapLinkState(st);
}
function renderMapLinkState(st) {
  const el = $('mlState'); if (!el) return;
  el.textContent = st.sending ? 'Sending…' : st.error ? 'Last attempt: ' + st.error : st.last ? (st.last.action === 'sent' ? `Sent the ${st.last.map} map ${new Date(st.last.at).toLocaleTimeString()}` : `Server already has the current ${st.last.map} map (${new Date(st.last.at).toLocaleTimeString()})`) : '';
}
$('btnMlCopyKey').onclick = () => { navigator.clipboard.writeText($('mlOwnKey').textContent); toast('Link key copied'); };
$('btnMlNewKey').onclick = (e) => run(async () => { if (!await showModal('New link key', '<p>Make a new link key? PCs linked with the old key can no longer send maps until you paste the new key there.</p>', [{ label: 'New key', value: true, primary: true }, { label: 'Cancel', value: false }])) return; await ipc.invoke('maplink:newOwnKey'); loadMapLink(); }, e.target);
$('btnMlSave').onclick = (e) => run(async () => { const key = $('mlKey').value.trim(); if (key && !/^[0-9a-fA-F]{64}$/.test(key)) return toast('That is not a link key: copy the 64-character key from the server tool.', true); const cur = await ipc.invoke('maplink:status'); await ipc.invoke('maplink:setTarget', { url: $('mlUrl').value, key: key || (cur.target.hasKey ? undefined : ''), auto: $('mlAuto').checked }); $('mlKey').value = ''; toast('Map sharing saved'); loadMapLink(); }, e.target);
$('btnMlSend').onclick = (e) => run(async () => { const r = await ipc.invoke('maplink:send'); toast(r.action === 'sent' ? `Sent the ${r.map} map (${r.tiles} tiles)` : r.action === 'up-to-date' ? 'The server already has this map' : 'Sending…'); loadMapLink(); }, e.target);
ipc.on('maplink:state', st => renderMapLinkState(st));
ipc.on('maps:changed', () => { if (document.querySelector('#page-map.active') && typeof loadMapInfo === 'function') loadMapInfo().then(() => scheduleDraw()); });
async function loadSettingsPage() {
  loadMapLink();
  const p = await ipc.invoke('app:prefs');
  $('prefCloseToTray').checked = !!p.closeToTray; $('prefStartMinimized').checked = !!p.startMinimized; $('prefLaunchAtLogin').checked = !!p.launchAtLogin;   $('prefAutoUpdate').checked = p.autoUpdate !== false;
  $('prefAutoStartServer').checked = !!p.autoStartServer; $('prefShowServerWindow').checked = !!p.showServerWindow; $('prefAutoFirewall').checked = p.autoFirewall !== false; $('prefAutoStartDelay').value = p.autoStartDelaySec || 10; $('prefTheme').value = p.theme || 'dark';
  $('dataDir').textContent = p.dataDir;
  renderUpdate(await ipc.invoke('update:state'), p);
}
$('btnPrefsSave').onclick = (e) => run(async () => { await ipc.invoke('app:setPrefs', { closeToTray: $('prefCloseToTray').checked, startMinimized: $('prefStartMinimized').checked, launchAtLogin: $('prefLaunchAtLogin').checked, autoUpdate: $('prefAutoUpdate').checked, autoStartServer: $('prefAutoStartServer').checked, autoFirewall: $('prefAutoFirewall').checked, showServerWindow: $('prefShowServerWindow').checked, autoStartDelaySec: Number($('prefAutoStartDelay').value) || 10, theme: $('prefTheme').value }); applyTheme($('prefTheme').value); try { localStorage.setItem('theme', $('prefTheme').value); } catch {} toast('Preferences saved'); }, e.target);
$('btnOpenDataDir').onclick = () => ipc.invoke('app:openDataDir');
$('btnOpenLogDir').onclick = () => ipc.invoke('app:openLogDir');
$('btnExportDiag').onclick = (e) => run(async () => { const f = await ipc.invoke('app:exportDiagnostics'); if (f) toast('Diagnostics bundle saved: ' + f); }, e.target);
$('btnExportSettings').onclick = (e) => run(async () => { const f = await ipc.invoke('app:exportSettings'); if (f) toast('Exported to ' + f); }, e.target);
$('btnImportSettings').onclick = (e) => run(async () => { const ok = await ipc.invoke('app:importSettings'); if (ok) { toast('Settings imported'); await loadSettings(); } }, e.target);
function renderUpdate(u, p) {
  const cur = (p && p.version) || u.current;
  const text = { idle: `Version ${cur}.`, checking: 'Checking for updates…', none: `Version ${cur} is up to date.`, available: `Version ${u.version} is available (you have ${cur}).`, downloading: `Downloading ${u.version}… ${u.progress || 0}%`, downloaded: `Version ${u.version} is downloaded. Restart to install.`, error: `Update check failed: ${u.error}` }[u.status] || `Version ${cur}.`;
  $('updateInfo').textContent = text + (p && !p.packaged ? ' (running from source: updates are disabled)' : '');
  $('btnUpdateDownload').hidden = u.status !== 'available'; $('btnUpdateInstall').hidden = u.status !== 'downloaded';
  const pill = $('pillUpdate'); pill.hidden = !['available', 'downloaded'].includes(u.status); pill.textContent = u.status === 'downloaded' ? 'Restart to update' : 'Update available';
  const b = $('updateBanner'); b.hidden = !['available', 'downloaded'].includes(u.status); b.textContent = u.status === 'downloaded' ? `Version ${u.version} is ready to install.` : `Version ${u.version} is available.`;
}
$('btnUpdateCheck').onclick = (e) => run(async () => { renderUpdate(await ipc.invoke('update:check')); }, e.target);
$('btnUpdateDownload').onclick = (e) => run(async () => { await ipc.invoke('update:download'); }, e.target);
$('btnUpdateInstall').onclick = (e) => run(async () => { await ipc.invoke('update:install'); }, e.target);
$('pillUpdate').onclick = () => showPage('settings');
ipc.on('update:state', (u) => renderUpdate(u));


// ---------- mission tools ----------
async function refreshMission() {
  const r = await ipc.invoke('mission:list');
  $('missionTable').querySelector('tbody').innerHTML = r.missions.map(mi => `<tr><td><b>${esc(mi.name)}</b>${mi.active ? ' <span class="badge ok">active</span>' : ''}</td><td>${esc(mi.map)}</td><td>${mi.storage ? 'yes' : '<span class="muted">none</span>'}</td><td>${mi.playersDb ? fmtBytes(mi.playersDb) : '<span class="muted">—</span>'}</td><td>${mi.active ? '' : `<button class="btn small ms-switch" data-name="${esc(mi.name)}">Switch to</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No missions found. Install the server first.</td></tr>';
  $('wipeInfo').textContent = r.current ? `Active mission: ${r.current}` : 'No active mission.';
  const gp = await ipc.invoke('mission:gameplay');
  $('gpInfo').textContent = gp.exists ? gp.file : 'No cfggameplay.json in the active mission (enableCfgGameplayFile = 1 in serverDZ.cfg turns it on).';
  gpFields = gp.fields; renderGp();
}
let gpFields = [], gpChanges = {};
function renderGp() {
  const q = $('gpFilter').value.trim().toLowerCase();
  $('gpTable').querySelector('tbody').innerHTML = gpFields.filter(f => !q || f.path.toLowerCase().includes(q)).slice(0, 400).map(f => { const v = gpChanges[f.path] !== undefined ? gpChanges[f.path] : f.value; const ctl = f.type === 'boolean' ? `<input type="checkbox" class="gp" data-p="${esc(f.path)}" ${v ? 'checked' : ''}>` : f.type === 'number' ? `<input type="number" step="any" class="input gp" data-p="${esc(f.path)}" value="${v}" style="width:120px;padding:3px 7px">` : f.type === 'array' ? `<input class="input gp" data-p="${esc(f.path)}" data-arr="1" value="${esc(JSON.stringify(v))}" style="padding:3px 7px">` : `<input class="input gp" data-p="${esc(f.path)}" value="${esc(String(v))}" style="padding:3px 7px">`; return `<tr><td class="mono">${esc(f.path)}</td><td>${ctl}</td></tr>`; }).join('');
}
$('gpFilter').addEventListener('input', renderGp);
$('gpTable').addEventListener('change', e => { const el = e.target.closest('.gp'); if (!el) return; const f = gpFields.find(x => x.path === el.dataset.p); let v; if (el.type === 'checkbox') v = el.checked; else if (f.type === 'number') v = Number(el.value); else if (el.dataset.arr) { try { v = JSON.parse(el.value); } catch { return toast('Invalid array (use JSON like [1,2])', true); } } else v = el.value; gpChanges[el.dataset.p] = v; });
$('btnGpSave').onclick = (e) => run(async () => { const changes = Object.entries(gpChanges).map(([path, value]) => ({ path, value })); if (!changes.length) return toast('Nothing changed'); const r = await ipc.invoke('mission:saveGameplay', changes); gpChanges = {}; toast(r.counts.error ? `Saved with ${r.counts.error} problem(s), see Config Editor` : 'cfggameplay.json saved', r.counts.error > 0); refreshMission(); }, e.target);
$('missionTable').addEventListener('click', e => { const b = e.target.closest('.ms-switch'); if (!b) return; run(async () => { const ok = await showModal(`Switch to ${b.dataset.name}?`, '<p>serverDZ.cfg is updated (a .bak is kept). Players keep their characters only if the new mission has its own storage.</p>', [{ label: 'Switch', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) return; await ipc.invoke('mission:switch', b.dataset.name); toast('Mission switched'); refreshMission(); refreshConfigTree(); }); });
const wipe = (kind, label) => (e) => run(async () => { const ok = await showModal(label, '<p>A backup is taken first. The server must be stopped. This cannot be undone except by restoring that backup.</p><label class="field">Type WIPE to confirm <input id="mWipe" class="input"></label>', [{ label: 'Wipe', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok || $('mWipe').value.trim() !== 'WIPE') return toast('Cancelled'); const r = await ipc.invoke('mission:wipe', kind); toast(`Wiped. Backup: ${r.backup}`); refreshMission(); }, e.target);
$('btnWipeAll').onclick = wipe('all', 'Full wipe of the active mission'); $('btnWipePlayers').onclick = wipe('players', 'Wipe all characters'); $('btnWipeWorld').onclick = wipe('world', 'World wipe: bases, vehicles and loot (characters are kept)');
let wipeArmTimer = null;
function setWipeArmed(on) { for (const id of ['btnWipeAll', 'btnWipeWorld', 'btnWipePlayers']) $(id).disabled = !on; $('wipeArm').checked = on; clearTimeout(wipeArmTimer); if (on) wipeArmTimer = setTimeout(() => setWipeArmed(false), 60000); }
$('wipeArm').onchange = () => setWipeArmed($('wipeArm').checked);
$('btnMissionRefresh').onclick = () => run(refreshMission);
$('btnOpenMissionFolder').onclick = () => run(async () => { const r = await ipc.invoke('configs:list'); if (r.missionDir) ipc.invoke('shell:openPath', r.missionDir); else toast('No active mission folder', true); });

// ---------- scheduled tasks ----------
let taskTypes = {};
async function refreshTasks() {
  const r = await ipc.invoke('tasks:all'); taskTypes = r.types;
  const next = Object.fromEntries(r.next.map(n => [n.id, n.next]));
  $('taskTable').querySelector('tbody').innerHTML = r.tasks.map(t => `<tr data-id="${esc(t.id)}"><td><b>${esc(t.name)}</b>${t.payload ? `<div class="muted mono" style="font-size:11px">${esc(t.payload.slice(0, 80))}</div>` : ''}</td><td>${esc(taskTypes[t.type] || t.type)}</td><td>${t.mode === 'times' ? 'daily at ' + esc((t.times || []).join(', ')) : 'every ' + t.intervalMinutes + ' min'}${t.onlyWhenRunning ? '' : ' <span class="badge">even when stopped</span>'}</td><td class="muted">${next[t.id] ? fmtDate(next[t.id]) : '—'}</td><td class="muted">${t.lastRun ? fmtDate(t.lastRun) : '—'}</td><td><input type="checkbox" class="tk-on" ${t.enabled ? 'checked' : ''}></td><td class="row gap"><button class="btn small tk-run">Run now</button><button class="btn small tk-edit">Edit</button><button class="btn small danger tk-del">✕</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No tasks yet.</td></tr>';
}
async function editTask(t = {}) {
  const typeOpts = Object.entries(taskTypes).map(([k, v]) => `<option value="${k}" ${t.type === k ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const ok = await showModal(t.id ? 'Edit task' : 'New task', `
    <label class="field">Name <input id="tkName" class="input" value="${esc(t.name || '')}"></label>
    <label class="field">What <select id="tkType" class="input">${typeOpts}</select></label>
    <label class="field">Message / command <input id="tkPayload" class="input" value="${esc(t.payload || '')}" placeholder="e.g. Server restarts at 04:00 — or: kick 3 reason — or: C:\\scripts\\cleanup.bat"></label>
    <div class="grid-2 tight"><label class="field">Schedule <select id="tkMode" class="input"><option value="times" ${t.mode !== 'interval' ? 'selected' : ''}>Daily at times</option><option value="interval" ${t.mode === 'interval' ? 'selected' : ''}>Every N minutes</option></select></label><label class="field">Times (HH:MM, comma separated) <input id="tkTimes" class="input" value="${esc((t.times || []).join(', '))}" placeholder="12:00, 18:00"></label><label class="field">Interval minutes <input id="tkInterval" class="input" type="number" min="1" value="${t.intervalMinutes || 60}"></label></div>
    <label class="check"><input type="checkbox" id="tkOnly" ${t.onlyWhenRunning !== false ? 'checked' : ''}> Only while the server is running</label>`,
    [{ label: 'Save', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  await ipc.invoke('tasks:upsert', { id: t.id, name: $('tkName').value.trim() || 'Task', type: $('tkType').value, payload: $('tkPayload').value, mode: $('tkMode').value, times: $('tkTimes').value.split(/[,\s]+/).map(x => x.trim()).filter(Boolean).map(x => x.padStart(5, '0')), intervalMinutes: Number($('tkInterval').value) || 60, onlyWhenRunning: $('tkOnly').checked, enabled: t.enabled !== false });
  refreshTasks();
}
$('btnTaskNew').onclick = () => run(() => editTask());
$('taskTable').addEventListener('click', e => { const tr = e.target.closest('tr'); if (!tr || !tr.dataset.id) return; const id = tr.dataset.id;
  if (e.target.classList.contains('tk-run')) return run(async () => { toast('Running…'); await ipc.invoke('tasks:run', id); refreshTasks(); }, e.target);
  if (e.target.classList.contains('tk-edit')) return run(async () => { const r = await ipc.invoke('tasks:all'); await editTask(r.tasks.find(t => t.id === id)); });
  if (e.target.classList.contains('tk-del')) return run(async () => { await ipc.invoke('tasks:remove', id); refreshTasks(); });
});
$('taskTable').addEventListener('change', e => { const tr = e.target.closest('tr'); if (!tr || !e.target.classList.contains('tk-on')) return; run(async () => { const r = await ipc.invoke('tasks:all'); const t = r.tasks.find(x => x.id === tr.dataset.id); await ipc.invoke('tasks:upsert', { ...t, enabled: e.target.checked }); refreshTasks(); }); });
ipc.on('tasks:changed', () => { if (document.querySelector('#page-tasks.active')) refreshTasks(); });

// ---------- network ----------
async function refreshNetwork() {
  refreshUpnp();
  $('netPublicIp').textContent = 'checking…';
  const r = await ipc.invoke('network:report');
  $('netPublicIp').textContent = r.publicIp ? `Public IP ${r.publicIp}` : 'Public IP unknown (offline?)';
  $('netPorts').querySelector('tbody').innerHTML = r.ports.map(p => `<tr><td>${esc(p.name)}</td><td class="mono">${p.port}</td><td>${p.proto}</td><td>${p.listening === null ? '?' : p.listening ? '<span class="badge ok">yes</span>' : '<span class="badge">no</span>'}</td><td class="muted">${esc(p.why)}</td></tr>`).join('');
  { const q = (lbl, v) => v ? `<span class="badge ok">${lbl}: answers</span> <span class="muted">${esc(v.name)} · ${esc(v.map)} · ${v.players}/${v.maxPlayers} players · ${v.ping} ms</span>` : `<span class="badge">${lbl}: no answer</span>`;
    $('netQuery').innerHTML = `<div>${q('Local query (port ' + r.queryPort + ')', r.queryLocal)}</div><div class="mt-s">${r.publicIp ? q('Public query (' + r.publicIp + ')', r.queryPublic) : '<span class="badge">Public query: no public IP</span>'}</div><div class="muted mt-s">${r.queryLocal ? (r.queryPublic ? 'The server is visible from the internet.' : 'The server answers locally but not on the public IP. Either the router does not forward UDP ' + r.queryPort + ' and the game ports, or your router does not allow connecting to its own public IP from inside the LAN (hairpin NAT). Ask a friend to test, or check from a phone on mobile data.') : 'The server is not answering Steam queries locally. Start it, then refresh; it takes a minute after start.'}</div>`; }
  { const w = r.stacks; const box = $('netStacks');
    if (!w) box.textContent = 'Could not check.';
    else if (!w.found.length && !w.running.length && !w.iis) box.innerHTML = '<span class="badge ok">none found</span> <span class="muted">No PHP, XAMPP, WAMP, Laragon or IIS on this machine. The tool\'s own website runs on Node and has no PHP.</span>';
    else box.innerHTML = w.found.map(f => `<div>${f.vulnerable === true ? '<span class="badge bad">vulnerable</span>' : f.vulnerable === false ? '<span class="badge ok">patched</span>' : '<span class="badge">unknown version</span>'} <b>${esc(f.name)}</b> <span class="muted mono">${esc(f.dir)}</span>${f.version ? ` · PHP ${esc(f.version)}${f.fixed ? ' (fixed: ' + esc(f.fixed) + ')' : ''}` : ''}</div>`).join('')
      + (w.iis ? '<div><span class="badge">IIS installed</span> <span class="muted">make sure any PHP handler on it is patched</span></div>' : '')
      + (w.running.length ? `<div class="mt-s"><span class="badge bad">running now</span> ${esc(w.running.join(', '))} · stop it unless you need it, and never forward ports 80/443 to it while it is unpatched.</div>` : '<div class="mt-s muted">Nothing from these is running right now, so it is not reachable; it only matters if you start it.</div>')
      + `<div class="mt-s muted">${esc(w.advisory)}</div>`; }
  $('netWeb').textContent = r.websiteReachableLocal ? 'Website answers locally. If it is unreachable from outside, forward the TCP port on your router.' : 'Website is not running (start it on the Website page to test).';
  $('netRules').querySelector('tbody').innerHTML = r.rules.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.proto)}</td><td class="mono">${esc(x.port)}</td><td>${x.enabled ? '<span class="badge ok">on</span>' : '<span class="badge warn">off</span>'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No rules from this tool yet.</td></tr>';
}
$('btnNetRefresh').onclick = () => run(refreshNetwork);
async function loadLogCleanup() { try { const c = await ipc.invoke('logs:cleanupCfg'); state.logClean = c; $('logCleanEnabled').checked = !!c.enabled; $('logCleanDays').value = c.keepDays; } catch { /* ignore */ } }
// the toolbar keeps the switch and default age; the dialog holds the rest, so both save the whole config
const logCleanCfg = (over = {}) => ({ ...(state.logClean || {}), enabled: $('logCleanEnabled').checked, keepDays: Number($('logCleanDays').value) || 14, ...over });
const saveLogCleanup = () => ipc.invoke('logs:saveCleanupCfg', logCleanCfg()).then(() => loadLogCleanup()).then(() => toast('Log cleanup ' + ($('logCleanEnabled').checked ? 'on' : 'off')));
$('logCleanEnabled').onchange = saveLogCleanup; $('logCleanDays').onchange = saveLogCleanup;
$('btnLogCleanNow').onclick = (e) => run(async () => { const r = await ipc.invoke('logs:cleanup', { keepDays: Number($('logCleanDays').value) || 14 }); toast(`Removed ${r.removed} file(s), ${(r.bytes / 1048576).toFixed(1)} MB`); refreshLogList(); }, e.target);
function logCleanRows(p) {
  const mb = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
  return p.rules.map((r, i) => `<tr data-i="${i}"><td><input type="checkbox" class="lc-on" ${r.on ? 'checked' : ''}></td>
    <td>${r.type === 'folder' ? `<code>${esc(r.label)}</code>${r.exists ? '' : ' <span class="muted">(not there now)</span>'}` : esc(r.label)}</td>
    <td>${r.type === 'folder' ? `<input class="input lc-pat" style="width:110px" value="${esc(r.pattern)}" title="File names to delete, separated by ;  e.g. *.log;*_old.txt. Patterns that could match settings or saves (.json, .xml, .cfg, *) are ignored.">` : ''}</td>
    <td><input class="input lc-days" type="number" min="1" placeholder="${p.keepDays}" value="${r.ownDays || ''}" title="Keep this many days; empty uses the default"></td>
    <td class="muted">${r.files} · ${mb(r.bytes)}</td><td>${r.old ? `${r.old} · ${mb(r.oldBytes)}` : '<span class="muted">none</span>'}</td></tr>`).join('');
}
$('btnLogCleanWhat').onclick = (e) => run(async () => {
  let p = await ipc.invoke('logs:cleanupPreview', { keepDays: Number($('logCleanDays').value) || 14 });
  const read = () => {
    const kinds = {}, folders = { ...((state.logClean || {}).folders || {}) };
    document.querySelectorAll('#lcTable tbody tr').forEach(tr => { const r = p.rules[Number(tr.dataset.i)]; const on = tr.querySelector('.lc-on').checked, days = Number(tr.querySelector('.lc-days').value) || null;
      if (r.type === 'kind') kinds[r.key] = { on, days }; else folders[r.key] = { on, days, pattern: tr.querySelector('.lc-pat').value }; });
    const extra = ($('lcAdd').value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (extra && !folders[extra]) folders[extra] = { on: true, days: null, pattern: '*.log' };
    return logCleanCfg({ kinds, folders });
  };
  const body = `<p class="muted">Logs older than their age are deleted when the server stops (if automatic cleanup is on) or with Clean now. The newest file of each row is always kept. Only files matching a folder's pattern are touched; folders that hold this tool's data, BattlEye, player storage and settings files are never offered.</p>
    <div class="table-wrap" style="max-height:360px"><table class="table" id="lcTable"><thead><tr><th></th><th>Logs</th><th>Pattern</th><th>Keep days</th><th>Now</th><th>Would delete</th></tr></thead><tbody>${logCleanRows(p)}</tbody></table></div>
    <label class="field mt">Add a mod log folder (inside the profiles folder) <input id="lcAdd" class="input" placeholder="e.g. ExpansionMod/Logs"></label>`;
  const ok = await showModal('What to clean', body, [{ label: 'Save', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  p = await ipc.invoke('logs:saveCleanupCfg', read());
  await loadLogCleanup();
  const on = p.rules.filter(r => r.on); toast(`Cleaning ${on.length} kind(s) of logs; ${on.reduce((n, r) => n + r.old, 0)} file(s) are old enough now`);
}, e.target);
loadLogCleanup();
$('btnNetAddRules').onclick = (e) => run(async () => { toast('Windows will ask for permission…'); await ipc.invoke('network:addRules'); toast('Firewall rules added'); refreshNetwork(); }, e.target);
$('btnNetRemoveRules').onclick = (e) => run(async () => { await ipc.invoke('network:removeRules'); toast('Rules removed'); refreshNetwork(); }, e.target);

// ---------- player map ----------
// map page code lives in map.js


// ---------- server keys ----------
$('btnKeysOpen').onclick = () => state.keyMap && ipc.invoke('shell:openPath', state.keyMap.keysDir);
$('btnKeysOrphans').onclick = (e) => run(async () => {
  const files = state.keyMap.keys.filter(k => k.status === 'orphan').map(k => k.file);
  const ok = await showModal('Remove leftover keys?', `<p>No mod in the server or download folders ships these keys:</p><p><b>${esc(files.join(', '))}</b></p><p class="muted">They were left by mods that are gone. If you load a mod from somewhere else that needs one, re-add its key.</p>`, [{ label: 'Remove', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  const r = await ipc.invoke('mods:removeOrphanKeys', files); toast(`Removed ${r.removed.length} key(s)`);
}, e.target);
$('keysTable').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.classList.contains('key-del')) run(async () => { const r = await ipc.invoke('mods:removeOrphanKeys', [b.dataset.file]); toast(r.removed.length ? `Removed ${b.dataset.file}` : 'Not removed: a mod uses it'); }, b);
  if (b.classList.contains('key-fix')) run(async () => { await ipc.invoke('mods:fixKey', b.dataset.file); toast(`Copied ${b.dataset.file}`); }, b);
});

// ---------- mod safety check ----------
$('btnModCheck').onclick = (e) => run(async () => {
  const r = await ipc.invoke('mods:check');
  const rows = r.problems.map(p => `<div class="problem ${p.level}"><span class="sev">${p.level}</span><span class="pfile">${esc(p.mod)}</span><span>${esc(p.text)}</span></div>`).join('') || '<div class="ok">✓ No problems found.</div>';
  await showModal(`Mod check — ${r.counts.error} errors, ${r.counts.warning} warnings`, `<div class="problems" style="height:auto;max-height:300px">${rows}</div><div class="card-title mt">Players need (${r.clientCount})</div><textarea class="input" rows="3" readonly>${esc(r.playersNeed)}</textarea><textarea class="input" rows="3" readonly>${esc(r.workshopLinks)}</textarea>`, [{ label: 'Close', value: true, primary: true }]);
}, e.target);

// ---------- instances ----------
let instInfo = null;
async function refreshInstanceSelect() {
  try {
    instInfo = await ipc.invoke('instances:defaults');
    $('instanceSelect').innerHTML = instInfo.names.map(n => `<option value="${esc(n)}" ${n === instInfo.self ? 'selected' : ''}>${esc(n)}</option>`).join('');
    $('instanceSelect').hidden = instInfo.names.length < 2 && !instInfo.isChild;
    const nav = document.querySelector('.nav-btn[data-page="instances"]'); if (nav) nav.hidden = instInfo.isChild;
    $('discordModeWrap').hidden = !instInfo.isChild;
    if (instInfo.isChild) document.title = 'DayZ Admin Tools — ' + instInfo.self;
  } catch { /* ignore */ }
}
$('instanceSelect').onchange = (e) => run(async () => { const name = e.target.value; e.target.value = instInfo.self; if (name !== instInfo.self) { toast(`Opening ${name}…`); await ipc.invoke('instances:action', name, 'open'); } });
const fmtPorts = (p) => `game ${p.game} · query ${p.query} · RCon ${p.rcon}${p.webOn ? ' · web ' + p.web : ''}`;
function instCard(x) {
  const st = x.status, sv = st && st.server;
  const serverBadge = !x.toolRunning ? '<span class="badge">tool stopped</span>' : !sv ? '<span class="badge">no answer</span>' : sv.running ? (sv.stage && !sv.stage.ready ? `<span class="badge warn">loading: ${esc(sv.stage.label)}</span>` : '<span class="badge ok">server on</span>') : (sv.restartPending ? '<span class="badge warn">restarting</span>' : '<span class="badge">server off</span>');
  const h = st && st.health; const players = h && h.players !== null && h.players !== undefined ? `<span class="badge">${h.players} player${h.players === 1 ? '' : 's'}</span>` : '';
  const res = h && sv && sv.running ? `<span class="muted">CPU ${h.cpu !== null && h.cpu !== undefined ? Math.round(h.cpu) + '%' : '—'} · RAM ${h.ramMB ? (h.ramMB / 1024).toFixed(1) + ' GB' : '—'}${h.fps ? ' · ' + Math.round(h.fps) + ' FPS' : ''}</span>` : '';
  const cpuText = x.cpu.mode === 'auto' ? 'Auto' + (st && st.cpu && st.cpu.chosen ? ` (logical ${st.cpu.chosen.join(', ')})` : '') : x.cpu.mode === 'manual' ? `Chosen: ${(x.cpu.cores || []).join(', ') || 'none'}` : 'Windows decides';
  const botText = { own: 'Own bot', shared: 'Shared with main', off: 'Off' }[x.bot] || x.bot;
  const conflict = x.conflicts.length ? `<span class="badge bad" title="${esc(x.conflicts.map(c => `${c.proto} ${c.port} also used by ${c.by}`).join('; '))}">port clash</span>` : '';
  const running = sv && sv.running;
  return `<div class="card inst" data-name="${esc(x.name)}">
    <div class="row gap wrap"><b class="inst-name">${esc(x.name)}</b>${x.main ? '<span class="badge">main · this window</span>' : ''}${serverBadge}${players}${conflict}${!x.serverInstalled ? '<span class="badge warn">server not installed</span>' : ''}${!x.exists ? '<span class="badge bad">folder missing</span>' : ''}<span class="grow"></span>
      <button class="btn small i-open">Open</button>
      ${running && sv.stopping ? '<button class="btn small danger i-kill" title="The server has not closed yet: end its process now">Force stop</button>' : running ? '<button class="btn small i-restart">Restart</button><button class="btn small danger i-stop">Stop server</button>' : '<button class="btn small primary i-start">Start server</button>'}
      <button class="btn small i-more" title="More">⋯</button></div>
    <div class="inst-grid">
      <span class="muted">Folder</span><code class="i-dir" title="Open the folder">${esc(x.dir)}</code>
      <span class="muted">Ports</span><span>${fmtPorts(x.ports)}</span>
      <span class="muted">CPU</span><span>${esc(cpuText)}</span>
      <span class="muted">Bot</span><span>${esc(botText)}</span>
      ${res ? '<span class="muted">Now</span>' + res : ''}
      ${x.main ? '' : `<span class="muted">Start</span><label class="check"><input type="checkbox" class="i-auto" ${x.autoStart ? 'checked' : ''}> with the main window (its tool runs in the background)</label>`}
    </div></div>`;
}
let instList = [];
async function refreshInstances() {
  instList = await ipc.invoke('instances:list');
  $('instList').innerHTML = instList.map(instCard).join('');
  if (instInfo && instInfo.cpu) { const on = instList.filter(x => x.status && x.status.server && x.status.server.running).length; $('instMachine').textContent = `${instInfo.cpu.name || 'CPU'} · ${instInfo.cpu.physical} cores / ${instInfo.cpu.logical} threads · ${instInfo.ramGb} GB · ${instList.length} instance${instList.length > 1 ? 's' : ''}, ${on} running${on * 2 > instInfo.cpu.physical || on * 5 > instInfo.ramGb ? ' — more servers than this PC comfortably carries' : ''}`; }
}
setInterval(() => { if (document.querySelector('#page-instances.active')) refreshInstances().catch(() => {}); }, 5000);
ipc.on('instances:changed', () => { refreshInstanceSelect(); if (document.querySelector('#page-instances.active')) refreshInstances(); });
ipc.on('instances:progress', (p) => { const b = $('instProgress'); b.hidden = p.step === 'Done'; b.innerHTML = `<span>${esc(p.name)}: ${esc(p.step)}${p.detail ? ' — ' + esc(p.detail) : ''}${/^(Failed|Done)/.test(p.step) ? '' : ' <span class="spinner"></span>'}</span>`; if (p.step === 'Failed') setTimeout(() => { b.hidden = true; }, 15000); });
$('instList').addEventListener('click', (e) => {
  const card = e.target.closest('.inst'); if (!card) return; const name = card.dataset.name; const x = instList.find(i => i.name === name); const t = e.target;
  const act = (what, msg) => run(async () => { await ipc.invoke('instances:action', name, what); if (msg) toast(msg); refreshInstances(); }, t);
  if (t.classList.contains('i-auto')) return run(async () => ipc.invoke('instances:setAutoStart', name, t.checked));
  if (t.classList.contains('i-dir')) return ipc.invoke('shell:openPath', x.dir).catch(() => {});
  if (t.classList.contains('i-open')) return act('open');
  if (t.classList.contains('i-start')) return act('start', `Starting ${name}`);
  if (t.classList.contains('i-restart')) return act('restart', `Restarting ${name}`);
  if (t.classList.contains('i-kill')) return run(async () => { if (!(await showModal(`Force stop ${name}?`, '<p>End its server process now. Progress since the last autosave is lost.</p>', [{ label: 'Force stop', value: true, primary: true }, { label: 'Keep waiting', value: false }]))) return; await ipc.invoke('instances:action', name, 'kill'); refreshInstances(); }, t);
  if (t.classList.contains('i-stop')) return run(async () => { if (!(await showModal(`Stop ${name}?`, '<p>Players are disconnected; the world is saved first.</p>', [{ label: 'Stop server', value: true, primary: true }, { label: 'Cancel', value: false }]))) return; await ipc.invoke('instances:action', name, 'stop'); refreshInstances(); }, t);
  if (t.classList.contains('i-more')) return run(async () => {
    const opts = [{ label: 'Update server and mods', value: 'update' }, { label: 'Backup now', value: 'backup' }];
    if (!x.main) opts.push({ label: 'Move to free ports', value: 'ports' }, { label: x.toolRunning ? 'Stop its tool (server keeps running)' : 'Start its tool', value: 'tool' }, { label: 'Remove…', value: 'remove' });
    opts.push({ label: 'Cancel', value: null });
    const c = await showModal(name, `<p class="muted">${esc(x.dir)}</p><p>Ports: ${fmtPorts(x.ports)}</p>`, opts);
    if (c === 'update') { toast(`Updating ${name}…`); await ipc.invoke('instances:action', name, 'update'); toast(`${name} updated`); }
    if (c === 'backup') { await ipc.invoke('instances:action', name, 'backup'); toast('Backup taken'); }
    if (c === 'ports') { const b = await ipc.invoke('instances:reassignPorts', name); toast(`${name}: game ${b.game}, query ${b.query}, RCon ${b.rcon}, web ${b.web}`); }
    if (c === 'tool') { if (x.toolRunning) await ipc.invoke('instances:stopTool', name); else await ipc.invoke('instances:startTool', name); }
    if (c === 'remove') {
      const how = await showModal(`Remove ${name}?`, `<p>Its server must be stopped. Removing it from the list keeps the folder; deleting also removes <code>${esc(x.dir)}</code> with its server files, mods, world, logs and backups.</p>`, [{ label: 'Remove, keep the folder', value: 'keep', primary: true }, { label: 'Remove and delete the folder', value: 'delete' }, { label: 'Cancel', value: null }]);
      if (how === 'delete' && !(await showModal('Delete for good?', `<p>Delete <code>${esc(x.dir)}</code>? This cannot be undone.</p>`, [{ label: 'Delete', value: true, primary: true }, { label: 'Cancel', value: false }]))) return;
      if (how) { await ipc.invoke('instances:remove', name, { deleteFiles: how === 'delete' }); toast(`${name} removed`); }
    }
    refreshInstances();
  }, t);
});
$('btnInstRename').onclick = (e) => run(async () => { const ok = await showModal('Rename the main instance', `<label class="field">Name <input id="mInstName" class="input" value="${esc(instInfo.self)}"></label><p class="muted">Shown in the instance list, in shared bot posts and in the bot's server option.</p>`, [{ label: 'Save', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) return; await ipc.invoke('instances:rename', $('mInstName').value.trim()); await refreshInstanceSelect(); refreshInstances(); }, e.target);
$('btnInstUpdateAll').onclick = (e) => run(async () => {
  if (!(await showModal('Update every instance?', '<p>Each instance updates its DayZ server files and mods in turn. A running server is stopped (players are warned when RCon is connected) and started again.</p>', [{ label: 'Update all', value: true, primary: true }, { label: 'Cancel', value: false }]))) return;
  for (const x of instList) { $('instProgress').hidden = false; $('instProgress').innerHTML = `<span>Updating ${esc(x.name)}… <span class="spinner"></span></span>`; try { await ipc.invoke('instances:action', x.name, 'update'); } catch (err) { toast(`${x.name}: ${err.message}`, true); } }
  $('instProgress').hidden = true; toast('All instances updated'); refreshInstances();
}, e.target);
$('btnInstNew').onclick = (e) => run(async () => {
  const d = await ipc.invoke('instances:defaults');
  const body = `<label class="field">Name <input id="niName" class="input" placeholder="e.g. Livonia" maxlength="32"></label>
    <label class="field">Folder (the instance goes in a subfolder with its name) <input id="niRoot" class="input" value="${esc(d.root)}"></label>
    <label class="field">Start from <select id="niFrom" class="input">${d.names.map(n => `<option value="${esc(n)}">a copy of ${esc(n)}</option>`).join('')}<option value="">nothing: install the server from its window</option></select></label>
    <div id="niCopy"><label class="check"><input type="checkbox" id="niServer" checked> Copy the server files and mission (fast; otherwise SteamCMD downloads about 3 GB)</label>
    <label class="check"><input type="checkbox" id="niMods" checked> Copy the mods, their keys and the mod list</label>
    <label class="check"><input type="checkbox" id="niWorld"> Copy the world too (bases, vehicles, loot); off = a fresh wipe</label>
    <label class="check"><input type="checkbox" id="niSettings" checked> Copy the tool settings (restarts, backups, alerts, website…)</label></div>
    <label class="field">CPU cores <select id="niCpu" class="input"><option value="auto">Auto: its own share, so servers do not share cores</option><option value="all">Windows decides</option></select></label>
    <label class="field">Discord bot <select id="niBot" class="input"><option value="shared">Shared with the main instance</option><option value="own">Its own bot (set the token in its window)</option><option value="off">Off</option></select></label>
    <label class="check" title="Needs the main bot running"><input type="checkbox" id="niFeeds" checked> With a shared bot: give it its own kill feed, join feed and death log channels (the main bot creates them)</label>
    <label class="check"><input type="checkbox" id="niSteam" checked> Use this window's Steam login, so it can update itself (stays encrypted in its own folder)</label>
    <label class="check"><input type="checkbox" id="niAuto" checked> Start it with the main window</label>
    <p class="muted small">Ports are picked automatically: the next free block (game port +100, query +100, RCon +100, website +1). Passwords and tokens are not copied: each instance keeps its own, encrypted for its own folder.</p>`;
  const ok = await showModal('New instance', body, [{ label: 'Create', value: true, primary: true }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  const from = $('niFrom').value;
  const opts = { name: $('niName').value.trim(), root: $('niRoot').value.trim(), from: from || null, copyServer: !!from && $('niServer').checked, copyMods: !!from && $('niMods').checked, copyStorage: !!from && $('niWorld').checked, copySettings: !!from && $('niSettings').checked, cpu: $('niCpu').value, bot: $('niBot').value, autoStart: $('niAuto').checked };
  $('btnInstNew').disabled = true;
  try {
    const r = await ipc.invoke('instances:create', opts);
    toast(`${r.name} created: game port ${r.ports.game}${r.warnings && r.warnings.length ? ' — with warnings, see above' : ''}`, !!(r.warnings && r.warnings.length));
    await refreshInstanceSelect(); await refreshInstances();
    await ipc.invoke('instances:action', r.name, 'open');
    if ($('niFeeds').checked && opts.bot === 'shared') { try { const f = await ipc.invoke('discord:createFeedChannels', r.name); toast(`${r.name}: ${f.created.length ? 'created ' + f.created.map(n => '#' + n).join(', ') : 'using its existing feed channels'}`); } catch (err) { toast(`Feed channels not created: ${err.message} (use the button on its Discord Bot page later)`, true); } }
    if ($('niSteam').checked) { try { if (await ipc.invoke('instances:shareSteamLogin', r.name)) toast(`${r.name} uses the same Steam login`); } catch (err) { toast('Steam login not shared: ' + err.message, true); } }
  } finally { $('btnInstNew').disabled = false; }
}, e.target);

// ---------- CPU cores (Launch page) ----------
let cpuState = null;
async function loadCpu() { try { cpuState = await ipc.invoke('cpu:status'); renderCpu(); } catch { /* ignore */ } }
function renderCpu() {
  const st = cpuState; if (!st) return; const t = st.topology, c = st.config;
  $('cpuInfo').textContent = `${t.name || 'CPU'}: ${t.physical} cores, ${t.logical} logical processors${t.smt > 1 ? ' (hyper-threading)' : ''}${t.guessed ? ' (not read from Windows yet)' : ''}.`;
  $('cpuMode').value = c.mode; $('cpuPriority').value = c.priority || 'normal';
  const shown = c.mode === 'manual' ? (c.cores || []).map(Number) : c.mode === 'auto' ? st.autoPreview : [];
  let html = '';
  for (let core = 0; core < t.physical; core++) {
    const threads = Array.from({ length: t.smt }, (_, k) => core * t.smt + k);
    html += `<div class="cpu-core"><div class="muted small">Core ${core}${core === 0 && t.physical >= 4 ? ' · Windows' : ''}</div>${threads.map(n => `<label class="check"><input type="checkbox" class="cpu-t" data-n="${n}" ${shown.includes(n) ? 'checked' : ''} ${c.mode === 'manual' ? '' : 'disabled'}> ${n}</label>`).join('')}</div>`;
  }
  $('cpuGrid').innerHTML = html;
  $('cpuSummary').textContent = c.mode === 'all' ? 'The server may run on every core; Windows spreads the work. Best for a single server.' : c.mode === 'auto' ? `Auto: this instance gets logical processors ${st.autoPreview.join(', ')} (its share among the instances set to Auto; core 0 stays free for Windows on 4+ cores). -cpuCount=${st.cpuCount}.` : `Pinned to ${shown.length} logical processor${shown.length === 1 ? '' : 's'}; -cpuCount=${st.cpuCount}. Pick whole cores (both threads) for the best result.`;
}
const saveCpu = (extra = {}) => run(async () => { cpuState = await ipc.invoke('cpu:save', { mode: $('cpuMode').value, priority: $('cpuPriority').value, ...extra }); renderCpu(); toast('CPU settings saved; a running server is updated now'); });
$('cpuMode').onchange = () => saveCpu(cpuState && $('cpuMode').value === 'manual' && !(cpuState.config.cores || []).length ? { cores: cpuState.autoPreview } : {});
$('cpuPriority').onchange = () => saveCpu();
$('cpuGrid').addEventListener('change', () => saveCpu({ cores: [...document.querySelectorAll('.cpu-t:checked')].map(i => Number(i.dataset.n)) }));
$('btnCpuDetect').onclick = (e) => run(async () => { cpuState = await ipc.invoke('cpu:detect'); renderCpu(); }, e.target);

// ---------- bot mode of a background instance ----------
$('btnDcFeeds').onclick = (e) => run(async () => { const r = await ipc.invoke('discord:createFeedChannels'); toast(r.created.length ? `Created ${r.created.map(n => '#' + n).join(', ')}` : 'Using the existing feed channels'); renderDiscord(await ipc.invoke('discord:status')); await loadSettings(); loadDiscordForm(); }, e.target);
$('discordMode').onchange = (e) => run(async () => { renderDiscord(await ipc.invoke('discord:setMode', e.target.value)); });

refreshInstanceSelect();
// ---------- theme + shortcuts ----------
function applyTheme(t) { document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; }
$('prefTheme').onchange = () => { applyTheme($('prefTheme').value); };
document.addEventListener('keydown', e => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') { const btns = [...document.querySelectorAll('.nav-btn')]; const b = btns[Number(e.key) - 1]; if (b) { e.preventDefault(); showPage(b.dataset.page); } }
  if (e.key === 'F5') { e.preventDefault(); const p = document.querySelector('.page.active'); if (p) showPage(p.id.replace('page-', '')); }
  if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); const name = prompt('Go to page (dashboard, launch, mods, logs, players, bans, …):'); if (name && navItem(name.trim().toLowerCase())) showPage(name.trim().toLowerCase()); }
});

// ---------- logs ----------
async function refreshLogList() {
  const r = await ipc.invoke('logs:list');
  const list = $('logFileList');
  if (!r.files.length) { list.innerHTML = `<div class="empty">No logs in<br><code>${esc(r.dir)}</code></div>`; return; }
  list.innerHTML = r.files.map(f => `
    <div class="file ${f.name === currentLog ? 'active' : ''}" data-name="${esc(f.name)}">
      <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="meta">${fmtBytes(f.size)}</span>
    </div>`).join('');
  if (!currentLog && r.files.length) openLog(r.files.find(f => /\.rpt$/i.test(f.name))?.name || r.files[0].name);
}
$('logFileList').addEventListener('click', e => { const f = e.target.closest('.file'); if (f) openLog(f.dataset.name); });
$('btnRefreshLogs').onclick = refreshLogList;
$('btnOpenProfiles').onclick = () => ipc.invoke('shell:openPath', state.paths.profilesDir);
document.querySelectorAll('.tab[data-tab]').forEach(t => t.onclick = () => {
  logTab = t.dataset.tab;
  document.querySelectorAll('.tab[data-tab]').forEach(x => x.classList.toggle('active', x === t));
  $('logRaw').hidden = logTab !== 'raw';
  $('logSummary').hidden = logTab !== 'summary';
  $('logCrashes').hidden = logTab !== 'crashes';
  if (logTab === 'crashes') refreshCrashes(); else renderLog();
});
$('logFilter').addEventListener('input', () => renderLog());
let logData = null;
async function openLog(name) {
  currentLog = name;
  document.querySelectorAll('.file').forEach(f => f.classList.toggle('active', f.dataset.name === name));
  await renderLog(true);
}
async function renderLog(reload = false) {
  if (!currentLog || logTab === 'crashes') return;
  if (logTab === 'raw') {
    if (reload || !logData) {
      if (/\.mdmp$/i.test(currentLog)) { $('logRaw').textContent = 'Binary crash dump. Open the profiles folder to inspect it.'; $('logInfo').textContent = ''; return; }
      logData = await ipc.invoke('logs:read', currentLog, 512 * 1024);
    }
    const filter = $('logFilter').value.toLowerCase();
    const pre = $('logRaw');
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    const lines = logData.text.split('\n').filter(l => !filter || l.toLowerCase().includes(filter));
    pre.innerHTML = lines.map(l => {
      const cls = /SCRIPT\s+\(E\)|ERROR|Error|Can't|Cannot|failed|Failed|Access violation/.test(l) ? 'hl-err' : /SCRIPT\s+\(W\)|Warning|WARNING/.test(l) ? 'hl-warn' : '';
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    }).join('\n');
    $('logInfo').textContent = `${fmtBytes(logData.size)}${logData.truncated ? ' (showing last 512 KB)' : ''} · ${fmtDate(logData.mtime)}`;
    if (atBottom || reload) pre.scrollTop = pre.scrollHeight;
  } else {
    const s = await ipc.invoke('logs:summary', currentLog);
    const el = $('logSummary');
    el.innerHTML = `
      <div class="verdict ${s.verdict.level}">${esc(s.verdict.text)}</div>
      <div class="chips">
        <span class="chip">${s.lineCount} lines</span>
        <span class="chip">${s.totalIssues} issues</span>
        ${s.firstTime ? `<span class="chip">${esc(s.firstTime)} → ${esc(s.lastTime)}</span>` : ''}
        <span class="chip">${s.stats.playersConnected} player connects</span>
        ${s.perCategory.map(c => `<span class="chip">${esc(c.label)}: <b>${c.count}</b></span>`).join('')}
      </div>
      ${s.groups.length ? s.groups.map(g => `
        <div class="group">
          <div class="head"><span><span class="badge ${g.category === 'crash' ? 'bad' : g.category.includes('error') || g.category === 'mod' ? 'warn' : ''}">${esc(g.label)}</span> <span class="count">×${g.count}</span></span><span>${g.firstTime ? esc(g.firstTime) + (g.lastTime && g.lastTime !== g.firstTime ? ' – ' + esc(g.lastTime) : '') : ''}</span></div>
          <div class="sample">${esc(g.sample)}</div>
        </div>`).join('') : '<div class="empty">Nothing to report.</div>'}
      ${s.modLines.length ? `<div class="group"><div class="head">Mod lines from the log</div><div class="sample">${esc(s.modLines.join('\n'))}</div></div>` : ''}`;
    $('logInfo').textContent = `${fmtBytes(s.size)}${s.truncated ? ' (last 20 MB analysed)' : ''}`;
  }
}
setInterval(() => { if ($('logFollow').checked && document.querySelector('#page-logs.active') && logTab === 'raw' && currentLog) renderLog(true); }, 3000);

// ---------- init ----------
try { applyTheme(localStorage.getItem('theme') || 'dark'); } catch { /* ignore */ }
(async function init() {
  await loadSettings();
  await refreshSteam();
  renderServer(await ipc.invoke('server:status'));
  await refreshMods();
  await refreshCmdline();
  await refreshUpdater();
  await refreshSchedule();
  refreshHealth(); refreshAlertList();
  renderRcon(await ipc.invoke('rcon:status'));
  renderDiscord(await ipc.invoke('discord:status'));
  renderWeb(await ipc.invoke('website:status'));
  document.querySelectorAll('.pill-link[data-go]').forEach(p => { p.onclick = () => showPage(p.dataset.go); });
  logLine({ source: 'app', line: 'DayZ Admin Tools ready.' });
})().catch(e => toast(e.message, true));

// Report renderer errors to the main process log (tool.log in the data folder).
window.addEventListener('error', e => { try { ipc.invoke('app:rendererError', `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`).catch(() => {}); } catch { /* ignore */ } });
window.addEventListener('unhandledrejection', e => { try { ipc.invoke('app:rendererError', 'unhandled: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)).catch(() => {}); } catch { /* ignore */ } });

// ---------- statistics ----------
function drawBars(canvas, values, labels, color, opts = {}) {
  const c = canvas; const W = c.clientWidth || 600, H = c.height || 150; c.width = W; const ctx = c.getContext('2d'); ctx.clearRect(0, 0, W, H);
  const max = Math.max(1, ...values); const n = values.length; const pad = 22, bw = (W - pad) / n;
  ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(pad, 0, W - pad, H - 18);
  for (let i = 0; i < n; i++) { const h = (values[i] / max) * (H - 24); ctx.fillStyle = color; ctx.fillRect(pad + i * bw + 1, H - 18 - h, Math.max(1, bw - 2), h); }
  ctx.fillStyle = '#8a94a6'; ctx.font = '10px Segoe UI'; ctx.fillText(String(max), 0, 10);
  const step = Math.max(1, Math.ceil(n / (opts.labelsEvery || 8)));
  for (let i = 0; i < n; i += step) ctx.fillText(labels[i], pad + i * bw, H - 5);
}
async function refreshStats() {
  let o; try { o = await ipc.invoke('stats:overview'); } catch (e) { toast(e.message, true); return; }
  const card = (t) => `<div class="stat-tile"><div class="muted">${t.label}</div><div class="stat-val">${t.value}</div>${t.sub ? `<div class="muted small">${t.sub}</div>` : ''}</div>`;
  const row = (title, t) => `<div class="card"><div class="card-title">${title}</div><div class="stat-grid">${[
    { label: 'Deaths', value: t.deaths, sub: Object.entries(t.causes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + ' ' + v).join(' · ') },
    { label: 'Player kills', value: t.kills }, { label: 'Unique players', value: t.unique, sub: t.newPlayers + ' new' }, { label: 'Peak online', value: t.peak },
    { label: 'Avg FPS', value: t.avgFps ?? '—' }, { label: 'Uptime', value: t.uptimePct !== null ? t.uptimePct + '%' : '—', sub: t.restarts + ' restart(s), ' + t.crashes + ' crash(es)' }].map(card).join('')}</div></div>`;
  $('statsCards').innerHTML = row('Today', o.today) + row('Last 7 days', o.week) + row('Last 30 days', o.month);
  $('statsDeathsHour').textContent = `${o.deathsLastHour} in the last hour`;
  drawBars($('chDeathsHour'), o.hourlyDeaths, o.hourlyDeaths.map((_, i) => { const h = new Date(Date.now() - (23 - i) * 3600000).getHours(); return h + 'h'; }), '#ff6b6b', { labelsEvery: 12 });
  drawBars($('chDeathsDay'), o.days.map(d => d.deaths), o.days.map(d => d.day.slice(5)), '#ff9f3b', { labelsEvery: 10 });
  drawBars($('chPlayersDay'), o.days.map(d => d.peak), o.days.map(d => d.day.slice(5)), '#7cc47f', { labelsEvery: 10 });
  drawBars($('chUniqueDay'), o.days.map(d => d.unique), o.days.map(d => d.day.slice(5)), '#6fa8ff', { labelsEvery: 10 });
  drawBars($('chFpsDay'), o.days.map(d => d.avgFps || 0), o.days.map(d => d.day.slice(5)), '#b784ff', { labelsEvery: 10 });
  const lb = (title, rows, fmt) => `<div class="card"><div class="card-title">${title}</div><table class="table"><tbody>${rows.length ? rows.map((r, i) => `<tr><td class="muted">${i + 1}</td><td>${esc(r.name)}</td><td class="right">${fmt(r)}</td></tr>`).join('') : '<tr><td class="muted">No data yet.</td></tr>'}</tbody></table></div>`;
  $('statsBoards').innerHTML = lb('Most kills', o.leaderboards.kills, r => r.value) + lb('Most deaths', o.leaderboards.deaths, r => r.value) + lb('Best K/D (5+ fights)', o.leaderboards.kd, r => `${r.value} (${r.kills}/${r.deaths})`) + lb('Most playtime', o.leaderboards.playtime, r => fmtPlaytime(r.value)) + lb('Longest sessions', o.leaderboards.longest, r => fmtPlaytime(r.sec)) + lb('Weapons (30 days)', o.month.weapons.map(([name, n]) => ({ name, value: n })), r => r.value);
}
async function refreshCombat() {
  let c; try { c = await ipc.invoke('combat:overview'); } catch (e) { toast(e.message, true); return; }
  $('combatTotals').textContent = `${c.totals.hits.toLocaleString()} player hits · ${c.totals.damage.toLocaleString()} damage · ${c.totals.kills} player kills`;
  $('combatWeapons').querySelector('tbody').innerHTML = c.weapons.map(w => `<tr><td>${esc(w.name)}</td><td>${w.kills}</td><td>${w.hits}</td><td>${w.damage.toLocaleString()}</td><td>${w.headshots}</td><td>${w.avgDist ?? '—'}</td><td>${w.maxDist || '—'}</td><td class="muted">${esc(w.ammo)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No player-versus-player hits recorded yet.</td></tr>';
  const parts = c.parts.slice(0, 12); drawBars($('chParts'), parts.map(p => p[1]), parts.map(p => p[0]), '#ff9f3b', { labelsEvery: 12 });
  const lb = (title, rows) => `<div class="card"><div class="card-title">${title}</div><table class="table"><tbody>${rows.length ? rows.map((r, i) => `<tr><td class="muted">${i + 1}</td><td>${esc(r.name)}</td><td class="right">${esc(String(r.value))}</td></tr>`).join('') : '<tr><td class="muted">No data yet.</td></tr>'}</tbody></table></div>`;
  await refreshSuspicious();
  await refreshAnticheat();
  $('combatBoards').innerHTML = lb('Headshot rate (20+ hits)', c.headshotRate) + lb('Fewest hits per kill (3+ kills)', c.hitsPerKill) + lb('Most damage dealt', c.damageDealt) + lb('Most damage taken', c.damageTaken) + lb('Headshots', c.headshots) + lb('Longest kills', c.longestKills) + lb('Rivalries (killer → victim)', c.rivalries) + lb('Favourite weapons', c.favouriteWeapons) + lb('Base builders (actions)', c.builders);
}
async function refreshSuspicious() {
  const r = $('susRange').value; const since = r === 'all' ? 0 : Date.now() - Number(r) * 3600000;
  let list; try { list = await ipc.invoke('combat:suspicious', since); } catch { list = []; }
  $('combatSuspicious').innerHTML = list.length ? `<table class="table"><thead><tr><th>Player</th><th>Score</th><th>Flags in range</th><th>24 h / 7 d / 30 d</th><th>Last</th><th>Hits</th><th>Head %</th></tr></thead><tbody>${list.map(p => `<tr><td><b>${esc(p.name)}</b></td><td><span class="badge bad">${p.score}</span></td><td>${esc(p.flags)}</td><td class="muted">${p.windows.day} / ${p.windows.week} / ${p.windows.month}</td><td class="muted">${esc(p.last)}${p.lastAt ? ' · ' + fmtDate(p.lastAt) : ''}</td><td>${p.hits}</td><td>${p.headshotPct}%</td></tr>`).join('')}</tbody></table>` : '<div class="muted">Nothing flagged in this range. Flags: headshot rate over 55% after 25+ hits, headshots at 400 m+, 4+ hits on 2+ players within 1.5 s, 3+ kills within 10 s, kills at 900 m+, movement faster than 80 m/s, 4+ logins within 10 min (relog duping), logging out within 20 s of being hit (combat logging), BattlEye kicks. Leads, not proof.</div>';
}
$('susRange').onchange = refreshSuspicious;
$('btnStatsReset').onclick = (e) => run(async () => { if (!await showModal('Reset statistics', '<p>Delete the daily statistics? Deaths, kills, joins and health history on this page start again from now. The player database, death log and combat statistics are not affected.</p>', [{ label: 'Reset', value: true, primary: true }, { label: 'Cancel', value: false }])) return; await ipc.invoke('stats:reset'); toast('Statistics reset'); refreshStats(); }, e.target);
async function refreshAnticheat() {
  let st; try { st = await ipc.invoke('anticheat:status'); } catch { return; }
  const b = $('acState'); b.className = 'badge ' + (st.enabled && st.upToDate ? 'ok' : st.installed ? 'warn' : '');
  b.textContent = st.enabled ? (st.upToDate ? `mod on (v${st.version})` : st.installed ? `mod on, v${st.version} installed, v${st.current} available` : 'mod on, not installed yet') : st.installed ? 'mod installed, not loaded' : 'mod off · engine check via bridge';
  $('acEnabled').checked = !!st.enabled;
  $('acStats').textContent = st.lastStats ? `mod last reported ${st.lastStats.tracked.toLocaleString()} items tracked, ${st.lastStats.dupes} duplicates (${new Date(st.lastStats.ts).toLocaleTimeString()})` : 'no report from the mod yet';
  const rows = await ipc.invoke('anticheat:list', { limit: 200 });
  $('acTable').querySelector('tbody').innerHTML = rows.length ? rows.map(r => `<tr><td class="mono">${esc(fmtDate(r.ts))}</td><td>${r.source === 'mod' ? 'hidden ID' : 'engine ID'}</td><td>${esc(r.cls)}</td><td class="mono">${esc(r.uid)}</td><td>${esc(r.who[0] || '')}</td><td>${esc(r.who[1] || '')}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">No duplicates detected.</td></tr>';
}
$('acEnabled').onchange = (e) => run(async () => {
  if ($('acEnabled').checked) {
    const ok = await showModal('Enable the anti-dupe mod', '<p>The mod adds a hidden ID to what the server saves for every item. Items saved before it was enabled do not have one, so the first start with the mod needs a <b>persistence wipe</b> (Mission page → Server Wipe). The same applies when you turn it off again.</p><p class="muted">Players need nothing: it is loaded with -serverMod only.</p>', [{ label: 'Enable', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (!ok) { $('acEnabled').checked = false; return; }
  }
  await ipc.invoke('anticheat:setEnabled', $('acEnabled').checked); refreshAnticheat();
}, e.target);
$('btnAcInstall').onclick = (e) => run(async () => {
  const st = await ipc.invoke('anticheat:status');
  if (!st.enabled) { const ok = await showModal('Install the anti-dupe mod', '<p>This writes the mod into the server folder and adds <code>@DayZAdminTools</code> to the -serverMod line (see the Launch tab).</p><p>Items saved before the mod have no hidden ID, so the first start with it needs a <b>persistence wipe</b> (Mission page → Server Wipe). The same applies when you turn it off again.</p>', [{ label: 'Install and enable', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) return; }
  await ipc.invoke('anticheat:setEnabled', true); toast('Mod written to the server folder and added to -serverMod'); refreshAnticheat();
}, e.target);
$('btnAcRemove').onclick = (e) => run(async () => { if (!await showModal('Remove the anti-dupe mod', '<p>Delete the @DayZAdminTools folder from the server? Turn the mod off as well, or it is written again at the next start. Remember the wipe note.</p>', [{ label: 'Remove', value: true, primary: true }, { label: 'Cancel', value: false }])) return; await ipc.invoke('anticheat:remove'); refreshAnticheat(); }, e.target);
ipc.on('anticheat:changed', () => { if (document.querySelector('#page-stats.active')) refreshAnticheat(); });
$('btnCombatRebuild').onclick = (e) => run(async () => { const r = await ipc.invoke('combat:rebuild'); toast(`Read ${r.files} log file(s), ${r.events.toLocaleString()} events`); refreshCombat(); }, e.target);
$('btnStatsRefresh').onclick = () => run(() => Promise.all([refreshStats(), refreshCombat()]));
$('btnStatsSummary').onclick = (e) => run(async () => { await ipc.invoke('stats:postSummary'); toast('Summary posted to Discord'); }, e.target);
$('btnStatsCopy').onclick = (e) => run(async () => { const t = await ipc.invoke('stats:summaryText'); await navigator.clipboard.writeText(t.replace(/\*\*/g, '')); toast('Summary copied'); }, e.target);

// ---------- audit log ----------
async function refreshAudit() {
  const rows = await ipc.invoke('audit:list', { q: $('auditQuery').value.trim(), source: $('auditSource').value, limit: 500 });
  $('auditTable').querySelector('tbody').innerHTML = rows.map(e => `<tr><td class="muted">${fmtDate(e.ts)}</td><td><span class="badge">${esc(e.source)}</span></td><td>${esc(e.who)}</td><td>${esc(e.action)}</td><td class="muted">${esc(e.details)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing recorded yet.</td></tr>';
}
$('auditQuery').addEventListener('input', () => { clearTimeout(refreshAudit._t); refreshAudit._t = setTimeout(refreshAudit, 250); }); $('auditSource').onchange = refreshAudit;
$('btnAuditRefresh').onclick = () => run(refreshAudit);
$('btnAuditExport').onclick = (e) => run(async () => { const p = await ipc.invoke('audit:export'); toast('Exported to ' + p); }, e.target);
ipc.on('audit:new', () => { if (document.querySelector('#page-audit.active')) refreshAudit(); });
