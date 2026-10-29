# DayZ Editor (.dze) file format, export and import formats

Research date: 2026-10-28. All findings come from primary source code:
- DayZ-Editor, default branch `legacy` (last commit 2026-10-25, a55ec49). It is the active branch; `production`/`development` were last touched in early 2024 and hold no file-format code. Base: https://github.com/InclementDab/DayZ-Editor/tree/legacy
- The save-data classes are **not** in the Editor repo. They live in Dabs Framework (`DF_Scripts`, a required addon), branch `production` (pushed 2026-10-27): `DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/` — https://github.com/InclementDab/DayZ-Dabs-Framework/tree/production/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor
- DayZ-Editor-Loader, branch `main` (pushed 2025-08-21): https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c

Short names used below:
- [SaveData] = https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/EditorSaveData.c
- [ObjData] = https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/EditorObjectData.c
- [DelData] = https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/EditorDeletedObjectData.c
- [Flags] = https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/EditorObjectFlags.c
- [CamTrack] = https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/EditorCameraTrackData.c
- [DZEFile] = https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/EditorDZEFile.c
- [Loader] = https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/EditorLoader/Scripts/5_Mission/EditorLoader/Mission/MissionServer.c
- [BinTool] = https://github.com/InclementDab/DayZ-Editor/blob/legacy/BinEditor/Enfusion-Deserializer/DayZ-Bin-Editor/Enfusion/EnfusionSerializer.cs (the author's own C# reader for the binary format)
- FileTypes dir = https://github.com/InclementDab/DayZ-Editor/tree/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes

## What is the .dze file structure?

### Takeaway
A `.dze` is either (a) a **binary** Enforce `FileSerializer` stream starting with the string `"EditorBinned"` (what the current editor always writes; current version **8**), or (b) a **JSON** serialization of the same `EditorSaveData` class (what older editors wrote; still readable). Both loaders sniff the first string: if it equals `EditorBinned` it is binary, otherwise JSON. Deleted map objects are identified by **position + model (shape) name** in v6+ (with a legacy fallback on class `Type`), searched within 0.1 m; there is no object ID.

### Cited Findings

**Top-level class `EditorSaveData` ([SaveData])**
- Fields (exact names): `static const string BIN_CHECK = "EditorBinned"` (NonSerialized), `static const int Version = 8`, `string MapName`, `string AuthorId` ("Steamid64 of original author"), `ref array<string> CreditIds` ("SteamId64 of all users that have edited / saved this build"), `DateTime LastModified`, `DateTime CreationDate`, `vector CameraPosition`, `ref array<ref EditorObjectData> EditorObjects`, `ref array<ref EditorDeletedObjectData> EditorHiddenObjects`, `ref array<ref EditorCameraTrackData> CameraTracks` — [SaveData]
- `DateTime` is `class DateTime: int` — a Unix-epoch seconds count (Create() adds days*DAY + hour*HOUR + minute*MINUTE + second from 1970) — so it serializes as a 32-bit int — https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/1_Core/DabsFramework/DateTime.c
- When saving, the editor sets `MapName = GetGame().GetWorldName()`, `CameraPosition = GetCamera().GetPosition()`, `LastModified = DateTime.Now()` (UTC by default), keeps the original `CreationDate`, appends the saver's UID to `CreditIds`; it saves only placed objects whose Type is not empty, that lack the `NOSAVE` flag and that have a live world object — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c (CreateSaveData, ~line 3201)

**Binary write order (`EditorSaveData.Write`)** — [SaveData]
1. string `BIN_CHECK` ("EditorBinned")
2. int `Version` (8)
3. string `MapName`
4. vector `CameraPosition`
5. string `AuthorId`; int count + N strings `CreditIds`   (read only if version >= 7)
6. int `LastModified`; int `CreationDate`                (read only if version >= 7)
7. int count + N × `EditorObjectData`
8. int count + N × `EditorDeletedObjectData`
9. int count + N × `EditorCameraTrackData`              (read only if version > 5; `if (read_version <= 5) return true;`)

