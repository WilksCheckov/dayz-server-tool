'use strict';
// BattlEye RCon client (UDP). Protocol: "BE" + CRC32(LE) of (0xFF + payload) + 0xFF + payload.
// payload: 0x00 login | 0x01 seq command | 0x02 seq message (server -> client, must be acked).
const dgram = require('dgram');
const settings = require('./settings');
const alerts = require('./alerts');

let emitRef = () => {};
let sock = null;
let state = { connected: false, host: '', port: 0, error: null, lastSeen: null };
let seq = 0;
const pending = new Map(); // seq -> { resolve, reject, parts, timer }
let keepalive = null;
let loginResolver = null;

// CRC32 table (zlib polynomial) so we do not depend on newer Node builtins.
const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function packet(payload) {
  const body = Buffer.concat([Buffer.from([0xFF]), payload]);
  const head = Buffer.alloc(6);
  head.write('BE', 0, 'ascii');
  head.writeUInt32LE(crc32(body), 2);
  return Buffer.concat([head, body]);
}

function send(payload) {
  if (!sock) return;
  sock.send(packet(payload), state.port, state.host, err => { if (err) setError(err.message); });
}

function setError(msg) {
  state.error = msg;
  emitRef('rcon:state', status());
}

function cfg() {
  const s = settings.load();
  return { host: '127.0.0.1', port: 2306, password: '', autoConnect: true, autoConfigure: true, ...(s.rcon || {}) };
}

function status() { return { ...state, config: { ...cfg(), password: cfg().password ? '••••' : '' } }; }

function connect(opts = {}) {
  const c = { ...cfg(), ...opts };
  if (!c.password) return Promise.reject(new Error('RCon password is empty. Set it in battleye\\BEServer_x64.cfg and here.'));
  disconnect(true);
  state = { connected: false, host: c.host, port: Number(c.port), error: null, lastSeen: null };
  sock = dgram.createSocket('udp4');
  sock.on('message', onMessage);
  sock.on('error', e => { setError(e.message); disconnect(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { loginResolver = null; setError('Login timed out. Is the server running with BattlEye and the RCon port open?'); disconnect(); reject(new Error(state.error)); }, 5000);
    loginResolver = ok => {
      clearTimeout(timer); loginResolver = null;
      if (ok) {
        state.connected = true; state.error = null; state.lastSeen = Date.now();
        keepalive = setInterval(() => { command('').catch(() => {}); }, 30000);
        emitRef('rcon:state', status());
        emitRef('console', { source: 'rcon', line: `Connected to ${state.host}:${state.port}` });
        resolve(status());
      } else { setError('Login failed: wrong RCon password.'); disconnect(); reject(new Error(state.error)); }
    };
    send(Buffer.concat([Buffer.from([0x00]), Buffer.from(c.password, 'utf8')]));
  });
}

function disconnect(silent = false) {
  clearInterval(keepalive); keepalive = null;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Disconnected')); }
  pending.clear();
  if (sock) { try { sock.close(); } catch { /* ignore */ } sock = null; }
  const was = state.connected;
  state.connected = false;
  if (!silent) { emitRef('rcon:state', status()); if (was) emitRef('console', { source: 'rcon', line: 'Disconnected' }); }
}

function onMessage(msg) {
  if (msg.length < 8 || msg[0] !== 0x42 || msg[1] !== 0x45 || msg[6] !== 0xFF) return;
  if (crc32(msg.subarray(6)) !== msg.readUInt32LE(2)) return;
  state.lastSeen = Date.now();
  const type = msg[7];
  if (type === 0x00) { if (loginResolver) loginResolver(msg[8] === 0x01); return; }
  if (type === 0x02) {
    const s = msg[8];
    const text = msg.subarray(9).toString('utf8');
    send(Buffer.from([0x02, s]));
    emitRef('rcon:message', { text, at: Date.now() });
    emitRef('console', { source: 'rcon', line: text });
    return;
  }
  if (type === 0x01) {
    const s = msg[8];
    const p = pending.get(s);
    if (!p) return;
    if (msg.length > 9 && msg[9] === 0x00) {
      // multi-part: 0x00 count index data
      const count = msg[10], index = msg[11];
      p.parts[index] = msg.subarray(12).toString('utf8');
      if (Object.keys(p.parts).length < count) return;
      finish(s, p, Array.from({ length: count }, (_, i) => p.parts[i] || '').join(''));
      return;
    }
    finish(s, p, msg.subarray(9).toString('utf8'));
  }
}

