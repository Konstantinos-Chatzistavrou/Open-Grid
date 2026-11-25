// Engine-agnostic Sim Racing Telemetry:
//   1. Forza/SimHub-compatible 311-byte "Car Dash V2" UDP packet serializer + POSIX/Winsock UDP broadcaster
//      (drives SimHub dashboards, bass shakers/haptics, wind simulators, and motion rigs over UDP port 20777).
//   2. MoTeC i2 Pro (.ld binary + .ldx XML lap-beacon) exporter for post-race braking/suspension/tire analysis.
//
// Pure C++17, zero engine dependencies — compiles identically in standalone tests, WASM (MoTeC/packer),
// and Unreal Engine 5 C++ plugins.
#pragma once
#include <array>
#include <cstdint>
#include <string>
#include <vector>
#include "rs/vehicle.hpp"

namespace rs {

struct TelemetryMeta {
    std::string driver = "OpenGrid Driver";
    std::string vehicle = "Vela GT";
    std::string venue = "New York Midtown";
    std::string event = "Night Shift Session";
    double sample_rate_hz = 60.0;
};

struct TelemetrySample {
    double time_s = 0.0;
    bool is_race_on = true;
    int lap_number = 0;
    double current_lap_s = 0.0;
    double last_lap_s = 0.0;
    double best_lap_s = 0.0;
    double distance_m = 0.0;

    // Kinematics & forces (body frame, SI)
    double speed_ms = 0.0;
    double engine_rpm = 0.0;
    double engine_max_rpm = 8000.0;
    double engine_idle_rpm = 900.0;
    double power_w = 0.0;    // W, torque_nm * engine speed (make_telemetry_sample: from the clutch torque; negative on engine braking)
    double torque_nm = 0.0;  // N m, engine torque delivered through the clutch
    int gear = 1;            // 0 = R, 1 = N, 2 = 1st, ...
    int drivetrain_type = 1; // Forza code: 0 = FWD, 1 = RWD, 2 = AWD (make_telemetry_sample: from the car's layout)
    int num_cylinders = 8;   // firing pulses per two crank revolutions (make_telemetry_sample: from the car's engine)
    double throttle = 0.0;   // 0..1
    double brake = 0.0;      // 0..1
    double clutch = 0.0;     // 0..1
    double handbrake = 0.0;  // 0..1
    double steer = 0.0;      // -1..+1

    Vec3 velocity_world{};   // m/s, world frame
    Vec3 velocity_body{};    // m/s, the car's frame (X forward, Y left, Z up): what the Forza / SimHub packet carries
    Vec3 angular_vel_body{};
    Vec3 accel_body_mps2{};  // longitudinal X, lateral Y, vertical Z (m/s^2)
    double yaw_rad = 0.0;
    double pitch_rad = 0.0;
    double roll_rad = 0.0;
    double sideslip_rad = 0.0;

