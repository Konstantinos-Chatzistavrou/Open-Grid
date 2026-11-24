# Downforce, lift and aero validation — legal data and what it can (and cannot) prove

Last updated 2026-11-24. Companion to `data/physics/aero_reference.json` and `tools/physics/aero_check.mjs`.

## Why this exists

Open Grid's car configs carry authored aero values (`drag_area_m2` = CdA, `downforce_area_m2` = ClA,
`front_balance`, `ground_effect_per_m`, `pitch_balance_per_m`). Those are **game values**, not measurements of
the fictional cars. This page records the legally usable reference data we could verify, and the plausibility
checks we run against it. It does not turn authored values into measured ones.

## Reference data (all legal to use)

| reference | values | source | licence |
|---|---|---|---|
| DrivAer fastback, smooth underbody | Cd = **0.243** | Elrefaie et al., *DrivAerNet++*, arXiv:2406.09624v1, Table 6 (experiment column) | **CC BY 4.0** (paper; values are the authors' reported measurements) |
| DrivAer fastback, detailed underbody | Cd = **0.275** | same | CC BY 4.0 |
| DrivAer notchback | Cd = **0.246** | same | CC BY 4.0 |
| DrivAer estateback | Cd = **0.292** | same | CC BY 4.0 |
| Ahmed body, 25° slant | Cd = **0.285** | Ahmed (1984), SAE 840300 — cited as a scientific fact, paper not redistributed | citation only |
| NACA 0012 aerofoil | clα ≈ **0.10 /deg**, cl_max ≈ **1.4**, cd_min ≈ **0.006** | Abbott & von Doenhoff, NACA Report 824 (1945) | **public domain** (US Government work) |

No measured **downforce** figures for production road cars are included: manufacturers rarely publish them, and
the numbers that circulate are usually CFD or marketing. Race-car ClA datasets that exist (FSAE TTC, Calspan,
team wind-tunnel reports) are licence-restricted and were rejected.

## What the checker does

`node tools/physics/aero_check.mjs [--speed 200]` loads every `data/cars/*.json` and, at the stated speed:

1. computes drag and downforce from CdA/ClA (`F = q·C·A`, q = ½ρv², ρ = 1.225 kg/m³);
2. checks **CdA** against a road-to-race envelope, and for low-downforce cars against the DrivAer-derived CdA
   band (Cd 0.243–0.292 × **assumed** frontal area 1.8–2.2 m², widened by 0.8–1.2);
3. checks **ClA** against a wing bound: cl_max 1.4 × **assumed** 1.0 m² device area, +15 % underbody allowance;
4. checks **L/D** (ClA/CdA) inside 0–2.5 and **front_balance** inside 0.30–0.60 whenever ClA > 0.1.

Every assumption is printed by the tool and stored in `aero_reference.json`; none is a measured value.

### Current result (200 km/h, 25 cars)

```
checked 25 cars, 0 without aero, 0 failure(s)
Tornado GT3        CdA 0.780  ClA 1.48  L/D 1.90   2798 N downforce
Falcorn 9R GT      CdA 0.880  ClA 1.15  L/D 1.31   2174 N
Kestrel GT         CdA 0.880  ClA 1.15  L/D 1.31   2174 N
...
Hayate             CdA 0.635  ClA 0.18  L/D 0.28    340 N
Mistra 200T        CdA 0.685  ClA 0.02  L/D 0.03     38 N
```

The highest-ClA car (Tornado GT3, 1.48 m²) sits just under the 1.61 m² wing bound; that is a plausibility
result, not evidence that its downforce is correct.

## What this proves — and what it does not

- **Proves:** our aero numbers are physically plausible at a stated speed, consistent with an open,
  measured passenger-car drag reference and a public-domain wing bound; nothing is wildly out of family.
- **Does not prove:** that any car's downforce matches reality. Only a wind tunnel or a validated CFD run of that
  specific body can do that. Front/rear balance is especially under-determined: published balance data for
  road cars is rare, and our `front_balance` remains an authored tuning value.
- `ground_effect_per_m` and `pitch_balance_per_m` have **no** public measured reference we could verify; they
  are game tuning parameters and are not validated here.

## To go further (legal routes)

1. **DrivAer geometry + CFD**: the DrivAer body is an open reference geometry; running our own CFD (or using the
   CC BY DrivAerNet++ coefficient tables) would give per-configuration Cd/Cl to validate the *solver*, not our cars.
2. **Ahmed body**: reproduce the 25° case in our own aero model to check the drag trend with slant angle.
3. **Per-car aero**: needs a wind tunnel or validated CFD of the actual body — not obtainable from public data.

## Rejected sources (and why)

- **SAE / Elsevier / Springer paywalled tables** — cannot redistribute; not fetched.
- **Manufacturer press charts** — copyrighted presentation, and usually not measured.
- **FSAE TTC, Calspan/TIRF, team wind-tunnel databases** — licence-restricted.
- **MDPI / TUM mediaTUM PDFs** — CC BY in principle, but the endpoints returned bot-protection HTML during this
  pass, so no values were taken from them; only the arXiv table above was verified from the actual text.
- **DrivAerNet++ dataset itself** — large; not stored. The *paper's* coefficient table (CC BY 4.0) is what we cite.

## Reproduce

```bash
node tools/physics/aero_check.mjs --speed 200
node tools/validate_mod.mjs --dir data/cars
node tools/assets/check_licences.mjs
```
