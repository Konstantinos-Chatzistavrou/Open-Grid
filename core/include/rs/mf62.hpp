// Pacejka Magic Formula MF 5.2 / 6.1 / 6.2 steady-state tyre model with a .tir reader (FITTYP 5 / 6 / 21 = MF 5.2 / PAC2002 family, 61, 62).
//
// STATUS (read this before quoting it): a complete, self-contained evaluator of forces, moments, loaded radius and relaxation lengths for one
// operating point, written against MFeval 4.3.1's MATLAB source and tested for internal consistency (tests/test_mf62.cpp) and by loading every
// committed tyre file. It is NOT yet driven by the vehicle (rs::magic_formula in tire.hpp is still the game's tyre model) and its numbers are
// NOT yet compared with MFeval's output (docs/mf62.md says how: a MATLAB / Octave run of tools/validation/mfeval_reference.m). Turn slip is as
// unvalidated as in MFeval itself (its own docs say so).
//
// Equations: H. B. Pacejka, "Tire and Vehicle Dynamics", 3rd ed. revised (Elsevier, 2012), section 4.3 and appendix 3; I. J. M. Besselink,
// A. J. C. Schmeitz, H. B. Pacejka, "An improved Magic Formula/Swift tyre model that can handle inflation pressure changes", Vehicle System
// Dynamics 48 (2010) 337-352. Where the book and the TNO solver differ (Bt, Dt, the equivalent slip angles, s, Mx, My, t * LFZO, the low-load
// and low-speed corrections) this follows MFeval, which was matched to the TNO MF-Tyre 6.1.2.1 solver. Stage order, corrections and use-mode
// logic are taken from MFeval's Solver.m (read directly); MFeval.jl was used as a first cross-reference and differs from Solver.m in places.
//
// Third-party notices (full texts in LICENSING.md):
//   MFeval, Copyright (c) 2020, Marco Furlan Tassara, BSD 3-Clause (MATLAB File Exchange 63618, https://mfeval.wordpress.com/)
//   MFeval.jl, Copyright (c) 2026 MFeval.jl contributors, MIT (https://github.com/matheusft/MFeval_julia): "MFeval.jl - High-Performance
//   Pacejka Magic Formula Tyre Model Implementation"
// SI units and the sign convention of TNO / MFeval files: +X forward, +Y left, and PKY1 < 0, so a positive slip angle gives a NEGATIVE lateral force.
#pragma once
#include <string>
#include <vector>

