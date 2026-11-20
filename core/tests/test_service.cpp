// Fuel use and engine wear are on in both builds (web/wasm/bridge.cpp, UOpenGridVehicleComponent). An empty tank cuts
// the throttle, so the repair key must also refuel: Vehicle::service().
#include <cmath>
#include <memory>
#include "harness.hpp"
#include "rs/config.hpp"
#include "rs/sim.hpp"
#include "rs/vehicle.hpp"

RS_TEST(service) {
    using namespace rs;
    const CarConfig cfg = load_car_config(std::string(RS_DATA_DIR) + "/cars/kestrel_gt.json");
    auto flat = std::make_shared<PlaneGround>();

    DriverInput wot;
    wot.throttle = 1.0;
    wot.gear = 3;
    wot.auto_clutch = true;

    // 1. Fuel burns at full throttle
    Simulation burn(cfg, flat);
    burn.vehicle.engine_systems().fuel_consumption_enabled = true;
    burn.reset({}, 0.0, 20.0, 3);
    const double before = burn.vehicle.engine_systems().fuel_liters;
    for (int i = 0; i < 240 * 5; ++i) burn.step(wot);   // 5 s
    const double used = before - burn.vehicle.engine_systems().fuel_liters;
    test::check_range("fuel used in 5 s at full throttle", used, 0.02, 0.5, "L");

    // 2. Empty tank: no drive, the car only coasts down
    Simulation dry(cfg, flat);
    dry.vehicle.engine_systems().fuel_consumption_enabled = true;
    dry.vehicle.engine_systems().fuel_liters = 0.0;
    dry.reset({}, 0.0, 20.0, 3);
    for (int i = 0; i < 240 * 2; ++i) dry.step(wot);
    test::check("empty tank: full throttle does not accelerate", dry.last.speed < 20.0);

    // 3. Service refuels and restores the engine
    dry.vehicle.engine_systems().engine_health = 0.4;
    dry.vehicle.service();
    test::check("service fills the tank",
                dry.vehicle.engine_systems().fuel_liters == dry.vehicle.engine_systems().fuel_capacity_liters);
    test::check("service restores engine health", dry.vehicle.engine_systems().engine_health == 1.0);
    const double v0 = dry.last.speed;
    for (int i = 0; i < 240 * 2; ++i) dry.step(wot);
    test::check("after service the car accelerates again", dry.last.speed > v0 + 2.0);

    // 4. Fuel weight: the spec mass is with a full tank; an almost empty tank makes the car lighter and quicker
    Simulation full(cfg, flat), light(cfg, flat);
    for (Simulation* s : {&full, &light}) s->vehicle.engine_systems().fuel_consumption_enabled = true;
    light.vehicle.engine_systems().fuel_liters = 2.0;
    // 5th gear from 30 m/s: power-limited, not grip-limited (with wheelspin, grip and weight scale together and the
    // lighter car gains nothing, which is also what real cars do)
    DriverInput wot5 = wot;
    wot5.gear = 6;
    full.reset({}, 0.0, 30.0, 6);
    light.reset({}, 0.0, 30.0, 6);
    for (int i = 0; i < 240 * 4; ++i) { full.step(wot5); light.step(wot5); }
    std::printf("         after 4 s: full tank %.3f m/s, 2 L left %.3f m/s\n", full.last.speed, light.last.speed);
    const double tank_kg = (full.vehicle.engine_systems().fuel_capacity_liters - 2.0) * 0.745;
    test::check_range("mass difference full vs 2 L left", full.last.mass_kg - light.last.mass_kg, tank_kg - 0.5, tank_kg + 0.5, "kg");
    test::check("full tank: output mass is the spec mass (minus what 4 s burnt)", std::abs(full.last.mass_kg - cfg.mass) < 0.5);
    test::check_range("lighter car is faster after 4 s at full throttle", light.last.speed - full.last.speed, 0.05, 3.0, "m/s");
}
