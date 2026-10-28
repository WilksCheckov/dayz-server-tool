# DRP_Admin + DayZ Admin Tool — implementation plan

Written 2026-10-27. Companion to `docs/drp-admin-research.md` (what LBmaster / COT offer). This is the plan for
what we build next, in order, with the in-game ticket system as the headline feature.

---

## 0. Where we are

**App (DayZ Admin Tool)**
- Already has: tickets shared with the Discord bot (`tickets.js`, linked deaths and admin actions, `#0041` tags).
- Also has:
  - a death log with gear snapshots and refunds (`deathlog.js`)
  - heatmaps from the admin log (`heat.js`: travel, hit, build, login, logout, death)
  - loot spawn maps (`lootmap.js`: where any item can spawn)
  - combat statistics, the player database, anti-dupe, the live map with vehicles and flags
  - the web portal with users, groups, permissions and approvals
  - the Discord bot, the admin action audit (`adminlog.js`), and the Factions and Loot zones pages
- Server PBO `@DayZAdminTools/drp_admin_server.pbo`: runs the bridge actions and writes hook events to
  `events.jsonl`.

**Client mod (`P:\DRP_Admin` → `@DRP_Core`)**

- The look is the faction colour style with LBmaster's layout: a toolbar plus windows you can move, resize and pin.
- Windows:
  - **Players**, **Player info**: about 30 actions, effects, sliders, message and kick.
  - **Item spawner**: preview, vehicles with parts.
  - **Teleports**, **Map**, **Environment**, **Server info**, **Cheats**.
- Keys: admin mode (U), menu (I), teleport to cursor (H). Admins and permissions come from
  `profiles/DRP_Admin/admins.json`.

**Known issues to fix first** (seen 2026-10-27):
- The stat sliders draw as empty white outlines.
- Some Teleport manager place names come out in Cyrillic.
- Default window positions overlap.
- Not yet tried in game: Environment, Server info, message, kick, Map, effects (invisible, freeze, ammo,
  stamina, AI ignore), Bring, and the vehicle and creature previews.
- It's unconfirmed whether I opens the vanilla inventory.
- Helicopters aren't on the map (only `CarScript` is tracked).

**Progress (2026-10-27):** steps 1–3 of the suggested order are built (Phase A, B1/B2, C1–C3 in-game tickets).
Step 4 is built but not yet tried in game:
- The app adds context to every in-game ticket: the death in full, the gear list, the player's history, alerts in
  the last 24 h, and the `.ADM` lines from two minutes either side. It shows on the app's ticket page and in game.
- In game, the Tickets window has **Death details** (Death window: teleport, refund, show on map) and **Context &
  admin log** buttons.
- The app's Test instance (`C:\DayZServers\Test`) reads the Developer Tools test server's folder (install folder =
  the Developer Tools workspace, so its mission and profiles).

Step 5 (Phase D) is built but not yet tried in game:
- The app writes `DayZAdminTools/map/`: `timed_<1h|24h|7d>.json` (deaths by cause, heat grids for travel, hits,
  building and logins), `static.json` (vehicle spawns, DRP_Factions territories, loot zones and caches, open
  tickets) and `loot.json` (answers `loot_req.txt`). Code: `src/main/drpmap.js`.
- The Map window has a layers panel. Marks show deaths, vehicle spawns, zones, caches, tickets and loot spots; a
  canvas laid over the map draws heat, territories and the selected player's trail (kept by the server mod, 30 min).
- Fixed on the way: the admin log's `pos=<x, north, height>` was stored with the height where north belongs, so the
  heatmap, last positions and the speed check used the height. Old death records are migrated; old heat data is
  dropped and read again from the logs.
