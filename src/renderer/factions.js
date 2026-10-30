'use strict';
// Factions page: DRP Factions set up and run from the tool. Setup installs the mod; the other tabs read what the mod
// keeps and send admin commands, which the server applies within a few seconds (or at its next start). Loaded after
// map.js (shares its globals: $, esc, ipc, toast, showModal, ask, withReason, fmtDate).
const fx = { tab: 'setup', state: null, setup: null, schema: null, sel: null, timer: null, seq: null, worldSize: 15360, q: '' };

function fxTime(t) { if (!t) return '—'; const off = fx.state ? fx.state.clockOffset : 0; return new Date((t - off) * 1000).toLocaleString(); }
function fxIn(t) { if (!t) return ''; const off = fx.state ? fx.state.clockOffset : 0; const s = Math.round((t - off) - Date.now() / 1000); const a = Math.abs(s); const txt = a >= 86400 ? `${Math.floor(a / 86400)}d ${Math.floor(a % 86400 / 3600)}h` : a >= 3600 ? `${Math.floor(a / 3600)}h ${Math.floor(a % 3600 / 60)}m` : `${Math.max(1, Math.floor(a / 60))}m`; return s >= 0 ? 'in ' + txt : txt + ' ago'; }
// Sectors come from map.js (sec, sectorName, sectorAt): the same sector map the Map page draws.
function fxCell(id) { return sectorName(id); }
// a sector by its name (as the lists and the map show it)
function fxParseCell(text) {
  const q = String(text).trim().toLowerCase(); if (!q || !sec.map) return null;
  const s = sec.map.sectors.find(x => x.name.toLowerCase() === q) || sec.map.sectors.find(x => x.name.toLowerCase().startsWith(q));
  return s ? s.id : null;
}
async function fxSectors() {
  const at = fx.state && fx.state.sectorsAt; if (!at || (sec.map && sec.at === at)) return;
  try { if (!adm.zones || !adm.zones.available || adm.zones.sectorsAt !== at) adm.zones = await ipc.invoke('drpzones:state'); await loadSectors(); } catch { /* shown when it loads */ }
}

async function fxCmd(cmd, done) {
  try { await ipc.invoke('drpf:command', cmd); toast(`${done || 'Sent'}. The server applies it within a few seconds${fx.setup && fx.setup.serverRunning ? '' : ' (or at its next start)'}.`); await fxLoad(); }
  catch (e) { toast(e.message, true); }
}
// every action asks for a reason, like the map's admin actions (it goes in the audit log)
const fxAct = (title, body, label, cmd, done) => withReason(title, body, label, (why) => fxCmd({ ...cmd, reason: why }, done));

async function fxLoad() {
  try { [fx.setup, fx.state] = await Promise.all([ipc.invoke('drpf:setup'), ipc.invoke('drpf:state')]); } catch (e) { toast(e.message, true); return; }
  if (!fx.schema) try { fx.schema = await ipc.invoke('drpf:schema'); const mi = await ipc.invoke('mission:mapInfo'); if (mi && mi.size) fx.worldSize = mi.size; } catch { /* older main */ }
  const S = fx.state;
  if (S && S.available) await fxSectors();
  if (S && S.available) {
    if (fx.seq !== null && S.result.seq > fx.seq) { const m = S.result.messages[S.result.messages.length - 1] || ''; toast('Server: ' + m.replace(/^\d\d:\d\d:\d\d /, ''), /refused|not found|Unknown|No /.test(m)); }
    fx.seq = S.result.seq;
  }
  fxRender();
}
function fxStart() { fxLoad(); clearInterval(fx.timer); fx.timer = setInterval(() => { if (document.querySelector('#page-factions.active')) fxLoad(); else { clearInterval(fx.timer); fx.timer = null; } }, 4000); }

function fxRender(force) {
  document.querySelectorAll('#page-factions .tab[data-ftab]').forEach(b => b.classList.toggle('active', b.dataset.ftab === fx.tab));
  const S = fx.state; const st = fx.setup;
  $('fxStatus').innerHTML = !st ? '' : `${st.ready ? '<span class="badge ok">set up</span>' : '<span class="badge warn">setup incomplete</span>'}${st.version ? ` <span class="muted">mod v${esc(st.version)}</span>` : ''}${S && S.available && S.pending ? ` <span class="badge warn">${S.pending} command(s) waiting for the server</span>` : ''}`;
  const box = $('fxBody');
  // a background refresh leaves the page alone while someone types in it or has unsaved settings
  if (!force && box.dataset.tab === fx.tab && (box.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || box.dataset.dirty)) return;
  box.dataset.tab = fx.tab;
  if (fx.tab === 'setup') return fxSetup(box);
  if (!S || !S.available) { box.innerHTML = `<div class="card"><p class="muted">${esc((S && S.reason) || 'Loading…')}</p></div>`; return; }
  ({ factions: fxFactions, wars: fxWars, players: fxPlayers, settings: fxSettings, admins: fxAdmins, tiers: fxTiers })[fx.tab](box);
  const last = S.result.messages.slice(-4).reverse();
  if (last.length && fx.tab !== 'settings') box.insertAdjacentHTML('beforeend', `<div class="card mt"><div class="card-title">Last applied by the server</div><div class="muted small mono">${last.map(esc).join('<br>')}</div></div>`);
}