    // Per-wheel arrays: FL, FR, RL, RR
    std::array<double, 4> susp_travel_m{};       // m
    std::array<double, 4> susp_norm{};           // 0..1
    std::array<double, 4> wheel_camber_rad{};    // rad, dynamic tyre inclination / camber
    std::array<double, 4> wheel_toe_rad{};       // rad, dynamic suspension alignment toe-in (+ = toe-in)
    double roll_centre_front_m = 0.0;            // m, dynamic front axle roll-centre height
    double roll_centre_rear_m = 0.0;             // m, dynamic rear axle roll-centre height
    std::array<double, 4> wheel_omega_rads{};    // rad/s
    std::array<double, 4> tire_slip_ratio{};     // kappa
    std::array<double, 4> tire_slip_angle{};     // rad
    std::array<double, 4> tire_temp_c{75, 75, 75, 75};
    std::array<double, 4> tire_temp_inner_c{75, 75, 75, 75};
    std::array<double, 4> tire_temp_middle_c{75, 75, 75, 75};
    std::array<double, 4> tire_temp_outer_c{75, 75, 75, 75};
    std::array<double, 4> tire_carcass_temp_c{80, 80, 80, 80};
    std::array<double, 4> tire_inner_air_temp_c{53, 53, 53, 53};
    std::array<double, 4> tire_pressure_kpa{220, 220, 220, 220};
    std::array<double, 4> tire_patch_length_m{0.19, 0.19, 0.19, 0.19};
    std::array<double, 4> flat_spot_depth_mm{};
    std::array<double, 4> brake_temp_c{220, 220, 220, 220};
    std::array<double, 4> wheel_load_n{};
    std::array<double, 4> wheel_kerb_load_ratio{};
    std::array<double, 4> wheel_surface_excitation{};
    std::array<double, 4> sidewall_rollover{};
    std::array<double, 4> sidewall_damage{};
    std::array<double, 4> rim_strike_force_n{};
    std::array<double, 4> carcass_hysteresis_w{};
    double boost_bar = 0.0;
    double intake_air_temp_c = 28.0;
    double oil_temp_c = 85.0;
    double fuel_liters = 55.0;
    double mass_kg = 1450.0;
    Vec3 effective_inertia{};
    double exhaust_primary_hz = 0.0;
    double gear_whine_hz = 0.0;
    double turbo_surge = 0.0;
    double slipstream_drag_scale = 1.0;
};

/// Build a TelemetrySample directly from rs::VehicleOutput + ChassisState + DriverInput.
TelemetrySample make_telemetry_sample(
    const VehicleOutput& out,
    const ChassisState& chassis,
    const DriverInput& input,
    const CarConfig& cfg,
    double time_s,
    int lap_number = 0,
    double current_lap_s = 0.0,
    double last_lap_s = 0.0,
    double best_lap_s = 0.0,
    double distance_m = 0.0);

/// Exact Forza Motorsport / Horizon "Car Dash V2" packet size supported natively by SimHub.
constexpr std::size_t kSimHubPacketBytes = 311;

/// Pack a TelemetrySample into a 311-byte little-endian SimHub/Forza Dash V2 UDP datagram.
std::array<std::uint8_t, kSimHubPacketBytes> pack_simhub_udp(const TelemetrySample& s);

/// Non-blocking cross-platform UDP telemetry broadcaster (POSIX + Winsock2).
class UdpTelemetrySender {
public:
    UdpTelemetrySender() = default;
    ~UdpTelemetrySender();
    UdpTelemetrySender(const UdpTelemetrySender&) = delete;
    UdpTelemetrySender& operator=(const UdpTelemetrySender&) = delete;

    /// Open a UDP socket targeting host:port (default 127.0.0.1:20777 for SimHub).
    bool open(const std::string& host = "127.0.0.1", std::uint16_t port = 20777);
    void close();
    bool is_open() const { return fd_ >= 0; }

    /// Send raw bytes (returns true on success).
    bool send_raw(const std::uint8_t* data, std::size_t len);
    /// Pack and transmit a SimHub/Forza Dash V2 telemetry packet.
    bool send(const TelemetrySample& sample);

private:
    int fd_ = -1;
    std::string host_;
    std::uint16_t port_ = 20777;
};

/// MoTeC i2 Pro (.ld binary + .ldx XML beacon) recorder & exporter.
///
/// The log has a FIXED time base: every channel is written at meta.sample_rate_hz (60 Hz by default). record() is meant to be
/// called once per game frame at whatever rate the game runs, and resamples to that time base by TelemetrySample::time_s:
/// frames that arrive faster than the log rate are skipped, slower ones are zero-order held, so the exported time axis is
/// right at any (even varying) frame rate. Only the 18 exported channels are stored (as float32), and the log stops growing
/// after kMaxSeconds, so it can stay on for a whole session.
class MotecLogger {
public:
    static constexpr std::size_t kChannelCount = 18;   // channels in the .ld file
    static constexpr double kMaxSeconds = 3600.0;      // a log never holds more than this much time
    static constexpr double kMaxHoldSeconds = 0.5;     // a longer gap (pause, hitch) is not back-filled with held rows

    explicit MotecLogger(TelemetryMeta meta = {});

    void reset(TelemetryMeta meta = {});
    void record(const TelemetrySample& sample);
    /// Lap end in the same time base as TelemetrySample::time_s.
    void mark_lap(double lap_end_time_s);

    std::size_t sample_count() const { return rows_.size(); }
    bool full() const { return rows_.size() >= max_rows(); }
    const std::vector<double>& lap_beacons() const { return beacons_; }

    /// Build complete MoTeC i2 Pro binary `.ld` payload in memory.
    std::vector<std::uint8_t> build_ld() const;
    /// Build matching MoTeC `.ldx` XML lap-beacon sidecar file (beacon times are relative to the first recorded sample).
    std::string build_ldx() const;
    /// Write both `<base_path>.ld` and `<base_path>.ldx` to disk.
    bool write_files(const std::string& base_path) const;

private:
    using Row = std::array<float, kChannelCount>;
    std::size_t max_rows() const;
    double log_rate_hz() const;

    TelemetryMeta meta_;
    std::vector<Row> rows_;
    std::vector<double> beacons_;
    bool have_last_ = false;
    Row last_row_{};
    double next_t_ = 0.0;   // time of the next row on the fixed time base
    double t0_ = 0.0;       // time of the first row
};

}  // namespace rs
