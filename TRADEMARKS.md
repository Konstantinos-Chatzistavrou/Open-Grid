# Names, logo and the "OpenGrid Conformant" mark

**Status.** This is how the maintainer intends the names below to be used. On 2026-11-27 no trademark is registered; where trademark rights exist (in many places they arise from use) this is how they will be applied. It is not legal advice:
ask a lawyer before you rely on it, and expect it to be revised.

**Covered:** the names "Open Grid" and "OpenGrid", the logo and wordmark (`docs/BRAND_IDENTITY.md`), and the mark "OpenGrid Conformant". The Apache License 2.0 (section 6) and the CC licences used here do **not** grant any right to these names;
the code, data and documents are free to use under their licences, the names are not part of that grant.

## Without asking

- Say truthfully that your software uses, is based on, or is compatible with Open Grid or its physics core ("built on Open Grid", "uses the OpenGrid tyre fitter"), as long as it does not suggest that Open Grid endorses or is involved in your product.
- Keep the project's name and credits where a licence asks for them (`NOTICE`, `CREDITS.md`, the credit line of the conformance suite).
- Run the conformance suite on your simulation and publish the result with its credit line and the `--json` file (`conformance/README.md`). You may say "passes the OpenGrid conformance suite, version 0.1, result: <link>". That is a factual statement, not the mark.
- Fork and modify the code. A modified version should say it is modified and **should not be named "Open Grid" / "OpenGrid"**.

## With written permission

- Naming a product, company, domain, app or social account "Open Grid", "OpenGrid" or anything confusingly similar.
- Using the logo or wordmark as your branding, or in a way that suggests the project is your partner, sponsor or endorser.
- Using the mark **"OpenGrid Conformant"**, or words like "certified" or "verified by OpenGrid".

## The "OpenGrid Conformant" mark

For a named simulation and a named build, the maintainer may allow the mark when all of this holds:

1. **It passes.** The tyre suite passes on all eight tyres (a subset of output columns only if the claim names those columns), and the vehicle suite reports 0 FAIL, for the suite version named.
2. **The result is public.** The `--json` result files for that exact build are published, with how to reproduce the run.
3. **It says what a pass means.** The tyre suite shows the model equals MFeval's numbers; the vehicle suite is a self-consistency check. The claim must not say or imply "certified accurate", "validated against real cars" or similar.
4. **Credit is shown** where the mark is: "Conformance suite by Konstantinos Chatzistavrou, Open Grid, CC BY 4.0" with a link to the repository.
5. **It is asked for in writing** (an issue titled "Conformance mark request", see `PARTNERS.md`). Permission is for the tested build; a new build needs a new result. It can be withdrawn if the result is misrepresented.

No fee is charged at the time of writing. If that ever changes it will be stated here first.
