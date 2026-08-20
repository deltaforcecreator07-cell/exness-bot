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
const { addPosition, listPositions, saveLastSignal, loadLastSignal, loadLastSignalRecord, markLastSignalExecuted } = require('./positions');
const { currentMode, setMode } = require('./runtime-mode');

const SESSION_DIR = path.join(__dirname, '..', '.runtime', 'sessions');
const TP_WINDOW_MS = Number(process.env.TRADE_TP_WINDOW_MS || 5 * 60 * 1000);

/* ---------------- signal-source config ---------------- */

const allowedGroupNames = (process.env.ALLOWED_GROUPS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const allowedGroupJids = new Set(
  (process.env.ALLOWED_GROUP_JIDS || '').split(',').map(s => s.trim()).filter(Boolean),
);

// WhatsApp Channel(s): bare invite code ("0029VarqpJRCXC3E4nNcRv05") or full jid ("120363403901744631@newsletter")
function channelConfig() {
  const ids = (process.env.ALLOWED_CHANNELS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(c => c.endsWith('@newsletter') ? c : c + '@newsletter');
  const names = (process.env.ALLOWED_CHANNEL_NAMES || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return { jids: ids, names };
}
const configuredChannelIds = channelConfig().jids;
const allowedChannelNames = channelConfig().names;

// Resolved real channel JIDs (invite codes resolved via newsletterMetadata).
// Filled in at connect time; used for follow/unmute AND for message matching.
let resolvedChannelIds = [...configuredChannelIds];

/**
 * Resolve configured channel invite codes to real channel JIDs.
 * The whatsapp.com/channel/<code> link gives an INVITE code; the real JID is
 * numeric (e.g. 120363403901744631@newsletter). newsletterMetadata('invite', code)
 * returns the metadata including .id (the real JID). Numeric jids pass through.
 */
async function resolveConfiguredChannels() {
  if (!sock) return;
  const out = [];
  for (const id of configuredChannelIds) {
    if (/^\d+@newsletter$/.test(id)) { out.push(id); continue; }
    const code = id.replace(/@newsletter$/, '');
    try {
      const meta = await sock.newsletterMetadata('invite', code);
      if (meta && meta.id) {
        console.log(`[whatsapp] resolved channel invite "${code}" -> ${meta.id} (${channelNameFromMeta(meta) || '?'})`);
        out.push(meta.id);
      } else {
        console.warn(`[whatsapp] invite "${code}" resolved to nothing — keeping as-is`);
        out.push(id);
      }
    } catch (e) {
      console.warn(`[whatsapp] could not resolve channel invite "${code}": ${e.message}`);
      out.push(id);
    }
  }
  resolvedChannelIds = [...new Set(out)];
  console.log('[whatsapp] channel jids:', resolvedChannelIds.join(', '));
}

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
      // FULL AUTOMATION: if a previous attempt failed/crashed (OOM, login
      // issue) and the signal is still fresh + not executed, auto-retry it.
      await autoRetryPending();
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
  if (!configuredChannelIds.length) return;
  await resolveConfiguredChannels();
  for (const jid of resolvedChannelIds) {
    try { await sock.newsletterFollow(jid); console.log(`[whatsapp] following channel ${jid}`); }
    catch (e) { console.warn(`[whatsapp] follow channel ${jid}: ${e.message} (already following? that's fine)`); }
    await sleep(500);
    try { await sock.newsletterUnmute(jid); console.log(`[whatsapp] unmuted channel ${jid}`); }
    catch (e) { console.warn(`[whatsapp] unmute channel ${jid}: ${e.message}`); }
  }
  console.log('[whatsapp] channels configured:', resolvedChannelIds.join(', '));
}

async function stopWhatsApp() {
  if (sock) { try { sock.end(undefined); sock = null; } catch {} }
}

/* ---------------- channel / group lock ---------------- */

function isChannel(jid) { return isJidNewsletter(jid); }

async function channelAllowed(jid) {
  if (!isChannel(jid)) return false;
  // 1) direct JID match against configured + resolved channel JIDs (fastest, most reliable)
  if (resolvedChannelIds.includes(jid)) return true;
  if (configuredChannelIds.includes(jid)) return true;
  // 2) name match (belt-and-braces when JID isn't known yet)
  if (allowedChannelNames.length === 0) return false;

  const cached = channelNameCache.get(jid);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
    return allowedChannelNames.some(n => cached.name.toLowerCase().includes(n));
  }
  try {
    const meta = await sock.newsletterMetadata('jid', jid);
    const name = channelNameFromMeta(meta);
    channelNameCache.set(jid, { name, ts: Date.now() });
    const ok = allowedChannelNames.some(n => name.toLowerCase().includes(n));
    console.log(`[whatsapp] channel "${name}" (${jid}) allowed=${ok}`);
    return ok;
  } catch (e) {
    console.warn('[whatsapp] cannot resolve channel metadata for', jid, e.message);
    return false;
  }
}

/**
 * Extract the display name from newsletter metadata.
 * The name field can be a plain string OR an object {id, text, update_time}
 * (as seen in WhatsApp's channel metadata) — handle both.
 */
function channelNameFromMeta(meta) {
  if (!meta) return '';
  const pick = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v.text === 'string') return v.text;
    return '';
  };
  return pick(meta.name) || pick(meta.thread_metadata?.name) || pick(meta.state?.name) || '';
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
  const jid = msg.key.remoteJid || '';
  const text = extractText(msg);
  if (!text || !text.trim()) return;

  // Sender identity: WhatsApp now uses LIDs (@lid). Prefer the real phone JID
  // (remoteJidAlt) when present, so ALLOWED_SENDERS (phone numbers) match.
  const sender = msg.key.participant || msg.key.remoteJidAlt || jid;
  const isSelf = !!msg.key.fromMe; // message from the bot's OWN account = the owner

  // DEBUG: log EVERY incoming message so you can see in Render logs whether
  // the bot receives your DMs / channel signals at all.
  console.log(`[whatsapp:debug] jid=${jid} fromMe=${isSelf} sender=${sender} txt=${text.slice(0, 80).replace(/\n/g, ' | ')}`);

  // Commands (/trade, /retake, /status, ...) are handled FIRST — before the
  // fromMe filter — so the owner can DM commands to their own number (self-DM)
  // and they still work. (When you message yourself, fromMe is true because
  // the message comes from the bot's own linked account.)
  const isCommand = /^\/(status|help|positions|retake|retry|trade|mode|close|cancel)\b/i.test(text.trim());
  if (isCommand && (isSelf || senderAllowed(sender))) {
    const reply = await handleCommand(text.trim(), sender);
    if (reply) await sock.sendMessage(jid, { text: reply });
    return;
  }

  if (msg.key.fromMe) return; // ignore own messages after command handling

  const isChannelMsg = isChannel(jid);
  const isGroup = jid.endsWith('@g.us');
  const isDM = jid.endsWith('@s.whatsapp.net');
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

