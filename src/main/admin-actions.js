'use strict';
// One catalogue of the admin actions the map, the portal and the Discord bot can do: the label and embed colour for
// the admin action channel, the portal permission, the approval category, whether a reason is required and what the
// action targets. A new action is added here once; adminlog, portal and the UIs read it.
const ACTIONS = {
  heal: { label: '💚 Heal', perm: 'admin.heal', category: 'heal', reason: true, target: 'player' },
  tp: { label: '📍 Teleport', perm: 'admin.teleport', category: 'teleport', reason: true, target: 'player' },
  tpto: { label: '📍 Teleport to a player', perm: 'admin.teleport', category: 'teleport', reason: true, target: 'player' },
  bring: { label: '📍 Bring a player', perm: 'admin.teleport', category: 'teleport', reason: true, target: 'player' },
  tpdeath: { label: '📍 Teleport to their death', perm: 'admin.teleport', category: 'teleport', reason: true, target: 'player' },
  kill: { label: '☠️ Kill', perm: 'admin.kill', category: 'kill', reason: true, target: 'player', color: 0xff5f5f },
  god: { label: '🛡️ God mode', perm: 'admin.god', category: 'god', reason: true, target: 'player', color: 0xa970ff },
  give: { label: '🎁 Give item', perm: 'admin.spawn', category: 'spawn', reason: true, target: 'player', color: 0x3ddc84 },
  kit: { label: '🎒 Give kit', perm: 'admin.kits', category: 'kits', reason: true, target: 'player', color: 0x3ddc84 },
  vehicle: { label: '🚗 Spawn vehicle', perm: 'admin.vehicles', category: 'vehicles', reason: true, target: 'player', color: 0x3ddc84 },
  spawn: { label: '📦 Spawn at a point', perm: 'admin.spawn', category: 'spawn', reason: true, target: 'point', color: 0x3ddc84 },
  refund: { label: '↩️ Refund', perm: 'admin.refund', category: 'refund', reason: false, target: 'player', color: 0x4f8cff },
  message: { label: '💬 Message', perm: 'players.message', category: null, reason: false, target: 'player' },
  kick: { label: '👢 Kick', perm: 'players.kick', category: null, reason: true, target: 'player', color: 0xf5b942 },
  ban: { label: '⛔ Ban', perm: 'players.ban', category: null, reason: true, target: 'player', color: 0xff5f5f },
  // afflictions and punishments (bridge v6)
  afflict: { label: '🤢 Affliction', perm: 'admin.afflict', category: 'afflict', reason: true, target: 'player', color: 0xf5b942 },
  freeze: { label: '🧊 Freeze', perm: 'admin.afflict', category: 'afflict', reason: true, target: 'player', color: 0xf5b942 },
  invisible: { label: '👻 Invisible', perm: 'admin.afflict', category: 'afflict', reason: true, target: 'player' },
  strip: { label: '🎒 Strip gear', perm: 'admin.afflict', category: 'afflict', reason: true, target: 'player', color: 0xf5b942 },
  respawn: { label: '♻️ Respawn', perm: 'admin.kill', category: 'kill', reason: true, target: 'player', color: 0xff5f5f },
  // vehicles on the map (bridge v5)
  vrepair: { label: '🔧 Repair vehicle', perm: 'admin.vehicles', category: 'vehicles', reason: true, target: 'vehicle', color: 0x3ddc84 },
  vrefuel: { label: '⛽ Refuel vehicle', perm: 'admin.vehicles', category: 'vehicles', reason: true, target: 'vehicle', color: 0x3ddc84 },
  vbreak: { label: '🔩 Break vehicle', perm: 'admin.vehicles', category: 'vehicles', reason: true, target: 'vehicle', color: 0xf5b942 },
  vflip: { label: '🔄 Flip vehicle upright', perm: 'admin.vehicles', category: 'vehicles', reason: true, target: 'vehicle' },
  vtp: { label: '📍 Move vehicle', perm: 'admin.vehicles', category: 'vehicles', reason: true, target: 'vehicle' },
  vbring: { label: '📍 Bring vehicle to a player', perm: 'admin.vehicles', category: 'vehicles', reason: true, target: 'vehicle' },
  vdestroy: { label: '💥 Destroy vehicle', perm: 'admin.vehicles', category: 'vehicles', reason: true, target: 'vehicle', color: 0xff5f5f },
  vdelete: { label: '🗑️ Delete vehicle', perm: 'admin.vehicles', category: 'vehicles', reason: true, target: 'vehicle', color: 0xff5f5f },
  // only done in game through the DRP_Admin menu (they reach the audit through events.jsonl)
  adminmode: { label: '🛡️ Admin mode', perm: 'admin.menu', category: null, reason: false, target: 'none', color: 0x8a94a6 },
  weather: { label: '🌦️ Weather / time', perm: 'admin.weather', category: null, reason: false, target: 'none', color: 0x4f8cff },
  tpspot: { label: '📍 Teleport spot', perm: 'admin.teleport.manage', category: null, reason: false, target: 'none' },
  // list changes (no in-game command; done through the Lists page or the bot)
  beban: { label: '⛔ BattlEye ban', perm: 'lists.manage', category: null, reason: true, target: 'player', color: 0xff5f5f },
  unban: { label: '✅ Unban', perm: 'lists.manage', category: null, reason: false, target: 'player', color: 0x3ddc84 },
  whitelist: { label: '📋 Whitelist', perm: 'lists.manage', category: null, reason: false, target: 'player' },
  priority: { label: '⭐ Priority queue', perm: 'lists.manage', category: null, reason: false, target: 'player' },
  unlist: { label: '📋 Removed from a list', perm: 'lists.manage', category: null, reason: false, target: 'player' }
};
const pick = (field) => Object.fromEntries(Object.entries(ACTIONS).filter(([, a]) => a[field] !== undefined && a[field] !== null).map(([k, a]) => [k, a[field]]));
const LABEL = pick('label');
const COLOR = pick('color');
const PERM = pick('perm');
const CATEGORY = pick('category');
// list actions are checked by the lists code itself; the in-game and RCon ones here
const NEEDS_REASON = Object.keys(ACTIONS).filter(k => ACTIONS[k].reason && !['beban', 'unban', 'whitelist', 'priority', 'unlist'].includes(k));
const VEHICLE_ACTIONS = Object.keys(ACTIONS).filter(k => ACTIONS[k].target === 'vehicle');
// what an affliction command can carry; health, blood and bleed also take a number (health:25, blood:40, bleed:5)
const AFFLICTIONS = [
  ['bleed:3', 'Start bleeding (3 wounds)', 'Injuries'], ['legs', 'Break their legs', 'Injuries'], ['unconscious', 'Knock out', 'Injuries'], ['health:20', 'Health down to 20%', 'Injuries'], ['blood:40', 'Blood down to 40%', 'Injuries'],
  ['cold', 'Hypothermia', 'Needs'], ['hot', 'Hyperthermia', 'Needs'], ['starve', 'Starving', 'Needs'], ['dehydrate', 'Dehydrated', 'Needs'], ['wet', 'Soaked', 'Needs'],
  ['sick:cholera', 'Cholera', 'Sickness'], ['sick:influenza', 'Influenza', 'Sickness'], ['sick:salmonella', 'Salmonella', 'Sickness'], ['sick:brain', 'Brain disease', 'Sickness'], ['sick:food', 'Food poisoning', 'Sickness'], ['sick:chemical', 'Chemical poisoning', 'Sickness'], ['sick:wound', 'Wound infection', 'Sickness'], ['sick:heavymetal', 'Heavy metal poisoning', 'Sickness'], ['clearsick', 'Clear every sickness', 'Sickness']
];
const afflictionLabel = (what) => { const hit = AFFLICTIONS.find(a => a[0] === what); if (hit) return hit[1]; const m = String(what).match(/^(bleed|health|blood):(\d+)$/); return m ? (m[1] === 'bleed' ? `start bleeding (${m[2]} wounds)` : `${m[1]} down to ${m[2]}%`) : null; };
const BREAK_KINDS = [['tyres', 'Flat tyres'], ['fuel', 'Drain the fuel'], ['engine', 'Ruin the engine'], ['battery', 'Ruin the battery'], ['all', 'Everything']];

module.exports = { ACTIONS, LABEL, COLOR, PERM, CATEGORY, NEEDS_REASON, VEHICLE_ACTIONS, BREAK_KINDS, AFFLICTIONS, afflictionLabel };
