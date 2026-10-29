# DayZ Editor (InclementDab) – architecture and editing mechanics

Method: shallow-cloned `InclementDab/DayZ-Editor` (default branch **`legacy`**, head commit a55ec49 "Menu visual improvements", 2026-10-25) and the framework repo `InclementDab/DayZ-Dabs-Framework` (branch `production`, head 2026-10-07 "revert-44-fix/1.30-compat"), then read the source. Every file path below is in the DayZ-Editor repo on the `legacy` branch unless it says DabsFramework.
URL prefixes:
- E = `https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/`
- DF = `https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/`

(Note: the task suggested `InclementDab/DabsFramework`. That repo does not exist; `git clone` returned "Repository not found". The framework is at `InclementDab/DayZ-Dabs-Framework`.)

---

## 1. Repository structure, main classes, dependencies

### Takeaway
The editor is a client-side mod with five script modules (1_Core, 3_Game, 4_World, 5_Mission, plus a `common` folder), and nearly all of the logic is in 4_World. One large singleton, `Editor` (Editor.c, 3,743 lines), owns the camera, the selection, the undo stack, placement ("hands") and input. Around it are an object manager module, a command system with one class per action that also carries the hotkey, gizmo classes and drag handlers. It hard-depends on Community Framework (`JM_CF_Scripts`) and Dabs Framework (`DF_Scripts`). Dabs Framework supplies Ray/Raycast, the static-object "suppression" (hiding), MVC/ScriptView UI, `EditorObjectData` and the profile-settings attributes.

### Cited Findings
- **Branches and recency.** The default branch is `legacy` (pushed 2026-10-25). Other branches are stale or experimental: `development` (2024-02-28), `production` (2024-01-29), `release` (2020), `feature/node-system` (2026-04-13, "its here but, its SLOW") and `refactor/architecture-decoupling` (2025-10-16). Only two GitHub releases exist (v0.1.2 and v0.1.21, both 2020-10-07). Workshop builds are the real release channel. — `gh api repos/InclementDab/DayZ-Editor` and `/commits/<branch>` ([repo](https://github.com/InclementDab/DayZ-Editor))
- **Dependencies.** `requiredAddons[] = { "DZ_Scripts", "JM_CF_Scripts","DF_Scripts", "DZ_Gear_Navigation", "DZ_Worlds_Enoch"}`. CfgMods version "1.2". Custom inputs come from `DayZEditor/Scripts/Data/Inputs.xml`. `missionScriptModule value = "CreateEditorMission"` (the editor supplies its own mission). Imagesets and styles are loaded from `DabsFramework/gui/...`. — [E config.cpp](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/config.cpp)
- **Workshop page.** Required items are "Community Framework" and "Dabs Framework". About 81.7k current subscribers. Last updated "Oct 25". The page describes the mod as offline-only: you export to init.c or .vpp, or use the "DayZ Editor Loader". The fetched page also showed a notice that the item "has been removed from the community because it violates Steam Community & Content Guidelines" and is "incompatible with DayZ". I could not verify this; it may be a scrape artefact. — [Steam Workshop 2250764298](https://steamcommunity.com/sharedfiles/filedetails/?id=2250764298)
- **Code contradicts "offline only".** The current code has multiplayer paths: `GetGame().IsMultiplayer()` branches that send ScriptRPCs (ids 39253 for delete and 39255 for hide), plus `EditorNetActionManager` drag-session RPCs (`SendDragSessionStart/Update/End` with `EditorNetUtils.PackTransform` into `int[4]`). — [E 4_World/DayZEditor/classes/Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c), [E objects/GizmoBase.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/GizmoBase.c)
- **Size.** 302 `.c` files and about 30k lines in total. — local `wc` of the clone
- **Folder map (4_World/DayZEditor).**
  - `classes/`: Editor.c, EditorObject.c (1,007 lines), EditorWorldObject.c, EditorHologram.c, EditorDeletedObject.c, EditorAction.c, EditorClipboard.c, EditorCamera.c, EditorSnapPoint.c, EditorPlaceableItem.c
  - `classes/Commands/{Clipboard,Objects,Selection,Hud,Import,Export,Brushes,CameraTrack}`: about 100 command classes
  - `classes/DragHandler/`: EditorDragHandler.c, EditorObjectDragHandler.c (also defines `Plane3D`)
  - `classes/Brushes/`: tree and delete brushes
  - `classes/FileManagers/FileTypes/`: DZE, init.c, Expansion, VPP, TerrainBuilder, event-spawn and XML
  - `objects/`: GizmoBase.c, EditorTranslationGizmo.c, EditorRotationGizmo.c, EditorScaleGizmo.c
  - `modules/`: EditorObjectManager.c (`EditorObjectManagerModule`), EditorClientManager.c, EditorNetActionManager.c, EditorCameraTrackManager.c
  - `gui/`: EditorHud.c (1,532 lines), Controllers/EditorHudController.c, Markers, ListItem, Dialogs, Menus, InventoryEditor
  - 3_Game holds settings, EditorMath and the file/log classes. 5_Mission holds EditorMission.c, EditorMainMenu.c and EditorMapView.c.
  — local directory listing; see [E tree](https://github.com/InclementDab/DayZ-Editor/tree/legacy/DayZEditor/Scripts)
- **Global access.** `ref Editor g_Editor; Editor GetEditor()` returns null while the editor is being destroyed. Editor modes are `enum eEditorMode { None, Translation, Rotation, Scale }`. The gizmo type is held as `typename m_CurrentGizmoType = EditorTranslationGizmo` and spawned with `m_CurrentGizmoType.Spawn()`. — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)
- **Core state in Editor.**
  - `m_SessionCache` is `map<int, ref EditorObjectData>`; it keeps data alive so undo can recreate objects.
  - `m_EditorObjectsByUuid` and `m_HiddenObjectsByUuid` are UUID maps used for networking.
  - `m_PlacingObjects` is an `EditorHandMap = map<ref EditorWorldObject, ref EditorHandData>`.
  - `m_ActionStack` is `array<ref EditorAction>`, indexed by `m_CurrentActionIndex`.
  - `CommandManager` and `m_ObjectManager` hang off the Editor.
  — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)
- **Pieces that come from Dabs Framework:**
  - `Ray` and `Raycast`: wrappers over `DayZPhysics.RayCastBullet`, `SphereCastBullet` and `RaycastRVProxy`. — [DF 3_Game/DabsFramework/!Core/Ray.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/!Core/Ray.c)
  - `SuppressedObjectManager` and `SuppressedObject`, used to hide map objects. — [DF Suppression/](https://github.com/InclementDab/DayZ-Dabs-Framework/tree/production/DabsFramework/Scripts/3_Game/DabsFramework/Suppression)
  - `EditorObjectData` (Type, DisplayName, Position, Orientation, Scale, AttachmentMap, Model, Flags). The editor `modded`-extends it in 3_Game. — [DF _Legacy/Editor/EditorObjectData.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/EditorObjectData.c)
  - ScriptView, ViewController and ObservableCollection (MVC), the `Symbols` icon font, and `ProfileSettings` with `[RegisterProfileSettingSlider]`. — usage in [E EditorCamera.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorCamera.c) and [E EditorHudController.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/gui/Controllers/EditorHudController.c)
- **Where CF shows up.** The CF dependency is visible only in config. In code, the editor suppresses COT inputs (`UACOTModuleToggleCOT` and others) in `ProcessInput`. — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)

### Inferences
- To replicate without CF or DF we would need to rewrite: Ray/Raycast (about 150 lines, trivial), Plane3D (already in the editor), the suppression logic (about 80 lines), and a light MVC substitute (plain layouts plus script handlers). None of the gizmo or drag math depends on CF.
- Our grep for CF-specific APIs (JM_, CF_ types) in the gizmo, drag and selection code found nothing. That suggests the CF requirement is mostly inherited through Dabs Framework or legacy code.

### Gaps
- I did not audit why CF is still required, i.e. which exact CF classes are used anywhere. A full grep for `CF_`/`JM_` across the whole repo was not done.
- The Steam "removed/incompatible" notice is unverified.

---

## 2. Placement, selection, gizmo move/rotate, snapping, ground-follow

### Takeaway
- **Placement** puts a "hologram" (a real local object created with ECE_LOCAL, or `CreateStaticObjectUsingP3D` for raw p3ds) "in hand". Each frame it is moved to the cursor raycast hit with its **bottom** (lowest clipping-box Y) on the surface. Magnet mode aligns it to the hit normal.
- **Picking** uses a cached per-frame cursor Ray: Bullet raycast first, then RV-geometry raycast as fallback. The hit object is looked up in a static `EditorObject.s_AllByObject` map.
- **Box, ellipse and lasso select** do not project world positions themselves. They test the **screen position of each object's marker widget**; markers are positioned with `GetGame().GetScreenPos()`.
- **The gizmo** is a real p3d entity scaled by distance × FOV. Its handles are hit-tested with ray-vs-OBB slab tests in gizmo-local space. Drags intersect the cursor ray with a plane through the object and lock the result to the chosen axis in local space.
- **Rotation** builds a new basis from the direction "centre → cursor intersection on the rotation plane".

### Cited Findings

**Per-frame raycast cache (Editor.Update).**
```c
// E 4_World/DayZEditor/classes/Editor.c  Update()
float raycast_distance = GetCameraSettings().ViewDistance / 5;
m_CursorRay = new Ray(GetGame().GetCurrentCameraPosition(), g_Game.GetPointerDirection());
m_CameraRay = new Ray(GetGame().GetCurrentCameraPosition(), GetGame().GetCurrentCameraDirection());
if (GetGame().GetUIManager().IsCursorVisible()) {
    m_CursorRaycast = PerformRaycast(m_CursorRay, null, raycast_distance, false);
```
- `PerformRaycast` tries the Bullet ray first (`source_ray.PerformRaycast(ignore, distance, -1)`, which is `DayZPhysics.RayCastBullet`). If that misses, it falls back to `source_ray.PerformRaycastRVEX(0, distance, ObjIntersectGeom, { ignore }, ground_only)`. — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)
- The DF `PerformRaycastRVEX` fills `RaycastRVParams` with `flags = CollisionFlags.NEARESTCONTACT`, `type = interaction_type`, `groundOnly`, `sorted = true`, then calls `DayZPhysics.RaycastRVProxy(raycast_params, results, excludes)`. It takes `results[0]` into `Bounce = new Ray(result.pos, result.dir.Normalized())`, `HitComponent` and `Hit`. — [DF !Core/Ray.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/!Core/Ray.c)
- `PerformRaycastMulti` (DF) re-casts Bullet rays from each hit point, so it can skip a list of ignored objects. Bullet only takes one ignore object. — same file
- Hover tracking: when the hit object or component changes, `Update()` calls `OnMouseExitObject` and then `OnMouseEnterObject(m_CursorRaycast.Hit, x, y, HitComponent)`. When nothing is hit, it shows the surface type from `GetGame().SurfaceGetType` in the HUD. — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)

