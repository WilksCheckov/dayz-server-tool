// Generates the DRP Admin layouts in the DRP Factions style (helpers, palette, fonts from gen-admin-helpers.js,
// the helper half of the faction generator) but laid out like LBmaster's Admin Tools: a toolbar along the top and
// free windows (title bar to drag, pin, close, resize grip). Window and content sizes are set by script, so the
// content layouts only need sensible starting rects; every widget the script moves uses exact pixel geometry.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./gen-admin-helpers.js');
const { panel, text, heading, label, multiText, multiEdit, button, edit, list, BAR, CARD, BTN_ACCENT, LINE, GOLD, MUTED, FIELD } = H;
// Our own value bar (the game's SliderWidget drew an empty outline): a dark track the script reads clicks and drags
// on, with a red fill sized by script; the fill ignores the mouse so the track gets every click.
const bar = (id, x, y, w, h) => ({ cls: 'PanelWidgetClass', name: id, props: `position ${x} ${y}
 size ${w} ${h}
 hexactpos 1
 vexactpos 1
 hexactsize 1
 vexactsize 1
 color ${FIELD}
 style DayZDefaultPanel`, children: [
  { cls: 'PanelWidgetClass', name: id + '_fill', props: `ignorepointer 1
 position 0 0
 size 0 ${h}
 hexactpos 1
 vexactpos 1
 hexactsize 1
 vexactsize 1
 color 0.62 0.1 0.1 1
 style DayZDefaultPanel`, children: [] }] });

const OUT = 'P:\\DRP_Admin\\gui\\layouts';
const render = (n, depth = 0) => {
  const pad = ' '.repeat(depth);
  const props = n.props.split('\n').map(l => pad + ' ' + l.trim()).join('\n');
  let out = `${pad}${n.cls} ${n.name} {\n${props}\n`;
  if (n.children && n.children.length) { out += `${pad} {\n`; for (const c of n.children) out += render(c, depth + 2); out += `${pad} }\n`; }
  return out + `${pad}}\n`;
};
// a top-left anchored root with exact geometry (the script moves and sizes it)
function rootPanel(name, w, h, color, children, priority) {
  return { cls: 'PanelWidgetClass', name, props: `position 0 0\n size ${w} ${h}\n hexactpos 1\n vexactpos 1\n hexactsize 1\n vexactsize 1\n color ${color}\n style DayZDefaultPanel\n priority ${priority}`, children };
}
const write = (file, node) => { fs.writeFileSync(path.join(OUT, file), render(node)); console.log('wrote', file); };
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ toolbar (the admin menu itself)
// Full-screen, transparent frame; the toolbar is a bar along the top, stretched by script to the screen width.
const TB = 40;
const toolbarButtons = [['tb_players', 'Players', 110], ['tb_info', 'Player info', 120], ['tb_spawner', 'Item spawner', 130], ['tb_teleports', 'Teleports', 110], ['tb_map', 'Map', 70], ['tb_tickets', 'Tickets', 110], ['tb_env', 'Environment', 120], ['tb_server', 'Server info', 110], ['tb_self', 'Cheats', 90], ['tb_editor', 'Editor', 90]];
let tx = 170;
const tbChildren = [text('tb_title', 16, 0, 150, TB, 'DRP Admin', { bold: true, size: 18 })];
for (const [id, lbl, w] of toolbarButtons) { tbChildren.push(button(id, tx, 5, w, TB - 10, lbl, { size: 14 })); tx += w + 6; }
tbChildren.push(text('tb_mode', 0, 0, 220, TB, '', { align: 'right', color: GOLD, size: 15 }));
tbChildren.push(button('tb_modebtn', 0, 5, 130, TB - 10, 'Admin mode', { size: 14 }));
tbChildren.push(button('tb_reset', 0, 5, 130, TB - 10, 'Reset layout', { size: 14 }));
tbChildren.push(button('tb_close', 0, 5, 34, TB - 10, 'X', { color: BTN_ACCENT }));
write('drpa_toolbar.layout', {
  cls: 'FrameWidgetClass', name: 'drpa_toolbar',
  props: 'position 0 0\n size 1 1\n hexactpos 0\n vexactpos 0\n hexactsize 0\n vexactsize 0\n priority 1',
  children: [
    panel('tb_bar', 0, 0, 1920, TB, BAR, tbChildren),
    panel('tb_line', 0, TB, 1920, 2, LINE),
  ]
});

