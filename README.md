# telegram-totp-bot

**Self-hosted 2FA (TOTP) authenticator for Telegram** — bot, Telegram Mini App and
web app with passkey login. Every user gets a private, encrypted vault on *your*
server: no third-party services, no cloud, no tracking.

🇮🇹 [Leggi in italiano](README.it.md)

- 🔐 TOTP codes (RFC 6238, SHA1/SHA256/SHA512, 6–8 digits, custom periods)
- 👥 Multi-user: one isolated vault per Telegram user, each with its own key
- 📷 Add accounts by QR code: photo sent to the bot, or live camera scanner in the app
- 📁 Categories (multi-tag), search, brand logos (simple-icons, served locally)
- 📥📤 Import/export compatible with **Ente Auth** (plain text and encrypted)
- 📱 Telegram Mini App with a "liquid glass" UI and 7 themes (light and dark)
- 🌐 Web app in any browser, sign in **with Telegram** or with a **passkey**
- 🛡️ Hardened by default: AES-256-GCM, HKDF per-user keys, signed `initData`,
  HttpOnly/SameSite cookies, CSRF origin checks, rate limits, auto-deleting messages

> The UI and bot messages are currently in Italian. Contributions for i18n are welcome.

## How it works

```
Telegram ──(Bot API, polling or webhook)──► telegram-totp-bot (Node.js) ◄──HTTPS── reverse proxy ◄── Mini App / browser
                                              │
                                              └── data/ (per-user encrypted vaults, sessions, passkeys)
```

The secrets never leave the server: the bot, the Mini App and the web app only
receive the **current** and **next** code, never the TOTP seed (only an explicit export, sent to your private chat, contains the seeds).

## Requirements

- Node.js **20+** (or Docker)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- For the Mini App and the web app: a domain with **HTTPS** pointing to the server
  (Telegram only accepts HTTPS Mini Apps; passkeys require a secure origin).
  The bot itself works without it.

## Quick start

### Docker

```bash
git clone https://github.com/paki81/telegram-totp-bot.git
cd telegram-totp-bot
cp .env.example .env
# edit .env: BOT_TOKEN, MASTER_KEY (openssl rand -hex 32), MINIAPP_URL
docker compose up -d --build
```

### Node.js

```bash
git clone https://github.com/paki81/telegram-totp-bot.git
cd telegram-totp-bot
npm ci --omit=dev
cp .env.example .env   # then edit it
npm start
# or keep it running with PM2:
pm2 start ecosystem.config.js && pm2 save
```

Then open your bot in Telegram and send `/start`.

### HTTPS (Mini App and web app)

Expose `HTTP_PORT` (default `8788`) through a reverse proxy with TLS and set
`MINIAPP_URL` (and optionally `WEB_ORIGIN`) to the public URL. Example with Caddy:

```
2fa.example.com {
    reverse_proxy 127.0.0.1:8788
}
```

With nginx or Nginx Proxy Manager forward the `X-Real-IP` header so that login
notifications show the real client IP. On restart the bot automatically sets the
chat menu button "🔐 Codici 2FA" pointing to the Mini App.

## Configuration

All options live in `.env` (see [.env.example](.env.example)):

| Variable | Default | Description |
|---|---|---|
| `BOT_TOKEN` | — | Bot token (required) |
| `ALLOWED_USERS` | — | `*` = everyone, or comma-separated Telegram user IDs (required) |
| `MASTER_KEY` / `MASTER_PASSPHRASE` | — | Master secret for vault encryption (required, keep it safe) |
| `OWNER_ID` | first allowed ID | Receives accounts from a legacy single-user store |
| `MINIAPP_URL` | — | Public HTTPS URL of the Mini App |
| `WEB_ORIGIN` | origin of `MINIAPP_URL` | Origin for web sessions and passkeys (rpID) |
| `HTTP_PORT` / `HTTP_HOST` | `8788` / `0.0.0.0` | HTTP server bind |
| `CODE_TTL_SECONDS` | `30` | Auto-delete delay for code messages |
| `MAX_ACCOUNTS_PER_USER` | `500` | Per-user limit |
| `WEB_SESSION_IDLE_HOURS` / `WEB_SESSION_MAX_DAYS` | `12` / `7` | Web session lifetime |
| `MODE` | `polling` | `polling` or `webhook` (`WEBHOOK_SECRET`, `WEBHOOK_PUBLIC_URL`, optional `RELAY_URL`) |
| `DATA_DIR` | `./data` | Storage directory |

