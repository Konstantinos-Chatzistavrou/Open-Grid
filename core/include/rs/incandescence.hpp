// Incandescence: the light a hot surface emits by itself (brake discs, exhausts, turbo housings), from physics.
// Planck's law times the surface emissivity, integrated against the CIE 1931 2-degree colour matching functions
// (the analytic multi-lobe fit of Wyman, Sloan & Shirley, JCGT 2013), 683 lm/W for luminance, XYZ -> linear sRGB.
// Engine-neutral: the web shader and the Unreal material take the same numbers (emissive in nits).
#pragma once

namespace rs {

struct Incandescence {
    double luminance_nits = 0;   // cd/m^2 of the glowing surface
    double r = 0, g = 0, b = 0;  // linear sRGB radiance per channel, nits (0.2126 r + 0.7152 g + 0.0722 b = luminance)
};

/** emissivity: oxidised cast iron ~0.6-0.95 in engineering tables (0.8 is a middle value); carbon-ceramic is similar. */
Incandescence incandescence(double temp_c, double emissivity = 0.8);

}  // namespace rs
