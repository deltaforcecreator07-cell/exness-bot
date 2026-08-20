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

/** Real mouse click on a visible element whose text matches one of the wanted labels (case-insensitive). */
/**
 * Click the Buy/Sell button INSIDE the order ticket modal (real mouse).
 * Scoped to the modal so we never hit the chart's "BUY/SELL" price labels
 * (which appear earlier in the DOM and silently swallow clicks).
 */
async function clickTicketButton(page, action) {
  const label = action === 'BUY' ? 'buy' : 'sell';
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const box = await page.evaluate((lbl) => {
      const vis = (el) => el.offsetParent !== null;
      // the order ticket modal is the visible modal that has a #volume input
      const modal = [...document.querySelectorAll('.page-window.modal')]
        .find(m => !/hidden/.test(m.className || '') && m.querySelector('input#volume'));
      const scope = modal || document;
      // only real buttons / input-buttons inside the ticket
      const el = [...scope.querySelectorAll('button, .input-button, [role="button"]')]
        .filter(vis)
        .find(b => {
          const t = (b.innerText || '').trim().toLowerCase();
          return t === lbl || t.startsWith(lbl + ' ') || t.startsWith(lbl + ':');
        });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.innerText || '').trim().slice(0, 24) };
    }, label);
    if (box) {
      console.log(`[exness] clicking ticket ${label.toUpperCase()} button: "${box.text}"`);
      await page.mouse.click(box.x, box.y);
      await sleep(1000);
      return true;
    }
    await sleep(700);
  }
  throw new Error(`ticket ${label.toUpperCase()} button not found in the order dialog`);
}

/** Real mouse click on a visible element whose text matches one of the wanted labels (case-insensitive).
 *  Uses page.mouse at real coordinates — GWT ignores synthetic el.click() events. */
async function clickVisibleText(page, wanted, timeout = 8000) {
  const wantedArr = (Array.isArray(wanted) ? wanted : [wanted]).map(String);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const box = await page.evaluate((list) => {
      const el = [...document.querySelectorAll('span, div, td, a, label, button')]
        .filter((e) => e.offsetParent !== null && e.childElementCount === 0)
        .find((e) => {
          const txt = (e.innerText || '').trim().toLowerCase();
          return list.some((w) => txt === w.toLowerCase() || txt.startsWith(w.toLowerCase() + ' '));
        });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, wantedArr);
    if (box) {
      await page.mouse.click(box.x, box.y);
      await sleep(800);
      return true;
    }
    await sleep(700);
  }
  throw new Error(`clickVisibleText: "${wantedArr.join(' | ')}" not found in ${timeout}ms`);
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

/** Find a GWT form field by its label text (label cell + adjacent input).
 *  Tolerant: matches "Volume:", "Volume (lots):", "Stop Loss", etc. */
async function fieldForLabel(page, label) {
  return page.evaluateHandle((needle) => {
    const n = needle.toLowerCase();
    const cells = [...document.querySelectorAll('td, div, span, label')]
      .filter((c) => c.offsetParent !== null && c.childElementCount === 0);
    const cell = cells.find((c) => {
      const t = (c.innerText || '').trim().toLowerCase();
      return t === n || t.startsWith(n + ':') || t.startsWith(n + ' (') || t === n + ':';
    });
    if (!cell) return null;
    // input in the same row (td) or the next sibling container
    const row = cell.closest('tr') || cell.parentElement;
    const scope = row || document;
    const input = scope.querySelector('input, textarea');
    return input || null;
  }, label);
}

/** Is the order ticket open? Look for its fields (volume/sl/tp) anywhere, not
 *  just in the first visible modal (the symbol dropdown is also a modal). */
async function isOrderTicketOpen(page) {
  return page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const ids = [...document.querySelectorAll('input')].filter(vis).map(i => (i.id || '').toLowerCase());
    if (ids.includes('volume') && (ids.includes('sl') || ids.includes('tp'))) return true;
    const m = [...document.querySelectorAll('.page-window.modal')].find(x => !/hidden/.test(x.className || ''));
    if (!m) return false;
    const t = (m.innerText || '');
    return /Volume|Stop Loss|Take Profit/i.test(t);
  });
}

