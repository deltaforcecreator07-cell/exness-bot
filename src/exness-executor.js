'use strict';

/**
 * Headless-browser execution against the MetaTrader Web Terminal
 * (MetaQuotes' GWT app at https://metatraderweb.app/trade).
 *
 * ==== VERIFIED IN LIVE TESTING (this repo) ====
 * 1. The old trade.mql5.com URL redirects to metatraderweb.app and 404s with
 *    query params. The working entry is EXACTLY:  https://metatraderweb.app/trade
 *    (no ?servers=, no ?version= — those 404).
 * 2. The app is a Google-Web-Toolkit SPA. It blocks plain headless Chrome
 *    (serves 404 / stalls at "Loading..."). It DOES boot with:
 *      - desktop Windows Chrome user-agent
 *      - navigator.webdriver hidden
 *      - --disable-blink-features=AutomationControlled
 *    (see applyStealth + launchBrowser)
 * 3. Boot time is variable (10-40s) -> always poll for the login dialog.
 * 4. The login dialog ("Connect to an Account") contains:
 *      Login: text input     Password: password input     Save password: checkbox
 *      Server: GWT autocomplete (#server)                 Platform: MT4/MT5 toggle
 *      buttons: Demo | OK | Cancel
 *    GWT fields need REAL keyboard events (focus + type), not value-setter hacks.
 * 5. Do NOT click "Demo" when logging into an existing Exness demo account —
 *    that opens MetaQuotes' demo-account CREATOR. Use Login/Password/Server + OK.
 * 6. MT5 accounts need the platform toggle flipped to MT5 ("Switch to the
 *    MetaTrader 5 mode" / "Switch"). Attempted automatically; if it fails, your
 *    screenshot (runtime/screenshots) will show the dialog so you can adjust.
 *
 * Memory plan for Render free (512 MB): browser launches only per signal,
 * closes right after; persistent profile (.runtime/browser-profile) = login
 * once, later signals skip login; PUPPETEER_HEADLESS=shell uses the lighter
 * chrome-headless-shell.
 */

const fs = require('fs');
const path = require('path');

const RUNTIME = path.join(__dirname, '..', '.runtime');
const PROFILE_DIR = path.join(RUNTIME, 'browser-profile');
const SHOT_DIR = path.join(RUNTIME, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let busy = false;

const DEFAULT_SELECTORS = {
  // any of these present = the terminal (not the login dialog) is on screen
  terminalReady: ['canvas', 'iframe[src*="trade"]'],
  serverInput: '#server',
};

function loadSelectors() {
  try {
    const custom = JSON.parse(fs.readFileSync(path.join(__dirname, 'selectors.json'), 'utf8'));
    return { ...DEFAULT_SELECTORS, ...custom };
  } catch {
    return DEFAULT_SELECTORS;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace(/[:.]/g, '-');

/* ---------------- helpers ---------------- */

async function screenshot(page, name) {
  try {
    const p = path.join(SHOT_DIR, `${name}-${now()}.png`);
    await page.screenshot({ path: p });
    console.log('[exness] 📸 screenshot:', p);
  } catch (e) { console.warn('[exness] screenshot failed:', e.message); }
}

async function waitFor(page, fn, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(1200);
  }
  throw new Error(`waitFor: ${label || 'condition'} not met within ${timeout}ms`);
}

async function waitForLoginDialog(page, timeout = 60000) {
  return waitFor(
    page,
    () => page.evaluate(() =>
      [...document.querySelectorAll('input')].some((i) =>
        i.offsetParent !== null && i.type === 'password')),
    timeout,
    'login dialog (password field)',
  );
}

async function isTerminalVisible(page) {
  return page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : '';
    return !!document.querySelector('canvas') ||
      /Market Watch/i.test(bodyText) ||
      /\bFile\b.*\bView\b.*\bCharts\b/i.test(bodyText);
  });
}

