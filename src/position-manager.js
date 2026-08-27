'use strict';

/**
 * Position management in the MetaTrader Web Terminal (close / modify SL / TP).
 *
 * IMPORTANT — this is the least stable part of the whole project, because the
 * GWT terminal renders positions in a virtualized grid whose DOM changes with
 * every MetaQuotes deployment. Everything is done by TEXT and saved with
 * screenshots so that when a step drifts, the screenshot shows exactly where.
 *
 * The flow per operation:
 *   close:       open Trade tab -> find the position row (by pair) ->
 *                right-click -> "Close position" -> confirm
 *   modify SL:   find the row -> double-click (Modify) -> SL field by label ->
 *                type new SL -> OK
 *   modify TP:   same as SL but the TP field
 *
 * If a step cannot be completed, we THROW with a clear message and the
 * screenshot path; the bot replies with that so the user can do it manually
 * or run `npm run dump-dom` to re-map the terminal layout.
 */
const { loginPage, clickVisibleText, clearAndType, fieldForLabel, screenshot, sleep } = require('./exness-executor');
const { symbolNeedles, symbolsMatch } = require('./fill-evidence');

/* ---------------- low-level terminal ops ---------------- */

async function openTradeTab(page) {
  await clickVisibleText(page, ['Trade', 'Toolbox'], 5000).catch(() => {});
  await sleep(1500);
}

async function findPositionRow(page, pair) {
  const needles = symbolNeedles(pair);
  const handle = await page.evaluateHandle((syms) => {
    const up = (syms || []).map((s) => String(s).toUpperCase());
    const cells = [...document.querySelectorAll('td, span, div')]
      .filter((c) => c.offsetParent !== null && c.childElementCount === 0);
    const cell = cells.find((c) => up.includes((c.innerText || '').trim().toUpperCase()));
    if (!cell) return null;
    // walk up to a row-ish container
    let el = cell;
    for (let i = 0; i < 3 && el; i++) {
      el = el.parentElement;
      if (el && (el.tagName === 'TR' || /row/i.test(el.className || ''))) return el;
    }
    return cell.parentElement || null;
  }, needles);
  const el = handle.asElement();
  return el || null;
}

async function rightClickElement(page, el) {
  await el.click({ button: 'right' });
  await sleep(1200);
}

async function clickContextItem(page, textRe) {
  return page.evaluate((re) => {
    const wanted = new RegExp(re, 'i');
    const el = [...document.querySelectorAll('div, span, td, button, li')]
      .filter((e) => e.offsetParent !== null && e.childElementCount === 0)
      .find((e) => wanted.test(e.innerText || ''));
    if (el) { el.click(); return (el.innerText || '').trim(); }
    return null;
  }, textRe);
}

/* ---------------- operations ---------------- */

