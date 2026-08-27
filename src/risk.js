'use strict';

/**
 * Risk + guard rails.
 *
 * v0.2 changes:
 *  - lot size is COMPUTED from account capital and risk %:
 *      riskAmount  = CAPITAL * RISK_PERCENT / 100
 *      lot         = riskAmount / ( |entry - SL| * contractSize(pair) )
 *      clamp(lot, 0.01, MAX_LOT_PER_TRADE), rounded to 0.01
 *    An explicit lot in the signal is respected but still clamped to caps.
 *  - contract sizes are per-symbol ("$ per 1.0 lot per $1 of price move"):
 *      XAUUSD 100 (100 oz), XAGUSD 5000, USOIL 1000, BTCUSD 1, indices ~5-10,
 *      forex pairs 100000. Override any with SYMBOL_CONTRACTS JSON env.
 *  - plus: allowed senders, daily trade/lot caps, duplicate protection.
 *
 * State lives in .runtime/state/ (ephemeral on Render — fine for testing).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_DIR = path.join(__dirname, '..', '.runtime', 'state');
const inFlight = new Map(); // hash -> timestamp

const DEFAULT_CONTRACTS = {
  XAUUSD: 100, GOLD: 100,
  XAGUSD: 5000, SILVER: 5000,
  USOIL: 1000, WTI: 1000, BRENT: 1000,
  NATGAS: 10000,
  BTCUSD: 1, ETHUSD: 1,
  US30: 5, DOW: 5, NAS100: 5, SPX500: 10, GER40: 5,
  default: 100000, // forex-like
};

function contracts() {
  try {
    return { ...DEFAULT_CONTRACTS, ...JSON.parse(process.env.SYMBOL_CONTRACTS || '{}') };
  } catch { return DEFAULT_CONTRACTS; }
}

function contractFor(pair) {
  const c = contracts();
  return c[pair] ?? c[pair?.replace(/\d+$/, '')] ?? c.default;
}

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), 'utf8')); } catch { return {}; }
}
function saveState(file, obj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, file), JSON.stringify(obj));
}

function senderAllowed(jid) {
  if (!jid) return false;
  const allowed = (process.env.ALLOWED_SENDERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  const bare = jid.split(':')[0].split('@')[0];
  return allowed.some(a => bare === a.split('@')[0] || jid === a);
}

/** Is this sender the signal provider (the trader)? */
function isProvider(jid) {
  const p = (process.env.SIGNAL_PROVIDER || '').split('@')[0].split(':')[0];
  if (!p) return true; // not configured -> allow any sender that passes other checks
  const bare = String(jid).split(':')[0].split('@')[0];
  return bare === p;
}

function hash(sig) {
  return crypto.createHash('sha1')
    .update([sig.action, sig.pair, sig.entryLow, sig.entryHigh, sig.sl, sig.tp, sig.lot].join('|'))
    .digest('hex').slice(0, 16);
}

function dayKey() { return new Date().toISOString().slice(0, 10); }

/** Compute lot from capital/risk; mutates sig.lot. Returns problems[] (empty = ok). */
function sizeLot(sig) {
  const capital = Number(process.env.CAPITAL || 3000);
  const riskPct = Number(process.env.RISK_PERCENT || 5);
  const riskAmount = capital * (riskPct / 100);
  const maxLot = Number(process.env.MAX_LOT_PER_TRADE || 0.5);

  if (sig.lot != null && sig.lot > 0) {
    // explicit lot from the signal — respect it (still clamped)
    sig.lot = Math.max(0.01, Math.min(Number(sig.lot), maxLot));
    return [];
  }

  const entryRef = sig.action === 'BUY'
    ? (sig.entryLow ?? sig.entry)
    : (sig.entryHigh ?? sig.entry);
  if (entryRef == null || sig.sl == null) {
    return ['cannot size lot: no entry/SL distance (signal must include entry or lot)'];
  }
  const dist = Math.abs(Number(sig.sl) - Number(entryRef));
  if (!(dist > 0)) return ['cannot size lot: SL equals entry'];
  if (dist > 0.5 * Number(entryRef)) {
    // distance is >50% of the price — smells like a bad/misparsed SL
    return [`SL distance ${dist} looks invalid for ${sig.pair}`];
  }
  const contract = contractFor(sig.pair);
  const raw = riskAmount / (dist * contract);
  const lot = Math.round((Math.min(raw, maxLot)) / 0.01) * 0.01;
  sig.lot = Math.max(0.01, lot);
  return [];
}

/**
 * Validate + enrich a parsed signal.
 * Returns { ok:true, hash, problems:[] } or { ok:false, hash, problems:[...] }.
 * On ok, sig.lot is set (computed from capital/risk or clamped explicit lot).
 */