/**
 * Open the order ticket for a symbol. GWT needs REAL mouse events, so we use
 * page.mouse (coordinate clicks), not synthetic dispatchEvent.
 *  1) click the chart to focus the terminal, then F9
 *  2) Market Watch search: click the search box, type the symbol, double-click
 *     the filtered row (opens the ticket for that symbol)
 *  3) toolbar "New Order" button
 *  4) right-click a Market Watch row -> "New Order" context menu
 * If all fail, dumps the terminal UI so we can adapt.
 */
async function openOrderTicket(page, pair) {
  const tryWaitTicket = async (how) => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (await isOrderTicketOpen(page)) { console.log(`[exness] order ticket opened (${how})`); return true; }
      await sleep(1000);
    }
    return false;
  };

  // focus the terminal by clicking the chart area
  try {
    const cb = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (cb) await page.mouse.click(cb.x, cb.y);
  } catch {}
  await sleep(600);

  // 1) F9
  await page.keyboard.press('F9').catch(() => {});
  if (await tryWaitTicket('F9')) return;

  // 2) Market Watch search + double-click symbol (real mouse)
  const searchBox = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null);
    return inputs.find(i => /search|symbol/i.test((i.placeholder || '') + (i.name || '') + (i.id || ''))) || null;
  });
  if (searchBox) {
    const sb = await searchBox.boundingBox();
    if (sb) {
      await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2);
      await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
      await page.keyboard.type(pair, { delay: 60 });
      await sleep(1800);
      const rowBox = await page.evaluate((sym) => {
        const el = [...document.querySelectorAll('td, span, div, tr')]
          .filter(e => e.offsetParent !== null && e.childElementCount === 0)
          .find(e => (e.innerText || '').trim().toUpperCase() === sym.toUpperCase());
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, pair);
      if (rowBox) {
        await page.mouse.click(rowBox.x, rowBox.y, { clickCount: 2 });
        if (await tryWaitTicket('market watch dblclick')) return;
      }
    }
  }

  // 3) toolbar "New Order" button (title/aria-label/class)
  const btnBox = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, [role="button"], a, div, span')]
      .find(b => b.offsetParent !== null && /New Order/i.test((b.title || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.className || '')));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (btnBox) {
    await page.mouse.click(btnBox.x, btnBox.y);
    if (await tryWaitTicket('toolbar button')) return;
  }

  // 4) right-click a Market Watch row -> New Order
  const anyRowBox = await page.evaluate(() => {
    const el = [...document.querySelectorAll('td, span, div, tr')]
      .filter(e => e.offsetParent !== null && e.childElementCount === 0)
      .find(e => /^[A-Z]{3,6}$/.test((e.innerText || '').trim()));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (anyRowBox) {
    await page.mouse.click(anyRowBox.x, anyRowBox.y, { button: 'right' });
    await sleep(1200);
    const ctxBox = await page.evaluate(() => {
      const el = [...document.querySelectorAll('div, span, td, li, button')]
        .filter(e => e.offsetParent !== null && e.childElementCount === 0)
        .find(e => /^New Order/i.test((e.innerText || '').trim()));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (ctxBox) {
      await page.mouse.click(ctxBox.x, ctxBox.y);
      if (await tryWaitTicket('context menu')) return;
    }
  }

  // diagnostic dump so we can adapt next iteration
  const dump = await page.evaluate(() => ({
    toolbar: [...document.querySelectorAll('button, [role="button"], [title]')]
      .filter(b => b.offsetParent !== null)
      .map(b => ({ t: (b.innerText || b.title || b.getAttribute('aria-label') || '').trim().slice(0, 40), ti: (b.title || '').slice(0, 40), c: (b.className || '').toString().slice(0, 30) }))
      .filter(x => x.t || x.ti)
      .slice(0, 30),
    menus: [...document.querySelectorAll('.page-menu .item .label')].map(l => (l.innerText || '').trim()).filter(Boolean).slice(0, 25),
    hasMarketWatch: /Market Watch/i.test(document.body ? document.body.innerText : ''),
    inputs: [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null).map(i => ({ ph: i.placeholder, id: i.id, cls: (i.className || '').toString().slice(0, 20) })),
  }));
  console.log('[exness] terminal dump (no ticket):', JSON.stringify(dump));
  await screenshot(page, 'no-order-ticket');
  throw new Error('Could not open the order ticket (F9 / market watch / toolbar / context all failed). See screenshot + terminal dump.');
}

async function placeOrder(page, sig) {
  const { action, pair, lot, sl, tp } = sig;

  // 0) sanity: if the login dialog is somehow still open, stop
  if (await isLoginDialogOpen(page)) throw new Error('login dialog still open — could not reach the terminal');

  // 1) open the order ticket
  await openOrderTicket(page, pair);
  await screenshot(page, 'order-ticket');

  // 2) set the SYMBOL. The ticket's symbol combo is the input right BEFORE the
  //    volume field (the combos have no id/name in this terminal). Set its
  //    value, then CLICK the matching dropdown option to commit.
  const symbolSet = await page.evaluate((sym) => {
    const vis = (el) => el.offsetParent !== null;
    const modal = [...document.querySelectorAll('.page-window.modal')].find(x => !/hidden/.test(x.className || ''));
    const scope = modal || document;
    const inputs = [...scope.querySelectorAll('input')].filter(vis);
    const volIdx = inputs.findIndex(i => (i.id || '').toLowerCase() === 'volume');
    const symInput = volIdx > 0 ? inputs[volIdx - 1] : (inputs[0] || null);
    if (!symInput) return false;
    const proto = window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(symInput, sym);
    symInput.dispatchEvent(new Event('input', { bubbles: true }));
    symInput.dispatchEvent(new Event('change', { bubbles: true }));
    symInput.focus();
    return true;
  }, pair);
  if (symbolSet) {
    await sleep(800);
    // commit by clicking the exact option (real mouse) or pressing Enter
    const optBox = await page.evaluate((sym) => {
      const el = [...document.querySelectorAll('.option, .datalist .option, td, div, span')]
        .filter(e => e.offsetParent !== null && e.childElementCount === 0)
        .find(e => {
          const t = (e.innerText || '').trim().toUpperCase();
          return t === sym.toUpperCase() || t.startsWith(sym.toUpperCase() + ',');
        });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, pair);
    if (optBox) {
      await page.mouse.click(optBox.x, optBox.y);
      console.log('[exness] symbol option clicked:', pair);
    } else {
      await page.keyboard.press('Enter');
      console.log('[exness] no option found, pressed Enter');
    }
    await sleep(1500);
    // verify the symbol actually changed
    const val = await page.evaluate(() => {
      const vis = (el) => el.offsetParent !== null;
      const modal = [...document.querySelectorAll('.page-window.modal')].find(x => !/hidden/.test(x.className || ''));
      const scope = modal || document;
      const inputs = [...scope.querySelectorAll('input')].filter(vis);
      const vi = inputs.findIndex(i => (i.id || '').toLowerCase() === 'volume');
      const si = vi > 0 ? vi - 1 : 0;
      return inputs[si] ? inputs[si].value : '?';
    });
    console.log(`[exness] symbol value after set: "${val}" (expected ${pair})`);
    if (val.toUpperCase() !== pair.toUpperCase()) console.warn('[exness] WARNING: symbol may not be set — ticket may still show the chart default!');
  } else {
    console.warn('[exness] no symbol field in ticket — will use the ticket default (check screenshot)');
  }

  // 3) volume / SL / TP by label (tolerant matching)
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

  // 4) verify the ticket is submittable BEFORE clicking — scoped to the modal,
  //    and check the VALUES actually landed in volume/sl/tp (not just present).
  const ticketOk = await page.evaluate((act, exp) => {
    const vis = (el) => el.offsetParent !== null;
    const modal = [...document.querySelectorAll('.page-window.modal')]
      .find(m => !/hidden/.test(m.className || '') && m.querySelector('input#volume'));
    const scope = modal || document;
    const btn = [...scope.querySelectorAll('button, .input-button, [role="button"]')]
      .filter(vis)
      .find(b => {
        const t = (b.innerText || '').trim();
        return t && new RegExp('^' + act + '(:| |$)', 'i').test(t);
      });
    const val = (id) => {
      const el = scope.querySelector('input#' + id);
      return el ? el.value : null;
    };
    return {
      ok: !!btn && !btn.disabled,
      btnFound: !!btn,
      btnText: btn ? (btn.innerText || '').trim().slice(0, 30) : null,
      btnDisabled: btn ? btn.disabled : null,
      modalFound: !!modal,
      volume: val('volume'),
      sl: val('sl'),
      tp: val('tp'),
      symbolInput: (() => {
        const inputs = [...scope.querySelectorAll('input')].filter(vis);
        const vi = inputs.findIndex(i => (i.id || '').toLowerCase() === 'volume');
        const si = vi > 0 ? vi - 1 : -1;
        return si >= 0 ? inputs[si].value : null;
      })(),
    };
  }, action, { v: String(lot), s: String(sl ?? ''), t: String(tp ?? '') });
  console.log('[exness] ticket check before click:', JSON.stringify(ticketOk));
  if (!ticketOk.ok || !ticketOk.modalFound || ticketOk.volume !== String(lot)) {
    console.warn(`[exness] ticket not ready: btn=${ticketOk.btnFound} modal=${ticketOk.modalFound} volume="${ticketOk.volume}" (want "${lot}") sl="${ticketOk.sl}" tp="${ticketOk.tp}" symbol="${ticketOk.symbolInput}"`);
    await screenshot(page, 'ticket-not-submittable');
    throw new Error(`Order ticket not submittable (btn=${ticketOk.btnFound} modal=${ticketOk.modalFound} volume=${ticketOk.volume}). See screenshot.`);
  }

  // 5) Buy / Sell — scoped to the ticket modal (real mouse; avoids chart labels)
  console.log(`[exness] clicking ${action} (ticket-scoped)...`);
  await clickTicketButton(page, action);

  // 6) handle any CONFIRMATION dialog: MT4 web shows "Buy 0.25 XAUUSD ... OK"
  //    after clicking Buy/Sell. If present, click OK / Yes (real mouse).
  const confirmHandled = await page.evaluate((act) => {
    const vis = (el) => el.offsetParent !== null;
    const m = [...document.querySelectorAll('.page-window.modal')].find(x => !/hidden/.test(x.className || ''));
    if (!m) return false;
    const txt = (m.innerText || '');
    // a confirmation dialog mentions the order details + has OK / Yes
    const hasOk = [...m.querySelectorAll('button')].some(b => vis(b) && /^(OK|Yes|Accept)$/i.test((b.innerText || '').trim()));
    if (hasOk && /(buy|sell|order|volume|market)/i.test(txt)) {
      return true; // signal to click OK below
    }
    return false;
  }, action);
  if (confirmHandled) {
    const okBox = await page.evaluate(() => {
      const vis = (el) => el.offsetParent !== null;
      const m = [...document.querySelectorAll('.page-window.modal')].find(x => !/hidden/.test(x.className || ''));
      if (!m) return null;
      const btn = [...m.querySelectorAll('button')].find(b => vis(b) && /^(OK|Yes|Accept)$/i.test((b.innerText || '').trim()));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (okBox) {
      console.log('[exness] confirmation dialog found, clicking OK...');
      await page.mouse.click(okBox.x, okBox.y);
      await sleep(1500);
    }
  } else {
    console.log('[exness] no confirmation dialog detected after Buy/Sell click');
  }

  // 6) REAL confirmation: poll the Trade tab / journal for up to ~20s
  let confirmed = false;
  let evidence = '';
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const st = await page.evaluate((sym) => {
      const t = document.body ? document.body.innerText : '';
      if (/done!|request accepted|order (executed|placed|accepted|done)|position opened|deal done/i.test(t)) {
        return { journal: true };
      }
      // Trade tab rows: pair + ticket number + volume
      const rows = [...document.querySelectorAll('tr, .row, [class*="row" i]')].filter(r => r.offsetParent !== null);
      for (const r of rows) {
        const txt = (r.innerText || '');
        if (txt.includes(sym) && /\d{4,}/.test(txt) && /(buy|sell)/i.test(txt)) {
          return { row: txt.replace(/\s+/g, ' ').slice(0, 140) };
        }
      }
      return null;
    }, pair);
    if (st) { confirmed = true; evidence = JSON.stringify(st); break; }
  }
  await screenshot(page, 'after-order');
  console.log(`[exness] order submitted, confirmed=${confirmed} evidence=${evidence}`);
  return { action, pair, lot, sl, tp, confirmed, evidence };
}

/**
 * REAL-TIME verification: open the terminal, check the Trade tab, and return
 * the ACTUAL open positions (ticket, symbol, side, volume, prices). This is
 * ground truth — it reads the terminal, not our local tracking.
 */
async function verifyPositionsLive() {
  let browser, page;
  try {
    ({ browser, page } = await loginPage());
    // open the Trade tab: it's a bottom toolbar tab, often in a tab bar.
    // Click any small visible element whose text is exactly "Trade".
    const clicked = await page.evaluate(() => {
      const vis = (el) => el.offsetParent !== null;
      const candidates = [...document.querySelectorAll('div, span, td, button, a')]
        .filter(e => vis(e) && e.childElementCount === 0)
        .filter(e => (e.innerText || '').trim() === 'Trade')
        .map(e => e.getBoundingClientRect())
        .filter(r => r.width > 0 && r.width < 120 && r.height > 0 && r.height < 40);
      if (!candidates.length) return false;
      const r = candidates[0];
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (clicked) {
      await page.mouse.click(clicked.x, clicked.y);
      await sleep(1800);
    }
    const positions = await page.evaluate(() => {
      const vis = (el) => el.offsetParent !== null;
      const out = [];
      // 1) table rows with ticket-like numbers + buy/sell + symbol + price
      const rows = [...document.querySelectorAll('tr, .row, [class*="row" i]')].filter(vis);
      for (const r of rows) {
        const txt = (r.innerText || '').trim().replace(/\s+/g, ' ');
        if (/\d{4,}/.test(txt) && /(buy|sell)/i.test(txt) && /[A-Z]{2,6}/.test(txt) && /\d+\.\d+/.test(txt)) {
          out.push(txt.slice(0, 160));
        }
      }
      if (!out.length) {
        // 2) fallback: any visible line containing a pair + buy/sell + number
        const lines = (document.body ? document.body.innerText : '').split('\n').map(s => s.trim()).filter(Boolean);
        for (const l of lines) {
          if (/(buy|sell)/i.test(l) && /[A-Z]{2,6}/.test(l) && /\d{4,}/.test(l)) out.push(l.replace(/\s+/g, ' ').slice(0, 160));
        }
      }
      // dedupe
      return [...new Set(out)].slice(0, 12);
    });
    if (!positions.length) {
      return { ok: true, message: 'ℹ️ No open positions found in the terminal (Trade tab is empty — nothing placed, or trade tab not visible).' };
    }
    return { ok: true, message: '📋 LIVE positions in the terminal:\n' + positions.map((p, i) => `${i + 1}. ${p}`).join('\n') };
  } catch (e) {
    return { ok: false, message: `❌ Could not verify: ${e.message}` };
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
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
  executeTrade, loginPage, launchBrowser, applyStealth, DEFAULT_SELECTORS, loadSelectors, verifyPositionsLive,
  clickVisibleText, clearAndType, fieldForLabel, screenshot, sleep,
  isLoginDialogOpen, isTerminalVisible, waitForLoginDialog, clickSwitchModalIfVisible,
  waitAfterSwitch, switchToMT5, performLogin, setServerField, waitForOkEnabled,
};
