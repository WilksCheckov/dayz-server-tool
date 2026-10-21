# DayZ Server Tool

A small Windows desktop app (Electron) for running a DayZ Standalone dedicated server.

## Features

- **Install & update** the DayZ server through SteamCMD (downloaded automatically on first use). Stable or Experimental branch.
- **Start / stop / restart** the server with configurable launch parameters, optional auto-restart on crash, and a live console.
- **Config Editor**: a file browser for serverDZ.cfg, BattlEye config and every XML/JSON/C file in the active mission, with syntax highlighting, search (Ctrl+F), save (Ctrl+S, keeps a `.bak`), and a **Check for errors** debugger. It validates syntax and DayZ rules: serverDZ.cfg keys, types and ranges; types.xml (nominal/min, quantmin/max, flags, categories/usages/values/tags against cfglimitsdefinition.xml, duplicates); events.xml (min/nominal/max, name prefixes, child types that exist); cfgeconomycore.xml (folders and files exist); cfgspawnabletypes.xml (items exist, chances 0..1); cfgeventspawns.xml; globals.xml; messages.xml; cfggameplay.json; init.c (brace balance, main, CreateCustomMission); BEServer_x64.cfg. **Check all files** runs everything plus server-level checks (missing mission files, mods without folders or keys).
- **Workshop mods**: browse the Steam Workshop inside the app, add a mod with one click (or paste an ID/URL), download it with SteamCMD, link it into the server folder as `@ModName`, copy `.bikey` files to `keys\`, set load order, mark server-side-only mods, check for and apply updates.
- **Logs**: list `.RPT` / `.log` / `.ADM` files from the profiles folder, follow them live, filter, and get an **error summary** that groups repeated errors by category (crash, script error, mod/PBO, network/BattlEye, mission/config, warnings) with a one-line verdict.
- **Update checks**: the tool asks Steam for the latest server build and compares every mod's workshop timestamp on a schedule (hourly by default). The Dashboard shows a notice with an "Update now" button when the server or any mod is out of date.
- **Auto update timetable**: scheduled update runs at fixed daily times or every N hours. With "only when out of date" on, a slot checks first and leaves the server running if nothing changed; otherwise it warns players (RCon), stops, installs the server and mod updates, and restarts.
- **Dependencies**: adding a mod installs everything it requires, and everything those require, all the way down, placed above it in load order. "Check updates" re-reads requirements so newly added ones are flagged, and removing or disabling a mod warns when other mods depend on it.
- **Backups**: zip backups named `backup_YYYY-MM-DD_HH-MM-SS_<label>.zip` of mpmissions, profiles, config and optionally keys. Run them manually, on a schedule, or before each scheduled restart. Keeps the newest N, and can restore one (a safety backup is taken first).
- **Scheduled restarts**: at fixed daily times (e.g. `04:00, 16:00`), every N hours of uptime, or both, with an optional backup before each restart.
- **Workshop viewer**: a built-in browser for the DayZ workshop (no API key): search, sort (trending, most subscribed, recently updated, newest, top rated), tag filters, cards with subscribers / size / last update, a details panel with the description and required items, tick-to-select with "Add selected", and pasting a collection URL adds every item in it.
- **Launch lines**: the Mods page shows the generated `-mod=` (from the enabled mods in list order), `-serverMod=` (a manual list you type, followed by mods flagged server-only), local mods, and other parameters, each with Copy. Auto-organize puts frameworks first (CF, Dabs, COT, Expansion, VPP) and then sorts by dependencies. The mod list is grouped into -mod, -serverMod and local sections; dragging between sections moves a mod. Workshop items tagged "Server" go into -serverMod automatically when installed. Every change rewrites `start_server.bat` (full command line) and `modlist.txt` in the server folder, so the server can be started without the tool.
- **Smoother mods**: adding a mod reads its "Required items" from the workshop page and offers to add the dependencies above it in load order; downloads are queued with per-mod progress; drag to reorder; Auto-sort fixes dependency order; Import found picks up mods already on disk (junctions, copied folders or local `@mods`); a banner reminds you to restart when the mod list changed while the server is running; Steam login is asked inline when needed.

### Server Management

- **Players & RCon**: a built-in BattlEye RCon client. Connect with the password/port from `battleye\BEServer_x64.cfg`, see online players (name, GUID, IP, ping, lobby/in-game), message, kick or ban them, broadcast to everyone, run raw RCon commands, and watch server messages live. A "Recent players" table is parsed from the admin logs (`-adminlog`) with one-click ban / whitelist / priority.
- **Bans**: manage `profiles\ban.txt` (game bans by Steam64 or DayZ ID) and `battleye\bans.txt` (GUID/IP bans with duration and reason), with names and notes kept by the tool. "loadBans via RCon" reloads BattlEye bans without a restart.
- **Whitelist** and **Priority queue**: manage `whitelist.txt` and `priority.txt` on their own pages, with a banner showing whether `enableWhitelist` is on in serverDZ.cfg.
- **Discord Bot**: a built-in bot (discord.js) you add to your own Discord server, modelled on the standalone whitelist bot. Paste a bot token, server ID and admin channel ID, start it, and it registers slash commands:
  - `/application` posts a Whitelist Application button. Applicants fill in SteamID64, character name, biography, bans and rules; the bot checks VAC/trade bans via the Steam API (optional key) and posts an embed in the admin channel with Accept / Decline / Steam Profile. Accept whitelists them (DayZ ID written to whitelist.txt with a `//SteamID64 … - DiscordID …` comment), gives the whitelist role and nicknames them after their character; Decline asks for a reason and DMs them.
  - `/ban permanent|temporary` (by Steam64 or Discord user) prompts for a reason, removes the whitelist, writes ban.txt, bans or times out the Discord account, and posts a ban notice with an Unban button. Temporary bans expire automatically. `/ban battleye`, `/ban remove`, `/ban list`, `/bantime` (players check their own ban).
  - `/whitelist`, `/priority` add/remove/list, `/search` player dossier, `/players`, `/kick`, `/say`, `/status`, `/server start|stop|restart`, `/backup`, `/help`.
  - `/mute add|remove|list`: a Discord-only mute that gives the muted role for a duration (`30m`, `2h`, `3d`, `1w`) and takes it away when the time is up.
  - **Roles**: optional whitelist, priority, banned and muted role IDs. The bot gives and removes them as people are whitelisted, put on the priority queue, banned or muted, and re-checks everyone against the list files every 5 minutes, so bans and mutes lose their role at the end of the sentence and edits made in the app or in the files are reflected in Discord.
  - Only server Administrators or configured admin roles can use admin commands. The bot's status shows online/offline and the live player count with a configurable format ("Server Online | 12/60 Players"). Optional: post every action to a log channel, and stream new ADM/RPT log lines live to a channel (batched, errors-only filter).
