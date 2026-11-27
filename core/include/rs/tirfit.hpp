// Apache-2.0 - fit Magic Formula coefficients (MF 5.2 / 6.1 / 6.2 tyre property file) to measured tyre curves.
//
// The model IS rs::mf62::evaluate (validated against MFeval, docs/mf62.md), so a fitted tyre is exactly the model the tests and the game evaluate: nothing is re-derived here. Coefficients are fitted
// in stages, each a bounded Levenberg-Marquardt least-squares problem on one channel, each stage keeping the coefficients of the earlier ones:
//   1. Fx0   pure longitudinal slip (|alpha| ~ 0)        PCX1 PDX* PEX* PKX* PHX* PVX*  (+ camber / pressure terms when the data varies them)
//   2. Fy0   pure lateral slip (|kappa| ~ 0)             PCY1 PDY* PEY* PKY* PHY* PVY*
//   3. Mz0   pure aligning moment                        QBZ* QCZ1 QDZ* QEZ* QHZ*
//   4. Fx    combined slip weighting                     RBX* RCX1 REX* RHX1
//   5. Fy    combined slip weighting                     RBY* RCY1 REY* RHY* RVY*
// A stage without data is skipped and its coefficients stay at the template's values (the report says so). Mx, My, turn slip and the Mz of combined slip are not fitted.
//
// STATUS: checked on synthetic data (curves generated from known tyres, with and without noise: test tirfit_roundtrip), NOT on measured tyre data: none is in the repository. A fit can only be
// as good as the data: the report lists the rms error per stage, coefficients that sit on a bound and coefficients the data barely determines.
#pragma once
#include <limits>
#include <map>
#include <set>
#include <string>
#include <vector>
#include "rs/mf62.hpp"

namespace rs::tirfit {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

/** One measured point, in the tyre-file sign convention (the one MFeval and rs::mf62 use: a positive slip angle on a left tyre gives a negative Fy). A channel that was not measured is NaN. */
struct Sample {
    double fz = 0;        // N, positive load
    double kappa = 0;     // longitudinal slip
    double alpha = 0;     // rad
    double gamma = 0;     // rad
    double vx = 0;        // m/s, 0 = unknown (the file's LONGVL)
    double pressure = 0;  // Pa, 0 = unknown (the file's INFLPRES)
    double fx = kNaN, fy = kNaN, mz = kNaN, mx = kNaN;
};

/** Read a delimited text table (comma, semicolon or tab; '#' comments). Header names, case-insensitive: fz | load, kappa | sl | slip_ratio, alpha | sa | slip_angle (rad) or alpha_deg | sa_deg,
 *  gamma | ia | camber (rad) or gamma_deg | ia_deg | camber_deg, vx | speed (m/s), pressure | p (Pa) or pressure_kpa | p_kpa, fx, fy, mz, mx. `angle_sign` = -1 flips alpha and gamma
 *  (data in the SAE convention, where a positive slip angle gives a positive Fy). Negative Fz (TYDEX) is taken as its magnitude. */
bool read_csv(const std::string& text, std::vector<Sample>& out, std::string& error, double angle_sign = 1.0);

struct Options {
    int max_iterations = 150;
    double ridge = 1e-5;         // pull towards the starting values (relative to the fit's own error); keeps coefficients the data does not determine where they were
    int stiffness_restarts = 3;  // further starts with the slip stiffness x 0.6, x 1.6, only while the best fit is worse than 1 % of the peak
    bool fit_aligning = true;
    bool fit_combined = true;
};

struct Stage {
    std::string name, channel, note;
    int rows = 0, iterations = 0, restarts_tried = 0;
    bool ran = false, converged = false;
    double rms = 0, rms_percent_of_peak = 0, max_abs_error = 0, peak = 0;
    std::vector<std::string> fitted, at_bounds, weakly_determined;
};

struct Result {
    mf62::Params params;
    std::vector<Stage> stages;
    std::vector<std::string> notes;     // data and template findings (distinct loads, camber / pressure variation, limits widened, ...)
    std::set<std::string> fitted_keys;  // every coefficient a stage actually moved
};

/** Fit `data` starting from `tyre` (geometry, nominal load and every coefficient the data cannot determine come from it). The file's limits (slip, camber, load, pressure) are widened to span the data. */
Result fit(const mf62::Params& tyre, const std::vector<Sample>& data, const Options& opt = {});

/** Coefficient by TIR key (e.g. "PDX1"). False when the key is not one rs::mf62 reads. */
bool get_coefficient(const mf62::Params& p, const std::string& key, double& value);
bool set_coefficient(mf62::Params& p, const std::string& key, double value);

/** The coefficients a stage fits for a given data set (exposed for tests): stage = "fx0" | "fy0" | "mz0" | "fx" | "fy". */
std::vector<std::string> stage_keys(const std::string& stage, bool camber, bool pressure, mf62::Version version);

/** Text of a .tir file: `template_text` with every coefficient that differs between `before` and `after` (or is in `also`) rewritten, new ones appended in an [OPENGRID_FITTED] section,
 *  `header` lines (no '$') added on top as comments. */
std::string write_tir(const std::string& template_text, const mf62::Params& before, const mf62::Params& after, const std::set<std::string>& also, const std::vector<std::string>& header);

/** SYNTHETIC measurement: curves generated by rs::mf62 from a known tyre, for tests, demos and for trying the pipeline without data of your own. Pure kappa sweeps (Fx), pure alpha sweeps at each
 *  camber (Fy, Mz) and, if asked, a combined-slip set. Noise is Gaussian, `noise` x FNOMIN on the forces and x 0.05 m of that on Mz (a fixed seed: the same rows on every platform). */
struct SweepSpec {
    std::vector<double> loads = {0.5, 0.75, 1.0, 1.25, 1.5};  // x FNOMIN
    std::vector<double> gammas = {0.0, 0.05, 0.1};            // rad
    double slip_max = 0.25;                                    // kappa and alpha (rad) from -slip_max to +slip_max in steps of 0.01
    double noise = 0.0;
    bool combined = true;
};
std::vector<Sample> synthetic_sweep(const mf62::Params& truth, const SweepSpec& spec = {});

/** The rows as a table the CLI reads back (header: fz,kappa,alpha,gamma,vx,pressure,fx,fy,mz; empty cell = not measured). */
std::string to_csv(const std::vector<Sample>& rows);

std::string report_text(const Result& r);
std::string report_json(const Result& r);

}  // namespace rs::tirfit
