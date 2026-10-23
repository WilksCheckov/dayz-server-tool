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
  const c = { ...sessionCreds(), ...opts };
  if (!c.password) return Promise.reject(new Error('RCon password is empty. Use "Sync with BEServer_x64.cfg" on the Players page.'));
  disconnect(true);
  state = { connected: false, host: c.host, port: Number(c.port), error: null, lastSeen: null, diag: state.diag || null };
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

// ---------- BattlEye config: one pinned folder, written before each start ----------
// The tool launches the server with -BEpath=<server>\battleye, so BattlEye reads exactly one config file there
// (renamed to BEServer_x64_active_<n>.cfg while it runs). Without the pin BattlEye picks <profiles>\BattlEye,
// so both folders are kept when pinning is off or the operator passes their own -BEpath.
const fsx = require('fs'); const pathx = require('path');
function serverRunning() { try { return !!require('./server').status().running; } catch { return false; } }
function serverStartedAt() { try { return require('./server').status().startedAt || 0; } catch { return 0; } }
function pinnedBeDir(s = settings.load()) {
  const p = settings.paths(s);
  const own = String(s.extraParams || '').match(/-BEpath=("([^"]+)"|(\S+))/i);
  if (own) { const d = own[2] || own[3]; return { dir: pathx.isAbsolute(d) ? d : pathx.join(p.serverDir, d), ours: false }; }
  if ((s.rcon || {}).pinBePath === false) return null;
  return { dir: pathx.join(p.serverDir, 'battleye'), ours: true };
}
// launch argument the server needs for the pin (null when the operator set their own or turned pinning off)
function beArg(s = settings.load()) { const pin = pinnedBeDir(s); return pin && pin.ours ? `-BEpath=${pin.dir}` : null; }
function beDirs() { const pin = pinnedBeDir(); if (pin) return [pin.dir]; const p = settings.paths(); return [pathx.join(p.profilesDir, 'BattlEye'), pathx.join(p.serverDir, 'battleye')]; }
function beFiles(dirs = beDirs()) { const out = []; for (const d of dirs) { try { for (const f of fsx.readdirSync(d)) if (/^beserver_x64(?:_active_[a-z0-9]+)?\.cfg$/i.test(f)) out.push(pathx.join(d, f)); } catch { /* no folder */ } } return out; }
function beLines(text) { return String(text || '').split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean); }
function beParse(text) {
  const out = {};
  for (const l of beLines(text)) { const m = l.match(/^(\w+)\s+(.*)$/); if (m) out[m[1].toLowerCase()] = m[2].trim(); }
  return out;
}
function readBe() {
  for (const f of beFiles()) {
    try { const kv = beParse(fsx.readFileSync(f, 'utf8')); if (kv.rconpassword || kv.rconport) return { file: f, password: kv.rconpassword || '', port: kv.rconport ? Number(kv.rconport) : null }; } catch { /* next */ }
  }
  return null;
}
// The config BattlEye actually loaded for the running server: the newest _active_ copy written since the start.
function readActive() {
  const since = serverStartedAt() - 10000;
  const all = [...new Set(beFiles([...beDirs(), ...(() => { const p = settings.paths(); return [pathx.join(p.profilesDir, 'BattlEye'), pathx.join(p.serverDir, 'battleye')]; })()]))];
  const act = all.filter(f => /_active_/i.test(f)).map(f => { try { const st = fsx.statSync(f); return { f, m: Math.max(st.mtimeMs, st.ctimeMs), fresh: !since || Math.max(st.mtimeMs, st.ctimeMs) >= since }; } catch { return null; } }).filter(Boolean).sort((a, b) => (b.fresh - a.fresh) || (b.m - a.m))[0];
  if (!act) return null;
  try { const kv = beParse(fsx.readFileSync(act.f, 'utf8')); return { file: act.f, password: kv.rconpassword || '', port: kv.rconport ? Number(kv.rconport) : null }; } catch { return null; }
}
// Canonical file: one "Key value" per line, CRLF, our keys first, anything else the admin added kept as is.
function beRender(text, password, port) {
  const keep = beLines(text).filter(l => !/^(RConPassword|RConPort|RestrictRCon)\s/i.test(l));
  const restrict = (beLines(text).find(l => /^RestrictRCon\s/i.test(l)) || 'RestrictRCon 0');
  return ['RConPassword ' + password, 'RConPort ' + port, restrict, ...keep].join('\r\n') + '\r\n';
}
function writeBe(password, port) {
  let first = null, next = null;
  for (const dir of beDirs()) {
    fsx.mkdirSync(dir, { recursive: true });
    const main = pathx.join(dir, 'BEServer_x64.cfg');
    let text = ''; try { text = fsx.readFileSync(main, 'utf8'); } catch { /* new file */ }
    if (!next) next = beRender(text, password, port);
    if (next !== text) fsx.writeFileSync(main, next, 'utf8');
    // a silent write failure (protected folder, other user) must not pass unnoticed
    if (fsx.readFileSync(main, 'utf8') !== next) throw new Error(`Could not write ${main} (permissions?).`);
    if (!first) first = main;
  }
  return first;
}
function newPassword() { return require('crypto').randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16); }
// Credentials the server was started with; filled in before each start, corrected from the active file after it.
let session = null; // { password, port, from: 'start' | 'active' }

