'use strict';
// Map sharing between your own tools. A PC with the DayZ client builds full-resolution map tiles and sends them to a
// server's tool through that server's website. Uploads are signed: HMAC-SHA256 over a timestamp, the map name and the
// SHA-256 of the zip, with the receiving tool's link key. The key never travels, an old upload cannot be replayed, and
// nothing unsigned is unpacked.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const settings = require('./settings');

const MAX_UPLOAD = 400 * 1024 * 1024;
const SKEW_MS = 10 * 60 * 1000;
let emitRef = () => {};
let state = { sending: false, last: null, error: null, at: 0 };
const log = line => emitRef('console', { source: 'maps', line });

function cfg() { const m = settings.load().mapLink || {}; return { ownKey: m.ownKey || '', target: { url: '', key: '', auto: true, ...(m.target || {}) } }; }
function save(partial) { const c = cfg(); settings.save({ mapLink: { ...c, ...partial, target: { ...c.target, ...((partial || {}).target || {}) } } }); }
// This tool's key for receiving maps (created on first use).
function ownKey() { let k = cfg().ownKey; if (!/^[0-9a-f]{64}$/.test(k)) { k = crypto.randomBytes(32).toString('hex'); save({ ownKey: k }); } return k; }
function newOwnKey() { save({ ownKey: crypto.randomBytes(32).toString('hex') }); return ownKey(); }
const keyId = k => crypto.createHash('sha256').update(k).digest('hex').slice(0, 12);
const sign = (key, ts, map, sha) => crypto.createHmac('sha256', key).update(`${ts}\n${map}\n${sha}`).digest('hex');

function mapsDir() { return path.join(settings.load().installDir, 'maps'); }
function tilesDir(key) { return path.join(mapsDir(), key, 'tiles'); }
function tilesMeta(key) { try { return JSON.parse(fs.readFileSync(path.join(tilesDir(key), 'meta.json'), 'utf8')); } catch { return null; } }
const validKey = k => /^[a-z0-9_]{1,40}$/.test(String(k || ''));

// ---------- receiving side (called by the website) ----------
async function handleUpload(req, res, url, send) {
  const json = (code, obj) => send(code, 'application/json', JSON.stringify(obj));
  if (req.method !== 'POST') return json(405, { error: 'POST required' });
  const map = String(url.searchParams.get('map') || '').toLowerCase();
  const ts = Number(req.headers['x-dzat-time']), sig = String(req.headers['x-dzat-sign'] || ''), kid = String(req.headers['x-dzat-key-id'] || '');
  const len = Number(req.headers['content-length']);
  const key = ownKey();
  // cheap checks first, before reading a byte of the body
  if (!validKey(map)) return json(400, { error: 'bad map name' });
  if (kid !== keyId(key)) return json(403, { error: 'This server does not know that link key. Copy the key from the server tool again.' });
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SKEW_MS) return json(403, { error: 'Request too old or clock difference over 10 minutes.' });
  if (!/^[0-9a-f]{64}$/.test(sig)) return json(403, { error: 'missing signature' });
  if (!Number.isFinite(len) || len <= 0 || len > MAX_UPLOAD) return json(413, { error: 'upload size missing or too large' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dzat-map-')); const zipPath = path.join(tmp, 'upload.zip');
  try {
    const hash = crypto.createHash('sha256'); let got = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      req.on('data', d => { got += d.length; if (got > MAX_UPLOAD) { req.destroy(); reject(new Error('too large')); return; } hash.update(d); out.write(d); });
      req.on('end', () => out.end(resolve)); req.on('error', reject);
    });
    const expect = sign(key, ts, map, hash.digest('hex'));
    if (!crypto.timingSafeEqual(Buffer.from(expect, 'hex'), Buffer.from(sig, 'hex'))) return json(403, { error: 'bad signature' });
    // unpack (Windows tar refuses absolute paths and ".." entries) and accept only the expected file names
    const ex = path.join(tmp, 'x'); fs.mkdirSync(ex);
    await require('./zip').unzip(zipPath, ex);
    const bad = []; const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) { if (!/^(tiles|tiles\/\d{1,2})$/.test(r)) bad.push(r); else walk(path.join(d, e.name), r); } else if (!/^(overview\.png|tiles\/meta\.json|tiles\/\d{1,2}\/\d{1,3}_\d{1,3}\.jpg)$/.test(r)) bad.push(r); } };
    walk(ex);
    if (bad.length) return json(400, { error: 'unexpected files in upload: ' + bad.slice(0, 3).join(', ') });
    const meta = JSON.parse(fs.readFileSync(path.join(ex, 'tiles', 'meta.json'), 'utf8'));
    if (!meta || !(meta.maxZ >= 0) || !(meta.width > 0)) return json(400, { error: 'meta.json invalid' });
    // swap the new tiles in
    const dest = tilesDir(map); fs.mkdirSync(path.dirname(dest), { recursive: true });
    const old = dest + '.old'; fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(path.join(ex, 'tiles'), dest); fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(path.join(ex, 'overview.png'))) {
      for (const e of ['png', 'jpg', 'jpeg', 'webp']) { try { fs.unlinkSync(path.join(mapsDir(), map + '.' + e)); } catch { /* none */ } }
      fs.copyFileSync(path.join(ex, 'overview.png'), path.join(mapsDir(), map + '.png'));
    }
    log(`Received the ${map} map (${meta.tiles} tiles, ${meta.width} px) from another of your tools.`);
    try { require('./audit').log('web', 'map link', 'maps:received', `${map}: ${meta.tiles} tiles`); } catch { /* ignore */ }
    emitRef('maps:changed', { map });
    return json(200, { ok: true, map, tiles: meta.tiles });
  } catch (e) { return json(500, { error: e.message }); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
}
// What this server's map is and which tiles it has (merged into /api/status.json).
function publicMapInfo() {
  try { const key = require('./mission').mapInfo().map; if (!key) return null; const m = tilesMeta(key); return { key, tilesBuiltAt: m ? m.builtAt : null, tiles: m ? m.tiles : 0 }; } catch { return null; }
}

