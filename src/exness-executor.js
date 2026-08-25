'use strict';

/**
 * Headless-browser execution against the MetaTrader Web Terminal
 * (MetaQuotes' GWT app at https://metatraderweb.app/trade).
 */

const fs = require('fs');
const path = require('path');

const RUNTIME = path.join(__dirname, '..', '.runtime');
const PROFILE_DIR = path.join(RUNTIME, 'browser-profile');
const SHOT_DIR = path.join(RUNTIME, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let busy = false;

const DEFAULT_SELECTORS = {
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

async function clickTicketButton(page, action, candidateLabels = null) {
  const labels = candidateLabels && candidateLabels.length
    ? candidateLabels.map((s) => String(s).toLowerCase())
    : [action === 'BUY' ? 'buy' : 'sell'];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const box = await page.evaluate((lbls) => {
      const vis = (el) => el.offsetParent !== null;
      const modal = [...document.querySelectorAll('.page-window.modal')]
        .find(m => !/hidden/.test(m.className || '') && m.querySelector('input#volume'));
      const scope = modal || document;
      const buttons = [...scope.querySelectorAll('button, .input-button, [role="button"]')].filter(vis);
      for (const lbl of lbls) {
        const el = buttons.find(b => {
          const t = (b.innerText || '').trim().toLowerCase();
          return t === lbl || t.startsWith(lbl + ' ') || t.startsWith(lbl + ':');
        });
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.innerText || '').trim().slice(0, 24) };
        }
      }
      return null;
    }, labels);
    if (box) {
      console.log(`[exness] clicking ticket button: "${box.text}"`);
      await page.mouse.click(box.x, box.y);
      await sleep(1000);
      return true;
    }
    await sleep(700);
  }
  throw new Error(`ticket button not found for labels [${labels.join(', ')}] in the order dialog`);
}

