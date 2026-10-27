class CfgPatches
{
	class DRP_Admin_Server
	{
		units[] = {};
		weapons[] = {};
		requiredVersion = 0.1;
		requiredAddons[] = {"DZ_Data", "DZ_Scripts"};
	};
};

class CfgMods
{
	class DRP_Admin_Server
	{
		dir = "DayZAdminTools";
		name = "DRP_Admin (server)";
		author = "DayZ Admin Tools";
		type = "mod";
		dependencies[] = {"World", "Mission"};
		class defs
		{
			class worldScriptModule
			{
				value = "";
				files[] = {"DRP_Admin/scripts/4_World"};
			};
			class missionScriptModule
			{
				value = "";
				files[] = {"DRP_Admin/scripts/5_Mission"};
			};
		};
	};
};
