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
 *    IMPORTANT: the terminal UI (charts + "Market Watch") renders BEHIND the
 *    login dialog, so "logged in" = login dialog NOT open AND terminal visible.
 *    Checking just for the terminal gave a false "already logged in" and the
 *    bot skipped the real login ("login dialog still open" error).
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

/**
 * True when the "Connect to an Account" login dialog is open.
 * CRITICAL: the terminal UI (charts, Market Watch) renders BEHIND this dialog,
 * so you cannot tell "logged in" just from canvases/Market Watch — you must
 * check that NO login dialog is open.
 */
async function isLoginDialogOpen(page) {
  return page.evaluate(() => {
    const hasPw = [...document.querySelectorAll('input')].some((i) =>
      i.offsetParent !== null && i.type === 'password');
    const hasOk = [...document.querySelectorAll('button')].some((b) =>
      b.offsetParent !== null && /^OK$/i.test((b.innerText || '').trim()));
    return hasPw && hasOk;
  });
}

async function waitForLoginDialog(page, timeout = 60000) {
  return waitFor(page, () => isLoginDialogOpen(page), timeout, 'login dialog');
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

/**
 * Memory guard for Render free (512 MB limit).
 * Node + Baileys already use ~140 MB; launching chrome-headless-shell + the
 * heavy trading-terminal page can push past 512 MB and trigger an OOM restart
 * (which also wipes the WhatsApp session). Refuse to launch when we're already
 * too close to the limit, and use every memory-saving flag we can.
 */
function memoryTooHigh() {
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const limit = Number(process.env.MAX_RSS_MB || 380);
  const tooHigh = rssMB > limit;
  if (tooHigh) console.warn(`[exness] MEMORY GUARD: rss=${rssMB}MB > ${limit}MB — skipping browser launch to avoid OOM`);
  return tooHigh;
}

/** Delete old screenshots (they accumulate on the ephemeral disk). */
function cleanupScreenshots(keep = 12) {
  try {
    const files = fs.readdirSync(SHOT_DIR).filter(f => f.endsWith('.png')).sort();
    while (files.length > keep) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(SHOT_DIR, oldest));
    }
  } catch (e) { /* ignore */ }
}

async function launchBrowser() {
  const puppeteer = require('puppeteer'); // lazy require
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--no-zygote',
    '--mute-audio',
    '--disable-blink-features=AutomationControlled', // hides automation from the app
    '--js-flags=--max-old-space-size=256', // cap V8 heap inside the browser
  ];
  // Optional: --single-process saves RAM but is less stable — opt in via env.
  if (process.env.PUPPETEER_SINGLE_PROCESS === '1') args.push('--single-process');
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

/**
 * If the "Switch to the MetaTrader 5 mode" confirmation modal is visible,
 * click its Switch button (this refreshes the page into MT5 mode).
 * Returns true if it clicked Switch.
 */
async function clickSwitchModalIfVisible(page) {
  return page.evaluate(() => {
    const m = [...document.querySelectorAll('.page-window.modal')]
      .find(x => !/hidden/.test(x.className || ''));
    if (!m) return false;
    const title = (m.querySelector('.h')?.innerText || '').trim();
    if (!/MetaTrader 5 mode/i.test(title)) return false;
    const btn = [...m.querySelectorAll('button')]
      .find(b => (b.innerText || '').trim() === 'Switch');
    if (btn) { btn.click(); return true; }
    return false;
  });
}

/** Wait (up to timeout) for the login dialog to reappear OR the terminal to be ready. */
async function waitAfterSwitch(page, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const dlg = await isLoginDialogOpen(page);
    if (dlg) { console.log('[exness] login dialog reappeared after MT5 switch'); return; }
    const term = await isTerminalVisible(page);
    if (term && !(await isLoginDialogOpen(page))) { console.log('[exness] terminal ready after MT5 switch'); return; }
    await sleep(1500);
  }
  throw new Error('page did not become ready after MT5 switch');
}

/** MT4 -> MT5 platform switch. MT5 accounts need the terminal in MT5 mode;
 *  the app shows a "Switch to the MetaTrader 5 mode" modal when it detects an
 *  MT5 server — clicking its Switch refreshes the page into MT5 mode. */