async function clickVisibleText(page, wanted, timeout = 8000) {
  const wantedArr = (Array.isArray(wanted) ? wanted : [wanted]).map(String);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const box = await page.evaluate((list) => {
      const els = [...document.querySelectorAll('*')]
        .filter((e) => e.offsetParent !== null && list.some((w) => (e.innerText || '').trim().toLowerCase() === w.toLowerCase()));
      if (!els.length) return null;
      const el = els[els.length - 1];
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

function memoryTooHigh() {
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const limit = Number(process.env.MAX_RSS_MB || 380);
  const tooHigh = rssMB > limit;
  if (tooHigh) console.warn(`[exness] MEMORY GUARD: rss=${rssMB}MB > ${limit}MB — skipping browser launch to avoid OOM`);
  return tooHigh;
}

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
  const puppeteer = require('puppeteer');
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
    '--disable-blink-features=AutomationControlled',
    '--js-flags=--max-old-space-size=256',
  ];
  if (process.env.PUPPETEER_SINGLE_PROCESS === '1') args.push('--single-process');
  const base = { args, userDataDir: PROFILE_DIR, headless: 'shell' };
  return puppeteer.launch(base);
}

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

async function switchToMT5(page) {
  const isMT5 = await page.evaluate(() => {
    const r5 = document.querySelector('input[id*="mt5"][type="radio"]');
    if (r5 && r5.offsetParent !== null && r5.checked) return true;
    const lbl5 = [...document.querySelectorAll('label')]
      .find(l => l.offsetParent !== null && /MetaTrader\s*5/i.test(l.innerText || ''));
    return !!lbl5;
  });
  if (isMT5) { console.log('[exness] platform already MT5'); return; }

  if (await clickSwitchModalIfVisible(page)) {
    console.log('[exness] clicked Switch (modal was open)');
    await waitAfterSwitch(page);
    return;
  }

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

async function setServerField(page, server) {
  const sel = loadSelectors();
  const field = await page.$(sel.serverInput);
  if (!field) { console.warn('[exness] server input not found (selector: ' + sel.serverInput + ')'); return; }

  await field.click();
  await sleep(300);
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

  await page.evaluate(() => { const el = document.querySelector('#server'); if (el) { el.focus(); el.select(); } });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(server), { delay: 50 });
  await sleep(1500);
  await page.keyboard.press('Enter');
  await sleep(1500);
  const v = await page.evaluate(() => document.querySelector('#server')?.value);
  console.log('[exness] server field ->', JSON.stringify(v));
}

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

async function performLogin(page, login, pass, server) {
  await setServerField(page, server);

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

  const servers = [server];
  const alt = String(server).replace(/-?MT5/i, '-').replace(/^[-_]+/, '').replace(/-+$/, '');
  if (alt !== server && alt) servers.push(alt);
  console.log('[exness] server candidates:', servers.join(' | '));

  console.log('[exness] opening', url);
  let wsAttempts = [];
  page.on('websocket', (ws) => {
    const u = ws.url() || '';
    wsAttempts.push(u);
    console.log('[exness] WS opened:', u.slice(0, 100));
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);

  const dialogOpen = await isLoginDialogOpen(page);
  if (!dialogOpen && (await isTerminalVisible(page))) {
    console.log('[exness] persisted session: already inside the terminal (no login dialog)');
    return;
  }

  console.log('[exness] waiting for the login dialog (can take 10-40s on first boot)...');
  await waitForLoginDialog(page, 90000);

  for (let attempt = 1; attempt <= 4; attempt++) {
    const srv = servers[Math.min(attempt - 1, servers.length - 1)];
    console.log(`[exness] login attempt ${attempt}/4 (server ${srv})`);
    await performLogin(page, login, pass, srv);
    await sleep(4000);

    if (await clickSwitchModalIfVisible(page)) {
      console.log('[exness] MT5 switch requested after OK — refreshing into MT5 mode...');
      try { await waitAfterSwitch(page, 60000); } catch (e) { console.warn('[exness] wait after switch:', e.message); }
      await sleep(2000);
      continue;
    }

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
        throw new Error('Authorization Failed — check EXNESS_LOGIN/PASSWORD/SERVER.');
      }
      console.warn(`[exness] login attempt ${attempt} (server ${srv}) did not complete (dialog still open), retrying...`);
    } else {
      console.warn(`[exness] login attempt ${attempt}: dialog closed but terminal not detected, retrying...`);
    }
  }
  await screenshot(page, 'post-login-unknown');
  throw new Error('Login did not complete after 4 attempts (see screenshot runtime/screenshots).');
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
    const row = cell.closest('tr') || cell.parentElement;
    const scope = row || document;
    const input = scope.querySelector('input, textarea');
    return input || null;
  }, label);
}

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

async function toolbarIconButtons(page) {
  return page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const all = [...document.querySelectorAll('button, [role="button"], div, td, a')]
      .filter(vis)
      .filter((el) => (el.innerText || '').trim() === '')
      .map((el) => ({ r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width >= 12 && r.width <= 44 && r.height >= 12 && r.height <= 44 && r.top < 140 && r.left < 400)
      .sort((a, b) => a.r.left - b.r.left);

    const out = [];
    for (const o of all) {
      const x = o.r.left + o.r.width / 2, y = o.r.top + o.r.height / 2;
      if (!out.some((p) => Math.abs(p.x - x) < 4 && Math.abs(p.y - y) < 4)) out.push({ x, y });
    }
    return out;
  });
}

async function closeOrderTicket(page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await isOrderTicketOpen(page))) return true;
    const clickedX = await page.evaluate(() => {
      const vis = (el) => el.offsetParent !== null;
      const modal = [...document.querySelectorAll('.page-window.modal')]
        .find((m) => !/hidden/.test(m.className || '') && m.querySelector('input#volume'));
      if (!modal) return true;
      let x = [...modal.querySelectorAll('button, [role="button"], span, div')]
        .filter(vis)
        .find((b) => /^(x|\u00d7|\u2715|\u2716|close)$/i.test((b.innerText || '').trim()) || /close/i.test(b.title || ''));
      if (!x) {
        const mr = modal.getBoundingClientRect();
        x = [...modal.querySelectorAll('button, [role="button"], span, div')]
          .filter(vis)
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width <= 28 && r.height <= 28 && r.top - mr.top < 36 && mr.right - r.right < 40)
          .sort((a, b) => (mr.right - a.r.right) - (mr.right - b.r.right))[0]?.el;
      }
      if (x) { x.click(); return true; }
      return false;
    });
    if (!clickedX) await page.keyboard.press('Escape').catch(() => {});
    await sleep(700);
  }
  const stillOpen = await isOrderTicketOpen(page);
  if (stillOpen) console.warn('[exness] could not confirm the order ticket closed — proceeding anyway');
  return !stillOpen;
}