// ------------------------------------------------------------------ window chrome
const TITLE = 30;
write('drpa_window.layout', rootPanel('win', 520, 360, '0.07 0.07 0.07 0.97', [
  panel('win_titlebar', 0, 0, 520, TITLE, BAR, [
    text('win_title', 10, 0, 300, TITLE, 'Window', { bold: true, size: 15 }),
    button('win_pin', 520 - 70, 4, 30, TITLE - 8, 'P', { size: 13 }),
    button('win_close', 520 - 36, 4, 30, TITLE - 8, 'X', { color: BTN_ACCENT, size: 13 }),
  ]),
  panel('win_line', 0, TITLE, 520, 2, LINE),
  panel('win_body', 0, TITLE + 2, 520, 360 - TITLE - 2, CARD),
  panel('win_grip', 520 - 14, 360 - 14, 14, 14, '0.62 0.1 0.1 1'),
], 2)); // low layer: ItemPreviewWidget draws nothing at high priorities

// ------------------------------------------------------------------ window contents (children of win_body)
const content = (name, children) => ({ cls: 'FrameWidgetClass', name, props: 'position 0 0\n size 1 1\n hexactpos 1\n vexactpos 1\n hexactsize 0\n vexactsize 0', children });
write('drpa_players.layout', content('pl_root', [
  label('pl_l_search', 8, 6, 300, 'Search name or Steam id'),
  edit('pl_search', 8, 28, 300, 26),
  list('pl_list', 8, 62, 300, 200, 20),
  multiText('pl_sel', 320, 28, 180, 90, 'Pick a player in the list.', 13),
  button('pl_info', 320, 124, 180, 30, 'Player info', { color: BTN_ACCENT }),
  button('pl_tpto', 320, 160, 180, 30, 'Teleport to them'),
  button('pl_bring', 320, 196, 180, 30, 'Bring them to me'),
  button('pl_refresh', 320, 232, 180, 30, 'Refresh'),
  text('pl_count', 8, 270, 300, 20, '', { color: MUTED, size: 12 }),
]));
write('drpa_spawner.layout', content('sp_root', [
  list('sp_cats', 8, 8, 150, 400, 8),
  label('sp_l_search', 166, 6, 300, 'Search name or class'),
  edit('sp_search', 166, 28, 400, 26),
  list('sp_items', 166, 62, 400, 300, 20),
  text('sp_count', 166, 370, 400, 20, '', { color: MUTED, size: 12 }),
  // the item preview (an ItemPreviewWidget like the inventory's icons) filling its panel; drag it to turn the item
  panel('sp_preview_bg', 580, 8, 220, 170, '0.05 0.05 0.05 1', [
    { cls: 'ItemPreviewWidgetClass', name: 'sp_preview', props: 'position 0 0\n size 1 1\n hexactpos 1\n vexactpos 1\n hexactsize 0\n vexactsize 0', children: [] },
    text('sp_preview_none', 0, 0, 220, 170, '', { color: MUTED, size: 13, align: 'center' }),
  ]),
  multiText('sp_sel', 580, 8, 220, 64, 'Pick an item in the list.', 13),
  label('sp_l_amount', 580, 78, 90, 'Count'),
  edit('sp_amount', 676, 78, 124, 26),
  button('sp_cond', 580, 112, 220, 30, 'Condition: Pristine'),
  // liquid (a drop-down, only for liquid containers), how full (a bar), temperature (cycled like the condition)
  button('sp_liquid', 580, 148, 220, 30, 'Liquid: default', { align: 'left' }),
  text('sp_l_fill', 580, 186, 96, 22, 'Full 100%', { color: MUTED, size: 13 }),
  bar('sp_fill', 676, 186, 124, 24),
  button('sp_temp', 580, 218, 220, 30, 'Temperature: default'),
  // where to spawn, two by two
  button('sp_look', 580, 258, 107, 30, 'Where I look', { color: BTN_ACCENT, size: 13 }),
  button('sp_feet', 693, 258, 107, 30, 'At my feet', { size: 13 }),
  button('sp_self', 580, 294, 107, 30, 'My inventory', { size: 13 }),
  button('sp_target', 693, 294, 107, 30, 'Their inventory', { size: 13 }),
  // last, so it draws over the buttons below when open
  list('sp_liquid_list', 580, 180, 220, 300, 13),
]));
write('drpa_info.layout', content('in_root', [
  text('in_name', 8, 4, 400, 26, 'No player selected', { bold: true, size: 16 }),
  text('in_ids', 8, 30, 400, 20, '', { color: MUTED, size: 12 }),
  multiText('in_details', 8, 56, 300, 260, '', 14),
  // first column: one-off actions; second column: lasting effects (toggles), stats and sicknesses. Placed by script.
  button('in_tpto', 320, 56, 180, 30, 'Teleport to them'),
  button('in_bring', 320, 92, 180, 30, 'Bring them to me'),
  button('in_refresh', 320, 128, 180, 30, 'Refresh'),
  button('in_heal', 320, 164, 180, 30, 'Heal fully'),
  button('in_kill', 320, 200, 180, 30, 'Kill'),
  button('in_strip', 320, 236, 180, 30, 'Strip (drop gear)'),
  button('in_clear', 320, 272, 180, 30, 'Clear inventory'),
  edit('in_msg', 320, 316, 180, 28),
  button('in_msg_send', 320, 350, 180, 30, 'Send message'),
  button('in_kick', 320, 386, 180, 30, 'Kick (text = reason)'),
  button('in_moderate', 320, 422, 180, 30, 'Moderate...', { color: BTN_ACCENT }),
  button('in_fx_god', 510, 56, 180, 30, 'God mode'),
  button('in_fx_freeze', 510, 92, 180, 30, 'Freeze'),
  button('in_fx_invisible', 510, 128, 180, 30, 'Invisible'),
  button('in_fx_ammo', 510, 164, 180, 30, 'Unlimited ammo'),
  button('in_fx_stamina', 510, 200, 180, 30, 'Unlimited stamina'),
  button('in_fx_aiignore', 510, 236, 180, 30, 'AI ignores them'),
  // stat sliders under the details: label, slider (0..100 %, set by script), value
  ...['health', 'blood', 'shock', 'water', 'energy', 'wet'].flatMap((s, i) => [
    text(`in_sl_${s}_lbl`, 8, 330 + i * 30, 90, 26, { health: 'Health', blood: 'Blood', shock: 'Shock', water: 'Water', energy: 'Food', wet: 'Wetness' }[s], { size: 14 }),
    bar(`in_sl_${s}`, 100, 334 + i * 30, 160, 18),
    text(`in_sl_${s}_val`, 266, 330 + i * 30, 50, 26, '', { size: 14, align: 'right' }),
  ]),
  // third column: afflictions and repairs
  button('in_knockout', 700, 56, 180, 30, 'Knock out'),
  button('in_breaklegs', 700, 92, 180, 30, 'Break legs'),
  button('in_bleed', 700, 128, 180, 30, 'Make bleed'),
  button('in_stopbleed', 700, 164, 180, 30, 'Stop bleeding'),
  button('in_vomit', 700, 200, 180, 30, 'Vomit'),
  button('in_bloodyhands', 700, 236, 180, 30, 'Bloody hands'),
  button('in_dry', 700, 272, 180, 30, 'Dry off'),
  button('in_repairgear', 700, 308, 180, 30, 'Repair all gear'),
  button('in_repairhands', 700, 344, 180, 30, 'Repair item in hands'),
  button('in_sick', 510, 352, 180, 30, 'Sickness: Cholera'),
  button('in_sick_add', 510, 388, 87, 30, 'Give'),
  button('in_sick_clear', 603, 388, 87, 30, 'Cure all'),
]));