function validateSignal(sig) {
  const problems = [];
  const maxPerDay = Number(process.env.MAX_TRADES_PER_DAY || 10);
  const maxLotDay = Number(process.env.MAX_LOT_PER_DAY || 2);

  if (!sig || !sig.pair) problems.push('no pair parsed');
  if (!/^(BUY|SELL)$/.test(sig.action)) problems.push('action must be BUY/SELL');
  if (sig.sl == null) problems.push('no SL — cannot risk-size a trade');

  // side sanity checks (only when an entry reference exists)
  const entryRef = sig.action === 'BUY' ? (sig.entryLow ?? sig.entry) : (sig.entryHigh ?? sig.entry);
  if (entryRef != null && sig.sl != null) {
    if (sig.action === 'BUY' && Number(sig.sl) >= Number(entryRef)) problems.push(`BUY SL ${sig.sl} is not below entry ${entryRef}`);
    if (sig.action === 'SELL' && Number(sig.sl) <= Number(entryRef)) problems.push(`SELL SL ${sig.sl} is not above entry ${entryRef}`);
  }
  if (sig.tp != null && entryRef != null) {
    if (sig.action === 'BUY' && Number(sig.tp) <= Number(entryRef)) problems.push(`BUY TP ${sig.tp} is not above entry ${entryRef}`);
    if (sig.action === 'SELL' && Number(sig.tp) >= Number(entryRef)) problems.push(`SELL TP ${sig.tp} is not below entry ${entryRef}`);
  }

  const h = hash(sig);
  const now = Date.now();
  if (inFlight.has(h) && now - inFlight.get(h) < 90_000) problems.push('duplicate (already executing)');

  const state = loadState('trades.json');
  const today = state[dayKey()] || { count: 0, lot: 0, seen: {} };
  if (today.seen[h]) problems.push('duplicate (already traded today)');
  if (today.count + 1 > maxPerDay) problems.push(`daily trade cap ${maxPerDay} reached`);

  if (problems.length) return { ok: false, problems, hash: h };

  const lotProblems = sizeLot(sig);
  if (lotProblems.length) return { ok: false, problems: lotProblems, hash: h };
  if (today.lot + Number(sig.lot || 0) > maxLotDay) problems.push(`daily lot cap ${maxLotDay} reached`);

  if (problems.length) return { ok: false, problems, hash: h };
  inFlight.set(h, now);
  return { ok: true, hash: h };
}

/** Call AFTER a successful execution so daily counters increment. */
function markExecuted(sig) {
  const h = hash(sig);
  const state = loadState('trades.json');
  const d = dayKey();
  const today = state[d] || { count: 0, lot: 0, seen: {} };
  today.count += 1;
  today.lot = Number((today.lot + Number(sig.lot || 0)).toFixed(2));
  today.seen[h] = new Date().toISOString();
  state[d] = today;
  saveState('trades.json', state);
  inFlight.delete(h);
}

function todayStats() {
  const state = loadState('trades.json');
  return state[dayKey()] || { count: 0, lot: 0, seen: {} };
}

/**
 * Entry-price tolerance in absolute price units ($ on gold).
 * The live market drifts between the moment a signal is posted and the moment
 * the headless browser executes it. Within this band the bot still executes at
 * market (no trade missed); beyond it, it places a pending order at the zone
 * edge instead of rejecting. Per-symbol override: ENTRY_TOLERANCE_JSON={"EURUSD":0.003}.
 */
function entryTolerance(pair) {
  let map = {};
  try { map = JSON.parse(process.env.ENTRY_TOLERANCE_JSON || '{}'); } catch { map = {}; }
  if (pair) {
    const p = String(pair).toUpperCase();
    const base = p.replace(/\d+$/, '');
    if (map[p] != null) return Math.max(0, Number(map[p]) || 0);
    if (map[base] != null) return Math.max(0, Number(map[base]) || 0);
  }
  // '' / invalid -> default 3 (Number('') is 0, so guard explicitly)
  const raw = process.env.ENTRY_TOLERANCE_USD;
  const def = raw != null && String(raw).trim() !== '' ? Number(raw) : 3;
  return Number.isFinite(def) && def >= 0 ? def : 3;
}

/** Snapshot of the risk configuration (for the /risk owner command). */
function riskConfig() {
  return {
    capital: Number(process.env.CAPITAL || 3000),
    riskPercent: Number(process.env.RISK_PERCENT || 5),
    maxLotPerTrade: Number(process.env.MAX_LOT_PER_TRADE || 0.5),
    maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY || 10),
    maxLotPerDay: Number(process.env.MAX_LOT_PER_DAY || 2),
    entryToleranceUsd: entryTolerance(null),
  };
}

module.exports = { senderAllowed, isProvider, validateSignal, markExecuted, todayStats, contractFor, entryTolerance, riskConfig };
