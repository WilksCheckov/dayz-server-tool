'use strict';
// DRP Factions from the tool: setup copies the mod in and puts it on the mod list; admin actions become command files
// the mod picks up (never edits of the files it owns); settings and admins are written and followed by a reload.
const fs = require('fs'); const path = require('path');
let running = false;
const modCalls = [];
const t = require('./harness').setup({ name: 'drpfactions', stubs: {
  './server@drpfactions': { status: () => ({ running }) },
  './mods@drpfactions': () => ({
    importUnmanaged: async (items) => { modCalls.push(['import', items[0].id]); const s = require(path.join(t.SRC, 'settings')); s.save({ mods: [...(s.load().mods || []), { id: items[0].id, enabled: true, serverSide: false }] }); },
    setFlags: (id, f) => modCalls.push(['flags', id, f]),
    remove: (id) => { modCalls.push(['remove', id]); const s = require(path.join(t.SRC, 'settings')); s.save({ mods: (s.load().mods || []).filter(m => m.id !== id) }); },
    link: (id) => modCalls.push(['link', id])
  })
} });
const settings = t.settings();
const f = t.mod('drpfactions');
const p = settings.paths();
const pd = path.join(p.profilesDir, 'DRP_Factions');

(async () => {
  // a build folder like the Developer Tools makes
  const build = path.join(t.S, 'build', '@DRP_Core');
  fs.mkdirSync(path.join(build, 'addons'), { recursive: true }); fs.mkdirSync(path.join(build, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(build, 'addons', 'DRP_Factions.pbo'), 'pbo v1'); fs.writeFileSync(path.join(build, 'keys', 'drp.bikey'), 'key');
  fs.writeFileSync(path.join(build, 'addons', 'DRP_DoorLocks.pbo'), 'doors');
  // a server set up before the core: @DRP_Factions on its own, on the mod list, plus an unrelated local mod
  fs.mkdirSync(path.join(p.serverDir, '@DRP_Factions', 'addons'), { recursive: true }); fs.writeFileSync(path.join(p.serverDir, '@DRP_Factions', 'addons', 'DRP_Factions.pbo'), 'old');
  fs.mkdirSync(path.join(p.serverDir, '@Other', 'addons'), { recursive: true }); fs.writeFileSync(path.join(p.serverDir, '@Other', 'addons', 'Other.pbo'), 'x');
  settings.save({ mods: [{ id: '@DRP_Factions', enabled: true }, { id: '@Other', enabled: true }] });

  let st = f.setupStatus();
  t.ok('fresh server: not installed, not ready', !st.installed && !st.ready);
  t.ok('old separate @DRP_Factions flagged', !st.steps.find(x => x.key === 'single').ok, st.steps.find(x => x.key === 'single').detail);
  running = true; let threw = ''; try { await f.install({ source: build }); } catch (e) { threw = e.message; }
  t.ok('install refused while the server runs', /Stop the server/.test(threw), threw);
  running = false;
  threw = ''; try { await f.install({ source: path.join(t.S, 'nothing') }); } catch (e) { threw = e.message; }
  t.ok('install refused without a pbo', /No DRP_Factions.pbo/.test(threw), threw);

  st = await f.install({ source: build, admins: ['76561198000000001', 'junk'] });
  t.ok('files copied into the server', fs.readFileSync(path.join(p.serverDir, '@DRP_Core', 'addons', 'DRP_Factions.pbo'), 'utf8') === 'pbo v1' && fs.existsSync(path.join(p.serverDir, '@DRP_Core', 'addons', 'DRP_DoorLocks.pbo')));
  t.ok('put on the mod list', modCalls.some(c => c[0] === 'import' && c[1] === '@DRP_Core'), JSON.stringify(modCalls));
  t.ok('old @DRP_Factions taken off the list (before the core goes on) and its folder removed', modCalls.findIndex(c => c[0] === 'remove' && c[1] === '@DRP_Factions') < modCalls.findIndex(c => c[0] === 'import') && modCalls.findIndex(c => c[0] === 'remove') >= 0 && !fs.existsSync(path.join(p.serverDir, '@DRP_Factions')), JSON.stringify(modCalls));
  t.ok('unrelated mods left alone', !modCalls.some(c => c[1] === '@Other') && fs.existsSync(path.join(p.serverDir, '@Other')));
  t.ok('sub-mods listed', st.subMods.join() === 'DRP_DoorLocks,DRP_Factions' && st.steps.find(x => x.key === 'single').ok, st.subMods.join());
  t.ok('admins.json made with the valid id only', JSON.stringify(JSON.parse(fs.readFileSync(path.join(pd, 'admins.json'), 'utf8')).admins) === '["76561198000000001"]');
  t.ok('source remembered', settings.load().drpFactions.source === build);
  t.ok('status: files and mod list ok, not run yet', st.steps.find(s => s.key === 'files').ok && st.steps.find(s => s.key === 'modlist').ok && !st.steps.find(s => s.key === 'ran').ok);

  // a newer build shows as an update; reinstalling replaces old files and links (keys) instead of importing again
  fs.writeFileSync(path.join(build, 'addons', 'DRP_Factions.pbo'), 'pbo v2'); const later = new Date(Date.now() + 60000); fs.utimesSync(path.join(build, 'addons', 'DRP_Factions.pbo'), later, later);
  fs.writeFileSync(path.join(p.serverDir, '@DRP_Core', 'addons', 'old.pbo'), 'stale');
  t.ok('newer build detected', !f.setupStatus().steps.find(s => s.key === 'current').ok);
  await f.install({});
  t.ok('update replaces the addons folder', fs.readFileSync(path.join(p.serverDir, '@DRP_Core', 'addons', 'DRP_Factions.pbo'), 'utf8') === 'pbo v2' && !fs.existsSync(path.join(p.serverDir, '@DRP_Core', 'addons', 'old.pbo')));
  t.ok('second install links instead of importing', modCalls.filter(c => c[0] === 'import').length === 1 && modCalls.some(c => c[0] === 'link'));

  // the mod has run: state from its files
  fs.writeFileSync(path.join(pd, 'settings.json'), JSON.stringify({ version: 1, cellSizeMeters: 512, tableDrainPerSecond: 1, spawnScatter: 3.5, nameMinLength: 3, nameMaxLength: 24, tagMinLength: 2, tagMaxLength: 5, warDurationHours: 72, deleteDepositedClothing: 1, kitAllowedSlots: ['Body'] }));
  fs.writeFileSync(path.join(pd, 'factions.json'), JSON.stringify({ factions: [{ id: 1, name: 'Monolith', tag: 'MCRP', color: -1754827, points: 5, founderId: '76561198000000001', members: [{ id: '76561198000000001', name: 'Boss', roleId: 0 }, { id: '76561198000000002', name: 'Grunt', roleId: 2 }], roles: [{ id: 0, name: 'Founder' }, { id: 2, name: 'Member' }], claims: [{ id: 3, kind: 0, x: 10800, z: 2300, cellX: 21, cellZ: 4, powered: 1, readyAt: 0 }], captured: [{ cellX: 22, cellZ: 4 }], hasCache: 1, cacheX: 1, cacheZ: 2 }] }));
  fs.writeFileSync(path.join(pd, 'wars.json'), JSON.stringify({ wars: [{ id: 1, state: 2, attackerId: 1, defenderId: 2, attackerName: 'Monolith', defenderName: 'Wolves', attackerScore: 10, defenderScore: 0 }] }));
  fs.writeFileSync(path.join(pd, 'players.json'), JSON.stringify({ players: [{ id: '76561198000000002', name: 'Grunt', factionId: 1, lastSeen: 5, cooldowns: [{}, {}] }] }));
  const S = f.state();
  t.ok('state: faction with members, roles, claims, captured, cache', S.available && S.factions[0].members[1].role === 'Member' && S.factions[0].members[0].leader && S.factions[0].captured.length === 1 && S.factions[0].cache && S.factions[0].color === '#e53935');
  t.ok('state: wars with state names, players, admins with names', S.wars[0].state === 'active' && S.players[0].cooldowns === 2 && S.admins[0].id === '76561198000000001');

  // commands
  const r = f.command({ op: 'set_points', factionId: 1, points: '250', reason: 'event prize' });
  const op = JSON.parse(fs.readFileSync(path.join(pd, r.file), 'utf8'));
  t.ok('command file with numbers and who did it', op.op === 'set_points' && op.factionId === 1 && op.points === 250 && op.by, JSON.stringify(op));
  t.ok('factions.json is never written by a command', JSON.parse(fs.readFileSync(path.join(pd, 'factions.json'), 'utf8')).factions[0].points === 5);
  const c2 = JSON.parse(fs.readFileSync(path.join(pd, f.command({ op: 'set_color', factionId: 1, color: '#1e88e5' }).file), 'utf8'));
  t.ok('colour sent as an int', c2.color === 0x1e88e5, String(c2.color));
  threw = ''; try { f.command({ op: 'drop_tables' }); } catch (e) { threw = e.message; } t.ok('unknown command refused', /Unknown command/.test(threw));
  threw = ''; try { f.command({ op: 'kick_member', factionId: 1 }); } catch (e) { threw = e.message; } t.ok('missing argument refused', /needs targetId/.test(threw));
  threw = ''; try { f.command({ op: 'war_score', warId: 1, attackerScore: 'x', defenderScore: 1 }); } catch (e) { threw = e.message; } t.ok('non-number refused', /must be a number/.test(threw));
  const pend = f.command({ op: 'war_cancel', warId: 1 });
  t.ok('pending command can be taken back', f.undo(pend.file).pending === pend.pending - 1);

  // settings: validated, floats kept, a reload follows; cell size flags a restart
  const before = fs.readdirSync(pd).filter(n => /^admin_inbox_/.test(n)).length;
  threw = ''; try { f.saveSettings({ warDurationHours: 0 }); } catch (e) { threw = e.message; } t.ok('out-of-range setting refused', /War length/.test(threw), threw);
  const sv = f.saveSettings({ warDurationHours: '48', tableDrainPerSecond: '0.75', spawnScatter: 2.5, cellSizeMeters: 256, deleteDepositedClothing: false, kitAllowedSlots: ['Body', ' Legs ', ''], pointValues: [{ match: 'slot:Body', points: '3' }, { match: '', points: 1 }] });
  const saved = JSON.parse(fs.readFileSync(path.join(pd, 'settings.json'), 'utf8'));
  t.ok('settings written, floats kept, ints rounded, lists cleaned', saved.warDurationHours === 48 && saved.tableDrainPerSecond === 0.75 && saved.spawnScatter === 2.5 && saved.deleteDepositedClothing === 0 && saved.kitAllowedSlots.join() === 'Body,Legs' && saved.pointValues.length === 1 && saved.pointValues[0].points === 3 && saved.version === 1, JSON.stringify(saved));
  t.ok('restart flagged for a new cell size, backup kept', sv.restartNeeded && fs.existsSync(path.join(pd, 'settings.json.bak')));
  t.ok('a reload follows a settings change', fs.readdirSync(pd).filter(n => /^admin_inbox_/.test(n)).length === before + 1);
  threw = ''; try { f.saveAdmins(['123']); } catch (e) { threw = e.message; } t.ok('admins: Steam64 only', /Not a Steam64/.test(threw));
  t.ok('admins saved', f.saveAdmins(['76561198000000002', '76561198000000002']).length === 1);
  t.done();
})();
