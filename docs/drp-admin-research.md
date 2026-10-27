# DRP_Admin — research and feature plan

Research date: 2026-10-26. Sources: the two Workshop pages the user named, the COT GitHub source
(read via `gh api`, version 2026.2.061658), and lbmaster.de (product page id=41, /configs, /faq,
/webhook/list.php).

## 1. What the reference mods are

### Workshop 2930930547 — "Sobr Foolproof (Admin)" by Sobranskiy
Not an admin tool. It is a 15 KB filter that hides `$UNT$` (unfinished) and crash-prone classes from
admin-panel item lists. The Workshop page now shows it as removed for a guidelines violation.
Users also report a butchering recipe override with a misspelled `FoxPelt` that breaks hides/feathers.
**Take-away for DRP_Admin:** our spawner's class list should exclude `scope < 2`, `$UNT$` display
names and a configurable blocklist (LBS calls it `forbiddenItems.json`). Do not depend on this mod.

### Workshop 1564026768 / GitHub — Community Online Tools (COT), Jacob_Mango et al.
2.2 M subscribers, CC-BY-SA-4.0, hard dependency on CF, client + server mod.
(Workshop page also flagged as removed at the time of reading.)

Modules (`5_Mission/CommunityOnlineTools/modules/JMModuleConstructor.c`):

| Module | What it does |
|---|---|
| JMPlayerModule | set health/blood/shock/energy/water/stamina/heat buffer/bloody hands; toggles god, freeze, invisible, AI-ignore, no-damage-dealt, no collision, unlimited ammo, unlimited stamina, admin NVG, broken legs; heal (optionally attachments/cargo), strip, clear cargo, dry, stop bleeding, vomit, set scale, repair vehicle; teleport to / bring / back to previous; spectate; kick/ban with message; message/notify; edit a player's permissions and roles; open inventory |
| JMObjectSpawnerModule | spawn at position or into a target's inventory, delete entity / at cursor, random animal/infected/wolf |
| JMTeleportModule | tp to position / cursor / saved location; add, remove, reload locations (`Teleports_<world>.json`) |
| JMESPModule | client-side ESP canvas; server edits: set position/orientation/health, delete, duplicate, delete-all, move to cursor, heal, make item set, base building build (optionally without materials)/dismantle/repair, car unstuck/refuel, copy as types/market/loadout |
| JMVehiclesModule | list vehicles; delete one/all/destroyed/unclaimed; tp to vehicle |
| JMWeatherModule | storm, fog, dynamic fog, rain, snow, overcast, wind, date/time, freeze time, presets, quick buttons |
| JMCameraModule | freecam (server tracks camera position so the network bubble follows), FOV, zoom |
| JMLoadoutModule | named loadouts; spawn at cursor / on target / on selected players |
| JMMapModule | map with players, click to teleport |
| JMWebhookModule | Discord webhooks, per-connection event-type toggles, queued + rate-limited via `RestApi` |
| JMCommandModule | chat commands routed to per-module sub-commands with a permission each |

Architecture worth copying:
- **Every action is checked on the server.** Client sends a numbered RPC; server re-reads args, checks
  `HasPermission("Admin.Player.Freeze", sender)`, runs `Exec_…`, logs, posts webhook, notifies admin.
- **Permission tree** with dotted names, each node INHERIT / DENY / ALLOW, own tree beats roles,
  role `everyone` implicit. The server sends each admin their resolved tree so the UI hides buttons.
- **Admin "active" flag** — passive admin effects only apply while the admin has toggled admin mode on.
- Logs to the `.ADM` (`GetGame().AdminLog`) and its own timestamped log.

Things to avoid (found in the COT source):
- Numeric RPC ranges 20 wide that collide ("AT MAX!" comment). Use one RPC id + a string command.
- Permission name casing mismatches (`Godmode` registered vs `GodMode` checked), and permissions that
  are checked but never registered.
- Sample `Webhooks.json` in the repo carries a real-looking Discord token.

### LBmaster "Admin Tools" (lbmaster.de product 41) — the target to replicate
Paid (150 €/server, IP-whitelisted licence), depends on LBmaster Core, separate client/server packs,
~120 permissions, 81 webhook events. Current version 5.12.2.

UI: resizable, movable, pinnable **frames** with up to 9 saved layouts (Ctrl+1..9). Frames:
Players, Player Info, Teleport Manager, Map, Item Spawner, Preset Spawner, Environment Manager,
ESP Tools, ESP Drag, ESP Selected, Cheats, Ban Manager, Watchlist, Construction Edit, Object Builder,
Active Modifiers, Freecam, Items on Map, Server Info, Settings.

