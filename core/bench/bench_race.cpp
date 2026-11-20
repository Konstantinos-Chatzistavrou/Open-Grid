// CPU cost of the core for a full grid: AI + controls, physics and race tracker for 8 cars on the
// real city route, 30 simulated seconds at 240 Hz. Headless, no engine. Run after any change to
// the core that runs every tick, and compare with docs/performance.md.
//   core/build/rs_bench data/cars/vela_gt.json data/tracks/city_route.json
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>
#include "rs/ai.hpp"
#include "rs/controls.hpp"
#include "rs/pinnacle.hpp"
#include "rs/race.hpp"
#include "rs/route.hpp"
#include "rs/sim.hpp"
using namespace rs;
using clk = std::chrono::steady_clock;

static void run_bench(const CarConfig& cfg, const Route& r, bool max_aaa) {
    const int n = 8;
    std::vector<std::unique_ptr<Simulation>> sims;
    std::vector<std::unique_ptr<Controls>> ctls;
    std::vector<std::unique_ptr<AIDriver>> ais;
    RaceTracker race(r, 3);
    for (int k = 0; k < n; ++k) {
        RouteSample p = r.at(75.0 - 9.0 * k);
        auto s = std::make_unique<Simulation>(cfg, std::make_shared<PlaneGround>(Vec3{0, 0, 1}));
        s->dt = 1.0 / 240.0;
        s->vehicle.assists().abs = s->vehicle.assists().tc = true;
        if (max_aaa) {
            s->use_contact_patch = true;
            s->vehicle.unsprung_dynamics_enabled = true;
            s->vehicle.tire_zones_enabled = true;
            s->vehicle.aero_wake().yaw_aero_enabled = true;
            s->vehicle.chassis_dynamics().chassis_flex_enabled = true;
            s->vehicle.chassis_dynamics().active_yaw_control_enabled = true;
            s->vehicle.chassis_dynamics().active_aero_enabled = true;
            s->vehicle.chassis_dynamics().brake_fluid_boil_enabled = true;
            s->vehicle.engine_systems().turbo_stage = 2;
            s->vehicle.engine_systems().wear_enabled = true;
            s->vehicle.engine_systems().fuel_consumption_enabled = true;
            s->vehicle.engine_systems().torsional_compliance_enabled = true;
            s->vehicle.engine_systems().dog_box_flat_shift_cut = true;
        }
        s->reset({p.p.x + (k % 2 ? 2.4 : -2.4) * -std::sin(p.heading), p.p.y + (k % 2 ? 2.4 : -2.4) * std::cos(p.heading), 0}, p.heading, 0, 2);
        auto c = std::make_unique<Controls>(s->vehicle.config());
        c->settings.auto_gearbox = c->settings.auto_clutch = true;
        AIParams ap;
        ap.lane_offset = k % 2 ? 1.0 : -1.0;
        ap.proactive_racecraft = max_aaa;
        ais.push_back(std::make_unique<AIDriver>(s->vehicle.config(), r, ap));
        race.add_car(s->body.state.position);
        sims.push_back(std::move(s));
        ctls.push_back(std::move(c));
    }
    double t_ai = 0, t_phys = 0, t_race = 0;
    const int N = 240 * 30;
    for (int i = 0; i < N; ++i) {
        std::vector<OtherCar> all;
        std::vector<Vec3> all_pos;
        for (auto& s : sims) {
            all.push_back({s->body.state.position, s->body.state.velocity});
            all_pos.push_back(s->body.state.position);
        }
        for (int k = 0; k < n; ++k) {
            std::vector<OtherCar> others;
            for (int j = 0; j < n; ++j) if (j != k) others.push_back(all[j]);
            auto a = clk::now();
            AIOutput o = ais[k]->update(sims[k]->body.state, sims[k]->last, others, sims[k]->dt);
            if (o.gear_request >= 0) ctls[k]->set_gear(o.gear_request);
            DriverInput in = ctls[k]->update(o.raw, sims[k]->last, sims[k]->dt);
            auto b = clk::now();
            if (max_aaa) {
                sims[k]->vehicle.aero_wake() = Vehicle::compute_slipstream_wake(
                    sims[k]->body.state.position,
                    sims[k]->body.state.orientation.rotate({1, 0, 0}),
                    all_pos);
                sims[k]->vehicle.aero_wake().yaw_aero_enabled = true;
            }
            sims[k]->step(in);
            if (max_aaa) {
                (void)compute_engine_acoustics(EngineAcousticLayout::Inline6, sims[k]->last.engine_rpm,
                                               sims[k]->last.throttle_applied, sims[k]->last.boost_bar,
                                               sims[k]->last.bov_venting, sims[k]->last.shift_cut_active,
                                               sims[k]->last.gear, sims[k]->last.speed);
            }
            auto c = clk::now();
            race.update(k, sims[k]->body.state.position, i / 240.0);
            auto d = clk::now();
            t_ai += std::chrono::duration<double, std::micro>(b - a).count();
            t_phys += std::chrono::duration<double, std::micro>(c - b).count();
            t_race += std::chrono::duration<double, std::micro>(d - c).count();
        }
    }
    double per = 1.0 / (N * n);
    std::printf("[%s]\n", max_aaa ? "MAXED AAA (ALL 15 SUBSYSTEMS ON)" : "BASELINE");
    std::printf("  per car per tick: AI+controls %.2f us, physics %.2f us, race tracker %.2f us\n", t_ai * per, t_phys * per, t_race * per);
    std::printf("  8 cars, 4 ticks per 60 fps frame: %.3f ms per frame total\n", (t_ai + t_phys + t_race) / N * 4 / 1000.0);
}

int main(int, char** argv) {
    CarConfig cfg = load_car_config(argv[1]);
    Route r = Route::load(argv[2]);
    run_bench(cfg, r, false);
    run_bench(cfg, r, true);
}