// ------------------------------------------------------------------ teleport manager
write('drpa_teleports.layout', content('tp_root', [
  label('tp_l_search', 8, 6, 300, 'Search places'),
  edit('tp_search', 8, 28, 300, 26),
  list('tp_list', 8, 62, 300, 300, 20),
  text('tp_count', 8, 370, 300, 20, '', { color: MUTED, size: 12 }),
  multiText('tp_sel', 320, 28, 200, 50, 'Pick a place in the list.', 13),
  button('tp_me', 320, 84, 200, 30, 'Teleport me', { color: BTN_ACCENT }),
  button('tp_player', 320, 120, 200, 30, 'Teleport selected player'),
  label('tp_l_name', 320, 164, 200, 'Save where I stand as'),
  edit('tp_name', 320, 186, 200, 26),
  button('tp_save_mine', 320, 220, 200, 30, 'Save for me'),
  button('tp_save_server', 320, 256, 200, 30, 'Save for every admin'),
  button('tp_delete', 320, 300, 200, 30, 'Delete selected spot'),
]));

// ------------------------------------------------------------------ map (live players and vehicles as map marks)
write('drpa_map.layout', content('mp_root', [
  { cls: 'MapWidgetClass', name: 'mp_map', props: 'visible 1\n clipchildren 1\n position 0 0\n size 600 400\n hexactpos 1\n vexactpos 1\n hexactsize 1\n vexactsize 1', children: [] },
  text('mp_info', 8, 404, 400, 28, '', { color: MUTED, size: 13 }),
  button('mp_vehicles', 420, 406, 120, 26, 'Vehicles', { size: 13 }),
  button('mp_center', 546, 406, 120, 26, 'Centre on me', { size: 13 }),
  // the layers panel on the right (placed by script)
  label('mp_l_layers', 680, 4, 200, 'Layers'),
  button('mp_range', 680, 28, 200, 28, 'Time: last 24 h', { size: 13 }),
  button('mp_deaths', 680, 62, 200, 28, 'Deaths', { size: 13 }),
  button('mp_heat', 680, 96, 200, 28, 'Heat: off', { size: 13 }),
  button('mp_vspawns', 680, 130, 200, 28, 'Vehicle spawns', { size: 13 }),
  button('mp_terr', 680, 164, 200, 28, 'Territories', { size: 13 }),
  button('mp_zones', 680, 198, 200, 28, 'Loot zones & caches', { size: 13 }),
  button('mp_tickets', 680, 232, 200, 28, 'Open tickets', { size: 13 }),
  button('mp_trail', 680, 266, 200, 28, 'Selected player\'s trail', { size: 13 }),
  label('mp_l_loot', 680, 304, 200, 'Where does an item spawn?'),
  edit('mp_loot', 680, 328, 200, 26),
  button('mp_loot_find', 680, 360, 97, 28, 'Find', { color: BTN_ACCENT, size: 13 }),
  button('mp_loot_clear', 783, 360, 97, 28, 'Clear', { size: 13 }),
  multiText('mp_layer_info', 680, 396, 200, 200, '', 12),
]));
// the canvas over the map (heat, territories, trails): its own top-level layout, since a canvas inside the window
// draws under the map; the script lays it over the map's rectangle every frame
fs.writeFileSync(path.join(OUT, 'drpa_mapcanvas.layout'), `FrameWidgetClass drpa_mapcanvas_root {
 ignorepointer 1
 clipchildren 1
 position 0 0
 size 100 100
 hexactpos 1
 vexactpos 1
 hexactsize 1
 vexactsize 1
 {
  CanvasWidgetClass mpc_canvas {
   ignorepointer 1
   position 0 0
   size 1 1
   hexactpos 1
   vexactpos 1
   hexactsize 0
   vexactsize 0
  }
 }
}`);
console.log('wrote drpa_mapcanvas.layout');

