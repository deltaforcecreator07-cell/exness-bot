'use strict';
const assert = require('assert');
const { isJidNewsletter } = require('@whiskeysockets/baileys');
const { channelConfig } = require('../src/whatsapp');

// channel jid detection
assert.strictEqual(isJidNewsletter('0029VarqpJRCXC3E4nNcRv05@newsletter'), true);
assert.strictEqual(isJidNewsletter('120363012345678901@g.us'), false);
assert.strictEqual(isJidNewsletter('923001234567@s.whatsapp.net'), false);
console.log('ok  ', 'isJidNewsletter detection');

// channel config parsing (bare id -> @newsletter jid)
const prev = process.env.ALLOWED_CHANNELS;
process.env.ALLOWED_CHANNELS = '0029VarqpJRCXC3E4nNcRv05,120363012345678901@newsletter';
process.env.ALLOWED_CHANNEL_NAMES = 'THE SHARKS, Gold Alerts';
const cfg = channelConfig();
assert.deepStrictEqual(cfg.jids, [
  '0029VarqpJRCXC3E4nNcRv05@newsletter',
  '120363012345678901@newsletter',
]);
assert.deepStrictEqual(cfg.names, ['the sharks', 'gold alerts']);
console.log('ok  ', 'channelConfig jid+name parsing');
process.env.ALLOWED_CHANNELS = prev || '';

console.log('\nAll config tests passed ✔');
