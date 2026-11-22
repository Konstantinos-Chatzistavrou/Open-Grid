#include "rs/incandescence.hpp"
#include <algorithm>
#include <cmath>

namespace rs {

namespace {
// Piecewise Gaussian lobe (different widths left / right of the peak), wavelength in nm.
double lobe(double l, double mu, double s1, double s2) {
    const double t = (l - mu) / (l < mu ? s1 : s2);
    return std::exp(-0.5 * t * t);
}
// CIE 1931 2-degree colour matching functions, Wyman, Sloan & Shirley (2013) multi-lobe fit.
double cie_x(double l) { return 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2); }
double cie_y(double l) { return 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1); }
double cie_z(double l) { return 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8); }
}  // namespace

Incandescence incandescence(double temp_c, double emissivity) {
    Incandescence out;
    const double T = temp_c + 273.15;
    if (T <= 300.0 || emissivity <= 0.0) return out;
    constexpr double h = 6.62607015e-34, c = 2.99792458e8, k = 1.380649e-23;
    double X = 0, Y = 0, Z = 0;
    const double dl_nm = 2.0;
    for (double l = 380.0; l <= 780.0; l += dl_nm) {
        const double lm = l * 1e-9;
        const double x = h * c / (lm * k * T);
        if (x > 700.0) continue;                                         // exp overflow: nothing emitted here
        const double B = 2.0 * h * c * c / (lm * lm * lm * lm * lm) / std::expm1(x);   // W / (m^2 sr m)
        const double e = emissivity * B * dl_nm * 1e-9;                  // W / (m^2 sr) in this band
        X += e * cie_x(l);
        Y += e * cie_y(l);
        Z += e * cie_z(l);
    }
    X *= 683.0; Y *= 683.0; Z *= 683.0;                                  // lm/W -> cd/m^2 (nits)
    out.luminance_nits = Y;
    // XYZ -> linear sRGB (D65). Deep red light is outside sRGB (negative green): clamp, then restore the luminance.
    double r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    double g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    double b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    r = std::max(r, 0.0); g = std::max(g, 0.0); b = std::max(b, 0.0);
    const double lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const double s = lum > 0 ? Y / lum : 0.0;
    out.r = r * s; out.g = g * s; out.b = b * s;
    return out;
}

}  // namespace rs
