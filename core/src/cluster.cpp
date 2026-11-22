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

namespace {
// small dials: an offset scale (min .. max) on a GaugeNeedle that counts from 0
GaugeParams small_dial(double range, double sample_hz) {
    GaugeParams p;
    p.full_scale = range;
    p.sweep_deg = 240;
    p.sample_hz = sample_hz;
    return p;
}
}  // namespace

void InstrumentCluster::configure(double redline_rpm, double speedo_max_kmh, double overread) {
    GaugeParams t;
    t.full_scale = std::ceil((redline_rpm + 1000.0) / 1000.0) * 1000.0;
    tach.set_params(t);
    GaugeParams s;
    s.full_scale = speedo_max_kmh;
    speedo.set_params(s);
    water.set_params(small_dial(kWaterMax - kWaterMin, 10));    // temperatures arrive slowly on the bus
    oil.set_params(small_dial(kOilMax - kOilMin, 10));
    boost.set_params(small_dial(kBoostMax - kBoostMin, 50));
    overread_ = std::max(0.0, overread);
    tach.reset(0);
    speedo.reset(0);
    water.reset(90 - kWaterMin);
    oil.reset(90 - kOilMin);
    boost.reset(0 - kBoostMin);
}

double InstrumentCluster::buffered_coolant(double c) {
    if (c < 80) return 90 - (80 - c) * (40.0 / 30.0);   // 50 -> 50, 80 -> 90
    if (c > 105) return 90 + (c - 105) * 2.0;           // 105 -> 90, 125 -> 130
    return 90;
}

void InstrumentCluster::step(const ClusterInputs& in, double dt) {
    // sensors: coolant and oil senders lag a couple of seconds, the boost (MAP) sensor ~20 ms
    coolant_f_ += (in.coolant_c - coolant_f_) * std::min(1.0, dt / 2.0);
    oil_f_ += (in.oil_c - oil_f_) * std::min(1.0, dt / 2.0);
    boost_f_ += (in.boost_bar - boost_f_) * std::min(1.0, dt / 0.02);
    indicated_ = std::max(0.0, in.speed_kmh) * (1.0 + overread_);

    if (sweep_t_ >= 0) {
        // self-test: full scale for the first half, back for the second (the steppers' own speed shapes it)
        sweep_t_ += dt;
        const bool up = sweep_t_ < 0.6;
        tach.step(up ? tach.params().full_scale : 0.0, dt);
        speedo.step(up ? speedo.params().full_scale : 0.0, dt);
        water.step(up ? water.params().full_scale : 0.0, dt);
        oil.step(up ? oil.params().full_scale : 0.0, dt);
        boost.step(up ? boost.params().full_scale : 0.0, dt);
        if (sweep_t_ > 1.2 && tach.value() < 1.0) sweep_t_ = -1;
    } else {
        tach.step(in.rpm, dt);
        speedo.step(indicated_, dt);
        water.step(buffered_coolant(coolant_f_) - kWaterMin, dt);
        oil.step(oil_f_ - kOilMin, dt);
        boost.step(in.turbo ? boost_f_ - kBoostMin : -kBoostMin, dt);
    }

    // lamps
    flash_t_ += dt;
    const bool blink = std::fmod(flash_t_, 0.5) < 0.25;   // 2 Hz
    unsigned l = 0;
    if (!in.engine_running) l |= LampOil | LampBattery;
    if (in.engine_health < 0.7 && (in.engine_health >= 0.4 || blink)) l |= LampCheckEngine;
    if (!in.abs_enabled) l |= LampAbs;
    if (!in.esc_enabled) l |= LampEscOff;
    if (in.esc_or_tc_active && blink) l |= LampEsc;
    if (in.handbrake || in.brake_fault) l |= LampBrake;
    if (coolant_f_ > 118) l |= LampCoolant;
    if (in.fuel_l < 8) l |= LampFuel;
    if (in.min_tyre_pressure_ratio < 0.75) l |= LampTpms;
    if (bulb_t_ >= 0) {
        bulb_t_ += dt;
        if (bulb_t_ < 2.5) l = 0x3FFu;     // bulb check: everything lit
        else bulb_t_ = -1;
    }
    lamps_ = l;
}

}  // namespace rs
