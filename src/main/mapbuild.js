'use strict';
// Builds a map image for the active world from the game's own files: the satellite tiles inside
// worlds_<world>_data.pbo (DayZ client install, or a map mod's addons). PBO -> PAA (DXT1, LZO) -> stitched PNG.
// Heavy work runs in a worker thread so the app stays responsive.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PBO ----------
function readPbo(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16 * 1024 * 1024); const n = fs.readSync(fd, head, 0, head.length, 0);
  let o = 0; const entries = [];
  while (o < n) {
    const e = head.indexOf(0, o); if (e < 0) break;
    const name = head.toString('latin1', o, e); o = e + 1;
    const packing = head.readUInt32LE(o), dataSize = head.readUInt32LE(o + 16); o += 20;
    if (name === '' && packing === 0x56657273) { for (;;) { const k = head.indexOf(0, o); const key = head.toString('latin1', o, k); o = k + 1; if (key === '') break; const v = head.indexOf(0, o); o = v + 1; } continue; }
    if (name === '') break;
    entries.push({ name, dataSize, packing });
  }
  let off = o; for (const en of entries) { en.offset = off; off += en.dataSize; }
  return { fd, entries };
}
function readEntry(pbo, en) { const b = Buffer.alloc(en.dataSize); fs.readSync(pbo.fd, b, 0, en.dataSize, en.offset); return b; }

// ---------- LZO1X decompression (the variant PAA files use) ----------
function lzo1x(src, outLen) {
  const dst = Buffer.alloc(outLen); let ip = 0, op = 0, t, mpos;
  const copyMatch = (len) => { for (let i = 0; i < len; i++) dst[op++] = dst[mpos++]; };
  let state = 'loop';
  if (src[0] > 17) { t = src[ip++] - 17; if (t < 4) state = 'match_next'; else { for (let i = 0; i < t; i++) dst[op++] = src[ip++]; state = 'first_literal_run'; } }
  for (;;) {
    if (state === 'loop') {
      t = src[ip++];
      if (t >= 16) { state = 'match'; }
      else {
        if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 15 + src[ip++]; }
        t += 3; for (let i = 0; i < t; i++) dst[op++] = src[ip++];
        state = 'first_literal_run';
      }
    }
    if (state === 'first_literal_run') {
      t = src[ip++];
      if (t >= 16) state = 'match';
      else { mpos = op - (1 + 0x0800); mpos -= t >> 2; mpos -= src[ip++] << 2; copyMatch(3); state = 'match_done'; }
    }
    if (state === 'match') {
      if (t >= 64) { mpos = op - 1; mpos -= (t >> 2) & 7; mpos -= src[ip++] << 3; t = (t >> 5) - 1; copyMatch(t + 2); state = 'match_done'; }
      else if (t >= 32) { t &= 31; if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 31 + src[ip++]; } mpos = op - 1; mpos -= (src[ip] >> 2) + (src[ip + 1] << 6); ip += 2; copyMatch(t + 2); state = 'match_done'; }
      else if (t >= 16) { mpos = op; mpos -= (t & 8) << 11; t &= 7; if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 7 + src[ip++]; } mpos -= (src[ip] >> 2) + (src[ip + 1] << 6); ip += 2; if (mpos === op) return dst.subarray(0, op); mpos -= 0x4000; copyMatch(t + 2); state = 'match_done'; }
      else { mpos = op - 1; mpos -= t >> 2; mpos -= src[ip++] << 2; copyMatch(2); state = 'match_done'; }
    }
    if (state === 'match_done') {
      t = src[ip - 2] & 3;
      if (t === 0) { state = 'loop'; continue; }
      state = 'match_next';
    }
    if (state === 'match_next') {
      for (let i = 0; i < t; i++) dst[op++] = src[ip++];
      t = src[ip++]; state = 'match';
    }
    if (op >= outLen) return dst;
  }
}

