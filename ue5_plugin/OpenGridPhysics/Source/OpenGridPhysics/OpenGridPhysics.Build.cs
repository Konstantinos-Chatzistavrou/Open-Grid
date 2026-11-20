// Apache-2.0 — OpenGrid Unreal Engine 5 Build Rules (UnrealBuildTool)
using UnrealBuildTool;
using System.IO;

public class OpenGridPhysics : ModuleRules
{
    public OpenGridPhysics(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;
        CppStandard = CppStandardVersion.Cpp20;
        bEnableExceptions = true;

        // Point directly to rs_core headers and vendored nlohmann/json
        string CoreRoot = Path.GetFullPath(Path.Combine(ModuleDirectory, "../../../../core"));
        PublicIncludePaths.Add(Path.Combine(CoreRoot, "include"));
        PrivateIncludePaths.Add(Path.Combine(CoreRoot, "third_party"));

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "PhysicsCore",
            "Chaos"
        });
    }
}
