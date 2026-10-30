'use strict';
// Map page: zoom and pan over the satellite image, live player dots, heat overlays with a time filter,
// the loot spawn overlay, click-for-details and a distance measure. Loaded after app.js (shares its globals).

const mapState = { img: null, info: null, view: { scale: 1, ox: 0, oy: 0 }, players: [], hover: null, measure: null, loot: null, lootItem: '', drag: null, raf: null };
const CAUSE_COLORS = { player: '#ff5252', infected: '#6fd36f', animal: '#ff9f3b', vehicle: '#b784ff', explosion: '#ffe14d', fall: '#7fd3ff', suicide: '#c9c9c9', bleeding: '#ff8fa3', environment: '#9aa3ad', other: '#e0e0e0', unknown: '#777' };
const CAUSE_LABELS = { player: 'players', infected: 'infected', animal: 'animals', vehicle: 'vehicles', explosion: 'explosions', fall: 'falls', suicide: 'suicide', bleeding: 'bleeding out', environment: 'environment (hunger, sickness…)', other: 'other', unknown: 'unknown' };
const OVERLAY_KIND = { travel: null, hits: 1, building: 2, logouts: 3, logins: 4, deaths: 5 };

async function loadMapInfo() {
  mapState.info = await ipc.invoke('mission:mapInfo');
  const i = mapState.info;
  $('mapDetected').textContent = !i.map ? 'No active mission: install the server and set the template in serverDZ.cfg.'
    : `${i.label} (${i.mission}) · ${i.size ? i.size + ' m' : 'unknown size, assuming 15360 m'}${i.tiles ? ` · ${i.bundled ? 'built-in ' : ''}full-resolution map (${i.tiles.width.toLocaleString()} px, ${i.tiles.maxZ + 1} zoom levels)` : i.image ? ' · overview image only: rebuild for full resolution' : i.building ? ' · building the map from the game files…' : ' · no map image yet'}`;
  tileCache.clear();
  mapState.img = null;
  if (i.image) { await new Promise(res => { const im = new Image(); im.onload = () => { mapState.img = im; res(); }; im.onerror = () => res(); im.src = 'file:///' + i.image.replace(/\\/g, '/') + '?t=' + Date.now(); }); }
}
function worldSize() { return (mapState.info && mapState.info.size) || 15360; }
// base size: the map square fitted in the canvas; view scales/pans on top of it
function baseSize(c) { return Math.max(100, Math.min(c.width, c.height)); }
function toScreen(c, x, z) { const sz = baseSize(c); const v = mapState.view; const ox = (c.width - sz) / 2, oy = (c.height - sz) / 2; return [ox + (x / worldSize()) * sz * v.scale + v.ox, oy + (sz - (z / worldSize()) * sz) * v.scale + v.oy]; }
function toWorld(c, px, py) { const sz = baseSize(c); const v = mapState.view; const ox = (c.width - sz) / 2, oy = (c.height - sz) / 2; const bx = (px - ox - v.ox) / v.scale, by = (py - oy - v.oy) / v.scale; return [bx / sz * worldSize(), (sz - by) / sz * worldSize()]; }
function sizeCanvas() { const c = $('mapCanvas'); const card = c.parentElement; const W = Math.max(300, card.clientWidth - 30), H = Math.max(260, card.clientHeight - 54); if (c.width !== W || c.height !== H) { c.width = W; c.height = H; } return c; }
// ----- full-resolution tiles: the level that matches the zoom, only the visible tiles, kept in a small cache -----
const tileCache = new Map();
function tileImg(dir, z, x, y) {
  const k = z + '/' + x + '_' + y; let t = tileCache.get(k);
  if (!t) {
    t = { img: new Image(), ok: false, used: 0 }; t.img.onload = () => { t.ok = true; scheduleDraw(); }; t.img.onerror = () => { t.failed = true; };
    t.img.src = 'file:///' + dir.replace(/\\/g, '/') + '/' + z + '/' + x + '_' + y + '.jpg';
    tileCache.set(k, t);
    if (tileCache.size > 700) { const old = [...tileCache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 150); for (const [ok] of old) tileCache.delete(ok); }
  }
  t.used = Date.now(); return t;
}
function drawTiles(ctx, c, sz) {
  const T = mapState.info && mapState.info.tiles; if (!T) return;
  const v = mapState.view; const onScreen = sz * v.scale;
  const z = Math.max(0, Math.min(T.maxZ, T.maxZ + Math.ceil(Math.log2(Math.max(1, onScreen) / T.width))));
  const levelW = T.width / Math.pow(2, T.maxZ - z), levelH = T.height / Math.pow(2, T.maxZ - z), k = sz / levelW, step = T.tile * k;
  const ox = (c.width - sz) / 2 + v.ox, oy = (c.height - sz) / 2 + v.oy;
  const vx0 = -ox / v.scale, vy0 = -oy / v.scale, vx1 = (c.width - ox) / v.scale, vy1 = (c.height - oy) / v.scale;
  const nx = Math.ceil(levelW / T.tile), ny = Math.ceil(levelH / T.tile);
  const tx0 = Math.max(0, Math.floor(vx0 / step)), tx1 = Math.min(nx - 1, Math.floor(vx1 / step)), ty0 = Math.max(0, Math.floor(vy0 / step)), ty1 = Math.min(ny - 1, Math.floor(vy1 / step));
  ctx.imageSmoothingQuality = 'high';
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const t = tileImg(T.dir, z, tx, ty);
    // overlap by a fraction of a pixel so no hairline shows between tiles
    if (t.ok) ctx.drawImage(t.img, tx * step, ty * step, t.img.naturalWidth * k + 0.5 / v.scale, t.img.naturalHeight * k + 0.5 / v.scale);
  }
  mapState.tileLevel = { z, maxZ: T.maxZ };
}
function scheduleDraw() { if (mapState.raf) return; mapState.raf = requestAnimationFrame(() => { mapState.raf = null; drawMap(); }); }

async function drawMap() {
  if (!mapState.info) await loadMapInfo();
  const c = sizeCanvas(); const ctx = c.getContext('2d'); const sz = baseSize(c); const v = mapState.view;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.save(); ctx.translate((c.width - sz) / 2 + v.ox, (c.height - sz) / 2 + v.oy); ctx.scale(v.scale, v.scale);
  if (mapState.img) ctx.drawImage(mapState.img, 0, 0, sz, sz);
  else { ctx.fillStyle = '#1a1d22'; ctx.fillRect(0, 0, sz, sz); ctx.strokeStyle = '#2b3036'; ctx.lineWidth = 1 / v.scale; for (let i = 0; i <= 10; i++) { ctx.beginPath(); ctx.moveTo(i * sz / 10, 0); ctx.lineTo(i * sz / 10, sz); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i * sz / 10); ctx.lineTo(sz, i * sz / 10); ctx.stroke(); } }
  drawTiles(ctx, c, sz);
  ctx.restore();
  await drawOverlay(ctx, c);
  drawLoot(ctx, c);
  drawLiveLoot(ctx, c);
  drawZones(ctx, c);
  drawVehicles(ctx, c);
  drawWorld(ctx, c);
  // players: live positions (bridge script) for those online, the last logged position for everyone else
  if (!mapState.players.at || Date.now() - mapState.players.at > 15000) { try { const rows = await ipc.invoke('players:all', { sort: 'lastSeen', limit: 500 }); mapState.players = Object.assign(rows.filter(r => r.lastPos), { at: Date.now() }); } catch { mapState.players = Object.assign([], { at: Date.now() }); } }
  const L = adm.live; const liveOn = !!(L && L.available);
  const liveNames = new Set(liveOn ? L.players.map(p => p.name) : []);
  const pts = mapState.players.filter(r => !(liveOn && (r.online || liveNames.has(r.name))) && (!$('mapOnlineOnly').checked || r.online));
  ctx.font = '11px Segoe UI';
  for (const r of pts) {
    const [x, y] = toScreen(c, r.lastPos.x, r.lastPos.z);
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = r.online ? '#7cc47f' : '#e0b04e'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    const tw = ctx.measureText(r.name).width; ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x + 7, y - 7, tw + 6, 14); ctx.fillStyle = '#fff'; ctx.fillText(r.name, x + 10, y + 4);
  }
  if (liveOn) for (const p of L.players) drawLivePlayer(ctx, c, p);
  // measure line
  if (mapState.measure && mapState.measure.a) {
    const m = mapState.measure; const [ax, ay] = toScreen(c, m.a[0], m.a[1]); const b = m.b || m.cursor; if (b) { const [bx, by] = toScreen(c, b[0], b[1]); ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]); const dist = Math.hypot(b[0] - m.a[0], b[1] - m.a[1]); const label = dist >= 1000 ? (dist / 1000).toFixed(2) + ' km' : Math.round(dist) + ' m'; ctx.fillStyle = 'rgba(0,0,0,.7)'; const tw = ctx.measureText(label).width; ctx.fillRect((ax + bx) / 2 - tw / 2 - 4, (ay + by) / 2 - 9, tw + 8, 16); ctx.fillStyle = '#ffe14d'; ctx.fillText(label, (ax + bx) / 2 - tw / 2, (ay + by) / 2 + 4); }
  }
  // cursor coordinates
  const cur = mapState.hover; const coords = cur ? `${Math.round(cur[0])}, ${Math.round(cur[1])}` : '';
  $('mapInfo').textContent = `${adm.live && adm.live.available ? adm.live.players.length + ' online (live) · ' : ''}${pts.length} last seen · green = live, blue = god mode, amber = last seen · scroll to zoom, drag to pan, click a dot for details, Shift+click twice to measure · zoom ${v.scale.toFixed(1)}x${coords ? ' · cursor ' + coords : ''}`;
}

// ----- heat overlays -----
let heatCache = { at: 0, key: '', data: null };
function heatSince() { const r = $('mapRange').value; return r === 'all' ? 0 : Date.now() - Number(r) * 3600000; }
async function heatData() { const since = heatSince(); const key = String(since); if (heatCache.data && heatCache.key === key && Date.now() - heatCache.at < 5000) return heatCache.data; try { heatCache = { at: Date.now(), key, data: await ipc.invoke('heat:summary', since) }; } catch { heatCache = { at: Date.now(), key, data: null }; } return heatCache.data; }
function heatColor(t) { const stops = [[60, 120, 255], [60, 220, 120], [255, 220, 60], [255, 60, 30]]; const p = t * (stops.length - 1); const i = Math.min(stops.length - 2, Math.floor(p)); const f = p - i; return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f)); }
function drawHeatGrid(ctx, c, N, cells, max, alpha) {
  const size = worldSize(); const cellW = size / N; const [x0] = toScreen(c, 0, size); const [x1] = toScreen(c, cellW, size - cellW); const cellPx = Math.max(2, x1 - x0); const r = cellPx * 1.6;
  for (const [i, n] of cells) {
    const gx = i % N, gz = Math.floor(i / N); const t = Math.log(1 + n) / Math.log(1 + max); const [cr, cg, cb] = heatColor(t);
    const [x, y] = toScreen(c, (gx + 0.5) * cellW, (gz + 0.5) * cellW);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r); grad.addColorStop(0, `rgba(${cr},${cg},${cb},${(0.25 + 0.75 * t) * alpha})`); grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}
