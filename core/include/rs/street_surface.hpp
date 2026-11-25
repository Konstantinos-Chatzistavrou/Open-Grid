// Dynamic City-Street Surface Evolution (rubber laydown, off-line marbles/grit, rain wake drying & gutter drainage)
// and Procedural ISO 8608 Urban Micro-Roughness Ground (road crown, painted crosswalks, wet manhole covers, potholes).
//
// Header-only C++17, zero engine dependencies, zero per-tick heap allocations.
// Works on both city street networks (NYC / Tokyo / London / LA) and closed circuits.
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>
#include "rs/math.hpp"
#include "rs/sim.hpp"
#include "rs/tire.hpp"

namespace rs {

// =============================================================================
// 1. Dynamic Street / Track Surface Evolution (Rubber, Marbles, Wet Line Drying)
// =============================================================================

struct StreetSurfaceSample {
    double rubber_0_to_1 = 0.0;    // 0 = green/washed asphalt, 1 = heavily rubbered-in racing line
    double marbles_0_to_1 = 0.0;   // 0 = clean, 1 = heavy off-line rubber marbles & street dust/grit
    double water_mm = 0.0;         // local standing water film depth (mm) after rain, wake drying & crown drainage
    double dry_mu_mult = 1.0;      // grip multiplier in dry conditions (1.00 .. 1.06 with rubber, down to 0.92 on marbles)
    double wet_mu_mult = 1.0;      // extra wet-line grip multiplier (rubbered line is slicker in wet: down to 0.91!)
    double effective_mu_mult = 1.0;// combined dry/wet/marble surface grip multiplier
};

// 2D (longitudinal station s x lateral lane) dynamic street-surface grid.
// Zero per-tick heap allocations once constructed.
class StreetSurfaceEvolution {
public:
    static constexpr int kLanes = 9; // lateral lanes across [-half_width_m .. +half_width_m]

    explicit StreetSurfaceEvolution(double route_length_m = 4000.0, int longitudinal_segments = 200,
                                    double half_width_m = 6.75, double crown_slope = 0.02)
        : length_m_(std::max(10.0, route_length_m)),
          n_seg_(std::max(8, longitudinal_segments)),
          half_width_m_(std::max(2.0, half_width_m)),
          crown_slope_(clamp(crown_slope, 0.0, 0.06)),
          rubber_(static_cast<std::size_t>(n_seg_ * kLanes), 0.0),
          marbles_(static_cast<std::size_t>(n_seg_ * kLanes), 0.0),
          water_mm_(static_cast<std::size_t>(n_seg_ * kLanes), 0.0) {}

    void reset(double initial_rubber = 0.0, double initial_water_mm = 0.0, double initial_edge_grit = 0.10) {
        std::fill(rubber_.begin(), rubber_.end(), clamp(initial_rubber, 0.0, 1.0));
        std::fill(water_mm_.begin(), water_mm_.end(), std::max(0.0, initial_water_mm));
        for (int s = 0; s < n_seg_; ++s) {
            for (int l = 0; l < kLanes; ++l) {
                const double edge = std::abs(lane_center_m(l)) / half_width_m_;
                // City street curbs & gutters naturally hold slightly more dust/grit than the swept center lanes
                marbles_[idx(s, l)] = clamp(initial_edge_grit * edge * edge, 0.0, 1.0);
            }
        }
    }

