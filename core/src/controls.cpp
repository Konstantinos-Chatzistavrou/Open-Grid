#include "rs/controls.hpp"
#include <cmath>
#include <utility>

namespace rs {

namespace {
double move_toward(double v, double target, double max_step) {
    return std::abs(target - v) <= max_step ? target : v + sign(target - v) * max_step;
}
}  // namespace

Controls::Controls(const CarConfig& cfg) : cfg_(cfg) {}

void Controls::set_gear(int g) {
    int n = (int)cfg_.drivetrain.gear_ratios.size();
    int prev = gear_;
    gear_ = g < 0 ? 0 : (g >= n ? n - 1 : g);
    if (gear_ != 0) pedal_reverse_ = false;
    if (gear_ != prev) reverse_timer_ = 0;
}

double Controls::max_steer_fraction(double v) const {
    if (!settings.speed_sensitive_steering) return 1.0;
    double lock = cfg_.front.max_steer_deg * kPi / 180.0;
    v = std::max(std::abs(v), 1.0);
    double grip_angle = cfg_.wheelbase * settings.steer_mu_estimate * kGravity / (v * v);
    double max_angle = clamp(grip_angle + settings.steer_slip_margin, lock * settings.steer_min_fraction, lock);
    return max_angle / lock;
}

DriverInput Controls::update(const RawInput& raw, const VehicleOutput& last, double dt) {
    const ControlSettings& s = settings;
    DriverInput in;
    const double v = last.speed;

    // ---- steering shaping per device
    double target = clamp(raw.steer, -1.0, 1.0);
    // hands off (keyboard released / stick centred, rolling): the caster, not the centring ramp, moves the wheel (below)
    const bool hands_off = s.self_aligning && raw.device != InputDevice::Wheel && std::abs(target) < 0.08 && v > 3.0;
    if (!hands_off) switch (raw.device) {
        case InputDevice::Keyboard: {
            // Digital key -> ramp. Releasing returns to centre faster than turning in (like a
            // self-centring steering rack); reversing direction passes through centre quickly.
            bool returning = std::abs(target) < 1e-3 || sign(target) != sign(steer_);
            steer_ = move_toward(steer_, target, (returning ? s.kb_steer_return : s.kb_steer_rate) * dt);
            break;
        }
        case InputDevice::Gamepad: {
            // Deadzone, then a curve y = (1-c) x + c x^3 for finer control near centre,
            // then a first-order low-pass filter (time constant tau): y += (x - y) dt / tau.
            double a = std::abs(target);
            a = a < s.pad_deadzone ? 0.0 : (a - s.pad_deadzone) / (1.0 - s.pad_deadzone);
            a = (1 - s.pad_curve) * a + s.pad_curve * a * a * a;
            double shaped = sign(target) * a;
            steer_ += (shaped - steer_) * std::min(1.0, dt / s.pad_smoothing);
            break;
        }
        case InputDevice::Wheel:
            steer_ = target;    // a real wheel is 1:1; no filtering, no speed scaling
            break;
    }
    // ---- hands off (keyboard released / stick centred): caster and aligning torque turn the front wheels toward the
    // direction the front axle is travelling, i.e. zero front slip angle. In a slide that is the countersteer angle:
    //   delta_free = atan2(v_y + r a, v_x)   (front axle velocity in the body frame; a = CG to front axle)
    if (hands_off) {
        const double lock = cfg_.front.max_steer_deg * kPi / 180.0 * max_steer_fraction(v);
        const double vy = std::tan(last.sideslip) * v;
        const double free_angle = std::atan2(vy + last.yaw_rate * cfg_.dist_cg_front, v);
        steer_ = move_toward(steer_, clamp(free_angle / std::max(lock, 1e-3), -1.0, 1.0), s.self_align_rate * dt);
    }
    double steer = steer_;
    if (raw.device != InputDevice::Wheel) steer *= max_steer_fraction(v);
    assist_state_ = {};

    // ---- countersteer assist: when the rear actually steps out (dynamic rear-axle sideslip opposing
    // yaw rate, NOT geometric low-speed Ackermann CG sideslip), add countersteer toward the slide.
    const double lock = std::max(cfg_.front.max_steer_deg * kPi / 180.0, 1e-3);
    if (s.countersteer_assist && v > 5.0) {
        const double vy_cg = std::tan(last.sideslip) * v;
        const double beta_rear = std::atan2(vy_cg - last.yaw_rate * cfg_.dist_cg_rear, v);
        if (std::abs(beta_rear) > 0.04 && beta_rear * last.yaw_rate < 0.0) {
            steer += s.countersteer_gain * beta_rear / lock;
            assist_state_.countersteer_active = true;
        }
    }

    // ---- physics-up Controller Steering Filter (gamepad/keyboard ONLY; wheels stay 100% 1:1):
    // Caps requested road-wheel steer angle near the front tyres' optimal peak slip angle around the front axle's
    // instantaneous velocity vector delta_free = atan2(v_y + r * a, v_x), preventing thumbstick/keyboard washout
    // understeer and pendulum snap-oversteer while running on the exact same Pacejka tyres and chassis.
    if (s.steering_assist != SteeringAssistMode::Off && raw.device != InputDevice::Wheel && v > 5.0) {
        const double vy_cg = std::tan(last.sideslip) * v;
        const double delta_free = std::atan2(vy_cg + last.yaw_rate * cfg_.dist_cg_front, v);
        const double max_slip = (s.steering_assist == SteeringAssistMode::Assisted)
            ? s.steer_filter_max_slip_assisted_rad
            : s.steer_filter_max_slip_sim_rad;
        double delta_cmd = steer * lock;
        if (s.steering_assist == SteeringAssistMode::Assisted) {
            // Subtle yaw-rate stabilization when the car rotates faster than steady-state Ackermann predicts
            const double r_ref = (v * delta_cmd) / std::max(cfg_.wheelbase, 1.5);
            const double yaw_err = last.yaw_rate - r_ref;
            if (std::abs(yaw_err) > 0.12) {
                delta_cmd -= clamp(yaw_err * s.steer_filter_yaw_damp, -0.10, 0.10);
            }
        }
        const double lo = delta_free - max_slip;
        const double hi = delta_free + max_slip;
        const double clamped_delta = clamp(delta_cmd, lo, hi);
        if (std::abs(clamped_delta - steer * lock) > 0.008) {
            assist_state_.steering_filter_active = true;
        }
        steer = clamped_delta / lock;
    }
    in.steer = clamp(steer, -1.0, 1.0);

    // ---- pedals
    if (raw.device == InputDevice::Keyboard) {
        throttle_ = move_toward(throttle_, raw.throttle, (raw.throttle > throttle_ ? s.kb_throttle_rise : s.kb_throttle_fall) * dt);
        brake_ = move_toward(brake_, raw.brake, (raw.brake > brake_ ? s.kb_brake_rise : s.kb_brake_fall) * dt);
    } else {
        throttle_ = clamp(raw.throttle, 0.0, 1.0);
        brake_ = clamp(raw.brake, 0.0, 1.0);
    }
    in.throttle = throttle_;
    in.brake = brake_;

    // ---- physics-up Corner Braking Assist (optional beginner on-ramp from Driving Line target speed):
    if (s.braking_assist != BrakingAssistMode::Off && raw.recommended_speed_ms >= 0.0 && v > 4.0 && !pedal_reverse_) {
        const double overspeed = v - raw.recommended_speed_ms;
        const bool high = (s.braking_assist == BrakingAssistMode::High);
        const double trigger = high ? 1.5 : 4.5;
        if (overspeed > trigger) {
            const double max_brake = high ? 0.85 : 0.48;
            const double span = high ? 9.0 : 14.0;
            const double assist_brake = clamp((overspeed - trigger) / span, 0.0, 1.0) * max_brake;
            if (assist_brake > in.brake) {
                assist_state_.braking_assist_active = true;
                assist_state_.braking_assist_amount = assist_brake - in.brake;
                in.brake = assist_brake;
            }
            const double lift = clamp((overspeed - trigger) / (high ? 4.0 : 8.0), 0.0, 1.0);
            in.throttle *= (1.0 - lift);
        }
    }
    in.clutch = raw.clutch;
    in.handbrake = raw.handbrake;
    in.line_lock = raw.line_lock;
    // Keyboard burnout: a key is a full pedal, so both pedals at a standstill cannot be the half-brake a driver would
    // hold; it acts as a line-lock button instead (front brakes held, rears free).
    if (raw.device == InputDevice::Keyboard && s.keyboard_line_lock && raw.throttle > 0.5 && raw.brake > 0.5
        && std::abs(last.speed) < 3.0 && !pedal_reverse_) {
        in.line_lock = 1.0;
        in.brake = 0.0;
    }
    in.auto_clutch = s.auto_clutch;
    in.auto_clutch_quality = s.auto_clutch_quality;

    // ---- gears: manual shift events always work; the automatic gearbox only moves between
    // forward gears. Shift points from engine rpm; a downshift is refused if it would over-rev.
    shift_cooldown_ = std::max(0.0, shift_cooldown_ - dt);
    if (raw.direct_gear != -99) {
        if (raw.direct_gear != gear_) set_gear(raw.direct_gear);   // the lever is where the lever is
    } else {
        if (raw.shift_up) set_gear(gear_ + 1);
        if (raw.shift_down) set_gear(gear_ - 1);
    }
    const auto& ratios = cfg_.drivetrain.gear_ratios;
    int top = (int)ratios.size() - 1;
    // Bug fix: engage 1st immediately when auto-gearbox is enabled and the car starts in Neutral (gear 1).
    if (s.auto_gearbox && gear_ == 1 && raw.direct_gear == -99 && !raw.shift_up && !raw.shift_down && throttle_ > 0.05 && brake_ < 0.1) {
        set_gear(2);
    }
    if (s.auto_gearbox && gear_ >= 2 && shift_cooldown_ <= 0) {
        double rpm = last.engine_rpm;
        // no upshifts while line lock holds the car: the wheels spin but the car is not going anywhere
        if (rpm > s.upshift_rpm_fraction * cfg_.engine.redline_rpm && gear_ < top && throttle_ > 0.1 && in.line_lock <= 0) {
            set_gear(gear_ + 1);
            shift_cooldown_ = 0.6;
        } else if (gear_ > 2 && rpm < s.downshift_rpm) {
            double rpm_after = rpm * ratios[gear_ - 1] / ratios[gear_];
            if (rpm_after < 0.85 * cfg_.engine.redline_rpm) {
                set_gear(gear_ - 1);
                shift_cooldown_ = 0.4;
            }
        }
        if (std::abs(v) < 1.0 && brake_ > 0.2) set_gear(2);   // stopped: back to first
    }
    // ---- reverse by pedal (see ControlSettings): brake held at a standstill -> R, pedals swap;
    // throttle held at a standstill while pedal-reversing -> 1st. Works with either gearbox; a
    // gear the driver chose keeps the normal pedals: an explicit shift into R (paddles) and the H-pattern
    // shifter (the lever decides, so the pedals never swap).
    if (raw.direct_gear != -99) {
        pedal_reverse_ = false;
        reverse_timer_ = 0;
    } else if (s.pedal_reverse && !raw.shift_up && !raw.shift_down) {
        const bool stopped = std::abs(v) < s.reverse_speed;
        const double want = pedal_reverse_ ? throttle_ : brake_;   // the pedal that asks to switch
        const double other = pedal_reverse_ ? brake_ : throttle_;
        // Already in R without pedal-reversing: the driver selected it, so the brake is a brake (not a throttle).
        const bool can_switch = pedal_reverse_ || gear_ != 0;
        if (stopped && can_switch && want > s.reverse_brake && other < 0.05) reverse_timer_ += dt;
        else reverse_timer_ = 0;
        if (reverse_timer_ > s.reverse_delay) {
            bool to_reverse = !pedal_reverse_;
            set_gear(to_reverse ? 0 : 2);
            pedal_reverse_ = to_reverse;
        }
    }
    if (pedal_reverse_) std::swap(in.throttle, in.brake);
    in.gear = gear_;
    return in;
}

}  // namespace rs
