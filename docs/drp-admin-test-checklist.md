# DRP_Admin — in-game test checklist

Everything below is built and compiles but has not been tried in game. Work through it on the Developer Tools test
server (admin mode on: **U**, menu: **I**). Note what fails and what feels wrong; screenshots help.

The Admin Tool side runs in the **Test instance** (`C:\DayZServers\Test`, started from the dev code), which reads
the test server's folder. Things marked *(real server)* need your main server with the Admin Tool's server mod.

## Tickets (step 4)
- [ ] Die (any way), press **K**, make an "I died / lost gear" ticket.
- [ ] Menu → **Tickets**: the ticket appears within ~10 s; the reporter, Steam64 and GUID are filled in.
- [ ] **Death details** opens the Death window: cause, killer, weapon, hits, gear list. **TP to death spot** works.
- [ ] **Context & admin log**: history, alerts, and admin log lines (the "after" lines fill in about a minute later).
- [ ] Type a reply and press **Enter**, and once with **Send reply**: the player side (K) shows it signed "Admin".
- [ ] App (Test instance) → Tickets: the same ticket with Death, Player history, Admin log sections.

## Map layers (step 5)
- [ ] Map window: the layers panel on the right. **Heat** cycles travel / hits / building / logins; cells shade
      blue → red where you have been.
- [ ] **Time** cycles 1 h / 24 h / 7 d. **Deaths** shows marks coloured by cause; click one for its text.
- [ ] **Vehicle spawns**, **Territories** (if DRP_Factions has claims), **Loot zones & caches**, **Open tickets**
      (click a ticket mark twice to open it).
- [ ] Select a player, **Selected player's trail**: a cyan line of the last 30 minutes.
- [ ] **Where does an item spawn?**: type `AKM`, Enter; buildings marked within ~10 s.
- [ ] Drag another window over the map: does the heat shading stay under it? (the one uncertain part)

## Moderation (step 6)
- [ ] Player info → **Moderate...**: add yourself to the watchlist (reason required) → Player info shows WATCHED;
      the app's Statistics page shows the entry.
- [ ] Whitelist / priority add and remove: the app answers in ~10 s.
- [ ] Ban (needs a second player or a test account): kicked at once, refused on reconnect, timed ban expires.
- [ ] Approvals: give a portal group an approval rule (e.g. Items by class name), link your Steam64 to a user in it,
      spawn something → "needs approval"; approve on the portal → it spawns.

## Delete tool
- [ ] Cheats → **Delete tool** on, aim at a fence / crate / car, press **Delete**: the dialog names it; **Cancel**
      and **Esc** do nothing; **Delete** removes it.
- [ ] A gate with a lock: **Remove the lock only** removes just the lock.
- [ ] Aim at a map building or a player: refused with a message.

## Freecam and spectate
- [ ] **Insert**: fly (WASD, Q/E, Shift fast, walk key slow, camera-tool speed keys). The world loads around you
      far away. **Insert** again: back in your body.
- [ ] **Leave freecam: my body here** puts the body under the camera.
- [ ] While in freecam: **H** teleports the body, the spawner's "Where I look" spawns there, Delete tool works.
- [ ] Player info → **Spectate** (second player): orbit with the mouse, W/S distance, close = first person; follows
      after they respawn. **Stop spectating** leaves you in free flight.
- [ ] Turn admin mode off while in freecam: you get your body back.

## Editor
- [ ] Toolbar → **Editor**: name a set, **New set**; search `Land_Wall`, pick one; **Place where I look**.
- [ ] Nudge, turn, pitch, roll, **Snap to ground**, **Move to aim**, **Duplicate**, **Delete object**.
- [ ] **Select what I aim at** on an object of the set selects it.
- [ ] **Switch off** removes the set's objects, **Switch on** brings them back. Restart the server: sets that were on
      come back once (no doubles).
- [ ] **Export**: `profiles/DRP_Admin/editor/export_<map>_<set>.c` and `.json` appear.

## Vehicles from the map, ESP
- [ ] Map: right-click a vehicle → Repair, Refuel, Flip upright, Teleport to it, Bring it here, Invulnerable,
      Delete (two clicks).
- [ ] Toolbar → **ESP**: on; players and vehicles labelled with distance; turn on creatures / base / items; the
      range bar shortens and lengthens the list.

## Step 7 tools and live items
- [ ] Make a kit on the app's Kits page; Item spawner → **Kits** lists it (written within a minute); spawn it into
      your inventory, at your feet, into another player's.
- [ ] Player info → **Copy position**; Cheats → **Copy my position** (also in freecam: the camera's position).
- [ ] Bring a player who is in a vehicle: the vehicle comes too.
- [ ] Hold a damaged, half-full canteen of beer: Cheats → **Duplicate in hands** copies it as it is.
- [ ] Aim at a tent or crate, Item spawner → **Into what I look at**.
- [ ] Admin menu open: arrange windows, **Ctrl+3**; move them; **3** puts them back.
- [ ] *(real server)* Map → type `AKM`, **Where are they now?**: marks and "AKM now: N (nominal, min)".
- [ ] **Wipe it on the ground**: two clicks; only loose ones within 300 m go.

## Spawner
- [ ] A canteen or barrel: **Liquid** lists the 8 liquids (crude oil with DRP_Industry); **Full %** sets the amount;
      **Temperature** presets.

## Heal and cure
- [ ] Player info → give yourself a sickness, then **Cure sicknesses**: the sickness does not come back.
- [ ] **Heal fully** after being hurt, bleeding, broken legs, sick: all gone.
- [ ] *(real server)* App → Player database → **Heal everything** / **Cure diseases** (bridge v7).