/** Real mouse click on a visible element whose exact text matches (case-insensitive). */
async function clickVisibleText(page, wanted, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const handle = await page.evaluateHandle((w) => {
      const el = [...document.querySelectorAll('span, div, td, a, label, button')]
        .filter((e) => e.offsetParent !== null && e.childElementCount === 0)
        .find((e) => (e.innerText || '').trim().toLowerCase() === w.toLowerCase());
      return el || null;
    }, wanted);
    const el = handle.asElement();
    if (el) {
      await el.click({ delay: 40 }).catch(() => {});
      await sleep(800);
      return true;
    }
    await sleep(700);
  }
  throw new Error(`clickVisibleText: "${wanted}" not found in ${timeout}ms`);
}

/** Focus an input, select all its content, then type real keystrokes. */
async function clearAndType(page, elHandleOrSelector, text) {
  let el = elHandleOrSelector;
  if (typeof elHandleOrSelector === 'string') {
    el = await page.$(elHandleOrSelector);
  }
  if (!el) throw new Error('clearAndType: element not found');
  await el.click({ clickCount: 3 }).catch(() => {});
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(text), { delay: 60 });
  await sleep(400);
}

/* ---------------- browser lifecycle ---------------- */

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function launchBrowser() {
  const puppeteer = require('puppeteer'); // lazy require
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--no-zygote',
    '--disable-background-networking',
    '--mute-audio',
    '--disable-blink-features=AutomationControlled', // hides automation from the app
  ];
  // IMPORTANT (Render free = 512 MB disk): only chrome-headless-shell is
  // installed (see package.json postinstall). Full Chrome (~340 MB) does not
  // fit alongside node_modules, so we NEVER fall back to it.
  const base = { args, userDataDir: PROFILE_DIR, headless: 'shell' };
  return puppeteer.launch(base);
}

/** Anti-bot fingerprint cleanup — REQUIRED or the terminal stalls at "Loading...". */
async function applyStealth(page) {
  await page.setUserAgent(process.env.WEBTERMINAL_UA || DESKTOP_UA);
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
}

