'use strict';
const assert = require('assert');
const {
  parseOwnerCommand, parseCloseArgs, resolveTargets, closeVolumeFor, parseFractionToken,
} = require('../src/commands');

function eq(label, got, want) {
  for (const [k, v] of Object.entries(want)) {
    assert.strictEqual(got && got[k], v, `${label}: ${k} got ${JSON.stringify(got && got[k])} want ${JSON.stringify(v)}`);
  }
  console.log('ok  ', label);
}

/* ---------- /close family ---------- */
eq('/close', parseOwnerCommand('/close'), { type: 'close', fraction: 1, all: false, index: null, ticketId: null, pair: null });
eq('/close all', parseOwnerCommand('/close all'), { type: 'close', all: true });
eq('/flatten', parseOwnerCommand('/flatten'), { type: 'close', all: true });
eq('/closeall', parseOwnerCommand('/closeall'), { type: 'close', all: true });
eq('/cancel', parseOwnerCommand('/cancel'), { type: 'close' });
eq('/close 50%', parseOwnerCommand('/close 50%'), { type: 'close', fraction: 0.5 });
eq('/close half', parseOwnerCommand('/close half'), { type: 'close', fraction: 0.5 });
eq('/close 50', parseOwnerCommand('/close 50'), { type: 'close', fraction: 0.5 });
eq('/close 100', parseOwnerCommand('/close 100'), { type: 'close', fraction: 1 });
eq('/close 0.5', parseOwnerCommand('/close 0.5'), { type: 'close', fraction: 0.5 });
eq('/close 1', parseOwnerCommand('/close 1'), { type: 'close', index: 1, fraction: 1 });
eq('/close 2 50%', parseOwnerCommand('/close 2 50%'), { type: 'close', index: 2, fraction: 0.5 });
eq('/close xauusd', parseOwnerCommand('/close xauusd'), { type: 'close', pair: 'XAUUSD' });
eq('/close GOLD', parseOwnerCommand('/close GOLD'), { type: 'close', pair: 'XAUUSD' });
eq('/close gold half', parseOwnerCommand('/close gold half'), { type: 'close', pair: 'XAUUSD', fraction: 0.5 });
eq('/close #120548117', parseOwnerCommand('/close #120548117'), { type: 'close', ticketId: '120548117', fraction: 1 });
eq('/close #120548117 50%', parseOwnerCommand('/close #120548117 50%'), { type: 'close', ticketId: '120548117', fraction: 0.5 });
eq('/close 120548117', parseOwnerCommand('/close 120548117'), { type: 'close', ticketId: '120548117' });
eq('/partial', parseOwnerCommand('/partial'), { type: 'close', fraction: 0.5 });
eq('/partial 30', parseOwnerCommand('/partial 30'), { type: 'close', fraction: 0.3 });
eq('/partial 2', parseOwnerCommand('/partial 2'), { type: 'close', index: 2, fraction: 0.5 });

/* ---------- /be (breakeven) ---------- */
eq('/be', parseOwnerCommand('/be'), { type: 'breakeven', index: null, ticketId: null, pair: null, pips: null });
eq('/breakeven', parseOwnerCommand('/breakeven'), { type: 'breakeven' });
eq('/be 2', parseOwnerCommand('/be 2'), { type: 'breakeven', index: 2 });
eq('/be #120548117', parseOwnerCommand('/be #120548117'), { type: 'breakeven', ticketId: '120548117' });
eq('/be gold', parseOwnerCommand('/be gold'), { type: 'breakeven', pair: 'XAUUSD' });
eq('/be +50', parseOwnerCommand('/be +50'), { type: 'breakeven', pips: 50 });
eq('/be -25', parseOwnerCommand('/be -25'), { type: 'breakeven', pips: -25 });
eq('/be 2 +50', parseOwnerCommand('/be 2 +50'), { type: 'breakeven', index: 2, pips: 50 });

/* ---------- /sl and /tp ---------- */
eq('/sl 4590', parseOwnerCommand('/sl 4590'), { type: 'sl', price: 4590 });
eq('/tp 4650', parseOwnerCommand('/tp 4650'), { type: 'tp', price: 4650 });
eq('/sl 2 4590', parseOwnerCommand('/sl 2 4590'), { type: 'sl', index: 2, price: 4590 });
eq('/sl xauusd 4590', parseOwnerCommand('/sl xauusd 4590'), { type: 'sl', pair: 'XAUUSD', price: 4590 });
eq('/sl #120548117 4590', parseOwnerCommand('/sl #120548117 4590'), { type: 'sl', ticketId: '120548117', price: 4590 });
eq('/tp 4650.5', parseOwnerCommand('/tp 4650.5'), { type: 'tp', price: 4650.5 });
eq('/sl (no price)', parseOwnerCommand('/sl'), { type: 'sl', price: null });

