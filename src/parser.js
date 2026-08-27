'use strict';

/**
 * Parses the REAL signal format used by the "Sharks" channel (see README).
 *
 * Signals arrive as short, conversational, MULTI-MESSAGE broadcasts:
 *   msg1: "GOLD BUY 4391-93"  +  "SL 85"          <- entry zone + SL
 *   msg2: "TP 4401"  "TP 4410"                    <- targets in the NEXT message
 *   plus management noise: "TRAIL SL TO 93", "60+ PIPS RUNNING!",
 *   "BE TAPPED!", "SL HIT DONE FOR THE DAY!", daily reports, react-bait, etc.
 *
 * parseTradeMessage(text) returns ONE of:
 *   { type:'signal', action, pair, entryLow, entryHigh, entry, sl, tp:[...], lot, raw }
 *        -> a real trade instruction (entry zone + SL, possibly with TPs)
 *   { type:'tp', tps:[...], raw }
 *        -> a TP-only message (attach to the pending signal)
 *   null -> anything else (management noise, member chatter, react-bait)
 *
 * Supported quirks of this channel:
 *   - pair can come BEFORE the action: "GOLD BUY 4391-93", "GOLD SELL 4400-4402"
 *   - entry can be a RANGE: "4391-93", "4398-4400", "4382-85" (abbrev 2nd side)
 *   - SL shorthand: "SL 85" with entry ~4391 means 4385
 *   - bold markers: "GOLD BUY **4398-4400**"
 *   - multiple TPs in one message: "TP 4401 TP 4410"
 *   - "GOLD BUY NOW!" alone has no entry/SL -> not a trade yet (returns null)
 */

const PAIR_ALIASES = {
  GOLD: 'XAUUSD', XAU: 'XAUUSD',
  SILVER: 'XAGUSD', XAG: 'XAGUSD',
  OIL: 'USOIL', WTI: 'USOIL',
  US100: 'NAS100', NASDAQ: 'NAS100',
  US500: 'SPX500', SP500: 'SPX500',
  US30: 'US30', DOW: 'US30', DOWJONES: 'US30',
  DAX: 'GER40', GER40: 'GER40',
  BTC: 'BTCUSD', BITCOIN: 'BTCUSD',
  ETH: 'ETHUSD', ETHEREUM: 'ETHUSD',
};

const KEYWORDS = new Set([
  'SL', 'TP', 'LOT', 'ENTRY', 'AT', '@', 'PRICE', 'VOLUME', 'VOL', 'SIZE',
  'STOP', 'TAKE', 'LOSS', 'PROFIT', 'MARKET', 'BUY', 'SELL', 'LIMIT', 'PENDING',
  'LONG', 'SHORT', // direction aliases -> LONG = BUY, SHORT = SELL
]);

// words that look ticker-ish but are channel filler — never a pair
const NOISE = new Set([
  'NOW', 'ACTIVE', 'TRADE', 'TRADES', 'STILL', 'HOLD', 'HOLDING', 'ADD', 'LAYER',
  'LAST', 'OVERALL', 'AVERAGE', 'FROM', 'CMP', 'AND', 'NEW', 'HIGH', 'LOW',
  'REACTS', 'MSG', 'DAILY', 'REPORT', 'TOTAL', 'PIPS', 'CAPITAL', 'TARGET',
  'TIME', 'P.M', 'A.M', 'GAMBLING', 'MODE', 'TESTING', 'PATIENCE', 'JUST',
  'TODAY', 'TOMORROW', 'PROMISE', 'MAXIMUM', 'KAHAN', 'SE', 'HE', 'ENTRY',
  'THEN', 'WILL', 'CAN', 'WITH', 'DONE', 'HIT', 'TAPPED', 'RUNNING', 'VOLUME',
  'FALL', 'COMING', 'TRADE', 'SL', 'TP', 'RISK', 'REWARD', 'CLOSE', 'OPEN',
  'TERM', // "long term" / "short term" chatter — never a pair
]);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, '.'));
  return Number.isFinite(n) ? n : null;
}

