// cbBTC/USDC race bot for agent-fun/bars-replay/v1 (make.fun btc-race-24h).
//
// One strategy for every window, long only, at most one position:
//
//  - Entry #1 (full size, all cash): the first of
//      a) a confirmed dip: close at least DIP_BPS below the rolling
//         LOOKBACK-bar high of closes, then CONFIRM_RISES rising closes
//         (a new low resets the count), or
//      b) a trend cross: EMA(FAST) crosses above EMA(SLOW) with the close
//         above EMA(SLOW), or
//      c) a late state fallback: from bar LATE_STATE_SEQ on, EMA(FAST) is
//         above EMA(SLOW) with the close above EMA(SLOW) — this catches a
//         straight-up day where the cross happened before EMA(SLOW) was
//         ready and no dip ever formed.
//    No entry before bar SLOW (indicators not ready) or in the last
//    END_GUARD bars.
//  - Exit: only a stop, STOP_BPS below the position's effective entry cost
//    (cost / qty, fees included), read on closes and filled at the next
//    open. Otherwise the position is held to the end of the window, where
//    the replay flattens it at the last close.
//  - Entry #2 (only after a stop exit): a fresh trend cross (b) after a
//    COOLDOWN-bar pause, no later than TOTAL_BARS - ENTRY2_GUARD. No dip
//    entries after the first: a second dip-buy in a downtrend is how one
//    stopped trade becomes two.
//  - Guardrail fallback: if no order has ever filled by bar FALLBACK_SEQ,
//    buy FALLBACK_NOTIONAL so the window never ends with zero trades;
//    retried on later bars while it keeps being refused.
//
// Round-trip costs here are roughly 35-45 bps at full size (4 bps fee,
// 2 bps slippage, plus constant-product impact against ~$0.6-1.1M of pool
// depth), which is why the bot trades once or twice and holds: frequent
// 1-minute signals pay that toll on every round trip.
//
// Deterministic: no wall clock, no environment, no randomness. Prices are
// read as float64 from the bar's integer close (exact below 2^53); every
// decision is a pure function of the bars seen so far. One reply per batch,
// echoing its seq, via the kit SDK shim in vendor/.

import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 10_000;

// Strategy parameters (bars are 1 minute; bps are 1/100 of a percent).
const FAST = 20;
const SLOW = 120;
const LOOKBACK = 240;
const DIP_BPS = 60;
const CONFIRM_RISES = 2;
const STOP_BPS = 120;
const COOLDOWN = 60;
const END_GUARD = 90;
const ENTRY2_GUARD = 180;
const LATE_STATE_SEQ = 720;
const TOTAL_BARS = 1440;
const FALLBACK_SEQ = 1380;
const FALLBACK_NOTIONAL = 5_000_000n; // 5 USDC in quote units

const closes: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
let prevGap: number | null = null;
let dipLow: number | null = null;
let risen = 0;
let filledBuys = 0;
let pendingBuy = false;
let everTraded = false;
let coolUntil = -1;

await runBars({
  onBatch(state, batch) {
    // Fills of orders decided on the previous batch arrive here. Process
    // them even when this batch carries no CBBTC bar (a minute the
    // recorder missed): dropping a fill report would leave pendingBuy
    // stuck and block every later entry, the fallback included.
    for (const f of batch.fills) {
      if (f.status === 'filled') everTraded = true;
      if (f.side === 'buy') {
        pendingBuy = false;
        if (f.status === 'filled') filledBuys++;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];

    const close = Number(bar.c);
    closes.push(close);
    const kf = 2 / (FAST + 1);
    const ks = 2 / (SLOW + 1);
    emaFast = emaFast === null ? close : emaFast + kf * (close - emaFast);
    emaSlow = emaSlow === null ? close : emaSlow + ks * (close - emaSlow);
    const gap = closes.length >= SLOW ? emaFast - emaSlow : null;

    const held = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];

    if (held !== undefined) {
      // Effective entry price (raw units): cost / qty at the symbol's scales.
      const sym = state.symbols.get(SYMBOL)!;
      const scale = 10 ** (sym.qty_scale + sym.price_scale - state.hello.capital.quote_scale);
      const avgEntry = (Number(held.cost) * scale) / Number(held.qty);
      if (close <= avgEntry * (1 - STOP_BPS / 10_000)) {
        coolUntil = batch.seq + COOLDOWN;
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    } else if (!pendingBuy && filledBuys < 2 && batch.seq >= SLOW && batch.seq >= coolUntil) {
      const cutoff = filledBuys === 0 ? TOTAL_BARS - END_GUARD : TOTAL_BARS - ENTRY2_GUARD;
      if (batch.seq <= cutoff) {
        let buy = false;
        if (filledBuys === 0) {
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
        }
        if (!buy && gap !== null && prevGap !== null && gap > 0 && prevGap <= 0 && close > emaSlow!) {
          buy = true;
        }
        if (!buy && filledBuys === 0 && batch.seq >= LATE_STATE_SEQ && gap !== null && gap > 0 && close > emaSlow!) {
          buy = true;
        }
        if (buy && state.cash > 0n) {
          pendingBuy = true;
          dipLow = null;
          risen = 0;
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }

    // Guardrail fallback: never finish the window with zero trades.
    if (orders.length === 0 && !everTraded && !pendingBuy && held === undefined && batch.seq >= FALLBACK_SEQ && state.cash >= FALLBACK_NOTIONAL) {
      pendingBuy = true;
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: FALLBACK_NOTIONAL, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }

    prevGap = gap;
    return orders;
  },
});
