'use strict';

/**
 * DOM discovery tool — THE most important debugging tool for this project.
 *
 * Exness/MetaQuotes change the terminal's CSS class names on every deployment,
 * so you can't trust hardcoded classes. Run this after you log in once, and it
 * saves runtime/dom-dump.json + runtime/dom-dump.html containing every input,
 * button, select and visible text on the page. Use that output to update
 * src/selectors.json and the match-strings in exness-executor.js.
 *
 * Usage:  npm run dump-dom
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loginPage } = require('./exness-executor');

const RUNTIME = path.join(__dirname, '..', '.runtime');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { browser, page } = await loginPage();
  console.log('[dump-dom] logged in, pressing F9 to open the order ticket (if possible)...');
  try { await page.keyboard.press('F9'); } catch {}
  await sleep(4000);

  const data = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].map((i) => ({
      tag: 'input', name: i.name, id: i.id, type: i.type,
      placeholder: i.placeholder, cls: i.className, html: i.outerHTML.slice(0, 250),
    }));
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
      .map((b) => ({
        tag: b.tagName, text: (b.innerText || b.value || '').trim().slice(0, 60),
        cls: b.className, html: b.outerHTML.slice(0, 250),
      }));
    const selects = [...document.querySelectorAll('select')].map((s) => ({
      tag: 'select', name: s.name, cls: s.className, html: s.outerHTML.slice(0, 250),
    }));
    const texts = [...new Set(
      [...document.querySelectorAll('body *')]
        .filter((el) => el.childElementCount === 0)
        .map((el) => (el.innerText || el.textContent || '').trim())
        .filter((t) => t && t.length < 80)
    )].slice(0, 400);
    return { url: location.href, inputs, buttons, selects, texts };
  });

  fs.mkdirSync(RUNTIME, { recursive: true });
  fs.writeFileSync(path.join(RUNTIME, 'dom-dump.json'), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(RUNTIME, 'dom-dump.html'), await page.content());
  console.log('[dump-dom] saved runtime/dom-dump.json and runtime/dom-dump.html');
  console.log('[dump-dom] URL:', data.url);
  console.log('[dump-dom] ---- INPUTS ----');
  data.inputs.forEach((i) => console.log('  ', JSON.stringify(i)));
  console.log('[dump-dom] ---- BUTTONS ----');
  data.buttons.forEach((b) => console.log('  ', JSON.stringify(b)));
  console.log('[dump-dom] ---- SELECTS ----');
  data.selects.forEach((s) => console.log('  ', JSON.stringify(s)));
  console.log('[dump-dom] ---- VISIBLE TEXTS (first 100) ----');
  data.texts.slice(0, 100).forEach((t) => console.log('  ', t));

  await browser.close();
  console.log('[dump-dom] done. Update src/selectors.json if you see new class names.');
}

main().catch((e) => { console.error('[dump-dom] failed:', e.message); process.exit(1); });
