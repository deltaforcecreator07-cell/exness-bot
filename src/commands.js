'use strict';

/**
 * Owner WhatsApp command parser + selector resolution.
 *
 * Supports (see /help in whatsapp.js):
 *   /close                      close the most recent tracked position
 *   /close 2                    close position #2 from /positions
 *   /close #120548117           close by ticket id
 *   /close xauusd | /close gold close by symbol
 *   /close all  (/flatten /closeall)  close everything
 *   /close 50% | half | 50      partial close (50% of the volume)
 *   /close 2 50%                partial close of position #2
 *   /partial [args]             alias of /close with 50% default
 *   /cancel                     alias of /close
 *   /be [sel] [+pips|-pips]     move SL to breakeven (+50 = entry+50 pips)
 *   /sl <price> [sel]           set stop loss
 *   /tp <price> [sel]           set take profit
 *   /positions /pos /orders     list tracked positions
 *   /verify /account /risk /status /ping /pause /resume /mode /shot /retake /trade /help
 *
 * Pure — no browser, no IO — so it can be unit-tested.
 */

const PAIR_ALIASES = {
  GOLD: 'XAUUSD', XAU: 'XAUUSD',
  SILVER: 'XAGUSD', XAG: 'XAGUSD',
  OIL: 'USOIL', WTI: 'USOIL', USOIL: 'USOIL', BRENT: 'BRENT',
  NAS100: 'NAS100', US100: 'NAS100', NASDAQ: 'NAS100',
  SPX500: 'SPX500', US500: 'SPX500', SP500: 'SPX500',
  US30: 'US30', DOW: 'US30', DOWJONES: 'US30',
  GER40: 'GER40', DAX: 'GER40',
  BTCUSD: 'BTCUSD', BTC: 'BTCUSD', BITCOIN: 'BTCUSD',
  ETHUSD: 'ETHUSD', ETH: 'ETHUSD', ETHEREUM: 'ETHUSD',
};

const RESERVED = new Set([
  'ALL', 'HALF', 'PARTIAL', 'AT', 'TO', 'ON', 'AND', 'THE', 'MY', 'ME',
  'POSITION', 'POSITIONS', 'TRADE', 'ORDER', 'ORDERS', 'PERCENT',
]);

function tokenize(arg) {
  return String(arg || '').trim().split(/[\s,]+/).filter(Boolean);
}

/** "gold" | "XAUUSD247" | "xauusdm" -> canonical pair symbol (null if not pair-like). */
function parsePairToken(tok) {
  const t = String(tok || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!t || RESERVED.has(t)) return null;
  if (PAIR_ALIASES[t]) return PAIR_ALIASES[t];
  if (/^[A-Z]{2,6}\d{0,3}$/.test(t)) return t;
  return null;
}

/**
 * Parse selector tokens (index / ticket / pair) out of an arg string.
 *   "#120548117" or a bare 8+ digit number -> ticketId
 *   "xauusd" / "gold"                      -> pair
 *   a single digit 1-9                     -> index (list position from /positions)
 */
function parseSelector(arg) {
  const out = { index: null, ticketId: null, pair: null };
  for (const tok of tokenize(arg)) {
    let m = tok.match(/^#(\d{4,})$/);
    if (m) { out.ticketId = m[1]; continue; }
    if (/^\d{8,}$/.test(tok)) { out.ticketId = tok; continue; }
    const pair = parsePairToken(tok);
    if (pair) { out.pair = pair; continue; }
    m = tok.match(/^(\d)$/);
    if (m) { out.index = parseInt(m[1], 10); continue; }
  }
  return out;
}

/** "50%" | "50 percent" | "half" | "0.5" -> 0..1 fraction (null if none). */
function parseFractionToken(tok) {
  const t = String(tok || '').toLowerCase().trim();
  if (!t) return null;
  if (t === 'half') return 0.5;
  let m = t.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (m) { const n = parseFloat(m[1]); return (n > 0 && n <= 100) ? n / 100 : null; }
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:percent|pct)$/);
  if (m) { const n = parseFloat(m[1]); return (n > 0 && n <= 100) ? n / 100 : null; }
  m = t.match(/^(?:0?\.\d+)$/);
  if (m) { const n = parseFloat(t); return (n > 0 && n < 1) ? n : null; }
  if (/^\d{2,3}$/.test(t)) { const n = parseInt(t, 10); return (n >= 10 && n <= 100) ? n / 100 : null; }
  return null;
}

