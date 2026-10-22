'use strict';
// One place every module reports notable events to. Each alert kind can go to a Windows toast,
// the Discord bot (alert channel or log channel), and/or a Discord webhook.
const { Notification } = require('electron');
const settings = require('./settings');

let emitRef = () => {};
const recentList = [];
const lastFired = {}; // kind -> timestamp, for de-duplication

const KINDS = {
  'server-critical': { label: 'Server critical error (from the server log)', color: 0xff5f5f, cooldownSec: 0 },
  'server-major': { label: 'Server error (from the server log)', color: 0xf5b942, cooldownSec: 0 },
  'server-minor': { label: 'Server warning (from the server log)', color: 0x8a94a6, cooldownSec: 0 },
  'crash': { label: 'Server crashed or exited unexpectedly', color: 0xff5f5f, cooldownSec: 60 },
  'crash-loop': { label: 'Crash loop detected, auto-restart paused', color: 0xff5f5f, cooldownSec: 600 },
  'restart': { label: 'Scheduled restart', color: 0x4f8cff, cooldownSec: 60 },
  'server-up': { label: 'Server started', color: 0x3ddc84, cooldownSec: 30 },
  'backup-failed': { label: 'Backup failed', color: 0xf5b942, cooldownSec: 300 },
  'update-available': { label: 'Mod updates available', color: 0x4f8cff, cooldownSec: 3600 },
  'update-done': { label: 'Update run finished', color: 0x3ddc84, cooldownSec: 60 },
  'update-failed': { label: 'Update failed', color: 0xf5b942, cooldownSec: 300 },
  'low-fps': { label: 'Low server FPS', color: 0xf5b942, cooldownSec: 900 },
  'high-ram': { label: 'High memory use', color: 0xf5b942, cooldownSec: 900 },
  'rcon-lost': { label: 'RCon connection lost', color: 0xf5b942, cooldownSec: 300 },
  'bot-offline': { label: 'Discord bot went offline', color: 0xf5b942, cooldownSec: 300 },
  'web-stack': { label: 'Vulnerable PHP / web server running on this machine', color: 0xff5f5f, cooldownSec: 3600 },
  'steam-guard': { label: 'Steam Guard code needed', color: 0xf5b942, cooldownSec: 600 },
  'suspicious-activity': { label: 'Suspicious combat activity (possible cheating)', color: 0xff5f5f, cooldownSec: 300 },
  'duplicate-item': { label: 'Duplicate item detected (possible duping)', color: 0xff5f5f, cooldownSec: 0 },
  'suspicious-player': { label: 'Flagged player joined (possible alt or banned account)', color: 0xf5b942, cooldownSec: 60 },
  'steam-ban': { label: 'Player picked up a Steam ban', color: 0xff5f5f, cooldownSec: 0 },
  'test': { label: 'Test alert', color: 0x4f8cff, cooldownSec: 0 }
};

function cfg() {
  const s = settings.load();
  const base = { toast: {}, discord: {}, webhook: {}, webhookUrl: '', alertChannelId: '', thresholds: { fpsBelow: 15, fpsForSec: 120, ramAboveMB: 12000, crashLoopCount: 3, crashLoopMinutes: 10 } };
  const c = { ...base, ...(s.alerts || {}), thresholds: { ...base.thresholds, ...((s.alerts || {}).thresholds || {}) } };
  // Sensible defaults: everything important goes to toast + Discord; noisy kinds off by default.
  for (const k of Object.keys(KINDS)) {
    const def = !['server-up', 'update-done', 'test', 'server-minor', 'server-major'].includes(k);
    if (c.toast[k] === undefined) c.toast[k] = def;
    if (c.discord[k] === undefined) c.discord[k] = def || k === 'server-major';
    if (c.webhook[k] === undefined) c.webhook[k] = def;
  }
  return c;
}

function recent(n = 50) { return recentList.slice(-n).reverse(); }

async function alert(kind, title, details = '', { force = false } = {}) {
  const meta = KINDS[kind] || { label: kind, color: 0x4f8cff, cooldownSec: 60 };
  const now = Date.now();
  if (!force && meta.cooldownSec && lastFired[kind] && now - lastFired[kind] < meta.cooldownSec * 1000) return false;
  lastFired[kind] = now;
  const entry = { at: now, kind, title, details: String(details || '').slice(0, 1500) };
  recentList.push(entry); if (recentList.length > 200) recentList.shift();
  emitRef('alerts:new', entry);
  if (!kind.startsWith('server-')) emitRef('console', { source: 'alert', line: `${title}${details ? ' — ' + String(details).split('\n')[0] : ''}` });
  const c = cfg();
  const jobs = [];
  if (c.toast[kind]) {
    try { if (Notification.isSupported()) new Notification({ title: `DayZ Admin Tools: ${title}`, body: String(details || meta.label).slice(0, 200) }).show(); } catch { /* ignore */ }
  }
  if (c.discord[kind]) {
    jobs.push((async () => { try { const discord = require('./discord'); await discord.postAlert({ title, description: details || meta.label, color: meta.color, channelId: c.alertChannelId }); } catch { /* bot offline */ } })());
  }
  if (c.webhook[kind] && c.webhookUrl) {
    jobs.push(fetch(c.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'DayZ Admin Tools', embeds: [{ title, description: String(details || meta.label).slice(0, 2000), color: meta.color, timestamp: new Date(now).toISOString() }] }) }).catch(() => {}));
  }
  await Promise.all(jobs);
  return true;
}

function init(emit) { emitRef = emit; }

module.exports = { init, alert, recent, cfg, KINDS };
