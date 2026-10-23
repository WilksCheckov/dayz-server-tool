// DayZ Admin Tools anti-dupe (server only). Every item gets a hidden random ID the first time it exists, saved with
// the item's persistence data, so any copy made by a dupe carries the same ID. A registry of live items spots two
// items sharing one ID the moment the copy appears and writes it to $profile:DayZAdminTools/dupes.log.
class DZAT_Dupe
{
	static const int VERSION = 3;
	static ref array<EntityAI> s_Vehicles = new array<EntityAI>();
	static int s_ExportEvery = 5;
	static int s_ScanCount = 0;
	static const string DIR = "$profile:DayZAdminTools";
	static ref map<string, ref array<EntityAI>> s_ByUid = new map<string, ref array<EntityAI>>();
	static ref map<string, float> s_Reported = new map<string, float>();
	static bool s_Started = false;
	static bool s_DirReady = false;
	static int s_Dupes = 0;

	static string Hex4(int v)
	{
		string digits = "0123456789abcdef";
		string r = "";
		for (int i = 0; i < 4; i++)
		{
			int d = v % 16;
			v = v / 16;
			r = digits.Get(d) + r;
		}
		return r;
	}
	static string NewUid()
	{
		string s = "";
		for (int i = 0; i < 4; i++) s = s + Hex4(Math.RandomInt(0, 65536));
		return s;
	}
	// a saved id is 16 lowercase hex characters; anything else is data from before the mod existed
	static bool IsUid(string s)
	{
		if (s.Length() != 16) return false;
		string digits = "0123456789abcdef";
		for (int i = 0; i < 16; i++)
		{
			if (digits.IndexOf(s.Get(i)) < 0) return false;
		}
		return true;
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
		if (!s_DirReady)
		{
			MakeDirectory(DIR);
			s_DirReady = true;
		}
		FileHandle fh = OpenFile(path, FileMode.APPEND);
		if (fh == 0) return;
		FPrintln(fh, line);
		CloseFile(fh);
	}
	static string Esc(string s)
	{
		s.Replace("|", "/");
		return s;
	}
	// who holds the item: a player (identity id and name) or a world object with its position
	static string Describe(EntityAI e)
	{
		if (!e) return "gone";
		PlayerBase p = PlayerBase.Cast(e.GetHierarchyRootPlayer());
		if (p && p.GetIdentity()) return "player:" + p.GetIdentity().GetId() + ":" + Esc(p.GetIdentity().GetName());
		EntityAI root = e.GetHierarchyRoot();
		if (!root) root = e;
		vector pos = root.GetPosition();
		return "world:" + root.GetType() + ":" + Math.Round(pos[0]).ToString() + "," + Math.Round(pos[2]).ToString();
	}
	static void EnsureStarted()
	{
		if (s_Started) return;
		s_Started = true;
		GetGame().GetCallQueue(CALL_CATEGORY_SYSTEM).CallLater(Scan, 60000, true);
	}
	// called from EEInit: a brand new item gets a fresh id (a loaded item is given its saved id right after)
	static string OnInit(EntityAI e)
	{
		EnsureStarted();
		string uid = NewUid();
		Register(e, uid);
		return uid;
	}
	// called from OnStoreLoad with the saved id (empty when the item was saved before the mod existed)
	static string OnLoaded(EntityAI e, string current, string saved)
	{
		if (saved == "") return current;
		Unregister(e, current);
		Register(e, saved);
		return saved;
	}
	static void Register(EntityAI e, string uid)
	{
		array<EntityAI> list = s_ByUid.Get(uid);
		if (!list)
		{
			list = new array<EntityAI>();
			s_ByUid.Set(uid, list);
		}
		for (int i = list.Count() - 1; i >= 0; i--)
		{
			if (!list[i]) list.Remove(i);
			else if (list[i] == e) return;
		}
		if (list.Count() > 0) Report(uid, e, list[0]);
		list.Insert(e);
	}
	static void Unregister(EntityAI e, string uid)
	{
		array<EntityAI> list = s_ByUid.Get(uid);
		if (!list) return;
		for (int i = list.Count() - 1; i >= 0; i--)
		{
			if (!list[i] || list[i] == e) list.Remove(i);
		}
		if (list.Count() == 0) s_ByUid.Remove(uid);
	}
	static void Report(string uid, EntityAI a, EntityAI b)
	{
		float now = GetGame().GetTickTime();
		if (s_Reported.Contains(uid) && now - s_Reported.Get(uid) < 600) return;
		s_Reported.Set(uid, now);
		s_Dupes++;
		string cls = "?";
		if (a) cls = a.GetType();
		Append(DIR + "/dupes.log", Stamp() + "|dupe|" + uid + "|" + cls + "|" + Describe(a) + "|" + Describe(b));
	}
	// once a minute: drop dead entries, re-check for copies that slipped past registration, write a heartbeat
	static void Scan()
	{
		int tracked = 0;
		array<string> empty = new array<string>();
		for (int i = 0; i < s_ByUid.Count(); i++)
		{
			string uid = s_ByUid.GetKey(i);
			array<EntityAI> list = s_ByUid.GetElement(i);
			for (int j = list.Count() - 1; j >= 0; j--)
			{
				if (!list[j]) list.Remove(j);
			}
			if (list.Count() == 0)
			{
				empty.Insert(uid);
				continue;
			}
			tracked = tracked + list.Count();
			if (list.Count() > 1) Report(uid, list[0], list[1]);
		}
		for (int k = 0; k < empty.Count(); k++) s_ByUid.Remove(empty[k]);
		Append(DIR + "/dupes.log", Stamp() + "|stats|" + tracked.ToString() + "|" + s_Dupes.ToString() + "|v" + VERSION.ToString());
		s_ScanCount++;
		// first export 2 minutes after the first item appeared, then every s_ExportEvery minutes
		if (s_ScanCount == 2 || s_ScanCount % s_ExportEvery == 0) ExportLoot();
	}
	// Writes loot.txt: one line per item not carried by a player ("class|x|z|container class or -"), framed by
	// #begin and #end lines so the tool never reads a half-written file.
	static void ExportLoot()
	{
		if (!s_DirReady)
		{
			MakeDirectory(DIR);
			s_DirReady = true;
		}
		FileHandle fh = OpenFile(DIR + "/loot.txt", FileMode.WRITE);
		if (fh == 0) return;
		FPrintln(fh, "#begin|" + Stamp() + "|v" + VERSION.ToString());
		int n = 0;
		string chunk = "";
		int inChunk = 0;
		for (int i = 0; i < s_ByUid.Count(); i++)
		{
			array<EntityAI> list = s_ByUid.GetElement(i);
			for (int j = 0; j < list.Count(); j++)
			{
				EntityAI e = list[j];
				if (!e) continue;
				if (e.GetHierarchyRootPlayer()) continue;
				EntityAI root = e.GetHierarchyRoot();
				if (!root) root = e;
				vector pos = root.GetPosition();
				string where = "-";
				if (root != e) where = root.GetType();
				// vehicles without a script class to hook (motorbikes) are found through the parts they carry
				if (root != e && Transport.Cast(root) && s_Vehicles.Find(root) < 0) s_Vehicles.Insert(root);
				string line = e.GetType() + "|" + Math.Round(pos[0]).ToString() + "|" + Math.Round(pos[2]).ToString() + "|" + where;
				if (inChunk > 0) chunk = chunk + "\n";
				chunk = chunk + line;
				inChunk++;
				n++;
				if (inChunk >= 100)
				{
					FPrintln(fh, chunk);
					chunk = "";
					inChunk = 0;
				}
			}
		}
		if (inChunk > 0) FPrintln(fh, chunk);
		// vehicles: "#veh|class|x|z|health 0-1"
		for (int v = s_Vehicles.Count() - 1; v >= 0; v--)
		{
			EntityAI car = s_Vehicles[v];
			if (!car)
			{
				s_Vehicles.Remove(v);
				continue;
			}
			vector cp = car.GetPosition();
			FPrintln(fh, "#veh|" + car.GetType() + "|" + Math.Round(cp[0]).ToString() + "|" + Math.Round(cp[2]).ToString() + "|" + car.GetHealth01("", "").ToString());
		}
		FPrintln(fh, "#end|" + n.ToString());
		CloseFile(fh);
	}
}

