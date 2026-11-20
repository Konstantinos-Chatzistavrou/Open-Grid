#include "rs/telemetry.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <sstream>

#if defined(__EMSCRIPTEN__)
  // Browser WASM build: UDP transport is handled by WebSocket -> tools/simhub_udp_bridge.mjs
#elif defined(_WIN32)
  #include <winsock2.h>
  #include <ws2tcpip.h>
#else
  #include <arpa/inet.h>
  #include <fcntl.h>
  #include <netinet/in.h>
  #include <sys/socket.h>
  #include <unistd.h>
#endif

namespace rs {
namespace {

constexpr double kG = 9.80665;
constexpr double kRadToDeg = 180.0 / kPi;

inline void put_u16(std::uint8_t* dst, std::size_t off, std::uint16_t v) {
    dst[off + 0] = static_cast<std::uint8_t>(v & 0xFFu);
    dst[off + 1] = static_cast<std::uint8_t>((v >> 8) & 0xFFu);
}

inline void put_u32(std::uint8_t* dst, std::size_t off, std::uint32_t v) {
    dst[off + 0] = static_cast<std::uint8_t>(v & 0xFFu);
    dst[off + 1] = static_cast<std::uint8_t>((v >> 8) & 0xFFu);
    dst[off + 2] = static_cast<std::uint8_t>((v >> 16) & 0xFFu);
    dst[off + 3] = static_cast<std::uint8_t>((v >> 24) & 0xFFu);
}

inline void put_i32(std::uint8_t* dst, std::size_t off, std::int32_t v) {
    put_u32(dst, off, static_cast<std::uint32_t>(v));
}

inline void put_f32(std::uint8_t* dst, std::size_t off, float v) {
    std::uint32_t bits = 0;
    std::memcpy(&bits, &v, sizeof(bits));
    put_u32(dst, off, bits);
}

inline void put_str(std::uint8_t* dst, std::size_t off, std::size_t cap, const std::string& s) {
    std::memset(dst + off, 0, cap);
    const std::size_t n = std::min(cap > 0 ? cap - 1 : 0, s.size());
    if (n > 0) std::memcpy(dst + off, s.data(), n);
}

inline std::uint8_t clamp_u8(double v) {
    return static_cast<std::uint8_t>(std::clamp(std::lround(v), 0L, 255L));
}

inline std::int8_t clamp_i8(double v) {
    return static_cast<std::int8_t>(std::clamp(std::lround(v), -127L, 127L));
}

}  // namespace

TelemetrySample make_telemetry_sample(
    const VehicleOutput& out,
    const ChassisState& chassis,
    const DriverInput& input,
    const CarConfig& cfg,
    double time_s,
    int lap_number,
    double current_lap_s,
    double last_lap_s,
    double best_lap_s,
    double distance_m) {
    TelemetrySample s;
    s.time_s = time_s;
    s.is_race_on = true;
    s.lap_number = lap_number;
    s.current_lap_s = current_lap_s;
    s.last_lap_s = last_lap_s;
    s.best_lap_s = best_lap_s;
    s.distance_m = distance_m;

    s.speed_ms = out.speed;
    s.engine_rpm = out.engine_rpm;
    s.engine_max_rpm = cfg.engine.redline_rpm > 0 ? cfg.engine.redline_rpm : 8000.0;
    s.engine_idle_rpm = cfg.engine.idle_rpm > 0 ? cfg.engine.idle_rpm : 900.0;
    s.gear = out.gear;
    s.throttle = out.throttle_applied;
    s.brake = out.brake_applied;
    s.clutch = input.clutch;
    s.handbrake = input.handbrake;
    s.steer = input.steer;

    s.velocity_world = chassis.velocity;
    s.angular_vel_body = chassis.orientation.inv_rotate(chassis.angular_velocity);
    s.accel_body_mps2 = out.accel;
    s.sideslip_rad = out.sideslip;

    // Extract Euler yaw/pitch/roll from Z-up quaternion
    const Quat& q = chassis.orientation;
    s.yaw_rad = std::atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z));
    const double sinp = std::clamp(2.0 * (q.w * q.y - q.z * q.x), -1.0, 1.0);
    s.pitch_rad = std::asin(sinp);
    s.roll_rad = std::atan2(2.0 * (q.w * q.x + q.y * q.z), 1.0 - 2.0 * (q.x * q.x + q.y * q.y));

    for (std::size_t i = 0; i < 4; ++i) {
        const auto& w = out.wheels[i];
        s.susp_travel_m[i] = w.compression;
        const auto& ax = cfg.axle(static_cast<int>(i));
        const double max_travel = ax.max_compression > 1e-4 ? ax.max_compression : 0.12;
        s.susp_norm[i] = std::clamp(w.compression / max_travel, 0.0, 1.0);
        s.wheel_omega_rads[i] = w.angular_velocity;
        s.tire_slip_ratio[i] = w.slip_ratio;
        s.tire_slip_angle[i] = w.slip_angle;
        s.tire_temp_c[i] = w.condition.surface_c > 0.0 ? w.condition.surface_c : w.condition.temperature_c;
        s.tire_temp_inner_c[i] = w.condition.inner_c;
        s.tire_temp_middle_c[i] = w.condition.middle_c;
        s.tire_temp_outer_c[i] = w.condition.outer_c;
        s.flat_spot_depth_mm[i] = w.condition.flat_spot_depth_mm;
        s.brake_temp_c[i] = w.brake_temp_c;
        s.wheel_load_n[i] = w.load;
    }
    s.boost_bar = out.boost_bar;
    s.intake_air_temp_c = out.intake_air_temp_c;
    s.oil_temp_c = out.oil_temp_c;
    s.fuel_liters = out.fuel_liters;
    s.slipstream_drag_scale = out.slipstream_drag_scale;
    return s;
}

