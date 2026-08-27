'use strict';
const assert = require('assert');
const { choosePendingType, clampStopsForMarket, planExecution } = require('../src/execution-math');
const { entryTolerance } = require('../src/risk');

/* ---------- choosePendingType ---------- */
assert.strictEqual(choosePendingType('BUY', 4612, 4607, 4608), 'Buy Stop', 'BUY above ask -> stop');
assert.strictEqual(choosePendingType('BUY', 4600, 4607, 4608), 'Buy Limit', 'BUY below ask -> limit');
assert.strictEqual(choosePendingType('SELL', 4600, 4607, 4608), 'Sell Stop', 'SELL below bid -> stop');
assert.strictEqual(choosePendingType('SELL', 4612, 4607, 4608), 'Sell Limit', 'SELL above bid -> limit');
console.log('ok  ', 'choosePendingType (limit vs stop)');

/* ---------- clampStopsForMarket ---------- */
let c = clampStopsForMarket('BUY', { sl: 4605, tp: 4620 }, 4604.5, 4605, 3);
assert.strictEqual(c.sl, 4603.5, 'BUY SL above live bid -> nudged below');
assert.strictEqual(c.tp, 4620, 'valid TP untouched');
assert.strictEqual(c.adjustments.length, 1, 'one adjustment reported');

c = clampStopsForMarket('BUY', { sl: 4600, tp: 4620 }, 4604.5, 4605, 3);
assert.strictEqual(c.sl, 4600, 'valid SL untouched');
assert.strictEqual(c.adjustments.length, 0, 'no adjustments');

c = clampStopsForMarket('SELL', { sl: 4606, tp: 4595 }, 4607, 4606.5, 3);
assert.strictEqual(c.sl, 4607.5, 'SELL SL below live ask -> nudged above (ask + buffer 1.0)');
assert.strictEqual(c.tp, 4595, 'valid SELL TP untouched');

c = clampStopsForMarket('SELL', { sl: 4612, tp: 4609 }, 4607, 4606.5, 3);
assert.strictEqual(c.tp, 4605.5, 'SELL TP above live ask -> nudged below (ask - buffer 1.0)');
console.log('ok  ', 'clampStopsForMarket (nudges only invalid sides)');

/* ---------- planExecution: market within tolerance ---------- */
const zone = { action: 'BUY', entryLow: 4607, entryHigh: 4609, sl: 4600, tp: 4620 };

let p = planExecution(zone, { bid: 4607.8, ask: 4608.2 }, 3);
assert.strictEqual(p.mode, 'market', 'inside zone -> market');
assert.strictEqual(p.drift, 0);

p = planExecution(zone, { bid: 4610.5, ask: 4611 }, 3);
assert.strictEqual(p.mode, 'market', 'price above zone but within +$3 -> STILL market (no missed trades)');
assert.ok(p.drift > 0, 'drift reported');

p = planExecution({ ...zone, action: 'SELL' }, { bid: 4606.0, ask: 4606.5 }, 3);
assert.strictEqual(p.mode, 'market', 'SELL slightly below zone within tolerance -> market');

/* ---------- planExecution: beyond tolerance -> pending at zone edge ---------- */
p = planExecution(zone, { bid: 4614, ask: 4614.5 }, 3);
assert.strictEqual(p.mode, 'pending', 'price ran up beyond +$3 -> pending');
assert.strictEqual(p.pendingType, 'Buy Limit', 'BUY above zone -> Buy Limit at zone top');
assert.strictEqual(p.entryPrice, 4609, 'edge = zone high');

p = planExecution(zone, { bid: 4600, ask: 4600.5 }, 3);
assert.strictEqual(p.mode, 'pending', 'price collapsed beyond -$3 -> pending');
assert.strictEqual(p.pendingType, 'Buy Stop', 'BUY below zone -> Buy Stop at zone bottom');
assert.strictEqual(p.entryPrice, 4607, 'edge = zone low');