async function switchToMT5(page) {
  const isMT5 = await page.evaluate(() => {
    // MT5 mode shows a checked mt5-platform radio / label
    const r5 = document.querySelector('input[id*="mt5"][type="radio"]');
    if (r5 && r5.offsetParent !== null && r5.checked) return true;
    const lbl5 = [...document.querySelectorAll('label')]
      .find(l => l.offsetParent !== null && /MetaTrader\s*5/i.test(l.innerText || ''));
    return !!lbl5;
  });
  if (isMT5) { console.log('[exness] platform already MT5'); return; }

  // modal already visible?
  if (await clickSwitchModalIfVisible(page)) {
    console.log('[exness] clicked Switch (modal was open)');
    await waitAfterSwitch(page);
    return;
  }
  // try to find a visible "Switch to the MetaTrader 5 mode" trigger
  const opened = await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')]
      .filter(e => e.offsetParent !== null)
      .find(e => /switch to the metatrader 5 mode/i.test((e.innerText || '').trim()) && e.children.length === 0);
    if (el) { el.click(); return true; }
    return false;
  });
  if (opened) {
    console.log('[exness] found switch trigger, clicked it');
    await sleep(1500);
    if (await clickSwitchModalIfVisible(page)) {
      console.log('[exness] clicked Switch in confirmation modal');
      await waitAfterSwitch(page);
    }
  } else {
    console.log('[exness] no switch trigger found — the app will prompt when an MT5 server is entered');
  }
}

/**
 * Set the Server field in the GWT autocomplete (VERIFIED sequence):
 * 1. focus + type a seed to open the datalist
 * 2. click the exact option if it exists (this seeds the combo's model)
 * 3. select-all + backspace + type the FULL server name + Enter
 * (The plain clearAndType left a "MetaQuotes-Dem" prefix and kept OK disabled.)
 */
async function setServerField(page, server) {
  const sel = loadSelectors();
  const field = await page.$(sel.serverInput);
  if (!field) { console.warn('[exness] server input not found (selector: ' + sel.serverInput + ')'); return; }

  await field.click();
  await sleep(300);
  // seed: type something to open the datalist, then pick an exact option if present
  const seed = server.slice(0, 12);
  await page.keyboard.type(seed, { delay: 40 });
  await sleep(1800);
  const picked = await page.evaluate((srv) => {
    const el = [...document.querySelectorAll('.datalist .option')]
      .find(o => (o.innerText || '').trim() === srv);
    if (el) { el.click(); return true; }
    return false;
  }, server);
  if (picked) console.log('[exness] server option selected:', server);
  await sleep(500);

  // select-all + backspace + type full server + Enter (verified: clean value, OK enables)
  await page.evaluate(() => { const el = document.querySelector('#server'); if (el) { el.focus(); el.select(); } });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(server), { delay: 50 });
  await sleep(1500);
  await page.keyboard.press('Enter');
  await sleep(1500);
  const v = await page.evaluate(() => document.querySelector('#server')?.value);
  console.log('[exness] server field ->', JSON.stringify(v));
}

/** Wait for the OK button to become enabled (it starts disabled until valid input). */
async function waitForOkEnabled(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => b.offsetParent !== null && (b.innerText || '').trim() === 'OK');
      return btn ? !btn.disabled : false;
    });
    if (st) return true;
    await sleep(800);
  }
  return false;
}

