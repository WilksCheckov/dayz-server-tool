'use strict';
// Which instance this process is. The main window is the main instance (its data in the usual app data folder);
// every other instance runs as its own background process of the same app, started by the main one with
//   --dzat-instance=<instance folder>  --dzat-manager=<main instance's data folder>
// and keeps its settings and data in <instance folder>\tool, so nothing is shared unless chosen.
const path = require('path');

const arg = (name) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3).replace(/^"|"$/g, '') : null; };
const dir = arg('dzat-instance');
const managerData = arg('dzat-manager');

module.exports = {
  isChild: !!dir,
  dir: dir ? path.resolve(dir) : null,
  name: dir ? path.basename(path.resolve(dir)) : null,
  dataDir: dir ? path.join(path.resolve(dir), 'tool') : null,
  managerData: managerData ? path.resolve(managerData) : null
};
