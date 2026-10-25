'use strict';
// npm test: runs every test/*.test.js in its own process, one after another, and fails if any fails.
//   node test/run.js            all tests
//   node test/run.js keys body  only those (by name)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const only = process.argv.slice(2);
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js') && (!only.length || only.some(o => f.startsWith(o)))).sort();
if (!files.length) { console.error('No tests matched.'); process.exit(1); }
const failed = []; const t0 = Date.now();
for (const f of files) {
  console.log(`\n=== ${f}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', timeout: 180000 });
  if (r.status !== 0) failed.push(f + (r.signal ? ` (${r.signal})` : r.error ? ` (${r.error.message})` : ''));
}
console.log(`\n${files.length - failed.length}/${files.length} test files passed in ${((Date.now() - t0) / 1000).toFixed(1)} s${failed.length ? '\nFAILED: ' + failed.join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
