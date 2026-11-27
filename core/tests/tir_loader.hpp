// Apache-2.0 - the game's .tir -> rs::TireParams mapping (symmetric single-fit tyre, ISO-W -> OpenGrid sign conventions, mirrors tools/tir2car.mjs), shared by
// test_tire_library.cpp and test_mf62_ab.cpp. Loads real .tir files verbatim from data/tires/.
#pragma once
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <map>
#include <string>
#include "harness.hpp"
#include "rs/tire.hpp"

namespace tirload {
using namespace rs;

struct LoadedTir {
    std::string filename;
    std::string format;
    double fnomin = 4000.0;
    double lfzo = 1.0;
    TireParams params{};
    bool loaded = false;
};

inline std::string trim_str(const std::string& s) {
    std::size_t a = 0;
    while (a < s.size() && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
    std::size_t b = s.size();
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
    return s.substr(a, b - a);
}

inline std::string strip_quotes(const std::string& s) {
    if (s.size() >= 2 && ((s.front() == '\'' && s.back() == '\'') || (s.front() == '"' && s.back() == '"'))) {
        return trim_str(s.substr(1, s.size() - 2));
    }
    return s;
}

// Lightweight Pacejka PAC2002 / MF_05 .tir parser mirroring tools/tir2car.mjs sign & symmetry conventions.
inline LoadedTir load_tir_file(const std::string& rel_filename) {
    LoadedTir out;
    out.filename = rel_filename;
    std::ifstream in(test::data_path("tires/" + rel_filename));
    if (!in) return out;

    std::map<std::string, double> num;
    std::map<std::string, std::string> str;
    std::string line;
    while (std::getline(in, line)) {
        const std::size_t cpos = line.find_first_of("$!");
        if (cpos != std::string::npos) line.resize(cpos);
        const std::size_t eq = line.find('=');
        if (eq == std::string::npos) continue;

        std::string key = trim_str(line.substr(0, eq));
        std::string val = strip_quotes(trim_str(line.substr(eq + 1)));
        if (key.empty() || val.empty()) continue;
        for (char& ch : key) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));

        char* endp = nullptr;
        const double d = std::strtod(val.c_str(), &endp);
        if (endp != val.c_str() && *endp == '\0' && std::isfinite(d)) {
            num[key] = d;
        } else {
            str[key] = val;
        }
    }

    auto g = [&](const char* k, double def = 0.0) -> double {
        auto it = num.find(k);
        return it != num.end() ? it->second : def;
    };
    auto L = [&](const char* k) -> double { return g(k, 1.0); };

    out.format = str.count("PROPERTY_FILE_FORMAT") ? str["PROPERTY_FILE_FORMAT"] : "UNKNOWN";
    out.fnomin = g("FNOMIN", 4000.0);
    out.lfzo = L("LFZO");

    TireParams p;
    p.radius = g("UNLOADED_RADIUS", 0.33);
    p.fz0 = out.fnomin * out.lfzo;
    p.vertical_stiffness = g("VERTICAL_STIFFNESS", 220000.0);
    p.vertical_damping = g("VERTICAL_DAMPING", 2000.0);
    p.section_width_m = g("WIDTH", 0.245);
    p.aspect_ratio = g("ASPECT_RATIO", 0.40);
    p.breff = g("BREFF", 8.4);
    p.dreff = g("DREFF", 0.27);
    p.freff = g("FREFF", 0.07);
    p.mbelt = g("MBELT", 5.4);

    // Longitudinal (pure slip)
    const double pdx1 = g("PDX1", 1.0);
    p.cx = g("PCX1", 1.65) * L("LCX");
    p.mu_x = std::abs(pdx1) * L("LMUX");
    p.pdx2 = (std::abs(pdx1) > 1e-9) ? (g("PDX2") / pdx1) : 0.0;
    p.pdx3 = g("PDX3");
    p.ex = g("PEX1") * L("LEX");
    p.pex2 = g("PEX2");
    p.pex3 = g("PEX3");
    p.pex4 = g("PEX4");
    p.kx = g("PKX1", 20.0) * L("LKX");
    p.pkx2 = g("PKX2");
    p.pkx3 = g("PKX3");
    p.phx1 = 0.0;
    p.phx2 = 0.0;
    p.pvx1 = 0.0;
    p.pvx2 = 0.0;

