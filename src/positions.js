'use strict';

/**
 * In-memory + persisted tracking of positions WE opened (so management
 * instructions — close, move SL, trail to breakeven — have something to act on).
 *
 * State lives in .runtime/state/positions.json (ephemeral on Render — if the
 * instance is recycled, tracking resets; the terminal still holds the real
 * position, and management falls back to searching the terminal by pair).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { symbolsMatch } = require('./fill-evidence');

const STATE_DIR = path.join(__dirname, '..', '.runtime', 'state');
const FILE = path.join(STATE_DIR, 'positions.json');

function load() {
  try { const l = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(l) ? l : []; }
  catch { return []; }
}
function save(list) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list));
}

function findIndexByPair(list, pair) {
  return list.findIndex((p) =>
    p.pair === pair
    || symbolsMatch(p.pair, pair)
    || symbolsMatch(p.terminalSymbol, pair));
}

function extractTicketId(result) {
  if (!result) return null;
  if (result.ticketId) return result.ticketId;
  if (!result.evidence) return null;
  try {
    const ev = typeof result.evidence === 'string' ? JSON.parse(result.evidence) : result.evidence;
    return (ev && ev.ticket) || null;
  } catch { return null; }
}

/** Record a position after a successful execution. */
function addPosition(sig, result) {
  const list = load();
  const terminalSymbol = (result && (result.terminalSymbol || result.pair)) || sig.pair;
  const pos = {
    id: crypto.createHash('sha1').update(Date.now() + sig.pair + Math.random()).digest('hex').slice(0, 10),
    pair: sig.pair,
    terminalSymbol,
    ticketId: extractTicketId(result),
    side: sig.action,
    lot: sig.lot,
    entry: sig.entry ?? (sig.entryLow != null && sig.entryHigh != null
      ? (sig.entryLow + sig.entryHigh) / 2
      : null),
    sl: sig.sl ?? null,
    tp: sig.tp ?? null,
    openedAt: Date.now(),
  };
  list.push(pos);
  save(list);
  return pos;
}

function updatePosition(pair, patch) {
  const list = load();
  const idx = findIndexByPair(list, pair);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  save(list);
  return list[idx];
}

/** Remove a tracked position (after successful close). */
function closeTracked(pair) {
  const list = load();
  const i = findIndexByPair(list, pair);
  if (i === -1) return null;
  const [removed] = list.splice(i, 1);
  save(list);
  return removed;
}

function listPositions() { return load(); }
function latestPosition() { const l = load(); return l.length ? l[l.length - 1] : null; }

/* ---------------- last-signal memory (auto-retry + /retake) ---------------- */

const LAST_SIGNAL_FILE = path.join(STATE_DIR, 'last-signal.json');

/**
 * Remember the most recent trade signal.
 * executed=true means it was already traded (or permanently rejected) — the
 * bot will NOT auto-retry it. executed=false (fresh or failed) = the bot
 * auto-retries it on the next startup/connect, so a crash or OOM never loses
 * a trade.
 */
function saveLastSignal(sig) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LAST_SIGNAL_FILE, JSON.stringify({ sig, executed: false, at: Date.now() }));
  } catch (e) { console.warn('[positions] saveLastSignal failed:', e.message); }
}

/** Mark the last signal as executed so it is NOT auto-retried. */
function markLastSignalExecuted() {
  try {
    const d = JSON.parse(fs.readFileSync(LAST_SIGNAL_FILE, 'utf8'));
    d.executed = true;
    fs.writeFileSync(LAST_SIGNAL_FILE, JSON.stringify(d));
  } catch (e) { /* no file — ignore */ }
}

/** Load the full record { sig, executed, at } (null if none / expired). */
function loadLastSignalRecord(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const d = JSON.parse(fs.readFileSync(LAST_SIGNAL_FILE, 'utf8'));
    if (!d || !d.sig) return null;
    if (Date.now() - (d.at || 0) > maxAgeMs) return null;
    return d;
  } catch { return null; }
}

/** Load just the signal (null if none / expired / already executed). */
function loadLastSignal(maxAgeMs = 24 * 60 * 60 * 1000) {
  const rec = loadLastSignalRecord(maxAgeMs);
  return rec ? rec.sig : null;
}

module.exports = {
  addPosition, updatePosition, closeTracked, listPositions, latestPosition,
  saveLastSignal, loadLastSignal, loadLastSignalRecord, markLastSignalExecuted,
};
