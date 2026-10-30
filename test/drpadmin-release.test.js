'use strict';
// DRP_Admin release work (plan step 10): the client mod's version and protocol from its "mod_start" event, the
// client mod's install state on the server (@DRP_Core, mod list, keys) and copying its keys, each admin's daily item
// cap from the portal written to admins.json, and one permission list: every in-game permission is in the portal's
// catalogue and (when the mod source is on this PC) matches the mod's DRPA_PERM_ constants.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'drpadmin-release', stubs: { './adminlog@drpadmin': { record: () => {} } } });
const settings = t.settings();
const portal = t.mod('portal'); portal.init && portal.init(t.emit);
const da = t.mod('drpadmin'); da.init(t.emit);
const p = settings.paths();

// ---- version handshake
let cl = da.clientStatus();
t.ok('before the mod has started there is no version and no protocol warning', cl.version === null && cl.protocolOk);
const ev = path.join(p.profilesDir, 'DayZAdminTools', 'events.jsonl');
fs.mkdirSync(path.dirname(ev), { recursive: true });
const stamp = () => { const d = new Date(); const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
fs.appendFileSync(ev, JSON.stringify({ t: stamp(), ev: 'mod_start', mod: 'DRP_Admin', version: '0.2.0', protocol: da.MOD_PROTOCOL }) + '\n');
da.ingest(); cl = da.clientStatus();
t.ok('the mod start event gives the version and protocol', cl.version === '0.2.0' && cl.protocol === da.MOD_PROTOCOL && cl.protocolOk);
fs.appendFileSync(ev, JSON.stringify({ t: stamp(), ev: 'mod_start', mod: 'DRP_Admin', version: '0.9.0', protocol: da.MOD_PROTOCOL + 1 }) + '\n');
da.ingest(); cl = da.clientStatus();
t.ok('a different protocol is a problem that says what to update', !cl.protocolOk && cl.problems.some(x => /protocol/.test(x) && /update the app/.test(x)), cl.problems.join(' | '));

// ---- client install state and keys
t.ok('without @DRP_Core the client mod is reported missing', !cl.installed && cl.problems.some(x => /not in @DRP_Core/.test(x)));
const core = path.join(p.serverDir, '@DRP_Core');
fs.mkdirSync(path.join(core, 'addons'), { recursive: true }); fs.writeFileSync(path.join(core, 'addons', 'DRP_Admin.pbo'), 'x');
fs.mkdirSync(path.join(core, 'keys'), { recursive: true }); fs.writeFileSync(path.join(core, 'keys', 'drp1714.bikey'), 'k');
settings.save({ mods: [{ id: '@DRP_Core', kind: 'local', enabled: true }] });
cl = da.clientStatus();
t.ok('a key the server keys folder lacks is listed', cl.installed && cl.onList && cl.missingKeys.join() === 'drp1714.bikey' && cl.problems.some(x => /drp1714\.bikey/.test(x)));
cl = da.installClientKeys();
t.ok('copying the keys fixes it', cl.missingKeys.length === 0 && fs.existsSync(path.join(p.keysDir, 'drp1714.bikey')));
settings.save({ mods: [{ id: '@DRP_Core', kind: 'local', enabled: true, serverSide: true }] });
t.ok('@DRP_Core loaded server-side only is a problem (players need it)', da.clientStatus().problems.some(x => /not on the mod list/.test(x)));

// ---- daily item cap
portal.upsertGroup({ name: 'Helpers', perms: ['admin.menu', 'admin.spawn'], approval: {}, itemsPerDay: 20 });
portal.upsertGroup({ name: 'Builders', perms: ['admin.menu', 'admin.spawn'], approval: {}, itemsPerDay: 0 });
portal.createUser({ name: 'Boss', password: 'password1', groups: ['owner'] });
portal.createUser({ name: 'Hal', password: 'password1', groups: ['helpers'], steam: '76561198000000004' });
portal.createUser({ name: 'Bea', password: 'password1', groups: ['builders'], steam: '76561198000000005' });
const admins = da.computeAdmins(); const a = s => admins.find(x => x.steam === s);
t.ok("a group's daily item cap reaches admins.json", a('76561198000000004') && a('76561198000000004').itemsPerDay === 20);
t.ok('no cap, no field', a('76561198000000005') && !('itemsPerDay' in a('76561198000000005')));

// ---- one permission list
const portalNames = new Set(portal.PERMS.map(x => x[0]));
t.ok('every in-game permission is in the portal catalogue', da.INGAME_PERMS.every(x => portalNames.has(x)), da.INGAME_PERMS.filter(x => !portalNames.has(x)).join());
const OTHER_MODS = ['admin.industry', 'admin.bases'];	// checked by DRP_Industry and DRP_Bases, not by DRP_Admin
const modSrc = 'P:\\DRP_Admin\\scripts\\3_Game\\DRPA_Common.c';
if (fs.existsSync(modSrc)) {
  const inMod = [...fs.readFileSync(modSrc, 'utf8').matchAll(/DRPA_PERM_\w+\s*=\s*"([^"]+)"/g)].map(m => m[1]);
  const want = da.INGAME_PERMS.filter(x => !OTHER_MODS.includes(x));
  const missing = want.filter(x => !inMod.includes(x)), extra = inMod.filter(x => !want.includes(x));
  t.ok("the mod's permission constants match the app's in-game list", !missing.length && !extra.length, `missing in mod: ${missing.join()} · only in mod: ${extra.join()}`);
} else t.ok('mod source not on this PC: constants not compared', true);
t.done();
