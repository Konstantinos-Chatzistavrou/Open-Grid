# October drafts: what was in them, and what happened to each idea

In October 2026 several agent sessions were cut off before they committed. Their uncommitted work sat in 14 local
worktrees under `.claude/worktrees/`. Their committed work was already on `main` (it went in under different
commit ids after the history was rewritten). On 2026-11-22 every uncommitted change was read, compared with
`main`, ported where it still fits, and the worktrees were removed. This page lists every idea so none is lost.

Status:
- **Ported**: now on `main`, tested.
- **On main**: `main` already does it, usually in a later and fuller form.
- **Not ported**: left out on purpose, with the reason. Some are proposals for later.

## 1. Handling tests ("realism pass", 591 lines of C++ tests)

The largest draft: 10 whole-car tests of tyre heat, wear and pressure, brakes, steering feel, differentials,
aero and driving manoeuvres. All 10 are ported to today's core as `core/tests/test_handling.cpp`. They run in
ctest and CI and pass under ASan/UBSan.

Rule used for the port: a check asserts only what physics or a textbook result says must happen (a direction,
an exact law such as v² or the ideal gas law, or a sourced range). The draft's guessed magnitudes are printed,
not asserted.

| Test | What it checks | Measured on `main` (vela_gt) |
|---|---|---|
| `tyre_thermal` | grip window, cornering heats the outer tyre most, hot tyres carry more pressure, cooked and worn tyres grip less, pressure terms are live | grip factor 0.906 at 20 °C, 1.000 at 90 °C, 0.793 at 160 °C; skidpad new 1.006 g, 50 % worn 0.978 g, fully worn 0.887 g |
| `brake_cold_pads` | cold pads stop longer than warm ones, within what the pad curve allows | 60 mph, 45 % pedal: 55.2 m cold vs 49.6 m warm (pad curve allows 1.14x) |
| `steering_feel` | no torque on a straight, restoring torque rises with g and falls past the peak (the wheel goes light), torque grows with speed | 129 / 239 / 300 Nm at 0.3 / 0.6 / 0.9 g, 116 Nm at the limit |
| `diff_split_mu` | LSD and locked diffs beat an open diff with one side on grass | 1.5 s: open 2.7 m, LSD 3.7 m, locked 3.7 m |
| `aero` | downforce follows v², nose dives under braking, coast-down is at least drag + rolling | 163 / 621 / 844 N at 100 / 200 / 250 km/h |
| `understeer_gradient` | understeer in the linear range, growing to the limit; stiffer front bar = more understeer; tyre load sensitivity | 2.50 / 2.25 / 2.80 deg/g at 0.3 / 0.6 / 0.9 g |
| `trail_braking` | the car turns in tighter as brake pressure rises with the steering held | curvature vs the circle: 1.14 coasting, 1.42 at 25 %, 1.92 at 50 % pedal |
| `handbrake_slide` | the handbrake breaks the rear loose | peak sideslip 17° without, 88° with |
| `snap_oversteer` | a throttle stab with ESC/TC off spins the car; lifting and counter-steering catches it | unattended 89°, recovered to 0.0° |
| `curb_strike` | 100 km/h over a 5 cm kerb with the right wheels: the body rolls, the heading barely moves, nothing launches | roll 1.6°, heading change 0.07° |

To set the tyres for these tests the core gained `Vehicle::set_tyres(temp_c, wear)`, a test and tooling hook
like the existing `set_brake_temperature`. `brake_pad_mu` is now declared in `vehicle.hpp`.

While porting, six tests that already existed on `main` turned out to be missing from ctest, so CI never ran
them: `anti_pitch`, `brake_fade`, `h_shifter`, `self_aligning`, `pedal_reverse`, `wreck_drivable_fire_brakes`.
All six pass and are now registered.

### Open findings from these tests (not changed, for a decision)

1. **Cold tyres grip as well as warm ones.** On a fast skidpad ramp, tyres soaked at 20 °C reach 0.990 g and
   tyres at 90 °C reach 0.989 g. The compound alone loses about 9 % at 20 °C (grip factor 0.906), so another
   term cancels it. Candidates: the lower cold pressure through the MF 6.1 pressure coefficients, or the
   rib WLF grip. Real cold tyres grip noticeably less. The check is printed, not asserted, until this is
   decided.
2. **Grip-limited cornering never wears the tread.** By design (tire.cpp, 2026-11-05), wear only accrues
   while a tyre slides (above 18 kW of slip power per tyre). Real treads abrade in proportion to friction
   work, with no such threshold. Over a race distance this matters for strategy.