async function loginFlow(page) {
  const url = process.env.WEBTERMINAL_URL || 'https://metatraderweb.app/trade';
  const login = process.env.EXNESS_LOGIN;
  const pass = process.env.EXNESS_PASSWORD;
  const server = process.env.EXNESS_SERVER || 'Exness-MT5Demo';
  if (!login || !pass) throw new Error('EXNESS_LOGIN / EXNESS_PASSWORD are not set');

  console.log('[exness] opening', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);

  // Already logged in thanks to the persisted browser profile?
  if (await isTerminalVisible(page)) {
    console.log('[exness] persisted session: already inside the terminal');
    return;
  }

  console.log('[exness] waiting for the login dialog (can take 10-40s on first boot)...');
  await waitForLoginDialog(page, 90000);

  // --- MT4 -> MT5 platform toggle (needed for MT5 accounts) ---
  try {
    const flipped = await page.evaluate(() => {
      const t = [...document.querySelectorAll('td, span, div')]
        .filter((d) => d.offsetParent !== null && d.childElementCount === 0)
        .map((d) => (d.innerText || '').trim());
      const i = t.findIndex((x) => x === 'Platform:');
      return i >= 0 ? t[i + 1] : null;
    });
    if (/MetaTrader\s*4/i.test(flipped || '')) {
      console.log('[exness] dialog is in MT4 mode, switching to MT5...');
      await clickVisibleText(page, 'Switch to the MetaTrader 5 mode', 5000)
        .catch(async () => {
          const btn = await page.evaluateHandle(() =>
            [...document.querySelectorAll('button')]
              .find((b) => b.offsetParent !== null && (b.innerText || '').trim() === 'Switch') || null);
          const el = btn.asElement();
          if (el) await el.click({ delay: 40 });
          else throw new Error('no MT5 switch control found');
        });
      await sleep(3000);
      console.log('[exness] platform switch clicked');
    }
  } catch (e) {
    console.warn('[exness] could not verify/switch platform:', e.message);
  }

  // --- Server (GWT autocomplete) ---
  const sel = loadSelectors();
  const serverField = await page.$(sel.serverInput);
  if (serverField) {
    await clearAndType(page, serverField, server);
    await sleep(2500);
    // commit: click the exact suggestion if it appeared, else press Enter
    const picked = await page.evaluate((srv) => {
      const el = [...document.querySelectorAll('div, span, td, li')]
        .filter((d) => d.offsetParent !== null && d.childElementCount === 0)
        .find((d) => (d.innerText || '').trim() === srv);
      if (el) { el.click(); return true; }
      return false;
    }, server);
    if (!picked) await page.keyboard.press('Enter');
    await sleep(1500);
    console.log('[exness] server field set to', server);
  } else {
    console.warn('[exness] server input not found (selector: ' + sel.serverInput + ')');
  }

  // --- Login + Password (real keystrokes, GWT needs them) ---
  await page.evaluate(() => {
    const all = [...document.querySelectorAll('input')].filter((i) => i.offsetParent !== null);
    const pwIdx = all.findIndex((i) => i.type === 'password');
    const loginEl = all.find((i, idx) => idx === pwIdx - 1 && i.type === 'text');
    if (loginEl) loginEl.focus();
  });
  await page.keyboard.type(String(login), { delay: 50 });
  await page.evaluate(() => {
    const all = [...document.querySelectorAll('input')].filter((i) => i.offsetParent !== null);
    const pw = all.find((i) => i.type === 'password');
    if (pw) pw.focus();
  });
  await page.keyboard.type(String(pass), { delay: 50 });
  await sleep(500);

  // --- OK ---
  const okClicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button')]
      .find((b) => b.offsetParent !== null && (b.innerText || '').trim() === 'OK');
    if (el) { el.click(); return true; }
    return false;
  });
  console.log('[exness] OK clicked:', okClicked);
  if (!okClicked) throw new Error('OK button not found in login dialog');

  // --- wait for terminal or auth error ---
  await sleep(6000);
  const terminalVisible = await isTerminalVisible(page);
  if (terminalVisible) {
    console.log('[exness] ✅ logged in, terminal ready');
    return;
  }
  const authError = await page.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    return /Authorization Failed|invalid login|incorrect/i.test(t);
  });
  if (authError) {
    await screenshot(page, 'auth-failed');
    throw new Error('Authorization Failed — check EXNESS_LOGIN/PASSWORD/SERVER');
  }
  await screenshot(page, 'post-login-unknown');
  throw new Error('Login did not complete (see screenshot runtime/screenshots)');
}

async function loginPage() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setDefaultTimeout(30000);
  await applyStealth(page);
  await loginFlow(page);
  return { browser, page };
}

/* ---------------- order placement ---------------- */

/** Find a GWT form field by its label text (label cell + adjacent input). */
async function fieldForLabel(page, label) {
  return page.evaluateHandle((needle) => {
    const cells = [...document.querySelectorAll('td, div, span')]
      .filter((c) => c.offsetParent !== null && c.childElementCount === 0);
    const cell = cells.find((c) => {
      const t = (c.innerText || '').trim().toLowerCase();
      return t === needle.toLowerCase() || t.startsWith(needle.toLowerCase() + ':');
    });
    if (!cell) return null;
    // input in the same row (td) or the next sibling container
    const row = cell.closest('tr') || cell.parentElement;
    const scope = row || document;
    const input = scope.querySelector('input, textarea');
    return input || null;
  }, label);
}

/**
 * Open the order ticket for a symbol the way a human would:
 * 1) double-click the symbol row in Market Watch (authentic GWT behavior)
 * 2) fallback: F9 (New Order shortcut)
 * 3) fallback: a "New Order" button/link
 */