std::array<std::uint8_t, kSimHubPacketBytes> pack_simhub_udp(const TelemetrySample& s) {
    // Standard Forza Motorsport / Horizon "Car Dash V2" (311 bytes) layout read natively by SimHub.
    std::array<std::uint8_t, kSimHubPacketBytes> buf{};
    auto* p = buf.data();

    put_i32(p, 0, s.is_race_on ? 1 : 0);
    put_u32(p, 4, static_cast<std::uint32_t>(std::max(0.0, s.time_s * 1000.0)));
    put_f32(p, 8, static_cast<float>(s.engine_max_rpm));
    put_f32(p, 12, static_cast<float>(s.engine_idle_rpm));
    put_f32(p, 16, static_cast<float>(s.engine_rpm));

    // Acceleration in Forza frame (X right, Y up, Z forward) from rs_core (X forward, Y left, Z up)
    put_f32(p, 20, static_cast<float>(-s.accel_body_mps2.y));
    put_f32(p, 24, static_cast<float>(s.accel_body_mps2.z));
    put_f32(p, 28, static_cast<float>(s.accel_body_mps2.x));

    // Velocity world
    put_f32(p, 32, static_cast<float>(-s.velocity_world.y));
    put_f32(p, 36, static_cast<float>(s.velocity_world.z));
    put_f32(p, 40, static_cast<float>(s.velocity_world.x));

    // Angular velocity body
    put_f32(p, 44, static_cast<float>(s.angular_vel_body.y));
    put_f32(p, 48, static_cast<float>(s.angular_vel_body.z));
    put_f32(p, 52, static_cast<float>(s.angular_vel_body.x));

    put_f32(p, 56, static_cast<float>(s.yaw_rad));
    put_f32(p, 60, static_cast<float>(s.pitch_rad));
    put_f32(p, 64, static_cast<float>(s.roll_rad));

    // Normalized suspension travel FL, FR, RL, RR (68..83)
    for (std::size_t i = 0; i < 4; ++i) put_f32(p, 68 + i * 4, static_cast<float>(s.susp_norm[i]));
    // Tire slip ratio FL..RR (84..99)
    for (std::size_t i = 0; i < 4; ++i) put_f32(p, 84 + i * 4, static_cast<float>(s.tire_slip_ratio[i]));
    // Wheel rotation speed rad/s FL..RR (100..115)
    for (std::size_t i = 0; i < 4; ++i) put_f32(p, 100 + i * 4, static_cast<float>(s.wheel_omega_rads[i]));
    // Wheel on rumble strip (116..131) + puddle depth (132..147) + surface rumble (148..163) left 0
    // Tire slip angle FL..RR (164..179)
    for (std::size_t i = 0; i < 4; ++i) put_f32(p, 164 + i * 4, static_cast<float>(s.tire_slip_angle[i]));
    // Combined slip (180..195)
    for (std::size_t i = 0; i < 4; ++i) {
        const float cs = static_cast<float>(std::hypot(s.tire_slip_ratio[i], std::sin(s.tire_slip_angle[i])));
        put_f32(p, 180 + i * 4, cs);
    }
    // Suspension travel meters FL..RR (196..211)
    for (std::size_t i = 0; i < 4; ++i) put_f32(p, 196 + i * 4, static_cast<float>(s.susp_travel_m[i]));

    // Car ordinal / class / PI / drivetrain / cylinders (212..231)
    put_i32(p, 212, 1001);
    put_i32(p, 216, 4);    // S-class
    put_i32(p, 220, 820);
    put_i32(p, 224, 1);    // RWD
    put_i32(p, 228, 8);

    // Dash V2 extension (232..310)
    // Position X,Y,Z (232..243) = 0
    put_f32(p, 244, static_cast<float>(std::fabs(s.speed_ms)));
    put_f32(p, 248, static_cast<float>(s.power_w));
    put_f32(p, 252, static_cast<float>(s.torque_nm));
    // Tire temperatures in Fahrenheit (Forza/SimHub convention): F = C * 9/5 + 32
    for (std::size_t i = 0; i < 4; ++i) {
        put_f32(p, 256 + i * 4, static_cast<float>(s.tire_temp_c[i] * 1.8 + 32.0));
    }
    put_f32(p, 272, static_cast<float>(s.boost_bar * 14.5038));  // boost (PSI in Forza Dash V2)
    put_f32(p, 276, static_cast<float>(std::clamp(s.fuel_liters / 55.0, 0.0, 1.0)));  // normalized fuel level (0..1)
    put_f32(p, 280, static_cast<float>(s.distance_m));
    put_f32(p, 284, static_cast<float>(s.best_lap_s));
    put_f32(p, 288, static_cast<float>(s.last_lap_s));
    put_f32(p, 292, static_cast<float>(s.current_lap_s));
    put_f32(p, 296, static_cast<float>(s.time_s));
    put_u16(p, 300, static_cast<std::uint16_t>(std::max(0, s.lap_number)));
    p[302] = 1;  // race position
    p[303] = clamp_u8(s.throttle * 255.0);
    p[304] = clamp_u8(s.brake * 255.0);
    p[305] = clamp_u8(s.clutch * 255.0);
    p[306] = clamp_u8(s.handbrake * 255.0);
    // Forza gear: 0 = R, 1..10 = forward gears (map rs_core 0=R, 1=N->0, 2=1st->1)
    p[307] = static_cast<std::uint8_t>(s.gear <= 1 ? 0 : std::min(10, s.gear - 1));
    p[308] = static_cast<std::uint8_t>(clamp_i8(-s.steer * 127.0));
    p[309] = 0;  // normalized driving line
    p[310] = 0;  // normalized AI brake diff
    return buf;
}

