'use strict';
// Built-in public website: status page, mods list, custom Markdown pages and a JSON API, served by the tool itself.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const settings = require('./settings');
const server = require('./server');
const rcon = require('./rcon');
const mods = require('./mods');
const scheduler = require('./scheduler');

let srv = null, srvTls = null;
let emitRef = () => {};
let state = { running: false, port: 0, error: null, requests: 0, startedAt: null };
let statusCache = { at: 0, data: null };

const DEFAULT_PAGES = [
  { slug: 'rules', title: 'Rules', content: '# Server rules\n\n1. No cheating, exploiting or glitching.\n2. Respect other players and the admins.\n3. No racism, hate speech or harassment.\n\nBreaking the rules gets you banned. Appeal on our Discord.' },
  { slug: 'about', title: 'About', content: '# About the server\n\nTell your players what makes your server special: map, loot economy, base building rules, events, wipes.' }
];

function cfg() {
  const s = settings.load();
  return {
    enabled: false, port: 8080, title: 'My DayZ Server', tagline: 'Survive. Build. Thrive.', description: 'Welcome to our DayZ server.',
    accent: '#4f8cff', serverAddress: '', discordInvite: '', showMods: true, showPlayers: true, showSchedule: true, bannerUrl: '', customCss: '',
    pages: DEFAULT_PAGES,
    ...(s.website || {})
  };
}

function publicDir() { return path.join(settings.load().installDir, 'website'); }

function localUrls(port) {
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list) if (n.family === 'IPv4' && !n.internal) urls.push(`http://${n.address}:${port}`);
  return urls;
}

function status() {
  const c = cfg();
  return { ...state, config: c, urls: state.running ? localUrls(state.port) : localUrls(c.port), publicDir: publicDir(), site: siteInfo(), https: state.https || null, httpsError: state.httpsError || null };
}

// ---------- data ----------
async function serverStatus() {
  if (Date.now() - statusCache.at < 10000 && statusCache.data) return statusCache.data;
  const st = server.status();
  const sc = scheduler.state();
  let players = null, maxPlayers = null, playerList = [];
  try { const m = fs.readFileSync(settings.paths().configPath, 'utf8').match(/maxPlayers\s*=\s*(\d+)/); if (m) maxPlayers = Number(m[1]); } catch { /* ignore */ }
  if (st.running && rcon.status().connected) { try { const r = await rcon.players(); players = r.players.length; playerList = r.players.map(p => p.name); } catch { players = null; } }
  const list = mods.list().filter(m => m.enabled && !m.serverSide).map(m => ({ id: m.local ? null : m.id, title: m.title, size: m.fileSize || null, local: !!m.local }));
  const data = {
    online: st.running, uptimeSeconds: st.running ? Math.round((Date.now() - st.startedAt) / 1000) : 0,
    players, maxPlayers, playerList,
    nextRestart: sc.nextRestart || null, restartTimes: (sc.restarts && sc.restarts.enabled) ? sc.restarts.times : [],
    mods: list, generatedAt: new Date().toISOString()
  };
  statusCache = { at: Date.now(), data };
  return data;
}

// ---------- tiny markdown ----------
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>');
}
function markdown(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) { flushPara(); const kind = ul ? 'ul' : 'ol'; if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline((ul || ol)[1])}</li>`); continue; }
    if (/^---+$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out.join('\n');
}

// ---------- templates ----------
function css(c) {
  return `
