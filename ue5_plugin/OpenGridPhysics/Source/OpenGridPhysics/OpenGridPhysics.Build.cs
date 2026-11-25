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

        // rs::EngineAudioSynth (core/src/engine_audio.cpp) and the vendored engine-sim sources are NOT part of RsCoreUnity.cpp, but
        // both audio components need them (UOpenGridAudioComponent here, UOpenGridEngineSynthComponent in the game module).
        // They come from the CMake static libraries opengrid_engine_audio + opengrid_engine_sim, which have to be built first.
        // Say so here, with the command to run, instead of skipping the libraries and failing later with unresolved externals.
        string AudioLib;
        string SimLib;
        string BuildCommand;
        if (Target.Platform == UnrealTargetPlatform.Win64)
        {
            PublicSystemLibraries.Add("ws2_32.lib");   // SimHub UDP telemetry (core/src/telemetry.cpp)
            string WinBuildRel = Path.Combine(CoreRoot, "build", "Release");
            AudioLib = Path.Combine(WinBuildRel, "opengrid_engine_audio.lib");
            SimLib = Path.Combine(WinBuildRel, "opengrid_engine_sim.lib");
            BuildCommand = "cmake -S core -B core/build -A x64 && cmake --build core/build --config Release --target opengrid_engine_audio opengrid_engine_sim";
        }
        else if (Target.Platform == UnrealTargetPlatform.Linux)
        {
            string BuildDir = Path.Combine(CoreRoot, "build");
            AudioLib = Path.Combine(BuildDir, "libopengrid_engine_audio.a");
            SimLib = Path.Combine(BuildDir, "libopengrid_engine_sim.a");
            BuildCommand = "cmake -S core -B core/build -DCMAKE_BUILD_TYPE=Release && cmake --build core/build --target opengrid_engine_audio opengrid_engine_sim";
        }
        else
        {
            throw new BuildException("OpenGridPhysics: the engine audio libraries are only wired up for Win64 and Linux (" +
                                     Target.Platform + " is not supported yet).");
        }

        if (!File.Exists(AudioLib) || !File.Exists(SimLib))
        {
            throw new BuildException("OpenGridPhysics: the engine audio libraries are missing (" + AudioLib + ", " + SimLib +
                                     "). Build them once from the repo root, then build the project again:\n  " + BuildCommand);
        }
        PublicAdditionalLibraries.Add(AudioLib);
        PublicAdditionalLibraries.Add(SimLib);
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