// ------------------------------------------------------------------ environment (weather and time)
const sliderRow = (id, label, y) => [
  text(`${id}_lbl`, 8, y, 90, 26, label, { size: 14 }),
  bar(id, 100, y + 4, 200, 18),
  text(`${id}_val`, 306, y, 60, 26, '', { size: 14, align: 'right' }),
];
write('drpa_env.layout', content('ev_root', [
  text('ev_now', 8, 4, 400, 24, '', { color: GOLD, size: 14 }),
  label('ev_l_weather', 8, 32, 200, 'Weather presets'),
  ...['clear', 'cloudy', 'rain', 'storm', 'fog'].map((id, i) => button(`ev_p_${id}`, 8 + i * 74, 54, 70, 28, id[0].toUpperCase() + id.slice(1), { size: 13 })),
  ...sliderRow('ev_overcast', 'Overcast', 92),
  ...sliderRow('ev_rain', 'Rain', 122),
  ...sliderRow('ev_fog', 'Fog', 152),
  ...sliderRow('ev_wind', 'Wind', 182),
  button('ev_apply', 8, 216, 360, 30, 'Apply weather', { color: BTN_ACCENT }),
  label('ev_l_time', 8, 262, 200, 'Time of day'),
  ...['dawn', 'noon', 'dusk', 'night'].map((id, i) => button(`ev_t_${id}`, 8 + i * 92, 284, 88, 28, id[0].toUpperCase() + id.slice(1), { size: 13 })),
  ...sliderRow('ev_hour', 'Hour', 322),
  ...sliderRow('ev_minute', 'Minute', 352),
  button('ev_settime', 8, 386, 360, 30, 'Set time', { color: BTN_ACCENT }),
]));

