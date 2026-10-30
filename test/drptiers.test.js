'use strict';
// DRP Factions sectors, loot tiers and logos from the tool: the sector map is read once per change, tiers are saved
// with validation and a reload, pools come from types.xml tiers weighted by nominal, logos go into the mod's folder.
const fs = require('fs'); const path = require('path');
const ITEMS = [
    { name: 'AKM', nominal: 5, value: ['Tier3', 'Tier4'], category: ['weapons'], usage: ['Military'] },
    { name: 'Apple', nominal: 40, value: ['Tier1'], category: ['food'], usage: ['Town', 'Village'] },
    { name: 'M4A1', nominal: 3, value: ['tier4'], category: ['weapons'], usage: ['military'] },
    { name: 'Rare', nominal: 0, value: ['Tier4'], category: ['weapons'], usage: ['Military'] },
    { name: 'Handcuffs', nominal: 8, value: [], category: ['tools'], usage: ['Police'] },
    { name: 'NoUse', nominal: 9, value: ['Tier1'], category: ['tools'], usage: [] }
];
const t = require('./harness').setup({ name: 'drptiers', stubs: {
  './lootmap@drpfactions': { items: () => ITEMS }
} });
const settings = t.settings();
const z = t.mod('drpzones'); const f = t.mod('drpfactions');
const pd = path.join(settings.paths().profilesDir, 'DRP_Factions');
fs.mkdirSync(pd, { recursive: true });
fs.writeFileSync(path.join(pd, 'reward_zones.json'), JSON.stringify({ enabled: 1, zones: [] }));
fs.writeFileSync(path.join(pd, 'settings.json'), JSON.stringify({ version: 2 }));
fs.writeFileSync(path.join(pd, 'factions.json'), JSON.stringify({ factions: [{ id: 1, name: 'A', tag: 'AA', color: -1754827, logo: 'wolf', claims: [{ id: 7, cellX: 2, cellZ: 0, kind: 0 }], captured: [{ cellX: 3, cellZ: 0 }] }] }));
fs.writeFileSync(path.join(pd, 'logos.json'), JSON.stringify({ logos: ['star', 'wolf'] }));

t.ok('no sector map yet', z.sectors().available === false);
fs.writeFileSync(path.join(pd, 'sectors.json'), JSON.stringify({ version: 4, raster: 32, n: 2, sectors: [{ id: 2, name: 'North', kind: 1, cx: 16, cz: 48, cells: 2, nb: [3] }, { id: 3, name: 'South', kind: 0, cx: 16, cz: 16, cells: 2, nb: [2] }], rows: ['3*2', '2*2'], borders: ['2,3,0,32,64,32'] }));
const S1 = z.sectors();
t.ok('sector map read with borders', S1.available && S1.sectors.length === 2 && S1.borders.length === 1 && S1.rows[1] === '2*2');
t.ok('read once per change (cached)', z.sectors() === S1);
const st = z.state();
t.ok('state: sector map time, logos, claim ids, faction logo', st.sectorsAt > 0 && st.logos.join() === 'star,wolf' && st.factions[0].cells[0].claimId === 7 && st.factions[0].logo === 'wolf');

// loot tiers
const d0 = f.lootTiers();
t.ok('defaults: four tiers, nothing painted', d0.tiers.length === 4 && d0.sectors.length === 0 && d0.intervalMinutes === 60);
let threw = ''; try { f.saveLootTiers({ intervalMinutes: 0 }); } catch (e) { threw = e.message; } t.ok('bad cycle refused', /1 to 10080/.test(threw), threw);
const saved = f.saveLootTiers({ sectors: [{ id: 2, tier: 3 }, { id: 3, tier: 9 }, { id: 0, tier: 1 }], intervalMinutes: 30, tiers: [{ tier: 3, rolls: 99, chance: 150, items: [{ className: ' AKM ', weight: 0, min: 2, max: 1 }, { className: '' }] }] });
const t3 = saved.tiers.find(x => x.tier === 3);
t.ok('painted sectors validated (bad tier and id dropped)', saved.sectors.length === 1 && saved.sectors[0].id === 2 && saved.sectors[0].tier === 3);
t.ok('tier numbers clamped, items cleaned', t3.rolls === 50 && t3.chance === 100 && t3.items.length === 1 && t3.items[0].className === 'AKM' && t3.items[0].weight === 1 && t3.items[0].max === 2, JSON.stringify(t3));
t.ok('saved to loot_tiers.json, a reload follows', JSON.parse(fs.readFileSync(path.join(pd, 'loot_tiers.json'), 'utf8')).intervalMinutes === 30 && fs.readdirSync(pd).some(n => /^admin_inbox_/.test(n) && JSON.parse(fs.readFileSync(path.join(pd, n), 'utf8')).op === 'reload'));
const again = f.saveLootTiers({ tiers: [{ tier: 1, rolls: 1 }] });
t.ok('a partial save keeps the rest', again.sectors.length === 1 && again.tiers.find(x => x.tier === 3).items.length === 1 && again.tiers.find(x => x.tier === 1).rolls === 1);
const pool = f.fillTier({ tier: 4 });
t.ok('pool from types.xml: TierN (any case), nominal > 0, weight = nominal', pool.map(i => i.className).join() === 'AKM,M4A1' && pool[0].weight === 5, JSON.stringify(pool));
t.ok('pool filtered by category', f.fillTier({ tier: 1, categories: ['weapons'] }).length === 0 && f.fillTier({ tier: 1, categories: ['food'] }).length === 1);