// ---------- PAA (DXT1 / DXT5) -> RGBA ----------
function decodePaa(buf) {
  const type = buf.readUInt16LE(0); let p = 2;
  while (buf.toString('latin1', p, p + 4) === 'GGAT') { const len = buf.readUInt32LE(p + 8); p += 12 + len; }
  const pal = buf.readUInt16LE(p); p += 2 + pal * 3;
  const wRaw = buf.readUInt16LE(p), hRaw = buf.readUInt16LE(p + 2); const size = buf.readUIntLE(p + 4, 3); p += 7;
  const w = wRaw & 0x7fff, h = hRaw & 0x7fff, lzo = !!(wRaw & 0x8000);
  const dxt5 = type === 0xff05; if (type !== 0xff01 && !dxt5) throw new Error('Unsupported PAA type 0x' + type.toString(16));
  const need = dxt5 ? w * h : (w * h) / 2;
  let data = buf.subarray(p, p + size);
  if (lzo) data = lzo1x(data, need);
  const out = Buffer.alloc(w * h * 4); const bs = dxt5 ? 16 : 8;
  let bi = 0;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
    const o = bi * bs + (dxt5 ? 8 : 0); bi++;
    const c0 = data.readUInt16LE(o), c1 = data.readUInt16LE(o + 2);
    const col = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
    const a = col(c0), b = col(c1); const cols = [a, b];
    if (c0 > c1 || dxt5) { cols.push([(2 * a[0] + b[0]) / 3, (2 * a[1] + b[1]) / 3, (2 * a[2] + b[2]) / 3]); cols.push([(a[0] + 2 * b[0]) / 3, (a[1] + 2 * b[1]) / 3, (a[2] + 2 * b[2]) / 3]); }
    else { cols.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]); cols.push([0, 0, 0]); }
    const idx = data.readUInt32LE(o + 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const c = cols[(idx >> ((y * 4 + x) * 2)) & 3]; const px = ((by + y) * w + (bx + x)) * 4;
      out[px] = c[0]; out[px + 1] = c[1]; out[px + 2] = c[2]; out[px + 3] = 255;
    }
  }
  return { w, h, rgba: out };
}

