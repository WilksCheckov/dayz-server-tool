'use strict';
// Unified player profile (plan Phase F): everything the app knows about one player in one place, for the Player
// database page. players.get already has sessions, combat, account and watchlist; this adds the history the other
// modules keep: deaths and kills (death log), tickets, refunds, admin actions on the player (audit) and dupe alerts.
// A player is matched by DayZ id (GUID), Steam64, Discord id and names, since each source knows a different one.

const MAX = 50;

function who(r) {
  const names = new Set((r.names || []).map(n => String(n).toLowerCase()));
  if (r.name) names.add(String(r.name).toLowerCase());
  return { id: r.id || null, steam: r.steamId || null, discord: r.discordId || null, key: r.key, names };
}
const nameIs = (w, n) => !!n && w.names.has(String(n).toLowerCase());

function deaths(w) {
  const dl = require('./deathlog');
  const mine = [], kills = [];
  for (const d of dl.list({ limit: 100000 })) {
    if (d.key === w.key || (w.id && d.key === w.id) || (!d.key && nameIs(w, d.name))) mine.push(d);
    else if (d.killer && ((w.id && d.killer.id === w.id) || nameIs(w, d.killer.name))) kills.push(d);
  }
  return { deaths: mine, kills };
}

function tickets(w) {
  const T = require('./tickets');
  return T.all().filter(t => (t.game && ((w.steam && t.game.steam === w.steam) || (w.id && t.game.guid === w.id))) ||
      (w.discord && t.discordId === w.discord) || nameIs(w, t.player))
    .map(t => ({ id: t.id, subject: (t.game && t.game.title) || t.subject || '', status: t.status, source: t.game ? 'game' : t.channelId ? 'discord' : 'app', createdAt: t.createdAt, closedAt: t.closedAt || null, deaths: (t.deaths || []).length }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Admin actions name their target as "<name> (<steam64>)" in the audit details (adminlog.record); moderation from the
// game names just the player ("whitelist add", details = name). A name inside longer details must be followed by
// " (" so "Tom" does not match "Tommy"; details that are exactly the name match as they are.
function actions(w) {
  const needles = [];
  if (w.steam) needles.push(w.steam);
  if (w.id) needles.push(w.id.toLowerCase());
  for (const n of w.names) if (n.length >= 3) needles.push(n + ' (');
  if (!needles.length && !w.names.size) return [];
  return require('./audit').list({ limit: 20000 })
    .filter(e => !String(e.action).startsWith('portal'))
    .filter(e => { const d = String(e.details || '').toLowerCase(); return w.names.has(d.trim()) || needles.some(n => d.includes(n)); })
    .map(e => ({ ts: e.ts, who: e.who, action: String(e.action).replace(/^admin:/, ''), source: e.source, details: e.details }));
}

function dupes(w) {
  let list = []; try { list = require('./anticheat').list({ limit: 5000 }); } catch { return []; }
  return list.filter(r => r.holders.some(h => h.kind === 'player' && ((w.id && h.id === w.id) || nameIs(w, h.name))))
    .map(r => ({ id: r.id, ts: r.ts, cls: r.cls, source: r.source, who: r.who }));
}

function history(key) {
  const r = require('./players').get(key);
  if (!r) throw new Error('Unknown player');
  const w = who(r);
  const d = deaths(w);
  const refunds = d.deaths.filter(x => x.refunds > 0).map(x => ({ deathId: x.id, ts: x.ts, refunds: x.refunds }));
  const tk = tickets(w); const ac = actions(w); const du = dupes(w);
  return {
    key: r.key,
    counts: { deaths: d.deaths.length, kills: d.kills.length, tickets: tk.length, openTickets: tk.filter(t => t.status === 'open').length, refunds: refunds.length, actions: ac.length, dupes: du.length },
    deaths: d.deaths.slice(0, MAX), kills: d.kills.slice(0, MAX), tickets: tk.slice(0, MAX), refunds: refunds.slice(0, MAX),
    actions: ac.slice(0, MAX), dupes: du.slice(0, MAX), names: r.names || [],
  };
}

module.exports = { history, who };
