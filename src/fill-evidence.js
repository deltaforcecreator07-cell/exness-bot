'use strict';

/**
 * Pure fill-detection used after clicking Buy/Sell in the MetaTrader Web ticket.
 *
 * MT4 market execution ("Buy by Market") leaves the order ticket OPEN after a
 * fill. The old confirmer waited for the ticket to close and therefore always
 * timed out on a successful MT4 trade — the position was live, but the bot
 * reported "execution failed" and never recorded it in /positions.
 */

function symbolNeedles(pair, extra = []) {
  const out = [];
  const push = (s) => {
    const v = String(s || '').split(',')[0].trim().toUpperCase();
    if (v && !out.includes(v)) out.push(v);
  };
  for (const x of extra) push(x);
  push(pair);
  const p = String(pair || '').toUpperCase();
  if (p === 'XAUUSD' || p === 'GOLD' || p === 'XAUUSD247' || p === 'XAUUSDM' || /XAU/.test(p)) {
    push('XAUUSD');
    push('XAUUSD247');
    push('XAUUSDM');
    push('GOLD');
  }
  return out;
}

function symbolsMatch(a, b) {
  if (!a || !b) return false;
  const A = String(a).toUpperCase().trim();
  const B = String(b).toUpperCase().trim();
  if (A === B) return true;
  const gold = new Set(['XAUUSD', 'XAUUSD247', 'XAUUSDM', 'GOLD']);
  return gold.has(A) && gold.has(B);
}

/**
 * Scan terminal text (body innerText, a Trade-tab row, journal slice, …)
 * for proof that `action` filled. Returns null when nothing looks like a fill.
 *
 * Deliberately ignores the open order ticket itself (which contains "Buy by
 * Market" + volume + symbol but NO 6+ digit ticket id).
 */
function matchFillEvidence(text, { action, lot, symbols } = {}) {
  if (!text) return null;
  const t = String(text);
  const side = String(action || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
  const upSyms = (symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean);
  const hasSym = (s) => {
    if (!upSyms.length) return true;
    const u = String(s).toUpperCase();
    return upSyms.some((sym) => u.includes(sym));
  };

  const chart = t.match(new RegExp(`#(\\d{6,})\\s+${side}\\s+([0-9]+(?:\\.[0-9]+)?)`, 'i'));
  if (chart) {
    return { kind: 'chart-label', ticket: chart[1], lot: chart[2], snippet: chart[0] };
  }

  const journalRes = [
    /order was opened[^\n|]{0,220}/i,
    /position (?:was )?opened[^\n|]{0,220}/i,
    /order (?:has been )?placed[^\n|]{0,160}/i,
    /market order[^\n|]{0,180}(?:executed|accepted|being executed)[^\n|]{0,100}/i,
    /request (?:was )?accepted[^\n|]{0,100}/i,
    /deal (?:done|executed)[^\n|]{0,80}/i,
  ];
  for (const re of journalRes) {
    const m = t.match(re);
    if (!m) continue;
    if (!hasSym(m[0]) && !/#?\d{6,}/.test(m[0])) continue;
    return { kind: 'journal', snippet: m[0].replace(/\s+/g, ' ').slice(0, 180) };
  }

  for (const raw of t.split(/\n|\|/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < 10 || line.length > 280) continue;
    if (/buy by market|sell by market|pending order/i.test(line) && !/#\d{6,}/.test(line)) continue;
    if (/stop loss|take profit/i.test(line) && !/\b\d{6,}\b/.test(line)) continue;
    if (!new RegExp(`\\b${side}\\b`, 'i').test(line)) continue;
    if (!hasSym(line)) continue;
    const id = line.match(/\b(\d{8,})\b/);
    if (!id) continue;
    if (lot != null && !line.includes(String(lot))) {
      // ticket id + side + symbol is enough; lot is extra confidence
    }
    return { kind: 'line', ticket: id[1], snippet: line.slice(0, 180) };
  }
  return null;
}

module.exports = { matchFillEvidence, symbolNeedles, symbolsMatch };
