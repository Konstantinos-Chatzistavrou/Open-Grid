#include "rs/pinnacle.hpp"

#include <algorithm>
#include <cmath>

namespace rs {

// -----------------------------------------------------------------------------
// 1. Hydroplaning (Aquaplaning Water-Wedge Physics)
// -----------------------------------------------------------------------------
HydroplaningState compute_hydroplaning(double speed_mps, double pressure_kpa, double tire_wear_0_to_1,
                                       double water_depth_mm) {
    HydroplaningState st{};
    double hw = std::max(0.0, water_depth_mm);
    double wear = clamp(tire_wear_0_to_1, 0.0, 1.0);
    double tread_mm = lerp(7.5, 1.2, wear);

    st.water_depth_mm = hw;
    st.remaining_tread_mm = tread_mm;

    // Horne's NASA hydroplaning equation adapted for tread depth & water film thickness:
    // v_hydro = 3.45 * sqrt(max(p_kPa, 80.0)) * (0.62 + 0.38 * tread_mm / 7.5)
    //         * (2.0 / max(h_w - 0.35 * tread_mm, 0.4))^0.22
    double p_eff = std::max(pressure_kpa, 80.0);
    double tread_factor = 0.62 + 0.38 * (tread_mm / 7.5);
    double film_excess_mm = std::max(hw - 0.35 * tread_mm, 0.4);
    double film_factor = std::pow(2.0 / film_excess_mm, 0.22);

    st.onset_speed_mps = 3.45 * std::sqrt(p_eff) * tread_factor * film_factor;

    // Evacuation threshold: if standing water is thinner than a shallow film that sipes clear without building
    // hydrodynamic pressure, or speed is below onset_speed_mps, no water-wedge lift occurs.
    double evacuation_limit_mm = 0.22 * tread_mm;
    double abs_speed = std::abs(speed_mps);
    if (hw <= evacuation_limit_mm || abs_speed <= st.onset_speed_mps) {
        st.wedge_lift_fraction = 0.0;
    } else {
        // Hydrodynamic stagnation pressure rises with (v^2 - v_onset^2) / v_onset^2 and depth excess
        double v_onset_sq = std::max(st.onset_speed_mps * st.onset_speed_mps, 1.0);
        double q_excess = (abs_speed * abs_speed - v_onset_sq) / v_onset_sq;
        double depth_boost = clamp(0.75 + 0.25 * (hw / std::max(0.35 * tread_mm, 0.5)), 0.75, 1.65);
        double lift = 0.90 * (1.0 - std::exp(-1.45 * q_excess * depth_boost));
        st.wedge_lift_fraction = clamp(lift, 0.0, 0.90);
    }

    st.effective_load_scale = 1.0 - st.wedge_lift_fraction;
    st.ffb_aligning_torque_scale = 1.0 - 0.85 * st.wedge_lift_fraction;
    return st;
}

// -----------------------------------------------------------------------------
// 2. Dynamic Racing Line (Rubbering-In & Wet Drying Groove)
// -----------------------------------------------------------------------------
DynamicTrackSurface::DynamicTrackSurface(double route_length_m, double ambient_water_mm, double bin_length_m)
    : route_length_m_(std::max(route_length_m, 10.0)),
      ambient_water_mm_(std::max(ambient_water_mm, 0.0)),
      bin_length_m_(std::max(bin_length_m, 1.0)) {
    int count = std::max(1, static_cast<int>(std::ceil(route_length_m_ / bin_length_m_)));
    bins_.resize(static_cast<std::size_t>(count));
    set_ambient_water_mm(ambient_water_mm_);
}

void DynamicTrackSurface::set_ambient_water_mm(double water_mm) {
    ambient_water_mm_ = std::max(0.0, water_mm);
    for (auto& bin : bins_) {
        bin.water_mm = {ambient_water_mm_, ambient_water_mm_, ambient_water_mm_};
    }
}

int DynamicTrackSurface::bin_index(double route_s) const {
    if (bins_.empty()) return 0;
    double wrapped = std::fmod(route_s, route_length_m_);
    if (wrapped < 0.0) wrapped += route_length_m_;
    int idx = static_cast<int>(wrapped / bin_length_m_);
    int max_idx = static_cast<int>(bins_.size()) - 1;
    return std::max(0, std::min(idx, max_idx));
}

int DynamicTrackSurface::band_index(double lateral_m, double ideal_lateral_m) {
    double offset = lateral_m - ideal_lateral_m;
    if (std::abs(offset) <= 1.45) {
        return IdealRacingGroove;
    }
    return (offset > 0.0) ? LeftOffLine : RightOffLine;
}

void DynamicTrackSurface::record_car_passage(double route_s, double lateral_m, double ideal_lateral_m,
                                             double speed_mps, double dt) {
    if (bins_.empty() || dt <= 0.0) return;
    int b_idx = bin_index(route_s);
    int band = band_index(lateral_m, ideal_lateral_m);
    TrackBin& bin = bins_[static_cast<std::size_t>(b_idx)];

    double speed_factor = clamp(std::abs(speed_mps) / 35.0, 0.25, 2.2);
    // A car traversing a 10 m longitudinal bin at ~50 m/s interacts with the bin over ~0.2 s per passage
    double eff_dt = clamp(dt, 0.16, 1.0);

    // 1. Wet track water evacuation and spray throw onto adjacent off-line bands
    double cur_water = bin.water_mm[static_cast<std::size_t>(band)];
    if (cur_water > 0.0) {
        double floor_mm = 0.25 * ambient_water_mm_;
        double removable = std::max(0.0, cur_water - floor_mm);
        double evacuated = removable * (1.0 - std::exp(-0.90 * eff_dt * speed_factor));
        bin.water_mm[static_cast<std::size_t>(band)] = std::max(0.0, cur_water - evacuated);

        if (band == IdealRacingGroove) {
            // Tires throw spray laterally out of the ideal groove onto both left and right off-line bands
            bin.water_mm[LeftOffLine] += 0.35 * evacuated;
            bin.water_mm[RightOffLine] += 0.35 * evacuated;
        } else {
            // Off-line passage throws a smaller fraction back toward the center groove
            bin.water_mm[IdealRacingGroove] += 0.15 * evacuated;
        }
    }

    // 2. Warm tire rubber deposition (rubbering-in)
    double dry_adhesion = clamp(1.0 - bin.water_mm[static_cast<std::size_t>(band)] / 4.5, 0.15, 1.0);
    double cur_rubber = bin.rubber[static_cast<std::size_t>(band)];
    double added_rubber = 0.32 * eff_dt * speed_factor * dry_adhesion * (1.0 - cur_rubber);
    bin.rubber[static_cast<std::size_t>(band)] = clamp(cur_rubber + added_rubber, 0.0, 1.0);
}

void DynamicTrackSurface::update_weather(double rain_rate_mm_per_s, double evaporation_mm_per_s, double dt) {
    if (dt <= 0.0) return;
    double net_water_delta = (rain_rate_mm_per_s - evaporation_mm_per_s) * dt;
    ambient_water_mm_ = std::max(0.0, ambient_water_mm_ + net_water_delta);
    double rain_wash = (rain_rate_mm_per_s > 0.0) ? std::exp(-0.025 * rain_rate_mm_per_s * dt) : 1.0;

    for (auto& bin : bins_) {
        for (std::size_t b = 0; b < 3; ++b) {
            bin.water_mm[b] = std::max(0.0, bin.water_mm[b] + net_water_delta);
            bin.rubber[b] = clamp(bin.rubber[b] * rain_wash, 0.0, 1.0);
        }
    }
}

double DynamicTrackSurface::water_depth_mm_at(double route_s, double lateral_m, double ideal_lateral_m) const {
    if (bins_.empty()) return ambient_water_mm_;
    int b_idx = bin_index(route_s);
    int band = band_index(lateral_m, ideal_lateral_m);
    return bins_[static_cast<std::size_t>(b_idx)].water_mm[static_cast<std::size_t>(band)];
}

double DynamicTrackSurface::grip_multiplier_at(double route_s, double lateral_m, double ideal_lateral_m) const {
    if (bins_.empty()) return 1.0;
    int b_idx = bin_index(route_s);
    int band = band_index(lateral_m, ideal_lateral_m);
    const TrackBin& bin = bins_[static_cast<std::size_t>(b_idx)];

    double water = bin.water_mm[static_cast<std::size_t>(band)];
    double rubber = bin.rubber[static_cast<std::size_t>(band)];

    // Up to +4.5% dry grip bonus (1.045) on a fully rubbered-in dry racing groove;
    // standing water attenuates the dry rubber bonus and lowers surface mu.
    double rubber_bonus = 0.045 * rubber * std::exp(-water / 1.5);
    double wet_loss = (water > 1e-6) ? 0.28 * (1.0 - std::exp(-water / 2.8)) : 0.0;
    return clamp(1.0 + rubber_bonus - wet_loss, 0.55, 1.045);
}

// -----------------------------------------------------------------------------
// 3. Physical Harmonic Engine & Turbo Acoustic Synthesizer State
// -----------------------------------------------------------------------------
EngineAcousticState compute_engine_acoustics(EngineAcousticLayout layout, double engine_rpm, double throttle,
                                             double boost_bar, bool bov_venting, bool shift_cut_active, int gear,
                                             double speed_mps) {
    EngineAcousticState st{};
    double rpm = std::max(0.0, engine_rpm);
    double thr = clamp(throttle, 0.0, 1.0);
    double boost = std::max(0.0, boost_bar);

    // Effective 4-stroke cylinder count N_cyl for f0 = (RPM / 60) * (N_cyl / 2)
    double n_cyl = 4.0;
    std::array<double, 6> base_harmonics{0.05, 1.00, 0.65, 0.25, 0.35, 0.12};

    switch (layout) {
        case EngineAcousticLayout::Inline4:
            n_cyl = 4.0;
            // Even 180-deg firing: dominant 2nd engine order (H1.0 firing fundamental) + 4th order (H2.0)
            base_harmonics = {0.04, 1.00, 0.68, 0.22, 0.36, 0.12};
            break;
        case EngineAcousticLayout::Inline6:
            n_cyl = 6.0;
            // Balanced primary/secondary forces with signature metallic 3rd-harmonic (H3.0) wail
            base_harmonics = {0.03, 0.84, 0.54, 0.94, 0.32, 0.50};
            break;
        case EngineAcousticLayout::CrossPlaneV8:
            n_cyl = 8.0;
            // 90-deg crank L-R-L-L-R-L-R-R uneven bank pulses: strong sub-harmonic H0.5 muscle burble
            base_harmonics = {0.84, 1.00, 0.46, 0.28, 0.20, 0.08};
            break;
        case EngineAcousticLayout::FlatPlaneV8:
            n_cyl = 8.0;
            // 180-deg crank alternating L-R-L-R bank firing: minimal H0.5, piercing H1.0/H2.0/H4.0 scream
            base_harmonics = {0.05, 0.96, 0.88, 0.34, 0.64, 0.26};
            break;
        case EngineAcousticLayout::Boxer4:
            n_cyl = 4.0;
            // Unequal-length exhaust header phase interference creates prominent H0.5 boxer rumble
            base_harmonics = {0.66, 1.00, 0.52, 0.24, 0.18, 0.09};
            break;
        case EngineAcousticLayout::Rotary2Rotor:
            n_cyl = 4.0;
            // Peripheral/side exhaust port sharpness generates dense upper harmonics (H2.0..H6.0)
            base_harmonics = {0.08, 0.88, 0.82, 0.75, 0.66, 0.52};
            break;
    }

    st.fundamental_firing_hz = (rpm / 60.0) * (n_cyl * 0.5);

    // Load and RPM slightly brighten upper harmonics while preserving layout character
    double load_bright = 0.88 + 0.12 * thr;
    for (std::size_t i = 0; i < 6; ++i) {
        double scale = (i >= 2) ? load_bright : 1.0;
        st.harmonic_weights[i] = clamp(base_harmonics[i] * scale, 0.0, 1.0);
    }

    // Turbocharger compressor shaft speed (0..155,000 RPM) & 11-blade whistle frequency
    if (boost > 1e-4) {
        double spool_norm = clamp(boost / 1.8, 0.0, 1.0);
        st.turbo_impeller_rpm = clamp(32000.0 + 123000.0 * std::pow(spool_norm, 0.55), 0.0, 155000.0);
    } else {
        st.turbo_impeller_rpm = 0.0;
    }
    st.turbo_whistle_hz = 11.0 * st.turbo_impeller_rpm / 60.0;

    // Wastegate / compressor surge flutter when blow-off valve vents on throttle lift
    st.wastegate_flutter_hz = bov_venting ? 28.0 : 0.0;

    // Straight-cut dog-box transmission gear tooth mesh frequency & gain
    double abs_speed = std::abs(speed_mps);
    double driveshaft_rps = (abs_speed / (2.0 * kPi * 0.325)) * 3.70;
    int eff_gear = std::max(0, gear);
    // Tooth count on engaged gear pair increases in higher gears
    double gear_teeth = (eff_gear == 1) ? 0.0 : (22.0 + 2.5 * clamp(static_cast<double>(eff_gear), 0.0, 7.0));
    st.transmission_whine_hz = driveshaft_rps * gear_teeth;
    if (eff_gear == 1 || abs_speed < 0.2) {
        st.transmission_whine_gain = 0.0;
    } else {
        double speed_norm = clamp(abs_speed / 55.0, 0.0, 1.0);
        double torque_load = 0.35 + 0.65 * thr;
        st.transmission_whine_gain = clamp(speed_norm * torque_load, 0.0, 1.0);
    }

    // Exhaust Gas Temperature (EGT, 320..950 C)
    double rpm_norm = clamp(rpm / 8000.0, 0.0, 1.0);
    double boost_norm = clamp(boost / 1.6, 0.0, 1.0);
    st.exhaust_gas_temp_c = clamp(320.0 + 360.0 * rpm_norm + 185.0 * thr + 85.0 * boost_norm, 320.0, 950.0);

    // Overrun unburnt-fuel pop/crackle intensity on high-RPM closed-throttle decel or dog-box flat-shift ignition cut
    double pop = 0.0;
    if (shift_cut_active && rpm > 3000.0) {
        pop = clamp(0.60 + 0.30 * clamp((rpm - 3000.0) / 4500.0, 0.0, 1.0) + 0.10 * boost_norm, 0.0, 1.0);
    }
    if (thr < 0.18 && rpm > 3200.0) {
        double rpm_factor = clamp((rpm - 3200.0) / 3600.0, 0.0, 1.0);
        double closed_factor = clamp((0.18 - thr) / 0.18, 0.0, 1.0);
        double overrun_pop = rpm_factor * closed_factor * (0.82 + 0.18 * boost_norm);
        pop = std::max(pop, clamp(overrun_pop, 0.0, 1.0));
    }
    st.overrun_pop_intensity = clamp(pop, 0.0, 1.0);

    return st;
}

}  // namespace rs
