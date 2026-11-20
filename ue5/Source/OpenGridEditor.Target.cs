// Apache-2.0 — OpenGrid editor target
using UnrealBuildTool;

public class OpenGridEditorTarget : TargetRules
{
    public OpenGridEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.Latest;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("OpenGrid");
    }
}
