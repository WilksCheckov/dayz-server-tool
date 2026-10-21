// Generates build/icon.png (256x256) and build/icon.ico from an SVG rendered by Electron itself.
// Run with: npx electron build/gen-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#8a5cff"/></linearGradient></defs>
  <rect x="16" y="16" width="224" height="224" rx="52" fill="url(#g)"/>
  <rect x="16" y="16" width="224" height="224" rx="52" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="6"/>
  <text x="128" y="158" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="104" fill="#fff" letter-spacing="2">DZ</text>
</svg>`;

function pngToIco(png) {
  // One PNG-compressed 256x256 entry (supported since Windows Vista).
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0; // 256 encoded as 0
  entry[2] = 0; entry[3] = 0; entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

// Pass DZ_ICON_SRC=<image path> to use your own artwork (scaled to 256x256, square-cropped, rounded corners).
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 256, height: 256, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const src = process.env.DZ_ICON_SRC;
  // A file:// page may load file:// images, so render through a temporary HTML file next to this script.
  const body = src
    ? `<div style="width:256px;height:256px;border-radius:40px;overflow:hidden"><img src="file:///${src.replace(/\\/g, '/')}" style="width:256px;height:256px;object-fit:cover;display:block"></div>`
    : SVG;
  const tmp = path.join(__dirname, '_icon.html');
  fs.writeFileSync(tmp, `<html><body style="margin:0;background:transparent">${body}</body></html>`);
  await win.loadFile(tmp);
  await new Promise(r => setTimeout(r, 800));
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  const png = img.toPNG();
  const out = path.join(__dirname);
  fs.writeFileSync(path.join(out, 'icon.png'), png);
  fs.writeFileSync(path.join(out, 'icon.ico'), pngToIco(png));
  console.log('icon.png', png.length, 'bytes; icon.ico written');
  app.quit();
});