3. **Lower pressure always grips more.** 138 / 188 / 258 kPa cold give 1.070 / 1.006 / 0.933 g. This matches
   MF 6.1 data for peak friction, so it is not asserted as wrong. Real tyres also lose response and heat
   control when soft, and the model has no penalty for that yet.
4. **Cruise temperatures stay near 75 °C** (90 s at 10–55 m/s from 80 °C), close to the model's equilibrium
   of 78 °C. That is warmer than road tyres usually run on a highway; it may be intentional (spawn with warm
   tyres).

## 2. Car customisation (`look.ts`, 516 lines)

| Idea | Status |
|---|---|
| Procedural rims (5 styles), rim colour, caliper colour | On main (`scene/custom.ts`, `scene/parts/`, 21 parts) |
| Spoilers, splitters, skirts, diffusers as parts | On main, with more parts and a physics effect per part (`partEffect`) |
| Window tint, headlight colour, underglow | On main (`custom-data.ts`) |
| Livery as a texture-free shader | On main (4 liveries) |
| Camber as a look option with a grip effect | On main as setup (`setStance`, core setup) |
| Compact look code for the network | On main (`cleanCustom` validation over the net) |
| **Rim size** (−2 to +3 inch) with the tyre sidewall shrinking to match | **Not ported. Proposal**: a real car mod with real physics (lower profile = stiffer sidewall, shorter relaxation length, more unsprung mass). It is visual too, so it needs a look review first |
| Second livery colour and a "fade" livery | Not ported: visual, needs a look review |

## 3. Phone tier and frame pacing (`quality.ts`, `perf.ts`, `lod.ts`, `glb_lowres.mjs`)

| Idea | Status |
|---|---|
| Device tiers (phone vs desktop budgets) | On main as presets plus potato mode (by GPU name) |
| Frame cap with even pacing | On main (`main.ts` cap, `bench.ts`) |
| Texture and memory accounting | On main (`stats.ts`, HUD line) |
| No pull-to-refresh or pinch zoom | On main (CSS `overscroll-behavior` / `touch-action`) |
| **Keep the screen awake while driving** (Screen Wake Lock) | **Ported**: `web/src/wakeLock.ts`, on in race / countdown / spectate. Also helps gamepad drivers on laptops |
| Lower fps cap in menus to save battery | Not ported: menus already run the potato/touch caps; worth measuring on a phone first |
| Keep only the street lights along the route | Not ported: city rendering is frozen for the UE 5.8 move (docs/ue5_roadmap.md) |
| Merged low-detail traffic car beyond 45 m (~6 draw calls instead of ~53) | Not ported: same freeze; UE has its own LOD system |
| `glb_lowres.mjs`: drop the top mip of KTX2 textures inside a GLB without re-encoding | Not ported: it targeted the old single `city.glb` (replaced by streaming). The idea is sound for phone car models if needed |
| Phone copies of the old city files (13 MB) | Dropped: the old city file is gone |

## 4. Night street effects (`nightfx.ts`) and facade tweaks

| Idea | Status |
|---|---|
| Lamp and neon halos through night air | On main in another form (`post.ts`) |
| Headlight beam haze cones | Not ported: rendering work is frozen for the UE 5.8 move; UE has volumetric fog for this |
| Tail-light glow with the brake pedal | On main (`scene/car.ts`, brake-light response) |
| Facade: dimmer window emissive, shop interior gradient, wall glow near the street | Not ported: city rendering freeze |

## 5. Physics draft side changes

| Idea | Status |
|---|---|
| Tyre temperatures, brake temperatures and pad friction in the HUD | On main (brake, clutch, gearbox, flat-spot and blistering chips; inner / middle / outer tyre temperatures in the telemetry panel) |
| Gamepad rumble from tyre grip and ABS | On main (`input.ts`) |
| Set tyre temperature, wear and pressure from the web (cold starts, used tyres) | Core hook added (`set_tyres`); not yet exposed to the web bridge |
| **Per-car tyre compounds and brake sizes** (touring vs GT vs GTR) | **Not ported. Proposal**: the core already reads `temp_optimal_c`, `temp_window_c`, `pressure_cold_kpa` and the brake disc fields from car JSON, but no car sets them, so every car shares one compound. The draft's numbers had no sources; real values need data |
| Smaller caster trail and pneumatic trail, bigger disc heat capacity | Not ported: tuning without sources |

## 6. Test-page tweaks

Extra loading messages in two NYC test pages and new camera spots for the building test. These are small
debugging changes, already superseded. Not ported.