function cleanText(text) {
  return String(text)
    .replace(/[*_#`~]/g, ' ')          // bold/italic markers
    .replace(/[|]/g, ' ')              // "/trade BUY XAUUSD 4605 | SL : 4600"
    .replace(/[^\x00-\x7F]/g, ' ')     // emojis / non-ascii
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** Next numeric token, skipping leftover punctuation (`SL : 4600`, `SL:4600`). */
function nextNumber(tokens, i) {
  const glued = tokens[i].replace(/[,]/g, '');
  const gluedNum = glued.match(/^(?:SL|TP|STOP|LOT|ENTRY|PRICE|AT|@)[:=]+(\d+(?:\.\d+)?)$/);
  if (gluedNum) return { value: num(gluedNum[1]), index: i };
  for (let j = i + 1; j < tokens.length; j++) {
    const raw = tokens[j];
    if (/^[,:;=]+$/.test(raw)) continue;
    const v = num(raw.replace(/^[=:]+/, ''));
    if (v === null) return { value: null, index: i };
    return { value: v, index: j };
  }
  return { value: null, index: i };
}

/** Expand a shorthand price: 93 with ref 4391 -> 4393 ; 85 with 4391 -> 4385 */
function expandShort(v, ref) {
  v = Math.round(v);
  ref = Math.round(ref);
  if (v < 1000 && ref >= 1000) {
    const vs = String(v);
    const rs = String(ref);
    if (vs.length < rs.length) {
      const prefix = rs.slice(0, rs.length - vs.length);
      return Number(prefix + vs);
    }
  }
  return v;
}

/** Parse "4391-93", "4398-4400", "4382-85" -> [low, high]; null if not a range */
function parseRange(tok) {
  const m = String(tok).match(/^(\d+(?:\.\d+)?)[-–—](\d+(?:\.\d+)?)$/);
  if (!m) return null;
  let a = num(m[1]);
  let b = num(m[2]);
  if (a === null || b === null) return null;
  if (b < 1000 && a >= 1000) b = expandShort(b, a);
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

/** A small decimal (<100, ≤2 decimals) that is clearly a lot size, not a price */
function isLotLike(tok) {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(tok)) return false;
  const v = parseFloat(tok);
  return v < 100 && (tok.includes('.') || v <= 50);
}

function findPair(tokens, action, actionWord) {
  const dirWords = new Set(['BUY', 'SELL', 'LONG', 'SHORT']);
  if (actionWord) dirWords.add(actionWord);
  for (const tok of tokens) {
    if (dirWords.has(tok)) continue;
    if (KEYWORDS.has(tok) || NOISE.has(tok)) continue;
    if (/^\d+(\.\d+)?([-–—]\d+)?$/.test(tok)) continue;
    if (PAIR_ALIASES[tok]) return PAIR_ALIASES[tok];
    if (/^(X[A-Z]{3,5}|[A-Z]{2,6}\d{1,3}|[A-Z]{4,6})$/.test(tok)) return tok;
  }
  return null;
}

function parseTradeMessage(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = cleanText(text);
  if (!clean) return null;

  // LONG = BUY, SHORT = SELL (common trader shorthand) — normalized below.
  const actionMatch = clean.match(/\b(BUY|SELL|LONG|SHORT)\b/);

  if (!actionMatch && /\b(?:TP|TAKE\s*PROFIT)\b/.test(clean)) {
    const tps = [];
    const tpRe = /\b(?:TP|TAKE\s*PROFIT)\s*[:=]?\s*(\d+(?:\.\d+)?)/gi;
    let m;
    while ((m = tpRe.exec(clean)) !== null) {
      const v = num(m[1]);
      if (v !== null) tps.push(v);
    }
    return tps.length ? { type: 'tp', tps, raw: text } : null;
  }

  if (!actionMatch) return null;
  const actionWord = actionMatch[1];
  const action = actionWord === 'LONG' ? 'BUY' : actionWord === 'SHORT' ? 'SELL' : actionWord;

  const tokens = clean.split(/\s+/).filter(Boolean);
  const pair = findPair(tokens, action, actionWord);
  if (!pair) return null;

  let entryLow = null;
  let entryHigh = null;
  let entry = null;
  let sl = null;
  let lot = null;
  const tp = [];

  for (let i = 0; i < tokens.length; i++) {
    const rawTok = tokens[i];
    let tok = rawTok.replace(/[,:;=]/g, '');
    if (!tok) continue;
    const glued = rawTok.match(/^(SL|TP|LOT|ENTRY)[:=]+(\d+(?:\.\d+)?)$/i);
    if (glued) {
      const kind = glued[1].toUpperCase();
      const v = num(glued[2]);
      if (v !== null) {
        if (kind === 'SL') sl = v;
        else if (kind === 'TP') tp.push(v);
        else if (kind === 'LOT') lot = v;
        else { entry = v; entryLow = v; entryHigh = v; }
      }
      continue;
    }

    if (tok === 'SL' || tok.startsWith('SL')) {
      const n = tok === 'SL' ? nextNumber(tokens, i) : { value: num(tok.replace(/^SL/, '')), index: i };
      if (n.value !== null) { sl = n.value; i = n.index; }
      continue;
    }
    if (tok === 'STOP' && tokens[i + 1] === 'LOSS') {
      const n = nextNumber(tokens, i + 1);
      if (n.value !== null) { sl = n.value; i = n.index; }
      continue;
    }
    if (tok === 'TP' || tok.startsWith('TP') || (tok === 'TAKE' && tokens[i + 1] === 'PROFIT')) {
      if (tok.startsWith('TP') && tok !== 'TP') {
        const v = num(tok.replace(/^TP/, ''));
        if (v !== null) tp.push(v);
        continue;
      }
      const start = tok === 'TAKE' ? i + 1 : i;
      for (let j = start + 1; j < Math.min(start + 8, tokens.length); j++) {
        if (/^[,:;=]+$/.test(tokens[j])) continue;
        const v = num(tokens[j].replace(/^[=:]+/, ''));
        if (v === null || KEYWORDS.has(tokens[j].replace(/[,:;]/g, ''))) break;
        tp.push(v); i = j;
      }
      continue;
    }
    if (tok === 'LOT' || tok === 'VOLUME' || tok === 'VOL' || tok === 'SIZE') {
      const n = nextNumber(tokens, i); if (n.value !== null) { lot = n.value; i = n.index; } continue;
    }
    if (tok === 'ENTRY' || tok === 'PRICE' || tok === 'AT' || tok === '@') {
      const n = nextNumber(tokens, i);
      if (n.value !== null) { entry = n.value; entryLow = n.value; entryHigh = n.value; i = n.index; }
      continue;
    }
    if (entryLow === null) {
      const r = parseRange(tok);
      if (r) { entryLow = r[0]; entryHigh = r[1]; continue; }
      const v = num(tok);
      if (v !== null) {
        if (isLotLike(tok)) { lot = v; }
        else { entry = v; entryLow = v; entryHigh = v; }
        continue;
      }
    }
  }

  if (sl === null) {
    const slM = clean.match(/\b(?:SL|STOP\s*LOSS)\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
    if (slM) sl = num(slM[1]);
  }
  if (!tp.length) {
    const tpRe = /\b(?:TP|TAKE\s*PROFIT)\s*[:=]?\s*(\d+(?:\.\d+)?)/gi;
    let m;
    while ((m = tpRe.exec(clean)) !== null) {
      const v = num(m[1]);
      if (v !== null) tp.push(v);
    }
  }

  if (sl !== null && sl < 1000 && entryLow !== null && entryLow >= 1000) {
    sl = expandShort(sl, entryLow);
  }

  const hasEntry = entryLow !== null;
  const hasLot = lot !== null;
  if (!(hasEntry || hasLot) || sl === null) return null;

  return {
    type: 'signal',
    action,
    pair,
    entryLow,
    entryHigh,
    entry: entryLow !== null && entryHigh !== null && entryLow !== entryHigh
      ? (entryLow + entryHigh) / 2
      : (entryLow ?? entry),
    sl,
    tp,
    lot,
    raw: text,
  };
}

function parseSignal(text) {
  const r = parseTradeMessage(text);
  if (!r || r.type !== 'signal') return null;
  const { type, ...sig } = r;
  return sig;
}

module.exports = { parseTradeMessage, parseSignal, expandShort, parseRange };