// ---- UdpTelemetrySender -------------------------------------------------------------------

UdpTelemetrySender::~UdpTelemetrySender() { close(); }

bool UdpTelemetrySender::open(const std::string& host, std::uint16_t port) {
    close();
    host_ = host;
    port_ = port;
#if defined(__EMSCRIPTEN__)
    return false;
#elif defined(_WIN32)
    WSADATA wsa{};
    WSAStartup(MAKEWORD(2, 2), &wsa);
    SOCKET s = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == INVALID_SOCKET) return false;
    u_long mode = 1;
    ioctlsocket(s, FIONBIO, &mode);
    fd_ = static_cast<int>(s);
    return true;
#else
    int s = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0) return false;
    int flags = ::fcntl(s, F_GETFL, 0);
    if (flags >= 0) ::fcntl(s, F_SETFL, flags | O_NONBLOCK);
    fd_ = s;
    return true;
#endif
}

void UdpTelemetrySender::close() {
    if (fd_ < 0) return;
#if defined(__EMSCRIPTEN__)
    fd_ = -1;
#elif defined(_WIN32)
    ::closesocket(static_cast<SOCKET>(fd_));
#else
    ::close(fd_);
#endif
    fd_ = -1;
}

bool UdpTelemetrySender::send_raw(const std::uint8_t* data, std::size_t len) {
    if (fd_ < 0 || !data || len == 0) return false;
#if defined(__EMSCRIPTEN__)
    return false;
#else
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port_);
    if (::inet_pton(AF_INET, host_.c_str(), &addr.sin_addr) != 1) return false;