    // Record one passing tyre at route arc-length s_m and signed lateral offset lat_m (+ = right of centerline).
    // Lays rubber into the driven lane, sheds marbles into outer lanes, and pumps standing water out of the track.
    void deposit_wheel(double s_m, double lat_m, double slip_power_w, double speed_mps, double load_n, double dt) {
        if (dt <= 0.0 || load_n <= 100.0) return;
        const int si = seg_of(s_m);
        const int li = lane_of(lat_m);
        const std::size_t k = idx(si, li);
        const double v = std::abs(speed_mps);

        // 1. Rubber laydown: proportional to friction slip work (reduced when street is flooded)
        const double wet_wash = clamp(1.0 - water_mm_[k] / 3.0, 0.15, 1.0);
        const double d_rubber = std::max(0.0, slip_power_w) * dt * 1.6e-6 * wet_wash;
        rubber_[k] = clamp(rubber_[k] + d_rubber, 0.0, 1.0);

        // 2. Passing wheel sweeps marbles/grit out of its own lane and flings shed rubber into adjacent off-line lanes
        const double sweep = clamp(v * dt * 0.015, 0.0, 0.25);
        marbles_[k] = std::max(0.0, marbles_[k] * (1.0 - sweep));
        const double shed = d_rubber * 0.45;
        if (shed > 0.0) {
            if (li > 0) marbles_[idx(si, li - 1)] = clamp(marbles_[idx(si, li - 1)] + shed, 0.0, 1.0);
            if (li + 1 < kLanes) marbles_[idx(si, li + 1)] = clamp(marbles_[idx(si, li + 1)] + shed, 0.0, 1.0);
        }

        // 3. Tyre wake water dispersion: rolling tyre pumps water off the driven line into neighboring lanes
        if (water_mm_[k] > 0.01 && v > 3.0) {
            const double pump_frac = clamp((v / 45.0) * (load_n / 4000.0) * dt * 0.55, 0.0, 0.35);
            const double moved = water_mm_[k] * pump_frac;
            water_mm_[k] = std::max(0.0, water_mm_[k] - moved);
            // Half atomizes into spray; half splashes into adjacent lanes
            const double splash = 0.25 * moved;
            if (li > 0) water_mm_[idx(si, li - 1)] = std::min(12.0, water_mm_[idx(si, li - 1)] + splash);
            if (li + 1 < kLanes) water_mm_[idx(si, li + 1)] = std::min(12.0, water_mm_[idx(si, li + 1)] + splash);
        }
    }

    // Advance global street weather: rainfall accumulation, evaporation, rain-wash of rubber/marbles, and
    // 2% crowned-street gravity drainage from center crown toward outer curb gutters (forming curb puddles).
    void step_weather(double rain_mm_per_hr, double ambient_air_c, double dt) {
        if (dt <= 0.0) return;
        const double rain_add = std::max(0.0, rain_mm_per_hr) * (dt / 3600.0);
        const double evap_rate = (rain_mm_per_hr < 0.2)
                               ? (0.00035 * clamp((ambient_air_c + 5.0) / 25.0, 0.25, 2.5)) * dt
                               : 0.0;
        const double wash_rate = (rain_mm_per_hr > 1.0) ? clamp(rain_mm_per_hr * 0.00012 * dt, 0.0, 0.05) : 0.0;
        const double drain_k = clamp(crown_slope_ * 2.2 * dt, 0.0, 0.20);
        constexpr int mid = kLanes / 2;

        for (int s = 0; s < n_seg_; ++s) {
            std::array<double, kLanes> w_next{};
            for (int l = 0; l < kLanes; ++l) {
                const std::size_t k = idx(s, l);
                double w = std::max(0.0, water_mm_[k] + rain_add - evap_rate);
                w_next[l] = w;
                if (wash_rate > 0.0) {
                    rubber_[k] = std::max(0.0, rubber_[k] * (1.0 - wash_rate));
                    marbles_[k] = std::max(0.0, marbles_[k] * (1.0 - 1.5 * wash_rate));
                }
            }
            // Crown drainage: water flows outward from center lane toward curb gutters (lanes 0 and kLanes-1),
            // while curb storm drains slowly remove excess water above 1.2 mm.
            for (int l = mid; l > 0; --l) {
                const double flow = w_next[l] * drain_k;
                w_next[l] -= flow;
                w_next[l - 1] += flow;
            }
            for (int l = mid; l < kLanes - 1; ++l) {
                const double flow = w_next[l] * drain_k;
                w_next[l] -= flow;
                w_next[l + 1] += flow;
            }
            // Gutter storm-drain outflow
            const double gutter_drain = clamp(0.04 * dt, 0.0, 0.25);
            w_next[0] = std::min(12.0, std::max(0.0, w_next[0] - std::max(0.0, w_next[0] - 1.0) * gutter_drain));
            w_next[kLanes - 1] = std::min(12.0, std::max(0.0, w_next[kLanes - 1] - std::max(0.0, w_next[kLanes - 1] - 1.0) * gutter_drain));

            for (int l = 0; l < kLanes; ++l) water_mm_[idx(s, l)] = w_next[l];
        }
    }

