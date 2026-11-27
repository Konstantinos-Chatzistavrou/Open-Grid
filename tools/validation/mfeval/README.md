# MFeval 4.3.1 (MATLAB source, vendored verbatim)

The MATLAB Magic Formula 5.2 / 6.1 / 6.2 evaluator by Marco Furlan Tassara, used here as the **reference** that `core/src/mf62.cpp` is compared with.

- Source: MATLAB File Exchange 63618, https://www.mathworks.com/matlabcentral/fileexchange/63618-mfeval (project site https://mfeval.wordpress.com/), version 4.3.1 (12 Mar 2021), downloaded as `mfeval-4.3.1.mltbx` (sha256 `bdcec2a15a394740e7b0bff333cded0daa2fe66703b46834cb2513224cb33cf3`).
- Licence: **BSD 3-Clause**, Copyright (c) 2020, Marco Furlan Tassara (`LICENSE.txt`, the file shipped in the package; its clause 3 has the organisation name left blank there). It stays with these files; it does not apply to the rest of this repository.
- The files are **unmodified** (byte-identical to the package):

| file | sha256 |
|---|---|
| `mfeval.m` | `48bfb5edb38a36a8b7f0263dfb5254e62a91540dca47a2987e3637a9fa7826a9` |
| `mfevalroot.m` | `8e947d253f9cea9be449757438871c7a85d272a349e3a34881443165af557d7c` |
| `Contents.m` | `f65589facc6fc8e10d942bd01f29830cf2995b162d699b400febe602bce2658d` |
| `+mfeval/Solver.m` | `068b1128a2f71b9820c146deea588073ebfa623884f8e285dcaa171583d11faa` |
| `+mfeval/readTIR.m` | `028e1bade0a18bac5da568cfebd7245c51e126268ffb6e1aa459bd82b8d95403` |
| `+mfeval/coefficientCheck.m` | `5f80839e2f71305b4bcf2042b93653e61968e7b56fb487b2353ddf183958db4f` |

- **Also vendored, verbatim: the six example tyre files** in `doc/examples/` (they ship inside the package under the same BSD-3-Clause licence; the author does not state where their data comes from):

| file | FITTYP | sha256 |
|---|---|---|
| `FSAE_Defaults.tir` | 61 | `926773983b9f1b7f7bf559e6258fd0467ff87b2d2e4692cde8312a8ed1296c67` |
| `MagicFormula52_Parameters.tir` | 6 | `f267d46489008c0bda1a2441b0ac3922b8d4d2429dff467b27b6694da75fe4cb` |
| `MagicFormula61_Parameters.tir` | 61 | `a7d1dbbb0a660f8a81ce69a492740aec5f25d1d5fa7390ca9ac13c3ae5b53bee` |
| `MagicFormula62_Parameters.tir` | 62 | `57eb8f4d577895542fd6e968b6253d87f44b75db26a0f3defc770bcedf0427b9` |
| `Model_Unstable.tir` | 61 | `e1a7a308d685e3b8a0242f9a7837cf529215bbc6d87bcf9ad8085b08f4864500` |
| `PacejkaBook_Defaults.tir` | 61 | `7ead04c26e4bc6c05cd19d39250d0bf1af42506e11acf007f429d96d5bfcea1a` |

  `Model_Unstable.tir` has `VERTICAL_STIFFNESS = 0` and `PKX1 = 0` (an invalid tyre by design): it is kept for completeness but not compared (MFeval itself returns NaN for several of its outputs).
- **Left out on purpose**: the Simulink libraries (1.7 MB of binary `.slx`), the documentation images and HTML, and `TyreData.mat`.
- Equations: Pacejka, *Tire and Vehicle Dynamics*, 3rd ed. revised (Elsevier 2012) section 4.3.2, and Besselink, Schmeitz, Pacejka (2010), Vehicle System Dynamics 48:1, 337-352, with the corrections that made it match the TNO MF-Tyre 6.1.2.1 solver (see the comments in `Solver.m`).

How it is used: `tools/validation/mfeval_reference.m` runs it over the operating points in `data/validation/mf62/mf62_cases.csv`; its output on these example tyres and on three more is committed in `data/validation/mf62/golden/`, and `core/tests/test_mf62.cpp` (test `mf62_golden`, part of ctest and CI) compares `rs::mf62` with it. See `docs/mf62.md`.