function binEvents(events, N, size, kind) { const grid = new Map(); let max = 0; for (const e of events) { if (kind !== null && e[3] !== kind) continue; const gx = Math.min(N - 1, Math.max(0, Math.floor(e[1] / size * N))), gz = Math.min(N - 1, Math.max(0, Math.floor(e[2] / size * N))); const i = gz * N + gx; const v = (grid.get(i) || 0) + 1; grid.set(i, v); if (v > max) max = v; } return { cells: [...grid.entries()], max }; }
async function drawOverlay(ctx, c) {
  const mode = $('mapOverlay').value; const info = $('mapOverlayInfo');
  if (mode === 'none' || mode === 'loot' || mode === 'liveloot' || mode === 'vehicles') { if (mode === 'none') info.textContent = ''; return; }
  const h = await heatData(); const alpha = Number($('mapOverlayAlpha').value) / 100;
  if (!h || (!h.events.length && !h.deaths.length)) { info.textContent = 'No data in this time range. It fills from the admin log (-adminlog) while players play; "Rebuild from all logs" reads older logs.'; return; }
  const N = h.N, size = h.size;
  if (mode in OVERLAY_KIND) {
    const kind = OVERLAY_KIND[mode]; const { cells, max } = binEvents(h.events, N, size, kind);
    drawHeatGrid(ctx, c, N, cells, max, alpha);
    const n = kind === null ? h.events.length : h.events.filter(e => e[3] === kind).length;
    const what = { travel: 'positions', hits: 'hits', building: 'build actions', logouts: 'logouts', logins: 'logins', deaths: 'deaths' }[mode];
    info.textContent = `${n.toLocaleString()} ${what} · blue = few, red = most`;
  } else if (mode === 'causes') {
    for (const d of h.deaths) { const [x, y] = toScreen(c, d.x, d.z); ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = CAUSE_COLORS[d.cause] || CAUSE_COLORS.unknown; ctx.globalAlpha = alpha; ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1; ctx.stroke(); }
    const order = Object.entries(h.causes).sort((a, b) => b[1] - a[1]);
    info.innerHTML = `<span class="map-legend">${order.map(([k, n]) => `<span style="--c:${CAUSE_COLORS[k] || CAUSE_COLORS.unknown}">${esc(CAUSE_LABELS[k] || k)} ${n}</span>`).join('')}</span>`;
  }
}

// ----- actual loot now (positions exported by the anti-dupe mod) -----
let liveLoot = null, liveLootAt = 0, liveLootPick = '';
async function loadLiveLoot(force) {
  if (!force && liveLoot && Date.now() - liveLootAt < 30000) return liveLoot;
  try { liveLoot = await ipc.invoke('anticheat:liveLoot'); liveLootAt = Date.now(); } catch (e) { toast(e.message, true); }
  return liveLoot;
}
function liveLootFiltered() {
  const L = liveLoot; if (!L || !L.available) return [];
  const q = $('liveLootSearch').value.trim().toLowerCase(); const cat = $('liveLootCat').value; const ground = $('liveLootGround').checked;
  const pick = liveLootPick.toLowerCase();
  return L.items.filter(it => (!pick || L.classes[it[0]].toLowerCase() === pick) && (!q || L.classes[it[0]].toLowerCase().includes(q)) && (!cat || L.classCat[it[0]] === cat) && (!ground || it[3] === 0));
}
function renderLiveLootList() {
  const L = liveLoot; const box = $('liveLootList');
  if (!L || !L.available) { box.innerHTML = `<div class="muted" style="padding:6px">${esc((L && L.reason) || 'No data yet.')}</div>`; $('liveLootWhen').textContent = ''; return; }
  $('liveLootWhen').textContent = 'as of ' + new Date(L.at).toLocaleTimeString();
  const cats = [...new Set([...L.classCat, ...(lootItems || []).map(i => i.category[0] || '')].filter(Boolean))].sort(); const sel = $('liveLootCat');
  if (sel.options.length !== cats.length + 1) { const cur = sel.value; sel.innerHTML = '<option value="">All types</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join(''); sel.value = cur; }
  const q = $('liveLootSearch').value.trim().toLowerCase(); const cat = $('liveLootCat').value; const ground = $('liveLootGround').checked;
  // counts of what is in the world now, keyed without case; then every economy item, with 0 when none is out
  const counts = new Map(), shown = new Map();
  for (const it of L.items) { if (ground && it[3] !== 0) continue; const n = L.classes[it[0]]; if (q && !n.toLowerCase().includes(q)) continue; if (cat && L.classCat[it[0]] !== cat) continue; const k = n.toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1); if (!shown.has(k)) shown.set(k, n); }
  for (const i of lootItems || []) { const k = i.name.toLowerCase(); if (shown.has(k)) { shown.set(k, i.name); continue; } if (q && !k.includes(q)) continue; if (cat && (i.category[0] || '') !== cat) continue; shown.set(k, i.name); }
  const rows = [...shown.entries()].map(([k, n]) => [n, counts.get(k) || 0]).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const total = [...counts.values()].reduce((x, y) => x + y, 0);
  box.innerHTML = `<div class="ip-item ${liveLootPick ? '' : 'on'}" data-name=""><span>All matching items (${rows.length.toLocaleString()} types)</span><span class="muted">${total.toLocaleString()}</span></div>` + rows.map(([n, k]) => `<div class="ip-item ${liveLootPick.toLowerCase() === n.toLowerCase() ? 'on' : ''}" data-name="${esc(n)}"><span>${esc(n)}</span><span class="muted">${k ? k.toLocaleString() : 'none in the world'}</span></div>`).join('');
}
function drawLiveLoot(ctx, c) {
  if ($('mapOverlay').value !== 'liveloot') return;
  const info = $('mapOverlayInfo'); const L = liveLoot;
  if (!L || !L.available) { info.textContent = (L && L.reason) || 'Loading…'; return; }
  const pts = liveLootFiltered(); const alpha = Number($('mapOverlayAlpha').value) / 100; const size = worldSize();
  if (mapState.view.scale >= 3 || pts.length <= 400) {
    for (const it of pts) { const [x, y] = toScreen(c, it[1], it[2]); ctx.beginPath(); ctx.arc(x, y, it[3] === 0 ? 3 : 2.5, 0, Math.PI * 2); ctx.fillStyle = it[3] === 0 ? `rgba(255,200,60,${0.5 + 0.5 * alpha})` : `rgba(120,190,255,${0.5 + 0.5 * alpha})`; ctx.fill(); }
  } else {
    const N = 128; const grid = new Map(); let max = 0;
    for (const it of pts) { const gx = Math.min(N - 1, Math.max(0, Math.floor(it[1] / size * N))), gz = Math.min(N - 1, Math.max(0, Math.floor(it[2] / size * N))); const i = gz * N + gx; const v = (grid.get(i) || 0) + 1; grid.set(i, v); if (v > max) max = v; }
    drawHeatGrid(ctx, c, N, grid, max, alpha);
  }
  const ground = pts.filter(it => it[3] === 0).length;
  info.textContent = `${pts.length.toLocaleString()} item(s)${liveLootPick ? ' of ' + liveLootPick : ''}: ${ground.toLocaleString()} on the ground, ${(pts.length - ground).toLocaleString()} in containers, tents or vehicles · as of ${new Date(L.at).toLocaleTimeString()} (updates every 5 min) · zoom in for single items (yellow = ground, blue = stored)`;
}

// ----- vehicles: spawn points from the mission, live positions from the anti-dupe mod -----
const VEH_COLORS = ['#ff5252', '#4fc3f7', '#ffd54f', '#81c784', '#ba68c8', '#ff8a65', '#90a4ae', '#f06292', '#aed581', '#7986cb'];
let vehSpawns = null, vehPick = '';
async function loadVehicles() {
  try { vehSpawns = await ipc.invoke('lootmap:vehicleSpawns'); } catch (e) { vehSpawns = []; toast(e.message, true); }
  await loadLiveLoot(true);
}
function vehColor(event) { const i = (vehSpawns || []).findIndex(e => e.event === event); return VEH_COLORS[(i < 0 ? 0 : i) % VEH_COLORS.length]; }
function vehEventOf(cls) { const lc = String(cls).toLowerCase(); const e = (vehSpawns || []).find(ev => ev.types.some(t => t.toLowerCase() === lc)); return e ? e.event : null; }
function liveVehicles() { return liveLoot && liveLoot.available && liveLoot.vehiclesKnown ? (liveLoot.vehicles || []) : null; }
function renderVehList() {
  const box = $('vehList'); const live = liveVehicles();
  $('vehWhen').textContent = live ? 'as of ' + new Date(liveLoot.at).toLocaleTimeString() : '';
  const counts = new Map(); for (const v of (live || [])) { const ev = vehEventOf(v.cls) || 'Other'; counts.set(ev, (counts.get(ev) || 0) + 1); }
  const rows = (vehSpawns || []).map(e => `<div class="ip-item ${vehPick === e.event ? 'on' : ''}" data-name="${esc(e.event)}" title="${esc(e.types.join(', '))}"><span><span class="veh-swatch" style="background:${vehColor(e.event)}"></span>${esc(e.event.replace(/^Vehicle/, ''))}</span><span class="muted">${e.positions.length} spots · ${live ? (counts.get(e.event) || 0) + ' now / ' : ''}nominal ${e.nominal ?? '?'}${e.active ? '' : ' · off'}</span></div>`);
  if (live && counts.get('Other')) rows.push(`<div class="ip-item ${vehPick === 'Other' ? 'on' : ''}" data-name="Other"><span><span class="veh-swatch" style="background:#ffffff"></span>Other vehicles</span><span class="muted">${counts.get('Other')} now</span></div>`);
  box.innerHTML = `<div class="ip-item ${vehPick ? '' : 'on'}" data-name=""><span>All vehicle types</span><span class="muted">${(vehSpawns || []).reduce((a, e) => a + e.positions.length, 0)} spots${live ? ' · ' + live.length + ' now' : ''}</span></div>` + rows.join('') + (live ? '' : `<div class="muted" style="padding:6px">${esc(liveLoot && liveLoot.available && !liveLoot.vehiclesKnown ? 'Vehicle positions need the anti-dupe mod v3, which installs itself at the next server start.' : (liveLoot && liveLoot.reason) || 'Where vehicles are now needs the anti-dupe server mod (Statistics → Dupe detection).')}</div>`);
}
function drawVehicles(ctx, c) {
  if ($('mapOverlay').value !== 'vehicles' || !vehSpawns) return;
  const alpha = Number($('mapOverlayAlpha').value) / 100; const zoomed = mapState.view.scale >= 2.5;
  let spots = 0, shown = 0;
  if ($('vehShowSpawns').checked) {
    for (const e of vehSpawns) {
      if (vehPick && vehPick !== e.event) continue;
      ctx.strokeStyle = vehColor(e.event); ctx.globalAlpha = 0.45 + 0.55 * alpha; ctx.lineWidth = 2;
      for (const p of e.positions) { const [x, y] = toScreen(c, p.x, p.z); ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke(); spots++; }
      ctx.globalAlpha = 1;
    }
  }
  const live = liveVehicles();
  if (live && $('vehShowLive').checked) {
    ctx.font = '11px Segoe UI';
    for (const v of live) {
      const ev = vehEventOf(v.cls) || 'Other'; if (vehPick && vehPick !== ev) continue;
      const [x, y] = toScreen(c, v.x, v.z); const col = ev === 'Other' ? '#ffffff' : vehColor(ev);
      ctx.fillStyle = col; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); ctx.stroke();
      if (zoomed) { const label = `${v.cls}${Number.isFinite(v.health) ? ' · ' + Math.round(v.health * 100) + '%' : ''}`; const tw = ctx.measureText(label).width; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x + 8, y - 7, tw + 6, 14); ctx.fillStyle = '#fff'; ctx.fillText(label, x + 11, y + 4); }
      shown++;
    }
  }
  $('mapOverlayInfo').textContent = `${spots.toLocaleString()} spawn point(s) (circles)${live ? ` · ${shown} vehicle(s) on the map now (squares, as of ${new Date(liveLoot.at).toLocaleTimeString()})` : ' · live positions need the anti-dupe mod'} · colours match the list · zoom in for names and condition`;
}

