'use strict';
// Scheduled in-game events: rows are checked, the warning and the switch each go to the game once a day at their
// time (not late by more than 5 minutes, not on other weekdays), one-off announcements and switches, the set picker.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'schedevents' });
const settings = t.mod('settings'); settings.save({ installDir: path.join(t.S, 'i') });
fs.mkdirSync(settings.paths().profilesDir, { recursive: true });
const ev = t.mod('schedevents'); ev.init(t.emit);
const dir = path.join(settings.paths().profilesDir, 'DayZAdminTools');
const cmds = () => { try { return fs.readFileSync(path.join(dir, 'editor_cmd.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

t.ok('a bad time is refused', (() => { try { ev.save([{ set: 'Airfield', time: '25:00' }]); return false; } catch { return true; } })());
// Wednesday 2026-10-28; the row runs on Wednesdays at 20:00 with a 10-minute warning
const wed = (h, m) => new Date(2026, 9, 28, h, m, 0);
ev.save([{ set: 'Airfield', on: true, time: '20:00', days: [3], warnMin: 10, message: 'Airfield event' }, { set: 'Airfield', on: false, time: '22:00', days: [], warnMin: 0 }]);
t.ok('saved rows show when they run next', ev.state().entries[0].dayNames === 'Wed' && ev.state().entries[1].dayNames === 'every day');

t.ok('nothing before the warning', ev.tick(wed(19, 49)).length === 0 && cmds().length === 0);
t.ok('the warning at 19:50, once', ev.tick(wed(19, 50)).length === 1 && ev.tick(wed(19, 52)).length === 0 && cmds()[0].announce === 'Airfield event (in 10 min)');
t.ok('the switch at 20:00, once, with the message', ev.tick(wed(20, 0)).length === 1 && ev.tick(wed(20, 3)).length === 0 && cmds()[1].setName === 'Airfield' && cmds()[1].on === true && cmds()[1].announce === 'Airfield event');
t.ok('not replayed when the tool was off past 5 minutes', ev.tick(wed(22, 6)).length === 0);
const thu = new Date(2026, 9, 29, 20, 0, 0);
t.ok('a Wednesday row does not run on Thursday', !ev.tick(thu).some(d => d.what === 'run' && ev.state().entries.find(e => e.id === d.id).days.includes(3)));

ev.announce('Restart in 5 minutes');
ev.switchSet('Halloween', false);
const last = cmds().slice(-2);
t.ok('one-off announcement and switch', last[0].announce === 'Restart in 5 minutes' && last[1].setName === 'Halloween' && last[1].on === false);

fs.writeFileSync(path.join(dir, 'editor_sets.json'), JSON.stringify({ sets: [{ name: 'Airfield', active: true, count: 12 }] }));
t.ok('the game\'s sets for the picker', ev.state().sets[0].name === 'Airfield');
t.done();