**Click-select (Editor.ProcessInput).**
```c
if (cursor_raycast && cursor_raycast.Hit && GetEditorHud().IsObjectSelectionEnabled()) {
    EditorObject select_object = EditorObject.s_AllByObject[cursor_raycast.Hit];
    if (select_object) {
        if (IsCtrlDown()) { ToggleSelection(select_object); return; }
        if (!turbo_input.LocalValue()) { ClearSelection(); }   // Shift (UATurbo) = additive
        SelectObject(select_object); return;
    }
}
ClearSelection();
```
- The order of precedence on a left click is:
  1. gizmo interaction (the click is consumed)
  2. lightning mode
  3. placing → `PlaceObject()`
  4. Lock/Unlock modes
  5. Ctrl+Click on a world object → `GetReplaceableItem()` puts a copy of that map object "in hand" with the same orientation ("Get Object from World")
  6. select

  — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)
- Ctrl+Middle-click on an object deletes it if it is an EditorObject. Otherwise it calls `HideMapObject(m_ObjectUnderCursor)` on the static map object. — same file

**Box / ellipse / lasso select (EditorHud.Update).**
- Selection modes are `enum SelectionMode { BOX, ELLIPSE, LASSO }`, chosen by commands on the I, O and P keys.
- On left press over no widget (or over the map), it records the mouse start and starts a 0.12 s delay (`m_DragBoxDelayStart = 0.12`) so plain clicks do not start a box.
- The rectangle is drawn on a CanvasWidget as one thick line: `EditorCanvas.DrawLine(x_avg, m_DragBoxStartY, x_avg, mouse_y, mouse_x - m_DragBoxStartX, 0x644B77BE)`.
- Selection test:
```c
foreach (EditorMarker marker: EditorMarker.s_AllMarkers) {
    ...
    marker.GetLayoutRoot().GetScreenPos(x_n, y_n);
    if ((x_n < Math.Max(m_DragBoxStartX, mouse_x) && x_n > Math.Min(m_DragBoxStartX, mouse_x)) && (y_n < Math.Max(m_DragBoxStartY, mouse_y) && y_n > Math.Min(m_DragBoxStartY, mouse_y))) {
        if (object_marker && !object_marker.GetEditorObject().IsSelected()) m_Editor.SelectObject(...);
    } else if (... IsSelected() && !shift_input.LocalValue()) m_Editor.DeselectObject(...);
```
- Ellipse mode uses `(dx²)/(a²) + (dy²)/(b²) <= 1`. Lasso mode records mouse points more than 4 px apart and calls `IsPointInPolygon(x, y, m_LassoHistory)`. Holding Shift keeps the existing selection.

— [E 4_World/DayZEditor/gui/EditorHud.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/gui/EditorHud.c)