    // Lateral (pure slip + camber; ISO-W -> OpenGrid sign mapping, MF_05 PDY1<0 normalized via |PDY1|)
    const double pdy1 = g("PDY1", 1.0);
    p.cy = g("PCY1", 1.3) * L("LCY");
    p.mu_y = std::abs(pdy1) * L("LMUY");
    p.pdy2 = (std::abs(pdy1) > 1e-9) ? (g("PDY2") / pdy1) : 0.0;
    p.pdy3 = g("PDY3");
    p.ey = g("PEY1") * L("LEY");
    p.pey2 = g("PEY2");
    p.pey3 = 0.0;
    p.pey4 = g("PEY4");
    p.pky1 = std::abs(g("PKY1", -15.0)) * L("LKY");
    p.pky2 = g("PKY2", 2.0);
    p.pky3 = g("PKY3");
    p.phy1 = 0.0;
    p.phy2 = 0.0;
    p.phy3 = g("PHY3");
    p.pvy1 = 0.0;
    p.pvy2 = 0.0;
    p.pvy3 = -g("PVY3");
    p.pvy4 = -g("PVY4");

    // Self-aligning moment Mz (mirror-symmetric single-fit mapping)
    p.qbz1 = g("QBZ1", 10.0);
    p.qbz2 = g("QBZ2");
    p.qbz3 = g("QBZ3");
    p.qbz4 = 0.0;
    p.qbz5 = g("QBZ5");
    p.qcz1 = g("QCZ1", 1.1);
    p.qdz1 = g("QDZ1", 0.1);
    p.qdz2 = g("QDZ2");
    p.qdz3 = 0.0;
    p.qdz4 = g("QDZ4");
    p.qez1 = g("QEZ1");
    p.qez2 = g("QEZ2");
    p.qez3 = g("QEZ3");
    p.qez4 = 0.0;
    p.qez5 = g("QEZ5");
    p.qhz1 = 0.0;
    p.qhz2 = 0.0;
    p.qhz3 = g("QHZ3");
    p.qhz4 = g("QHZ4");
    p.qbz9 = g("QBZ9");
    p.qbz10 = g("QBZ10");
    p.qdz6 = 0.0;
    p.qdz7 = 0.0;
    p.qdz8 = -g("QDZ8");
    p.qdz9 = -g("QDZ9");
    p.ssz1 = 0.0;
    p.ssz2 = g("SSZ2");
    p.ssz3 = -g("SSZ3");
    p.ssz4 = -g("SSZ4");

    // Neutral combined-slip defaults (matches mf_dump pure-slip evaluation)
    p.rbx1 = 10.0; p.rbx2 = 0.0; p.rbx3 = 0.0; p.rcx1 = 1.0; p.rex1 = 0.0; p.rex2 = 0.0; p.rhx1 = 0.0;
    p.rby1 = 10.0; p.rby2 = 0.0; p.rby3 = 0.0; p.rby4 = 0.0; p.rcy1 = 1.0; p.rey1 = 0.0; p.rey2 = 0.0;
    p.rhy1 = 0.0;  p.rhy2 = 0.0; p.rvy1 = 0.0; p.rvy2 = 0.0; p.rvy3 = 0.0; p.rvy4 = 0.0; p.rvy5 = 0.0; p.rvy6 = 0.0;

    out.params = p;
    out.loaded = num.count("PDX1") > 0 && num.count("PDY1") > 0 && num.count("PKY1") > 0;
    return out;
}

}  // namespace tirload