// ------------------------------------------------------------------ server info
write('drpa_server.layout', content('si_root', [
  multiText('si_text', 8, 8, 300, 220, 'Waiting for the server...', 15),
  button('si_refresh', 8, 236, 140, 30, 'Refresh'),
]));

// ------------------------------------------------------------------ staff: Tickets window
write('drpa_tickets.layout', content('tk_root', [
  button('tk_filter', 8, 8, 200, 28, 'Show: Open', { size: 13 }),
  button('tk_refresh', 214, 8, 96, 28, 'Refresh', { size: 13 }),
  list('tk_list', 8, 42, 302, 300, 20),
  multiText('tk_head', 320, 8, 400, 120, 'Pick a ticket in the list.', 13),
  multiText('tk_conv', 320, 132, 400, 200, '', 13),
  multiText('tk_ctx', 320, 336, 400, 60, '', 12),
  edit('tk_text', 320, 400, 284, 26),
  button('tk_send', 610, 400, 110, 28, 'Send reply', { color: BTN_ACCENT, size: 13 }),
  button('tk_reply', 730, 8, 180, 30, 'Reply to player', { color: BTN_ACCENT }),
  button('tk_note', 730, 44, 180, 30, 'Internal note'),
  button('tk_claim', 730, 80, 180, 30, 'Claim'),
  button('tk_close', 730, 116, 180, 30, 'Close ticket'),
  button('tk_select', 730, 160, 180, 30, 'Select player'),
  button('tk_tp', 730, 196, 180, 30, 'TP to report spot'),
  button('tk_tpdeath', 730, 232, 180, 30, 'TP to death spot'),
  button('tk_map', 730, 268, 180, 30, 'Show on map'),
  button('tk_refund', 730, 312, 180, 30, 'Refund the death'),
  button('tk_death', 730, 356, 180, 30, 'Death details'),
  button('tk_context', 730, 392, 180, 30, 'Context & admin log'),
]));

// ------------------------------------------------------------------ staff: Death and Ticket context (open from a ticket)
write('drpa_death.layout', content('dt_root', [
  multiText('dt_text', 8, 8, 340, 330, '', 13),
  label('dt_l_gear', 356, 4, 260, 'Gear at death'),
  list('dt_gear', 356, 28, 260, 310, 14),
  button('dt_tp', 8, 346, 196, 30, 'TP to death spot', { color: BTN_ACCENT }),
  button('dt_refund', 212, 346, 196, 30, 'Refund the death'),
  button('dt_map', 416, 346, 196, 30, 'Show on map'),
]));
// ------------------------------------------------------------------ staff: Editor (object sets), placed by script
write('drpa_editor.layout', content('ed_root', [
  label('ed_l_sets', 8, 4, 230, 'Object sets'),
  list('ed_sets', 8, 28, 230, 300, 12),
  edit('ed_newname', 8, 340, 230, 26),
  button('ed_new', 8, 372, 112, 30, 'New set', { size: 13 }),
  button('ed_toggle', 126, 372, 112, 30, 'Switch on', { size: 13 }),
  button('ed_export', 8, 408, 112, 30, 'Export', { size: 13 }),
  button('ed_delset', 126, 408, 112, 30, 'Delete set', { size: 13 }),
  label('ed_l_search', 246, 4, 400, 'Objects: search name or class (buildings, walls, props, items)'),
  edit('ed_search', 246, 28, 400, 26),
  list('ed_items', 246, 62, 400, 300, 16),
  text('ed_count', 246, 370, 400, 20, '', { color: MUTED, size: 12 }),
  button('ed_place', 246, 396, 400, 32, 'Place where I look', { color: BTN_ACCENT }),
  multiText('ed_sel', 660, 4, 250, 70, '', 12),
  button('ed_pick', 660, 80, 250, 28, 'Select what I aim at', { size: 13 }),
  button('ed_step', 660, 114, 250, 28, 'Step: 0.5 m / 5 deg', { size: 13 }),
  button('ed_xm', 660, 148, 122, 28, 'West -', { size: 13 }), button('ed_xp', 788, 148, 122, 28, 'East +', { size: 13 }),
  button('ed_zm', 660, 180, 122, 28, 'South -', { size: 13 }), button('ed_zp', 788, 180, 122, 28, 'North +', { size: 13 }),
  button('ed_ym', 660, 212, 122, 28, 'Down', { size: 13 }), button('ed_yp', 788, 212, 122, 28, 'Up', { size: 13 }),
  button('ed_rl', 660, 244, 122, 28, 'Turn left', { size: 13 }), button('ed_rr', 788, 244, 122, 28, 'Turn right', { size: 13 }),
  button('ed_pm', 660, 276, 122, 28, 'Pitch -', { size: 13 }), button('ed_pp', 788, 276, 122, 28, 'Pitch +', { size: 13 }),
  button('ed_tm', 660, 308, 122, 28, 'Roll -', { size: 13 }), button('ed_tp', 788, 308, 122, 28, 'Roll +', { size: 13 }),
  button('ed_ground', 660, 340, 122, 28, 'Snap to ground', { size: 13 }), button('ed_toaim', 788, 340, 122, 28, 'Move to aim', { size: 13 }),
  button('ed_dup', 660, 372, 122, 28, 'Duplicate', { size: 13 }), button('ed_del', 788, 372, 122, 28, 'Delete object', { color: BTN_ACCENT, size: 13 }),
]));

