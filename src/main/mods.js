'use strict';
// Workshop mod management: metadata, dependencies, queued downloads, linking into the server folder, key copying, updates.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const steamcmd = require('./steamcmd');
const vdf = require('./vdf');

const API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const PAGE = 'https://steamcommunity.com/sharedfiles/filedetails/?id=';

let emitRef = () => {};
const progress = {}; // id -> { state, message }
let queue = Promise.resolve();

function setProgress(id, state, message = '') {
  if (state === 'done' || state === 'idle') delete progress[id];
  else progress[id] = { state, message };
  emitRef('mods:progress', { id, state, message });
}

function isLocal(id) { return String(id).startsWith('@'); }

// ---------- Steam lookups ----------
async function fetchDetails(ids) {
  ids = ids.filter(id => !isLocal(id));
  if (!ids.length) return [];
  const body = new URLSearchParams();
  body.set('itemcount', String(ids.length));
  ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, String(id)));
  const res = await fetch(API, { method: 'POST', body });
  if (!res.ok) throw new Error(`Steam API HTTP ${res.status}`);
  const json = await res.json();
  return (json.response && json.response.publishedfiledetails) || [];
}

// Required items are only on the workshop page, not in the public API.
async function fetchRequiredItems(id, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(PAGE + id, { headers: { 'Accept-Language': 'en' }, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) return [];
      const html = await res.text();
      const block = html.match(/id="RequiredItems"[\s\S]*?<\/div>\s*<\/div>/);
      if (!block) return [];
      const ids = new Set();
      for (const m of block[0].matchAll(/filedetails\/\?id=(\d+)/g)) if (m[1] !== String(id)) ids.add(m[1]);
      return [...ids];
    } catch (e) {
      if (i === attempts) { emitRef('console', { source: 'mods', line: `Could not read required items for ${id}: ${e.message}` }); return null; }
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  return null;
}

async function refreshMeta(ids) {
  const s = settings.load();
  const details = await fetchDetails(ids);
  const modCache = { ...s.modCache };
  for (const d of details) {
    if (d.result !== 1) continue;
    modCache[d.publishedfileid] = {
      ...(modCache[d.publishedfileid] || {}),
      title: d.title,
      remoteTimeUpdated: Number(d.time_updated || 0),
      fileSize: Number(d.file_size || 0),
      preview: d.preview_url || null,
      tags: (d.tags || []).map(t => t.tag)
    };
  }
  settings.save({ modCache });
  return details;
}

// ---------- local filesystem ----------
function sanitizeFolder(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Mod';
}

function readMetaName(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir, 'meta.cpp'), 'utf8');
    const m = txt.match(/name\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

function readMetaId(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir, 'meta.cpp'), 'utf8');
    const m = txt.match(/publishedid\s*=\s*(\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

function folderNameFor(id, s) {
  if (isLocal(id)) return id;
  const c = s.modCache[id] || {};
  if (c.folderName) return c.folderName;
  const p = settings.paths(s);
  const name = readMetaName(path.join(p.workshopDir, String(id))) || c.title || String(id);
  return '@' + sanitizeFolder(name);
}

function localWorkshopState() {
  const p = settings.paths();
  try {
    const data = vdf.parse(fs.readFileSync(p.workshopAcf, 'utf8'));
    const items = (data.AppWorkshop && data.AppWorkshop.WorkshopItemsInstalled) || {};
    const out = {};
    for (const [id, v] of Object.entries(items)) out[id] = { timeUpdated: Number(v.timeupdated || 0), size: Number(v.size || 0) };
    return out;
  } catch { return {}; }
}

function findKeys(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.bikey$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

function copyKeys(id, src) {
  const s = settings.load();
  const p = settings.paths(s);
  fs.mkdirSync(p.keysDir, { recursive: true });
  const keys = [];
  for (const k of findKeys(src)) {
    const target = path.join(p.keysDir, path.basename(k));
    try { fs.copyFileSync(k, target); keys.push(path.basename(k)); } catch { /* ignore */ }
  }
  return keys;
}

// Create junction server/@Name -> workshop/<id> and copy .bikey files into server/keys.
function link(id) {
  const s = settings.load();
  const p = settings.paths(s);
  if (isLocal(id)) {
    const dest = path.join(p.serverDir, id);
    if (!fs.existsSync(dest)) throw new Error(`Local mod folder ${id} not found.`);
    const keys = copyKeys(id, dest);
    settings.save({ modCache: { ...s.modCache, [id]: { ...(s.modCache[id] || {}), folderName: id, keys, title: readMetaName(dest) || id } } });
    return { folderName: id, keys };
  }
  const src = path.join(p.workshopDir, String(id));
  if (!fs.existsSync(src)) throw new Error(`Mod ${id} is not downloaded yet.`);
  const folderName = folderNameFor(id, s);
  const dest = path.join(p.serverDir, folderName);
  fs.mkdirSync(p.serverDir, { recursive: true });
  try {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink() || st.isDirectory()) fs.rmSync(dest, { recursive: true, force: true });
  } catch { /* not there */ }
  fs.symlinkSync(src, dest, 'junction');
  const keys = copyKeys(id, src);
  settings.save({ modCache: { ...s.modCache, [id]: { ...(s.modCache[id] || {}), folderName, keys, title: (s.modCache[id] || {}).title || readMetaName(src) || folderName } } });
  return { folderName, keys };
}

function unlink(id) {
  const s = settings.load();
  const p = settings.paths(s);
  const c = s.modCache[id] || {};
  if (c.folderName && !isLocal(id)) {
    const dest = path.join(p.serverDir, c.folderName);
    try { if (fs.lstatSync(dest).isSymbolicLink()) fs.unlinkSync(dest); } catch { /* ignore */ }
  }
  for (const k of c.keys || []) {
    const shared = Object.entries(s.modCache).some(([oid, oc]) => oid !== String(id) && (oc.keys || []).includes(k));
    if (!shared) { try { fs.unlinkSync(path.join(p.keysDir, k)); } catch { /* ignore */ } }
  }
}

// ---------- listing ----------
function list() {
  const s = settings.load();
  const p = settings.paths(s);
  const local = localWorkshopState();
  return s.mods.map(m => {
    const c = s.modCache[m.id] || {};
    if (isLocal(m.id)) {
      const dir = path.join(p.serverDir, m.id);
      const exists = fs.existsSync(dir);
      return { id: m.id, local: true, enabled: m.enabled !== false, serverSide: !!m.serverSide, title: c.title || readMetaName(dir) || m.id, folderName: m.id, installed: exists, linked: exists, keys: c.keys || [], deps: [], progress: progress[m.id] || null };
    }
    const dir = path.join(p.workshopDir, String(m.id));
    const installed = fs.existsSync(dir);
    const folderName = c.folderName || (installed ? folderNameFor(m.id, s) : null);
    const linked = folderName ? fs.existsSync(path.join(p.serverDir, folderName)) : false;
    const loc = local[m.id] || {};
    return {
      id: m.id,
      local: false,
      enabled: m.enabled !== false,
      serverSide: !!m.serverSide,
      title: c.title || readMetaName(dir) || `Mod ${m.id}`,
      folderName,
      installed,
      linked,
      localTimeUpdated: loc.timeUpdated || null,
      remoteTimeUpdated: c.remoteTimeUpdated || null,
      updateAvailable: !!(installed && c.remoteTimeUpdated && loc.timeUpdated && c.remoteTimeUpdated > loc.timeUpdated),
      fileSize: c.fileSize || loc.size || null,
      keys: c.keys || [],
      deps: c.deps || [],
      missingDeps: (c.deps || []).filter(d => !s.mods.some(x => x.id === d)),
      preview: c.preview || null,
      progress: progress[m.id] || null
    };
  });
}

// ---------- adding / updating ----------
function ensureEntry(id, insertBefore = null) {
  const s = settings.load();
  if (s.mods.some(m => m.id === id)) return;
  const mods = [...s.mods];
  const entry = { id, enabled: true, serverSide: false };
  const idx = insertBefore ? mods.findIndex(m => m.id === insertBefore) : -1;
  if (idx >= 0) mods.splice(idx, 0, entry); else mods.push(entry);
  settings.save({ mods });
}

// Resolve the dependency tree (deps first) for a set of ids. Returns ordered unique ids.
async function resolveDeps(ids, depth = 0, seen = new Set()) {
  const order = [];
  for (const id of ids) {
    if (seen.has(id) || isLocal(id)) continue;
    seen.add(id);
    if (depth > 25) continue; // safety valve; cycles are already stopped by 'seen'
    const fetched = await fetchRequiredItems(id);
    const s = settings.load();
    const deps = fetched === null ? ((s.modCache[id] || {}).deps || []) : fetched;
    settings.save({ modCache: { ...s.modCache, [id]: { ...(s.modCache[id] || {}), deps } } });
    for (const d of await resolveDeps(deps, depth + 1, seen)) if (!order.includes(d)) order.push(d);
    order.push(id);
  }
  return order;
}

// Preview what adding an id would pull in (used by the UI before confirming).
async function plan(id) {
  id = String(id).trim();
  if (!/^\d+$/.test(id)) throw new Error('Workshop ID must be numeric.');
  const order = await resolveDeps([id]);
  await refreshMeta(order).catch(() => {});
  const s = settings.load();
  return order.map(x => ({ id: x, title: (s.modCache[x] || {}).title || `Mod ${x}`, already: s.mods.some(m => m.id === x), fileSize: (s.modCache[x] || {}).fileSize || null }));
}

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function installOne(id) {
  setProgress(id, 'downloading', 'Downloading from Steam Workshop');
  try {
    await steamcmd.downloadWorkshopItem(id, emitRef);
    setProgress(id, 'linking', 'Linking into server folder');
    const r = link(id);
    emitRef('console', { source: 'mods', line: `Linked ${r.folderName} (${r.keys.length} key(s))` });
    setProgress(id, 'done');
  } catch (e) {
    setProgress(id, 'error', e.message);
    throw e;
  } finally {
    emitRef('mods:changed', {});
  }
}

async function add(id, { withDeps = true } = {}) {
  id = String(id).trim();
  if (!/^\d+$/.test(id)) throw new Error('Workshop ID must be numeric.');
  setProgress(id, 'queued', 'Resolving dependencies');
  const order = withDeps ? await resolveDeps([id]) : [id];
  await refreshMeta(order).catch(e => emitRef('console', { source: 'mods', line: `Metadata lookup failed: ${e.message}` }));
  // Insert deps ahead of the mod that needs them.
  for (const x of order) ensureEntry(x, x === id ? null : id);
  // Workshop items tagged "Server" (and not "Mod") are server-side only: put them in -serverMod automatically.
  {
    const s2 = settings.load();
    const mods2 = s2.mods.map(m => {
      const tags = (s2.modCache[m.id] || {}).tags || [];
      if (order.includes(m.id) && m.serverSide === false && tags.includes('Server') && !tags.includes('Mod')) return { ...m, serverSide: true };
      return m;
    });
    settings.save({ mods: mods2 });
  }
  emitRef('mods:changed', {});
  const s = settings.load();
  const p = settings.paths(s);
  const failed = [];
  for (const x of order) {
    if (fs.existsSync(path.join(p.workshopDir, x)) && list().find(m => m.id === x && m.linked)) { setProgress(x, 'done'); continue; }
    try { await enqueue(() => installOne(x)); }
    catch (e) { failed.push({ id: x, error: e.message }); }
  }
  if (failed.length) throw new Error(`${failed.length} mod(s) failed: ${failed.map(f => f.error).join('; ')}`);
  return list();
}

async function update(id) {
  if (isLocal(id)) { link(id); emitRef('mods:changed', {}); return list(); }
  await enqueue(() => installOne(id));
  return list();
}

async function updateAll(onlyOutdated = true) {
  await checkUpdates();
  const targets = list().filter(m => !m.local && (!onlyOutdated || m.updateAvailable || !m.installed));
  const failed = [];
  for (const m of targets) {
    try { await update(m.id); } catch (e) { failed.push({ id: m.id, error: e.message }); }
  }
  return { updated: targets.length - failed.length, failed };
}

function remove(id, { deleteFiles = false } = {}) {
  const s = settings.load();
  unlink(id);
  if (deleteFiles && !isLocal(id)) {
    const p = settings.paths(s);
    fs.rmSync(path.join(p.workshopDir, String(id)), { recursive: true, force: true });
  }
  const modCache = { ...s.modCache };
  delete modCache[id];
  delete progress[id];
  settings.save({ mods: s.mods.filter(m => m.id !== String(id)), modCache });
  emitRef('mods:changed', {});
  return list();
}

function setFlags(id, flags) {
  const s = settings.load();
  settings.save({ mods: s.mods.map(m => m.id === String(id) ? { ...m, ...flags } : m) });
  emitRef('mods:changed', {});
  return list();
}

function reorder(ids) {
  const s = settings.load();
  const byId = Object.fromEntries(s.mods.map(m => [m.id, m]));
  const ordered = ids.map(id => byId[id]).filter(Boolean);
  for (const m of s.mods) if (!ordered.includes(m)) ordered.push(m);
  settings.save({ mods: ordered });
  emitRef('mods:changed', {});
  return list();
}

// Sort so every dependency comes before the mods that need it (stable otherwise).
function autoSort() {
  const s = settings.load();
  const ids = s.mods.map(m => m.id);
  const deps = id => ((s.modCache[id] || {}).deps || []).filter(d => ids.includes(d));
  const out = [];
  const visit = (id, stack = new Set()) => {
    if (out.includes(id) || stack.has(id)) return;
    stack.add(id);
    for (const d of deps(id)) visit(d, stack);
    out.push(id);
  };
  ids.forEach(id => visit(id));
  return reorder(out);
}

async function checkUpdates() {
  const s = settings.load();
  const ids = s.mods.map(m => m.id).filter(id => !isLocal(id));
  if (ids.length) await refreshMeta(ids);
  // Authors add requirements over time: re-read them so missing dependencies show up before the next restart.
  for (const id of ids) {
    const fetched = await fetchRequiredItems(id, 2);
    if (fetched === null) continue;
    const s2 = settings.load();
    settings.save({ modCache: { ...s2.modCache, [id]: { ...(s2.modCache[id] || {}), deps: fetched } } });
  }
  settings.save({ lastUpdateCheck: Date.now() });
  emitRef('mods:changed', {});
  const missing = list().filter(m => m.missingDeps && m.missingDeps.length);
  if (missing.length) emitRef('console', { source: 'mods', line: `${missing.length} mod(s) have missing dependencies: ${missing.map(m => m.title).join(', ')}. Use +deps on the Installed page.` });
  return list().filter(m => m.updateAvailable);
}

// Find mods on disk that the tool does not know about yet.
function scanUnmanaged() {
  const s = settings.load();
  const p = settings.paths(s);
  const known = new Set(s.mods.map(m => m.id));
  const found = [];
  try {
    for (const e of fs.readdirSync(p.workshopDir, { withFileTypes: true })) {
      if (e.isDirectory() && /^\d+$/.test(e.name) && !known.has(e.name)) found.push({ id: e.name, kind: 'workshop', title: readMetaName(path.join(p.workshopDir, e.name)) || `Mod ${e.name}` });
    }
  } catch { /* no workshop dir */ }
  try {
    for (const e of fs.readdirSync(p.serverDir, { withFileTypes: true })) {
      if (!e.name.startsWith('@')) continue;
      const full = path.join(p.serverDir, e.name);
      let isLink = false;
      try { isLink = fs.lstatSync(full).isSymbolicLink(); } catch { /* ignore */ }
      if (isLink) {
        let target = '';
        try { target = fs.readlinkSync(full); } catch { /* ignore */ }
        const id = path.basename(target);
        if (/^\d+$/.test(id) && !known.has(id) && !found.some(f => f.id === id)) found.push({ id, kind: 'workshop', title: readMetaName(full) || e.name, folderName: e.name });
        continue;
      }
      const metaId = readMetaId(full);
      if (metaId && !known.has(metaId) && !found.some(f => f.id === metaId)) { found.push({ id: metaId, kind: 'copied', title: readMetaName(full) || e.name, folderName: e.name }); continue; }
      if (!known.has(e.name)) found.push({ id: e.name, kind: 'local', title: readMetaName(full) || e.name, folderName: e.name });
    }
  } catch { /* no server dir */ }
  return found;
}

// Register unmanaged mods found on disk without downloading anything.
async function importUnmanaged(items) {
  const s = settings.load();
  const mods = [...s.mods];
  const modCache = { ...s.modCache };
  for (const it of items) {
    if (mods.some(m => m.id === it.id)) continue;
    mods.push({ id: it.id, enabled: true, serverSide: false });
    if (it.kind === 'local' || it.kind === 'copied') {
      // A copied folder is treated as a local mod under its folder name.
      const id = it.kind === 'copied' ? it.folderName : it.id;
      mods[mods.length - 1].id = id;
      modCache[id] = { ...(modCache[id] || {}), folderName: it.folderName, title: it.title };
    } else {
      modCache[it.id] = { ...(modCache[it.id] || {}), folderName: it.folderName || null, title: it.title };
    }
  }
  settings.save({ mods, modCache });
  for (const m of settings.load().mods) {
    try { link(m.id); } catch { /* not downloaded */ }
  }
  await refreshMeta(items.filter(i => i.kind === 'workshop').map(i => i.id)).catch(() => {});
  emitRef('mods:changed', {});
  return list();
}

// Frameworks that must load before everything else, in this order.
const FRAMEWORK_ORDER = [/^@?(CF|Community[- ]?Framework)$/i, /^@?Dabs[- ]?Framework$/i, /^@?Community[- ]?Online[- ]?Tools$/i, /^@?DayZ[- ]?Expansion[- ]?Core$/i, /^@?DayZ[- ]?Expansion[- ]?Licensed$/i, /^@?VPP[- ]?Admin[- ]?Tools$/i];

// Auto-organize: frameworks first (in a known order), then everything else in dependency order.
function autoOrganize() {
  const s = settings.load();
  const title = id => (s.modCache[id] || {}).title || (s.modCache[id] || {}).folderName || id;
  const rank = id => { const t = title(id).replace(/^@/, ''); const i = FRAMEWORK_ORDER.findIndex(re => re.test(t)); return i < 0 ? 99 : i; };
  const ids = s.mods.map(m => m.id).sort((a, b) => rank(a) - rank(b));
  settings.save({ mods: ids.map(id => s.mods.find(m => m.id === id)) });
  return autoSort();
}

// The launch strings as the server will receive them, split into the pieces people care about.
const p0 = (s) => settings.paths(s);
function launchLines(s = settings.load()) {
  const folder = m => isLocal(m.id) ? m.id : (s.modCache[m.id] || {}).folderName;
  const enabled = s.mods.filter(m => m.enabled !== false && folder(m));
  const client = enabled.filter(m => !m.serverSide), serverOnly = enabled.filter(m => m.serverSide);
  const local = s.mods.filter(m => isLocal(m.id));
  const missing = s.mods.filter(m => m.enabled !== false && !folder(m));
  const other = (s.extraParams || '').trim();
  const mod = modParam(s, false), serverMod = modParam(s, true);
  return {
    mod: mod ? `-mod=${mod}` : '', serverMod: serverMod ? `-serverMod=${serverMod}` : '',
    serverModManual: s.serverModManual || '', serverModFlagged: serverOnly.map(folder),
    savedTo: fs.existsSync(path.join(p0(s).serverDir, 'start_server.bat')) ? path.join(p0(s).serverDir, 'start_server.bat') : null,
    local: local.map(m => ({ id: m.id, enabled: m.enabled !== false, serverSide: !!m.serverSide })),
    other, counts: { client: client.length, server: serverOnly.length, local: local.length, disabled: s.mods.filter(m => m.enabled === false).length, missing: missing.length },
    missing: missing.map(m => (s.modCache[m.id] || {}).title || m.id),
    full: [`-config=${s.configFile}`, `-port=${s.port}`, `-profiles=${s.profilesDir}`, s.cpuCount > 0 ? `-cpuCount=${s.cpuCount}` : '', other, mod ? `"-mod=${mod}"` : '', serverMod ? `"-serverMod=${serverMod}"` : ''].filter(Boolean).join(' ')
  };
}

// -mod is generated from the enabled mods in list order. -serverMod starts with whatever the operator typed
// (settings.serverModManual, ';'-separated folder names) followed by mods flagged server-only in the list.
// Mods in the list that declare this id as a requirement.
function dependents(id) {
  const s = settings.load();
  return s.mods.filter(m => ((s.modCache[m.id] || {}).deps || []).includes(String(id))).map(m => (s.modCache[m.id] || {}).title || m.id);
}

function modParam(s, serverSide) {
  const generated = s.mods
    .filter(m => m.enabled !== false && !!m.serverSide === serverSide)
    .map(m => isLocal(m.id) ? m.id : (s.modCache[m.id] || {}).folderName)
    .filter(Boolean);
  if (!serverSide) return generated.join(';');
  const manual = String(s.serverModManual || '').split(/[;\n,]+/).map(x => x.trim()).filter(Boolean);
  const seen = new Set();
  return [...manual, ...generated].filter(f => { const k = f.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).join(';');
}

// Keep the launch strings saved in the server folder so it can be started without the tool
// (start_server.bat = full command line, modlist.txt = the -mod / -serverMod lines).
function writeLaunchFiles() {
  const s = settings.load();
  const p = settings.paths(s);
  if (!fs.existsSync(p.serverDir)) return null;
  const ll = launchLines(s);
  const bat = [
    '@echo off',
    'REM Generated by DayZ Admin Tools - edit the mod list in the tool, this file is rewritten whenever it changes.',
    `cd /d "%~dp0"`,
    `start "DayZ Server" "DayZServer_x64.exe" ${ll.full}`,
    ''
  ].join('\r\n');
  const txt = [
    '# Generated by DayZ Admin Tools',
    ll.mod || '-mod=',
    ll.serverMod || '-serverMod=',
    ll.local.length ? '# local: ' + ll.local.map(l => l.id).join(';') : '# local: (none)',
    '# other: ' + (ll.other || '(none)'),
    ''
  ].join('\r\n');
  try {
    fs.writeFileSync(path.join(p.serverDir, 'start_server.bat'), bat, 'utf8');
    fs.writeFileSync(path.join(p.serverDir, 'modlist.txt'), txt, 'utf8');
    return { bat: path.join(p.serverDir, 'start_server.bat'), modlist: path.join(p.serverDir, 'modlist.txt') };
  } catch { return null; }
}

function init(emit) {
  emitRef = (channel, data) => {
    if (channel === 'mods:changed') { try { writeLaunchFiles(); } catch { /* ignore */ } }
    emit(channel, data);
  };
}

module.exports = { init, list, add, plan, update, updateAll, remove, setFlags, reorder, autoSort, autoOrganize, launchLines, writeLaunchFiles, checkUpdates, dependents, modParam, link, fetchDetails, scanUnmanaged, importUnmanaged, fetchRequiredItems };