// ----- loot spawn overlay -----
let lootItems = null;
async function loadLootItems() { if (lootItems) return lootItems; try { lootItems = await ipc.invoke('lootmap:items'); } catch (e) { toast(e.message, true); lootItems = []; } return lootItems; }
function drawLoot(ctx, c) {
  if ($('mapOverlay').value !== 'loot' || !mapState.loot) return;
  const l = mapState.loot; const alpha = Number($('mapOverlayAlpha').value) / 100; const maxP = Math.max(1, ...l.spots.map(s => s.points));
  for (const s of l.spots) { const [x, y] = toScreen(c, s.x, s.z); const r = 2 + 4 * Math.sqrt(s.points / maxP) * Math.min(2, Math.sqrt(mapState.view.scale)); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = `rgba(255,120,40,${0.35 + 0.5 * alpha})`; ctx.fill(); }
  $('mapOverlayInfo').textContent = `${l.item.name}: can spawn in ${l.buildings.toLocaleString()} of ${l.totalBuildings.toLocaleString()} buildings (${l.points.toLocaleString()} loot points) · nominal ${l.item.nominal ?? '?'}, min ${l.item.min ?? '?'} · tiers ${l.item.value.join(', ') || 'any'} · usage ${l.item.usage.join(', ') || 'any'}${l.tiers ? '' : ' · tier regions not available (areaflags.map unreadable)'} · most common: ${l.top.slice(0, 4).map(t => t.name.replace(/^Land_/, '') + ' ×' + t.count).join(', ')}`;
}
async function pickLootItem(name) {
  mapState.lootItem = name; mapState.loot = null;
  if (!name) { scheduleDraw(); return; }
  try { mapState.loot = await ipc.invoke('lootmap:spawns', name); } catch (e) { toast(e.message, true); }
  scheduleDraw();
}
function renderLootList() {
  const q = $('lootSearch').value.trim().toLowerCase(); const box = $('lootList');
  const rows = (lootItems || []).filter(i => !q || i.name.toLowerCase().includes(q));
  box.innerHTML = rows.map(i => `<div class="ip-item ${mapState.lootItem === i.name ? 'on' : ''}" data-name="${esc(i.name)}"><span>${esc(i.name)}</span><span class="muted">${esc(i.category[0] || '')}${i.value.length ? ' · ' + esc(i.value.join('/')) : ''}</span></div>`).join('') || '<div class="muted" style="padding:6px">No items match.</div>';
}

