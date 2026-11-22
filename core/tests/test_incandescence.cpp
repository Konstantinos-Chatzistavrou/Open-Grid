// Incandescence of hot metal (brake discs): luminance and colour from Planck's law, CIE matching, 683 lm/W.
#include <cmath>
#include <cstdio>
#include "harness.hpp"
#include "rs/incandescence.hpp"

using namespace rs;

RS_TEST(incandescence) {
    const double temps[] = {400, 500, 525, 600, 700, 800, 900, 1000, 1100};
    double prev = 0, gr_600 = 0, gr_1000 = 0;
    bool monotonic = true;
    std::printf("         oxidised iron (emissivity 0.8):");
    for (double t : temps) {
        const Incandescence g = incandescence(t);
        std::printf(" %.0f C %.3g nit (g/r %.3f)%s", t, g.luminance_nits, g.r > 0 ? g.g / g.r : 0.0, t == 1100 ? "\n" : ",");
        if (g.luminance_nits < prev) monotonic = false;
        prev = g.luminance_nits;
        if (t == 600) gr_600 = g.g / g.r;
        if (t == 1000) gr_1000 = g.g / g.r;
    }
    // Draper point (~525 C): where hot iron starts to glow visibly in the dark. Below ~400 C nothing shows.
    test::check("no visible glow at 400 C", incandescence(400).luminance_nits < 1e-3);
    test::check_range("glow at the Draper point (525 C) is faint", incandescence(525).luminance_nits, 1e-3, 0.1, "nit");
    test::check_range("dull red at 700 C", incandescence(700).luminance_nits, 0.3, 5.0, "nit");
    test::check_range("bright at 900 C", incandescence(900).luminance_nits, 20, 300, "nit");
    test::check("brightness rises with temperature", monotonic);
    test::check("red at 600 C, toward orange by 1000 C", gr_600 < 0.15 && gr_1000 > gr_600 * 2);
    test::check("cold: nothing", incandescence(20).luminance_nits == 0.0);
}
