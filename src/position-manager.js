'use strict';

/**
 * Position management in the MetaTrader Web Terminal (close / partial close /
 * modify SL / TP / breakeven) + owner command execution.
 *
 * WHY /close USED TO FAIL
 * -----------------------
 * The old implementation looked for the right-click "Close" menu item using
 * `el.offsetParent !== null` as the visibility test. GWT context menus in the
 * MetaTrader web terminal are rendered with `position: fixed`, and
 * `offsetParent` is ALWAYS null for fixed elements — so the menu item was on
 * screen but invisible to the code. The row match also wasn't scoped to the
 * Trade tab, so the right-click could land on a Market Watch cell instead of
 * the position row (that menu has no Close item).
 *
 * HOW IT WORKS NOW
 * ----------------
 *  - Rows are matched by symbol needle AND a ticket-like number / buy-sell
 *    word, which Market Watch rows never have.
 *  - Menu/dialog element visibility uses checkVisibility() + bounding-box,
 *    which works for fixed-position GWT menus. (Browser snippets are built as
 *    string expressions with VIS_FN inlined, since page.evaluate() serializes
 *    functions and can't interpolate.)
 *  - Every strategy dumps the texts it sees into the Render log (and
 *    screenshots), so if MetaQuotes changes the DOM the log shows exactly
 *    which items were on screen.
 *  - Three close strategies, tried in order:
 *      A. select row -> right-click -> "Close position" in the context menu
 *      B. double-click the row -> the close/modify dialog opens directly
 *      C. right-click again -> click ANY close-ish menu item (loose match)
 *  - The close dialog keeps its Volume field editable, which is exactly how
 *    MT5 does partial closes: set the volume to close, click the yellow
 *    "Close" button, the remainder stays open.
 */
const {
  loginPage, clickVisibleText, clearAndType, fieldForLabel, screenshot, sleep,
  readTicketError,
} = require('./exness-executor');
const { symbolNeedles } = require('./fill-evidence');
const { resolveTargets, closeVolumeFor, describeSelector } = require('./commands');
const { pipSize } = require('./pips');

/* ---------------- low-level terminal helpers ---------------- */

/**
 * Visibility snippet injected into every browser expression. Works for
 * position:fixed GWT menus where offsetParent is always null.
 */
const VIS_FN = `
function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  if (typeof el.checkVisibility === 'function') {
    try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); }
    catch (e) { /* fall through */ }
  }
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = window.getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
}`;

/** Build a browser expression string with VIS_FN inlined. */
const expr = (body) => `(function () {\n${VIS_FN}\n${body}\n})()`;

async function openTradeTab(page) {
  await clickVisibleText(page, ['Trade', 'Toolbox'], 5000).catch(() => {});
  await sleep(1500);
}

/**
 * Find a position row in the Trade tab. Scoped so Market Watch cells can't
 * fool it: the enclosing row must contain a ticket-like number or a buy/sell
 * word (Market Watch rows never do). Pass pos.ticketId to disambiguate
 * multiple positions on the same symbol.
 */
async function findPositionRow(page, pos) {
  const args = JSON.stringify({
    syms: symbolNeedles(pos.terminalSymbol || pos.pair),
    ticket: pos.ticketId ? String(pos.ticketId) : null,
  });
  const handle = await page.evaluateHandle(expr(`
    const opts = ${args};
    const up = (opts.syms || []).map((s) => String(s).toUpperCase());
    const rowish = (el) => el.tagName === 'TR' || /row|line|item|grid/i.test(el.className || '');
    const cells = [...document.querySelectorAll('td, span, div')]
      .filter((c) => isVisible(c) && c.childElementCount === 0);
    const matches = cells.filter((c) => {
      const t = (c.innerText || '').trim().toUpperCase();
      if (!up.includes(t)) return false;
      let el = c;
      for (let i = 0; i < 5 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        if (!rowish(el)) continue;
        const rt = (el.innerText || '').replace(/\\s+/g, ' ');
        if (opts.ticket) return new RegExp('#?' + opts.ticket).test(rt);
        if (/\\b\\d{6,}\\b/.test(rt) || /\\b(buy|sell)\\b/i.test(rt)) return true;
        return false;
      }
      return false;
    });
    if (!matches.length) return null;
    // last DOM match = bottom of the page = the toolbox (Market Watch sits above)
    const cell = matches[matches.length - 1];
    let el = cell;
    for (let i = 0; i < 5 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      if (rowish(el)) return el;
    }
    return cell.parentElement || cell;
  `));
  const el = handle.asElement();
  return el || null;
}