- The app now also reads the logs while a server it did not start writes them (the test server).
- Not done from the table: PvP killer → victim lines (the killer's position is not recorded).

Step 6 (B3/B4) is built but not yet tried in game:
- **Watchlist** (`src/main/watchlist.js`): confidence, reason, private note; added from the Statistics page, the
  Player database or in game, and automatically (source "auto") when a suspicious-activity score reaches the alert
  level (never over a staff entry). Joins raise the `watchlist-join` alert; the mod reads
  `DayZAdminTools/watchlist.json`, tells admins in game when a watched player joins and shows it in Player info.
- **Moderation from the game** (`src/main/gamereq.js`, mod `DRPA_Moderation.c`, window *Moderate* from Player
  info): ban (permanent or 1/3/7/30 days, through the Discord module's ban with expiry), whitelist and priority
  queue add/remove, watch/unwatch. Lines go to `requests_in.jsonl`; answers come back in `requests_out.json`. A ban
  kicks at once, and the mod refuses players in `ban.txt` itself (the engine reads it only at start).
- **Approvals**: `admins.json` lists each admin's categories that need approval (portal group policy); the mod holds
  such an action, the app makes a portal request (`portal.requestFromGame`), and the decision goes back to the game,
  which runs it if the admin is still online. Timed bans now expire even while the Discord bot is off.
- New in-game permissions: `players.ban`, `lists.manage`.

Built next (2026-10-28), not yet tried in game:
- **Delete tool** (Cheats → *Delete tool*, key Delete): deletes what the crosshair points at after a confirmation
  that names it; a locked gate, door or container can lose just its lock. Players and map objects are refused.
  Permission `admin.delete`.
- **Freecam** (Cheats → *Freecam*, key Insert): the admin becomes a spectator with a `DRPA_FreeCam` (COT's method:
  `SelectSpectator` + `UpdateSpectatorPosition`), the body stays behind without taking damage. WASD, Q/E, Shift,
  walk key; admin actions aim from the camera. *Leave freecam: my body here* moves the body under the camera.
  Permission `admin.freecam`.
- **Editor** (toolbar → *Editor*): object sets per map in `profiles/DRP_Admin/editor/<map>.json`; place from a
  searchable catalogue (map objects and spawnables) where the crosshair points, select what you aim at, nudge,
  turn, pitch, roll, snap to ground, move to aim, duplicate, delete; switch sets on and off; export to an init.c
  snippet and JSON. Sets that are on come back after a restart (objects already standing there are reused).
  Permission `admin.editor`. Not done: a mouse gizmo (moves are buttons with a step size).
- **Heal / cure fixes**: curing now empties the stomach, removes the agents, switches off the disease modifiers and
  clears queued symptoms (in game and through the bridge, now v7). Heal fully also resets stats and wakes them.

---

## 1. Principles (apply to everything below)

1. **The app is the one source of truth for permissions.** In-game admins come from the app's or portal's
   users and groups, not from a hand-edited file. The permission names are the same everywhere (`admin.heal`,
   `players.kick`, …).
2. **The server checks every request.** The client only draws.
3. **Every admin action is audited once:** the app's audit log, the Discord admin action channel, and the
   ticket it belongs to, whether it came from the app, the portal, Discord or the game.
4. **One event stream.** The mod writes `events.jsonl`, and the app reads it the same way it reads the admin
   log. Each new kind of event is just a new `"ev"`.
5. **App → game data travels as files** in `$profile:DayZAdminTools/out/` (the app writes them, the server
   reads them and sends them to admin clients on request, in chunks). **Game → app travels as JSON-lines files**
   in `$profile:DayZAdminTools/` (the mod appends, the app tails). This keeps working when the app is closed.
6. **Players see nothing of the admin side.** The player-facing part (tickets) is its own small UI.

---

## 2. Phase A — Fix and verify (short)

| # | Task | Notes |
|---|---|---|
| A1 | Sliders that render | Give `SliderWidget` a visible style, or draw our own bar: a panel fill plus a drag handle, set from mouse x. The bar is the safer choice. |
| A2 | English place names | Run `Widget.TranslateString` on CfgWorlds names. If a name is still Cyrillic, fall back to the name's class (e.g. `Settlement_Chernogorsk`, cleaned up). |
| A3 | Default layout | Default window positions that don't overlap at 1920×1080. "Reset layout" on the toolbar. |
| A4 | Verification pass | One session with two clients (second Diag client, or a friend): effects, Bring, kick, message, invisibility seen from the other client, freeze. |
| A5 | Menu key | Confirm whether I is free. If not, use K by default. |
| A6 | Helicopters and boats on the map | Track `Transport` subclasses (`HelicopterScript`, boats if present) as well as `CarScript`. |
| A7 | Action log off | Only when you say a mod is cleared (standing rule). |

---

## 3. Phase B — Glue between the app and the mod

### B1. Admins and permissions from the app
- The app's **In-game admins** page links a portal user or app account to a **Steam64 id** (or uses Discord
  link + Steam).
- The app writes `profiles/DRP_Admin/admins.json` from those users' groups. The permissions shown in the portal
  are the ones used in game. The mod already re-reads the file every 30 s, so changes apply live.
- New permissions to add to the portal catalogue: `admin.menu`, `admin.players`, `admin.teleport.manage`,
  `admin.weather`, `admin.spawn.forbidden`, `admin.afflict`, `admin.god`, `admin.cheats`.

### B2. In-game actions in the app's audit
- The app reads `ev:"admin"` lines from `events.jsonl` into `adminlog.record`. They then appear in the audit log, the
  Discord admin action channel ("Chris (in game) healed Bob — reason …") and on the player's profile.
- **Reasons and tickets in game:** actions that need a reason in the app (refund, spawn, kill, ban) ask for one
  in game. A small prompt takes the reason or a `#ticket` number, so actions attach to tickets exactly as they do
  from the app.

### B3. Bans and lists from the game
- Player info gets **Ban**: permanent or timed, a public reason and a private note. The mod writes a request
  (`requests.jsonl`). The app runs it through its existing ban code (BattlEye ban list, timed bans, Discord
  notice), then confirms back.
- **Whitelist / priority queue** buttons work the same way.
- **Watchlist** (LBS feature): add a player with a confidence and a note. The app alerts admins in game and on
  Discord when that player joins.

### B4. Approvals in game
- If the portal policy says an action needs approval for that admin, the game shows "Sent for approval
  (#R12)". The request appears on the portal and in Discord, and the action runs once it's approved. The admin
  gets an in-game notice either way.

### B5. Better data from the mod's events
- Kills and hits from the mod (weapon, ammo, body zone, distance, both positions) feed the death log and combat
  statistics. They replace guesses from the admin log whenever both are present.
- Building, placing and vehicle events feed the heatmap (build kind) and the player profile.

---

## 4. Phase C — In-game tickets (the headline)

### C1. Player side: "Help / Report" in game
- Opened with a key (default **F1**, rebindable) or the chat command `/ticket`.
- **Categories:** *I died / lost gear*, *Report a player*, *Base / building problem*, *Bug*, *Question*, *Other*.
- **The form:** a short title and a description. "Report a player" also lets them pick a nearby or recent player.
- **Context the game attaches automatically:**
  - position, time, server instance
  - their last death record (if within 30 min), with cause, killer, weapon and position
  - the gear snapshot before death
  - players within 200 m at the time of reporting
  - for building problems, the nearest flag or base
- **My tickets:** players see their own tickets, status and the conversation, and can reply.
- **Notifications:** an in-game notice when an admin replies or closes the ticket, and on the next login if they
  were offline.
- **Limits:** one open ticket per category, a cooldown between tickets, and a character limit, so it can't be
  spammed.

### C2. Transport
```
player client --RPC--> server mod --append--> $profile:DayZAdminTools/tickets_in.jsonl --tail--> app tickets.create(source:"game")
app (reply/close/assign from app, portal or Discord) --write--> out/tickets/<steam>.json --> server mod --RPC--> player client
```
- A ticket from the game becomes a normal ticket in the app. It opens a private Discord channel as Discord
  tickets do today, so admins can answer from Discord, the app, the portal or the game.
- Ticket numbers stay shared: `#0042` works everywhere.

### C3. Admin side: **Tickets** window in game
- **The list:** filters (Open / Mine / Unassigned / All) and search, with age, category, player and assignee.
  An "unanswered" count shows on the toolbar.
- **Ticket detail:** the conversation and a reply box with canned replies (macros), plus Claim / Assign, Close
  and Reopen.
- **Linked context, each item a button:**
  - **Death record:** opens a **Death** window with cause, killer, weapon, range, hits per body part and the
    gear list. It has *Teleport to death spot*, *Refund* (the existing refund path, which removes the body) and
    *Show on map*.
  - **Position:** *Teleport there*, *Show on map*.
  - **Player:** selects them (Players and Player info follow). *Teleport to*, *Bring*.
  - **Reported player:** their profile summary, recent kills, flags and dupe alerts.
  - **Nearby players at report time:** select each one.
  - **Admin actions already done for this ticket.**
- **Map integration:** *Show on map* opens the Map window centred on the ticket with marks for the reporter,
  the death spot, the killer's position and nearby players.

### C4. What the app adds automatically
- Deaths for that player near the ticket time are attached (the existing `forDeath` linking).
- A combat log excerpt (hits in the 5 minutes before a death) and the killer's history against this player.
- **Admin log excerpt:** the `.ADM` lines from ±2 minutes around the reported time, readable in the app and portal.
- Dupe and anticheat alerts on either party in the last 24 h.
- The player's history: playtime, previous tickets, previous refunds, notes.

### C5. Ticket data model (extends `tickets.js`)
```
{ id, source: game|discord|app|portal, player: {steam, name}, category, title, status, assignee,
  messages: [{ by, role: player|admin, text, ts }],
  links: { deaths: [], positions: [{x,z,label}], players: [], actions: [], items: [] },
  context: { pos, time, instance, nearby: [...], gear: [...] } }
```

### C6. Ticket tools for the team
- SLA timers: unanswered for more than X minutes → alert.
- Saved replies, editable in the app.
- Ticket stats: response time, per admin, per category.
- Closing asks "resolved / not resolved / refunded", which feeds the stats.

---

## 5. Phase D — The app's map intelligence in the game's Map window

Each layer can be switched on and off in the Map window, with a time filter (1 h / 24 h / 7 d).

| Layer | Source | Drawn as |
|---|---|---|
| Deaths | `heat.js` deaths and the death log | Coloured marks by cause; click → Death window |
| Kills (PvP) | Death log | Killer → victim lines, or paired marks |
| Activity heat | `heat.js` events (travel, build, login, logout, hit) | Grid cells shaded by count, one layer per kind |
| Loot: where an item spawns | `lootmap.spawns(item)` | Search an item → marks on every building where it can spawn, weighted |
| Vehicle spawns | `lootmap.vehicleSpawns` | Marks |
| Territories | Flags (bridge) and DRP_Factions cells | Shaded cells / flag marks |
| Loot zones | DRP_Factions zones | Circles / marks |
| Player trails | Bridge or mod positions (last 30 min) | Breadcrumb marks per selected player |
| Tickets | Open tickets with a position | Marks; click → ticket |

- **How the data gets there:** the app writes `out/map/<layer>.json` (already aggregated, small). The admin
  client asks the server, which sends it in chunks.
- **Drawing:** marks use `AddUserMark`. Shaded heat cells need a canvas, using the faction menu's approach of a
  separate canvas layer laid over the map's rectangle every frame. A canvas inside the window draws under the
  map. The same low-layer rule the item preview needed probably applies, so test it early.

---

## 6. Phase E — More LBmaster parity in game

Grouped by size.

**Small**
- Copy position, teleport a player together with their vehicle, restrain, set scale.
- Vehicle actions from the Map window: right-click a vehicle → repair, refuel, flip, delete, teleport to,
  vehicle god mode.
- **Kits / preset spawner** from the app's kits (`settings.kits`): spawn a kit on a player.
- Duplicate the item in hands, spawn into the container you're looking at.
- A **forbidden items** editor in the app, written to `forbidden_items.json`.
- **Layout presets:** save and restore window arrangements (LBS Ctrl+1…9).

**Medium**
- **Spectate:** first and third person, follow through respawn, see their inventory. Needs the server to move the
  admin's network bubble.
- **Freecam:** speed, FOV, admin actions from freecam. The server follows the camera position so the world loads
  around it.
- **ESP:** players, items, vehicles, base parts, infected; labels and a distance filter; teleport to or delete
  from the ESP.
- **Construction edit:** build, dismantle or repair base parts, or build without materials.
- **Items on map:** count and bulk-wipe by class or area, with min/nominal from `types.xml` shown next to the
  live count (this is economy insight too).

**Large**
- **ESP drag / box select:** move objects, bulk delete.
- **Object builder / event sets:** place sets of objects and switch them on or off (for events), saved per map.
- **Admin teams and colours** on ESP and the map.

---

## 7. Phase F — App-side features that build on the above

- **Unified player profile** (app and portal): sessions, deaths, kills, tickets, refunds, admin actions,
  watchlist, dupe alerts, name history, gear history, and an "open in game" link (selects them in game when
  you're in admin mode).
- **Tickets page upgrade:** the C4 context panels, the admin log excerpt, map snapshots (death spot on the
  rendered map tiles), canned replies.
- **Heatmap page:** time slider, layer toggles that match the game's, export as an image.
- **Economy insight:** live item counts from the mod's world sweep against nominal/min in `types.xml`, and
  over/under-spawned items.
- **Anticheat from mod data:**
  - impossible movement speed, teleports without an admin action
  - damage while invisible or in god mode by a non-admin
  - very long-range kills with the wrong weapon
  - Each feeds a watchlist automatically, as LBS does.
- **Announcements and scheduled events:** restart warnings and messages in game. Later, timed events from
  object sets (Phase E).
- **Discord:** `/ticket` links a Discord ticket to an in-game player, ticket replies go both ways, and death
  embeds have a "teleport there" button for admins.

---

## 8. Phase G — Reliability, packaging, release

- **Version handshake:** the mod reports its version in `events.jsonl` "start"; the app warns when the app,
  server PBO and client PBO don't match.
- **Permission catalogue generated from one file:** `admin-actions.js` → the portal list and the mod's
  constants, so names can't drift (COT's bug).
- **Rate limits** on the server for spawn and teleport requests, plus a per-admin daily spawn cap (the portal
  policy reused).
- **Tests:** keep `test/drpadmin.test.js` growing (ticket inbox/outbox, admins.json writer, map layer
  writers).
- **Server owner install:** the app's DRP_Admin card installs `@DRP_Core` with the client PBO and its key,
  writes `admins.json`, and checks the mod is loaded.
- **Docs:** a page in the app's website: "How tickets work for players", with the keys.

---

## 9. Suggested order

| Step | What | Why first |
|---|---|---|
| 1 | Phase A (fixes and verification) | Builds on solid ground |
| 2 | B1 admins from the app, B2 audit | Everything after relies on one set of permissions and one audit trail |
| 3 | **C1–C3 tickets in game** (player form, transport, admin Tickets window) | The headline feature |
| 4 | C4 context + Death window + "show on map" | Makes tickets fast to resolve |
| 5 | D deaths, heat and loot layers on the in-game map | Reuses the data the app already has |
| 6 | B3 bans and watchlist, B4 approvals | Moderation complete in game |
| 7 | E small items, then spectate and freecam | The most-used LBS tools |
| 8 | E ESP, construction edit, items on map | |
| 9 | F profile, economy, anticheat | |
| 10 | G release work | Before handing it to other server owners |

---

## 10. Questions for you

1. **Ticket key for players:** F1 (rebindable), a chat command, or both?
2. **Who can open tickets:** everyone, or whitelisted players only? A cooldown? One open ticket per category?
3. **Player visibility:** should players see which admin answered them (name), or just "Admin"?
4. **Refunds from tickets:** may any admin refund, or only some groups (approval for others, as in the portal)?
5. **Heatmaps in game:** all admins, or a separate permission? (They show where players are active.)
6. **Ban from game:** BattlEye ban only, or also a Discord ban for linked users, as the bot does?
7. **Admins without the app open:** should in-game tickets still queue when the app isn't running? (The plan
   says yes: they wait in the file until the app reads them.)
