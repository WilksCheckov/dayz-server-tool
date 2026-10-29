# Enforce-script techniques for an in-game object editor without CF (DayZ 1.30)

Source conventions used below:
- **Vanilla 1.30** = `BohemiaInteractive/DayZ-Script-Diff`, branch `main`, latest commit "Build 1.30.164200, Scripts Rev. 127662" (checked 2026-10-28). URL root: https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/
- **Local P:\scripts is OLD** (pre-1.2x): it lacks `GetWorldDirectionFromScreen`, `CreateStaticObjectUsingP3D`, `ECE_OBJECT_SPAWNER`, `PhxInteractionLayers.DYNAMICITEM_NOCHAR`, `World.MarkObjectForPathgraphUpdate`, and has the pre-1.26 `ObjectSpawnerHandler`. Do not use P:\scripts as the API reference for 1.30; compare against Script-Diff. (Compared directly: P:\scripts\3_game\objectspawner.c vs [Script-Diff objectspawner.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/objectspawner.c).)
- COT = `Jacob-Mango/DayZ-CommunityOnlineTools` branch `production` (CC-BY-SA-4.0). Expansion = `salutesh/DayZ-Expansion-Scripts` branch `experimental` (file header says CC BY-NC-ND 4.0: patterns may be studied, code must not be copied). VPP = `VanillaPlusPlus/VPP-Admin-Tools` `master` (licence not asserted on GitHub). DayZ Editor (`InclementDab/DayZ-Editor`, `legacy`) is cited only where it is evidence for retail behaviour.
- COT and VPP use CF / their own RPC manager; the patterns below translate to vanilla `ScriptRPC` / `OnRPC` without CF.

## Raycast picking under cursor/crosshair, and screen-to-world

### Takeaway
Use `GetGame().GetPointerDirection()` (mouse ray from the current camera) or `GetCurrentCameraDirection()` (crosshair) from `GetCurrentCameraPosition()`, then `DayZPhysics.RaycastRV` (returns a `set<Object>` of hits, works on static map objects and networked entities) or `RaycastRVProxy` (per-hit results incl. proxies, `CollisionFlags.ALLOBJECTS`). Fire every pick with more than one `ObjIntersect*` LOD type (COT uses Fire+View, optionally Geom) because many models lack one of the LODs; filter trees/bushes on non-View hits. All of these are retail APIs (vanilla scene editor and COT use them).

