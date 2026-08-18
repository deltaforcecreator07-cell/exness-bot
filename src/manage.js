'use strict';

/**
 * Management-instruction classifier.
 *
 * Turns the trader's spoken Roman-Urdu instructions into structured actions:
 *   { action: 'close_position' }
 *   { action: 'modify_sl', target: 'price',     price: 4393 }
 *   { action: 'modify_sl', target: 'breakeven', pips: 50 }
 *   { action: 'modify_tp', target: 'price',     price: 4410 }
 *   { action: 'note', message: '...' }          -> nothing to do
 *   null                                        -> not a management instruction
 *
 * Pipeline:
 *   1. cheap pre-filter (hint regex + status-noise skip) so we don't burn
 *      Gemini quota on react-bait / status spam
 *   2. Gemini 3.6 Flash (if GEMINI_API_KEY set) — understands the Roman-Urdu
 *      phrasing "50 pips pa breakeven kar dana", "trade close kardo"
 *   3. rule-based fallback (no API / rate-limited) for the common patterns
 */
const { generateText, parseJsonLoose } = require('./gemini');
const { listPositions } = require('./positions');
const { expandShort } = require('./parser');
const { priceFromPips, pipSize } = require('./pips');

// status/chat noise that is never an instruction — skip before calling Gemini
// (NOTE: "BE TAPPED"/"BE HIT" are handled BEFORE this filter — they mean the
//  trade closed at breakeven, which is meaningful, not noise)
const STATUS_NOISE = /(running|active|reacts|report|reply|edited|now!?$|coming!?$|holding|volatile|low volume)/i;

// must contain at least one of these to even be considered an instruction
const MGMT_HINT = /(sl|stop\s*loss|tp|take\s*profit|close|band|karo|kardo|kar\s*dana|breakeven|break\s*even|trail|entry|exit|position|rakh|set|move|profit|target|pips|hit|loss|\bbe\b)/i;

/**
 * "BE TAPPED" / "BE HIT" / "BE TAP!" / "BREAKEVEN TAPPED"
 * -> the stop loss was moved to breakeven and got hit: the trade is CLOSED
 *    at entry (no profit / no loss). No browser action needed — the broker
 *    already closed it. We only drop tracking and inform.
 * Excluded when the text looks like a daily report / recap ("BE HIT AFTER
 * 70 PIPS" inside the end-of-day report refers to a past trade).
 */
function ruleBreakevenHit(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.toUpperCase().replace(/\s+/g, ' ').trim();
  if (/(REPORT|DAILY)/i.test(clean)) return null; // daily recap, not a live event
  const m = clean.match(/(\bBE\b|BREAKEVEN)\s*(TAP|TAPPED|HIT|DONE|LAGA|GAYA|GAYI|KHAIR)/i);
  if (m) {
    return { action: 'breakeven_hit', target: null, price: null, pips: null, pair: null, message: text };
  }
  return null;
}

function buildPrompt(text) {
  const positions = listPositions().map((p) =>
    `${p.side} ${p.pair} ${p.lot} lot @ ${p.entry ?? '?'} SL ${p.sl ?? '-'} TP ${p.tp ?? '-'}`).join('; ') || 'none';
  return `You translate a forex/gold trader's WhatsApp instructions into JSON for a trading bot.
The trader writes in a mix of English and Roman Urdu ("kardo", "rakhna", "kar dana", "pe/pa" = at).
"BE" is ALWAYS short for "breakeven" in this trader's vocabulary.
Only respond with JSON, no prose. No markdown.

Allowed actions:
- "close_position"           -> close the open trade
- "breakeven_hit"            -> the trade was ALREADY closed at breakeven (the
                                stop loss had been moved to entry and got hit).
                                Use ONLY for announcements like "BE tapped",
                                "BE hit", "BE tap". Do NOT use for instructions.
- "modify_sl"                -> change the stop loss
- "modify_tp"                -> change the take profit
- "note"                     -> informational only, no action

Fields:
- action: one of the above
- target: "price" (explicit price) | "breakeven" | "trail_pips" | null
- price: numeric price ONLY if target is "price" (null otherwise). If the trader
  gives a SHORTHAND price (e.g. "93" when gold is ~4393, "401" for 4401, or
  "SL ko BE pe rakh do" meaning entry), expand it to the FULL price using the
  position context below and put the FULL number in price.
- pips: numeric pips if the instruction mentions pips (else null)
- pair: the symbol if mentioned (XAUUSD, US30, ...) else null
- message: a short English summary of what the trader said

Context (open positions): ${positions}

Examples:
- "trade close kardo" -> {"action":"close_position","target":null,"price":null,"pips":null,"pair":null,"message":"close the trade"}
- "BE tapped" -> {"action":"breakeven_hit","target":null,"price":null,"pips":null,"pair":null,"message":"trade closed at breakeven"}
- "BE hit done for the day" -> {"action":"breakeven_hit","target":null,"price":null,"pips":null,"pair":null,"message":"trade closed at breakeven"}
- "SL 401 pe rakhna" with gold ~4391 -> {"action":"modify_sl","target":"price","price":4401,"pips":null,"pair":"XAUUSD","message":"set SL to 4401"}
- "50 pips pa breakeven kar dana" -> {"action":"modify_sl","target":"breakeven","price":null,"pips":50,"pair":null,"message":"move SL to breakeven after 50 pips"}
- "SL ko BE pe rakh do" -> {"action":"modify_sl","target":"breakeven","price":null,"pips":null,"pair":null,"message":"move SL to breakeven"}
- "TRAIL SL TO BE" -> {"action":"modify_sl","target":"breakeven","price":null,"pips":null,"pair":null,"message":"trail SL to breakeven"}
- "TRAIL SL TO 93" with entry ~4391 -> {"action":"modify_sl","target":"price","price":4393,"pips":null,"pair":"XAUUSD","message":"trail SL to 4393"}
- "60+ pips running" -> {"action":"note","target":null,"price":null,"pips":60,"pair":null,"message":"status update"}
- "if this msg gets 80 reacts" -> {"action":"note","target":null,"price":null,"pips":null,"pair":null,"message":"react bait"}

Trader message: "${text}"`;
}

