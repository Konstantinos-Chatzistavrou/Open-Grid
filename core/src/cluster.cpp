#include "rs/cluster.hpp"
#include <algorithm>
#include <cmath>

namespace rs {

void GaugeNeedle::reset(double value) {
    const double f = p_.full_scale > 0 ? std::clamp(value / p_.full_scale, 0.0, 1.0) : 0.0;
    pos_deg_ = target_deg_ = f * p_.sweep_deg;
    vel_dps_ = 0;
    sample_t_ = 1e9;
}

double GaugeNeedle::step(double value, double dt) {
    if (dt <= 0) return this->value();
    // CAN: a new sample every 1 / sample_hz, held in between
    sample_t_ += dt;
    if (sample_t_ >= 1.0 / std::max(p_.sample_hz, 1.0)) {
        sample_t_ = 0;
        const double f = p_.full_scale > 0 ? std::clamp(value / p_.full_scale, 0.0, 1.0) : 0.0;
        target_deg_ = f * p_.sweep_deg;
    }
    // stepper: velocity toward the target, limited by top speed and by the deceleration needed to stop on it
    const double err = target_deg_ - pos_deg_;
    const double a = std::max(p_.max_accel_dps2, 1.0);
    const double v_stop = std::sqrt(2.0 * a * std::abs(err));
    const double v_want = std::copysign(std::min(p_.max_speed_dps, v_stop), err);
    const double dv = std::clamp(v_want - vel_dps_, -a * dt, a * dt);
    vel_dps_ += dv;
    const double move = vel_dps_ * dt;
    if ((err > 0 && move >= err) || (err < 0 && move <= err) || err == 0) {   // arrives this step: stop on it
        pos_deg_ = target_deg_;
        vel_dps_ = 0;
    } else {
        pos_deg_ += move;
    }
    return this->value();
}

double GaugeNeedle::value() const { return p_.sweep_deg > 0 ? pos_deg_ / p_.sweep_deg * p_.full_scale : 0.0; }
double GaugeNeedle::fraction() const { return p_.sweep_deg > 0 ? pos_deg_ / p_.sweep_deg : 0.0; }

void InstrumentCluster::configure(double redline_rpm, double speedo_max_kmh) {
    GaugeParams t;
    t.full_scale = std::ceil((redline_rpm + 1000.0) / 1000.0) * 1000.0;
    tach.set_params(t);
    GaugeParams s;
    s.full_scale = speedo_max_kmh;
    speedo.set_params(s);
    tach.reset(0);
    speedo.reset(0);
}

void InstrumentCluster::step(double rpm, double speed_kmh, double dt) {
    if (sweep_t_ >= 0) {
        // self-test: full scale for the first half, back to zero for the second (the steppers' own speed shapes it)
        sweep_t_ += dt;
        const bool up = sweep_t_ < 0.6;
        tach.step(up ? tach.params().full_scale : 0.0, dt);
        speedo.step(up ? speedo.params().full_scale : 0.0, dt);
        if (sweep_t_ > 1.2 && tach.value() < 1.0) sweep_t_ = -1;
        return;
    }
    tach.step(rpm, dt);
    speedo.step(speed_kmh, dt);
}

}  // namespace rs
