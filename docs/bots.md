# Bots: write a driver for Open Grid's physics

Open Grid's physics core ships with a bot API: a driver is a plain JS object with a `drive(observation)` function
that returns steering and pedals. Bots race headless (no browser, no GPU) on the same physics the game uses, at
240 Hz, about 100 times faster than real time.

Everything lives in [packages/vehicle-physics](../packages/vehicle-physics/):

- the API and the full observation: [harness.d.ts](../packages/vehicle-physics/harness.d.ts) (`BotObservation`)
- a working bot to start from: [bots/example_bot.js](../packages/vehicle-physics/bots/example_bot.js) (1:04.158 per
  lap in the example coupe; CC0, copy it)
- run one: `node examples/bot-race.mjs path/to/my-bot.js 3`
- the leaderboard: `npm run leaderboard` races every bot in `bots/`

## Rules (for the leaderboard)

- Car `cars/example_coupe.json`, track `routes/example_circuit.json`, 3 laps from a standing start, default assists
  (ABS and TC on, automatic gearbox, stability control off).
- Score = race time + 2 s for every second more than 1 m past the road edge. Not finishing within 2 minutes per
  lap is a DNF.
- The bot only reads the observation it is given. No reading the physics state, no changing the car.
- Deterministic: the same bot gives the same time on any machine running the same build.

## Submit a bot

Open a pull request adding one file, `packages/vehicle-physics/bots/<your-name>.js`, with a default export that
returns the bot. Say in the PR what your bot does differently and paste the output of `npm run leaderboard`. Bots in
`bots/` are CC0 so others can learn from them; say so in the file's first line.

## Ideas, if you want somewhere to start

- A racing line instead of the centreline: use the road width (`widthLeft`, `widthRight`) to cut corners.
- Trail braking: brake into the corner instead of finishing braking before it.
- Use the tyre slip (`wheels[i].slipRatio`, `slipAngle`) to drive at the limit instead of a fixed 0.8 g.
- Learn it: the harness is fast enough for reinforcement learning or evolutionary tuning on a laptop.