    StreetSurfaceSample sample(double s_m, double lat_m) const {
        const int si = seg_of(s_m);
        const int li = lane_of(lat_m);
        const std::size_t k = idx(si, li);

        StreetSurfaceSample out;
        out.rubber_0_to_1 = rubber_[k];
        out.marbles_0_to_1 = marbles_[k];
        out.water_mm = water_mm_[k];

        // Dry rubbered-in asphalt adds up to +5.5% grip; off-line marbles/street grit cost up to -8%.
        out.dry_mu_mult = clamp(1.0 + 0.055 * out.rubber_0_to_1 - 0.080 * out.marbles_0_to_1, 0.88, 1.06);

        // Wet physics: polished/rubbered-in line loses micro-texture grip in rain (up to -9% vs clean wet asphalt),
        // rewarding wet-weather drivers who take the grippier off-line asphalt outside the rubbered groove.
        const double wet_blend = clamp(out.water_mm / 0.8, 0.0, 1.0);
        out.wet_mu_mult = 1.0 - 0.090 * out.rubber_0_to_1 * wet_blend;

        // Blend dry rubber bonus out smoothly as water film builds
        const double dry_rubber_bonus = 0.055 * out.rubber_0_to_1 * (1.0 - wet_blend);
        out.effective_mu_mult = clamp((1.0 + dry_rubber_bonus - 0.080 * out.marbles_0_to_1) * out.wet_mu_mult, 0.82, 1.06);
        return out;
    }

    int segment_count() const { return n_seg_; }
    double route_length_m() const { return length_m_; }
    double lane_center_m(int lane) const {
        const double u = (static_cast<double>(lane) + 0.5) / static_cast<double>(kLanes);
        return (2.0 * u - 1.0) * half_width_m_;
    }

private:
    double length_m_;
    int n_seg_;
    double half_width_m_;
    double crown_slope_;
    std::vector<double> rubber_;
    std::vector<double> marbles_;
    std::vector<double> water_mm_;

    int seg_of(double s_m) const {
        double wrapped = std::fmod(s_m, length_m_);
        if (wrapped < 0.0) wrapped += length_m_;
        return clamp(static_cast<int>(wrapped / length_m_ * n_seg_), 0, n_seg_ - 1);
    }
    int lane_of(double lat_m) const {
        const double u = clamp((lat_m + half_width_m_) / (2.0 * half_width_m_), 0.0, 0.999999);
        return clamp(static_cast<int>(u * kLanes), 0, kLanes - 1);
    }
    std::size_t idx(int s, int l) const { return static_cast<std::size_t>(s * kLanes + l); }
};

// =============================================================================
// 2. Procedural ISO 8608 City-Street Micro-Roughness & Urban Hazard Ground
// =============================================================================

enum class IsoRoadClass {
    ClassA_Highway = 0,     // smooth motorway / fresh tarmac (RMS ~ 1.5 mm)
    ClassB_CityAvenue = 1,  // typical maintained city avenue (RMS ~ 3.5 mm)
    ClassC_WornStreet = 2,  // worn/patched urban asphalt (RMS ~ 7.5 mm)
    ClassD_BrokenCobble = 3 // rough cobblestones / heavily broken street (RMS ~ 15 mm)
};

struct UrbanStreetConfig {
    IsoRoadClass road_class = IsoRoadClass::ClassB_CityAvenue;
    double crown_slope = 0.02;         // 2% road drainage crown (center highest, sloping toward curbs)
    double street_half_width_m = 6.0;  // m, curb-to-centerline half-width
    double base_water_mm = 0.0;        // ambient rain film depth (mm); deeper near gutters due to crown
    bool enable_manholes = true;       // recessed cast-iron manhole covers (low wet mu + sharp -12 mm lip)
    bool enable_crosswalks = true;     // thermoplastic painted crosswalk stripes (low wet mu)
    bool enable_expansion_joints = true; // periodic bridge/concrete expansion joints every 28 m
    double pothole_x_m = -1e9;         // optional deterministic street pothole center X (> -1e8 enables)
    double pothole_y_m = 0.0;          // pothole center Y (m)
    double pothole_radius_m = 0.35;    // pothole radius (m)
    double pothole_depth_m = 0.065;    // pothole depth (m) — triggers rim strike if driven into hard!
};

class StreetMicroGround : public Ground {
public:
    explicit StreetMicroGround(UrbanStreetConfig cfg = {}, int asphalt_surface = 0)
        : cfg_(cfg), surface_(asphalt_surface) {}