#if defined(_WIN32)
    int sent = ::sendto(static_cast<SOCKET>(fd_), reinterpret_cast<const char*>(data), static_cast<int>(len), 0,
                        reinterpret_cast<const sockaddr*>(&addr), sizeof(addr));
#else
    ssize_t sent = ::sendto(fd_, data, len, 0, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr));
#endif
    return sent == static_cast<decltype(sent)>(len);
#endif
}

bool UdpTelemetrySender::send(const TelemetrySample& sample) {
    auto pkt = pack_simhub_udp(sample);
    return send_raw(pkt.data(), pkt.size());
}

// ---- MotecLogger (.ld binary + .ldx XML) --------------------------------------------------

MotecLogger::MotecLogger(TelemetryMeta meta) : meta_(std::move(meta)) {}

void MotecLogger::reset(TelemetryMeta meta) {
    meta_ = std::move(meta);
    samples_.clear();
    beacons_.clear();
}

void MotecLogger::record(const TelemetrySample& sample) {
    samples_.push_back(sample);
}

void MotecLogger::mark_lap(double lap_end_time_s) {
    beacons_.push_back(lap_end_time_s);
}

std::vector<std::uint8_t> MotecLogger::build_ld() const {
    // MoTeC i2 Pro .ld binary specification:
    //   [0x0000 .. 0x06E1]  1762-byte main file header (magic 0x0040, event/venue/vehicle metadata)
    //   [meta_ptr ..]       linked list of 124-byte channel headers
    //   [data_ptr ..]       contiguous float32 channel sample arrays (datatype 0x07, 4 bytes/sample)
    struct ChanDef {
        const char* name;
        const char* short_name;
        const char* unit;
        float (*extract)(const TelemetrySample&);
    };
    static const ChanDef kChannels[] = {
        {"Ground Speed", "Speed", "km/h", [](const TelemetrySample& s) { return static_cast<float>(std::fabs(s.speed_ms) * 3.6); }},
        {"Engine RPM", "RPM", "rpm", [](const TelemetrySample& s) { return static_cast<float>(s.engine_rpm); }},
        {"Throttle Pos", "Thr", "%", [](const TelemetrySample& s) { return static_cast<float>(s.throttle * 100.0); }},
        {"Brake Pos", "Brk", "%", [](const TelemetrySample& s) { return static_cast<float>(s.brake * 100.0); }},
        {"Steering Angle", "Steer", "deg", [](const TelemetrySample& s) { return static_cast<float>(s.steer * 360.0); }},
        {"Gear", "Gear", "", [](const TelemetrySample& s) { return static_cast<float>(s.gear - 1); }},
        {"G Force Lat", "GLat", "G", [](const TelemetrySample& s) { return static_cast<float>(s.accel_body_mps2.y / kG); }},
        {"G Force Long", "GLong", "G", [](const TelemetrySample& s) { return static_cast<float>(s.accel_body_mps2.x / kG); }},
        {"Susp Pos FL", "SuspFL", "mm", [](const TelemetrySample& s) { return static_cast<float>(s.susp_travel_m[0] * 1000.0); }},
        {"Susp Pos FR", "SuspFR", "mm", [](const TelemetrySample& s) { return static_cast<float>(s.susp_travel_m[1] * 1000.0); }},
        {"Susp Pos RL", "SuspRL", "mm", [](const TelemetrySample& s) { return static_cast<float>(s.susp_travel_m[2] * 1000.0); }},
        {"Susp Pos RR", "SuspRR", "mm", [](const TelemetrySample& s) { return static_cast<float>(s.susp_travel_m[3] * 1000.0); }},
        {"Tire Temp FL", "TTmpFL", "C", [](const TelemetrySample& s) { return static_cast<float>(s.tire_temp_c[0]); }},
        {"Tire Temp FR", "TTmpFR", "C", [](const TelemetrySample& s) { return static_cast<float>(s.tire_temp_c[1]); }},
        {"Tire Temp RL", "TTmpRL", "C", [](const TelemetrySample& s) { return static_cast<float>(s.tire_temp_c[2]); }},
        {"Tire Temp RR", "TTmpRR", "C", [](const TelemetrySample& s) { return static_cast<float>(s.tire_temp_c[3]); }},
        {"Sideslip Angle", "Slip", "deg", [](const TelemetrySample& s) { return static_cast<float>(s.sideslip_rad * kRadToDeg); }},
        {"Yaw Rate", "YawR", "deg/s", [](const TelemetrySample& s) { return static_cast<float>(s.angular_vel_body.z * kRadToDeg); }},
    };

    constexpr std::size_t kHeaderSize = 1762;
    constexpr std::size_t kChanHdrSize = 124;
    constexpr std::size_t kNumChans = sizeof(kChannels) / sizeof(kChannels[0]);
    const std::size_t n_samples = samples_.size();
    const std::uint32_t meta_ptr = static_cast<std::uint32_t>(kHeaderSize);
    const std::uint32_t data_ptr = meta_ptr + static_cast<std::uint32_t>(kNumChans * kChanHdrSize);
    const std::size_t chan_bytes = n_samples * sizeof(float);
    const std::size_t total_size = static_cast<std::size_t>(data_ptr) + kNumChans * chan_bytes;

    std::vector<std::uint8_t> out(total_size, 0);
    auto* b = out.data();

    // Main MoTeC .ld header
    put_u32(b, 0x00, 0x00000040u);   // MoTeC .ld file magic
    put_u32(b, 0x08, meta_ptr);      // first channel header pointer
    put_u32(b, 0x0C, data_ptr);      // start of raw sample data
    put_u32(b, 0x24, 0x00010000u);   // logger device marker
    put_u16(b, 0x46, 0x4240u);       // MoTeC magic2
    put_u16(b, 0x48, 0x000Fu);
    put_u16(b, 0x4A, 0x1F44u);
    put_str(b, 0x5E, 16, "01/01/2026");
    put_str(b, 0x7E, 16, "00:00:00");
    put_str(b, 0x9E, 64, meta_.driver);
    put_str(b, 0xDE, 64, meta_.vehicle);
    put_str(b, 0x15E, 64, meta_.venue);
    put_str(b, 0x19E, 64, meta_.event);

    const std::uint16_t freq = static_cast<std::uint16_t>(std::clamp(std::lround(meta_.sample_rate_hz), 1L, 1000L));
    for (std::size_t c = 0; c < kNumChans; ++c) {
        const std::uint32_t hdr_off = meta_ptr + static_cast<std::uint32_t>(c * kChanHdrSize);
        const std::uint32_t prev_ptr = c == 0 ? 0u : hdr_off - static_cast<std::uint32_t>(kChanHdrSize);
        const std::uint32_t next_ptr = (c + 1 < kNumChans) ? hdr_off + static_cast<std::uint32_t>(kChanHdrSize) : 0u;
        const std::uint32_t c_data_ptr = data_ptr + static_cast<std::uint32_t>(c * chan_bytes);

        put_u32(b, hdr_off + 0x00, prev_ptr);
        put_u32(b, hdr_off + 0x04, next_ptr);
        put_u32(b, hdr_off + 0x08, c_data_ptr);
        put_u32(b, hdr_off + 0x0C, static_cast<std::uint32_t>(n_samples));
        put_u16(b, hdr_off + 0x10, static_cast<std::uint16_t>(0x2EE1u + c));
        put_u16(b, hdr_off + 0x12, 0x0007u);  // IEEE 754 float32 datatype
        put_u16(b, hdr_off + 0x14, 0x0004u);  // 4 bytes per sample
        put_u16(b, hdr_off + 0x16, freq);
        put_u16(b, hdr_off + 0x18, 0);        // shift
        put_u16(b, hdr_off + 0x1A, 1);        // multiplier
        put_u16(b, hdr_off + 0x1C, 1);        // scale
        put_u16(b, hdr_off + 0x1E, 0);        // dec_places
        put_str(b, hdr_off + 0x20, 32, kChannels[c].name);
        put_str(b, hdr_off + 0x40, 8, kChannels[c].short_name);
        put_str(b, hdr_off + 0x48, 12, kChannels[c].unit);

        for (std::size_t i = 0; i < n_samples; ++i) {
            put_f32(b, static_cast<std::size_t>(c_data_ptr) + i * sizeof(float), kChannels[c].extract(samples_[i]));
        }
    }
    return out;
}

