// The gearbox is a property of the CAR; the AUTO / MAN switch only decides who picks the gear. A dual-clutch box clutches itself and a
// torque converter has no clutch at all, so neither can miss a shift whatever the player's clutch assist says. Cars with a clutch pedal
// (manual synchromesh) keep the missed-shift model.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <string>
#include "harness.hpp"
#include "rs/controls.hpp"

using namespace rs;

namespace {

struct Run {
    double t100 = -1, kmh = 0, neutral_max = 0;
    int missed = 0;
    double gearbox = 1, clutch = 1;
    int gear = 0;
};

// 30 s flat out from rest, the way the game drives it. `paddles`: AUTO off, shifts by hand at 6500 rpm (no clutch pedal).
Run flat_out(const CarConfig& cfg, bool auto_gearbox, bool clutch_assist, AutoClutchQuality q, bool paddles = false) {
    auto s = test::make_sim(cfg);
    test::enable_game_models(s->vehicle);
    s->vehicle.assists().tc = true;
    Controls c(cfg);
    c.settings.auto_gearbox = auto_gearbox;
    c.settings.auto_clutch = clutch_assist;
    c.settings.auto_clutch_quality = q;
    s->settle(0.5);
    c.set_gear(2);
    RawInput raw;
    raw.device = InputDevice::Gamepad;
    raw.throttle = 1.0;
    Run r;
    double neutral = 0, since_shift = 0;
    const int top = static_cast<int>(cfg.drivetrain.gear_ratios.size()) - 1;
    for (int i = 0; i < 30 * 240; ++i) {
        raw.shift_up = false;
        since_shift += s->dt;
        if (paddles && s->last.engine_rpm > 6500.0 && c.gear() < top && since_shift > 0.4) { raw.shift_up = true; since_shift = 0; }
        const DriverInput in = c.update(raw, s->last, s->dt);
        s->step(in);
        if (r.t100 < 0 && s->last.speed >= 100.0 / 3.6) r.t100 = s->time;
        if (s->last.gear == 1 && in.gear != 1) neutral += s->dt; else neutral = 0;
        r.neutral_max = std::max(r.neutral_max, neutral);
    }
    r.kmh = s->last.speed * 3.6;
    r.missed = s->last.missed_shifts;
    r.gearbox = s->last.gearbox_health;
    r.clutch = s->last.clutch_health;
    r.gear = s->last.gear;
    return r;
}

}  // namespace

