'use strict';

/**
 * Pure execution planning — entry tolerance ("no trade missed") + SL/TP
 * sanity against the LIVE market price.
 *
 * Problem it solves: between the moment a signal is posted and the moment the
 * headless browser hits the terminal, gold can move several dollars. Without
 * tolerance a trade would be executed blindly at a bad price or rejected by
 * the terminal ("invalid stops") when SL/TP end up on the wrong side of the
 * live price.
 *
 * Plan rules (tolerance T, default $3, env ENTRY_TOLERANCE_USD):
 *   1. No entry zone in the signal                 -> MARKET order.
 *   2. Live price inside [low - T, high + T]       -> MARKET order (drift
 *      accepted on purpose so no trade is missed).
 *   3. Live price OUTSIDE the tolerance band       -> PENDING order at the
 *      nearest zone edge (Buy Limit / Buy Stop / Sell Limit / Sell Stop), so
 *      the trade still fills when price trades back to the level instead of
 *      being rejected or chased.
 *   4. In MARKET mode, if an SL/TP would be rejected by the terminal because
 *      the live price already crossed it (violation <= T), it is nudged just
 *      beyond the live price by a small buffer (T/3) and the adjustment is
 *      reported back to the owner.
 *
 * No I/O, no puppeteer — unit-tested in tests/execution-math-test.js.
 */

/** Decide Limit vs Stop for a pending order, the standard MT5 way. */
function choosePendingType(action, entryPrice, bid, ask) {
  if (entryPrice == null) return action === 'BUY' ? 'Buy Limit' : 'Sell Limit';
  if (action === 'BUY') return entryPrice > ask ? 'Buy Stop' : 'Buy Limit';
  return entryPrice < bid ? 'Sell Stop' : 'Sell Limit';
}

function zoneOf(sig) {
  const low = sig.entryLow ?? sig.entryPrice ?? (sig.entry != null ? Number(sig.entry) : null);
  const high = sig.entryHigh ?? low;
  if (low == null || high == null) return null;
  return { low: Number(low), high: Number(high) };
}

/**
 * Nudge SL/TP so the terminal accepts a MARKET order even after drift.
 * BUY: SL must be below Bid, TP above Bid. SELL: SL above Ask, TP below Ask.
 * Only fixes violations <= tolerance (bigger ones are handled by the pending
 * branch or rejected upstream). Returns { sl, tp, adjustments[] }.
 */
function clampStopsForMarket(action, { sl, tp }, bid, ask, tolerance) {
  const adjustments = [];
  let slOut = sl != null ? Number(sl) : null;
  let tpOut = tp != null ? Number(tp) : null;
  const r2 = (v) => Math.round(v * 100) / 100;
  const buffer = Math.max(r2((Number(tolerance) || 0) / 3), 0.01);

  if (action === 'BUY') {
    const ref = bid != null ? Number(bid) : null;
    if (ref != null && slOut != null && slOut >= ref && (slOut - ref) <= tolerance) {
      adjustments.push(`SL ${slOut} was at/above live Bid ${ref} — moved to ${r2(ref - buffer)}`);
      slOut = r2(ref - buffer);
    }
    if (ref != null && tpOut != null && tpOut <= ref && (ref - tpOut) <= tolerance) {
      adjustments.push(`TP ${tpOut} was at/below live Bid ${ref} — moved to ${r2(ref + buffer)}`);
      tpOut = r2(ref + buffer);
    }
  } else {
    const ref = ask != null ? Number(ask) : null;
    if (ref != null && slOut != null && slOut <= ref && (ref - slOut) <= tolerance) {
      adjustments.push(`SL ${slOut} was at/below live Ask ${ref} — moved to ${r2(ref + buffer)}`);
      slOut = r2(ref + buffer);
    }
    if (ref != null && tpOut != null && tpOut >= ref && (tpOut - ref) <= tolerance) {
      adjustments.push(`TP ${tpOut} was at/above live Ask ${ref} — moved to ${r2(ref - buffer)}`);
      tpOut = r2(ref - buffer);
    }
  }
  return { sl: slOut, tp: tpOut, adjustments };
}

