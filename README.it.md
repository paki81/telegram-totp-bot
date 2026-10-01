# telegram-totp-bot

**Autenticatore 2FA (TOTP) self-hosted per Telegram** — bot, Mini App di Telegram e
web app con accesso tramite passkey. Ogni utente ha un vault privato e cifrato sul
*tuo* server: niente servizi di terze parti, niente cloud, niente tracciamento.

🇬🇧 [Read in English](README.md)

- 🔐 Codici TOTP (RFC 6238, SHA1/SHA256/SHA512, 6–8 cifre, periodi personalizzati)
- 👥 Multi-utente: un vault isolato per ogni utente Telegram, ognuno con la sua chiave
- 📷 Aggiunta tramite QR code: foto inviata al bot o scanner con fotocamera nell'app
- 📁 Categorie (più tag per account), ricerca, loghi dei servizi (simple-icons, in locale)
- 📥📤 Import/export compatibile con **Ente Auth** (testo in chiaro e cifrato)
- 📱 Mini App Telegram con grafica "liquid glass" e 7 temi (chiari e scuro)
- 🌐 Web app da qualsiasi browser, accesso **con Telegram** o con **passkey**
- 🛡️ Sicuro di default: AES-256-GCM, chiavi per utente con HKDF, `initData` firmato,
  cookie HttpOnly/SameSite, controllo Origin anti-CSRF, rate limit, messaggi a scadenza

## Come funziona

```
Telegram ──(Bot API, polling o webhook)──► telegram-totp-bot (Node.js) ◄──HTTPS── reverse proxy ◄── Mini App / browser
                                              │
                                              └── data/ (vault cifrati per utente, sessioni, passkey)
```

I secret non lasciano mai il server: bot, Mini App e web app ricevono solo il codice
**corrente** e il **successivo**, mai il seed TOTP (solo un export esplicito, inviato nella tua chat privata, contiene i seed).

## Requisiti

