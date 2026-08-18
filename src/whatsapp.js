'use strict';

/**
 * WhatsApp side (Baileys 7).
 *
 * v0.4 — WhatsApp CHANNEL support (primary signal source):
 *  "THE SHARKS" is a WhatsApp Channel (https://whatsapp.com/channel/0029VarqpJRCXC3E4nNcRv05),
 *  NOT a group. Channels are one-way broadcasts with JIDs ending in @newsletter.
 *  Differences vs groups handled here:
 *   - channel JIDs end with @newsletter (groups: @g.us)
 *   - no participant phone to check — the channel itself is the trusted source
 *   - you CANNOT reply inside a channel -> confirmations go to the owner's DM
 *     (first ALLOWED_SENDERS entry) or are logged only
 *   - the account must FOLLOW the channel (newsletterFollow + newsletterUnmute
 *     are attempted on connect; or simply follow it with the linked phone)
 *
 * Group support is kept as a fallback source (ALLOWED_GROUPS), so the bot
 * can read the same trader from a group too if needed.
 *
 * Multi-message signal handling (Sharks style):
 *  msg1 "GOLD BUY 4391-93" + "SL 85"  -> base signal, held as pending
 *  msg2 "TP 4401" "TP 4410"           -> TP attaches -> trade fires
 *  management noise / react-bait / member chatter -> ignored
 */
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidNewsletter,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { parseTradeMessage } = require('./parser');
const { senderAllowed, isProvider, validateSignal, markExecuted, todayStats } = require('./risk');
const { execute } = require('./executor');
const { classifyManagement } = require('./manage');
const { applyManagement } = require('./position-manager');
const { addPosition, listPositions } = require('./positions');

const SESSION_DIR = path.join(__dirname, '..', '.runtime', 'sessions');
const TP_WINDOW_MS = Number(process.env.TRADE_TP_WINDOW_MS || 5 * 60 * 1000);

/* ---------------- signal-source config ---------------- */

const allowedGroupNames = (process.env.ALLOWED_GROUPS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const allowedGroupJids = new Set(
  (process.env.ALLOWED_GROUP_JIDS || '').split(',').map(s => s.trim()).filter(Boolean),
);

// WhatsApp Channel(s): bare id ("0029VarqpJRCXC3E4nNcRv05") and/or full jid ("...@newsletter")
function channelConfig() {
  const ids = (process.env.ALLOWED_CHANNELS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(c => c.endsWith('@newsletter') ? c : c + '@newsletter');
  const names = (process.env.ALLOWED_CHANNEL_NAMES || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return { jids: ids, names };
}
const allowedChannelIds = channelConfig().jids;
const allowedChannelNames = channelConfig().names;

let sock = null;
let pending = null; // { sig, at }
const startedAt = Date.now();
const groupNameCache = new Map();   // jid -> { name, ts }
const channelNameCache = new Map(); // jid -> { name, ts }

function fmtMB(bytes) { return Math.round(bytes / 1024 / 1024); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- socket ---------------- */

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: process.env.LOG_LEVEL || 'warn' }),
    printQRInTerminal: false,
    browser: ['Exness Signal Bot', 'Chrome', '121.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log('[whatsapp] === SCAN THIS QR CODE (WhatsApp > Linked Devices > Link a device) ===');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('[whatsapp] connected as', sock.user?.id);
      await subscribeToChannels();
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('[whatsapp] LOGGED OUT. Delete .runtime/sessions and restart to re-link.');
        return;
      }
      console.log('[whatsapp] connection closed (code ' + code + '), reconnecting in 5s');
      sock.end(undefined);
      setTimeout(startWhatsApp, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try { await onMessage(msg); } catch (e) { console.error('[whatsapp] message error:', e.message); }
    }
  });

  return sock;
}

/** Follow + unmute configured channels so their messages arrive. */
async function subscribeToChannels() {
  if (!allowedChannelIds.length) return;
  for (const jid of allowedChannelIds) {
    try { await sock.newsletterFollow(jid); } catch (e) { console.warn('[whatsapp] follow channel', jid, 'failed:', e.message); }
    await sleep(500);
    try { await sock.newsletterUnmute(jid); } catch (e) { console.warn('[whatsapp] unmute channel', jid, 'failed:', e.message); }
  }
  console.log('[whatsapp] channels configured:', allowedChannelIds.join(', '));
}