## Usage

**Bot commands:** `/start` menu · `/add` · `/code` · `/list` · `/cat` categories ·
`/import` · `/export` · `/scan` · `/del` · `/cancel` · `/help`.
Every list has inline buttons; code messages offer refresh, categories and close.
Send a **photo of a QR code** or an **export file** directly to the bot.

**Mini App / web app:** live codes with countdown ring and "next" code, tap to copy,
search, category filter chips, add/edit/delete, QR scanner (native Telegram scanner or
browser camera), import/export, themes, and *⋯ → Sicurezza e accessi* to manage
passkeys and web sessions.

### Browser access

1. Open your `WEB_ORIGIN` and choose **Accedi con Telegram**.
2. The page shows a verification code, a deep link and a QR code (for phones).
3. The bot asks for confirmation, showing browser, IP and the same code:
   tap **Consenti accesso** only if the code matches.
4. Afterwards add a **passkey** (*⋯ → Sicurezza e accessi*) to sign in with
   fingerprint, face or device PIN. Register passkeys from a real browser:
   Telegram's in-app webviews often don't support WebAuthn.

Every new web login and every new passkey triggers a notification in the bot.

### Import / export (Ente Auth format)

- **Plain text**: one `otpauth://` URI per line, with Ente's `codeDisplay` metadata
  (tags become categories; trashed items are skipped; duplicates are detected).
- **Encrypted**: `{ version, kdfParams{memLimit,opsLimit,salt}, encryptedData, encryptionNonce }`
  with Argon2id + XChaCha20-Poly1305 secretstream (libsodium), the same format as
  Ente Auth's encrypted export. Our exports decrypt with the official
  `ente auth decrypt` CLI.
- Exports are delivered as a document in the private bot chat. Plain exports require
  an explicit confirmation and are deleted from the chat after 10 minutes.

## Security model

- **Vaults**: one file per user, `data/users/<HMAC(master, uid)>.json` (the file name
  does not reveal the user ID), key = `HKDF-SHA256(master, uid)`, every secret encrypted
  with AES-256-GCM and AAD bound to user and account. A blob copied into another vault
  cannot be decrypted. Files are written with mode `600`.
- **Telegram auth**: Mini App requests carry `initData` verified with HMAC-SHA256
  (bot token) and a 24h freshness check. The bot only works in private chats.
- **Mini App gate**: the public page is just a loader; the real app (HTML/CSS/JS)
  is served only after authentication.
- **Web sessions**: random 256-bit token in a `__Host-` cookie (HttpOnly, Secure,
  SameSite=Strict); only its SHA-256 is stored. Cookie-authenticated API calls must
  carry `Origin == WEB_ORIGIN`. Idle and absolute expiry; revocable from the app.
- **Telegram login for browsers**: single-use request valid 5 minutes, bound to the
  initiating browser via a secret poll token, plus a verification code shown on both
  sides against phishing.
- **Passkeys**: WebAuthn via `@simplewebauthn/server`, user verification required,
  opaque user handle (HMAC), signature counter tracked.
- **Abuse protection**: rate limits on messages, API, logins, imports, exports and
  password attempts; Argon2 parameters of imported files are capped and run in a
  worker thread, one at a time.
- **Hygiene**: messages with codes self-destruct; photos of QR codes, imported files
  and passwords are deleted from the chat right after use.

**Limitation**: encryption happens server-side. Users are isolated from each other,
but whoever controls the server *and* `MASTER_KEY` can technically decrypt the vaults.
Host it yourself, or only use instances run by someone you trust.

## Tests

```bash
npm ci
npm test
```

`test.js` (RFC 6238 vectors, vault isolation, migration, Ente formats), `smoke.js`
(end-to-end bot flows against a mocked Bot API, multi-user isolation, web login with
Telegram, passkeys via a software authenticator) and `webapp-test.js` (the Mini App in
a real DOM with jsdom).

## Credits

[simple-icons](https://simpleicons.org) (brand logos, CC0), [jsQR](https://github.com/cozmo/jsQR),
[libsodium.js](https://github.com/jedisct1/libsodium.js), [SimpleWebAuthn](https://simplewebauthn.dev).
Brand names and logos belong to their respective owners. Not affiliated with Telegram or Ente.

## License

[AGPL-3.0](LICENSE). If you run a modified version as a public service you must make
its source code available to its users.

😎
