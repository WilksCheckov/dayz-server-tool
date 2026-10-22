'use strict';
// Network helper: Windows firewall rules (elevated), public IP, and port reachability checks.
const { spawn } = require('child_process');
const net = require('net');
const settings = require('./settings');

const RULE_PREFIX = 'DayZ Admin Tools';
const OLD_PREFIX = 'DayZ Server Tool'; // rules created by earlier versions are replaced

function ps(cmd, { elevated = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!elevated) {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
      let out = '', err = '';
      p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
      p.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.trim() || out.trim() || `exit ${code}`)));
      p.on('error', reject);
      return;
    }
    // Elevated: write the script to a file so no quoting survives two PowerShell layers, and have it
    // record its output and errors in a result file we read back (an elevated window cannot be piped).
    const os = require('os'); const fs = require('fs'); const path = require('path');
    const stamp = Date.now();
    const script = path.join(os.tmpdir(), `dzst-fw-${stamp}.ps1`), result = path.join(os.tmpdir(), `dzst-fw-${stamp}.txt`);
    fs.writeFileSync(script, `$ErrorActionPreference = 'Continue'\r\n$out = @()\r\ntry {\r\n${cmd}\r\n} catch { $out += ('ERROR: ' + $_.Exception.Message) }\r\n$out += 'DONE'\r\n$out | Out-File -FilePath '${result.replace(/'/g, "''")}' -Encoding utf8\r\n`, 'utf8');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}'`], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      let out = ''; try { out = fs.readFileSync(result, 'utf8'); } catch { /* no result: the UAC prompt was declined or the script never ran */ }
      try { fs.unlinkSync(script); } catch { /* ignore */ } try { fs.unlinkSync(result); } catch { /* ignore */ }
      if (code !== 0) return reject(new Error(/canceled|cancelled|denied/i.test(err) ? 'Administrator permission was declined.' : (err.trim() || `exit ${code}`)));
      if (!out.includes('DONE')) return reject(new Error('The elevated command did not run (permission declined?).'));
      const errors = out.split(/\r?\n/).filter(l => l.startsWith('ERROR:'));
      errors.length ? reject(new Error(errors.join('; '))) : resolve(out);
    });
    p.on('error', reject);
  });
}

function ports() {
  const s = settings.load();
  const web = (s.website || {}).port || 8080;
  const rconPort = (s.rcon || {}).port || 2306;
  const list = [
    { name: 'Game', port: Number(s.port) || 2302, proto: 'UDP', why: 'players connect here' },
    { name: 'Game +1', port: (Number(s.port) || 2302) + 1, proto: 'UDP', why: 'engine traffic (DayZ uses port and port+1)' },
    { name: 'Steam query', port: Number(s.steamQueryPort) || 27016, proto: 'UDP', why: 'server browser' },
    { name: 'RCon', port: rconPort, proto: 'UDP', why: 'BattlEye RCon (only open if you use RCon remotely)' },
    { name: 'Website', port: web, proto: 'TCP', why: 'built-in website' }
  ];
  const dom = ((s.website || {}).domain) || {};
  if (dom.httpPort && Number(dom.httpPort) !== web) list.push({ name: 'Website HTTP', port: Number(dom.httpPort), proto: 'TCP', why: 'domain: plain HTTP and Let\'s Encrypt checks' });
  if (dom.https && dom.https !== 'off') list.push({ name: 'Website HTTPS', port: Number(dom.httpsPort) || 443, proto: 'TCP', why: 'domain: HTTPS' });
  return list;
}

async function rules() {
  try {
    const out = await ps(`Get-NetFirewallRule -DisplayName '${RULE_PREFIX} *' | ForEach-Object { $pf = $_ | Get-NetFirewallPortFilter; "$($_.DisplayName)|$($_.Enabled)|$($pf.Protocol)|$($pf.LocalPort)" }`);
    return out.trim().split(/\r?\n/).filter(Boolean).map(l => { const [name, enabled, proto, port] = l.split('|'); return { name, enabled: enabled === 'True', proto, port }; });
  } catch { return []; }
}