async function ensureMarketWatchVisible(page) {
  const hasRows = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    return [...document.querySelectorAll('div, span, td, li')]
      .filter((e) => vis(e) && e.childElementCount === 0)
      .some((e) => /^[A-Z]{6}$/.test((e.innerText || '').trim()));
  });
  if (hasRows) return true;
  const tabBox = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const el = [...document.querySelectorAll('div, span, td, li, button')]
      .filter(vis)
      .find((e) => (e.innerText || '').trim() === 'Symbols');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (tabBox) {
    await page.mouse.click(tabBox.x, tabBox.y);
    await sleep(600);
    return true;
  }
  return false;
}

function symbolAliases() {
  try { return { ...JSON.parse(process.env.SYMBOL_ALIASES || '{}') }; } catch { return {}; }
}
function terminalSymbol(pair) {
  const a = symbolAliases();
  const p = String(pair || '').toUpperCase();
  return a[pair] || a[p] || (p === 'GOLD' ? 'XAUUSD' : pair);
}

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

/**
 * Quick check: is any of the candidate symbols already visible as a plain
 * row in Market Watch? VERIFIED (2026-08-21 recording): once a category has
 * been "Shown" via the Symbols dialog, it stays shown across sessions (tied
 * to the trading account, not the browser) — the very first frame of that
 * recording already had XAUUSD sitting in Market Watch from an earlier run.
 * So on every trade after the first ever reveal, this lets us skip the
 * entire right-click -> Symbols -> Forex -> Show -> Close dance (~6-8s and
 * several fragile clicks) and go straight to double-clicking the row.
 */
async function symbolAlreadyInMarketWatch(page, candidates) {
  return page.evaluate((cands) => {
    const vis = (el) => el.offsetParent !== null;
    const upCands = cands.map((c) => String(c).toUpperCase());
    return [...document.querySelectorAll('div, span, td, li')]
      .filter((e) => vis(e) && e.childElementCount === 0)
      .some((e) => upCands.includes((e.innerText || '').trim().toUpperCase()));
  }, candidates);
}

/**
 * Forces MetaTrader Web to load hidden symbols into the DOM.
 * Mimics: Right-click Market Watch -> Symbols... -> select category -> Show -> Close
 * VERIFIED end-to-end from a screen recording (2026-08-21): the context menu
 * item is literally "Symbols..." WITH the trailing ellipsis — an earlier
 * version of this function matched the exact text "Symbols" and therefore
 * never actually found/clicked it, so nothing after that step ever ran.
 * The category tree in this account is: Forex, Crypto, CryptoCross,
 * Energies, Indices, Stocks, Idx_Enlarge, Forex_Indicator — there is no
 * separate "Metals" category; Gold lives inside "Forex".
 */