/**
 * Build the execution plan.
 * sig:      { action, entryLow, entryHigh, entry, entryPrice, sl, tp, pending, orderType }
 * prices:   { bid, ask } | null (live, read from the ticket)
 * tolerance: absolute price units (e.g. 3 => $3 on gold)
 *
 * Returns {
 *   mode: 'market' | 'pending',
 *   entryPrice,          // only for pending
 *   pendingType,         // only for pending
 *   sl, tp,              // possibly clamped
 *   drift,               // signed distance of live price beyond the zone (0 if inside)
 *   adjustments: [],     // human-readable notes for the owner
 *   reason               // short machine-ish explanation, logged
 * }
 */
function planExecution(sig, prices, tolerance) {
  const tol = Math.max(0, Number(tolerance) || 0);
  const action = sig.action === 'SELL' ? 'SELL' : 'BUY';
  const zone = zoneOf(sig);
  const bid = prices && Number.isFinite(Number(prices.bid)) ? Number(prices.bid) : null;
  const ask = prices && Number.isFinite(Number(prices.ask)) ? Number(prices.ask) : null;
  const explicitEntry = sig.entryPrice != null ? Number(sig.entryPrice) : null;
  const forcedPending = sig.pending === true || /^(pending|limit|stop)$/i.test(sig.orderType || '');

  const base = {
    mode: 'market',
    entryPrice: explicitEntry,
    pendingType: null,
    sl: sig.sl != null ? Number(sig.sl) : null,
    tp: sig.tp != null ? Number(sig.tp) : null,
    drift: 0,
    adjustments: [],
    reason: '',
  };

  // explicit pending intent from the caller — honour it untouched
  if (forcedPending || explicitEntry != null) {
    return { ...base, mode: 'pending', reason: forcedPending ? 'pending order requested by signal' : 'explicit entry price in signal' };
  }

  // no live prices -> cannot evaluate drift, execute as before (market)
  if (bid == null && ask == null) {
    return { ...base, reason: 'live bid/ask unavailable — executing at market as before' };
  }

  const market = action === 'BUY' ? (ask ?? bid) : (bid ?? ask);

  // no entry zone -> pure market signal
  if (!zone) {
    const clamped = clampStopsForMarket(action, { sl: base.sl, tp: base.tp }, bid, ask, tol);
    return {
      ...base,
      ...clamped,
      reason: 'no entry zone in signal — market execution',
    };
  }

  const inside = market >= zone.low - tol && market <= zone.high + tol;
  if (inside) {
    const clamped = clampStopsForMarket(action, { sl: base.sl, tp: base.tp }, bid, ask, tol);
    const drift = market < zone.low ? Math.round((zone.low - market) * 100) / 100
      : market > zone.high ? Math.round((market - zone.high) * 100) / 100 : 0;
    return {
      ...base,
      ...clamped,
      drift,
      reason: drift > 0
        ? `live price ${market} is ${drift} outside the zone but within the ±${tol} tolerance — executing at market`
        : `live price ${market} is inside the zone — executing at market`,
    };
  }

  // outside the tolerance band -> pending order at the nearest zone edge
  const edge = market > zone.high ? zone.high : zone.low;
  const pendingType = choosePendingType(action, edge, bid, ask);
  const drift = Math.round((market > zone.high ? market - zone.high : zone.low - market) * 100) / 100;
  return {
    ...base,
    mode: 'pending',
    entryPrice: edge,
    pendingType,
    drift,
    reason: `live price ${market} is ${drift} beyond the zone (tolerance ±${tol}) — placing ${pendingType} @ ${edge} so the trade fills at the level instead of being missed`,
  };
}

module.exports = { choosePendingType, clampStopsForMarket, planExecution, zoneOf };