async function addRules() {
  const cmds = ports().map(p => `New-NetFirewallRule -DisplayName '${RULE_PREFIX} ${p.name} ${p.proto} ${p.port}' -Direction Inbound -Action Allow -Protocol ${p.proto} -LocalPort ${p.port} -Profile Any -ErrorAction Stop | Out-Null`);
  await ps(`Get-NetFirewallRule -DisplayName '${OLD_PREFIX} *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName '${RULE_PREFIX} *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue\r\n${cmds.join('\r\n')}`, { elevated: true });
  // verify: the rules must now exist, otherwise report it instead of pretending
  const have = await rules();
  const missing = ports().filter(p => !have.some(r => String(r.port) === String(p.port) && r.proto === p.proto));
  if (missing.length) throw new Error('Rules were not created for ' + missing.map(p => p.proto + ' ' + p.port).join(', '));
  return have;
}
async function removeRules() { await ps(`Get-NetFirewallRule -DisplayName '${RULE_PREFIX} *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`, { elevated: true }); return rules(); }

async function publicIp() {
  for (const url of ['https://api.ipify.org?format=json', 'https://ifconfig.me/all.json']) {
    try { const j = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json(); if (j.ip || j.ip_addr) return j.ip || j.ip_addr; } catch { /* next */ }
  }
  return null;
}

// Which of our ports have a local listener right now (netstat), so we can tell "server not running" from "blocked".
async function listening() {
  try {
    const out = await ps('netstat -an');
    const lines = out.split(/\r?\n/);
    return ports().map(p => ({ ...p, listening: lines.some(l => new RegExp(`^\\s*${p.proto}\\s+\\S+:${p.port}\\s`).test(l)) }));
  } catch { return ports().map(p => ({ ...p, listening: null })); }
}

// TCP reachability from outside is checked through the website port only (UDP cannot be probed reliably from here).
function tcpCheck(host, port) {
  return new Promise(resolve => { const s = net.createConnection({ host, port, timeout: 4000 }); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); }); });
}

// Steam A2S_INFO query (what the server browser does). Handles the challenge handshake newer servers require.
function a2sInfo(host, port, timeoutMs = 4000) {
  const dgram = require('dgram');
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const base = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0', 'latin1')]);
    const started = Date.now();
    const done = (v) => { try { sock.close(); } catch { /* ignore */ } resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on('error', () => { clearTimeout(timer); done(null); });
    sock.on('message', msg => {
      if (msg.length < 5 || msg.readInt32LE(0) !== -1) return;
      const type = msg[4];
      if (type === 0x41 && msg.length >= 9) { sock.send(Buffer.concat([base, msg.subarray(5, 9)]), port, host); return; }
      if (type !== 0x49) return;
      clearTimeout(timer);
      try {
        let o = 6; const str = () => { const e = msg.indexOf(0, o); const v = msg.toString('utf8', o, e); o = e + 1; return v; };
        const name = str(), map = str(), folder = str(), game = str(); o += 2;
        const players = msg[o++], maxPlayers = msg[o++];
        done({ name, map, folder, game, players, maxPlayers, ping: Date.now() - started });
      } catch { done(null); }
    });
    sock.send(base, port, host, err => { if (err) { clearTimeout(timer); done(null); } });
  });
}

