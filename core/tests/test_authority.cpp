// Unit tests for Server-Authoritative Physics Verifier, Anti-Cheat Tamper Detector,
// and Unreal Engine 5 Client-Prediction Reconciliation (rs::AuthorityServerSim).
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <vector>
#include "harness.hpp"
#include "rs/authority.hpp"

static bool near_val(double a, double b, double eps = 1e-9) { return std::fabs(a - b) <= eps; }

RS_TEST(authority) {
    using namespace rs;

    CarConfig cfg = test::car();

    // 1. Honest client replay: 120 ticks (0.5 s at 240 Hz) of full throttle passes verify_ticks
    //    with valid == true, position_error_m == 0, and matching 64-bit state_hash.
    {
        AuthorityServerSim server(cfg);
        server.reset({0, 0, 0}, 0.0, 20.0, 3);

        Simulation client_sim(cfg, std::make_shared<PlaneGround>());
        client_sim.reset({0, 0, 0}, 0.0, 20.0, 3);

        std::vector<TickInputFrame> frames;
        frames.reserve(120);
        for (std::uint32_t tick = 1; tick <= 120; ++tick) {
            DriverInput in{};
            in.throttle = 1.0;
            in.gear = 3;
            in.auto_clutch = true;
            client_sim.step(in);
            frames.push_back({tick, in});
        }

        ClientStateClaim claim{};
        claim.tick = 120;
        claim.chassis = client_sim.body.state;
        claim.engine_rpm = client_sim.vehicle.engine_rpm();
        claim.gear = client_sim.last.gear;
        claim.state_hash = hash_chassis_state(claim.chassis, claim.engine_rpm, claim.gear);

        VerificationResult res = server.verify_ticks(frames, claim);
        test::check("honest 120-tick full-throttle replay accepted",
                    res.valid && res.violation == CheatViolation::None);
        test::check("honest replay zero position error", near_val(res.position_error_m, 0.0, 1e-12));
        test::check("honest replay matching 64-bit FNV-1a state_hash",
                    res.authoritative_hash == claim.state_hash && res.authoritative_hash != 0);
    }

    // 2. 5,000 hp / speed hack detection: a client claiming higher speed/position after 120 ticks
    //    is rejected with CheatViolation::SpeedOrPowerTamper.
    {
        AuthorityServerSim server(cfg);
        server.reset({0, 0, 0}, 0.0, 20.0, 3);

        CarConfig hacked_cfg = cfg;
        for (auto& pt : hacked_cfg.engine.torque_curve) {
            pt[1] *= 10.0;  // 5,000 hp engine power cheat
        }
        hacked_cfg.tire_rear.mu_x *= 3.0;
        hacked_cfg.tire_front.mu_x *= 3.0;

        Simulation cheater_sim(hacked_cfg, std::make_shared<PlaneGround>());
        cheater_sim.reset({0, 0, 0}, 0.0, 20.0, 3);

        std::vector<TickInputFrame> frames;
        frames.reserve(120);
        for (std::uint32_t tick = 1; tick <= 120; ++tick) {
            DriverInput in{};
            in.throttle = 1.0;
            in.gear = 3;
            in.auto_clutch = true;
            cheater_sim.step(in);
            frames.push_back({tick, in});
        }

        ClientStateClaim claim{};
        claim.tick = 120;
        claim.chassis = cheater_sim.body.state;
        claim.engine_rpm = cheater_sim.vehicle.engine_rpm();
        claim.gear = cheater_sim.last.gear;
        claim.state_hash = hash_chassis_state(claim.chassis, claim.engine_rpm, claim.gear);

        VerificationResult res = server.verify_ticks(frames, claim);
        test::check("5,000 hp speed/power tamper rejected",
                    !res.valid && res.violation == CheatViolation::SpeedOrPowerTamper && res.failed_tick == 120);
    }

    // 3. Input injection detection: a client sending throttle = 5.0 or NaN is rejected on that
    //    exact tick with CheatViolation::InvalidInputRange.
    {
        AuthorityServerSim server(cfg);
        server.reset({0, 0, 0}, 0.0, 15.0, 2);

        std::vector<TickInputFrame> frames;
        for (std::uint32_t tick = 1; tick <= 10; ++tick) {
            DriverInput in{};
            in.throttle = (tick == 7) ? 5.0 : 0.8;
            in.gear = 2;
            frames.push_back({tick, in});
        }

        ClientStateClaim claim{};
        claim.tick = 10;
        VerificationResult res_overflow = server.verify_ticks(frames, claim);
        test::check("throttle = 5.0 packet injection rejected on exact tick 7",
                    !res_overflow.valid && res_overflow.violation == CheatViolation::InvalidInputRange &&
                        res_overflow.failed_tick == 7);

        frames[6].input.throttle = std::numeric_limits<double>::quiet_NaN();
        VerificationResult res_nan = server.verify_ticks(frames, claim);
        test::check("NaN throttle packet injection rejected on exact tick 7",
                    !res_nan.valid && res_nan.violation == CheatViolation::InvalidInputRange &&
                        res_nan.failed_tick == 7);
    }

    // 4. Spec Class config hash anti-cheat: modifying cfg.tire_front.mu_y or cfg.engine.torque_curve
    //    changes hash_car_config(cfg).
    {
        const std::uint64_t base_hash = hash_car_config(cfg);

        CarConfig grip_mod = cfg;
        grip_mod.tire_front.mu_y += 0.15;
        const std::uint64_t grip_hash = hash_car_config(grip_mod);

        CarConfig power_mod = cfg;
        power_mod.engine.torque_curve[0][1] += 25.0;
        const std::uint64_t power_hash = hash_car_config(power_mod);

        AuthorityServerSim server(cfg);
        VerificationResult ok_cfg = server.verify_config_hash(base_hash);
        VerificationResult bad_cfg = server.verify_config_hash(grip_hash);

        test::check("modifying tire_front.mu_y changes Spec Class config hash",
                    grip_hash != base_hash && !bad_cfg.valid &&
                        bad_cfg.violation == CheatViolation::SpecConfigMismatch && ok_cfg.valid);
        test::check("modifying engine.torque_curve changes Spec Class config hash",
                    power_hash != base_hash && power_hash != grip_hash);
    }

    // 5. UE5 reconciliation: a 0.40 m drift produces a 40.0 cm pos_correction_cm with needs_snap == false,
    //    while a 5.0 m desync sets needs_snap == true.
    {
        ChassisState client_s{};
        client_s.position = {10.0, 0.0, 0.47};
        client_s.velocity = {25.0, 0.0, 0.0};

        ChassisState auth_small = client_s;
        auth_small.position.x += 0.40;  // +0.40 m forward drift -> +40.0 cm in UE5

        Ue5ReconciliationDelta delta_small =
            AuthorityServerSim::compute_ue5_reconciliation(client_s, auth_small, 2.5);
        test::check("0.40 m drift produces 40.0 cm UE5 correction without snap",
                    !delta_small.needs_snap && near_val(delta_small.pos_correction_cm.x, 40.0) &&
                        near_val(delta_small.pos_correction_cm.y, 0.0) &&
                        near_val(delta_small.pos_correction_cm.z, 0.0) &&
                        delta_small.blend_alpha > 0.0 && delta_small.blend_alpha < 1.0);

        ChassisState auth_large = client_s;
        auth_large.position.x += 5.0;  // +5.0 m desync (> 2.5 m threshold)

        Ue5ReconciliationDelta delta_large =
            AuthorityServerSim::compute_ue5_reconciliation(client_s, auth_large, 2.5);
        test::check("5.0 m desync triggers UE5 hard snap (500.0 cm)",
                    delta_large.needs_snap && near_val(delta_large.pos_correction_cm.x, 500.0) &&
                        near_val(delta_large.blend_alpha, 1.0));
    }

    // 6. AntiBotAnalyzer: realistic human cornering trace (smooth sinusoidal steering + natural slip
    //    variation 0.08..0.17 rad) is not flagged as a bot and has bot_confidence_0_to_1 < 0.35.
    {
        AntiBotAnalyzer human_analyzer;
        constexpr int kFrames = 240;  // 1.0 s at 240 Hz
        for (int i = 0; i < kFrames; ++i) {
            const double t = static_cast<double>(i) / 240.0;
            BotTelemetryFrame f{};
            f.time_s = t;
            f.steer = 0.45 * std::sin(2.0 * 3.14159265358979323846 * 0.8 * t);
            f.throttle = 0.75;
            f.brake = 0.0;
            // Natural slip variation across 0.08..0.17 rad
            f.front_slip_angle_rad = 0.125 + 0.045 * std::sin(2.0 * 3.14159265358979323846 * 1.3 * t);
            f.optimal_slip_angle_rad = 0.14;
            f.yaw_accel_rads2 = 1.2 * std::cos(2.0 * 3.14159265358979323846 * 0.8 * t);
            human_analyzer.record_frame(f);
        }

        BotAnalysisReport human_rep = human_analyzer.analyze();
        test::check("realistic human cornering trace not flagged as bot",
                    human_analyzer.frame_count() == 240 && !human_rep.flagged_as_bot &&
                        human_rep.violation == CheatViolation::None &&
                        human_rep.bot_confidence_0_to_1 < 0.35);
    }

    // 7. AntiBotAnalyzer: TAS / Autosteer / Macro bot trace (front slip locked at 0.1400 +- 0.0005 rad,
    //    240 Hz sawtooth steering micro-corrections +-0.06, and instant 0-ms counter-steer) is flagged
    //    with CheatViolation::AutosteerOrMacroBot and bot_confidence_0_to_1 > 0.75.
    {
        AntiBotAnalyzer bot_analyzer;
        constexpr int kFrames = 240;  // 1.0 s at 240 Hz
        double steer_val = 0.35;
        for (int i = 0; i < kFrames; ++i) {
            const double t = static_cast<double>(i) / 240.0;
            const double sign = (i % 2 == 0) ? 1.0 : -1.0;
            steer_val += sign * 0.06;  // 240 Hz sawtooth micro-corrections (+0.06, -0.06)

            BotTelemetryFrame f{};
            f.time_s = t;
            f.steer = steer_val;
            f.throttle = 1.0;
            f.brake = 0.0;
            f.front_slip_angle_rad = 0.1400 + sign * 0.0005;  // Locked at peak Pacejka slip angle
            f.optimal_slip_angle_rad = 0.14;
            // Sudden yaw acceleration spike opposed on the exact same tick (0 ms lag) by counter-steer delta
            f.yaw_accel_rads2 = -sign * 4.5;
            bot_analyzer.record_frame(f);
        }

        BotAnalysisReport bot_rep = bot_analyzer.analyze();
        test::check("TAS / Autosteer / Macro bot trace flagged with AutosteerOrMacroBot",
                    bot_rep.flagged_as_bot &&
                        bot_rep.violation == CheatViolation::AutosteerOrMacroBot &&
                        bot_rep.bot_confidence_0_to_1 > 0.75 &&
                        bot_rep.slip_lock_precision_score > 0.85 &&
                        bot_rep.sawtooth_macro_score > 0.85 &&
                        bot_rep.zero_latency_reflex_score > 0.85);
    }
}