// ----- interaction -----
function mapInit() {
  const c = $('mapCanvas');
  c.addEventListener('wheel', e => { e.preventDefault(); const rect = c.getBoundingClientRect(); const px = e.clientX - rect.left, py = e.clientY - rect.top; const v = mapState.view; const f = e.deltaY < 0 ? 1.2 : 1 / 1.2; const ns = Math.min(40, Math.max(1, v.scale * f)); const k = ns / v.scale; const sz = baseSize(c); const ox = (c.width - sz) / 2, oy = (c.height - sz) / 2; v.ox = px - ox - (px - ox - v.ox) * k; v.oy = py - oy - (py - oy - v.oy) * k; v.scale = ns; if (ns === 1) { v.ox = 0; v.oy = 0; } scheduleDraw(); }, { passive: false });
  c.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    // painting loot tiers: a click or a drag paints sectors instead of panning
    if (tiers.paint && zoneOn()) { const rect = c.getBoundingClientRect(); tiers.dragging = true; paintAt(c, e.clientX - rect.left, e.clientY - rect.top); return; }
    mapState.drag = { x: e.clientX, y: e.clientY, ox: mapState.view.ox, oy: mapState.view.oy, moved: false };
  });
  window.addEventListener('mousemove', e => {
    const rect = c.getBoundingClientRect(); const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (tiers.dragging) { if (inside) paintAt(c, e.clientX - rect.left, e.clientY - rect.top); return; }
    if (inside && zoneOn() && document.querySelector('#page-map.active')) { const before = mapState.hover; mapState.hover = toWorld(c, e.clientX - rect.left, e.clientY - rect.top); if (!before || sectorAt(before[0], before[1]) !== sectorAt(mapState.hover[0], mapState.hover[1])) scheduleDraw(); }
    if (mapState.drag) { const dx = e.clientX - mapState.drag.x, dy = e.clientY - mapState.drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) mapState.drag.moved = true; mapState.view.ox = mapState.drag.ox + dx; mapState.view.oy = mapState.drag.oy + dy; scheduleDraw(); return; }
    if (!inside || !document.querySelector('#page-map.active')) return;
    const w = toWorld(c, e.clientX - rect.left, e.clientY - rect.top); mapState.hover = w; if (mapState.measure && mapState.measure.a && !mapState.measure.b) { mapState.measure.cursor = w; scheduleDraw(); } else { const el = $('mapInfo'); const t = el.textContent.replace(/ · cursor .*$/, ''); el.textContent = t + ` · cursor ${Math.round(w[0])}, ${Math.round(w[1])}`; }
  });
  window.addEventListener('mouseup', e => {
    if (tiers.dragging) { tiers.dragging = false; return; }
    const d = mapState.drag; mapState.drag = null; if (!d) return;
    if (d.moved) return;
    const rect = c.getBoundingClientRect(); const px = e.clientX - rect.left, py = e.clientY - rect.top; const w = toWorld(c, px, py);
    if (e.shiftKey) { const m = mapState.measure; if (!m || m.b) mapState.measure = { a: w, b: null, cursor: w }; else m.b = w; scheduleDraw(); return; }
    if (adm.pickTp) { const p = livePlayer(adm.pickTp); adm.pickTp = null; c.style.cursor = ''; if (p) withReason(`Teleport ${p.name} to ${Math.round(w[0])}, ${Math.round(w[1])}`, '', 'Teleport', (why) => admAct('tp', p, { x: w[0], z: w[1], reason: why })); return; }
    if (adm.pickVtp) { const v = liveVeh(adm.pickVtp); adm.pickVtp = null; c.style.cursor = ''; if (v) withReason(`Move ${v.cls} to ${Math.round(w[0])}, ${Math.round(w[1])}`, '', 'Move', (why) => admVact('vtp', v, { x: w[0], z: w[1], reason: why })); return; }
    { const hit = liveAt(c, px, py); if (hit) { admSelect(hit.id); return; } }
    { const wh = worldAt(c, px, py); if (wh && wh.kind === 'vehicle') { adm.selVeh = wh.obj.id; renderVehPanel(); scheduleDraw(); return; } }
    // click a player dot
    for (const r of mapState.players) { const [x, y] = toScreen(c, r.lastPos.x, r.lastPos.z); if (Math.hypot(px - x, py - y) <= 7) { showPlayerPopup(r); return; } }
    // click a loot spot
    if (mapState.loot) { let best = null, bd = 9; for (const s of mapState.loot.spots) { const [x, y] = toScreen(c, s.x, s.z); const dd = Math.hypot(px - x, py - y); if (dd < bd) { bd = dd; best = s; } } if (best) { toast(`${best.name.replace(/^Land_/, '')} at ${Math.round(best.x)}, ${Math.round(best.z)} · ${best.points} matching loot point(s)`); return; } }
    if (mapState.measure) { mapState.measure = null; scheduleDraw(); }
  });
  c.addEventListener('dblclick', () => { mapState.view = { scale: 1, ox: 0, oy: 0 }; scheduleDraw(); });
  $('mapOverlay').onchange = async () => { const loot = $('mapOverlay').value === 'loot'; const live = $('mapOverlay').value === 'liveloot'; const veh = $('mapOverlay').value === 'vehicles'; $('lootPanel').hidden = !loot; $('liveLootPanel').hidden = !live; $('vehPanel').hidden = !veh; if (veh) { await loadVehicles(); renderVehList(); } if (loot) { await loadLootItems(); renderLootList(); } if (live) { await Promise.all([loadLiveLoot(true), loadLootItems()]); renderLiveLootList(); } scheduleDraw(); };
  const liveRefresh = () => { renderLiveLootList(); scheduleDraw(); };
  $('liveLootSearch').addEventListener('input', () => { liveLootPick = ''; liveRefresh(); }); $('liveLootCat').onchange = () => { liveLootPick = ''; liveRefresh(); }; $('liveLootGround').onchange = liveRefresh;
  $('liveLootList').addEventListener('click', e => { const it = e.target.closest('.ip-item'); if (!it) return; liveLootPick = it.dataset.name || ''; liveRefresh(); });
  setInterval(async () => { if ($('mapOverlay').value === 'liveloot' && document.querySelector('#page-map.active')) { await loadLiveLoot(true); liveRefresh(); } if ($('mapOverlay').value === 'vehicles' && document.querySelector('#page-map.active')) { await loadLiveLoot(true); renderVehList(); scheduleDraw(); } }, 60000);
  $('vehList').addEventListener('click', e => { const it = e.target.closest('.ip-item'); if (!it) return; vehPick = it.dataset.name || ''; renderVehList(); scheduleDraw(); });
  $('vehShowSpawns').onchange = $('vehShowLive').onchange = () => scheduleDraw();
  $('mapOverlayAlpha').oninput = scheduleDraw; $('mapRange').onchange = () => { heatCache.at = 0; scheduleDraw(); };
  $('lootSearch').addEventListener('input', renderLootList);
  $('lootList').addEventListener('click', e => { const it = e.target.closest('.ip-item'); if (!it) return; pickLootItem(it.dataset.name); renderLootList(); });
  $('btnHeatRebuild').onclick = (e) => run(async () => { const r = await ipc.invoke('heat:rebuild'); heatCache.at = 0; toast(`Read ${r.files} log file(s): ${r.positions.toLocaleString()} positions, ${r.deaths} deaths`); scheduleDraw(); }, e.target);
  $('btnHeatClear').onclick = (e) => run(async () => { const ok = await showModal('Clear the heatmap data for this map?', '', [{ label: 'Clear', value: true, primary: true }, { label: 'Cancel', value: false }]); if (!ok) return; await ipc.invoke('heat:clear'); heatCache.at = 0; scheduleDraw(); }, e.target);
  $('btnMapPickImage').onclick = () => run(async () => { const f = await ipc.invoke('dialog:pickFile', { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }); if (!f) return; await ipc.invoke('mission:setMapImage', f); await loadMapInfo(); scheduleDraw(); toast('Map image saved for ' + mapState.info.label); });
  $('btnMapOpenDir').onclick = () => ipc.invoke('mission:openMapsDir');
  $('btnMapRefresh').onclick = () => run(async () => { heatCache.at = 0; mapState.players.at = 0; await loadMapInfo(); scheduleDraw(); }); $('mapOnlineOnly').onchange = scheduleDraw;
  $('btnMapBuild').onclick = (e) => run(() => ensureMapImage(true), e.target);
  $('btnMapSaveImage').onclick = (e) => run(async () => { const f = await ipc.invoke('mission:exportMapImage'); if (f) toast('Map image saved: copy it to the server PC and use "Set map image…" there'); }, e.target);
  ipc.on('map:progress', p => { if (p.error) { $('mapDetected').textContent = 'Map build failed: ' + p.error; return; } if (!p.done) $('mapDetected').textContent = `Building the map image from the game files… ${Math.round((p.progress || 0) * 100)}%`; });
  window.addEventListener('resize', () => { if (document.querySelector('#page-map.active') && mapState.info) scheduleDraw(); });
}
let mapBuildTried = null, mapLiveTimer = null;
function showMapNotice(text) { const n = $('mapNotice'); if (!n) return; n.hidden = !text; n.textContent = text || ''; }
async function ensureMapImage(force) {
  const i = mapState.info; if (!i || !i.map) return;
  showMapNotice(i.image ? '' : (i.canBuild === false ? i.noClientText : ''));
  if (i.image && !force && (i.tiles || i.canBuild === false)) return;
  // without the DayZ client there is nothing to build from: the notice says what to do instead of an error
  if (!force && i.canBuild === false) return;
  if (!force && mapBuildTried === i.map) return;
  mapBuildTried = i.map;
  try { toast('Building the full-resolution ' + (i.label || i.map) + ' map from the game files (about a minute)…'); await ipc.invoke('mission:buildMap', { force: !!force }); await loadMapInfo(); scheduleDraw(); toast('Map image ready'); }
  catch (e) { if (/placeholder tiles|no map to build from/i.test(e.message)) { showMapNotice(mapState.info && mapState.info.noClientText || e.message); if (force) toast('This PC has no DayZ client to build the map from; see the note on the map.', true); } else toast(e.message, true); }
  if (mapState.info && mapState.info.image) showMapNotice('');
}
function mapLive(on) { if (on) loadKits(); clearInterval(adm.timer); adm.timer = on ? setInterval(pollLive, 1500) : null; if (on) pollLive(); clearInterval(mapLiveTimer); mapLiveTimer = null; if (on) mapLiveTimer = setInterval(() => { if (document.querySelector('#page-map.active')) { mapState.players.at = 0; scheduleDraw(); } else mapLive(false); }, 5000); }
function showPlayerPopup(r) {
  const body = `<div class="muted mono">${esc(r.id || '')}${r.steamId ? '<br>Steam64 ' + esc(r.steamId) : ''}</div>
    <div class="grid-2 tight pdb-kv"><div><span class="muted">Status</span><br>${r.online ? 'online' : 'last seen ' + fmtDate(r.lastSeen)}</div><div><span class="muted">Position</span><br>${Math.round(r.lastPos.x)}, ${Math.round(r.lastPos.z)}</div>
    <div><span class="muted">Playtime</span><br>${fmtPlaytime(r.playtimeSec)}</div><div><span class="muted">Kills / deaths</span><br>${r.kills} / ${r.deaths}</div></div>
    ${r.banned ? '<span class="badge bad">banned</span> ' : ''}${r.whitelisted ? '<span class="badge ok">whitelist</span> ' : ''}${r.account && r.account.suspicious ? '<span class="badge warn">⚠ suspicious</span>' : ''}`;
  showModal(r.name, body, [{ label: 'Open in Database', value: 'db', primary: true }, { label: 'Close', value: false }]).then(v => { if (v === 'db') { pdbSelected = r.key; showPage('database'); } });
}
// ----- live admin: players online now, their actions -----
const adm = { live: null, world: null, zones: null, selZone: null, pickZone: null, sel: null, selVeh: null, pickTp: null, pickVtp: null, follow: false, timer: null, kits: [], vehicles: [], afflictions: [] };
const BREAK_KINDS = [['tyres', 'Flat tyres'], ['fuel', 'Drain the fuel'], ['engine', 'Ruin the engine'], ['battery', 'Ruin the battery'], ['all', 'Everything']];
async function loadKits() { try { [adm.kits, adm.vehicles] = await Promise.all([ipc.invoke('live:kits'), ipc.invoke('live:vehicles')]); } catch { /* no mission yet */ } if (!adm.afflictions.length) try { adm.afflictions = (await ipc.invoke('live:actions')).AFFLICTIONS || []; } catch { /* older main */ } }
const HEALS = [['all', 'Heal everything'], ['health', 'Health, blood and shock'], ['bleeding', 'Stop bleeding'], ['bones', 'Fix broken bones'], ['cure', 'Cure diseases'], ['food', 'Food and water']];
const livePlayer = (id) => adm.live && adm.live.available ? adm.live.players.find(p => p.id === id) : null;
function liveAt(c, px, py) { if (!adm.live || !adm.live.available) return null; let best = null, bd = 9; for (const p of adm.live.players) { const [x, y] = toScreen(c, p.x, p.z); const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = p; } } return best; }
function drawLivePlayer(ctx, c, p) {
  const [x, y] = toScreen(c, p.x, p.z); const sel = p.id === adm.sel;
  const color = !p.alive ? '#8a8f98' : p.god ? '#6fa8ff' : '#46d36a';
  // heading: a wedge pointing where they face (0 = north, clockwise)
  const h = (p.heading || 0) * Math.PI / 180; ctx.beginPath(); ctx.moveTo(x + Math.sin(h) * 13, y - Math.cos(h) * 13); ctx.lineTo(x + Math.sin(h + 2.5) * 6, y - Math.cos(h + 2.5) * 6); ctx.lineTo(x + Math.sin(h - 2.5) * 6, y - Math.cos(h - 2.5) * 6); ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2; ctx.stroke();
  if (sel) { ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2; ctx.stroke(); }
  const label = p.name + (p.vehicle ? ' · ' + p.vehicle : '') + (!p.alive ? ' · dead' : '');
  const tw = ctx.measureText(label).width; ctx.fillStyle = sel ? 'rgba(60,50,0,.8)' : 'rgba(0,0,0,.6)'; ctx.fillRect(x + 9, y - 8, tw + 6, 15); ctx.fillStyle = '#fff'; ctx.fillText(label, x + 12, y + 3);
}
function centreOn(p) {
  const c = $('mapCanvas'); const v = mapState.view;
  if (v.scale < 4) { v.scale = 4; v.ox = 0; v.oy = 0; }
  const [x, y] = toScreen(c, p.x, p.z); v.ox += c.width / 2 - x; v.oy += c.height / 2 - y; scheduleDraw();
}
function admSelect(id) { adm.sel = id; renderAdmin(); scheduleDraw(); }
async function pollLive() {
  if (!document.querySelector('#page-map.active')) return;
  try { adm.live = await ipc.invoke('live:players'); } catch (e) { adm.live = { available: false, reason: e.message, players: [] }; }
  try { adm.world = await ipc.invoke('live:world'); } catch (e) { adm.world = { available: false, reason: e.message, vehicles: [], flags: [] }; }
  try { const prev = adm.zones && adm.zones.available ? adm.zones.result.seq : null; adm.zones = await ipc.invoke('drpzones:state'); zoneResultToast(prev, adm.zones); } catch (e) { adm.zones = { available: false, reason: e.message }; }
  if (adm.zones && adm.zones.available) { await loadSectors(); if (!tiers.data) await loadTiers(); }
  renderTierPanel();
  const p = livePlayer(adm.sel); if (adm.follow && p) centreOn(p);
  renderAdmin(); renderVehPanel(); scheduleDraw();
}
function renderAdmin() {
  const L = adm.live; const box = $('admList'); const q = $('admSearch').value.trim().toLowerCase();
  if (!L || !L.available) { box.innerHTML = `<div class="muted" style="padding:6px">${esc((L && L.reason) || 'Loading…')}</div>`; $('admWhen').textContent = ''; $('admSel').hidden = true; return; }
  $('admWhen').textContent = `${L.players.length} online · live`;
  const rows = L.players.filter(p => !q || p.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  box.innerHTML = rows.map(p => `<div class="ip-item ${p.id === adm.sel ? 'on' : ''}" data-id="${esc(p.id)}"><span>${esc(p.name)}${p.god ? ' <span class="badge">god</span>' : ''}</span><span class="muted">${!p.alive ? 'dead' : Math.round(p.health * 100) + '%'}${p.vehicle ? ' · 🚗' : ''}</span></div>`).join('') || '<div class="muted" style="padding:6px">No players online.</div>';
  const s = livePlayer(adm.sel); const el = $('admSel');
  if (!s) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>${esc(s.name)}</b><div class="muted">${Math.round(s.x)}, ${Math.round(s.z)} · health ${Math.round(s.health * 100)}% · blood ${Math.round(s.blood)}${s.vehicle ? ' · in ' + esc(s.vehicle) : ''}${s.god ? ' · god mode' : ''}</div>
    <div class="row gap"><button class="btn small" data-a="heal">Heal</button><button class="btn small" data-a="tpmap" title="Then click the map where they should go">Teleport…</button><button class="btn small" data-a="refund">Refund</button><button class="btn small" data-a="give">Give…</button><button class="btn small" data-a="kit">Kit ▾</button><button class="btn small" data-a="menu">More ▾</button></div>
    <label class="check"><input type="checkbox" id="admFollow" ${adm.follow ? 'checked' : ''}> Follow on the map</label>`;
}
async function admAct(action, p, args = {}) {
  try {
    const r = await ipc.invoke('live:act', action, p.id, args);
    if (r && r.status === 'pending') return toast('The game picked it up but has not answered yet; it finishes in a moment.');
    if (action === 'strip') { toast(`${p.name} stripped: ${r.ok} item(s) dropped at their feet`); pollLive(); return; }
    const msg = { heal: 'healed', tp: 'teleported', tpto: 'teleported', bring: 'brought over', kill: 'killed', god: args.on ? 'is in god mode' : 'is no longer in god mode', tpdeath: 'teleported to their last death', message: 'messaged', kick: 'kicked', ban: 'banned', afflict: 'afflicted: ' + ((adm.afflictions.find(a => a[0] === args.what) || [, args.what])[1]).toLowerCase(), freeze: args.on ? 'is frozen in place' : 'can move again', invisible: args.on ? 'is invisible' : 'is visible again', respawn: 'killed and their body removed' }[action];
    if (action === 'give' || action === 'kit') toast(`Gave ${p.name} ${r.ok} item(s)${action === 'kit' ? ' from kit ' + args.kit : ' of ' + args.item}${r.fail ? ` (${r.fail} failed: is every class name right?)` : ''}`, !r.ok);
    else if (action === 'vehicle') toast(r.ok ? `${args.vehicle} is ready next to ${p.name} (${r.ok} part(s)${r.fail ? `, ${r.fail} failed` : ''})` : `${args.vehicle} could not be spawned`, !r.ok);
    else if (action === 'refund') toast(r.ok ? `Refunded ${r.ok} of ${r.items} items to ${p.name} (death #${r.deathId})${r.body === 'body' ? ' · body removed' : r.body === 'nobody' ? ' · no body found to remove' : ''}` : `Nothing could be spawned for ${p.name}`, !r.ok);
    else toast(`${p.name} ${msg}`);
    pollLive();
  } catch (e) { toast(e.message, true); }
}
function closeCtx() { const m = document.getElementById('ctxMenu'); if (m) m.remove(); }
function ctxBuild(items) {
  const m = document.createElement('div');
  for (const it of items) {
    if (it.sep) { const d = document.createElement('div'); d.className = 'ctx-sep'; m.appendChild(d); continue; }
    if (it.header) { const d = document.createElement('div'); d.className = 'ctx-head'; d.textContent = it.header; m.appendChild(d); continue; }
    const d = document.createElement('div'); d.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    const t = document.createElement('span'); t.textContent = it.label; d.appendChild(t);
    if (it.sub) { const ar = document.createElement('span'); ar.className = 'muted'; ar.textContent = '▸'; d.appendChild(ar); const sub = ctxBuild(it.sub.length ? it.sub : [{ label: 'nobody else online', disabled: true }]); sub.className = 'ctx-sub'; d.appendChild(sub); }
    else if (!it.disabled) d.addEventListener('click', (e) => { e.stopPropagation(); closeCtx(); it.run(); });
    m.appendChild(d);
  }
  return m;
}
function showCtx(items, x, y) {
  closeCtx(); const m = ctxBuild(items); m.id = 'ctxMenu'; m.className = 'ctx-menu'; document.body.appendChild(m);
  const r = m.getBoundingClientRect(); m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'; m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
const ask = (title, body, label = 'OK', danger = false) => showModal(title, body, [{ label, value: true, primary: true }, { label: 'Cancel', value: false }]);
// the reason box every accountable action carries; required when the setting says so
let reasonRequired = true;
ipc.invoke('adminlog:cfg').then(c => { reasonRequired = c.requireReason !== false; }).catch(() => {});
const reasonField = (ph = 'Why (posted to the admin action channel)', required = reasonRequired) => `<label class="field">Reason${required ? '' : ' / ticket (optional)'} <input id="admWhy" class="input" placeholder="${ph}"></label>`;
const reason = () => ($('admWhy') ? $('admWhy').value.trim() : '');
// every action asks why; refunds (explained by their death and ticket) only offer the box
const withReason = async (title, body, label, run, required = reasonRequired) => { const ok = await ask(title, body + reasonField(undefined, required), label); if (!ok) return; if (required && !reason()) return toast('Give a reason.', true); run(reason()); };
function playerMenu(p) {
  const others = (adm.live.players || []).filter(o => o.id !== p.id);
  return [
    { header: p.name + (p.god ? ' (god mode)' : '') + (!p.alive ? ' (dead)' : '') },
    { label: 'Heal', sub: HEALS.map(([k, l]) => ({ label: l, run: () => withReason(`Heal ${p.name}: ${l.toLowerCase()}`, '', 'Heal', (why) => admAct('heal', p, { what: k, reason: why })) })) },
    { label: 'Teleport to player', sub: others.map(o => ({ label: o.name, run: () => withReason(`Teleport ${p.name} to ${o.name}`, '', 'Teleport', (why) => admAct('tpto', p, { to: o.id, reason: why })) })) },
    { label: 'Bring a player to them', sub: others.map(o => ({ label: o.name, run: () => withReason(`Bring ${o.name} to ${p.name}`, '', 'Bring', (why) => admAct('bring', p, { to: o.id, reason: why })) })) },
    { label: 'Teleport by clicking the map', run: () => { adm.sel = p.id; adm.pickTp = p.id; $('mapCanvas').style.cursor = 'crosshair'; renderAdmin(); toast(`Click the map where ${p.name} should go (Esc cancels)`); } },
    { label: 'Teleport to their last death', run: () => withReason(`Teleport ${p.name} to their last death`, '', 'Teleport', (why) => admAct('tpdeath', p, { reason: why })) },
    { sep: true },
    { label: 'Refund their last death…', run: () => withReason('Refund last death', `<p>Spawn the gear ${esc(p.name)} had at their last recorded death, pristine, at their feet? Their body is removed.</p>`, 'Refund', (why) => admAct('refund', p, { reason: why }), false) },
    { label: 'Give item…', run: () => giveDialog(p) },
    { label: 'Give kit', sub: [...adm.kits.map(k => ({ label: `${k.name} (${k.items})`, run: () => withReason(`Give ${p.name} the kit ${k.name}`, '', 'Give', (why) => admAct('kit', p, { kit: k.name, reason: why })) })), { label: 'Manage kits…', run: () => kitManager() }] },
    { label: 'Spawn a vehicle next to them', sub: adm.vehicles.map(v => ({ label: v.name, run: () => withReason(`Spawn ${v.name} next to ${p.name}`, '<p class="muted">Every part fitted, every fluid full.</p>', 'Spawn', (why) => admAct('vehicle', p, { vehicle: v.name, reason: why })) })) },
    { label: p.god ? 'Turn god mode off' : 'Turn god mode on', run: () => withReason(`God mode ${p.god ? 'off' : 'on'} for ${p.name}`, '', 'OK', (why) => admAct('god', p, { on: !p.god, reason: why })) },
    { sep: true },
    { label: 'Message…', run: async () => { if (await ask(`Message ${p.name}`, '<input id="admMsg" class="input" placeholder="Only they see it">', 'Send')) admAct('message', p, { text: $('admMsg').value }); } },
    { label: 'Kick…', danger: true, run: () => withReason(`Kick ${p.name}?`, '<p class="muted">The reason is shown to them.</p>', 'Kick', (why) => admAct('kick', p, { reason: why })) },
    { label: 'Ban…', danger: true, run: () => withReason(`Ban ${p.name}?`, `<p>Adds Steam64 ${esc(p.steam)} to ban.txt and kicks them now.</p>`, 'Ban', (why) => admAct('ban', p, { reason: why })) },
    { label: 'Afflict', sub: afflictMenu(p) },
    { label: p.frozen ? 'Unfreeze' : 'Freeze in place', run: () => withReason(`${p.frozen ? 'Unfreeze' : 'Freeze'} ${p.name}`, p.frozen ? '' : '<p class="muted">They cannot move until unfrozen (survives a reconnect).</p>', 'OK', (why) => admAct('freeze', p, { on: !p.frozen, reason: why })) },
    { label: p.invisible ? 'Make visible again' : 'Make invisible', run: () => withReason(`${p.invisible ? 'Show' : 'Hide'} ${p.name}`, '', 'OK', (why) => admAct('invisible', p, { on: !p.invisible, reason: why })) },
    { label: 'Strip all gear…', danger: true, run: () => withReason(`Strip ${p.name}?`, '<p>Everything they carry drops at their feet.</p>', 'Strip', (why) => admAct('strip', p, { reason: why })) },
    { label: 'Respawn (kill, body removed)…', danger: true, run: () => withReason(`Respawn ${p.name}?`, '<p>Their character dies and the body with all its gear is removed a moment later, so they start fresh.</p>', 'Respawn', (why) => admAct('respawn', p, { reason: why })) },
    { label: 'Kill…', danger: true, run: () => withReason(`Kill ${p.name}?`, '<p>Their character dies where it stands.</p>', 'Kill', (why) => admAct('kill', p, { reason: why })) },
    { sep: true },
    { label: 'Centre the map on them', run: () => centreOn(p) },
    { label: 'Open in the database', run: () => { pdbSelected = p.id; showPage('database'); } }
  ];
}
function afflictMenu(p) {
  const items = []; let group = '';
  for (const [what, label, grp] of adm.afflictions) { if (grp !== group) { group = grp; items.push({ header: grp }); } items.push({ label, run: () => withReason(`${label} · ${p.name}`, '', 'Apply', (why) => admAct('afflict', p, { what, reason: why })) }); }
  items.push({ sep: true });
  for (const [kind, label] of [['health', 'Health to a percentage…'], ['blood', 'Blood to a percentage…'], ['bleed', 'Bleeding wounds, how many…']]) items.push({ label, run: () => withReason(`${label.replace('…', '')} · ${p.name}`, `<label class="field">${kind === 'bleed' ? 'Wounds (1–8)' : 'Percent (5–100)'} <input id="admAmt" class="input short" type="number" value="${kind === 'bleed' ? 3 : 25}" min="${kind === 'bleed' ? 1 : 5}" max="${kind === 'bleed' ? 8 : 100}"></label>`, 'Apply', (why) => admAct('afflict', p, { what: `${kind}:${Math.round(Number($('admAmt').value) || 0)}`, reason: why })) });
  return items;
}
async function giveDialog(p) {
  await loadLootItems();
  const ok = await ask(`Give ${p.name} an item`, `<label class="field">Item class <input id="admItem" class="input" list="admItems" placeholder="e.g. BandageDressing"></label><datalist id="admItems">${(lootItems || []).map(i => `<option value="${esc(i.name)}">`).join('')}</datalist><label class="field">How many <input id="admCount" class="input short" type="number" min="1" max="50" value="1"></label><p class="muted small">Goes into their inventory where it fits, otherwise at their feet.</p>` + reasonField(), 'Give');
  if (!ok) return; if (reasonRequired && !reason()) return toast('Give a reason or ticket number.', true);
  admAct('give', p, { item: $('admItem').value.trim(), count: Number($('admCount').value) || 1, reason: reason() });
}
async function spawnHere(w, args, what) {
  try { const r = await ipc.invoke('live:spawnAt', { x: w[0], z: w[1], ...args }); if (r.status === 'pending') return toast('The game picked it up but has not answered yet.'); toast(r.ok ? `${what}: spawned ${r.ok} item(s) at ${Math.round(w[0])}, ${Math.round(w[1])}${r.fail ? ` (${r.fail} failed)` : ''}` : `${what} could not be spawned (is the class name right?)`, !r.ok); }
  catch (e) { toast(e.message, true); }
}
async function spawnItemDialog(w) {
  await loadLootItems();
  const ok = await ask(`Spawn at ${Math.round(w[0])}, ${Math.round(w[1])}`, `<label class="field">Item class <input id="admItem" class="input" list="admItems" placeholder="e.g. AKM; AK_WoodBttstck"></label><datalist id="admItems">${(lootItems || []).map(i => `<option value="${esc(i.name)}">`).join('')}</datalist><label class="field">How many <input id="admCount" class="input short" type="number" min="1" max="50" value="1"></label>` + reasonField(), 'Spawn');
  if (!ok) return; if (reasonRequired && !reason()) return toast('Give a reason or ticket number.', true);
  spawnHere(w, { item: $('admItem').value.trim(), count: Number($('admCount').value) || 1, reason: reason() }, $('admItem').value.trim());
}
// Kits: saved item lists, one item per line
async function kitManager(edit = null) {
  await loadKits(); await loadLootItems();
  const k = edit ? adm.kits.find(x => x.name === edit) : null;
  const list = adm.kits.map(x => `<div class="row gap"><span class="grow">${esc(x.name)} <span class="muted">(${x.items} line${x.items === 1 ? '' : 's'})</span></span><button class="btn small kit-edit" data-name="${esc(x.name)}">Edit</button><button class="btn small danger kit-del" data-name="${esc(x.name)}">Delete</button></div>`).join('') || '<p class="muted">No kits yet.</p>';
  const cats = [...new Set((lootItems || []).map(i => i.category[0] || '').filter(Boolean))].sort();
  const body = `<div class="kit-list">${list}</div><div class="card-title mt">${k ? 'Edit ' + esc(k.name) : 'New kit'}</div>
    <label class="field">Name <input id="kitName" class="input" value="${esc(k ? k.name : '')}" placeholder="e.g. Starter, Sniper, Medic"></label>
    <div class="kit-editor" id="kitPicker">
      <div class="kit-left">
        <div class="muted small">In the kit <span id="kitCount"></span></div>
        <div id="kitRows" class="ip-list kit-rows"></div>
        <details><summary class="muted small">As text (one item per line; "Class x3" gives three; "Parent; Attachment; …" fits attachments)</summary><textarea id="kitLines" class="input mono" rows="6">${esc(k ? (k.lines || []).join('\n') : '')}</textarea></details>
      </div>
      <div class="kit-right">
        <div class="row gap"><input id="kitSearch" class="input" placeholder="Search every item in the economy…"><select id="kitCat" class="input" style="width:120px"><option value="">All types</option>${cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select></div>
        <div class="muted small">Click an item to add it (again for one more); <b>attach</b> fits it onto the last item (stock, magazine, optic…).</div>
        <div id="kitItems" class="ip-list kit-items"></div>
      </div>
    </div>
    <p class="muted small">Everything spawns pristine and full.</p>`;
  const p = showModal('Kits', body, [{ label: 'Save kit', value: 'save', primary: true }, { label: 'Close', value: null }]);
  setTimeout(() => {
    for (const b of document.querySelectorAll('.kit-edit')) b.onclick = () => { $('modalActions').lastElementChild.click(); kitManager(b.dataset.name); };
    for (const b of document.querySelectorAll('.kit-del')) b.onclick = async () => { await ipc.invoke('live:deleteKit', b.dataset.name); toast(`Kit ${b.dataset.name} deleted`); $('modalActions').lastElementChild.click(); kitManager(); };
    // the text box is the kit; the rows and the picker edit it
    const parse = (l) => { const m = l.trim().match(/^(.*?)(?:\s+x\s*(\d+))?$/i); return { spec: m[1].trim(), count: Math.max(1, Number(m[2]) || 1) }; };
    const lines = () => $('kitLines').value.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const write = (rows) => { $('kitLines').value = rows.map(r => r.count > 1 ? `${r.spec} x${r.count}` : r.spec).join('\n'); renderRows(); };
    const renderRows = () => {
      const rows = lines().map(parse); const total = rows.reduce((n, r) => n + r.count * r.spec.split(';').length, 0);
      $('kitCount').textContent = rows.length ? `· ${rows.length} line${rows.length === 1 ? '' : 's'}, ${total} item${total === 1 ? '' : 's'}` : '· empty';
      $('kitRows').innerHTML = rows.map((r, i) => `<div class="ip-item" data-i="${i}"><span>${esc(r.spec.split(';').map(x => x.trim()).join(' + '))}</span><span class="row gap"><button class="btn small kr-minus" title="One fewer">−</button><b>${r.count}</b><button class="btn small kr-plus" title="One more">+</button><button class="btn small danger kr-del" title="Remove">✕</button></span></div>`).join('') || '<div class="muted" style="padding:6px">Nothing yet: click items on the right.</div>';
    };
    const add = (cls, attach) => {
      const rows = lines().map(parse);
      if (attach) { if (!rows.length) return toast('Add the item it goes on first', true); rows[rows.length - 1].spec += '; ' + cls; }
      else { const same = rows.find(r => r.spec === cls); if (same) same.count++; else rows.push({ spec: cls, count: 1 }); }
      write(rows);
    };
    const renderItems = () => {
      const q = $('kitSearch').value.trim().toLowerCase(); const cat = $('kitCat').value;
      const rows = (lootItems || []).filter(i => (!q || i.name.toLowerCase().includes(q)) && (!cat || (i.category[0] || '') === cat));
      $('kitItems').innerHTML = rows.slice(0, 400).map(i => `<div class="ip-item ki" data-name="${esc(i.name)}"><span>${esc(i.name)} <span class="muted">${esc(i.category[0] || '')}</span></span><button class="btn small ki-attach" title="Fit onto the last item">attach</button></div>`).join('') + (rows.length > 400 ? `<div class="muted" style="padding:6px">${rows.length - 400} more: narrow the search</div>` : '') || '<div class="muted" style="padding:6px">No items match.</div>';
    };
    $('kitItems').onclick = (e) => { const it = e.target.closest('.ki'); if (!it) return; add(it.dataset.name, e.target.classList.contains('ki-attach')); };
    $('kitRows').onclick = (e) => { const it = e.target.closest('.ip-item'); if (!it) return; const rows = lines().map(parse); const i = Number(it.dataset.i); if (e.target.classList.contains('kr-plus')) rows[i].count++; else if (e.target.classList.contains('kr-minus')) { if (--rows[i].count < 1) rows.splice(i, 1); } else if (e.target.classList.contains('kr-del')) rows.splice(i, 1); else return; write(rows); };
    $('kitSearch').oninput = renderItems; $('kitCat').onchange = renderItems; $('kitLines').oninput = renderRows;
    renderRows(); renderItems();
  }, 0);
  if ((await p) !== 'save') return;
  try { const r = await ipc.invoke('live:saveKit', { name: $('kitName').value, lines: $('kitLines').value, oldName: k ? k.name : null }); adm.kits = r.kits; toast(r.unknown.length ? `Saved. Not in your economy files (fine for mod items, otherwise check the spelling): ${r.unknown.join(', ')}` : 'Kit saved', !!r.unknown.length); }
  catch (e) { toast(e.message, true); }
}
// ----- world layer: vehicles and territory flags from the bridge (every 3 s) -----
const liveVeh = (id) => adm.world && adm.world.available ? adm.world.vehicles.find(v => v.id === id) : null;
const vehColorOf = (v) => v.ruined ? '#8a8f98' : v.health > 0.66 ? '#46d36a' : v.health > 0.33 ? '#f5b942' : '#ff5f5f';
function worldAt(c, px, py) {
  const W = adm.world; if (!W || !W.available) return null; let best = null, bd = 11;
  if ($('lyrVeh').checked) for (const v of W.vehicles) { const [x, y] = toScreen(c, v.x, v.z); const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = { kind: 'vehicle', obj: v }; } }
  if ($('lyrFlags').checked) for (const f of W.flags) { const [x, y] = toScreen(c, f.x, f.z); const d = Math.hypot(px - x, py - y + 7); if (d < bd) { bd = d; best = { kind: 'flag', obj: f }; } }
  return best;
}
function drawWorld(ctx, c) {
  const W = adm.world; const info = $('lyrInfo');
  if (!W || !W.available) { info.textContent = (adm.live && adm.live.available && W) ? W.reason : ''; return; }
  const zoomed = mapState.view.scale >= 2.5; ctx.font = '11px Segoe UI'; const pxPerM = baseSize(c) * mapState.view.scale / worldSize();
  if ($('lyrFlags').checked) for (const f of W.flags) {
    const [x, y] = toScreen(c, f.x, f.z); const col = f.refresher < 0.25 ? '#ff5f5f' : '#ff9f3b'; const r = 60 * pxPerM;
    if (r >= 3) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,159,59,.08)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,159,59,.6)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]); }
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 14); ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, y - 14); ctx.lineTo(x + 9, y - 10); ctx.lineTo(x, y - 6); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 0.8; ctx.stroke();
    if (zoomed) { const label = `Flag · ${Math.round(f.refresher * 100)}%`; const tw = ctx.measureText(label).width; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x + 11, y - 13, tw + 6, 14); ctx.fillStyle = '#fff'; ctx.fillText(label, x + 14, y - 2); }
  }
  if ($('lyrVeh').checked) for (const v of W.vehicles) {
    const [x, y] = toScreen(c, v.x, v.z); const col = vehColorOf(v); const sel = v.id === adm.selVeh;
    ctx.save(); ctx.translate(x, y); ctx.rotate((v.heading || 0) * Math.PI / 180);
    ctx.fillStyle = col; ctx.strokeStyle = v.driver ? '#6fa8ff' : '#000'; ctx.lineWidth = v.driver ? 2 : 1.2; ctx.beginPath(); ctx.rect(-5, -8, 10, 16); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(-4, -6, 8, 4); ctx.restore();
    if (sel) { ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2; ctx.stroke(); }
    if (zoomed || sel) { const label = `${v.cls} · ${v.ruined ? 'ruined' : Math.round(v.health * 100) + '%'}${v.fuel != null ? ' · ⛽ ' + Math.round(v.fuel * 100) + '%' : ''}${v.driver ? ' · ' + v.driver : v.crew ? ' · ' + v.crew + ' inside' : ''}`; const tw = ctx.measureText(label).width; ctx.fillStyle = sel ? 'rgba(60,50,0,.8)' : 'rgba(0,0,0,.6)'; ctx.fillRect(x + 10, y - 7, tw + 6, 14); ctx.fillStyle = '#fff'; ctx.fillText(label, x + 13, y + 4); }
  }
  info.textContent = `${W.vehicles.length} vehicle(s) · ${W.flags.length} flag(s) · green / amber / red = condition, blue outline = someone driving, zoom in for names`;
}
function renderVehPanel() {
  const W = adm.world; const box = $('admVehList'); const q = $('admVehSearch').value.trim().toLowerCase();
  if (!W || !W.available) { $('admVehCount').textContent = ''; box.innerHTML = `<div class="muted" style="padding:6px">${esc((W && W.reason) || 'Loading…')}</div>`; return; }
  $('admVehCount').textContent = `(${W.vehicles.length}${W.flags.length ? ' · ' + W.flags.length + ' flags' : ''})`;
  const rows = W.vehicles.filter(v => !q || v.cls.toLowerCase().includes(q) || (v.driver || '').toLowerCase().includes(q)).sort((a, b) => a.cls.localeCompare(b.cls));
  box.innerHTML = rows.map(v => `<div class="ip-item ${v.id === adm.selVeh ? 'on' : ''}" data-vid="${esc(v.id)}"><span><span class="veh-swatch" style="background:${vehColorOf(v)}"></span>${esc(v.cls)}${v.driver ? ' <span class="badge">' + esc(v.driver) + '</span>' : ''}</span><span class="muted">${v.ruined ? 'ruined' : Math.round(v.health * 100) + '%'}${v.fuel != null ? ' · ⛽ ' + Math.round(v.fuel * 100) + '%' : ''}</span></div>`).join('') || '<div class="muted" style="padding:6px">No vehicles found yet (the bridge sweeps the whole map within 24 s of the server loading).</div>';
}
async function admVact(action, v, args = {}) {
  try {
    const r = await ipc.invoke('live:vact', action, v.id, args);
    if (r && r.status === 'pending') return toast('The game picked it up but has not answered yet; it finishes in a moment.');
    toast(`${v.cls}: ${{ vrepair: 'repaired', vrefuel: 'refuelled', vflip: 'flipped upright', vbreak: 'broken (' + (BREAK_KINDS.find(k => k[0] === args.what) || ['', args.what])[1].toLowerCase() + ')', vtp: 'moved', vbring: 'brought over', vdestroy: 'destroyed', vdelete: 'deleted' }[action] || action}`);
    pollLive();
  } catch (e) { toast(e.message, true); }
}
function vehicleMenu(v) {
  const all = adm.live && adm.live.available ? adm.live.players : [];
  const name = `${v.cls} at ${Math.round(v.x)}, ${Math.round(v.z)}`;
  const act = (a, title, label, args = {}, body = '') => withReason(title, body, label, (why) => admVact(a, v, { ...args, reason: why }));
  return [
    { header: `${v.cls}${v.ruined ? ' (ruined)' : ''} · ${Math.round(v.health * 100)}%${v.fuel != null ? ' · fuel ' + Math.round(v.fuel * 100) + '%' : ''}${v.engine ? ' · engine on' : ''}${v.driver ? ' · driven by ' + v.driver : v.crew ? ' · ' + v.crew + ' inside' : ''}` },
    { label: 'Repair everything', run: () => act('vrepair', `Repair ${name}`, 'Repair', {}, '<p class="muted">Every part pristine, every fluid full.</p>') },
    { label: 'Refuel', run: () => act('vrefuel', `Refuel ${name}`, 'Refuel') },
    { label: 'Flip upright', run: () => act('vflip', `Flip ${name} upright`, 'Flip') },
    { label: 'Break', sub: BREAK_KINDS.map(([k, l]) => ({ label: l, run: () => act('vbreak', `${l}: ${name}`, 'Break', { what: k }) })) },
    { sep: true },
    { label: 'Move by clicking the map', run: () => { adm.selVeh = v.id; adm.pickVtp = v.id; $('mapCanvas').style.cursor = 'crosshair'; renderVehPanel(); toast(`Click the map where the ${v.cls} should go (Esc cancels)`); } },
    { label: 'Bring it to a player', sub: all.map(o => ({ label: o.name, run: () => act('vbring', `Bring ${name} to ${o.name}`, 'Bring', { to: o.id }) })) },
    { label: 'Teleport a player to it', sub: all.map(o => ({ label: o.name, run: () => withReason(`Teleport ${o.name} to the ${v.cls}`, '', 'Teleport', (why) => admAct('tp', o, { x: v.x + 3, z: v.z, reason: why })) })) },
    { sep: true },
    { label: 'Destroy…', danger: true, run: () => act('vdestroy', `Destroy ${name}?`, 'Destroy', {}, '<p>It is wrecked where it stands; anyone inside gets hurt.</p>') },
    { label: 'Delete…', danger: true, run: () => act('vdelete', `Delete ${name}?`, 'Delete', {}, '<p>Removed from the world with everything in it. Refused while someone is inside.</p>') },
    { sep: true },
    { label: 'Centre the map on it', run: () => centreOn(v) },
    { label: 'Copy the position', run: () => { navigator.clipboard.writeText(`${Math.round(v.x)} ${Math.round(v.z)}`); toast('Position copied'); } }
  ];
}
function flagMenu(f) {
  const all = adm.live && adm.live.available ? adm.live.players : [];
  return [
    { header: `Territory flag · refresher ${Math.round(f.refresher * 100)}% · ${Math.round(f.x)}, ${Math.round(f.z)}` },
    { label: 'Teleport a player here', sub: all.map(o => ({ label: o.name, run: () => withReason(`Teleport ${o.name} to the flag at ${Math.round(f.x)}, ${Math.round(f.z)}`, '', 'Teleport', (why) => admAct('tp', o, { x: f.x + 2, z: f.z, reason: why })) })) },
    { label: 'Centre the map on it', run: () => centreOn(f) },
    { label: 'Copy the position', run: () => { navigator.clipboard.writeText(`${Math.round(f.x)} ${Math.round(f.z)}`); toast('Position copied'); } }
  ];
}
function pointMenu(w) {
  const s = livePlayer(adm.sel); const all = adm.live && adm.live.available ? adm.live.players : [];
  return [
    { header: `${Math.round(w[0])}, ${Math.round(w[1])}` },
    ...(s ? [{ label: `Teleport ${s.name} here`, run: () => withReason(`Teleport ${s.name} to ${Math.round(w[0])}, ${Math.round(w[1])}`, '', 'Teleport', (why) => admAct('tp', s, { x: w[0], z: w[1], reason: why })) }] : []),
    { label: 'Teleport a player here', sub: all.map(o => ({ label: o.name, run: () => withReason(`Teleport ${o.name} to ${Math.round(w[0])}, ${Math.round(w[1])}`, '', 'Teleport', (why) => admAct('tp', o, { x: w[0], z: w[1], reason: why })) })) },
    { sep: true },
    { label: 'Spawn item here…', run: () => spawnItemDialog(w) },
    { label: 'Spawn kit here', sub: [...adm.kits.map(k => ({ label: `${k.name} (${k.items})`, run: () => withReason(`Spawn the kit ${k.name} here`, '', 'Spawn', (why) => spawnHere(w, { kit: k.name, reason: why }, 'Kit ' + k.name)) })), { label: 'Manage kits…', run: () => kitManager() }] },
    { label: 'Spawn vehicle here', sub: adm.vehicles.map(v => ({ label: v.name, run: () => withReason(`Spawn ${v.name} here`, '<p class="muted">Every part fitted, every fluid full.</p>', 'Spawn', (why) => spawnHere(w, { vehicle: v.name, reason: why }, v.name)) })) },
    { sep: true },
    { label: 'Copy the position', run: () => { navigator.clipboard.writeText(`${Math.round(w[0])} ${Math.round(w[1])}`); toast('Position copied'); } }
  ];
}
// ----- DRP Factions: territory sectors, faction areas and loot tiers, painted on the map -----
// The mod splits the map into sectors (profiles\DRP_Factions\sectors.json). Faction areas are drawn like the in-game
// map: held sectors filled in the faction's colour, one outline and label per connected group. Loot tiers are painted
// onto sectors here and saved to loot_tiers.json; the faction holding a sector gets rolls from its tier's pool.
const sec = { at: 0, map: null, key: '', fill: null, lines: null, blobs: [], tierKey: '', tierFill: null };
const TIER_COLORS = ['', '#7cc47f', '#e0c04e', '#f08a3c', '#ff4d4d'];
const tiers = { data: null, at: 0, edits: new Map(), clsEdits: new Map(), mode: 'tier', paint: false, brush: 1, clsBrush: 'civilian', dragging: false };
const CLASS_COLORS = { civilian: '#6fcf6f', civil: '#4fb3ff', police: '#8a7dff', military: '#c9a227' };
const classColor = (id) => CLASS_COLORS[id] || '#cfcfcf';
const zoneOn = () => $('lyrZones').checked && adm.zones && adm.zones.available && sec.map;
async function loadSectors() {
  const Z = adm.zones; if (!Z || !Z.available || !Z.sectorsAt || Z.sectorsAt === sec.at) return;
  try {
    const d = await ipc.invoke('drpzones:sectors'); if (!d || !d.available) return;
    const n = d.n, grid = new Int32Array(n * n);
    d.rows.forEach((row, r) => { let c = 0; for (const run of row.split(',')) { const [id, len] = run.split('*').map(Number); grid.fill(id, r * n + c, Math.min(n * n, r * n + c + len)); c += len; } });
    const byId = new Map(d.sectors.map(s => [s.id, s]));
    const borders = (d.borders || []).map(b => { const v = b.split(',').map(Number); return { a: v[0], b: v[1], pts: v.slice(2) }; });
    sec.map = { n, R: d.raster, grid, sectors: d.sectors, byId, borders }; sec.at = Z.sectorsAt; sec.key = ''; sec.tierKey = '';
  } catch (e) { toast('Sector map: ' + e.message, true); }
}
function sectorAt(x, z) { const m = sec.map; if (!m) return -1; const c = Math.floor(x / m.R), r = Math.floor(z / m.R); return c < 0 || r < 0 || c >= m.n || r >= m.n ? -1 : m.grid[r * m.n + c]; }
function sectorName(id) { const s = sec.map && sec.map.byId.get(id); return s ? s.name : id > 0 ? 'sector ' + id : 'the sea'; }
const KINDS = ['countryside', 'village', 'town', 'city', 'military'];
// the faction holding a sector (claim or captured), or null
function sectorOwner(id) { if (!adm.zones) return null; for (const f of adm.zones.factions) if (f.cells.some(c => c.x === id && !c.pending)) return f; return null; }
// an offscreen image with one pixel per raster cell, north up
function rasterImage(colorOf) {
  const m = sec.map; const cv = document.createElement('canvas'); cv.width = m.n; cv.height = m.n;
  const g = cv.getContext('2d'); const img = g.createImageData(m.n, m.n); const cache = new Map();
  for (let r = 0; r < m.n; r++) for (let c = 0; c < m.n; c++) {
    const id = m.grid[r * m.n + c]; if (id < 1) continue;
    let rgba = cache.get(id); if (rgba === undefined) { rgba = colorOf(id); cache.set(id, rgba); } if (!rgba) continue;
    const o = ((m.n - 1 - r) * m.n + c) * 4; img.data[o] = rgba[0]; img.data[o + 1] = rgba[1]; img.data[o + 2] = rgba[2]; img.data[o + 3] = rgba[3];
  }
  g.putImageData(img, 0, 0); return cv;
}
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function buildTerritory() {
  const Z = adm.zones; const m = sec.map; const key = JSON.stringify(Z.factions.map(f => [f.id, f.color, f.tag, f.cells])) + sec.at;
  if (key === sec.key) return; sec.key = key;
  const owner = new Map(); for (const f of Z.factions) for (const c of f.cells) owner.set(c.x, { f, pending: c.pending });
  sec.fill = rasterImage(id => { const o = owner.get(id); return o ? [...hexRgb(o.f.color), o.pending ? 50 : 105] : null; });
  // lines: territory edges (owner changes) in the owner's colour, faint sector borders otherwise
  sec.lines = m.borders.map(b => { const oa = owner.get(b.a), ob = owner.get(b.b); const fa = oa && oa.f.id, fb = ob && ob.f.id;
    return fa !== fb ? { pts: b.pts, color: (oa || ob).f.color, width: 2 } : b.a > 0 && b.b > 0 ? { pts: b.pts, color: 'rgba(255,255,255,.28)', width: 1 } : null; }).filter(Boolean);
  // one label per connected group of a faction's sectors
  sec.blobs = []; const seen = new Set();
  for (const [id, o] of owner) {
    if (seen.has(id)) continue; const group = []; const todo = [id]; seen.add(id);
    while (todo.length) { const cur = todo.pop(); group.push(cur); const s = m.byId.get(cur); if (!s) continue; for (const nb of s.nb) { const on = owner.get(nb); if (!seen.has(nb) && on && on.f.id === o.f.id) { seen.add(nb); todo.push(nb); } } }
    let wx = 0, wz = 0, w = 0; for (const g of group) { const s = m.byId.get(g); if (s) { wx += s.cx * s.cells; wz += s.cz * s.cells; w += s.cells; } }
    if (!w) continue; const gx = wx / w, gz = wz / w;
    const at = group.map(g => m.byId.get(g)).filter(Boolean).sort((a, b) => Math.hypot(a.cx - gx, a.cz - gz) - Math.hypot(b.cx - gx, b.cz - gz))[0];
    sec.blobs.push({ x: at.cx, z: at.cz, f: o.f, sectors: group.length });
  }
}
// tier and zone class of a sector: unsaved paint first, then the saved file
function savedSector(id) { return tiers.data && tiers.data.sectors ? tiers.data.sectors.find(x => x.id === id) : null; }
function tierOf(id) { if (tiers.edits.has(id)) return tiers.edits.get(id); const t = savedSector(id); return t ? t.tier || 0 : 0; }
function classOf(id) { if (tiers.clsEdits.has(id)) return tiers.clsEdits.get(id); const t = savedSector(id); return t ? t.cls || '' : ''; }
// the class that counts: painted, else military for bases and airfields and civilian elsewhere (as the mod does)
function classEff(id) { const c = classOf(id); if (c) return c; const s = sec.map && sec.map.byId.get(id); return s && s.kind === 4 ? 'military' : 'civilian'; }
function className(id) { const c = tiers.data && (tiers.data.classes || []).find(x => x.id === id); return c ? c.name : id; }
function unsavedCount() { return new Set([...tiers.edits.keys(), ...tiers.clsEdits.keys()]).size; }
function buildTierFill() {
  const key = sec.at + tiers.mode + JSON.stringify([...tiers.edits]) + JSON.stringify([...tiers.clsEdits]) + tiers.at; if (key === sec.tierKey) return; sec.tierKey = key;
  sec.tierFill = tiers.mode === 'class'
    ? rasterImage(id => [...hexRgb(classColor(classEff(id))), classOf(id) ? 120 : 45])
    : rasterImage(id => { const t = tierOf(id); return t ? [...hexRgb(TIER_COLORS[t]), 110] : null; });
}
function drawZones(ctx, c) {
  const info = $('lyrZoneInfo'); if (!info) return;
  if (!zoneOn()) { info.textContent = adm.zones && adm.zones.available && !sec.map ? 'Sector map loading…' : ''; return; }
  const m = sec.map; const v = mapState.view;
  const [x0, y0] = toScreen(c, 0, m.n * m.R); const [x1, y1] = toScreen(c, m.n * m.R, 0);
  ctx.save(); ctx.imageSmoothingEnabled = false;
  const showTiers = $('lyrTiers') && $('lyrTiers').checked;
  if (showTiers) { buildTierFill(); ctx.drawImage(sec.tierFill, x0, y0, x1 - x0, y1 - y0); }
  buildTerritory(); if (!showTiers) ctx.drawImage(sec.fill, x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
  const kx = (x1 - x0) / (m.n * m.R); const pxPerCell = m.R * kx;
  for (const l of sec.lines) {
    if (l.width === 1 && pxPerCell < 0.6 && !showTiers) continue;
    ctx.strokeStyle = l.color; ctx.lineWidth = l.width; ctx.beginPath();
    for (let i = 0; i + 1 < l.pts.length; i += 2) { const [sx, sy] = toScreen(c, l.pts[i], l.pts[i + 1]); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); }
    ctx.stroke();
  }
  // the sector under the cursor
  if (mapState.hover) {
    const id = sectorAt(mapState.hover[0], mapState.hover[1]);
    if (id > 0) { ctx.strokeStyle = '#2ee05a'; ctx.lineWidth = 3; for (const b of m.borders) { if (b.a !== id && b.b !== id) continue; ctx.beginPath(); for (let i = 0; i + 1 < b.pts.length; i += 2) { const [sx, sy] = toScreen(c, b.pts[i], b.pts[i + 1]); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); } ctx.stroke(); } }
  }
  ctx.textAlign = 'center';
  if (!showTiers) for (const b of sec.blobs) {
    const [sx, sy] = toScreen(c, b.x, b.z); ctx.font = 'bold 13px Segoe UI'; const label = `[${b.f.tag}] ${b.f.name}`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(label, sx, sy); ctx.fillStyle = '#fff'; ctx.fillText(label, sx, sy);
  }
  if (pxPerCell >= 2.5 || (showTiers && pxPerCell >= 1.2)) {
    ctx.font = '11px Segoe UI';
    for (const s of m.sectors) {
      const [sx, sy] = toScreen(c, s.cx, s.cz); if (sx < 0 || sy < 0 || sx > c.width || sy > c.height) continue;
      const t = tierOf(s.id); const label = showTiers ? `${s.name} · ${t ? 'T' + t : 'no tier'} · ${className(classEff(s.id))}` : s.name;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(label, sx, sy + (showTiers ? 0 : 16)); ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillText(label, sx, sy + (showTiers ? 0 : 16));
    }
  }
  ctx.textAlign = 'start';
  const held = adm.zones.factions.reduce((n, f) => n + f.cells.length, 0);
  const counts = [1, 2, 3, 4].map(t => m.sectors.filter(s => tierOf(s.id) === t).length);
  const what = tiers.mode === 'class' ? (tiers.data && tiers.data.classes || []).map(cl => `${cl.name} ${m.sectors.filter(s => classEff(s.id) === cl.id).length}`).join(', ') : counts.map((n, i) => `T${i + 1} ${n}`).join(', ');
  info.textContent = showTiers ? `${tiers.mode === 'class' ? 'zone classes' : 'tiers'}: ${what}${unsavedCount() ? ` · ${unsavedCount()} unsaved` : ''}${tiers.paint ? ' · painting: click or drag over sectors' : ''}` : `${m.sectors.length} sectors, ${held} held`;
}
// ----- painting loot tiers -----
async function loadTiers() { try { const r = await ipc.invoke('drpf:lootTiers'); tiers.data = r; tiers.at = Date.now(); } catch { tiers.data = null; } }
function paintAt(c, px, py) {
  const w = toWorld(c, px, py); const id = sectorAt(w[0], w[1]); if (id < 1) return;
  const saved = savedSector(id);
  if (tiers.mode === 'class') { const was = saved ? saved.cls || '' : ''; if (tiers.clsBrush === was) tiers.clsEdits.delete(id); else tiers.clsEdits.set(id, tiers.clsBrush); }
  else { const was = saved ? saved.tier || 0 : 0; if (tiers.brush === was) tiers.edits.delete(id); else tiers.edits.set(id, tiers.brush); }
  renderTierPanel(); scheduleDraw();
}
function renderTierPanel() {
  const box = $('admTierBox'); if (!box) return; box.hidden = !(adm.zones && adm.zones.available && sec.map);
  if (box.hidden) return;
  $('admTierCount').textContent = unsavedCount() ? `(${unsavedCount()} unsaved)` : '';
  const modes = `<div class="row gap"><button class="btn small ${tiers.mode === 'tier' ? 'primary' : ''}" data-mode="tier">Tiers</button><button class="btn small ${tiers.mode === 'class' ? 'primary' : ''}" data-mode="class">Zone classes</button></div>`;
  const brushes = tiers.mode === 'class'
    ? [{ id: '', name: 'Automatic' }, ...((tiers.data && tiers.data.classes) || [])].map(cl => `<button class="btn small ${tiers.paint && tiers.clsBrush === cl.id ? 'primary' : ''}" data-cls="${esc(cl.id)}" style="${cl.id ? `border-color:${classColor(cl.id)}` : ''}">${esc(cl.name)}</button>`).join('')
    : [0, 1, 2, 3, 4].map(t => `<button class="btn small ${tiers.paint && tiers.brush === t ? 'primary' : ''}" data-tier="${t}" style="${t ? `border-color:${TIER_COLORS[t]}` : ''}">${t ? 'Tier ' + t : 'None'}</button>`).join('');
  $('admTierTools').innerHTML = modes + brushes + `<button class="btn small ${tiers.paint ? '' : 'primary'}" data-tier="off">${tiers.paint ? 'Stop painting' : 'Pan the map'}</button>`;
  $('admTierSave').disabled = !unsavedCount(); $('admTierDiscard').disabled = !unsavedCount();
}
async function saveTierPaint() {
  const list = new Map((tiers.data && tiers.data.sectors || []).map(x => [x.id, { tier: x.tier || 0, cls: x.cls || '' }]));
  for (const [id, t] of tiers.edits) list.set(id, { ...(list.get(id) || { cls: '' }), tier: t });
  for (const [id, c] of tiers.clsEdits) list.set(id, { ...(list.get(id) || { tier: 0 }), cls: c });
  try { await ipc.invoke('drpf:saveLootTiers', { sectors: [...list].map(([id, v]) => ({ id, tier: v.tier, cls: v.cls })).filter(x => x.tier || x.cls) }); tiers.edits.clear(); tiers.clsEdits.clear(); await loadTiers(); renderTierPanel(); scheduleDraw(); toast('Saved. The server reloads the loot tiers and zone classes within a few seconds.'); }
  catch (e) { toast(e.message, true); }
}
// right-click on a sector
function sectorMenu(id, w) {
  const s = sec.map.byId.get(id); const o = sectorOwner(id);
  return [
    { header: `${s.name} · ${KINDS[s.kind] || ''} · ${o ? `held by [${o.tag}] ${o.name}` : 'unclaimed'} · ${tierOf(id) ? 'Tier ' + tierOf(id) : 'no loot tier'} · ${className(classEff(id))}${classOf(id) ? '' : ' (automatic)'}` },
    { label: 'Loot tier', sub: [0, 1, 2, 3, 4].map(t => ({ label: t ? 'Tier ' + t : 'None', run: () => { tiers.edits.set(id, t); renderTierPanel(); scheduleDraw(); toast('Painted: save to keep it'); } })) },
    { label: 'Zone class', sub: [{ id: '', name: 'Automatic' }, ...((tiers.data && tiers.data.classes) || [])].map(cl => ({ label: cl.name, run: () => { tiers.clsEdits.set(id, cl.id); renderTierPanel(); scheduleDraw(); toast('Painted: save to keep it'); } })) },
    { label: 'Give this sector to a faction', sub: (adm.zones.factions || []).map(f => ({ label: `[${f.tag}] ${f.name}`, run: () => withReason(`Give ${s.name} to [${f.tag}] ${f.name}`, '', 'Give', (why) => ipc.invoke('drpf:command', { op: 'grant_cell', factionId: f.id, cellX: id, cellZ: 0, reason: why }).then(() => toast('Sent: the server applies it within a few seconds')).catch(e => toast(e.message, true))) })) },
    ...(o ? [{ label: `Take it from [${o.tag}] ${o.name}`, danger: true, run: () => withReason(`Take ${s.name} from [${o.tag}] ${o.name}?`, '<p>A captured sector is removed; a claimed one loses its claim (the table stays).</p>', 'Take', (why) => { const claim = (adm.zones.factions.find(f => f.id === o.id) || { cells: [] }).cells.find(c => c.x === id); const cmd = claim && claim.kind !== 'captured' && claim.claimId ? { op: 'remove_claim', factionId: o.id, claimId: claim.claimId } : { op: 'remove_cell', factionId: o.id, cellX: id, cellZ: 0 }; ipc.invoke('drpf:command', { ...cmd, reason: why }).then(() => toast('Sent')).catch(e => toast(e.message, true)); }) }] : []),
    { sep: true },
    ...pointMenu(w).slice(1)
  ];
}
function zoneResultToast(prev, next) {
  if (prev === null || !next || !next.available || next.result.seq <= prev) return;
  const msg = next.result.messages[next.result.messages.length - 1] || 'Applied';
  toast('Server: ' + msg.replace(/^\d\d:\d\d:\d\d /, ''), /Unknown|refused|No /.test(msg));
}