async function revealHiddenSymbols(page, categoryName = 'Forex') {
  console.log(`[exness] Unhiding symbols for category: ${categoryName}...`);
  await ensureMarketWatchVisible(page);
  await sleep(1000);

  const clickPos = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const allEls = [...document.querySelectorAll('*')].filter(vis);

    const targets = allEls.filter(e => /^(EURUSD|USDJPY|GBPUSD|USDCHF|USDCAD|AUDUSD)[a-z0-9]*$/i.test((e.innerText || '').trim()));
    if (targets.length) {
        const target = targets[targets.length - 1];
        const r = target.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }

    const headers = allEls.filter(e => (e.innerText || '').trim() === 'Symbol');
    if (headers.length) {
        const header = headers[headers.length - 1];
        const r = header.getBoundingClientRect();
        return { x: r.x + 10, y: r.y + 35 };
    }

    return null;
  });

  if (!clickPos) {
    console.warn('[exness] Could not find a reliable Market Watch element to right-click.');
    return false;
  }

  await page.mouse.click(clickPos.x, clickPos.y, { button: 'right' });
  await sleep(1200);

  const symbolsMenuOption = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const allEls = [...document.querySelectorAll('*')].filter(vis);

    // VERIFIED: the real menu text is "Symbols..." (with ellipsis) — strip
    // trailing dots before comparing so this matches regardless of exactly
    // how many the skin renders, instead of requiring an exact 'Symbols'.
    const norm = (s) => (s || '').trim().replace(/\.+$/, '');
    const opts = allEls.filter((e) => e.childElementCount === 0 && norm(e.innerText) === 'Symbols');
    if (!opts.length) return null;

    const opt = opts[opts.length - 1];
    const r = opt.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  if (!symbolsMenuOption) {
      console.warn('[exness] Context menu option "Symbols..." not found. The right click might have missed.');
      await page.keyboard.press('Escape');
      return false;
  }

  await page.mouse.click(symbolsMenuOption.x, symbolsMenuOption.y);
  await sleep(1500);

  const clickedCat = await page.evaluate((cat) => {
    const vis = (el) => el.offsetParent !== null;
    const modals = [...document.querySelectorAll('.page-window.modal')].filter(vis);
    const symbolsModal = modals.find(m => /Symbols/i.test(m.innerText));
    if (!symbolsModal) return false;

    const allEls = [...symbolsModal.querySelectorAll('*')].filter(vis);
    const items = allEls.filter((e) => (e.innerText || '').trim().toLowerCase() === cat.toLowerCase());

    if (!items.length) return false;
    const item = items[items.length - 1];
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, categoryName);

  if (clickedCat) {
    await page.mouse.click(clickedCat.x, clickedCat.y);
    await sleep(1000);
  } else {
    console.warn(`[exness] Category "${categoryName}" not found in Symbols modal.`);
  }

  const showBtn = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const modals = [...document.querySelectorAll('.page-window.modal')].filter(vis);
    const symbolsModal = modals.find(m => /Symbols/i.test(m.innerText));
    if (!symbolsModal) return null;

    const allEls = [...symbolsModal.querySelectorAll('*')].filter(vis);
    const buttons = allEls.filter((b) => (b.innerText || '').trim() === 'Show');
    if (!buttons.length) return null;

    const btn = buttons[buttons.length - 1];
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  if (showBtn) {
    await page.mouse.click(showBtn.x, showBtn.y);
    console.log(`[exness] Clicked "Show" for ${categoryName}.`);
    await sleep(1000);
  }

  const closeBtn = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const modals = [...document.querySelectorAll('.page-window.modal')].filter(vis);
    const symbolsModal = modals.find(m => /Symbols/i.test(m.innerText));
    if (!symbolsModal) return null;

    const allEls = [...symbolsModal.querySelectorAll('*')].filter(vis);
    const buttons = allEls.filter((b) => (b.innerText || '').trim() === 'Close');
    if (!buttons.length) return null;

    const btn = buttons[buttons.length - 1];
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  if (closeBtn) {
    await page.mouse.click(closeBtn.x, closeBtn.y);
    await sleep(1000);
  }

  return true;
}

/**
 * Open the order ticket for a symbol.
 * Bypasses the toolbar and dropdowns entirely.
 * Searches the main Market Watch list, scrolls to the symbol, and double-clicks it.
 */