// Make the tool's settings and the BattlEye file agree before a start. While the server runs nothing is written:
// BattlEye only reads its config at start, so a change then would only create a mismatch. A new password asked for
// during a run is kept as pending and applied at the next start.
function ensureConfigured({ regenerate = false } = {}) {
  const c = cfg(); if (c.autoConfigure === false) return { action: 'off' };
  if (serverRunning()) {
    if (regenerate) {
      settings.save({ rcon: { ...c, pendingPassword: newPassword() } });
      emitRef('console', { source: 'rcon', line: 'RCon: a new random password is saved and takes effect at the next server start. Until then RCon keeps the password the server started with.' });
      return { action: 'pending' };
    }
    const act = readActive();
    return { action: 'running', port: (act && act.port) || (session && session.port) || Number(c.port) || 2306, active: act ? act.file : null };
  }
  const be = readBe();
  let password = c.password, port = Number(c.port) || 2306, action = 'ok';
  if (c.pendingPassword) { password = c.pendingPassword; action = 'regenerated'; }
  if (regenerate) { password = newPassword(); action = 'regenerated'; }
  if (!password && be && be.password) { password = be.password; if (be.port) port = be.port; action = 'from-battleye'; }
  if (!password) { password = newPassword(); action = 'generated'; }
  let needWrite = !be || be.password !== password || be.port !== port;
  if (!needWrite) { for (const dir of beDirs()) { try { const raw = fsx.readFileSync(pathx.join(dir, 'BEServer_x64.cfg'), 'utf8'); if (beRender(raw, password, port) !== raw) needWrite = true; } catch { needWrite = true; } } }
  if (needWrite) { try { writeBe(password, port); if (action === 'ok') action = 'wrote-battleye'; } catch (e) { emitRef('console', { source: 'rcon', line: 'RCon: ' + e.message }); return { action: 'error', error: e.message }; } }
  // stale _active_ copies from a server that did not shut down cleanly would be read as the loaded config
  for (const f of beFiles()) if (/_active_/i.test(f)) { try { fsx.unlinkSync(f); } catch { /* in use */ } }
  try { const configs = require('./configs'); const cur = configs.cfgFormRead(); if (cur && cur.exists && cur.values && cur.values.BattlEye !== 1 && cur.values.BattlEye !== true) { configs.cfgFormWrite({ BattlEye: 1 }); emitRef('console', { source: 'rcon', line: 'RCon: BattlEye was off in serverDZ.cfg; turned it on, RCon needs it.' }); } } catch { /* config not readable yet */ }
  const next = { ...c, password, port, host: c.host || '127.0.0.1', autoConnect: true }; delete next.pendingPassword;
  if (password !== c.password || port !== c.port || c.autoConnect !== true || c.pendingPassword) settings.save({ rcon: next });
  session = { password, port, from: 'start' };
  const file = pathx.join(beDirs()[0], 'BEServer_x64.cfg');
  if (action !== 'ok') emitRef('console', { source: 'rcon', line: action === 'regenerated' ? `RCon: new random password written to ${file} (port ${port}).` : action === 'generated' ? `RCon configured: created a password in ${file} (port ${port}).` : action === 'from-battleye' ? `RCon configured from ${file} (port ${port}).` : `RCon: ${file} updated to match the tool's settings (port ${port}).` });
  return { action, port, file };
}
// The Config Editor saved a BEServer_x64.cfg by hand: adopt its values (now when stopped, at the next start when running).
function adoptFromFile(text) {
  const kv = beParse(text); if (!kv.rconpassword && !kv.rconport) return null;
  const c = cfg();
  if (serverRunning()) {
    if (kv.rconpassword && kv.rconpassword !== c.password) settings.save({ rcon: { ...c, pendingPassword: kv.rconpassword, ...(kv.rconport ? { port: Number(kv.rconport) } : {}) } });
    emitRef('console', { source: 'rcon', line: 'RCon: BattlEye config saved. BattlEye reads it at the next server start; until then RCon keeps the password the server started with.' });
    return { action: 'pending' };
  }
  settings.save({ rcon: { ...c, ...(kv.rconpassword ? { password: kv.rconpassword } : {}), ...(kv.rconport ? { port: Number(kv.rconport) } : {}) } });
  return { action: 'adopted' };
}
// What to log in with right now: the loaded (active) config when the local server runs, else the settings.
function sessionCreds() {
  const c = cfg();
  const local = /^(127\.|localhost$|::1$)/.test(String(c.host || '127.0.0.1'));
  if (local && serverRunning()) {
    const act = readActive();
    if (act && act.password) return { host: c.host || '127.0.0.1', port: act.port || 2306, password: act.password, from: 'active' };
    if (session) return { host: c.host || '127.0.0.1', port: session.port, password: session.password, from: session.from };
  }
  return { host: c.host || '127.0.0.1', port: Number(c.port) || 2306, password: c.password, from: 'settings' };
}

