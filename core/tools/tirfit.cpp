// Apache-2.0 - Magic Formula coefficient fitting (see rs/tirfit.hpp).
#include "rs/tirfit.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <sstream>

namespace rs::tirfit {
namespace {

using Member = double mf62::Params::*;

const std::map<std::string, Member>& coeff_table() {
    static const std::map<std::string, Member> t = [] {
        std::map<std::string, Member> m;
#define RS_TIRFIT_ENTRY(field, key, def) m[key] = &mf62::Params::field;
        RS_MF62_COEFFS(RS_TIRFIT_ENTRY)
#undef RS_TIRFIT_ENTRY
        return m;
    }();
    return t;
}

std::string trim(const std::string& s) {
    std::size_t a = 0, b = s.size();
    while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
    return s.substr(a, b - a);
}

std::string lower(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

std::string upper(std::string s) {
    for (char& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return s;
}

// ------------------------------------------------------------------------------------------------ bounds

// Box bounds per coefficient: physical ranges of Pacejka's coefficients, wide enough for real tyres, tight enough that a bad start cannot wander into nonsense. Shape factors E stay <= 1.
void bounds_for(const std::string& k, double x0, double& lo, double& hi) {
    lo = -100.0;
    hi = 100.0;
    auto in = [&](std::initializer_list<const char*> ks) {
        for (const char* s : ks) if (k == s) return true;
        return false;
    };
    if (in({"PCX1", "PCY1", "RCX1", "RCY1", "QCZ1"})) { lo = 0.3; hi = 3.0; }
    else if (in({"PDX1", "PDY1"})) { lo = 0.05; hi = 6.0; }
    else if (in({"PDX2", "PDY2"})) { lo = -2.0; hi = 2.0; }
    else if (in({"PDX3", "PDY3"})) { lo = -10.0; hi = 10.0; }
    else if (in({"PEX1", "PEY1", "REX1", "REY1", "QEZ1"})) { lo = -50.0; hi = 1.0; }
    else if (in({"PEX2", "PEX3", "PEY2", "REX2", "REY2", "QEZ2", "QEZ3"})) { lo = -50.0; hi = 50.0; }
    else if (in({"PEX4", "PEY3"})) { lo = -5.0; hi = 5.0; }
    else if (in({"PKX1"})) { lo = 0.5; hi = 500.0; }
    else if (in({"PKX2"})) { lo = -100.0; hi = 100.0; }
    else if (in({"PKX3"})) { lo = -10.0; hi = 10.0; }
    else if (in({"PKY1"})) { if (x0 < 0) { lo = -500.0; hi = -0.5; } else { lo = 0.5; hi = 500.0; } }
    else if (in({"PKY2"})) { lo = 0.05; hi = 30.0; }
    else if (in({"PKY3"})) { lo = -5.0; hi = 5.0; }
    else if (in({"PKY4"})) { lo = 0.5; hi = 10.0; }
    else if (in({"PHX1", "PHY1", "RHX1"})) { lo = -0.2; hi = 0.2; }
    else if (in({"PHX2", "PHY2", "PVX1", "PVX2", "PVY1", "PVY2", "RHY1", "QHZ1", "QHZ2"})) { lo = -0.5; hi = 0.5; }
    else if (in({"PHY3", "PVY3", "PVY4", "RHY2", "RVY1", "RVY2", "QHZ3", "QHZ4", "QDZ1", "QDZ2", "QDZ6", "QDZ7"})) { lo = -3.0; hi = 3.0; }
    else if (in({"QDZ8", "QDZ9"})) { lo = -3.0; hi = 3.0; }
    else if (in({"QBZ1"})) { lo = 0.5; hi = 60.0; }
    else if (in({"RBX1", "RBY1"})) { lo = 1.0; hi = 100.0; }
    else if (in({"RBX3", "RBY3", "PPX1", "PPX2", "PPX3", "PPX4", "PPY1", "PPY2", "PPY3", "PPY4", "PPY5"})) { lo = -5.0; hi = 5.0; }
    else if (in({"RVY3"})) { lo = -3.0; hi = 3.0; }
}

// ------------------------------------------------------------------------------------------------ coefficient groups per stage

void append(std::vector<std::string>& v, std::initializer_list<const char*> ks) {
    for (const char* k : ks) v.emplace_back(k);
}

}  // namespace

std::vector<std::string> stage_keys(const std::string& stage, bool camber, bool pressure, mf62::Version version) {
    const bool six = version != mf62::Version::Mf52;
    std::vector<std::string> k;
    if (stage == "fx0") {
        append(k, {"PCX1", "PDX1", "PDX2", "PEX1", "PEX2", "PEX3", "PEX4", "PKX1", "PKX2", "PKX3", "PHX1", "PHX2", "PVX1", "PVX2"});
        if (camber) append(k, {"PDX3"});
        if (pressure && six) append(k, {"PPX1", "PPX2", "PPX3", "PPX4"});
    } else if (stage == "fy0") {
        append(k, {"PCY1", "PDY1", "PDY2", "PEY1", "PEY2", "PEY3", "PKY1", "PKY2", "PHY1", "PHY2", "PVY1", "PVY2"});
        if (six) append(k, {"PKY4"});
        if (camber) {
            append(k, {"PDY3", "PEY4", "PKY3", "PHY3", "PVY3", "PVY4"});
            if (six) append(k, {"PEY5", "PKY5", "PKY6", "PKY7"});
        }
        if (pressure && six) append(k, {"PPY1", "PPY2", "PPY3", "PPY4", "PPY5"});
    } else if (stage == "mz0") {
        append(k, {"QBZ1", "QBZ2", "QBZ3", "QBZ9", "QBZ10", "QCZ1", "QDZ1", "QDZ2", "QDZ6", "QDZ7", "QEZ1", "QEZ2", "QEZ3", "QHZ1", "QHZ2"});
        if (camber) append(k, {"QBZ4", "QBZ5", "QDZ3", "QDZ4", "QDZ8", "QDZ9", "QEZ4", "QEZ5", "QHZ3", "QHZ4"});
    } else if (stage == "fx") {
        append(k, {"RBX1", "RBX2", "RCX1", "REX1", "REX2", "RHX1"});
        if (camber) append(k, {"RBX3"});
    } else if (stage == "fy") {
        append(k, {"RBY1", "RBY2", "RBY3", "RCY1", "REY1", "REY2", "RHY1", "RHY2", "RVY1", "RVY2", "RVY4", "RVY5", "RVY6"});
        if (camber) append(k, {"RBY4", "RVY3"});
    }
    return k;
}

bool get_coefficient(const mf62::Params& p, const std::string& key, double& value) {
    const auto it = coeff_table().find(upper(key));
    if (it == coeff_table().end()) return false;
    value = p.*(it->second);
    return true;
}

bool set_coefficient(mf62::Params& p, const std::string& key, double value) {
    const auto it = coeff_table().find(upper(key));
    if (it == coeff_table().end()) return false;
    p.*(it->second) = value;
    return true;
}

// ------------------------------------------------------------------------------------------------ CSV

bool read_csv(const std::string& text, std::vector<Sample>& out, std::string& error, double angle_sign) {
    out.clear();
    std::istringstream in(text);
    std::string line;
    std::vector<std::string> head;
    char delim = ',';
    enum Col { Fz, Kappa, Alpha, AlphaDeg, Gamma, GammaDeg, Vx, Pres, PresKpa, Fx, Fy, Mz, Mx, Unknown };
    std::vector<Col> cols;
    std::vector<double> mult;  // unit conversion to the internal unit of each column
    auto split = [&](const std::string& s) {
        std::vector<std::string> f;
        std::string cur;
        for (char c : s) {
            if (c == delim) { f.push_back(trim(cur)); cur.clear(); }
            else cur += c;
        }
        f.push_back(trim(cur));
        return f;
    };
    // "SA [deg]" -> name "sa", unit "deg"; a unit may also be a name suffix (alpha_deg)
    auto normalise = [](const std::string& s, std::string& unit) {
        std::string r;
        int depth = 0;
        unit.clear();
        for (char c : s) {
            if (c == '(' || c == '[') { ++depth; continue; }
            if (c == ')' || c == ']') { if (depth > 0) --depth; continue; }
            if (depth == 0) r += c; else unit += c;
        }
        unit = lower(trim(unit));
        r = lower(trim(r));
        for (char& c : r) if (c == ' ' || c == '-') c = '_';
        return r;
    };
    int lineno = 0;
    bool have_head = false;
    while (std::getline(in, line)) {
        ++lineno;
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const std::string t = trim(line);
        if (t.empty() || t[0] == '#') continue;
        if (!have_head) {
            delim = t.find('\t') != std::string::npos ? '\t' : (t.find(';') != std::string::npos ? ';' : ',');
            head = split(t);
            for (const std::string& h : head) {
                std::string unit;
                const std::string n = normalise(h, unit);
                Col c = Unknown;
                double m = 1.0;
                if (n == "fz" || n == "load" || n == "fz_n") c = Fz;
                else if (n == "kappa" || n == "sl" || n == "slip_ratio" || n == "sr") c = Kappa;
                else if (n == "alpha" || n == "sa" || n == "slip_angle") c = Alpha;
                else if (n == "alpha_deg" || n == "sa_deg" || n == "slip_angle_deg") c = AlphaDeg;
                else if (n == "gamma" || n == "ia" || n == "camber" || n == "inclination") c = Gamma;
                else if (n == "gamma_deg" || n == "ia_deg" || n == "camber_deg" || n == "inclination_deg") c = GammaDeg;
                else if (n == "vx" || n == "speed" || n == "v" || n == "velocity") c = Vx;
                else if (n == "pressure" || n == "p" || n == "pressure_pa") c = Pres;
                else if (n == "pressure_kpa" || n == "p_kpa") c = PresKpa;
                else if (n == "fx") c = Fx;
                else if (n == "fy") c = Fy;
                else if (n == "mz") c = Mz;
                else if (n == "mx") c = Mx;
                // a bracketed unit turns the plain names into their degree / kPa / km/h forms; one we do not know is refused (a silent wrong unit would corrupt the fit)
                if ((c == Alpha || c == Gamma) && (unit == "deg" || unit == "degree" || unit == "degrees" || unit == "\xc2\xb0")) c = (c == Alpha ? AlphaDeg : GammaDeg);
                if (c == Pres && unit == "kpa") c = PresKpa;
                if (c == Pres && unit == "bar") m = 1e5;
                if (c == Pres && unit == "psi") m = 6894.757;
                if (c == Vx && (unit == "km/h" || unit == "kph" || unit == "kmh")) m = 1.0 / 3.6;
                if (c == Vx && unit == "mph") m = 0.44704;
                const bool known_unit = unit.empty() || unit == "n" || unit == "nm" || unit == "n.m" || unit == "n*m" || unit == "rad" || unit == "-" || unit == "m/s" || unit == "pa" || unit == "kpa" || unit == "deg" ||
                                        unit == "degree" || unit == "degrees" || unit == "\xc2\xb0" || unit == "bar" || unit == "psi" || unit == "km/h" || unit == "kph" || unit == "kmh" || unit == "mph" || c == Unknown;
                if (!known_unit) { error = "column '" + trim(h) + "': unit '" + unit + "' is not understood (use N, Nm, rad or deg, Pa / kPa / bar / psi, m/s or km/h)"; return false; }
                if ((c == Fz || c == Fx || c == Fy) && (unit == "kn")) { error = "column '" + trim(h) + "': give forces in N"; return false; }
                cols.push_back(c);
                mult.push_back(m);
            }
            bool has_fz = false, has_force = false;
            for (Col c : cols) { has_fz = has_fz || c == Fz; has_force = has_force || c == Fx || c == Fy || c == Mz || c == Mx; }
            if (!has_fz || !has_force) { error = "the header needs an Fz column and at least one of Fx, Fy, Mz, Mx"; return false; }
            have_head = true;
            continue;
        }
        const std::vector<std::string> f = split(t);
        if (f.size() != cols.size()) { error = "line " + std::to_string(lineno) + ": " + std::to_string(f.size()) + " fields, the header has " + std::to_string(cols.size()); return false; }
        Sample s;
        for (std::size_t i = 0; i < cols.size(); ++i) {
            if (cols[i] == Unknown) continue;
            double v = kNaN;
            if (!f[i].empty() && lower(f[i]) != "nan") {
                char* end = nullptr;
                v = std::strtod(f[i].c_str(), &end);
                if (end == f[i].c_str() || *end != '\0') { error = "line " + std::to_string(lineno) + ": '" + f[i] + "' is not a number"; return false; }
            }
            const bool slip = cols[i] == Kappa || cols[i] == Alpha || cols[i] == AlphaDeg || cols[i] == Gamma || cols[i] == GammaDeg || cols[i] == Vx || cols[i] == Pres || cols[i] == PresKpa;
            if (slip && std::isnan(v)) v = 0.0;
            v *= mult[i];
            switch (cols[i]) {
                case Fz: s.fz = std::abs(v); break;
                case Kappa: s.kappa = v; break;
                case Alpha: s.alpha = angle_sign * v; break;
                case AlphaDeg: s.alpha = angle_sign * v * 3.14159265358979323846 / 180.0; break;
                case Gamma: s.gamma = angle_sign * v; break;
                case GammaDeg: s.gamma = angle_sign * v * 3.14159265358979323846 / 180.0; break;
                case Vx: s.vx = v; break;
                case Pres: s.pressure = v; break;
                case PresKpa: s.pressure = v * 1000.0; break;
                case Fx: s.fx = v; break;
                case Fy: s.fy = v; break;
                case Mz: s.mz = v; break;
                case Mx: s.mx = v; break;
                default: break;
            }
        }
        if (std::isnan(s.fz) || s.fz <= 0.0) { error = "line " + std::to_string(lineno) + ": Fz must be a positive load"; return false; }
        out.push_back(s);
    }
    if (!have_head) { error = "no header line"; return false; }
    if (out.empty()) { error = "no data rows"; return false; }
    return true;
}

// ------------------------------------------------------------------------------------------------ least squares

namespace {

struct Problem {
    mf62::Params base;
    std::vector<Member> mem;
    std::vector<mf62::Input> in;
    std::vector<double> y;
    int channel = 0;  // 0 Fx, 1 Fy, 2 Mz
    double sigma = 1.0;
    mf62::Modes modes;
    std::vector<double> lo, hi, x0, scale;
    std::vector<char> lo_soft, hi_soft;  // a bound that was widened to the starting value: not reported as 'on a bound'
    double reg = 0.0;  // weight of the pull towards x0
};

double pick(const mf62::Output& o, int ch) { return ch == 0 ? o.fx : (ch == 1 ? o.fy : o.mz); }

void residuals(const Problem& pr, const std::vector<double>& x, std::vector<double>& r) {
    mf62::Params p = pr.base;
    for (std::size_t j = 0; j < x.size(); ++j) p.*(pr.mem[j]) = x[j];
    r.resize(pr.in.size());
    for (std::size_t i = 0; i < pr.in.size(); ++i) {
        const double v = pick(mf62::evaluate(p, pr.in[i], pr.modes), pr.channel);
        r[i] = std::isfinite(v) ? (v - pr.y[i]) / pr.sigma : 1e3;
    }
}

double cost_of(const Problem& pr, const std::vector<double>& x, const std::vector<double>& r) {
    double c = 0;
    for (double v : r) c += v * v;
    for (std::size_t j = 0; j < x.size(); ++j) {
        const double d = (x[j] - pr.x0[j]) / pr.scale[j];
        c += pr.reg * d * d;
    }
    return c;
}

// solve A x = b (n x n, row-major) by Gaussian elimination with partial pivoting
bool solve(std::vector<double> A, std::vector<double> b, std::vector<double>& x) {
    const std::size_t n = b.size();
    for (std::size_t c = 0; c < n; ++c) {
        std::size_t piv = c;
        for (std::size_t r = c + 1; r < n; ++r) if (std::abs(A[r * n + c]) > std::abs(A[piv * n + c])) piv = r;
        if (std::abs(A[piv * n + c]) < 1e-300) return false;
        if (piv != c) { for (std::size_t k = 0; k < n; ++k) std::swap(A[c * n + k], A[piv * n + k]); std::swap(b[c], b[piv]); }
        for (std::size_t r = c + 1; r < n; ++r) {
            const double f = A[r * n + c] / A[c * n + c];
            if (f == 0.0) continue;
            for (std::size_t k = c; k < n; ++k) A[r * n + k] -= f * A[c * n + k];
            b[r] -= f * b[c];
        }
    }
    x.assign(n, 0.0);
    for (std::size_t i = n; i-- > 0;) {
        double s = b[i];
        for (std::size_t k = i + 1; k < n; ++k) s -= A[i * n + k] * x[k];
        x[i] = s / A[i * n + i];
    }
    return true;
}

// J (columns) by forward differences from the residuals r0 at x (the model is smooth; half the cost of central differences, and Levenberg-Marquardt does not need more)
void jacobian(const Problem& pr, const std::vector<double>& x, const std::vector<double>& r0, std::vector<std::vector<double>>& J) {
    const std::size_t n = x.size();
    J.assign(n, {});
    std::vector<double> xp = x, rp;
    for (std::size_t j = 0; j < n; ++j) {
        const double h = 1e-7 * std::max(std::abs(x[j]), 0.01 * pr.scale[j]);
        xp[j] = x[j] + h;
        residuals(pr, xp, rp);
        xp[j] = x[j];
        J[j].resize(rp.size());
        for (std::size_t i = 0; i < rp.size(); ++i) J[j][i] = (rp[i] - r0[i]) / h;
    }
}

struct LmResult {
    std::vector<double> x;
    double cost = 1e300;
    int iterations = 0;
    bool converged = false;
};

LmResult levenberg_marquardt(const Problem& pr, std::vector<double> x, int max_iter) {
    const std::size_t n = x.size();
    LmResult res;
    for (std::size_t j = 0; j < n; ++j) x[j] = std::clamp(x[j], pr.lo[j], pr.hi[j]);
    std::vector<double> r;
    residuals(pr, x, r);
    double cost = cost_of(pr, x, r);
    double lambda = 1e-3;
    int stalled = 0;
    std::vector<std::vector<double>> J;
    for (int it = 0; it < max_iter; ++it) {
        res.iterations = it + 1;
        jacobian(pr, x, r, J);
        std::vector<double> A(n * n, 0.0), g(n, 0.0);
        for (std::size_t a = 0; a < n; ++a) {
            for (std::size_t b = a; b < n; ++b) {
                double s = 0;
                for (std::size_t i = 0; i < r.size(); ++i) s += J[a][i] * J[b][i];
                A[a * n + b] = A[b * n + a] = s;
            }
            double s = 0;
            for (std::size_t i = 0; i < r.size(); ++i) s += J[a][i] * r[i];
            const double inv_s2 = 1.0 / (pr.scale[a] * pr.scale[a]);
            A[a * n + a] += pr.reg * inv_s2;
            g[a] = s + pr.reg * (x[a] - pr.x0[a]) * inv_s2;
        }
        bool accepted = false;
        for (int attempt = 0; attempt < 30; ++attempt) {
            std::vector<double> M = A, rhs(n), dx;
            for (std::size_t a = 0; a < n; ++a) { M[a * n + a] += lambda * std::max(A[a * n + a], 1e-12); rhs[a] = -g[a]; }
            if (!solve(M, rhs, dx)) { lambda *= 10.0; continue; }
            std::vector<double> xn(n);
            for (std::size_t a = 0; a < n; ++a) xn[a] = std::clamp(x[a] + dx[a], pr.lo[a], pr.hi[a]);
            std::vector<double> rn;
            residuals(pr, xn, rn);
            const double cn = cost_of(pr, xn, rn);
            if (std::isfinite(cn) && cn < cost) {
                double step = 0;
                for (std::size_t a = 0; a < n; ++a) step = std::max(step, std::abs(xn[a] - x[a]) / pr.scale[a]);
                const double drop = (cost - cn) / std::max(cost, 1e-300);
                x = xn; r = rn; cost = cn;
                lambda = std::max(lambda / 3.0, 1e-12);
                accepted = true;
                stalled = (drop < 1e-9 || step < 1e-9) ? stalled + 1 : 0;
                if (stalled >= 2) res.converged = true;
                break;
            }
            lambda *= 4.0;
        }
        if (!accepted) { res.converged = true; break; }  // no step lowers the cost: a minimum (within the bounds)
        if (res.converged) break;
    }
    res.x = x;
    res.cost = cost;
    return res;
}

// ------------------------------------------------------------------------------------------------ stages

struct Spec {
    std::string name;
    int channel;
    const char* peak_key;   // scaled by the data / template magnitude ratio before the fit
    const char* stiff_key;  // restarted at several factors
};

bool pure_x(const Sample& s) { return std::abs(s.alpha) <= 0.003; }
bool pure_y(const Sample& s) { return std::abs(s.kappa) <= 0.003; }
bool combined(const Sample& s) { return std::abs(s.alpha) > 0.003 && std::abs(s.kappa) > 0.003; }

// ---- data-driven first guess for the pure-slip stages: peak grip and initial slope at each measured load, regressed onto the load coefficients (PDX1 PDX2 PKX1 PKX2 / PDY1 PDY2 PKY1 PKY2).
// Local least squares from a template that is far from the data (a truck tyre fitted from a car tyre) can settle in a nonsense minimum; this puts the start where the data's two dominant features are right.
struct LoadBin { double fz = 0, peak = 0, sxy = 0, sxx = 0; int n = 0, nlin = 0; };

bool linreg(const std::vector<double>& x, const std::vector<double>& y, double& a, double& b) {  // y = a + b x
    const std::size_t n = x.size();
    if (n == 0) return false;
    if (n == 1) { a = y[0]; b = 0.0; return true; }
    double sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (std::size_t i = 0; i < n; ++i) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
    const double den = static_cast<double>(n) * sxx - sx * sx;
    if (std::abs(den) < 1e-12) { a = sy / static_cast<double>(n); b = 0.0; return true; }
    b = (static_cast<double>(n) * sxy - sx * sy) / den;
    a = (sy - b * sx) / static_cast<double>(n);
    return true;
}

bool data_driven_start(const Problem& pr, const std::vector<std::string>& keys, const mf62::Params& cur, std::vector<double>& x) {
    const bool lateral = pr.channel == 1;
    if (pr.channel == 2) return false;
    // bins of equal load (3 %), rows at (almost) zero camber if there are any
    bool any_flat = false;
    for (const auto& in : pr.in) any_flat = any_flat || std::abs(in.gamma) < 0.0087;
    std::vector<LoadBin> bins;
    for (std::size_t i = 0; i < pr.in.size(); ++i) {
        const mf62::Input& in = pr.in[i];
        if (any_flat && std::abs(in.gamma) >= 0.0087) continue;
        LoadBin* b = nullptr;
        for (LoadBin& c : bins) if (std::abs(c.fz - in.fz) <= 0.03 * c.fz) { b = &c; break; }
        if (!b) { bins.push_back({}); b = &bins.back(); b->fz = in.fz; }
        const double slip = lateral ? in.alpha : in.kappa;
        b->peak = std::max(b->peak, std::abs(pr.y[i]));
        ++b->n;
        if (std::abs(slip) > 0 && std::abs(slip) <= 0.02) { b->sxy += pr.y[i] * slip; b->sxx += slip * slip; ++b->nlin; }
    }
    const double fz0 = cur.fnomin * cur.lfzo;
    std::vector<double> dfz, mu, fzs, slope;
    for (const LoadBin& b : bins) {
        if (b.n < 5 || b.peak <= 0) continue;
        dfz.push_back((b.fz - fz0) / fz0);
        fzs.push_back(b.fz);
        mu.push_back(b.peak / b.fz);
        slope.push_back(b.nlin >= 3 && b.sxx > 0 ? b.sxy / b.sxx : kNaN);
    }
    if (dfz.empty()) return false;
    auto idx = [&](const char* k) -> int {
        for (std::size_t j = 0; j < keys.size(); ++j) if (keys[j] == k) return static_cast<int>(j);
        return -1;
    };
    auto put = [&](const char* k, double v) { const int j = idx(k); if (j >= 0) x[static_cast<std::size_t>(j)] = std::clamp(v, pr.lo[static_cast<std::size_t>(j)], pr.hi[static_cast<std::size_t>(j)]); };
    double a = 0, b = 0;
    if (!linreg(dfz, mu, a, b)) return false;
    put(lateral ? "PDY1" : "PDX1", a);
    if (dfz.size() >= 2) put(lateral ? "PDY2" : "PDX2", b);
    // stiffness
    std::vector<double> dk, kk, fk, sk;
    for (std::size_t i = 0; i < dfz.size(); ++i) if (std::isfinite(slope[i])) { dk.push_back(dfz[i]); fk.push_back(fzs[i]); sk.push_back(slope[i]); }
    if (dk.empty()) return true;
    if (!lateral) {
        const double pkx3 = cur.pkx3;
        std::vector<double> k;
        for (std::size_t i = 0; i < dk.size(); ++i) k.push_back(sk[i] / fk[i] / std::exp(pkx3 * dk[i]));
        if (linreg(dk, k, a, b)) { put("PKX1", a); if (dk.size() >= 2) put("PKX2", b); }
    } else {
        // Kya = PKY1 Fz0 sin(e atan(Fz / (PKY2 Fz0))): closed form for PKY1 at each PKY2 on a grid, the best PKY2 wins
        const double e = cur.version() == mf62::Version::Mf52 ? 2.0 : cur.pky4;
        double best = 1e300, best_pky1 = cur.pky1, best_pky2 = cur.pky2;
        for (int g = 0; g < 40; ++g) {
            const double pky2 = 0.2 * std::pow(10.0, 1.4 * g / 39.0);  // 0.2 .. 5
            double sgg = 0, sgk = 0;
            std::vector<double> gv(dk.size());
            for (std::size_t i = 0; i < dk.size(); ++i) { gv[i] = fz0 * std::sin(e * std::atan(fk[i] / (pky2 * fz0))); sgg += gv[i] * gv[i]; sgk += gv[i] * sk[i]; }
            if (sgg <= 0) continue;
            const double pky1 = sgk / sgg;
            double c = 0;
            for (std::size_t i = 0; i < dk.size(); ++i) { const double d = sk[i] - pky1 * gv[i]; c += d * d; }
            if (c < best) { best = c; best_pky1 = pky1; best_pky2 = pky2; }
        }
        put("PKY1", best_pky1);
        if (dk.size() >= 2) put("PKY2", best_pky2);
    }
    return true;
}

double rms_of(const std::vector<double>& v) {
    double s = 0;
    for (double x : v) s += x * x;
    return v.empty() ? 0.0 : std::sqrt(s / static_cast<double>(v.size()));
}

}  // namespace

Result fit(const mf62::Params& tyre, const std::vector<Sample>& data, const Options& opt) {
    Result res;
    res.params = tyre;
    mf62::Params& cur = res.params;
    const mf62::Modes modes = mf62::modes_from_use_mode(111);

    // -- the template's scaling factors (LFZO, LMUX, LKY, ...) rescale its coefficients: the measured data defines this tyre, so they go back to 1 (FNOMIN is then the nominal load and a coefficient is what it says)
    {
        const mf62::Params defaults;
        std::string changed;
        for (const auto& [key, mem] : coeff_table()) {
            const bool scale_factor = key.size() >= 2 && key.size() <= 5 && key[0] == 'L' && key != "LONGVL" && defaults.*mem == 1.0;
            if (scale_factor && cur.*mem != 1.0) { changed += (changed.empty() ? "" : ", ") + key + " (" + std::to_string(cur.*mem).substr(0, 6) + ")"; cur.*mem = 1.0; }
        }
        if (!changed.empty()) res.notes.push_back("the template's scaling factors were reset to 1 so that FNOMIN is the nominal load: " + changed);
    }

    // -- what the data covers
    std::vector<double> loads;
    double kmin = 0, kmax = 0, amin = 0, amax = 0, gmin = 0, gmax = 0, fzmin = 1e300, fzmax = 0, pmin = 1e300, pmax = 0;
    bool any_p = false;
    for (const Sample& s : data) {
        kmin = std::min(kmin, s.kappa); kmax = std::max(kmax, s.kappa);
        amin = std::min(amin, s.alpha); amax = std::max(amax, s.alpha);
        gmin = std::min(gmin, s.gamma); gmax = std::max(gmax, s.gamma);
        fzmin = std::min(fzmin, s.fz); fzmax = std::max(fzmax, s.fz);
        if (s.pressure > 0) { any_p = true; pmin = std::min(pmin, s.pressure); pmax = std::max(pmax, s.pressure); }
        bool known = false;
        for (double l : loads) if (std::abs(l - s.fz) <= 0.03 * l) { known = true; break; }
        if (!known) loads.push_back(s.fz);
    }
    const bool camber = (gmax - gmin) > 0.0087 || std::max(std::abs(gmin), std::abs(gmax)) > 0.0087;  // > 0.5 deg
    const bool pressure = any_p && (pmax - pmin) > 0.03 * pmax;
    res.notes.push_back(std::to_string(data.size()) + " rows, " + std::to_string(loads.size()) + " distinct load(s) between " + std::to_string(static_cast<int>(fzmin)) + " and " + std::to_string(static_cast<int>(fzmax)) + " N");
    if (loads.size() < 3) res.notes.push_back("fewer than 3 loads: the load dependence (PDX2, PKX2, PEX2, PKY2, ...) is poorly determined and stays close to the template's");
    if (!camber) res.notes.push_back("no camber variation in the data: the camber coefficients (PDX3, PDY3, PEY4, PKY3, PHY3, PVY3, PVY4, QBZ4/5, QDZ3/4/8/9, ...) were NOT fitted and keep the template's values");
    if (!pressure) res.notes.push_back("no pressure variation in the data: the pressure coefficients (PPX*, PPY*) were NOT fitted");
    if (cur.fnomin < fzmin / 3.0 || cur.fnomin > fzmax * 3.0) res.notes.push_back("FNOMIN (" + std::to_string(static_cast<int>(cur.fnomin)) + " N) is far outside the measured loads: set it to the tyre's nominal load");

    // -- the file's limits must span the data (the fit runs with the limits on, exactly as the tyre is used)
    auto widen = [&](double& lo, double& hi, double dlo, double dhi, const char* what) {
        const double nlo = dlo - 0.05 * std::max(std::abs(dlo), 0.02), nhi = dhi + 0.05 * std::max(std::abs(dhi), 0.02);
        if (nlo < lo || nhi > hi) {
            lo = std::min(lo, nlo);
            hi = std::max(hi, nhi);
            res.notes.push_back(std::string("the file's ") + what + " limits were widened to span the data");
        }
    };
    widen(cur.kpumin, cur.kpumax, kmin, kmax, "slip ratio");
    widen(cur.alpmin, cur.alpmax, amin, amax, "slip angle");
    widen(cur.cammin, cur.cammax, gmin, gmax, "camber");
    if (fzmin * 0.9 < cur.fzmin) { cur.fzmin = fzmin * 0.9; res.notes.push_back("the file's minimum load was lowered to span the data"); }
    if (fzmax * 1.1 > cur.fzmax) { cur.fzmax = fzmax * 1.1; res.notes.push_back("the file's maximum load was raised to span the data"); }
    if (pressure) {
        if (pmin * 0.95 < cur.presmin) cur.presmin = pmin * 0.95;
        if (pmax * 1.05 > cur.presmax) cur.presmax = pmax * 1.05;
    }

    std::vector<Spec> specs = {{"fx0", 0, "PDX1", "PKX1"}, {"fy0", 1, "PDY1", "PKY1"}};
    if (opt.fit_aligning) specs.push_back({"mz0", 2, "QDZ1", "QBZ1"});
    if (opt.fit_combined) { specs.push_back({"fx", 0, nullptr, nullptr}); specs.push_back({"fy", 1, nullptr, nullptr}); }

    for (const Spec& sp : specs) {
        Stage st;
        st.name = sp.name;
        st.channel = sp.channel == 0 ? "Fx" : (sp.channel == 1 ? "Fy" : "Mz");
        Problem pr;
        pr.base = cur;
        pr.modes = modes;
        pr.channel = sp.channel;
        // rows of this stage
        for (const Sample& s : data) {
            const double y = sp.channel == 0 ? s.fx : (sp.channel == 1 ? s.fy : s.mz);
            if (std::isnan(y)) continue;
            bool use = false;
            if (sp.name == "fx0") use = pure_x(s);
            else if (sp.name == "fy0" || sp.name == "mz0") use = pure_y(s);
            else use = combined(s);
            if (!use) continue;
            mf62::Input in;
            in.fz = s.fz; in.kappa = s.kappa; in.alpha = s.alpha; in.gamma = s.gamma;
            in.vx = s.vx > 0 ? s.vx : cur.longvl;
            in.pressure = s.pressure;
            pr.in.push_back(in);
            pr.y.push_back(y);
        }
        st.rows = static_cast<int>(pr.in.size());
        std::vector<std::string> keys = stage_keys(sp.name, camber, pressure, cur.version());
        const std::size_t min_rows = keys.size() * 2 + 8;
        if (pr.in.size() < min_rows) {
            st.note = pr.in.empty() ? "no rows with this channel and slip combination: not fitted, coefficients stay at the template's"
                                    : "only " + std::to_string(pr.in.size()) + " rows for " + std::to_string(keys.size()) + " coefficients: not fitted";
            res.stages.push_back(st);
            continue;
        }
        for (const std::string& k : keys) {
            const auto it = coeff_table().find(k);
            if (it == coeff_table().end()) continue;
            pr.mem.push_back(it->second);
            st.fitted.push_back(k);
        }
        const std::size_t n = pr.mem.size();
        pr.x0.resize(n); pr.lo.resize(n); pr.hi.resize(n); pr.scale.resize(n); pr.lo_soft.assign(n, 0); pr.hi_soft.assign(n, 0);
        for (std::size_t j = 0; j < n; ++j) {
            pr.x0[j] = cur.*(pr.mem[j]);
            bounds_for(st.fitted[j], pr.x0[j], pr.lo[j], pr.hi[j]);
            if (pr.x0[j] < pr.lo[j]) { pr.lo[j] = pr.x0[j]; pr.lo_soft[j] = 1; }
            if (pr.x0[j] > pr.hi[j]) { pr.hi[j] = pr.x0[j]; pr.hi_soft[j] = 1; }
            pr.scale[j] = std::max(std::abs(pr.x0[j]), 0.1);
        }
        st.peak = 0;
        for (double v : pr.y) st.peak = std::max(st.peak, std::abs(v));
        pr.sigma = std::max(rms_of(pr.y), 1e-9);
        pr.reg = opt.ridge * static_cast<double>(pr.in.size());
        std::vector<double> best_x0, best_scale;

        // starting points. A: the data's own peak grip and initial slope per load (pure-slip stages). B: the template with its peak scaled to the data's magnitude. Then A (or B) with the slip stiffness
        // x 0.6 and x 1.6. The first start that fits to 1 % of the peak ends the search.
        std::size_t ipeak = n, istiff = n;
        for (std::size_t j = 0; j < n; ++j) {
            if (sp.peak_key && st.fitted[j] == sp.peak_key) ipeak = j;
            if (sp.stiff_key && st.fitted[j] == sp.stiff_key) istiff = j;
        }
        std::vector<std::vector<double>> starts;
        std::vector<double> xa = pr.x0;
        if (data_driven_start(pr, st.fitted, cur, xa)) starts.push_back(xa);
        if (ipeak < n) {
            std::vector<double> xb = pr.x0, r0;
            residuals(pr, xb, r0);
            std::vector<double> model(r0.size());
            for (std::size_t i = 0; i < r0.size(); ++i) model[i] = r0[i] * pr.sigma + pr.y[i];
            const double ratio = std::clamp(rms_of(pr.y) / std::max(rms_of(model), 1e-9), 0.2, 5.0);
            xb[ipeak] = std::clamp(xb[ipeak] * ratio, pr.lo[ipeak], pr.hi[ipeak]);
            starts.push_back(xb);
        }
        if (starts.empty()) starts.push_back(pr.x0);
        if (istiff < n && opt.stiffness_restarts > 0) {
            for (double f : {0.6, 1.6}) {
                std::vector<double> xf = starts.front();
                xf[istiff] = std::clamp(xf[istiff] * f, pr.lo[istiff], pr.hi[istiff]);
                starts.push_back(xf);
            }
        }
        LmResult best;
        for (std::size_t t = 0; t < starts.size(); ++t) {
            pr.x0 = starts[t];  // the ridge pulls towards this start
            for (std::size_t j = 0; j < n; ++j) pr.scale[j] = std::max(std::abs(pr.x0[j]), 0.1);
            LmResult lr = levenberg_marquardt(pr, starts[t], opt.max_iterations);
            if (lr.cost < best.cost) { best = lr; best_x0 = pr.x0; best_scale = pr.scale; }
            ++st.restarts_tried;
            std::vector<double> rr;
            residuals(pr, best.x, rr);
            double sse0 = 0;
            for (double v : rr) sse0 += v * v;
            if (std::sqrt(sse0 / static_cast<double>(rr.size())) * pr.sigma < 0.01 * st.peak) break;
        }
        pr.x0 = best_x0;
        pr.scale = best_scale;
        st.ran = true;
        st.iterations = best.iterations;
        st.converged = best.converged;
        // error in physical units
        std::vector<double> r;
        residuals(pr, best.x, r);
        double sse = 0, maxe = 0;
        for (double v : r) { const double e = v * pr.sigma; sse += e * e; maxe = std::max(maxe, std::abs(e)); }
        st.rms = std::sqrt(sse / static_cast<double>(r.size()));
        st.max_abs_error = maxe;
        st.rms_percent_of_peak = st.peak > 0 ? 100.0 * st.rms / st.peak : 0.0;
        // bounds and identifiability
        std::vector<std::vector<double>> J;
        jacobian(pr, best.x, r, J);
        std::vector<double> sens(n);
        double smax = 0;
        for (std::size_t j = 0; j < n; ++j) {
            double s = 0;
            for (double v : J[j]) s += v * v;
            sens[j] = std::sqrt(s) * pr.scale[j];
            smax = std::max(smax, sens[j]);
        }
        for (std::size_t j = 0; j < n; ++j) {
            const double span = pr.hi[j] - pr.lo[j];
            if ((!pr.lo_soft[j] && best.x[j] - pr.lo[j] < 1e-6 * span) || (!pr.hi_soft[j] && pr.hi[j] - best.x[j] < 1e-6 * span)) st.at_bounds.push_back(st.fitted[j]);
            if (sens[j] < 1e-3 * smax) st.weakly_determined.push_back(st.fitted[j]);
            cur.*(pr.mem[j]) = best.x[j];
            res.fitted_keys.insert(st.fitted[j]);
        }
        res.stages.push_back(st);
    }
    return res;
}

// ------------------------------------------------------------------------------------------------ synthetic data

std::vector<Sample> synthetic_sweep(const mf62::Params& truth, const SweepSpec& spec) {
    // deterministic on every platform (std::normal_distribution is not): a 64-bit LCG and Box-Muller
    std::uint64_t state = 0x9E3779B97F4A7C15ull;
    auto uniform = [&]() {
        state = state * 6364136223846793005ull + 1442695040888963407ull;
        return static_cast<double>((state >> 11) & ((1ull << 53) - 1)) / static_cast<double>(1ull << 53);
    };
    auto normal = [&]() {
        const double u = std::max(uniform(), 1e-12), v = uniform();
        return std::sqrt(-2.0 * std::log(u)) * std::cos(2.0 * 3.14159265358979323846 * v);
    };
    const mf62::Modes modes = mf62::modes_from_use_mode(111);
    std::vector<Sample> out;
    auto add = [&](double fz, double kappa, double alpha, double gamma, bool fx, bool fy, bool mz) {
        mf62::Input in;
        in.fz = fz; in.kappa = kappa; in.alpha = alpha; in.gamma = gamma; in.vx = truth.longvl;
        const mf62::Output o = mf62::evaluate(truth, in, modes);
        Sample s;
        s.fz = fz; s.kappa = kappa; s.alpha = alpha; s.gamma = gamma; s.vx = truth.longvl;
        const double nf = spec.noise * truth.fnomin, nm = spec.noise * truth.fnomin * 0.05;
        if (fx) s.fx = o.fx + (nf > 0 ? nf * normal() : 0.0);
        if (fy) s.fy = o.fy + (nf > 0 ? nf * normal() : 0.0);
        if (mz) s.mz = o.mz + (nm > 0 ? nm * normal() : 0.0);
        out.push_back(s);
    };
    const int steps = static_cast<int>(std::lround(spec.slip_max / 0.01));
    for (double l : spec.loads) {
        const double fz = l * truth.fnomin;
        for (int i = -steps; i <= steps; ++i) add(fz, 0.01 * i, 0.0, 0.0, true, false, false);
        for (double gm : spec.gammas)
            for (int i = -steps; i <= steps; ++i) add(fz, 0.0, 0.01 * i, gm, false, true, true);
    }
    if (spec.combined)
        for (double l : {0.75, 1.0, 1.25}) {
            const double fz = l * truth.fnomin;
            for (double k : {-0.15, -0.08, -0.04, 0.04, 0.08, 0.15})
                for (double a : {-0.12, -0.08, -0.04, 0.04, 0.08, 0.12}) add(fz, k, a, 0.0, true, true, false);
        }
    return out;
}

std::string to_csv(const std::vector<Sample>& rows) {
    std::ostringstream o;
    o << "fz,kappa,alpha,gamma,vx,pressure,fx,fy,mz\n";
    auto cell = [](double v) {
        if (std::isnan(v)) return std::string();
        char buf[40];
        std::snprintf(buf, sizeof buf, "%.7g", v);
        return std::string(buf);
    };
    for (const Sample& s : rows) o << cell(s.fz) << ',' << cell(s.kappa) << ',' << cell(s.alpha) << ',' << cell(s.gamma) << ',' << cell(s.vx) << ',' << cell(s.pressure) << ',' << cell(s.fx) << ',' << cell(s.fy) << ',' << cell(s.mz) << "\n";
    return o.str();
}

// ------------------------------------------------------------------------------------------------ writing

std::string write_tir(const std::string& template_text, const mf62::Params& before, const mf62::Params& after, const std::set<std::string>& also, const std::vector<std::string>& header) {
    std::map<std::string, double> todo;
    for (const auto& [key, mem] : coeff_table()) {
        const double a = before.*mem, b = after.*mem;
        if (a != b || also.count(key)) todo[key] = b;
    }
    auto fmt = [](double v) {
        char buf[64];
        std::snprintf(buf, sizeof buf, "%.10g", v);
        return std::string(buf);
    };
    std::ostringstream out;
    for (const std::string& h : header) out << "$ " << h << "\n";
    std::istringstream in(template_text);
    std::string line;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const std::string t = trim(line);
        const std::size_t eq = line.find('=');
        if (!t.empty() && t[0] != '$' && t[0] != '!' && t[0] != '[' && eq != std::string::npos) {
            const std::string key = upper(trim(line.substr(0, eq)));
            const auto it = todo.find(key);
            if (it != todo.end()) {
                const std::size_t cpos = line.find('$', eq);
                std::string val = fmt(it->second);
                out << line.substr(0, eq + 1) << ' ' << val;
                if (cpos != std::string::npos) out << std::string(val.size() < 20 ? 20 - val.size() : 1, ' ') << line.substr(cpos);
                out << "\n";
                todo.erase(it);
                continue;
            }
        }
        out << line << "\n";
    }
    if (!todo.empty()) {
        out << "$----------------------------------------------------------------coefficients added by the fit (not in the template file)\n[OPENGRID_FITTED]\n";
        for (const auto& [key, v] : todo) out << key << std::string(key.size() < 24 ? 24 - key.size() : 1, ' ') << "= " << fmt(v) << "\n";
    }
    return out.str();
}

// ------------------------------------------------------------------------------------------------ reports

std::string report_text(const Result& r) {
    std::ostringstream o;
    char buf[256];
    for (const std::string& n : r.notes) o << "note: " << n << "\n";
    o << "\nstage  channel   rows  coeffs  rms error            max error     iterations\n";
    for (const Stage& s : r.stages) {
        if (!s.ran) {
            std::snprintf(buf, sizeof buf, "%-6s %-7s %6d      -   not fitted: %s\n", s.name.c_str(), s.channel.c_str(), s.rows, s.note.c_str());
        } else {
            std::snprintf(buf, sizeof buf, "%-6s %-7s %6d %6zu  %10.4g (%5.2f %% of peak) %10.4g %6d%s\n", s.name.c_str(), s.channel.c_str(), s.rows, s.fitted.size(), s.rms, s.rms_percent_of_peak, s.max_abs_error, s.iterations,
                          s.converged ? "" : "  (iteration limit)");
        }
        o << buf;
        auto list = [&](const char* what, const std::vector<std::string>& v) {
            if (v.empty()) return;
            o << "         " << what << ":";
            for (const std::string& k : v) o << ' ' << k;
            o << "\n";
        };
        list("on a bound", s.at_bounds);
        list("barely determined by this data", s.weakly_determined);
    }
    return o.str();
}

std::string report_json(const Result& r) {
    auto esc = [](const std::string& s) {
        std::string o;
        for (char c : s) { if (c == '"' || c == '\\') o += '\\'; o += c; }
        return o;
    };
    auto arr = [&](const std::vector<std::string>& v) {
        std::string o = "[";
        for (std::size_t i = 0; i < v.size(); ++i) o += (i ? ",\"" : "\"") + esc(v[i]) + "\"";
        return o + "]";
    };
    std::ostringstream o;
    o << "{\"notes\":" << arr(r.notes) << ",\"stages\":[";
    for (std::size_t i = 0; i < r.stages.size(); ++i) {
        const Stage& s = r.stages[i];
        char buf[320];
        std::snprintf(buf, sizeof buf, "{\"name\":\"%s\",\"channel\":\"%s\",\"rows\":%d,\"ran\":%s,\"converged\":%s,\"iterations\":%d,\"rms\":%.6g,\"rms_percent_of_peak\":%.4f,\"max_abs_error\":%.6g,\"peak\":%.6g",
                      s.name.c_str(), s.channel.c_str(), s.rows, s.ran ? "true" : "false", s.converged ? "true" : "false", s.iterations, s.rms, s.rms_percent_of_peak, s.max_abs_error, s.peak);
        o << (i ? "," : "") << buf << ",\"fitted\":" << arr(s.fitted) << ",\"at_bounds\":" << arr(s.at_bounds) << ",\"weakly_determined\":" << arr(s.weakly_determined) << ",\"note\":\"" << esc(s.note) << "\"}";
    }
    o << "]}";
    return o.str();
}

}  // namespace rs::tirfit
