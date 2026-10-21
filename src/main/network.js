'use strict';
// Network helper: Windows firewall rules (elevated), public IP, and port reachability checks.
const { spawn } = require('child_process');
const net = require('net');
const settings = require('./settings');

const RULE_PREFIX = 'DayZ Server Tool';

function ps(cmd, { elevated = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = elevated
      ? ['-NoProfile', '-NonInteractive', '-Command', `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-Command',${JSON.stringify(cmd.replace(/'/g, "''"))}`]
      : ['-NoProfile', '-NonInteractive', '-Command', cmd];
    const p = spawn('powershell.exe', args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.trim() || out.trim() || `exit ${code}`)));
    p.on('error', reject);
  });
}

function ports() {
  const s = settings.load();
  const web = (s.website || {}).port || 8080;
  const rconPort = (s.rcon || {}).port || 2306;
  return [
    { name: 'Game', port: Number(s.port) || 2302, proto: 'UDP', why: 'players connect here' },
    { name: 'Game +1', port: (Number(s.port) || 2302) + 1, proto: 'UDP', why: 'engine traffic (DayZ uses port and port+1)' },
    { name: 'Steam query', port: Number(s.steamQueryPort) || 27016, proto: 'UDP', why: 'server browser' },
    { name: 'RCon', port: rconPort, proto: 'UDP', why: 'BattlEye RCon (only open if you use RCon remotely)' },
    { name: 'Website', port: web, proto: 'TCP', why: 'built-in website' }
  ];
}

async function rules() {
  try {
    const out = await ps(`Get-NetFirewallRule -DisplayName '${RULE_PREFIX}*' | ForEach-Object { $pf = $_ | Get-NetFirewallPortFilter; "$($_.DisplayName)|$($_.Enabled)|$($pf.Protocol)|$($pf.LocalPort)" }`);
    return out.trim().split(/\r?\n/).filter(Boolean).map(l => { const [name, enabled, proto, port] = l.split('|'); return { name, enabled: enabled === 'True', proto, port }; });
  } catch { return []; }
}

async function addRules() {
  const cmds = ports().map(p => `New-NetFirewallRule -DisplayName '${RULE_PREFIX} ${p.name} ${p.proto} ${p.port}' -Direction Inbound -Action Allow -Protocol ${p.proto} -LocalPort ${p.port} -Profile Any -ErrorAction SilentlyContinue | Out-Null`);
  await ps(`Get-NetFirewallRule -DisplayName '${RULE_PREFIX}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; ${cmds.join('; ')}`, { elevated: true });
  return rules();
}
async function removeRules() { await ps(`Get-NetFirewallRule -DisplayName '${RULE_PREFIX}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`, { elevated: true }); return rules(); }

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

async function report() {
  const [ip, rl, ls] = await Promise.all([publicIp(), rules(), listening()]);
  return { publicIp: ip, rules: rl, ports: ls, websiteReachableLocal: await tcpCheck('127.0.0.1', (settings.load().website || {}).port || 8080) };
}

module.exports = { ports, rules, addRules, removeRules, publicIp, listening, report, tcpCheck };