// ---------- connect when the server is ready, and say which step is failing ----------
function fmtElapsed(ms) { const s = Math.round(ms / 1000); return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s'; }
function setDiag(step, text) { state.diag = { step, text, at: Date.now() }; emitRef('rcon:state', status()); }
function udpListening(port) {
  try { const out = require('child_process').execSync('netstat -an -p udp', { encoding: 'utf8', windowsHide: true, timeout: 8000 }); return new RegExp(':' + port + '\\s').test(out); } catch { return null; }
}
function rptActive(withinMs = 120000) {
  try { const p = settings.paths(); const m = fsx.readdirSync(p.profilesDir).filter(f => /\.rpt$/i.test(f)).map(f => fsx.statSync(pathx.join(p.profilesDir, f)).mtimeMs).sort((a, b) => b - a)[0]; return !!m && Date.now() - m < withinMs; } catch { return false; }
}
function whyNoPort(port) {
  const reasons = [];
  try { const cur = require('./configs').cfgFormRead(); if (cur && cur.values && cur.values.BattlEye !== 1 && cur.values.BattlEye !== true) reasons.push('BattlEye is off in serverDZ.cfg (BattlEye = 1 is missing)'); } catch { /* ignore */ }
  const dirs = beDirs();
  if (!dirs.some(d => fsx.existsSync(pathx.join(d, 'BEServer_x64.dll')))) reasons.push(`BEServer_x64.dll is missing in ${dirs[0]}`);
  if (!readActive()) reasons.push('BattlEye has not loaded its config (no BEServer_x64_active_*.cfg appeared)');
  return reasons.length ? reasons.join('; ') : `something else is stopping BattlEye from opening port ${port}; check the server console for BattlEye errors`;
}
let auto = { timer: null, startedAt: 0, timeouts: 0, wrongPw: 0, busy: false };
async function attempt() {
  if (auto.busy) return; auto.busy = true;
  try {
    if (state.connected) { stopAuto(); return; }
    if (!serverRunning()) { setDiag('stopped', 'The server is not running.'); stopAuto(); return; }
    const creds = sessionCreds();
    if (!creds.password) { setDiag('failed', 'No RCon password is set. Use "Sync with BEServer_x64.cfg" on the Players page, then restart the server.'); stopAuto(); return; }
    const mins = Math.round((Date.now() - auto.startedAt) / 60000);
    let stg = null; try { stg = require('./server').status().stage; } catch { /* ignore */ }
    if (stg && !stg.ready) {
      // fall back to plain retries when the server log cannot be followed, or a stage never ends
      const noLog = stg.key === 'starting' && Date.now() - auto.startedAt > 3 * 60000;
      const stuck = Date.now() - stg.at > 30 * 60000;
      if (!noLog && !stuck) { setDiag('loading', `Server loading: ${stg.label} (step ${stg.index} of ${stg.total}, ${fmtElapsed(Date.now() - auto.startedAt)} so far). RCon connects as soon as loading finishes.`); return; }
    }
    const open = udpListening(creds.port);
    if (open === false) {
      if (rptActive() || Date.now() - auto.startedAt < 5 * 60000) setDiag('loading', `Server still starting (${mins} min so far); RCon port ${creds.port} is not open yet. The tool connects when it opens.`);
      else setDiag('failed', `The server stopped making progress and RCon port ${creds.port} never opened: ${whyNoPort(creds.port)}.`);
      return;
    }
    setDiag('logging-in', `RCon port ${creds.port} is open; logging in…`);
    try {
      await connect({ host: creds.host, port: creds.port, password: creds.password });
      const secs = Math.round((Date.now() - auto.startedAt) / 1000);
      setDiag('connected', `Connected ${secs < 120 ? secs + ' s' : Math.round(secs / 60) + ' min'} after the server started.`); stopAuto();
    } catch (e) {
      if (/wrong RCon password/i.test(e.message)) {
        auto.wrongPw++;
        const act = readActive();
        if (act && act.password && act.password !== creds.password && auto.wrongPw < 3) { session = { password: act.password, port: act.port || creds.port, from: 'active' }; setDiag('logging-in', 'The password differed from the one BattlEye loaded; retrying with the loaded one.'); return; }
        setDiag('failed', 'BattlEye refused the password. The password the server started with is not the one the tool has; restart the server so the tool can set it, or use "Sync with BEServer_x64.cfg".'); stopAuto(); return;
      }
      auto.timeouts++;
      if (auto.timeouts >= 30 && !rptActive()) setDiag('failed', `RCon port ${creds.port} is open but BattlEye does not answer logins. Another program may be using the port, or RestrictRCon is blocking it.`);
      else setDiag('port-open', `RCon port ${creds.port} is open but BattlEye is not answering yet (it starts answering once the server finishes loading). Retrying…`);
    }
  } finally { auto.busy = false; }
}
// Started when the server starts; checks every 10 s, no fixed time limit while the server is visibly still loading.
function autoConnectLoop() {
  const c = cfg(); if (!c.autoConnect) return;
  stopAuto(); auto = { timer: null, startedAt: Date.now(), timeouts: 0, wrongPw: 0, busy: false };
  setDiag('loading', 'Server starting; RCon connects when BattlEye is ready.');
  auto.timer = setInterval(() => { if (Date.now() - auto.startedAt > 3 * 3600000) { setDiag('failed', 'Gave up after 3 hours.'); stopAuto(); return; } attempt().catch(() => {}); }, 10000);
}
function stopAuto() { clearInterval(auto.timer); auto.timer = null; }
function onStage(stg) { if (stg && stg.ready && auto.timer && !state.connected) setTimeout(() => attempt().catch(() => {}), 1500); }
function init(emit) {
  emitRef = emit;
  try { if (!serverRunning()) ensureConfigured(); } catch { /* server not installed yet */ }
  // a server the tool did not start (still running from before) is only tried once
  if (cfg().autoConnect && cfg().password) setTimeout(() => connect(sessionCreds()).catch(() => {}), 3000);
}

module.exports = { onStage, init, connect, disconnect, command, status, players, bans, say, kick, ban, addBan, cfg, crc32, ensureConfigured, autoConnectLoop, stopAuto, beArg, readActive, adoptFromFile, sessionCreds };