// ------------------------------------------------------------------ staff: Moderate (bans, lists, watchlist)
write('drpa_moderate.layout', content('mo_root', [
  multiText('mo_head', 8, 6, 440, 54, '', 13),
  label('mo_l_reason', 8, 64, 440, 'Reason (the player sees a ban reason)'),
  edit('mo_reason', 8, 86, 440, 26),
  label('mo_l_note', 8, 118, 440, 'Private note (staff only)'),
  edit('mo_note', 8, 140, 440, 26),
  button('mo_days', 8, 178, 216, 30, 'Ban: permanent', { size: 13 }),
  button('mo_ban', 232, 178, 216, 30, 'Ban', { color: BTN_ACCENT, size: 13 }),
  button('mo_conf', 8, 214, 216, 30, 'Confidence: Medium', { size: 13 }),
  button('mo_watch', 232, 214, 216, 30, 'Add to watchlist', { size: 13 }),
  button('mo_unwatch', 232, 250, 216, 30, 'Stop watching', { size: 13 }),
  button('mo_wl_add', 8, 292, 216, 30, 'Whitelist: add', { size: 13 }),
  button('mo_wl_del', 232, 292, 216, 30, 'Whitelist: remove', { size: 13 }),
  button('mo_pq_add', 8, 328, 216, 30, 'Priority queue: add', { size: 13 }),
  button('mo_pq_del', 232, 328, 216, 30, 'Priority queue: remove', { size: 13 }),
]));
write('drpa_ticketctx.layout', content('ct_root', [
  multiText('ct_text', 8, 8, 700, 150, '', 13),
  label('ct_l_adm', 8, 162, 700, 'Server admin log, two minutes either side of the ticket'),
  list('ct_adm', 8, 186, 700, 230, 12),
]));