/**
 * FULL AUTOMATION: on every WhatsApp connect (including after an OOM restart),
 * check whether there is a saved signal that was never executed. If so, fire it
 * automatically. The duplicate-protection in the risk layer prevents a second
 * entry if it was actually already placed.
 */
async function autoRetryPending() {
  try {
    const rec = loadLastSignalRecord();
    if (!rec) return;
    if (rec.executed) return; // already handled
    console.log('[auto-retry] found unexecuted signal, retrying automatically...');
    const reply = await handleTrade(rec.sig);
    console.log('[auto-retry] result:', reply);
  } catch (e) {
    console.error('[auto-retry] failed:', e.message);
  }
}

async function handleTrade(sig) {
  // remember the signal so a missed/failed trade is never lost
  // (auto-retried on next connect, or retaken with /retake)
  if (sig && sig.pair) saveLastSignal(sig);

  const verdict = validateSignal(sig);
  if (!verdict.ok) {
    // permanent rejection (invalid SL side, duplicate, caps) — don't retry forever
    markLastSignalExecuted();
    return `⛔ Rejected: ${verdict.problems.join('; ')}`;
  }

  let result;
  try {
    result = await execute(sig);
  } catch (e) {
    // transient failure (OOM guard, login hiccup) — KEEP pending so the bot
    // auto-retries on next connect; also available via /retake
    return `❌ Execution failed: ${e.message}`;
  }

  markExecuted(sig); // count only after success
  markLastSignalExecuted(); // success → don't auto-retry again

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

async function handleCommand(rawCmd, sender) {
  const cmd = rawCmd.toLowerCase().trim();
  const s = todayStats();

  // /trade <signal> — manually enter a trade, e.g.
  //   /trade SELL XAUUSD 4392-94 SL 4400 TP 4384
  // Only the owner (ALLOWED_SENDERS) can do this; goes through the same
  // risk sizing + safety checks as a channel signal.
  if (cmd.startsWith('/trade ')) {
    const signalText = rawCmd.replace(/^\/trade\s+/i, '').trim();
    if (!signalText) return 'Usage: /trade BUY|SELL PAIR ZONE SL <price> TP <price>\nExample: /trade SELL XAUUSD 4392-94 SL 4400 TP 4384';
    const parsed = parseTradeMessage(signalText);
    if (!parsed) return '❌ Could not parse that as a trade.\nUse: /trade SELL XAUUSD 4392-94 SL 4400 TP 4384';
    const sig = { ...parsed, tp: parsed.tp && parsed.tp.length ? parsed.tp[0] : null, tps: parsed.tp };
    if (sig.sl == null) return '❌ No SL found — a stop loss is required.';
    console.log(`[trade-cmd] owner manual trade from ${sender}: ${signalText}`);
    return await handleTrade(sig);
  }

  // /mode [log|puppeteer] — switch execution mode instantly without restart
  // /close (alias /cancel) — close the latest tracked position in the terminal
  if (cmd === '/close' || cmd === '/cancel') {
    const ps = listPositions();
    if (!ps.length) return 'ℹ️ No tracked position to close. (If the bot restarted, tracking reset — close it in the MT app manually.)';
    const latest = ps[ps.length - 1];
    const res = await applyManagement({ action: 'close_position', pair: latest.pair, message: `close ${latest.pair} position` });
    return res.message;
  }

  if (cmd === '/mode' || cmd.startsWith('/mode ')) {
    const arg = rawCmd.replace(/^\/mode\s*/i, '').trim().toLowerCase();
    if (!arg) return `Current mode: ${currentMode()}\nUsage: /mode log | /mode puppeteer\n(log = dry-run, puppeteer = real trade)`;
    const r = setMode(arg);
    return r.message + ` (now: ${currentMode()})`;
  }

  if (cmd === '/status') {
    const ps = listPositions();
    return [
      '🤖 exness-signal-bot',
      `mode: ${currentMode()}`,
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
  if (cmd === '/retake' || cmd === '/retry') {
    const last = loadLastSignal();
    if (!last) return 'ℹ️ No recent signal stored. Wait for the next signal from the channel.';
    const zone = last.entryLow != null && last.entryHigh != null && last.entryLow !== last.entryHigh
      ? `${last.entryLow}-${last.entryHigh}`
      : (last.entry != null ? String(last.entry) : 'market');
    const msg = `🔁 Retaking last signal: ${last.action} ${last.pair} zone ${zone} | SL ${last.sl}` +
      (last.tp != null ? ` | TP ${last.tp}` : '');
    // acknowledge, then attempt execution
    const result = await handleTrade(last);
    return `${msg}\n${result}`;
  }
  return [
    '🤖 exness-signal-bot — commands:',
    '/status — bot status (shows current mode)',
    '/mode [log|puppeteer] — switch dry-run ↔ real trading instantly (no restart)',
    '/close (or /cancel) — close the latest position',
    '/positions — tracked open positions',
    '/retake — retry the last signal (e.g. if a trade was missed while price is still at entry)',
    '/trade SELL XAUUSD 4392-94 SL 4400 TP 4384 — manually enter a trade (owner only)',
    'Signals are only read from the configured channel + provider.',
  ].join('\n');
}

module.exports = { startWhatsApp, stopWhatsApp, channelConfig };