// ----- setup -----
function fxSetup(box) {
  const st = fx.setup; if (!st) { box.innerHTML = '<p class="muted">Loading…</p>'; return; }
  box.innerHTML = `<div class="card">
    <div class="card-title">Install DRP Core (DRP Factions and the other DRP sub-mods) on this server</div>
    <div class="fx-steps">${st.steps.map(s => `<div class="fx-step"><span class="badge ${s.ok ? 'ok' : 'warn'}">${s.ok ? '✓' : '!'}</span><div><b>${esc(s.label)}</b><div class="muted small">${esc(s.detail)}</div></div></div>`).join('')}</div>
    <label class="field mt">Build folder (the @DRP_Core folder: addons\\ with DRP_Factions.pbo and the other sub-mods, keys\\)
      <div class="row gap"><input id="fxSource" class="input grow" value="${esc(st.source || st.sourceCandidates[0] || '')}"><button class="btn" id="fxPick">Choose…</button></div></label>
    <label class="field">In-game faction admins to add (Steam64, comma separated, optional) <input id="fxAdminsNew" class="input" placeholder="7656119…"></label>
    <div class="row gap"><button class="btn primary" id="fxInstall" ${st.serverRunning ? 'disabled' : ''}>${st.installed ? 'Update DRP Core' : 'Install DRP Core'}</button>
      <span class="muted small">${st.serverRunning ? 'Stop the server first: it keeps the mod files open while it runs.' : 'Copies @DRP_Core into the server folder, installs its key, adds it to the mod list (-mod: players need it too), takes separate copies of its sub-mods off the list and rewrites the launch files.'}</span></div>
  </div>
  <div class="card mt"><div class="card-title">What the mod does and where it is run from</div>
    <p class="muted small">Players found factions, claim grid cells with base unit tables (home instantly, outposts after a wait), fight wars over neighbouring cells, and get loot from the zones they hold, delivered to their supply cache.</p>
    <p class="muted small">Here: <b>Factions</b> (points, names, colours, members, claims, cells, caches), <b>Wars</b> (start, end, cancel, fix the score), <b>Players</b> (spawn cooldowns), <b>Settings</b> and <b>Admins</b>. Loot zones are set up on the <a href="#" id="fxToMap">Map, Loot zones layer</a>. The mod keeps its data in ${esc(st.profilesDir)}.</p>
  </div>`;
  $('fxPick').onclick = async () => { const f = await ipc.invoke('dialog:pickFolder', $('fxSource').value); if (f) $('fxSource').value = f; };
  $('fxInstall').onclick = (e) => run(async () => { fx.setup = await ipc.invoke('drpf:install', { source: $('fxSource').value.trim(), admins: $('fxAdminsNew').value.split(/[\s,;]+/).filter(Boolean) }); toast('DRP Core installed: start the server to load it'); await fxLoad(); }, e.target);
  $('fxToMap').onclick = (e) => { e.preventDefault(); fxOpenMap(); };
}
function fxOpenMap() { $('lyrZones').checked = true; showPage('map'); toast('Right-click the map to add a loot zone; right-click a zone to edit it'); }

