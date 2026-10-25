'use strict';
// Tickets: the support tickets the Discord bot opens (each with its private channel) and tickets made in the app,
// in one list, each with an assignee, notes, linked death records and the admin actions done for it. A reason like
// "#0041" or "ticket 41" on any admin action tags that action onto the ticket; a refund of death #12 links the death.
// Stored with the bot's other data (discord-data.json) so the bot and the app see the same tickets.
const settings = require('./settings');

let emitRef = () => {};
const store = () => require('./discord').store();
const save = () => { require('./discord').saveStore(); emitRef('tickets:changed', {}); };
const all = () => (store().tickets = store().tickets || []);
const pad = (id) => String(id).replace(/^#/, '').trim().padStart(4, '0');
const nowIso = () => new Date().toISOString();
function byId(id) { const t = all().find(x => x.id === pad(id)); if (!t) throw new Error(`No ticket #${pad(id)}.`); return t; }
const adminName = () => { try { return require('./adminlog').cfg().adminName; } catch { return 'admin'; } };
const who = (by) => !by || by === 'app' || by === 'map' ? adminName() : by;

function deathBrief(id) {
  try { const d = require('./deathlog').get(id); return d ? { id: d.id, name: d.name, ts: d.ts, cause: d.causeText, killer: d.killer ? d.killer.name : null, refunded: (d.refunds || []).some(f => f.status === 'done' && f.ok > 0) } : { id: Number(id), missing: true }; } catch { return { id: Number(id), missing: true }; }
}
function brief(t) {
  const last = [...(t.notes || []), ...(t.actions || [])].map(x => x.ts).sort().pop() || t.createdAt;
  return { id: t.id, subject: t.subject || '', status: t.status, source: t.channelId ? 'discord' : 'app', discordId: t.discordId || null, channelId: t.channelId || null, player: t.player || null, assignee: t.assignee || null, createdAt: t.createdAt, closedAt: t.closedAt || null, deaths: (t.deaths || []).slice(), notes: (t.notes || []).length, actions: (t.actions || []).length, lastActivity: last };
}
function list({ status = '', q = '' } = {}) {
  const needle = String(q || '').toLowerCase();
  return all().filter(t => !status || t.status === status)
    .filter(t => !needle || [t.id, t.subject, t.description, t.player, t.assignee, t.discordId, ...(t.deaths || []).map(d => '#' + d)].some(v => v && String(v).toLowerCase().includes(needle)))
    .map(brief).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.lastActivity.localeCompare(a.lastActivity));
}
function get(id) {
  const t = byId(id); const c = (settings.load().discord || {});
  return { ...t, deaths: (t.deaths || []).map(deathBrief), notes: t.notes || [], actions: (t.actions || []).slice().reverse(), channelUrl: t.channelId && c.guildId ? `https://discord.com/channels/${c.guildId}/${t.channelId}` : null };
}
function create({ subject, description = '', player = '', deathId = null, by = 'app' }) {
  subject = String(subject || '').trim(); if (!subject) throw new Error('Give the ticket a subject.');
  const s = store(); s.ticketSeq = (s.ticketSeq || 0) + 1;
  const t = { id: String(s.ticketSeq).padStart(4, '0'), subject: subject.slice(0, 120), description: String(description || '').slice(0, 2000), player: String(player || '').slice(0, 80), status: 'open', createdAt: nowIso(), createdBy: who(by), assignee: null, deaths: [], notes: [], actions: [] };
  all().push(t);
  if (deathId) { const d = deathBrief(deathId); if (!d.missing) { t.deaths.push(d.id); if (!t.player) t.player = d.name; } }
  save(); emitRef('console', { source: 'tickets', line: `Ticket #${t.id} opened: ${t.subject}` });
  return get(t.id);
}
function note(id, text, by = 'app') { const t = byId(id); text = String(text || '').trim(); if (!text) throw new Error('Write a note.'); (t.notes = t.notes || []).push({ ts: nowIso(), by: who(by), text: text.slice(0, 2000) }); save(); return get(id); }
function assign(id, assignee, by = 'app') { const t = byId(id); t.assignee = String(assignee || '').trim().slice(0, 80) || null; (t.notes = t.notes || []).push({ ts: nowIso(), by: who(by), text: t.assignee ? `Assigned to ${t.assignee}` : 'Unassigned', system: true }); save(); return get(id); }
function link(id, deathId, by = 'app') {
  const t = byId(id); const d = deathBrief(deathId); if (d.missing) throw new Error(`No death record #${deathId}.`);
  t.deaths = t.deaths || []; if (!t.deaths.includes(d.id)) { t.deaths.push(d.id); (t.notes = t.notes || []).push({ ts: nowIso(), by: who(by), text: `Linked death #${d.id} (${d.name}: ${d.cause})`, system: true }); if (!t.player) t.player = d.name; save(); }
  return get(id);
}
function unlink(id, deathId, by = 'app') { const t = byId(id); t.deaths = (t.deaths || []).filter(x => x !== Number(deathId)); (t.notes = t.notes || []).push({ ts: nowIso(), by: who(by), text: `Unlinked death #${deathId}`, system: true }); save(); return get(id); }
async function setStatus(id, status, by = 'app', reason = '') {
  const t = byId(id);
  if (status === 'closed') {
    // a ticket with a Discord channel is closed through the bot (transcript, channel removed) when the bot is up
    let viaBot = false;
    if (t.channelId) { try { const d = require('./discord'); if (d.status().running) { await d.closeTicket(t.id, { by: by === 'app' || by === 'map' ? null : by, reason }); viaBot = true; } } catch (e) { emitRef('console', { source: 'tickets', line: `Ticket #${t.id}: the Discord channel was not closed (${e.message}); closed in the app only.` }); } }
    if (!viaBot) { t.status = 'closed'; t.closedAt = nowIso(); t.closedBy = who(by); t.closeReason = reason || ''; }
    (t.notes = t.notes || []).push({ ts: nowIso(), by: who(by), text: `Closed${reason ? ': ' + reason : ''}`, system: true });
  } else { t.status = 'open'; t.closedAt = null; (t.notes = t.notes || []).push({ ts: nowIso(), by: who(by), text: 'Reopened', system: true }); }
  save(); return get(id);
}
// tickets a death record is linked to
function forDeath(deathId) { const n = Number(deathId); return all().filter(t => (t.deaths || []).includes(n)).map(t => ({ id: t.id, subject: t.subject, status: t.status })); }
// "#41", "ticket 41", "ticket #0041", "T41" in a reason → the ticket id when it exists
function refFromText(text) {
  const m = String(text || '').match(/(?:^|[\s(,;:])(?:ticket\s*#?\s*|#|t)(\d{1,6})(?![\d\w])/i);
  if (!m) return null; const id = pad(m[1]); return all().some(t => t.id === id) ? id : null;
}
// called by adminlog for every admin action whose reason names a ticket
function tagAction(id, { action, by, target, details, reason, result }) {
  const t = byId(id);
  (t.actions = t.actions || []).push({ ts: nowIso(), action, by: who(by), target: target ? target.name : null, steam: target ? target.steam : null, details: String(details || '').slice(0, 500), reason: String(reason || '').slice(0, 500), result: result ? `${result.status}${result.ok !== undefined && (result.ok || result.fail) ? ` (${result.ok} ok${result.fail ? `, ${result.fail} failed` : ''})` : ''}` : '' });
  if (t.actions.length > 300) t.actions.splice(0, t.actions.length - 300);
  const dm = String(details || '').match(/death #(\d+)/i); if (dm) { const d = deathBrief(dm[1]); if (!d.missing && !(t.deaths || []).includes(d.id)) { (t.deaths = t.deaths || []).push(d.id); if (!t.player) t.player = d.name; } }
  if (target && !t.player) t.player = target.name;
  save();
  return t.id;
}
function stats() { const a = all(); return { open: a.filter(t => t.status === 'open').length, closed: a.filter(t => t.status !== 'open').length, unassigned: a.filter(t => t.status === 'open' && !t.assignee).length }; }

function init(emit) { emitRef = emit; }

module.exports = { init, list, get, create, note, assign, link, unlink, setStatus, forDeath, refFromText, tagAction, stats, pad };
