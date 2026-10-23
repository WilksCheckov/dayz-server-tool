'use strict';
// Local control channel between the main window and the background instances (and the shared Discord bot).
// Every instance listens on 127.0.0.1 on a random port and writes control.json (pid, port, token) into its data
// folder; only a caller that can read that file (the same Windows user) can talk to it.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let srv = null, token = null, handlers = null;
const routes = {};
const file = (dataDir) => path.join(dataDir || require('electron').app.getPath('userData'), 'control.json');

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// routes: name -> async (body) => result. GET /status, POST /call {channel, args}, POST /<route>.
function route(name, fn) { routes[name] = fn; }

function start(handlerMap) {
  handlers = handlerMap;
  token = crypto.randomBytes(24).toString('hex');
  srv = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const given = Buffer.from(String(req.headers['x-dzat-token'] || '')), want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(403, { ok: false, error: 'forbidden' });
    let size = 0; const chunks = [];
    req.on('data', d => { size += d.length; if (size > 2 * 1024 * 1024) req.destroy(); else chunks.push(d); });
    req.on('end', async () => {
      let body = {}; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(400, { ok: false, error: 'bad json' }); }
      const name = (req.url || '/').split('?')[0].replace(/^\/+/, '');
      try {
        if (name === 'call') {
          const fn = handlers && handlers.get(body.channel);
          if (!fn) return send(404, { ok: false, error: 'unknown channel ' + body.channel });
          return send(200, { ok: true, data: await fn(...(Array.isArray(body.args) ? body.args : [])) });
        }
        const fn = routes[name];
        if (!fn) return send(404, { ok: false, error: 'unknown route' });
        send(200, { ok: true, data: await fn(body) });
      } catch (e) { send(200, { ok: false, error: e.message || String(e) }); }
    });
  });
  srv.listen(0, '127.0.0.1', () => {
    try { fs.writeFileSync(file(), JSON.stringify({ pid: process.pid, port: srv.address().port, token, version: require('electron').app.getVersion(), startedAt: Date.now() })); } catch { /* ignore */ }
  });
  srv.on('error', () => {});
}
function stop() { try { const c = JSON.parse(fs.readFileSync(file(), 'utf8')); if (c.pid === process.pid) fs.unlinkSync(file()); } catch { /* ignore */ } try { srv && srv.close(); } catch { /* ignore */ } }

// The control info of the instance whose data folder is dataDir, or null when its tool is not running.
function info(dataDir) {
  try { const c = JSON.parse(fs.readFileSync(file(dataDir), 'utf8')); return c && c.pid && alive(c.pid) ? c : null; } catch { return null; }
}
async function request(dataDir, name, body, timeoutMs = 8000) {
  const c = info(dataDir); if (!c) throw new Error('That instance\'s tool is not running.');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${c.port}/${name}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-dzat-token': c.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'failed');
    return j.data;
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'The instance did not answer in time.' : e.message); }
  finally { clearTimeout(t); }
}
const call = (dataDir, channel, ...args) => request(dataDir, 'call', { channel, args }, 300000);

module.exports = { start, stop, route, info, request, call, alive };