Keybinds: U admin mode · Ctrl+A (or I) menu · H tp to cursor/ESP item · Ctrl+D delete (confirm) /
duplicate in inventory · Alt+D delete · Ctrl+G/S/C spawn ground/self/cursor · Ctrl+F freecam ·
Ctrl+G god · Ctrl+H heal self · Ctrl+R heal target/repair vehicle · Ctrl+I invisible · Ctrl+E ESP ·
Ctrl+P copy position · wheel = spectate zoom / freecam speed.

Features:
- **Players:** list with search + multi-select; info: name, SteamID, GUID, item in hands, position,
  alive/dead/unconscious, health, blood, shock, water, energy, heat comfort, heat buffer, sicknesses.
  Actions: spectate, kill, heal, tp to, tp back, bring, find on map, strip, clear inventory, restrain,
  freeze, invisible, god, vehicle god, unlimited ammo, pristine hands, unlimited stamina, action
  speedhack, AI ignore, bloody hands, vomit, set scale, set stats, add/remove sickness, message, kick, ban.
- **Spectate:** 1st/3rd person, zoom to 1000 m, auto-follow through tp/respawn, sees target inventory,
  hears their VoIP, vehicle HUD.
- **Freecam:** follow targets, remote actions, inventory viewing, speed/FOV/smoothing.
- **ESP:** skeletons, classname/display labels, distance and custom filters; tp to / delete from ESP;
  **ESP Drag** (move objects, ground snap); **ESP Selected** (box-select, bulk delete).
- **Item spawner:** search, preview, attachments, quantity, food stage, health level, temperature;
  spawn at cursor / ground / inventory. **Preset spawner** (local or server-wide sets).
  **Duplicate item** with attachments and health. `forbiddenItems.json` blocklist + bypass permission.
- **Teleport manager:** personal + server locations, 100+ defaults per map, tp selected players with
  their vehicles.
- **Map:** players, vehicles by type, freecam position, coordinates and distances.
- **Construction edit:** set base-building part states, presets. **Object Builder:** toggleable placed
  structure sets (event building).
- **Environment manager:** time + weather presets with live preview.
- **Server info:** players, bodies, animals, zombies, vehicles, items, FPS, uptime.
  **Items on map:** per type count with lifetime and min/nominal from types.xml, bulk wipe by type/area.
- **Self cheats** + "Active Modifiers" frame: full bright, temporary player, invisible, god, unlimited
  ammo, vehicle god, pristine hands, unlimited stamina, 100× action speed, AI ignore.
- **Moderation:** timed/permanent bans with public reason + private comment, history; global banlist
  across all servers on the licence; watchlists (personal/server/global) with confidence 0–1, comments,
  join alerts, automatic entries from cheat/dupe rules.
- **Permissions:** `Admins.json` (SteamID, optional required name, comment, grantAll, groups);
  groups grant/revoke individual perms, default deny; `teams.json` for staff colours on ESP/map.
  Admin mode must be on before anything works.
- **Logs:** per-admin audit log, 7-day retention; 81 Discord webhook events with SteamID filters and
  public-safe message overrides.

## 2. Where our app stands (v0.1.77, bridge v6)

Already done through the mission-script bridge (`src/main/bridge.c`, file channel in
`$profile:DayZAdminTools`) and the shared catalogue (`src/main/admin-actions.js`):
heal, kill, god, freeze, invisible, strip, respawn (body removed), tp to point / to player / bring /
to death, give item, kit, spawn vehicle, spawn at point, refund, afflictions (bleed, broken legs,
unconscious, health/blood %, cold, hot, starve, dehydrate, wet, nine sicknesses + clear), vehicle
repair/refuel/break/flip/move/bring/destroy/delete, message, kick, ban, BE ban/unban, whitelist,
priority queue, live map with players/vehicles/flags, dupe detection, gear log, death log, Discord bot,
web portal with approvals, audit log, multi-instance.

What the app does **better than LBS/COT** already: everything works from outside the game (desktop +
web portal + Discord), approval workflow, multi-instance, economy/loot tooling, backups, crash/health
monitoring. Keep that as the identity: DRP_Admin is the in-game half, not a replacement.

## 3. Gaps

### A. Needs a client-side mod (impossible from the mission bridge)
| Feature | LBS | COT |
|---|---|---|
| Admin mode toggle + in-game menu with frames | ✓ | ✓ (toolbar) |
| Freecam (server tracks the camera so the network bubble follows) | ✓ | ✓ |
| Spectate (1st/3rd, inventory, VoIP) | ✓ | ✓ |
| ESP with labels/filters, tp/delete from ESP | ✓ | ✓ |
| ESP drag + box-select bulk delete | ✓ | partial |
| Teleport to cursor (H) | ✓ | ✓ |
| Item spawner with preview, spawn at cursor | ✓ | ✓ |
| Open a player's inventory | ✓ | ✓ |
| Full bright / admin NVG | ✓ | ✓ |
| Copy position | ✓ | — |