### Cited Findings
- Signature (vanilla 1.30): `proto static bool RaycastRV(vector begPos, vector endPos, out vector contactPos, out vector contactDir, out int contactComponent, set<Object> results = NULL, Object with = NULL, Object ignore = NULL, bool sorted = false, bool ground_only = false, int iType = ObjIntersectView, float radius = 0.0, CollisionFlags flags = CollisionFlags.NEARESTCONTACT);` iType values: `ObjIntersectFire(0), ObjIntersectView(1), ObjIntersectGeom(2), ObjIntersectIFire(3), ObjIntersectNone(4)`. — [dayzphysics.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/dayzphysics.c)
- `RaycastRVProxy(notnull RaycastRVParams in, out notnull array<ref RaycastRVResult> results, array<Object> excluded = null)`; `RaycastRVResult` has `obj`, `parent` (most-parent when `hierLevel > 0`, i.e. a proxy), `pos`, `dir`, `hierLevel` ("== 0 = objects in landscape, > 0 = proxy"), `component`. `RaycastRVParams` defaults: `flags = NEARESTCONTACT, type = ObjIntersectView, sorted = false, groundOnly = false`. — [dayzphysics.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/dayzphysics.c)
- Bullet-physics casts also exist: `RayCastBullet(begPos, endPos, PhxInteractionLayers layerMask, Object ignoreObj, out Object hitObject, out vector hitPosition, out vector hitNormal, out float hitFraction)`, `SphereCastBullet(...)`, plus overlap queries `BoxOverlapBullet`, `SphereOverlapBullet`, `EntityOverlapBullet` (with `CollisionOverlapCallback`). These only see objects with physics bodies in the given layer mask. — [dayzphysics.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/dayzphysics.c)
- A modder reported FIREGEOM was removed from `PhxInteractionLayers` in 1.22 when used with `RayCastBullet`; the 1.30 enum again contains `FIREGEOM` (between `RAGDOLL_NO_CHARACTER` and `DOOR`), so check the enum per version. — [BI feedback T174337 (search snippet)](https://feedback.bistudio.com/T174337); [dayzphysics.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/dayzphysics.c)
- Mouse ray: `proto native vector GetPointerDirection(); // Returns the direction where the mouse points, from the camera view`. Camera: `GetCurrentCameraPosition()`, `GetCurrentCameraDirection()`. 1.30 also declares `proto native vector GetWorldDirectionFromScreen(vector world_pos);` (its doc comment is a copy-paste of GetScreenPos, so semantics are undocumented; no public mod usage found). — [game.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c)
- Vanilla's own (dev) scene editor picks with the mouse exactly this way:
  ```c
  vector dir = GetGame().GetPointerDirection();
  vector from = FreeDebugCamera.GetInstance().GetPosition();
  vector to = from + ( dir * 10000 );
  if ( DayZPhysics.RaycastRV(from, to, contact_pos, contact_dir, contact_component, objects) ) { ... obj.IsInherited(EntityAI) ... }
  // drag: ground-only ray (ground_only = true) then SetPosition(contact_pos)
  DayZPhysics.RaycastRV(from, to, contact_pos, contact_dir, contact_component, NULL, NULL, NULL, false, true);
  ```
  — [pluginscenemanager.c Event_OnClick / Event_OnDrag](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/4_world/plugins/pluginbase/pluginscenemanager.c)
- COT merges View and Geom LOD hits for pointer/cursor objects:
  ```c
  DayZPhysics.RaycastRV(from, to, contact_pos, contact_dir, contact_component, view, with, ignore, false, false, ObjIntersectView, radius);
  DayZPhysics.RaycastRV(from, to, contact_pos, contact_dir, contact_component, geom, with, ignore, false, false, ObjIntersectGeom, radius);
  // GetPointerObject: from = GetCurrentCameraPosition(), dir = GetPointerDirection()
  // GetCursorObject:  dir = GetCurrentCameraDirection()   (crosshair)
  ```
  and for the hit *position* it fires View and Geom and keeps the nearer contact. — [COT 3_Game StaticFunctions.c](https://github.com/Jacob-Mango/DayZ-CommunityOnlineTools/blob/production/JM/COT/Scripts/3_Game/CommunityOnlineTools/StaticFunctions.c); [COT 4_World StaticFunctions.c](https://github.com/Jacob-Mango/DayZ-CommunityOnlineTools/blob/production/JM/COT/Scripts/4_World/CommunityOnlineTools/Classes/StaticFunctions.c)
- COT's delete/inspect picker uses `RaycastRVProxy` with `rayInput.flags = CollisionFlags.ALLOBJECTS; rayInput.radius = 0.1;`, loops `types = {ObjIntersectFire, ObjIntersectView}` (adds `ObjIntersectGeom` only when restricted classes are allowed), skips `IsBush()/IsTree()` hits unless the type is View, climbs `EntityAI.GetHierarchyRoot()`, skips empty type names and `#particlesourceenf`, and by default requires `ConfigGetInt("scope") == 2`. It ignores the player only when not in free camera, and adds the head-to-camera distance in 3rd person. — [COT JMObjectSpawnerModule.c](https://github.com/Jacob-Mango/DayZ-CommunityOnlineTools/blob/production/JM/COT/Scripts/5_Mission/CommunityOnlineTools/modules/Object/JMObjectSpawnerModule.c)
- Hologram (base-building placement) raycasts with `ObjIntersectFire`, `with = player`, `ignore = m_Projection` to find placement position, i.e. to exclude the object being moved from its own ray. — [hologram.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/4_world/classes/hologram.c)
- Static map objects (from the .wrp) are returned by the same raycasts; their `GetType()` can be empty, so Expansion falls back to `GetShapeName()` for identification. — [ExpansionWorldObjectsModule.c](https://github.com/salutesh/DayZ-Expansion-Scripts/blob/experimental/DayZExpansion/Core/Scripts/4_World/DayZExpansion_Core/ExpansionWorldObjectsModule.c)

### Inferences
- Recommended editor pick: client-side, `from = GetCurrentCameraPosition()`, `dir = GetPointerDirection()` when the cursor is shown (UI menu open / `ShowUICursor(true)`), otherwise `GetCurrentCameraDirection()`. Run `RaycastRVProxy` with types Fire, View, Geom, `ALLOBJECTS`; take the nearest `result.parent ? result.parent : result.obj`; `ignore` = the selected object while dragging. Send the picked object to the server as an RPC target (networked) or as type+position (static map object: it has no network ID; re-find it on the server via `GetObjectsAtPosition3D`).
- The ObjIntersect types map to the RV LODs (Fire geometry, View geometry, Geometry, Indirect fire); this is consistent with COT needing multiple types but is not stated in a primary source.
- `GetWorldDirectionFromScreen` may be a proper screen-to-world ray for arbitrary pixels (needed for box-select corners); untested, so prefer `GetPointerDirection` for the actual mouse.

### Gaps
- No primary documentation of `GetWorldDirectionFromScreen` semantics (argument units: pixels? relative?) and no mod using it found via GitHub code search.
- The BI wiki (community.bistudio.com) and feedback tracker returned HTTP 403 to automated fetches, so no official prose on ObjIntersect LOD meaning could be read.

## Drawing gizmos / selection boxes, and bounding boxes

### Takeaway
`Shape.Create/CreateLines/CreateSphere/...` are declared in 1_core (not behind `#ifdef DIAG`), and retail Workshop mods draw with them on the client (DayZ Editor bounding boxes, COT spectator markers, Expansion bullet traces), so they are usable in retail; screen-space overlays via `GetScreenPos` + widgets/CanvasWidget are the fully safe alternative. Get the box from `ClippingInfo` (visual clip box, model space) or `GetCollisionBox`, and transform the 8 corners with the object's matrix (or `Shape.SetMatrix`).

### Cited Findings
- Shape API (1_core, no diag guard): `Shape.Create(ShapeType type, int color, ShapeFlags flags, vector p1, vector p2)`, `CreateLines(int color, ShapeFlags flags, vector p[], int num)`, `CreateTris`, `CreateSphere`, `CreateFrustum`, `CreateCylinder`, helpers `CreateArrow`, `CreateBridgeArrow`, `CreateMatrix` (draws XYZ axes in red/green/blue with `ONCE|NOZWRITE|DOUBLESIDE|TRANSP`); instance `SetMatrix`, `SetPosition`, `SetDirection`, `SetColor`, `SetFlags`, `Destroy()` ("don't call destructor directly"). `ShapeType`: BBOX, LINE, SPHERE, CYLINDER, DIAMOND, PYRAMID. `ShapeFlags`: NOZBUFFER, NOZWRITE, WIREFRAME, TRANSP, DOUBLESIDE, ONCE ("Rendered just once and then it's automatically destroyed. Do not keep pointer to these!!"), NOOUTLINE, BACKFACE, NOCULL, VISIBLE, ADDITIVE. — [endebug.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/1_core/proto/endebug.c)
- Vanilla wrappers `Debug.DrawBox/DrawBoxEx/DrawSphere/DrawLine/DrawLines/DrawArrow` return `Shape` and are not wrapped in `#ifdef DIAG_DEVELOPER` in 1.30 (only logging sections are). — [debug.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/tools/debug.c)
- DayZ Editor (a retail Workshop mod) draws selection boxes with `Shape.CreateLines(color, ShapeFlags.VISIBLE | ShapeFlags.NOCULL | ShapeFlags.TRANSP, pts, n)` once, then each frame `m_BoundingBox.SetMatrix(transform)` from `m_WorldObject.GetTransform(transform)`; to remove, it sets `SetFlags(ShapeFlags.ONCE)` so the engine frees it next frame (comment: "Pointers to shapes are buggy?"). — [DayZ-Editor EditorObject.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorObject.c)
- COT spectator camera draws a marker with `Shape.Create(ShapeType.DIAMOND, color, ShapeFlags.ONCE | ShapeFlags.TRANSP | ShapeFlags.ADDITIVE | ShapeFlags.NOZBUFFER, min, max)` every frame. — [COT JMSpectatorCamera.c](https://github.com/Jacob-Mango/DayZ-CommunityOnlineTools/blob/production/JM/COT/Scripts/4_World/CommunityOnlineTools/Entities/Cameras/JMSpectatorCamera.c)
- Expansion bullet traces use `Shape.CreateLines(ExpansionStatic.ARGBtoInt(200, r, g, b), ShapeFlags.TRANSP, pts, 2)`. — [ExpansionBulletTrace.c](https://github.com/salutesh/DayZ-Expansion-Scripts/blob/experimental/DayZExpansion/Weapons/Scripts/4_World/DayZExpansion_Weapons/Classes/ExpansionBulletTrace.c)
- Shape colours are ARGB (`0xAARRGGBB`), e.g. vanilla `CreateMatrix` uses `0xFFFF0000` for red. — [endebug.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/1_core/proto/endebug.c)
- The Diag Menu itself needs `DayZDiag_x64.exe`; that is a different thing from the Shape API. — [StarDZ Modding Wiki 8.13 (search snippet)](https://stardz-team.github.io/DayZ-Modding-Wiki/de/08-tutorials/13-diag-menu)
- World→screen: `GetScreenPos(vector world_pos)` returns pixels in x,y and camera distance in z; `GetScreenPosRelative` returns 0..1. — [game.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c)
- COT ESP widgets: `ScreenPos = g_Game.GetScreenPos(m_LastPosition); GetScreenSize(Width, Height);` hide when `ScreenPos[0] <= 0 || ScreenPos[1] <= 0 || >= Width || >= Height || ScreenPos[2] < 0` (behind camera), sort widgets by `-distance * 100`. — [COT JMESPWidgetHandler.c](https://github.com/Jacob-Mango/DayZ-CommunityOnlineTools/blob/production/JM/COT/Scripts/5_Mission/CommunityOnlineTools/modules/ESP/JMESPWidgetHandler.c)
- Vanilla has a debug canvas line helper `Debug.CanvasDrawLine(x1, y1, x2, y2, width, color)` built on `CanvasWidget.DrawLine`. — [debug.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/tools/debug.c)
- Bounding boxes: `float ClippingInfo(out vector minMax[2])` ("Get Clipping info... return radius of bounding box"); `bool GetCollisionBox(out vector minMax[2])` ("true if collision box exists"); `float GetCollisionRadius()`; on IEntity `GetBounds(out mins, out maxs)` and `GetWorldBounds(out mins, out maxs)`. — [object.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/entities/object.c); [enentity.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/1_core/proto/enentity.c)
- DayZ Editor builds its box vertices from `ClippingInfo(clip_info)`. — [DayZ-Editor EditorObject.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorObject.c)
- Model↔world helpers: `Object.GetLocalPos/GetGlobalPos`, `GetGame().ObjectModelToWorld/ObjectWorldToModel`. — [object.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/entities/object.c); [game.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c)

Example (pattern from the sources above, not copied):
```c
// client only; build once, move each frame
vector mm[2]; obj.ClippingInfo(mm);
vector p[16]; // 4 bottom edges as a loop + verticals, as line strips
p[0]=Vector(mm[0][0],mm[0][1],mm[0][2]); p[1]=Vector(mm[1][0],mm[0][1],mm[0][2]);
p[2]=Vector(mm[1][0],mm[0][1],mm[1][2]); p[3]=Vector(mm[0][0],mm[0][1],mm[1][2]); p[4]=p[0];
// ... top loop and verticals in further CreateLines calls
Shape box = Shape.CreateLines(0xFF00FFFF, ShapeFlags.VISIBLE|ShapeFlags.NOCULL|ShapeFlags.TRANSP|ShapeFlags.NOZBUFFER, p, 5);
vector m[4]; obj.GetTransform(m); box.SetMatrix(m);
// remove: box.Destroy();  (or SetFlags(ShapeFlags.ONCE) as DayZ Editor does)
```

### Inferences
- A translate/rotate gizmo can be three `Shape.CreateArrow` / `CreateLines` axes (like `Shape.CreateMatrix`) drawn with `NOZBUFFER` so they show through geometry; hit-testing the gizmo is done in screen space (project the axis end-points with `GetScreenPos` and measure pointer distance to each 2D segment), since shapes have no collision.
- Shapes are client-local; never create them on the server.

### Gaps
- No official BI statement found that confirms or denies Shape rendering in DayZ_x64.exe; the retail evidence is indirect (widely used retail mods call it on the client). Verify once in the retail client before relying on it.

## Moving/rotating objects server-side and syncing

### Takeaway
Do authoritative moves on the server: `SetPosition` + `SetOrientation` (yaw, pitch, roll in degrees) or `SetTransform(mat)`, then `Update()` and a pathgraph update. Items/EntityAI replicate transforms; static `House`-type buildings do not reliably replicate transform changes after creation, so editors either recreate the object (delete + `CreateObjectEx`) or resend it (`RemoteObjectTreeDelete` + `RemoteObjectTreeCreate`).

### Cited Findings
- Object transform API: `SetPosition(vector)`, `PlaceOnSurface()`, `GetOrientation()/SetOrientation(vector)` "(yaw, pitch, roll) in degrees ... x = yaw, y = pitch, z = roll", `SetDirection(vector)` "object up vector is always y-axis", `GetDirectionUp()/GetDirectionAside()`, `CanAffectPathgraph()/SetAffectPathgraph(bool fromConfig, bool affect)`. — [object.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/entities/object.c)
- IEntity: `GetTransform(out vector mat[])`, `SetTransform(vector mat[4])`, `SetYawPitchRoll(vector)`, `SetScale(float)`, `SetFlags/ClearFlags(EntityFlags, bool recursively)`, `int Update()`. — [enentity.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/1_core/proto/enentity.c)
- VPP building sets spawn with `CreateObjectEx(name, pos, ECE_SETUP|ECE_CREATEPHYSICS|ECE_UPDATEPATHGRAPH)`, store the network ID (`GetNetworkID(low, high)`), `SetOrientation`, then `if (CanAffectPathgraph()) { SetAffectPathgraph(true, false); CallLater(GetGame().UpdatePathgraphRegionByObject, 100, false, obj); }` and `obj.Update()`. Moving a spawned building is `m_Building.SetPosition(pos)` / `SetOrientation(o)`. — [VPP SpawnedBuilding.c](https://github.com/VanillaPlusPlus/VPP-Admin-Tools/blob/master/4_World/VPPAdminTools/Plugins/PluginBase/BuildingSetManager/Classes/SpawnedBuilding.c)
- Expansion mapping spawn: flags `ECE_CREATEPHYSICS | ECE_NOLIFETIME | ECE_KEEPHEIGHT | ECE_DYNAMIC_PERSISTENCY`, then `obj.SetFlags(EntityFlags.STATIC, false); obj.SetOrientation(rotation); obj.SetAffectPathgraph(true, false); obj.Update(); if (obj.CanAffectPathgraph()) GetWorld().MarkObjectForPathgraphUpdate(obj);` — [ExpansionWorldObjectsModule.c](https://github.com/salutesh/DayZ-Expansion-Scripts/blob/experimental/DayZExpansion/Core/Scripts/4_World/DayZExpansion_Core/ExpansionWorldObjectsModule.c)
- 1.30 `World` has `MarkObjectForPathgraphUpdate(Object)` and `ProcessMarkedObjectsForPathgraphUpdate()`; `CGame.UpdatePathgraphRegionByObject(obj)` uses `ClippingInfo` radius around the object. — [world.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/world.c); [game.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c)
- COT, after setting up an entity that was created locally (`ECE_LOCAL`), resends it to clients: `g_Game.RemoteObjectTreeDelete(obj); g_Game.RemoteObjectTreeCreate(obj);` (comment: needed so attachments created during setup are replicated). Vanilla comment on these: "postponed registration of network object ... do not use if not sure what you do". — [COT JMObjectSpawnerModule.c](https://github.com/Jacob-Mango/DayZ-CommunityOnlineTools/blob/production/JM/COT/Scripts/5_Mission/CommunityOnlineTools/modules/Object/JMObjectSpawnerModule.c); [game.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c)
- RV-engine note: "the only known object types that don't synchronise position over the net are statics with simulation type 'house'" (Arma wiki, same engine lineage). — [BI wiki setPos (search snippet)](https://community.bistudio.com/wiki/setPos)
- BI feedback reports: a building's `SetScale` on the server changed only server collision/pathgraph, not client visuals (T156159); a structure spawned by script and then `SetPosition`ed desynced (clients rubber-banded, server player passed through it) (T134421). — [T156159 (search snippet)](https://feedback.bistudio.com/T156159); [T134421 (search snippet)](https://feedback.bistudio.com/T134421)
- Vanilla 1.30 object spawner applies `SetOrientation` and `SetScale` immediately after `CreateObjectEx` on the server at mission start (before any client connects), which avoids the post-creation sync problem. — [objectspawner.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/objectspawner.c)

### Inferences
- Safest editor rule: for anything not an `ItemBase`/vehicle (i.e. `House`/`BuildingBase` and plain statics), apply the final transform server-side and then either (a) delete and recreate at the new transform, or (b) `RemoteObjectTreeDelete` + `RemoteObjectTreeCreate` to make clients re-instantiate it with the current transform. Option (b) keeps the server object (and its network ID) and is the lighter choice; test it with two clients.
- During a drag, move a client-local preview only (`ECE_LOCAL` copy or the client instance) and commit to the server on mouse-up, so the server is touched once per edit (also the natural unit for undo).
- Use `SetOrientation` for (yaw,pitch,roll) storage and `SetTransform` when building orientation from vectors; call `Update()` after either.

### Gaps
- No primary DayZ (not Arma) statement that `House` transforms do not replicate in DayZ 1.30; the evidence is the Arma wiki, BI tickets and editor practice. Needs a two-client test.
- Behaviour of `RemoteObjectTreeDelete/Create` on `House` objects for JIP clients was not found documented.

## Ground snapping, surface alignment, snapping to objects

### Takeaway
Height: `SurfaceY(x,z)` (terrain), `SurfaceRoadY(x,z)`/`SurfaceRoadY3D(x,y,z, RoadSurfaceDetection)` (roads/object tops), or a downward `RaycastRV` that ignores the moved object (hits other objects too, giving object snapping). Slope: `SurfaceGetNormal(x,z)` or the ray's `contactDir`, converted to angles exactly as vanilla `GetSurfaceOrientation` / Hologram `AlignProjectionOnTerrain` do, or build a matrix with `Math3D.DirectionAndUpMatrix(dir, normal, mat)`.

### Cited Findings
- `SurfaceY(float x, float z)`, `SurfaceRoadY(x, z)`, `SurfaceRoadY3D(x, y, z, RoadSurfaceDetection rsd)`, `SurfaceGetNormal(x, z)`, `GetWaterDepth(posWS)`, `SurfaceIsSea/SurfaceIsPond`. — [game.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c)
- Vanilla helper:
  ```c
  vector GetSurfaceOrientation(float x, float z)
  {
      vector normal = g_Game.SurfaceGetNormal(x, z);
      vector angles = normal.VectorToAngles();
      angles[1] = angles[1]+270;
      if (angles == "0 540 0") angles = "0 0 0"; // flat-ground flip hack
      return angles;
  }
  ```
  — [game.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c)
- Hologram aligns to slope keeping the user yaw: normal from `m_ContactDir` (ray hit normal) else `SurfaceGetNormal`; `angles = normal.VectorToAngles(); angles[1] += 270;` then `Math3D.YawPitchRollMatrix(userYpr, mat0); Math3D.YawPitchRollMatrix(angles, mat1); Math3D.MatrixMultiply3(mat1, mat0, mat2); ypr = Math3D.MatrixToAngles(mat2);` — [hologram.c AlignProjectionOnTerrain](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/4_world/classes/hologram.c)
- Hologram ground checks cast four downward rays from the projection's corners with `ObjIntersectFire` and `ignore = m_Projection` to test contact under each corner. — [hologram.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/4_world/classes/hologram.c)
- `EntityAI.PlaceOnSurfaceRotated(out vector trans[4], vector pos, float dx = 0, float dz = 0, float fAngle = 0, bool align = false)` and `Object.PlaceOnSurface()` exist natively. — [entityai.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/entities/entityai.c); [object.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/entities/object.c)
- `Math3D.DirectionAndUpMatrix(vector dir, vector up, out vector mat[4])`, `YawPitchRollMatrix`, `MatrixToAngles`, `MatrixMultiply3/4`, `MatrixInvMultiply4`. — [enmath3d.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/1_core/proto/enmath3d.c)
- COT picks spawn flags by surface: water → `ECE_OBJECT_SWAP` (keep height, no surface align), else `ECE_PLACE_ON_SURFACE` (`ECE_CREATEPHYSICS|ECE_UPDATEPATHGRAPH|ECE_TRACE`); water test via `SurfaceRoadY3D(..., RoadSurfaceDetection.LEGACY)` then `GetWaterDepth > 0`. — [COT JMObjectSpawnerModule.c](https://github.com/Jacob-Mango/DayZ-CommunityOnlineTools/blob/production/JM/COT/Scripts/5_Mission/CommunityOnlineTools/modules/Object/JMObjectSpawnerModule.c); [COT 4_World StaticFunctions.c](https://github.com/Jacob-Mango/DayZ-CommunityOnlineTools/blob/production/JM/COT/Scripts/4_World/CommunityOnlineTools/Classes/StaticFunctions.c)

### Inferences
- Snap-to-ground with object-bottom offset: `pos[1] = groundY - minMax[0][1]` using `ClippingInfo` (or collision box) min Y, so the model's lowest point touches the surface regardless of its origin.
- Snap-to-object: downward `RaycastRV` from above the object with `ignore = movedObj` and `ground_only = false`; for face/edge snapping, use the other object's `GetCollisionBox` corners transformed by its matrix as snap candidates.
- Align to slope via matrix: `Math3D.DirectionAndUpMatrix(forwardProjectedOnPlane, normal, m); m[3] = pos; obj.SetTransform(m);` avoids the `"0 540 0"` angle hack.

### Gaps
- None critical; behaviour of `PlaceOnSurfaceRotated` with `align = true` on buildings not tested in sources.

## Deleting or hiding static map objects without CF

### Takeaway
Map objects baked into the .wrp are not networked: each machine (server and every client) has its own copy, so removal must run on the server and on every client, including JIP clients at connect. Expansion does not `ObjectDelete` them; it moves them 1000 m down, `Update()`s, turns off physics with `dBodySetSolid(obj,false)`, marks the pathgraph, keeps a list keyed by type-hash + position, and sends that list to each client on connect so the client does the same locally. That is reversible and avoids deleting engine-owned objects.

### Cited Findings
- Expansion `ExpansionRemovedObject` constructor:
  ```c
  m_Position = init.GetPosition();
  init.SetPosition(m_Position - Vector(0, 1000, 0));
  init.Update();
  m_IsSolid = dBodyIsSolid(init);
  if (m_IsSolid) dBodySetSolid(init, false);
  if (g_Game.IsServer() && init.CanAffectPathgraph()) g_Game.GetWorld().MarkObjectForPathgraphUpdate(init);
  ```
  Destructor restores position, `Update()`, `dBodySetSolid(obj, true)`, and re-marks the pathgraph on dedicated server. — [ExpansionWorldObjectsModule.c](https://github.com/salutesh/DayZ-Expansion-Scripts/blob/experimental/DayZExpansion/Core/Scripts/4_World/DayZExpansion_Core/ExpansionWorldObjectsModule.c)
- Expansion also treats an object as already removed if its first three transform rows are zero (`transform[0] == vector.Zero && [1] && [2]`), i.e. it recognises the other common hiding technique (zero-scale matrix via `SetTransform`) used by other mods. — [ExpansionWorldObjectsModule.c](https://github.com/salutesh/DayZ-Expansion-Scripts/blob/experimental/DayZExpansion/Core/Scripts/4_World/DayZExpansion_Core/ExpansionWorldObjectsModule.c)
- Finding the object: `GetGame().GetObjectsAtPosition3D(position, radius /*default 0.1*/, objects, null)`, compare lower-cased `ObjectGetType` (fallback `GetShapeName()`), with `*` prefix/suffix wildcard support; warn if not found. — [ExpansionWorldObjectsModule.c](https://github.com/salutesh/DayZ-Expansion-Scripts/blob/experimental/DayZExpansion/Core/Scripts/4_World/DayZExpansion_Core/ExpansionWorldObjectsModule.c)
- JIP sync: on player connect the server writes `count`, then for each removed object its type hash and `m_Position` into an RPC sent only to that identity; the client handler re-finds each by hash+position and removes it locally. (Skipped on respawn of an already-connected player.) — [ExpansionWorldObjectsModule.c OnInvokeConnect / RPC_RemoveObjects](https://github.com/salutesh/DayZ-Expansion-Scripts/blob/experimental/DayZExpansion/Core/Scripts/4_World/DayZExpansion_Core/ExpansionWorldObjectsModule.c)
- Comment in Expansion: removed objects are sent with the general settings RPC "to avoid race conditions (building interiors checks if object was removed)", i.e. the removal list must arrive before other client systems look at buildings. — [ExpansionWorldObjectsModule.c](https://github.com/salutesh/DayZ-Expansion-Scripts/blob/experimental/DayZExpansion/Core/Scripts/4_World/DayZExpansion_Core/ExpansionWorldObjectsModule.c)
- Vanilla API: `ObjectDelete(Object)`, `ObjectDeleteOnClient(Object)`, `RemoteObjectDelete(Object)` "deletes only remote object (unregisters from network)", `RemoteObjectTreeDelete`. Vanilla uses `ObjectDeleteOnClient` for a client-local flare created with `ECE_LOCAL`. — [game.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c); [dynamicarea_flare.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/4_world/classes/contaminatedarea/dynamicarea_flare.c)
- VPP deletes its own spawned (networked) buildings with `ObjectDelete` on the server and `ObjectDeleteOnClient(m_Building)` in the client-side destructor of its record; after restart it re-finds stale ones by saved network ID and type check. — [VPP SpawnedBuilding.c](https://github.com/VanillaPlusPlus/VPP-Admin-Tools/blob/master/4_World/VPPAdminTools/Plugins/PluginBase/BuildingSetManager/Classes/SpawnedBuilding.c)
- A third-party wiki says `ObjectDeleteOnClient` "Deletes the object only on clients. The server still keeps the object." (unofficial, AI-assisted wiki; vanilla only uses it on local objects). — [StarDZ wiki entity system](https://github.com/StarDZ-Team/DayZ-Modding-Wiki/blob/main/en/06-engine-api/01-entity-system.md)

### Inferences
- Recommended no-CF design: server keeps `array<(type, pos)>` of hidden map objects in a mission JSON; at mission start apply the Expansion-style hide on the server; in `MissionServer.InvokeOnConnect` (or `OnClientReadyEvent`) send one vanilla `ScriptRPC` with the list to that identity; client handler (in `MissionGameplay`/a modded `PlayerBase.OnRPC`) runs the same hide. For a live edit, broadcast the same RPC to all clients. Hiding (move down + non-solid) rather than deleting keeps undo possible.
- Map objects do not have network IDs, so identify them by lower-cased type (or `GetShapeName()` for type-less objects) + rounded position, searched with a small radius.
- Server-only removal leaves clients seeing (and colliding locally with) the object; client-only removal lets players see through an object that still blocks bullets/AI on the server. Both sides are required.

### Gaps
- No primary source on whether `ObjectDelete` on a .wrp map object on a dedicated server is safe (crash/pathgraph). Expansion avoiding it is indirect evidence. The BI feedback tickets T193100 and T171517 that discuss object removal returned 403 and could not be read.
- Sounds attached to hidden objects (e.g. generators) may persist; noted for Arma `hideObjectGlobal`, not verified for DayZ.

## Persistence caveats when spawning editor objects

### Takeaway
Spawn editor objects from a server-side JSON at every start (like vanilla `objectSpawnersArr`) with flags that exclude them from CE persistence (`ECE_NOLIFETIME | ECE_DYNAMIC_PERSISTENCY`), so a restart never duplicates them. Only `EntityAI` with CE persistence (items, base-building) would be saved into storage_1; static/House objects created by script are not.

### Cited Findings
- Vanilla 1.30 `ObjectSpawnerHandler.SpawnObject`: flags `ECE_SETUP | ECE_UPDATEPATHGRAPH | ECE_CREATEPHYSICS | ECE_NOLIFETIME | ECE_DYNAMIC_PERSISTENCY | ECE_OBJECT_SPAWNER`; if `item.enableCEPersistency` it clears `ECE_DYNAMIC_PERSISTENCY` and `ECE_NOLIFETIME`; uses `RF_IGNORE`; then `SetOrientation(ypr)`, `SetScale`, `object.OnSpawnByObjectSpawner(item)`. Names containing `\` or `/` are P3D paths, allowed only under `DZ\plants*` / `DZ\rocks*`, created with `CreateStaticObjectUsingP3D(path, pos, ypr, scale, true)`. Runs only on server, then `ProcessMarkedObjectsForPathgraphUpdate()`. — [objectspawner.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/objectspawner.c)
- `CreateStaticObjectUsingP3D(string p3dFilename, vector position, vector orientation, float scale = 1.0, bool createLocal = false, bool objSpawner = false)` and `CreateObject(..., bool objSpawner = false)` exist in 1.30. — [game.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c)
- ECE flags (vanilla): `ECE_SETUP 2, ECE_TRACE 4, ECE_CENTER 8, ECE_UPDATEPATHGRAPH 32, ECE_ROTATIONFLAGS 512, ECE_CREATEPHYSICS 1024, ECE_INITAI 2048, ECE_KEEPHEIGHT 524288, ECE_NOSURFACEALIGN 262144, ECE_NOLIFETIME 4194304, ECE_LOCAL 1073741824`; combos `ECE_PLACE_ON_SURFACE = CREATEPHYSICS|UPDATEPATHGRAPH|TRACE`, `ECE_OBJECT_SWAP = CREATEPHYSICS|UPDATEPATHGRAPH|KEEPHEIGHT|NOSURFACEALIGN`. `ECE_DYNAMIC_PERSISTENCY` is not defined in script (engine constant) but is used by vanilla. — [centraleconomy.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/ce/centraleconomy.c); [objectspawner.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/objectspawner.c)
- Expansion mapping objects use `ECE_CREATEPHYSICS | ECE_NOLIFETIME | ECE_KEEPHEIGHT | ECE_DYNAMIC_PERSISTENCY` and are re-spawned from mission files every start. — [ExpansionWorldObjectsModule.c](https://github.com/salutesh/DayZ-Expansion-Scripts/blob/experimental/DayZExpansion/Core/Scripts/4_World/DayZExpansion_Core/ExpansionWorldObjectsModule.c)
- VPP building sets spawn without `ECE_NOLIFETIME`/`ECE_DYNAMIC_PERSISTENCY` and keep `"high,low"` network IDs in their JSON; on load they look up `GetObjectByNetworkId(low, high)` and only delete it if its type matches (an old ID "may belong to something else now"). — [VPP SpawnedBuilding.c](https://github.com/VanillaPlusPlus/VPP-Admin-Tools/blob/master/4_World/VPPAdminTools/Plugins/PluginBase/BuildingSetManager/Classes/SpawnedBuilding.c)
- Official docs: objectSpawnersArr lists JSON files in the mission folder, loaded at mission start; needs `enableCfgGameplayFile = 1`. — [BI wiki Object Spawner (search snippet; page 403 to fetch)](https://community.bistudio.com/wiki/DayZ:Object_Spawner); [vincibean guide](https://vincibean.github.io/my-dayz-guide/guide/object-spawner.html)

### Inferences
- An editor can emit vanilla-format spawner JSON (`{"Objects":[{"name","pos":[3],"ypr":[3],"scale","enableCEPersistency"}]}`) so the result also loads with no mod at all; a companion server mod only needs to add map-object hiding (which vanilla lacks).
- Network IDs are not stable across restarts; never use them as persistent keys. Use type + position (+ an editor-assigned GUID in the JSON).
- Items (`ItemBase`) spawned without `ECE_NOLIFETIME` get CE lifetime and can despawn; with persistence they get saved and then duplicated by the next JSON load. Use `ECE_NOLIFETIME | ECE_DYNAMIC_PERSISTENCY` for decorative items.

### Gaps
- Exact engine semantics of `ECE_DYNAMIC_PERSISTENCY` and `ECE_OBJECT_SPAWNER` are not documented in script; inferred from vanilla usage.

## Undo/redo and box-select

### Takeaway
No vanilla undo framework exists; implement the command pattern with `ref` arrays of command objects storing before/after snapshots (type, transform, hidden state). Box-select is a pure client loop: project candidate objects with `GetScreenPos` and test against the drag rectangle.

### Cited Findings
- Projection and on-screen test pattern (pixel x,y; z<0 means behind camera; compare with `GetScreenSize`). — [COT JMESPWidgetHandler.c](https://github.com/Jacob-Mango/DayZ-CommunityOnlineTools/blob/production/JM/COT/Scripts/5_Mission/CommunityOnlineTools/modules/ESP/JMESPWidgetHandler.c); [game.c GetScreenPos](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c)
- Candidate gathering: `GetObjectsAtPosition3D(pos, radius, objects, proxyCargos)` (sphere) and `GetObjectsAtPosition` (circle); vanilla uses these widely, e.g. VicinityItemManager. — [game.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c)
- Mouse position: global `GetMousePos(out int x, out int y)` and `GetScreenSize(out int x, out int y)`. — [ensystem.c](https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/1_core/proto/ensystem.c)

Example sketch (own pattern, Enforce-safe: no `out` in interfaces, classes not structs):
```c
class EdCmd : Managed { void Do(); void Undo(); }
class EdCmdTransform : EdCmd
{
    string m_Key;            // editor GUID or type|pos key
    vector m_Before[4], m_After[4];
    override void Do()   { EdNet.SendTransform(m_Key, m_After); }   // server RPC
    override void Undo() { EdNet.SendTransform(m_Key, m_Before); }
}
class EdHistory
{
    ref array<ref EdCmd> m_Undo = new array<ref EdCmd>;
    ref array<ref EdCmd> m_Redo = new array<ref EdCmd>;
    void Push(EdCmd c) { c.Do(); m_Undo.Insert(c); m_Redo.Clear(); }
    void Undo() { int n = m_Undo.Count(); if (!n) return; EdCmd c = m_Undo[n-1]; m_Undo.Remove(n-1); c.Undo(); m_Redo.Insert(c); }
    void Redo() { int n = m_Redo.Count(); if (!n) return; EdCmd c = m_Redo[n-1]; m_Redo.Remove(n-1); c.Do(); m_Undo.Insert(c); }
}
// box select
int mx, my; GetMousePos(mx, my);
foreach (Object o : candidates) { vector s = GetGame().GetScreenPos(o.GetPosition()); if (s[2] > 0 && s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1) sel.Insert(o); }
```

### Inferences
- Store commands by stable editor key, not by `Object` reference, because delete/recreate (needed for buildings) invalidates references; a "delete" command's undo re-spawns from the stored type+transform, and a "hide map object" undo calls the restore path (Expansion-style reverse).
- Batch multi-select moves into one compound command so one Ctrl+Z reverts the whole drag.
- Candidates for box-select: objects the editor spawned (own list) plus map objects from `GetObjectsAtPosition` around the camera target with a capped radius; project the bounding-box centre (or all 8 corners for "fully inside" mode).

### Gaps
- No open-source non-CF DayZ undo implementation was reviewed (DayZ Editor's is out of scope); the sketch above is original and untested in-game.