/* ---------- info / control commands ---------- */
eq('/ping', parseOwnerCommand('/ping'), { type: 'ping' });
eq('/status', parseOwnerCommand('/status'), { type: 'status' });
eq('/risk', parseOwnerCommand('/risk'), { type: 'risk' });
eq('/pause', parseOwnerCommand('/pause'), { type: 'pause' });
eq('/resume', parseOwnerCommand('/resume'), { type: 'resume' });
eq('/positions', parseOwnerCommand('/positions'), { type: 'positions' });
eq('/pos', parseOwnerCommand('/pos'), { type: 'positions' });
eq('/orders', parseOwnerCommand('/orders'), { type: 'positions' });
eq('/verify', parseOwnerCommand('/verify'), { type: 'verify' });
eq('/account', parseOwnerCommand('/account'), { type: 'account' });
eq('/shot', parseOwnerCommand('/shot'), { type: 'shot' });
eq('/screenshot', parseOwnerCommand('/screenshot'), { type: 'shot' });
eq('/help', parseOwnerCommand('/help'), { type: 'help' });
eq('/retake', parseOwnerCommand('/retake'), { type: 'retake' });
eq('/mode log', parseOwnerCommand('/mode log'), { type: 'mode', arg: 'log' });
eq('/mode', parseOwnerCommand('/mode'), { type: 'mode', arg: '' });
eq('/trade SELL XAUUSD 4600 SL 4610', parseOwnerCommand('/trade SELL XAUUSD 4600 SL 4610'),
  { type: 'trade', arg: 'SELL XAUUSD 4600 SL 4610' });

/* ---------- non-commands ---------- */
assert.strictEqual(parseOwnerCommand('hello'), null, 'plain text is not a command');
assert.strictEqual(parseOwnerCommand(''), null);
assert.strictEqual(parseOwnerCommand('/unknowncmd'), null);
assert.strictEqual(parseOwnerCommand('GOLD BUY 4391'), null);
console.log('ok  ', 'non-commands -> null');

/* ---------- fraction tokenizer edge cases ---------- */
assert.strictEqual(parseFractionToken('30%'), 0.3);
assert.strictEqual(parseFractionToken('30 percent'), 0.3);
assert.strictEqual(parseFractionToken('HALF'), 0.5);
assert.strictEqual(parseFractionToken('150%'), null, '>100% rejected');
assert.strictEqual(parseFractionToken('0.25'), 0.25);
assert.strictEqual(parseFractionToken('7'), null, 'single digit is an index, not a fraction');
assert.strictEqual(parseFractionToken('4600'), null, 'price-sized numbers are not fractions');
console.log('ok  ', 'fraction tokenizer');

/* ---------- resolveTargets ---------- */
const positions = [
  { pair: 'XAUUSD', terminalSymbol: 'XAUUSD247', ticketId: '120548117', side: 'BUY', lot: 0.05, entry: 4607, sl: 4600, tp: 4620, openedAt: 1 },
  { pair: 'XAUUSD', terminalSymbol: 'XAUUSD247', ticketId: '120549999', side: 'SELL', lot: 0.02, entry: 4610, sl: 4616, tp: 4600, openedAt: 2 },
  { pair: 'EURUSD', terminalSymbol: 'EURUSD', ticketId: '120550001', side: 'BUY', lot: 0.1, entry: 1.085, sl: 1.08, tp: 1.09, openedAt: 3 },
];

assert.strictEqual(resolveTargets(positions, {}).length, 1, 'default selector -> latest only');
assert.strictEqual(resolveTargets(positions, {})[0].ticketId, '120550001', 'default selector -> most recent');
assert.strictEqual(resolveTargets(positions, { all: true }).length, 3, 'all -> every position');
assert.strictEqual(resolveTargets(positions, { index: 2 })[0].ticketId, '120549999', 'index 2');
assert.strictEqual(resolveTargets(positions, { index: 5 }).length, 0, 'out-of-range index -> empty');
assert.strictEqual(resolveTargets(positions, { ticketId: '120548117' })[0].side, 'BUY', 'by ticket');
assert.strictEqual(resolveTargets(positions, { ticketId: '999' }).length, 0, 'unknown ticket -> empty');
assert.strictEqual(resolveTargets(positions, { pair: 'xauusd' }).length, 2, 'by pair (both gold)');
assert.strictEqual(resolveTargets(positions, { pair: 'XAUUSDM' }).length, 2, 'gold family matching');
assert.strictEqual(resolveTargets([], {}).length, 0, 'empty tracking -> empty');
console.log('ok  ', 'resolveTargets (latest/index/ticket/pair/all)');

/* ---------- closeVolumeFor (partial close math) ---------- */
let r = closeVolumeFor({ lot: 0.10 }, 0.5);
assert.deepStrictEqual([r.ok, r.full, r.volume, r.remaining], [true, false, 0.05, 0.05], '50% of 0.10');
r = closeVolumeFor({ lot: 0.05 }, 0.5);
assert.deepStrictEqual([r.ok, r.full, r.volume, r.remaining], [true, false, 0.02, 0.03], '50% of 0.05 floors to 0.02');
r = closeVolumeFor({ lot: 0.01 }, 0.5);
assert.deepStrictEqual([r.ok, r.full], [true, true], '50% of 0.01 -> full close (below lot step)');
r = closeVolumeFor({ lot: 0.03 }, 0.5);
assert.deepStrictEqual([r.ok, r.full, r.volume, r.remaining], [true, false, 0.01, 0.02], '50% of 0.03 floors to 0.01 (never over-close)');
r = closeVolumeFor({ lot: 0.10 }, 1);
assert.deepStrictEqual([r.ok, r.full, r.volume], [true, true, 0.1], 'fraction 1 -> full');
r = closeVolumeFor({ lot: null }, 0.5);
assert.strictEqual(r.ok, false, 'unknown lot -> not ok (full-close fallback handled by caller)');
console.log('ok  ', 'closeVolumeFor (lot-step flooring)');

/* ---------- parseCloseArgs direct ---------- */
const ca = parseCloseArgs('xauusd 30');
assert.deepStrictEqual([ca.pair, ca.fraction], ['XAUUSD', 0.3], 'parseCloseArgs pair+fraction');
console.log('ok  ', 'parseCloseArgs');

console.log('\nAll command-parser tests passed ✔');