// ------------------------------------------------------------------ players: Help & tickets (a menu of its own)
{
  const HW = 1000, HH = 640, HEAD = 48, LX = 16, LW = 300, RX = 332, RW = HW - RX - 16;
  // a drop-down: a button showing the choice and a list (hidden) laid over what is below it
  const dropdown = (id, x, y, w, rows) => [
    button(id, x, y, w, 30, '', { align: 'left', size: 14 }),
    list(`${id}_list`, x, y + 32, w, rows * 22 + 6, rows),
  ];
  const form = panel('hp_form', RX, HEAD + 16, RW, HH - HEAD - 32, '0 0 0 0', [
    heading('hp_f_title', 0, 0, RW, 'New ticket'),
    label('hp_l_name', 0, 34, 300, 'Ticket name'),
    edit('hp_title', 0, 56, RW, 28),
    label('hp_l_type', 0, 94, 300, 'Ticket type'),
    label('hp_l_urg', 330, 94, 300, 'Urgency'),
    label('hp_l_desc', 0, 168, 300, 'Description'),
    multiEdit('hp_desc', 0, 190, RW, 250),
    button('hp_send', 0, 452, 200, 34, 'Send ticket', { color: BTN_ACCENT }),
    multiText('hp_hint', 212, 450, RW - 212, 60, 'Your in-game name, Steam id and position are added for the staff automatically. You will be told in game when they answer.', 12),
    // the drop-downs last, so their open lists cover the fields below them
    ...dropdown('hp_type', 0, 116, 310, 6),
    ...dropdown('hp_urg', 330, 116, 200, 4),
  ]);
  const view = panel('hp_view', RX, HEAD + 16, RW, HH - HEAD - 32, '0 0 0 0', [
    heading('hp_v_title', 0, 0, RW, ''),
    text('hp_v_meta', 0, 28, RW, 22, '', { color: MUTED, size: 13 }),
    multiText('hp_v_conv', 0, 56, RW, 380, '', 14),
    label('hp_l_reply', 0, 444, 300, 'Your reply'),
    edit('hp_reply', 0, 466, RW - 170, 28),
    button('hp_reply_send', RW - 160, 464, 160, 32, 'Send reply', { color: BTN_ACCENT }),
  ]);
  fs.writeFileSync(path.join(OUT, 'drpa_help.layout'), H.root('drpa_help', HW, HH, [
    panel('hp_bar', 0, 0, HW, HEAD, BAR, [
      text('hp_head', 20, 0, 600, HEAD, 'Help & tickets', { bold: true, size: 20 }),
      button('hp_closebtn', HW - 60, 8, 40, 32, 'X', { color: BTN_ACCENT }),
    ]),
    panel('hp_line', 0, HEAD, HW, 2, LINE),
    heading('hp_l_mine', LX, HEAD + 16, LW, 'My tickets'),
    list('hp_list', LX, HEAD + 48, LW, HH - HEAD - 120, 18),
    button('hp_new', LX, HH - 58, LW, 34, 'New ticket', { color: BTN_ACCENT }),
    form, view,
  ], H.BG, 1));
}

// ------------------------------------------------------------------ self (the admin's own toggles)
write('drpa_self.layout', content('sf_root', [
  button('sf_fx_god', 8, 8, 260, 30, 'God mode'),
  button('sf_fx_invisible', 8, 44, 260, 30, 'Invisible'),
  button('sf_fx_ammo', 8, 80, 260, 30, 'Unlimited ammo'),
  button('sf_fx_stamina', 8, 116, 260, 30, 'Unlimited stamina'),
  button('sf_fx_aiignore', 8, 152, 260, 30, 'AI ignores me'),
  button('sf_nv', 8, 188, 260, 30, 'Daytime (only for me)'),
  button('sf_heal', 8, 232, 260, 30, 'Heal me', { color: BTN_ACCENT }),
  button('sf_delete', 8, 268, 260, 30, 'Delete tool (Del)'),
  button('sf_freecam', 8, 304, 260, 30, 'Freecam (Ins)'),
  button('sf_body', 8, 340, 260, 30, 'Leave freecam: my body here', { color: BTN_ACCENT }),
  multiText('sf_active', 8, 380, 260, 60, '', 13),
]));

// ------------------------------------------------------------------ delete tool: the confirmation (a menu of its own)
{
  const CW = 520, CH = 230, HEAD = 44;
  fs.writeFileSync(path.join(OUT, 'drpa_confirm.layout'), H.root('drpa_confirm', CW, CH, [
    panel('cf_bar', 0, 0, CW, HEAD, BAR, [
      text('cf_head', 16, 0, CW - 32, HEAD, 'Delete tool', { bold: true, size: 18 }),
    ]),
    panel('cf_line', 0, HEAD, CW, 2, LINE),
    multiText('cf_text', 16, HEAD + 14, CW - 32, CH - HEAD - 70, '', 14),
    button('cf_yes', 16, CH - 46, 150, 32, 'Delete', { color: BTN_ACCENT }),
    button('cf_lock', 176, CH - 46, 180, 32, 'Remove the lock only'),
    button('cf_no', CW - 136, CH - 46, 120, 32, 'Cancel'),
  ], H.BG, 995));
  console.log('wrote drpa_confirm.layout');
}
