'use strict';
// DRP_Admin server mod: the PBO is built from bridge.c + the hooks into @DayZAdminTools, takes the bridge's place
// (init.c is stripped, the death log sees the bridge as present), shares the folder with the anti-dupe PBO without
// either removing the other, and its events.jsonl is read into the event list.
const fs = require('fs'); const path = require('path');
let running = false;
const t = require('./harness').setup({ name: 'drpadmin', stubs: { './server@drpadmin': { status: () => ({ running }) }, './server@deathlog': { status: () => ({ running: true }) } } });
const settings = t.settings(); const md = t.mission();
const da = t.mod('drpadmin'); da.init(t.emit);
const ac = t.mod('anticheat'); ac.init(t.emit);
const dl = t.mod('deathlog'); dl.init(t.emit);
const dir = path.join(settings.paths().serverDir, '@DayZAdminTools');
const pbo = path.join(dir, 'addons', 'drp_admin_server.pbo');
const initC = path.join(md, 'init.c');

// the bridge source becomes DRPA_Bridge with a settable world size
const src = da.sources();
const bridge = src.find(f => /drpa_bridge\.c$/.test(f.name)).text;
t.ok('bridge renamed for the mod', /^class DRPA_Bridge\b/m.test(bridge) && !/DZAT_Bridge/.test(bridge));
t.ok('world size is a variable set at mission start', /static float WORLD = 15360;/.test(bridge) && !/__DZAT_WORLD__/.test(bridge) && /static const int VERSION = \d+;/.test(bridge));
t.ok('mission hook calls the mod bridge', /DRPA_Bridge\.Tick\(timeslice\)/.test(src.find(f => /drpa_mission\.c$/.test(f.name)).text));
t.ok('config loads world and mission scripts', /DRP_Admin\/scripts\/4_World/.test(src[0].text) && /DRP_Admin\/scripts\/5_Mission/.test(src[0].text));

// off: the init.c bridge as before, nothing in the mod folder
dl.ensureBridge();
t.ok('off: init.c gets the bridge', /DZAT_Bridge\.Tick\(/.test(fs.readFileSync(initC, 'utf8')));
t.ok('off: no launch folder', da.launchMod() === null && !fs.existsSync(pbo));

// on: PBO built, bridge moves out of init.c, death log sees the bridge via the mod
const st = da.setEnabled(true);
const buf = fs.readFileSync(pbo);
t.ok('on: PBO written with the prefix and every script', st.installed && st.upToDate && buf.includes(Buffer.from('DRP_Admin\0')) && ['config.cpp', 'scripts\\4_World\\drpa_events.c', 'scripts\\5_Mission\\drpa_bridge.c', 'scripts\\5_Mission\\drpa_mission.c'].every(n => buf.includes(Buffer.from(n + '\0'))));
t.ok('on: -serverMod gets @DayZAdminTools', da.launchMod() === '@DayZAdminTools');
let r = dl.ensureBridge();
t.ok('on: init.c bridge removed at start', r.action === 'moved' && !/DZAT_Bridge/.test(fs.readFileSync(initC, 'utf8')), JSON.stringify(r));
t.ok('on: second start leaves init.c alone', dl.ensureBridge().action === 'mod');
const bs = dl.bridgeStatus();
t.ok('death log reports the bridge via the mod', bs.installed && bs.upToDate && bs.via === 'mod', JSON.stringify(bs));
let threw = null; try { dl.installBridge(); } catch (e) { threw = e.message; }
t.ok('installing into init.c is refused while the mod is on', /DRP_Admin/.test(threw || ''));
t.ok('ensure keeps a current build', da.ensure().action === 'ok');

// a stale build (bridge.c edited) is rebuilt
fs.writeFileSync(path.join(dir, 'drp_admin.txt'), 'old');
t.ok('stale build is rebuilt at start', da.ensure().action === 'updated' && da.status().upToDate);

// shared folder: anti-dupe on and off does not touch the DRP_Admin PBO, and an off anti-dupe PBO is taken out
ac.setEnabled(true);
t.ok('both PBOs side by side', fs.existsSync(path.join(dir, 'addons', 'dzat_anticheat.pbo')) && fs.existsSync(pbo));
settings.save({ anticheat: { mod: false } });
r = ac.ensure();
t.ok('anti-dupe off: its PBO is removed, DRP_Admin stays', r.action === 'removed' && !fs.existsSync(path.join(dir, 'addons', 'dzat_anticheat.pbo')) && fs.existsSync(pbo));

// while the server runs the toggle only saves
running = true;
const off = da.setEnabled(false);
t.ok('server running: off is deferred', off.pendingRestart && fs.existsSync(pbo));
t.ok('the loaded mod still counts as the bridge until the restart', dl.bridgeStatus().via === 'mod');
running = false;
t.ok('next start removes it and the folder', da.ensure().action === 'removed' && !fs.existsSync(dir));
t.ok('off again: init.c gets the bridge back', dl.ensureBridge().action === 'installed' && /DZAT_Bridge\.Tick\(/.test(fs.readFileSync(initC, 'utf8')));

// events
const ev = path.join(settings.paths().profilesDir, 'DayZAdminTools', 'events.jsonl');
fs.mkdirSync(path.dirname(ev), { recursive: true });
fs.writeFileSync(ev, [
  '{"t":"2026-10-26 20:00:00","ev":"start","world":"chernarusplus","size":15360,"version":1}',
  '{"t":"2026-10-26 20:01:00","ev":"connect","who":{"id":"G1","steam":"7656","name":"Bob \\"B\\"","pos":[1,2,3]}}',
  'not json',
  '{"t":"2026-10-26 20:02:00","ev":"kill","victim":{"id":"G1","steam":"7656","name":"Bob","pos":[1,2,3]},"by":{"cls":"ZmbM_HermitSkinny_Beige","pos":[1,2,4]},"weapon":"","dist":1}',
  '{"t":"2026-10-26 20:03:00","ev":"build","by":{"id":"G2","name":"Ann"},"cls":"Fence","part":"wall_base_down"'
].join('\r\n'));
t.ok('complete lines read, partial line kept', da.ingest() === 3);
fs.appendFileSync(ev, ',"pos":[5,6,7]}\r\n');
t.ok('partial line finished later', da.ingest() === 1);
const all = da.list();
t.ok('newest first with parsed time', all.length === 4 && all[0].ev === 'build' && all[0].ts === new Date(2026, 9, 26, 20, 3, 0).getTime());
t.ok('escaped names survive', da.list({ ev: 'connect' })[0].who.name === 'Bob "B"');
t.ok('filter by kind and text', da.list({ ev: 'kill,build' }).length === 2 && da.list({ q: 'hermit' }).length === 1);
t.ok('server start recorded', da.status().lastStart && da.status().lastStart.world === 'chernarusplus');
fs.writeFileSync(ev, '{"t":"2026-10-26 21:00:00","ev":"start","world":"enoch"}\n');
t.ok('a new (smaller) file is read from the start', da.ingest() === 1 && da.status().lastStart.world === 'enoch');
t.done();
