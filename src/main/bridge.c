class DZAT_Bridge
{
	static float s_Acc = 0;
	static bool s_DirReady = false;
	static ref map<string, string> s_Last = new map<string, string>();
	static ref map<string, int> s_Dead = new map<string, int>();
	static const string DIR = "$profile:DayZAdminTools";

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
			Append(DIR + "/results.log", nonce + "|done|" + ok.ToString() + "|" + fail.ToString());
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
		s_Acc += dt;
		if (s_Acc < 3) return;
		s_Acc = 0;
		if (!GetGame().IsServer()) return;
		if (!s_DirReady)
		{
			MakeDirectory(DIR);
			s_DirReady = true;
		}
		array<Man> players = new array<Man>();
		GetGame().GetPlayers(players);
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
		ProcessCommands(players);
	}
}
