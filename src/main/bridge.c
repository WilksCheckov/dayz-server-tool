class DZAT_Bridge
{
	static float s_Acc = 0;
	static float s_PosAcc = 0;
	static bool s_DirReady = false;
	// players an admin made invulnerable (by identity id); re-applied every tick so it survives a reconnect
	static ref map<string, int> s_God = new map<string, int>();
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
	static string Clean(string s)
	{
		s.Replace("|", "/");
		return s;
	}
	// Live positions for the map: rewritten every 1.5 s, one line per player, framed by #begin / #end
	// id|steam|name|x|y|z|heading|health01|blood|alive|vehicle|god
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
			vector pos = p.GetPosition();
			vector ori = p.GetOrientation();
			string veh = "-";
			HumanCommandVehicle hcv = p.GetCommand_Vehicle();
			if (hcv && hcv.GetTransport()) veh = hcv.GetTransport().GetType();
			string line = pid + "|" + p.GetIdentity().GetPlainId() + "|" + Clean(p.GetIdentity().GetName());
			line = line + "|" + pos[0].ToString() + "|" + pos[1].ToString() + "|" + pos[2].ToString();
			line = line + "|" + ori[0].ToString() + "|" + p.GetHealth01("", "").ToString();
			line = line + "|" + p.GetHealth("GlobalHealth", "Blood").ToString() + "|" + BoolStr(p.IsAlive());
			line = line + "|" + veh + "|" + BoolStr(god);
			FPrintln(fh, line);
		}
		FPrintln(fh, "#end");
		CloseFile(fh);
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
		if (s_Acc < 3) return;
		s_Acc = 0;
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
	}
}
