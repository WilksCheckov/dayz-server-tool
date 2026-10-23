'use strict';
// Server keys (.bikey) and the mods that ship them: which mod needs which key, keys shared by several mods, keys
// no mod ships any more, and keys whose copy in the keys folder differs from the one the mod ships. Removing a mod
// deletes its keys only when no other mod folder (managed or not, enabled or not) ships a key of the same name.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');

const BASE = new Set(['dayz.bikey']); // the game's own key: never removed
let emitRef = () => {};

// A .bikey is the signer's name, a zero byte, then the public key. Returns null for anything else.
function readKey(file) {
  try {
    const buf = fs.readFileSync(file);
    const z = buf.indexOf(0);
    if (z < 1 || z > 256 || buf.length < z + 24) return null;
    return { authority: buf.slice(0, z).toString('latin1'), hash: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) };
  } catch { return null; }
}

// .bikey files inside a mod folder (keys/ or Keys/, sometimes deeper)
function keysIn(dir) {
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

// Every mod the server could load: the tool's mods (from their download folder) and @folders in the server
// directory the tool does not manage.
function modFolders(s = settings.load()) {
  const p = settings.paths(s);
  const out = [];
  for (const m of s.mods) {
    const c = s.modCache[m.id] || {};
    const local = String(m.id).startsWith('@');
    out.push({ id: String(m.id), title: c.title || c.folderName || m.id, managed: true, enabled: m.enabled !== false, serverSide: !!m.serverSide,
      dir: local ? path.join(p.serverDir, m.id) : path.join(p.workshopDir, String(m.id)), folderName: local ? m.id : (c.folderName || null), recorded: c.keys || [] });
  }
  const managed = new Set(out.map(o => (o.folderName || '').toLowerCase()).filter(Boolean));
  try {
    for (const e of fs.readdirSync(p.serverDir, { withFileTypes: true })) {
      if (!e.name.startsWith('@') || managed.has(e.name.toLowerCase())) continue;
      out.push({ id: e.name, title: e.name, managed: false, enabled: null, serverSide: false, dir: path.join(p.serverDir, e.name), folderName: e.name, recorded: [] });
    }
  } catch { /* no server folder yet */ }
  return out;
}

// The full picture for the Keys card: one row per key file, one row per mod.
function map() {
  const s = settings.load();
  const p = settings.paths(s);
  const folders = modFolders(s);
  const byFile = {};
  const entry = (name) => byFile[name.toLowerCase()] || (byFile[name.toLowerCase()] = { file: name, shipped: [], inFolder: null });
  for (const f of folders) {
    f.keys = [];
    const found = keysIn(f.dir);
    for (const k of found) {
      const info = readKey(k); if (!info) continue;
      const name = path.basename(k); f.keys.push(name);
      entry(name).shipped.push({ mod: f.id, title: f.title, managed: f.managed, enabled: f.enabled, hash: info.hash, authority: info.authority });
    }
    // a listed mod that is not downloaded right now still owns the keys it had
    if (!found.length && f.managed) for (const name of f.recorded) { f.keys.push(name); entry(name).shipped.push({ mod: f.id, title: f.title, managed: true, enabled: f.enabled, hash: null, authority: null, notDownloaded: true }); }
  }
  try {
    for (const name of fs.readdirSync(p.keysDir)) {
      if (!/\.bikey$/i.test(name)) continue;
      const info = readKey(path.join(p.keysDir, name));
      entry(name).inFolder = info || { authority: '?', hash: null, unreadable: true };
      byFile[name.toLowerCase()].file = name;
    }
  } catch { /* no keys folder yet */ }

  const keys = Object.values(byFile).map(k => {
    const hashes = [...new Set(k.shipped.map(x => x.hash).filter(Boolean))];
    const users = [...new Set(k.shipped.map(x => x.mod))];
    const needed = k.shipped.some(x => x.enabled !== false);
    let status = 'ok', note = '';
    if (BASE.has(k.file.toLowerCase())) { status = 'base'; note = 'The game\'s own key. Always kept.'; }
    else if (!users.length) { status = 'orphan'; note = 'No mod in the server or download folders ships this key. Left over from a mod that is gone; safe to remove.'; }
    else if (hashes.length > 1) { status = 'conflict'; note = `Mods ship different keys under the same file name; only one can be in the keys folder, so players of the other mod are kicked. Ask the authors, or rename one mod's key file in its keys folder.`; }
    else if (!k.inFolder && needed) { status = 'missing'; note = 'Not in the keys folder; players are kicked when signatures are checked. Use Fix to copy it.'; }
    else if (!k.inFolder) { status = 'unused'; note = 'Only disabled mods ship it, so it is not in the keys folder.'; }
    else if (hashes.length && k.inFolder.hash && !hashes.includes(k.inFolder.hash)) { status = 'outdated'; note = 'The copy in the keys folder differs from the key the mod ships now (the author re-signed it). Use Fix to copy the current one.'; }
    else if (users.length > 1) { status = 'shared'; note = `Shared by ${users.length} mods; kept until the last of them is removed.`; }
    const authority = (k.inFolder && k.inFolder.authority) || (k.shipped.find(x => x.authority) || {}).authority || '';
    return { file: k.file, authority, inFolder: !!k.inFolder, status, note, mods: k.shipped.map(x => ({ id: x.mod, title: x.title, managed: x.managed, enabled: x.enabled, notDownloaded: !!x.notDownloaded })) };
  }).sort((a, b) => a.file.localeCompare(b.file, undefined, { sensitivity: 'base' }));
  // the same key under several names is harmless, just worth knowing
  const sameKey = {};
  for (const f of folders) for (const name of f.keys) { const k = byFile[name.toLowerCase()]; const h = k && k.inFolder && k.inFolder.hash; if (h) (sameKey[h] = sameKey[h] || new Set()).add(k.file); }
  for (const k of keys) { const h = (byFile[k.file.toLowerCase()].inFolder || {}).hash; const names = h && sameKey[h] ? [...sameKey[h]].filter(n => n !== k.file) : []; if (names.length) k.sameAs = names; }

  const counts = {};
  for (const k of keys) counts[k.status] = (counts[k.status] || 0) + 1;
  return {
    keysDir: p.keysDir, keys, counts,
    mods: folders.map(f => ({ id: f.id, title: f.title, managed: f.managed, enabled: f.enabled, serverSide: f.serverSide, keys: f.keys.map(n => { const k = keys.find(x => x.file.toLowerCase() === n.toLowerCase()); return { file: n, status: k ? k.status : 'ok', sharedWith: k ? k.mods.filter(x => x.id !== f.id).map(x => x.title) : [] }; }) }))
  };
}

// Which keys go and which stay if mod `id` stops shipping `files` (removed, or updated with a new key).
function plan(id, files) {
  const others = modFolders().filter(f => f.id !== String(id));
  const owners = {};
  for (const f of others) {
    const names = keysIn(f.dir).map(k => path.basename(k));
    for (const n of (names.length ? names : f.recorded)) (owners[n.toLowerCase()] = owners[n.toLowerCase()] || []).push(f.title);
  }
  const remove = [], keep = [];
  for (const file of files || []) {
    if (BASE.has(file.toLowerCase())) { keep.push({ file, by: ['the game'] }); continue; }
    const by = owners[file.toLowerCase()];
    if (by && by.length) keep.push({ file, by: [...new Set(by)] }); else remove.push(file);
  }
  return { remove, keep };
}

// Delete the keys only that mod shipped; say which ones stay and why.
function release(id, files, title) {
  const p = settings.paths();
  const r = plan(id, files);
  const removed = [];
  for (const f of r.remove) { try { fs.unlinkSync(path.join(p.keysDir, f)); removed.push(f); } catch (e) { if (e.code !== 'ENOENT') emitRef('console', { source: 'mods', line: `Could not delete key ${f}: ${e.message}` }); } }
  const who = title || id;
  if (removed.length) emitRef('console', { source: 'mods', line: `Removed key${removed.length > 1 ? 's' : ''} ${removed.join(', ')} (only ${who} used ${removed.length > 1 ? 'them' : 'it'})` });
  for (const k of r.keep) emitRef('console', { source: 'mods', line: `Kept key ${k.file}: also used by ${k.by.join(', ')}` });
  return { removed, kept: r.keep };
}

// Remove keys that no mod ships. Re-checked here so a key a mod still needs is never deleted.
function removeOrphans(files) {
  const p = settings.paths();
  const orphans = new Set(map().keys.filter(k => k.status === 'orphan').map(k => k.file.toLowerCase()));
  const removed = [];
  for (const f of files || []) {
    if (!orphans.has(String(f).toLowerCase()) || path.basename(f) !== f) continue;
    try { fs.unlinkSync(path.join(p.keysDir, f)); removed.push(f); } catch { /* gone already */ }
  }
  if (removed.length) emitRef('console', { source: 'mods', line: `Removed leftover key${removed.length > 1 ? 's' : ''} ${removed.join(', ')}` });
  emitRef('mods:changed', {});
  return { removed, map: map() };
}

// Copy the key the mods ship into the keys folder (missing or outdated).
function fix(file) {
  const p = settings.paths();
  const src = modFolders().filter(f => f.enabled !== false).flatMap(f => keysIn(f.dir)).find(k => path.basename(k).toLowerCase() === String(file).toLowerCase());
  if (!src) throw new Error(`No enabled mod ships ${file}.`);
  fs.mkdirSync(p.keysDir, { recursive: true });
  fs.copyFileSync(src, path.join(p.keysDir, path.basename(src)));
  emitRef('console', { source: 'mods', line: `Copied key ${path.basename(src)} into the keys folder` });
  emitRef('mods:changed', {});
  return map();
}

function init(emit) { emitRef = emit; }

module.exports = { init, map, plan, release, removeOrphans, fix, keysIn, readKey };