// logos
const r1 = f.command({ op: 'set_logo', factionId: 1 });
t.ok('set_logo without a name clears it', JSON.parse(fs.readFileSync(path.join(pd, r1.file), 'utf8')).name === '');
threw = ''; try { f.addLogo({ file: path.join(t.S, 'nope.png') }); } catch (e) { threw = e.message; } t.ok('add logo needs a file', /Pick an image/.test(threw));
const img = path.join(t.S, 'My Cool Logo!.png'); fs.writeFileSync(img, 'png');
// only where the real mod folder is absent: with it present, addLogo would copy the fake image into the mod
if (!fs.existsSync('P:\\DRP_Factions\\gui\\logos')) { threw = ''; try { f.addLogo({ file: img }); } catch (e) { threw = e.message; } t.ok('no logo folder: says so', /No logo folder/.test(threw), threw); }
const ld = path.join(t.S, 'logos'); fs.mkdirSync(ld);
f.setLogoDir(ld);
const added = f.addLogo({ file: img });
t.ok('logo copied under a clean name', added.name === 'my_cool_logo' && fs.existsSync(path.join(ld, 'my_cool_logo.png')), JSON.stringify(added));
const jpg = path.join(t.S, 'my_cool_logo.jpg'); fs.writeFileSync(jpg, 'jpg');
f.addLogo({ file: jpg });
t.ok('a new image replaces the old one of that name', fs.existsSync(path.join(ld, 'my_cool_logo.jpg')) && !fs.existsSync(path.join(ld, 'my_cool_logo.png')));
threw = ''; try { f.addLogo({ file: path.join(t.S, 'x.gif') }); } catch (e) { threw = e.message; } t.ok('only PNG or JPG', /PNG or JPG|Pick an image/.test(threw));
// zone classes
const L = f.lootTiers();
t.ok('default zone classes', L.classes.map(c => c.id).join() === 'civilian,civil,police,military');
const withCls = f.saveLootTiers({ sectors: [{ id: 2, tier: 3, cls: 'military' }, { id: 3, tier: 0, cls: 'police' }, { id: 4, tier: 0, cls: 'nonsense' }] });
t.ok('sector classes saved; a class alone is kept, an unknown class dropped', withCls.sectors.length === 2 && withCls.sectors[0].cls === 'military' && withCls.sectors[1].tier === 0 && withCls.sectors[1].cls === 'police', JSON.stringify(withCls.sectors));
const mil = L.classes.find(c => c.id === 'military'), pol = L.classes.find(c => c.id === 'police'), civ = L.classes.find(c => c.id === 'civilian');
const items = ITEMS;
t.ok('pool: usage and tier must both fit (case-insensitive), nominal > 0', f.poolFor(mil, 4, items).map(i => i.className).join() === 'AKM,M4A1' && f.poolFor(mil, 1, items).length === 0);
t.ok('pool: an item with no tier fits every tier', f.poolFor(pol, 1, items).map(i => i.className).join() === 'Handcuffs' && f.poolFor(pol, 4, items).length === 1);
t.ok('pool: items without a usage never fit', !f.poolFor(civ, 1, items).some(i => i.className === 'NoUse') && f.poolFor(civ, 1, items)[0].className === 'Apple');
const built = f.buildPools();
t.ok('buildPools makes every class x tier pool', built.pools.length === 16 && built.pools.find(p => p.cls === 'military' && p.tier === 4).items.length === 2);
const renamed = f.saveLootTiers({ classes: [{ id: 'civilian', name: 'Civilian', usages: ['Town'] }, { id: 'military', name: 'Army', usages: ['Military'] }] });
t.ok('removing a class drops its pools and paint', renamed.classes.length === 2 && !renamed.pools.some(p => p.cls === 'police') && !renamed.sectors.some(x => x.cls === 'police'));
threw = ''; try { f.saveLootTiers({ classes: [] }); } catch (e) { threw = e.message; } t.ok('at least one class stays', /at least one/.test(threw));
t.done();