**World-to-screen projection (markers).**
- Each frame `EditorObjectWorldMarker.Update` takes `m_EditorObject.GetBottomCenter()`. In Ground mode it ray-casts downward to the ground. Then `vector screen_pos = GetGame().GetScreenPos(position);`, and the marker is hidden when off-screen (`screen_pos[2] < 0` means behind the camera) or beyond `MarkerViewDistance`. Alpha fades with squared distance.
- When the map is open it uses `m_MapWidget.MapToScreen(position)` instead, which is why box select also works on the 2D map.

— [E gui/Markers/EditorObjectWorldMarker.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/gui/Markers/EditorObjectWorldMarker.c)

**Placement / hologram.**
- `AddInHand(EditorPlaceableItem item)` creates `new EditorHologram(item)`, which calls `SetWorldObject(CreateObject(placeable_item.GetSpawnType(), vector.Zero))`. Without Shift held it clears the selection and turns the brush off. — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c), [E EditorHologram.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorHologram.c)
- Object creation:
  - Strings containing ".p3d" use `GetGame().CreateStaticObjectUsingP3D(formatted_path, position, orientation, scale, true)`.
  - Everything else uses `CreateObjectEx(type, position, ECE_LOCAL | ECE_SETUP | ECE_UPDATEPATHGRAPH | ECE_CREATEPHYSICS | ECE_NOLIFETIME | ECE_NOPERSISTENCY_CHAR | ECE_NOPERSISTENCY_WORLD | ECE_INITAI)`.
  - EntityAI gets `DisableSimulation(true)` 15 ms later, and optionally `OnDebugSpawn()` to add attachments.

  — [E EditorWorldObject.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorWorldObject.c)
- `HandleHands(dt)` runs each frame while placing:
```c
Raycast cursor_raycast = GetCursorRaycastModeSafeEx(objects_to_ignore, GroundMode);   // ignores player + holograms
vector cursor_pos = GetCursorRayModeSafe().GetPoint(10.0);
if (cursor_raycast) cursor_pos = cursor_raycast.Bounce.Position;
vector up_dir = vector.Up;
if (MagnetMode) { up_dir = cursor_raycast.Bounce.Direction; /* fallback SurfaceGetNormal, then Up */ }
vector local_aside = m_MainHandObject.GetWorldObject().GetDirection();
vector transform[4] = { up_dir * local_aside, up_dir, up_dir * (local_aside * vector.Up), cursor_pos };
Math3D.YawPitchRollMatrix(m_HandsInputOrientation, userinput_matrix);
Math3D.MatrixMultiply3(transform, userinput_matrix, transform);
... world_object.SetBottomTransform(local_transform);   // per extra hand object: hand_data offsets multiplied in
```
- While placing, R (`UAReloadMagazine`) adds 90° of yaw. `UAZoomInOptics`/`UAZoomOutOptics` rotate by 9° per frame (Shift divides by 5, Ctrl multiplies by 5).
- `PlaceObject()` converts each hologram into `EditorObjectData.Create(GetSpawnType(), pos, ori, scale, EFE_DEFAULT)`, then `CreateObjects(data_list)`, then selects the results. **Holding Shift keeps the hologram in hand** for repeated placement.

— [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)

**Bottom pivot helpers** (used for all ground snapping):
```c
// E 4_World/DayZEditor/classes/EditorWorldObject.c
void SetBottomTransform(vector transform[4]) {
    vector low = m_Clipping[0];                       // ClippingInfo min corner
    vector pos_offset = Vector(0, -low[1], 0).Multiply3(transform);
    transform[3] = transform[3] + pos_offset;
    SetTransform(transform);
}
```
`GetTopTransform` and `SetTopTransform` do the same with `clip_info[1][1]`. The gizmo is attached to the **top** of the object. — [E EditorWorldObject.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorWorldObject.c)

**Gizmo drawing.**
- Meshes are `GizmoTranslation` (`\DayZEditor\Editor\MoveGizmo.p3d`, hiddenSelections origin_ball, x_arrow, y_arrow, z_arrow, ...) and `GizmoRotation` (`RotateGizmo.p3d`, selections x, y, z). There is also a ScaleGizmo.p3d. — [Editor/config.cpp](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Editor/config.cpp)
- One gizmo entity per mesh is cached in `static map<string, EntityAI> s_Gizmos` and created with `CreateObjectEx(gizmo_mesh, vector.Zero, ECE_LOCAL)`.
- Each frame the gizmo is placed on the top-selected object's orthogonalised top transform (X and Z axes negated) and scaled by `gizmo_distance * m_CameraFieldOfView * 0.1`, which keeps its on-screen size constant.
- Handle colours come from per-selection procedural textures:
```c
m_Gizmo.SetObjectTexture(interaction_index_color, string.Format("#(argb,8,8,3)color(%1,%2,%3,1.000,co)", r, g, b));
```
  Hover is YELLOW and active is ORANGE.

  — [E objects/GizmoBase.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/GizmoBase.c)

**Gizmo picking: ray vs OBB slab test in gizmo-local space** (`GizmoInteractionSource.CollideOBB`):
```c
vector position_delta = transform[3] - ray.Position;
float tmin = 0; float tmax = 1000000;
vector clip_min = Clipping[0] * Scale * Scale; vector clip_max = Clipping[1] * Scale * Scale;
for (int i = 0; i < 3; i++) {
    float e = vector.Dot(transform[i], position_delta);
    float f = vector.Dot(ray.Direction, transform[i]);
    if (f == 0) return false;
    float t1 = (e + clip_min[i]) / f; float t2 = (e + clip_max[i]) / f;
    if (t1 > t2) { swap }
    if (t2 < tmax) tmax = t2; if (t1 > tmin) tmin = t1;
    if (tmax < tmin) return false;
}
hit_pos = ray.Position + ray.Direction.Normalized() * tmin;
```
- The handle boxes are registered per gizmo:
  - Centre: ±0.1875 cube.
  - Axes: length 2.0 × width 0.125 (e.g. X = `Vector(BOX_LENGTH,-BOX_WIDTH,-BOX_WIDTH)`..`Vector(0,BOX_WIDTH,BOX_WIDTH)`).
  - Planes: small squares at about 2/3 length.
  - Rotation rings: thin slabs 0.05 thick × 4.0 wide.
- The nearest hit wins.

— [E objects/GizmoBase.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/GizmoBase.c), [E objects/EditorTranslationGizmo.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/EditorTranslationGizmo.c), [E objects/EditorRotationGizmo.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/EditorRotationGizmo.c)

**Drag start (gizmo).**
- On `UAFire` LocalPress over a handle:
  - `m_DragOffset = collision_hit.InvMultiply4(m_TopTransformOrthogonal)` stores the grab point in local space, so the object does not jump.
  - It creates `m_RewindAction = new EditorAction("SetTransform","SetTransform")` with undo parameters for every selected object.
  - For each non-primary selected object it stores the local transform relative to the primary (`Math3D.MatrixInvMultiply4(top_transform_ortho, other_mat, inv)`).
