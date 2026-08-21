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
/**
 * ==== ADDITIONAL FINDINGS (2026-08-20, from a verified screen recording of ====
 * ==== the real account placing a live Gold trade) ====
 * 7. The floating "Order" ticket (Symbol / Volume / Stop Loss / Take Profit /
 *    Comment / Type / "Sell by Market" | "Buy by Market") is opened by the
 *    2ND TOOLBAR ICON (top-left, "New Order" — a white page + green plus,
 *    right next to the "New Chart" icon) or by the F9 hotkey. It is NOT
 *    reached by first clicking "Create a new chart" and hunting for an
 *    inline per-chart "Forex" dropdown — that earlier assumption was wrong
 *    and is why symbol selection kept failing ("symbol row not found").
 * 8. The ticket's "Symbol:" field is a REAL native <select> (GWT ListBox),
 *    with options formatted "SYMBOL, Description" (e.g. "XAUUSD, Gold vs US
 *    Dollar"). Set it directly via `select.value = ...` + a 'change' event —
 *    no typing into it, no clicking a filtered dropdown row, no Escape dance.
 * 9. On this account BOTH "XAUUSD" (regular gold) and "XAUUSD247" (24/7
 *    variant) exist as separate symbols — verified side-by-side in the
 *    Market Watch "Forex" flyout. The recording used plain "XAUUSD". The
 *    old hardcoded alias XAUUSD -> "XAUUSD247" was therefore searching for a
 *    symbol string that may not even be the one you want; the new code
 *    tries "XAUUSD" first and falls back through a candidate list instead of
 *    hardcoding one guess.
 * 10. Market Watch's "Forex" category (left sidebar) is a flyout of 200+
 *     symbols, alphabetical, with NO search/filter box — you must scroll.
 *     Gold sits near the very end (next to Silver/XAG and Platinum/XPT,
 *     just before the exotic "Z..." pairs). This is only needed as a
 *     fallback now, to add a symbol to Market Watch if it isn't already
 *     selectable in the ticket's Symbol <select>.
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
    return p;
  } catch (e) { console.warn('[exness] screenshot failed:', e.message); return null; }
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
 * Open the order ticket for a symbol.
 * REWRITTEN (see header notes 7-10): open the "New Order" ticket first
 * (this doesn't depend on which symbol is currently charted), then set the
 * Symbol field directly via its native <select>. Only if that symbol isn't
 * present as a selectable option do we fall back to Market Watch's "Forex"
 * flyout to add it, then reopen the ticket.
 */

async function focusTerminal(page) {
  try {
    const cb = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (cb) await page.mouse.click(cb.x, cb.y);
  } catch {}
  await sleep(300);
}

/** Small square icon-only buttons clustered top-left = the toolbar.
 *  Sorted left-to-right: index 0 = "New Chart", index 1 = "New Order". */
async function toolbarIconButtons(page) {
  return page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const all = [...document.querySelectorAll('button, [role="button"], div, td, a')]
      .filter(vis)
      .map((el) => ({ r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width >= 16 && r.width <= 42 && r.height >= 16 && r.height <= 42 && r.top < 140 && r.left < 400)
      .sort((a, b) => a.r.left - b.r.left);
    const out = [];
    for (const o of all) {
      const x = o.r.left + o.r.width / 2, y = o.r.top + o.r.height / 2;
      if (!out.some((p) => Math.abs(p.x - x) < 4 && Math.abs(p.y - y) < 4)) out.push({ x, y });
    }
    return out;
  });
}