RS_TEST(transmission_by_car) {
    // the cars whose real counterpart has a dual-clutch box, and the one with a torque-converter automatic
    const std::map<std::string, TransmissionType> declared = {
        {"falcorn_9r", TransmissionType::DualClutchDct},   {"falcorn_9r_rs", TransmissionType::DualClutchDct},
        {"aether_solis", TransmissionType::DualClutchDct}, {"aether_borealis", TransmissionType::DualClutchDct},
        {"valenza_corsa", TransmissionType::DualClutchDct}, {"valenza_fiamma", TransmissionType::DualClutchDct},
        {"valenza_sp3", TransmissionType::DualClutchDct},  {"kronos_fulmine", TransmissionType::DualClutchDct},
        {"tornado_gt", TransmissionType::DualClutchDct},   {"falcorn_hellhound", TransmissionType::AutomaticTorqueConverter},
    };
    int wrong = 0;
    for (const auto& [id, type] : declared) {
        const CarConfig cfg = load_car_config(test::data_path("cars/" + id + ".json"));
        Vehicle v(cfg);
        if (v.engine_systems().transmission != type) { ++wrong; std::printf("         %s: wrong box\n", id.c_str()); }
    }
    test::check("the ten cars with a dual-clutch / converter counterpart declare it in their car file", wrong == 0);

    // A dual-clutch car cannot miss a shift: not with the Poor clutch assist, not with the assist OFF (there is no clutch pedal).
    int bad = 0;
    for (const auto& [id, type] : declared) {
        if (type != TransmissionType::DualClutchDct) continue;
        const CarConfig cfg = load_car_config(test::data_path("cars/" + id + ".json"));
        for (int mode = 0; mode < 2; ++mode) {
            const Run r = flat_out(cfg, true, mode == 0, AutoClutchQuality::Poor);
            const bool ok = r.missed == 0 && r.gearbox > 0.999 && r.neutral_max < 0.2 && r.clutch > 0.97 && r.kmh > 200.0 && r.t100 > 0;
            if (!ok) {
                ++bad;
                std::printf("         %s (clutch assist %s): %.0f km/h, %d missed, gearbox %.0f %%, clutch %.0f %%, neutral %.2f s\n", id.c_str(),
                            mode == 0 ? "Poor" : "OFF", r.kmh, r.missed, r.gearbox * 100, r.clutch * 100, r.neutral_max);
            }
        }
    }
    test::check("every dual-clutch car pulls cleanly flat out with the clutch assist Poor or OFF: no missed shift, no wear", bad == 0);

    // The same cars with MAN (paddles) and no clutch pedal: shifting by hand works through the whole box.
    bad = 0;
    for (const auto& [id, type] : declared) {
        if (type == TransmissionType::AutomaticTorqueConverter) continue;
        const CarConfig cfg = load_car_config(test::data_path("cars/" + id + ".json"));
        const Run r = flat_out(cfg, false, false, AutoClutchQuality::Poor, true);
        if (r.missed != 0 || r.gearbox < 0.999 || r.gear < 5 || r.kmh < 200.0) {
            ++bad;
            std::printf("         %s paddles: %.0f km/h, gear %d, %d missed\n", id.c_str(), r.kmh, r.gear, r.missed);
        }
    }
    test::check("paddle shifting (MAN) on a dual-clutch car works with no clutch pedal and no missed shift", bad == 0);

    // The torque-converter car: idles on the brake in Drive without stalling, creeps, no phantom clutch wear, and is not slower at the top.
    {
        const CarConfig tc = load_car_config(test::data_path("cars/falcorn_hellhound.json"));
        CarConfig manual = tc;
        manual.drivetrain.transmission = "h_pattern";
        const Run rt = flat_out(tc, true, false, AutoClutchQuality::Poor);
        const Run rm = flat_out(manual, true, true, AutoClutchQuality::Perfect);
        std::printf("         Hellhound torque converter: 0-100 %.2f s, %.0f km/h, clutch %.0f %% | manual: 0-100 %.2f s, %.0f km/h\n", rt.t100, rt.kmh,
                    rt.clutch * 100, rm.t100, rm.kmh);
        test::check("torque converter: no missed shift and no phantom clutch wear", rt.missed == 0 && rt.clutch > 0.99 && rt.neutral_max < 0.2);
        test::check("torque converter: launches harder than a manual clutch launch (stall torque multiplication)", rt.t100 > 0 && rt.t100 < rm.t100 - 0.3);
        test::check("torque converter: top speed within 1.5 % of the manual box (the lock-up holds at full throttle)",
                    rt.kmh > 0.985 * rm.kmh);
        auto s = test::make_sim(tc);
        Controls c(tc);
        c.settings.auto_gearbox = true;
        s->settle(0.5);
        c.set_gear(2);
        RawInput hold;
        hold.device = InputDevice::Wheel;
        hold.brake = 0.6;
        for (int i = 0; i < 4 * 240; ++i) s->step(c.update(hold, s->last, s->dt));
        test::check("torque converter: held on the brake in Drive it idles and does not stall",
                    !s->last.engine_stalled && s->last.engine_rpm > 500.0 && s->last.engine_rpm < 1500.0);
    }

    // A car with a clutch pedal keeps the missed-shift model: the Poor assist still hurts it (that setting is for these cars).
    {
        const CarConfig cfg = test::car();   // vela_gt: manual synchromesh in the game
        CarConfig manual = cfg;
        manual.drivetrain.transmission = "h_pattern";
        const Run poor = flat_out(manual, true, true, AutoClutchQuality::Poor);
        const Run perfect = flat_out(manual, true, true, AutoClutchQuality::Perfect);
        test::check("manual synchromesh: Perfect never misses, Poor still can (but recovers)", perfect.missed == 0 && poor.missed >= 1 && poor.kmh > 200.0);
    }
}
