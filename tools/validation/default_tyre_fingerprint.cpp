// Apache-2.0 - bit-exact fingerprint of the game's own tyre path (rs::magic_formula without the opt-in rs::mf62 tyre): 1,752,192 evaluations over four cars, both axles, hybrid and patch grid on and off,
// with and without a tyre condition, hashed bit for bit (FNV-1a over the raw doubles). Used to show that a change did not alter the default tyre: build it against two checkouts and compare.
//
//   # for each checkout to compare (the same compiler and machine: floating point is only bit-identical there):
//   cmake -S core -B core/build -DCMAKE_BUILD_TYPE=Release -DRS_BUILD_TESTS=OFF && cmake --build core/build --target rs_core
//   g++ -std=c++20 -O2 -Icore/include tools/validation/default_tyre_fingerprint.cpp core/build/librs_core.a -o /tmp/fingerprint
//   /tmp/fingerprint "$PWD/data"
//
// Recorded 2026-11-27 with GCC 13.3 on x86-64 (Linux): "1752192 evaluations, fingerprint a850d0caf3473245" at commit 6c25dfde (before the opt-in tyre existed) and at 31235fa4 (after). A different compiler or CPU
// may give a different value for BOTH checkouts; what matters is that the two agree. Needs `data/cars/*.json` of the checkout it is run on, so a car-file change also changes the value.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include "rs/config.hpp"
#include "rs/tire.hpp"
using namespace rs;
static uint64_t h = 1469598103934665603ull;
static long n = 0;
static void mix(double d) { uint64_t u; std::memcpy(&u, &d, 8); for (int i = 0; i < 8; ++i) { h ^= (u >> (8 * i)) & 0xff; h *= 1099511628211ull; } }
int main(int argc, char** argv) {
    const std::string dir = argv[1];
    for (const char* car : {"tornado_gt3.json", "kestrel_gt.json", "vela_gt.json", "harrier_gt.json"}) {
        const CarConfig cfg = load_car_config(dir + "/cars/" + car);
        for (int ax = 0; ax < 2; ++ax) {
            const TireParams& p = ax ? cfg.tire_rear : cfg.tire_front;
            for (int cond = 0; cond < 3; ++cond)
            for (int hybrid = 0; hybrid < 2; ++hybrid)
            for (int grid = 0; grid < 2; ++grid) {
                TireCondition tc;
                if (cond == 2) { tc.surface_c = 60; tc.flash_c = 120; tc.inner_c = 70; tc.middle_c = 95; tc.outer_c = 125; tc.wear = 0.4; }
                for (double fz : {1500.0, 3500.0, 6500.0})
                for (double gamma : {-0.05, 0.0, 0.04})
                for (double vs : {2.0, 9.0, 24.0})
                for (double dpi : {0.0, 0.08})
                for (double side : {-1.0, 1.0})
                for (int ik = -6; ik <= 6; ++ik)
                for (int ia = -6; ia <= 6; ++ia) {
                    TireOperating op;
                    op.slip_speed = vs; op.dpi = dpi; op.phi = 0.02 * ia; op.enable_mf62_hybrid = hybrid; op.enable_contact_patch_grid = grid;
                    op.wheel_side_sign = side; op.rolling_speed_mps = 20.0; op.yaw_rate_rads = 0.1 * ik;
                    op.condition = cond ? &tc : nullptr;
                    const TireForces f = magic_formula(p, 0.05 * ik, 0.08 * ia, fz, 0.97, gamma, op);
                    mix(f.fx); mix(f.fy); mix(f.mx); mix(f.mz); mix(f.pneumatic_trail); mix(f.effective_rib_mu); mix(f.thermal_stiffness_scale);
                    mix(f.contact_patch_length_m); mix(f.adhesion_ratio); mix(f.kerb_load_ratio); mix(f.cold_micro_step_chatter);
                    ++n;
                }
            }
        }
    }
    std::printf("%ld evaluations, fingerprint %016llx\n", n, static_cast<unsigned long long>(h));
}
