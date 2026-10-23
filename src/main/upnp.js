'use strict';
// Router port forwarding over UPnP (Internet Gateway Device). No dependencies: SSDP discovery over UDP 1900,
// the gateway's description XML, and SOAP calls to its WAN(IP|PPP)Connection service.
const dgram = require('dgram');
const http = require('http');
const { URL } = require('url');

const SSDP_ADDR = '239.255.255.250', SSDP_PORT = 1900;
const TARGETS = ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1', 'upnp:rootdevice'];
let cached = null; // { controlUrl, serviceType, location, found: ts }

function fetchText(url, { method = 'GET', headers = {}, body = null, timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

// Find the gateway: send M-SEARCH, collect LOCATION headers, read the first description that has a WAN connection service.
function discover(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); const locations = new Set();
    sock.on('message', msg => { const m = String(msg).match(/^LOCATION:\s*(\S+)/im); if (m) locations.add(m[1]); });
    sock.on('error', () => { /* keep going */ });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); sock.setMulticastTTL(2); } catch { /* ignore */ }
      for (const st of TARGETS) { const q = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`; sock.send(q, SSDP_PORT, SSDP_ADDR, () => {}); }
    });
    setTimeout(() => { try { sock.close(); } catch { /* ignore */ } resolve([...locations]); }, timeoutMs);
  });
}
async function gateway({ refresh = false } = {}) {
  if (cached && !refresh && Date.now() - cached.found < 10 * 60000) return cached;
  const locations = await discover();
  for (const loc of locations) {
    try {
      const { body } = await fetchText(loc);
      const m = body.match(/<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d)<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/i);
      if (!m) continue;
      const base = (body.match(/<URLBase>([^<]+)<\/URLBase>/i) || [])[1] || loc;
      const controlUrl = new URL(m[2].trim(), base).toString();
      const name = (body.match(/<friendlyName>([^<]+)<\/friendlyName>/i) || [])[1] || new URL(loc).hostname;
      cached = { controlUrl, serviceType: m[1], location: loc, name, found: Date.now() };
      return cached;
    } catch { /* next */ }
  }
  cached = null;
  const lan = (() => { try { return require('./network').lanIps()[0].ip; } catch { return null; } })();
  const guess = lan ? lan.replace(/\.\d+$/, '.1') : 'your router';
  throw new Error(`Your router did not answer UPnP (other devices did). Either enable UPnP in the router's settings (usually http://${guess}) and try again, or forward the ports there by hand to this PC${lan ? ' (' + lan + ')' : ''}.`);
}
async function soap(gw, action, args) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${String(v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</${k}>`).join('');
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${gw.serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const r = await fetchText(gw.controlUrl, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${gw.serviceType}#${action}"` }, body });
  if (r.status >= 400) { const code = (r.body.match(/<errorCode>(\d+)<\/errorCode>/) || [])[1]; const desc = (r.body.match(/<errorDescription>([^<]+)<\/errorDescription>/) || [])[1]; throw new Error(`${action} refused by the router${code ? ` (${code}${desc ? ' ' + desc : ''})` : ''}`); }
  return r.body;
}
function lanIpFor(gw) {
  // the local address that routes to the gateway: open a UDP socket "towards" it and read our side
  return new Promise((resolve) => {
    const host = new URL(gw.location).hostname; const s = dgram.createSocket('udp4');
    s.connect(53, host, () => { try { resolve(s.address().address); } catch { resolve(null); } s.close(); });
    s.on('error', () => resolve(null));
  });
}
async function externalIp(gw) { const b = await soap(gw, 'GetExternalIPAddress', {}); return (b.match(/<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/) || [])[1] || null; }
async function map(ports, description = 'DayZ Admin Tools') {
  const gw = await gateway(); const lan = await lanIpFor(gw) || require('./network').lanIps()[0]?.ip;
  if (!lan) throw new Error('Could not work out this PC\'s LAN address.');
  const results = [];
  for (const p of ports) {
    try { await soap(gw, 'AddPortMapping', { NewRemoteHost: '', NewExternalPort: p.port, NewProtocol: p.proto, NewInternalPort: p.port, NewInternalClient: lan, NewEnabled: 1, NewPortMappingDescription: `${description} ${p.name}`, NewLeaseDuration: 0 }); results.push({ ...p, ok: true }); }
    catch (e) { results.push({ ...p, ok: false, error: e.message }); }
  }
  let ext = null; try { ext = await externalIp(gw); } catch { /* optional */ }
  return { router: gw.name, lan, externalIp: ext, results };
}
async function unmap(ports) {
  const gw = await gateway(); const results = [];
  for (const p of ports) { try { await soap(gw, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: p.port, NewProtocol: p.proto }); results.push({ ...p, ok: true }); } catch (e) { results.push({ ...p, ok: false, error: e.message }); } }
  return { router: gw.name, results };
}
// Which of our ports the router currently forwards (walks the mapping table).
async function status(ports) {
  const gw = await gateway(); const lan = await lanIpFor(gw); const mapped = [];
  for (let i = 0; i < 200; i++) {
    let b; try { b = await soap(gw, 'GetGenericPortMappingEntry', { NewPortMappingIndex: i }); } catch { await new Promise(r => setTimeout(r, 500)); try { b = await soap(gw, 'GetGenericPortMappingEntry', { NewPortMappingIndex: i }); } catch { break; } }
    const g = k => (b.match(new RegExp(`<${k}>([^<]*)</${k}>`)) || [])[1];
    mapped.push({ port: Number(g('NewExternalPort')), proto: g('NewProtocol'), client: g('NewInternalClient'), desc: g('NewPortMappingDescription') });
  }
  let ext = null; try { ext = await externalIp(gw); } catch { /* optional */ }
  return { router: gw.name, lan, externalIp: ext, ports: ports.map(p => { const m = mapped.find(x => x.port === Number(p.port) && x.proto === p.proto); return { ...p, forwarded: !!m, toThisPc: !!m && m.client === lan, client: m ? m.client : null, desc: m ? m.desc : null }; }) };
}
module.exports = { gateway, map, unmap, status, externalIp };