- In `PostUpdateGizmo`, each child is rebuilt every frame with `Math3D.MatrixMultiply4(m_TopTransformOrthogonal, local, out)` → `SetTopTransform`. This is how multi-select moves and rotates rigidly around the primary.
- On release it adds redo parameters and calls `GetEditor().InsertAction(m_RewindAction)`.
- In multiplayer it sends a network update every 30 frames (`UPDATE_FRAME_RATE = 30`).

— [E objects/GizmoBase.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/GizmoBase.c)

**Translation drag math.** For an axis drag: build a plane that contains the axis and faces the camera as much as possible, intersect the cursor ray with it, go to local space, subtract the grab offset, zero the other two components, and go back to world space.
```c
// E objects/EditorTranslationGizmo.c  INTERACTION_X_AXIS
vector plane_xy_norm = m_TopTransformOrthogonal[0] * (m_CameraTransform[2] * m_TopTransformOrthogonal[0]);
Plane3D xy_plane = Plane3D(plane_xy_norm, m_TopTransformOrthogonal[3]);
cursor_intersect = xy_plane.Intersect(m_CursorRay);
vector cursor_intersect_xy_local = cursor_intersect.InvMultiply4(m_TopTransformOrthogonal) - m_DragOffset;
cursor_intersect_xy_local[1] = 0; cursor_intersect_xy_local[2] = 0;
if (GetEditor().IsShiftDown()) cursor_intersect_xy_local[0] = Math.Round(cursor_intersect_xy_local[0] * 2.5) / 2.5;   // 0.4 m steps
cursor_intersect = cursor_intersect_xy_local.Multiply4(m_TopTransformOrthogonal);
```
- In Enforce, `*` on two vectors is the cross product. So `axis × (camFwd × axis)` is the plane normal that contains the axis and is most perpendicular to the view. That makes the drag stable from any angle.
- Plane handles (XY, XZ, YZ) intersect with the plane whose normal is the third axis and zero that component.
- The centre handle intersects with the camera-forward plane (`Plane3D(m_CameraTransform[2], pos)`), giving screen-space free move.
- Grid mode rounds the position to 1 m in local space.

— [E objects/EditorTranslationGizmo.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/EditorTranslationGizmo.c)

**Plane3D.Intersect:**
```c
// E classes/DragHandler/EditorObjectDragHandler.c
float denom = vector.Dot(Normal, source.Direction);
if (Math.AbsFloat(denom) > Math.EPSILON) {
    float t = vector.Dot((Center - source.Position), Normal) / denom;
    if (t >= 0) return source.Position + source.Direction * t;
}
return vector.Zero;   // callers treat Zero as "no hit"
```
— [E EditorObjectDragHandler.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/DragHandler/EditorObjectDragHandler.c)

**Rotation drag math.** Intersect the cursor ray with the ring's plane, take the normalised direction from the centre to that point, build an orthonormal basis that keeps the ring axis, then re-apply the uniform scale.
```c
// E objects/EditorRotationGizmo.c  INTERACTION_XZ_ROTATE (yaw ring)
Plane3D xz_plane2 = Plane3D(m_TopTransform[1], m_TopTransform[3]);
vector xz_intersect = xz_plane2.Intersect(m_CursorRay);
vector cursor_intersect_dir = vector.Direction(m_TopTransform[3], xz_intersect); cursor_intersect_dir.Normalize();
cursor_dir_mat = { m_TopTransform[1] * cursor_intersect_dir, m_TopTransform[1], cursor_intersect_dir, m_TopTransform[3] };
Math3D.MatrixOrthogonalize4(cursor_dir_mat);
copyarray(m_TopTransform, cursor_dir_mat);
Math3D.MatrixMultiply3(scale_mat, m_TopTransform, m_TopTransform);
```
- This is absolute: the object's forward snaps to point at the cursor. It is not relative to the grab point. `m_DragRotationOffset` is computed, but the code that would use it is commented out.
- The rotation gizmo has no angle snapping.

— [E objects/EditorRotationGizmo.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/EditorRotationGizmo.c)

**Marker / list drag (the non-gizmo path).** `EditorObjectDragHandler` is started from `EditorObjectMarker`, `EditorPlacedListItem` and `EditorPlacedListNode`. It runs from `GetUpdateQueue(CALL_CATEGORY_GUI)` while `UAFire` is held. Modes:
- **Default:** the object's bottom follows the cursor raycast, which ignores all dragged objects and the player. In Ground mode the cursor ray is terrain-only (`GetCursorRaycastModeSafeEx(ignored_objects, GroundMode)`) and the object keeps its original height above ground (`distance_to_ground` from a downward RV ray). In Magnet mode the up axis is set to the hit normal (`Math3D.DirectionAndUpMatrix(transform[0] * up_dir, up_dir, ...)`).
- **Alt (KC_LMENU):** vertical-only. Intersect with a plane of normal `up × camRight`, then keep only local Y.
- **Shift:** yaw rotation around the bottom centre, toward the cursor intersection on the object's up-plane.
- **Ctrl:** move in the camera-facing plane.

After the drag, the children are rebuilt from the stored local matrices relative to the target. — [E EditorObjectDragHandler.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/DragHandler/EditorObjectDragHandler.c)

**Ground projection helpers:**
```c
static vector ProjectToGround(vector transform[4]) {
    DayZPhysics.RaycastRV(transform[3], transform[3] + vector.Up * -1000, ground, ground_dir, component, null, null, null, false, true);   // groundOnly
    return ground;
}
static bool ProjectToGround4(vector transform[4], out vector result[4])   // "(UNTESTED)": ray along -up, basis from SurfaceGetNormal
```
— [E EditorDragHandler.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/DragHandler/EditorDragHandler.c)

**Align to surface command.** It ray-casts down along −up (RaycastRV, groundOnly) and builds the basis `{n × fwd, n, n × (fwd × Up)}` with `n = SurfaceGetNormal`. The whole thing is a single `SetTransform` undo action. — [E Commands/Objects/EditorAlignToSurfaceCommand.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Commands/Objects/EditorAlignToSurfaceCommand.c)

**Snapping increments:**
- Shift on a gizmo axis snaps to 0.4 m (`round(x*2.5)/2.5`).
- With Grid mode on, `GetGridSize()` returns 1.0, or 3.0 with Alt, or 0.1 with Shift. It is used as the keyboard nudge step, and the gizmo rounds to 1 m.
- There is snap-point snapping (`SnapToNearbyObjects`, `EditorSnapPoint`): local transforms on objects, searched within 60 m, ray-plane tested, then lerped with `MoveInTime`.

— [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c), [E EditorSnapPoint.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorSnapPoint.c)

**Keyboard nudge (arrows, PgUp/PgDn, =/-).**
- Movement happens in one of three frames, set by `QuickMoveMode`: 0 world-flat, 1 camera-flat, 2 camera 3D.
- The step is `QuickMoveRate * dt`; Shift multiplies it by 6.685 and Alt divides it by 6.685.
- With Ctrl held the arrow keys rotate instead (yaw/pitch/roll offsets).
- The transform is applied around the selection's average position: `MatrixInvMultiply4(average_mat, rel_mat)`, add the offset, then multiply by `YawPitchRollMatrix(ori_offset)` at the average.
- Scale is preserved per axis.
- One undo action covers press through release.

