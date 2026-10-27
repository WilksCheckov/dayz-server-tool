// DRP_Admin server hooks: one JSON object per line in $profile:DayZAdminTools/events.jsonl for the Admin Tool.
// Every line has "t" (server local time) and "ev"; players are {"id","steam","name","pos"}, other entities {"cls","pos"}.
class DRPA_Events
{
	static const string DIR = "$profile:DayZAdminTools";
	static bool s_DirReady = false;

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
	static string Vec(vector v)
	{
		return "[" + v[0].ToString() + "," + v[1].ToString() + "," + v[2].ToString() + "]";
	}
	static string Str(string key, string value)
	{
		return ",\"" + key + "\":\"" + Esc(value) + "\"";
	}
	static string Num(string key, float value)
	{
		return ",\"" + key + "\":" + value.ToString();
	}
	// the player behind an entity: itself, or whoever holds it (a weapon, a grenade in hands)
	static PlayerBase OwnerOf(Object o)
	{
		PlayerBase p = PlayerBase.Cast(o);
		if (p) return p;
		EntityAI e = EntityAI.Cast(o);
		if (e) return PlayerBase.Cast(e.GetHierarchyRootPlayer());
		return null;
	}
	static string Who(Object o)
	{
		if (!o) return "null";
		PlayerBase p = OwnerOf(o);
		if (p && p.GetIdentity())
		{
			string r = "{\"id\":\"" + p.GetIdentity().GetId() + "\"";
			r = r + Str("steam", p.GetIdentity().GetPlainId()) + Str("name", p.GetIdentity().GetName());
			r = r + ",\"pos\":" + Vec(p.GetPosition()) + "}";
			return r;
		}
		if (p) o = p;
		return "{\"cls\":\"" + Esc(o.GetType()) + "\",\"pos\":" + Vec(o.GetPosition()) + "}";
	}
	static void Emit(string ev, string body)
	{
		if (!GetGame() || !GetGame().IsServer() || !GetGame().IsMultiplayer()) return;
		if (!s_DirReady)
		{
			MakeDirectory(DIR);
			s_DirReady = true;
		}
		string line = "{\"t\":\"" + Stamp() + "\",\"ev\":\"" + ev + "\"" + body + "}";
		FileHandle fh = OpenFile(DIR + "/events.jsonl", FileMode.APPEND);
		if (fh == 0) return;
		FPrintln(fh, line);
		CloseFile(fh);
	}

	// damageType: 0 melee, 1 firearm, 2 explosion, 3 other (DT_ constants)
	static void Hit(PlayerBase victim, TotalDamageResult res, int damageType, EntityAI source, string zone, string ammo)
	{
		float dmg = 0;
		float blood = 0;
		if (res)
		{
			dmg = res.GetDamage(zone, "Health");
			blood = res.GetDamage(zone, "Blood");
		}
		string body = ",\"victim\":" + Who(victim) + ",\"by\":" + Who(source);
		string weapon = "";
		if (source && !source.IsMan() && !source.IsInherited(DayZCreature)) weapon = source.GetType();
		body = body + Str("weapon", weapon) + Str("ammo", ammo) + Str("zone", zone);
		body = body + Num("type", damageType) + Num("dmg", dmg) + Num("blood", blood);
		if (source) body = body + Num("dist", vector.Distance(victim.GetPosition(), source.GetPosition()));
		body = body + Num("hp", victim.GetHealth("", "")) + ",\"dead\":" + BoolStr(!victim.IsAlive());
		Emit("hit", body);
	}
	static void Killed(PlayerBase victim, Object killer)
	{
		string body = ",\"victim\":" + Who(victim) + ",\"by\":" + Who(killer);
		string weapon = "";
		EntityAI ke = EntityAI.Cast(killer);
		if (ke && !ke.IsMan() && !ke.IsInherited(DayZCreature)) weapon = ke.GetType();
		body = body + Str("weapon", weapon);
		if (killer) body = body + Num("dist", vector.Distance(victim.GetPosition(), killer.GetPosition()));
		Emit("kill", body);
	}
	static void Build(string ev, BaseBuildingBase base, Man player, string part)
	{
		string body = ",\"by\":" + Who(player) + Str("cls", base.GetType()) + Str("part", part);
		body = body + ",\"pos\":" + Vec(base.GetPosition());
		Emit(ev, body);
	}
	static void Vehicle(string ev, Man player, Object veh)
	{
		if (!veh) return;
		string body = ",\"by\":" + Who(player) + Str("cls", veh.GetType()) + ",\"pos\":" + Vec(veh.GetPosition());
		Emit(ev, body);
	}
	static string BoolStr(bool b)
	{
		if (b) return "true";
		return "false";
	}
}

modded class PlayerBase
{
	override void EEHitBy(TotalDamageResult damageResult, int damageType, EntityAI source, int component, string dmgZone, string ammo, vector modelPos, float speedCoef)
	{
		super.EEHitBy(damageResult, damageType, source, component, dmgZone, ammo, modelPos, speedCoef);
		if (GetGame().IsServer() && GetIdentity()) DRPA_Events.Hit(this, damageResult, damageType, source, dmgZone, ammo);
	}
	override void EEKilled(Object killer)
	{
		if (GetGame().IsServer() && GetIdentity()) DRPA_Events.Killed(this, killer);
		super.EEKilled(killer);
	}
}

modded class BaseBuildingBase
{
	override void OnPartBuiltServer(notnull Man player, string part_name, int action_id)
	{
		super.OnPartBuiltServer(player, part_name, action_id);
		DRPA_Events.Build("build", this, player, part_name);
	}
	override void OnPartDismantledServer(notnull Man player, string part_name, int action_id)
	{
		DRPA_Events.Build("dismantle", this, player, part_name);
		super.OnPartDismantledServer(player, part_name, action_id);
	}
	override void OnPartDestroyedServer(Man player, string part_name, int action_id, bool destroyed_by_connected_part = false)
	{
		DRPA_Events.Build("destroy", this, player, part_name);
		super.OnPartDestroyedServer(player, part_name, action_id, destroyed_by_connected_part);
	}
}

modded class ItemBase
{
	override void OnPlacementComplete(Man player, vector position = "0 0 0", vector orientation = "0 0 0")
	{
		super.OnPlacementComplete(player, position, orientation);
		if (!GetGame().IsServer()) return;
		string body = ",\"by\":" + DRPA_Events.Who(player) + DRPA_Events.Str("cls", GetType()) + ",\"pos\":" + DRPA_Events.Vec(position);
		DRPA_Events.Emit("place", body);
	}
}

modded class ActionGetInTransport
{
	override void OnStartServer(ActionData action_data)
	{
		super.OnStartServer(action_data);
		Object veh = null;
		if (action_data.m_Target) veh = Transport.Cast(action_data.m_Target.GetObject());
		if (!veh && action_data.m_Target) veh = Transport.Cast(action_data.m_Target.GetParent());
		DRPA_Events.Vehicle("vehicle_in", action_data.m_Player, veh);
	}
}

modded class ActionGetOutTransport
{
	override void OnStartServer(ActionData action_data)
	{
		Object veh = null;
		HumanCommandVehicle hcv = action_data.m_Player.GetCommand_Vehicle();
		if (hcv) veh = hcv.GetTransport();
		DRPA_Events.Vehicle("vehicle_out", action_data.m_Player, veh);
		super.OnStartServer(action_data);
	}
}
