// Physical clutch friction disc (bite point, Karnopp stick/slip, thermal fade & wear),
// tooth-ratio gearbox, baulk-ring synchromesh cone clutch, missed shifts, gearbox damage,
// and auto-clutch quality levels (Perfect / Normal / Poor).
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include "harness.hpp"
#include "rs/controls.hpp"

using namespace rs;

// ---------------------------------------------------------------- 1. Clutch bite point & progressive travel curve
RS_TEST(clutch_bite_point) {
    CarConfig cfg = test::car();
    const double bite = cfg.drivetrain.clutch.bite_point;            // 0.65
    const double full = cfg.drivetrain.clutch.full_engage_point;     // 0.15

    auto s = test::make_sim(cfg);
    s->settle(0.5);
    const Drivetrain& dt = s->vehicle.drivetrain();

    // Free play (pedal >= bite_point): clamp force and torque capacity must be identically zero.
    const double f_floor = dt.clutch_clamp_force(1.0);
    const double f_free  = dt.clutch_clamp_force(bite + 0.05);
    const double f_at_bite = dt.clutch_clamp_force(bite);
    const double t_free  = dt.clutch_torque_capacity(bite + 0.05, true);

    // Progressive clamp ramp past bite point toward full_engage_point.
    const double t_early = dt.clutch_torque_capacity(bite - 0.10, true);
    const double t_mid   = dt.clutch_torque_capacity(0.5 * (bite + full), true);
    const double t_late  = dt.clutch_torque_capacity(full + 0.05, true);
    const double t_full  = dt.clutch_torque_capacity(full, true);
    const double t_top   = dt.clutch_torque_capacity(0.0, true);
    const double t_kin   = dt.clutch_torque_capacity(0.0, false);

    std::printf("         bite=%.2f full=%.2f | T_cap: free=%.1f early=%.1f mid=%.1f late=%.1f full=%.1f (kin=%.1f) N m\n",
                bite, full, t_free, t_early, t_mid, t_late, t_full, t_kin);

    test::check("free play at floor (pedal=1.0) has zero clamp force", f_floor == 0.0);
    test::check("free play above bite point has zero clamp force & torque", f_free == 0.0 && f_at_bite == 0.0 && t_free == 0.0);
    test::check("torque rises progressively past bite point", t_early > 10.0 && t_mid > t_early * 2.0 && t_late > t_mid);
    const double expected_full = cfg.drivetrain.clutch_max_torque * Drivetrain::clutch_temp_mu_factor(s->vehicle.engine_systems().clutch_temp_c);
    test::check("top free play saturates at full static capacity", std::abs(t_full - t_top) < 1e-6 && std::abs(t_top - expected_full) < 1.0);
    test::check("kinetic capacity < static capacity (mu_k < mu_s)", t_kin > 0.0 && t_kin < t_top);

    // Verify dynamic vehicle response: in free play car does not accelerate; past bite point it pulls forward.
    DriverInput in;
    in.gear = 2;
    in.throttle = 0.5;
    in.clutch = bite + 0.05;   // inside free play
    for (int i = 0; i < 120; ++i) s->step(in);
    const double v_free = test::speed(*s);
    in.clutch = 0.5 * (bite + full);  // mid bite ramp
    for (int i = 0; i < 240; ++i) s->step(in);
    const double v_engaged = test::speed(*s);
    std::printf("         dynamic check: speed in free play=%.3f m/s, mid-bite=%.2f m/s\n", v_free, v_engaged);
    test::check("zero drive in clutch free play", v_free < 0.05);
    test::check("progressive launch past bite point", v_engaged > 4.0);
}

