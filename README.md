# 🤖 exness-signal-bot

WhatsApp signal channel → risk checks → **Exness MT5 demo trade** via a headless browser,
running on **Render free tier** (no paid VPS, no credit card, no always-on PC).

**WhatsApp stack:** Baileys **7.0.0-rc14** (`@whiskeysockets/baileys`, the current npm `latest` tag — requires Node ≥ 20, which Render free supports).

```
WhatsApp CHANNEL "THE SHARKS" (https://whatsapp.com/channel/0029VarqpJRCXC3E4nNcRv05)
      │  Baileys 7 listens 24/7  |  @newsletter JID, one-way broadcast
      │  (optional: same trader in a group — ALLOWED_GROUPS)
      ▼
parseTradeMessage() ──► msg1: { action, pair, zone 4391-93, SL 4385 }  (held pending)
                        msg2: "TP 4401" "TP 4410" ──► TP attaches
      │
      ▼
risk.js ──► lot = (CAPITAL × RISK%) / (|entry−SL| × contract)  →  $3000, 5% = $150 → 0.25 lots
            + side checks (BUY SL below entry…), daily caps, duplicate protection
      │
      ▼
executor.js ──► EXECUTION_MODE=puppeteer
      │
      ▼
exness-executor.js ──► headless Chromium → MetaTrader WebTerminal → place order → close browser
      │
      ▼
confirmation → DM to the OWNER (channels can't receive replies)
```

---

## v0.5 — reliable /close, partial closes, entry tolerance, breakeven & more owner commands

1. **`/close` actually works now.** The old code looked for the right-click "Close" menu item with `offsetParent !== null` — GWT context menus are `position: fixed`, where `offsetParent` is always null, so the item was on screen but invisible to the bot. It also could right-click a Market Watch cell instead of the Trade-tab row. Now rows are scoped to the Trade tab (ticket/buy-sell heuristic), visibility uses `checkVisibility()`, the right-click first selects the row, every menu's contents are dumped to the logs, and THREE close strategies run in order (context menu → double-click the row → loose menu match), each with screenshots.
2. **Selective + partial closes** — `/close 2`, `/close #120548117`, `/close gold`, `/close all` (/flatten), and volume-based partials: `/close 50%`, `/close half`, `/close 2 50%`, `/partial 30`. Partial close = MT5's native way: the close dialog's Volume field is rewritten to the floored-to-0.01 volume, the remainder stays open and tracking is updated.
3. **Entry tolerance — no trade missed.** `ENTRY_TOLERANCE_USD` (default 3). Live bid/ask is read off the order ticket before submitting. Within ±$3 of the signal zone → still executes at market (drift accepted on purpose). Beyond the band → instead of rejecting or chasing, the bot places a pending order (Buy/Sell Limit/Stop) at the nearest zone edge, and the confirmation message says so. SL/TP the live price already crossed get nudged just beyond it (≤ tolerance) and every adjustment is reported.
4. **Breakeven** — `/be` moves SL to entry, `/be +50` locks +50 pips, works on a selector too (`/be 2`, `/be #120548117`, `/be gold`).
5. **More direction words** — `LONG` = BUY, `SHORT` = SELL everywhere (channel signals AND `/trade`).
6. **Institutional-grade command set** — `/account` (live balance/equity/margin), `/risk` (sizing config + daily usage), `/pause` `/resume` (safety switch: no NEW trades, management still works), `/ping`, `/shot` (terminal screenshot to your DM), plus the existing `/status` `/positions` `/verify` `/mode` `/retake` `/trade` `/help`.

---

## v0.4 — WhatsApp Channel signal source

Your signal source is a **WhatsApp Channel** (`THE SHARKS`), not a group. This changes three things:

1. **Channel lock** — `ALLOWED_CHANNELS=0029VarqpJRCXC3E4nNcRv05` (the id in the link, with or without `@newsletter`). The bot verifies the sender JID is that channel (or its name matches `ALLOWED_CHANNEL_NAMES`), and **follows + unmutes** it automatically on connect so broadcasts arrive.
2. **No participant check** — channels are one-way broadcasts from the owner, so the bot trusts the channel wholesale (no `SIGNAL_PROVIDER` phone needed for channel signals). `SIGNAL_PROVIDER` still applies if you also read a group.
3. **Confirmations go to your DM** — you can't reply inside a channel. When the bot executes (or rejects) a signal, the ✅/⛔ confirmation is DM'd to the first number in `ALLOWED_SENDERS` (set it to your own number).

Group listening (`ALLOWED_GROUPS` + `SIGNAL_PROVIDER`) is still supported as an optional second source.

