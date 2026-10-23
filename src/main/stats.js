'use strict';
// Server statistics: a daily rollup (userData/stats.json) fed by player events, health samples, restarts and crashes,
// plus queries that combine it with the player database and the heat store for the Statistics page and the
// optional daily Discord summary.
const fs = require('fs');
const jsonstore = require('./jsonstore');
const path = require('path');
const { app } = require('electron');
const settings = require('./settings');

let db = null, timer = null, wasRunning = null;
const file = () => path.join(app.getPath('userData'), 'stats.json');
function load() { if (!db) { db = jsonstore.readOr(file(), { days: {}, lastSummary: null }); db.days = db.days || {}; } return db; }
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { jsonstore.write(file(), load()); }, 3000); }
const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
function day(ts) { const d = load(); const k = dayKey(ts); if (!d.days[k]) d.days[k] = { players: [], newPlayers: 0, connects: 0, deaths: 0, kills: 0, causes: {}, peak: 0, fpsSum: 0, fpsN: 0, playersSum: 0, playersN: 0, restarts: 0, crashes: 0, uptimeSec: 0, runSec: 0, weapons: {}, hourlyDeaths: new Array(24).fill(0) }; return d.days[k]; }

// ---------- feeds ----------
function recordEvent(ev, isNewPlayer) {
  if (!ev || !ev.ts) return;
  const d = day(ev.ts); const key = ev.id || ev.name;
  if (ev.type === 'connect') { d.connects++; if (key && !d.players.includes(key)) d.players.push(key); if (isNewPlayer) d.newPlayers++; }
  if (ev.type === 'kill' || ev.type === 'death') {
    d.deaths++; d.hourlyDeaths[new Date(ev.ts).getHours()]++;
    const cause = require('./heat').causeOf(ev.body); d.causes[cause] = (d.causes[cause] || 0) + 1;
    if (ev.type === 'kill') { d.kills++; if (ev.weapon) d.weapons[ev.weapon] = (d.weapons[ev.weapon] || 0) + 1; }
  }
  save();
}
function recordSample(s) {
  if (!s) return; const d = day();
  if (typeof s.fps === 'number') { d.fpsSum += s.fps; d.fpsN++; }
  if (typeof s.players === 'number') { d.playersSum += s.players; d.playersN++; if (s.players > d.peak) d.peak = s.players; }
  save();
}
let lastTick = Date.now();
function tick() {
  const now = Date.now(); const d = day(); const running = (() => { try { return require('./server').status().running; } catch { return false; } })();
  d.runSec += Math.round((now - lastTick) / 1000); if (running) d.uptimeSec += Math.round((now - lastTick) / 1000); lastTick = now;
  if (wasRunning === false && running) d.restarts++;
  wasRunning = running;
  save();
  maybePostSummary().catch(() => {});
}
function recordCrash() { day().crashes++; save(); }