// ---------------------------------------------------------------- 2. Clutch thermal heating, fade & wear under abuse
RS_TEST(clutch_thermal_wear) {
    CarConfig cfg = test::car();
    auto s = test::make_sim(cfg);
    s->settle(0.5);

    const double temp0 = s->vehicle.engine_systems().clutch_temp_c;
    const double health0 = s->vehicle.engine_systems().clutch_health;
    const double cap_cold = s->vehicle.drivetrain().clutch_torque_capacity(0.0, true);

    // Extreme abuse: hold brakes at standstill in 3rd gear while revving and riding the clutch inside
    // the slip zone (partial clamp so engine stays spinning at high RPM against locked wheels without stalling).
    DriverInput abuse;
    abuse.gear = 4;            // 3rd gear
    abuse.brake = 1.0;
    abuse.handbrake = 1.0;
    abuse.throttle = 1.0;
    abuse.clutch = 1.0;        // rev up first for 0.3 s
    for (int i = 0; i < 72; ++i) s->step(abuse);
    abuse.clutch = 0.48;       // slip aggressively inside bite zone (~220 N m @ high RPM -> >100 kW slip power)
    for (int i = 0; i < 240 * 5; ++i) s->step(abuse);   // 5 seconds of full-power clutch burning

    const double temp_hot = s->last.clutch_temp_c;
    const double health_worn = s->last.clutch_health;
    const double cap_hot = s->vehicle.drivetrain().clutch_torque_capacity(0.0, true);

    // Let it cool for 10 seconds with clutch fully disengaged (zero slip power)
    DriverInput cool;
    cool.gear = 1;
    cool.clutch = 1.0;
    cool.throttle = 0.0;
    for (int i = 0; i < 240 * 10; ++i) s->step(cool);
    const double temp_cooled = s->last.clutch_temp_c;

    std::printf("         temp: %.1f -> %.1f C (cooled %.1f C) | health: %.3f -> %.3f | T_cap: %.0f -> %.0f N m\n",
                temp0, temp_hot, temp_cooled, health0, health_worn, cap_cold, cap_hot);

    test::check_range("slip abuse heats clutch disc past fade threshold (> 280 C)", temp_hot, 280.0, 650.0, "C");
    test::check("overheated + worn clutch fades torque capacity significantly", cap_hot < cap_cold * 0.80);
    test::check("extreme slip abuse accumulates measurable lining wear", health_worn < health0 - 0.02);
    test::check("convective cooling reduces disc temperature once slip stops", temp_cooled < temp_hot - 15.0);
}

// ---------------------------------------------------------------- 3. Full lock-up at 1 kHz with zero chatter
RS_TEST(clutch_lockup_no_chatter) {
    CarConfig cfg = test::car();
    auto s = test::make_sim(cfg);
    s->reset({}, 0.0, 25.0, 4);    // rolling at 90 km/h in 3rd gear, shafts matched

    DriverInput in;
    in.gear = 4;
    in.clutch = 0.0;
    in.throttle = 0.8;

    // Warm up 0.2 s into steady pull, then inspect 1 full second (240 ticks = 1200 substeps at 1 kHz)
    for (int i = 0; i < 48; ++i) s->step(in);

    int locked_ticks = 0;
    int sign_flips = 0;
    double prev_t = s->last.clutch_torque_nm;
    double max_step_jump = 0.0;
    double temp_before = s->last.clutch_temp_c;
    double v0 = test::speed(*s);

    for (int i = 0; i < 240; ++i) {
        s->step(in);
        double t = s->last.clutch_torque_nm;
        if (s->last.clutch_locked) ++locked_ticks;
        if (prev_t * t < 0.0) ++sign_flips;
        max_step_jump = std::max(max_step_jump, std::abs(t - prev_t));
        prev_t = t;
    }
    double v1 = test::speed(*s);
    double temp_after = s->last.clutch_temp_c;

    std::printf("         locked %d/240 ticks, sign flips %d, max dT %.2f N m, speed %.1f -> %.1f m/s, dTemp %.2f C\n",
                locked_ticks, sign_flips, max_step_jump, v0, v1, temp_after - temp_before);

    test::check("clutch stays statically locked during full-engagement pull", locked_ticks >= 235);
    test::check("zero torque sign-flip chatter at 1 kHz", sign_flips == 0);
    test::check_range("smooth clutch torque (no high-frequency chatter spikes)", max_step_jump, 0.0, 15.0, "N m");
    test::check("cleanly accelerates the car under locked clutch", v1 > v0 + 3.0);
    test::check("no phantom slip heating while statically locked", temp_after <= temp_before + 0.5);

    // Regression: Stage-3 turbo pull from rest through all gears on a tight-margin car (harrier_gt: 800 Nm peak)
    // must NEVER enter a clutch thermal-slip death spiral ("gears getting shorter" / failing to reach top speed).
    {
        CarConfig hcfg = load_car_config(test::data_path("cars/harrier_gt.json"));
        auto hs = test::make_sim(hcfg);
        hs->vehicle.engine_systems().turbo_stage = 3;
        hs->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
        hs->vehicle.assists().tc = true;
        hs->settle(0.5);
        Controls hc(hcfg);
        hc.settings.auto_gearbox = true;
        hc.settings.auto_clutch = true;
        RawInput hraw;
        hraw.device = InputDevice::Wheel;
        hraw.throttle = 1.0;
        double vmax_kmh = 0.0;
        for (int i = 0; i < 240 * 35; ++i) {
            hs->step(hc.update(hraw, hs->last, hs->dt));
            vmax_kmh = std::max(vmax_kmh, hs->last.speed * 3.6);
        }
        std::printf("         harrier_gt Stage-3 turbo 35 s pull: vmax %.1f km/h, clutch temp %.1f C, health %.3f, locked %d\n",
                    vmax_kmh, hs->last.clutch_temp_c, hs->last.clutch_health, hs->last.clutch_locked ? 1 : 0);
        test::check_range("Stage-3 turbo car reaches high speed cleanly (no slipping clutch)", vmax_kmh, 290.0, 460.0, "km/h");
        test::check_range("Stage-3 turbo race pull preserves clutch health", hs->last.clutch_health, 0.90, 1.0, "-");
        test::check_range("Stage-3 turbo race pull keeps clutch below fade temp", hs->last.clutch_temp_c, 20.0, 220.0, "C");
    }
}

