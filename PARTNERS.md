# Work with Open Grid

Open Grid is an open-source vehicle-dynamics core and racing simulator, created and maintained by Konstantinos Chatzistavrou (https://github.com/Konstantinos-Chatzistavrou) with contributors. The code is free to use under the
Apache License 2.0 whether or not you talk to anyone: you do not need to partner to use it, and you must keep its `NOTICE` (`LICENSING.md`). Partnership is for people who want more than that.

## What exists today (all of it checkable: `docs/verify.md`)

- A Magic Formula 5.2 / 6.1 / 6.2 tyre evaluator whose numbers equal MFeval's on eight tyres, and a per-coefficient sweep that exercises all 228 coefficients (`docs/mf62.md`).
- A tyre fitter (command line, and a browser page at `/lab/` that needs no install) and a car generator with a sanity checker (`docs/getting_started.md`).
- A conformance suite that any simulation, in any language, can run: tyres against MFeval, vehicles against the physics their own numbers imply (`conformance/`).
- An engine-independent C++20 core with a browser (WebAssembly) host and an Unreal Engine 5.8 plugin.

## What the maintainer is open to talking about

1. **Conformance.** Running your simulation through the suite and, if it passes, the "OpenGrid Conformant" mark (`TRADEMARKS.md`).
2. **Tyre work.** Fitting a tyre file to your measurements, or reviewing your own Magic Formula implementation against MFeval.
3. **Integration.** Using the core in your engine, or joint work on hosts and plugins.
4. **Data.** Tyre or vehicle measurements you are free to share, added as public references with your credit and your licence terms. This is the biggest gap: there is no measured tyre data in the repository.
5. **Research and teaching** that builds on the suite or the fitter.

## What is not on offer (yet)

No existing partners or customers to cite, no support contract, no service levels and no prices. Replies come from one person. Anything beyond the free licences is agreed case by case and in writing.

## How to start

Open an issue in the repository titled **"Partnership: <your name or company>"** (or "Conformance mark request"), say who you are, which simulation or data you have and what you would like to do. If it should not be public, say so in a short issue and the
maintainer will reply with a private route, or use the GitHub profile above. Please look at `docs/verify.md` first: if you find a claim that does not hold, an issue about that is the most useful kind.

## Credit

If you build on Open Grid, credit it as `CITATION.cff` and `NOTICE` ask. If you would like to be listed as a partner in the README, say so; nothing is listed without the partner's agreement.
