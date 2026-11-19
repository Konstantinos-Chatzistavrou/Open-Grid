// Unit tests for SimHub/Forza UDP Telemetry output and MoTeC i2 Pro (.ld + .ldx) export.
#include <cmath>
#include <cstring>
#include "harness.hpp"
#include "rs/telemetry.hpp"

#if !defined(_WIN32)
  #include <arpa/inet.h>
  #include <netinet/in.h>
  #include <sys/socket.h>
  #include <unistd.h>
#endif

static float read_f32(const std::uint8_t* p, std::size_t off) {
    std::uint32_t bits = static_cast<std::uint32_t>(p[off]) |
                         (static_cast<std::uint32_t>(p[off + 1]) << 8) |
                         (static_cast<std::uint32_t>(p[off + 2]) << 16) |
                         (static_cast<std::uint32_t>(p[off + 3]) << 24);
    float v = 0;
    std::memcpy(&v, &bits, sizeof(v));
    return v;
}

static std::uint32_t read_u32(const std::uint8_t* p, std::size_t off) {
    return static_cast<std::uint32_t>(p[off]) |
           (static_cast<std::uint32_t>(p[off + 1]) << 8) |
           (static_cast<std::uint32_t>(p[off + 2]) << 16) |
           (static_cast<std::uint32_t>(p[off + 3]) << 24);
}

RS_TEST(telemetry) {
    using namespace rs;

    TelemetrySample s;
    s.time_s = 12.5;
    s.is_race_on = true;
    s.speed_ms = 55.0;       // 198 km/h
    s.engine_rpm = 6800.0;
    s.engine_max_rpm = 8200.0;
    s.gear = 4;              // 3rd gear (0=R,1=N,2=1st,3=2nd,4=3rd)
    s.throttle = 0.85;
    s.brake = 0.0;
    s.steer = -0.25;
    s.accel_body_mps2 = {6.5, -11.2, 0.4};
    s.susp_travel_m = {0.042, 0.058, 0.061, 0.049};
    s.susp_norm = {0.26, 0.36, 0.38, 0.31};
    s.tire_temp_c = {92.0, 96.0, 88.0, 91.0};

    // 1. SimHub/Forza Dash V2 311-byte binary packet layout
    auto pkt = pack_simhub_udp(s);
    test::check("SimHub packet size is 311 bytes", pkt.size() == 311);
    test::check("SimHub isRaceOn == 1", read_u32(pkt.data(), 0) == 1);
    test::check("SimHub RPM encoded", std::fabs(read_f32(pkt.data(), 16) - 6800.0f) < 0.1f);
    test::check("SimHub speed encoded", std::fabs(read_f32(pkt.data(), 244) - 55.0f) < 0.05f);
    test::check("SimHub FL tire temp F", std::fabs(read_f32(pkt.data(), 256) - (92.0f * 1.8f + 32.0f)) < 0.1f);
    test::check("SimHub suspension travel FL", std::fabs(read_f32(pkt.data(), 196) - 0.042f) < 1e-4f);
    test::check("SimHub gear 3rd", pkt[307] == 3);

#if !defined(_WIN32)
    // 2. Real UDP loopback transmission test
    int rx = ::socket(AF_INET, SOCK_DGRAM, 0);
    test::check("loopback rx socket created", rx >= 0);
    sockaddr_in bind_addr{};
    bind_addr.sin_family = AF_INET;
    bind_addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    bind_addr.sin_port = 0;  // ephemeral port
    test::check("loopback rx bind", ::bind(rx, reinterpret_cast<sockaddr*>(&bind_addr), sizeof(bind_addr)) == 0);
    socklen_t alen = sizeof(bind_addr);
    ::getsockname(rx, reinterpret_cast<sockaddr*>(&bind_addr), &alen);
    std::uint16_t port = ntohs(bind_addr.sin_port);

    UdpTelemetrySender tx;
    test::check("UdpTelemetrySender::open", tx.open("127.0.0.1", port));
    test::check("UdpTelemetrySender::send", tx.send(s));

    std::uint8_t rxbuf[512]{};
    ssize_t n = ::recv(rx, rxbuf, sizeof(rxbuf), 0);
    ::close(rx);
    test::check("UDP loopback received 311 bytes", n == 311);
    test::check("UDP loopback payload matches", std::memcmp(rxbuf, pkt.data(), 311) == 0);
#endif

    // 3. MoTeC i2 Pro (.ld binary + .ldx XML) exporter test
    MotecLogger logger({"TestDriver", "Vela GT", "NYC Midtown", "Time Attack", 60.0});
    for (int i = 0; i < 120; ++i) {
        TelemetrySample f = s;
        f.time_s = i / 60.0;
        f.speed_ms = 20.0 + i * 0.4;
        logger.record(f);
    }
    logger.mark_lap(2.0);
    auto ld = logger.build_ld();
    auto ldx = logger.build_ldx();
    test::check("MoTeC .ld header magic 0x40", ld.size() > 1762 && read_u32(ld.data(), 0) == 0x40u);
    std::uint32_t first_chan = read_u32(ld.data(), 0x08);
    std::uint32_t data_ptr = read_u32(ld.data(), 0x0C);
    test::check("MoTeC first channel pointer valid", first_chan == 1762);
    test::check("MoTeC channel count 18 * 120 floats", ld.size() == data_ptr + 18 * 120 * 4);
    test::check("MoTeC first sample Ground Speed km/h", std::fabs(read_f32(ld.data(), data_ptr) - 72.0f) < 0.1f);
    test::check("MoTeC .ldx contains Lap 1 beacon", ldx.find("Name=\"Lap 1\"") != std::string::npos);
}