## v0.3 — management instructions (Gemini + rules)

The bot now **understands the trader's spoken Roman-Urdu instructions** and acts on the open position:

| Trader says | Bot does |
|---|---|
| `TRADE CLOSE KARDO!` / `trade band karo` | closes the position |
| `BE TAPPED!` / `BE HIT!` / `BE TAP!` | **BE = breakeven.** Trade already closed at entry (the SL-at-breakeven was hit) → bot marks the tracked position closed, replies "✅ hit breakeven — closed at entry". No browser action (broker already closed it) |
| `SL 401 PE RAKHNA!` | moves SL to **4401** (shorthand auto-expanded against your entry) |
| `TRAIL SL TO 93` | trails SL to **4393** |
| `SL KO BE PE RAKH DO` / `TRAIL SL TO BE` | **BE = breakeven.** Moves SL to breakeven (your entry) |
| `50 PIPS PA BREAKEVEN KAR DANA` | moves SL to breakeven (your entry) |
| `SL KO 4400 PE SET KARO` | moves SL to 4400 |
| `60+ PIPS RUNNING!` / react-bait | **ignored** (status, not instruction) |
| `... BE HIT AFTER 70 PIPS` (inside the daily report) | **ignored** — that's a recap of a past trade, not a live event |

How it works:
1. **Gemini 3.6 Flash** (free via Google AI Studio — no card) translates the message into a structured JSON action. The prompt includes your tracked positions so it can expand shorthands correctly ("93" → 4393 when gold is ~4391) and is taught that **"BE" always means breakeven** — both for instructions ("SL ko BE pe rakh do") and for status ("BE tapped" = closed at breakeven).
2. **Rule fallback** handles the common patterns when no `GEMINI_API_KEY` is set or the API is rate-limited — so management still works offline.
3. The position manager then boots the headless browser, opens the Trade tab, right-clicks/double-clicks the position, and closes it or modifies SL/TP — with screenshots at every step.

Setup: `GEMINI_API_KEY` from https://aistudio.google.com/apikey (free tier: ~10–15 req/min — plenty for this). Model chain: `GEMINI_MODEL=gemini-3.6-flash,gemini-2.5-flash`. Pips math: `SYMBOL_PIPS` (gold = 0.1 per pip, so 50 pips = 5.0 price).

> ⚠️ Honest caveat: closing/modifying a position in the GWT terminal is the most fragile UI automation in this project. The bot saves a screenshot at every step — if a step drifts after an Exness/MetaQuotes update, the screenshot shows where, and the bot replies with a clear "could not X — verify in terminal" message instead of silently failing.

## v0.2 — what changed in this audit

