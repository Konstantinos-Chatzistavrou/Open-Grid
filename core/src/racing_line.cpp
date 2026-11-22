#include "rs/racing_line.hpp"
#include <algorithm>
#include <cmath>

namespace rs {

RacingLine::RacingLine(const Route& route, RacingLineParams p) {
    closed_ = route.closed();
    length_ = route.length();
    const int N = std::max(8, (int)std::lround(length_ / std::max(p.spacing_m, 0.25)));
    ds_ = length_ / (closed_ ? N : N - 1);
    std::vector<Vec3> c(N), L(N);
    std::vector<double> lo(N), hi(N);
    for (int i = 0; i < N; ++i) {
        const double s = i * ds_;
        const RouteSample r = route.at(s);
        c[i] = r.p;
        L[i] = route.left(s);
        hi[i] = r.width_left - p.margin_m;
        lo[i] = -(r.width_right - p.margin_m);
        if (hi[i] < lo[i]) hi[i] = lo[i] = 0.5 * (hi[i] + lo[i]);   // narrower than the car + margins: middle
    }
    n_.assign(N, 0.0);
    for (int i = 0; i < N; ++i) n_[i] = std::clamp(0.0, lo[i], hi[i]);
    // index helper: wraps on a closed route, clamps (fixed ends) on an open one
    auto idx = [&](int i) { return closed_ ? ((i % N) + N) % N : std::clamp(i, 0, N - 1); };
    auto P = [&](int i) { const int j = idx(i); return c[j] + L[j] * n_[j]; };
    auto D = [&](int j) { return P(j - 1) - P(j) * 2.0 + P(j + 1); };   // second difference (curvature * ds^2)
    const double omega = 1.6;                                           // over-relaxation
    for (int it = 0; it < p.iterations; ++it) {
        double moved = 0;
        for (int i = 0; i < N; ++i) {
            if (!closed_ && (i < 2 || i > N - 3)) continue;                // open route: start and end on the centreline
            const Vec3 Li = L[i];
            // dE/dn_i = 2 (D_{i-1} - 2 D_i + D_{i+1}) . L_i, d2E/dn_i2 = 12 |L_i|^2
            const double g = dot(D(i - 1) - D(i) * 2.0 + D(i + 1), Li);
            const double ni = std::clamp(n_[i] - omega * g / 6.0, lo[i], hi[i]);
            moved = std::max(moved, std::abs(ni - n_[i]));
            n_[i] = ni;
        }
        if (moved < 1e-5) break;
    }
    // curvature of the line (Menger curvature through three neighbours), signed + = left
    k_.assign(N, 0.0);
    energy_ = 0;
    for (int i = 0; i < N; ++i) {
        if (!closed_ && (i == 0 || i == N - 1)) continue;
        const Vec3 a = P(i - 1), b = P(i), d = P(i + 1);
        const Vec3 ab{b.x - a.x, b.y - a.y, 0}, bd{d.x - b.x, d.y - b.y, 0}, ad{d.x - a.x, d.y - a.y, 0};
        const double cross = ab.x * bd.y - ab.y * bd.x;
        const double den = std::sqrt(dot(ab, ab) * dot(bd, bd) * dot(ad, ad));
        k_[i] = den > 1e-12 ? 2.0 * cross / den : 0.0;
        energy_ += k_[i] * k_[i] * ds_;
    }
    if (!closed_ && N >= 3) { k_[0] = k_[1]; k_[N - 1] = k_[N - 2]; }
}

double RacingLine::sample(const std::vector<double>& v, double s) const {
    if (v.empty()) return 0.0;
    const int N = (int)v.size();
    if (closed_) {
        s = std::fmod(s, length_);
        if (s < 0) s += length_;
    } else {
        s = std::clamp(s, 0.0, length_);
    }
    const double x = s / ds_;
    int i = (int)std::floor(x);
    const double t = x - i;
    i = closed_ ? i % N : std::min(i, N - 1);
    const int j = closed_ ? (i + 1) % N : std::min(i + 1, N - 1);
    return v[i] + (v[j] - v[i]) * t;
}

double RacingLine::lateral(double s) const { return sample(n_, s); }
double RacingLine::curvature(double s) const { return sample(k_, s); }

}  // namespace rs