/** Real-mouse right-click (GWT ignores synthetic contextmenu events). */
async function realRightClick(page, box) {
  await page.mouse.move(box.x, box.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await sleep(1200);
}

/** Real-mouse click at coordinates. */
async function realClick(page, box) {
  await page.mouse.click(box.x, box.y);
  await sleep(800);
}

/**
 * Dump every visible menu/overlay-ish text so the log shows exactly what the
 * context menu contained (works for fixed-position GWT menus).
 */
async function listMenuTexts(page) {
  return page.evaluate(expr(`
    const out = [];
    const els = [...document.querySelectorAll('div, span, td, li, button, a, [role="menuitem"]')]
      .filter((e) => isVisible(e) && e.innerText && e.innerText.trim().length > 0)
      .filter((e) => e.innerText.trim().length <= 60)
      .filter((e) => {
        const st = window.getComputedStyle(e);
        const zi = parseInt(st.zIndex, 10);
        return zi > 0 || st.position === 'fixed' || st.position === 'absolute'
          || !!e.closest('[class*="menu" i], [class*="context" i], [class*="popup" i]');
      });
    for (const e of els) {
      const t = e.innerText.trim().replace(/\\s+/g, ' ');
      if (t && !out.includes(t)) out.push(t);
    }
    out.slice(0, 40);
  `));
}

/**
 * Click the first menu item matching `patterns` (RegExp sources, priority
 * order) whose text does NOT match anything in `exclude`. Returns clicked
 * text or null.
 */
async function clickMenuText(page, patterns, exclude = []) {
  const args = JSON.stringify({ patterns, exclude });
  for (let i = 0; i < patterns.length; i++) {
    const box = await page.evaluate(expr(`
      const opts = ${args};
      const wanted = new RegExp(opts.patterns[${i}], 'i');
      const excluded = (opts.exclude || []).map((x) => new RegExp(x, 'i'));
      const els = [...document.querySelectorAll('div, span, td, li, button, a, [role="menuitem"]')]
        .filter((e) => isVisible(e))
        .filter((e) => {
          const t = (e.innerText || '').trim();
          return t.length > 0 && t.length <= 60 && wanted.test(t) && !excluded.some((x) => x.test(t));
        });
      if (!els.length) return null;
      const el = els[els.length - 1];
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.innerText || '').trim().slice(0, 40) };
    `));
    if (box) {
      console.log(`[posman] clicking menu item: "${box.text}"`);
      await realClick(page, box);
      return box.text;
    }
  }
  return null;
}

/**
 * Handle the close/modify dialog that MT5 opens for a position:
 *  - optionally rewrite the Volume field (partial close)
 *  - click the yellow "Close" button (exact text, real mouse)
 *  - report terminal errors ("invalid stops", "off quotes", ...)
 */
async function confirmCloseDialog(page, { fraction = 1, lot = null, waitMs = 10000 } = {}) {
  const deadline = Date.now() + waitMs;
  let dialogSeen = false;

  while (Date.now() < deadline) {
    const dlg = await page.evaluate(expr(`
      const modal = [...document.querySelectorAll('.page-window.modal')]
        .find((m) => !/hidden/.test(m.className || '') && isVisible(m));
      const volInput = modal
        ? modal.querySelector('input#volume')
        : [...document.querySelectorAll('input')].find((i) => isVisible(i) && i.id === 'volume');
      const scope = modal || document;
      let closeBtn = null;
      const btns = [...scope.querySelectorAll('button, .input-button, [role="button"]')]
        .filter((b) => isVisible(b) && !b.disabled)
        .filter((b) => /^close( position)?$/i.test((b.innerText || '').trim()));
      if (btns.length) {
        const r = btns[0].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          closeBtn = { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (btns[0].innerText || '').trim().slice(0, 30) };
        }
      }
      return {
        modalFound: !!modal,
        volPresent: !!volInput,
        volValue: volInput ? volInput.value : null,
        closeBtn,
        title: modal ? ((modal.querySelector('.h') || {}).innerText || '').trim().slice(0, 40) : '',
      };
    `));

    if (dlg.volPresent) dialogSeen = true;

    if (dlg.closeBtn && (dlg.volPresent || dlg.modalFound || dialogSeen)) {
      // partial close: rewrite the prefilled volume first
      if (fraction < 1 && dlg.volPresent && lot > 0) {
        const want = closeVolumeFor({ lot }, fraction);
        if (want.ok && !want.full) {
          const volHandle = await page.evaluateHandle(expr(`
            const modal = [...document.querySelectorAll('.page-window.modal')]
              .find((m) => !/hidden/.test(m.className || '') && isVisible(m));
            return (modal && modal.querySelector('input#volume'))
              || [...document.querySelectorAll('input')].find((i) => isVisible(i) && i.id === 'volume')
              || null;
          `));
          const volEl = volHandle.asElement();
          if (volEl) {
            await clearAndType(page, volEl, String(want.volume));
            console.log(`[posman] partial close: volume set to ${want.volume} (of ${lot})`);
            await sleep(600);
          }
        }
      }
      console.log(`[posman] clicking close dialog button: "${dlg.closeBtn.text}" (dialog: ${dlg.title || 'n/a'})`);
      await realClick(page, dlg.closeBtn);
      await sleep(2500);
      const err = await readTicketError(page).catch(() => null);
      await screenshot(page, 'pos-closed');
      if (err) return { confirmed: false, errorText: err };
      return { confirmed: true, errorText: null };
    }
    await sleep(700);
  }

  await screenshot(page, 'pos-closed-timeout');
  return { confirmed: false, errorText: dialogSeen ? null : 'no close dialog appeared' };
}

/* ---------------- close strategies ---------------- */

async function closePositionOp(page, pos, { fraction = 1 } = {}) {
  const pair = pos.terminalSymbol || pos.pair;
  await openTradeTab(page);
  let row = await findPositionRow(page, pos);
  if (!row) throw new Error(`position ${pair} not visible in the Trade tab (screenshot saved)`);
  await screenshot(page, 'pos-row');

  // ---- Strategy A: select row -> right-click -> "Close position" ----
  try {
    const r = await row.boundingBox();
    if (r) {
      // click near the symbol cell (left side), not the far-right profit/X area
      const center = { x: r.x + Math.min(r.width / 2, 220), y: r.y + r.height / 2 };
      await realClick(page, center); // GWT often needs the row selected/focused first
      await realRightClick(page, center);
      const items = await listMenuTexts(page);
      console.log('[posman] context menu items:', JSON.stringify(items));
      await screenshot(page, 'pos-context');
      if (items.length) {
        const clicked = await clickMenuText(
          page,
          ['^close position$', '^close$', '^close position\\b'],
          ['close (all|by)'],
        );
        if (clicked) {
          const res = await confirmCloseDialog(page, { fraction, lot: pos.lot });
          if (res.confirmed || res.errorText) return res;
        }
      }
    }
  } catch (e) {
    console.warn('[posman] close strategy A (context menu) failed:', e.message);
    await screenshot(page, 'close-strategy-a-fail').catch(() => {});
  }

  // ---- Strategy B: double-click the row -> close dialog directly ----
  try {
    row = (await findPositionRow(page, pos)) || row;
    const r = await row.boundingBox();
    if (r) {
      console.log('[posman] close strategy B: double-clicking the position row');
      await page.mouse.click(r.x + Math.min(r.width / 2, 220), r.y + r.height / 2, { clickCount: 2 });
      await sleep(2000);
      const res = await confirmCloseDialog(page, { fraction, lot: pos.lot });
      if (res.confirmed || res.errorText) return res;
    }
  } catch (e) {
    console.warn('[posman] close strategy B (double-click) failed:', e.message);
    await screenshot(page, 'close-strategy-b-fail').catch(() => {});
  }

  // ---- Strategy C: right-click again, accept ANY close-ish item (loose) ----
  try {
    row = (await findPositionRow(page, pos)) || row;
    const r = await row.boundingBox();
    if (r) {
      const center = { x: r.x + Math.min(r.width / 2, 220), y: r.y + r.height / 2 };
      await realRightClick(page, center);
      const items = await listMenuTexts(page);
      console.log('[posman] strategy C context menu items:', JSON.stringify(items));
      const clicked = await clickMenuText(page, ['close'], ['close (all|by)']);
      if (clicked) {
        const res = await confirmCloseDialog(page, { fraction, lot: pos.lot });
        if (res.confirmed || res.errorText) return res;
      }
    }
  } catch (e) {
    console.warn('[posman] close strategy C (loose menu match) failed:', e.message);
    await screenshot(page, 'close-strategy-c-fail').catch(() => {});
  }

  await screenshot(page, 'close-exhausted');
  throw new Error('could not open a Close dialog via context menu or double-click (3 strategies tried — screenshots saved)');
}

/* ---------------- modify SL / TP ---------------- */

async function modifyFieldOp(page, pos, label, value) {
  const pair = pos.terminalSymbol || pos.pair;
  await openTradeTab(page);
  const row = await findPositionRow(page, pos);
  if (!row) throw new Error(`position ${pair} not visible in the Trade tab (screenshot saved)`);
  await screenshot(page, 'pos-row');
  // double-click the row to open the Modify dialog
  const r = await row.boundingBox();
  if (!r) throw new Error(`position ${pair} row has no box (screenshot saved)`);
  await page.mouse.click(r.x + Math.min(r.width / 2, 220), r.y + r.height / 2, { clickCount: 2 });
  await sleep(2000);

  const field = await fieldForLabel(page, label);
  let el = field && field.asElement();
  if (!el) {
    const args = JSON.stringify({ label });
    const handle = await page.evaluateHandle(expr(`
      const opts = ${args};
      const modal = [...document.querySelectorAll('.page-window.modal')]
        .find((m) => !/hidden/.test(m.className || '') && isVisible(m));
      const scope = modal || document;
      const id = /stop/i.test(opts.label) ? 'sl' : 'tp';
      return scope.querySelector('input#' + id) || null;
    `));
    el = handle.asElement();
  }
  if (!el) {
    await screenshot(page, 'modify-dialog');
    throw new Error(`Modify dialog has no "${label}" field (screenshot saved)`);
  }
  await clearAndType(page, el, String(value));
  await sleep(800);
  const okClicked = await page.evaluate(expr(`
    const btn = [...document.querySelectorAll('button')]
      .find((b) => isVisible(b) && /^(ok|modify)$/i.test((b.innerText || '').trim()));
    if (btn) { btn.click(); return true; }
    return false;
  `));
  if (!okClicked) {
    await screenshot(page, 'modify-ok');
    throw new Error('Modify dialog OK/Modify button not found (screenshot saved)');
  }
  await sleep(2500);
  const err = await readTicketError(page).catch(() => null);
  await screenshot(page, 'modify-done');
  console.log(`[posman] modify ${pair} ${label} -> ${value}: ok=${okClicked}${err ? ' error=' + err : ''}`);
  if (err) throw new Error(`terminal rejected the ${label} change: ${err}`);
  return { ok: okClicked };
}

/* ---------------- shared browser session ---------------- */

async function withTerminal(fn) {
  let browser, page;
  try {
    ({ browser, page } = await loginPage());
    return await fn(page);
  } catch (e) {
    if (page) await screenshot(page, 'mgmt-error').catch(() => {});
    console.error('[posman] FAILED:', e.message);
    throw e;
  } finally {
    try { if (browser) await browser.close(); } catch {}
    console.log('[posman] browser closed (memory released)');
  }
}

function matchFor(pos) { return { ticketId: pos.ticketId || null, pair: pos.pair }; }

/* ---------------- owner command execution ---------------- */

/**
 * Execute a parsed owner command (see src/commands.js).
 * Types handled here: close | breakeven | sl | tp  (browser operations).
 * Returns a WhatsApp-ready message string.
 */
async function handleOwnerCommand(cmd) {
  const { listPositions, updatePosition, removePosition } = require('./positions');

  if (!cmd) return '❌ Empty command.';

  if (cmd.type === 'close') {
    const positions = listPositions();
    if (!positions.length && !cmd.pair && !cmd.ticketId) {
      return 'ℹ️ No tracked positions to close. (If the bot restarted, tracking reset — use /verify to see the terminal, or close it in the MT app manually.)';
    }
    const targets = positions.length
      ? resolveTargets(positions, cmd)
      : [{ pair: cmd.pair, terminalSymbol: cmd.pair, ticketId: cmd.ticketId, lot: null }]; // untracked -> try the terminal directly
    if (!targets.length) {
      return `❌ No tracked position matches ${describeSelector(cmd) || 'that selector'}. Run /positions to see the numbering.`;
    }

    return withTerminal(async (page) => {
      const parts = [];
      for (const pos of targets) {
        const name = pos.terminalSymbol || pos.pair;
        try {
          const vol = closeVolumeFor(pos, cmd.fraction ?? 1);
          if (!vol.ok) { parts.push(`⚠️ ${name}: ${vol.reason}`); continue; }
          const res = await closePositionOp(page, pos, { fraction: cmd.fraction ?? 1 });
          if (res.confirmed) {
            if (vol.full) removePosition(matchFor(pos));
            else updatePosition(matchFor(pos), { lot: vol.remaining });
            parts.push(`✅ ${name} ${vol.full ? 'closed' : `partially closed — ${vol.volume} of ${pos.lot} lot closed, ${vol.remaining} left`} ✔${vol.note ? ` (${vol.note})` : ''}`);
          } else {
            parts.push(`⚠️ ${name}: close sent but NOT confirmed — verify in the terminal${res.errorText ? ` (terminal said: ${res.errorText})` : ''}`);
          }
        } catch (e) {
          parts.push(`❌ ${name}: ${e.message}`);
        }
      }
      return parts.join('\n') || 'ℹ️ Nothing to do.';
    }).catch((e) => `❌ Could not close: ${e.message}`);
  }

  if (cmd.type === 'breakeven') {
    const positions = listPositions();
    if (!positions.length) return 'ℹ️ No tracked positions. Use /verify to check the terminal.';
    const targets = resolveTargets(positions, cmd);
    if (!targets.length) return `❌ No tracked position matches ${describeSelector(cmd) || 'that selector'}.`;

    return withTerminal(async (page) => {
      const parts = [];
      for (const pos of targets) {
        const name = pos.terminalSymbol || pos.pair;
        if (pos.entry == null) { parts.push(`⚠️ ${name}: entry price unknown — cannot compute breakeven`); continue; }
        let newSl = Number(pos.entry);
        if (cmd.pips != null) {
          const delta = Math.abs(cmd.pips) * pipSize(pos.pair);
          newSl = cmd.pips >= 0
            ? (pos.side === 'BUY' ? pos.entry + delta : pos.entry - delta)
            : (pos.side === 'BUY' ? pos.entry - delta : pos.entry + delta);
          newSl = Math.round(newSl * 100) / 100;
        }
        try {
          await modifyFieldOp(page, pos, 'Stop Loss', newSl);
          updatePosition(matchFor(pos), { sl: newSl });
          parts.push(`✅ ${name} SL → ${newSl} (breakeven${cmd.pips != null ? ' ' + (cmd.pips > 0 ? '+' : '') + cmd.pips + ' pips' : ''}) ✔`);
        } catch (e) {
          parts.push(`❌ ${name}: ${e.message}`);
        }
      }
      return parts.join('\n');
    }).catch((e) => `❌ Could not set breakeven: ${e.message}`);
  }

  if (cmd.type === 'sl' || cmd.type === 'tp') {
    if (cmd.price == null) return `Usage: /${cmd.type} <price> [position# | #ticket | pair]\nExample: /${cmd.type} 4600 2`;
    const positions = listPositions();
    if (!positions.length) return 'ℹ️ No tracked positions. Use /verify to check the terminal.';
    const targets = resolveTargets(positions, cmd);
    if (!targets.length) return `❌ No tracked position matches ${describeSelector(cmd) || 'that selector'}.`;

    const label = cmd.type === 'sl' ? 'Stop Loss' : 'Take Profit';
    const field = cmd.type === 'sl' ? 'sl' : 'tp';
    return withTerminal(async (page) => {
      const parts = [];
      for (const pos of targets) {
        const name = pos.terminalSymbol || pos.pair;
        try {
          await modifyFieldOp(page, pos, label, cmd.price);
          updatePosition(matchFor(pos), { [field]: cmd.price });
          parts.push(`✅ ${name} ${label} → ${cmd.price} ✔`);
        } catch (e) {
          parts.push(`❌ ${name}: ${e.message}`);
        }
      }
      return parts.join('\n');
    }).catch((e) => `❌ Could not set ${label}: ${e.message}`);
  }

  return null; // not a browser command
}

/**
 * Screenshot of the terminal right now (for the /shot owner command).
 * Returns { ok, path?, message }.
 */
async function terminalScreenshot() {
  try {
    return await withTerminal(async (page) => {
      await sleep(1500);
      const p = await screenshot(page, 'manual-shot');
      return { ok: true, path: p };
    });
  } catch (e) {
    return { ok: false, message: `❌ Could not screenshot the terminal: ${e.message}` };
  }
}

/* ---------------- legacy management instructions (channel msgs) ---------------- */

/**
 * Apply a management action parsed from a CHANNEL message
 * (instruction: { action, target, price, pips, pair, message }).
 * Kept backward compatible with the v0.3 Gemini/rules pipeline.
 */
async function applyManagement(instruction) {
  if (!instruction || !instruction.action) return { ok: false, message: 'no action' };
  const { listPositions, removePosition } = require('./positions');

  // "BE tapped"/"BE hit" — the trade ALREADY closed at breakeven in the broker.
  if (instruction.action === 'breakeven_hit') {
    const positions = listPositions();
    if (!positions.length) {
      return { ok: true, message: 'ℹ️ BE hit noted — no tracked position to update.' };
    }
    let pos = positions[positions.length - 1];
    if (instruction.pair) {
      const t = resolveTargets(positions, { pair: instruction.pair });
      if (t.length) pos = t[0];
    }
    removePosition(matchFor(pos));
    console.log(`[posman] ${pos.pair} hit breakeven — marked closed at entry (no browser action)`);
    return { ok: true, message: `✅ ${pos.terminalSymbol || pos.pair} hit breakeven — closed at entry (tracking updated)` };
  }

  if (instruction.action === 'close_position') {
    const message = await handleOwnerCommand({ type: 'close', pair: instruction.pair || null, fraction: 1 });
    return { ok: !/^❌/.test(message), message };
  }

  if (instruction.action === 'modify_sl') {
    const { resolveNewSl } = require('./manage');
    const positions = listPositions();
    if (!positions.length) return { ok: false, message: `ℹ️ "${instruction.message || 'SL change'}" — but no open position is tracked (bot restarted?). Manage it in the terminal.` };
    const [pos] = resolveTargets(positions, { pair: instruction.pair || null });
    const newSl = resolveNewSl(instruction, pos);
    if (newSl == null) return { ok: false, message: `❌ cannot compute new SL from "${instruction.message}"` };
    const message = await handleOwnerCommand({ type: 'sl', price: newSl, pair: instruction.pair || null }).catch((e) => `❌ ${e.message}`);
    return { ok: !/^❌/.test(message), message };
  }

  if (instruction.action === 'modify_tp') {
    if (instruction.target !== 'price' || instruction.price == null) {
      return { ok: false, message: `❌ TP instruction "${instruction.message}" has no clear price` };
    }
    const message = await handleOwnerCommand({ type: 'tp', price: instruction.price, pair: instruction.pair || null }).catch((e) => `❌ ${e.message}`);
    return { ok: !/^❌/.test(message), message };
  }

  return { ok: false, message: `ℹ️ "${instruction.message || 'no-op'}" — informational only, nothing executed.` };
}

module.exports = {
  applyManagement,
  handleOwnerCommand,
  terminalScreenshot,
  closePositionOp,
  modifyFieldOp,
  findPositionRow,
};