// ---------- queries ----------
function range(days) { const d = load(); const out = []; for (let i = days - 1; i >= 0; i--) { const k = dayKey(Date.now() - i * 86400000); out.push({ day: k, ...(d.days[k] || { players: [], newPlayers: 0, connects: 0, deaths: 0, kills: 0, causes: {}, peak: 0, fpsSum: 0, fpsN: 0, playersSum: 0, playersN: 0, restarts: 0, crashes: 0, uptimeSec: 0, runSec: 0, weapons: {}, hourlyDeaths: new Array(24).fill(0) }) }); } return out; }
function totals(days) {
  const rows = range(days); const t = { deaths: 0, kills: 0, unique: new Set(), newPlayers: 0, peak: 0, fpsSum: 0, fpsN: 0, restarts: 0, crashes: 0, uptimeSec: 0, runSec: 0, causes: {}, weapons: {} };
  for (const r of rows) { t.deaths += r.deaths; t.kills += r.kills; r.players.forEach(p => t.unique.add(p)); t.newPlayers += r.newPlayers; t.peak = Math.max(t.peak, r.peak); t.fpsSum += r.fpsSum; t.fpsN += r.fpsN; t.restarts += r.restarts; t.crashes += r.crashes; t.uptimeSec += r.uptimeSec; t.runSec += r.runSec; for (const [k, v] of Object.entries(r.causes)) t.causes[k] = (t.causes[k] || 0) + v; for (const [k, v] of Object.entries(r.weapons)) t.weapons[k] = (t.weapons[k] || 0) + v; }
  return { deaths: t.deaths, kills: t.kills, unique: t.unique.size, newPlayers: t.newPlayers, peak: t.peak, avgFps: t.fpsN ? Math.round(t.fpsSum / t.fpsN) : null, restarts: t.restarts, crashes: t.crashes, uptimePct: t.runSec ? Math.round(100 * t.uptimeSec / t.runSec) : null, causes: t.causes, weapons: Object.entries(t.weapons).sort((a, b) => b[1] - a[1]).slice(0, 10) };
}
function overview() {
  const heat = require('./heat'); const players = require('./players');
  const now = Date.now();
  const last24 = heat.deathsSince(now - 86400000);
  const hourly = new Array(24).fill(0); for (const d of last24) hourly[23 - Math.min(23, Math.floor((now - d.ts) / 3600000))]++;
  const all = players.all({ limit: 5000 });
  const lb = (key, n = 10) => all.filter(p => p[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, n).map(p => ({ name: p.name, value: p[key], kills: p.kills, deaths: p.deaths, playtimeSec: p.playtimeSec }));
  const longest = all.flatMap(p => (p.sessions || []).map(s => ({ name: p.name, sec: Math.round((s.end - s.start) / 1000) }))).sort((a, b) => b.sec - a.sec).slice(0, 5);
  return {
    today: totals(1), week: totals(7), month: totals(30),
    days: range(30).map(r => ({ day: r.day, deaths: r.deaths, kills: r.kills, unique: r.players.length, newPlayers: r.newPlayers, peak: r.peak, avgPlayers: r.playersN ? +(r.playersSum / r.playersN).toFixed(1) : null, avgFps: r.fpsN ? Math.round(r.fpsSum / r.fpsN) : null, restarts: r.restarts, crashes: r.crashes })),
    hourlyDeaths: hourly, deathsLastHour: last24.filter(d => d.ts >= now - 3600000).length,
    leaderboards: { kills: lb('kills'), deaths: lb('deaths'), playtime: lb('playtimeSec'), kd: all.filter(p => p.kills + p.deaths >= 5).map(p => ({ name: p.name, value: +(p.kills / Math.max(1, p.deaths)).toFixed(2), kills: p.kills, deaths: p.deaths })).sort((a, b) => b.value - a.value).slice(0, 10), longest },
    totalPlayers: all.length
  };
}

// ---------- daily Discord summary ----------
function summaryText() {
  const t = totals(1), w = totals(7);
  const causes = Object.entries(t.causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const ov = overview(); const topK = ov.leaderboards.kills.slice(0, 3).map(x => `${x.name} (${x.value})`).join(', ') || '-';
  return [`**Last 24 hours**: ${t.unique} unique player(s), peak ${t.peak} online, ${t.newPlayers} new. ${t.deaths} death(s) (${causes}), ${t.kills} player kill(s).`,
    `Server: ${t.avgFps !== null ? 'avg ' + t.avgFps + ' FPS, ' : ''}${t.uptimePct !== null ? t.uptimePct + '% uptime, ' : ''}${t.restarts} restart(s), ${t.crashes} crash(es).`,
    `**7 days**: ${w.unique} unique, ${w.deaths} deaths, ${w.kills} kills. Top killers: ${topK}.`].join('\n');
}
async function maybePostSummary() {
  const dc = (settings.load().discord || {}); if (!dc.summaryChannelId) return;
  const at = (dc.summaryTime || '09:00'); const now = new Date(); const hhmm = now.toTimeString().slice(0, 5);
  if (hhmm !== at) return;
  const d = load(); if (d.lastSummary === dayKey()) return;
  // marked as sent only once Discord took it, so a bot that was offline at that minute is reported, not skipped quietly
  try { await require('./discord').postAlert({ title: 'Daily server summary', description: summaryText(), color: 0x4f8cff, channelId: dc.summaryChannelId }); d.lastSummary = dayKey(); save(); }
  catch (e) { d.lastSummary = dayKey(); save(); emitRef('console', { source: 'stats', line: `Daily summary not posted: ${e.message}. Use Post summary now on the Statistics page.` }); }
}
async function postSummaryNow() { const dc = (settings.load().discord || {}); if (!dc.summaryChannelId) throw new Error('Set a summary channel on the Discord Bot page first.'); await require('./discord').postAlert({ title: 'Daily server summary', description: summaryText(), color: 0x4f8cff, channelId: dc.summaryChannelId }); return true; }

function clear() { db = { days: {}, lastSummary: null }; jsonstore.write(file(), db); }
function init() { load(); clearInterval(timer); timer = setInterval(tick, 60000); }
module.exports = { init, recordEvent, recordSample, recordCrash, overview, totals, summaryText, postSummaryNow, clear };