namespace rs::mf62 {

enum class Version { Mf52, Mf61, Mf62 };

// Every coefficient the steady-state solver reads, as X(field, "TIR KEY", default when the file does not give it). The defaults are those of
// MFeval.jl's reader (not checked against MATLAB's readTIR); real property files list all of them.
#define RS_MF62_COEFFS(X) \
    X(longvl, "LONGVL", 16.7) \
    X(vxlow, "VXLOW", 1.0) \
    X(unloaded_radius, "UNLOADED_RADIUS", 0.3135) \
    X(width, "WIDTH", 0.205) \
    X(aspect_ratio, "ASPECT_RATIO", 0.6) \
    X(rim_radius, "RIM_RADIUS", 0.1905) \
    X(inflpres, "INFLPRES", 220000.0) \
    X(nompres, "NOMPRES", 220000.0) \
    X(fnomin, "FNOMIN", 4000.0) \
    X(vertical_stiffness, "VERTICAL_STIFFNESS", 200000.0) \
    X(breff, "BREFF", 8.4) \
    X(dreff, "DREFF", 0.27) \
    X(freff, "FREFF", 0.07) \
    X(q_re0, "Q_RE0", 1.0) \
    X(q_v1, "Q_V1", 0.0) \
    X(q_v2, "Q_V2", 0.0) \
    X(q_fz2, "Q_FZ2", 0.0001) \
    X(q_fcx, "Q_FCX", 0.0) \
    X(q_fcy, "Q_FCY", 0.0) \
    X(pfz1, "PFZ1", 0.0) \
    X(bottom_offst, "BOTTOM_OFFST", 0.01) \
    X(longitudinal_stiffness, "LONGITUDINAL_STIFFNESS", 300000.0) \
    X(lateral_stiffness, "LATERAL_STIFFNESS", 100000.0) \
    X(pcfx1, "PCFX1", 0.0) \
    X(pcfx2, "PCFX2", 0.0) \
    X(pcfx3, "PCFX3", 0.0) \
    X(pcfy1, "PCFY1", 0.0) \
    X(pcfy2, "PCFY2", 0.0) \
    X(pcfy3, "PCFY3", 0.0) \
    X(q_ra1, "Q_RA1", 0.5) \
    X(q_ra2, "Q_RA2", 1.0) \
    X(q_rb1, "Q_RB1", 1.0) \
    X(q_rb2, "Q_RB2", -1.0) \
    X(presmin, "PRESMIN", 10000.0) \
    X(presmax, "PRESMAX", 1000000.0) \
    X(fzmin, "FZMIN", 100.0) \
    X(fzmax, "FZMAX", 10000.0) \
    X(kpumin, "KPUMIN", -1.5) \
    X(kpumax, "KPUMAX", 1.5) \
    X(alpmin, "ALPMIN", -1.5) \
    X(alpmax, "ALPMAX", 1.5) \
    X(cammin, "CAMMIN", -0.175) \
    X(cammax, "CAMMAX", 0.175) \
    X(lfzo, "LFZO", 1.0) \
    X(lcx, "LCX", 1.0) \
    X(lmux, "LMUX", 1.0) \
    X(lex, "LEX", 1.0) \
    X(lkx, "LKX", 1.0) \
    X(lhx, "LHX", 1.0) \
    X(lvx, "LVX", 1.0) \
    X(lcy, "LCY", 1.0) \
    X(lmuy, "LMUY", 1.0) \
    X(ley, "LEY", 1.0) \
    X(lky, "LKY", 1.0) \
    X(lhy, "LHY", 1.0) \
    X(lvy, "LVY", 1.0) \
    X(ltr, "LTR", 1.0) \
    X(lres, "LRES", 1.0) \
    X(lxal, "LXAL", 1.0) \
    X(lyka, "LYKA", 1.0) \
    X(lvyka, "LVYKA", 1.0) \
    X(ls, "LS", 1.0) \
    X(lkyc, "LKYC", 1.0) \
    X(lkzc, "LKZC", 1.0) \
    X(lvmx, "LVMX", 1.0) \
    X(lmx, "LMX", 1.0) \
    X(lmy, "LMY", 1.0) \
    X(lmp, "LMP", 1.0) \
    X(pcx1, "PCX1", 1.65) \
    X(pdx1, "PDX1", 1.3) \
    X(pdx2, "PDX2", -0.15) \
    X(pdx3, "PDX3", 0.0) \
    X(pex1, "PEX1", 0.0) \
    X(pex2, "PEX2", 0.0) \
    X(pex3, "PEX3", 0.0) \
    X(pex4, "PEX4", 0.0) \
    X(pkx1, "PKX1", 20.0) \
    X(pkx2, "PKX2", 0.0) \
    X(pkx3, "PKX3", 0.0) \
    X(phx1, "PHX1", 0.0) \
    X(phx2, "PHX2", 0.0) \
    X(pvx1, "PVX1", 0.0) \
    X(pvx2, "PVX2", 0.0) \
    X(ppx1, "PPX1", 0.0) \
    X(ppx2, "PPX2", 0.0) \
    X(ppx3, "PPX3", 0.0) \
    X(ppx4, "PPX4", 0.0) \
    X(rbx1, "RBX1", 20.0) \
    X(rbx2, "RBX2", 15.0) \
    X(rbx3, "RBX3", 0.0) \
    X(rcx1, "RCX1", 1.0) \
    X(rex1, "REX1", 0.0) \
    X(rex2, "REX2", 0.0) \
    X(rhx1, "RHX1", 0.0) \
    X(qsx1, "QSX1", 0.0) \
    X(qsx2, "QSX2", 0.0) \
    X(qsx3, "QSX3", 0.0) \
    X(qsx4, "QSX4", 5.0) \
    X(qsx5, "QSX5", 1.0) \
    X(qsx6, "QSX6", 10.0) \
    X(qsx7, "QSX7", 0.0) \
    X(qsx8, "QSX8", 0.0) \
    X(qsx9, "QSX9", 0.4) \
    X(qsx10, "QSX10", 0.0) \
    X(qsx11, "QSX11", 5.0) \
    X(qsx12, "QSX12", 0.0) \
    X(qsx13, "QSX13", 0.0) \
    X(qsx14, "QSX14", 0.0) \
    X(ppmx1, "PPMX1", 0.0) \
    X(pcy1, "PCY1", 1.3) \
    X(pdy1, "PDY1", 1.1) \
    X(pdy2, "PDY2", -0.15) \
    X(pdy3, "PDY3", 0.0) \
    X(pey1, "PEY1", 0.0) \
    X(pey2, "PEY2", 0.0) \
    X(pey3, "PEY3", 0.0) \
    X(pey4, "PEY4", 0.0) \
    X(pey5, "PEY5", 0.0) \
    X(pky1, "PKY1", -20.0) \
    X(pky2, "PKY2", 1.0) \
    X(pky3, "PKY3", 0.0) \
    X(pky4, "PKY4", 2.0) \
    X(pky5, "PKY5", 0.0) \
    X(pky6, "PKY6", -1.0) \
    X(pky7, "PKY7", 0.0) \
    X(phy1, "PHY1", 0.0) \
    X(phy2, "PHY2", 0.0) \
    X(pvy1, "PVY1", 0.0) \
    X(pvy2, "PVY2", 0.0) \
    X(pvy3, "PVY3", 0.0) \
    X(pvy4, "PVY4", 0.0) \
    X(ppy1, "PPY1", 0.0) \
    X(ppy2, "PPY2", 0.0) \
    X(ppy3, "PPY3", 0.0) \
    X(ppy4, "PPY4", 0.0) \
    X(ppy5, "PPY5", 0.0) \
    X(rby1, "RBY1", 10.0) \
    X(rby2, "RBY2", 10.0) \
    X(rby3, "RBY3", 0.0) \
    X(rby4, "RBY4", 0.0) \
    X(rcy1, "RCY1", 1.0) \
    X(rey1, "REY1", 0.0) \
    X(rey2, "REY2", 0.0) \
    X(rhy1, "RHY1", 0.0) \
    X(rhy2, "RHY2", 0.0) \
    X(rvy1, "RVY1", 0.0) \
    X(rvy2, "RVY2", 0.0) \
    X(rvy3, "RVY3", 0.0) \
    X(rvy4, "RVY4", 20.0) \
    X(rvy5, "RVY5", 2.0) \
    X(rvy6, "RVY6", 10.0) \
    X(qsy1, "QSY1", 0.01) \
    X(qsy2, "QSY2", 0.0) \
    X(qsy3, "QSY3", 0.0004) \
    X(qsy4, "QSY4", 4e-05) \
    X(qsy5, "QSY5", 0.0) \
    X(qsy6, "QSY6", 0.0) \
    X(qsy7, "QSY7", 0.85) \
    X(qsy8, "QSY8", -0.4) \
    X(qbz1, "QBZ1", 10.0) \
    X(qbz2, "QBZ2", 0.0) \
    X(qbz3, "QBZ3", 0.0) \
    X(qbz4, "QBZ4", 0.0) \
    X(qbz5, "QBZ5", 0.0) \
    X(qbz9, "QBZ9", 10.0) \
    X(qbz10, "QBZ10", 0.0) \
    X(qcz1, "QCZ1", 1.1) \
    X(qdz1, "QDZ1", 0.12) \
    X(qdz2, "QDZ2", 0.0) \
    X(qdz3, "QDZ3", 0.0) \
    X(qdz4, "QDZ4", 0.0) \
    X(qdz6, "QDZ6", 0.0) \
    X(qdz7, "QDZ7", 0.0) \
    X(qdz8, "QDZ8", -0.05) \
    X(qdz9, "QDZ9", 0.0) \
    X(qdz10, "QDZ10", 0.0) \
    X(qdz11, "QDZ11", 0.0) \
    X(qez1, "QEZ1", 0.0) \
    X(qez2, "QEZ2", 0.0) \
    X(qez3, "QEZ3", 0.0) \
    X(qez4, "QEZ4", 0.0) \
    X(qez5, "QEZ5", 0.0) \
    X(qhz1, "QHZ1", 0.0) \
    X(qhz2, "QHZ2", 0.0) \
    X(qhz3, "QHZ3", 0.0) \
    X(qhz4, "QHZ4", 0.0) \
    X(ppz1, "PPZ1", 0.0) \
    X(ppz2, "PPZ2", 0.0) \
    X(ssz1, "SSZ1", 0.0) \
    X(ssz2, "SSZ2", 0.0) \
    X(ssz3, "SSZ3", 0.0) \
    X(ssz4, "SSZ4", 0.0) \
    X(pdxp1, "PDXP1", 0.4) \
    X(pdxp2, "PDXP2", 0.0) \
    X(pdxp3, "PDXP3", 0.0) \
    X(pkyp1, "PKYP1", 1.0) \
    X(pdyp1, "PDYP1", 0.4) \
    X(pdyp2, "PDYP2", 0.0) \
    X(pdyp3, "PDYP3", 0.0) \
    X(pdyp4, "PDYP4", 0.0) \
    X(phyp1, "PHYP1", 1.0) \
    X(phyp2, "PHYP2", 0.15) \
    X(phyp3, "PHYP3", 0.0) \
    X(phyp4, "PHYP4", -4.0) \
    X(pecp1, "PECP1", 0.5) \
    X(pecp2, "PECP2", 0.0) \
    X(qdtp1, "QDTP1", 10.0) \
    X(qcrp1, "QCRP1", 0.2) \
    X(qcrp2, "QCRP2", 0.1) \
    X(qbrp1, "QBRP1", 0.1) \
    X(qdrp1, "QDRP1", 1.0) \
    X(q_a1, "Q_A1", 0.0) \
    X(q_a2, "Q_A2", 0.0) \
    X(phy3, "PHY3", 0.0) \
    X(ptx1, "PTX1", 0.0) \
    X(ptx2, "PTX2", 0.0) \
    X(ptx3, "PTX3", 0.0) \
    X(pty1, "PTY1", 0.0) \
    X(pty2, "PTY2", 0.0) \
    X(lsgkp, "LSGKP", 1.0) \
    X(lsgal, "LSGAL", 1.0) \
    X(q_fcy2, "Q_FCY2", 0.0) \
    X(q_cam1, "Q_CAM1", 0.0) \
    X(q_cam2, "Q_CAM2", 0.0) \
    X(q_cam3, "Q_CAM3", 0.0) \
    X(q_fys1, "Q_FYS1", 0.0) \
    X(q_fys2, "Q_FYS2", 0.0) \
    X(q_fys3, "Q_FYS3", 0.0)

struct Params {
#define RS_MF62_FIELD(field, key, def) double field = def;
    RS_MF62_COEFFS(RS_MF62_FIELD)
#undef RS_MF62_FIELD
    int fittyp = 62;                 // 5, 6 or 21: MF 5.2 / PAC2002 family, 61: MF 6.1, 62: MF 6.2
    std::string tyreside = "LEFT";   // 'LEFT' or 'RIGHT' as written in the file (not used by the solver, MFeval does not mirror either)
    Version version() const { return fittyp == 62 ? Version::Mf62 : fittyp == 61 ? Version::Mf61 : Version::Mf52; }
};

/** Parse the text of a .tir file. FITTYP 5, 6, 21 = the MF 5.2 / PAC2002 family (a file with PROPERTY_FILE_FORMAT = 'PAC2002' and no FITTYP counts as 21), 61, 62;
 *  false + `error` otherwise. Unknown keys are ignored. */
bool parse_tir(const std::string& text, Params& out, std::string& error);
bool load_tir_file(const std::string& path, Params& out, std::string& error);

/** The three switches of MFeval's 3-digit useMode: hundreds 1 = apply the file's limits / 2 = skip them, tens 1 = alpha / 2 = alpha* = tan(alpha)
 *  and gamma* = sin(gamma), units 1 = no turn slip / 2 = turn slip. Anything else is invalid and evaluate() returns NaN (as MFeval does). */
struct Modes {
    bool limits_check = true, alpha_star = false, turn_slip = false, valid = true;
};
Modes modes_from_use_mode(int use_mode);

struct Input {
    double fz = 0;        // N
    double kappa = 0;     // longitudinal slip (-1 = locked wheel)
    double alpha = 0;     // rad
    double gamma = 0;     // rad, inclination
    double phit = 0;      // 1/m, turn slip
    double vx = 0;        // m/s
    double pressure = 0;  // Pa, 0 = the file's INFLPRES
    double omega = 0;     // rad/s, 0 = estimated from vx and kappa
};

/** All 30 outputs in MFeval's column order. Slips are echoed as given (kappa after the low-speed reduction), pressure after the file's limits. */
struct Output {
    double fx = 0, fy = 0, fz = 0, mx = 0, my = 0, mz = 0;
    double kappa = 0, alpha = 0, gamma = 0, phit = 0, vx = 0, pressure = 0;
    double re = 0, rho = 0, two_a = 0, t = 0, mux = 0, muy = 0, omega = 0, rl = 0, two_b = 0, mzr = 0;
    double cx = 0, cy = 0, cz = 0, kya = 0, sigmax = 0, sigmay = 0;
    double inst_kya = 0;  // MFeval fills it from neighbouring points of a sweep; a single evaluation leaves 0
    double kxk = 0;
};

Output evaluate(const Params& p, const Input& in, const Modes& modes);

/** Evaluate a series of points in order. Identical to calling evaluate() on each, plus MFeval's inst_kya = diff(Fy) / diff(alpha) between neighbours
 *  (the last value repeated; a single point leaves 0). */
std::vector<Output> evaluate_series(const Params& p, const std::vector<Input>& in, const Modes& modes);

}  // namespace rs::mf62
