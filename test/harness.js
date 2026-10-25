'use strict';
// Test harness for the main-process modules: runs them outside Electron with a stub `electron`, a throwaway data
// folder (userData) and a throwaway install folder, and collects PASS / FAIL lines. Each *.test.js is its own
// process (test/run.js starts them), so module state never leaks between tests.
//
//   const t = require('./harness').setup({ name: 'keys', stubs: { './server@deathlog': { status: () => ({ running: true }) } } });
//   const settings = t.settings();          // installDir = <S>\i
//   const mods = t.mod('mods');             // src/main/mods.js
//   t.ok('what', condition, 'detail');      // one check
//   t.done();                               // prints the summary, removes S, exits 1 on any failure
//
// stubs: { '<request>[@<requiring file>]': value | () => value } replaces that require (optionally only from one file).
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'src', 'main');

function setup({ name = 'test', stubs = {} } = {}) {
  const S = path.join(os.tmpdir(), `dzat-test-${name}-${process.pid}`);
  fs.rmSync(S, { recursive: true, force: true }); fs.mkdirSync(S, { recursive: true });
  const electron = {
    app: { getPath: () => S, setPath: () => {}, getVersion: () => 'test', getAppPath: () => path.join(__dirname, '..'), isPackaged: false },
    Notification: { isSupported: () => false },
    shell: { openPath: async () => '', openExternal: async () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
  };
  const orig = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === 'electron') return electron;
    for (const [key, v] of Object.entries(stubs)) {
      const [mod, from] = key.split('@');
      if (req === mod && (!from || (parent && new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.js$').test(parent.filename || '')))) return typeof v === 'function' ? v() : v;
    }
    return orig.call(this, req, parent, ...rest);
  };
  const lines = []; const results = [];
  const t = {
    S, SRC, electron, lines,
    emit: (ch, d) => { if (ch === 'console') lines.push(`[${d.source}] ${d.line}`); },
    mod: (n) => require(path.join(SRC, n + '.js')),
    settings() { const s = t.mod('settings'); s.save({ installDir: path.join(S, 'i') }); return s; },
    ok(label, cond, extra = '') { results.push({ label, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`); },
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    // a mission with a stock-like init.c so the bridge script can be installed
    mission(mapName = 'test.map') {
      const p = t.mod('settings').paths();
      const md = path.join(p.serverDir, 'mpmissions', mapName); fs.mkdirSync(md, { recursive: true });
      fs.writeFileSync(p.configPath, `hostname = "test";\r\ntemplate = "${mapName}";\r\n`);
      fs.writeFileSync(path.join(md, 'init.c'), 'void main()\r\n{\r\n}\r\nclass CustomMission: MissionServer\r\n{\r\n};\r\nMission CreateCustomMission(string path)\r\n{\r\n\treturn new CustomMission();\r\n}\r\n');
      return md;
    },
    done() {
      const failed = results.filter(r => !r.ok);
      console.log(`${results.length - failed.length}/${results.length} passed${failed.length ? ': FAILED ' + failed.map(f => f.label).join(', ') : ''}`);
      try { fs.rmSync(S, { recursive: true, force: true }); } catch { /* a handle may still be open on Windows */ }
      process.exit(failed.length ? 1 : 0);
    }
  };
  process.on('unhandledRejection', e => { console.log('FAIL  unhandled rejection — ' + (e && e.stack || e)); results.push({ label: 'unhandled rejection', ok: false }); t.done(); });
  return t;
}

module.exports = { setup, SRC };
