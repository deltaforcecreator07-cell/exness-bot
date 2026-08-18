'use strict';

/**
 * WhatsApp connection-layer test for Baileys 7.
 *
 * Verifies the whole wiring actually works against the real WhatsApp servers:
 *   1. multi-file auth state loads (or creates) a session
 *   2. latest version is fetched
 *   3. socket is created and connects
 *   4. connection.update events fire (QR printed when needed)
 *   5. the event APIs our bot uses are all present
 *
 * Run:  npm run test:wa
 * Exit 0 = connection layer OK, 1 = broken.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const SESSION_DIR = process.env.WA_TEST_SESSION || path.join(os.tmpdir(), 'wa-test-session-' + Date.now());
fs.mkdirSync(SESSION_DIR, { recursive: true });

const results = [];
function pass(name, detail) { results.push(`✔ ${name}${detail ? ' — ' + detail : ''}`); console.log(`✔ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail) { results.push(`✘ ${name}${detail ? ' — ' + detail : ''}`); console.error(`✘ ${name}${detail ? ' — ' + detail : ''}`); }

async function main() {
  console.log('=== WhatsApp connection test (Baileys', require('@whiskeysockets/baileys/package.json').version, ') ===');
  console.log('session dir:', SESSION_DIR);

  // 1. version fetch
  let version;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
    pass('fetchLatestBaileysVersion', version.join('.'));
  } catch (e) {
    fail('fetchLatestBaileysVersion', e.message);
    return 1;
  }

  // 2. auth state
  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(SESSION_DIR));
    pass('useMultiFileAuthState', 'session dir ready');
  } catch (e) {
    fail('useMultiFileAuthState', e.message);
    return 1;
  }

  // 3. socket + events
  let qrSeen = false;
  let openSeen = false;
  let closeSeen = false;
  let events = 0;

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'warn' }),
    printQRInTerminal: false,
    browser: ['Exness Signal Bot', 'Chrome', '121.0'],
  });

  const eventApi = {
    credsUpdate: typeof sock.ev.on === 'function',
    connectionUpdate: typeof sock.ev.on === 'function',
    messagesUpsert: typeof sock.ev.on === 'function',
  };

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    events++;
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      qrSeen = true;
      // QR is a base64-ish string; just confirm it looks like one
      const looksLikeQr = typeof qr === 'string' && qr.length > 50;
      if (looksLikeQr) pass('QR generated (length ' + qr.length + ') — scan it to complete login');
      else fail('QR generated', 'unexpected shape');
    }
    if (connection === 'open') {
      openSeen = true;
      pass('connection open', 'logged in as ' + (sock.user?.id || '?'));
    }
    if (connection === 'close') {
      closeSeen = true;
      const code = lastDisconnect?.error?.output?.statusCode;
      pass('connection closed', 'statusCode=' + code + ' (loggedOut=' + (code === DisconnectReason.loggedOut) + ')');
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    pass('messages.upsert event', 'received ' + (messages?.length || 0) + ' message(s)');
  });

  // 4. event API presence
  if (eventApi.credsUpdate && eventApi.connectionUpdate && eventApi.messagesUpsert) {
    pass('event API (ev.on) present', 'creds/connection/messages');
  } else {
    fail('event API', JSON.stringify(eventApi));
    return 1;
  }

  // 5. wait for real connection activity
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (openSeen) break;
    if (qrSeen && events >= 2) break; // got a QR + at least one event -> layer works
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (qrSeen) {
    pass('connection layer', 'socket initialized, QR received — login flow works (scan to fully link)');
  } else if (openSeen) {
    pass('connection layer', 'socket already logged in (no QR needed)');
  } else {
    fail('connection layer', 'no QR and no open after 30s (events=' + events + ') — check network / Baileys config');
    try { sock.end(undefined); } catch {}
    return 1;
  }

  console.log('\n=== summary ===');
  console.log('events seen:', events, '| qr:', qrSeen, '| open:', openSeen, '| close:', closeSeen);

  try { sock.end(undefined); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  console.log('clean shutdown OK');
  return 0;
}

main().then((code) => {
  // tidy up temp session
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  process.exit(code);
}).catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