function finish(s, p, text) { clearTimeout(p.timer); pending.delete(s); p.resolve(text); }

function command(cmd, timeoutMs = 4000) {
  if (!sock || (!state.connected && cmd !== '')) return Promise.reject(new Error('RCon is not connected.'));
  return new Promise((resolve, reject) => {
    const s = seq; seq = (seq + 1) & 0xFF;
    const timer = setTimeout(() => { pending.delete(s); if (cmd === '') { setError('Keep-alive timed out; connection lost.'); disconnect(); alerts.alert('rcon-lost', 'RCon connection lost', 'Keep-alive timed out. Is the server still running?'); } reject(new Error('RCon command timed out.')); }, timeoutMs);
    pending.set(s, { resolve, reject, parts: {}, timer });
    send(Buffer.concat([Buffer.from([0x01, s]), Buffer.from(cmd, 'utf8')]));
  });
}

// ----- helpers around common commands -----
async function players() {
  const out = await command('players');
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+)\s+(\S+)\s+(\d+)\s+(\S+?)(\(OK\)|\(\?\))?\s+(.*?)(\s+\(Lobby\))?\s*$/);
    if (!m) continue;
    list.push({ num: Number(m[1]), ip: m[2], ping: Number(m[3]), guid: m[4], verified: m[5] === '(OK)', name: m[6], lobby: !!m[7] });
  }
  try { require('./accounts').record(list); } catch { /* ignore */ }
  return { raw: out, players: list };
}