/** Real-mouse right-click on an element (GWT needs real events). */
async function realRightClick(page, box) {
  await page.mouse.move(box.x, box.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await sleep(1000);
}

/** Click the first visible element whose text matches (real mouse at coords). */
async function realClickText(page, regex) {
  const box = await page.evaluate((re) => {
    const el = [...document.querySelectorAll('div, span, td, li, button, a')]
      .filter(e => e.offsetParent !== null && e.childElementCount === 0)
      .find(e => new RegExp(re, 'i').test((e.innerText || '').trim()));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, regex);
  if (!box) return null;
  await page.mouse.click(box.x, box.y);
  await sleep(800);
  return box;
}

async function closePositionOp(page, pair) {
  await openTradeTab(page);
  const row = await findPositionRow(page, pair);
  if (!row) throw new Error(`position ${pair} not visible in the Trade tab (screenshot saved)`);
  const r = await row.boundingBox();
  if (!r) throw new Error(`position ${pair} row has no box (screenshot saved)`);
  await screenshot(page, 'pos-row');
  // real right-click on the row
  await realRightClick(page, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const item = await realClickText(page, '^Close (Position)?$|^Close by$|Close position');
  if (!item) {
    await screenshot(page, 'pos-context');
    throw new Error('right-click menu did not show "Close" (screenshot saved)');
  }
  await sleep(1500);
  // confirm: a confirmation dialog may appear with a "Close" button — click it
  let confirmed = false;
  const closeBtn = await realClickText(page, '^Close$');
  if (closeBtn) confirmed = true;
  await sleep(3000);
  await screenshot(page, 'pos-closed');
  console.log(`[posman] close ${pair}: menu clicked, confirmed=${confirmed}`);
  return { confirmed };
}

async function modifyFieldOp(page, pair, label, value) {
  await openTradeTab(page);
  const row = await findPositionRow(page, pair);
  if (!row) throw new Error(`position ${pair} not visible in the Trade tab (screenshot saved)`);
  await screenshot(page, 'pos-row');
  // double-click the row to open the Modify dialog
  await row.click({ clickCount: 2 });
  await sleep(2000);
  const field = await fieldForLabel(page, label);
  if (!field.asElement()) {
    await screenshot(page, 'modify-dialog');
    throw new Error(`Modify dialog has no "${label}" field (screenshot saved)`);
  }
  await clearAndType(page, field.asElement(), String(value));
  await sleep(800);
  const okClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.offsetParent !== null && /^OK$/i.test((b.innerText || '').trim()));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!okClicked) {
    await screenshot(page, 'modify-ok');
    throw new Error('Modify dialog OK button not found (screenshot saved)');
  }
  await sleep(2500);
  await screenshot(page, 'modify-done');
  console.log(`[posman] modify ${pair} ${label} -> ${value}: ok=${okClicked}`);
  return { ok: okClicked };
}

/* ---------------- public API ---------------- */

/**
 * Apply a management action to a tracked position.
 * instruction: { action, target, price, pips, pair, message }
 * Returns { ok, message }.
 */
async function applyManagement(instruction) {
  if (!instruction || !instruction.action) return { ok: false, message: 'no action' };
  const { listPositions, updatePosition, closeTracked } = require('./positions');

  const positions = listPositions();
  if (!positions.length) {
    if (instruction.action === 'breakeven_hit') {
      return { ok: true, message: `ℹ️ BE hit noted — no tracked position to update.` };
    }
    return { ok: false, message: `ℹ️ "${instruction.message || 'instruction'}" — but no open position is tracked (bot restarted?). Manage it in the terminal.` };
  }
  // pick: pair mentioned in the message, else most recent
  let pos = positions[positions.length - 1];
  if (instruction.pair) {
    const byPair = positions.find((p) =>
      symbolsMatch(p.pair, instruction.pair)
      || symbolsMatch(p.terminalSymbol, instruction.pair)
      || String(p.pair).toUpperCase() === String(instruction.pair).toUpperCase());
    if (byPair) pos = byPair;
  }

  const pair = pos.terminalSymbol || pos.pair;

  // "BE tapped"/"BE hit" — the trade ALREADY closed at breakeven in the broker
  // (the SL had been moved to entry and got hit). No browser action needed;
  // just drop tracking and confirm.
  if (instruction.action === 'breakeven_hit') {
    closeTracked(pair);
    console.log(`[posman] ${pair} hit breakeven — marked closed at entry (no browser action)`);
    return { ok: true, message: `✅ ${pair} hit breakeven — closed at entry (tracking updated)` };
  }

  let browser, page;
  try {
    console.log(`[posman] launching browser for ${instruction.action} on ${pair}...`);
    ({ browser, page } = await loginPage());

    switch (instruction.action) {
      case 'close_position': {
        const { confirmed } = await closePositionOp(page, pair);
        closeTracked(pair);
        return { ok: true, message: `✅ ${pair} closed` + (confirmed ? ' ✔' : ' — verify in terminal') };
      }
      case 'modify_sl': {
        const { resolveNewSl } = require('./manage');
        const newSl = resolveNewSl(instruction, pos);
        if (newSl == null) return { ok: false, message: `❌ cannot compute new SL from "${instruction.message}"` };
        const { ok } = await modifyFieldOp(page, pair, 'Stop Loss', newSl);
        updatePosition(pair, { sl: newSl });
        return { ok, message: ok ? `✅ ${pair} SL → ${newSl}` : `⚠️ ${pair} SL change — verify in terminal` };
      }
      case 'modify_tp': {
        if (instruction.target !== 'price' || instruction.price == null) {
          return { ok: false, message: `❌ TP instruction "${instruction.message}" has no clear price` };
        }
        const { ok } = await modifyFieldOp(page, pair, 'Take Profit', instruction.price);
        updatePosition(pair, { tp: instruction.price });
        return { ok, message: ok ? `✅ ${pair} TP → ${instruction.price}` : `⚠️ ${pair} TP change — verify in terminal` };
      }
      default:
        return { ok: false, message: `ℹ️ "${instruction.message || 'no-op'}" — informational only, nothing executed.` };
    }
  } catch (e) {
    if (page) await screenshot(page, 'mgmt-error').catch(() => {});
    console.error('[posman] FAILED:', e.message);
    return { ok: false, message: `❌ Could not ${instruction.action} on ${pair}: ${e.message}` };
  } finally {
    try { if (browser) await browser.close(); } catch {}
    console.log('[posman] browser closed (memory released)');
  }
}

module.exports = { applyManagement };