/** Parse the argument part of /close //partial //cancel. */
function parseCloseArgs(arg) {
  const out = { all: false, index: null, ticketId: null, pair: null, fraction: 1 };
  let seen = false;
  for (const tok of tokenize(arg)) {
    seen = true;
    if (/^all$/i.test(tok)) { out.all = true; continue; }
    const frac = parseFractionToken(tok);
    if (frac !== null) { out.fraction = frac; continue; }
    let m = tok.match(/^#(\d{4,})$/);
    if (m) { out.ticketId = m[1]; continue; }
    if (/^\d{8,}$/.test(tok)) { out.ticketId = tok; continue; }
    const pair = parsePairToken(tok);
    if (pair) { out.pair = pair; continue; }
    m = tok.match(/^(\d)$/);
    if (m) { out.index = parseInt(m[1], 10); continue; }
  }
  if (!seen) out.fraction = 1;
  return out;
}

/** Parse the argument part of /sl //tp: [selector] <price>. */
function parsePriceArgs(arg) {
  const out = { index: null, ticketId: null, pair: null, price: null };
  const toks = tokenize(arg);
  const nums = [];
  for (const tok of toks) {
    let m = tok.match(/^#(\d{4,})$/);
    if (m) { out.ticketId = m[1]; continue; }
    if (/^\d{8,}$/.test(tok)) { out.ticketId = tok; continue; }
    const pair = parsePairToken(tok);
    if (pair) { out.pair = pair; continue; }
    m = tok.match(/^(\d)$/);
    if (m && out.price === null && nums.length === 0 && toks.length > 1) { out.index = parseInt(m[1], 10); continue; }
    const n = parseFloat(tok.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n)) nums.push(n);
  }
  if (nums.length) out.price = nums[nums.length - 1];
  // a lone single-digit arg to /sl //tp is far more likely a price typo than an
  // index — treat "/sl 2" as price 2, not "index 2 with no price".
  if (out.price === null) out.index = null;
  return out;
}

/** Parse the argument part of /be: [selector] [+pips|-pips]. */
function parseBreakevenArgs(arg) {
  const out = { ...parseSelector(arg), pips: null };
  for (const tok of tokenize(arg)) {
    const m = tok.match(/^([+-]\d+(?:\.\d+)?)$/);
    if (m) out.pips = parseFloat(m[1]);
  }
  return out;
}

function describeSelector(sel) {
  if (!sel) return '';
  if (sel.all) return 'all positions';
  const parts = [];
  if (sel.index != null) parts.push(`#${sel.index} in /positions`);
  if (sel.ticketId) parts.push(`ticket #${sel.ticketId}`);
  if (sel.pair) parts.push(sel.pair);
  return parts.join(' ');
}

/**
 * Resolve a selector against the tracked positions (oldest -> newest order,
 * exactly the numbering shown by /positions).
 * Returns an array of positions; empty = nothing matched.
 */
function resolveTargets(positions, sel = {}) {
  const list = Array.isArray(positions) ? positions : [];
  if (!list.length) return [];
  const hasSelector = !!(sel.all || sel.ticketId != null || sel.pair != null || sel.index != null);
  if (sel.all) return list.slice();
  if (sel.ticketId) {
    const hits = list.filter((p) => String(p.ticketId || '') === String(sel.ticketId));
    if (hits.length) return hits;
  }
  if (sel.pair) {
    const gold = new Set(['XAUUSD', 'XAUUSD247', 'XAUUSDM', 'GOLD']);
    const norm = (s) => {
      const S = String(s || '').toUpperCase().trim();
      if (gold.has(S)) return 'XAUUSD';
      return S.split(',')[0].trim();
    };
    const want = norm(sel.pair);
    const hits = list.filter((p) => norm(p.pair) === want || norm(p.terminalSymbol) === want);
    if (hits.length) return hits;
    // gold family fallback (XAUUSD247 tracked vs "xauusd" requested etc.)
    const isGold = (s) => gold.has(norm(s));
    if (isGold(sel.pair)) {
      const g = list.filter((p) => isGold(p.pair) || isGold(p.terminalSymbol));
      if (g.length) return g;
    }
  }
  if (sel.index != null) {
    if (sel.index >= 1 && sel.index <= list.length) return [list[sel.index - 1]];
    return [];
  }
  // an EXPLICIT selector that matched nothing must never silently fall back to
  // the latest position — that would close the wrong trade.
  if (hasSelector) return [];
  return [list[list.length - 1]]; // no selector: most recent
}

/**
 * Compute the volume to close for a partial close.
 * Floors to the broker lot step (0.01) so we never close MORE than intended.
 * Returns { ok, full, volume, remaining, note? } or { ok:false, reason }.
 */
function closeVolumeFor(pos, fraction) {
  const lot = Number(pos && pos.lot);
  if (!(lot > 0)) return { ok: false, reason: 'position has no lot size recorded (bot restarted?) — only full close possible' };
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  if (f >= 1) return { ok: true, full: true, volume: lot, remaining: 0 };
  const step = 0.01;
  let v = Math.floor((lot * f) / step + 1e-9) * step;
  let remaining = Math.round((lot - v) * 100) / 100;
  if (v < step - 1e-9) {
    return { ok: true, full: true, volume: lot, remaining: 0, note: `${Math.round(f * 100)}% of ${lot} lot is below the 0.01 lot step — closing the FULL position instead` };
  }
  if (remaining < step - 1e-9) {
    return { ok: true, full: true, volume: lot, remaining: 0, note: `remainder would be below the 0.01 lot step — closing the FULL position instead` };
  }
  return { ok: true, full: false, volume: Math.round(v * 100) / 100, remaining };
}

/** Main entry: "/close 2 50%" -> { type:'close', index:2, fraction:0.5, ... } */
function parseOwnerCommand(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || '').trim();

  switch (cmd) {
    case 'flatten':
    case 'closeall':
      return { type: 'close', all: true, fraction: 1, index: null, ticketId: null, pair: null };
    case 'cancel':
    case 'close': {
      const p = parseCloseArgs(arg);
      return { type: 'close', ...p };
    }
    case 'partial': {
      const p = parseCloseArgs(arg);
      if (p.fraction >= 1 && !p.all) p.fraction = 0.5; // "/partial" with no % -> 50%
      return { type: 'close', ...p };
    }
    case 'be':
    case 'breakeven':
      return { type: 'breakeven', ...parseBreakevenArgs(arg) };
    case 'sl':
      return { type: 'sl', ...parsePriceArgs(arg) };
    case 'tp':
      return { type: 'tp', ...parsePriceArgs(arg) };
    case 'positions':
    case 'pos':
    case 'orders':
      return { type: 'positions' };
    case 'verify':
      return { type: 'verify' };
    case 'account':
      return { type: 'account' };
    case 'status':
      return { type: 'status' };
    case 'risk':
      return { type: 'risk' };
    case 'ping':
      return { type: 'ping' };
    case 'pause':
      return { type: 'pause' };
    case 'resume':
      return { type: 'resume' };
    case 'mode':
      return { type: 'mode', arg };
    case 'shot':
    case 'screenshot':
      return { type: 'shot' };
    case 'retake':
    case 'retry':
      return { type: 'retake' };
    case 'trade':
      return { type: 'trade', arg };
    case 'help':
      return { type: 'help' };
    default:
      return null;
  }
}

module.exports = {
  parseOwnerCommand,
  parseCloseArgs,
  parseSelector,
  parseBreakevenArgs,
  parsePriceArgs,
  parseFractionToken,
  parsePairToken,
  resolveTargets,
  closeVolumeFor,
  describeSelector,
};
