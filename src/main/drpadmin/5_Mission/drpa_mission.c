// DRP_Admin server: runs the admin bridge (drpa_bridge.c, built from the tool's bridge.c) from the mission and
// reports connects, disconnects and server start to events.jsonl.
modded class MissionServer
{
	override void OnInit()
	{
		super.OnInit();
		// keep the action log on while DRP_Admin is in development (scriptExt.log)
		LogManager.ActionLogEnable(true);
		DRPA_Bridge.WORLD = GetGame().GetWorld().GetWorldSize();
		string body = DRPA_Events.Str("world", GetGame().GetWorldName()) + DRPA_Events.Num("size", DRPA_Bridge.WORLD);
		body = body + DRPA_Events.Num("version", DRPA_Bridge.VERSION);
		DRPA_Events.Emit("start", body);
	}
	override void OnUpdate(float timeslice)
	{
		super.OnUpdate(timeslice);
		DRPA_Bridge.Tick(timeslice);
	}
	override void InvokeOnConnect(PlayerBase player, PlayerIdentity identity)
	{
		super.InvokeOnConnect(player, identity);
		DRPA_Events.Emit("connect", ",\"who\":" + DRPA_Events.Who(player));
	}
	override void InvokeOnDisconnect(PlayerBase player)
	{
		if (player) DRPA_Events.Emit("disconnect", ",\"who\":" + DRPA_Events.Who(player) + ",\"alive\":" + DRPA_Events.BoolStr(player.IsAlive()));
		super.InvokeOnDisconnect(player);
	}
}