// ----- factions -----
function fxFactions(box) {
  const S = fx.state; const q = fx.q.toLowerCase();
  const list = S.factions.filter(f => !q || f.name.toLowerCase().includes(q) || f.tag.toLowerCase().includes(q) || f.members.some(m => m.name.toLowerCase().includes(q) || m.id.includes(q)));
  if (!S.factions.some(f => f.id === fx.sel)) fx.sel = S.factions.length ? S.factions[0].id : null;
  const f = S.factions.find(x => x.id === fx.sel);
  box.innerHTML = `<div class="fx-split">
    <div class="card fx-list"><input id="fxQ" class="input" placeholder="Search factions, members, Steam64…" value="${esc(fx.q)}">
      <div class="ip-list">${list.map(x => `<div class="ip-item ${x.id === fx.sel ? 'on' : ''}" data-fid="${x.id}"><span><span class="veh-swatch" style="background:${x.color}"></span>[${esc(x.tag)}] ${esc(x.name)}</span><span class="muted">${x.members.length} · ${x.claims.length + x.captured.length} cells · ${x.points} pts</span></div>`).join('') || '<div class="muted" style="padding:6px">No factions yet.</div>'}</div></div>
    <div class="fx-detail">${f ? fxFactionDetail(f) : '<div class="card"><p class="muted">Pick a faction.</p></div>'}</div></div>`;
  $('fxQ').oninput = () => { fx.q = $('fxQ').value; const pos = $('fxQ').selectionStart; fxRender(true); $('fxQ').focus(); $('fxQ').setSelectionRange(pos, pos); };
  box.querySelector('.fx-list .ip-list').onclick = (e) => { const it = e.target.closest('[data-fid]'); if (it) { fx.sel = Number(it.dataset.fid); fxRender(true); } };
  if (f) fxFactionWire(box, f);
}
function fxFactionDetail(f) {
  const cellOf = (c) => fxCell(c.cellX);
  return `<div class="card"><div class="row gap wrap"><span class="veh-swatch big" style="background:${f.color}"></span><div class="grow"><div class="card-title" style="margin:0">[${esc(f.tag)}] ${esc(f.name)}${f.solo ? ' <span class="badge">solo</span>' : ''}</div><div class="muted small">#${f.id} · led by ${esc(f.founderName)} (${esc(f.founderId)}) · founded ${fxTime(f.createdAt)} · ${f.points} points${f.zones.length ? ' · holds ' + f.zones.map(esc).join(', ') : ''}</div>${f.description ? `<div class="small">${esc(f.description)}</div>` : ''}</div>
      <button class="btn small" data-a="points">Set points…</button><button class="btn small" data-a="rename">Rename…</button><button class="btn small" data-a="color">Colour…</button><button class="btn small" data-a="logo">Logo${f.logo ? ': ' + esc(f.logo) : '…'}</button><button class="btn small danger" data-a="delete">Delete…</button></div></div>
  <div class="card mt"><div class="card-title">Members (${f.members.length})</div><table class="table"><thead><tr><th>Name</th><th>Steam64</th><th>Role</th><th>Joined</th><th></th></tr></thead><tbody>${f.members.map(m => `<tr><td>${esc(m.name)}${m.leader ? ' <span class="badge ok">leader</span>' : ''}</td><td class="mono small">${esc(m.id)}</td><td>${esc(m.role)}</td><td class="muted small">${fxTime(m.joinedAt)}</td><td class="right-align">${m.leader ? '' : `<button class="btn small" data-a="lead" data-id="${esc(m.id)}">Make leader</button> <button class="btn small danger" data-a="kick" data-id="${esc(m.id)}">Remove</button>`}</td></tr>`).join('')}</tbody></table></div>
  <div class="card mt"><div class="card-title">Territory</div><table class="table"><thead><tr><th>Cell</th><th>What</th><th>State</th><th>Position</th><th></th></tr></thead><tbody>
    ${f.claims.map(c => `<tr><td><b>${cellOf(c)}</b></td><td>${c.kind === 'home' ? 'Home' : 'Outpost'} #${c.id}</td><td>${c.pending ? '<span class="badge warn">being secured</span>' : c.powered ? `<span class="badge ok">radio online</span> <span class="muted small">${Math.round((c.powerLeft || 0) / 3600)} h of power</span>` : '<span class="badge bad">radio offline</span>'}</td><td class="mono small">${Math.round(c.x)}, ${Math.round(c.z)}</td><td class="right-align"><button class="btn small danger" data-a="unclaim" data-id="${c.id}">Remove claim</button></td></tr>`).join('')}
    ${f.captured.map(c => `<tr><td><b>${cellOf(c)}</b></td><td>Captured cell</td><td class="muted small">since ${fxTime(c.at)}</td><td></td><td class="right-align"><button class="btn small danger" data-a="uncell" data-x="${c.cellX}" data-z="${c.cellZ}">Take away</button></td></tr>`).join('')}
    ${!f.claims.length && !f.captured.length ? '<tr><td colspan="5" class="muted">No territory.</td></tr>' : ''}</tbody></table>
    <div class="row gap mt"><button class="btn small" data-a="grant">Give a sector…</button><span class="muted small">Supply cache: ${f.cache ? `at ${Math.round(f.cache.x)}, ${Math.round(f.cache.z)} (${esc(fxCell(sectorAt(f.cache.x, f.cache.z)))})` : 'none placed'}</span>${f.cache ? '<button class="btn small" data-a="cache">Forget the cache</button>' : ''}<span class="grow"></span><button class="btn small" data-a="map">Show on the map</button></div></div>
  <div class="card mt"><div class="card-title">Kits (${f.kits.length}) and roles (${f.roles.length})</div><div class="muted small">${f.kits.map(k => `${esc(k.name)} (${k.items} items, ${k.cost} pts)`).join(' · ') || 'No kits'}</div><div class="muted small">${f.roles.map(r => esc(r.name)).join(' · ')}</div></div>`;
}
function fxFactionWire(box, f) {
  const name = `[${f.tag}] ${f.name}`;
  box.querySelector('.fx-detail').onclick = (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return; const a = b.dataset.a;
    if (a === 'points') fxAct(`Set the points of ${name}`, `<label class="field">Points <input id="fxN" class="input short" type="number" min="0" value="${f.points}"></label>`, 'Set', { op: 'set_points', factionId: f.id, get points() { return $('fxN').value; } }, 'Points set');
    if (a === 'rename') withReason(`Rename ${name}`, `<label class="field">Name <input id="fxName" class="input" value="${esc(f.name)}"></label><label class="field">Tag <input id="fxTag" class="input short" value="${esc(f.tag)}"></label>`, 'Rename', (why) => fxCmd({ op: 'rename', factionId: f.id, name: $('fxName').value, tag: $('fxTag').value, reason: why }, 'Rename sent'));
    if (a === 'logo') fxLogoDialog(f);
    if (a === 'color') withReason(`Map colour of ${name}`, `<label class="field">Colour <input id="fxColor" type="color" value="${f.color}"></label>`, 'Set', (why) => fxCmd({ op: 'set_color', factionId: f.id, color: $('fxColor').value, reason: why }, 'Colour set'));
    if (a === 'delete') fxAct(`Delete ${name}?`, '<p>The faction, its claims and kits are removed and its open wars end. Members become factionless. This cannot be undone.</p>', 'Delete', { op: 'delete_faction', factionId: f.id }, 'Delete sent');
    if (a === 'lead') { const m = f.members.find(x => x.id === b.dataset.id); fxAct(`Make ${m.name} the leader of ${name}`, '<p>The old leader stays a member.</p>', 'Make leader', { op: 'transfer_owner', factionId: f.id, targetId: m.id }, 'Leader change sent'); }
    if (a === 'kick') { const m = f.members.find(x => x.id === b.dataset.id); fxAct(`Remove ${m.name} from ${name}?`, '', 'Remove', { op: 'kick_member', factionId: f.id, targetId: m.id }, 'Removal sent'); }
    if (a === 'unclaim') fxAct(`Remove claim #${b.dataset.id} of ${name}?`, '<p>The cell is no longer theirs; the table stays in the world.</p>', 'Remove', { op: 'remove_claim', factionId: f.id, claimId: Number(b.dataset.id) }, 'Claim removal sent');
    if (a === 'uncell') fxAct(`Take ${fxCell(Number(b.dataset.x))} from ${name}?`, '', 'Take away', { op: 'remove_cell', factionId: f.id, cellX: Number(b.dataset.x), cellZ: 0 }, 'Sent');
    if (a === 'grant') withReason(`Give ${name} a sector`, `<label class="field">Sector <input id="fxCellIn" class="input" list="fxSectorList" placeholder="e.g. Chernogorsk north"></label><datalist id="fxSectorList">${(sec.map ? sec.map.sectors : []).map(x => `<option value="${esc(x.name)}">`).join('')}</datalist><p class="muted small">It is theirs as a captured sector: it pays out its loot tier and borders for wars. A sector another faction holds is refused. You can also right-click a sector on the Map page.</p>`, 'Give', (why) => { const id = fxParseCell($('fxCellIn').value); if (!id) return toast('No sector by that name', true); fxCmd({ op: 'grant_cell', factionId: f.id, cellX: id, cellZ: 0, reason: why }, 'Sector given'); });
    if (a === 'cache') fxAct(`Forget the supply cache of ${name}?`, '<p>For a cache that is gone: they can place a new one. The box itself is not touched.</p>', 'Forget', { op: 'clear_cache', factionId: f.id }, 'Sent');
    if (a === 'map') { const c = f.claims[0] || null; fxOpenMap(); if (c) setTimeout(() => centreOn({ x: c.x, z: c.z }), 600); }
  };
}