/* ---------------- rule-based fallback (no API) ---------------- */

function ruleClassify(text) {
  // 1) "BE TAPPED"/"BE HIT" -> closed at breakeven
  const beHit = ruleBreakevenHit(text);
  if (beHit) return beHit;

  const clean = text.toUpperCase().replace(/\s+/g, ' ').trim();

  // 2) close
  if (/(CLOSE|BAND|KHATAM|EXIT|BAND\s*KAR|KAR\s*DO|KARDO)\s*(KARO|KARDO|THE|DO)?/.test(clean) &&
      /(TRADE|POSITION|ORDER)/.test(clean)) {
    return { action: 'close_position', target: null, price: null, pips: null, pair: null, message: text };
  }
  if (/(TRADE|POSITION|ORDER)\s*(KO)?\s*(CLOSE|BAND|KHATAM)/.test(clean)) {
    return { action: 'close_position', target: null, price: null, pips: null, pair: null, message: text };
  }

  // 3) move SL to breakeven — "BE" IS breakeven here too:
  //    "SL KO BE PE RAKH DO" | "TRAIL SL TO BE" | "50 PIPS PA BREAKEVEN KAR DANA"
  const beInstRe =
    /(BREAKEVEN|BREAK\s*EVEN)|((SL|STOP\s*LOSS)\s*(KO|TO|PE|PA|PAR)?\s*(BREAKEVEN|BREAK\s*EVEN|\bBE\b))|(\bBE\b\s*(PE|PA|KO|TO|PAR)?\s*(SL|STOP))/i;
  if (beInstRe.test(clean) && !/(TAPPED|HIT|RUNNING)/i.test(clean)) {
    const pipsM = clean.match(/(\d+(?:\.\d+)?)\s*(PIPS|POINTS?)/i);
    return {
      action: 'modify_sl', target: 'breakeven', price: null,
      pips: pipsM ? parseFloat(pipsM[1]) : null, pair: null, message: text,
    };
  }

  // 4) SL to a price: "SL 401 PE RAKHNA", "TRAIL SL TO 93", "SL KO 401 PE KARO"
  //    (shorthand like "401" -> 4401 is expanded later in resolveNewSl, which has
  //     the position's entry price as reference)
  const slM = clean.match(/(?:TRAIL|SL|STOP\s*LOSS)\s*(?:KO|TO|PE|PA)?\s*[:=]?\s*(\d{1,6}(?:\.\d+)?)/i);
  if (slM && !/(TAPPED|HIT|RUNNING)/i.test(clean)) {
    const price = parseFloat(slM[1]);
    return { action: 'modify_sl', target: 'price', price, pips: null, pair: null, message: text };
  }

  return null;
}

/* ---------------- public API ---------------- */

async function classifyManagement(text) {
  if (!text || typeof text !== 'string') return null;

  // 0) "BE TAPPED"/"BE HIT" -> trade closed at breakeven.
  //    Checked FIRST (before the noise filter and before Gemini) so it is
  //    always treated as the meaningful event it is, never as status spam.
  const beHit = ruleBreakevenHit(text);
  if (beHit) {
    console.log('[manage] rule  ->', JSON.stringify(beHit));
    return beHit;
  }

  if (STATUS_NOISE.test(text)) return null;
  if (!MGMT_HINT.test(text)) return null;

  // 1) Gemini (primary)
  if (process.env.GEMINI_API_KEY) {
    try {
      const out = await generateText(buildPrompt(text));
      const obj = parseJsonLoose(out);
      if (obj && obj.action) {
        console.log('[manage] gemini ->', JSON.stringify(obj));
        if (obj.action !== 'note') return obj;
        return null;
      }
    } catch (e) {
      console.warn('[manage] gemini failed, falling back to rules:', e.message);
    }
  }

  // 2) rules (fallback)
  const r = ruleClassify(text);
  if (r) console.log('[manage] rule  ->', JSON.stringify(r));
  return r;
}

/** Given a modify_sl instruction and the target position, compute the new SL. */
function resolveNewSl(instruction, pos) {
  if (!pos) return null;
  if (instruction.target === 'price' && instruction.price != null) {
    let p = Number(instruction.price);
    // shorthand: "SL 401" with entry ~4391 means 4401; "trail to 93" means 4393
    if (p < 1000 && pos.entry != null && pos.entry >= 1000) {
      p = expandShort(p, pos.entry);
    }
    return p;
  }
  if (instruction.target === 'breakeven') {
    if (pos.entry != null) return Number(pos.entry);
    return null;
  }
  if (instruction.target === 'trail_pips' && instruction.pips != null && pos.entry != null) {
    // trail N pips from current price would need live price; safe interpretation:
    // move SL to entry +/- N pips (buffer) — documented in README as a simplification
    const delta = priceFromPips(instruction.pips, pos.pair);
    return pos.side === 'BUY'
      ? Number((pos.entry + delta).toFixed(2))
      : Number((pos.entry - delta).toFixed(2));
  }
  return null;
}

module.exports = { classifyManagement, resolveNewSl, buildPrompt, ruleClassify, ruleBreakevenHit, pipSize };