$('admSearch').addEventListener('input', renderAdmin);
$('btnKits').onclick = () => kitManager();
$('admList').addEventListener('click', e => { const it = e.target.closest('.ip-item'); if (it && it.dataset.id) admSelect(it.dataset.id); });
$('admList').addEventListener('dblclick', e => { const it = e.target.closest('.ip-item'); const p = it && livePlayer(it.dataset.id); if (p) { admSelect(p.id); centreOn(p); } });
$('admList').addEventListener('contextmenu', e => { const it = e.target.closest('.ip-item'); const p = it && livePlayer(it.dataset.id); if (!p) return; e.preventDefault(); admSelect(p.id); showCtx(playerMenu(p), e.clientX, e.clientY); });
$('admSel').addEventListener('click', e => {
  const b = e.target.closest('button'); const p = livePlayer(adm.sel); if (!b || !p) return;
  const a = b.dataset.a; const r = b.getBoundingClientRect();
  if (a === 'heal') showCtx(HEALS.map(([k, l]) => ({ label: l, run: () => withReason(`Heal ${p.name}: ${l.toLowerCase()}`, '', 'Heal', (why) => admAct('heal', p, { what: k, reason: why })) })), r.left, r.bottom + 2);
  if (a === 'tpmap') showCtx(playerMenu(p).filter(x => x.label && /^Teleport/.test(x.label)), r.left, r.bottom + 2);
  if (a === 'refund') playerMenu(p).find(x => x.label === 'Refund their last death…').run();
  if (a === 'give') giveDialog(p);
  if (a === 'kit') showCtx([...adm.kits.map(k => ({ label: `${k.name} (${k.items})`, run: () => withReason(`Give ${p.name} the kit ${k.name}`, '', 'Give', (why) => admAct('kit', p, { kit: k.name, reason: why })) })), { sep: true }, { label: 'Manage kits…', run: () => kitManager() }], r.left, r.bottom + 2);
  if (a === 'menu') showCtx(playerMenu(p), r.left, r.bottom + 2);
});
$('admSel').addEventListener('change', e => { if (e.target.id === 'admFollow') { adm.follow = e.target.checked; const p = livePlayer(adm.sel); if (adm.follow && p) centreOn(p); } });
$('mapCanvas').addEventListener('contextmenu', e => {
  e.preventDefault(); const c = $('mapCanvas'); const rect = c.getBoundingClientRect(); const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const hit = liveAt(c, px, py);
  const wh = hit ? null : worldAt(c, px, py);
  if (hit) { admSelect(hit.id); showCtx(playerMenu(hit), e.clientX, e.clientY); }
  else if (wh && wh.kind === 'vehicle') { adm.selVeh = wh.obj.id; renderVehPanel(); scheduleDraw(); showCtx(vehicleMenu(wh.obj), e.clientX, e.clientY); }
  else if (wh && wh.kind === 'flag') showCtx(flagMenu(wh.obj), e.clientX, e.clientY);
  else { const w = toWorld(c, px, py); const sid = zoneOn() ? sectorAt(w[0], w[1]) : -1; showCtx(sid > 0 ? sectorMenu(sid, w) : pointMenu(w), e.clientX, e.clientY); }
});
document.addEventListener('click', e => { if (!e.target.closest('#ctxMenu')) closeCtx(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCtx(); if (adm.pickTp) { adm.pickTp = null; $('mapCanvas').style.cursor = ''; toast('Teleport cancelled'); } if (adm.pickVtp) { adm.pickVtp = null; $('mapCanvas').style.cursor = ''; toast('Move cancelled'); } if (tiers.paint) { tiers.paint = false; renderTierPanel(); toast('Stopped painting'); } } });
$('admVehSearch').addEventListener('input', renderVehPanel);
$('admVehList').addEventListener('click', e => { const it = e.target.closest('[data-vid]'); if (!it) return; adm.selVeh = it.dataset.vid; const v = liveVeh(adm.selVeh); if (v) centreOn(v); renderVehPanel(); scheduleDraw(); });
$('admVehList').addEventListener('contextmenu', e => { const it = e.target.closest('[data-vid]'); const v = it && liveVeh(it.dataset.vid); if (!v) return; e.preventDefault(); adm.selVeh = v.id; renderVehPanel(); showCtx(vehicleMenu(v), e.clientX, e.clientY); });
$('lyrVeh').onchange = $('lyrFlags').onchange = $('lyrZones').onchange = () => scheduleDraw();
$('lyrTiers').onchange = () => { if ($('lyrTiers').checked) $('lyrZones').checked = true; else tiers.paint = false; renderTierPanel(); scheduleDraw(); };
$('admTierTools').addEventListener('click', e => {
  const m = e.target.closest('[data-mode]'); if (m) { tiers.mode = m.dataset.mode; $('lyrTiers').checked = true; $('lyrZones').checked = true; renderTierPanel(); scheduleDraw(); return; }
  const cb = e.target.closest('[data-cls]'); if (cb) { tiers.paint = true; tiers.clsBrush = cb.dataset.cls; $('lyrTiers').checked = true; $('lyrZones').checked = true; renderTierPanel(); scheduleDraw(); return; }
  const b = e.target.closest('[data-tier]'); if (!b) return;
  if (b.dataset.tier === 'off') { tiers.paint = false; } else { tiers.paint = true; tiers.brush = Number(b.dataset.tier); $('lyrTiers').checked = true; $('lyrZones').checked = true; }
  renderTierPanel(); scheduleDraw();
});
$('admTierSave').onclick = () => saveTierPaint();
$('admTierDiscard').onclick = () => { tiers.edits.clear(); tiers.clsEdits.clear(); renderTierPanel(); scheduleDraw(); };

mapInit();