    const UrbanStreetConfig& config() const { return cfg_; }
    UrbanStreetConfig& config() { return cfg_; }

    // Deterministic ISO 8608 spatial height z(x, y) in metres:
    // combines road drainage crown, multi-octave roughness PSD, expansion joints, manholes, and optional pothole.
    double height_at(double x, double y) const {
        // 1. 2% urban drainage crown (smooth parabolic crest over center 2 m, linear slope toward gutters)
        const double ay = std::min(std::abs(y), cfg_.street_half_width_m);
        const double z_crown = -cfg_.crown_slope * (ay * ay) / (ay + 0.65);

        // 2. ISO 8608 multi-octave spatial roughness (wavelengths 0.45 m .. 18 m, 1/f^2 amplitude roll-off)
        double amp = 0.0015;
        if (cfg_.road_class == IsoRoadClass::ClassB_CityAvenue) amp = 0.0035;
        else if (cfg_.road_class == IsoRoadClass::ClassC_WornStreet) amp = 0.0075;
        else if (cfg_.road_class == IsoRoadClass::ClassD_BrokenCobble) amp = 0.0150;

        const double z_iso = amp * (
              0.46 * std::sin(0.35 * x + 0.21 * y + 0.4)
            + 0.28 * std::sin(0.92 * x - 0.63 * y + 1.7)
            + 0.16 * std::sin(2.41 * x + 1.37 * y + 2.9)
            + 0.08 * std::sin(5.80 * x - 3.10 * y + 0.8)
            + 0.04 * std::sin(13.5 * x + 7.40 * y + 4.1)
        );

        // 3. Periodic concrete / bridge expansion joints every 28 m (4 cm narrow trough, 7 mm deep)
        double z_joint = 0.0;
        if (cfg_.enable_expansion_joints) {
            const double xm = std::fmod(std::abs(x), 28.0);
            const double dj = std::min(xm, 28.0 - xm);
            if (dj < 0.04) {
                z_joint = -0.007 * (1.0 - dj / 0.04);
            }
        }

        // 4. Cast-iron street manhole covers (every 45 m along y = +/- 1.75 m, radius 0.34 m, -12 mm recessed lip)
        double z_manhole = 0.0;
        if (cfg_.enable_manholes && is_on_manhole(x, y)) {
            z_manhole = -0.012;
        }

        // 5. Optional sharp urban pothole
        double z_pot = 0.0;
        if (cfg_.pothole_x_m > -1e8) {
            const double d = std::hypot(x - cfg_.pothole_x_m, y - cfg_.pothole_y_m);
            if (d < cfg_.pothole_radius_m) {
                const double u = d / std::max(cfg_.pothole_radius_m, 0.05);
                z_pot = -cfg_.pothole_depth_m * (1.0 - u * u);
            }
        }

        return z_crown + z_iso + z_joint + z_manhole + z_pot;
    }

    bool is_on_manhole(double x, double y) const {
        if (!cfg_.enable_manholes) return false;
        const double cell_x = std::round((x - 15.0) / 45.0) * 45.0 + 15.0;
        const double cell_y = (y >= 0.0) ? 1.75 : -1.75;
        return std::hypot(x - cell_x, y - cell_y) <= 0.34;
    }