async function openOrderTicket(page, candidates) {
  console.log('[exness] Searching for symbol directly in the Market Watch panel...');
  await ensureMarketWatchVisible(page);
  await sleep(1000);

  // Step 1: scroll the right row into view. IMPORTANT FIX: pick the match by
  // CANDIDATE PRIORITY, not DOM order. The old version filtered by "any
  // candidate matches" then took the LAST element found — since Market
  // Watch lists XAUUSD *and* XAUUSD247 side by side once Forex is shown,
  // that always grabbed XAUUSD247 (it sits later in the list) regardless of
  // our preferred candidate order, so trades silently went to the wrong
  // instrument. Verified from the 2026-08-25 log: "Found symbol XAUUSD247"
  // when XAUUSD (the actual first-priority candidate) was sitting right
  // above it.
  const scrolled = await page.evaluate((cands) => {
    const vis = (el) => el.offsetParent !== null;
    const rows = [...document.querySelectorAll('*')].filter((e) => vis(e) && e.childElementCount === 0);
    for (const c of cands) {
      const up = String(c).toUpperCase();
      const exact = rows.filter((e) => (e.innerText || '').trim().toUpperCase() === up);
      if (exact.length) {
        const row = exact[exact.length - 1];
        row.scrollIntoView({ block: 'center', behavior: 'instant' });
        return (row.innerText || '').trim();
      }
    }
    for (const c of cands) {
      const up = String(c).toUpperCase();
      const pref = rows.filter((e) => (e.innerText || '').trim().toUpperCase().startsWith(up + ','));
      if (pref.length) {
        const row = pref[pref.length - 1];
        row.scrollIntoView({ block: 'center', behavior: 'instant' });
        return (row.innerText || '').trim();
      }
    }
    return null;
  }, candidates);

  if (!scrolled) {
    await screenshot(page, 'symbol-not-in-market-watch');
    throw new Error(`Symbol not found in Market Watch list. Candidates tried: ${candidates.join(', ')}. See screenshot.`);
  }

  // Step 2: re-measure AFTER the scroll settles, in a separate round-trip —
  // reading getBoundingClientRect() in the exact same tick as
  // scrollIntoView() can race on some renders and hand back stale (pre-
  // scroll) coordinates, which would double-click on the wrong spot and
  // silently fail to open anything.
  await sleep(400);
  const foundBox = await page.evaluate((wanted) => {
    const vis = (el) => el.offsetParent !== null;
    const el = [...document.querySelectorAll('*')]
      .filter((e) => vis(e) && e.childElementCount === 0 && (e.innerText || '').trim() === wanted);
    if (!el.length) return null;
    const row = el[el.length - 1];
    const r = row.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { text: wanted, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, scrolled);

  if (!foundBox) {
    await screenshot(page, 'symbol-not-in-market-watch');
    throw new Error(`Symbol "${scrolled}" scrolled into view but its position could not be re-measured. See screenshot.`);
  }

  console.log(`[exness] Found symbol "${foundBox.text}" in Market Watch. Double-clicking to open ticket...`);
  await page.mouse.click(foundBox.x, foundBox.y, { clickCount: 2, delay: 100 });
  await sleep(2000);

  if (await isOrderTicketOpen(page)) {
    console.log('[exness] Order ticket successfully opened via double-click.');
    return;
  }

  // Fallback: right-click the row -> "New Order" from the context menu.
  // VERIFIED (2026-08-25 recording) as an equally valid, arguably more
  // reliable way to open the same ticket — double-click timing can be
  // finicky in headless Chrome, this doesn't depend on click timing at all.
  console.warn('[exness] double-click did not open a ticket — retrying via right-click > New Order');
  await page.mouse.click(foundBox.x, foundBox.y, { button: 'right' });
  await sleep(900);
  const newOrderItem = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const el = [...document.querySelectorAll('*')]
      .filter((e) => vis(e) && e.childElementCount === 0 && (e.innerText || '').trim() === 'New Order');
    if (!el.length) return null;
    const r = el[el.length - 1].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (newOrderItem) {
    await page.mouse.click(newOrderItem.x, newOrderItem.y);
    await sleep(2000);
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }

  if (!(await isOrderTicketOpen(page))) {
     await screenshot(page, 'ticket-failed-to-open');
     throw new Error('Order ticket did not open (tried double-click and right-click > New Order).');
  }

  console.log('[exness] Order ticket successfully opened via right-click > New Order.');
}

/** Read the big "bid / ask" price line shown in an open ticket
 *  (e.g. "4648.518 / 4648.568"), used to work out Limit vs Stop below. */
async function readTicketPrices(page) {
  return page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const modal = [...document.querySelectorAll('.page-window.modal')]
      .find((m) => !/hidden/.test(m.className || '') && m.querySelector('input#volume'));
    const scope = modal || document;
    const el = [...scope.querySelectorAll('*')]
      .filter((e) => vis(e) && e.childElementCount === 0)
      .find((e) => /^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test((e.innerText || '').trim()));
    if (!el) return null;
    const [bid, ask] = el.innerText.trim().split('/').map((s) => parseFloat(s.trim()));
    return { bid, ask };
  });
}