// ---------- PNG ----------
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngEncode(w, h, rgb) { // rgb: 3 bytes per pixel
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- locating the world data ----------
function steamLibraries() {
  const libs = new Set();
  const roots = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  try { const { execSync } = require('child_process'); const out = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', { windowsHide: true }).toString(); const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/); if (m) roots.unshift(m[1].trim().replace(/\//g, '\\')); } catch { /* ignore */ }
  for (const r of roots) {
    libs.add(r);
    try { const vdf = fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8'); for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\')); } catch { /* ignore */ }
  }
  return [...libs];
}
// Candidate PBOs for a world key such as "chernarusplus", best first (largest = real tiles, not server stubs).
function findWorldData(worldKey, serverDir) {
  const name = `worlds_${worldKey}_data.pbo`; const found = [];
  const add = (p) => { try { const st = fs.statSync(p); if (st.isFile()) found.push({ path: p, size: st.size }); } catch { /* ignore */ } };
  for (const lib of steamLibraries()) add(path.join(lib, 'steamapps', 'common', 'DayZ', 'Addons', name));
  if (serverDir) {
    add(path.join(serverDir, 'addons', name));
    try { for (const d of fs.readdirSync(serverDir)) if (d.startsWith('@')) { const ad = path.join(serverDir, d, 'addons'); try { for (const f of fs.readdirSync(ad)) if (f.toLowerCase() === name.toLowerCase()) add(path.join(ad, f)); } catch { /* ignore */ } } } catch { /* ignore */ }
  }
  found.sort((a, b) => b.size - a.size);
  return found;
}

// ---------- stitching ----------
// Finds the horizontal overlap between neighbouring tiles by matching the first column of tile B against columns of tile A.
function detectOverlap(a, b) {
  const w = a.w, h = a.h; let best = 0, bestScore = Infinity;
  for (let k = 0; k <= 96; k++) {
    let s = 0; const colA = w - 1 - k;
    for (let y = 0; y < h; y += 4) { const pa = (y * w + colA) * 4, pb = (y * w) * 4; s += Math.abs(a.rgba[pa] - b.rgba[pb]) + Math.abs(a.rgba[pa + 1] - b.rgba[pb + 1]) + Math.abs(a.rgba[pa + 2] - b.rgba[pb + 2]); }
    if (s < bestScore) { bestScore = s; best = k + 1; }
  }
  return best;
}
function build({ pboPath, outPath, scale = 4, onProgress = () => {} }) {
  const pbo = readPbo(pboPath);
  const re = /^layers[\\/]s_(\d+)_(\d+)_lco\.paa$/i;
  const tiles = pbo.entries.filter(e => re.test(e.name)).map(e => { const m = e.name.match(re); return { e, x: +m[1], y: +m[2] }; });
  if (!tiles.length) throw new Error('No satellite tiles in ' + path.basename(pboPath));
  const nx = Math.max(...tiles.map(t => t.x)) + 1, ny = Math.max(...tiles.map(t => t.y)) + 1;
  const first = decodePaa(readEntry(pbo, tiles.find(t => t.x === 0 && t.y === 0).e));
  if (first.w < 64) throw new Error('This copy only has placeholder tiles (' + first.w + 'px). Install the DayZ client, or point the tool at a map mod, for the real satellite image.');
  const right = tiles.find(t => t.x === 1 && t.y === 0);
  const overlap = right ? detectOverlap(first, decodePaa(readEntry(pbo, right.e))) : 0;
  const tile = first.w, stride = tile - overlap; const half = Math.floor(overlap / 2);
  const W = Math.round((nx * stride) / scale), H = Math.round((ny * stride) / scale);
  const out = Buffer.alloc(W * H * 3);
  let done = 0;
  for (const t of tiles) {
    const img = t === tiles[0] ? first : decodePaa(readEntry(pbo, t.e));
    // tile covers world columns [t.x*stride, (t.x+1)*stride) using source pixels [half, half+stride)
    for (let oy = 0; oy < stride / scale; oy++) for (let ox = 0; ox < stride / scale; ox++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) { const px = ((half + oy * scale + sy) * img.w + (half + ox * scale + sx)) * 4; r += img.rgba[px]; g += img.rgba[px + 1]; b += img.rgba[px + 2]; }
      const n = scale * scale; const X = Math.round(t.x * stride / scale) + ox, Y = Math.round(t.y * stride / scale) + oy; if (X >= W || Y >= H) continue;
      const o = (Y * W + X) * 3; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
    done++; if (done % 32 === 0) onProgress(done / tiles.length);
  }
  fs.closeSync(pbo.fd);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, pngEncode(W, H, out));
  return { width: W, height: H, tiles: tiles.length, overlap, outPath };
}

// ---------- full-resolution tile pyramid ----------
// Writes <outDir>/<z>/<x>_<y>.jpg, 512 px tiles. The top level is the game's native resolution (one source pixel per
// map pixel, 15360 px for Chernarus); each lower level halves it, down to the whole map in one tile. The map is
// processed in 512 px strips and every level is built by streaming halved strips downwards, so memory stays small
// (a few strips) instead of holding a 15360 x 15360 image. Also writes a 3840 px PNG overview for older views.
const TILE = 512;
function downscale2(buf, w, h) { // RGBA, w x h -> ceil(w/2) x ceil(h/2), box filter
  const W = Math.ceil(w / 2), H = Math.ceil(h / 2), out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = 0; dy < 2; dy++) { const sy = 2 * y + dy; if (sy >= h) continue; for (let dx = 0; dx < 2; dx++) { const sx = 2 * x + dx; if (sx >= w) continue; const p = (sy * w + sx) * 4; r += buf[p]; g += buf[p + 1]; b += buf[p + 2]; n++; } }
    const o = (y * W + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
  return { buf: out, w: W, h: H };
}
function buildTiles({ pboPath, outDir, pngOut, quality = 82, onProgress = () => {} }) {
  const jpeg = require('jpeg-js');
  const pbo = readPbo(pboPath);
  const re = /^layers[\\/]s_(\d+)_(\d+)_lco\.paa$/i;
  const src = new Map(); for (const e of pbo.entries) { const m = e.name.match(re); if (m) src.set(Number(m[1]) + '_' + Number(m[2]), e); }
  if (!src.size) throw new Error('No satellite tiles in ' + path.basename(pboPath));
  const keys = [...src.keys()].map(k => k.split('_').map(Number));
  const nx = Math.max(...keys.map(k => k[0])) + 1, ny = Math.max(...keys.map(k => k[1])) + 1;
  const first = decodePaa(readEntry(pbo, src.get('0_0')));
  if (first.w < 64) throw new Error('This copy only has placeholder tiles (' + first.w + 'px). Install the DayZ client, or point the tool at a map mod, for the real satellite image.');
  const overlap = src.has('1_0') ? detectOverlap(first, decodePaa(readEntry(pbo, src.get('1_0')))) : 0;
  const stride = first.w - overlap, half = Math.floor(overlap / 2);
  const W = nx * stride, H = ny * stride;
  let maxZ = 0; while (TILE * Math.pow(2, maxZ) < Math.max(W, H)) maxZ++;
  fs.rmSync(outDir, { recursive: true, force: true });
  for (let z = 0; z <= maxZ; z++) fs.mkdirSync(path.join(outDir, String(z)), { recursive: true });
  // decoded source tiles of the current and previous source row (each strip touches at most two rows)
  const cache = new Map();
  const srcTile = (x, y) => { const k = x + '_' + y; if (!cache.has(k)) { const e = src.get(k); cache.set(k, e ? decodePaa(readEntry(pbo, e)) : null); } return cache.get(k); };
  const dropRowsBefore = (y) => { for (const k of [...cache.keys()]) if (Number(k.split('_')[1]) < y) cache.delete(k); };
  // overview PNG at 1/4 resolution, filled from level maxZ-2
  const ovZ = Math.max(0, maxZ - 2), ovW = Math.ceil(W / Math.pow(2, maxZ - ovZ)), ovH = Math.ceil(H / Math.pow(2, maxZ - ovZ));
  const overview = pngOut ? Buffer.alloc(ovW * ovH * 3) : null;
  const pending = {}; const rowAt = {}; let written = 0;
  const totalTiles = (() => { let n = 0; for (let z = 0; z <= maxZ; z++) { const s = Math.pow(2, z - maxZ); n += Math.ceil(W * s / TILE) * Math.ceil(H * s / TILE); } return n; })();
  function writeStrip(z, buf, w, h) {
    const ty = rowAt[z] || 0; rowAt[z] = ty + 1;
    for (let tx = 0; tx * TILE < w; tx++) {
      const tw = Math.min(TILE, w - tx * TILE), tile = Buffer.alloc(tw * h * 4);
      for (let y = 0; y < h; y++) buf.copy(tile, y * tw * 4, (y * w + tx * TILE) * 4, (y * w + tx * TILE + tw) * 4);
      fs.writeFileSync(path.join(outDir, String(z), `${tx}_${ty}.jpg`), jpeg.encode({ data: tile, width: tw, height: h }, quality).data);
      written++;
    }
    if (overview && z === ovZ) { for (let y = 0; y < h; y++) { const oy = ty * TILE + y; if (oy >= ovH) break; for (let x = 0; x < w && x < ovW; x++) { const s = (y * w + x) * 4, o = (oy * ovW + x) * 3; overview[o] = buf[s]; overview[o + 1] = buf[s + 1]; overview[o + 2] = buf[s + 2]; } } }
    onProgress(written / totalTiles);
    if (z === 0) return;
    // halve the strip and stack it into the level below; a full 512 px strip there gets written in turn
    const d = downscale2(buf, w, h); const p = pending[z - 1];
    if (!p) pending[z - 1] = d; else { const merged = Buffer.concat([p.buf, d.buf]); pending[z - 1] = { buf: merged, w: d.w, h: p.h + d.h }; }
    if (pending[z - 1].h >= TILE) { const q = pending[z - 1]; pending[z - 1] = null; writeStrip(z - 1, q.buf, q.w, q.h); }
  }
  for (let sy = 0; sy * TILE < H; sy++) {
    const y0 = sy * TILE, h = Math.min(TILE, H - y0), strip = Buffer.alloc(W * h * 4);
    for (let y = 0; y < h; y++) {
      const wy = y0 + y, ty = Math.floor(wy / stride), py = half + (wy - ty * stride);
      for (let tx = 0; tx < nx; tx++) {
        const img = srcTile(tx, ty); const dst = (y * W + tx * stride) * 4;
        if (!img) continue;
        img.rgba.copy(strip, dst, (py * img.w + half) * 4, (py * img.w + half + stride) * 4);
      }
    }
    for (let i = 3; i < strip.length; i += 4) strip[i] = 255;
    dropRowsBefore(Math.floor(y0 / stride));
    writeStrip(maxZ, strip, W, h);
  }
  // flush partial strips left in the lower levels
  for (let z = maxZ - 1; z >= 0; z--) { const q = pending[z]; if (q && q.h) { pending[z] = null; writeStrip(z, q.buf, q.w, q.h); } }
  fs.closeSync(pbo.fd);
  const meta = { version: 1, tile: TILE, width: W, height: H, maxZ, minZ: 0, tiles: written, overlap, builtAt: Date.now(), source: path.basename(pboPath) };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  if (overview) { fs.mkdirSync(path.dirname(pngOut), { recursive: true }); fs.writeFileSync(pngOut, pngEncode(ovW, ovH, overview)); }
  return { ...meta, outDir, pngOut };
}

// ---------- worker entry ----------
if (require('worker_threads') && !require('worker_threads').isMainThread && require('worker_threads').workerData && require('worker_threads').workerData.mapbuild) {
  const { parentPort, workerData } = require('worker_threads');
  const job = workerData.mapbuild;
  try { const r = (job.tiles ? buildTiles : build)({ ...job, onProgress: p => parentPort.postMessage({ progress: p }) }); parentPort.postMessage({ done: r }); }
  catch (e) { parentPort.postMessage({ error: e.message }); }
}
function buildAsync(opts, onProgress) {
  return new Promise((resolve, reject) => {
    const { Worker } = require('worker_threads');
    const w = new Worker(__filename, { workerData: { mapbuild: opts } });
    w.on('message', m => { if (m.progress !== undefined) onProgress && onProgress(m.progress); else if (m.done) resolve(m.done); else if (m.error) reject(new Error(m.error)); });
    w.on('error', reject);
  });
}

module.exports = { findWorldData, build, buildTiles, buildAsync };