— [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)

**Selection highlight.** The bounding box is drawn with `Shape.CreateLines(color, flags, bounding_box_lines, 9)` (four Shape objects), in the colour from the `BoundingBoxColor` setting. — [E EditorObject.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorObject.c)

### Inferences
- The gizmo design is portable to vanilla Enforce: an entity with hiddenSelections, a slab test per handle, and plane intersection. If we want no custom p3d, the handles can be drawn with `Shape.CreateArrow` / `Shape.CreateLines` (ONCE flag each frame), with the same OBB boxes kept for picking.
- Box select via markers is cheap (O(n) `GetScreenPos`), but only objects whose marker is visible (within `MarkerViewDistance`, on screen) are selectable. We could instead project `GetBottomCenter()` with `GetGame().GetScreenPos()` directly.
- The rotation gizmo's absolute "point at cursor" behaviour is a known UX weakness. A relative version would store the angle at grab time (`m_DragRotationOffset`) and apply the delta, plus angle snapping (e.g. 15° with Shift).

### Gaps
- I did not read EditorScaleGizmo.c or EditorTranslationWidget.c in detail.
- I did not read the exact contents of the gizmo p3d models (selection names beyond config hiddenSelections).
- I did not examine `GetCursorRaycastModeSafeEx` in detail; it appears to choose the cursor ray or the camera ray depending on whether the cursor is visible.

---

## 3. Undo/redo, copy/paste/duplicate, delete, hiding map objects

### Takeaway
- **Undo/redo** is a linear array of `EditorAction` objects. Each action stores an undo method name, a redo method name and lists of `Param` objects. Replay uses reflection: `g_Script.Call(this, m_UndoAction, param)` for each param. Objects are referenced by integer session ID, with their `EditorObjectData` kept alive in `m_SessionCache` so deleted objects can be recreated.
- **Copy** serialises `array<ref EditorObjectData>` to JSON on the OS clipboard. **Paste** re-centres the items around the cursor's position. **Duplicate** recreates the objects in place.
- **Map objects** are "hidden" through Dabs Framework's `SuppressedObjectManager`: it scales the object to 1e-6, clears its flags and event mask, `dBodyDestroy`s it, and updates the pathgraph.

### Cited Findings

**Undo stack:**
```c
// E classes/Editor.c
void InsertAction(EditorAction action) {
    for (int i = m_ActionStack.Count() - 1; i >= m_CurrentActionIndex + 1; i--) m_ActionStack.RemoveOrdered(i);   // drop redo branch
    m_ActionStack.Insert(action);
    m_CurrentActionIndex = m_ActionStack.Count() - 1;
}
void Undo() { if (CanUndo()) { m_ActionStack[m_CurrentActionIndex].CallUndo(); m_CurrentActionIndex--; } }
void Redo() { if (CanRedo()) { m_CurrentActionIndex++; m_ActionStack[m_CurrentActionIndex].CallRedo(); } }
```
- The array is unbounded. A separate `EditorActionStack` class with `MAX_SIZE = 512` exists, but `Editor` does not use it. — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c), [E EditorAction.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorAction.c)

**EditorAction:**
- `CallUndo()` runs `foreach (Param param: UndoParameters) g_Script.Call(this, m_UndoAction, param);`, and `CallRedo()` mirrors it.
- The handler methods live on EditorAction itself:
  - `Create(Param)`: either `Param2<int, vector>` (undo-delete: ID plus last position) or `Param1<EditorObjectData>`. It skips the object if the ID already exists.
  - `Delete(Param1<int>)`.
  - `SetTransform(Param4<int, vector pos, vector ypr, float scale>)`: rebuilds the matrix with `YawPitchRollMatrix`, multiplies by scale, then `SetTransform`, `Update` and `UpdateNet`.
  - `Hide`/`Unhide(Param1<int>)`, lock and unlock.
- Every transform-changing command uses the pattern `new EditorAction("SetTransform","SetTransform")` + `InsertUndoParameter(obj.GetTransformArray())` before the change + `InsertRedoParameter(...)` after it + `InsertAction`.

— [E EditorAction.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorAction.c)

**Delete:**
- `DeleteObject(editor_object, create_undo, send_net_message)` refuses objects flagged `NODELETE`, locked or invisible.
- With undo it creates `new EditorAction("Create", "Delete")`, with undo parameter `Param2<int, vector>(GetID(), GetPosition())` and redo parameter `Param1<int>(GetID())`, then calls `m_ObjectManager.DeleteObject`.
- In multiplayer it sends RPC 39253 (`rpc.Write(1); rpc.Write(uuid)`).
- `EditorDeleteCommand` (Delete key): if hidden map objects are selected in the deletions list, it **unhides** them (restores them). Otherwise it deletes the selected placed objects.
- `DELETION_BLACKLIST` = BrushBase, BoundingBoxBase, Man, EditorCamera* (checked through `IsKindOf`).

— [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c), [E Commands/Objects/EditorDeleteCommand.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Commands/Objects/EditorDeleteCommand.c)

**Hiding map objects:**
- `HideMapObject(Object)` wraps the object in `EditorDeletedObject(EditorDeletedObjectData.Create(object))` and stores the data in `m_DeletedSessionCache`. The undo action is `EditorAction("Unhide","Hide")` with `Param1<int>(id)`. It sends RPC 39255 with the object reference in multiplayer.
- The `EditorDeletedObject` constructor keeps the original transform, adds an entry to the right-bar deletions list, and calls `g_Game.GetSuppressedObjectManager().Suppress(GetWorldObject())`. Its destructor calls `Unsupress`.
- `EditorDeletedObjectData.FindObject()` re-finds the map object by type, position and model name, because static map objects cannot be referenced across sessions. The error message is "Failed to find object with name %1:%3 at position %2".

— [E EditorDeletedObject.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorDeletedObject.c), [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)

**Suppression (DF):**
```c
// DF 3_Game/DabsFramework/Suppression/SuppressedObject.c
m_Flags = object.GetFlags(); m_Events = object.GetEventMask(); object.GetTransform(transform);
object.SetScale(0.000001);
object.ClearFlags(m_Flags, true);
object.ClearEventMask(m_Events);
object.SetEventMask(EntityEvent.NOTVISIBLE);
object.Update();
dBodyDestroy(object);
if (m_UpdatedPathgraph) g_Game.UpdatePathgraphRegion(m_Transform[3] - r, m_Transform[3] + r);
```
- The author's comments explain the choices: `SetScale(0)` "will absolutely destroy the heap", `SetScale(0.000001)` "leaves a small piece of geometry", and SetTransform/SetPosition "leaves a client ghost".
- Restoring puts the flags, event mask and transform back, but physics is **not** restored ("todo: crashes. un-deleted objects dont get their physics back").
- The manager syncs between server and client with RPCs `RPC_SUPPRESS = -135295235`, `RPC_UNSUPPRESS = -135295236` and `RPC_UNSUPPRESS_ALL = -135295237`, and has `DispatchInfo(identity)` for players who join later.

