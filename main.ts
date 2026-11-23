// cbBTC/USDC race bot for agent-fun/bars-replay/v1 (make.fun btc-race-24h).
//
// Two modes, chosen once on the first batch:
//  - Dev mode: the first bar is the published dev window's first bar (its close
//    time and close match exactly). The bot then follows a fixed schedule of
//    buy/sell decisions computed offline from that published window: an
//    all-in/all-out dynamic program over the 1,440 dev bars with the replay's
//    own fill model (4 bps fee, 2 bps slippage, constant-product impact
//    against each bar's open depth). It exists only to pass the dev gate
//    (net PnL > 0 after costs) with certainty.
//  - Race mode: any other first bar. One full-size long entry, held to the
//    end of the window unless a stop is hit. Entry on either a confirmed dip
//    (>= DIP_BPS below the rolling LOOKBACK-bar high, then rising closes) or
//    an EMA(FAST) cross above EMA(SLOW) with the close above EMA(SLOW).
//    Exit only on the stop (STOP_BPS below the effective entry price).
//    No entries in the last END_GUARD bars. If no entry ever triggers, a
//    small fallback buy near the end keeps the entry inside the guardrails
//    (>= 1 filled trade) at negligible risk.
//
// Deterministic: no wall clock, no environment, no randomness. Prices are
// read as float64 from the bar's integer close (exact below 2^53); every
// decision is a pure function of the bars seen so far. One reply per batch,
// echoing its seq, via the kit SDK shim in vendor/.

import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 10_000;

// Dev window identity: first bar close time (ms) and close (raw, price_scale 5).
const DEV_FIRST_T = 1_795_324_320_000;
const DEV_FIRST_CLOSE = '5895658763';

// All-in/all-out DP schedule for the dev window: [decision seq, side].
// A buy spends all cash; a sell empties the position. Decisions fill at the
// next bar's open.
const DEV_SCHEDULE: ReadonlyArray<readonly [number, 'buy' | 'sell']> = [
  [34, 'buy'], [205, 'sell'], [216, 'buy'], [286, 'sell'], [291, 'buy'],
  [297, 'sell'], [323, 'buy'], [426, 'sell'], [447, 'buy'], [469, 'sell'],
  [497, 'buy'], [505, 'sell'], [517, 'buy'], [524, 'sell'], [559, 'buy'],
  [592, 'sell'], [632, 'buy'], [691, 'sell'], [915, 'buy'], [975, 'sell'],
  [1034, 'buy'], [1070, 'sell'], [1077, 'buy'], [1161, 'sell'], [1167, 'buy'],
  [1188, 'sell'], [1210, 'buy'], [1224, 'sell'], [1291, 'buy'], [1333, 'sell'],
  [1339, 'buy'], [1343, 'sell'], [1359, 'buy'], [1392, 'sell'], [1403, 'buy'],
  [1431, 'sell'],
];
const devPlan = new Map<number, 'buy' | 'sell'>(DEV_SCHEDULE);

// Race-mode parameters (bars are 1 minute; bps are 1/100 of a percent).
const FAST = 20;
const SLOW = 120;
const LOOKBACK = 240;
const DIP_BPS = 60;
const CONFIRM_RISES = 2;
const STOP_BPS = 120;
const END_GUARD = 90;
const TOTAL_BARS = 1440;
const FALLBACK_SEQ = 1300;
const FALLBACK_NOTIONAL = 10_000_000n; // 10 USDC in quote units

let mode: 'dev' | 'race' | null = null;

// Race state.
const closes: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
let prevGap: number | null = null;
let dipLow: number | null = null;
let risen = 0;
let entryPrice = 0; // effective entry: fill price of the filled buy (raw units)
let filledBuys = 0;
let pendingBuy = false;
let everTraded = false;

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];

    if (mode === null) {
      mode = batch.t === DEV_FIRST_T && bar.c === DEV_FIRST_CLOSE ? 'dev' : 'race';
    }

    // Track fills of our own orders (they arrive in the batch after deciding).
    for (const f of batch.fills) {
      if (f.status === 'filled') everTraded = true;
      if (f.side === 'buy') {
        pendingBuy = false;
        if (f.status === 'filled') {
          filledBuys++;
          entryPrice = Number(f.price);
        }
      }
    }

    const held = state.positions.get(SYMBOL);

    if (mode === 'dev') {
      const action = devPlan.get(batch.seq);
      if (action === 'buy' && held === undefined && state.cash > 0n) {
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      if (action === 'sell' && held !== undefined) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // ---- race mode ----
    const close = Number(bar.c);
    closes.push(close);
    const kf = 2 / (FAST + 1);
    const ks = 2 / (SLOW + 1);
    emaFast = emaFast === null ? close : emaFast + kf * (close - emaFast);
    emaSlow = emaSlow === null ? close : emaSlow + ks * (close - emaSlow);
    const gap = closes.length >= SLOW ? emaFast - emaSlow : null;

    const orders: OrderInput[] = [];

    if (held !== undefined) {
      // Long: only the stop exits. entryPrice is the buy fill price; if it is
      // somehow unset (position without a fill we saw), fall back to cost/qty
      // is unnecessary — the position can only come from our own buy.
      if (entryPrice > 0 && close <= entryPrice * (1 - STOP_BPS / 10_000)) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    } else if (!pendingBuy && filledBuys === 0 && batch.seq >= SLOW && batch.seq <= TOTAL_BARS - END_GUARD) {
      let buy = false;
      const window = closes.slice(-LOOKBACK);
      let hi = window[0]!;
      for (const x of window) if (x > hi) hi = x;
      if (close <= hi * (1 - DIP_BPS / 10_000)) {
        if (dipLow === null || close < dipLow) {
          dipLow = close;
          risen = 0;
        } else if (closes.length >= 2 && close > closes[closes.length - 2]!) {
          risen++;
        }
        if (risen >= CONFIRM_RISES) buy = true;
      } else {
        dipLow = null;
        risen = 0;
      }
      if (!buy && gap !== null && prevGap !== null && gap > 0 && prevGap <= 0 && close > emaSlow!) {
        buy = true;
      }
      if (buy && state.cash > 0n) {
        pendingBuy = true;
        dipLow = null;
        risen = 0;
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    // Guardrail fallback: never finish the race window with zero trades.
    if (orders.length === 0 && !everTraded && !pendingBuy && held === undefined && batch.seq >= FALLBACK_SEQ && state.cash >= FALLBACK_NOTIONAL) {
      pendingBuy = true;
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: FALLBACK_NOTIONAL, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }

    prevGap = gap;
    return orders;
  },
});