async function stopWhatsApp() {
  if (sock) { try { sock.end(undefined); sock = null; } catch {} }
}

/* ---------------- channel / group lock ---------------- */

function isChannel(jid) { return isJidNewsletter(jid); }

async function channelAllowed(jid) {
  if (!isChannel(jid)) return false;
  if (allowedChannelIds.includes(jid)) return true;
  if (allowedChannelNames.length === 0) return false;

  const cached = channelNameCache.get(jid);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
    return allowedChannelNames.some(n => cached.name.toLowerCase().includes(n));
  }
  try {
    const meta = await sock.newsletterMetadata('jid', jid);
    const name = (meta && (meta.name || meta.state?.name)) || '';
    channelNameCache.set(jid, { name, ts: Date.now() });
    const ok = allowedChannelNames.some(n => name.toLowerCase().includes(n));
    console.log(`[whatsapp] channel "${name}" (${jid}) allowed=${ok}`);
    return ok;
  } catch (e) {
    console.warn('[whatsapp] cannot resolve channel metadata for', jid, e.message);
    return false;
  }
}

async function groupAllowed(jid) {
  if (allowedGroupJids.has(jid)) return true;
  if (!jid.endsWith('@g.us')) return false;
  if (allowedGroupNames.length === 0) return false;

  const cached = groupNameCache.get(jid);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
    return allowedGroupNames.some(n => cached.name.toLowerCase().includes(n));
  }
  try {
    const meta = await sock.groupMetadata(jid);
    const name = (meta && meta.subject) || '';
    groupNameCache.set(jid, { name, ts: Date.now() });
    const ok = allowedGroupNames.some(n => name.toLowerCase().includes(n));
    console.log(`[whatsapp] group "${name}" (${jid}) allowed=${ok}`);
    return ok;
  } catch (e) {
    console.warn('[whatsapp] cannot resolve group metadata for', jid, e.message);
    return false;
  }
}

/** Owner DM to receive confirmations when the signal source is a channel. */
function ownerJid() {
  const first = (process.env.ALLOWED_SENDERS || '').split(',')[0]?.trim();
  if (!first) return null;
  return first.includes('@') ? first : first + '@s.whatsapp.net';
}

/* ---------------- message handling ---------------- */

function extractText(msg) {
  return (
    msg.message?.extendedTextMessage?.text ||
    msg.message?.conversation ||
    msg.message?.imageMessage?.caption ||
    ''
  );
}

async function onMessage(msg) {
  if (msg.key.fromMe) return;
  const jid = msg.key.remoteJid || '';
  const text = extractText(msg);
  if (!text || !text.trim()) return;

  const sender = msg.key.participant || jid;
  const isChannelMsg = isChannel(jid);
  const isGroup = jid.endsWith('@g.us');
  const isDM = jid.endsWith('@s.whatsapp.net');
  const isCommand = /^\/(status|help|positions)$/i.test(text.trim());

  // commands: allowed senders, anywhere
  if (isCommand && senderAllowed(sender)) {
    const reply = await handleCommand(text.trim().toLowerCase());
    if (reply) await sock.sendMessage(jid, { text: reply });
    return;
  }
  if (isDM) return; // DMs are never signal sources

  // ---- signal source: allowed CHANNEL (primary) or allowed GROUP ----
  let trusted = false;
  if (isChannelMsg) {
    if (!(await channelAllowed(jid))) return;
    trusted = true; // channel broadcasts are trusted as a whole (no participant check)
  } else if (isGroup) {
    if (!(await groupAllowed(jid))) return;
    if (!isProvider(sender)) return;
    trusted = true;
  } else {
    return;
  }

  console.log(`[whatsapp] ${isChannelMsg ? 'channel' : 'group'} msg (${sender}): ${text.slice(0, 120)}`);
  const reply = await handleIncoming(sender, text);
  if (!reply) return;

  if (isChannelMsg) {
    // channels are one-way — send the confirmation to the owner's DM instead
    const owner = ownerJid();
    if (owner) {
      try { await sock.sendMessage(owner, { text: reply }); }
      catch (e) { console.error('[whatsapp] owner DM reply failed:', e.message); }
    } else {
      console.log('[whatsapp] (no owner configured — confirmation logged):', reply);
    }
  } else {
    try { await sock.sendMessage(jid, { text: reply }); }
    catch (e) { console.error('[whatsapp] reply failed:', e.message); }
  }
}