/** Fill the login dialog (server / login / password) and click OK (waits for enable). */
async function performLogin(page, login, pass, server) {
  await setServerField(page, server);

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
  await sleep(800);

  // VERIFY what actually landed in the fields (password masked) — catches
  // cases where typing went to the wrong field or special chars got mangled.
  const fields = await page.evaluate(() => {
    const all = [...document.querySelectorAll('input')].filter((i) => i.offsetParent !== null);
    const pw = all.find((i) => i.type === 'password');
    const loginEl = all.find((i, idx) => idx === all.findIndex((x) => x.type === 'password') - 1 && i.type === 'text');
    return {
      loginVal: loginEl ? loginEl.value : '(not found)',
      pwLen: pw ? pw.value.length : 0,
      serverVal: document.querySelector('#server')?.value || '(not found)',
    };
  });
  console.log(`[exness] field check -> login="${fields.loginVal}" pwLen=${fields.pwLen} server="${fields.serverVal}"`);
  if (fields.loginVal !== String(login)) console.warn(`[exness] WARNING: login field value "${fields.loginVal}" != expected "${login}"`);
  if (fields.pwLen !== String(pass).length) console.warn(`[exness] WARNING: password length ${fields.pwLen} != expected ${String(pass).length} (special chars?)`);
  if (fields.serverVal !== server) console.warn(`[exness] WARNING: server field "${fields.serverVal}" != expected "${server}"`);

  // --- OK (wait until enabled, then click) ---
  const enabled = await waitForOkEnabled(page);
  console.log('[exness] OK enabled:', enabled);
  if (!enabled) {
    await screenshot(page, 'ok-disabled');
    throw new Error('OK button never enabled — check server name + credentials fields');
  }
  const okClicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button')]
      .find((b) => b.offsetParent !== null && (b.innerText || '').trim() === 'OK' && !b.disabled);
    if (el) { el.click(); return true; }
    return false;
  });
  console.log('[exness] OK clicked:', okClicked);
  if (!okClicked) throw new Error('OK button not found in login dialog');
}

