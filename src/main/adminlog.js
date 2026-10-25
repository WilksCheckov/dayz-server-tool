'use strict';
// Accountability for admin actions on players and the world (refunds, spawns, kits, vehicles, heals, teleports, god
// mode, kills, messages, kicks, bans), whether done from the map, the Death log page or a Discord command: one record
// each in the audit log and the console, and an embed in the admin action channel on Discord saying who did what to
// whom, why, and what came of it. Refunds, spawns, kills and bans can be made to need a reason or ticket number.
const os = require('os');
const settings = require('./settings');

let emitRef = () => {};
function cfg() {
  let user = 'admin'; try { user = os.userInfo().username; } catch { /* ignore */ }
  return { requireReason: true, adminName: user, ...(settings.load().adminLog || {}) };
}
// every admin action needs a reason except a refund (its death record and ticket explain it) and a message (the text is the reason)
const { LABEL, COLOR, NEEDS_REASON } = require('./admin-actions');

// Throws when this action needs a reason and none was given (checked before anything happens in game).
function check(action, reason) {
  if (cfg().requireReason && NEEDS_REASON.includes(action) && !String(reason || '').trim()) throw new Error('Give a reason for this: every admin action except a refund needs one (Discord Bot page → Admin action log).');
}
const resultText = (r) => !r ? '' : r.status === 'done' ? (r.ok !== undefined && (r.ok || r.fail) ? `${r.ok} ok${r.fail ? `, ${r.fail} failed` : ''}` : 'done') + (r.body === 'body' ? ', body removed' : r.body === 'nobody' ? ', no body found' : '') : r.status === 'pending' ? 'picked up by the game, result pending' : r.withdrawn ? 'not picked up by the game: nothing done' : (r.status || '');

// { action, by ('app'/'map' = the admin at this PC, else a Discord user), source ('app' | 'discord'), target {name, steam}, details, reason, result }
function record({ action, by = 'app', source = 'app', target = null, details = '', reason = '', result = null }) {
  const c = cfg();
  const who = by === 'app' || by === 'map' ? c.adminName : by;
  const res = resultText(result);
  let ticket = null; try { const tk = require('./tickets'); const id = tk.refFromText(reason); if (id) ticket = tk.tagAction(id, { action, by, target, details, reason, result }); } catch (e) { emitRef('console', { source: 'tickets', line: 'Could not tag the ticket: ' + e.message }); }
  const text = `${LABEL[action] || action}${target ? ` · ${target.name}` : ''}${details ? ` · ${details}` : ''}${reason ? ` · reason: ${reason}` : ''}${res ? ` · ${res}` : ''}`;
  emitRef('console', { source: 'admin', line: `${who}: ${text}` });
  try { require('./audit').log(source, who, 'admin:' + action, `${target ? `${target.name} (${target.steam || '?'}) ` : ''}${details}${reason ? ` — reason: ${reason}` : ''}${res ? ` — ${res}` : ''}`); } catch { /* ignore */ }
  try {
    const d = require('./discord');
    d.postAdminAction({ title: `${LABEL[action] || action}${target ? ` · ${target.name}` : ''}`, color: COLOR[action] || 0x8a94a6,
      fields: [
        { name: 'Admin', value: String(who).slice(0, 200), inline: true },
        ...(target ? [{ name: 'Player', value: `${target.name}${target.steam ? `\n${target.steam}` : ''}`.slice(0, 200), inline: true }] : []),
        ...(res ? [{ name: 'Result', value: res.slice(0, 200), inline: true }] : []),
        ...(details ? [{ name: 'Details', value: String(details).slice(0, 1000) }] : []),
        { name: 'Reason / ticket', value: reason ? String(reason).slice(0, 1000) : '—' },
        ...(ticket ? [{ name: 'Ticket', value: `#${ticket}`, inline: true }] : [])
      ] }).catch(e => emitRef('console', { source: 'admin', line: `Admin action not posted to Discord: ${e.message}` }));
  } catch { /* bot not loaded */ }
}

function init(emit) { emitRef = emit; }

module.exports = { init, cfg, check, record, NEEDS_REASON };
