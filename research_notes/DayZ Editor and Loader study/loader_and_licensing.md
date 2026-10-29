# DayZ Editor Loader: how it works on a dedicated server, and licensing (DayZ Editor, Loader, Dabs Framework)

Research date: 2026-10-28. Code was read from shallow clones of the GitHub default branches:
- Loader: https://github.com/InclementDab/DayZ-Editor-Loader, branch `main`, last commit `83e78fb4` (2025-08-21, "auto mapgrouppos export"). The Workshop item was updated after that (2025-08-30, 2025-09-01), so the published PBO may be slightly newer than GitHub (see the config-key conflict below).
- Dabs Framework (DF): https://github.com/InclementDab/DayZ-Dabs-Framework, branch `production`, HEAD `2451902` (2026-10-07). The repo `InclementDab/DabsFramework` does not exist (404); the real one is `DayZ-Dabs-Framework`.
- DayZ Editor: https://github.com/InclementDab/DayZ-Editor, default branch `legacy`, HEAD `a55ec49` (2026-10-25).

Main file: https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c (258 lines; the whole current Loader is this one file plus config.cpp).

## Q1. How the Loader finds and loads .dze files and spawns objects

### Takeaway
The current Loader is a single `modded class MissionServer`. In `OnMissionStart()` (after `super`, so after init.c `main()` and the CE/Hive init), it creates `$mission:\EditorFiles` and recursively enumerates `*.dze` files in it (depth 5). It reads each file as DF's binary format or JSON. It hides the deleted map objects and then spawns the objects. Script class names go through `CreateObjectEx(type, pos, ECE_SETUP | ECE_UPDATEPATHGRAPH | ECE_CREATEPHYSICS)` and raw `.p3d` paths go through `CreateStaticObjectUsingP3D`. These are networked, non-persistent objects, re-created on every restart. The pathgraph is rebuilt once in a batch at the end.