/** Try every known way to open the New Order ticket; true once it's open. */
async function tryOpenNewOrderDialog(page, timeout = 5000) {
  if (await isOrderTicketOpen(page)) return true;
  await focusTerminal(page);

  // 1) F9 — the standard MetaTrader "New Order" hotkey
  await page.keyboard.press('F9').catch(() => {});
  if (await waitFor(page, () => isOrderTicketOpen(page), timeout, 'ticket after F9').catch(() => false)) {
    console.log('[exness] order ticket opened (F9)');
    return true;
  }

  // 2) toolbar icon #2 ("New Order", next to "New Chart")
  const icons = await toolbarIconButtons(page);
  if (icons[1]) {
    await page.mouse.click(icons[1].x, icons[1].y);
    if (await waitFor(page, () => isOrderTicketOpen(page), timeout, 'ticket after toolbar click').catch(() => false)) {
      console.log('[exness] order ticket opened (toolbar icon #2)');
      return true;
    }
  }

  // 3) any visible element whose text/title mentions "New Order"
  const clicked = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const el = [...document.querySelectorAll('button, [role="button"], div, span, a, li, td')]
      .filter(vis)
      .find((e) => /new order|create new order/i.test((e.innerText || '').trim()) || /new order|create new order/i.test(e.title || ''));
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (clicked) {
    await page.mouse.click(clicked.x, clicked.y);
    if (await waitFor(page, () => isOrderTicketOpen(page), timeout, 'ticket after text match').catch(() => false)) {
      console.log('[exness] order ticket opened (text/title match)');
      return true;
    }
  }
  return false;
}

/** Close the ticket if it's open (X button, else Escape). */
async function closeOrderTicket(page) {
  const closedByX = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const modal = [...document.querySelectorAll('.page-window.modal')]
      .find((m) => !/hidden/.test(m.className || '') && m.querySelector('input#volume'));
    if (!modal) return true;
    const x = [...modal.querySelectorAll('button, [role="button"], span, div')]
      .filter(vis)
      .find((b) => /^(x|\u00d7|close)$/i.test((b.innerText || '').trim()) || /close/i.test(b.title || ''));
    if (x) { x.click(); return true; }
    return false;
  });
  if (!closedByX) await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);
}

/**
 * Set the ticket's Symbol field. VERIFIED: it's a real native <select>
 * (options formatted "SYMBOL, Description") — set .value + fire 'change'.
 * `candidates` is an ordered list of acceptable terminal symbol names; the
 * first one that exists as an option wins.
 */
async function setTicketSymbolSelect(page, candidates) {
  const res = await page.evaluate((cands) => {
    const vis = (el) => el.offsetParent !== null;
    const modal = [...document.querySelectorAll('.page-window.modal')]
      .find((m) => !/hidden/.test(m.className || '') && m.querySelector('input#volume'));
    const scope = modal || document;
    const selects = [...scope.querySelectorAll('select')].filter(vis);
    if (!selects.length) return { ok: false, reason: 'no-select' };
    const symSelect = selects[0]; // Symbol is the first select in the ticket; Type is the second
    const opts = [...symSelect.options];
    const upCands = cands.map((c) => String(c).toUpperCase());
    let match = opts.find((o) => upCands.includes((o.value || '').toUpperCase()) || upCands.includes((o.text || '').toUpperCase()));
    if (!match) {
      match = opts.find((o) => upCands.some((c) => (o.value || '').toUpperCase().startsWith(c) || (o.text || '').toUpperCase().startsWith(c + ',')));
    }
    if (!match) return { ok: false, reason: 'no-match', sampleOptions: opts.slice(0, 400).map((o) => o.text || o.value) };
    symSelect.value = match.value;
    symSelect.dispatchEvent(new Event('input', { bubbles: true }));
    symSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, matched: match.text || match.value };
  }, candidates);
  if (res.ok) console.log('[exness] symbol select set ->', res.matched);
  return res;
}

/** Fallback: add the symbol via Market Watch's "Forex" flyout (fixes two
 *  bugs from the previous version: the "Forex" label match no longer
 *  requires childElementCount===0 — it has a sibling arrow icon so that
 *  never matched — and the target row is scrolled into view before its
 *  coordinates are read, since this flyout has no search box). */