    bool is_on_crosswalk_paint(double x, double y) const {
        if (!cfg_.enable_crosswalks) return false;
        // Crosswalk bands every 80 m (3.2 m long), painted thermoplastic bars every 0.80 m laterally (0.40 m wide)
        const double cx = std::fmod(std::abs(x - 40.0), 80.0);
        const double dx = std::min(cx, 80.0 - cx);
        if (dx > 1.6) return false;
        const double cy = std::fmod(std::abs(y), 0.80);
        return cy < 0.40;
    }

    // Local water depth (mm), pooling deeper toward the curb gutters due to the 2% street crown.
    double water_depth_at(double /*x*/, double y) const {
        if (cfg_.base_water_mm <= 0.0) return 0.0;
        const double gutter_frac = clamp(std::abs(y) / std::max(cfg_.street_half_width_m, 1.0), 0.0, 1.2);
        return cfg_.base_water_mm * (0.70 + 0.90 * gutter_frac * gutter_frac);
    }

    // Local per-cell micro-surface grip multiplier (painted crosswalks & cast-iron manholes turn slick in rain!).
    double cell_mu_at(double x, double y) const {
        const double water = water_depth_at(x, y);
        const double wet_blend = clamp(water / 0.5, 0.0, 1.0);
        if (is_on_manhole(x, y)) {
            return lerp(0.84, 0.44, wet_blend); // bare iron: ~0.84 dry, ~0.44 wet
        }
        if (is_on_crosswalk_paint(x, y)) {
            return lerp(0.92, 0.58, wet_blend); // thermoplastic paint: ~0.92 dry, ~0.58 wet
        }
        return 1.0;
    }

    Vec3 normal_at(double x, double y) const {
        constexpr double eps = 0.03;
        const double dz_dx = (height_at(x + eps, y) - height_at(x - eps, y)) / (2.0 * eps);
        const double dz_dy = (height_at(x, y + eps) - height_at(x, y - eps)) / (2.0 * eps);
        return normalized(Vec3{-dz_dx, -dz_dy, 1.0});
    }

    WheelContact raycast(const WheelRay& ray) const override {
        WheelContact c;
        if (ray.direction.z >= -1e-6) return c;
        // 2-iteration ray-surface intersection against z = height_at(x, y)
        double t = (height_at(ray.origin.x, ray.origin.y) - ray.origin.z) / ray.direction.z;
        for (int it = 0; it < 2; ++it) {
            const Vec3 p = ray.origin + ray.direction * std::max(0.0, t);
            t = (height_at(p.x, p.y) - ray.origin.z) / ray.direction.z;
        }
        if (t < 0.0 || t > ray.length) return c;
        c.hit = true;
        c.distance = t;
        c.point = ray.origin + ray.direction * t;
        c.normal = normal_at(c.point.x, c.point.y);
        c.surface = surface_;
        c.water_depth_mm = water_depth_at(c.point.x, c.point.y);
        return c;
    }

    // Populate a 4x4 ContactPatchProfile with exact micro-height and wet iron/paint mu across the tyre footprint.
    void fill_patch_profile(const Vec3& center_world, const Vec3& fwd, const Vec3& lat,
                            double half_len_a, double half_wid_b, ContactPatchProfile& out) const {
        constexpr double kXi[4] = {-0.75, -0.25, 0.25, 0.75};
        constexpr double kEta[4] = {-0.75, -0.25, 0.25, 0.75};
        const double z0 = height_at(center_world.x, center_world.y);
        bool non_uniform = false;
        for (int i = 0; i < kPatchRows; ++i) {
            for (int j = 0; j < kPatchCols; ++j) {
                const int idx = i * kPatchCols + j;
                const Vec3 p = center_world + fwd * (kXi[i] * half_len_a) + lat * (kEta[j] * half_wid_b);
                const double dz = height_at(p.x, p.y) - z0;
                const double mu = cell_mu_at(p.x, p.y);
                out.road_dz_m[idx] = dz;
                out.mu_cell[idx] = mu;
                out.contact_mask[idx] = true;
                if (std::abs(dz) > 0.0015 || mu < 0.99) non_uniform = true;
            }
        }
        out.has_height_map = non_uniform;
    }

private:
    UrbanStreetConfig cfg_;
    int surface_;
};

}  // namespace rs
