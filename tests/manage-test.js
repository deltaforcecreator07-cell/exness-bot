'use strict';
const assert = require('assert');
const { ruleClassify, resolveNewSl } = require('../src/manage');
const { pipsBetween, priceFromPips, pipSize } = require('../src/pips');
const { expandShort } = require('../src/parser');

function expect(label, got, want) {
  if (want === null) {
    assert.strictEqual(got, null, `${label}: expected null, got ${JSON.stringify(got)}`);
  } else {
    assert.ok(got, `${label}: expected action, got null`);
    assert.strictEqual(got.action, want.action, `${label}: action`);
    if (want.target) assert.strictEqual(got.target, want.target, `${label}: target`);
    if (want.price) assert.strictEqual(got.price, want.price, `${label}: price (got ${got.price})`);
    if (want.pips) assert.strictEqual(got.pips, want.pips, `${label}: pips (got ${got.pips})`);
  }
  console.log('ok  ', label);
}

/* ---- management instructions (rule fallback, no API) ---- */
expect('trade close kardo', ruleClassify('TRADE CLOSE KARDO!'), { action: 'close_position' });
expect('trade ko close kar do', ruleClassify('TRADE KO CLOSE KAR DO!'), { action: 'close_position' });
expect('position band karo', ruleClassify('POSITION BAND KARO!'), { action: 'close_position' });
expect('trade band karo', ruleClassify('trade band karo!'), { action: 'close_position' });

expect('SL 401 pe rakhna (raw price)', ruleClassify('SL 401 PE RAKHNA!'), { action: 'modify_sl', target: 'price', price: 401 });
expect('trail SL to 93 (raw price)', ruleClassify('TRAIL SL TO 93'), { action: 'modify_sl', target: 'price', price: 93 });
expect('sl ko 4400 pe set', ruleClassify('SL KO 4400 PE SET KARO'), { action: 'modify_sl', target: 'price', price: 4400 });

expect('50 pips pa breakeven kar dana', ruleClassify('50 PIPS PA BREAKEVEN KAR DANA'),
  { action: 'modify_sl', target: 'breakeven', pips: 50 });
expect('breakeven pe sl rakh', ruleClassify('SL KO BREAKEVEN PE RAKH DO'),
  { action: 'modify_sl', target: 'breakeven', pips: null });

/* ---- BE = breakeven: status announcements -> closed at breakeven ---- */
expect('BE TAPPED', ruleClassify('BE TAPPED!!!! I AM DONE W GOLD ATP'), { action: 'breakeven_hit' });
expect('BE TAP', ruleClassify('BE TAP! KHAIR!'), { action: 'breakeven_hit' });
expect('BE HIT', ruleClassify('BE HIT DONE FOR THE DAY!'), { action: 'breakeven_hit' });
expect('BREAKEVEN TAPPED', ruleClassify('BREAKEVEN TAPPED!'), { action: 'breakeven_hit' });
expect('BE TAPPED lowercase', ruleClassify('be tapped'), { action: 'breakeven_hit' });

/* ---- BE = breakeven: instructions ---- */
expect('SL ko BE pe rakh do', ruleClassify('SL KO BE PE RAKH DO'), { action: 'modify_sl', target: 'breakeven' });
expect('TRAIL SL TO BE', ruleClassify('TRAIL SL TO BE'), { action: 'modify_sl', target: 'breakeven' });
expect('BE pe SL rakh do', ruleClassify('BE PE SL RAKH DO'), { action: 'modify_sl', target: 'breakeven' });

/* ---- must NOT be instructions ---- */
expect('BE hit inside daily report (past trade)', ruleClassify('SHARKS DAILY REPORT GOLD BUY => BE HIT AFTER 70 PIPS'), null);
expect('60+ pips running', ruleClassify('60+ PIPS RUNNING DO BE!'), null);
expect('sl hit done (not BE)', ruleClassify('SL HIT DONE FOR THE DAY!'), null);
expect('fall coming', ruleClassify('FALL COMING!'), null);
expect('react bait', ruleClassify('IF THIS MSG GET 80 REACTS WE WILL MAKE 500+ PIPS TOMORROW!'), null);
expect('low volume', ruleClassify('LOW VOLUME!'), null);
expect('need reacts', ruleClassify('NEED MAXIMUM REACTS!'), null);
expect('trivial chat', ruleClassify('ok bhai'), null);

/* ---- pip math ---- */
assert.strictEqual(pipSize('XAUUSD'), 0.1);
assert.strictEqual(pipsBetween(4391, 4401, 'XAUUSD'), 100);
assert.strictEqual(pipsBetween(4400, 4370, 'XAUUSD'), 300);
assert.strictEqual(priceFromPips(50, 'XAUUSD'), 5);
assert.strictEqual(pipsBetween(1.09, 1.08, 'EURUSD'), 100);
console.log('ok  ', 'pip math (gold 0.1, eurusd 0.0001)');

/* ---- shorthand expansion ---- */
assert.strictEqual(expandShort(93, 4391), 4393);
assert.strictEqual(expandShort(401, 4391), 4401);
assert.strictEqual(expandShort(4392, 4391), 4392);
console.log('ok  ', 'shorthand expansion');

/* ---- resolveNewSl (has the position's entry as shorthand reference) ---- */
const pos = { pair: 'XAUUSD', side: 'BUY', entry: 4392, sl: 4385 };
assert.strictEqual(resolveNewSl({ target: 'price', price: 4393 }, pos), 4393);
assert.strictEqual(resolveNewSl({ target: 'price', price: 93 }, pos), 4393);    // trail to 93 -> 4393
assert.strictEqual(resolveNewSl({ target: 'price', price: 401 }, pos), 4401);   // SL 401 -> 4401
assert.strictEqual(resolveNewSl({ target: 'breakeven' }, pos), 4392);
assert.strictEqual(resolveNewSl({ target: 'trail_pips', pips: 50 }, pos), 4397);
console.log('ok  ', 'resolveNewSl (+ shorthand expansion)');

console.log('\nAll management tests passed ✔');
