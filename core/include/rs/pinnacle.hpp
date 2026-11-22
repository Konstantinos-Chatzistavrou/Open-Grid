// Pinnacle simulation extensions:
//   1. Hydroplaning (Aquaplaning Water-Wedge Physics based on Horne's NASA equation)
//   2. Dynamic Racing Line (Rubbering-In & Wet Drying Groove across 3 lateral bands)
//   3. Physical Harmonic Engine & Turbo Acoustic Synthesizer State (for UE5 MetaSounds / WebAudio)
// Engine-agnostic C++17, SI units.
#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <vector>
#include "rs/math.hpp"

namespace rs {

// -----------------------------------------------------------------------------
// 1. Hydroplaning (Aquaplaning Water-Wedge Physics)
// -----------------------------------------------------------------------------
struct HydroplaningState {
    double water_depth_mm = 0.0;
    double remaining_tread_mm = 7.5;        // 7.5 mm new street tread down to 1.2 mm at wear = 1.0
    double onset_speed_mps = 100.0;         // Horne's NASA hydroplaning onset speed adapted for tread & film thickness
    double wedge_lift_fraction = 0.0;       // 0..0.90 hydrodynamic water-wedge vertical lift fraction
    double effective_load_scale = 1.0;      // 1.0 - wedge_lift_fraction
    double ffb_aligning_torque_scale = 1.0; // 1.0 - 0.85 * wedge_lift_fraction (steering goes light on aquaplane)
};

HydroplaningState compute_hydroplaning(double speed_mps, double pressure_kpa, double tire_wear_0_to_1,
                                       double water_depth_mm);

/**
 * Wet-road friction factor (1 = dry) for a tyre rolling at speed_mps through a water film water_depth_mm deep.
 * Two effects, both measured:
 *  - a damp film lubricates the road texture: friction holds until a critical depth, then drops (inverse-S;
 *    the critical depth falls from ~0.34 mm at 20-40 km/h to ~0.15 mm at 60 km/h: Beautru, IFSTTAR);
 *  - above it the tread must clear the water from the contact patch, which gets harder with speed, water depth
 *    (log law, Veith) and wear: friction / (1 + (v / v_d)^2), v_d scaled from the Horne onset speed.
 * Calibrated to Continental's wet ABS stops from 80 km/h (new 25.8 m, 3 mm 31.0 m, 1.6 mm 36.2 m). The full
 * water-wedge lift (hydroplaning) is compute_hydroplaning and acts on the load, not the friction.
 */
double wet_grip_factor(double speed_mps, double pressure_kpa, double tire_wear_0_to_1, double water_depth_mm);

// -----------------------------------------------------------------------------
// 2. Dynamic Racing Line (Rubbering-In & Wet Drying Groove)
// -----------------------------------------------------------------------------
enum TrackLateralBand : int {
    LeftOffLine = 0,
    IdealRacingGroove = 1,
    RightOffLine = 2
};

class DynamicTrackSurface {
public:
    explicit DynamicTrackSurface(double route_length_m = 2000.0, double ambient_water_mm = 0.0,
                                 double bin_length_m = 10.0);

    void set_ambient_water_mm(double water_mm);
    void record_car_passage(double route_s, double lateral_m, double ideal_lateral_m, double speed_mps, double dt);
    void update_weather(double rain_rate_mm_per_s, double evaporation_mm_per_s, double dt);

    double water_depth_mm_at(double route_s, double lateral_m, double ideal_lateral_m) const;
    double grip_multiplier_at(double route_s, double lateral_m, double ideal_lateral_m) const;

private:
    struct TrackBin {
        std::array<double, 3> water_mm{0.0, 0.0, 0.0};
        std::array<double, 3> rubber{0.0, 0.0, 0.0};
    };

    double route_length_m_ = 2000.0;
    double ambient_water_mm_ = 0.0;
    double bin_length_m_ = 10.0;
    std::vector<TrackBin> bins_;

    int bin_index(double route_s) const;
    static int band_index(double lateral_m, double ideal_lateral_m);
};

// -----------------------------------------------------------------------------
// 3. Physical Harmonic Engine & Turbo Acoustic Synthesizer State
// -----------------------------------------------------------------------------
enum class EngineAcousticLayout : int {
    Inline4 = 0,
    Inline6 = 1,
    CrossPlaneV8 = 2,
    FlatPlaneV8 = 3,
    Boxer4 = 4,
    Rotary2Rotor = 5
};

struct EngineAcousticState {
    double fundamental_firing_hz = 0.0;           // f0 = (RPM / 60) * (N_cyl / 2)
    std::array<double, 6> harmonic_weights{};     // [0]=H0.5, [1]=H1.0, [2]=H2.0, [3]=H3.0, [4]=H4.0, [5]=H6.0
    double turbo_impeller_rpm = 0.0;              // 0..155,000 RPM compressor shaft speed
    double turbo_whistle_hz = 0.0;                // 11 blades * impeller_rpm / 60
    double wastegate_flutter_hz = 0.0;            // 28 Hz compressor surge flutter when bov_venting is true
    double transmission_whine_hz = 0.0;           // straight-cut gear tooth mesh frequency
    double transmission_whine_gain = 0.0;         // 0..1
    double exhaust_gas_temp_c = 420.0;            // EGT, 320..950 C
    double overrun_pop_intensity = 0.0;           // 0..1 unburnt fuel crackle/flame intensity
};

EngineAcousticState compute_engine_acoustics(EngineAcousticLayout layout, double engine_rpm, double throttle,
                                             double boost_bar, bool bov_venting, bool shift_cut_active, int gear,
                                             double speed_mps);

}  // namespace rs