/**
 * Switch an open ticket from "Market Execution" to "Pending order" and
 * configure it for a specific entry price.
 *
 * NOTE ON CONFIDENCE: verified from a live recording (2026-08-25) that the
 * ticket's "Type" select has exactly two options, "Market Execution" and
 * "Pending order" — but the recording didn't carry on to show the expanded
 * pending-order sub-form (the secondary Buy/Sell Limit/Stop selector, the
 * Price field, and the submit button's exact label), so those parts below
 * are implemented generically (label-based field lookup, multiple button-
 * label fallbacks, screenshots on anything unexpected) rather than against
 * a confirmed exact layout. If this doesn't match first try, the
 * 'pending-order-ticket' screenshot plus the thrown error will show exactly
 * what the real sub-form looks like so it's a quick follow-up fix.
 */
async function setPendingOrderMode(page, { action, entryPrice }) {
  const prices = await readTicketPrices(page);

  // 1) Switch the primary Type select to "Pending order".
  const switched = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const modal = [...document.querySelectorAll('.page-window.modal')]
      .find((m) => !/hidden/.test(m.className || '') && m.querySelector('input#volume'));
    const scope = modal || document;
    const selects = [...scope.querySelectorAll('select')].filter(vis);
    const typeSelect = selects.find((s) => [...s.options].some((o) => /pending order/i.test(o.text)));
    if (!typeSelect) return false;
    const opt = [...typeSelect.options].find((o) => /pending order/i.test(o.text));
    typeSelect.value = opt.value;
    typeSelect.dispatchEvent(new Event('input', { bubbles: true }));
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  if (!switched) {
    await screenshot(page, 'pending-order-type-select-not-found');
    throw new Error('Could not find/switch the ticket\'s Type select to "Pending order". See screenshot.');
  }
  await sleep(900);
  await screenshot(page, 'pending-order-ticket');

  // 2) Work out Limit vs Stop the standard way: a BUY above the current ask
  //    or a SELL below the current bid only fills on a breakout -> Stop;
  //    the opposite (waiting for a better/retraced price) -> Limit.
  let pendingType = null;
  if (prices && entryPrice != null) {
    if (action === 'BUY') pendingType = entryPrice > prices.ask ? 'Buy Stop' : 'Buy Limit';
    else pendingType = entryPrice < prices.bid ? 'Sell Stop' : 'Sell Limit';
  } else {
    pendingType = action === 'BUY' ? 'Buy Limit' : 'Sell Limit';
    console.warn('[exness] could not read current bid/ask — defaulting to', pendingType, '(verify this is what you want)');
  }

  // 3) Set the secondary Buy/Sell Limit/Stop select, if present.
  const subTypeSet = await page.evaluate((wanted) => {
    const vis = (el) => el.offsetParent !== null;
    const modal = [...document.querySelectorAll('.page-window.modal')]
      .find((m) => !/hidden/.test(m.className || '') && m.querySelector('input#volume'));
    const scope = modal || document;
    const selects = [...scope.querySelectorAll('select')].filter(vis);
    const subSelect = selects.find((s) => [...s.options].some((o) => /limit|stop/i.test(o.text)));
    if (!subSelect) return { ok: false, reason: 'no-sub-select' };
    const opt = [...subSelect.options].find((o) => o.text.trim().toLowerCase() === wanted.toLowerCase());
    if (!opt) return { ok: false, reason: 'no-matching-option', available: [...subSelect.options].map((o) => o.text) };
    subSelect.value = opt.value;
    subSelect.dispatchEvent(new Event('input', { bubbles: true }));
    subSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }, pendingType);
  if (!subTypeSet.ok) {
    await screenshot(page, 'pending-order-subtype-not-found');
    throw new Error(`Could not set the pending order sub-type to "${pendingType}" (${subTypeSet.reason}). See screenshot.`);
  }
  console.log('[exness] pending order sub-type set ->', pendingType);

  // 4) Fill the entry Price field.
  if (entryPrice != null) {
    let priceEl = await page.$('#price');
    if (!priceEl) {
      const handle = await fieldForLabel(page, 'Price');
      priceEl = handle ? handle.asElement() : null;
    }
    if (!priceEl) {
      await screenshot(page, 'pending-order-price-field-not-found');
      throw new Error('Could not find the pending order "Price" field. See screenshot.');
    }
    await clearAndType(page, priceEl, String(entryPrice));
    console.log('[exness] set pending Price =', entryPrice);
  }
  await sleep(500);
  return pendingType;
}