async function openOrderTicket(page, pair) {
  const dbl = await page.evaluate((sym) => {
    const el = [...document.querySelectorAll('td, span, div, tr')]
      .filter((e) => e.offsetParent !== null && e.childElementCount === 0)
      .find((e) => (e.innerText || '').trim().toUpperCase() === sym.toUpperCase());
    if (el) {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      return true;
    }
    return false;
  }, pair);
  if (dbl) { await sleep(2500); return; }

  await page.keyboard.press('F9').catch(() => {});
  await sleep(2500);
  await clickVisibleText(page, 'New Order', 3000).catch(async () => {
    // toolbar icon buttons often carry a title attribute instead of text
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('button, [role="button"], div, span')]
        .find((b) => b.offsetParent !== null && /New Order/i.test(b.title || ''));
      if (el) el.click();
    });
  });
  await sleep(2000);
}

async function placeOrder(page, sig) {
  const { action, pair, lot, sl, tp } = sig;

  // 0) sanity: if the login dialog is somehow still open, stop
  const dialogOpen = await page.evaluate(() =>
    [...document.querySelectorAll('input')].some((i) => i.offsetParent !== null && i.type === 'password') &&
    [...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && (b.innerText || '').trim() === 'OK'));
  if (dialogOpen) throw new Error('login dialog still open — could not reach the terminal');

  // 1) open the order ticket (dblclick symbol in Market Watch, else F9, else New Order button)
  await openOrderTicket(page, pair);
  await screenshot(page, 'order-ticket');

  // 2) symbol: if there is a symbol search box, use it as extra safety
  const searchBox = await page.$('input[placeholder*="ymbol"], input[placeholder*="earch"]');
  if (searchBox) {
    await clearAndType(page, searchBox, pair);
    await page.keyboard.press('Enter');
    await sleep(2000);
    console.log('[exness] symbol set to', pair);
  }

  // 3) volume / SL / TP by label
  const volumeField = await fieldForLabel(page, 'Volume');
  if (volumeField.asElement()) {
    await clearAndType(page, volumeField.asElement(), String(lot));
  } else {
    console.warn('[exness] Volume field not found (run dump-dom to update)');
  }
  if (sl != null) {
    const slField = await fieldForLabel(page, 'Stop Loss');
    if (slField.asElement()) await clearAndType(page, slField.asElement(), String(sl));
    else console.warn('[exness] Stop Loss field not found');
  }
  if (tp != null) {
    const tpField = await fieldForLabel(page, 'Take Profit');
    if (tpField.asElement()) await clearAndType(page, tpField.asElement(), String(tp));
    else console.warn('[exness] Take Profit field not found');
  }
  await sleep(1000);

  // 4) Buy / Sell
  const labels = action === 'BUY' ? ['Buy', 'Buy by Market'] : ['Sell', 'Sell by Market'];
  console.log(`[exness] clicking ${labels[0]}...`);
  await clickVisibleText(page, labels);
  await sleep(4000);

  // 5) confirmation
  const confirmed = await page.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    return /order (placed|executed|accepted|done)|position opened/i.test(t);
  });
  await screenshot(page, 'after-order');
  console.log('[exness] order submitted, confirmed=' + confirmed);
  return { action, pair, lot, sl, tp, confirmed };
}

/* ---------------- public API ---------------- */

async function executeTrade(signal, timeoutMs = 180000) {
  if (busy) throw new Error('another execution is already in progress');
  busy = true;

  const run = (async () => {
    let browser, page;
    try {
      console.log('[exness] launching headless browser (signal received)');
      ({ browser, page } = await loginPage());
      const result = await placeOrder(page, signal);
      return result;
    } catch (e) {
      if (page) await screenshot(page, 'error').catch(() => {});
      console.error('[exness] execution FAILED:', e.message);
      throw e;
    } finally {
      try { if (browser) await browser.close(); } catch {}
      busy = false;
      console.log('[exness] browser closed (memory released)');
    }
  })();

  // hard cap so a hung GWT app can never lock the bot forever
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('execution timed out after ' + timeoutMs + 'ms')), timeoutMs));
  try {
    return await Promise.race([run, timer]);
  } catch (e) {
    busy = false;
    throw e;
  }
}

module.exports = {
  executeTrade, loginPage, launchBrowser, applyStealth, DEFAULT_SELECTORS, loadSelectors,
  clickVisibleText, clearAndType, fieldForLabel, screenshot, sleep,
};
