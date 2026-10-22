'use strict';
// Domain support for the built-in website: HTTPS certificates (Let's Encrypt via ACME http-01, or pasted PEM files),
// automatic renewal, and dynamic DNS updates (Cloudflare, DuckDNS) so a bought domain keeps pointing at this machine.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const settings = require('./settings');

let emitRef = () => {};
let renewTimer = null, ddnsTimer = null;
const challenges = new Map(); // token -> key authorization, served at /.well-known/acme-challenge/<token>
const state = { issuing: false, lastIssueError: null, lastIssueAt: null, ddns: { lastIp: null, lastUpdate: null, lastError: null, updating: false } };

function cfg() {
  const w = settings.load().website || {};
  const d = w.domain || {};
  return {
    name: '', https: 'off', email: '', certPem: '', keyPem: '', httpsPort: 443, httpPort: 0, redirectHttp: true,
    ...d,
    ddns: { provider: 'none', token: '', zoneId: '', record: '', intervalMin: 10, ...(d.ddns || {}) }
  };
}
function saveCfg(partial) { const w = settings.load().website || {}; const cur = cfg(); settings.save({ website: { ...w, domain: { ...cur, ...partial, ddns: { ...cur.ddns, ...((partial || {}).ddns || {}) } } } }); }
function certDir() { const d = path.join(app.getPath('userData'), 'certs'); fs.mkdirSync(d, { recursive: true }); return d; }
function log(line) { emitRef('console', { source: 'domain', line }); }

// ---------- certificates ----------
function certExpiry(pem) {
  try { const { X509Certificate } = require('crypto'); return new Date(new X509Certificate(pem).validTo).getTime(); } catch { return null; }
}
// The certificate the website should use right now, or null.
function currentCert() {
  const c = cfg();
  if (c.https === 'manual') {
    if (!c.certPem || !c.keyPem) return null;
    return { cert: c.certPem, key: c.keyPem, expires: certExpiry(c.certPem), source: 'manual' };
  }
  if (c.https === 'letsencrypt') {
    try {
      const cert = fs.readFileSync(path.join(certDir(), 'cert.pem'), 'utf8'), key = fs.readFileSync(path.join(certDir(), 'key.pem'), 'utf8');
      const meta = JSON.parse(fs.readFileSync(path.join(certDir(), 'meta.json'), 'utf8'));
      if (meta.domain !== c.name) return null; // certificate is for another name
      return { cert, key, expires: certExpiry(cert) || meta.expires, source: 'letsencrypt', domain: meta.domain };
    } catch { return null; }
  }
  return null;
}
function challengeResponse(urlPath) {
  const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(urlPath || '');
  return m && challenges.has(m[1]) ? challenges.get(m[1]) : null;
}
// Request (or renew) a Let's Encrypt certificate. The website must be reachable on port 80 at the domain for the http-01 check.
async function issue({ staging = false } = {}) {
  const c = cfg();
  if (state.issuing) throw new Error('A certificate request is already running.');
  if (!c.name) throw new Error('Set the domain name first.');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(c.name)) throw new Error('That does not look like a domain name.');
  if (!c.email) throw new Error("Let's Encrypt needs a contact e-mail (used for expiry warnings only).");
  const website = require('./website');
  const st = website.status();
  if (!st.running) throw new Error('Start the website first; Let\'s Encrypt checks the domain over HTTP on port 80.');
  if (Number(st.port) !== 80) throw new Error(`The website listens on port ${st.port}. Set "Listen for HTTP on port" to 80 (and forward 80 on the router) so Let's Encrypt can reach it.`);
  state.issuing = true; state.lastIssueError = null; emitRef('domain:state', status());
  try {
    const acme = require('acme-client');
    const accountFile = path.join(certDir(), 'account.pem');
    let accountKey; try { accountKey = fs.readFileSync(accountFile); } catch { accountKey = await acme.crypto.createPrivateKey(); fs.writeFileSync(accountFile, accountKey); }
    const client = new acme.Client({ directoryUrl: staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production, accountKey });
    const [key, csr] = await acme.crypto.createCsr({ commonName: c.name });
    log(`Requesting a certificate for ${c.name} from Let's Encrypt${staging ? ' (staging)' : ''}...`);
    const cert = await client.auto({
      csr, email: c.email, termsOfServiceAgreed: true, challengePriority: ['http-01'],
      challengeCreateFn: async (authz, challenge, keyAuthorization) => { challenges.set(challenge.token, keyAuthorization); },
      challengeRemoveFn: async (authz, challenge) => { challenges.delete(challenge.token); }
    });
    fs.writeFileSync(path.join(certDir(), 'cert.pem'), cert); fs.writeFileSync(path.join(certDir(), 'key.pem'), key);
    const expires = certExpiry(cert);
    fs.writeFileSync(path.join(certDir(), 'meta.json'), JSON.stringify({ domain: c.name, issuedAt: Date.now(), expires, staging }));
    state.lastIssueAt = Date.now();
    log(`Certificate issued for ${c.name}, valid until ${expires ? new Date(expires).toLocaleDateString() : '?'}.`);
    try { require('./alerts').alert('update-done', 'HTTPS certificate issued', `${c.name}, valid until ${expires ? new Date(expires).toLocaleDateString() : '?'}`); } catch { /* ignore */ }
    // apply it: restart the website so the HTTPS listener picks up the new files
    try { await website.start(); } catch (e) { log('Website restart after issuing failed: ' + e.message); }
    return status();
  } catch (e) {
    state.lastIssueError = e.message; log('Certificate request failed: ' + e.message);
    throw new Error('Certificate request failed: ' + e.message);
  } finally { state.issuing = false; challenges.clear(); emitRef('domain:state', status()); }
}
async function renewIfNeeded() {
  const c = cfg(); if (c.https !== 'letsencrypt' || !c.name) return;
  const cur = currentCert();
  const daysLeft = cur && cur.expires ? (cur.expires - Date.now()) / 86400000 : -1;
  if (cur && daysLeft > 30) return;
  try { await issue(); } catch (e) { try { require('./alerts').alert('update-failed', 'HTTPS certificate renewal failed', e.message); } catch { /* ignore */ } }
}