:root{--accent:${c.accent || '#4f8cff'};--bg:#0b0d12;--panel:#141821;--border:#242a38;--text:#e8ebf1;--muted:#8c95a8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:"Segoe UI",system-ui,sans-serif;line-height:1.5}
a{color:var(--accent)}header{border-bottom:1px solid var(--border);background:#10131a}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}nav{display:flex;align-items:center;gap:18px;height:58px}
nav .brand{font-weight:700;margin-right:auto;color:var(--text);text-decoration:none}nav a{color:var(--muted);text-decoration:none;font-size:14px}nav a.on,nav a:hover{color:var(--text)}
.hero{padding:44px 0 28px;${c.bannerUrl ? `background:linear-gradient(rgba(11,13,18,.55),rgba(11,13,18,.95)),url("${esc(c.bannerUrl)}") center/cover;` : ''}}
.hero h1{margin:0 0 6px;font-size:36px}.hero p{margin:0;color:var(--muted);font-size:17px}
.pill{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;border:1px solid var(--border);background:var(--panel);font-size:14px;margin:18px 8px 0 0}
.dot{width:9px;height:9px;border-radius:50%;background:#ff5f5f}.dot.on{background:#3ddc84;box-shadow:0 0 10px #3ddc84}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:26px 0}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px 20px}.card h3{margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.big{font-size:26px;font-weight:700}.muted{color:var(--muted)}code{background:#090b0f;border:1px solid var(--border);border-radius:6px;padding:2px 7px}
main{padding:10px 0 50px}table{width:100%;border-collapse:collapse}td,th{padding:9px 10px;border-bottom:1px solid var(--border);text-align:left;font-size:14px}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.btn{display:inline-block;background:var(--accent);color:#fff;padding:10px 18px;border-radius:9px;text-decoration:none;font-weight:600;margin-top:14px}
footer{border-top:1px solid var(--border);color:var(--muted);font-size:12px;padding:18px 0}
.prose h2{margin-top:28px}.prose li{margin:4px 0}
${c.customCss || ''}`;
}

// Owners can drop files into <installDir>\website\ to customise everything:
//   template.html  - replaces the layout; placeholders {{title}} {{site}} {{nav}} {{content}} {{year}}
//   index.html     - replaces the home page entirely (raw HTML)
//   <slug>.html    - replaces a custom page or /mods entirely
//   site.css       - replaces the generated stylesheet (served at /assets/site.css)
//   anything else  - served as-is (images, fonts, extra pages): /banner.jpg, /docs/map.png ...
function customFile(name) {
  try { const f = path.join(publicDir(), name); return fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null; } catch { return null; }
}

function navLinks(c, active) {
  const nav = [['/', 'Home'], ...(c.showMods ? [['/mods', 'Mods']] : []), ...c.pages.map(p => ['/' + p.slug, p.title]), ...(c.discordInvite ? [[c.discordInvite, 'Discord']] : [])];
  return nav.map(([h, l]) => `<a href="${esc(h)}" class="${h === active ? 'on' : ''}">${esc(l)}</a>`).join('');
}

function layout(c, active, title, body) {
  const tpl = customFile('template.html');
  if (tpl) {
    return tpl.replace(/\{\{\s*title\s*\}\}/g, esc(title)).replace(/\{\{\s*site\s*\}\}/g, esc(c.title)).replace(/\{\{\s*tagline\s*\}\}/g, esc(c.tagline))
      .replace(/\{\{\s*nav\s*\}\}/g, navLinks(c, active)).replace(/\{\{\s*content\s*\}\}/g, body).replace(/\{\{\s*year\s*\}\}/g, String(new Date().getFullYear()));
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(c.title)}</title><link rel="stylesheet" href="/assets/site.css"></head><body>
<header><div class="wrap"><nav><a class="brand" href="/">${esc(c.title)}</a>${navLinks(c, active)}</nav></div></header>
<main><div class="wrap">${body}</div></main>
<footer><div class="wrap">${esc(c.title)} · powered by DayZ Admin Tools</div></footer></body></html>`;
}

// Custom pages can be written in Markdown or raw HTML.
function pageBody(p) { return p.type === 'html' ? String(p.content || '') : `<div class="prose">${markdown(p.content)}</div>`; }

function fmtDur(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }

async function homePage(c) {
  const d = await serverStatus();
  const players = c.showPlayers ? (d.players === null ? (d.online ? 'online' : '—') : `${d.players}${d.maxPlayers ? ' / ' + d.maxPlayers : ''}`) : null;
  return layout(c, '/', 'Home', `
<section class="hero"><h1>${esc(c.title)}</h1><p>${esc(c.tagline)}</p>
<span class="pill"><span class="dot ${d.online ? 'on' : ''}"></span>${d.online ? 'Online' : 'Offline'}${d.online ? ' · up ' + fmtDur(d.uptimeSeconds) : ''}</span>
${players !== null ? `<span class="pill">👥 ${esc(players)} players</span>` : ''}
${c.showSchedule && d.nextRestart ? `<span class="pill">⟳ next restart <span data-ts="${d.nextRestart}">${new Date(d.nextRestart).toLocaleString()}</span></span>` : ''}
</section>
<div class="grid">
  ${c.serverAddress ? `<div class="card"><h3>Join</h3><div class="big"><code>${esc(c.serverAddress)}</code></div><div class="muted">Add it as a favourite in the DayZ launcher, or search the name.</div></div>` : ''}
  ${c.showMods ? `<div class="card"><h3>Mods</h3><div class="big">${d.mods.length}</div><div class="muted">${d.mods.slice(0, 4).map(m => esc(m.title)).join(', ')}${d.mods.length > 4 ? '…' : ''}</div><a class="btn" href="/mods">Mod list</a></div>` : ''}
  ${c.showSchedule && d.restartTimes.length ? `<div class="card"><h3>Restarts</h3><div class="big">${d.restartTimes.map(esc).join(' · ')}</div><div class="muted">Daily, server time. Players are warned in-game.</div></div>` : ''}
  ${c.discordInvite ? `<div class="card"><h3>Community</h3><div class="muted">Join the Discord for whitelist applications, support and announcements.</div><a class="btn" href="${esc(c.discordInvite)}">Join Discord</a></div>` : ''}
</div>
<div class="prose">${markdown(c.description)}</div>
<script>document.querySelectorAll('[data-ts]').forEach(e=>{e.textContent=new Date(Number(e.dataset.ts)).toLocaleString()});</script>`);
}

async function modsPage(c) {
  const d = await serverStatus();
  const rows = d.mods.map(m => `<tr><td>${m.id ? `<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${m.id}">${esc(m.title)}</a>` : esc(m.title)}</td><td class="muted">${m.local ? 'local' : m.id}</td><td class="muted">${m.size ? (m.size / 1048576).toFixed(0) + ' MB' : ''}</td></tr>`).join('');
  return layout(c, '/mods', 'Mods', `<h1>Mods</h1><p class="muted">Subscribe to all of these on the Steam Workshop and enable them in the DayZ launcher before joining.</p><div class="card"><table><thead><tr><th>Mod</th><th>Workshop ID</th><th>Size</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="muted">No client mods required.</td></tr>'}</tbody></table></div>`);
}

function customPage(c, p) { return layout(c, '/' + p.slug, p.title, pageBody(p)); }

// ---------- admin panel (/admin): password-protected remote control ----------
const crypto = require('crypto');
const adminSessions = new Map(); // token -> expiry
const loginFails = new Map(); // ip -> { n, until }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function hashPw(pw, salt) { return crypto.createHash('sha256').update(salt + ':' + pw).digest('hex'); }
// The admin password is stored as a salted hash. A plain password left over from an older version is hashed on first read.
function adminCfg() {
  const s = settings.load();
  const ac = { enabled: false, password: '', passwordHash: '', salt: '', ...((s.website || {}).admin || {}) };
  if (ac.password) {
    ac.salt = crypto.randomBytes(8).toString('hex'); ac.passwordHash = hashPw(ac.password, ac.salt); ac.password = '';
    settings.save({ website: { ...(s.website || {}), admin: { enabled: ac.enabled, passwordHash: ac.passwordHash, salt: ac.salt } } });
  }
  return ac;
}
function adminToken(req) { const m = (req.headers.cookie || '').match(/dzadmin=([a-f0-9]+)/); const t = m && m[1]; return t && adminSessions.get(t) > Date.now() ? t : null; }
function adminPage(c, body, { loggedIn = false, error = '' } = {}) {
  return layout(c, '/admin', 'Admin', loggedIn ? body : `<h1>Admin</h1>${error ? `<p style="color:#ff5f5f">${esc(error)}</p>` : ''}<form method="post" action="/admin/login" class="card" style="max-width:380px"><label>Password<br><input type="password" name="password" style="width:100%;padding:8px;margin:6px 0 12px;border-radius:8px;border:1px solid #333;background:#0b0d12;color:#fff"></label><button class="btn" type="submit" style="margin:0">Log in</button></form>`);
}
function adminHtml(c) {
  return `<h1>Admin</h1><div class="grid">
<div class="card"><h3>Server</h3><div class="big" id="st">…</div><div class="muted" id="st2"></div><div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="start">Start</button><button class="btn" data-act="restart">Restart</button><button class="btn" data-act="stop" style="background:#5a2a33">Stop</button><button class="btn" data-act="backup" style="background:#333">Backup now</button></div></div>
<div class="card"><h3>Broadcast</h3><input id="say" placeholder="Message to all players" style="width:100%;padding:8px;border-radius:8px;border:1px solid #333;background:#0b0d12;color:#fff"><button class="btn" data-act="say">Send</button></div>
</div>
<div class="card"><h3>Online players</h3><table><thead><tr><th>#</th><th>Name</th><th>Ping</th><th></th></tr></thead><tbody id="pl"><tr><td colspan="4" class="muted">RCon not connected in the tool.</td></tr></tbody></table></div>
<p class="muted"><a href="/admin/logout">Log out</a></p>
<script>
async function api(path, body){const r=await fetch('/admin/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(r.status===401){location.reload();return null;}return r.json();}
async function refresh(){const d=await api('status');if(!d)return;document.getElementById('st').textContent=d.online?'Online':'Offline';document.getElementById('st2').textContent=(d.players!==null?d.players+' players · ':'')+(d.online?'up '+Math.floor(d.uptimeSeconds/60)+' min':'');const tb=document.getElementById('pl');if(d.playerRows){tb.innerHTML=d.playerRows.map(p=>'<tr><td>'+p.num+'</td><td>'+p.name.replace(/</g,'&lt;')+'</td><td>'+p.ping+'</td><td><button class="btn" style="margin:0;padding:4px 10px" data-kick="'+p.num+'">Kick</button></td></tr>').join('')||'<tr><td colspan="4" class="muted">No players</td></tr>';}}
document.addEventListener('click',async e=>{const a=e.target.getAttribute('data-act');const k=e.target.getAttribute('data-kick');if(a==='say'){const m=document.getElementById('say').value.trim();if(m){await api('say',{message:m});document.getElementById('say').value='';}return;}if(a){if(a==='stop'&&!confirm('Stop the server?'))return;await api(a,{});setTimeout(refresh,1500);}if(k!==null&&k!==undefined){if(confirm('Kick player #'+k+'?'))await api('kick',{num:Number(k)});setTimeout(refresh,1500);}});
refresh();setInterval(refresh,15000);
</script>`;
}
async function handleAdmin(req, res, p, c, send) {
  const ac = adminCfg();
  if (!ac.enabled || !ac.passwordHash) return send(404, 'text/html', layout(c, '', 'Not found', '<h1>Admin panel is disabled</h1><p class="muted">Enable it on the Website page in DayZ Admin Tools and set a password.</p>'));
  if (p === '/admin/login' && req.method === 'POST') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const ip = String(req.socket.remoteAddress || ''); const lf = loginFails.get(ip);
      if (lf && lf.n >= 5 && Date.now() < lf.until) { res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '900' }); return res.end(adminPage(c, '', { error: 'Too many attempts. Try again in 15 minutes.' })); }
      const pw = decodeURIComponent((new URLSearchParams(body).get('password') || ''));
      if (!pw || !safeEq(hashPw(pw, ac.salt), ac.passwordHash)) {
        const f = loginFails.get(ip) || { n: 0, until: 0 }; f.n++; f.until = Date.now() + 15 * 60000; loginFails.set(ip, f);
        try { require('./audit').log('web', ip, 'admin login failed', ''); } catch { /* ignore */ } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(adminPage(c, '', { error: 'Wrong password.' })); }
      loginFails.delete(ip);
      const token = crypto.randomBytes(24).toString('hex'); adminSessions.set(token, Date.now() + 12 * 3600 * 1000);
      try { require('./audit').log('web', ip, 'admin login', ''); } catch { /* ignore */ }
      res.writeHead(302, { Location: '/admin', 'Set-Cookie': `dzadmin=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200${req.socket.encrypted ? '; Secure' : ''}` }); res.end();
    });
    return;
  }
  if (p === '/admin/logout') { const t = adminToken(req); if (t) adminSessions.delete(t); res.writeHead(302, { Location: '/admin', 'Set-Cookie': 'dzadmin=; Path=/admin; Max-Age=0' }); return res.end(); }
  const token = adminToken(req);
  if (p.startsWith('/admin/api/')) {
    if (!token) return send(401, 'application/json', '{"error":"unauthorized"}');
    if (req.method === 'POST') { const origin = req.headers.origin || req.headers.referer || ''; const host = String(req.headers.host || ''); if (origin && !new RegExp('^https?://' + host.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '(/|$)', 'i').test(origin)) return send(403, 'application/json', '{"error":"cross-site request blocked"}'); if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return send(403, 'application/json', '{"error":"cross-site request blocked"}'); }
    const action = p.slice('/admin/api/'.length);
    let body = {}; if (req.method === 'POST') { let raw = ''; await new Promise(r => { req.on('data', d => { raw += d; if (raw.length > 8192) req.destroy(); }); req.on('end', r); }); try { body = JSON.parse(raw || '{}'); } catch { body = {}; } }
    try {
      if (action === 'status') { const d = await serverStatus(); let playerRows = null; if (d.online && rcon.status().connected) { try { playerRows = (await rcon.players()).players.map(x => ({ num: x.num, name: x.name, ping: x.ping })); } catch { playerRows = null; } } return send(200, 'application/json', JSON.stringify({ ...d, playerRows })); }
      if (req.method !== 'POST') return send(405, 'application/json', '{"error":"POST required"}');
      if (action === 'start') server.start(); else if (action === 'stop') await server.stop(); else if (action === 'restart') await require('./scheduler').restartNow();
      else if (action === 'backup') await require('./backups').create('admin-panel');
      else if (action === 'say') await rcon.say(String(body.message || '').slice(0, 200));
      else if (action === 'kick') await rcon.kick(Number(body.num), 'Kicked by admin');
      else return send(404, 'application/json', '{"error":"unknown action"}');
      emitRef('console', { source: 'website', line: `Admin panel: ${action}` });
      try { require('./audit').log('web', String(req.socket.remoteAddress || ''), 'admin panel: ' + action, body && Object.keys(body).length ? body : ''); } catch { /* ignore */ }
      return send(200, 'application/json', '{"ok":true}');
    } catch (e) { return send(500, 'application/json', JSON.stringify({ error: e.message })); }
  }
  return send(200, 'text/html', adminPage(c, adminHtml(c), { loggedIn: !!token }));
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain', '.woff2': 'font/woff2' };

