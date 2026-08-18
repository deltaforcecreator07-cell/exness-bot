'use strict';

/**
 * Gemini API client — tiny, dependency-free (uses global fetch, Node >= 18).
 *
 * Purpose: translate the trader's spoken Roman-Urdu management instructions
 * into structured actions:
 *   "50 pips pa breakeven kar dana"   -> { action:'modify_sl', target:'breakeven', pips:50 }
 *   "trade close kardo"               -> { action:'close_position' }
 *   "SL 401 pe rakhna"                -> { action:'modify_sl', target:'price', price:4401 }
 *   "TRAIL SL TO 93"                  -> { action:'modify_sl', target:'price', price:4393 }
 *
 * Model (configurable, comma-separated fallback chain):
 *   GEMINI_MODEL=gemini-3.6-flash,gemini-2.5-flash
 * Free API key from Google AI Studio: https://aistudio.google.com/apikey
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateText(prompt, { maxOutputTokens = 700, temperature = 0.1, timeoutMs = 25000 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const models = (process.env.GEMINI_MODEL || DEFAULT_MODELS[0])
    .split(',').map((s) => s.trim()).filter(Boolean);

  let lastErr;
  for (const model of models) {
    try {
      return await callModel(model, key, prompt, { maxOutputTokens, temperature, timeoutMs });
    } catch (e) {
      lastErr = e;
      console.warn(`[gemini] model "${model}" failed: ${e.message}`);
    }
  }
  throw lastErr;
}

async function callModel(model, key, prompt, cfg) {
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: cfg.temperature, maxOutputTokens: cfg.maxOutputTokens },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (res.status === 429) {
        console.warn(`[gemini] rate limited (429), backoff ${attempt}s...`);
        await sleep(attempt * 1000 + Math.random() * 500);
        continue;
      }
      if (!res.ok) {
        const txt = (await res.text()).slice(0, 200);
        const err = new Error(`HTTP ${res.status}: ${txt}`);
        if (res.status === 404) err.modelNotFound = true;
        throw err;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('empty response');
      return text.trim();
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error('rate limited after retries (429)');
}

/** Tolerant JSON extraction: strip code fences, find the first balanced {...} */
function parseJsonLoose(text) {
  if (!text) return null;
  let s = text.replace(/```json|```/g, '').trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  s = s.slice(start);
  try { return JSON.parse(s); } catch {}
  // fallback: walk braces to find a parseable object
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(0, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

module.exports = { generateText, parseJsonLoose };