std::string MotecLogger::build_ldx() const {
    std::ostringstream ss;
    ss << "<?xml version=\"1.0\"?>\n"
       << "<LDXFile Locale=\"English_United States.1252\" DefaultLocale=\"C\" Version=\"1.6\">\n"
       << "  <Layers>\n"
       << "    <Layer>\n"
       << "      <MarkerBlock>\n"
       << "        <MarkerGroup Name=\"Beacons\" Index=\"" << beacons_.size() << "\">\n";
    for (std::size_t i = 0; i < beacons_.size(); ++i) {
        const long long us = static_cast<long long>(std::llround(beacons_[i] * 1e6));
        ss << "          <Marker Version=\"100\" ClassName=\"BCN\" Name=\"Lap " << (i + 1)
           << "\" Flags=\"77\" Time=\"" << us << "\"/>\n";
    }
    ss << "        </MarkerGroup>\n"
       << "      </MarkerBlock>\n"
       << "    </Layer>\n"
       << "  </Layers>\n"
       << "</LDXFile>\n";
    return ss.str();
}

bool MotecLogger::write_files(const std::string& base_path) const {
    auto ld = build_ld();
    auto ldx = build_ldx();
    std::ofstream f_ld(base_path + ".ld", std::ios::binary);
    if (!f_ld) return false;
    f_ld.write(reinterpret_cast<const char*>(ld.data()), static_cast<std::streamsize>(ld.size()));
    std::ofstream f_ldx(base_path + ".ldx");
    if (!f_ldx) return false;
    f_ldx << ldx;
    return f_ld.good() && f_ldx.good();
}

}  // namespace rs
