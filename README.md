# polygon.market

A paper-trading system for Polymarket's daily temperature markets. It prices
outcomes, compares its prices to the book, and records what it would have done.
**It does not trade real money** — the live execution path is unimplemented and
locked behind a flag.

## What it actually is

Not a signal bot. A signal bot asks *should I buy?*; this asks *what is this
worth, what does the book charge, and is the difference bigger than my costs?*
The second question is the one that pays, and it is also the only one that can
tell you whether to rest a limit order instead of crossing the spread.

```
Gamma / CLOB  →  WeatherModel  →  EdgeEngine  →  PositionSizer  →  ExecutionEngine
   markets        distribution     net cents        ¼ Kelly          book-walked fill
                       ↓            per share                              ↓
                 forecast log  ────────────────────────────────────→  ledger + calibration
```

The forecast log is the point of the whole thing. Every probability the model
produces is recorded with the market's price at that instant, then scored when
the market settles — including the forecasts that never became trades. Scoring
only the trades would measure the entry threshold rather than the model.

## Quick start

```bash
npm install
cp .env.example .env
npm test               # unit tests
npm run reality-check  # what the market looks like right now, read-only
npm start              # run the bot (paper mode)
```

## The commands that matter

| Command | What it tells you |
|---|---|
| `npm run calibration` | **Does the model beat the market?** Brier score vs. the market's, reliability curve, go-live gate |
| `npm run track-record` | What execution cost: fills, fees, slippage, P&L by strategy |
| `npm run reality-check` | Live spreads, depth, and how much of the market the bot can see |
| `npm start -- --once` | One cycle, then exit (what the scheduled job runs) |

`npm run calibration` is the one to check first. P&L over a few dozen trades
cannot distinguish a real edge from a lucky streak; a proper scoring rule can,
because it uses every forecast and has the market as a free benchmark.

## How a trade is decided

1. **Discover** — paginate Gamma by 24h volume, keep temperature markets
2. **Group** — buckets sharing a city and date are one event; they resolve off
   one reading
3. **Forecast** — Open-Meteo ensemble members give a mean and a *measured*
   spread, rather than a spread assumed from lead time
4. **Distribute** — spread a normal over the buckets, renormalise to sum to 1
5. **Log** — every bucket's probability goes to the forecast table, traded or not
6. **Price** — `EdgeEngine` walks the real ask book, subtracts the real fee, and
   returns `TAKE`, `QUOTE`, or `PASS` in cents per share
7. **Size** — quarter Kelly off the live bankroll, capped per position and per
   correlation group
8. **Fill** — simulated against the book that was actually there, with fees

## Costs are modelled properly

Polymarket charges takers `shares × rate × p × (1−p)`, per category. Two things
follow that a flat percentage-of-notional model gets wrong:

- The fee peaks at 50¢ and vanishes at the extremes. A fill at 30¢ costs exactly
  what one at 70¢ costs.
- **Makers pay nothing** and earn a rebate. Any strategy that only crosses the
  spread has chosen the most expensive way to trade.

`EdgeEngine` reports both sides. Where the edge is real but thin it returns
`QUOTE` — correct, and currently unexecutable, because there is no order-posting
path yet. Those are logged rather than silently dropped.

## Risk controls

| Control | Default |
|---|---|
| Kelly fraction | ¼ |
| Max per position | 5% of bankroll |
| Max per correlation group (city + date) | 3% |
| Daily loss limit | 10% of bankroll |
| Spread ceiling | 5¢ |
| Book depth required | 5× position size |
| Live execution | **hard-blocked** |

Bankroll is read from the ledger, not a static variable, so a drawdown shrinks
every subsequent position automatically.

## Retired strategies

Four strategies were removed rather than tuned. Each failed structurally, not
numerically:

- **CorrelationArb** — inferred mutual exclusivity from shared words in titles,
  so it could hold both legs of a "hedge" and lose both. It once scored a Fed
  rate rise against a Fed rate cut as a 99.3% arbitrage. Real sum-below-1 arb
  needs the protocol's negRisk outcome sets (`NegRiskConsistencyModel`).
- **WalletMirror** — fills only after a whale's order has moved the book, buying
  the price their trade created.
- **NewsCatalyst** — polled RSS every two minutes against markets that reprice on
  the source in seconds.

Their code is in git history.

## Automation

Two GitHub Actions workflows, free tier:

- `paper-trade.yml` — one cycle hourly; ledger persists via the Actions cache
- `daily-report.yml` — a summary at 01:00 UTC as an email (Resend) and a GitHub
  issue

## Before any real money

Do not skip this. Run `npm run calibration` and require **all** of:

- 100+ resolved forecasts
- model Brier below the market's Brier over the same forecasts
- net edge after real fees above 2× transaction costs

If the model does not beat the price it trades against, no amount of position
sizing rescues it. Finding that out on paper costs nothing.

Then: check your jurisdiction, start at a fraction of the intended size, and
confirm live fills match simulated ones before scaling.

## Layout

```
src/
  core/
    calibration/   Brier scoring, reliability curves, sigma fitting
    edge/          EdgeEngine — the one place costs are compared
    pricing/       FeeModel — the real fee schedule
    risk/          RiskManager gates, PositionSizer (Kelly)
    ledger/        SQLite: markets, candidates, positions, forecasts, snapshots
    polymarket/    Gamma + CLOB client
  strategies/
    weather/       bucket parser, forecast distribution, strategy
    negrisk/       protocol-guaranteed arbitrage
  execution/       fill simulation (book-walked), live path (blocked)
  tools/           reality-check, calibration, track-record, report
```