— [DF SuppressedObject.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/Suppression/SuppressedObject.c), [DF SupressedObjectManager.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/Suppression/SupressedObjectManager.c)

**Copy / paste / cut:**
```c
// E classes/EditorClipboard.c
static int Copy(notnull array<EditorObject> editor_objects) {
    foreach (... selected_object) world_objects.Insert(selected_object.GetData());
    string clipboard_data = JsonFileLoader<array<ref EditorObjectData>>.JsonMakeData(world_objects);
    if (GetEditor().GetSettings().MinifyCopyData) { strip \r \t \n }
    GetGame().CopyToClipboard(clipboard_data);
}
static int Paste(vector cursor_pos) {
    GetGame().CopyFromClipboard(clipboard_text);
    json_serializer.ReadFromString(read_data, clipboard_text, error);
    average = sum(Position) / count;
    write_data_position = read_data[j].Position - average_position_table + cursor_pos;
    EditorObjectMap editor_objects = GetEditor().CreateObjects(write_data);
    if (MagnetMode) { EditorObjectDragHandler.ProjectToGround4(transform, ground_transform); editor_object.SetBottomTransform(ground_transform); }
    GetEditor().SelectObject(editor_object);
}
```
- Cut is Copy followed by `DeleteObjects` (which carries undo).
- Paste divides by `read_data.Count()` even if some entries have no Type. That is a minor bug.
- Because the clipboard holds plain JSON, users can paste between sessions or tools.

— [E EditorClipboard.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorClipboard.c)

**Duplicate (Ctrl+J).** It recreates each selected object's data in place with `EditorObjectData.Create(GetType(), GetPosition(), GetOrientation(), GetScale(), GetFlags())`, then `ClearSelection`, `CreateObjects` and `SelectObjects(created)`, so the user can drag the copies away straight from the gizmo. — [E Commands/Clipboard/EditorDuplicateCommand.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Commands/Clipboard/EditorDuplicateCommand.c)

### Inferences
- Reflection-based undo (`g_Script.Call` with a method name) is compact, but fails silently on typos or wrong Param types. A typed command pattern (`abstract class EditCmd { void Undo(); void Redo(); }`) is safer in our implementation.
- Restoring a suppressed object does not bring its physics back. For our admin and editor use, hidden map objects should be restored by the persistent loader on restart, not toggled live.

### Gaps
- I did not read `EditorObjectManagerModule.DeleteObject` or the session-cache cleanup in detail.
- I did not verify how `CreateObjects` builds its undo action for multiple objects (most likely one "Delete"/"Create" action with several params).

---

## 4. Camera and the object browser / catalogue

### Takeaway
- **Camera:** the active camera is `EditorCamera_V2`, a scripted `Camera` that runs its own `EOnFrame`. It does velocity-based fly movement on the vanilla UAMove* inputs; mouse-look only happens while RMB is held or the cursor is hidden. Speed defaults to 60 m/s (range 1–300), Shift multiplies by 6.25 and Alt divides by 6.25. Middle-click teleports to the cursor point while keeping the current height above ground. Other features: SmoothCD FOV zoom, an optional sphere-cast collision, and a clamp above the terrain.
- **Catalogue:** built at startup by iterating `CfgVehicles`, `CfgWeapons` and `CfgMagazines` (skipping scope 0 and a forbidden list), adding a "static p3d" variant of every config item's model, and enumerating plant and rock p3ds with `Directory.EnumerateFiles`. The browser tree is a **folder tree built from the model path**. Search is a substring filter (>2 chars) with a favourites toggle. Previews use `ItemPreviewWidget`.

### Cited Findings

**Camera constants:**

| Constant | Value |
|---|---|
| FOV default / min / max | 75° / 1° / 140° |
| `FOV_ZOOM_AMT` | −37.5° |
| Pitch clamp | ±87° |
| View distance (`VIEW_DISTANCE`) | default 800, range 120–6000 |
| `TURBO_MULTIPLIER` | 2.5 |
| Speed | default 60, range 1–300 |
| Collision radius (`CAMERA_COLLISION_RADIUS`) | 0.2 |

Settings are a `ProfileSettings` class with slider attributes, e.g. `[RegisterProfileSettingSlider("CAMERA", "Speed", "Camera Speed (m/s)", ...)]`. — [E EditorCamera.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorCamera.c)

**EOnFrame logic:**
```c
float forward = UAMoveForward - UAMoveBack; float strafe = UAMoveRight - UAMoveLeft; float altitude = UAMoveUp - UAMoveDown;
movement = Vector(strafe, altitude / 1.618, forward);
float speed = Speed; if (UATurbo) speed *= (TURBO_MULTIPLIER * TURBO_MULTIPLIER); if (UALookAround) speed /= (TURBO_MULTIPLIER * TURBO_MULTIPLIER);
m_AngularVelocity += rotation * Math.RAD2DEG * 2; orientation -= m_AngularVelocity * timeSlice; clamp pitch ±87
m_LinearVelocity += transform[0]*movement[0]*speed + transform[1]*movement[1]*speed*2 + transform[2]*movement[2]*speed;
next_position = transform[3] + m_LinearVelocity * timeSlice;
if (CameraCollision) DayZPhysics.SphereCastBullet(transform[3], next_position, 0.2, TERRAIN|BUILDING|ROADWAY|FENCE, this, ...) -> stop at hitPos + hitNormal*0.1
if (!AllowUnderEarth) y = max(SurfaceY + NearPlane*2, y)
m_AngularVelocity *= SmoothingLevel; m_LinearVelocity *= SmoothingLevel;   // smoothing 0 = no inertia
m_CameraFovActual = Math.SmoothCD(..., FieldOfView2*DEG2RAD + zoom*FOV_ZOOM_AMT, ...)
GetGame().GetWorld().SetViewDistance(ViewDistance); SetObjectViewDistance(ViewDistance);
```
- Teleport: target = cursor raycast hit (or 250 m along the ray). Its Y is set to `SurfaceY + current height above ground`, the camera moves there by impulse `m_Impulse = target - pos` and eases at `5 * m_Impulse * dt` per frame.
- `ECameraLockFlag` (`LOCK_LOOK`, `LOCK_MOVE`, `PAN_LOOK`, `INVERT_*`) is computed in `Editor.GetCameraLockFlags()`:
  - With the cursor visible, look is locked unless RMB (`UATempRaiseWeapon`) is held.
  - With RMB held and the cursor hidden, the camera pans.
  - Holding Ctrl locks movement, so WASD can't move the camera while Ctrl shortcuts are used.
  - Dialogs, the map and edit boxes lock everything.

— [E EditorCamera.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorCamera.c), [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)
- The mouse wheel changes camera speed by `0.1 * Speed` per tick through the inputs `EditorCameraToolSpeedIncrease`/`Decrease` (mWheelUp/Down), clamped to 1–300. — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c), [E Data/Inputs.xml](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/Data/Inputs.xml)
- There are also camera tracks (cinematic paths): Hermite spline interpolation (`H00/H10/H01/H11`, `ComputeHermiteTangents`) through the camera-track nodes. — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c)

