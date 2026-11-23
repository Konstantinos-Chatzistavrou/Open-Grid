// Second reference car (Testing Program Layer 1 #1 / Issue #8):
// Front-drive hot hatch (Mistra 200T) against published road-test figures for a real car of the
// same class, measured the way magazines do — testing whether the physics model generalises beyond
// the single RWD Corvette-class Vela GT without retuning the core.
//
// Reference: 2015-2017 Volkswagen Golf GTI Mk7 (Performance Pack, 6-speed manual).
// Transverse 2.0L turbo I4 (169 kW / 230 PS EU, 164 kW / 220 hp US; 350 Nm @ 1500-4600 rpm),
// ~1385 kg (3057 lb), 61/39 F/R weight split, 2.631 m wheelbase, 1.538/1.516 m track, MacPherson
// strut front + 4-link independent rear, VAQ front LSD, 225/40 R18 summer tyres, Cd 0.31 / A 2.21 m^2.
//
// Published figures:
//   0-60 mph (1 ft rollout)  5.6-5.9 s (Car and Driver), 5.9 s (Edmunds, 1 ft rollout), 5.8-6.1 s (MotorTrend)
//   0-100 km/h               6.4 s (VW factory EU 230 PS manual; ~6.2-6.5 s magazine tests)
//   60-0 mph, ABS            108 ft = 32.9 m (Edmunds), 108-112 ft = 32.9-34.1 m (MotorTrend)
//   skidpad 300 ft           0.92-0.96 g (Car and Driver), 0.94 g (Edmunds, MotorTrend)
//   top speed                250 km/h / 155 mph (VW factory Performance Pack, drag/limiter class)
//
// Sources:
//   - VW US Press Release (2015 Golf GTI): https://media.vw.com/releases/346
//   - VW 2015 US Golf GTI Brochure: https://www.auto-brochures.com/makes/Volkswagen/Golf/VW_US%20Golf_GTI_2015.pdf
//   - Edmunds 2015 Golf GTI Track Test: https://www.edmunds.com/volkswagen/golf-gti/2015/long-term-road-test/
//   - UltimateSpecs (Golf 7 GTI Performance 230 PS):
//     https://www.ultimatespecs.com/car-specs/Volkswagen/65179/Volkswagen-Golf-7-GTI-Performance-20-TSI-230HP-.html
//   - ZePerfs (Golf VII GTI Performance): https://zeperfs.com/en/fiche4572-vw-golf-vii-gti-performance.htm
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include "measure.hpp"

using namespace rs;
using namespace rs::sheet;

namespace {

struct SkidpadBalance {
    double understeer_grad_deg_per_g = 0.0;
    double front_slip_deg = 0.0;
    double rear_slip_deg = 0.0;
    double ay_g = 0.0;
};

// Measure steady-state balance on the 300 ft diameter skidpad (R = 45.72 m) near 0.75 g:
// road-wheel steer minus Ackermann angle (L/R), and front vs rear tyre slip angles.
SkidpadBalance measure_skidpad_balance(const CarConfig& cfg, double target_g = 0.75) {
    const double R = 150.0 * kFoot;
    const double L = cfg.wheelbase;
    const double v = std::sqrt(target_g * kGravity * R);
    auto s = test::make_sim(cfg);
    s->reset({}, 0, v, 3);
    test::SpeedController sc;
    double steer_sum = 0.0, ay_sum = 0.0, af_sum = 0.0, ar_sum = 0.0;
    int n = 0;
    while (s->time < 16.0) {
        DriverInput in;
        in.gear = 3;
        in.steer = test::steer_circle(*s, {0, R, 0}, R, 10.0);
        sc.apply(*s, v, in);
        s->step(in);
        if (s->time > 10.0) {
            steer_sum += in.steer;
            ay_sum += s->accel_body().y;
            af_sum += 0.5 * (std::abs(s->last.wheels[0].slip_angle) + std::abs(s->last.wheels[1].slip_angle));
            ar_sum += 0.5 * (std::abs(s->last.wheels[2].slip_angle) + std::abs(s->last.wheels[3].slip_angle));
            ++n;
        }
    }
    SkidpadBalance out;
    if (n > 0) {
        constexpr double kRadToDeg = 180.0 / kPi;
        const double steer_deg = (steer_sum / n) * cfg.front.max_steer_deg;
        out.ay_g = (ay_sum / n) / kGravity;
        out.understeer_grad_deg_per_g = (steer_deg - (L / R) * kRadToDeg) / std::max(out.ay_g, 0.1);
        out.front_slip_deg = (af_sum / n) * kRadToDeg;
        out.rear_slip_deg = (ar_sum / n) * kRadToDeg;
    }
    return out;
}

}  // namespace

RS_TEST(reference_fwd) {
    const CarConfig fwd_cfg = load_car_config(test::data_path("cars/mistra_200t.json"));
    const CarConfig rwd_cfg = test::car();

    // 1. Mistra 200T vs 2015-2017 VW Golf GTI Mk7 Performance Pack (6-speed manual)
    const Sheet hatch = measure(fwd_cfg);
    test::check_range("0-60 mph (1 ft rollout)  [GTI Mk7 5.6-6.1 s]", hatch.t60, 5.4, 6.4, "s");
    test::check_range("0-100 km/h (1 ft roll.)  [GTI Mk7 ~6.1-6.5 s]", hatch.t100, 5.7, 6.8, "s");
    test::check_range("60-0 mph, ABS            [GTI Mk7 32.9-34.1 m]", hatch.brake60, 31.5, 36.0, "m");
    test::check_range("skidpad 300 ft           [GTI Mk7 0.92-0.96 g]", hatch.skidpad_g, 0.90, 0.98, "g");
    test::check_range("top speed                [GTI Mk7 ~250 km/h]", hatch.vmax_kmh, 240.0, 260.0, "km/h");

    // 2. Cross-class generalization against the RWD Corvette-class Vela GT
    const Sheet gt = measure(rwd_cfg);
    test::check("0-60 mph: FWD hot hatch slower than RWD Vela GT", hatch.t60 > gt.t60);
    test::check("0-200 km/h: FWD hot hatch slower than RWD Vela GT", hatch.t200 > gt.t200 && hatch.t200 > 0.0);
    test::check("skidpad: FWD hot hatch lower lateral g than RWD Vela GT", hatch.skidpad_g < gt.skidpad_g);
    test::check("top speed: FWD hot hatch slower than RWD Vela GT", hatch.vmax_kmh < gt.vmax_kmh);

    // 3. FWD steady-state understeer character on the 300 ft skidpad
    const SkidpadBalance bal = measure_skidpad_balance(fwd_cfg, 0.75);
    std::printf("         skidpad balance @ %.2f g: K_us = %.2f deg/g | slip front %.2f deg vs rear %.2f deg\n",
                bal.ay_g, bal.understeer_grad_deg_per_g, bal.front_slip_deg, bal.rear_slip_deg);
    test::check("skidpad: positive steady-state understeer gradient", bal.understeer_grad_deg_per_g > 0.5);
    test::check("skidpad: front tyres work at larger slip angle than rear (front saturates first)",
                bal.front_slip_deg > bal.rear_slip_deg);
}
