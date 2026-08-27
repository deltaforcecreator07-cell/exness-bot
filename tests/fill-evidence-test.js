'use strict';
const assert = require('assert');
const { matchFillEvidence, symbolNeedles, symbolsMatch } = require('../src/fill-evidence');

const gold = { action: 'BUY', lot: 0.15, symbols: symbolNeedles('XAUUSD', ['XAUUSD247']) };

function hit(label, text, extra) {
  const got = matchFillEvidence(text, { ...gold, ...extra });
  assert.ok(got, `${label}: expected a fill, got null for ${JSON.stringify(text)}`);
  console.log('ok  ', label, '->', got.kind, got.ticket || '');
  return got;
}

function miss(label, text, extra) {
  const got = matchFillEvidence(text, { ...gold, ...extra });
  assert.strictEqual(got, null, `${label}: expected null, got ${JSON.stringify(got)}`);
  console.log('ok  ', label);
}

/* ---- real evidence from the 2026-08-26 MT4 fill that was reported as failed ---- */
const chart = hit('chart label #ticket buy lot', '#120241514 buy 0.15');
assert.strictEqual(chart.ticket, '120241514');
assert.strictEqual(chart.lot, '0.15');

const row = hit('Trade-tab row',
  '120241514 2026.08.26 06:35:46 buy 0.15 XAUUSD247 4629.485 4624.354 4635.000');
assert.strictEqual(row.ticket, '120241514');
assert.strictEqual(row.kind, 'line');

hit('MT4 journal "order was opened"',
  "'XAUUSD247,M1: order was opened : #120241514 buy 0.15 XAUUSD247 at 4629.485 sl: 4624.354 tp: 4635.000");

hit('chart labels stacked with tp/sl',
  '#120241514 tp\n#120241514 buy 0.15\n#120241514 sl');

/* ---- must NOT treat the open ticket / junk "journal" scrape as a fill ---- */
miss('open MT4 ticket (Buy by Market + volume + symbol, no ticket id)',
  'Volume 0.15 Stop Loss 4620 Take Profit 4635 Buy by Market Sell by Market XAUUSD247, Gold vs US Dollar 24/7');

miss('bot journal scrape that was just UI chrome',
  'Journal  | USDCHF,H1  0.80335 0.80370 0.80327 0.80369 | SELL | 0.80 36 9 | BUY | 0.80 36 9 | USDCHF, H1  | Order | Symbol: | USDCHF, US Dollar vs Swiss Franc | GBPUSD');

miss('empty');
miss('unrelated chart quote', 'XAUUSD247 4628.536 4628.586');

/* ---- aliases ---- */
assert.ok(symbolsMatch('XAUUSD', 'XAUUSD247'));
assert.ok(symbolsMatch('GOLD', 'XAUUSD'));
assert.ok(!symbolsMatch('XAUUSD', 'EURUSD'));
assert.deepStrictEqual(
  symbolNeedles('GOLD', ['XAUUSD247, Gold vs US Dollar 24/7']).slice(0, 2),
  ['XAUUSD247', 'GOLD'],
);
console.log('ok   symbol aliases');

console.log('\nAll fill-evidence tests passed ✔');