1. **Channel lock.** The bot reads signals **only** from `ALLOWED_GROUPS` (group subject, e.g. `THE SHARKS`) and **only** messages sent by `SIGNAL_PROVIDER` (the trader's number). Member replies (`KAHAN SE HE ENTRY?`), react-bait (`IF THIS MSG GET 80 REACTS…`), daily reports and DMs are all ignored. `ALLOWED_GROUP_JIDS` is an optional hard lock if you know the group ID.
2. **Trader-format parser.** Real signals are multi-message and conversational:
   - `GOLD BUY 4391-93` + `SL 85` → entry zone **4391–4393**, SL expanded from shorthand to **4385**
   - `GOLD BUY **4398-4400** SL 4392` → zone 4398–4400, SL 4392
   - `GOLD SELL **4400-4402** SL 4408` → SELL zone, SL above entry
   - next message `TP 4401` `TP 4410` → first TP goes on the order, both logged
   - management messages (`TRAIL SL TO 93`, `60+ PIPS RUNNING!`, `SL HIT DONE!`, `BE TAPPED!`) are **not** trades — ignored
   - The bot holds the base signal for `TRADE_TP_WINDOW_MS` (default 5 min) waiting for the TP message, then fires.
3. **Capital-based lot sizing (risk 2% style).** With `CAPITAL=3000`, `RISK_PERCENT=5`:
   - max risk per trade = **$150**
   - `lot = 150 / (SL distance × contract size)` — XAUUSD contract = $100 per 1.0 lot per $1 move
   - example: zone 4391–93, SL 4385 → 6 pts → **lot 0.25**
   - explicit lots in a signal are respected but clamped to `MAX_LOT_PER_TRADE`
   - trades without an SL are rejected (nothing to size risk against)

### Sample transcript → what the bot does
| Trader message | Bot action |
|---|---|
| `GOLD BUY NOW!` | logged, ignored (no entry/SL yet) |
| `GOLD BUY 4391-93` / `SL 85` | parse → hold pending (zone 4391–93, SL 4385) |
| `TP 4401` / `TP 4410` | attach TP 4401 → execute 0.25 lot BUY XAUUSD |
| `60+ PIPS RUNNING!` | ignored |
| member: `KAHAN SE HE ENTRY?` | ignored (not the provider) |
| `SL HIT DONE FOR THE DAY!` | ignored |



---

## ⚠️ Read this first — the honest limits

This is a **testing rig, not a production trading system**. It works, but:

| Problem | Reality | Mitigation in this project |
|---|---|---|
| MetaQuotes moved/changed the terminal | old `trade.mql5.com` URL 404s; the app is a GWT SPA that **blocks plain headless Chrome** | verified live: `metatraderweb.app/trade` + desktop UA + webdriver-hidden stealth (all baked into `exness-executor.js`) |
| Exness change terminal UI | selectors break on updates | code targets fields by *purpose* (labels "Login:", "Volume:", "Stop Loss:", button text), never hardcoded classes; `npm run dump-dom` re-discovers anything else |
| Render 512 MB RAM | Chromium + Node can OOM | browser launches **only per signal**, uses light `chrome-headless-shell`, persistent profile = login once, hard 180 s timeout so a hung page can't lock the bot |
| Render spins down after 15 min idle | WhatsApp connection dies | free **cron-job.org ping every 10 min** keeps it awake (see Setup step 4) |
| Render free disk is ephemeral | Files vanish if instance restarts | while pings keep it alive it persists; if it restarts you re-scan the WhatsApp QR |
| 750 free instance hours/month | 24/7 ≈ 744 h — no room for a 2nd free service | keep this the only free service in the account while testing |
| UI automation vs broker ToS | Official automation = Expert Advisor, not clicking | this is demo-only testing. Don't run it against a live funded account |

**Demo account = no real money, no KYC** (email only at Exness). That's exactly what you want here.

---

## Setup

### 0. Create an Exness MT5 demo account (5 minutes, no KYC)
1. Go to **exness.com** → register with an email (no card, no documents for demo).
2. Personal Area → **New Account** → **MT5** → **Demo**.
3. Note the **login number**, the **trading password** (different from your PA password — you can reset it under the account's ⋯ menu if needed), and the **server** (usually `Exness-MT5Demo`).
4. The bot logs into the MetaTrader Web Terminal directly with those three values — `WEBTERMINAL_URL` is already set to the working URL (`https://metatraderweb.app/trade`). No need to touch your Personal Area for the terminal URL (the old `trade.mql5.com` URL with `?servers=` is dead — verified 404).

### 1. Run it locally first (dry-run, no browser yet)
```bash
cd exness-signal-bot
npm install
cp .env.example .env
# edit .env: fill EXNESS_LOGIN / EXNESS_PASSWORD / EXNESS_SERVER / WEBTERMINAL_URL
# set EXECUTION_MODE=log
npm test            # parser sanity checks
npm start           # prints QR -> scan in WhatsApp (Linked Devices)
```
Add the bot to the Sharks group, then have the trader send a real signal (or paste one): `GOLD BUY 4391-93` / `SL 85` → you get a `[DRY-RUN]` reply once the `TP` message arrives. The whole pipeline (WhatsApp → channel lock → parser → risk → executor) is now proven, **before** the fragile browser part.

### 2. Deploy to Render (free)
1. Push this folder to a GitHub repo.
2. Render Dashboard → **New → Web Service** → pick the repo.
3. Settings:
   - **Build:** `npm install`  (Render downloads Chromium for Puppeteer during build — first build takes a few minutes)
   - **Start:** `npm start`
   - **Runtime:** Node 20
   - **Instance type:** Free
4. **Environment Variables:** add everything from `.env.example` (with `EXECUTION_MODE=puppeteer` once you're ready for real browser execution).
5. **Deploy.**

### 3. Link WhatsApp (first run)
- Open your service **Logs**. You'll see a QR code printed. Scan it: WhatsApp → Settings → Linked Devices → Link a device.
- Log will show `connected as <number>`.
- The session lives in `.runtime/sessions` — it persists while the instance stays awake.

### 4. Keep it awake (the critical bit) — free, no card
Render spins free services down after **15 minutes without inbound traffic**. Fix with a free cron pinger:

1. Go to **cron-job.org** → sign up (free, email only).
2. **Create cronjob:**
   - URL: `https://YOUR-APP.onrender.com/health`
   - Schedule: **every 10 minutes** (custom cron: `*/10 * * * *`)
3. That's it — your service now never sleeps, WhatsApp stays connected, signals flow.

> Alternative: UptimeRobot free (5-min interval). Render's ToS doesn't ban pinging, but don't abuse it.

### 5. First live login — watch the screenshots (this is the real test)
Run once locally (or on Render) with `EXECUTION_MODE=puppeteer` and real demo credentials, then send:
`GOLD BUY 4398-4400` / `SL 4392` / `TP 4408` (or any real Sharks-style signal; lot is auto-sized, e.g. 0.25 with $3000/5%).

The bot logs its whole journey. Every stage saves a screenshot into `.runtime/screenshots/`:
`order-ticket`, `after-order`, `auth-failed`, `post-login-unknown`, `error`.
The terminal is a GWT app (boots in 10–40 s) — the code polls patiently for the login dialog, flips the MT4→MT5 platform switch, types server/login/password with real keystrokes, and clicks OK. If anything in that chain drifts (Exness/MT change the UI), the screenshot shows exactly where it stopped and the logs say which step failed.

If a field isn't found, run `npm run dump-dom` and check `.runtime/dom-dump.json` for the label text / input attributes, then adjust the match-strings in `exness-executor.js` (Volume / Stop Loss / Take Profit / Buy / Sell).

### 6. Live test (demo money)
1. Set `EXECUTION_MODE=puppeteer`, redeploy.
2. Send a real signal: `GOLD BUY 4398-4400` / `SL 4392`, then `TP 4408` — the bot assembles them, sizes the lot from your capital/risk, and fires.
3. Watch logs: `launching headless browser` → `logged in, terminal ready` → `clicking Buy` → `order submitted`.
4. Verify in the WebTerminal / MT5 app that the position exists.
5. Try a failure on purpose (e.g. `GOLD BUY 4398-4400 SL 4420` — SL above entry) to see the risk layer reject it and reply with ⛔.

---

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `EXNESS_LOGIN` | – | MT5 demo account number |
| `EXNESS_PASSWORD` | – | MT5 **trading** password (not PA password) |
| `EXNESS_SERVER` | `Exness-MT5Demo` | server name |
| `WEBTERMINAL_URL` | `https://metatraderweb.app/trade` | MetaTrader Web Terminal (no query params — they 404) |
| `WEBTERMINAL_UA` | desktop Chrome UA | UA sent to the terminal (it blocks headless UAs) |
| `ALLOWED_CHANNELS` | – | WhatsApp Channel id(s) to listen to, e.g. `0029VarqpJRCXC3E4nNcRv05` (primary source) |
| `ALLOWED_CHANNEL_NAMES` | – | optional channel name lock, case-insensitive (e.g. `THE SHARKS`) |
| `ALLOWED_GROUPS` | – | optional group subject(s) to also listen to |
| `ALLOWED_GROUP_JIDS` | – | optional hard group JID lock (`…@g.us`) |
| `SIGNAL_PROVIDER` | – | trader's number; only their messages in a GROUP are parsed (channels skip this) |
| `ALLOWED_SENDERS` | empty | your number(s): receive channel-signal confirmations as a DM + run `/status`, `/help`; empty = anyone (testing) |
| `CAPITAL` | `3000` | account capital in USD (for lot sizing) |
| `RISK_PERCENT` | `5` | % of capital risked per trade |
| `MAX_LOT_PER_TRADE` | `0.5` | hard lot cap per trade (computed lots are clamped) |
| `MAX_TRADES_PER_DAY` | `10` | daily trade cap |
| `MAX_LOT_PER_DAY` | `2.0` | daily cumulative lot cap |
| `SYMBOL_CONTRACTS` | built-in map | override contract sizes, JSON e.g. `{"XAUUSD":100}` |
| `TRADE_TP_WINDOW_MS` | `300000` | wait for the TP message after a base signal |
| `GEMINI_API_KEY` | – | free key from Google AI Studio; enables Roman-Urdu instruction understanding |
| `GEMINI_MODEL` | `gemini-3.6-flash,gemini-2.5-flash` | model fallback chain |
| `SYMBOL_PIPS` | built-in map | price units per 1 pip per symbol (gold 0.1, forex 0.0001…) |
| `EXECUTION_MODE` | `puppeteer` | `log` = dry-run, `puppeteer` = real |
| `PUPPETEER_HEADLESS` | `shell` | `shell` = lighter chrome-headless-shell |
| `PORT` | `10000` | Render sets this automatically |

## Commands in WhatsApp

Position management (selectors: nothing = most recent, `2` = #2 in /positions, `#120548117` = ticket, `gold`/`xauusdm` = symbol):

- `/close [sel] [%]` → close (e.g. `/close`, `/close 2`, `/close #120548117`, `/close gold 50%`)
- `/close 50%` (or `half`, `0.5`) → partial close; `/close 2 50%` → half of position #2
- `/partial 30 [sel]` → alias, defaults to 50%; `/close all` / `/flatten` → close everything
- `/be [sel] [+pips]` → SL to breakeven (`/be`, `/be +50`, `/be 2`)
- `/sl <price> [sel]` / `/tp <price> [sel]` → modify levels (e.g. `/sl 4600 2`)
- `/positions` (aliases `/pos` `/orders`) → tracked positions, numbered
- `/verify` → read the ACTUAL open positions from the terminal
- `/account` → balance / equity / margin from the terminal
- `/risk` → sizing config + today's usage vs caps

Control:

- `/status`, `/ping`, `/shot` (terminal screenshot), `/account`
- `/pause` / `/resume` → stop/re-start NEW trades (management keeps working)
- `/mode [log|puppeteer]` → dry-run ↔ real trading instantly
- `/trade SELL XAUUSD 4392-94 SL 4400 TP 4384` → manual trade (LONG=BUY, SHORT=SELL)
- `/retake` → re-fire the last saved signal
- any `BUY/SELL/LONG/SHORT ...` message → parsed, risk-checked, executed, confirmed
- management instructions (`close kardo`, `SL 401 pe rakhna`, `breakeven kar dana`) → acted on the open position

## Testing the WhatsApp layer

```bash
npm run test:wa   # connects to WhatsApp servers with Baileys 7, prints a QR,
                  # verifies the full event wiring — exits 0 when the layer works
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| QR appears again after a restart | instance was recycled → sessions lost. Re-scan; keepalive prevents this |
| Logs stall at `waiting for the login dialog...` | GWT boot is slow (10–40 s) or the terminal blocked the headless browser. First check the screenshot; then confirm `WEBTERMINAL_UA` is a desktop Chrome UA and that `navigator.webdriver` hiding is active (it is, unless you edited `applyStealth`) |
| `Authorization Failed` | wrong password type (trading vs PA password), wrong server name, or the account server differs from `EXNESS_SERVER` |
| Platform stuck on MetaTrader 4 | the MT5 switch control changed → screenshot shows the dialog; click the switch yourself in the screenshot context and update `loginFlow` |
| `Volume / Stop Loss / Take Profit field not found` | order-ticket layout changed → `npm run dump-dom`, check `.runtime/dom-dump.json`, update the label match-strings |
| OOM / crash during execution | browser + Node too heavy → keep `PUPPETEER_HEADLESS=shell`, make sure browser closes (`browser closed (memory released)` in logs) |
| No trade but `✅` reply | you're in `EXECUTION_MODE=log` (dry-run) |
| Trade "succeeds" but nothing on account | the F9 ticket opened on the chart's current symbol (no search box found) → set the symbol via Market Watch in the terminal first, or map the symbol field in `placeOrder` |
| Service asleep | ping not running → check cron-job.org job / URL |
| Every run re-logins + captcha | clear `.runtime/browser-profile` only when login is broken; otherwise keep it so the session persists |
| `could not close_position on XAUUSD: ...` | terminal layout drifted (GWT update). Screenshot in `.runtime/screenshots/` shows where; close it manually, then run `npm run dump-dom` and re-map in `position-manager.js` |
| Management says "no open position tracked" | bot restarted (tracking reset). The real position is still in the terminal — the instruction falls back to a manual note. `addPosition` re-enables tracking on the next trade |
| Gemini returns 429s | free-tier rate limit — the bot falls back to rules automatically, or bump `GEMINI_MODEL` chain / wait |

## Going beyond (when the demo proves the pipeline)

1. **Selector-proof execution:** replace the puppeteer case in `executor.js` with an API case. Exness offers API access in the PA for some account types; MetaApi (metaapi.cloud) has a free tier and runs MT5 in the cloud — no browser at all.
2. **Move off free hosting** when it matters: Oracle Cloud "Always Free" VM (needs a card to verify, so later, not now), or any $5 VPS.
3. **Never** point this at a live funded account without a proper API and real risk management.

---

## Safety

- Demo only. Zero real money involved in testing.
- Your trading password sits in Render env vars (not in code, not in the repo). Rotate it after testing if you like.
- The bot only acts on the configured channel + provider. Member chatter and DMs are ignored. Set `ALLOWED_SENDERS` if you also want `/status` from your own number only.