// ---------------------------------------------------------------- 4. Gear tooth ratios, missed shift & gearbox damage
RS_TEST(gearbox_missed_shift) {
    CarConfig cfg = test::car();
    // Verify Vela GT tooth counts produce exact physical ratios driven/drive.
    test::check("vela_gt loads physical gear_teeth pairs", cfg.drivetrain.gear_teeth.size() == 8);
    test::check_range("1st gear ratio from 51/15 teeth", cfg.drivetrain.gear_ratios[2], 3.399, 3.401, "-");
    test::check_range("2nd gear ratio from 46/20 teeth", cfg.drivetrain.gear_ratios[3], 2.299, 2.301, "-");
    test::check_range("3rd gear ratio from 41/24 teeth", cfg.drivetrain.gear_ratios[4], 1.707, 1.709, "-");

    // Verify kestrel_gt tooth counts and fallback when gear_teeth is omitted in JSON.
    CarConfig kcfg = load_car_config(test::data_path("cars/kestrel_gt.json"));
    test::check("kestrel_gt loads physical gear_teeth with 1st == 3.3",
                kcfg.drivetrain.gear_teeth.size() == 8 && std::abs(kcfg.drivetrain.gear_ratios[2] - 3.3) < 1e-6);
    {
        std::ifstream kf(test::data_path("cars/kestrel_gt.json"));
        std::stringstream kss;
        kss << kf.rdbuf();
        std::string ktxt = kss.str();
        const auto pos = ktxt.find("\"gear_teeth\"");
        if (pos != std::string::npos) ktxt.replace(pos, 12, "\"_no_teeth_\"");
        CarConfig kfallback = parse_car_config(ktxt);
        test::check("config without gear_teeth keeps explicit gear_ratios",
                    kfallback.drivetrain.gear_teeth.empty() && kfallback.drivetrain.gear_ratios[2] == 3.3);
    }

    // A) Fast clutchless upshift on H-pattern synchromesh -> misses gear (stays in Neutral), triggers event & damage.
    auto s = test::make_sim(cfg);
    s->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
    s->reset({}, 0.0, 22.0, 2);   // ~79 km/h near redline in 1st gear

    DriverInput raw_up;
    raw_up.gear = 3;              // try shifting 1st -> 2nd without clutch
    raw_up.clutch = 0.0;
    raw_up.throttle = 0.9;
    raw_up.auto_clutch = false;

    bool saw_event = false;
    bool saw_grind = false;
    for (int i = 0; i < 48; ++i) {   // 0.20 s
        s->step(raw_up);
        saw_event |= s->last.missed_shift_event;
        saw_grind |= s->last.gear_grind;
    }

    std::printf("         clutchless 1->2: gear=%d (1=N), missed=%d, event=%d, grind=%d, gb_health=%.3f\n",
                s->last.gear, s->last.missed_shifts, saw_event, saw_grind, s->last.gearbox_health);

    test::check("clutchless upshift drops & stays in Neutral (gear == 1)", s->last.gear == 1);
    test::check("missed-shift event and counter triggered", saw_event && s->last.missed_shifts >= 1);
    test::check("gear grind active on missed shift", saw_grind);
    test::check("missed shift accumulates gearbox damage", s->last.gearbox_health < 0.99);

    // B) Shifting faster than the synchro can match (dropping clutch after 12 ms while sync needs ~65 ms) -> missed gear!
    auto s2 = test::make_sim(cfg);
    s2->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
    s2->reset({}, 0.0, 22.0, 2);
    DriverInput fast_shift;
    fast_shift.gear = 3;
    fast_shift.throttle = 0.0;
    fast_shift.clutch = 1.0;      // clutch down for only 12 ms (3 ticks at 240 Hz)
    for (int i = 0; i < 3; ++i) s2->step(fast_shift);
    fast_shift.clutch = 0.0;      // dump clutch too early before synchro finishes!
    fast_shift.throttle = 0.8;
    for (int i = 0; i < 24; ++i) s2->step(fast_shift);
    std::printf("         too-fast 12 ms clutched 1->2: gear=%d, missed=%d, gb_health=%.3f\n",
                s2->last.gear, s2->last.missed_shifts, s2->last.gearbox_health);
    test::check("releasing clutch faster than synchro time misses the gear",
                s2->last.gear == 1 && s2->last.missed_shifts >= 1 && s2->last.gearbox_health < 1.0);

    // C) Worn synchros synchronize slower & heavily damaged teeth pop out under peak torque.
    auto s_fresh = test::make_sim(cfg), s_worn = test::make_sim(cfg);
    s_fresh->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
    s_worn->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
    s_fresh->reset({}, 0.0, 22.0, 2);
    s_worn->reset({}, 0.0, 22.0, 2);
    s_worn->vehicle.engine_systems().gearbox_health = 0.25;

    auto measure_sync = [](Simulation& sim) {
        DriverInput d;
        d.gear = 3;
        d.clutch = 1.0;
        d.throttle = 0.0;
        double t = 0.0;
        for (int i = 0; i < 240; ++i) {
            sim.step(d);
            t += sim.dt;
            if (sim.last.gear == 3) return t;
        }
        return -1.0;
    };
    const double t_fresh = measure_sync(*s_fresh);
    const double t_worn = measure_sync(*s_worn);
    std::printf("         synchro time 1->2: fresh=%.3f s, worn(25%%)=%.3f s\n", t_fresh, t_worn);
    test::check("worn synchro synchronizes noticeably slower than healthy", t_fresh > 0.02 && t_worn > t_fresh * 1.6);

    // Heavily damaged gearbox (health=0.15) under sustained peak torque pops out of gear.
    auto s_dmg = test::make_sim(cfg);
    s_dmg->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
    s_dmg->reset({}, 0.0, 20.0, 3);
    s_dmg->vehicle.engine_systems().gearbox_health = 0.15;
    DriverInput wot;
    wot.gear = 3;
    wot.clutch = 0.0;
    wot.throttle = 1.0;
    bool popped = false;
    for (int i = 0; i < 240; ++i) {
        s_dmg->step(wot);
        if (s_dmg->last.gear == 1) { popped = true; break; }
    }
    test::check("heavily damaged gearbox (15% health) pops out of gear under peak torque", popped);
}

