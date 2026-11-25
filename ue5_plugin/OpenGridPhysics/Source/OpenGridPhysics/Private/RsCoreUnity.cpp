// Apache-2.0 — compiles the engine-independent rs_core sources into the OpenGridPhysics module, so there is no
// separate library to build or link. The include path to core/ comes from OpenGridPhysics.Build.cs.
//
// The core is third-party code from Unreal's point of view: THIRD_PARTY_INCLUDES_START relaxes the engine's stricter
// warnings for it. telemetry.cpp goes last because it pulls in the Windows socket headers (with their macros) on Win64.
// CI compiles this same list as one C++20 unit with MSVC (.github/workflows/ci.yml, job core-windows).

#include "CoreMinimal.h"   // defines THIRD_PARTY_INCLUDES_START / _END even when the shared PCH is not used

THIRD_PARTY_INCLUDES_START
#include "src/config.cpp"
#include "src/kinematics.cpp"
#include "src/tire.cpp"
#include "src/drivetrain.cpp"
#include "src/vehicle.cpp"
#include "src/sim.cpp"
#include "src/controls.cpp"
#include "src/damage.cpp"
#include "src/route.cpp"
#include "src/ai.cpp"
#include "src/racing_line.cpp"
#include "src/incandescence.cpp"
#include "src/dyno.cpp"
#include "src/cluster.cpp"
#include "src/race.cpp"
#include "src/setup.cpp"
#include "src/cops.cpp"
#include "src/authority.cpp"
#include "src/gameplay.cpp"
#include "src/pinnacle.cpp"
#include "src/esports.cpp"
#include "src/tempest.cpp"
#include "src/telemetry.cpp"
THIRD_PARTY_INCLUDES_END