async function handle(req, res) {
  state.requests++;
  const c = cfg();
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }); res.end(body); };
  try {
    { const dom = require('./domain'); const ch = dom.challengeResponse(p); if (ch) return send(200, 'text/plain', ch);
      const dc = dom.cfg();
      if (!req.socket.encrypted && srvTls && dc.redirectHttp && dc.name) {
        const host = String(req.headers.host || '').split(':')[0].toLowerCase();
        if (host === dc.name.toLowerCase()) { res.writeHead(301, { Location: `https://${dc.name}${Number(dc.httpsPort) === 443 ? '' : ':' + dc.httpsPort}${req.url}` }); return res.end(); }
      } }
    if (p === '/dayz-status.js') return send(200, 'text/javascript', STATUS_JS);
    if (p === '/admin' || p.startsWith('/admin/')) return handleAdmin(req, res, p, c, send);
    // A dropped website wins over everything except the API.
    if (!p.startsWith('/api/')) {
      const f = customSiteFile(p);
      if (f) { res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); return fs.createReadStream(f).pipe(res); }
    }
    if (p === '/assets/site.css') return send(200, 'text/css', customFile('site.css') || css(c));
    if (p === '/api/status.json') return send(200, 'application/json', JSON.stringify(await serverStatus()));
    if (p === '/api/mods.json') return send(200, 'application/json', JSON.stringify((await serverStatus()).mods));
    // Files dropped in <installDir>\website\ are served first (images for the banner, favicon, extra pages).
    const pub = publicDir();
    const safe = path.normalize(path.join(pub, decodeURIComponent(p)));
    if (safe.startsWith(pub + path.sep) && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(safe).toLowerCase()] || 'application/octet-stream' });
      return fs.createReadStream(safe).pipe(res);
    }
    // Owner overrides: index.html for the home page, <slug>.html for any route.
    const override = customFile(p === '/' ? 'index.html' : p.slice(1) + '.html');
    if (override) return send(200, 'text/html', override);
    if (p === '/') return send(200, 'text/html', await homePage(c));
    if (p === '/mods' && c.showMods) return send(200, 'text/html', await modsPage(c));
    const page = c.pages.find(x => '/' + x.slug === p);
    if (page) return send(200, 'text/html', customPage(c, page));
    const notFound = customSiteFile('/404.html');
    if (notFound) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(notFound).pipe(res); }
    return send(404, 'text/html', layout(c, '', 'Not found', '<h1>Not found</h1><p class="muted">That page does not exist.</p>'));
  } catch (e) {
    send(500, 'text/plain', 'Error: ' + e.message);
  }
}

