# How NFS Heat customisation works, and what it means for us

Checked 2026-11-18 against the game's tuning flow (paint / visual parts / decals).

## Heat's model

1. **Every car has its own authored parts.** Body kits are not generic add-ons: each kit is modelled for that
   body, with the same mount points as the stock panels. That is why nothing floats or clips in Heat.
2. **A kit is a set, not a piece.** Choosing "body kit" swaps several panels together (front bumper, rear bumper,
   side skirts, fenders, sometimes the hood), so the car keeps one coherent silhouette.
3. **The stock panel is hidden, never covered.** When a bumper or spoiler is replaced, the original mesh is
   removed from the render set, so two parts can never occupy the same space.
4. **Fenders are body panels.** Wheel-arch flares are widened bodywork (the arch is cut and re-skinned), not a
   ring of trim stuck on the surface.
5. **Stance and wheels are separate systems**: ride height, camber, wheel size, rim style, tyre lettering.
6. **Paint and livery are decoupled from geometry**: base paint (gloss/matte/metallic/chrome), then a wrap
   layer with decals, both shader-side.

## What this means for Open Grid

- Our parts must be either (a) authored GLBs shrink-wrapped to the car's own surface, or (b) derived from the
  car's own panel geometry - never a primitive positioned by eye.
- Selecting a non-stock part must hide the stock mesh for that slot (wing, bumper, hood, fender). This is the
  "two spoilers" class of bug and the fix belongs in the visibility/stock-swap layer, not the part.
- Fender flares should be derived from the body's arch region (scale outward, smooth into the panel at the ends)
  rather than a constant torus ring.
- Generic "one shape fits every car" parts are acceptable only for non-structural trim (badges, tow straps).
