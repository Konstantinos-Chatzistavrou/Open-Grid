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

/** Tachometer + speedometer with the key-on sweep. */
class InstrumentCluster {
public:
    /** tach dial ends 1000-2000 rpm above the redline, on a whole 1000; speedo dial at speedo_max_kmh. */
    void configure(double redline_rpm, double speedo_max_kmh = 340);
    /** Key on: both pointers sweep to full scale and back (~1.2 s) before they show the signals. */
    void ignition_sweep() { sweep_t_ = 0; }
    void step(double rpm, double speed_kmh, double dt);

    GaugeNeedle tach, speedo;
    double tach_max_rpm() const { return tach.params().full_scale; }

private:
    double sweep_t_ = -1;   // < 0: no sweep running
};

}  // namespace rs