function start(port) {
  return new Promise((resolve, reject) => {
    stop(true);
    const c = cfg();
    const dom = require('./domain'); const dc = dom.cfg();
    const prt = Number(port || dc.httpPort || c.port) || 8080;
    const onReq = (req, res) => { handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* ignore */ } }); };
    srv = http.createServer(onReq);
    // HTTPS listener when a certificate is available
    const cert = dc.https !== 'off' ? dom.currentCert() : null;
    if (cert) {
      try {
        srvTls = https.createServer({ cert: cert.cert, key: cert.key }, onReq);
        srvTls.on('error', e => { emitRef('console', { source: 'website', line: 'HTTPS error: ' + (e.code === 'EADDRINUSE' ? 'port ' + dc.httpsPort + ' is already in use' : e.message) }); state.httpsError = e.message; srvTls = null; emitRef('website:state', status()); });
        srvTls.listen(Number(dc.httpsPort) || 443, '0.0.0.0', () => { state.https = Number(dc.httpsPort) || 443; state.httpsError = null; emitRef('console', { source: 'website', line: `HTTPS running on port ${state.https} (${cert.source} certificate${cert.expires ? ', valid until ' + new Date(cert.expires).toLocaleDateString() : ''})` }); emitRef('website:state', status()); });
      } catch (e) { state.httpsError = 'Certificate could not be loaded: ' + e.message; srvTls = null; emitRef('console', { source: 'website', line: state.httpsError }); }
    } else if (dc.https !== 'off') { state.httpsError = dc.https === 'letsencrypt' ? 'No certificate yet. Use "Get certificate" on the Website page.' : 'Paste the certificate and key on the Website page.'; }
    srv.on('error', e => {
      state = { ...state, running: false, error: e.code === 'EADDRINUSE' ? `Port ${prt} is already in use.` : e.message };
      emitRef('website:state', status()); emitRef('console', { source: 'website', line: `Website error: ${state.error}` });
      reject(new Error(state.error));
    });
    srv.listen(prt, '0.0.0.0', () => {
      state = { ...state, running: true, port: prt, error: null, requests: 0, startedAt: Date.now() };
      try { fs.mkdirSync(publicDir(), { recursive: true }); } catch { /* ignore */ }
      emitRef('website:state', status());
      emitRef('console', { source: 'website', line: `Website running on port ${prt} (${localUrls(prt).join(', ')})` });
      resolve(status());
    });
  });
}