async function placeOrder(page, sig) {
  const { action, lot, sl, tp, entryPrice } = sig;
  // sig.pending / sig.orderType let the caller force pending mode explicitly;
  // otherwise we infer it from entryPrice being present (backward compatible
  // — existing callers that never pass entryPrice keep getting plain market
  // orders exactly as before).
  const isPending = sig.pending === true || /^(pending|limit|stop)$/i.test(sig.orderType || '') || entryPrice != null;
  const candidates = terminalSymbolCandidates(sig.pair);
  const pair = candidates[0];

  if (await isLoginDialogOpen(page)) throw new Error('login dialog still open — could not reach the terminal');

  // Fast path: symbol visibility is remembered per trading account (not per
  // browser session) — once Gold has been "Shown" once, it stays in Market
  // Watch on every future login. Only run the right-click -> Symbols... ->
  // Forex -> Show -> Close dance when the symbol genuinely isn't there yet.
  await ensureMarketWatchVisible(page);
  const alreadyVisible = await symbolAlreadyInMarketWatch(page, candidates);
  if (alreadyVisible) {
    console.log('[exness] symbol already visible in Market Watch — skipping the reveal step');
  } else {
    try {
      await revealHiddenSymbols(page, 'Forex');
      if (!(await symbolAlreadyInMarketWatch(page, candidates)) && (pair.includes('XAU') || pair.includes('GOLD'))) {
        await revealHiddenSymbols(page, 'Metals'); // no-op on accounts without this category, kept for safety
      }
    } catch (e) {
      console.warn('[exness] Non-fatal error while revealing symbols:', e.message);
    }
  }

  await openOrderTicket(page, candidates);
  await screenshot(page, 'order-ticket');

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

  let pendingType = null;
  if (isPending) {
    if (entryPrice == null) throw new Error('Pending order requested but no entryPrice was provided.');
    pendingType = await setPendingOrderMode(page, { action, entryPrice });
  }

  // For a pending order the submit button's label is uncertain (could be
  // "Place", the sub-type name like "Buy Limit", or still just "Buy") — so
  // check against a list of plausible labels instead of the single exact
  // action word used for market orders.
  const btnLabels = isPending
    ? [pendingType.toLowerCase(), 'place', action === 'BUY' ? 'buy' : 'sell']
    : [action === 'BUY' ? 'buy' : 'sell'];

  const ticketOk = await page.evaluate((labels) => {
    const vis = (el) => el.offsetParent !== null;
    const modal = [...document.querySelectorAll('.page-window.modal')]
      .find(m => !/hidden/.test(m.className || '') && m.querySelector('input#volume'));
    const scope = modal || document;
    const buttons = [...scope.querySelectorAll('button, .input-button, [role="button"]')].filter(vis);
    let btn = null;
    for (const lbl of labels) {
      btn = buttons.find(b => {
        const t = (b.innerText || '').trim().toLowerCase();
        return t === lbl || t.startsWith(lbl + ' ') || t.startsWith(lbl + ':');
      });
      if (btn) break;
    }
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
      price: val('price'),
      symbolInput: sel ? (sel.options[sel.selectedIndex] ? (sel.options[sel.selectedIndex].text || sel.value) : sel.value) : null,
    };
  }, btnLabels);

  console.log('[exness] ticket check before click:', JSON.stringify(ticketOk));
  if (!ticketOk.ok || !ticketOk.modalFound || ticketOk.volume !== String(lot)) {
    console.warn(`[exness] ticket not ready: btn=${ticketOk.btnFound} modal=${ticketOk.modalFound} volume="${ticketOk.volume}" (want "${lot}") sl="${ticketOk.sl}" tp="${ticketOk.tp}" symbol="${ticketOk.symbolInput}"`);
    await screenshot(page, 'ticket-not-submittable');
    throw new Error(`Order ticket not submittable (btn=${ticketOk.btnFound} modal=${ticketOk.modalFound} volume=${ticketOk.volume}). See screenshot.`);
  }

  console.log(`[exness] clicking ${isPending ? pendingType : action} (ticket-scoped)...`);
  await clickTicketButton(page, action, isPending ? btnLabels : null);

  let confirmed = false;
  let evidence = '';
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
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

    const ticketStillOpen = await page.evaluate(() => {
      const vis = (el) => el.offsetParent !== null;
      const m = [...document.querySelectorAll('.page-window.modal')]
        .find(x => !/hidden/.test(x.className || '') && x.querySelector('input#volume'));
      return !!m;
    });

    if (!ticketStillOpen) {
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
  return { action, pair, lot, sl, tp, entryPrice, pendingType, confirmed, evidence };
}