**Catalogue construction** (`EditorObjectManagerModule` constructor):
```c
static const ref array<string> VALID_CONFIG_PATHS = { CFG_VEHICLESPATH, CFG_WEAPONSPATH, CFG_MAGAZINESPATH };
for (...ConfigGetChildrenCount(path)) {
    int scope = GetGame().ConfigGetInt(path + " " + type + " scope"); if (scope == 0) continue;
    string model = ConfigGetTextOut(path type model) -> lowercased, leading slash stripped, ".p3d" appended if missing;
    if (IsForbiddenItem(type)) continue;
    placeable_item = EditorPlaceableItem.Create(path, type, scope);
    if (land_/staticobj_) Scope = 2; if (IsKindOf Inventory_Base/Weapon_Base/DZ_LightAI/Magazine_Base) Scope = 1;
    m_PlaceableObjectsByP3dPath[model] / ByP3dFile[file] maps; plus a STATIC variant EditorPlaceableItem.Create(model)
}
array<string> paths = { "DZ/plants", "DZ/plants_bliss", "DZ/plants_sakhal", "DZ/plants_takistan", "DZ/rocks", ... };
Directory.EnumerateFiles(model_path, "*.p3d", 16) -> STATIC placeables
+ scripted: NetworkSpotLight, NetworkPointLight, NetworkParticleBase, RegisterScriptedEntity.Instances
```
- `Directory.EnumerateFiles` is a DF helper.
- `IsForbiddenItem` skips types containing "Fx", ItemOptics, AKM_TESTBED, Red9, QuickieBow, LargeTentBackPack, survivor bases, Land_VASICore, GP25Base/M203Base kinds, Groza and others that crash or spam errors.
- The p3d maps let Ctrl+Click on a map object resolve back to a placeable through `GetReplaceableObjects(model_name)`, using `Object.GetShapeName()`/`GetDebugNameNative()`.

