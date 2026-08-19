'use strict';

/**
 * Execution adapter — the one place that decides HOW a trade is placed.
 *   log       -> dry-run (print only). Use this first.
 *   puppeteer -> headless browser against Exness MT5 WebTerminal.
 *
 * The mode comes from runtime-mode.js: a /mode WhatsApp command can flip it
 * instantly (persisted to .runtime/state/mode.json), falling back to the
 * EXECUTION_MODE env var. This lets you keep log mode for daily validation
 * and switch to real trading on demand WITHOUT restarting Render (a restart
 * would wipe the WhatsApp session).
 *
 * If you later find a proper API (e.g. Exness API or MetaApi free tier),
 * add another case here and nothing else in the bot changes.
 */
const { currentMode } = require('./runtime-mode');

async function execute(signal) {
  const mode = currentMode();
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
