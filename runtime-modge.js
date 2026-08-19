'use strict';

/**
 * Runtime execution mode (log | puppeteer) that can be switched from WhatsApp
 * WITHOUT a Render restart (env changes restart the service + wipe the
 * WhatsApp session, which is why /mode exists).
 *
 * Priority: persisted file (.runtime/state/mode.json) > EXECUTION_MODE env.
 * The persisted value survives until changed; the env remains the default.
 */
const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', '.runtime', 'state');
const MODE_FILE = path.join(STATE_DIR, 'mode.json');

const VALID = ['log', 'puppeteer'];

function currentMode() {
  try {
    const d = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    if (d && VALID.includes(d.mode)) return d.mode;
  } catch (e) { /* no file yet */ }
  const env = process.env.EXECUTION_MODE;
  return VALID.includes(env) ? env : 'puppeteer';
}

function setMode(mode) {
  const m = String(mode || '').toLowerCase().trim();
  if (!VALID.includes(m)) return { ok: false, message: `Invalid mode "${mode}". Use: log or puppeteer` };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: m, at: Date.now() }));
  return { ok: true, message: `Mode set to ${m}` };
}

module.exports = { currentMode, setMode, VALID };