/* ---------------- multi-message signal assembly + management ---------------- */

async function handleIncoming(sender, text) {
  const parsed = parseTradeMessage(text);

  if (parsed && parsed.type === 'tp') {
    if (pending && Date.now() - pending.at < TP_WINDOW_MS) {
      const sig = { ...pending.sig, tp: parsed.tps[0], tps: parsed.tps };
      pending = null;
      console.log('[signal] TP attached ->', JSON.stringify(sig));
      return handleTrade(sig);
    }
    console.log('[signal] TP message but no pending signal in window — ignored');
    return null;
  }

  if (parsed && parsed.type === 'signal') {
    if (parsed.tp.length) {
      return handleTrade({ ...parsed, tp: parsed.tp[0], tps: parsed.tp });
    }
    if (parsed.sl == null) {
      console.log('[signal] incomplete (no SL) — waiting for details:', JSON.stringify(parsed));
      return null;
    }
    pending = { sig: parsed, at: Date.now() };
    console.log('[signal] base signal pending, waiting for TP (window ' + TP_WINDOW_MS + 'ms):',
      JSON.stringify({ action: parsed.action, pair: parsed.pair, zone: [parsed.entryLow, parsed.entryHigh], sl: parsed.sl }));
    return null; // wait for the TP message
  }

  // not a trade signal -> maybe a management instruction
  const mgmt = await classifyManagement(text);
  if (mgmt) {
    console.log('[manage] instruction:', JSON.stringify(mgmt));
    const res = await applyManagement(mgmt);
    return res.message;
  }
  return null; // noise — stay silent
}

async function handleTrade(sig) {
  const verdict = validateSignal(sig);
  if (!verdict.ok) return `⛔ Rejected: ${verdict.problems.join('; ')}`;

  let result;
  try {
    result = await execute(sig);
  } catch (e) {
    return `❌ Execution failed: ${e.message}`;
  }

  markExecuted(sig); // count only after success

  const zone = sig.entryLow != null && sig.entryHigh != null && sig.entryLow !== sig.entryHigh
    ? `${sig.entryLow}-${sig.entryHigh}`
    : (sig.entry != null ? String(sig.entry) : 'market');

  if (result.mode === 'log') {
    return `✅ [DRY-RUN] ${sig.action} ${sig.pair} zone ${zone} | lot ${sig.lot} | SL ${sig.sl}` +
      (sig.tp != null ? ` | TP ${sig.tp}` : '');
  }
  if (result.mode === 'puppeteer' && result.ok !== false) {
    addPosition(sig, result);
  }
  return `✅ ${sig.action} ${sig.pair} zone ${zone} | lot ${sig.lot} | SL ${sig.sl}` +
    (sig.tp != null ? ` | TP ${sig.tp}` : '') +
    (result.confirmed ? ' — order confirmed ✔' : ' — check terminal for confirmation');
}

async function handleCommand(cmd) {
  const s = todayStats();
  if (cmd === '/status') {
    const ps = listPositions();
    return [
      '🤖 exness-signal-bot',
      `mode: ${process.env.EXECUTION_MODE || 'puppeteer'}`,
      `llm: ${process.env.GEMINI_API_KEY ? 'gemini ✔' : 'rules only'}`,
      `channel: ${process.env.ALLOWED_CHANNELS || '(none)'}`,
      `group: ${process.env.ALLOWED_GROUPS || '(none)'}`,
      `uptime: ${Math.round((Date.now() - startedAt) / 60000)} min`,
      `rss: ${fmtMB(process.memoryUsage().rss)} MB`,
      `trades today: ${s.count} (${s.lot} lot)`,
      `open tracked: ${ps.length}`,
    ].join('\n');
  }
  if (cmd === '/positions') {
    const ps = listPositions();
    if (!ps.length) return 'No tracked open positions.';
    return ps.map((p, i) =>
      `${i + 1}. ${p.side} ${p.pair} ${p.lot} lot @ ${p.entry ?? '?'} | SL ${p.sl ?? '-'} | TP ${p.tp ?? '-'} | opened ${new Date(p.openedAt).toLocaleTimeString()}`,
    ).join('\n');
  }
  return [
    '🤖 exness-signal-bot — commands:',
    '/status — bot status',
    '/positions — tracked open positions',
    'Signals are only read from the configured channel + provider.',
  ].join('\n');
}

module.exports = { startWhatsApp, stopWhatsApp, channelConfig };