function stop(silent = false) {
  if (srv) { try { srv.close(); } catch { /* ignore */ } srv = null; }
  if (srvTls) { try { srvTls.close(); } catch { /* ignore */ } srvTls = null; }
  state.https = null;
  const was = state.running;
  state = { ...state, running: false, startedAt: null };
  if (!silent) { emitRef('website:state', status()); if (was) emitRef('console', { source: 'website', line: 'Website stopped.' }); }
  return status();
}

function init(emit) {
  emitRef = emit;
  if (cfg().enabled) setTimeout(() => start().catch(() => {}), 1500);
}

// ---------- your own website (dropped folder or zip) ----------
// A dropped site lives in <installDir>\website\site\. Its files win over everything; anything it does not
// define falls back to the generated pages and the JSON API, so /api/status.json keeps working.
function siteDir() { return path.join(publicDir(), 'site'); }
function hasCustomSite() { try { return fs.existsSync(path.join(siteDir(), 'index.html')); } catch { return false; } }

function tar(args) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const proc = require('child_process').spawn(exe, args, { windowsHide: true });
    let err = ''; proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `tar exit ${code}`)));
  });
}

// Find the folder that holds index.html (handles zips that wrap everything in one folder, or dist/build/public outputs).
function findSiteRoot(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  if (depth >= 3) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !/^(node_modules|\.git|src)$/i.test(e.name)); } catch { return null; }
  const preferred = ['dist', 'build', 'public', 'out', 'www', 'site', 'html'];
  entries.sort((a, b) => (preferred.indexOf(a.name.toLowerCase()) + 1 || 99) - (preferred.indexOf(b.name.toLowerCase()) + 1 || 99));
  for (const e of entries) { const r = findSiteRoot(path.join(dir, e.name), depth + 1); if (r) return r; }
  return null;
}