async function pickSymbolFromMarketWatch(page, candidates) {
  const forexBox = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const el = [...document.querySelectorAll('div, span, td, li')]
      .filter(vis)
      .find((e) => (e.innerText || '').trim() === 'Forex');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!forexBox) throw new Error('Market Watch "Forex" category not found');
  await page.mouse.click(forexBox.x, forexBox.y);
  await sleep(900);

  const foundText = await page.evaluate((cands) => {
    const vis = (el) => el.offsetParent !== null;
    const rows = [...document.querySelectorAll('td, span, div, li')].filter((e) => vis(e) && e.childElementCount === 0);
    const upCands = cands.map((c) => String(c).toUpperCase());
    let row = rows.find((e) => upCands.includes((e.innerText || '').trim().toUpperCase()));
    if (!row) row = rows.find((e) => upCands.some((c) => (e.innerText || '').trim().toUpperCase().startsWith(c + ',')));
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    return (row.innerText || '').trim();
  }, candidates);
  if (!foundText) {
    await screenshot(page, 'forex-flyout-no-match');
    throw new Error('Symbol not found in the Market Watch Forex flyout (see screenshot)');
  }
  await sleep(400);
  const box = await page.evaluate((wanted) => {
    const vis = (el) => el.offsetParent !== null;
    const el = [...document.querySelectorAll('td, span, div, li')]
      .filter((e) => vis(e) && e.childElementCount === 0)
      .find((e) => (e.innerText || '').trim() === wanted);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, foundText);
  if (!box) throw new Error(`"${foundText}" scrolled into view but has no clickable box`);
  await page.mouse.click(box.x, box.y);
  console.log('[exness] picked from Market Watch:', foundText);
  await sleep(1500);
}

async function openOrderTicket(page, candidates) {
  if (!(await tryOpenNewOrderDialog(page))) {
    await screenshot(page, 'no-order-ticket');
    throw new Error('Could not open the New Order ticket (tried F9, toolbar icon, and text match). See screenshot.');
  }
  let symRes = await setTicketSymbolSelect(page, candidates);
  if (symRes.ok) return;

  console.warn(`[exness] symbol not directly selectable in ticket (${symRes.reason}) — adding it via Market Watch first`);
  await closeOrderTicket(page);
  await pickSymbolFromMarketWatch(page, candidates);
  if (!(await tryOpenNewOrderDialog(page))) {
    await screenshot(page, 'no-order-ticket-after-watchlist');
    throw new Error('Could not open the New Order ticket after adding the symbol via Market Watch. See screenshot.');
  }
  symRes = await setTicketSymbolSelect(page, candidates);
  if (!symRes.ok) {
    await screenshot(page, 'symbol-not-in-select');
    throw new Error(`Symbol still not selectable after the Market Watch fallback (${symRes.reason}). Sample options: ` +
      JSON.stringify(symRes.sampleOptions || []).slice(0, 500) + ' — see screenshot.');
  }
}

/**
 * Map a logical pair (XAUUSD from the parser) to REAL terminal symbol name(s).
 * VERIFIED (2026-08-20): this account lists BOTH "XAUUSD" and "XAUUSD247" as
 * separate symbols. Plain "XAUUSD" is what the verified recording actually
 * used, so it's now tried FIRST instead of being hardcoded to "XAUUSD247".
 * Override via SYMBOL_ALIASES env (JSON, e.g. {"XAUUSD":"XAUUSDm"}).
 */
function symbolAliases() {
  try { return { ...JSON.parse(process.env.SYMBOL_ALIASES || '{}') }; } catch { return {}; }
}
function terminalSymbol(pair) {
  const a = symbolAliases();
  const p = String(pair || '').toUpperCase();
  return a[pair] || a[p] || (p === 'GOLD' ? 'XAUUSD' : pair);
}
/** Ordered candidates to try against the ticket's live Symbol <select>. */
function terminalSymbolCandidates(pair) {
  const a = symbolAliases();
  const p = String(pair || '').toUpperCase();
  const override = a[pair] || a[p];
  const out = [];
  if (override) out.push(override);
  if (p === 'XAUUSD' || p === 'GOLD') out.push('XAUUSD', 'XAUUSD247', 'XAUUSDm', 'GOLD');
  else out.push(pair, pair + 'm', pair + '247');
  return [...new Set(out)];
}