**Primitive encoding of Enforce FileSerializer** (from the author's C# reader [BinTool] and confirmed by hex of a real file):
- int: 4 bytes little-endian; float: 4-byte LE IEEE single; bool: written as a 4-byte int (0/1) ("Booleans in enfusion are literally just integers") — [BinTool]
- string: int32 length followed by the bytes, no terminator — [BinTool]. (Note the C# writer uses `value.Length` (UTF-16 char count) instead of the UTF-8 byte count — a bug for non-ASCII names; a correct writer should use the byte length.)
- vector: int32 component count (always 3) followed by 3 floats — [BinTool] ("length is always 3")
- Hex of the real file `TestingDab.dze` begins `0c000000 "EditorBinned" 03000000 0d000000 "ChernarusPlus" 03000000 <3 floats> 0f000000 ...` (length 12, version 3, map name, vector with count 3, then 15 objects) — https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/Missions/EditorLoader.ChernarusPlus/EditorFiles/TestingDab.dze

**`EditorObjectData` (placed object) ([ObjData])**
- Serialized JSON fields: `string Type` ("Corresponds to the spawnable typename, identical to ITEM_SpawnerObject.name"), `string DisplayName`, `vector Position`, `vector Orientation`, `float Scale = 1`, `map<int, ref EditorObjectData> AttachmentMap` (slot id → nested object), `string Model`, `EditorObjectFlags Flags`. NonSerialized (JSON-invisible): `EditorOnly`, `Locked`, `AllowDamage`, `Simulate`, `Attachments` (array<string>), `BottomCenter`, `Mod`, `Icon`, `WorldObject`, `Parameters` — [ObjData]
- Binary write order: `Type`, `DisplayName`, `Position`, `Orientation`, `Scale`(float), `Flags`(int); stop if version < 2; if version < 8: int count + strings `Attachments`; then `Parameters`: int count, then per entry string key, string type name (e.g. `SerializableParam1<string>`), then the param's values; stop if version < 3; then 4 bools `EditorOnly`, `Locked`, `AllowDamage`, `Simulate`; stop if version < 5; string `Model`; (v8) int count + per entry int `slot_id` + recursive EditorObjectData — [ObjData]
- Asymmetry to be aware of: `Write` emits the AttachmentMap whenever version >= 5, but `Read` only reads it when version >= 8 (`if (version < 8) return true;`). Since the writer always uses the current Version (8) this does not matter for current files — [ObjData]
- Parameters are typed `SerializableParam1..N<T...>`; each param writes its values with the serializer in order (`ctx.Write(param1) && ctx.Write(param2)...`) — https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/1_Core/DabsFramework/Managed/SerializableParam.c. Known uses: Expansion trader type stored as `Parameters["ExpansionTraderType"] = SerializableParam1<string>` — FileTypes/EditorExpansionFile.c; `SerializedBuilding.Read/Write(map<string, ref SerializableParam>)` for networked buildings (lights etc.) — https://github.com/InclementDab/DayZ-Dabs-Framework/blob/production/DabsFramework/Scripts/3_Game/DabsFramework/!Core/SerializedBuilding.c
- An object whose `Type` contains `.p3d` is a static P3D object. On export to .dze the editor converts it: `Position = Position - GetP3dBoundingCenter(type)` and `Orientation = Orientation * DEG2RAD`; on import it does the inverse (adds bounding centre, multiplies by RAD2DEG). So **for .p3d entries the file stores model-origin position and orientation in radians; for class-name entries it stores world position and degrees** — [DZEFile]

**`EditorObjectFlags` (bitmask, int) ([Flags])**
- `NONE=0, BBOX=2, MAPMARKER=4, OBJECTMARKER=8, LISTITEM=16, PERSISTENCE=32, LOCKED=64, EDITOR_ONLY=128, SIMULATE=256, ALLOW_DAMAGE=512, HIDDEN=1024, NOSAVE=2048, NODELETE=4096, BRUSHED=8192`; `EFE_DEFAULT = BBOX|MAPMARKER|OBJECTMARKER|LISTITEM` (=30); `EFE_BRUSHED = LISTITEM|BRUSHED` — [Flags]
- Real files use `Flags: 2147483647` (int.MAX, older "ALL" value) or `30` — https://github.com/DayZNETWORk/EditorFiles/blob/main/codelocks.dze ; https://github.com/iLLMannerSevs/DZE_Sessions/blob/main/Shed_Mil_Squad.dze. The author's C# enum also has `ALL = 2147483647` — https://github.com/InclementDab/DayZ-Editor/blob/legacy/BinEditor/Enfusion-Deserializer/DayZ-Bin-Editor/Editor/EditorSaveData.cs
- Locked / editor-only / simulate / allow-damage are stored twice in the binary: as dedicated bools (v3+) and implicitly as flag bits. The Loader uses the bools: it skips objects with `EditorOnly` and calls `DisableSimulation` when `!Simulate` — [Loader]

**`EditorDeletedObjectData` (hidden/deleted map object) ([DelData])**
- Serialized fields: `string Type` (comment: "Depreciated"), `string ModelName`, `vector Position`, `int Flags`. NonSerialized: `ID`, `Orientation` ("explicitly for expansion .map file"), `WorldObject` — [DelData]
- Binary write: `Type`, `Position`, `Flags`, `ModelName`. Read: Type is read **except when version is 6 or 7** ("this was a horrendous bug that broke backwards compatibility on these versions specifically"); `ModelName` read only if version >= 6 — [DelData]
- **Identification:** `FindObject(radius = 0.1)` calls `GetObjectsAtPosition3D(Position, 0.1, ...)`, then matches each object's `GetShapeName()` (lower-cased, trimmed, `/`→`\`) against `ModelName` ("New way"), else falls back to `g_Game.ObjectGetType(object) == Type` ("Deprecated"). No object ID is stored. ModelName is filled from `WorldObject.GetShapeName()` when the deletion is made — [DelData]
- The Loader hides found objects with `GetDayZGame().GetSuppressedObjectManager().Suppress(obj)` (server-side), not by deleting them — [Loader]
- In the v3 sample file the 635 deleted entries have `Type: ""` (empty) and only a position + Flags 0 (verified by parsing the file to EOF with a small reader) — https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/Missions/EditorLoader.ChernarusPlus/EditorFiles/TestingDab.dze

**`EditorCameraTrackData` ([CamTrack])**: extends EditorObjectData (Type `"DSLRCamera"`, Position, Orientation) and appends `float Time` after the base object data.

**JSON variant**
- Current loaders: if the file is not binned, the editor uses `EditorJsonLoader<EditorSaveData>.LoadFromFile`, then rebuilds each object with `EditorObjectData.Create(Type, Position, Orientation, Scale, Flags)` and each deletion with `EditorDeletedObjectData.Create(Type, Position)` + Flags (so JSON `ModelName`, `DisplayName`, `AttachmentMap` are dropped on import; Model is recomputed) — [DZEFile]. The Loader uses `JsonSerializer().ReadFromString(save_data, ...)` directly — [Loader]
- Real-world JSON example (older editor, object list abbreviated):
```json
{
    "Version": 1,
    "MapName": "ChernarusPlus",
    "CameraPosition": [10246.2587890625, 46.484676361083987, 3744.936767578125],
    "EditorObjects": [
        {
            "Type": "CombinationLock4",
            "DisplayName": "CombinationLock4",
            "Position": [10244.6669921875, 44.71049499511719, 3718.904541015625],
            "Orientation": [0.0, -0.1483449786901474, 13.85632038116455],
            "Scale": 0.9903935790061951,
            "Flags": 2147483647
        }
    ],
    "EditorDeletedObjects": []
}
```
 — https://github.com/DayZNETWORk/EditorFiles/blob/main/codelocks.dze (and Berezino_Military.dze in the same repo)
- Real JSON with deletions (Namalsk): `"EditorDeletedObjects": [ { "Type": "TreeHard_t_PiceaAbies_2fb_dark", "Position": [3030.0546875, 61.2509765625, 7258.48388671875], "Flags": 0 }, ... ]` — https://github.com/XxFri3ndlyxX/MetallurgyForgingNamalskFiles/blob/main/regular.namalsk/EditorFiles/Namalsk%20Mine%20Objects%20And%20Deletion.dze
- Many JSON files omit `"Version"` entirely (e.g. start.dze, Shed_Mil_Squad.dze, NEAF.dze) — https://github.com/DayZNETWORk/EditorFiles ; https://github.com/Boogahadeen/DayZ-PC-Modded-Server-Files/tree/main/mpmissions/dayzOffline.chernarusplus/EditorFiles

**Binary layout example (v3, hex of TestingDab.dze, first object)**: string "StaticObj_Wall_Canal_10" (len 0x17) ×2 (Type, DisplayName), vector(3) position, vector(3) orientation `0, -0, -0`, Scale `0x3f7ffffe` (≈0.9999999), Flags `0x7fffffff`, then attachments count 0, params count 0, four 4-byte bools 0 — https://github.com/InclementDab/DayZ-Editor-Loader/blob/main/Missions/EditorLoader.ChernarusPlus/EditorFiles/TestingDab.dze (parsed by me; layout follows [ObjData] v3 path)

**Third-party reader**: Shawminator's DayZeEditor reads binary .dze with `const int Version = 8`, reading LastModified/CreationDate as Int32 and refusing newer versions; its JSON model adds `Uuid`, `m_Id`, `AuthorID`, `CreditsID` (different spellings from the real class) — https://github.com/Shawminator/DayZeEditor/blob/master/DaZeLib/EditorDze/DZE.cs

### Inferences
- A compatible binary writer should emit version 8 exactly in [SaveData] order; a reader must branch on version as in [ObjData]/[DelData] (v<2, <3, <5, <8 for objects; v6/7 Type quirk for deletions; v>=7 author block; v>5 camera tracks).
- Deleted entries with empty `Type` and no `ModelName` (v3–v5 era) match any object at that spot (within 0.1 m) whose config type is also empty — typically trees/rocks/terrain clutter without a CfgVehicles class. That is a position-only match in practice.
- JSON field rename: the array of deletions was `EditorDeletedObjects` up to at least Feb 2024 (DabsFramework commit 7469248, Version = 3) and is now `EditorHiddenObjects`. Because Enforce's JsonSerializer maps by field name, older JSON files' deletions will probably be silently ignored by the current Editor and Loader. A compatible reader should accept both keys.
- Orientation vector order is (yaw, pitch, roll) in degrees, which is the Enforce `GetOrientation()` convention; the editor's own Object Spawner export copies `Orientation[0..2]` straight into `ypr[0..2]` (FileTypes/EditorObjectSpawnerFile.c), which confirms it.
- Position is absolute world coordinates (x, y = altitude above sea level, z). No exporter applies a terrain-relative height (see the export section).

### Gaps
- When exactly (which commit/version) `EditorDeletedObjects` was renamed to `EditorHiddenObjects`, and what changed in versions 4 and 6, was not pinned to a commit; only the current read branches show the differences.
- I did not find a public current-version (v8) binary sample; the only binary sample is v3. The v8 layout is from code, not from a sample file.
- Exact JSON shape of `AttachmentMap` (Enforce JsonSerializer map<int, ...> encoding) not verified against a real file.

## Which export formats exist, and what do they look like?

### Takeaway
The Export menu offers: **.dze**, **init.c (SpawnObject)**, **Object Spawner JSON (cfggameplay)**, **Expansion .map**, **Terrain Builder .txt**, **VPP .vpp**, **events.xml-style positions**, and **mapgrouppos.xml**. COM JSON export code exists but is commented out of the menu. There are also clipboard exports (event group / cfgeventspawns / events.xml snippets) and an "Export Relative" .dze. Every exporter writes absolute world positions; orientation is (yaw, pitch, roll) degrees except in Terrain Builder (recomputed) and mapgrouppos (rpy order plus `a`).

### Cited Findings

**Menu list** — Export menu buttons: `EditorExportToDZEFile`, `EditorExportToInitFile`, `EditorExportToObjectSpawner`, divider, `EditorExportToExpansion`, `EditorExportToTerrainBuilder`, `EditorExportToVPP`, `//EditorExportToCOM` (commented), `EditorExportToEvents`, `EditorExportToMapGroupPos` — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/gui/Menus/Menus/EditorExportMenu.c
- All exports go through `EditorExportCommandBase.ExportFile`, which builds `CreateSaveData(extra_settings & EXPORT_SELECTED_ONLY)` and then calls the file type's `Export` — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Commands/Export/EditorExportCommands.c
- `ExportSettings` has `Binarized = true`, `ExportHeightType HeightType` (ABSOLUTE/RELATIVE), `vector ExportOffset`, `string ExportSetName`, but the only UI setting is "Export Selected Only"; a grep shows no exporter reads HeightType/ExportOffset/Binarized — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/3_Game/DayZEditor/classes/ExportSettings.c
- `CanDoDeletion()` returns true only for the DZE and Expansion file types (base returns false), so only those two carry deleted objects — FileTypes/EditorDZEFile.c, EditorExpansionFile.c, https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/3_Game/DayZEditor/classes/EditorFileType.c

**1. DayZ Editor .dze** — always binary, current Version — [DZEFile] (`data.Write(file_serializer, EditorSaveData.Version)`).

**2. init.c / SpawnObject (`EditorInitFile`, extension `.c`)** — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/EditorInitFile.c
- Copies the template `DayZEditor/scripts/data/Defaults/init.c` (defines `static Object SpawnObject(string type, vector position, vector orientation, float scale = 1.0)`) then appends:
  - `// Paste anything below this line into the bottom of your 'void main()' function`
  - `// Created Objects`
  - one line per object: `SpawnObject("%1", "%2", "%3", %4);` = type, `Position.ToString(false)`, `Orientation.ToString(false)`, Scale → e.g. `SpawnObject("Land_Wall", "4525.95 340.817 9981.35", "0 0 0", 1);` (space-separated vector strings, no brackets)
  - commented `// GetCEApi().ExportProxyData(Vector(7500, GetGame().SurfaceY(7500, 7500), 7500), 20000);`
- Backslashes in type are replaced with `/`; for `.p3d` types position has the bounding centre subtracted and orientation converted to radians. **Deleted objects are not exported.**
- The template's SpawnObject uses `CreateStaticObjectUsingP3D` for `.p3d` types, else `CreateObjectEx(type, position, ECE_SETUP | ECE_CREATEPHYSICS | ECE_NOLIFETIME | ECE_NOPERSISTENCY_WORLD | ECE_NOPERSISTENCY_CHAR)`, then SetPosition/SetOrientation/SetScale and pathgraph update — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/Data/Defaults/init.c

**3. Object Spawner JSON (`EditorObjectSpawnerFile`, `.json`)** — vanilla cfggameplay `objectSpawnersArr` format, class `ObjectSpawnerJson { Objects: [ITEM_SpawnerObject] }` with fields `name`, `pos[3]`, `ypr[3]`, `scale`, `enableCEPersistency=false` — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/EditorObjectSpawnerFile.c
- `ypr[i] = Orientation[i]` (degrees); `.p3d` names get origin position and radians. Quirk: `if (name.Contains("dz")) name.Replace("dz", "DZ");` — any lowercase "dz" substring in a type name is upper-cased. No deletions.

**4. Expansion .map (`EditorExpansionFile`, `.map`)** — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/EditorExpansionFile.c
- Deletions first: `-%1|%2|%3` = `-Type|x y z|yaw pitch roll` (deleted entries with empty Type are skipped; orientation from the live WorldObject).
- Objects: `Type|x y z|yaw pitch roll`; with trader param and attachments: `Type.TraderType|x y z|yaw pitch roll|Att1,Att2`. Position and orientation come from the live `WorldObject`, not the save data. Quirk: the attachments column is only written when a trader param also exists.
- Import: lines starting `//` skipped; `|`-split; `Type.Trader` split on `.`; leading `-` = deletion (position only, Create(type, pos)); objects get Scale 1 and EFE_DEFAULT.

**5. Terrain Builder text (`EditorTerrainBuilderFile`, `.txt`)** — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/EditorTerrainBuilderFile.c
- Line: `"%1";%2;%3;%4;%5;%6;%7;%8` = `"modelName";X;Z;yaw;pitch;roll;scale;Y`
- modelName = p3d file name without folders, `.p3d` and `Land_` removed (falls back to Type, or `UNKNOWN_OBJECT`).
- X is prefixed with characters from `"200000"` so the integer part has 6 digits (`String("200000").Substring(0, 6 - cnt) + x`), i.e. the TB 200000 easting offset convention for maps under 100 km.
- Y = `Position[1] - (bounding centre transformed to world)[1]` (absolute altitude, corrected from bounding centre to model origin).
- Orientation is recomputed: matrix `Rz(roll) * Ry(pitch) * Rx(yaw)` then `ToYawPitchRoll()` (pitch = asin(m02), yaw = atan2(-m12, m22), roll = atan2(-m01, m00)), degrees. No deletions. Import from TB is commented out of the menu.

**6. VPP (`EditorVPPFile`, `.vpp`)** — binary `FileSerializer.Write(VPPToEditorBuildingSet)` (Enforce auto-serializes the class: `m_Name`, `m_IsActive`, `m_Buildings[]` of `VPPToEditorSpawnedBuilding { m_Name, m_ObjectName, m_Position, m_Direction, m_Orientation, m_IsActive, m_NetWorkId }`). Building name = `Type + "-" + floor(x)floor(y)floor(z)`. Opened with `FileMode.APPEND` — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/VPP/EditorVPPFile.c ; https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/VPP/VPPBuildings.c

**7. "Events" XML (`EditorEventsFile`, `.xml`)** — cfgeventspawns-style, grouped by type:
```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<events>
	<event name="TYPE">
		<pos x="X" y="Y" z="Z" a="YAW"/>
	</event>
</events>
```
`a` = Orientation[0] (yaw, degrees, not normalised) — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/EditorEventsFile.c

**8. mapgrouppos.xml (`EditorMapGroupPosFile`, `.xml`)** — `<group name="%1" pos="%2" rpy="%3" a="%4"/>` inside `<map>`; only `House`-derived, non-suppressed objects; `rpy = (ori[2], ori[1], ori[0])` i.e. roll pitch yaw; `a = (rpy[2] <= -90) ? -rpy[2] - 270 : 90 - rpy[2]`. Option "export entire map" scans `GetObjectsAtPosition3D(0, 100000)` — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/EditorMapGroupPosFile.c. The Loader writes the same format automatically at mission start when `mapgroupproto.xml` exists and `disableAutoMapGroupPosExport` is not set in server config — [Loader]

**9. COM (Community Online Tools) JSON (`EditorCOMFile`, menu entry commented out)** — `{ "name": "DayZ Editor Export", "m_SceneObjects": [ [type, [x,y,z], [yaw,pitch,roll]], ... ] }` (`array<ref Param3<string, vector, vector>>`) — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/EditorCOMFile.c

**10. Clipboard / context exports**
- "Copy Event To Clipboard" (`EditorExportEventPos`): events.xml block `StaticMyEvent` (nominal 1, lifetime 5400, position fixed, limit child), cfgeventspawns `<pos x y z a="0" group="MyEventGroup" />`, cfgeventgroups `<child type deloot="0" lootmax="5" lootmin="0" x y z a/>` with **positions relative to the anchor** and `a` = yaw normalised to 0..360 — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Commands/Export/EditorExportEventPos.c
- "Export selection as event group" (`EditorExportSelectionAsEventGroup`): `<event name="EditorExport">` with `<zone smin="0" smax="0" dmin="1" dmax="1" r="20" />`, `<pos x z a="0" y group="EditorGroup0"/>` and `<group name="EditorGroup0">` children with offsets relative to the clicked object (yaw not normalised) — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Commands/Objects/EditorExportSelectionAsEventGroup.c
- "Export Relative..." writes a .dze whose objects are transformed into the local frame of a chosen building (`MatrixInvMultiply4`); "Import Relative..." does the inverse — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Commands/Objects/EditorExportSelectionRelativeToBuilding.c

### Inferences
- Vector text in init.c / .map / mapgrouppos uses Enforce `vector.ToString(false)` → `"x y z"` space-separated; float precision is whatever Enforce's float-to-string gives (about 6 significant digits), so these text exports lose precision compared with .dze.
- For a server-side reader, .dze (via the Loader) and Expansion .map are the only formats that carry map-object deletions.

### Gaps
- Exact float formatting of `vector.ToString(false)` and `%n` floats was not verified against a sample output.
- The VPP `.vpp` binary layout depends on Enforce's automatic class serialization; not verified byte-for-byte.

## Which import formats are supported?

### Takeaway
Import menu: **.dze**, **Object Spawner JSON**, **init.c**, **Expansion .map**, **VPP**. Terrain Builder and COM importers exist in code but are commented out of the menu. There is also an events.xml + cfgeventspawns.xml loader.

### Cited Findings
- Import menu: `EditorImportFromDZE`, `EditorImportFromObjectSpawner`, divider, `EditorImportFromInit`, `EditorImportFromExpansion`, `//EditorImportFromTerrainBuilder`, `EditorImportFromVPP`, `//EditorImportFromCOM` — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/gui/Menus/Menus/EditorImportMenu.c
- .dze import: binary or JSON (sniffs `EditorBinned`); objects whose model resolves to `UNKNOWN_P3D_FILE` get a warning; `.p3d` entries converted back (add bounding centre, radians → degrees) — [DZEFile]
- init.c import: any line containing `SpawnObject` but not `void`/`static` is split on `"`: tokens[1]=type, [3]=position, [5]=orientation, [6]=`, scale);` (scale defaults 1.0) — FileTypes/EditorInitFile.c
- Object Spawner import: `name`, `pos`, `ypr`, `scale` (0 → 1) — FileTypes/EditorObjectSpawnerFile.c
- Expansion import (format above) supports deletions (`-Type|pos`), trader suffix and attachments — FileTypes/EditorExpansionFile.c
- VPP import: reads `VPPToEditorBuildingSet`, takes the type as the part of `m_Name` before `-` — FileTypes/VPP/EditorVPPFile.c
- Events: `EditorEventManager.ImportEventPositions()` reads `<Editor root>/cfgeventspawns.xml` (`<event name><pos x y z a/>`) then `db\events.xml` (`<event><children><child type/>`), and spawns a random child type at each position (y = 0 → SurfaceY; DZ_LightAI types skipped) — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/FileManagers/FileTypes/EditorEventSpawn.c
- Editor root directory: `Editor.ROOT_DIRECTORY = SystemPath.Combine(SystemPath.Saves(), "Editor")` — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Editor.c
- Loader: reads every `*.dze` under `$mission:\EditorFiles` (recursive enumerate, depth 5), binary or JSON; suppresses deletions, then spawns objects (`.p3d` via `CreateStaticObjectUsingP3D` after `/`→`\` and Trim; others via `CreateObjectEx(type, pos, ECE_SETUP | ECE_UPDATEPATHGRAPH | ECE_CREATEPHYSICS)` then SetOrientation/SetScale), skips `EditorOnly` or empty Type, disables simulation if `!Simulate`, feeds `Parameters` to `SerializedBuilding.Read`; ends with `ProcessMarkedObjectsForPathgraphUpdate()` — [Loader]

### Inferences
- A tool that wants to feed the Loader needs only to drop a binary or JSON .dze into `mission\EditorFiles`; JSON is the simplest to write, but use the key `EditorHiddenObjects` (current class) for deletions.

### Gaps
- No importer exists for mapgrouppos.xml or Terrain Builder in the active menu.

## Versioning / compatibility notes

### Takeaway
Binary versions go from 1 to 8 and each reader branches on the version number; key breaks are v2 (attachments + params), v3 (4 bool flags), v5 (Model), v6 (deleted ModelName; Type missing in v6/v7), v6+ camera tracks, v7 (author/credits/dates), v8 (AttachmentMap replaces Attachments). JSON keys changed from `EditorDeletedObjects` to `EditorHiddenObjects` during 2024.

### Cited Findings
- Version gates in readers: object data `<2`, `<8` (old Attachments), `<3`, `<5`, `<8` (AttachmentMap) — [ObjData]; deletions: Type skipped for exactly 6 and 7, ModelName for `>=6` — [DelData]; save data: author block `>=7`, camera tracks only if `>5` — [SaveData]
- DabsFramework history: "Back to legacy implementation for dze" (2024-02-03, Version = 3, field `EditorDeletedObjects`), "Updated editor object data to properly support static objects" (2024-03-24), "Camera tracks to save data" (2024-12-05), "Added author data to dze files" (2024-12-08) — https://github.com/InclementDab/DayZ-Dabs-Framework/commits/production/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/EditorSaveData.c ; field names at 7469248: https://github.com/InclementDab/DayZ-Dabs-Framework/blob/7469248406/DabsFramework/Scripts/3_Game/DabsFramework/_Legacy/Editor/EditorSaveData.c
- In v0.1.21 (Oct 2020) `EditorSaveData` had only `MapName` (default "ChernarusPlus"), `CameraPosition` and `EditorObjects` as a **map** keyed by ID; `ExportSettings.Binarized = false` — https://github.com/InclementDab/DayZ-Editor/blob/v0.1.21/DayZEditor/scripts/4_world/DayZEditor/classes/FileManagers/EditorFileManager.c
- The author's C# BinEditor still models the old v2 layout (no bools, no Model, `EditorDeletedObjects`) and is out of date — https://github.com/InclementDab/DayZ-Editor/blob/legacy/BinEditor/Enfusion-Deserializer/DayZ-Bin-Editor/Editor/EditorSaveData.cs
- A "Fix static file" command exists to repair `.p3d` objects saved with the wrong convention (adds bounding centre, multiplies orientation by RAD2DEG) and writes `_FIXED.dze` — https://github.com/InclementDab/DayZ-Editor/blob/legacy/DayZEditor/Scripts/4_World/DayZEditor/classes/Commands/Hud/EditorFixStaticFileCommand.c
- Repo README warns that repacking/reuploading without permission is prohibited — https://github.com/InclementDab/DayZ-Editor/blob/legacy/README.md

### Inferences
- A robust reader should: sniff the `EditorBinned` header; support binary versions 1–8 with the gates above; for JSON accept both `EditorDeletedObjects` and `EditorHiddenObjects`, treat a missing `Version` as legacy, and treat `Flags` 2147483647 as "all display flags". A writer targeting current editors/loaders should emit binary v8 (or JSON with current key names).
- The v6/v7 deleted-object quirk means a v8 reader handed a v6/v7 file must not read `Type` for deletions, or the stream misaligns.

### Gaps
- Meaning of version 4 (no read gate references it) — not found.
- Whether the Steam Workshop build equals the `legacy` branch head was not checked against the Workshop page.
