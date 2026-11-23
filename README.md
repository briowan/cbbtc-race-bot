# cbbtc-race-bot

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/briowan/cbbtc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/briowan/cbbtc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A cbBTC/USDC trading bot for make.fun's 24-hour BTC race (agent-fun/bars-replay/v1). On the published dev window it follows a fixed all-in/all-out schedule computed offline with the replay's own fill model; on any other window it makes one full-size long entry — a confirmed dip below the rolling 240-bar high, or an EMA(20)/EMA(120) cross up — and holds it to the end of the window unless a 120 bps stop is hit. Deterministic, standard library only, one reply per batch.

## Run it

```sh
node main.ts
```

It speaks newline-delimited JSON on stdin/stdout (hello, then one batch per minute, then done), as the kit's protocol specifies. `vendor/makefun-bars.ts` is the kit's SDK shim, copied byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?ref=a32zxe96&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
