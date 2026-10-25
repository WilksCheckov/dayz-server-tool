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
  // players
  if (!mapState.players.at || Date.now() - mapState.players.at > 4000) { try { const rows = await ipc.invoke('players:all', { sort: 'lastSeen', limit: 500 }); mapState.players = Object.assign(rows.filter(r => r.lastPos), { at: Date.now() }); } catch { /* ignore */ } }
  const pts = mapState.players.filter(r => !$('mapOnlineOnly').checked || r.online);
  ctx.font = '11px Segoe UI';
  for (const r of pts) {
    const [x, y] = toScreen(c, r.lastPos.x, r.lastPos.z);
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = r.online ? '#7cc47f' : '#e0b04e'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    const tw = ctx.measureText(r.name).width; ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x + 7, y - 7, tw + 6, 14); ctx.fillStyle = '#fff'; ctx.fillText(r.name, x + 10, y + 4);
  }
  // measure line
  if (mapState.measure && mapState.measure.a) {
    const m = mapState.measure; const [ax, ay] = toScreen(c, m.a[0], m.a[1]); const b = m.b || m.cursor; if (b) { const [bx, by] = toScreen(c, b[0], b[1]); ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]); const dist = Math.hypot(b[0] - m.a[0], b[1] - m.a[1]); const label = dist >= 1000 ? (dist / 1000).toFixed(2) + ' km' : Math.round(dist) + ' m'; ctx.fillStyle = 'rgba(0,0,0,.7)'; const tw = ctx.measureText(label).width; ctx.fillRect((ax + bx) / 2 - tw / 2 - 4, (ay + by) / 2 - 9, tw + 8, 16); ctx.fillStyle = '#ffe14d'; ctx.fillText(label, (ax + bx) / 2 - tw / 2, (ay + by) / 2 + 4); }
  }
  // cursor coordinates
  const cur = mapState.hover; const coords = cur ? `${Math.round(cur[0])}, ${Math.round(cur[1])}` : '';
  $('mapInfo').textContent = `${pts.length} player position(s) · green = online, amber = last seen · scroll to zoom, drag to pan, click a dot for details, Shift+click twice to measure · zoom ${v.scale.toFixed(1)}x${coords ? ' · cursor ' + coords : ''}`;
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
  return L.items.filter(it => (!liveLootPick || L.classes[it[0]] === liveLootPick) && (!q || L.classes[it[0]].toLowerCase().includes(q)) && (!cat || L.classCat[it[0]] === cat) && (!ground || it[3] === 0));
}
function renderLiveLootList() {
  const L = liveLoot; const box = $('liveLootList');
  if (!L || !L.available) { box.innerHTML = `<div class="muted" style="padding:6px">${esc((L && L.reason) || 'No data yet.')}</div>`; $('liveLootWhen').textContent = ''; return; }
  $('liveLootWhen').textContent = 'as of ' + new Date(L.at).toLocaleTimeString();
  const cats = [...new Set(L.classCat.filter(Boolean))].sort(); const sel = $('liveLootCat');
  if (sel.options.length !== cats.length + 1) { const cur = sel.value; sel.innerHTML = '<option value="">All types</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join(''); sel.value = cur; }
  const q = $('liveLootSearch').value.trim().toLowerCase(); const cat = $('liveLootCat').value; const ground = $('liveLootGround').checked;
  const counts = new Map(); for (const it of L.items) { if (ground && it[3] !== 0) continue; const n = L.classes[it[0]]; if (q && !n.toLowerCase().includes(q)) continue; if (cat && L.classCat[it[0]] !== cat) continue; counts.set(n, (counts.get(n) || 0) + 1); }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300);
  box.innerHTML = `<div class="ip-item ${liveLootPick ? '' : 'on'}" data-name=""><span>All matching items</span><span class="muted">${[...counts.values()].reduce((a, b) => a + b, 0).toLocaleString()}</span></div>` + rows.map(([n, k]) => `<div class="ip-item ${liveLootPick === n ? 'on' : ''}" data-name="${esc(n)}"><span>${esc(n)}</span><span class="muted">${k.toLocaleString()}</span></div>`).join('');
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
  const rows = (lootItems || []).filter(i => !q || i.name.toLowerCase().includes(q)).slice(0, 200);
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
    // click a player dot
    for (const r of mapState.players) { const [x, y] = toScreen(c, r.lastPos.x, r.lastPos.z); if (Math.hypot(px - x, py - y) <= 7) { showPlayerPopup(r); return; } }
    // click a loot spot
    if (mapState.loot) { let best = null, bd = 9; for (const s of mapState.loot.spots) { const [x, y] = toScreen(c, s.x, s.z); const dd = Math.hypot(px - x, py - y); if (dd < bd) { bd = dd; best = s; } } if (best) { toast(`${best.name.replace(/^Land_/, '')} at ${Math.round(best.x)}, ${Math.round(best.z)} · ${best.points} matching loot point(s)`); return; } }
    if (mapState.measure) { mapState.measure = null; scheduleDraw(); }
  });
  c.addEventListener('dblclick', () => { mapState.view = { scale: 1, ox: 0, oy: 0 }; scheduleDraw(); });
  $('mapOverlay').onchange = async () => { const loot = $('mapOverlay').value === 'loot'; const live = $('mapOverlay').value === 'liveloot'; const veh = $('mapOverlay').value === 'vehicles'; $('lootPanel').hidden = !loot; $('liveLootPanel').hidden = !live; $('vehPanel').hidden = !veh; if (veh) { await loadVehicles(); renderVehList(); } if (loot) { await loadLootItems(); renderLootList(); } if (live) { await loadLiveLoot(true); renderLiveLootList(); } scheduleDraw(); };
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
function mapLive(on) { clearInterval(mapLiveTimer); mapLiveTimer = null; if (on) mapLiveTimer = setInterval(() => { if (document.querySelector('#page-map.active')) { mapState.players.at = 0; scheduleDraw(); } else mapLive(false); }, 5000); }
function showPlayerPopup(r) {
  const body = `<div class="muted mono">${esc(r.id || '')}${r.steamId ? '<br>Steam64 ' + esc(r.steamId) : ''}</div>
    <div class="grid-2 tight pdb-kv"><div><span class="muted">Status</span><br>${r.online ? 'online' : 'last seen ' + fmtDate(r.lastSeen)}</div><div><span class="muted">Position</span><br>${Math.round(r.lastPos.x)}, ${Math.round(r.lastPos.z)}</div>
    <div><span class="muted">Playtime</span><br>${fmtPlaytime(r.playtimeSec)}</div><div><span class="muted">Kills / deaths</span><br>${r.kills} / ${r.deaths}</div></div>
    ${r.banned ? '<span class="badge bad">banned</span> ' : ''}${r.whitelisted ? '<span class="badge ok">whitelist</span> ' : ''}${r.account && r.account.suspicious ? '<span class="badge warn">⚠ suspicious</span>' : ''}`;
  showModal(r.name, body, [{ label: 'Open in Database', value: 'db', primary: true }, { label: 'Close', value: false }]).then(v => { if (v === 'db') { pdbSelected = r.key; showPage('database'); } });
}
mapInit();
