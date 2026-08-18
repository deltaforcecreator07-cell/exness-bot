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

/** Record a position after a successful execution. */
function addPosition(sig, result) {
  const list = load();
  const pos = {
    id: crypto.createHash('sha1').update(Date.now() + sig.pair + Math.random()).digest('hex').slice(0, 10),
    pair: sig.pair,
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
  const idx = list.findIndex((p) => p.pair === pair);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  save(list);
  return list[idx];
}

/** Remove a tracked position (after successful close). */
function closeTracked(pair) {
  const list = load();
  const i = list.findIndex((p) => p.pair === pair);
  if (i === -1) return null;
  const [removed] = list.splice(i, 1);
  save(list);
  return removed;
}

function listPositions() { return load(); }
function latestPosition() { const l = load(); return l.length ? l[l.length - 1] : null; }

module.exports = { addPosition, updatePosition, closeTracked, listPositions, latestPosition };
