'use strict';
const assert = require('assert');
const { parseTradeMessage } = require('../src/parser');

function sig(label, input, expected) {
  const got = parseTradeMessage(input);
  assert.ok(got && got.type === 'signal', `${label}: expected signal, got ${JSON.stringify(got)}`);
  for (const [k, v] of Object.entries(expected)) {
    if (Array.isArray(v)) assert.deepStrictEqual(got[k], v, `${label}: ${k}`);
    else assert.strictEqual(got[k], v, `${label}: ${k} = ${got[k]}, expected ${v}`);
  }
  console.log('ok  ', label);
}

function tp(label, input, expected) {
  const got = parseTradeMessage(input);
  assert.ok(got && got.type === 'tp', `${label}: expected tp-message, got ${JSON.stringify(got)}`);
  assert.deepStrictEqual(got.tps, expected, `${label}: tps`);
  console.log('ok  ', label);
}

function none(label, input) {
  const got = parseTradeMessage(input);
  assert.strictEqual(got, null, `${label}: expected null, got ${JSON.stringify(got)}`);
  console.log('ok  ', label);
}

sig('GOLD BUY zone + shorthand SL', 'GOLD BUY 4391-93 SL 85',
  { action: 'BUY', pair: 'XAUUSD', entryLow: 4391, entryHigh: 4393, sl: 4385, lot: null });

sig('GOLD BUY bold zone + full SL', 'GOLD BUY **4398-4400** SL 4392',
  { action: 'BUY', pair: 'XAUUSD', entryLow: 4398, entryHigh: 4400, sl: 4392, lot: null });

sig('GOLD SELL bold zone', 'GOLD SELL **4400-4402** SL 4408',
  { action: 'SELL', pair: 'XAUUSD', entryLow: 4400, entryHigh: 4402, sl: 4408, lot: null });

sig('GOLD BUY short zone', 'GOLD BUY 4382-85 SL 4377',
  { action: 'BUY', pair: 'XAUUSD', entryLow: 4382, entryHigh: 4385, sl: 4377, lot: null });

sig('GOLD BUY with inline TP', 'GOLD BUY 4398-4400 SL 4392 TP 4408 TP 4420',
  { action: 'BUY', pair: 'XAUUSD', entryLow: 4398, entryHigh: 4400, sl: 4392, tp: [4408, 4420] });

sig('classic simple format still works', 'BUY XAUUSD 0.1 SL 2005 TP 2020',
  { action: 'BUY', pair: 'XAUUSD', lot: 0.1, sl: 2005, tp: [2020] });

sig('/trade Gold with pipes and Sl :', 'Gold buy 4605 | Sl : 4600 tp 4620',
  { action: 'BUY', pair: 'XAUUSD', entryLow: 4605, entryHigh: 4605, sl: 4600, tp: [4620] });

sig('/trade BUY XAUUSD pipes + Sl :', 'BUY XAUUSD 4605 | Sl : 4600 tp 4620',
  { action: 'BUY', pair: 'XAUUSD', entryLow: 4605, entryHigh: 4605, sl: 4600, tp: [4620] });

sig('glued SL: TP:', 'GOLD BUY 4605 SL:4600 TP:4620',
  { action: 'BUY', pair: 'XAUUSD', entryLow: 4605, entryHigh: 4605, sl: 4600, tp: [4620] });

sig('single entry no zone', 'BUY XAUUSD 4605 SL 4600 TP 4620',
  { action: 'BUY', pair: 'XAUUSD', entryLow: 4605, entryHigh: 4605, sl: 4600, tp: [4620] });

tp('TP pair 1', 'TP 4401\nTP 4410', [4401, 4410]);
tp('TP pair 2 (sell)', 'TP 4392 TP 4370', [4392, 4370]);
tp('TP pair 3', 'TP 4393 TP 4400', [4393, 4400]);

none('GOLD BUY NOW! (no entry/SL)', 'GOLD BUY NOW!');
none('SL trail update', 'TRAIL SL TO 93');
none('SL pips update', 'SL -60 PIPS!');
none('SL trail to price', 'SL 401 PE RAKHNA!');
none('running pips', '60+ PIPS RUNNING DO BE!');
none('be tapped', 'BE TAPPED!!!! I AM DONE W GOLD ATP');
none('sl hit done', 'SL HIT DONE FOR THE DAY!');
none('sl still not tapped', 'SL STILL NOT TAPPED!');
none('fall coming', 'FALL COMING!');
none('low volume', 'LOW VOLUME!');
none('daily report', 'SHARKS DAILY REPORT MON - 17 AUG GOLD BUY => +430 PIPS');
none('react bait', 'IF THIS MSG GET 80 REACTS WE WILL MAKE 500+ PIPS TOMORROW!');
none('member question', 'KAHAN SE HE ENTRY?');
none('member avg entry q', 'AVERAGE ENTRY FROM 99! JUST HOLD AND IT WILL GIVE TP');
none('edited marker', 'Edited1:54 p.m.');
none('empty', '');

console.log('\nAll parser tests passed ✔');