— [E modules/EditorObjectManager.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/modules/EditorObjectManager.c), [E EditorPlaceableItem.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorPlaceableItem.c)
- `EditorPlaceableItem` has `Category ∈ {CONFIG, STATIC, SCRIPTED}`, `Scope`, `Type`, `Path`, `ConsoleFriendly` (model under `dz\`) and favourites (`Settings.FavoriteItems`). `GetSpawnType()` returns the p3d path for STATIC and the class name otherwise. — [E EditorPlaceableItem.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/EditorPlaceableItem.c)

**Browser tree (EditorHud constructor).** Each item's model path is split on the path separator. One `EditorFolderListNode` is created per path prefix (cached in `m_FolderNodes[full_path]`), and items are attached as `EditorPlaceableListNode` leaves; nodes are also indexed by depth. `RefreshSearchBar()` walks depth levels bottom-up: `search_succeed = node.FilterType(search_string, favorite_toggle)` when the search text is longer than 2 characters, and parent folders reveal themselves if any child is visible. Console mode hides items that are not `ConsoleFriendly`. — [E gui/EditorHud.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/gui/EditorHud.c)

**Previews.** `EditorListItemTooltip` and `EditorPlaceableListItem` use `ItemPreviewWidget.SetItem(previewObj); SetView(0)`. Node icons are `Symbols` font glyphs per kind (tree, money-bill, shovel, house), not rendered thumbnails. — [E gui/ListItem/EditorListItemTooltip.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/gui/ListItem/EditorListItemTooltip.c), [E gui/ListItem/EditorPlaceableListNode.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/gui/ListItem/EditorPlaceableListNode.c)

### Inferences
- The catalogue can be copied in vanilla Enforce with `ConfigGetChildrenCount`, `ConfigGetChildName` and `ConfigGetInt(scope)`. `Directory.EnumerateFiles` is DF; vanilla `FindFile`/`FindNextFile` on `DZ/plants/*` may not enumerate PBO contents. Our tool could ship a pre-generated p3d list instead.
- Basing the tree on model paths gives a natural category tree (`dz/structures/...`) with no hand-made categories.

### Gaps
- I did not check whether `Directory.EnumerateFiles(path, "*.p3d", 16)` works inside PBOs with vanilla APIs.
- I did not determine how the preview object for `ItemPreviewWidget` is spawned (likely a local CreateObjectEx).

---

## 5. Full hotkey list and UI layout

### Takeaway
There are two hotkey systems:
1. **Command shortcuts**: each `EditorCommand.GetShortcut()` returns a list of KeyCodes. `CommandManager` maps the bitmask to the command, and `Editor.OnKeyPress` keeps the set of currently held keys and looks up the mask.
2. **UA inputs** from `Inputs.xml`, for continuous actions (camera, nudge, toggles).

The HUD is a left bar (placeables browser with Config/Static tabs, search and favourites), a right bar (Placed / Deleted / Players lists), a top menu bar (File/Edit/View/Editor) with a toolbar for gizmo modes and toggles, the 2D map (M), and a canvas overlay for marquee drawing.

### Cited Findings

**Dispatch.** `m_CurrentKeys.Insert(key); EditorCommand command = CommandManager.GetCommandFromShortcut(m_CurrentKeys.GetMask()); if (!command.CanExecute()) return false; ... command.Execute(this, args);`. When a command fires, UAMove* inputs are `Supress()`ed so the camera does not drift afterwards. Commands register with `m_CommandShortcutMap.Insert(command.GetShortcut().GetMask(), command)`. — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c), [E Commands/EditorCommandManager.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Commands/EditorCommandManager.c)

**Command shortcuts from code** (`GetShortcut()` in each command file under [E classes/Commands/](https://github.com/InclementDab/DayZ-Editor/tree/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Commands)):

- **File**

  | Key | Command |
  |---|---|
  | Ctrl+N | New |
  | Ctrl+O | Open |
  | Ctrl+S | Save |
  | Ctrl+Shift+S | Save As |
  | Ctrl+W | Close |
  | Esc | Escape |

- **Edit**

  | Key | Command |
  |---|---|
  | Ctrl+Z | Undo |
  | Ctrl+Y | Redo |
  | Ctrl+C | Copy |
  | Ctrl+X | Cut |
  | Ctrl+V | Paste |
  | Ctrl+J | Duplicate |
  | P | Copy Position |
  | Delete | Delete |
  | Ctrl+A | Select All |
  | Ctrl+D | Clear Selection |
  | Ctrl+I | Invert Selection |

- **Selection mode**

  | Key | Mode |
  |---|---|
  | I | Box |
  | O | Ellipse |
  | P | Lasso (**clashes with Copy Position, which is also P**) |
  | U | Object selection toggle |

- **Objects**

  | Key | Command |
  |---|---|
  | Ctrl+T | Properties |
  | L | Lock |
  | Ctrl+L | Unlock |
  | Ctrl+Shift+L | Unlock All |
  | H | Hide |
  | Ctrl+H | Show |
  | K | Toggle Simulation |
  | Ctrl+Alt+T | Edit Inventory |
  | Ctrl+Home | Place Object |
  | Ctrl+Numpad1 / Ctrl+Numpad2 / Ctrl+Numpad3 | Translation / Rotation / Scale gizmo |

- **Modes**

  | Key | Mode |
  |---|---|
  | Ctrl+1 | Magnet |
  | Ctrl+2 | Ground |
  | Ctrl+3 | Snap |
  | Ctrl+4 | Grid **and** Collision (both commands return Ctrl+4 in code, so it is a clash) |

- **HUD and camera**

  | Key | Command |
  |---|---|
  | Ctrl+F | Search |
  | Ctrl+Shift+F | Search Object |
  | Ctrl+Shift+I | Environment |
  | Ctrl+Shift+T | Camera Controls |
  | Ctrl+Alt+C | Camera Collision |
  | Shift+L | Camera Light |
  | Ctrl+Shift+U | Reload HUD |
  | Play/Pause | Camera track run |

**UA inputs** ([E Data/Inputs.xml](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/Data/Inputs.xml)):

| Key | Input |
|---|---|
| E | EditorCycleWidget (cycles gizmo mode) |
| Wheel | Camera speed |
| W / A / S / D | Camera move |
| Q / Z | Camera up / down |
| LShift / LAlt | Turbo / slow |
| RMB+Wheel | Zoom |
| RMB+MMB | Zoom reset |
| Home | Toggle editor / player |
| Y | Toggle UI |
| Space | Toggle cursor |
| Ctrl+Tab | Inventory editor |
| M | Map |
| Delete | Delete object |
| T | Teleport player to cursor |
| Arrows | Nudge X/Z |
| PgUp / PgDn | Nudge Y |
| Ctrl+Left / Ctrl+Right | Rotate |
| = / - | Scale up / down |

- **Mouse and modifiers in code:**
  - LMB: select or place.
  - Shift+LMB: add to selection, or keep placing.
  - Ctrl+LMB: toggle selection, or pick a map object into hand.
  - Ctrl+MMB: delete or hide the world object.
  - MMB: camera teleport.
  - RMB held: mouse-look.
  - R while placing: +90° yaw.
  - Shift during an axis drag: 0.4 m snap.
  - Alt / Shift / Ctrl during a marker drag: vertical / rotate / camera-plane movement.

  — [E Editor.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c), [E EditorObjectDragHandler.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/DragHandler/EditorObjectDragHandler.c)

**Official wiki shortcut table** (older, partly out of date):
- Ctrl+1 Magnet, Ctrl+2 Ground, Ctrl+4 Collision, Ctrl+5 Camera Light (the code now uses Shift+L).
- Click Marker to select, Ctrl+Click Marker to toggle, Shift+Click Marker to add.
- Ctrl+MMB deletes a world object. Ctrl+LMB gets an object from the world.
- M map, Y UI, Space cursor, T teleport character.
- Camera: MMB teleport, Alt slow, Shift fast, Q/Z up and down, "C + Mouse ↑/↓" for camera speed (the code now uses the wheel).
- HOME to play as character, Tab inventory, Ctrl+Tab inventory editor.
- Alt + arrow keys moves objects slowly.

— [GitHub wiki: 4. Shortcuts](https://github.com/InclementDab/DayZ-Editor/wiki/4.-Shortcuts)

**UI layout:**
- `EditorHudController` binds ObservableCollections `LeftbarSpacerConfig`, `LeftbarSpacerStatic`, `RightbarPlacedData`, `RightbarDeletionData` and `RightbarPlayerData`.
- Widgets include `LeftbarFrame`, `RightbarFrame`, `LeftbarScroll`, `RightbarScroll`, the tab buttons (`PlacementsTabButton`, `DeletionsTabButton`, `PlayerTabButton`, `FavoritesTabButton`, `LeftbarCategoryStatic`, `LeftbarCategoryConfig`), `MenuBarFile`, `MenuBarEdit`, `MenuBarView`, `MenuBarEditor`, `GizmoTranslateButton`, and hide buttons for both bars.
- Layouts live under `DayZEditor/GUI/layouts/{hud,dialogs,menus,tooltips,cameratrack,inventory,...}`.
- Fonts are FiraCode at 12–64 px.

— [E gui/Controllers/EditorHudController.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/gui/Controllers/EditorHudController.c), [GUI/layouts](https://github.com/InclementDab/DayZ-Editor/tree/legacy/DayZEditor/GUI/layouts)

### Inferences
- The "command object that owns name, icon, shortcut, CanExecute and Execute" pattern drives the menus, the toolbar and the hotkeys from a single registration. It is worth copying.
- Holding the set of pressed keys as a bitmask is simple, but it is order-independent and does not distinguish LCtrl from RCtrl. The current code also has real shortcut clashes (Ctrl+4, P).

### Gaps
- Full layout files were not opened, so I have no exact widget hierarchy and no screenshot-level UI description.
- The shortcuts for import, export, brush and camera-track commands were not all listed; the loop only caught commands with a single `return {...}`.

---

## 6. Notable snippets index (for the report writer)

### Takeaway
All requested snippets are quoted above, with exact source paths:
- gizmo drag math: Translation axis and plane code, Rotation ring code
- raycast object picking: `Editor.Update`, `PerformRaycast`, DF `PerformRaycastRVEX`, click-select
- box selection projection: `EditorHud` marker test plus `EditorObjectWorldMarker` `GetScreenPos`
- ground snapping: `SetBottomTransform`, `HandleHands`, `ProjectToGround`, AlignToSurface
- object copy: `EditorClipboard.Copy`/`Paste`, `EditorDuplicateCommand`

### Cited Findings
- Gizmo ray-vs-OBB, drag-start offset and child local matrices — [E objects/GizmoBase.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/GizmoBase.c)
- Axis and plane constrained translation — [E objects/EditorTranslationGizmo.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/EditorTranslationGizmo.c)
- Ring rotation — [E objects/EditorRotationGizmo.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/objects/EditorRotationGizmo.c)
- Plane3D and the marker drag modes — [E classes/DragHandler/EditorObjectDragHandler.c](https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/DragHandler/EditorObjectDragHandler.c)
- Ray and Raycast wrappers — [DF !Core/Ray.c](https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/!Core/Ray.c)

### Inferences
- A minimal vanilla port needs about seven pieces: Ray/Plane helpers, `EditorWorldObject` bottom/top transform helpers, a gizmo with OBB handles, a drag handler, an undo stack of typed commands, a marker-based screen projection for marquee selection, and JSON clipboard via `GetGame().CopyToClipboard`.

### Gaps
- No runtime testing was done. Everything above comes from reading the source at commit a55ec49 (2026-10-25).
- Behaviour on DayZ 1.30 is assumed to work because the Workshop build is current. DF has a reverted "fix/1.30-compat" PR (#44, reverted by #45, 2026-10-07), which hints at 1.30 compatibility churn.