async function bans() {
  const out = await command('bans');
  const guid = [], ip = [];
  let section = null;
  for (const line of out.split('\n')) {
    if (/^GUID Bans/i.test(line)) { section = guid; continue; }
    if (/^IP Bans/i.test(line)) { section = ip; continue; }
    const m = line.match(/^(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (m && section) section.push({ num: Number(m[1]), id: m[2], minutes: m[3], reason: m[4] });
  }
  return { raw: out, guid, ip };
}

const say = (msg, player = -1) => command(`say ${player} ${msg}`);
const kick = (num, reason = '') => command(`kick ${num} ${reason}`.trim());
const ban = (num, minutes = 0, reason = '') => command(`ban ${num} ${minutes} ${reason}`.trim());
const addBan = (guid, minutes = 0, reason = '') => command(`addBan ${guid} ${minutes} ${reason}`.trim());

// ---------- automatic configuration from battleye\BEServer_x64.cfg ----------
// BattlEye reads RConPassword / RConPort from that file when the server starts (DayZ may rename it to
// BEServer_x64_active_*.cfg while running). The tool keeps its own settings and that file in step, creating
// a password when neither has one, so RCon works without any manual setup.
const fsx = require('fs'); const pathx = require('path');
function beDir() { return pathx.join(settings.paths().serverDir, 'battleye'); }
function beFiles() { try { return fsx.readdirSync(beDir()).filter(f => /^beserver_x64(?:_active_[a-z0-9]+)?\.cfg$/i.test(f)).map(f => pathx.join(beDir(), f)); } catch { return []; } }
function readBe() {
  for (const f of beFiles()) {
    try { const t = fsx.readFileSync(f, 'utf8'); const pw = t.match(/^\s*RConPassword\s+(\S+)/mi), port = t.match(/^\s*RConPort\s+(\d+)/mi); if (pw || port) return { file: f, password: pw ? pw[1] : '', port: port ? Number(port[1]) : null }; } catch { /* next */ }
  }
  return null;
}
function writeBe(password, port) {
  const dir = beDir(); fsx.mkdirSync(dir, { recursive: true });
  const main = pathx.join(dir, 'BEServer_x64.cfg');
  let text = ''; try { text = fsx.readFileSync(main, 'utf8'); } catch { /* new file */ }
  const set = (key, val) => { const re = new RegExp('^\\s*' + key + '\\s+.*$', 'mi'); text = re.test(text) ? text.replace(re, key + ' ' + val) : (text.replace(/\s*$/, '') + (text ? '\r\n' : '') + key + ' ' + val); };
  set('RConPassword', password); set('RConPort', String(port)); if (!/^\s*RestrictRCon\s/mi.test(text)) set('RestrictRCon', '0');
  fsx.writeFileSync(main, text.replace(/\s*$/, '') + '\r\n', 'utf8');
  // an _active_ copy is what a running server actually reads; keep it in step too
  for (const f of beFiles()) if (f !== main) { try { fsx.writeFileSync(f, fsx.readFileSync(main, 'utf8')); } catch { /* ignore */ } }
  return main;
}
// Make the tool's settings and the BattlEye file agree. Returns what happened.
function newPassword() { return require('crypto').randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16); }
// Each install gets its own random password, generated once and kept. regenerate: true replaces it with a new one.
function ensureConfigured({ regenerate = false } = {}) {
  const c = cfg(); if (c.autoConfigure === false) return { action: 'off' };
  const be = readBe();
  let password = c.password, port = Number(c.port) || 2306, action = 'ok';
  if (regenerate) { password = newPassword(); action = 'regenerated'; }
  if (!password && be && be.password) { password = be.password; if (be.port) port = be.port; action = 'from-battleye'; }
  if (!password) { password = newPassword(); action = 'generated'; }
  const needWrite = !be || be.password !== password || be.port !== port;
  if (needWrite) { try { writeBe(password, port); if (action === 'ok') action = 'wrote-battleye'; } catch (e) { return { action: 'error', error: e.message }; } }
  if (password !== c.password || port !== c.port || c.autoConnect !== true) settings.save({ rcon: { ...c, password, port, host: c.host || '127.0.0.1', autoConnect: true } });
  if (action !== 'ok') emitRef('console', { source: 'rcon', line: action === 'regenerated' ? `RCon: new random password written to battleye\BEServer_x64.cfg (port ${port}). Restart the server for BattlEye to pick it up.` : action === 'generated' ? `RCon configured: created a password in battleye\\BEServer_x64.cfg (port ${port}).` : action === 'from-battleye' ? `RCon configured from battleye\\BEServer_x64.cfg (port ${port}).` : `RCon: battleye\\BEServer_x64.cfg updated to match the tool's settings (port ${port}).` });
  return { action, port, file: pathx.join(beDir(), 'BEServer_x64.cfg') };
}
// Connect on its own once the server is up: retry every 15 s for up to 10 minutes, stop when connected or the server stops.
let autoTimer = null, autoUntil = 0;
function autoConnectLoop() {
  const c = cfg(); if (!c.autoConnect || !c.password) return;
  clearInterval(autoTimer); autoUntil = Date.now() + 10 * 60000;
  const attempt = () => { if (state.connected) { clearInterval(autoTimer); autoTimer = null; return; } if (Date.now() > autoUntil) { clearInterval(autoTimer); autoTimer = null; emitRef('console', { source: 'rcon', line: 'RCon: gave up auto-connecting after 10 minutes. Check the RCon port and BattlEye.' }); return; } connect().catch(() => {}); };
  setTimeout(attempt, 20000); autoTimer = setInterval(attempt, 15000);
}
function stopAuto() { clearInterval(autoTimer); autoTimer = null; }
function init(emit) {
  emitRef = emit;
  try { ensureConfigured(); } catch { /* server not installed yet */ }
  if (cfg().autoConnect && cfg().password) setTimeout(() => connect().catch(() => {}), 3000);
}

module.exports = { init, connect, disconnect, command, status, players, bans, say, kick, ban, addBan, cfg, crc32, ensureConfigured, autoConnectLoop, stopAuto };
