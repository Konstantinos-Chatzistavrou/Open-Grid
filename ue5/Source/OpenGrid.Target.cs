// Apache-2.0 — OpenGrid game target
using UnrealBuildTool;

public class OpenGridTarget : TargetRules
{
    public OpenGridTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.Latest;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("OpenGrid");
    }
}