// ---------------------------------------------------------------- 5. Proper clutched shift + DogBox + DCT
RS_TEST(gearbox_clutched_shift) {
    CarConfig cfg = test::car();
    auto s = test::make_sim(cfg);
    s->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
    s->reset({}, 0.0, 22.0, 2);   // rolling in 1st gear

    // Proper clutched upshift: depress clutch, select 2nd, hold past synchro time (~0.12 s), release clutch.
    DriverInput in;
    in.gear = 3;
    in.clutch = 1.0;
    in.throttle = 0.0;
    double engage_t = -1.0;
    for (int i = 0; i < 36; ++i) {   // 0.15 s
        s->step(in);
        if (engage_t < 0.0 && s->last.gear == 3) engage_t = (i + 1) * s->dt;
    }
    in.clutch = 0.0;
    in.throttle = 0.9;
    for (int i = 0; i < 48; ++i) s->step(in);

    std::printf("         proper clutched 1->2: engaged in %.3f s, gear=%d, missed=%d, gb_health=%.3f\n",
                engage_t, s->last.gear, s->last.missed_shifts, s->last.gearbox_health);

    test::check_range("synchro engages within realistic cone-clutch time", engage_t, 0.025, 0.14, "s");
    test::check("gear stays engaged cleanly after clutch release", s->last.gear == 3);
    test::check("zero missed shifts and zero gearbox damage", s->last.missed_shifts == 0 && s->last.gearbox_health == 1.0);

    // Dog-box flat-foot upshift engages cleanly via ignition shift cut; DCT stays clean and fast.
    auto s_dog = test::make_sim(cfg);
    s_dog->vehicle.engine_systems().transmission = TransmissionType::SequentialDogBox;
    s_dog->vehicle.engine_systems().dog_box_flat_shift_cut = true;
    s_dog->reset({}, 0.0, 22.0, 2);
    DriverInput dog_up;
    dog_up.gear = 3;
    dog_up.throttle = 1.0;
    dog_up.clutch = 0.0;
    s_dog->step(dog_up);
    test::check("dog-box flat-foot upshift engages cleanly during shift cut",
                s_dog->last.gear == 3 && s_dog->last.shift_cut_active && s_dog->last.missed_shifts == 0);

    auto s_dct = test::make_sim(cfg);
    s_dct->vehicle.engine_systems().transmission = TransmissionType::DualClutchDct;
    s_dct->reset({}, 0.0, 22.0, 2);
    s_dct->step(dog_up);
    test::check("DCT upshift engages cleanly and fast with zero misses",
                s_dct->last.gear == 3 && s_dct->last.missed_shifts == 0 && s_dct->last.gearbox_health == 1.0);
}