- Node.js **20+** (oppure Docker)
- Un token bot da [@BotFather](https://t.me/BotFather)
- Per Mini App e web app: un dominio in **HTTPS** che punta al server (Telegram accetta
  solo Mini App HTTPS; le passkey richiedono un'origine sicura). Il bot funziona anche senza.

## Avvio rapido

### Docker

```bash
git clone https://github.com/paki81/telegram-totp-bot.git
cd telegram-totp-bot
cp .env.example .env
# modifica .env: BOT_TOKEN, MASTER_KEY (openssl rand -hex 32), MINIAPP_URL
docker compose up -d --build
```

### Node.js

```bash
git clone https://github.com/paki81/telegram-totp-bot.git
cd telegram-totp-bot
npm ci --omit=dev
cp .env.example .env   # e modificalo
npm start
# oppure, permanente con PM2:
pm2 start ecosystem.config.js && pm2 save
```

Poi apri il bot su Telegram e invia `/start`.

### HTTPS (Mini App e web app)

Esponi `HTTP_PORT` (default `8788`) tramite un reverse proxy con TLS e imposta
`MINIAPP_URL` (ed eventualmente `WEB_ORIGIN`) all'URL pubblico. Esempio con Caddy:

```
2fa.example.com {
    reverse_proxy 127.0.0.1:8788
}
```

Con nginx o Nginx Proxy Manager inoltra l'header `X-Real-IP`, così le notifiche di
accesso mostrano l'IP reale. Al riavvio il bot imposta da solo il pulsante menu
"🔐 Codici 2FA" che apre la Mini App.

## Configurazione

Tutte le opzioni sono in `.env` (vedi [.env.example](.env.example)):

| Variabile | Default | Descrizione |
|---|---|---|
| `BOT_TOKEN` | — | Token del bot (obbligatorio) |
| `ALLOWED_USERS` | — | `*` = tutti, oppure ID Telegram separati da virgola (obbligatorio) |
| `MASTER_KEY` / `MASTER_PASSPHRASE` | — | Segreto master per la cifratura (obbligatorio, custodiscilo) |
| `OWNER_ID` | primo ID consentito | Riceve gli account di un vecchio store mono-utente |
| `MINIAPP_URL` | — | URL pubblico HTTPS della Mini App |
| `WEB_ORIGIN` | origin di `MINIAPP_URL` | Origin per sessioni web e passkey (rpID) |
| `HTTP_PORT` / `HTTP_HOST` | `8788` / `0.0.0.0` | Indirizzo del server HTTP |
| `CODE_TTL_SECONDS` | `30` | Dopo quanto si cancellano i messaggi con i codici |
| `MAX_ACCOUNTS_PER_USER` | `500` | Limite per utente |
| `WEB_SESSION_IDLE_HOURS` / `WEB_SESSION_MAX_DAYS` | `12` / `7` | Durata sessioni web |
| `MODE` | `polling` | `polling` o `webhook` (`WEBHOOK_SECRET`, `WEBHOOK_PUBLIC_URL`, `RELAY_URL` opzionale) |
| `DATA_DIR` | `./data` | Cartella dei dati |

## Utilizzo

**Comandi del bot:** `/start` menu · `/add` · `/code` · `/list` · `/cat` categorie ·
`/import` · `/export` · `/scan` · `/del` · `/cancel` · `/help`.
Ogni elenco ha tasti inline; i messaggi con i codici hanno aggiorna, categorie e chiudi.
Puoi inviare direttamente al bot la **foto di un QR code** o un **file di export**.

**Mini App / web app:** codici in tempo reale con anello del countdown e codice
successivo, tocca per copiare, ricerca, filtro per categoria, aggiunta/modifica/eliminazione,
scanner QR (nativo di Telegram o fotocamera del browser), import/export, temi e
*⋯ → Sicurezza e accessi* per gestire passkey e sessioni web.

### Accesso da browser

1. Apri il tuo `WEB_ORIGIN` e scegli **Accedi con Telegram**.
2. La pagina mostra un codice di verifica, un link al bot e un QR (per il telefono).
3. Il bot chiede conferma mostrando browser, IP e lo stesso codice: premi
   **Consenti accesso** solo se il codice coincide.
4. Poi aggiungi una **passkey** (*⋯ → Sicurezza e accessi*) per entrare con impronta,
   volto o PIN del dispositivo. Registra le passkey da un browser vero: le webview
   interne di Telegram spesso non supportano WebAuthn.

Ogni nuovo accesso web e ogni nuova passkey generano una notifica nel bot.

### Import / export (formato Ente Auth)

- **Testo in chiaro**: un URI `otpauth://` per riga, con i metadati `codeDisplay` di
  Ente (i tag diventano categorie; gli elementi nel cestino vengono saltati; i duplicati
  vengono riconosciuti).
- **Cifrato**: `{ version, kdfParams{memLimit,opsLimit,salt}, encryptedData, encryptionNonce }`
  con Argon2id + XChaCha20-Poly1305 secretstream (libsodium), lo stesso formato
  dell'export cifrato di Ente Auth. I nostri export si decifrano con la CLI ufficiale
  `ente auth decrypt`.
- Gli export arrivano come documento nella chat privata del bot. L'export in chiaro
  richiede una conferma esplicita e viene cancellato dalla chat dopo 10 minuti.

## Modello di sicurezza

- **Vault**: un file per utente, `data/users/<HMAC(master, uid)>.json` (il nome non
  rivela lo user ID), chiave = `HKDF-SHA256(master, uid)`, ogni secret cifrato con
  AES-256-GCM e AAD legata a utente e account. Un blob copiato in un altro vault non si
  decifra. File con permessi `600`.
- **Autenticazione Telegram**: le richieste della Mini App portano `initData` verificato
  con HMAC-SHA256 (token del bot) e scadenza 24h. Il bot lavora solo in chat privata.
- **Gate della Mini App**: la pagina pubblica è solo un caricatore; l'app vera
  (HTML/CSS/JS) viene servita solo dopo l'autenticazione.
- **Sessioni web**: token casuale a 256 bit in un cookie `__Host-` (HttpOnly, Secure,
  SameSite=Strict); sul server si salva solo l'hash SHA-256. Le API con cookie
  richiedono `Origin == WEB_ORIGIN`. Scadenza per inattività e assoluta; revocabili dall'app.
- **Login Telegram da browser**: richiesta monouso valida 5 minuti, legata al browser
  che l'ha avviata tramite un poll token segreto, più un codice di verifica mostrato da
  entrambe le parti contro il phishing.
- **Passkey**: WebAuthn con `@simplewebauthn/server`, verifica utente obbligatoria,
  user handle opaco (HMAC), contatore delle firme controllato.
- **Anti-abuso**: rate limit su messaggi, API, login, import, export e tentativi di
  password; i parametri Argon2 dei file importati sono limitati e il calcolo gira in un
  worker thread, uno alla volta.
- **Igiene**: i messaggi con i codici si autodistruggono; foto dei QR, file importati e
  password vengono cancellati dalla chat subito dopo l'uso.

**Limite**: la cifratura avviene lato server. Gli utenti sono isolati tra loro, ma chi
controlla il server *e* la `MASTER_KEY` può tecnicamente decifrare i vault. Ospitalo tu,
oppure usa solo istanze gestite da qualcuno di cui ti fidi.

## Test

```bash
npm ci
npm test
```

`test.js` (vettori RFC 6238, isolamento dei vault, migrazione, formati Ente), `smoke.js`
(flussi completi del bot con Bot API simulata, isolamento multi-utente, login web con
Telegram, passkey tramite autenticatore software) e `webapp-test.js` (la Mini App in un
DOM reale con jsdom).

## Crediti

[simple-icons](https://simpleicons.org) (loghi, CC0), [jsQR](https://github.com/cozmo/jsQR),
[libsodium.js](https://github.com/jedisct1/libsodium.js), [SimpleWebAuthn](https://simplewebauthn.dev).
Nomi e loghi dei servizi appartengono ai rispettivi proprietari. Non affiliato a Telegram o Ente.

## Licenza

[AGPL-3.0](LICENSE). Se offri una versione modificata come servizio pubblico devi
renderne disponibile il codice sorgente ai suoi utenti.
