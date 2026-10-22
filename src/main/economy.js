'use strict';
// Loot economy editor backend: types.xml (vanilla + CE-registered custom files), events.xml and cfgspawnabletypes.xml
// read into plain rows and written back in the exact layout the DayZ server expects.
const fs = require('fs');
const path = require('path');
const configs = require('./configs');
const { xmlParser } = configs;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const arr = x => x === undefined ? [] : Array.isArray(x) ? x : [x];
const attr = (o, n) => o && o['@_' + n];
const numOrNull = v => v === undefined || v === null || v === '' ? null : Number(v);

function md() { const m = configs.missionDir(); if (!m || !fs.existsSync(m)) throw new Error('No mission folder found. Set the template in serverDZ.cfg and install the server first.'); return m; }

// ---------- file discovery ----------
function files() {
  const m = md();
  const typesFiles = [{ label: 'db/types.xml (vanilla)', abs: path.join(m, 'db', 'types.xml') }];
  const eventsFiles = [{ label: 'db/events.xml (vanilla)', abs: path.join(m, 'db', 'events.xml') }];
  const spawnFiles = [{ label: 'cfgspawnabletypes.xml (vanilla)', abs: path.join(m, 'cfgspawnabletypes.xml') }];
  try {
    const core = xmlParser.parse(fs.readFileSync(path.join(m, 'cfgeconomycore.xml'), 'utf8'));
    for (const ce of arr(core.economycore && core.economycore.ce)) {
      const folder = attr(ce, 'folder') || '';
      for (const f of arr(ce.file)) {
        const abs = path.join(m, folder, attr(f, 'name') || '');
        const label = `${folder}/${attr(f, 'name')}`;
        if (attr(f, 'type') === 'types') typesFiles.push({ label, abs });
        else if (attr(f, 'type') === 'events') eventsFiles.push({ label, abs });
        else if (attr(f, 'type') === 'spawnabletypes') spawnFiles.push({ label, abs });
      }
    }
  } catch { /* no economy core */ }
  const mark = l => l.map(f => ({ ...f, exists: fs.existsSync(f.abs) }));
  return { missionDir: m, types: mark(typesFiles), events: mark(eventsFiles), spawnable: mark(spawnFiles) };
}

function limits() {
  const m = md();
  const out = { categories: [], usages: [], values: [], tags: [] };
  try {
    const doc = xmlParser.parse(fs.readFileSync(path.join(m, 'cfglimitsdefinition.xml'), 'utf8'));
    const l = doc.lists || {};
    out.categories = arr(l.categories && l.categories.category).map(c => attr(c, 'name')).filter(Boolean);
    out.usages = arr(l.usageflags && l.usageflags.usage).map(c => attr(c, 'name')).filter(Boolean);
    out.values = arr(l.valueflags && l.valueflags.value).map(c => attr(c, 'name')).filter(Boolean);
    out.tags = arr(l.tags && l.tags.tag).map(c => attr(c, 'name')).filter(Boolean);
  } catch { /* missing */ }
  return out;
}

function safe(abs) {
  const m = path.resolve(md());
  const a = path.resolve(abs);
  if (!a.startsWith(m + path.sep)) throw new Error('File is outside the mission folder.');
  return a;
}

function backupAndWrite(abs, text) {
  try { if (fs.existsSync(abs)) fs.copyFileSync(abs, abs + '.bak'); } catch { /* ignore */ }
  fs.writeFileSync(abs, text, 'utf8');
  return configs.validate(abs);
}

