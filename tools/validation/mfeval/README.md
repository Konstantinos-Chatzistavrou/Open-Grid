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

- **Left out on purpose**: the Simulink libraries (1.7 MB of binary `.slx`), the documentation images and HTML, and the example tyre files (`FSAE_Defaults.tir`, `MagicFormula5x/6x_Parameters.tir`, `PacejkaBook_Defaults.tir`, `Model_Unstable.tir`, `TyreData.mat`): their data origin is not stated, so they are used locally only and are not part of this repository.
- Equations: Pacejka, *Tire and Vehicle Dynamics*, 3rd ed. revised (Elsevier 2012) section 4.3.2, and Besselink, Schmeitz, Pacejka (2010), Vehicle System Dynamics 48:1, 337-352, with the corrections that made it match the TNO MF-Tyre 6.1.2.1 solver (see the comments in `Solver.m`).

How it is used: `tools/validation/mfeval_reference.m` runs it over the operating points in `data/validation/mf62/mf62_cases.csv`; `core/tests/test_mf62.cpp` (test `mf62_vs_mfeval`) compares the result with `rs::mf62`. See `docs/mf62.md`.