function countFiles(dir) {
  let n = 0, bytes = 0;
  const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.isDirectory()) walk(path.join(d, e.name)); else { n++; try { bytes += fs.statSync(path.join(d, e.name)).size; } catch { /* ignore */ } } } };
  walk(dir);
  return { files: n, bytes };
}

async function importSite(src) {
  if (!src || !fs.existsSync(src)) throw new Error('Dropped item not found on disk.');
  const st = fs.statSync(src);
  let staging = null, root;
  try {
    if (st.isFile()) {
      if (!/\.zip$/i.test(src)) throw new Error('Drop a folder or a .zip file containing the site (it must contain an index.html).');
      staging = path.join(publicDir(), `_import_${Date.now()}`);
      fs.mkdirSync(staging, { recursive: true });
      await tar(['-x', '-f', src, '-C', staging]);
      root = findSiteRoot(staging);
    } else root = findSiteRoot(src);
    if (!root) throw new Error('No index.html found in the dropped site (looked up to 3 folders deep).');
    const dest = siteDir();
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(root, dest, { recursive: true, filter: p => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p) });
    settings.save({ website: { ...cfg(), customSite: { name: path.basename(st.isFile() ? src.replace(/\.zip$/i, '') : src), importedAt: Date.now(), from: src } } });
    const info = siteInfo();
    statusCache = { at: 0, data: null };
    emitRef('console', { source: 'website', line: `Imported site "${path.basename(src)}" (${info.files} files, ${(info.bytes / 1048576).toFixed(1)} MB). It now replaces the generated pages.` });
    emitRef('website:state', status());
    return info;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function removeSite() {
  fs.rmSync(siteDir(), { recursive: true, force: true });
  const c = cfg(); delete c.customSite;
  settings.save({ website: c });
  emitRef('website:state', status());
  return siteInfo();
}

function siteInfo() {
  const c = cfg();
  if (!hasCustomSite()) return { active: false, dir: siteDir() };
  const n = countFiles(siteDir());
  return { active: true, dir: siteDir(), ...n, name: c.customSite ? c.customSite.name : 'site', importedAt: c.customSite ? c.customSite.importedAt : null, hasStatusScript: fs.readFileSync(path.join(siteDir(), 'index.html'), 'utf8').includes('dayz-status.js') };
}

// Serve a file from the dropped site for this path, if there is one.
function customSiteFile(p) {
  if (!hasCustomSite()) return null;
  const dir = siteDir();
  let rel = decodeURIComponent(p);
  const candidates = [rel, rel.replace(/\/$/, '') + '/index.html', rel + '.html'];
  for (const cand of candidates) {
    const full = path.normalize(path.join(dir, cand));
    if (!full.startsWith(dir + path.sep) && full !== dir) continue;
    try { if (fs.statSync(full).isFile()) return full; } catch { /* next */ }
  }
  return null;
}

// Helper script custom sites can include: <script src="/dayz-status.js"></script>
// Fills elements with data-dayz="online|players|max|uptime|next-restart|mods-count|title" and lists for data-dayz-list="mods|players".
const STATUS_JS = `(function(){
  function fmt(s){var h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+'h '+m+'m':m+'m';}
  function apply(d){
    document.querySelectorAll('[data-dayz]').forEach(function(el){
      var k=el.getAttribute('data-dayz'),v='';
      if(k==='online')v=d.online?'Online':'Offline';
      else if(k==='players')v=d.players===null?(d.online?'?':'0'):String(d.players);
      else if(k==='max')v=d.maxPlayers===null?'?':String(d.maxPlayers);
      else if(k==='uptime')v=d.online?fmt(d.uptimeSeconds):'-';
      else if(k==='next-restart')v=d.nextRestart?new Date(d.nextRestart).toLocaleString():'-';
      else if(k==='restart-times')v=(d.restartTimes||[]).join(', ');
      else if(k==='mods-count')v=String(d.mods.length);
      el.textContent=v; el.classList.toggle('dayz-online',!!d.online); el.classList.toggle('dayz-offline',!d.online);
    });
    document.querySelectorAll('[data-dayz-list]').forEach(function(el){
      var k=el.getAttribute('data-dayz-list');
      var items=k==='mods'?d.mods.map(function(m){return m.id?'<li><a href="https://steamcommunity.com/sharedfiles/filedetails/?id='+m.id+'">'+m.title.replace(/</g,'&lt;')+'</a></li>':'<li>'+m.title.replace(/</g,'&lt;')+'</li>';}):(d.playerList||[]).map(function(n){return '<li>'+String(n).replace(/</g,'&lt;')+'</li>';});
      el.innerHTML=items.join('')||'<li>-</li>';
    });
    document.dispatchEvent(new CustomEvent('dayz-status',{detail:d}));
  }
  function load(){fetch('/api/status.json').then(function(r){return r.json();}).then(apply).catch(function(){});}
  load(); setInterval(load,30000); window.DayZStatus={reload:load};
})();`;

// ---------- custom files ----------
function listFiles() {
  const dir = publicDir();
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!rel && e.name === 'site') continue; if (out.length < 500) walk(path.join(d, e.name), r); }
      else { let size = 0; try { size = fs.statSync(path.join(d, e.name)).size; } catch { /* ignore */ } out.push({ name: r, size, url: '/' + r.split('/').map(encodeURIComponent).join('/'), special: ['template.html', 'index.html', 'site.css'].includes(r) }); }
    }
  };
  walk(dir, '');
  return { dir, files: out.sort((a, b) => a.name.localeCompare(b.name)) };
}

