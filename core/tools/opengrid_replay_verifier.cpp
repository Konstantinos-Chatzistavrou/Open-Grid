// Apache-2.0 — Headless C++20 Deterministic Replay & Anti-Bot Anti-Cheat Verifier CLI.
// Runs for $0/month on GitHub Actions to verify top-3 race replays and official hotlaps using rs_core:
//   - Replays tick-by-tick driver inputs through rs::AuthorityServerSim at 400 Hz
//   - Flags grip/power hacks, teleports, config hash mismatches, and state hash tampering
//   - Runs rs::AntiBotAnalyzer to detect steering-lock bots, 240 Hz sawtooth macros & inhuman reflexes
// Usage: opengrid_replay_verifier <car_json_path> <replay_json_path>
#include "rs/authority.hpp"
#include "rs/config.hpp"
#include <nlohmann/json.hpp>

#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {
const char* violation_name(rs::CheatViolation v) {
    switch (v) {
        case rs::CheatViolation::None: return "verified_clean";
        case rs::CheatViolation::InvalidInputRange: return "invalid_input_range";
        case rs::CheatViolation::SpeedOrPowerTamper: return "speed_or_power_tamper";
        case rs::CheatViolation::TeleportOrPositionDesync: return "teleport_or_position_desync";
        case rs::CheatViolation::StateHashMismatch: return "state_hash_mismatch";
        case rs::CheatViolation::SpecConfigMismatch: return "spec_config_mismatch";
        case rs::CheatViolation::AutosteerOrMacroBot: return "autosteer_or_macro_bot";
    }
    return "unknown";
}
}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "Usage: opengrid_replay_verifier <car_json> <replay_json>\n");
        return 2;
    }
    try {
        rs::CarConfig cfg = rs::load_car_config(argv[1]);
        std::ifstream ifs(argv[2]);
        if (!ifs) {
            std::fprintf(stderr, "Cannot open replay file: %s\n", argv[2]);
            return 2;
        }
        nlohmann::json j;
        ifs >> j;

        rs::AuthorityServerSim auth(cfg);
        const rs::Vec3 start_pos{
            j.value("start_x", 0.0),
            j.value("start_y", 0.0),
            j.value("start_z", 0.0)
        };
        auth.reset(start_pos, j.value("start_yaw", 0.0), j.value("start_speed", 0.0), j.value("start_gear", -1));

        const std::uint64_t expected_cfg_hash = auth.config_hash();
        const std::uint64_t claimed_cfg_hash = j.value("config_hash", expected_cfg_hash);
        const rs::VerificationResult cfg_rep = auth.verify_config_hash(claimed_cfg_hash);

        const double dt = j.value("dt", 1.0 / 400.0);
        std::vector<rs::TickInputFrame> inputs;
        rs::AntiBotAnalyzer bot;
        rs::ClientStateClaim claim{};
        bool has_claim = false;

        if (j.contains("ticks") && j["ticks"].is_array()) {
            inputs.reserve(j["ticks"].size());
            std::uint32_t idx = 0;
            for (const auto& t : j["ticks"]) {
                rs::TickInputFrame frame{};
                frame.tick = t.value("tick", idx++);
                frame.input.throttle = t.value("throttle", 0.0);
                frame.input.brake = t.value("brake", 0.0);
                frame.input.steer = t.value("steer", 0.0);
                frame.input.clutch = t.value("clutch", 0.0);
                frame.input.handbrake = t.value("handbrake", 0.0);
                frame.input.gear = t.value("gear", 2);
                frame.input.auto_clutch = t.value("auto_clutch", true);
                inputs.push_back(frame);

                rs::BotTelemetryFrame bf{};
                bf.time_s = t.value("time_s", static_cast<double>(frame.tick) * dt);
                bf.steer = frame.input.steer;
                bf.throttle = frame.input.throttle;
                bf.brake = frame.input.brake;
                bf.front_slip_angle_rad = t.value("front_slip_angle_rad", t.value("slip_max", 0.0));
                bf.optimal_slip_angle_rad = t.value("optimal_slip_angle_rad", 0.14);
                bf.yaw_accel_rads2 = t.value("yaw_accel_rads2", 0.0);
                bot.record_frame(bf);

                if (t.contains("x") && t.contains("y")) {
                    claim.tick = frame.tick;
                    claim.chassis.position = {t.value("x", 0.0), t.value("y", 0.0), t.value("z", 0.0)};
                    claim.chassis.velocity = {t.value("vx", 0.0), t.value("vy", 0.0), t.value("vz", 0.0)};
                    claim.engine_rpm = t.value("rpm", 0.0);
                    claim.gear = frame.input.gear;
                    claim.state_hash = t.value("state_hash", std::uint64_t{0});
                    has_claim = true;
                }
            }
        }

        if (j.contains("claim") && j["claim"].is_object()) {
            const auto& c = j["claim"];
            claim.tick = c.value("tick", inputs.empty() ? 0u : inputs.back().tick);
            claim.chassis.position = {c.value("x", 0.0), c.value("y", 0.0), c.value("z", 0.0)};
            claim.chassis.velocity = {c.value("vx", 0.0), c.value("vy", 0.0), c.value("vz", 0.0)};
            claim.engine_rpm = c.value("rpm", 0.0);
            claim.gear = c.value("gear", 2);
            claim.state_hash = c.value("state_hash", std::uint64_t{0});
            has_claim = true;
        }

        rs::VerificationResult phys_rep{};
        if (!inputs.empty() && has_claim) {
            phys_rep = auth.verify_ticks(
                inputs,
                claim,
                j.value("pos_tolerance_m", 0.35),
                j.value("speed_tolerance_ms", 1.2)
            );
        }

        const rs::BotAnalysisReport bot_rep = bot.analyze();
        const bool ok = cfg_rep.valid && phys_rep.valid && !bot_rep.flagged_as_bot;
        const rs::CheatViolation final_violation =
            !cfg_rep.valid ? cfg_rep.violation
            : (!phys_rep.valid ? phys_rep.violation
            : (bot_rep.flagged_as_bot ? bot_rep.violation : rs::CheatViolation::None));

        nlohmann::json out = {
            {"verdict", ok ? "ok" : "mismatch"},
            {"config_match", cfg_rep.valid},
            {"physics_passed", phys_rep.valid},
            {"bot_flagged", bot_rep.flagged_as_bot},
            {"ticks_checked", inputs.size()},
            {"position_error_m", phys_rep.position_error_m},
            {"speed_error_ms", phys_rep.speed_error_ms},
            {"bot_confidence", bot_rep.bot_confidence_0_to_1},
            {"reason", violation_name(final_violation)},
        };
        std::cout << out.dump() << "\n";
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "Verifier error: %s\n", e.what());
        return 1;
    }
}
