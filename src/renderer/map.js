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
  drawVehicles(ctx, c);
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
  c.addEventListener('mousedown', e => { if (e.button !== 0) return; mapState.drag = { x: e.clientX, y: e.clientY, ox: mapState.view.ox, oy: mapState.view.oy, moved: false }; });
  window.addEventListener('mousemove', e => {
    const rect = c.getBoundingClientRect(); const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (mapState.drag) { const dx = e.clientX - mapState.drag.x, dy = e.clientY - mapState.drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) mapState.drag.moved = true; mapState.view.ox = mapState.drag.ox + dx; mapState.view.oy = mapState.drag.oy + dy; scheduleDraw(); return; }
    if (!inside || !document.querySelector('#page-map.active')) return;
    const w = toWorld(c, e.clientX - rect.left, e.clientY - rect.top); mapState.hover = w; if (mapState.measure && mapState.measure.a && !mapState.measure.b) { mapState.measure.cursor = w; scheduleDraw(); } else { const el = $('mapInfo'); const t = el.textContent.replace(/ · cursor .*$/, ''); el.textContent = t + ` · cursor ${Math.round(w[0])}, ${Math.round(w[1])}`; }
  });
  window.addEventListener('mouseup', e => {
    const d = mapState.drag; mapState.drag = null; if (!d) return;
    if (d.moved) return;
    const rect = c.getBoundingClientRect(); const px = e.clientX - rect.left, py = e.clientY - rect.top; const w = toWorld(c, px, py);
    if (e.shiftKey) { const m = mapState.measure; if (!m || m.b) mapState.measure = { a: w, b: null, cursor: w }; else m.b = w; scheduleDraw(); return; }
    if (adm.pickTp) { const p = livePlayer(adm.pickTp); adm.pickTp = null; c.style.cursor = ''; if (p) admAct('tp', p, { x: w[0], z: w[1] }); return; }
    { const hit = liveAt(c, px, py); if (hit) { admSelect(hit.id); return; } }
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
const adm = { live: null, sel: null, pickTp: null, follow: false, timer: null, kits: [], vehicles: [] };
async function loadKits() { try { [adm.kits, adm.vehicles] = await Promise.all([ipc.invoke('live:kits'), ipc.invoke('live:vehicles')]); } catch { /* no mission yet */ } }
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
  const p = livePlayer(adm.sel); if (adm.follow && p) centreOn(p);
  renderAdmin(); scheduleDraw();
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
    const msg = { heal: 'healed', tp: 'teleported', tpto: 'teleported', bring: 'brought over', kill: 'killed', god: args.on ? 'is in god mode' : 'is no longer in god mode', tpdeath: 'teleported to their last death', message: 'messaged', kick: 'kicked', ban: 'banned' }[action];
    if (action === 'give' || action === 'kit') toast(`Gave ${p.name} ${r.ok} item(s)${action === 'kit' ? ' from kit ' + args.kit : ' of ' + args.item}${r.fail ? ` (${r.fail} failed: is every class name right?)` : ''}`, !r.ok);
    else if (action === 'vehicle') toast(r.ok ? `${args.vehicle} is ready next to ${p.name} (${r.ok} part(s)${r.fail ? `, ${r.fail} failed` : ''})` : `${args.vehicle} could not be spawned`, !r.ok);
    else if (action === 'refund') toast(r.ok ? `Refunded ${r.ok} of ${r.items} items to ${p.name} (death #${r.deathId})` : `Nothing could be spawned for ${p.name}`, !r.ok);
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
const reasonField = (ph = 'Reason or ticket number') => `<label class="field">Reason / ticket${reasonRequired ? '' : ' (optional)'} <input id="admWhy" class="input" placeholder="${ph}"></label>`;
const reason = () => ($('admWhy') ? $('admWhy').value.trim() : '');
const withReason = async (title, body, label, run) => { const ok = await ask(title, body + reasonField(), label); if (!ok) return; if (reasonRequired && !reason()) return toast('Give a reason or ticket number.', true); run(reason()); };
function playerMenu(p) {
  const others = (adm.live.players || []).filter(o => o.id !== p.id);
  return [
    { header: p.name + (p.god ? ' (god mode)' : '') + (!p.alive ? ' (dead)' : '') },
    { label: 'Heal', sub: HEALS.map(([k, l]) => ({ label: l, run: () => admAct('heal', p, { what: k }) })) },
    { label: 'Teleport to player', sub: others.map(o => ({ label: o.name, run: () => admAct('tpto', p, { to: o.id }) })) },
    { label: 'Bring a player to them', sub: others.map(o => ({ label: o.name, run: () => admAct('bring', p, { to: o.id }) })) },
    { label: 'Teleport by clicking the map', run: () => { adm.sel = p.id; adm.pickTp = p.id; $('mapCanvas').style.cursor = 'crosshair'; renderAdmin(); toast(`Click the map where ${p.name} should go (Esc cancels)`); } },
    { label: 'Teleport to their last death', run: () => admAct('tpdeath', p) },
    { sep: true },
    { label: 'Refund their last death…', run: () => withReason('Refund last death', `<p>Spawn the gear ${esc(p.name)} had at their last recorded death, pristine, at their feet?</p>`, 'Refund', (why) => admAct('refund', p, { reason: why })) },
    { label: 'Give item…', run: () => giveDialog(p) },
    { label: 'Give kit', sub: [...adm.kits.map(k => ({ label: `${k.name} (${k.items})`, run: () => withReason(`Give ${p.name} the kit ${k.name}`, '', 'Give', (why) => admAct('kit', p, { kit: k.name, reason: why })) })), { label: 'Manage kits…', run: () => kitManager() }] },
    { label: 'Spawn a vehicle next to them', sub: adm.vehicles.map(v => ({ label: v.name, run: () => withReason(`Spawn ${v.name} next to ${p.name}`, '<p class="muted">Every part fitted, every fluid full.</p>', 'Spawn', (why) => admAct('vehicle', p, { vehicle: v.name, reason: why })) })) },
    { label: p.god ? 'Turn god mode off' : 'Turn god mode on', run: () => admAct('god', p, { on: !p.god }) },
    { sep: true },
    { label: 'Message…', run: async () => { if (await ask(`Message ${p.name}`, '<input id="admMsg" class="input" placeholder="Only they see it">', 'Send')) admAct('message', p, { text: $('admMsg').value }); } },
    { label: 'Kick…', danger: true, run: async () => { if (await ask(`Kick ${p.name}?`, '<label class="field">Reason (shown to them) <input id="admWhy" class="input"></label>', 'Kick', true)) admAct('kick', p, { reason: reason() }); } },
    { label: 'Ban…', danger: true, run: () => withReason(`Ban ${p.name}?`, `<p>Adds Steam64 ${esc(p.steam)} to ban.txt and kicks them now.</p>`, 'Ban', (why) => admAct('ban', p, { reason: why })) },
    { label: 'Kill…', danger: true, run: () => withReason(`Kill ${p.name}?`, '<p>Their character dies where it stands.</p>', 'Kill', (why) => admAct('kill', p, { reason: why })) },
    { sep: true },
    { label: 'Centre the map on them', run: () => centreOn(p) },
    { label: 'Open in the database', run: () => { pdbSelected = p.id; showPage('database'); } }
  ];
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
  const body = `<div class="kit-list">${list}</div><div class="card-title mt">${k ? 'Edit ' + esc(k.name) : 'New kit'}</div>
    <label class="field">Name <input id="kitName" class="input" value="${esc(k ? k.name : '')}" placeholder="e.g. Starter, Sniper, Medic"></label>
    <label class="field">Items, one per line <textarea id="kitLines" class="input mono" rows="8" placeholder="BandageDressing x4&#10;AKM; AK_WoodBttstck; AK_WoodHndgrd; Mag_AKM_30Rnd&#10;Mag_AKM_30Rnd x3&#10;TacticalBaconCan x2">${esc(k ? (k.lines || []).join('\n') : '')}</textarea></label>
    <p class="muted small">"Class x3" gives three. "Parent; Attachment; …" fits the attachments onto the item (stock, handguard, optic, magazine…). Everything spawns pristine and full.</p>`;
  const p = showModal('Kits', body, [{ label: 'Save kit', value: 'save', primary: true }, { label: 'Close', value: null }]);
  setTimeout(() => {
    for (const b of document.querySelectorAll('.kit-edit')) b.onclick = () => { $('modalActions').lastElementChild.click(); kitManager(b.dataset.name); };
    for (const b of document.querySelectorAll('.kit-del')) b.onclick = async () => { await ipc.invoke('live:deleteKit', b.dataset.name); toast(`Kit ${b.dataset.name} deleted`); $('modalActions').lastElementChild.click(); kitManager(); };
  }, 0);
  if ((await p) !== 'save') return;
  try { const r = await ipc.invoke('live:saveKit', { name: $('kitName').value, lines: $('kitLines').value, oldName: k ? k.name : null }); adm.kits = r.kits; toast(r.unknown.length ? `Saved. Not in your economy files (fine for mod items, otherwise check the spelling): ${r.unknown.join(', ')}` : 'Kit saved', !!r.unknown.length); }
  catch (e) { toast(e.message, true); }
}
function pointMenu(w) {
  const s = livePlayer(adm.sel); const all = adm.live && adm.live.available ? adm.live.players : [];
  return [
    { header: `${Math.round(w[0])}, ${Math.round(w[1])}` },
    ...(s ? [{ label: `Teleport ${s.name} here`, run: () => admAct('tp', s, { x: w[0], z: w[1] }) }] : []),
    { label: 'Teleport a player here', sub: all.map(o => ({ label: o.name, run: () => admAct('tp', o, { x: w[0], z: w[1] }) })) },
    { sep: true },
    { label: 'Spawn item here…', run: () => spawnItemDialog(w) },
    { label: 'Spawn kit here', sub: [...adm.kits.map(k => ({ label: `${k.name} (${k.items})`, run: () => withReason(`Spawn the kit ${k.name} here`, '', 'Spawn', (why) => spawnHere(w, { kit: k.name, reason: why }, 'Kit ' + k.name)) })), { label: 'Manage kits…', run: () => kitManager() }] },
    { label: 'Spawn vehicle here', sub: adm.vehicles.map(v => ({ label: v.name, run: () => withReason(`Spawn ${v.name} here`, '<p class="muted">Every part fitted, every fluid full.</p>', 'Spawn', (why) => spawnHere(w, { vehicle: v.name, reason: why }, v.name)) })) },
    { sep: true },
    { label: 'Copy the position', run: () => { navigator.clipboard.writeText(`${Math.round(w[0])} ${Math.round(w[1])}`); toast('Position copied'); } }
  ];
}
$('admSearch').addEventListener('input', renderAdmin);
$('btnKits').onclick = () => kitManager();
$('admList').addEventListener('click', e => { const it = e.target.closest('.ip-item'); if (it && it.dataset.id) admSelect(it.dataset.id); });
$('admList').addEventListener('dblclick', e => { const it = e.target.closest('.ip-item'); const p = it && livePlayer(it.dataset.id); if (p) { admSelect(p.id); centreOn(p); } });
$('admList').addEventListener('contextmenu', e => { const it = e.target.closest('.ip-item'); const p = it && livePlayer(it.dataset.id); if (!p) return; e.preventDefault(); admSelect(p.id); showCtx(playerMenu(p), e.clientX, e.clientY); });
$('admSel').addEventListener('click', e => {
  const b = e.target.closest('button'); const p = livePlayer(adm.sel); if (!b || !p) return;
  const a = b.dataset.a; const r = b.getBoundingClientRect();
  if (a === 'heal') showCtx(HEALS.map(([k, l]) => ({ label: l, run: () => admAct('heal', p, { what: k }) })), r.left, r.bottom + 2);
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
  if (hit) { admSelect(hit.id); showCtx(playerMenu(hit), e.clientX, e.clientY); }
  else showCtx(pointMenu(toWorld(c, px, py)), e.clientX, e.clientY);
});
document.addEventListener('click', e => { if (!e.target.closest('#ctxMenu')) closeCtx(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCtx(); if (adm.pickTp) { adm.pickTp = null; $('mapCanvas').style.cursor = ''; toast('Teleport cancelled'); } } });

mapInit();