- **List files**: whitelist.txt, priority.txt and ban.txt store the DayZ ID (sha256 of the Steam64, base64 URL-safe) followed by a comment with the Steam64, Discord ID, name and reason, the same format the standalone bot used, so existing files keep working.
- **Website**: a public site served by the tool itself (Integrations → Website). Home page with online/offline status, player count, uptime, next restart, join address and Discord link; a mods page with workshop links; custom pages written in Markdown or raw HTML; JSON at `/api/status.json` and `/api/mods.json`. Fully customisable: files added to `<install dir>\website\` are served as-is (images, fonts, extra pages), and `template.html` (placeholders `{{site}} {{title}} {{nav}} {{content}} {{year}}`), `index.html`, `site.css`, `mods.html` or `<slug>.html` replace the generated layout, home page, stylesheet or any page. Starter files can be created from the app. **Bring your own site**: drag a folder or .zip of any static site (hand-written, or a React/Vue/Hugo/Astro build output; the tool finds the folder with index.html, including dist/build/public) onto the Website page and it is installed and served. Your site wins for every path it defines; anything else falls back to the generated pages and the API, and a `404.html` in your site is used for missing pages. Add `<script src="/dayz-status.js"></script>` and `data-dayz="online|players|max|uptime|next-restart|mods-count"` attributes (or `data-dayz-list="mods|players"` on a list) to show live server data. Forward the port on your router to publish it.
- **Restart warnings**: when RCon is connected, scheduled restarts announce themselves in-game at configurable minute marks (default 15, 5, 1) and right before the restart.

## Operations features

- **Health**: CPU, memory, server FPS (from the RPT) and player count sampled every 10 s while the server runs, kept for 24 h and drawn as sparklines on the Dashboard.
- **Alerts** (Maintenance → Alerts): every notable event (crash, crash loop, restart, backup failure, update result, low FPS, high memory, RCon lost, bot offline) can go to a Windows toast, the Discord bot's alert channel and/or a Discord webhook, with thresholds you set. A crash loop (3 unexpected exits in 10 min by default) pauses auto-restart until you start the server by hand.
- **Crash reports** (Logs → Crash reports): an unexpected exit zips the newest RPT/ADM/dump/script logs, the config and the launch line into `crashes\crash_<time>.zip` with a JSON summary and the log analyser's verdict; post it to Discord with one click.
- **Steam ban checks**: with a Steam Web API key set on the Discord Bot page, every Steam64 the tool knows (lists, applications, player database) is checked for VAC, game, trade and community bans and profile privacy, once a day and on demand ("Check Steam bans" on the Database page, `/maintenance` in Discord). Results show as badges on the Database, Bans, Whitelist and Priority pages and on the application embeds, which are refreshed like the old bot's maintenance pass. A player who picks up a new ban raises a "Steam ban" alert.
- **Discord role check**: the Database page shows which of the configured whitelist / priority / banned / muted roles each linked Discord member holds, and flags mismatches with the list files.
- **Player database** (Players → Database): every player seen in the admin logs with name history, first/last seen, sessions and playtime, kills/deaths, last position and notes, joined with the whitelist/ban lists and Discord applications. Search, sort, quick ban/whitelist/priority/mute. `/search` in the bot shows playtime, last seen and K/D.
- **Economy editor** (Server → Economy): table editors for `types.xml` (vanilla and CE-registered custom files), `events.xml` and `cfgspawnabletypes.xml`. Filter by name/category/usage/tier/tag, edit numbers inline, pick flags from `cfglimitsdefinition.xml`, select rows and bulk set/multiply/add values or add/remove flags, then Save (keeps a `.bak`, validates, lists problems). Files are written in the exact layout the server expects.
- **Settings**: keep running in the tray with start/stop/restart/backup from the tray menu, start minimised, launch at Windows login, export/import settings, and self-update from GitHub Releases (set `build.publish` in package.json to your repo and publish with `npm run release`, which needs a `GH_TOKEN`).

## More operations features

- **Auto-start**: Settings → "Start the DayZ server automatically when the tool starts", with a delay. Combined with "Launch when Windows starts" and auto-restart on crash, a rebooted machine comes back on its own.
- **Mission** (Server → Mission): list missions in `mpmissions\`, switch the active one (updates serverDZ.cfg), full wipe or characters-only wipe with a backup first and a typed confirmation, and a form editor for `cfggameplay.json`.
- **Tasks** (Maintenance → Tasks): scheduled in-game messages, RCon commands, backups, updates, restarts, start/stop, or any command line, at daily times or on an interval.
- **Network** (Maintenance → Network): the ports the server uses and whether something is listening, your public IP, and one-click Windows firewall rules (asks for admin rights).
- **Off-site backups** (Backups page): after each backup, copy it to another folder (OneDrive, NAS…) and/or upload by FTP/FTPS, with remote retention.
- **Check mods** (Installed page): duplicate PBOs across mods, missing or uncopied keys, unlinked folders, verifySignatures, plus a ready-to-paste "players need these mods" list with workshop links.
- **Server profiles** (top bar + Settings): separate settings per server instance; switching restarts the tool.
- **Remote admin panel**: enable `/admin` on the Website page with a password to start, stop, restart, back up, broadcast and kick from a phone.
- **Map** (Players → Map): last known player positions from the admin log. The map and world size are detected from the active mission template (Chernarus, Livonia, Sakhal, Namalsk, Deer Isle and others). Put an image named after the map, e.g. `chernarusplus.png`, in `<install dir>\maps\` (or use "Set map image") and positions are drawn on it.
- **Server settings form** (Server → Launch): the common serverDZ.cfg keys (name, passwords, max players, whitelist, signatures, voice, third person, time and acceleration, MOTD, logging) as a form. Values are written in place, so comments and the rest of the file are untouched; a `.bak` is kept.
- **Launch flags** as checkboxes: -dologs, -adminlog, -netlog, -freezecheck and -limitFPS. The FPS graph needs -dologs; the player database, map and Discord feeds need -adminlog.
- **Remembered Steam password** (Installation page, opt-in): stored encrypted with your Windows account (Electron safeStorage) so scheduled mod updates keep working after the tool restarts. A "Steam Guard code needed" alert fires if SteamCMD asks for a code.
- **Backup before updates**: the update timetable takes a backup before installing (on by default). Backups can also include the tool's own data (settings, player database, Discord applications and bans, Steam ban results).
- **Log cleanup** (Logs page): delete RPT / ADM / log / dump files older than N days after each server start, keeping the newest of each kind. "Clean now" runs it immediately.
- **Server browser check** (Network page): a Steam A2S query against localhost and your public IP shows whether the server is visible from the internet, with the name, map and player count it reports.
- **Scheduled wipes** (Tasks): "Full wipe" and "Character wipe" task types warn players, stop the server, back up, wipe and start again.
- **Tickets** (Discord): `/ticketpanel` posts an "Open a ticket" button; each ticket gets a private channel under the configured category, visible to the opener, the admin roles and the bot. Close it with the button or `/ticket close`; a transcript is posted to the ticket log channel and the channel is deleted. `/ticket add` brings someone else in, `/ticket list` shows open ones.
- **Kill feed and join feed** (Discord): kills, deaths, joins and leaves parsed live from the admin log are posted to channels you pick, batched every few seconds.
- **Web admin password** is stored as a salted hash.
- **Running unattended**: "Launch when Windows starts" needs a logged-in Windows session, so on a dedicated box enable automatic login for the account that runs the tool (or run the tool from a scheduled task "at log on") and keep it in the tray. The tool itself is not a Windows service.
- **Themes and shortcuts**: dark or light theme in Settings; Ctrl+1…9 jump to pages, F5 refreshes the page, Ctrl+K goes to a page by name.

## Layout

Sidebar: **Dashboard**, then **Server** (Installation, Launch, Config Editor, Logs), **Mods** (Workshop, Installed), **Maintenance** (Updates, Backups, Restarts), **Players** (Online, Bans, Whitelist, Priority queue) and **Integrations** (Discord Bot). The top bar shows the page title and live pills for the server, RCon and the Discord bot.

## Run from source

```bash
npm install
npm start
```

## Build an installer

```bash
npm run dist
```

Output lands in `dist\` (NSIS installer and a portable exe).

## Notes

- The server app installs with an anonymous Steam login. Workshop mods require a Steam account that owns DayZ; enter it on the Install page. The password is kept in memory only.
- Mods are stored under `<install dir>\steamcmd\steamapps\workshop\content\221100\<id>` and linked into `<install dir>\server\@Name` with a directory junction, so no files are duplicated.
- Settings live in `%APPDATA%\dayz-server-tool\settings.json`.
- Open the server port (default 2302 UDP, plus 27016 UDP for Steam query) in the Windows firewall and router.
