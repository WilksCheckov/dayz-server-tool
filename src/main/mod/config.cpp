class CfgPatches
{
	class DZAT_AntiCheat
	{
		units[] = {};
		weapons[] = {};
		requiredVersion = 0.1;
		requiredAddons[] = {"DZ_Data", "DZ_Scripts"};
	};
};

class CfgMods
{
	class DZAT_AntiCheat
	{
		dir = "DayZAdminTools";
		name = "DayZ Admin Tools anti-dupe";
		author = "DayZ Admin Tools";
		type = "mod";
		dependencies[] = {"World"};
		class defs
		{
			class worldScriptModule
			{
				value = "";
				files[] = {"DayZAdminTools/scripts/4_World"};
			};
		};
	};
};