// ---------------------------------------------------------------- 6. Auto-clutch quality (Perfect / Normal / Poor)
RS_TEST(auto_clutch_quality) {
    CarConfig cfg = test::car();

    // A) Perfect auto-clutch on H-pattern synchromesh: full 1->2->3->4->5->6->5->4->3->2 sequence -> ZERO misses!
    {
        auto s = test::make_sim(cfg);
        s->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
        s->vehicle.assists().tc = true;
        s->settle(0.5);

        DriverInput in;
        in.auto_clutch = true;
        in.auto_clutch_quality = AutoClutchQuality::Perfect;
        in.gear = 2;
        in.throttle = 1.0;

        int upshifts = 0;
        // Accelerate through all 6 gears (indices 2..7)
        while (s->time < 22.0 && in.gear < 7) {
            s->step(in);
            if (s->last.gear == in.gear && s->last.engine_rpm > 6800.0 && in.gear < 7) {
                ++in.gear;
                ++upshifts;
            }
        }
        // Hold 6th briefly so it finishes engaging
        for (int i = 0; i < 60; ++i) s->step(in);
        const bool reached_top = (s->last.gear == 7);

        // Now brake and downshift sequentially 6 -> 5 -> 4 -> 3 -> 2
        in.throttle = 0.0;
        in.brake = 0.7;
        s->vehicle.assists().abs = true;
        int downshifts = 0;
        while (s->time < 32.0 && in.gear > 2) {
            s->step(in);
            if (s->last.gear == in.gear && s->last.engine_rpm < 3800.0 && in.gear > 2) {
                --in.gear;
                ++downshifts;
            }
        }
        for (int i = 0; i < 60; ++i) s->step(in);

        std::printf("         auto-clutch Perfect: %d upshifts, %d downshifts, reached 6th=%d, missed=%d, gb_health=%.3f\n",
                    upshifts, downshifts, reached_top, s->last.missed_shifts, s->last.gearbox_health);
        test::check("Perfect auto-clutch reaches top gear and downshifts back to 1st",
                    upshifts == 5 && reached_top && downshifts == 5 && s->last.gear == 2);
        test::check("Perfect auto-clutch NEVER misses a shift or damages gearbox",
                    s->last.missed_shifts == 0 && s->last.gearbox_health == 1.0);
    }

    // B) Poor auto-clutch on H-pattern synchromesh: misses shifts and damages gearbox under brisk upshifts!
    {
        auto s = test::make_sim(cfg);
        s->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
        s->reset({}, 0.0, 22.0, 2);

        DriverInput in;
        in.auto_clutch = true;
        in.auto_clutch_quality = AutoClutchQuality::Poor;
        in.gear = 2;
        in.throttle = 1.0;
        for (int i = 0; i < 12; ++i) s->step(in);

        // Command upshift 1st -> 2nd under WOT with Poor auto-clutch
        in.gear = 3;
        for (int i = 0; i < 60; ++i) s->step(in);

        std::printf("         auto-clutch Poor (1->2 WOT): missed=%d, gb_health=%.3f\n",
                    s->last.missed_shifts, s->last.gearbox_health);
        test::check("Poor auto-clutch misses shift and damages transmission",
                    s->last.missed_shifts >= 1 && s->last.gearbox_health < 1.0);
    }

    // C) Normal auto-clutch: clean on paced shift, but slamming rapid back-to-back shifts can grind/miss!
    {
        auto s_paced = test::make_sim(cfg);
        s_paced->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
        s_paced->reset({}, 0.0, 22.0, 2);
        DriverInput in;
        in.auto_clutch = true;
        in.auto_clutch_quality = AutoClutchQuality::Normal;
        in.gear = 2;
        in.throttle = 0.8;
        for (int i = 0; i < 120; ++i) s_paced->step(in); // 0.5 s paced driving
        in.gear = 3;
        for (int i = 0; i < 60; ++i) s_paced->step(in);
        const int paced_misses = s_paced->last.missed_shifts;
        const int paced_gear = s_paced->last.gear;

        // Slam rapid 1st -> 2nd -> 3rd within 0.15 s!
        auto s_slam = test::make_sim(cfg);
        s_slam->vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
        s_slam->reset({}, 0.0, 22.0, 2);
        DriverInput sl;
        sl.auto_clutch = true;
        sl.auto_clutch_quality = AutoClutchQuality::Normal;
        sl.gear = 2;
        sl.throttle = 1.0;
        for (int i = 0; i < 24; ++i) s_slam->step(sl);
        sl.gear = 3;
        for (int i = 0; i < 24; ++i) s_slam->step(sl);  // 0.10 s later, slam straight to 3rd!
        sl.gear = 4;
        for (int i = 0; i < 60; ++i) s_slam->step(sl);

        std::printf("         auto-clutch Normal: paced gear=%d misses=%d | slammed misses=%d gb_health=%.3f\n",
                    paced_gear, paced_misses, s_slam->last.missed_shifts, s_slam->last.gearbox_health);
        test::check("Normal auto-clutch shifts cleanly when paced", paced_gear == 3 && paced_misses == 0);
        test::check("Normal auto-clutch can miss/grind when slamming shifts rapidly",
                    s_slam->last.missed_shifts >= 1 && s_slam->last.gearbox_health < 1.0);
    }
}
