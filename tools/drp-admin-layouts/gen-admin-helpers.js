// Generates the DRP Factions .layout files (Enfusion widget layout text) from a compact description.
// Buttons carry a nested TextWidget label ("<name>_label") because a ButtonWidget's own text scales with its
// height and clips; all text uses exact pixel sizes.
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = 'P:\\DRP_Factions\\gui\\layouts';
const FONT = 'gui/fonts/sdf_MetronLight24';
const FONT_BOLD = 'gui/fonts/sdf_MetronBook24';

// palette
const BG = '0.07 0.07 0.07 0.98';
const BAR = '0.11 0.11 0.11 1';
const NAV = '0.085 0.085 0.085 1';
const CARD = '0.115 0.115 0.115 1';
const FIELD = '0.16 0.16 0.16 1';
const BTN = '0.2 0.2 0.2 1';
const BTN_ACCENT = '0.62 0.1 0.1 1';
const LINE = '0.62 0.1 0.1 1';
const TXT = '0.92 0.92 0.92 1';
const MUTED = '0.62 0.62 0.62 1';
const GOLD = '1 0.82 0.35 1';

function ind(n) { return ' '.repeat(n); }
function pos(x, y, w, h) { return `position ${x} ${y}\n size ${w} ${h}\n hexactpos 1\n vexactpos 1\n hexactsize 1\n vexactsize 1`; }
function node(cls, name, props, children = []) { return { cls, name, props, children }; }

function panel(name, x, y, w, h, color, children = []) {
  return node('PanelWidgetClass', name, `${pos(x, y, w, h)}\n color ${color}\n style DayZDefaultPanel`, children);
}
function text(name, x, y, w, h, str, o = {}) {
  return node('TextWidgetClass', name, `ignorepointer 1\n ${pos(x, y, w, h)}\n text "${str}"\n font "${o.bold ? FONT_BOLD : FONT}"\n "text color" ${o.color || TXT}\n "exact text" 1\n "exact text size" ${o.size || 15}\n "text halign" ${o.align || 'left'}\n "text valign" center`);
}
function heading(name, x, y, w, str) { return text(name, x, y, w, 24, str, { bold: true, size: 17 }); }
function label(name, x, y, w, str) { return text(name, x, y, w, 22, str, { color: MUTED, size: 13 }); }
function multiText(name, x, y, w, h, str, size = 14) {
  return node('MultilineTextWidgetClass', name, `ignorepointer 1\n ${pos(x, y, w, h)}\n text "${str}"\n font "${FONT}"\n "text color" ${TXT}\n "exact text" 1\n "exact text size" ${size}\n wrap 1\n "condense whitespace" 0`);
}
// Buttons, edit boxes and lists draw no background of their own in this engine, so each gets a panel: a child
// "<name>_bg" for buttons (scripts recolor it for highlights), a container panel behind edit boxes and lists.
const FILL = 'position 0 0\n size 1 1\n hexactpos 1\n vexactpos 1\n hexactsize 0\n vexactsize 0';
function button(name, x, y, w, h, str, o = {}) {
  const bg = node('PanelWidgetClass', `${name}_bg`, `ignorepointer 1\n ${FILL}\n color ${o.color || BTN}\n style DayZDefaultPanel`);
  const lbl = node('TextWidgetClass', `${name}_label`, `ignorepointer 1\n ${FILL}\n text "${str}"\n font "${FONT}"\n "text color" ${TXT}\n "exact text" 1\n "exact text size" ${o.size || 14}\n "text halign" ${o.align || 'center'}\n "text valign" center`);
  return node('ButtonWidgetClass', name, `${pos(x, y, w, h)}\n color 0 0 0 0\n style Default\n text ""`, [bg, lbl]);
}
function edit(name, x, y, w, h) {
  const box = node('EditBoxWidgetClass', name, `position 6 0\n size 0.98 1\n hexactpos 1\n vexactpos 1\n hexactsize 0\n vexactsize 0\n style Default\n font "${FONT}"\n text ""`);
  return node('PanelWidgetClass', `${name}_bg`, `${pos(x, y, w, h)}\n color ${FIELD}\n style DayZDefaultPanel`, [box]);
}
function multiEdit(name, x, y, w, h) {
  const box = node('MultilineEditBoxWidgetClass', name, `position 6 4\n size 0.98 0.94\n hexactpos 1\n vexactpos 1\n hexactsize 0\n vexactsize 0\n style Default\n font "${FONT}"\n wrap 1\n text ""`);
  return node('PanelWidgetClass', `${name}_bg`, `${pos(x, y, w, h)}\n color ${FIELD}\n style DayZDefaultPanel`, [box]);
}
function list(name, x, y, w, h, lines) {
  // list rows take the font's native size, so lists use the 16 px bitmap font
  const lst = node('TextListboxWidgetClass', name, `clipchildren 1\n ${FILL}\n style Default\n "title visible" 0\n lines ${lines}\n font "gui/fonts/metronbook16"`);
  return node('PanelWidgetClass', `${name}_bg`, `${pos(x, y, w, h)}\n color ${FIELD}\n style DayZDefaultPanel`, [lst]);
}
function check(name, x, y, w, h, str) {
  return node('CheckBoxWidgetClass', name, `${pos(x, y, w, h)}\n text "${str}"\n font "gui/fonts/metronbook16"`);
}
// Same properties as the inventory's CharacterPanelWidget: relative size, centred, no clipping.
function playerPreview(name) {
  return node('PlayerPreviewWidgetClass', name, `disabled 0\n clipchildren 0\n ignorepointer 1\n keepsafezone 0\n position 0 0\n size 1 1\n halign center_ref\n hexactpos 0\n vexactpos 0\n hexactsize 0\n vexactsize 0\n priority 1`);
}
function render(n, depth = 0) {
  const pad = ind(depth);
  const props = n.props.split('\n').map(l => pad + ' ' + l.trim()).join('\n');
  let out = `${pad}${n.cls} ${n.name} {\n${props}\n`;
  if (n.children.length) {
    out += `${pad} {\n`;
    for (const c of n.children) out += render(c, depth + 2);
    out += `${pad} }\n`;
  }
  out += `${pad}}\n`;
  return out;
}
// bg may be transparent: the character preview is drawn beneath the UI (like the inventory's), so the menu that
// hosts it is assembled from opaque pieces that leave the preview rectangle uncovered.
function root(name, w, h, children, bg = BG, priority = 990) {
  return render({
    cls: 'FrameWidgetClass', name,
    props: `position 0 0\n size 1 1\n halign center_ref\n valign center_ref\n hexactpos 0\n vexactpos 0\n hexactsize 0\n vexactsize 0\n priority ${priority}`,
    children: [{
      cls: 'PanelWidgetClass', name: `${name}_panel`,
      props: `clipchildren 0\n color ${bg}\n position 0 0\n size ${w} ${h}\n halign center_ref\n valign center_ref\n hexactpos 1\n vexactpos 1\n hexactsize 1\n vexactsize 1\n style DayZDefaultPanel`,
      children
    }]
  });
}

module.exports = { panel, text, heading, label, multiText, multiEdit, button, edit, list, check, root, BG, BAR, NAV, CARD, FIELD, BTN, BTN_ACCENT, LINE, TXT, MUTED, GOLD };
