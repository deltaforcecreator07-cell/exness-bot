'use strict';

/**
 * Pip math helpers.
 *
 * "Pips" mean different things per symbol. The Sharks trader reports gold
 * moves like "+430 PIPS" for a ~43.0 price move — i.e. on XAUUSD 1 pip = 0.1.
 * Defaults follow common MT conventions; override per symbol with the
 * SYMBOL_PIPS env (JSON) if your account quotes differently.
 */
const DEFAULT_PIPS = {
  XAUUSD: 0.1, GOLD: 0.1,
  XAGUSD: 0.01, SILVER: 0.01,
  USOIL: 0.01, WTI: 0.01,
  NATGAS: 0.001,
  BTCUSD: 1, ETHUSD: 1,
  US30: 1, NAS100: 1, SPX500: 1, GER40: 1,
  default: 0.0001, // forex-like
};

function pipMap() {
  try {
    return { ...DEFAULT_PIPS, ...JSON.parse(process.env.SYMBOL_PIPS || '{}') };
  } catch { return DEFAULT_PIPS; }
}

/** Price units per 1 pip for a pair. */
function pipSize(pair) {
  const m = pipMap();
  return m[pair] ?? m[pair?.replace(/\d+$/, '')] ?? m.default;
}

/** Number of pips between two prices (positive, rounded to avoid float noise). */
function pipsBetween(priceA, priceB, pair) {
  const d = Math.abs(Number(priceA) - Number(priceB));
  return Math.round((d / pipSize(pair)) * 1000) / 1000;
}

/** Price distance equivalent to `n` pips. */
function priceFromPips(n, pair) {
  return Number(n) * pipSize(pair);
}

module.exports = { pipSize, pipsBetween, priceFromPips };
