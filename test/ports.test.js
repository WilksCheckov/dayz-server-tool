'use strict';
// Instances: port blocks, clashes between instances, writing ports into an instance's settings and serverDZ.cfg.
const fs = require('fs'); const path = require('path');
const t = require('./harness').setup({ name: 'ports' });
const settings = t.settings();
const inst = t.mod('instances'); inst.init(t.emit);
const dir = path.join(t.S, 'servers', 'Second'); fs.mkdirSync(path.join(dir, 'tool'), { recursive: true }); fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
fs.writeFileSync(path.join(dir, 'tool', 'settings.json'), JSON.stringify({ installDir: dir, port: 2302, website: { enabled: true, port: 8080 } }));
fs.writeFileSync(path.join(dir, 'server', 'serverDZ.cfg'), 'hostname = "second";\r\nsteamQueryPort = 27016;\r\n');
fs.writeFileSync(path.join(t.S, 'instances.json'), JSON.stringify({ root: path.join(t.S, 'servers'), list: [{ name: 'Second', dir }] }));
(async () => {
  t.ok('two entries, main first', inst.entries().map(e => e.name).join(',') === 'Main,Second');
  const c = inst.conflicts();
  t.ok('same ports clash on game, game+1, RCon and query', c.map(x => x.mine).sort().join(',') === 'game,game2,query,rcon' && c.every(x => x.by === 'Second'), JSON.stringify(c));
  t.ok('the website port clashes only when the website is on', !c.some(x => x.mine === 'web'));
  const b = await inst.freeBlock(path.join(dir, 'tool'));
  t.ok('next free block skips the main instance\'s ports', b.game === 2402 && b.query === 27116 && b.rcon === 2406 && b.web === 8081, JSON.stringify(b));
  inst.writePorts(inst.entries()[1], b);
  const s2 = JSON.parse(fs.readFileSync(path.join(dir, 'tool', 'settings.json'), 'utf8'));
  t.ok('ports written to the instance settings', s2.port === 2402 && s2.rcon.port === 2406 && s2.website.port === 8081 && s2.steamQueryPort === 27116 && s2.installDir === dir);
  t.ok('query port written to serverDZ.cfg', /steamQueryPort = 27116;/.test(fs.readFileSync(path.join(dir, 'server', 'serverDZ.cfg'), 'utf8')));
  t.ok('no clashes afterwards', inst.conflicts().length === 0 && inst.conflicts(path.join(dir, 'tool')).length === 0);
  settings.save({ website: { enabled: true, port: 8081 } });
  t.ok('a website port clash is found once both have the website on', inst.conflicts().some(x => x.mine === 'web' && x.port === 8081));
  t.done();
})();
