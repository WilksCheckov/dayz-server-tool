'use strict';
// Watchlist and moderation from the game: entries by Steam64 or DayZ id, joins alert, suspicious activity adds
// automatically without overriding staff, the mod's watchlist.json; in-game requests (ban, lists, watch, approval)
// are checked against the admin's in-game permissions and answered in requests_out.json.
const fs = require('fs'); const path = require('path');
const alerts = []; const bans = []; const requests = [];
const t = require('./harness').setup({ name: 'watchlist', stubs: {
  './alerts@watchlist': { alert: (kind, title, body) => alerts.push({ kind, title, body }) },
  './discord@gamereq': { banUser: async (b) => { bans.push(b); }, checkExpiredBans: async () => {} },
  './portal@gamereq': { requestFromGame: (steam, cat, desc, rid) => { requests.push({ steam, cat, desc, rid }); return { id: '0042' }; } },
  './drpadmin@gamereq': { computeAdmins: () => [{ steam: '76561198000000001', name: 'Ada', perms: ['admin.players', 'players.ban'] }, { steam: '76561198000000002', name: 'Gm', perms: ['admin.players'] }] }
} });
const settings = t.mod('settings'); settings.save({ installDir: path.join(t.S, 'i') });
fs.mkdirSync(settings.paths().profilesDir, { recursive: true });
const lists = t.mod('lists');
const wl = t.mod('watchlist'); wl.init(t.emit);
const BOB = '76561198000000005'; const bobId = lists.steamIdToDayzId(BOB);

t.ok('a reason is needed', (() => { try { wl.add({ steam: BOB, name: 'Bob' }); return false; } catch { return true; } })());
const e = wl.add({ steam: BOB, name: 'Bob', confidence: 'high', reason: 'Seen flying', note: 'check his base' }, 'Chris', 'app');
t.ok('keyed by the DayZ id, Steam64 kept', e.guid === bobId && e.steam === BOB && e.confidence === 'high');
t.ok('found by Steam64 or DayZ id', wl.find(BOB) === wl.find(bobId) && wl.find(BOB).name === 'Bob');
const out = JSON.parse(fs.readFileSync(path.join(settings.paths().profilesDir, 'DayZAdminTools', 'watchlist.json'), 'utf8'));
t.ok('the mod gets watchlist.json with the reason', out.entries.length === 1 && out.entries[0].steam === BOB && out.entries[0].reason === 'Seen flying');

wl.onConnect({ id: bobId, name: 'Bob', ts: Date.now() });
t.ok('a join alerts with the reason and counts', alerts.length === 1 && alerts[0].kind === 'watchlist-join' && /Seen flying/.test(alerts[0].body) && wl.find(BOB).joins === 1);
wl.onConnect({ id: 'SOMEONEELSE', name: 'Al', ts: Date.now() });
t.ok('others joining do not alert', alerts.length === 1);

wl.autoFlag(bobId, 'Bob', 9, 3, 'speed ×3');
t.ok('suspicious activity never overrides a staff entry', wl.find(BOB).source === 'app' && wl.find(BOB).reason === 'Seen flying');
wl.autoFlag('GAL', 'Al', 4, 3, 'headshots ×4');
t.ok('suspicious activity adds automatically', wl.find('GAL').source === 'auto' && wl.find('GAL').confidence === 'medium');
wl.autoFlag('GAL', 'Al', 7, 3, 'headshots ×7');
t.ok('and raises the confidence as the score grows', wl.find('GAL').confidence === 'high');
t.ok('list carries what the app knows, online first', wl.list().length === 2 && 'playtimeSec' in wl.list()[0]);

// requests from the game
const gr = t.mod('gamereq'); gr.init(t.emit);
const dir = path.join(settings.paths().profilesDir, 'DayZAdminTools');
const send = async (...lines) => { fs.appendFileSync(path.join(dir, 'requests_in.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n'); return gr.ingest(); };
const res = () => JSON.parse(fs.readFileSync(path.join(dir, 'requests_out.json'), 'utf8'));
const ADA = { steam: '76561198000000001', name: 'Ada' }, GM = { steam: '76561198000000002', name: 'Gm' };
const AL = { steam: '76561198000000006', name: 'Al', guid: lists.steamIdToDayzId('76561198000000006') };

(async () => {
  await send({ op: 'ban', rid: 'r1', by: GM, target: AL, reason: 'cheating', days: 3 });
  t.ok('a ban needs players.ban', bans.length === 0 && res().results.pop().ok === false);
  await send({ op: 'ban', rid: 'r2', by: ADA, target: AL, reason: 'cheating', note: 'video', days: 3 });
  t.ok('a ban runs through the app\'s ban with its expiry', bans.length === 1 && bans[0].steamId === AL.steam && bans[0].expiresAt && /cheating \(note: video\)/.test(bans[0].reason));
  t.ok('the admin is told', /banned for 3 day/.test(res().results.pop().text));
  await send({ op: 'list', rid: 'r3', by: ADA, kind: 'whitelist', on: true, target: AL });
  t.ok('lists need lists.manage', !lists.has('whitelist', AL.steam) && res().results.pop().ok === false);
  await send({ op: 'watch', rid: 'r4', by: GM, target: AL, confidence: 'low', reason: 'odd loot runs', on: true });
  t.ok('a watch from the game is added as an in-game entry', wl.find(AL.steam).source === 'game' && wl.find(AL.steam).by === 'Gm (in game)');
  await send({ op: 'approval', rid: 'g7', by: GM, cat: 'spawn', desc: '5 × M4A1' });
  t.ok('an approval becomes a portal request', requests.length === 1 && requests[0].rid === 'g7' && /#R0042/.test(res().results.pop().text));
  gr.decided('g7', true, 'Ada');
  t.ok('the decision goes back to the game', res().approvals.some(a => a.rid === 'g7' && a.status === 'approved' && a.by === 'Ada'));
  t.ok('every line is read once', (await gr.ingest()) === 0);
  t.done();
})();
