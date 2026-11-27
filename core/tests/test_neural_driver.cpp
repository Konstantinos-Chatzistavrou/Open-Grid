// Apache-2.0 — CTest verification for the Open Grid Neural Driver (JSON load, deterministic
// zero-allocation forward pass, mirror symmetry, and clean autonomous lap inside rs::Simulation).
#include <cmath>
#include <memory>
#include <vector>
#include "harness.hpp"
#include "rs/controls.hpp"
#include "rs/neural_driver.hpp"
#include "rs/route.hpp"

using namespace rs;

RS_TEST(neural_driver) {
    // 1. Load trained weights from data/ai/neural_driver.json
    NeuralPolicy policy;
    const std::string weights_path = test::data_path("ai/neural_driver.json");
    test::check("trained neural_driver.json loads cleanly", policy.load_file(weights_path));
    test::check("policy reports loaded state", policy.is_loaded());

    // 2. Round-trip JSON serialization & deterministic forward pass
    const std::string serialized = policy.to_json();
    NeuralPolicy reloaded;
    test::check("to_json -> parse_json round-trip succeeds", reloaded.parse_json(serialized));

    const NeuralObs sample_obs = {0.42, 0.15, -0.08, 0.10, -0.04, 0.25, 0.35, -0.10, 0.0, 0.70, 0.65, -0.05, 1.0, 0.0};
    const NeuralAction a1 = policy.infer(sample_obs);
    const NeuralAction a2 = reloaded.infer(sample_obs);
    test::check("forward pass outputs stay strictly in valid control bounds",
                std::isfinite(a1.steer) && a1.steer >= -1.0 && a1.steer <= 1.0 &&
                std::isfinite(a1.throttle) && a1.throttle >= 0.0 && a1.throttle <= 1.0 &&
                std::isfinite(a1.brake) && a1.brake >= 0.0 && a1.brake <= 1.0);
    test::check("round-tripped policy reproduces identical deterministic outputs",
                std::abs(a1.steer - a2.steer) < 1e-5 &&
                std::abs(a1.throttle - a2.throttle) < 1e-5 &&
                std::abs(a1.brake - a2.brake) < 1e-5);

    // 3. Drive a full autonomous lap on Old Harbour City Loop inside real rs::Simulation physics!
    Route raw_city = Route::load(test::data_path("tracks/city_route.json"));
    std::vector<RouteSample> flat_pts = raw_city.samples();
    for (auto& pt : flat_pts) pt.p.z = 0.0;
    const Route city = Route::from_samples(std::move(flat_pts), raw_city.closed());

    const CarConfig cfg = test::car();
    auto sim = test::make_sim(cfg, 1.0 / 200.0);
    sim->vehicle.assists().abs = true;
    sim->vehicle.assists().tc = true;

    NeuralDriver driver(sim->vehicle.config(), city, policy, 0.96);
    const RouteSample s0 = city.at(0.0);
    const Vec3 p0 = s0.p + city.left(0.0) * driver.racing_line().lateral(0.0);
    sim->reset({p0.x, p0.y, 0.0}, s0.heading, 22.0, 4);
    sim->settle(0.15);

    Controls ctl(sim->vehicle.config());
    ctl.settings.auto_gearbox = true;
    ctl.set_gear(4);

    const std::vector<OtherCar> no_others;
    double travelled = 0.0;
    double last_s = city.project(sim->body.state.position).s;
    double offtrack_sec = 0.0;
    double max_excursion = -1e9;
    const double t0 = sim->time;

    while (sim->time - t0 < 65.0 && travelled < city.length()) {
        const AIOutput out = driver.update(sim->body.state, sim->last, no_others, sim->dt);
        if (out.gear_request >= 0) ctl.set_gear(out.gear_request);
        sim->step(ctl.update(out.raw, sim->last, sim->dt));

        const double ds = city.delta(last_s, driver.route_s);
        travelled += ds;
        last_s = driver.route_s;

        const RouteSample rs_here = city.at(driver.route_s);
        const double limit_w = (driver.last_lateral >= 0.0 ? rs_here.width_left : rs_here.width_right) - 0.9;
        const double excursion = std::abs(driver.last_lateral) - limit_w;
        max_excursion = std::max(max_excursion, excursion);
        if (excursion > 0.0) offtrack_sec += sim->dt;
    }

    const double lap_s = sim->time - t0;
    const double avg_kmh = (travelled / std::max(0.1, lap_s)) * 3.6;
    std::printf("         Open Grid Neural Driver lap: %.0f / %.0f m in %.2f s (avg %.1f km/h), offtrack %.2f s, max excursion %.2f m\n",
                travelled, city.length(), lap_s, avg_kmh, offtrack_sec, max_excursion);

    test::check("Open Grid Neural Driver completes a full lap autonomously", travelled >= city.length());
    test::check_range("Open Grid Neural Driver average lap speed", avg_kmh, 72.0, 220.0, "km/h");
    test::check_range("Open Grid Neural Driver stays cleanly on track (offtrack time)", offtrack_sec, 0.0, 1.5, "s");
    test::check_range("Open Grid Neural Driver max lateral excursion past road edge", max_excursion, -10.0, 2.5, "m");
}