### B. Server-side only — can go in DRP_Admin's server part (or the bridge) with app/portal UI
- Set individual stats: water, energy, shock, stamina, heat buffer (we do health/blood % only)
- Unlimited ammo, unlimited stamina, AI ignore, pristine hands, vehicle god, action speed
- Bloody hands, vomit, set scale, restrain, dry, stop bleeding only, clear inventory (vs strip)
- Teleport back to previous position; teleport players together with their vehicle
- **Weather / time control + presets** (nothing in the app today)
- **Saved teleport locations** (nothing today) — ship defaults per map
- Duplicate item; spawn with food stage / health level / quantity / temperature
- Base building: build / dismantle / repair parts, construction presets
- Object sets / event building toggles (overlaps our map/mission tooling)
- Server info counts: bodies, animals, infected, items, vehicles (we have FPS/players)
- Items on map with bulk wipe by type or area
- Vehicles: delete all destroyed / unclaimed
- Spawn random animal / infected

### C. App-side only (no mod needed)
- **Watchlist** with confidence, comments, join alerts, auto-entries from anticheat/dupe rules
- Timed bans with public reason + private comment, ban history (check what `lists.js` already does)
- Global banlist shared across instances
- Forbidden-items blocklist for spawning, with a bypass permission
- Webhook coverage: SteamID filters and public-safe message variants
- Staff teams with colours (for ESP/map)

### D. Hooks we lack today (the "companion" part)
The bridge only sees what it polls and what the ADM log prints. A mod with `modded class` can emit
structured events to the app:
- Connect / disconnect with identity, ping, position (MissionServer)
- Damage and kills with weapon, ammo, distance, hit zone, both positions (`EEHitBy`, `EEKilled`)
- Action events beyond the action log: base building place/build/dismantle/destroy, code lock set /
  open / fail (DRP_DoorLocks), container open, item pick up / drop / take from body
- Vehicle enter / exit / driver change / crash damage
- Inventory move of flagged items (anti-dupe trail, ties into the existing dupe mod)
- Server-side chat capture with sender identity (RCon gives text only)
- Admin actions performed in game, so the app's audit log and portal approvals cover both sides

## 4. Design recommendations

1. **Two PBOs in `@DRP_Core`**: `drp_admin_server` (hooks + action executor, replaces the mission
   bridge) and `drp_admin` (client UI, inputs, layouts). Clients must load the client PBO; the server
   PBO is server-only. No CF — same choice as DRP_Hacking.
2. **One permission source: the app.** The app already has roles and `admin.*` permissions. It writes a
   resolved `admins.json` (GUID/Steam64 → permission list) to the profile; the mod reads it and pushes
   each admin's list to their client to hide buttons. The server re-checks every RPC, COT-style.
   Fix the COT pitfalls: one registry of permission names shared by app and mod, generated from
   `admin-actions.js`, so names can't drift.
3. **One RPC id, string command + params**, routed to handlers on the server — no numeric ranges.
4. **Keep the file channel for app ↔ mod**, but move from polled text to append-only JSON lines
   (events out, commands in, results out) so the app's existing tailers can read them.
5. **In-game actions go through the same catalogue** — an in-game kill/heal writes an audit event
   the app logs and the portal shows; approval-required categories can be refused in game with a
   "request sent to the portal" message.
6. **Admin mode** (LBS `U`): nothing works until toggled; toggling is logged and webhooked.
7. **Build order** (each step usable on its own):
   1. Server PBO: port bridge v6 actions + event hooks (D). App switches from mission bridge to mod.
      **Done 2026-10-26** — `src/main/drpadmin.js` builds `@DayZAdminTools/addons/drp_admin_server.pbo`
      from `bridge.c` (renamed `DRPA_Bridge`) + `src/main/drpadmin/`; toggle on the Death log page;
      events in `events.jsonl`. Server-only, so it lives in the tool's `-serverMod` folder, not `@DRP_Core`.
   2. Server-side gaps (B) with app/portal UI: weather/time, saved teleports, stats, cheats toggles.
   3. App-side gaps (C): watchlist, timed bans, forbidden items.
   4. Client PBO: admin mode, menu shell with player list + player info, tp to cursor.
      **UI style: the same as the DRP_Factions menu** (user decision 2026-10-26), with tabs in place of LBS's
      floating frames.
   5. Freecam + spectate.
   6. ESP, ESP drag/select, item spawner with preview.
   7. Construction edit, object sets, items-on-map wipe.
