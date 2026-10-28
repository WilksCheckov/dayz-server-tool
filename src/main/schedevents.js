'use strict';
// Scheduled in-game events: DRP_Admin's editor sets switched on or off at set times (days of the week + HH:MM, the
// app's local time), with an announcement to every player a few minutes before and when it happens, plus one-off
// announcements and switches. Commands go to the game as lines in DayZAdminTools/editor_cmd.jsonl, which the mod
// reads every 10 s; the mod lists its sets in DayZAdminTools/editor_sets.json for the schedule's set picker.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

let emitRef = () => {}, timer = null, seq = 0;
const dir = () => path.join(settings.paths().profilesDir, 'DayZAdminTools');
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function cfg() { return { entries: [], ...(settings.load().eventSchedule || {}) }; }
function clean(e, i) {
  const time = String(e.time || '').trim();
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`Row ${i + 1}: give the time as HH:MM.`);
  const set = String(e.set || '').trim(); if (!set) throw new Error(`Row ${i + 1}: pick a set.`);
  const days = [...new Set((e.days || []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
  return { id: e.id || `ev${Date.now().toString(36)}${i}`, set, on: e.on !== false, time, days, warnMin: Math.max(0, Math.min(120, Number(e.warnMin) || 0)), message: String(e.message || '').trim().slice(0, 200), enabled: e.enabled !== false, lastRun: e.lastRun || '', lastWarn: e.lastWarn || '' };
}
function save(entries) {
  const list = (entries || []).map(clean);
  // keep what already ran today so saving does not run it again
  const old = new Map(cfg().entries.map(e => [e.id, e]));
  for (const e of list) { const o = old.get(e.id); if (o) { e.lastRun = o.lastRun || ''; e.lastWarn = o.lastWarn || ''; } }
  settings.save({ eventSchedule: { entries: list } });
  return state();
}

// the sets the game has (the mod writes them), for the picker
function sets() {
  try { return JSON.parse(fs.readFileSync(path.join(dir(), 'editor_sets.json'), 'utf8')).sets || []; } catch { return []; }
}

function command(cmd) {
  fs.mkdirSync(dir(), { recursive: true });
  seq++;
  fs.appendFileSync(path.join(dir(), 'editor_cmd.jsonl'), JSON.stringify({ t: new Date().toISOString(), seq: `${Date.now()}-${seq}`, ...cmd }) + '\n');
}
function announce(text, by = 'app') {
  const t = String(text || '').trim().slice(0, 200); if (!t) throw new Error('Type the announcement.');
  command({ announce: t }); audit(by, 'announcement', t); return true;
}
function switchSet(set, on, by = 'app', message = '') {
  if (!String(set || '').trim()) throw new Error('Pick a set.');
  command({ setName: String(set).trim(), on: !!on, announce: String(message || '').trim().slice(0, 200) });
  audit(by, `event set ${on ? 'on' : 'off'}`, set); return true;
}

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const at = (d, hhmm) => { const [h, m] = hhmm.split(':').map(Number); const x = new Date(d); x.setHours(h, m, 0, 0); return x; };

// what is due now: the warning (warnMin before) and the switch itself, each once per day, never late by more
// than 5 minutes (a tool that was off does not replay the day's events)
function tick(now = new Date()) {
  const c = cfg(); let changed = false; const done = [];
  for (const e of c.entries) {
    if (!e.enabled || (e.days.length && !e.days.includes(now.getDay()))) continue;
    const when = at(now, e.time); const key = dayKey(now);
    if (e.warnMin > 0 && e.lastWarn !== key) {
      const warnAt = new Date(when.getTime() - e.warnMin * 60000);
      if (now >= warnAt && now < when) {
        command({ announce: e.message ? `${e.message} (in ${e.warnMin} min)` : `${e.set} ${e.on ? 'starts' : 'ends'} in ${e.warnMin} min` });
        e.lastWarn = key; changed = true; done.push({ id: e.id, what: 'warn' });
      }
    }
    if (e.lastRun !== key && now >= when && now - when < 5 * 60000) {
      command({ setName: e.set, on: e.on, announce: e.message || '' });
      e.lastRun = key; changed = true; done.push({ id: e.id, what: 'run' });
      audit('schedule', `event set ${e.on ? 'on' : 'off'}`, e.set);
      emitRef('console', { source: 'events', line: `Scheduled event: ${e.set} switched ${e.on ? 'on' : 'off'}` });
    }
  }
  if (changed) settings.save({ eventSchedule: { entries: c.entries } });
  return done;
}

function nextRun(e, now = new Date()) {
  if (!e.enabled) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    if (e.days.length && !e.days.includes(d.getDay())) continue;
    const w = at(d, e.time); if (w > now) return w.getTime();
  }
  return null;
}
function state() {
  return { entries: cfg().entries.map(e => ({ ...e, next: nextRun(e), dayNames: e.days.length ? e.days.map(d => DAY[d]).join(' ') : 'every day' })), sets: sets() };
}
function audit(by, action, details) { try { require('./audit').log('app', by, action, details); } catch { /* ignore */ } }

function init(emit) { emitRef = emit; clearInterval(timer); timer = setInterval(() => { try { tick(); } catch (e) { emitRef('console', { source: 'events', line: 'Event schedule: ' + e.message }); } }, 30000); }
module.exports = { init, save, state, tick, announce, switchSet, sets, nextRun };