// ---------- types ----------
const FLAGS = ['count_in_cargo', 'count_in_hoarder', 'count_in_map', 'count_in_player', 'crafted', 'deloot'];
function loadTypes(abs) { abs = safe(abs); return typesFromDoc(xmlParser.parse(fs.readFileSync(abs, 'utf8'))); }
function typesFromDoc(doc) {
  if (!doc.types) throw new Error('Root element is not <types>.');
  return arr(doc.types.type).map(t => {
    const fl = arr(t.flags)[0] || {};
    return {
      name: attr(t, 'name') || '', nominal: numOrNull(t.nominal), lifetime: numOrNull(t.lifetime), restock: numOrNull(t.restock), min: numOrNull(t.min),
      quantmin: numOrNull(t.quantmin), quantmax: numOrNull(t.quantmax), cost: numOrNull(t.cost),
      flags: Object.fromEntries(FLAGS.map(f => [f, attr(fl, f) === undefined ? null : Number(attr(fl, f))])),
      category: arr(t.category).map(c => attr(c, 'name')).filter(Boolean),
      usage: arr(t.usage).map(c => attr(c, 'name')).filter(Boolean),
      value: arr(t.value).map(c => attr(c, 'name')).filter(Boolean),
      tag: arr(t.tag).map(c => attr(c, 'name')).filter(Boolean)
    };
  });
}
function typesXml(rows) {
  const line = (k, v) => v === null || v === undefined ? '' : `        <${k}>${v}</${k}>\n`;
  const body = rows.map(r => {
    const flags = FLAGS.filter(f => r.flags && r.flags[f] !== null && r.flags[f] !== undefined).map(f => ` ${f}="${r.flags[f]}"`).join('');
    return `    <type name="${esc(r.name)}">\n` + line('nominal', r.nominal) + line('lifetime', r.lifetime) + line('restock', r.restock) + line('min', r.min) + line('quantmin', r.quantmin) + line('quantmax', r.quantmax) + line('cost', r.cost) +
      (flags ? `        <flags${flags}/>\n` : '') +
      r.category.map(c => `        <category name="${esc(c)}"/>\n`).join('') + r.usage.map(c => `        <usage name="${esc(c)}"/>\n`).join('') + r.value.map(c => `        <value name="${esc(c)}"/>\n`).join('') + r.tag.map(c => `        <tag name="${esc(c)}"/>\n`).join('') +
      `    </type>\n`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<types>\n${body}</types>\n`;
}
function saveTypes(abs, rows) { abs = safe(abs); const r = backupAndWrite(abs, typesXml(rows)); return { saved: rows.length, problems: r.problems, counts: r.counts }; }

// ---------- events ----------
const EFLAGS = ['deletable', 'init_random', 'remove_damaged'];
function loadEvents(abs) { abs = safe(abs); return eventsFromDoc(xmlParser.parse(fs.readFileSync(abs, 'utf8'))); }
function eventsFromDoc(doc) {
  if (!doc.events) throw new Error('Root element is not <events>.');
  return arr(doc.events.event).map(e => {
    const fl = arr(e.flags)[0] || {};
    return {
      name: attr(e, 'name') || '', nominal: numOrNull(e.nominal), min: numOrNull(e.min), max: numOrNull(e.max), lifetime: numOrNull(e.lifetime), restock: numOrNull(e.restock),
      saferadius: numOrNull(e.saferadius), distanceradius: numOrNull(e.distanceradius), cleanupradius: numOrNull(e.cleanupradius),
      flags: Object.fromEntries(EFLAGS.map(f => [f, attr(fl, f) === undefined ? null : Number(attr(fl, f))])),
      position: e.position === undefined ? null : String(e.position), limit: e.limit === undefined ? null : String(e.limit), active: numOrNull(e.active),
      secondary: arr(e.secondary).map(s => String(s)),
      children: arr(arr(e.children)[0] && arr(e.children)[0].child).map(c => ({ type: attr(c, 'type') || '', min: numOrNull(attr(c, 'min')), max: numOrNull(attr(c, 'max')), lootmin: numOrNull(attr(c, 'lootmin')), lootmax: numOrNull(attr(c, 'lootmax')) })),
      hasChildren: arr(e.children).length > 0
    };
  });
}
function eventsXml(rows) {
  const line = (k, v) => v === null || v === undefined ? '' : `        <${k}>${esc(v)}</${k}>\n`;
  const body = rows.map(r => {
    const flags = EFLAGS.filter(f => r.flags && r.flags[f] !== null && r.flags[f] !== undefined).map(f => ` ${f}="${r.flags[f]}"`).join('');
    const kids = r.children.map(c => `            <child lootmax="${c.lootmax ?? 0}" lootmin="${c.lootmin ?? 0}" max="${c.max ?? 0}" min="${c.min ?? 0}" type="${esc(c.type)}"/>\n`).join('');
    return `    <event name="${esc(r.name)}">\n` + line('nominal', r.nominal) + line('min', r.min) + line('max', r.max) + line('lifetime', r.lifetime) + line('restock', r.restock) + line('saferadius', r.saferadius) + line('distanceradius', r.distanceradius) + line('cleanupradius', r.cleanupradius) +
      (flags ? `        <flags${flags}/>\n` : '') + line('position', r.position) + line('limit', r.limit) + line('active', r.active) + r.secondary.map(s => line('secondary', s)).join('') +
      (r.hasChildren || r.children.length ? (r.children.length ? `        <children>\n${kids}        </children>\n` : `        <children/>\n`) : '') +
      `    </event>\n`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<events>\n${body}</events>\n`;
}
function saveEvents(abs, rows) { abs = safe(abs); const r = backupAndWrite(abs, eventsXml(rows)); return { saved: rows.length, problems: r.problems, counts: r.counts }; }

// ---------- spawnable types ----------
function loadSpawnable(abs) { abs = safe(abs); return spawnableFromDoc(xmlParser.parse(fs.readFileSync(abs, 'utf8'))); }
function spawnableFromDoc(doc) {
  if (!doc.spawnabletypes) throw new Error('Root element is not <spawnabletypes>.');
  const raw = v => v === undefined || v === null ? null : String(v); // keep the author's number formatting (0.20 stays 0.20)
  const group = g => ({ chance: raw(attr(g, 'chance')), preset: attr(g, 'preset') || null, items: arr(g.item).map(i => ({ name: attr(i, 'name') || '', chance: raw(attr(i, 'chance')) })) });
  return arr(doc.spawnabletypes.type).map(t => ({
    name: attr(t, 'name') || '', hoarder: t.hoarder !== undefined, damage: t.damage ? { min: raw(attr(arr(t.damage)[0], 'min')), max: raw(attr(arr(t.damage)[0], 'max')) } : null,
    tag: arr(t.tag).map(c => attr(c, 'name')).filter(Boolean), attachments: arr(t.attachments).map(group), cargo: arr(t.cargo).map(group)
  }));
}
function spawnableXml(rows) {
  const group = (kind, g) => g.preset ? `        <${kind} preset="${esc(g.preset)}"/>\n` : `        <${kind} chance="${g.chance ?? 1}">\n${g.items.map(i => `            <item name="${esc(i.name)}"${i.chance === null || i.chance === undefined ? '' : ` chance="${i.chance}"`}/>\n`).join('')}        </${kind}>\n`;
  const body = rows.map(r => `    <type name="${esc(r.name)}">\n` + (r.hoarder ? '        <hoarder/>\n' : '') + (r.damage ? `        <damage min="${r.damage.min ?? 0}" max="${r.damage.max ?? 1}"/>\n` : '') + r.tag.map(c => `        <tag name="${esc(c)}"/>\n`).join('') + r.attachments.map(g => group('attachments', g)).join('') + r.cargo.map(g => group('cargo', g)).join('') + `    </type>\n`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<spawnabletypes>\n${body}</spawnabletypes>\n`;
}
function saveSpawnable(abs, rows) { abs = safe(abs); const r = backupAndWrite(abs, spawnableXml(rows)); return { saved: rows.length, problems: r.problems, counts: r.counts }; }

// ---------- import from pasted / dropped text ----------
const ROOTS = { types: 'types', events: 'events', spawnable: 'spawnabletypes' };
const CHILD = { types: 'type', events: 'event', spawnable: 'type' };
// Accepts a whole file, or a bare list of <type>/<event> elements copied from a mod's readme. Returns rows.
function rowsFromText(kind, text) {
  if (!ROOTS[kind]) throw new Error('Unknown kind ' + kind);
  let t = String(text || '').replace(/^﻿/, '').trim();
  if (!t) throw new Error('Nothing to import.');
  t = t.replace(/<\?xml[^>]*\?>/i, '').trim();
  const root = ROOTS[kind];
  if (!new RegExp('<' + root + '[\\s>]', 'i').test(t)) t = '<' + root + '>' + t + '</' + root + '>';
  let doc;
  try { doc = xmlParser.parse(t); } catch (e) { throw new Error('Could not parse XML: ' + e.message); }
  const rows = kind === 'types' ? typesFromDoc(doc) : kind === 'events' ? eventsFromDoc(doc) : spawnableFromDoc(doc);
  if (!rows.length) throw new Error('No <' + CHILD[kind] + '> entries found.');
  return rows;
}

// ---------- custom mission files (registered in cfgeconomycore.xml) ----------
function economyCorePath() { return path.join(md(), 'cfgeconomycore.xml'); }
function escRe(x) { return String(x).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&'); }
// Locate the <ce folder="X"> ... </ce> block.
function ceBlock(core, folder) {
  const re = new RegExp('<ce\\s+folder="' + escRe(folder) + '"[^>]*>', 'i');
  const m = re.exec(core); if (!m) return null;
  const close = core.indexOf('</ce>', m.index); if (close < 0) return null;
  return { open: m.index + m[0].length, close, start: m.index };
}
// Create (if missing) and register a types / events / spawnabletypes file. rel is relative to the mission, e.g. "custom/mymod_types.xml".
function createFile({ kind, rel }) {
  if (!ROOTS[kind]) throw new Error('Unknown kind ' + kind);
  rel = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || !/\.xml$/i.test(rel)) throw new Error('Give a file name ending in .xml, e.g. custom/mymod_types.xml');
  if (rel.includes('..')) throw new Error('Keep the file inside the mission folder.');
  const m = md();
  const abs = path.join(m, rel);
  const folder = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  const name = path.posix.basename(rel);
  if (!folder) throw new Error('Put custom files in a sub folder (for example custom/), the mission root is reserved for the vanilla files.');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<' + ROOTS[kind] + '>\n</' + ROOTS[kind] + '>\n', 'utf8');
  // register in cfgeconomycore.xml by editing the text, so comments and layout are kept
  const corePath = economyCorePath();
  let core = fs.existsSync(corePath) ? fs.readFileSync(corePath, 'utf8') : '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<economycore>\n</economycore>\n';
  const nl = core.includes('\r\n') ? '\r\n' : '\n';
  const b = ceBlock(core, folder);
  const already = !!(b && new RegExp('<file\\s+name="' + escRe(name) + '"[^>]*type="' + ROOTS[kind] + '"', 'i').test(core.slice(b.open, b.close)));
  if (!already) {
    const fileLine = '\t\t<file name="' + name + '" type="' + ROOTS[kind] + '" />';
    if (b) { const before = core.slice(0, b.close).replace(/[ \t]*$/, ''); core = before + nl + fileLine + nl + '\t' + core.slice(b.close); }
    else {
      const blk = '\t<ce folder="' + folder + '">' + nl + fileLine + nl + '\t</ce>' + nl;
      const e = core.search(/<\/economycore>/i);
      core = e >= 0 ? core.slice(0, e) + blk + core.slice(e) : core + blk;
    }
    try { fs.copyFileSync(corePath, corePath + '.bak'); } catch { /* ignore */ }
    fs.writeFileSync(corePath, core, 'utf8');
  }
  return { abs, registered: !already, files: files() };
}
// Remove a registration (the file itself is kept).
function unregisterFile(abs) {
  const m = md(); const rel = path.relative(m, abs).replace(/\\/g, '/');
  const folder = path.posix.dirname(rel), name = path.posix.basename(rel);
  const corePath = economyCorePath(); if (!fs.existsSync(corePath)) return files();
  let core = fs.readFileSync(corePath, 'utf8');
  const b = ceBlock(core, folder); if (!b) return files();
  let inner = core.slice(b.open, b.close);
  inner = inner.replace(new RegExp('[ \\t]*<file\\s+name="' + escRe(name) + '"[^>]*/>[ \\t]*(\\r?\\n)?', 'i'), '');
  if (!/<file\s/i.test(inner)) {
    const lineStart = core.lastIndexOf('\n', b.start) + 1;
    let after = b.close + '</ce>'.length; if (core[after] === '\r') after++; if (core[after] === '\n') after++;
    core = core.slice(0, lineStart) + core.slice(after);
  } else core = core.slice(0, b.open) + inner + core.slice(b.close);
  try { fs.copyFileSync(corePath, corePath + '.bak'); } catch { /* ignore */ }
  fs.writeFileSync(corePath, core, 'utf8');
  return files();
}

module.exports = { rowsFromText, createFile, unregisterFile, files, limits, loadTypes, saveTypes, typesXml, loadEvents, saveEvents, eventsXml, loadSpawnable, saveSpawnable, spawnableXml, FLAGS, EFLAGS };
