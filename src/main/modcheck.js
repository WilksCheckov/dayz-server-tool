'use strict';
// Mod safety checks: duplicate PBOs across mods, missing keys, broken links, and a "what players need" string.
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const mods = require('./mods');

function pbosIn(dir) {
  const out = [];
  const walk = (d, depth) => { if (depth > 3) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.isDirectory()) walk(path.join(d, e.name), depth + 1); else if (/\.pbo$/i.test(e.name)) out.push(e.name.toLowerCase()); } };
  walk(dir, 0);
  return out;
}

function run() {
  const s = settings.load();
  const p = settings.paths(s);
  const list = mods.list();
  const problems = [];
  const pboOwners = {};
  let keysDir = []; try { keysDir = fs.readdirSync(p.keysDir).map(f => f.toLowerCase()); } catch { /* none */ }
  for (const m of list) {
    if (!m.enabled) continue;
    const dir = m.folderName ? path.join(p.serverDir, m.folderName) : null;
    if (!m.installed) { problems.push({ level: 'error', mod: m.title, text: 'Not downloaded.' }); continue; }
    if (!dir || !fs.existsSync(dir)) { problems.push({ level: 'error', mod: m.title, text: `Folder ${m.folderName || '?'} is missing from the server directory (not linked).` }); continue; }
    const pbos = pbosIn(dir);
    if (!pbos.length) problems.push({ level: 'warning', mod: m.title, text: 'Contains no .pbo files; the server will ignore it.' });
    for (const pbo of pbos) { (pboOwners[pbo] = pboOwners[pbo] || []).push(m.title); }
    if (!m.serverSide) {
      const keys = (m.keys || []).map(k => k.toLowerCase());
      if (!keys.length) problems.push({ level: 'warning', mod: m.title, text: 'No .bikey found in the mod; clients will be kicked with verifySignatures=2 unless another mod provides the key.' });
      else for (const k of keys) if (!keysDir.includes(k)) problems.push({ level: 'error', mod: m.title, text: `Key ${k} is not in the server keys folder. Re-link the mod.` });
    }
    const meta = path.join(dir, 'meta.cpp');
    if (!fs.existsSync(meta)) problems.push({ level: 'info', mod: m.title, text: 'No meta.cpp (fine for local mods, unusual for workshop mods).' });
  }
  for (const [pbo, owners] of Object.entries(pboOwners)) if (owners.length > 1) problems.push({ level: 'warning', mod: owners.join(' + '), text: `Duplicate PBO ${pbo} in ${owners.length} mods; the last one in load order wins and the others may misbehave.` });
  // keys: same file name with different keys, stale copies, leftovers from removed mods
  try { for (const k of require('./modkeys').map().keys) if (['conflict', 'outdated', 'orphan'].includes(k.status)) problems.push({ level: k.status === 'conflict' ? 'error' : k.status === 'outdated' ? 'warning' : 'info', mod: k.mods.map(x => x.title).join(' + ') || k.file, text: k.file + ': ' + k.note }); } catch { /* keys folder unreadable */ }
  let cfgText = ''; try { cfgText = fs.readFileSync(p.configPath, 'utf8'); } catch { /* ignore */ }
  const vs = cfgText.match(/verifySignatures\s*=\s*(\d)/);
  if (vs && vs[1] !== '2') problems.push({ level: 'warning', mod: 'serverDZ.cfg', text: `verifySignatures is ${vs[1]}; 2 is required for signed mods to be enforced.` });
  const client = list.filter(m => m.enabled && !m.serverSide);
  const playersNeed = client.map(m => m.local ? m.title : `${m.title} (${m.id})`).join(', ');
  const workshopLinks = client.filter(m => !m.local).map(m => `https://steamcommunity.com/sharedfiles/filedetails/?id=${m.id}`).join('\n');
  const order = { error: 0, warning: 1, info: 2 };
  problems.sort((a, b) => order[a.level] - order[b.level]);
  return { problems, counts: { error: problems.filter(x => x.level === 'error').length, warning: problems.filter(x => x.level === 'warning').length, info: problems.filter(x => x.level === 'info').length }, playersNeed, workshopLinks, clientCount: client.length };
}

module.exports = { run };