p = planExecution({ ...zone, action: 'SELL' }, { bid: 4615, ask: 4615.5 }, 3);
assert.strictEqual(p.mode, 'pending');
assert.strictEqual(p.pendingType, 'Sell Stop', 'SELL above zone -> Sell Stop at zone top');
assert.strictEqual(p.entryPrice, 4609, 'edge = zone high');

p = planExecution({ ...zone, action: 'SELL' }, { bid: 4601, ask: 4601.5 }, 3);
assert.strictEqual(p.mode, 'pending');
assert.strictEqual(p.pendingType, 'Sell Limit', 'SELL below zone -> Sell Limit at zone bottom');
assert.strictEqual(p.entryPrice, 4607, 'edge = zone low');

/* ---------- planExecution: SL/TP clamp inside the tolerance band ---------- */
p = planExecution({ ...zone, sl: 4608, tp: 4620 }, { bid: 4606, ask: 4606.5 }, 3);
assert.strictEqual(p.mode, 'market');
assert.strictEqual(p.sl, 4605, 'BUY SL crossed by live price within band -> clamped to bid - buffer');
assert.strictEqual(p.adjustments.length, 1);

p = planExecution({ ...zone, sl: 4600, tp: 4620 }, { bid: 4606, ask: 4606.5 }, 3);
assert.strictEqual(p.sl, 4600, 'valid SL not touched by planner');

/* ---------- planExecution: single entry, no zone ---------- */
p = planExecution({ action: 'BUY', entry: 4607, entryLow: 4607, entryHigh: 4607, sl: 4600 }, { bid: 4608, ask: 4608.3 }, 3);
assert.strictEqual(p.mode, 'market', 'single-price entry within tolerance -> market');

p = planExecution({ action: 'BUY', entry: 4607, entryLow: 4607, entryHigh: 4607, sl: 4600 }, { bid: 4615, ask: 4616 }, 3);
assert.strictEqual(p.mode, 'pending', 'single entry far away -> pending');
assert.strictEqual(p.entryPrice, 4607);

/* ---------- planExecution: no prices / explicit pending ---------- */
p = planExecution(zone, null, 3);
assert.strictEqual(p.mode, 'market', 'no live prices -> behave exactly as before (market)');

p = planExecution({ ...zone, pending: true }, { bid: 4608, ask: 4608.2 }, 3);
assert.strictEqual(p.mode, 'pending', 'explicit pending intent honoured');

p = planExecution({ ...zone, entryPrice: 4605 }, { bid: 4604, ask: 4604.2 }, 3);
assert.strictEqual(p.mode, 'pending', 'explicit entryPrice -> pending as before');
console.log('ok  ', 'planExecution (tolerance bands, pending fallback, clamps)');

/* ---------- entryTolerance (risk layer) ---------- */
const prevUsd = process.env.ENTRY_TOLERANCE_USD;
const prevJson = process.env.ENTRY_TOLERANCE_JSON;
delete process.env.ENTRY_TOLERANCE_JSON;
process.env.ENTRY_TOLERANCE_USD = '';
assert.strictEqual(entryTolerance(null), 3, 'default tolerance $3');
process.env.ENTRY_TOLERANCE_USD = '2.5';
assert.strictEqual(entryTolerance('XAUUSD'), 2.5, 'env override');
process.env.ENTRY_TOLERANCE_JSON = '{"EURUSD":0.003,"XAUUSD":2}';
assert.strictEqual(entryTolerance('XAUUSD247'), 2, 'per-symbol (with suffix)');
assert.strictEqual(entryTolerance('EURUSD'), 0.003, 'per-symbol fx');
delete process.env.ENTRY_TOLERANCE_JSON;
delete process.env.ENTRY_TOLERANCE_USD;
assert.strictEqual(entryTolerance('XAUUSD'), 3, 'back to default');
if (prevUsd !== undefined) process.env.ENTRY_TOLERANCE_USD = prevUsd;
if (prevJson !== undefined) process.env.ENTRY_TOLERANCE_JSON = prevJson;
console.log('ok  ', 'entryTolerance (default, env, per-symbol JSON)');

console.log('\nAll execution-math tests passed ✔');