function addFiles(paths, subdir = '') {
  const dir = path.join(publicDir(), subdir.replace(/^[\\/]+/, ''));
  fs.mkdirSync(dir, { recursive: true });
  const added = [];
  for (const src of paths) {
    const dest = path.join(dir, path.basename(src));
    fs.copyFileSync(src, dest);
    added.push(path.relative(publicDir(), dest).replace(/\\/g, '/'));
  }
  return { added, ...listFiles() };
}

function removeFile(rel) {
  const dir = publicDir();
  const full = path.normalize(path.join(dir, rel));
  if (!full.startsWith(dir + path.sep)) throw new Error('Invalid path');
  fs.rmSync(full, { force: true });
  return listFiles();
}

// Write a starter template.html / site.css the owner can edit.
function writeStarter(kind) {
  const dir = publicDir();
  fs.mkdirSync(dir, { recursive: true });
  const c = cfg();
  if (kind === 'template.html') {
    fs.writeFileSync(path.join(dir, 'template.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{title}} · {{site}}</title>
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
  <header><div class="wrap"><nav><a class="brand" href="/">{{site}}</a>{{nav}}</nav></div></header>
  <main><div class="wrap">{{content}}</div></main>
  <footer><div class="wrap">&copy; {{year}} {{site}}</div></footer>
</body>
</html>
`);
  } else if (kind === 'site.css') {
    fs.writeFileSync(path.join(dir, 'site.css'), css(c));
  } else if (kind === 'index.html') {
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(c.title)}</title><link rel="stylesheet" href="/assets/site.css"></head>
<body><header><div class="wrap"><nav><a class="brand" href="/">${esc(c.title)}</a><a href="/mods">Mods</a></nav></div></header>
<main><div class="wrap"><h1>${esc(c.title)}</h1><p>This index.html replaces the generated home page. Live data is available at <code>/api/status.json</code>.</p>
<p id="status">Loading…</p>
<script>fetch('/api/status.json').then(r=>r.json()).then(d=>{document.getElementById('status').textContent=(d.online?'Online':'Offline')+(d.players!==null?' · '+d.players+(d.maxPlayers?'/'+d.maxPlayers:'')+' players':'');});</script>
</div></main></body></html>
`);
  } else throw new Error('Unknown starter');
  return listFiles();
}

// Render a page to a string for the in-app preview.
async function preview(slug) {
  const c = cfg();
  if (slug === '__css__') return customFile('site.css') || css(c);
  if (!slug || slug === '/') return homePage(c);
  if (slug === 'mods') return modsPage(c);
  const page = c.pages.find(x => x.slug === slug);
  return page ? customPage(c, page) : '<p>Not found</p>';
}

module.exports = { init, start, stop, status, cfg, preview, listFiles, addFiles, removeFile, writeStarter, publicDir, importSite, removeSite, siteDir };
