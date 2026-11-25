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
    // Cars declaring dual-clutch, torque converter, sequential race dog-box, or single-clutch automated manual (AMT)
    const std::map<std::string, TransmissionType> declared = {
        {"falcorn_9r", TransmissionType::DualClutchDct},   {"falcorn_9r_rs", TransmissionType::DualClutchDct},
        {"aether_solis", TransmissionType::DualClutchDct}, {"aether_borealis", TransmissionType::DualClutchDct},
        {"valenza_corsa", TransmissionType::DualClutchDct}, {"valenza_fiamma", TransmissionType::DualClutchDct},
        {"valenza_sp3", TransmissionType::DualClutchDct},  {"kronos_fulmine", TransmissionType::DualClutchDct},
        {"tornado_gt", TransmissionType::DualClutchDct},   {"falcorn_hellhound", TransmissionType::AutomaticTorqueConverter},
        {"kestrel_gt", TransmissionType::SequentialDogBox}, {"tornado_gt3", TransmissionType::SequentialDogBox},
        {"kronos_taurus", TransmissionType::AutomatedManual}, {"strix_gt7", TransmissionType::AutomatedManual},
    };
    int wrong = 0;
    for (const auto& [id, type] : declared) {
        const CarConfig cfg = load_car_config(test::data_path("cars/" + id + ".json"));
        Vehicle v(cfg);
        if (v.engine_systems().transmission != type) { ++wrong; std::printf("         %s: wrong box\n", id.c_str()); }
    }
    test::check("all 14 declared DCT / converter / dog-box / AMT cars load their exact gearbox type", wrong == 0);

    // Every self-shifting/pneumatic box (DCT, SequentialDogBox, AutomatedManual) cannot miss a shift with Poor or OFF clutch assist.
    int bad = 0;
    for (const auto& [id, type] : declared) {
        if (type == TransmissionType::AutomaticTorqueConverter) continue;
        const CarConfig cfg = load_car_config(test::data_path("cars/" + id + ".json"));
        for (int mode = 0; mode < 2; ++mode) {
            const Run r = flat_out(cfg, true, mode == 0, AutoClutchQuality::Poor);
            const bool ok = r.missed == 0 && r.gearbox > 0.999 && r.neutral_max < 0.2 && r.clutch > 0.96 && r.kmh > 200.0 && r.t100 > 0;
            if (!ok) {
                ++bad;
                std::printf("         %s (clutch assist %s): %.0f km/h, %d missed, gearbox %.0f %%, clutch %.0f %%, neutral %.2f s\n", id.c_str(),
                            mode == 0 ? "Poor" : "OFF", r.kmh, r.missed, r.gearbox * 100, r.clutch * 100, r.neutral_max);
            }
        }
    }
    test::check("every DCT / dog-box / AMT car pulls cleanly flat out with clutch assist Poor or OFF: no missed shift, no wear", bad == 0);

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
    test::check("paddle shifting (MAN) on DCT / dog-box / AMT works with no clutch pedal and no missed shift", bad == 0);

    // Sequential race dog-box (Kestrel GT & Tornado GT3): flat-foot ignition-cut upshift + pneumatic auto-blip downshift + mechanical dog clunk!
    for (const char* id : {"kestrel_gt", "tornado_gt3"}) {
        const CarConfig cfg = load_car_config(test::data_path("cars/" + std::string(id) + ".json"));
        auto s = test::make_sim(cfg);
        test::enable_game_models(s->vehicle);
        s->vehicle.assists().abs = true;
        s->reset({}, 0.0, 38.0, 4);   // ~137 km/h in 3rd gear
        DriverInput up;
        up.gear = 5;                  // flat-foot upshift 3rd -> 4th with NO clutch pedal
        up.throttle = 1.0;
        up.clutch = 0.0;
        up.auto_clutch = false;
        bool saw_cut = false;
        double max_clunk = 0.0;
        for (int i = 0; i < 36; ++i) {
            s->step(up);
            saw_cut |= s->last.shift_cut_active;
            max_clunk = std::max(max_clunk, s->last.driveline_clunk_nm);
        }
        const bool up_ok = (s->last.gear == 5 && saw_cut && max_clunk >= 120.0 && s->last.missed_shifts == 0);

        // Now brake with ABS and command a clutchless paddle downshift 4th -> 3rd: pneumatic auto-blip must fire and rev-match cleanly!
        DriverInput down;
        down.gear = 4;
        down.throttle = 0.0;
        down.brake = 0.45;
        down.clutch = 0.0;
        down.auto_clutch = false;
        const double rpm_before = s->last.engine_rpm;
        const double v_before = std::max(s->last.speed, 1.0);
        bool saw_blip = false;
        double max_blip_thr = 0.0;
        for (int i = 0; i < 48; ++i) {
            s->step(down);
            saw_blip |= s->last.auto_blip_active;
            max_blip_thr = std::max(max_blip_thr, s->last.throttle_applied);
        }
        const double old_gear_rpm_now = rpm_before * (s->last.speed / v_before);
        const bool down_ok = (s->last.gear == 4 && saw_blip && max_blip_thr > 0.25 && s->last.engine_rpm > old_gear_rpm_now + 350.0
                              && s->last.missed_shifts == 0 && s->last.gearbox_health > 0.999);
        std::printf("         dog-box %-12s up(cut=%d clunk=%.0fNm) | down(blip=%d thr=%.2f rpm %.0f vs old-gear %.0f missed=%d)\n",
                    id, saw_cut, max_clunk, saw_blip, max_blip_thr, s->last.engine_rpm, old_gear_rpm_now, s->last.missed_shifts);
        test::check("sequential dog-box: flat-foot upshift cut + mechanical dog clunk + auto-blip downshift", up_ok && down_ok);
    }

    // Single-clutch automated manual (Kronos Taurus V12 & Strix GT7): distinct upshift torque interrupt (~65 ms) + heel-toe auto-blip downshift!
    for (const char* id : {"kronos_taurus", "strix_gt7"}) {
        const CarConfig cfg = load_car_config(test::data_path("cars/" + std::string(id) + ".json"));
        auto s = test::make_sim(cfg);
        test::enable_game_models(s->vehicle);
        s->vehicle.assists().abs = true;
        s->reset({}, 0.0, 38.0, 4);   // ~137 km/h in 3rd gear
        DriverInput up;
        up.gear = 5;                  // upshift 3rd -> 4th with NO clutch pedal
        up.throttle = 1.0;
        up.clutch = 0.0;
        up.auto_clutch = false;
        bool saw_cut = false;
        double interrupt_s = 0.0, max_clunk = 0.0;
        for (int i = 0; i < 60; ++i) {
            s->step(up);
            saw_cut |= s->last.shift_cut_active;
            if (s->last.throttle_applied < 0.1) interrupt_s += s->dt;
            max_clunk = std::max(max_clunk, s->last.driveline_clunk_nm);
        }
        const bool up_ok = (s->last.gear == 5 && saw_cut && interrupt_s >= 0.045 && interrupt_s <= 0.13
                            && max_clunk >= 100.0 && s->last.missed_shifts == 0);

        // Downshift 4th -> 3rd under braking: electro-hydraulic clutch opens + heel-toe throttle auto-blip rev-matches cleanly!
        DriverInput down;
        down.gear = 4;
        down.throttle = 0.0;
        down.brake = 0.45;
        down.clutch = 0.0;
        down.auto_clutch = false;
        const double rpm_before = s->last.engine_rpm;
        const double v_before = std::max(s->last.speed, 1.0);
        bool saw_blip = false;
        double max_blip_thr = 0.0;
        for (int i = 0; i < 60; ++i) {
            s->step(down);
            saw_blip |= s->last.auto_blip_active;
            max_blip_thr = std::max(max_blip_thr, s->last.throttle_applied);
        }
        const double old_gear_rpm_now = rpm_before * (s->last.speed / v_before);
        const bool down_ok = (s->last.gear == 4 && saw_blip && max_blip_thr > 0.25 && s->last.engine_rpm > old_gear_rpm_now + 350.0
                              && s->last.missed_shifts == 0 && s->last.gearbox_health > 0.999);
        std::printf("         AMT     %-12s up(cut=%d gap=%.3fs clunk=%.0fNm) | down(blip=%d thr=%.2f rpm %.0f vs old-gear %.0f)\n",
                    id, saw_cut, interrupt_s, max_clunk, saw_blip, max_blip_thr, s->last.engine_rpm, old_gear_rpm_now);
        test::check("single-clutch AMT: crisp hydraulic torque-interrupt upshift + heel-toe auto-blip downshift", up_ok && down_ok);
    }

    // DCT vs AMT vs Manual shift speed hierarchy: DCT has shorter torque interrupt than single-clutch AMT, which is faster than H-pattern manual!
    {
        const CarConfig base = load_car_config(test::data_path("cars/kronos_taurus.json"));
        auto measure_gap = [&](const std::string& tx_name) {
            CarConfig c = base;
            c.drivetrain.transmission = tx_name;
            auto s = test::make_sim(c);
            test::enable_game_models(s->vehicle);
            s->reset({}, 0.0, 38.0, 4);
            DriverInput up;
            up.gear = 5;
            up.throttle = 1.0;
            up.auto_clutch = true;
            up.auto_clutch_quality = AutoClutchQuality::Perfect;
            double gap = 0.0;
            for (int i = 0; i < 80; ++i) {
                s->step(up);
                if (s->last.throttle_applied < 0.1 || s->last.shift_cut_active) gap += s->dt;
            }
            return gap;
        };
        const double gap_dct = measure_gap("dct");
        const double gap_amt = measure_gap("amt");
        const double gap_man = measure_gap("h_pattern");
        std::printf("         upshift torque-interrupt hierarchy: DCT %.3f s < AMT %.3f s < H-pattern %.3f s\n",
                    gap_dct, gap_amt, gap_man);
        test::check("upshift torque gap matches real life: DCT < single-clutch AMT < manual H-pattern",
                    gap_dct < gap_amt - 0.025 && gap_amt < gap_man - 0.025);
    }

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
