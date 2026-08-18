'use strict';

/**
 * Execution adapter — the one place that decides HOW a trade is placed.
 *   EXECUTION_MODE=log       -> dry-run (print only). Use this first.
 *   EXECUTION_MODE=puppeteer -> headless browser against Exness MT5 WebTerminal.
 *
 * If you later find a proper API (e.g. Exness API or MetaApi free tier),
 * add another case here and nothing else in the bot changes.
 */
async function execute(signal) {
  const mode = process.env.EXECUTION_MODE || 'puppeteer';
  switch (mode) {
    case 'log':
      console.log('[executor:log] DRY-RUN would trade:', JSON.stringify(signal));
      return { ok: true, mode: 'log' };

    case 'puppeteer': {
      const { executeTrade } = require('./exness-executor');
      const result = await executeTrade(signal);
      return { ok: true, mode: 'puppeteer', ...result };
    }

    default:
      throw new Error('Unknown EXECUTION_MODE: ' + mode);
  }
}

module.exports = { execute };