// ---------- dynamic DNS ----------
async function publicIp() { try { return await require('./network').publicIp(); } catch { return null; } }
async function updateDns({ force = false } = {}) {
  const c = cfg(); const d = c.ddns; const s = state.ddns;
  if (d.provider === 'none') return status();
  if (s.updating) return status();
  s.updating = true; s.lastError = null; emitRef('domain:state', status());
  try {
    const ip = await publicIp(); if (!ip) throw new Error('Could not determine the public IP (offline?).');
    if (!force && ip === s.lastIp) return status();
    const name = (d.record || c.name || '').trim();
    if (d.provider === 'duckdns') {
      if (!d.token) throw new Error('DuckDNS needs the token from duckdns.org.');
      const sub = name.replace(/\.duckdns\.org$/i, '');
      if (!sub) throw new Error('Set the DuckDNS sub domain (e.g. myserver or myserver.duckdns.org).');
      const r = await fetch(`https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(d.token)}&ip=${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(10000) });
      const t = (await r.text()).trim(); if (!/^OK/i.test(t)) throw new Error('DuckDNS answered: ' + t);
    } else if (d.provider === 'cloudflare') {
      if (!d.token || !d.zoneId) throw new Error('Cloudflare needs an API token (Zone.DNS edit) and the zone ID from the domain overview page.');
      if (!name) throw new Error('Set the record name, e.g. yourdomain.com or play.yourdomain.com.');
      const h = { Authorization: 'Bearer ' + d.token, 'Content-Type': 'application/json' };
      const list = await (await fetch(`https://api.cloudflare.com/client/v4/zones/${d.zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`, { headers: h, signal: AbortSignal.timeout(10000) })).json();
      if (!list.success) throw new Error('Cloudflare: ' + (list.errors && list.errors[0] ? list.errors[0].message : 'request failed'));
      const body = JSON.stringify({ type: 'A', name, content: ip, ttl: 120, proxied: false });
      const rec = list.result && list.result[0];
      const res = await (await fetch(`https://api.cloudflare.com/client/v4/zones/${d.zoneId}/dns_records${rec ? '/' + rec.id : ''}`, { method: rec ? 'PUT' : 'POST', headers: h, body, signal: AbortSignal.timeout(10000) })).json();
      if (!res.success) throw new Error('Cloudflare: ' + (res.errors && res.errors[0] ? res.errors[0].message : 'update failed'));
    } else throw new Error('Unknown DNS provider ' + d.provider);
    s.lastIp = ip; s.lastUpdate = Date.now();
    log(`DNS updated: ${name} -> ${ip} (${d.provider})`);
    return status();
  } catch (e) { s.lastError = e.message; log('DNS update failed: ' + e.message); throw e; }
  finally { s.updating = false; emitRef('domain:state', status()); }
}

function status() {
  const c = cfg(); const cur = currentCert();
  return {
    config: { ...c, certPem: c.certPem ? '(set)' : '', keyPem: c.keyPem ? '(set)' : '', ddns: { ...c.ddns, token: c.ddns.token ? '(set)' : '' } },
    cert: cur ? { source: cur.source, expires: cur.expires, daysLeft: cur.expires ? Math.floor((cur.expires - Date.now()) / 86400000) : null } : null,
    issuing: state.issuing, lastIssueError: state.lastIssueError, lastIssueAt: state.lastIssueAt,
    ddns: { ...state.ddns }, publicUrl: c.name ? (c.https !== 'off' && cur ? `https://${c.name}${Number(c.httpsPort) === 443 ? '' : ':' + c.httpsPort}` : `http://${c.name}${Number(c.httpPort || (settings.load().website || {}).port || 8080) === 80 ? '' : ':' + (c.httpPort || (settings.load().website || {}).port || 8080)}`) : null
  };
}
function applyTimers() {
  clearInterval(renewTimer); clearInterval(ddnsTimer);
  renewTimer = setInterval(() => renewIfNeeded().catch(() => {}), 24 * 3600 * 1000);
  const d = cfg().ddns;
  if (d.provider !== 'none') { ddnsTimer = setInterval(() => updateDns().catch(() => {}), Math.max(2, Number(d.intervalMin) || 10) * 60000); setTimeout(() => updateDns().catch(() => {}), 20000); }
  setTimeout(() => renewIfNeeded().catch(() => {}), 90000);
}
function init(emit) { emitRef = emit; applyTimers(); }

module.exports = { init, cfg, saveCfg, status, currentCert, challengeResponse, issue, updateDns, applyTimers };
