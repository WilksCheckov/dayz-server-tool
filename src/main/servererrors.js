'use strict';
// Classifies lines from the DayZ server (process output and the RPT) into critical / major / minor
// and raises them as alerts, so they show in Recent alerts and go to the configured channels.
// Each distinct message is raised once per window, so a line repeating every frame does not flood the list.
const alerts = require('./alerts');

const RULES = [
  // critical: the server will not run or is about to die
  { level: 'critical', re: /crash|fatal|access violation|unhandled exception|out of memory|stack overflow|cannot bind|address already in use|port .* in use|battleye.*(fail|not (?:found|installed))|be(?:server)?.*init.*fail|bad version|wrong version|mission (?:not found|failed to load)|cannot (?:open|load) mission|verifysignatures|signature (?:check )?fail|no space left|disk full|steam.*(?:not running|init.*fail)/i, title: 'Server critical error' },
  // major: something is broken that players will notice (missing files, mod and script failures)
  { level: 'major', re: /script error|script\(e\)|\bSCRIPT\s+\(E\)|cannot open file|cannot load|failed to (?:load|open|read|parse|start)|file .* not found|missing (?:addon|pbo|file|key|mod)|addon .* (?:requires|not found)|no such file|invalid (?:config|xml|json|mission|argument)|xml.*(?:error|invalid)|json.*(?:error|invalid)|\[CE\].*(?:error|fail)|error (?:loading|reading|parsing)|exception/i, title: 'Server error' },
  // minor: warnings and bad data that the server works around
  { level: 'minor', re: /warning|no entry|unsupported (?:type|value)|duplicate|deprecated|unknown (?:class|type|key)|not defined|cannot find (?:class|type|variable)|invalid (?:type|value|count|quantity)|out of (?:range|bounds)|skipping/i, title: 'Server warning' }
];
const IGNORE = /0 error|no error|error summary|errors?: 0\b|average server fps|logging|player .* connected|disconnected|\[BE\]|battleye server: (?:updating|downloading|update attempt|registered)/i;

function classify(line) {
  if (!line || IGNORE.test(line)) return null;
  for (const r of RULES) if (r.re.test(line)) return { level: r.level, title: r.title };
  return null;
}

// de-dup: normalise timestamps and numbers so "12:00:05 Cannot open X" and "12:00:09 Cannot open X" count as one
const seen = new Map(); let minuteBucket = { at: 0, n: 0 };
const WINDOW = { critical: 5 * 60000, major: 15 * 60000, minor: 60 * 60000 };
const MAX_PER_MINUTE = 12;
function key(line) { return line.replace(/^\s*\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*/, '').replace(/\d+/g, '#').trim().slice(0, 160); }

function handleLine(source, line) {
  if (source !== 'server' && source !== 'rpt') return null;
  const c = classify(line); if (!c) return null;
  const k = c.level + '|' + key(line); const now = Date.now();
  const last = seen.get(k) || 0;
  if (now - last < WINDOW[c.level]) return null;
  if (now - minuteBucket.at > 60000) minuteBucket = { at: now, n: 0 };
  if (++minuteBucket.n > MAX_PER_MINUTE && c.level !== 'critical') return null;
  seen.set(k, now); if (seen.size > 2000) seen.delete(seen.keys().next().value);
  alerts.alert('server-' + c.level, c.title, line.slice(0, 400), { force: true });
  return c;
}
function reset() { seen.clear(); }

module.exports = { classify, handleLine, reset, RULES };