// ---------- sending side ----------
function normUrl(u) { u = String(u || '').trim().replace(/\/+$/, ''); if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u; return u; }
async function send({ force = false, by = 'app' } = {}) {
  const t = cfg().target; const base = normUrl(t.url);
  if (!base || !/^[0-9a-f]{64}$/.test(t.key)) throw new Error('Set the server address and its link key first (Settings → Map sharing).');
  if (state.sending) return { action: 'busy' };
  state = { ...state, sending: true, error: null }; emitRef('maplink:state', status());
  try {
    let remote; try { remote = await (await fetch(base + '/api/status.json', { signal: AbortSignal.timeout(15000) })).json(); } catch (e) { throw new Error(`Could not reach ${base} (${e.message}). Is the server's website running and its port open?`); }
    const map = remote && remote.map && remote.map.key; if (!validKey(map)) throw new Error('The server did not say which map it runs (update its tool to this version).');
    // build here when needed (this PC must have the DayZ client)
    let meta = tilesMeta(map);
    if (!meta) { log(`Building the ${map} map tiles to send to the server…`); await require('./mission').buildMapImage({ force: true, key: map }); meta = tilesMeta(map); }
    if (!meta) throw new Error(`No ${map} tiles to send.`);
    if (!force && remote.map.tilesBuiltAt && remote.map.tilesBuiltAt >= meta.builtAt) { state.last = { at: Date.now(), map, action: 'up-to-date' }; return { action: 'up-to-date', map }; }
    // zip tiles + overview
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dzat-mapsend-')); const stage = path.join(tmp, 's'); fs.mkdirSync(stage);
    try {
      fs.cpSync(tilesDir(map), path.join(stage, 'tiles'), { recursive: true });
      const ov = path.join(mapsDir(), map + '.png'); if (fs.existsSync(ov)) fs.copyFileSync(ov, path.join(stage, 'overview.png'));
      const zipPath = path.join(tmp, 'map.zip'); await require('./zip').zipDir(stage, zipPath);
      const body = fs.readFileSync(zipPath); const sha = crypto.createHash('sha256').update(body).digest('hex'); const ts = Date.now();
      log(`Sending the ${map} map to ${base} (${(body.length / 1048576).toFixed(0)} MB)…`);
      const r = await fetch(`${base}/api/maptiles?map=${encodeURIComponent(map)}`, { method: 'POST', body, headers: { 'Content-Type': 'application/zip', 'X-DZAT-Time': String(ts), 'X-DZAT-Key-Id': keyId(t.key), 'X-DZAT-Sign': sign(t.key, ts, map, sha) }, signal: AbortSignal.timeout(30 * 60000) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
      log(`The server now has the full-resolution ${map} map (${out.tiles} tiles).`);
      try { require('./audit').log('app', by, 'maps:sent', `${map} to ${base}`); } catch { /* ignore */ }
      state.last = { at: Date.now(), map, action: 'sent' };
      return { action: 'sent', map, tiles: out.tiles };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } catch (e) { state.error = e.message; throw e; }
  finally { state.sending = false; state.at = Date.now(); emitRef('maplink:state', status()); }
}
function status() { const c = cfg(); return { ...state, target: { url: c.target.url, auto: c.target.auto !== false, hasKey: /^[0-9a-f]{64}$/.test(c.target.key) } }; }
function setTarget(t) { const cur = cfg().target; save({ target: { url: normUrl(t.url), key: t.key === undefined || t.key === null ? cur.key : String(t.key).trim().toLowerCase(), auto: t.auto !== false } }); return status(); }
// Automatic: shortly after start and every 30 minutes, if a target is set.
let timer = null;
function autoTick() { const t = cfg().target; if (!t.auto || !t.url || !t.key) return; send({ by: 'auto' }).then(r => { if (r.action === 'up-to-date') emitRef('maplink:state', status()); }).catch(e => log('Map sharing: ' + e.message)); }
function init(emit) { emitRef = emit; clearInterval(timer); setTimeout(autoTick, 120000); timer = setInterval(autoTick, 30 * 60000); }
module.exports = { init, ownKey, newOwnKey, keyId, handleUpload, publicMapInfo, send, status, setTarget, tilesMeta, tilesDir };
