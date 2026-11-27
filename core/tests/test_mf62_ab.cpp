// A/B: the game's tyre (rs::magic_formula on the TireParams the game builds from a real .tir, see tir_loader.hpp) against rs::mf62 on the SAME real tyre file.
//
// rs::mf62 is validated against MFeval (test_mf62.cpp); so differences below are differences between the game's tyre and the full Magic Formula of that tyre file. They come from two
// places: the model (the game's pure-slip equations + its own combined-slip / patch code) and the MAPPING (tir_loader.hpp keeps a symmetric single-fit subset of the file: it zeroes
// terms such as PEY3, QBZ4, QDZ3, QEZ4, QHZ1/2, PHY1/2, PVY1/2, QDZ6/7, SSZ1 and replaces the combined-slip coefficients by neutral defaults). The test prints a table (docs/mf62.md
// has it) and only fails if the game's tyre is wildly off or non-finite: it is a measurement, not a tolerance on realism.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <tuple>
#include <memory>
#include "ai_lap.hpp"
#include "harness.hpp"
#include "measure.hpp"
#include "rs/config.hpp"
#include "rs/mf62.hpp"
#include "rs/tire.hpp"
#include "tir_loader.hpp"

namespace {
using namespace rs;

struct Metrics {
    double mu_y = 0, mu_x = 0, c_alpha = 0, c_kappa = 0, mz3 = 0, camber_fy = 0, load_ratio = 0;
};

TireOperating flat_op(const TireParams& p) {
    TireOperating op;
    op.slip_speed = p.lmuv_ref_mps;
    op.rolling_speed_mps = 16.6;
    op.enable_contact_patch_grid = true;
    op.enable_mf62_hybrid = false;
    return op;
}

Metrics game_metrics(const TireParams& p, double fz0) {
    const TireOperating op = flat_op(p);
    const double deg = kPi / 180.0;
    Metrics m;
    auto fy_peak = [&](double fz) { double best = 0; for (int i = 1; i <= 250; ++i) best = std::max(best, std::abs(magic_formula(p, 0.0, std::tan(i * 0.1 * deg), fz, 1.0, 0.0, op).fy)); return best / fz; };
    m.mu_y = fy_peak(fz0);
    for (int i = 1; i <= 300; ++i) m.mu_x = std::max(m.mu_x, std::abs(magic_formula(p, i * 0.001, 0.0, fz0, 1.0, 0.0, op).fx) / fz0);
    const double da = 0.25 * deg, dk = 0.002;
    m.c_alpha = std::abs(magic_formula(p, 0.0, std::tan(da), fz0, 1.0, 0.0, op).fy - magic_formula(p, 0.0, std::tan(-da), fz0, 1.0, 0.0, op).fy) / (2 * da);
    m.c_kappa = std::abs(magic_formula(p, dk, 0.0, fz0, 1.0, 0.0, op).fx - magic_formula(p, -dk, 0.0, fz0, 1.0, 0.0, op).fx) / (2 * dk);
    m.mz3 = std::abs(magic_formula(p, 0.0, std::tan(3.0 * deg), fz0, 1.0, 0.0, op).mz);
    m.camber_fy = std::abs(magic_formula(p, 0.0, 0.0, fz0, 1.0, 3.0 * deg, op).fy);
    m.load_ratio = fy_peak(1.5 * fz0) / std::max(fy_peak(0.5 * fz0), 1e-9);
    return m;
}

Metrics mf_metrics(const mf62::Params& p, double fz0) {
    const double deg = kPi / 180.0;
    auto ev = [&](double fz, double kappa, double alpha, double gamma) {
        mf62::Input in;
        in.fz = fz; in.kappa = kappa; in.alpha = alpha; in.gamma = gamma; in.vx = 16.6;
        return mf62::evaluate(p, in, mf62::modes_from_use_mode(111));
    };
    Metrics m;
    auto fy_peak = [&](double fz) { double best = 0; for (int i = 1; i <= 250; ++i) best = std::max(best, std::abs(ev(fz, 0.0, i * 0.1 * deg, 0.0).fy)); return best / fz; };
    m.mu_y = fy_peak(fz0);
    for (int i = 1; i <= 300; ++i) m.mu_x = std::max(m.mu_x, std::abs(ev(fz0, i * 0.001, 0.0, 0.0).fx) / fz0);
    const double da = 0.25 * deg, dk = 0.002;
    m.c_alpha = std::abs(ev(fz0, 0.0, da, 0.0).fy - ev(fz0, 0.0, -da, 0.0).fy) / (2 * da);
    m.c_kappa = std::abs(ev(fz0, dk, 0.0, 0.0).fx - ev(fz0, -dk, 0.0, 0.0).fx) / (2 * dk);
    m.mz3 = std::abs(ev(fz0, 0.0, 3.0 * deg, 0.0).mz);
    m.camber_fy = std::abs(ev(fz0, 0.0, 0.0, 3.0 * deg).fy);
    m.load_ratio = fy_peak(1.5 * fz0) / std::max(fy_peak(0.5 * fz0), 1e-9);
    return m;
}

RS_TEST(mf62_ab_game_tyre) {
    const std::vector<std::string> files = {"audi_245_40R18_pac2002.tir", "sedan_pac2002.tir", "suv_pac2002.tir", "classic_185_80R14_pac2002.tir", "pac2002_235_60R16.tir",
                                            "generic_pac2002.tir", "hmmwv_pac2002.tir", "polaris_pac2002.tir", "citybus_pac2002.tir", "uazbus_pac2002.tir"};
    std::printf("         game tyre / rs::mf62 on the same real .tir (nominal load, 16.6 m/s); 1.00 = identical\n");
    std::printf("         %-30s %7s %7s %8s %8s %7s %9s %9s\n", "tyre", "mu_y", "mu_x", "C_alpha", "C_kappa", "Mz 3deg", "camber Fy", "load sens");
    int tyres = 0;
    bool sane = true;
    double worst_pure = 0.0, worst_mz_lo = 1e9, worst_mz_hi = 0.0, worst_camber_lo = 1e9, worst_camber_hi = 0.0;
    for (const std::string& f : files) {
        const tirload::LoadedTir game = tirload::load_tir_file(f);
        mf62::Params p;
        std::string err;
        if (!game.loaded || !mf62::load_tir_file(test::data_path("tires/" + f), p, err)) { std::printf("         %-30s (not loaded)\n", f.c_str()); continue; }
        const double fz0 = game.fnomin * game.lfzo;
        const Metrics g = game_metrics(game.params, fz0), m = mf_metrics(p, fz0);
        auto r = [](double a, double b) { return b != 0.0 ? a / b : 0.0; };
        std::printf("         %-30s %7.3f %7.3f %8.3f %8.3f %7.3f %9.3f %9.3f   (mf62 mu_y %.2f, mu_x %.2f, C_alpha %.0f N/rad)\n", f.c_str(), r(g.mu_y, m.mu_y), r(g.mu_x, m.mu_x), r(g.c_alpha, m.c_alpha), r(g.c_kappa, m.c_kappa),
                    r(g.mz3, m.mz3), r(g.camber_fy, m.camber_fy), r(g.load_ratio, m.load_ratio), m.mu_y, m.mu_x, m.c_alpha);
        ++tyres;
        sane = sane && std::isfinite(g.mu_y) && std::isfinite(g.c_alpha) && std::isfinite(g.mz3);
        worst_pure = std::max({worst_pure, std::abs(r(g.mu_y, m.mu_y) - 1.0), std::abs(r(g.mu_x, m.mu_x) - 1.0), std::abs(r(g.c_alpha, m.c_alpha) - 1.0), std::abs(r(g.c_kappa, m.c_kappa) - 1.0),
                               std::abs(r(g.load_ratio, m.load_ratio) - 1.0) * 0.0});
        worst_mz_lo = std::min(worst_mz_lo, r(g.mz3, m.mz3)); worst_mz_hi = std::max(worst_mz_hi, r(g.mz3, m.mz3));
        worst_camber_lo = std::min(worst_camber_lo, r(g.camber_fy, m.camber_fy)); worst_camber_hi = std::max(worst_camber_hi, r(g.camber_fy, m.camber_fy));
    }
    test::check("at least 8 real tyres compared", tyres >= 8);
    test::check("the game's tyre is finite on every compared tyre", sane);
    // regression guard on what agrees today: the game's pure-slip curves are the file's (peak grip, slip stiffnesses) to a few per cent
    test::check_range("largest pure-slip difference (peak mu_y / mu_x, C_alpha, C_kappa), game vs full MF", worst_pure * 100.0, 0.0, 6.0, "%");
    std::printf("         self-aligning moment at 3 deg: game / full MF between %.2f and %.2f; camber force at 3 deg: between %.2f and %.2f (informational: the mapping drops terms, see docs/mf62.md)\n",
                worst_mz_lo, worst_mz_hi, worst_camber_lo, worst_camber_hi);
}


// The same car on the same real tyre file, once with the game's tyre model and once with rs::mf62 driving the forces (the opt-in TireParams::mf62). Radius, inertia and the load rating come
// from the car, everything else of the tyre from the file, so the only difference is the tyre model. Magazine-style numbers (measure.hpp), printed as A (game) / B (full MF).
rs::CarConfig car_on_tyre(const std::string& car_file, const std::string& tir_file, bool full_mf) {
    rs::CarConfig cfg = rs::load_car_config(test::data_path("cars/" + car_file));
    const tirload::LoadedTir lt = tirload::load_tir_file(tir_file);
    for (rs::TireParams* t : {&cfg.tire_front, &cfg.tire_rear}) {
        rs::TireParams n = lt.params;
        n.radius = t->radius;
        n.inertia = t->inertia;
        n.fz0 = t->fz0;
        n.vertical_stiffness = t->vertical_stiffness;
        if (full_mf) {
            auto m = std::make_shared<mf62::Params>();
            std::string err;
            mf62::load_tir_file(test::data_path("tires/" + tir_file), *m, err);
            n.mf62 = m;
        }
        *t = n;
    }
    return cfg;
}

RS_TEST(mf62_car_ab) {
    struct Row { double t100, brake60, skid; };
    auto run = [](const rs::CarConfig& cfg) {
        rs::sheet::Sheet sh;
        rs::sheet::launch(cfg, sh);
        return Row{sh.t100, rs::sheet::brake_60(cfg), rs::sheet::skidpad(cfg)};
    };
    std::printf("         same car, same real tyre file (Chrono Audi 245/40 R18): game tyre model (A) vs full Magic Formula rs::mf62 (B)\n");
    std::printf("         %-14s %22s %22s %22s\n", "car", "0-100 km/h  A / B s", "60-0 mph  A / B m", "skidpad  A / B g");
    bool finite = true;
    double worst = 0.0;
    for (const char* car : {"tornado_gt3.json", "kestrel_gt.json"}) {
        const Row a = run(car_on_tyre(car, "audi_245_40R18_pac2002.tir", false)), b = run(car_on_tyre(car, "audi_245_40R18_pac2002.tir", true));
        std::printf("         %-14s %10.2f / %-9.2f %10.1f / %-9.1f %10.3f / %-9.3f\n", car, a.t100, b.t100, a.brake60, b.brake60, a.skid, b.skid);
        finite = finite && std::isfinite(b.t100) && std::isfinite(b.brake60) && std::isfinite(b.skid) && b.skid > 0.3;
        worst = std::max({worst, std::abs(b.skid / a.skid - 1.0), std::abs(b.brake60 / a.brake60 - 1.0)});
    }
    test::check("the car is drivable on the full-MF tyre (finite 0-100, braking, skidpad > 0.3 g)", finite);
    std::printf("         largest skidpad / braking difference game vs full MF: %.1f %%\n", worst * 100.0);
}

// What it costs: one evaluate() call (all 30 outputs, the version 6.2 secant solve for the loaded radius) against the game's magic_formula().
RS_TEST(mf62_cost) {
    const tirload::LoadedTir lt = tirload::load_tir_file("audi_245_40R18_pac2002.tir");
    mf62::Params p;
    std::string err;
    mf62::load_tir_file(test::data_path("tires/audi_245_40R18_pac2002.tir"), p, err);
    mf62::Params p62;
    mf62::load_tir_file(test::data_path("validation/mf62/tyres/opengrid_mf62_synthetic.tir"), p62, err);
    const rs::TireOperating op = flat_op(lt.params);
    const int n = 200000;
    double sink = 0;
    auto time_ns = [&](auto&& f) {
        const auto t0 = std::chrono::steady_clock::now();
        for (int i = 0; i < n; ++i) sink += f(i);
        return std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count() / n;
    };
    const double game = time_ns([&](int i) { return magic_formula(lt.params, 0.02 * std::sin(i * 0.01), 0.1 * std::cos(i * 0.013), 4000.0 + 500.0 * std::sin(i * 0.007), 1.0, 0.02, op).fy; });
    auto mf = [&](const mf62::Params& q, int i) {
        mf62::Input in;
        in.fz = 4000.0 + 500.0 * std::sin(i * 0.007); in.kappa = 0.02 * std::sin(i * 0.01); in.alpha = 0.1 * std::cos(i * 0.013); in.gamma = 0.02; in.vx = 16.6;
        return mf62::evaluate(q, in, mf62::modes_from_use_mode(111)).fy;
    };
    const double mf52 = time_ns([&](int i) { return mf(p, i); });
    const double mf62t = time_ns([&](int i) { return mf(p62, i); });
    std::printf("         per tyre call (this machine, one core): game magic_formula %.0f ns | rs::mf62 on a PAC2002 file %.0f ns | rs::mf62 with the 6.2 secant radius %.0f ns   (sink %.1f)\n", game, mf52, mf62t, sink);
    std::printf("         x 4 wheels x 240 Hz = %.2f / %.2f / %.2f ms of tyre per simulated second\n", 4 * 240 * game * 1e-6, 4 * 240 * mf52 * 1e-6, 4 * 240 * mf62t * 1e-6);
    test::check("the full MF tyre call is finite", std::isfinite(sink));
}


// A lap: the AI driver (same one the race uses) drives a rectangle of streets with 12 m corners (the test_phase4 ai_lap course, 7 m wide) on the same car + tyre file with both tyre models.
// A lap time and the line it takes show whether the full-MF tyre changes how the car handles at the limit, not only the steady numbers above.
RS_TEST(mf62_lap_ab) {
    struct Lap { double t = 0, max_lat = 0, corner_v = 0; bool done = false; };
    auto drive = [](const rs::CarConfig& cfg) {
        const rs::Route r = ai_lap::block_route(220, 140, 12, 3.5);
        ai_lap::AICar car(cfg, r, rs::AIParams{}, {120, 0, 0}, 0, 0);
        car.sim->settle(0.5);
        Lap lap;
        double travelled = 0, last_s = car.ai->route_s;
        bool started = false;
        while (car.sim->time < 120 && travelled < r.length()) {
            car.step({});
            if (!started) { started = true; last_s = car.ai->route_s; }
            travelled += r.delta(last_s, car.ai->route_s);
            last_s = car.ai->route_s;
            const rs::Route::Projection pr = r.project(car.sim->body.state.position);
            if (car.sim->time > 3) lap.max_lat = std::max(lap.max_lat, std::abs(pr.lateral));
            if (std::abs(r.at(pr.s).curvature) > 0.05) lap.corner_v = std::max(lap.corner_v, test::speed(*car.sim));
        }
        lap.t = car.sim->time;
        lap.done = travelled >= r.length();
        return lap;
    };
    std::printf("         AI lap of the 220 x 140 m block (12 m corners), same car + same tyre file, game tyre (A) vs full Magic Formula (B)\n");
    bool both = true;
    double worst = 0;
    for (const char* car : {"tornado_gt3.json", "kestrel_gt.json"}) {
        const Lap a = drive(car_on_tyre(car, "audi_245_40R18_pac2002.tir", false)), b = drive(car_on_tyre(car, "audi_245_40R18_pac2002.tir", true));
        std::printf("         %-14s lap %.1f s / %.1f s | corner speed %.1f / %.1f km/h | max distance from the centre %.2f / %.2f m\n", car, a.t, b.t, a.corner_v * 3.6, b.corner_v * 3.6, a.max_lat, b.max_lat);
        both = both && a.done && b.done && b.max_lat < 3.5 - 0.9;
        worst = std::max(worst, std::abs(b.t / a.t - 1.0));
    }
    test::check("both tyre models complete the lap and stay on the 7 m street", both);
    test::check_range("lap-time difference game vs full MF", worst * 100.0, 0.0, 15.0, "%");
}


// The car JSON key "mf62_tir": a car file that names a tyre property file gets the full Magic Formula tyre, a car file without the key keeps the game's tyre (every shipped car).
RS_TEST(mf62_car_flag) {
    namespace fs = std::filesystem;
    const std::string src = test::data_path("cars/tornado_gt3.json");
    std::ifstream in(src);
    std::stringstream ss;
    ss << in.rdbuf();
    const std::string text = ss.str();
    test::check("the shipped Tornado GT3 has no mf62_tir (default = the game's tyre)", text.find("mf62_tir") == std::string::npos && !rs::load_car_config(src).tire_front.mf62);
    for (const char* car : {"tornado_gt3", "kestrel_gt", "vela_gt", "harrier_gt", "mistra_200t"})
        test::check((std::string(car) + ": a shipped car loads with the game's tyre").c_str(), !rs::load_car_config(test::data_path(std::string("cars/") + car + ".json")).tire_rear.mf62);

    const fs::path dir = fs::temp_directory_path() / "rs_mf62_flag" / "cars";
    fs::create_directories(dir);
    std::string abs = test::data_path("tires/audi_245_40R18_pac2002.tir");
    std::string esc;
    for (char ch : abs) { if (ch == '\\') esc += "\\\\"; else esc += ch; }
    auto with_flag = [&](const std::string& value, const std::string& name) {
        std::string t2 = text;
        for (const char* key : {"\"tire_front\": {", "\"tire_rear\": {"}) {
            const std::size_t k = t2.find(key);
            if (k != std::string::npos) t2.insert(k + std::string(key).size(), "\"mf62_tir\": \"" + value + "\",");
        }
        const fs::path f = dir / name;
        std::ofstream(f) << t2;
        return f.string();
    };
    const rs::CarConfig on = rs::load_car_config(with_flag(esc, "flag_on.json"));
    test::check("\"mf62_tir\" fills both axles' rs::mf62 tyre", on.tire_front.mf62 && on.tire_rear.mf62 && on.tire_front.mf62->fnomin > 1000.0);
    test::check("the flag changes only the tyre model: the rest of the tyre file's keys stay the car's own", on.tire_front.radius == rs::load_car_config(src).tire_front.radius);

    bool threw = false;
    try { rs::load_car_config(with_flag("/nonexistent/none.tir", "flag_bad.json")); } catch (const std::exception& e) { threw = std::string(e.what()).find("mf62_tir") != std::string::npos; }
    test::check("a missing tyre file is a clear error naming mf62_tir", threw);

    // the flagged car really drives on the other tyre (a different braking distance), and drives sanely
    const double d_game = rs::sheet::brake_60(rs::load_car_config(src)), d_mf = rs::sheet::brake_60(on);
    std::printf("         60-0 mph: shipped Tornado GT3 %.1f m, with mf62_tir = Audi 245/40 R18 %.1f m\n", d_game, d_mf);
    test::check("the flagged car brakes on the new tyre (different distance) and stays physical (15 to 120 m)", std::abs(d_mf - d_game) > 0.05 && d_mf > 15.0 && d_mf < 120.0);
    fs::remove_all(dir.parent_path());
}


// Sign conventions of the bridge in magic_formula(): the game's slip signs (tan_alpha = -vy / vx, + gamma = top toward the left) against the tyre file's ISO-W ones. The same TireParams with and
// without the full-MF tyre must push, steer and tip the same way, in every output, for slip and camber of either sign.
RS_TEST(mf62_bridge_signs) {
    const tirload::LoadedTir lt = tirload::load_tir_file("audi_245_40R18_pac2002.tir");
    rs::TireParams game = lt.params, full = lt.params;
    auto m = std::make_shared<mf62::Params>();
    std::string err;
    mf62::load_tir_file(test::data_path("tires/audi_245_40R18_pac2002.tir"), *m, err);
    full.mf62 = m;
    const rs::TireOperating op = flat_op(game);
    auto sgn = [](double v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); };
    const double fz = lt.fnomin;
    int bad = 0, checked = 0;
    std::printf("         bridge vs game tyre, same call (kappa, tan_alpha, gamma) -> signs of Fx Fy Mx Mz and the ratio of each:\n");
    struct Pt { double k, ta, g; const char* what; };
    for (const Pt& p : {Pt{0.08, 0, 0, "kappa +0.08 (drive)"}, Pt{-0.08, 0, 0, "kappa -0.08 (brake)"}, Pt{0, 0.06, 0, "tan_alpha +0.06"}, Pt{0, -0.06, 0, "tan_alpha -0.06"},
                        Pt{0, 0, 0.05, "gamma +0.05"}, Pt{0, 0, -0.05, "gamma -0.05"}, Pt{0, 0.06, 0.05, "alpha + gamma +"}, Pt{0, 0.06, -0.05, "alpha + gamma -"}}) {
        const rs::TireForces a = magic_formula(game, p.k, p.ta, fz, 1.0, p.g, op), b = magic_formula(full, p.k, p.ta, fz, 1.0, p.g, op);
        std::printf("         %-20s Fx %+7.0f/%+7.0f  Fy %+7.0f/%+7.0f  Mx %+6.1f/%+6.1f  Mz %+6.1f/%+6.1f\n", p.what, a.fx, b.fx, a.fy, b.fy, a.mx, b.mx, a.mz, b.mz);
        // the main effects must agree in sign: Fx from kappa, Fy and Mz from alpha, Fy from camber. The rest is the FILE against the game's assumed defaults and is only printed: Chrono's file has no
        // overturning-moment coefficients (Mx is 0 in the full MF tyre, ~20 N m in the game's), its combined-slip terms (RHX1, RVY*, plysteer) give a small Fx at pure alpha and Fy at pure kappa,
        // and the small camber-only Mz differs in sign.
        auto cmp = [&](double va, double vb, double big) { if (std::abs(va) > big) { ++checked; if (sgn(va) != sgn(vb)) ++bad; } };
        if (p.k != 0 && p.ta == 0 && p.g == 0) cmp(a.fx, b.fx, 200.0);
        if (p.ta != 0 && p.k == 0) { cmp(a.fy, b.fy, 200.0); if (p.g == 0) cmp(a.mz, b.mz, 20.0); }
        if (p.g != 0 && p.ta == 0) cmp(a.fy, b.fy, 100.0);
    }
    test::check("Fx (from kappa), Fy and Mz (from alpha), Fy (from camber) of the full-MF tyre have the game tyre's sign, either way", checked >= 8 && bad == 0);
}

}  // namespace
