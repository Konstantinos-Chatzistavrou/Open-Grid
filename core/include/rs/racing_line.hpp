// Racing line: the minimum-curvature path through a route's drivable width (outside - apex - outside through a
// corner, straightened chicanes). Engine-neutral (web, Unreal 5.8): computed once per route, then sampled by route
// distance. The AI follows it in races and takes its corner speeds from the line's own, smaller curvature.
//
// Method: the line is the centreline shifted sideways by n(s) within [-(width_right - margin), width_left - margin].
// n minimises the sum of squared second differences of the line points (discrete curvature at a uniform spacing),
// solved by projected Gauss-Seidel / SOR (each step is the exact minimiser in one n_i, then clamped to the road).
// Minimum curvature is the classic approximation of the minimum-time line: close to it on a road car, with apexes a
// little earlier than a lap-time optimiser would choose.
#pragma once
#include <vector>
#include "rs/route.hpp"

namespace rs {

struct RacingLineParams {
    double margin_m = 1.3;     // car half width + clearance to the road edge / kerb
    double spacing_m = 2.0;    // resampling step along the route
    int iterations = 3000;     // SOR sweeps (each O(n))
};

class RacingLine {
public:
    RacingLine() = default;
    explicit RacingLine(const Route& route, RacingLineParams p = {});

    bool empty() const { return n_.empty(); }
    /** Offset from the centreline at route distance s (m, + = left), interpolated. */
    double lateral(double s) const;
    /** Curvature of the line itself at route distance s (1/m, + = turning left). */
    double curvature(double s) const;
    /** Sum of squared curvature of the line (diagnostics). */
    double energy() const { return energy_; }

private:
    double sample(const std::vector<double>& v, double s) const;
    std::vector<double> n_, k_;
    double ds_ = 2.0, length_ = 0, energy_ = 0;
    bool closed_ = true;
};

}  // namespace rs
