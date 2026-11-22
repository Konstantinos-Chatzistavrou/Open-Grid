// Apache-2.0 — OpenGrid game module
using UnrealBuildTool;

public class OpenGrid : ModuleRules
{
    public OpenGrid(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        CppStandard = CppStandardVersion.Cpp20;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "InputCore",
            "EnhancedInput",
            "HTTP",
            "WebSockets",
            "Json",
            "JsonUtilities",
            "AudioMixer",
            "OpenGridPhysics"
        });
    }
}