// Weapon_Base and Magazine_Base both descend from ItemBase, so this covers every item.
modded class ItemBase
{
	string m_DZAT_Uid;

	override void EEInit()
	{
		super.EEInit();
		if (GetGame().IsServer() && m_DZAT_Uid == "") m_DZAT_Uid = DZAT_Dupe.OnInit(this);
	}
	override void EEDelete(EntityAI parent)
	{
		if (GetGame().IsServer() && m_DZAT_Uid != "") DZAT_Dupe.Unregister(this, m_DZAT_Uid);
		super.EEDelete(parent);
	}
	override void OnStoreSave(ParamsWriteContext ctx)
	{
		super.OnStoreSave(ctx);
		ctx.Write(m_DZAT_Uid);
	}
	override bool OnStoreLoad(ParamsReadContext ctx, int version)
	{
		if (!super.OnStoreLoad(ctx, version)) return false;
		string saved;
		if (!ctx.Read(saved) || !DZAT_Dupe.IsUid(saved)) saved = "";
		m_DZAT_Uid = DZAT_Dupe.OnLoaded(this, m_DZAT_Uid, saved);
		return true;
	}
	string DZAT_GetUid()
	{
		return m_DZAT_Uid;
	}
}

// Vehicles are not items: keep a list of the live ones so their positions can be exported with the loot.
modded class CarScript
{
	override void EEInit()
	{
		super.EEInit();
		if (GetGame().IsServer() && DZAT_Dupe.s_Vehicles.Find(this) < 0) DZAT_Dupe.s_Vehicles.Insert(this);
	}
}

modded class BoatScript
{
	override void EEInit()
	{
		super.EEInit();
		if (GetGame().IsServer() && DZAT_Dupe.s_Vehicles.Find(this) < 0) DZAT_Dupe.s_Vehicles.Insert(this);
	}
}