async function placeOrder(page, sig) {
  const { action, lot, sl, tp } = sig;
  const candidates = terminalSymbolCandidates(sig.pair);
  const pair = candidates[0]; // logical/display name used below for journal matching

  // 0) sanity: if the login dialog is somehow still open, stop
  if (await isLoginDialogOpen(page)) throw new Error('login dialog still open — could not reach the terminal');

  // 1) open the order ticket AND get the right symbol selected in it
  await openOrderTicket(page, candidates);
  await screenshot(page, 'order-ticket');

  // 2) volume / SL / TP — direct IDs first (verified), label lookup as fallback
  const setInput = async (id, label, value) => {
    let el = await page.$('#' + id);
    if (!el) {
      const handle = await fieldForLabel(page, label);
      el = handle ? handle.asElement() : null;
    }
    if (!el) { console.warn(`[exness] input for "${label}" (#${id}) not found`); return false; }
    await clearAndType(page, el, String(value));
    console.log(`[exness] set ${label} = ${value}`);
    return true;
  };
  await setInput('volume', 'Volume', lot);
  if (sl != null) await setInput('sl', 'Stop Loss', sl);
  if (tp != null) await setInput('tp', 'Take Profit', tp);
  await sleep(1000);

  // 3) verify the ticket is submittable BEFORE clicking — scoped to the modal,
  //    and check the VALUES actually landed in volume/sl/tp (not just present).
  const ticketOk = await page.evaluate((act) => {
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
    const sel = [...scope.querySelectorAll('select')].filter(vis)[0];
    return {
      ok: !!btn && !btn.disabled,
      btnFound: !!btn,
      btnText: btn ? (btn.innerText || '').trim().slice(0, 30) : null,
      btnDisabled: btn ? btn.disabled : null,
      modalFound: !!modal,
      volume: val('volume'),
      sl: val('sl'),
      tp: val('tp'),
      symbolInput: sel ? (sel.options[sel.selectedIndex] ? (sel.options[sel.selectedIndex].text || sel.value) : sel.value) : null,
    };
  }, action);
  console.log('[exness] ticket check before click:', JSON.stringify(ticketOk));
  if (!ticketOk.ok || !ticketOk.modalFound || ticketOk.volume !== String(lot)) {
    console.warn(`[exness] ticket not ready: btn=${ticketOk.btnFound} modal=${ticketOk.modalFound} volume="${ticketOk.volume}" (want "${lot}") sl="${ticketOk.sl}" tp="${ticketOk.tp}" symbol="${ticketOk.symbolInput}"`);
    await screenshot(page, 'ticket-not-submittable');
    throw new Error(`Order ticket not submittable (btn=${ticketOk.btnFound} modal=${ticketOk.modalFound} volume=${ticketOk.volume}). See screenshot.`);
  }

  // 5) Buy / Sell — scoped to the ticket modal (real mouse; avoids chart labels)
  console.log(`[exness] clicking ${action} (ticket-scoped)...`);
  await clickTicketButton(page, action);

  // 6) SUCCESS = the order ticket closes. In MT4 web, a placed order closes
  //    the ticket (the modal with #volume disappears). Wait up to ~20s for that.
  //    If a confirmation dialog ("Buy 0.14 XAUUSD ... OK") appears, click OK.
  let confirmed = false;
  let evidence = '';
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    // if a confirmation dialog (distinct from the ticket) is showing, click OK
    const confirmBox = await page.evaluate(() => {
      const vis = (el) => el.offsetParent !== null;
      const modals = [...document.querySelectorAll('.page-window.modal')].filter(m => !/hidden/.test(m.className || ''));
      const ticket = modals.find(m => m.querySelector('input#volume'));
      const other = modals.find(m => !m.querySelector('input#volume') && /(buy|sell|order|market)/i.test(m.innerText || ''));
      if (!other) return null;
      const btn = [...other.querySelectorAll('button')].find(b => vis(b) && /^(OK|Yes|Accept)$/i.test((b.innerText || '').trim()));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: (other.querySelector('.h')?.innerText || '').trim().slice(0, 40) };
    });
    if (confirmBox) {
      console.log('[exness] confirm dialog found, clicking OK:', confirmBox.title);
      await page.mouse.click(confirmBox.x, confirmBox.y);
      await sleep(1500);
      continue;
    }
    // ticket still open? keep waiting
    const ticketStillOpen = await page.evaluate(() => {
      const vis = (el) => el.offsetParent !== null;
      const m = [...document.querySelectorAll('.page-window.modal')]
        .find(x => !/hidden/.test(x.className || '') && x.querySelector('input#volume'));
      return !!m;
    });
    if (!ticketStillOpen) {
      // ticket closed — check the Trade tab / journal for the position
      const st = await page.evaluate((sym) => {
        const t = document.body ? document.body.innerText : '';
        if (/done!|request accepted|order (executed|placed|accepted|done)|position opened|deal done/i.test(t)) {
          return { journal: true };
        }
        const rows = [...document.querySelectorAll('tr, .row, [class*="row" i]')].filter(r => r.offsetParent !== null);
        for (const r of rows) {
          const txt = (r.innerText || '');
          if (txt.includes(sym) && /\d{4,}/.test(txt) && /(buy|sell)/i.test(txt)) {
            return { row: txt.replace(/\s+/g, ' ').slice(0, 140) };
          }
        }
        return null;
      }, pair);
      if (st) { confirmed = true; evidence = JSON.stringify(st); }
      break;
    }
    await sleep(1200);
  }

  // journal dump (ground truth) regardless of outcome
  const journalAfter = await page.evaluate(() => {
    const txt = document.body ? document.body.innerText : '';
    const i = txt.lastIndexOf('Journal');
    if (i < 0) return '(no journal found)';
    return txt.slice(i, i + 600).replace(/\n+/g, ' | ');
  });
  console.log('[exness] JOURNAL AFTER ORDER:', journalAfter);
  console.log(`[exness] order result: confirmed=${confirmed} evidence=${evidence}`);

  await screenshot(page, 'after-order');
  if (!confirmed) {
    throw new Error('Order ticket did not close / no position found after clicking ' + action +
      '. Journal: ' + (journalAfter || '(empty)') + ' — see screenshot');
  }
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
      // include the journal so we can see any order history / rejections
      const journal = await page.evaluate(() => {
        const txt = document.body ? document.body.innerText : '';
        const i = txt.lastIndexOf('Journal');
        return i >= 0 ? txt.slice(i, i + 600).replace(/\n+/g, ' | ') : '';
      });
      return { ok: true, message: 'ℹ️ No open positions found. Journal: ' + (journal || '(empty)') };
    }
    return { ok: true, message: '📋 LIVE positions in the terminal:\n' + positions.map((p, i) => `${i + 1}. ${p}`).join('\n') };
  } catch (e) {
    return { ok: false, message: `❌ Could not verify: ${e.message}` };
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
}

