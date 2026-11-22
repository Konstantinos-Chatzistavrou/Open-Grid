// Instrument cluster: how a real dashboard shows the engine and the speed, engine-neutral (web HUD and Unreal draw the
// same needle positions).
//
// A modern cluster gets the rpm and speed as messages on the CAN bus every 10-20 ms (sample and hold), and moves each
// pointer with a stepper motor that has a top speed and a limited acceleration: it lags a fast change, never
// overshoots, and on the rev limiter it twitches with the bounce the engine really makes (it cannot follow all of it).
// On key-on the cluster sweeps every pointer to full scale and back (self-test).
//
// Numbers: X27-class stepper gauge motors run up to 600 deg/s over a 315 deg range (Juken Swiss spec sheet); an rpm
// frame every 20 ms (observed on a production car's CAN bus; 10 ms in SAE J1939). The acceleration limit is an
// estimate (reaches full speed in ~50 ms).
#pragma once

namespace rs {

struct GaugeParams {
    double full_scale = 8000;       // value at the end of the dial (rpm, km/h)
    double sweep_deg = 270;         // dial angle from 0 to full scale
    double sample_hz = 50;          // CAN message rate (sample and hold)
    double max_speed_dps = 600;     // stepper top speed, deg/s
    double max_accel_dps2 = 12000;  // stepper acceleration limit, deg/s^2 (estimate)
};

class GaugeNeedle {
public:
    explicit GaugeNeedle(GaugeParams p = {}) : p_(p) {}
    void set_params(const GaugeParams& p) { p_ = p; }
    const GaugeParams& params() const { return p_; }
    void reset(double value);
    /** Advance by dt with the current signal; returns the pointer position in value units (0 .. full scale). */
    double step(double value, double dt);
    double value() const;                 // pointer position, value units
    double fraction() const;              // 0 .. 1 of the dial
    double angle_deg() const { return pos_deg_; }

private:
    GaugeParams p_;
    double pos_deg_ = 0, vel_dps_ = 0, target_deg_ = 0, sample_t_ = 1e9;
};

// Warning lamps (bit mask), as a cluster lights them.
enum ClusterLamp : unsigned {
    LampCheckEngine = 1u << 0,   // engine health low (flashes when it is misfiring badly)
    LampOil = 1u << 1,           // oil pressure: engine not running
    LampBattery = 1u << 2,       // charging: engine not running
    LampAbs = 1u << 3,           // ABS off / unavailable
    LampEsc = 1u << 4,           // traction / stability control intervening (flashes)
    LampEscOff = 1u << 5,        // stability control switched off
    LampBrake = 1u << 6,         // handbrake on or brake failure
    LampCoolant = 1u << 7,       // coolant over-temperature
    LampFuel = 1u << 8,          // low fuel
    LampTpms = 1u << 9,          // a tyre 25 % or more under its set pressure (FMVSS 138 threshold)
};

/** What the cluster reads from the car each step. */
struct ClusterInputs {
    double rpm = 0, speed_kmh = 0;
    double coolant_c = 90, oil_c = 90, boost_bar = 0;
    bool turbo = false, engine_running = true;
    bool abs_enabled = true, esc_enabled = true, esc_or_tc_active = false;
    bool handbrake = false, brake_fault = false;
    double engine_health = 1, fuel_l = 50;
    double min_tyre_pressure_ratio = 1;   // lowest tyre pressure / its set (cold) pressure, temperature-corrected
};

/** Tachometer, speedometer, water / oil temperature, boost and the warning lamps, with the key-on self-test. */
class InstrumentCluster {
public:
    /** tach dial ends 1000-2000 rpm above the redline, on a whole 1000; speedo dial at speedo_max_kmh.
     *  overread: the speedometer reads this fraction high (UN R39: indicated may exceed true by 0 .. 10 % + 4 km/h,
     *  never less; production speedometers read a few per cent high). */
    void configure(double redline_rpm, double speedo_max_kmh = 340, double overread = 0.035);
    /** Key on: every pointer sweeps to full scale and back (~1.2 s) and every lamp lights for the bulb check (2.5 s). */
    void ignition_sweep() { sweep_t_ = 0; bulb_t_ = 0; }
    void step(const ClusterInputs& in, double dt);
    void step(double rpm, double speed_kmh, double dt) { ClusterInputs i; i.rpm = rpm; i.speed_kmh = speed_kmh; step(i, dt); }

    GaugeNeedle tach, speedo, water, oil, boost;
    double tach_max_rpm() const { return tach.params().full_scale; }
    /** what the speedometer shows (the digital readout too): true speed x (1 + overread) */
    double indicated_speed_kmh() const { return indicated_; }
    /** coolant temperature the water needle points at (C): mid-scale (90) across the normal 80-105 C band */
    static double buffered_coolant(double c);
    unsigned lamps() const { return lamps_; }

    // dial ranges (value units at the ends of each small dial)
    static constexpr double kWaterMin = 50, kWaterMax = 130, kOilMin = 50, kOilMax = 150, kBoostMin = -1, kBoostMax = 2;

private:
    double sweep_t_ = -1, bulb_t_ = -1, flash_t_ = 0, indicated_ = 0, overread_ = 0.035;
    double coolant_f_ = 90, oil_f_ = 90, boost_f_ = 0;   // sensor lags
    unsigned lamps_ = 0;
};

}  // namespace rs
