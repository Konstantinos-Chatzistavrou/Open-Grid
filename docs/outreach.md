# Talking about Open Grid in public

The aim: when a new racing game appears, say something true and useful that makes its developers curious. This page is the rules, why the first draft of the pitch had to change, and messages you can adapt.

## Why not "use my engine, it has everything you need to build a successful and realistic racing game"

- **"Everything" is not true.** No art, tracks, interface design, netcode beyond the demo, or a proven Unreal workflow (`docs/whats_in_the_box.md`). One developer who tries it and hits a gap turns the sentence into your reputation.
- **"Successful" is not yours to promise.** Nobody can promise it, and developers know it.
- **"Realistic" needs a reference.** What you can say truthfully is *verifiable*: the tyre model is checked against MFeval, in public CI, with commands to reproduce it. That is rarer and harder to dismiss.
- **"Engine" over-promises.** People expect rendering and an editor. It is a physics core and tools.

## What to say instead (the claims that hold)

| Say | Don't say |
|---|---|
| "an open-source vehicle-physics core" | "an engine that has everything" |
| "the tyre model is checked against MFeval, here is how to reproduce it" | "the most realistic physics" |
| "you bring your own art, cars and tracks for commercial use" | "free to use for anything" (the art and the shipped car files are non-commercial) |
| "tools to fit your own tyres and check your own cars" | "validated against real cars" (it is not) |
| "pre-1.0, one maintainer, the Unreal plugin is experimental" | anything that hides that |

## Rules for public comments

1. **Disclose.** You are the author. Say so in the first line.
2. **Only where it is relevant.** A thread about their physics, tyres, handling, a tool they need. Not every racing game's announcement.
3. **Give before you ask.** Answer their question, then mention the project. Never a link and nothing else.
4. **Read the place's rules.** Many forums, subreddits and Discords ban self-promotion; some allow it in a set thread or day. Ask a moderator when unsure.
5. **Accept a no.** One reply, one follow-up if they respond, then leave it.
6. **Keep a short log** (who, where, what you offered, what they said). It tells you what works, and it is traction you can show a partner.
7. **Never disparage their physics or another project.** Say what yours does.

## Messages to adapt

**A. One reply under a post** (only when relevant):
> Disclosure: I'm the author of Open Grid, an open-source (Apache-2.0) vehicle-physics core. If tyre or handling physics is on your list: the tyre model is checked against MFeval in public CI, and there are tools to fit your own tyre data (a browser one: open-grid.racing/lab/). You'd bring your own art, cars and tracks for commercial use. Pre-1.0, one maintainer. How to check the claims: github.com/Konstantinos-Chatzistavrou/Open-Grid/blob/main/docs/verify.md

**B. When someone asks how to model tyres / why their car feels wrong:**
> Short answer: [answer their actual question first]. If it helps, I wrote a small open-source tool that fits Magic Formula coefficients to measured tyre curves and runs in the browser (open-grid.racing/lab/); the solver behind it is checked against MFeval. Disclosure: it's mine.

**C. A post for a game-developer or sim-racing community:**
> **Open Grid: an open vehicle-physics core you can check.** Apache-2.0 C++20 core (tyres, suspension, drivetrain, aero, damage, AI, race rules, replays), a tyre fitter, a car generator and checker, and a conformance suite any simulation can run. The Magic Formula evaluator matches MFeval on 8 tyres and 582 single-coefficient variants; every claim has a command: `docs/verify.md`. What it isn't: no art or tracks to ship (ours are non-commercial; bring your own), Unreal plugin experimental, never run on a real wheel, one maintainer. Looking for: a first outside user, tyre measurements to share, partners. Repo: github.com/Konstantinos-Chatzistavrou/Open-Grid

**D. A direct message to a Formula Student team, lab or sim project:**
> Hi, I maintain Open Grid, an open-source vehicle-physics core, and I'm looking for people with real tyre data or a simulation they'd like checked. Two things you could use: a browser tool that fits a Magic Formula tyre file to your measurements (open-grid.racing/lab/) and a conformance suite that checks a tyre model against MFeval. Nothing is uploaded and nothing to sign. If you try either I'd like to hear what breaks. [name]

Adapt the wording; keep the disclosure, the limits and the link to `docs/verify.md`.