/* ---------------- public API ---------------- */

// queue of pending signals (a signal arriving while another trade is being
// placed must NOT be dropped — it runs right after the current one finishes)
const queue = [];

async function executeTrade(signal, timeoutMs = 180000) {
  if (busy) {
    queue.push(signal);
    throw new Error('another execution is in progress — signal QUEUED, will run next');
  }
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
      // attach the latest screenshot path so the WhatsApp side can send it to you
      if (page) {
        const p = await screenshot(page, 'error').catch(() => null);
        if (p) e.screenshotPath = p;
      }
      console.error('[exness] execution FAILED:', e.message);
      throw e;
    } finally {
      try { if (browser) await browser.close(); } catch {}
      busy = false;
      console.log('[exness] browser closed (memory released)');
      // drain any queued signal so nothing is ever dropped
      if (queue.length) {
        const next = queue.shift();
        console.log('[exness] executing queued signal:', JSON.stringify(next));
        setTimeout(() => executeTrade(next).catch(e => console.error('[exness] queued signal failed:', e.message)), 100);
      }
    }
  })();

  // hard cap so a hung GWT app can never lock the bot forever
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('execution timed out after ' + timeoutMs + 'ms')), timeoutMs));
  try {
    return await Promise.race([run, timer]);
  } catch (e) {
    busy = false;
    // still drain the queue on failure
    if (queue.length) {
      const next = queue.shift();
      console.log('[exness] executing queued signal after failure:', JSON.stringify(next));
      setTimeout(() => executeTrade(next).catch(err => console.error('[exness] queued signal failed:', err.message)), 100);
    }
    throw e;
  }
}

module.exports = {
  executeTrade, loginPage, launchBrowser, applyStealth, DEFAULT_SELECTORS, loadSelectors, verifyPositionsLive, terminalSymbol,
  clickVisibleText, clearAndType, fieldForLabel, screenshot, sleep,
  isLoginDialogOpen, isTerminalVisible, waitForLoginDialog, clickSwitchModalIfVisible,
  waitAfterSwitch, switchToMT5, performLogin, setServerField, waitForOkEnabled,
  // new in this version (see header notes 7-10)
  terminalSymbolCandidates, tryOpenNewOrderDialog, setTicketSymbolSelect,
  pickSymbolFromMarketWatch, openOrderTicket, closeOrderTicket, toolbarIconButtons,
  isOrderTicketOpen, focusTerminal,
};
