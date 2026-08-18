'use strict';

/**
 * Entry point.
 * 1. start the tiny HTTP server (answers cron-job.org pings so Render free
 *    tier never spins down)
 * 2. start the WhatsApp session
 */
require('dotenv').config();

const { startKeepAliveServer } = require('./keepalive');
const { startWhatsApp, stopWhatsApp } = require('./whatsapp');

startKeepAliveServer();

// Boot-time browser check — actually LAUNCHES the headless browser so we know
// for sure trades can execute, instead of guessing from cache paths.
async function checkBrowser() {
  console.log(`[boot] PUPPETEER_CACHE_DIR=${process.env.PUPPETEER_CACHE_DIR || '(not set — default cache may not persist on Render!)'}`);
  try {
    const { launchBrowser } = require('./exness-executor');
    const browser = await launchBrowser();
    await browser.close();
    console.log('[boot] browser check: FOUND ✔ (chrome-headless-shell launches OK)');
  } catch (e) {
    console.error('[boot] browser check: MISSING ✘ — ' + e.message.split('\n')[0]);
    console.warn('[boot] trades will fail with "Could not find Chrome". Fix: set PUPPETEER_CACHE_DIR=/opt/render/project/src/.cache/puppeteer and redeploy (postinstall installs chrome-headless-shell).');
  }
}
checkBrowser();

startWhatsApp().then(() => {
  console.log('[boot] exness-signal-bot started.');
  console.log('[boot] If this is the first run, a QR code appears in the logs — scan it in WhatsApp.');
}).catch((e) => {
  console.error('[boot] failed to start WhatsApp:', e);
});

const t0 = Date.now();
setInterval(() => {
  const mb = fmtMB(process.memoryUsage().rss);
  console.log(`[stats] up ${Math.round((Date.now() - t0) / 60000)}m  rss=${mb}MB  (limit 512MB)`);
  if (mb > 450) console.warn('[stats] WARNING: near the 512MB limit — expect an OOM restart');
}, 10 * 60 * 1000);

function fmtMB(b) { return Math.round(b / 1024 / 1024); }

async function shutdown(signal) {
  console.log(`[boot] ${signal} received, shutting down cleanly...`);
  await stopWhatsApp().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