async function verifyPositionsLive() {
  let browser, page;
  try {
    ({ browser, page } = await loginPage());
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
      const rows = [...document.querySelectorAll('tr, .row, [class*="row" i]')].filter(vis);
      for (const r of rows) {
        const txt = (r.innerText || '').trim().replace(/\s+/g, ' ');
        if (/\d{4,}/.test(txt) && /(buy|sell)/i.test(txt) && /[A-Z]{2,6}/.test(txt) && /\d+\.\d+/.test(txt)) {
          out.push(txt.slice(0, 160));
        }
      }
      if (!out.length) {
        const lines = (document.body ? document.body.innerText : '').split('\n').map(s => s.trim()).filter(Boolean);
        for (const l of lines) {
          if (/(buy|sell)/i.test(l) && /[A-Z]{2,6}/.test(l) && /\d{4,}/.test(l)) out.push(l.replace(/\s+/g, ' ').slice(0, 160));
        }
      }
      return [...new Set(out)].slice(0, 12);
    });

    if (!positions.length) {
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

const queue = [];

async function executeTrade(signal, timeoutMs = 180000) {
  if (busy) {
    queue.push(signal);
    throw new Error('another execution is in progress — signal QUEUED, will run next');
  }
  cleanupScreenshots();

  const memoryWaitMs = Number(process.env.MEMORY_WAIT_MS || 120000);
  const memoryWaitStart = Date.now();
  while (memoryTooHigh()) {
    if (Date.now() - memoryWaitStart > memoryWaitMs) {
      throw new Error(`Memory guard: RSS stayed above ${process.env.MAX_RSS_MB || 380}MB for ${memoryWaitMs / 1000}s — skipping to avoid OOM.`);
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
      if (queue.length) {
        const next = queue.shift();
        console.log('[exness] executing queued signal:', JSON.stringify(next));
        setTimeout(() => executeTrade(next).catch(e => console.error('[exness] queued signal failed:', e.message)), 100);
      }
    }
  })();

  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('execution timed out after ' + timeoutMs + 'ms')), timeoutMs));
  try {
    return await Promise.race([run, timer]);
  } catch (e) {
    busy = false;
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
  terminalSymbolCandidates, openOrderTicket, closeOrderTicket, toolbarIconButtons,
  isOrderTicketOpen, focusTerminal, revealHiddenSymbols, symbolAlreadyInMarketWatch,
  readTicketPrices, setPendingOrderMode,
};
