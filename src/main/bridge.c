class DZAT_Bridge
{
	static float s_Acc = 0;
	static float s_PosAcc = 0;
	static bool s_DirReady = false;
	// players an admin made invulnerable (by identity id); re-applied every tick so it survives a reconnect
	static ref map<string, int> s_God = new map<string, int>();
	static ref map<string, string> s_Last = new map<string, string>();
	static ref map<string, int> s_Dead = new map<string, int>();
	// players an admin froze or hid (by identity id), re-applied every tick so it survives a reconnect
	static ref map<string, int> s_Frozen = new map<string, int>();
	static ref map<string, int> s_Invisible = new map<string, int>();
	// respawns: the body is removed a moment after the kill (by identity id → tick time of the kill)
	static ref map<string, float> s_RespawnAt = new map<string, float>();
	// the body of each player who died this session (by identity id), so a refund can remove it with its gear
	static ref map<string, PlayerBase> s_Corpses = new map<string, PlayerBase>();
	static const string DIR = "$profile:DayZAdminTools";
	// vehicles and flags for the map: found by sweeping the world one cell per tick (4 x 4 cells, a full sweep every 24 s)
	// plus whatever a player is driving; a deleted entity turns null and is dropped. Ids: the engine's persistent id, else t<n>.
	static const float WORLD = __DZAT_WORLD__;
	static ref array<EntityAI> s_Vehicles = new array<EntityAI>();
	static ref array<string> s_VehIds = new array<string>();
	static ref array<EntityAI> s_Flags = new array<EntityAI>();
	static int s_Cell = 0;
	static int s_VehSeq = 0;

	static string Esc(string s)
	{
		s.Replace("\\", "\\\\");
		s.Replace("\"", "\\\"");
		return s;
	}
	static string Pad(int v)
	{
		if (v < 10) return "0" + v.ToString();
		return v.ToString();
	}
	static string Stamp()
	{
		int y, mo, d, h, mi, se;
		GetYearMonthDay(y, mo, d);
		GetHourMinuteSecond(h, mi, se);
		string r = y.ToString() + "-" + Pad(mo) + "-" + Pad(d);
		r = r + " " + Pad(h) + ":" + Pad(mi) + ":" + Pad(se);
		return r;
	}
	static void Append(string path, string line)
	{
		FileHandle fh = OpenFile(path, FileMode.APPEND);
		if (fh == 0) return;
		FPrintln(fh, line);
		CloseFile(fh);
	}
	static string BoolStr(bool b)
	{
		if (b) return "true";
		return "false";
	}
	static string Clean(string s)
	{
		s.Replace("|", "/");
		return s;
	}
	// Live positions for the map: rewritten every 1.5 s, one line per player, framed by #begin / #end
	// id|steam|name|x|y|z|heading|health01|blood|alive|vehicle|god|frozen|invisible
	static void WritePlayers(array<Man> players)
	{
		FileHandle fh = OpenFile(DIR + "/players.txt", FileMode.WRITE);
		if (fh == 0) return;
		FPrintln(fh, "#begin|" + Stamp());
		for (int i = 0; i < players.Count(); i++)
		{
			PlayerBase p = PlayerBase.Cast(players[i]);
			if (!p || !p.GetIdentity()) continue;
			string pid = p.GetIdentity().GetId();
			bool god = s_God.Contains(pid);
			if (god) p.SetAllowDamage(false);
			bool frozen = s_Frozen.Contains(pid);
			if (frozen && p.GetInputController()) p.GetInputController().OverrideMovementSpeed(true, 0);
			bool invisible = s_Invisible.Contains(pid);
			vector pos = p.GetPosition();
			vector ori = p.GetOrientation();
			string veh = "-";
			HumanCommandVehicle hcv = p.GetCommand_Vehicle();
			if (hcv && hcv.GetTransport())
			{
				veh = hcv.GetTransport().GetType();
				Track(hcv.GetTransport());
			}
			string line = pid + "|" + p.GetIdentity().GetPlainId() + "|" + Clean(p.GetIdentity().GetName());
			line = line + "|" + pos[0].ToString() + "|" + pos[1].ToString() + "|" + pos[2].ToString();
			line = line + "|" + ori[0].ToString() + "|" + p.GetHealth01("", "").ToString();
			line = line + "|" + p.GetHealth("GlobalHealth", "Blood").ToString() + "|" + BoolStr(p.IsAlive());
			line = line + "|" + veh + "|" + BoolStr(god);
			line = line + "|" + BoolStr(frozen) + "|" + BoolStr(invisible);
			FPrintln(fh, line);
		}
		FPrintln(fh, "#end");
		CloseFile(fh);
	}
	static void Track(Object o)
	{
		EntityAI e = EntityAI.Cast(o);
		if (!e) return;
		if (Transport.Cast(e))
		{
			if (s_Vehicles.Find(e) >= 0) return;
			string vid = EngineId(e);
			if (vid == "")
			{
				s_VehSeq++;
				vid = "t" + s_VehSeq.ToString();
			}
			s_Vehicles.Insert(e);
			s_VehIds.Insert(vid);
			return;
		}
		if (TerritoryFlag.Cast(e) && s_Flags.Find(e) < 0) s_Flags.Insert(e);
	}
	static void ScanCell()
	{
		float cs = WORLD / 4;
		int cx = s_Cell % 4;
		int cz = s_Cell / 4;
		s_Cell = (s_Cell + 1) % 16;
		vector centre = Vector((cx + 0.5) * cs, 0, (cz + 0.5) * cs);
		array<Object> objs = new array<Object>();
		array<CargoBase> proxies = new array<CargoBase>();
		GetGame().GetObjectsAtPosition(centre, cs * 0.75, objs, proxies);
		for (int i = 0; i < objs.Count(); i++) Track(objs[i]);
	}
	static void Compact()
	{
		for (int i = s_Vehicles.Count() - 1; i >= 0; i--)
		{
			if (!s_Vehicles[i])
			{
				s_Vehicles.RemoveOrdered(i);
				s_VehIds.RemoveOrdered(i);
			}
		}
		for (int j = s_Flags.Count() - 1; j >= 0; j--)
		{
			if (!s_Flags[j]) s_Flags.RemoveOrdered(j);
		}
	}
	// vehicles.txt: id|class|x|y|z|heading|health01|fuel01|engine|driver|crew|ruined   flags.txt: x|y|z|refresher01
	static void WriteWorld()
	{
		Compact();
		FileHandle fh = OpenFile(DIR + "/vehicles.txt", FileMode.WRITE);
		if (fh == 0) return;
		FPrintln(fh, "#begin|" + Stamp());
		for (int i = 0; i < s_Vehicles.Count(); i++)
		{
			EntityAI e = s_Vehicles[i];
			vector pos = e.GetPosition();
			vector ori = e.GetOrientation();
			string fuel = "-";
			string engine = "false";
			CarScript car = CarScript.Cast(e);
			if (car)
			{
				fuel = car.GetFluidFraction(CarFluid.FUEL).ToString();
				engine = BoolStr(car.EngineIsOn());
			}
			string driver = "-";
			int crew = 0;
			Transport tr = Transport.Cast(e);
			if (tr)
			{
				for (int s = 0; s < tr.CrewSize(); s++)
				{
					Human h = tr.CrewMember(s);
					if (!h) continue;
					crew++;
					PlayerBase hp = PlayerBase.Cast(h);
					if (s == 0 && hp && hp.GetIdentity()) driver = Clean(hp.GetIdentity().GetName());
				}
			}
			string line = s_VehIds[i] + "|" + e.GetType() + "|" + pos[0].ToString() + "|" + pos[1].ToString() + "|" + pos[2].ToString();
			line = line + "|" + ori[0].ToString() + "|" + e.GetHealth01("", "").ToString() + "|" + fuel + "|" + engine;
			line = line + "|" + driver + "|" + crew.ToString() + "|" + BoolStr(e.IsRuined());
			FPrintln(fh, line);
		}
		FPrintln(fh, "#end");
		CloseFile(fh);
		fh = OpenFile(DIR + "/flags.txt", FileMode.WRITE);
		if (fh == 0) return;
		FPrintln(fh, "#begin|" + Stamp());
		for (int k = 0; k < s_Flags.Count(); k++)
		{
			TerritoryFlag flag = TerritoryFlag.Cast(s_Flags[k]);
			if (!flag) continue;
			vector fp = flag.GetPosition();
			FPrintln(fh, fp[0].ToString() + "|" + fp[1].ToString() + "|" + fp[2].ToString() + "|" + flag.GetRefresherTime01().ToString());
		}
		FPrintln(fh, "#end");
		CloseFile(fh);
	}
	static EntityAI FindVehicle(string id)
	{
		int at = s_VehIds.Find(id);
		if (at < 0) return null;
		return s_Vehicles[at];
	}
	// every damage zone and every part pristine, every fluid full
	static void RepairAll(EntityAI e)
	{
		Fill(e);
		array<string> zones = new array<string>();
		e.GetDamageZones(zones);
		for (int z = 0; z < zones.Count(); z++) e.SetHealth01(zones[z], "", 1.0);
		array<EntityAI> parts = new array<EntityAI>();
		e.GetInventory().EnumerateInventory(InventoryTraversalType.PREORDER, parts);
		for (int i = 0; i < parts.Count(); i++)
		{
			if (parts[i] && parts[i] != e) parts[i].SetHealth01("", "", 1.0);
		}
	}
	// vehicle commands: f[2] = vehicle id, f[3] = what (vbreak) or a player id (vbring), f[4] f[5] = x z (vtp)
	static void RunVehicle(array<Man> players, string nonce, string type, array<string> f)
	{
		EntityAI veh = FindVehicle(f[2]);
		if (!veh)
		{
			Append(DIR + "/results.log", nonce + "|noveh|0|0");
			return;
		}
		CarScript car = CarScript.Cast(veh);
		Transport tr = Transport.Cast(veh);
		int crew = 0;
		if (tr)
		{
			for (int s = 0; s < tr.CrewSize(); s++)
			{
				if (tr.CrewMember(s)) crew++;
			}
		}
		if (type == "vrepair")
		{
			RepairAll(veh);
		}
		else if (type == "vrefuel")
		{
			if (car) car.Fill(CarFluid.FUEL, car.GetFluidCapacity(CarFluid.FUEL));
		}
		else if (type == "vbreak")
		{
			// what: tyres | fuel | engine | battery | all
			string what = f[3];
			bool all = (what == "all");
			if (car && (all || what == "fuel")) car.Leak(CarFluid.FUEL, car.GetFluidCapacity(CarFluid.FUEL));
			if (car && (all || what == "engine")) veh.SetHealth01("Engine", "", 0.0);
			if (all || what == "tyres" || what == "battery")
			{
				array<EntityAI> parts = new array<EntityAI>();
				veh.GetInventory().EnumerateInventory(InventoryTraversalType.PREORDER, parts);
				for (int i = 0; i < parts.Count(); i++)
				{
					EntityAI part = parts[i];
					if (!part || part == veh) continue;
					string pt = part.GetType();
					pt.ToLower();
					bool wheel = pt.Contains("wheel");
					bool batt = pt.Contains("battery");
					if ((wheel && (all || what == "tyres")) || (batt && (all || what == "battery"))) part.SetHealth01("", "", 0.0);
				}
			}
		}
		else if (type == "vdestroy")
		{
			veh.SetHealth("", "", 0);
		}
		else if (type == "vdelete")
		{
			if (crew > 0)
			{
				Append(DIR + "/results.log", nonce + "|occupied|0|0");
				return;
			}
			int at = s_VehIds.Find(f[2]);
			if (at >= 0)
			{
				s_Vehicles.RemoveOrdered(at);
				s_VehIds.RemoveOrdered(at);
			}
			GetGame().ObjectDelete(veh);
		}
		else if (type == "vtp" || type == "vbring" || type == "vflip")
		{
			vector dest = veh.GetPosition();
			if (type == "vtp")
			{
				if (f[4] == "-" || f[5] == "-")
				{
					Append(DIR + "/results.log", nonce + "|badpos|0|0");
					return;
				}
				dest = Vector(f[4].ToFloat(), 0, f[5].ToFloat());
			}
			if (type == "vbring")
			{
				PlayerBase near = FindPlayer(players, f[3]);
				if (!near)
				{
					Append(DIR + "/results.log", nonce + "|nodest|0|0");
					return;
				}
				dest = near.GetPosition();
				dest[0] = dest[0] + 4.0;
			}
			dest[1] = GetGame().SurfaceY(dest[0], dest[2]) + 0.5;
			vector ori = veh.GetOrientation();
			ori[1] = 0;
			ori[2] = 0;
			veh.SetOrientation(ori);
			veh.SetPosition(dest);
		}
		else
		{
			Append(DIR + "/results.log", nonce + "|unknown|0|0");
			return;
		}
		Append(DIR + "/results.log", nonce + "|done|1|0");
	}
	// the engine's own persistent id of an entity ("" when it has none)
	static string EngineId(EntityAI e)
	{
		int b1, b2, b3, b4;
		e.GetPersistentID(b1, b2, b3, b4);
		if (b1 == 0 && b2 == 0 && b3 == 0 && b4 == 0) return "";
		return b1.ToString() + "-" + b2.ToString() + "-" + b3.ToString() + "-" + b4.ToString();
	}
	// Engine-id dupe check: the same persistent id carried by two online players at once is a copy
	static ref map<string, float> s_EngineReported = new map<string, float>();
	static void CheckEngineIds(array<Man> players)
	{
		map<string, string> seen = new map<string, string>();
		map<string, string> seenClass = new map<string, string>();
		for (int i = 0; i < players.Count(); i++)
		{
			PlayerBase p = PlayerBase.Cast(players[i]);
			if (!p || !p.GetIdentity()) continue;
			string holder = "player:" + p.GetIdentity().GetId() + ":" + Esc(p.GetIdentity().GetName());
			array<EntityAI> items = new array<EntityAI>();
			p.GetInventory().EnumerateInventory(InventoryTraversalType.PREORDER, items);
			for (int j = 0; j < items.Count(); j++)
			{
				EntityAI e = items[j];
				if (!e || e == p) continue;
				string key = EngineId(e);
				if (key == "") continue;
				if (seen.Contains(key) && seen.Get(key) != holder)
				{
					float now = GetGame().GetTickTime();
					if (!s_EngineReported.Contains(key) || now - s_EngineReported.Get(key) >= 600)
					{
						s_EngineReported.Set(key, now);
						Append(DIR + "/dupes.log", Stamp() + "|engine|" + key + "|" + e.GetType() + "|" + seen.Get(key) + "|" + holder);
					}
				}
				else
				{
					seen.Set(key, holder);
					seenClass.Set(key, e.GetType());
				}
			}
		}
	}
	static string GearJson(PlayerBase p)
	{
		array<EntityAI> items = new array<EntityAI>();
		p.GetInventory().EnumerateInventory(InventoryTraversalType.PREORDER, items);
		string buf = "";
		for (int i = 0; i < items.Count(); i++)
		{
			EntityAI e = items[i];
			if (!e || e == p) continue;
			string parent = "";
			EntityAI par = e.GetHierarchyParent();
			if (par && par != p) parent = par.GetType();
			float q = -1;
			ItemBase ib = ItemBase.Cast(e);
			if (ib && ib.HasQuantity()) q = ib.GetQuantity();
			Magazine mag = Magazine.Cast(e);
			if (mag) q = mag.GetAmmoCount();
			if (buf != "") buf = buf + ",";
			string one = "{\"c\":\"" + Esc(e.GetType()) + "\",\"p\":\"" + Esc(parent) + "\"";
			one = one + ",\"e\":\"" + EngineId(e) + "\"";
			one = one + ",\"q\":" + q.ToString();
			one = one + ",\"h\":" + e.GetHealth01("", "").ToString() + "}";
			buf = buf + one;
		}
		return "[" + buf + "]";
	}
	static void Snapshot(PlayerBase p, string id, bool dead)
	{
		string gear = GearJson(p);
		if (!dead && s_Last.Contains(id) && s_Last.Get(id) == gear) return;
		s_Last.Set(id, gear);
		string steam = p.GetIdentity().GetPlainId();
		string name = Esc(p.GetIdentity().GetName());
		vector pos = p.GetPosition();
		string line = "{\"t\":\"" + Stamp() + "\",\"id\":\"" + id + "\"";
		line = line + ",\"steam\":\"" + steam + "\",\"name\":\"" + name + "\"";
		line = line + ",\"dead\":" + BoolStr(dead);
		line = line + ",\"pos\":[" + pos[0].ToString() + "," + pos[1].ToString() + "," + pos[2].ToString() + "]";
		line = line + ",\"items\":" + gear + "}";
		Append(DIR + "/gear.log", line);
	}
	// what: all | health | bleeding | bones | cure | food
	static void Heal(PlayerBase p, string what)
	{
		bool all = (what == "" || what == "-" || what == "all");
		if (all || what == "health")
		{
			array<string> zones = new array<string>();
			p.GetDamageZones(zones);
			for (int z = 0; z < zones.Count(); z++) p.SetHealth(zones[z], "Health", p.GetMaxHealth(zones[z], "Health"));
			p.SetHealth("", "", p.GetMaxHealth("", ""));
			p.SetHealth("GlobalHealth", "Blood", p.GetMaxHealth("GlobalHealth", "Blood"));
			p.SetHealth("GlobalHealth", "Shock", p.GetMaxHealth("GlobalHealth", "Shock"));
		}
		if (all || what == "bleeding")
		{
			if (p.GetBleedingManagerServer()) p.GetBleedingManagerServer().RemoveAllSources();
		}
		if (all || what == "bones")
		{
			p.SetBrokenLegs(0);
		}
		if (all || what == "cure")
		{
			p.RemoveAllAgents();
			if (p.GetModifiersManager()) p.GetModifiersManager().DeactivateAllModifiers();
		}
		if (all || what == "food")
		{
			p.GetStatWater().Set(p.GetStatWater().GetMax());
			p.GetStatEnergy().Set(p.GetStatEnergy().GetMax());
		}
	}
	// disease agents by name (the eAgents bit values; the enum is not reachable from a mission script)
	static int AgentOf(string name)
	{
		if (name == "cholera") return 1;
		if (name == "influenza") return 2;
		if (name == "salmonella") return 4;
		if (name == "brain") return 8;
		if (name == "food") return 16;
		if (name == "chemical") return 32;
		if (name == "wound") return 64;
		if (name == "nerve") return 128;
		if (name == "heavymetal") return 256;
		return 0;
	}
	// what: bleed:n | legs | unconscious | health:pct | blood:pct | cold | hot | starve | dehydrate | wet | sick:name | clearsick
	static string Afflict(PlayerBase p, string what)
	{
		array<string> kv = new array<string>();
		what.Split(":", kv);
		if (kv.Count() == 0) return "unknown";
		string kind = kv[0];
		string arg = "";
		if (kv.Count() > 1) arg = kv[1];
		if (kind == "bleed")
		{
			int n = arg.ToInt();
			if (n < 1) n = 3;
			if (n > 8) n = 8;
			array<string> sel = new array<string>();
			sel.Insert("LeftArm");
			sel.Insert("RightArm");
			sel.Insert("LeftLeg");
			sel.Insert("RightLeg");
			sel.Insert("Torso");
			sel.Insert("Head");
			if (!p.GetBleedingManagerServer()) return "nobleed";
			for (int i = 0; i < n; i++) p.GetBleedingManagerServer().AttemptAddBleedingSourceBySelection(sel[i % 6]);
			return "done";
		}
		if (kind == "legs")
		{
			p.SetBrokenLegs(1);
			return "done";
		}
		if (kind == "unconscious")
		{
			p.SetHealth("GlobalHealth", "Shock", 0);
			return "done";
		}
		if (kind == "health" || kind == "blood")
		{
			float pct = arg.ToFloat() / 100.0;
			if (pct < 0.05) pct = 0.05;
			if (pct > 1.0) pct = 1.0;
			if (kind == "health") p.SetHealth("", "", p.GetMaxHealth("", "") * pct);
			else p.SetHealth("GlobalHealth", "Blood", p.GetMaxHealth("GlobalHealth", "Blood") * pct);
			return "done";
		}
		if (kind == "cold")
		{
			p.GetStatHeatComfort().Set(p.GetStatHeatComfort().GetMin());
			return "done";
		}
		if (kind == "hot")
		{
			p.GetStatHeatComfort().Set(p.GetStatHeatComfort().GetMax());
			return "done";
		}
		if (kind == "starve")
		{
			p.GetStatEnergy().Set(0);
			return "done";
		}
		if (kind == "dehydrate")
		{
			p.GetStatWater().Set(0);
			return "done";
		}
		if (kind == "wet")
		{
			p.GetStatWet().Set(p.GetStatWet().GetMax());
			return "done";
		}
		if (kind == "sick")
		{
			int agent = AgentOf(arg);
			if (agent == 0) return "unknown";
			p.InsertAgent(agent, 1000);
			return "done";
		}
		if (kind == "clearsick")
		{
			p.RemoveAllAgents();
			return "done";
		}
		return "unknown";
	}
	// a spawned item at its best: full health, full quantity, full magazine
	static void Fill(EntityAI e)
	{
		e.SetHealth01("", "", 1.0);
		ItemBase fib = ItemBase.Cast(e);
		if (fib && fib.HasQuantity()) fib.SetQuantityMax();
		Magazine fmag = Magazine.Cast(e);
		if (fmag) fmag.ServerSetAmmoCount(fmag.GetAmmoMax());
		// a vehicle ready to drive: every fluid full (its parts are attached by AttachParts)
		CarScript fcar = CarScript.Cast(e);
		if (fcar)
		{
			fcar.Fill(CarFluid.FUEL, fcar.GetFluidCapacity(CarFluid.FUEL));
			fcar.Fill(CarFluid.OIL, fcar.GetFluidCapacity(CarFluid.OIL));
			fcar.Fill(CarFluid.BRAKE, fcar.GetFluidCapacity(CarFluid.BRAKE));
			fcar.Fill(CarFluid.COOLANT, fcar.GetFluidCapacity(CarFluid.COOLANT));
		}
	}
	// "Parent;Attachment;Attachment": the rest go onto the parent (attached, else into it), else next to it.
	// Returns how many of the parts exist afterwards; parent is spawned by the caller.
	static int AttachParts(EntityAI parent, array<string> parts, PlayerBase holder)
	{
		int made = 0;
		for (int a = 1; a < parts.Count(); a++)
		{
			if (parts[a] == "") continue;
			EntityAI att = parent.GetInventory().CreateAttachment(parts[a]);
			if (!att) att = parent.GetInventory().CreateInInventory(parts[a]);
			if (!att && holder) att = holder.GetInventory().CreateInInventory(parts[a]);
			if (!att) att = EntityAI.Cast(GetGame().CreateObjectEx(parts[a], parent.GetPosition(), ECE_PLACE_ON_SURFACE));
			if (att)
			{
				Fill(att);
				made++;
			}
		}
		return made;
	}
	// Remove a dead player's body and everything on it: the one remembered for this identity, else (after a restart)
	// a dead body within 3 m of the exact death position. Returns "body" when one was deleted, "nobody" otherwise.
	static string DeleteCorpse(string id, string xs, string zs)
	{
		PlayerBase corpse = null;
		if (s_Corpses.Contains(id)) corpse = s_Corpses.Get(id);
		if (corpse && corpse.IsAlive()) corpse = null;
		if (!corpse && xs != "-" && zs != "-")
		{
			vector at = Vector(xs.ToFloat(), 0, zs.ToFloat());
			at[1] = GetGame().SurfaceY(at[0], at[2]);
			array<Object> objs = new array<Object>();
			array<CargoBase> proxies = new array<CargoBase>();
			GetGame().GetObjectsAtPosition(at, 3.0, objs, proxies);
			for (int i = 0; i < objs.Count(); i++)
			{
				PlayerBase cand = PlayerBase.Cast(objs[i]);
				if (cand && !cand.IsAlive()) { corpse = cand; break; }
			}
		}
		if (!corpse) return "nobody";
		if (s_Corpses.Contains(id)) s_Corpses.Remove(id);
		GetGame().ObjectDelete(corpse);
		return "body";
	}
	static PlayerBase FindPlayer(array<Man> players, string id)
	{
		for (int j = 0; j < players.Count(); j++)
		{
			PlayerBase cand = PlayerBase.Cast(players[j]);
			if (!cand || !cand.GetIdentity()) continue;
			if (cand.GetIdentity().GetId() == id || cand.GetIdentity().GetPlainId() == id) return cand;
		}
		return null;
	}
	// One command per line: nonce|type|playerId|what|x|z|item,item,...   ("-" for an empty field)
	static void RunCommand(array<Man> players, string ln)
	{
		array<string> f = new array<string>();
		ln.Split("|", f);
		if (f.Count() < 7) return;
		string nonce = f[0];
		string type = f[1];
		// at a map point, nobody needed: x = f[4], z = f[5], items = f[6] (each "Parent;Attachment;…")
		if (type == "spawn")
		{
			if (f[4] == "-" || f[5] == "-")
			{
				Append(DIR + "/results.log", nonce + "|badpos|0|0");
				return;
			}
			array<string> sitems = new array<string>();
			f[6].Split(",", sitems);
			int sok = 0;
			int sfail = 0;
			for (int si = 0; si < sitems.Count(); si++)
			{
				array<string> sparts = new array<string>();
				sitems[si].Split(";", sparts);
				if (sparts.Count() == 0 || sparts[0] == "" || sparts[0] == "-") continue;
				vector sp = Vector(f[4].ToFloat() + Math.RandomFloat(-1.0, 1.0), 0, f[5].ToFloat() + Math.RandomFloat(-1.0, 1.0));
				sp[1] = GetGame().SurfaceY(sp[0], sp[2]);
				EntityAI sent = EntityAI.Cast(GetGame().CreateObjectEx(sparts[0], sp, ECE_PLACE_ON_SURFACE));
				if (!sent)
				{
					sfail = sfail + sparts.Count();
					continue;
				}
				Fill(sent);
				int sat = AttachParts(sent, sparts, null);
				sok = sok + 1 + sat;
				sfail = sfail + sparts.Count() - 1 - sat;
			}
			Append(DIR + "/results.log", nonce + "|done|" + sok.ToString() + "|" + sfail.ToString());
			return;
		}
		if (type == "vrepair" || type == "vrefuel" || type == "vbreak" || type == "vdestroy" || type == "vdelete" || type == "vtp" || type == "vbring" || type == "vflip")
		{
			RunVehicle(players, nonce, type, f);
			return;
		}
		PlayerBase target = FindPlayer(players, f[2]);
		if (!target || !target.IsAlive())
		{
			Append(DIR + "/results.log", nonce + "|offline|0|0");
			return;
		}
		if (type == "heal")
		{
			Heal(target, f[3]);
			Append(DIR + "/results.log", nonce + "|done|1|0");
			return;
		}
		if (type == "afflict")
		{
			string ares = Afflict(target, f[3]);
			if (ares == "done") Append(DIR + "/results.log", nonce + "|done|1|0");
			else Append(DIR + "/results.log", nonce + "|" + ares + "|0|0");
			return;
		}
		// f[3] = on | off: no movement (re-applied every tick), survives a reconnect until turned off
		if (type == "freeze")
		{
			string fid = target.GetIdentity().GetId();
			if (f[3] == "on")
			{
				s_Frozen.Set(fid, 1);
				if (target.GetInputController()) target.GetInputController().OverrideMovementSpeed(true, 0);
			}
			else
			{
				if (s_Frozen.Contains(fid)) s_Frozen.Remove(fid);
				if (target.GetInputController()) target.GetInputController().OverrideMovementSpeed(false, 1);
			}
			Append(DIR + "/results.log", nonce + "|done|1|0");
			return;
		}
		if (type == "invisible")
		{
			string iid = target.GetIdentity().GetId();
			if (f[3] == "on")
			{
				s_Invisible.Set(iid, 1);
				target.SetInvisible(true);
			}
			else
			{
				if (s_Invisible.Contains(iid)) s_Invisible.Remove(iid);
				target.SetInvisible(false);
			}
			Append(DIR + "/results.log", nonce + "|done|1|0");
			return;
		}
		// everything they carry drops at their feet
		if (type == "strip")
		{
			array<EntityAI> worn = new array<EntityAI>();
			target.GetInventory().EnumerateInventory(InventoryTraversalType.PREORDER, worn);
			int dropped = 0;
			for (int wi = 0; wi < worn.Count(); wi++)
			{
				EntityAI w = worn[wi];
				if (!w || w == target || w.GetHierarchyParent() != target) continue;
				target.ServerDropEntity(w);
				dropped++;
			}
			Append(DIR + "/results.log", nonce + "|done|" + dropped.ToString() + "|0");
			return;
		}
		// kill now; the body goes a few seconds later (see Tick) so they respawn fresh
		if (type == "respawn")
		{
			string rid = target.GetIdentity().GetId();
			if (s_God.Contains(rid)) s_God.Remove(rid);
			target.SetAllowDamage(true);
			target.SetHealth("", "", 0);
			s_RespawnAt.Set(rid, GetGame().GetTickTime());
			Append(DIR + "/results.log", nonce + "|done|1|0");
			return;
		}
		if (type == "tp")
		{
			if (f[4] == "-" || f[5] == "-")
			{
				Append(DIR + "/results.log", nonce + "|badpos|0|0");
				return;
			}
			vector dest = Vector(f[4].ToFloat(), 0, f[5].ToFloat());
			dest[1] = GetGame().SurfaceY(dest[0], dest[2]) + 0.3;
			target.SetPosition(dest);
			Append(DIR + "/results.log", nonce + "|done|1|0");
			return;
		}
		if (type == "refund")
		{
			// f[3] = "delbody" removes the body first (f[4], f[5] = the death position for the search after a restart)
			string body = "kept";
			if (f[3] == "delbody") body = DeleteCorpse(f[2], f[4], f[5]);
			array<string> items = new array<string>();
			f[6].Split(",", items);
			int ok = 0;
			int fail = 0;
			vector origin = target.GetPosition();
			for (int k = 0; k < items.Count(); k++)
			{
				if (items[k] == "" || items[k] == "-") continue;
				vector at = origin;
				at[0] = at[0] + Math.RandomFloat(-0.8, 0.8);
				at[2] = at[2] + Math.RandomFloat(-0.8, 0.8);
				EntityAI ent = EntityAI.Cast(GetGame().CreateObjectEx(items[k], at, ECE_PLACE_ON_SURFACE));
				if (!ent)
				{
					fail++;
					continue;
				}
				ent.SetHealth01("", "", 1.0);
				ItemBase sib = ItemBase.Cast(ent);
				if (sib && sib.HasQuantity()) sib.SetQuantityMax();
				Magazine smag = Magazine.Cast(ent);
				if (smag) smag.ServerSetAmmoCount(smag.GetAmmoMax());
				ok++;
			}
			Append(DIR + "/results.log", nonce + "|done|" + ok.ToString() + "|" + fail.ToString() + "|" + body);
			return;
		}
		// to another player: f[3] = that player's id, placed next to them at their height (works on upper floors)
		if (type == "tpto")
		{
			PlayerBase other = FindPlayer(players, f[3]);
			if (!other)
			{
				Append(DIR + "/results.log", nonce + "|nodest|0|0");
				return;
			}
			vector to = other.GetPosition();
			to[0] = to[0] + 1.2;
			target.SetPosition(to);
			Append(DIR + "/results.log", nonce + "|done|1|0");
			return;
		}
		if (type == "kill")
		{
			if (s_God.Contains(target.GetIdentity().GetId())) s_God.Remove(target.GetIdentity().GetId());
			target.SetAllowDamage(true);
			target.SetHealth("", "", 0);
			Append(DIR + "/results.log", nonce + "|done|1|0");
			return;
		}
		// f[3] = on | off
		if (type == "god")
		{
			string gid = target.GetIdentity().GetId();
			if (f[3] == "on")
			{
				s_God.Set(gid, 1);
				target.SetAllowDamage(false);
			}
			else
			{
				if (s_God.Contains(gid)) s_God.Remove(gid);
				target.SetAllowDamage(true);
			}
			Append(DIR + "/results.log", nonce + "|done|1|0");
			return;
		}
		// into the inventory where it fits, otherwise at the feet; f[6] = item,item,... each "Parent;Attachment;…"
		if (type == "give")
		{
			array<string> gitems = new array<string>();
			f[6].Split(",", gitems);
			int gok = 0;
			int gfail = 0;
			for (int gi = 0; gi < gitems.Count(); gi++)
			{
				array<string> gparts = new array<string>();
				gitems[gi].Split(";", gparts);
				if (gparts.Count() == 0 || gparts[0] == "" || gparts[0] == "-") continue;
				EntityAI gent = target.GetInventory().CreateInInventory(gparts[0]);
				if (!gent) gent = EntityAI.Cast(GetGame().CreateObjectEx(gparts[0], target.GetPosition(), ECE_PLACE_ON_SURFACE));
				if (!gent)
				{
					gfail = gfail + gparts.Count();
					continue;
				}
				Fill(gent);
				int gat = AttachParts(gent, gparts, target);
				gok = gok + 1 + gat;
				gfail = gfail + gparts.Count() - 1 - gat;
			}
			Append(DIR + "/results.log", nonce + "|done|" + gok.ToString() + "|" + gfail.ToString());
			return;
		}
		Append(DIR + "/results.log", nonce + "|unknown|0|0");
	}
	static void ProcessCommands(array<Man> players)
	{
		string cmdPath = DIR + "/commands.txt";
		if (!FileExist(cmdPath)) return;
		FileHandle fh = OpenFile(cmdPath, FileMode.READ);
		if (fh == 0) return;
		array<string> lines = new array<string>();
		string ln;
		while (FGets(fh, ln) >= 0)
		{
			if (ln != "") lines.Insert(ln);
		}
		CloseFile(fh);
		DeleteFile(cmdPath);
		for (int i = 0; i < lines.Count(); i++) RunCommand(players, lines[i]);
	}
	static void Tick(float dt)
	{
		if (!GetGame().IsServer()) return;
		s_Acc += dt;
		s_PosAcc += dt;
		// positions and admin commands every 1.5 s; gear snapshots and the dupe check every 3 s
		if (s_PosAcc < 1.5) return;
		s_PosAcc = 0;
		if (!s_DirReady)
		{
			MakeDirectory(DIR);
			s_DirReady = true;
		}
		array<Man> players = new array<Man>();
		GetGame().GetPlayers(players);
		WritePlayers(players);
		ProcessCommands(players);
		ScanCell();
		if (s_Acc < 3) return;
		s_Acc = 0;
		WriteWorld();
		if (s_RespawnAt.Count() > 0)
		{
			array<string> doneIds = new array<string>();
			float tnow = GetGame().GetTickTime();
			for (int ri = 0; ri < s_RespawnAt.Count(); ri++)
			{
				if (tnow - s_RespawnAt.GetElement(ri) >= 2.0) doneIds.Insert(s_RespawnAt.GetKey(ri));
			}
			for (int di = 0; di < doneIds.Count(); di++)
			{
				DeleteCorpse(doneIds[di], "-", "-");
				s_RespawnAt.Remove(doneIds[di]);
			}
		}
		for (int i = 0; i < players.Count(); i++)
		{
			PlayerBase p = PlayerBase.Cast(players[i]);
			if (!p || !p.GetIdentity()) continue;
			string id = p.GetIdentity().GetId();
			if (!p.IsAlive())
			{
				if (!s_Dead.Contains(id))
				{
					s_Dead.Insert(id, 1);
					s_Corpses.Set(id, p);
					Snapshot(p, id, true);
				}
			}
			else
			{
				if (s_Dead.Contains(id)) s_Dead.Remove(id);
				Snapshot(p, id, false);
			}
		}
		CheckEngineIds(players);
	}
}