// ----- wars -----
function fxWars(box) {
  const S = fx.state;
  box.innerHTML = `<div class="card"><table class="table"><thead><tr><th>#</th><th>Cell</th><th>Attacker</th><th>Defender</th><th>State</th><th>Score (kills)</th><th>When</th><th></th></tr></thead><tbody>${S.wars.map(w => {
    const open = w.state !== 'ended';
    const when = w.state === 'declared' ? `starts by itself ${fxIn(w.scheduleDeadline)}` : w.state === 'scheduled' ? `starts ${fxIn(w.startAt)}` : w.state === 'active' ? `ends ${fxIn(w.endAt)}` : `ended ${fxTime(w.endedAt)}`;
    const won = w.state === 'ended' ? (w.winnerId === w.attacker.id ? ` · ${esc(w.attacker.tag)} won` : w.winnerId === w.defender.id ? ` · ${esc(w.defender.tag)} held` : ' · cancelled') : '';
    return `<tr><td>${w.id}</td><td><b>${esc(fxCell(w.cellX))}</b></td><td>[${esc(w.attacker.tag)}] ${esc(w.attacker.name)}</td><td>[${esc(w.defender.tag)}] ${esc(w.defender.name)}</td><td><span class="badge ${w.state === 'active' ? 'bad' : open ? 'warn' : ''}">${w.state}</span>${won}</td><td>${w.attackerScore} : ${w.defenderScore} <span class="muted small">(${w.attackerKills} / ${w.defenderKills})</span></td><td class="muted small">${when}</td>
      <td class="right-align">${open && w.state !== 'active' ? `<button class="btn small" data-a="start" data-id="${w.id}">Start now</button> ` : ''}${open ? `<button class="btn small" data-a="end" data-id="${w.id}">End now</button> <button class="btn small danger" data-a="cancel" data-id="${w.id}">Cancel</button> ` : ''}<button class="btn small" data-a="score" data-id="${w.id}">Score…</button></td></tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">No wars yet. Factions declare them in game on a neighbouring cell.</td></tr>'}</tbody></table>
  <p class="muted small">End now decides it by the score as it stands (a tie keeps the cell with the defender); Cancel ends it with no winner and nothing changes hands.</p></div>`;
  box.querySelector('table').onclick = (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return; const w = S.wars.find(x => x.id === Number(b.dataset.id)); const t = `war #${w.id} over ${fxCell(w.cellX)}`;
    if (b.dataset.a === 'start') fxAct(`Start ${t} now?`, '', 'Start', { op: 'war_start', warId: w.id }, 'Start sent');
    if (b.dataset.a === 'end') fxAct(`End ${t} now?`, `<p>${w.attackerScore > w.defenderScore ? `[${esc(w.attacker.tag)}] takes the cell` : `[${esc(w.defender.tag)}] keeps the cell`} at ${w.attackerScore} : ${w.defenderScore}.</p>`, 'End', { op: 'war_end', warId: w.id }, 'End sent');
    if (b.dataset.a === 'cancel') fxAct(`Cancel ${t}?`, '<p>No winner; nothing changes hands.</p>', 'Cancel war', { op: 'war_cancel', warId: w.id }, 'Cancel sent');
    if (b.dataset.a === 'score') withReason(`Score of ${t}`, `<div class="row gap"><label class="field">[${esc(w.attacker.tag)}] attacker <input id="fxSa" class="input short" type="number" min="0" value="${w.attackerScore}"></label><label class="field">[${esc(w.defender.tag)}] defender <input id="fxSd" class="input short" type="number" min="0" value="${w.defenderScore}"></label></div>`, 'Set', (why) => fxCmd({ op: 'war_score', warId: w.id, attackerScore: $('fxSa').value, defenderScore: $('fxSd').value, reason: why }, 'Score sent'));
  };
}

