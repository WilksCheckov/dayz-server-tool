'use strict';
// Build step: copy the full-resolution map tiles the tool built from the game files into build-maps\, which the
// installer ships as resources\maps (see "extraResources" in package.json), so every install has the maps without
// a DayZ client. Run with Electron (for the JPEG encoder):  npm run maps  [-- <maps folder>]
// Default source: C:\DayZServer\maps (what the Map page builds into).
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const src = process.argv.find((a, i) => i > 1 && fs.existsSync(a) && fs.statSync(a).isDirectory()) || 'C:\\DayZServer\\maps';
const out = path.join(__dirname, '..', 'build-maps');

app.whenReady().then(() => {
  fs.mkdirSync(out, { recursive: true });
  const maps = fs.readdirSync(src, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(src, e.name, 'tiles', 'meta.json'))).map(e => e.name);
  if (!maps.length) { console.error(`No built maps in ${src} (build one on the Map page first).`); app.exit(1); return; }
  for (const key of maps) {
    const from = path.join(src, key, 'tiles'), to = path.join(out, key, 'tiles');
    fs.rmSync(path.join(out, key), { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
    // the overview as a JPEG (a quarter of the PNG's size); the tiles carry the detail
    const png = path.join(src, key + '.png');
    if (fs.existsSync(png)) fs.writeFileSync(path.join(out, key + '.jpg'), nativeImage.createFromPath(png).toJPEG(88));
    const meta = JSON.parse(fs.readFileSync(path.join(to, 'meta.json'), 'utf8'));
    console.log(`${key}: ${meta.tiles} tiles, ${meta.width} px${fs.existsSync(png) ? ', overview' : ''}`);
  }
  app.exit(0);
});
