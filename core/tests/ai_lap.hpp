// Apache-2.0 - route and AI-driven car helpers shared by test_phase4.cpp and test_mf62_ab.cpp (a block of streets, a straight, an AI car driving a route).
#pragma once
#include <cmath>
#include <memory>
#include <vector>
#include "harness.hpp"
#include "rs/ai.hpp"
#include "rs/race.hpp"
#include "rs/racing_line.hpp"

namespace ai_lap {
using namespace rs;

// Rectangle of streets with rounded corners (like driving around a city block).
inline Route block_route(double w, double h, double r, double half_width) {
    std::vector<RouteSample> v;
    auto add = [&](double x, double y, double hd, double k) {
        RouteSample s;
        s.p = {x, y, 0};
        s.heading = hd;
        s.curvature = k;
        s.width_left = s.width_right = half_width;
        v.push_back(s);
    };
    double step = 2.0;
    double cx[4] = {w - r, w - r, r, r}, cy[4] = {r, h - r, h - r, r};
    for (int side = 0; side < 4; ++side) {
        double h0 = side * kPi / 2;                   // heading of this straight
        Vec3 a{cx[(side + 3) % 4] + r * std::cos(h0 - kPi / 2), cy[(side + 3) % 4] + r * std::sin(h0 - kPi / 2), 0};
        Vec3 b{cx[side] + r * std::cos(h0 - kPi / 2), cy[side] + r * std::sin(h0 - kPi / 2), 0};
        double L = length(b - a);
        for (double t = 0; t < L; t += step) add(a.x + (b.x - a.x) * t / L, a.y + (b.y - a.y) * t / L, h0, 0);
        for (double ang = 0; ang < kPi / 2; ang += step / r)   // left-hand 90 degree corner
            add(cx[side] + r * std::cos(h0 - kPi / 2 + ang), cy[side] + r * std::sin(h0 - kPi / 2 + ang), h0 + ang, 1.0 / r);
    }
    return Route::from_samples(v, true);
}

inline Route straight_route(double len, double half_width) {
    std::vector<RouteSample> v;
    for (double x = 0; x <= len; x += 2) {
        RouteSample s;
        s.p = {x, 0, 0};
        s.width_left = s.width_right = half_width;
        v.push_back(s);
    }
    return Route::from_samples(v, false);
}

struct AICar {
    std::unique_ptr<Simulation> sim;
    std::unique_ptr<Controls> ctl;
    std::unique_ptr<AIDriver> ai;
    AICar(const CarConfig& cfg, const Route& r, AIParams p, Vec3 pos, double yaw, double v) {
        sim = test::make_sim(cfg);
        sim->vehicle.assists().abs = sim->vehicle.assists().tc = true;
        sim->reset(pos, yaw, v, v > 10 ? 4 : 2);
        ctl = std::make_unique<Controls>(sim->vehicle.config());
        ctl->settings.auto_gearbox = true;
        ctl->set_gear(v > 10 ? 4 : 2);
        ai = std::make_unique<AIDriver>(sim->vehicle.config(), r, p);
    }
    void step(const std::vector<OtherCar>& others) {
        AIOutput o = ai->update(sim->body.state, sim->last, others, sim->dt);
        if (o.gear_request >= 0) ctl->set_gear(o.gear_request);
        sim->step(ctl->update(o.raw, sim->last, sim->dt));
    }
    OtherCar as_other() const { return {sim->body.state.position, sim->body.state.velocity}; }
};

}  // namespace ai_lap