// ----- players -----
function fxPlayers(box) {
  const S = fx.state; const fname = (id) => { const f = S.factions.find(x => x.id === id); return f ? `[${esc(f.tag)}] ${esc(f.name)}` : '<span class="muted">none</span>'; };
  box.innerHTML = `<div class="card"><table class="table"><thead><tr><th>Name</th><th>Steam64</th><th>Faction</th><th>Last seen</th><th>Spawn cooldowns</th><th></th></tr></thead><tbody>${S.players.map(p => `<tr><td>${esc(p.name)}</td><td class="mono small">${esc(p.id)}</td><td>${fname(p.factionId)}</td><td class="muted small">${fxTime(p.lastSeen)}</td><td>${p.cooldowns || '<span class="muted">none</span>'}</td><td class="right-align">${p.cooldowns ? `<button class="btn small" data-id="${esc(p.id)}">Reset cooldowns</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No players yet.</td></tr>'}</tbody></table></div>`;
  box.querySelector('table').onclick = (e) => { const b = e.target.closest('button[data-id]'); if (!b) return; const p = S.players.find(x => x.id === b.dataset.id); fxAct(`Reset the spawn cooldowns of ${p.name}?`, '<p>They can spawn at every faction spawn point again right away.</p>', 'Reset', { op: 'reset_cooldowns', targetId: p.id }, 'Reset sent'); };
}

// ----- settings -----
function fxSettings(box) {
  const S = fx.state; const cfg = S.settings; const sch = fx.schema || { settings: [], lists: [] };
  const groups = [...new Set(sch.settings.map(s => s[4]))];
  const field = ([key, label, min, max, , hint]) => min === null
    ? `<label class="check" title="${esc(hint || '')}"><input type="checkbox" data-k="${key}" ${cfg[key] ? 'checked' : ''}> ${esc(label)}</label>`
    : `<label class="field" title="${esc(hint || '')}">${esc(label)}${hint ? ` <span class="muted small">${esc(hint)}</span>` : ''}<input class="input" type="number" data-k="${key}" min="${min}" max="${max}" step="any" value="${cfg[key] ?? ''}"></label>`;
  box.innerHTML = `<div class="fx-settings">${groups.map(g => `<div class="card"><div class="card-title">${esc(g)}</div>${sch.settings.filter(s => s[4] === g).map(field).join('')}</div>`).join('')}
    <div class="card"><div class="card-title">Kits and deposit crate</div>${sch.lists.map(([k, l]) => `<label class="field">${esc(l)} <span class="muted small">one per line</span><textarea class="input mono" rows="4" data-list="${k}">${esc((cfg[k] || []).join('\n'))}</textarea></label>`).join('')}
      <label class="field">Points per deposited item <span class="muted small">"class or slot:Name = points", one per line</span><textarea class="input mono" rows="6" id="fxPv">${esc((cfg.pointValues || []).map(p => `${p.match} = ${p.points}`).join('\n'))}</textarea></label></div></div>
    <div class="row gap mt"><button class="btn primary" id="fxSave">Save and reload</button><span class="muted small">Written to settings.json (the old one is kept as settings.json.bak) and reloaded by the server within seconds. A new cell size needs a restart.</span></div>`;
  box.oninput = () => { box.dataset.dirty = '1'; };
  $('fxSave').onclick = (e) => run(async () => {
    const ch = {};
    box.querySelectorAll('[data-k]').forEach(i => { ch[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; });
    box.querySelectorAll('[data-list]').forEach(t => { ch[t.dataset.list] = t.value.split(/\r?\n/); });
    ch.pointValues = $('fxPv').value.split(/\r?\n/).map(l => l.split('=')).filter(x => x.length === 2).map(([m, p]) => ({ match: m.trim(), points: p.trim() }));
    const r = await ipc.invoke('drpf:saveSettings', ch);
    delete box.dataset.dirty;
    toast(r.changed.length ? `Saved ${r.changed.length} change(s)${r.restartNeeded ? '. Restart the server for the new cell size.' : ', reloading on the server'}` : 'Nothing changed');
    await fxLoad();
  }, e.target);
}

// ----- admins -----
function fxAdmins(box) {
  const S = fx.state;
  box.innerHTML = `<div class="card"><div class="card-title">In-game faction admins</div><p class="muted small">They get the Admin and Loot zones tabs in the faction menu in game. Everything there can also be done here.</p>
    <table class="table"><tbody>${S.admins.map(a => `<tr><td>${esc(a.name || '(not seen yet)')}</td><td class="mono small">${esc(a.id)}</td><td class="right-align"><button class="btn small danger" data-id="${esc(a.id)}">Remove</button></td></tr>`).join('') || '<tr><td class="muted">Nobody yet.</td></tr>'}</tbody></table>
    <div class="row gap mt"><input id="fxAdminId" class="input" list="fxAdminPick" placeholder="Steam64, or pick a player"><datalist id="fxAdminPick">${S.players.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</datalist><button class="btn primary" id="fxAdminAdd">Add</button></div></div>`;
  const save = async (ids, msg) => { try { await ipc.invoke('drpf:saveAdmins', ids); toast(msg); await fxLoad(); } catch (e) { toast(e.message, true); } };
  $('fxAdminAdd').onclick = () => { const id = $('fxAdminId').value.trim(); if (id) save([...S.admins.map(a => a.id), id], 'Admin added; the server reloads its list within seconds'); };
  box.querySelector('table').onclick = (e) => { const b = e.target.closest('button[data-id]'); if (b) save(S.admins.map(a => a.id).filter(x => x !== b.dataset.id), 'Admin removed'); };
}

// ----- logos -----
function fxLogoDialog(f) {
  const S = fx.state; const logos = S.logos || [];
  const body = `<label class="field">Logo <select id="fxLogoPick" class="input"><option value="">No logo</option>${logos.map(l => `<option ${l === f.logo ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <p class="muted small">These are the logos packed in the mod on this server (${logos.length}). To add your own: Add logo… puts a PNG or JPG into the mod's logos folder${S.logoDir ? ` (${esc(S.logoDir)})` : ''}; building the mod turns it into a texture, and it shows up here once the server runs the new build.</p>` + reasonField();
  showModal(`Logo of [${f.tag}] ${f.name}`, body, [{ label: 'Set logo', value: 'set', primary: true }, { label: 'Add logo…', value: 'add' }, { label: 'Cancel', value: null }]).then(async v => {
    if (v === 'set') { if (reasonRequired && !reason()) return toast('Give a reason.', true); fxCmd({ op: 'set_logo', factionId: f.id, name: $('fxLogoPick').value, reason: reason() }, 'Logo sent'); }
    if (v === 'add') fxAddLogo();
  });
}
async function fxAddLogo() {
  const file = await ipc.invoke('dialog:pickFile', { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] }); if (!file) return;
  try { const r = await ipc.invoke('drpf:addLogo', { file }); toast(`Logo "${r.name}" added to the mod. Build DRP Core (Developer Tools) and update the server: then it can be picked.`); }
  catch (e) {
    if (!/No logo folder/.test(e.message)) return toast(e.message, true);
    const folder = await ipc.invoke('dialog:pickFolder', ''); if (!folder) return;
    try { await ipc.invoke('drpf:setLogoDir', folder); const r = await ipc.invoke('drpf:addLogo', { file }); toast(`Logo "${r.name}" added. Build DRP Core and update the server to use it.`); } catch (e2) { toast(e2.message, true); }
  }
}

// ----- loot: tiers and zone classes; painting is on the Map page -----
const fxT = { data: null, usages: null, dirty: false, cls: 'civilian', tier: 1 };
async function fxTiers(box) {
  if (!fxT.data || !fxT.dirty) try { fxT.data = await ipc.invoke('drpf:lootTiers'); } catch (e) { box.innerHTML = `<div class="card"><p class="muted">${esc(e.message)}</p></div>`; return; }
  if (!fxT.usages) try { fxT.usages = await ipc.invoke('drpf:usages'); } catch { fxT.usages = []; }
  if (box.dataset.tab !== 'tiers') return;
  const T = fxT.data;
  if (!T.classes.some(c => c.id === fxT.cls)) fxT.cls = T.classes[0].id;
  const pool = T.pools.find(p => p.cls === fxT.cls && p.tier === fxT.tier) || { cls: fxT.cls, tier: fxT.tier, items: [] };
  const painted = (fn) => T.sectors.filter(fn).length;
  const emptyPools = T.classes.length * 4 - T.pools.filter(p => p.items.length).length;
  box.innerHTML = `<div class="card"><div class="row gap wrap"><label class="check"><input type="checkbox" id="fxtOn" ${T.enabled ? 'checked' : ''}> Territory loot pays out</label>
      <label class="field inline">Every <input id="fxtEvery" class="input short" type="number" min="1" value="${T.intervalMinutes}"> minutes</label>
      <button class="btn small" id="fxtPaint">Paint tiers and zone classes on the map…</button><span class="grow"></span>
      <button class="btn small" id="fxtBuild" title="Every zone class x tier pool again from types.xml (hand edits to pools are replaced)">Rebuild all pools from types.xml</button><button class="btn primary" id="fxtSave">Save and reload</button></div>
    <p class="muted small">A sector's <b>tier</b> sets how many rolls it gives and the TierN items it can give; its <b>zone class</b> sets which types.xml usages they come from (bases and airfields count as military until painted otherwise, everything else as civilian). Every cycle the faction holding a painted sector gets its tier's rolls: each lands with the tier's chance and picks an item by weight from the pool for that class and tier.${emptyPools ? ` <b>${emptyPools} pool(s) are empty</b>: use Rebuild all pools.` : ''}</p></div>
  <div class="fx-tiers">
    <div class="card"><div class="card-title">Tiers</div><table class="table"><thead><tr><th>Tier</th><th>Rolls</th><th>Chance %</th><th>Painted</th></tr></thead><tbody>${T.tiers.map(t => `<tr data-tier="${t.tier}"><td><span class="veh-swatch" style="background:${TIER_COLORS[t.tier]}"></span>Tier ${t.tier}</td><td><input class="input short fxt-rolls" type="number" min="0" max="50" value="${t.rolls}"></td><td><input class="input short fxt-chance" type="number" min="0" max="100" value="${t.chance}"></td><td class="muted">${painted(x => x.tier === t.tier)} sector(s)</td></tr>`).join('')}</tbody></table></div>
    <div class="card"><div class="card-title">Zone classes <span class="muted small">which types.xml usages each one draws from</span></div>${T.classes.map((c, k) => `<div class="fxt-class" data-k="${k}"><div class="row gap"><span class="veh-swatch" style="background:${classColor(c.id)}"></span><input class="input fxt-cname" value="${esc(c.name)}" style="width:140px"><span class="muted small">${painted(x => x.cls === c.id)} painted</span>${T.classes.length > 1 ? '<button class="btn small danger fxt-cdel">✕</button>' : ''}</div>
      <div class="row gap wrap fxt-uses">${fxT.usages.map(u => `<label class="check small"><input type="checkbox" value="${esc(u)}" ${c.usages.some(x => x.toLowerCase() === u.toLowerCase()) ? 'checked' : ''}> ${esc(u)}</label>`).join('')}</div></div>`).join('')}
      <div class="row gap mt"><input id="fxtNewClass" class="input" placeholder="New class, e.g. Medical" style="width:200px"><button class="btn small" id="fxtAddClass">Add class</button></div></div>
  </div>
  <div class="card mt"><div class="row gap wrap"><b>Pool</b><select id="fxtPoolCls" class="input" style="width:150px">${T.classes.map(c => `<option value="${esc(c.id)}" ${c.id === fxT.cls ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="fxtPoolTier" class="input" style="width:110px">${[1, 2, 3, 4].map(t => `<option value="${t}" ${t === fxT.tier ? 'selected' : ''}>Tier ${t}</option>`).join('')}</select>
      <span class="muted small">${pool.items.length} item(s)</span><span class="grow"></span><input id="fxtAdd" class="input" placeholder="Add a class, Enter" list="fxtItems" style="width:220px"><button class="btn small" id="fxtClear">Clear this pool</button></div>
    <div class="table-wrap fxt-wrap"><table class="table"><thead><tr><th>Item</th><th>Weight</th><th>Min</th><th>Max</th><th></th></tr></thead><tbody>${pool.items.slice(0, 400).map((i, k) => `<tr data-k="${k}"><td class="mono small">${esc(i.className)}</td><td><input class="input short fxt-w" type="number" min="1" value="${i.weight}"></td><td><input class="input short fxt-min" type="number" min="1" value="${i.min}"></td><td><input class="input short fxt-max" type="number" min="1" value="${i.max}"></td><td><button class="btn small danger fxt-del">✕</button></td></tr>`).join('')}${pool.items.length > 400 ? `<tr><td colspan="5" class="muted">${pool.items.length - 400} more not shown</td></tr>` : ''}${!pool.items.length ? '<tr><td colspan="5" class="muted">Empty: Rebuild all pools fills it from types.xml, or add items.</td></tr>' : ''}</tbody></table></div></div>
  <datalist id="fxtItems">${(typeof lootItems !== 'undefined' && lootItems ? lootItems : []).map(i => `<option value="${esc(i.name)}">`).join('')}</datalist>`;
  if (typeof loadLootItems === 'function' && !lootItems) loadLootItems();
  const curPool = () => { let p = T.pools.find(x => x.cls === fxT.cls && x.tier === fxT.tier); if (!p) { p = { cls: fxT.cls, tier: fxT.tier, items: [] }; T.pools.push(p); } return p; };
  const readBack = () => {
    T.enabled = $('fxtOn').checked ? 1 : 0; T.intervalMinutes = Number($('fxtEvery').value);
    for (const tr of box.querySelectorAll('tr[data-tier]')) { const t = T.tiers.find(x => x.tier === Number(tr.dataset.tier)); t.rolls = Number(tr.querySelector('.fxt-rolls').value); t.chance = Number(tr.querySelector('.fxt-chance').value); }
    for (const row of box.querySelectorAll('.fxt-class')) { const c = T.classes[Number(row.dataset.k)]; c.name = row.querySelector('.fxt-cname').value.trim() || c.id; c.usages = [...row.querySelectorAll('.fxt-uses input:checked')].map(i => i.value); }
    const p = curPool(); for (const tr of box.querySelectorAll('tr[data-k]')) { const it = p.items[Number(tr.dataset.k)]; if (!it) continue; it.weight = Number(tr.querySelector('.fxt-w').value); it.min = Number(tr.querySelector('.fxt-min').value); it.max = Number(tr.querySelector('.fxt-max').value); }
  };
  const redraw = () => { fxT.dirty = true; box.dataset.dirty = '1'; fxTiers(box); };
  box.oninput = () => { fxT.dirty = true; box.dataset.dirty = '1'; };
  box.onchange = (e) => { if (e.target.id === 'fxtPoolCls' || e.target.id === 'fxtPoolTier') { readBack(); fxT.cls = $('fxtPoolCls').value; fxT.tier = Number($('fxtPoolTier').value); redraw(); } };
  box.onclick = (e) => {
    if (e.target.classList.contains('fxt-del')) { readBack(); curPool().items.splice(Number(e.target.closest('tr').dataset.k), 1); redraw(); }
    if (e.target.classList.contains('fxt-cdel')) { readBack(); const k = Number(e.target.closest('.fxt-class').dataset.k); T.classes.splice(k, 1); redraw(); }
  };
  box.onkeydown = (e) => { if (e.target.id !== 'fxtAdd' || e.key !== 'Enter' || !e.target.value.trim()) return; readBack(); curPool().items.unshift({ className: e.target.value.trim(), weight: 10, min: 1, max: 1 }); redraw(); };
  $('fxtClear').onclick = () => { readBack(); curPool().items = []; redraw(); };
  $('fxtAddClass').onclick = () => { readBack(); const n = $('fxtNewClass').value.trim(); if (!n) return; const id = n.toLowerCase().replace(/[^a-z0-9_]+/g, '_'); if (T.classes.some(c => c.id === id)) return toast('That class exists', true); T.classes.push({ id, name: n, usages: [] }); redraw(); };
  $('fxtPaint').onclick = () => { $('lyrTiers').checked = true; $('lyrZones').checked = true; showPage('map'); toast('Under Loot tiers on the left: pick Tiers or Zone classes, then a brush, and click or drag over sectors'); };
  const save = async () => { readBack(); fxT.data = await ipc.invoke('drpf:saveLootTiers', { tiers: T.tiers, classes: T.classes, pools: T.pools, intervalMinutes: T.intervalMinutes, enabled: T.enabled }); fxT.dirty = false; delete box.dataset.dirty; if (typeof tiers !== 'undefined') tiers.data = null; };
  $('fxtSave').onclick = (e) => run(async () => { await save(); toast('Saved; the server reloads it within seconds'); fxTiers(box); }, e.target);
  $('fxtBuild').onclick = (e) => run(async () => {
    if (!await ask('Rebuild every pool from types.xml?', '<p>Each zone class x tier pool is made again from the economy: items with one of the class\'s usages and that tier (or no tier), weighted by nominal. Hand edits to pools are replaced.</p>', 'Rebuild')) return;
    await save(); fxT.data = await ipc.invoke('drpf:buildPools'); fxT.dirty = false; toast(`Pools rebuilt: ${fxT.data.pools.map(p => p.items.length).reduce((a, b) => a + b, 0)} entries in ${fxT.data.pools.length} pools`); fxTiers(box);
  }, e.target);
}

document.querySelectorAll('#page-factions .tab[data-ftab]').forEach(b => b.onclick = () => { fx.tab = b.dataset.ftab; delete $('fxBody').dataset.dirty; fxRender(true); });
$('fxToZones').onclick = fxOpenMap;