// ---------- local web stacks (PHP / Apache / IIS) that could expose this machine ----------
// Minimum PHP releases that fix CVE-2026-109618 / CVE-2026-109619 ("php2shell", CISA alert of 2026-10-21).
const PHP_FIXED = { '8.5': '8.5.12', '8.4': '8.4.27', '8.3': '8.3.36', '8.2': '8.2.35' };
function verCmp(a, b) { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; }
function phpVersion(exe) { try { const out = require('child_process').execFileSync(exe, ['-v'], { windowsHide: true, timeout: 5000 }).toString(); const m = out.match(/PHP\s+(\d+\.\d+\.\d+)/); return m ? m[1] : null; } catch { return null; } }
async function webStacks() {
  const fs = require('fs'); const path = require('path');
  const found = [];
  const candidates = [['XAMPP', 'C:\\xampp', 'C:\\xampp\\php\\php.exe'], ['WampServer', 'C:\\wamp64', null], ['WampServer', 'C:\\wamp', null], ['Laragon', 'C:\\laragon', null], ['PHP', 'C:\\php', 'C:\\php\\php.exe'], ['PHP', 'C:\\Program Files\\PHP', null]];
  for (const [name, dir, exe] of candidates) {
    if (!fs.existsSync(dir)) continue;
    let php = exe && fs.existsSync(exe) ? exe : null;
    if (!php) { try { for (const sub of fs.readdirSync(dir)) { const p = path.join(dir, sub, 'php.exe'); if (fs.existsSync(p)) { php = p; break; } const bin = path.join(dir, 'bin', 'php'); if (fs.existsSync(bin)) for (const v of fs.readdirSync(bin)) { const p2 = path.join(bin, v, 'php.exe'); if (fs.existsSync(p2)) { php = p2; break; } } if (php) break; } } catch { /* ignore */ } }
    const version = php ? phpVersion(php) : null;
    const branch = version ? version.split('.').slice(0, 2).join('.') : null;
    const fixed = branch ? PHP_FIXED[branch] : null;
    const vulnerable = version ? (fixed ? verCmp(version, fixed) < 0 : true) : null; // unsupported branches (8.1 and older) count as vulnerable
    found.push({ name, dir, php, version, fixed: fixed || (branch ? 'unsupported branch, upgrade' : null), vulnerable });
  }
  try { const out = require('child_process').execSync('where php', { windowsHide: true, timeout: 5000 }).toString().trim(); if (out && !found.some(f => f.php && f.php.toLowerCase() === out.split(/\r?\n/)[0].toLowerCase())) { const php = out.split(/\r?\n/)[0]; const version = phpVersion(php); const branch = version ? version.split('.').slice(0, 2).join('.') : null; const fixed = branch ? PHP_FIXED[branch] : null; found.push({ name: 'PHP on PATH', dir: path.dirname(php), php, version, fixed: fixed || 'unsupported branch, upgrade', vulnerable: version ? (fixed ? verCmp(version, fixed) < 0 : true) : null }); } } catch { /* not on PATH */ }
  let running = [];
  try { const out = require('child_process').execSync('tasklist /FO CSV /NH', { windowsHide: true, timeout: 8000 }).toString(); running = [...new Set(out.split(/\r?\n/).map(l => (l.split('","')[0] || '').replace(/^"/, '').toLowerCase()).filter(n => /^(php|php-cgi|httpd|apache|nginx|w3wp|xampp)/.test(n)))]; } catch { /* ignore */ }
  let iis = false; try { require('child_process').execSync('sc query W3SVC', { windowsHide: true, timeout: 5000 }); iis = true; } catch { iis = false; }
  return { found, running, iis, advisory: 'CISA alert 2026-10-21: CVE-2026-109618 / CVE-2026-109619, unauthenticated remote code execution in PHP. Fixed in 8.5.12, 8.4.27, 8.3.36, 8.2.35; older branches are unsupported.' };
}

async function report() {
  const [ip, rl, ls] = await Promise.all([publicIp(), rules(), listening()]);
  const qport = Number(settings.load().steamQueryPort) || 27016;
  const [queryLocal, queryPublic] = await Promise.all([a2sInfo('127.0.0.1', qport), ip ? a2sInfo(ip, qport) : Promise.resolve(null)]);
  let stacks = null; try { stacks = await webStacks(); } catch { stacks = null; }
  return { publicIp: ip, rules: rl, ports: ls, websiteReachableLocal: await tcpCheck('127.0.0.1', (settings.load().website || {}).port || 8080), queryPort: qport, queryLocal, queryPublic, stacks };
}

module.exports = { ports, rules, addRules, removeRules, publicIp, listening, report, tcpCheck, a2sInfo, webStacks };