### Cited Findings
- **Folder:** `ROOT_DIRECTORY = "$mission:\\EditorFiles"`, which is the mission folder, not profiles. The code calls `MakeDirectory(ROOT_DIRECTORY);` and then `Directory.EnumerateFiles(ROOT_DIRECTORY, "*.dze", 5);` — [MissionServer.c L8, L68-70](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c)
- **History of the folder location:** the commit "changed EditorFiles from profiles to mission" (cc393a9c, 2021-09-06) and the commit "Added recursive folder search so you can have dze files in folders" (65d74565, 2021-09-06) — [commit list](https://github.com/InclementDab/DayZ-Editor-Loader/commits/main). The Workshop change note of Oct 5, 2021 (v1.32) says .dze files moved to the mission folder — [Workshop changelog p3](https://steamcommunity.com/sharedfiles/filedetails/changelog/2276010135?p=3)
- **Workshop instructions:** load the mod on the server, which generates an "EditorFiles" folder in the server's Mission Folder. Place the .dze files there; the client Editor saves them in its "profiles/Editor folder". Then run the server — [Workshop page 2276010135](https://steamcommunity.com/sharedfiles/filedetails/?id=2276010135)
- **Timing:** the code is `override void OnMissionStart() { super.OnMissionStart(); ScopedFunctionTimer function_timer("EditorLoader::MissionStart"); ...`. DF's own `MissionServer.OnMissionStart` schedules `AfterHiveInit` via `CallLater(AfterHiveInit, 0, false)`, commented "Called immediately after main() is done, CLE is initialized by this point" — [Loader MissionServer.c L62-66](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c); [DF MissionServer.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/5_Mission/DabsFramework/Mission/MissionServer.c)
- **Extensibility hook:** `void LoadCustomBuilds(inout array<string> custom_builds) {} // making this into a semi-colon deletes the array`. Other mods can override this to append packed .dze paths. Legacy alias: `typedef MissionServer EditorLoaderModule;` — [MissionServer.c L2, L12, L72-73](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c)
- **Format detection:** `if (EditorSaveData.IsBinnedFile(file)) { save_data = LoadBinFile(file); } else { save_data = LoadJsonFile(file); }`. The binary reader uses `FileSerializer` + `EditorSaveData.Read`, and JSON uses `JsonSerializer.ReadFromString`. `EditorSaveData` lives in Dabs Framework (`_Legacy/Editor/EditorSaveData.c`), which has the magic string `BIN_CHECK = "EditorBinned"`, `static const int Version = 8;`, and the fields `MapName, AuthorId, CreditIds, LastModified, CreationDate, CameraPosition, EditorObjects, EditorHiddenObjects, CameraTracks` — [Loader L85-89](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c); [DF EditorSaveData.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/EditorSaveData.c). The sample file `Missions/EditorLoader.ChernarusPlus/EditorFiles/TestingDab.dze` in the Loader repo begins with the string `EditorBinned` followed by `ChernarusPlus` (observed in the clone).
- **Order:** deletions first, then creations, per file. Comment: `// Create and Delete buildings on Server Side` — [L82-111](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c)
- **Spawn code (current, verbatim):**
  ```c
  if (editor_object.EditorOnly || editor_object.Type == string.Empty) { continue; }
  ...
  if (File.WildcardMatch(object_typename, "*.p3d")) {
      object_typename = object_typename.Trim();
      object_typename.Replace("\/", "\\");
      obj = GetGame().CreateStaticObjectUsingP3D(object_typename, editor_object.Position, editor_object.Orientation, editor_object.Scale, false);
  } else {
      obj = GetGame().CreateObjectEx(object_typename, editor_object.Position, ECE_SETUP | ECE_UPDATEPATHGRAPH | ECE_CREATEPHYSICS);
  }
  ...
  // disabled for letting 40mm in
  //obj.SetAllowDamage(editor_object.AllowDamage);
  obj.SetOrientation(editor_object.Orientation);
  obj.SetScale(editor_object.Scale);
  obj.Update();
  EntityAI ent;
  if (EntityAI.CastTo(ent, obj) && !editor_object.Simulate) { ent.DisableSimulation(!editor_object.Simulate); }
  SerializedBuilding networked_object = SerializedBuilding.Cast(obj);
  if (networked_object) { networked_object.Read(editor_object.Parameters); }
  ```
  — [MissionServer.c L111-149](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c)
- **Pathgraph:** `GetGame().GetWorld().ProcessMarkedObjectsForPathgraphUpdate();` runs once after all files are processed — [L155](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c). The commit "Batch update pathgraph, use dynamic persistence" (9a78439f, 2023-06-04, PR #9 from wrdg) introduced the batching — [commits](https://github.com/InclementDab/DayZ-Editor-Loader/commits/main)
- **Flag history:** the June 2023 version (commit 64a7226c) used `CreateObjectEx(editor_object.Type, editor_object.Position, ECE_SETUP | ECE_CREATEPHYSICS | ECE_NOLIFETIME | ECE_DYNAMIC_PERSISTENCY)` plus `GetGame().GetWorld().MarkObjectForPathgraphUpdate(obj);`. It also skipped types with `CfgVehicles <type> scope < 1`. The current code dropped `ECE_NOLIFETIME | ECE_DYNAMIC_PERSISTENCY`, swapped in `ECE_UPDATEPATHGRAPH`, and removed the scope check — [2023 MissionServer.c L166-182](https://raw.githubusercontent.com/InclementDab/DayZ-Editor-Loader/64a7226c/DayZEditorLoader/Scripts/5_Mission/DayZEditorLoader/Mission/MissionServer.c). The Workshop change note of Jun 9, 2023 reads "Fixed for 1.21 persistency changes" — [changelog p2](https://steamcommunity.com/sharedfiles/filedetails/changelog/2276010135?p=2)
- **Static p3d support:** the change notes say "Added support for static objects" (Nov 9, 2024), "Fixes for static object placement" (Nov 16, 2024) and "Fixed placement and collision of p3d objects" (Aug 30, 2025) — [changelog p1](https://steamcommunity.com/sharedfiles/filedetails/changelog/2276010135)
- **mapgrouppos.xml auto-export (Aug 2025):** after spawning, if `GetHive() && FileExist(proto_file) && !GetGame().ServerConfigGetInt("disableAutoMapGroupPosExport")`, the Loader scans `GetObjectsAtPosition3D(vector.Zero, 100000, objects, null)`. It keeps the types that appear as `<group name=...>` in `mapgroupproto.xml`, skips suppressed objects (`if (GetDayZGame().GetSuppressedObjectManager().IsSuppressed(world_object)) continue;`), and rewrites `$mission:\mapgrouppos.xml` — [L160-222](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c)

### Inferences
- The objects are ordinary networked entities, so every client receives them through normal network replication. No `ECE_LOCAL` is used, and nothing spawns per client. They are not saved to storage: the Loader re-creates them on every boot, and `.dze` is the source of truth. Without `ECE_NOLIFETIME`, an `ItemBase` placed through the Loader could in principle be subject to CE lifetime cleanup. Buildings and statics (House or static p3d) are unaffected. This is inferred from the flags and has not been tested.
- `CreateStaticObjectUsingP3D(..., false)` is used for raw p3d paths. Whether its last argument means "local" (non-networked) could not be confirmed from the source. If the object is server-only, clients would not see it unless the engine replicates statics. **Gap.**
- Because loading happens in `OnMissionStart` after `super`, CE has already initialised and the Hive is loaded. This explains why loot positions for new or deleted buildings need the separate mapgrouppos export plus a restart.

### Gaps
- The exact semantics of the bool parameter of `CreateStaticObjectUsingP3D` were not verified against BI docs.
- The Loader's own `config.cpp` lists a `gameScriptModule` path (`EditorLoader/scripts/3_Game`) that has no files in the repo. This is harmless but shows the repo is not exactly the packed PBO.

## Q2. How it deletes or hides static map objects, and why the client side matters

### Takeaway
The Loader no longer calls `ObjectDelete`. For each hidden-object record it finds the live map object at the saved position (radius 0.1 m, matched by model/shape name, with a fallback to type). It then calls `GetDayZGame().GetSuppressedObjectManager().Suppress(obj)` from Dabs Framework. DF "suppresses" the object: it scales it to 0.000001, clears its flags and event masks, sets `NOTVISIBLE`, destroys its physics body (`dBodyDestroy`) and updates the pathgraph region. The server then sends an RPC carrying the object references to all clients, and re-sends the full list to each player on connect (JIP), so each client suppresses its own local copy. Clients need this because static map objects are baked into the terrain/world file that every client loads locally. They are not network-replicated entities, so a server-side delete or hide does not propagate.

### Cited Findings
- **Loader call site (verbatim):**
  ```c
  foreach (EditorDeletedObjectData deleted_object: save_data.EditorHiddenObjects) {
      Object deleted_obj = deleted_object.FindObject();
      if (deleted_obj) {
          deleted_objects_list.Insert(deleted_obj);
          GetDayZGame().GetSuppressedObjectManager().Suppress(deleted_obj);
      }
  }
  //GetDayZGame().GetSuppressedObjectManager().SuppressMany(deleted_objects_list);
  ```
  — [MissionServer.c L99-107](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c). Because the batch `SuppressMany` is commented out, one RPC is sent per object.
- **Finding the object (DF `EditorDeletedObjectData.FindObject`):**
  ```c
  Object FindObject(float radius = 0.1)
  {
      array<Object> objects = {};
      GetGame().GetObjectsAtPosition3D(Position, radius, objects, null);
      string model_name_formatted = ModelName; model_name_formatted.ToLower(); ...Replace("/", "\\");
      foreach (Object object: objects) {
          string shape_name = object.GetShapeName(); ...
          // New way of doing it
          if (model_name_formatted && model_name_formatted == shape_name) { return object; }
          // Deprecated
          string type; g_Game.ObjectGetType(object, type);
          if (type == Type) { return object; }
      }
      return null;
  }
  ```
  A deleted record stores `Type` (deprecated), `ModelName`, `Position` and `Flags` — [DF EditorDeletedObjectData.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/EditorDeletedObjectData.c)
- **The suppression technique (DF `SuppressedObject` constructor, verbatim):**
  ```c
  m_PhysicsMask = dBodyGetInteractionLayer(object);
  m_Flags = object.GetFlags();
  m_Events = object.GetEventMask();
  object.GetTransform(transform); copyarray(m_Transform, transform);
  //object.SetPosition(Vector(0, -100, 0) + object.GetPosition());
  object.SetScale(0.000001);
  object.ClearFlags(m_Flags, true);
  object.ClearEventMask(m_Events);
  object.SetEventMask(EntityEvent.NOTVISIBLE);
  object.Update();
  // for now, this might be kinda fucked because objects that are un-deleted may not get their physics back.
  // but its required since calling SetScale(0) will absolutely destroy the heap
  // and calling SetScale(0.000001) leaves a small piece of geometry for you to step on.
  // and calling SetTransform() or SetPosition() leaves a client ghost
  dBodyDestroy(object);
  g_Script.CallFunction(object, "DF_OnDeletedFromWorld", null, null);
  if (m_UpdatedPathgraph) { ... g_Game.UpdatePathgraphRegion(m_Transform[3] - radius_vector, m_Transform[3] + radius_vector); }
  ```
  The destructor restores flags, event mask and transform, but `//object.CreateDynamicPhysics(m_PhysicsMask);` is commented out with "todo: crashes. un-deleted objects dont get their physics back" — [DF SuppressedObject.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/Suppression/SuppressedObject.c). These comments are the author's own evidence of which alternatives fail: SetScale(0) corrupts the heap, a tiny scale leaves collision, and SetPosition/SetTransform leaves a client "ghost".
- **What can be suppressed:** `if (object.IsKindOf("House") || object.IsTree() || object.IsBush() || object.IsRock()) return true; return (object.GetType() == string.Empty) && (object.Type() == Object);`. That covers houses, vegetation, rocks and untyped static p3d objects — [DF SupressedObjectManager.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/Suppression/SupressedObjectManager.c)
- **Server-to-client sync (verbatim excerpts):**
  ```c
  static const int RPC_SUPPRESS = -135295235;
  ...
  void SuppressMany(notnull array<Object> objects, bool inform_clients = true) {
      ScriptRPC rpc = new ScriptRPC(); rpc.Write(objects.Count());
      for (...) { if (!IsSuppressible(objects[i])) { rpc.Write(null); continue; }
          rpc.Write(suppress); auto suppressed_object = new SuppressedObject(suppress); ... }
  #ifdef SERVER
      if (inform_clients) { rpc.Send(null, RPC_SUPPRESS, true); }
  #endif
  }
  void DispatchInfo(PlayerIdentity identity = null) {
  #ifdef SERVER
      ScriptRPC rpc = new ScriptRPC(); rpc.Write(m_Objects.Count());
      foreach (SuppressedObject object: m_Objects) { rpc.Write(object.GetObject()); }
      rpc.Send(null, RPC_SUPPRESS, true, identity);
  #endif
  }
  ```
  The client side (`#ifndef SERVER`) `OnRPC` reads each `Object` and constructs a `SuppressedObject` locally — [DF SupressedObjectManager.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/Suppression/SupressedObjectManager.c). Static map objects are written to the RPC directly as `Object` references, so the engine resolves them on the client by their static map ID.
- **JIP handling:** DF `modded class MissionServer` → `InvokeOnConnect(...)` calls `supressed_object_manager.DispatchInfo(identity);` on every connect — [DF MissionServer.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/5_Mission/DabsFramework/Mission/MissionServer.c)
- **Manager creation:** in DF `modded class DayZGame` the constructor contains `if (IsDedicatedServer() || !IsMultiplayer()) { m_EventManager = new EventManager(); m_SuppressedObjectManager = new SuppressedObjectManager(); }` — [DF DayZGame.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/!Core/DayZGame.c)
- **The previous technique (2021–2023), useful for comparison:** the server called `ObjectRemover.RemoveObject(deleted_obj)`. `OnPlayerJoined` → `SendClientData(identity)` sent the `EditorDeletedObjectData` records (type, position, model), not object references, in "packages of 100" via `RPC_REMOTE_DELETE_BUILDING = -34293538`. Each client ran `ObjectRemover.RemoveObject(deleted_building.FindObject());` itself, and `MissionGameplay.OnMissionFinish` called `ObjectRemover.RestoreAllMapObjects()` — [2023 MissionServer.c](https://raw.githubusercontent.com/InclementDab/DayZ-Editor-Loader/64a7226c/DayZEditorLoader/Scripts/5_Mission/DayZEditorLoader/Mission/MissionServer.c); [2023 DayZGame.c](https://raw.githubusercontent.com/InclementDab/DayZ-Editor-Loader/64a7226c/DayZEditorLoader/Scripts/3_Game/DayZEditorLoader/DayZGame.c). The commit "Swapped over to using DF ObjectRemover instead of CF ObjectManager" (00d006e0, 2021-07-15) shows that the earliest versions used Community Framework's ObjectManager (`CF.ObjectManager.HideMapObjectsInRadius`, still visible as dead comments in the 2023 `ObjectRemover.c`) — [commits](https://github.com/InclementDab/DayZ-Editor-Loader/commits/main)
- **DF commit history of the suppression system:** "The classic method" and "Fixing the damn suppressed object system" (2025-07-14), and "last patch fixes" (2025-07-16) — [DF commits for SuppressedObject.c](https://github.com/InclementDab/DayZ-Dabs-Framework/commits/production/DabsFramework/Scripts/3_Game/DabsFramework/Suppression/SuppressedObject.c)
- **Workshop claims:** "Only mod that implements deletions", deleting about 40k objects per second — [Workshop page](https://steamcommunity.com/sharedfiles/filedetails/?id=2276010135). The rival loader's author says "BuildLoader does not support deletions, use dayz editor loader for that" (via search summary of the BuildLoader Workshop comments; the original page was not fetched).

### Inferences
- Why client-side removal is needed: map statics come from the world (.wrp) data that each client loads locally. The server cannot `ObjectDelete` them in a way that replicates, because they are not network entities. Any technique must therefore run on every client, including clients that join later. Both the old record-based RPC and the new object-reference RPC exist for this reason. This is supported by the code structure and the "client ghost" comment, not by a BI doc.
- `IsMultiplayer()` is false while DayZGame is being constructed at game boot (main menu), so the manager probably also exists on MP clients. Otherwise the client RPC handler would never run. This is inferred and has not been verified at runtime.
- Because `Suppress` is called once per object, each deleted object produces one RPC broadcast at server start (when no clients are connected), plus one large RPC per player connect. With thousands of deletions, the JIP RPC is large; whether it hits a size cap was not checked.
- For our own mod, the proven recipe is: find by position + shape name → on server and every client, `SetScale(~0)` + `ClearFlags` + `NOTVISIBLE` + `dBodyDestroy` + `UpdatePathgraphRegion`, re-sent to JIP clients. Avoid `SetScale(0)` (heap) and SetPosition (ghost), per DF's own comments.

### Gaps
- No BI documentation was found that confirms how `Object` references to static map objects serialize over RPC.
- Whether `ObjectDelete` on map statics works on current (1.28+) builds was not tested.

## Q3. Performance and known issues

### Takeaway
Load cost is dominated by the per-deletion `GetObjectsAtPosition3D` lookup and the batched pathgraph update. The author claims about 40k deletions per second. Known issues include Linux directory enumeration (since fixed), loot positions for deleted buildings (handled by the mapgrouppos export), un-suppressed objects that never regain physics, deletions that need re-saving after format changes, and 40mm grenades or bullets getting stuck in builds.

### Cited Findings
- Timing instrumentation exists: `ScopedFunctionTimer function_timer("EditorLoader::MissionStart")` with `Dump` lines for deleted, created and pathgraph steps — [MissionServer.c](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c)
- "Big optimizations" commit 9e56d139 (2025-06-03) — [commits](https://github.com/InclementDab/DayZ-Editor-Loader/commits/main)
- **Linux:** issue #4, "Not finding *.dze files in EditorFiles directory", includes an strace showing that `FindFile` with the pattern `.../EditorFiles/*.dze` fails on Linux. The commit "Fixed for linux and recursion" (aa03f380, 2024-10-10) and the change note "Fixed .dze file loading on Linux" (Oct 9, 2024) address it; the current code uses `Directory.EnumerateFiles` — [issue #4](https://github.com/InclementDab/DayZ-Editor-Loader/issues/4); [changelog](https://steamcommunity.com/sharedfiles/filedetails/changelog/2276010135)
- **Loot in deleted buildings:** issue #6, "ExportLootExperimental = true is generating positions for deleted buildings" (closed 2022). The workaround given was to "use the DayZ Editor to generate the mapgrouppos.xml instead of the server" — [issue #6](https://github.com/InclementDab/DayZ-Editor-Loader/issues/6). The 2025 auto-export now skips suppressed objects via `IsSuppressed` — [MissionServer.c L204](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c)
- **Change notes on issues:** "Fixed bullets and 40mm grenades getting stuck in builds" (v1.34, Jul 22, 2022), which matches the code comment `// disabled for letting 40mm in`. Also "Fixed an exploit that would let cheaters remove buildings on the server" (Feb 8, 2022) and "Implemented safety checks for persistent and non-existent objects" (Nov 28, 2021) — [changelog p2](https://steamcommunity.com/sharedfiles/filedetails/changelog/2276010135?p=2). Earlier notes: "New deletion method that is update-proof and requires re-deleting builds once" (Jul 16, 2021), "Added packet transfer optimization for deleted buildings" (Dec 30, 2020), "Potential fix for client lag in loaded areas" (Dec 15, 2020), "Fixed memory leaks causing access violations" (Jan 9, 2021) — [changelog p3](https://steamcommunity.com/sharedfiles/filedetails/changelog/2276010135?p=3)
- **Recent instability:** "Temporary Reversion until we can stabilize the update" (Aug 22, 2025) and "Fixed crash on launch with invalid objects" (Sep 1, 2025) — [changelog p1](https://steamcommunity.com/sharedfiles/filedetails/changelog/2276010135)
- **Re-appearing deletions:** a Steam user reported that deleted Green Mountain buildings came back after a Dabs Framework update. Separately, an unconfirmed report said deleted objects returned with collision. Both come from search summaries of community threads and are low reliability.
- **Un-suppress:** DF's code admits "un-deleted objects dont get their physics back" — [SuppressedObject.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/Suppression/SuppressedObject.c)
- **Other open issues:** #10 "Import .dze" (open, 2023), #11 "Can't compile Mission script module!" (closed 2024), #2 "Unknown type: 'EditorDeletedObjectData'" (2021). The last one is a DF dependency or version mismatch — [issues](https://github.com/InclementDab/DayZ-Editor-Loader/issues?q=is%3Aissue)

### Inferences
- The loot pipeline needs two restarts. The first boot loads the builds and writes mapgrouppos.xml; CE only reads that file on the next boot, because the export runs after the Hive init.
- Matching depends on the model name plus a 0.1 m position. A map update that moves or renames an object silently breaks a deletion (FindObject returns null and nothing is logged; the log line is commented out). This explains the "re-delete once" notes.

### Gaps
- No quantitative benchmarks beyond the author's 40k/s claim, and no data on JIP RPC size limits.
- Reddit r/dayzservers threads were not retrieved (search returned nothing specific).

## Q4. Configuration and requirements

### Takeaway
The Loader depends on Dabs Framework (`requiredAddons[] = {"DF_Scripts"}`), not on Community Framework; the CF dependency was removed in Feb 2023. DF must be loaded on clients too, because the client-side suppression RPC handler lives in DF. There is no Loader config file; the only knobs are server.cfg `disableAutoMapGroupPosExport` (GitHub) or `enableAutoMapGroupPosExport=1` (Workshop text, which conflicts) and the script statics `ExportProxyData`/`LoadCustomBuilds`.

### Cited Findings
- `config.cpp`: `requiredAddons[] = {"DF_Scripts"};`, with only `gameScriptModule` and `missionScriptModule` — [config.cpp](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/config.cpp)
- Commit "removed CF dependency" (2ff123c9, 2023-02-09) and "Refactored to latest Dabs Framework" (Workshop, Feb 20, 2024) — [commits](https://github.com/InclementDab/DayZ-Editor-Loader/commits/main); [changelog p2](https://steamcommunity.com/sharedfiles/filedetails/changelog/2276010135?p=2)
- The Workshop "Required items" list shows Dabs Framework (2545327648) — [Workshop page](https://steamcommunity.com/sharedfiles/filedetails/?id=2276010135). The Editor's page lists Dabs Framework and Community Framework as required, with the Loader as recommended (search-result summary).
- **Config key conflict:** the GitHub code reads `ServerConfigGetInt("disableAutoMapGroupPosExport")`, so export is on by default. The Workshop description says to set `enableAutoMapGroupPosExport=1`, and the Aug 30, 2025 change note says "Added enableAutoMapGroupPosExport to server config". The published PBO (Sep 2025) is probably newer than GitHub (Aug 21, 2025) — [MissionServer.c L162](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c); [changelog](https://steamcommunity.com/sharedfiles/filedetails/changelog/2276010135)
- `static bool ExportProxyData = false;` makes `AfterHiveInit` call `GetCEApi().ExportProxyData()` and copy `$storage:export\mapgrouppos.xml` → `$mission:\mapgrouppos.xml` — [L10, L227-257](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c)
- **Client requirement:** a 2020 change note states that the mod "is no longer a server side mod" (search-result snippet of [changelog p5](https://steamcommunity.com/sharedfiles/filedetails/changelog/2276010135?p=5); not fetched directly).

### Inferences
- The current Loader's own scripts touch only `MissionServer`. It could probably run as `-serverMod` as long as DF (which handles the client RPC) is in `-mod` for clients. This has not been tested, and the author distributes it as a normal client+server mod.

### Gaps
- The Workshop page did not state explicitly whether clients must load the Loader itself.

## Q5. Licensing and what we may reuse

### Takeaway
- **DayZ Editor and Dabs Framework:** both carry the **Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 (CC BY-NC-ND 4.0)** license, and the author's Workshop and README terms add "no repacking/reupload".
- **Loader:** its GitHub `LICENSE.md` is **MIT** text, but the copyright lines name "Mark Otto" (2013) and "Andrew Fong" (2017), which is template boilerplate. Its Workshop page says "You are not permitted to repack any part of DayZ Editor Loader", "(c) InclementDab 2025".
- **Practical meaning:** copying or adapting DF or Editor code (for example `SuppressedObject`, `EditorSaveData`, `FindObject`) into our own PBO creates Adapted Material, which ND forbids us to share. Even a private server distributes the client PBO to players. The safe path is a clean-room implementation of the same technique (ideas and APIs are not copyrightable), or depending on the unmodified Workshop DF/Loader as-is.

### Cited Findings
- **Loader LICENSE.md (verbatim, complete, 10 lines):**
  > # Released under MIT License
  > Copyright (c) 2013 Mark Otto.
  > Copyright (c) 2017 Andrew Fong.
  > Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND...

  It was added in commit "Reloading :repeat:" (2024-01-26), when the repo was rebuilt from the author's DayZ-Mod-Template; the README is the template README, ending "Your tool is licensed under [MIT License](LICENSE.md)". GitHub reports the license as `NOASSERTION` — [LICENSE.md](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/LICENSE.md); [README](https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/README.md)
- **Loader Workshop terms:** "You are not permitted to repack any part of DayZ Editor Loader". The author will not approve repacking requests, the item is not authorized on Steam except under the author's account or by an authorized contributor, and the page carries "(c) InclementDab 2025" — [Workshop page](https://steamcommunity.com/sharedfiles/filedetails/?id=2276010135)
- **DayZ Editor `license.md`:** heading "# Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International", with the full CC legal code (commit "Proper license", 2020-10-07). The README adds: "> [!CAUTION] Reupload / Repacking without explicit permission is strictly prohibited. All versions found on the Workshop will be actioned and the Steam account will be blacklisted from Editor usage." — [license.md](https://github.com/InclementDab/DayZ-Editor/blob/legacy/license.md); [README](https://github.com/InclementDab/DayZ-Editor/blob/legacy/README.md)
- **Dabs Framework `LICENSE.md`:** "Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International Public License …" (added 2023-11-03). The README nevertheless calls DF "a complete, open-source modding framework" — [DF LICENSE.md](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/LICENSE.md); [DF README](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/README.md)
- **CC BY-NC-ND definitions (from the license text in those repos):** "NonCommercial means not primarily intended for or directed towards commercial advantage or monetary compensation." "Adapted Material means material ... derived from or based upon the Licensed Material ... translated, altered, arranged, transformed, or otherwise modified." "Share means to provide material to the public by any means ... such as reproduction, ... distribution". Under the standard CC BY-NC-ND 4.0 §2(a)(1)(B), you may produce, but not Share, Adapted Material — [DF LICENSE.md](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/LICENSE.md)
- **DF Workshop terms:** you are "not permitted to repack any part of Dabs Framework". Monetization approval is given "under the conditions that you follow the DayZ Server Monetization agreement", and posting to Steam is limited to the author or authorized contributors. The page claims 3.45M subscribers — [Workshop 2545327648](https://steamcommunity.com/sharedfiles/filedetails/?id=2545327648)
- **Note:** fetching both Workshop pages (2276010135 and 2545327648) returned a banner that the item "has been removed from the community because it violates Steam Community & Content Guidelines. It is only visible to you", and "incompatible with DayZ". This is odd for items with millions of subscribers and recent updates, and it may be an artifact of the fetcher. **Unverified**; check in a browser.

### Inferences (not legal advice)
- **Using the Workshop Loader + DF unmodified on our server** (subscribed via the Workshop or launched as published) is the intended use and is fine. If the server takes money, the DF monetization clause points to BI's server monetization rules.
- **Copying Loader code:** the GitHub file is MIT on its face, which would allow copying with the notice kept. However, the copyright holders named in the notice are wrong (template boilerplate), and the Workshop says no repacking. The Loader is also nearly worthless without DF's CC BY-NC-ND classes (`EditorSaveData`, `EditorDeletedObjectData`, `SuppressedObjectManager`). Copying it would either require DF at runtime or force us to copy DF code, which is ND-restricted. Treat it as "reference only".
- **Copying DF or Editor code** (suppression, the .dze binary reader, FindObject) into DRP_Core or our PBO: this is Adapted Material and would be Shared to every connecting client, which ND prohibits even if non-commercial. It also violates the "no repack" terms. Avoid it.
- **Writing our own:** the techniques (position + shape-name lookup, scale/flags/NOTVISIBLE/dBodyDestroy, RPC object-reference broadcast + JIP re-send, `ECE_SETUP|ECE_UPDATEPATHGRAPH|ECE_CREATEPHYSICS`, a batch `ProcessMarkedObjectsForPathgraphUpdate`, mapgrouppos regeneration) are ideas and engine API usage, which are not protected by copyright. A clean-room rewrite in our own code is the safe route. Reading a .dze file for interoperability is also generally fine. A simpler option is to have the Editor export JSON (the Loader accepts JSON) and parse that.
- If exact compatibility with DF's binary `.dze` (Version 8) is wanted, implement the reader from the observed field order without pasting DF code, or ask the author for permission. The author's Discord is linked from the READMEs.

### Gaps
- No explicit statement from the author was found about whether "private server mods" referencing or adapting the code are acceptable.
- Whether the MIT file on the Loader repo was intentional was not determined.
