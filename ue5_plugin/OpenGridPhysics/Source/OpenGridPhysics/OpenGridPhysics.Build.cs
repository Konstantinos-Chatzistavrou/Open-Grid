// Apache-2.0 — OpenGrid Unreal Engine 5 build rules (UnrealBuildTool)
using System.IO;
using UnrealBuildTool;

public class OpenGridPhysics : ModuleRules
{
    public OpenGridPhysics(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;
        CppStandard = CppStandardVersion.Cpp20;
        bEnableExceptions = true;   // nlohmann::json and the car-spec loader report errors by throwing
        bUseUnity = false;          // RsCoreUnity.cpp is already one unit; merging it with the component risks name clashes

        // rs_core is not copied into the plugin: find the repo's core/ folder above this module, wherever the plugin
        // sits (ue5_plugin/ next to core/, or a project's Plugins/ folder inside the repo).
        string CoreRoot = FindCoreRoot(ModuleDirectory);
        PublicIncludePaths.Add(Path.Combine(CoreRoot, "include"));
        PrivateIncludePaths.Add(Path.Combine(CoreRoot, "third_party"));
        PrivateIncludePaths.Add(CoreRoot);   // RsCoreUnity.cpp includes "src/*.cpp"
        PrivateDefinitions.Add("RS_UNREAL=1");

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "PhysicsCore",
            "Chaos",
            "AudioMixer",
            "SignalProcessing"
        });

        if (Target.Platform == UnrealTargetPlatform.Win64)
        {
            PublicSystemLibraries.Add("ws2_32.lib");   // SimHub UDP telemetry (core/src/telemetry.cpp)
            // Link prebuilt CMake opengrid_engine_audio + opengrid_engine_sim static libs when available
            string WinBuildRel = Path.Combine(CoreRoot, "build", "Release");
            string AudioLib = Path.Combine(WinBuildRel, "opengrid_engine_audio.lib");
            string SimLib = Path.Combine(WinBuildRel, "opengrid_engine_sim.lib");
            if (File.Exists(AudioLib) && File.Exists(SimLib))
            {
                PublicAdditionalLibraries.Add(AudioLib);
                PublicAdditionalLibraries.Add(SimLib);
            }
        }
        else if (Target.Platform == UnrealTargetPlatform.Linux)
        {
            string BuildDir = Path.Combine(CoreRoot, "build");
            string AudioLib = Path.Combine(BuildDir, "libopengrid_engine_audio.a");
            string SimLib = Path.Combine(BuildDir, "libopengrid_engine_sim.a");
            if (File.Exists(AudioLib) && File.Exists(SimLib))
            {
                PublicAdditionalLibraries.Add(AudioLib);
                PublicAdditionalLibraries.Add(SimLib);
            }
        }
    }

    private static string FindCoreRoot(string Start)
    {
        DirectoryInfo Dir = new DirectoryInfo(Start);
        while (Dir != null)
        {
            string Candidate = Path.Combine(Dir.FullName, "core");
            if (File.Exists(Path.Combine(Candidate, "CMakeLists.txt")) && Directory.Exists(Path.Combine(Candidate, "include", "rs")))
            {
                return Candidate;
            }
            Dir = Dir.Parent;
        }
        throw new BuildException("OpenGridPhysics: no core/ folder (core/CMakeLists.txt + core/include/rs) above " + Start +
                                 ". Keep the plugin inside the Open-Grid repo.");
    }
}