async function loginFlow(page) {
  const url = process.env.WEBTERMINAL_URL || 'https://metatraderweb.app/trade';
  const login = process.env.EXNESS_LOGIN;
  const pass = process.env.EXNESS_PASSWORD;
  const server = process.env.EXNESS_SERVER || 'Exness-Trial16';
  if (!login || !pass) throw new Error('EXNESS_LOGIN / EXNESS_PASSWORD are not set');

  // Some users write "Exness-MT5Trial16" but the real server is "Exness-Trial16"
  // (the "MT5" prefix doesn't exist in the terminal's server list — verified).
  // Build a fallback chain: configured server, then the same name minus "MT5".
  const servers = [server];
  const alt = String(server).replace(/-?MT5/i, '-').replace(/^[-_]+/, '').replace(/-+$/, '');
  if (alt !== server && alt) servers.push(alt);
  console.log('[exness] server candidates:', servers.join(' | '));

  console.log('[exness] opening', url);
  // Track WebSocket attempts — tells us if the app is trying to reach the
  // trade server at all (and to which host).
  let wsAttempts = [];
  page.on('websocket', (ws) => {
    const u = ws.url() || '';
    wsAttempts.push(u);
    console.log('[exness] WS opened:', u.slice(0, 100));
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);

  // Already logged in? ONLY if no login dialog is open AND the terminal UI is
  // visible. The terminal UI renders behind the login dialog, so checking just
  // for the terminal is NOT enough (this caused "login dialog still open").
  const dialogOpen = await isLoginDialogOpen(page);
  if (!dialogOpen && (await isTerminalVisible(page))) {
    console.log('[exness] persisted session: already inside the terminal (no login dialog)');
    return;
  }

  console.log('[exness] waiting for the login dialog (can take 10-40s on first boot)...');
  await waitForLoginDialog(page, 90000);

  // Attempt login (with retry + server fallback) and VERIFY the dialog closed.
  // Handles the MT5 flow: fill -> OK -> app asks to switch to MT5 -> Switch ->
  // page reloads in MT5 mode -> fill again -> OK -> terminal.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const srv = servers[Math.min(attempt - 1, servers.length - 1)];
    console.log(`[exness] login attempt ${attempt}/4 (server ${srv})`);
    await performLogin(page, login, pass, srv);
    await sleep(4000);

    // If the app asks to switch to MT5 mode (MT5 server detected), do it and
    // wait for the reload; then loop again to re-login in MT5 mode.
    if (await clickSwitchModalIfVisible(page)) {
      console.log('[exness] MT5 switch requested after OK — refreshing into MT5 mode...');
      try { await waitAfterSwitch(page, 60000); } catch (e) { console.warn('[exness] wait after switch:', e.message); }
      await sleep(2000);
      continue; // next attempt logs in on the (now MT5) dialog
    }

    // DIAGNOSTIC: after OK, capture what the app is showing — visible modals,
    // any error/status text, journal tail, websocket count. This tells us WHY
    // the dialog stays open (auth failed? connection refused? 2FA? too slow?).
    // Watch up to ~12s (some trade-server connections are slow).
    const diagSnapshots = [];
    for (let s = 0; s < 4; s++) {
      await sleep(3000);
      const diag = await page.evaluate(() => {
        const txt = document.body ? document.body.innerText : '';
        const lines = txt.split('\n').map(x => x.trim()).filter(Boolean);
        return {
          visibleModals: [...document.querySelectorAll('.page-window.modal')]
            .filter(m => !/hidden/.test(m.className || ''))
            .map(m => (m.querySelector('.h')?.innerText || '').trim().slice(0, 60)),
          errorText: lines.filter(l => /fail|error|invalid|incorrect|wrong|denied|reject|offline|timeout|otp|verif|code|password|connect|auth/i.test(l)).slice(0, 8),
          journalTail: (() => {
            const i = txt.lastIndexOf('Journal');
            return i >= 0 ? txt.slice(i, i + 300).replace(/\n+/g, ' | ') : '';
          })(),
          hasCanvas: document.querySelectorAll('canvas').length > 0,
        };
      });
      diagSnapshots.push(diag);
      // stop early if dialog closed
      if (!(await isLoginDialogOpen(page))) break;
    }
    console.log('[exness] POST-OK DIAGNOSTIC:', JSON.stringify(diagSnapshots));
    console.log('[exness] WS attempts this run:', JSON.stringify(wsAttempts));
    wsAttempts = [];

    const stillOpen = await isLoginDialogOpen(page);
    const terminalOk = await isTerminalVisible(page);
    if (!stillOpen && terminalOk) {
      console.log('[exness] ✅ logged in, terminal ready');
      return;
    }

    if (stillOpen) {
      const authErr = await page.evaluate(() => {
        const t = document.body ? document.body.innerText : '';
        return /Authorization Failed|invalid login|incorrect|wrong password/i.test(t);
      });
      if (authErr) {
        await screenshot(page, 'auth-failed');
        throw new Error('Authorization Failed — check EXNESS_LOGIN/PASSWORD/SERVER. NOTE: "Exness-MT5Trial16" does NOT exist — use the exact server from your Personal Area (e.g. "Exness-Trial16").');
      }
      console.warn(`[exness] login attempt ${attempt} (server ${srv}) did not complete (dialog still open), retrying...`);
    } else {
      console.warn(`[exness] login attempt ${attempt}: dialog closed but terminal not detected, retrying...`);
    }
  }
  await screenshot(page, 'post-login-unknown');
  throw new Error('Login did not complete after 4 attempts (see screenshot runtime/screenshots). Verify EXNESS_SERVER is the EXACT server name from your Personal Area (e.g. "Exness-Trial16", not "Exness-MT5Trial16").');
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
  if (await isLoginDialogOpen(page)) throw new Error('login dialog still open — could not reach the terminal');

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
  cleanupScreenshots();

  // OOM guard that WAITS instead of failing: if memory is high (usually because
  // a previous browser is still releasing), poll until it frees (up to 2 min).
  // This keeps the bot fully automatic — it never silently skips a trade.
  const memoryWaitMs = Number(process.env.MEMORY_WAIT_MS || 120000);
  const memoryWaitStart = Date.now();
  while (memoryTooHigh()) {
    if (Date.now() - memoryWaitStart > memoryWaitMs) {
      throw new Error(`Memory guard: RSS stayed above ${process.env.MAX_RSS_MB || 380}MB for ${memoryWaitMs / 1000}s — skipping to avoid OOM. The signal is saved and will be auto-retried on the next restart/connect.`);
    }
    console.log(`[exness] memory still high (${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB), waiting 10s before retrying...`);
    await sleep(10000);
  }

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
  isLoginDialogOpen, isTerminalVisible, waitForLoginDialog, clickSwitchModalIfVisible,
  waitAfterSwitch, switchToMT5, performLogin, setServerField, waitForOkEnabled,
};
