// Apache-2.0 — UnrealBuildTool Unity Compilation Bridge for rs_core.
// UnrealBuildTool compiles .cpp files inside Plugins/OpenGridPhysics/Source/OpenGridPhysics/Private/.
// Including the engine-independent rs_core implementation units here compiles the entire C++ physics,
// Pacejka tire, drivetrain, tactical police AI, server authority, telemetry, and gameplay core
// directly into the UE5 OpenGridPhysics module with zero external library linking steps.

#include "../../../../../core/src/config.cpp"
#include "../../../../../core/src/tire.cpp"
#include "../../../../../core/src/drivetrain.cpp"
#include "../../../../../core/src/vehicle.cpp"
#include "../../../../../core/src/sim.cpp"
#include "../../../../../core/src/controls.cpp"
#include "../../../../../core/src/damage.cpp"
#include "../../../../../core/src/route.cpp"
#include "../../../../../core/src/ai.cpp"
#include "../../../../../core/src/race.cpp"
#include "../../../../../core/src/setup.cpp"
#include "../../../../../core/src/telemetry.cpp"
#include "../../../../../core/src/cops.cpp"
#include "../../../../../core/src/authority.cpp"
#include "../../../../../core/src/gameplay.cpp"
#include "../../../../../core/src/pinnacle.cpp"
#include "../../../../../core/src/esports.cpp"
