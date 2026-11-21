// Engine-agnostic Sim Racing Telemetry:
//   1. Forza/SimHub-compatible 311-byte "Car Dash V2" UDP packet serializer + POSIX/Winsock UDP broadcaster
//      (drives SimHub dashboards, bass shakers/haptics, wind simulators, and motion rigs over UDP port 20777).
//   2. MoTeC i2 Pro (.ld binary + .ldx XML lap-beacon) exporter for post-race braking/suspension/tire analysis.
//
// Pure C++17, zero engine dependencies — compiles identically in standalone tests, WASM (MoTeC/packer),
// and Unreal Engine 5 C++ plugins.
#pragma once
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
    double power_w = 0.0;
    double torque_nm = 0.0;
    int gear = 1;            // 0 = R, 1 = N, 2 = 1st, ...
    double throttle = 0.0;   // 0..1
    double brake = 0.0;      // 0..1
    double clutch = 0.0;     // 0..1
    double handbrake = 0.0;  // 0..1
    double steer = 0.0;      // -1..+1

    Vec3 velocity_world{};
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
    double boost_bar = 0.0;
    double intake_air_temp_c = 28.0;
    double oil_temp_c = 85.0;
    double fuel_liters = 55.0;
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
class MotecLogger {
public:
    explicit MotecLogger(TelemetryMeta meta = {});

    void reset(TelemetryMeta meta = {});
    void record(const TelemetrySample& sample);
    void mark_lap(double lap_end_time_s);

    std::size_t sample_count() const { return samples_.size(); }
    const std::vector<double>& lap_beacons() const { return beacons_; }

    /// Build complete MoTeC i2 Pro binary `.ld` payload in memory.
    std::vector<std::uint8_t> build_ld() const;
    /// Build matching MoTeC `.ldx` XML lap-beacon sidecar file.
    std::string build_ldx() const;
    /// Write both `<base_path>.ld` and `<base_path>.ldx` to disk.
    bool write_files(const std::string& base_path) const;

private:
    TelemetryMeta meta_;
    std::vector<TelemetrySample> samples_;
    std::vector<double> beacons_;
};

}  // namespace rs
