'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Telegram } = require('./telegram');
const { Vaults, migrateLegacy, loadMasterKey } = require('./store');
const { totp, secondsRemaining, parseAccountInput, validateAccount } = require('./totp');
const { decodeQr } = require('./qr');
const ente = require('./ente');
const { matchBrand } = require('./brands');
const { WebAuth, describeUA } = require('./webauth');
const QRCode = require('qrcode');

// ---------- .env loader minimale ----------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
const env = process.env;

const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const LEGACY_STORE = env.STORE_FILE || path.join(DATA_DIR, 'secrets.json');
const VAULTS_DIR = env.VAULTS_DIR || path.join(DATA_DIR, 'users');
const CODE_TTL = Math.max(5, parseInt(env.CODE_TTL_SECONDS || '30', 10));
const MODE = (env.MODE || 'polling').toLowerCase();
const RELAY_URL = env.RELAY_URL || '';
const HTTP_PORT = parseInt(env.HTTP_PORT || env.WEBHOOK_PORT || '8788', 10);
const MINIAPP_URL = (env.MINIAPP_URL || '').replace(/\/$/, ''); // URL pubblico HTTPS della mini app
const WEBAPP_DIR = path.join(__dirname, 'webapp');
const MAX_ACCOUNTS = Math.max(1, parseInt(env.MAX_ACCOUNTS_PER_USER || '500', 10));
const MAX_IMPORT_BYTES = 1024 * 1024;
const PLAIN_EXPORT_TTL_MIN = 10;

// ALLOWED_USERS: lista di user ID separati da virgola, oppure "*" per aprire il bot a tutti.
// Ogni utente ha comunque un vault separato e cifrato con una chiave propria.
const allowedRaw = (env.ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const OPEN_ACCESS = allowedRaw.includes('*');
const allowedUsers = new Set(allowedRaw.filter((s) => s !== '*'));
const OWNER_ID = (env.OWNER_ID || [...allowedUsers][0] || '').trim();

if (!env.BOT_TOKEN) {
  console.error('BOT_TOKEN mancante: crea un bot con @BotFather e metti il token in .env');
  process.exit(1);
}
if (!OPEN_ACCESS && !allowedUsers.size) {
  console.error('ALLOWED_USERS vuoto: metti il tuo user ID Telegram, oppure "*" per aprire il bot a tutti');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const masterKey = loadMasterKey(env, DATA_DIR);
const vaults = new Vaults(VAULTS_DIR, masterKey, { maxAccounts: MAX_ACCOUNTS });
const tg = new Telegram(env.BOT_TOKEN);

// migrazione del vecchio store unico nel vault del proprietario
if (fs.existsSync(LEGACY_STORE)) {
  if (/^\d+$/.test(OWNER_ID)) {
    const n = migrateLegacy(LEGACY_STORE, masterKey, vaults.for(OWNER_ID));
    console.log(`Migrazione: ${n} account spostati nel vault del proprietario (${OWNER_ID}). Backup: ${path.basename(LEGACY_STORE)}.migrated`);
  } else {
    console.error('Store legacy presente ma OWNER_ID non definito: migrazione rimandata');
  }
}

const isAllowedId = (uid) => OPEN_ACCESS || allowedUsers.has(String(uid));

// ---------- accesso da browser (sessioni, login Telegram, passkey) ----------
// origin pubblico HTTPS: necessario per cookie Secure e per le passkey (rpID = hostname)
const WEB_ORIGIN = (() => {
  try { return new URL(env.WEB_ORIGIN || MINIAPP_URL).origin; } catch { return ''; }
})();
const SESSION_COOKIE = '__Host-totp_sid';
const webAuth = new WebAuth({
  file: path.join(DATA_DIR, 'web.json'),
  origin: WEB_ORIGIN,
  secret: Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.from('totp-bot/web'), Buffer.from('webauthn'), 32)),
  sessionIdleHours: parseInt(env.WEB_SESSION_IDLE_HOURS || '12', 10),
  sessionMaxDays: parseInt(env.WEB_SESSION_MAX_DAYS || '7', 10),
});
let BOT_USERNAME = '';

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const sessionCookie = (token, maxAgeSec) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
const clientIp = (req) => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();

/** le richieste con cookie di sessione devono provenire dal nostro origin (anti-CSRF) */
function sameOrigin(req) {
  const o = req.headers.origin;
  return !!WEB_ORIGIN && o === WEB_ORIGIN;
}

function notifyWebLogin(uid, how, req) {
  const when = new Date().toLocaleString('it-IT', env.DISPLAY_TZ ? { timeZone: env.DISPLAY_TZ } : {});
  tg.sendMessage(uid, `🔐 <b>Nuovo accesso web</b> (${how})\n${esc(describeUA(req.headers['user-agent']))} · IP ${esc(clientIp(req))}\n${when}\n\nNon sei stato tu? Apri la Mini App → ⋯ → Sicurezza e disconnetti le sessioni.`).catch(() => {});
}

// Stato dei wizard per utente: { step, ... }
const pending = new Map();

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const spaced = (c) => (c.length > 4 ? `${c.slice(0, 3)} ${c.slice(3)}` : c);
const btnLabel = (s) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

// ---------- rate limit (sliding window in memoria) ----------
const hits = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 600000)) hits.delete(k);
}, 600000).unref();

// ---------- testi e tastiere ----------
const HELP = [
  '<b>Bot 2FA personale</b> — genera codici TOTP sul server, il tuo vault è privato e cifrato.',
  '',
  '/add — aggiungi un account (wizard guidato)',
  '/add &lt;nome&gt; &lt;secret|otpauth://…&gt; — aggiunta rapida',
  '/code — tastiera con i tuoi account',
  '/code &lt;nome&gt; — codice immediato',
  '/list — elenca gli account',
  '/cat — gestisci le categorie',
  '/import — importa da Ente Auth (testo o cifrato)',
  '/export — esporta in formato Ente Auth',
  '/del &lt;nome&gt; — elimina un account',
  '/scan — scansiona un QR code',
  '/cancel — annulla l\'operazione in corso',
  '',
  '📷 Puoi anche <b>inviare una foto del QR code</b> o <b>il file di export di Ente Auth</b>.',
  `I messaggi con i codici si auto-eliminano dopo ${CODE_TTL}s. Ogni utente ha un vault separato, cifrato con una chiave dedicata (AES-256-GCM).`,
].join('\n');

const BOT_COMMANDS = [
  { command: 'start', description: 'Menu principale' },
  { command: 'add', description: 'Aggiungi un account 2FA' },
  { command: 'code', description: 'Genera un codice' },
  { command: 'list', description: 'Elenca gli account' },
  { command: 'cat', description: 'Gestisci le categorie' },
  { command: 'import', description: 'Importa da Ente Auth' },
  { command: 'export', description: 'Esporta in formato Ente Auth' },
  { command: 'scan', description: 'Scansiona un QR code' },
  { command: 'del', description: 'Elimina un account' },
  { command: 'cancel', description: 'Annulla operazione in corso' },
  { command: 'help', description: 'Aiuto' },
];

const SCAN_PROMPT = '📷 Inviami una <b>foto del QR code</b> (o un file immagine).\n' +
  'Se è un QR di attivazione 2FA salvo il secret cifrato, altrimenti ti mostro il contenuto.\n' +
  'La foto viene eliminata dopo la lettura.';

const IMPORT_PROMPT = '📥 <b>Importa da Ente Auth</b>\n\n' +
  'In Ente Auth: <i>Impostazioni → Dati → Esporta codici</i>, poi inviami qui il file:\n' +
  '• <b>Cifrato</b> (<code>.json</code>) — ti chiederò la password\n' +
  '• <b>Testo</b> (<code>.txt</code>) — un URI otpauth:// per riga\n\n' +
  'Le categorie (tag) di Ente vengono mantenute. Il file viene eliminato dalla chat dopo la lettura.';

const CANCEL_KEYBOARD = { inline_keyboard: [[{ text: '❌ Annulla', callback_data: 'cancel' }]] };

function menuKeyboard() {
  const rows = [
    [{ text: '➕ Aggiungi account', callback_data: 'menu:add' }],
    [{ text: '🔑 Codici', callback_data: 'menu:code' }, { text: '📋 Lista', callback_data: 'menu:list' }],
    [{ text: '📁 Categorie', callback_data: 'menu:cat' }, { text: '📷 Scansiona QR', callback_data: 'menu:scan' }],
    [{ text: '📥 Importa', callback_data: 'menu:import' }, { text: '📤 Esporta', callback_data: 'menu:export' }],
    [{ text: 'ℹ️ Aiuto', callback_data: 'menu:help' }],
  ];
  if (MINIAPP_URL) rows.unshift([{ text: '📱 Apri Mini App', web_app: { url: MINIAPP_URL } }]);
  return { inline_keyboard: rows };
}

function menuText(vault) {
  return `<b>Bot 2FA personale</b> — ${vault.size} account nel tuo vault privato.\nCosa vuoi fare?`;
}

const BACK_ROW = [{ text: '⬅️ Menu', callback_data: 'menu:main' }];

function accountsKeyboard(vault, prefix, filter, { back = true } = {}) {
  const list = vault.list().filter((a) => !filter || filter(a));
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [{ text: btnLabel(list[i].name), callback_data: `${prefix}:${list[i].id}` }];
    if (list[i + 1]) row.push({ text: btnLabel(list[i + 1].name), callback_data: `${prefix}:${list[i + 1].id}` });
    rows.push(row);
  }
  if (!rows.length) return null;
  if (back) rows.push(BACK_ROW);
  return { inline_keyboard: rows };
}

function listText(vault) {
  const list = vault.list();
  if (!list.length) return 'Nessun account. Aggiungine uno con /add o importa da Ente Auth con /import.';
  const cats = vault.categories();
  const lines = [`<b>I tuoi account (${list.length})</b>`];
  for (const c of cats) {
    const inCat = list.filter((a) => a.tags.includes(c));
    if (inCat.length) lines.push('', `📁 <b>${esc(c)}</b>`, ...inCat.map((a) => `• ${esc(a.name)}`));
  }
  const none = list.filter((a) => !a.tags.length);
  if (none.length) lines.push('', cats.length ? '📄 <b>Senza categoria</b>' : '', ...none.map((a) => `• ${esc(a.name)}`));
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}

function categoriesView(vault) {
  const cats = vault.categories();
  const list = vault.list();
  const rows = cats.map((c, i) => [{ text: `📁 ${btnLabel(c)} (${list.filter((a) => a.tags.includes(c)).length})`, callback_data: `cv:${i}` }]);
  rows.push([{ text: '➕ Nuova categoria', callback_data: 'cn' }]);
  rows.push([{ text: '⬅️ Menu', callback_data: 'menu:main' }]);
  const text = cats.length
    ? '📁 <b>Categorie</b>\nTocca una categoria per vederne i codici, rinominarla o eliminarla.\nPer assegnare una categoria apri un codice e premi 🏷.'
    : '📁 <b>Categorie</b>\nNon hai ancora categorie. Creane una per organizzare i codici (es. Lavoro, Server, Social).';
  return { text, reply_markup: { inline_keyboard: rows } };
}

function tagsKeyboard(vault, id) {
  const acc = vault.list().find((a) => a.id === id);
  const cats = vault.categories();
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [];
    for (const j of [i, i + 1]) {
      if (cats[j] === undefined) continue;
      row.push({ text: `${acc.tags.includes(cats[j]) ? '✅' : '▫️'} ${btnLabel(cats[j])}`, callback_data: `tt:${id}:${j}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '➕ Nuova categoria', callback_data: `tn:${id}` }, { text: '✔️ Fatto', callback_data: 'delmsg' }]);
  return { inline_keyboard: rows };
}

function codeMessage(vault, id) {
  if (!vault.has(id)) return null;
  const acc = vault.get(id);
  const code = totp(acc.keyBuf, acc);
  const remain = secondsRemaining(acc.period);
  const tags = acc.tags.length ? `\n🏷 ${acc.tags.map(esc).join(', ')}` : '';
  return {
    text: `<b>${esc(acc.name)}</b>${acc.issuer ? ` (${esc(acc.issuer)})` : ''}${tags}\n\n<code>${spaced(code)}</code>\n\n⏳ valido ancora ${remain}s — questo messaggio si elimina in ${CODE_TTL}s`,
    reply_markup: {
      inline_keyboard: [[
        { text: '🔄 Aggiorna', callback_data: `r:${id}` },
        { text: '🏷 Categorie', callback_data: `t:${id}` },
        { text: '🗑 Chiudi', callback_data: 'delmsg' },
      ]],
    },
  };
}

async function sendCode(chatId, vault, id, replyTo) {
  const m = codeMessage(vault, id);
  if (!m) return tg.sendMessage(chatId, 'Account non trovato. Usa /list.');
  const sent = await tg.sendMessage(chatId, m.text, {
    reply_markup: m.reply_markup,
    ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
  });
  setTimeout(() => tg.deleteMessage(chatId, sent.message_id).catch(() => {}), CODE_TTL * 1000);
}

function exportKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔒 Cifrato (consigliato)', callback_data: 'ex:enc' }],
      [{ text: '📄 Testo in chiaro', callback_data: 'ex:plain' }],
      [{ text: '❌ Annulla', callback_data: 'cancel' }],
    ],
  };
}

// ---------- import / export ----------

/**
 * Importa una lista di URI otpauth nel vault (con tag Ente → categorie).
 */
function importUris(vault, uris) {
  const stats = { imported: 0, duplicates: 0, trashed: 0, invalid: 0, unsupported: 0, limit: false };
  for (const uri of uris) {
    try {
      if (!/^otpauth:\/\/totp\//i.test(uri)) { stats.unsupported++; continue; }
      const p = parseAccountInput(uri);
      if (p.trashed) { stats.trashed++; continue; }
      const acc = validateAccount(p);
      if (vault.isDuplicate(acc.key)) { stats.duplicates++; continue; }
      if (vault.size >= MAX_ACCOUNTS) { stats.limit = true; break; }
      vault.add({ name: acc.name, issuer: acc.issuer, secretBuf: acc.key, digits: acc.digits, period: acc.period, algorithm: acc.algorithm, tags: acc.tags, note: acc.note }, { save: false });
      stats.imported++;
    } catch {
      stats.invalid++;
    }
  }
  vault.save();
  return stats;
}

function importReport(s) {
  const lines = [`✅ <b>Importazione completata</b>: ${s.imported} account importati.`];
  if (s.duplicates) lines.push(`↩️ ${s.duplicates} già presenti (saltati)`);
  if (s.trashed) lines.push(`🗑 ${s.trashed} nel cestino di Ente (saltati)`);
  if (s.unsupported) lines.push(`⚠️ ${s.unsupported} non TOTP (HOTP/Steam non supportati)`);
  if (s.invalid) lines.push(`❌ ${s.invalid} non validi`);
  if (s.limit) lines.push(`⛔ Raggiunto il limite di ${MAX_ACCOUNTS} account`);
  return lines.join('\n');
}

async function sendExport(uid, format, password) {
  const vault = vaults.for(uid);
  const accounts = vault.exportAll();
  if (!accounts.length) throw new Error('Nessun account da esportare');
  if (format === 'encrypted') {
    const content = await ente.buildEncryptedExport(accounts, password);
    await tg.sendDocument(uid, ente.exportFileName('encrypted'), content, {
      caption: `🔒 Export cifrato di ${accounts.length} account (formato Ente Auth).\nImportabile in Ente Auth: Impostazioni → Dati → Importa codici → Ente Auth cifrato.`,
    });
  } else {
    const content = ente.buildPlainExport(accounts);
    const doc = await tg.sendDocument(uid, ente.exportFileName('plain'), content, {
      caption: `⚠️ Export IN CHIARO di ${accounts.length} account (formato Ente Auth).\nChiunque abbia questo file può generare i tuoi codici: salvalo subito, verrà eliminato dalla chat tra ${PLAIN_EXPORT_TTL_MIN} minuti.`,
    });
    setTimeout(() => tg.deleteMessage(uid, doc.message_id).catch(() => {}), PLAIN_EXPORT_TTL_MIN * 60000);
  }
  return accounts.length;
}

// ---------- handler messaggi ----------

async function handleText(msg) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const vault = vaults.for(uid);
  const text = (msg.text || '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const command = cmd.split('@')[0].toLowerCase();

  // wizard in corso: solo testo semplice alimenta il wizard, i comandi passano al router
  if (pending.has(uid) && !command.startsWith('/')) return handleWizard(msg, vault, pending.get(uid));

  switch (command) {
    case '/start':
      if (rest[0] && rest[0].startsWith('login_')) return askWebLogin(chatId, rest[0].slice(6));
    // fallthrough
    case '/menu':
      return tg.sendMessage(chatId, menuText(vault), { reply_markup: menuKeyboard() });

    case '/help':
      return tg.sendMessage(chatId, HELP, { reply_markup: menuKeyboard() });

    case '/cancel':
      pending.delete(uid);
      return tg.sendMessage(chatId, 'Operazione annullata.', { reply_markup: menuKeyboard() });

    case '/scan':
      pending.set(uid, { step: 'scan' });
      return tg.sendMessage(chatId, SCAN_PROMPT, { reply_markup: CANCEL_KEYBOARD });

    case '/import':
      pending.set(uid, { step: 'import' });
      return tg.sendMessage(chatId, IMPORT_PROMPT, { reply_markup: CANCEL_KEYBOARD });

    case '/export':
      return tg.sendMessage(chatId, '📤 <b>Esporta in formato Ente Auth</b>\nScegli il formato:', { reply_markup: exportKeyboard() });

    case '/cat':
    case '/categorie': {
      const v = categoriesView(vault);
      return tg.sendMessage(chatId, v.text, { reply_markup: v.reply_markup });
    }

    case '/add': {
      if (rest.length >= 2) {
        const [name, ...secretParts] = rest;
        return finishAdd(msg, vault, name, secretParts.join(' '));
      }
      if (rest.length === 1) {
        pending.set(uid, { step: 'secret', name: rest[0] });
        return tg.sendMessage(chatId, `Inviami il <b>secret base32</b>, l'URI <code>otpauth://totp/...</code> oppure <b>una foto del QR code</b> per <b>${esc(rest[0])}</b>.\nIl messaggio verrà eliminato dopo il salvataggio.`, { reply_markup: CANCEL_KEYBOARD });
      }
      pending.set(uid, { step: 'name' });
      return tg.sendMessage(chatId, 'Nome del nuovo account (es. <code>github</code>):', { reply_markup: CANCEL_KEYBOARD });
    }

    case '/list':
      return tg.sendMessage(chatId, listText(vault), { reply_markup: accountsKeyboard(vault, 'c') || menuKeyboard() });

    case '/code': {
      if (rest.length) {
        const id = vault.findByName(rest.join(' '));
        return id ? sendCode(chatId, vault, id, msg.message_id) : tg.sendMessage(chatId, 'Account non trovato. Usa /list.');
      }
      const kb = accountsKeyboard(vault, 'c');
      if (!kb) return tg.sendMessage(chatId, 'Nessun account. Aggiungine uno con /add.');
      return tg.sendMessage(chatId, 'Scegli l\'account:', { reply_markup: kb });
    }

    case '/del': {
      if (!rest.length) {
        const kb = accountsKeyboard(vault, 'd');
        if (!kb) return tg.sendMessage(chatId, 'Nessun account salvato.');
        return tg.sendMessage(chatId, 'Quale account vuoi eliminare?', { reply_markup: kb });
      }
      const id = vault.findByName(rest.join(' '));
      if (!id) return tg.sendMessage(chatId, 'Account non trovato.');
      return tg.sendMessage(chatId, `Eliminare <b>${esc(vault.get(id).name)}</b>? L'operazione è definitiva.`, { reply_markup: confirmDelKeyboard(id) });
    }

    default:
      if (text.startsWith('/')) return tg.sendMessage(chatId, 'Comando non riconosciuto. /help per la lista.');
      return tg.sendMessage(chatId, 'Usa /help per vedere i comandi.', { reply_markup: menuKeyboard() });
  }
}

/** Richiesta di accesso web arrivata dal deep link: chiede conferma esplicita */
function askWebLogin(chatId, loginId) {
  const l = webAuth.getTelegramLogin(loginId);
  if (!l || l.status !== 'pending') {
    return tg.sendMessage(chatId, '⌛ Richiesta di accesso scaduta o già usata. Riprova dal browser.', { reply_markup: menuKeyboard() });
  }
  return tg.sendMessage(chatId, [
    '🔐 <b>Richiesta di accesso web</b>',
    '',
    `Browser: <b>${esc(l.ua)}</b>`,
    `IP: <code>${esc(l.ip)}</code>`,
    `Codice di verifica: <b>${esc(l.code)}</b>`,
    '',
    '⚠️ Consenti solo se l\'accesso l\'hai richiesto tu e il codice <b>coincide</b> con quello mostrato nel browser. Chi accede vedrà i tuoi codici 2FA.',
  ].join('\n'), {
    reply_markup: { inline_keyboard: [[{ text: '✅ Consenti accesso', callback_data: `wl:${loginId}` }, { text: '❌ Rifiuta', callback_data: `wn:${loginId}` }]] },
  });
}

const confirmDelKeyboard = (id) => ({
  inline_keyboard: [[{ text: 'Sì, elimina', callback_data: `dc:${id}` }, { text: 'Annulla', callback_data: 'cancel' }]],
});

async function handleWizard(msg, vault, state) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const text = (msg.text || '').trim();

  switch (state.step) {
    case 'name': {
      const name = text.slice(0, 80);
      pending.set(uid, { step: 'secret', name });
      return tg.sendMessage(chatId, `Ok, <b>${esc(name)}</b>. Ora inviami il <b>secret base32</b>, l'URI <code>otpauth://totp/...</code> oppure <b>una foto del QR code</b>.\nIl messaggio verrà eliminato dopo il salvataggio.`, { reply_markup: CANCEL_KEYBOARD });
    }
    case 'secret':
      return finishAdd(msg, vault, state.name, text);
    case 'qrname':
      return finishAdd(msg, vault, text, state.qr);
    case 'scan':
      return tg.sendMessage(chatId, 'Attendo una <b>foto del QR code</b>.', { reply_markup: CANCEL_KEYBOARD });
    case 'import':
      return tg.sendMessage(chatId, 'Attendo il <b>file di export</b> di Ente Auth (.txt o .json).', { reply_markup: CANCEL_KEYBOARD });

    case 'importpw': {
      // la password non deve restare in chat
      tg.deleteMessage(chatId, msg.message_id).catch(() => {});
      if (rateLimited(`pw:${uid}`, 5, 600000)) {
        pending.delete(uid);
        return tg.sendMessage(chatId, '⛔ Troppi tentativi. Riprova tra qualche minuto con /import.');
      }
      const wait = await tg.sendMessage(chatId, '🔓 Decifratura in corso…');
      try {
        const uris = await ente.readExport(state.content, text);
        pending.delete(uid);
        const stats = importUris(vault, uris);
        return tg.editMessageText(chatId, wait.message_id, importReport(stats), { reply_markup: menuKeyboard() });
      } catch (e) {
        return tg.editMessageText(chatId, wait.message_id, `❌ ${esc(e.message)}\nReinvia la password oppure /cancel.`, { reply_markup: CANCEL_KEYBOARD });
      }
    }

    case 'exportpw': {
      tg.deleteMessage(chatId, msg.message_id).catch(() => {});
      if (text.length < 8) {
        return tg.sendMessage(chatId, '⚠️ La password deve avere almeno 8 caratteri. Inviane un\'altra:', { reply_markup: CANCEL_KEYBOARD });
      }
      pending.delete(uid);
      const wait = await tg.sendMessage(chatId, '🔒 Cifratura in corso…');
      try {
        const n = await sendExport(uid, 'encrypted', text);
        return tg.editMessageText(chatId, wait.message_id, `✅ Export cifrato di ${n} account inviato. Conserva la password: senza di essa il file non è recuperabile.`);
      } catch (e) {
        return tg.editMessageText(chatId, wait.message_id, `❌ Export non riuscito: ${esc(e.message)}`);
      }
    }

    case 'catnew': {
      pending.delete(uid);
      try {
        const name = vault.addCategory(text);
        if (state.assignTo && vault.has(state.assignTo)) {
          const acc = vault.get(state.assignTo);
          vault.update(state.assignTo, { tags: [...acc.tags, name] });
          return tg.sendMessage(chatId, `✅ Categoria <b>${esc(name)}</b> creata e assegnata a <b>${esc(acc.name)}</b>.`, { reply_markup: tagsKeyboard(vault, state.assignTo) });
        }
        const v = categoriesView(vault);
        return tg.sendMessage(chatId, `✅ Categoria <b>${esc(name)}</b> creata.\n\n${v.text}`, { reply_markup: v.reply_markup });
      } catch (e) {
        return tg.sendMessage(chatId, `❌ ${esc(e.message)}`, { reply_markup: menuKeyboard() });
      }
    }

    case 'catrename': {
      pending.delete(uid);
      try {
        const name = vault.renameCategory(state.old, text);
        const v = categoriesView(vault);
        return tg.sendMessage(chatId, `✅ Categoria rinominata in <b>${esc(name)}</b>.\n\n${v.text}`, { reply_markup: v.reply_markup });
      } catch (e) {
        return tg.sendMessage(chatId, `❌ ${esc(e.message)}`, { reply_markup: menuKeyboard() });
      }
    }
  }
}

async function finishAdd(msg, vault, name, secretInput) {
  const chatId = msg.chat.id;
  pending.delete(msg.from.id);
  // elimina il messaggio che contiene il secret
  tg.deleteMessage(chatId, msg.message_id).catch(() => {});
  try {
    const acc = validateAccount(parseAccountInput(secretInput, name));
    if (vault.isDuplicate(acc.key)) return tg.sendMessage(chatId, '↩️ Questo secret è già presente nel tuo vault.', { reply_markup: menuKeyboard() });
    const id = vault.add({ name: acc.name, issuer: acc.issuer, secretBuf: acc.key, digits: acc.digits, period: acc.period, algorithm: acc.algorithm, tags: acc.tags });
    await tg.sendMessage(chatId, `✅ Account <b>${esc(vault.get(id).name)}</b> salvato (cifrato).`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔑 Codice', callback_data: `c:${id}` }, { text: '🏷 Categoria', callback_data: `t:${id}` }],
          [{ text: '➕ Altro account', callback_data: 'menu:add' }],
        ],
      },
    });
  } catch (e) {
    await tg.sendMessage(chatId, `❌ Secret non valido: ${esc(e.message)}\nReinvia con /add.`, { reply_markup: menuKeyboard() });
  }
}

/** Foto e documenti immagine: scarica il file e decodifica il QR in locale. */
async function handleImage(msg, fileId) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const vault = vaults.for(uid);
  try {
    const buf = await tg.downloadFile(fileId);
    const data = decodeQr(buf);
    // la foto del QR contiene il secret: eliminala subito
    tg.deleteMessage(chatId, msg.message_id).catch(() => {});
    if (!data) return tg.sendMessage(chatId, '❌ Nessun QR code trovato nell\'immagine. Prova con una foto più nitida/ravvicinata.');
    if (/^otpauth:\/\//i.test(data.trim())) {
      const st = pending.get(uid);
      pending.delete(uid);
      const parsed = parseAccountInput(data, st?.name || null);
      if (parsed.name === 'account') {
        pending.set(uid, { step: 'qrname', qr: data });
        return tg.sendMessage(chatId, 'QR letto ✅ — che nome vuoi dare a questo account?', { reply_markup: CANCEL_KEYBOARD });
      }
      return finishAdd(msg, vault, parsed.name, data);
    }
    await tg.sendMessage(chatId, `📷 Contenuto del QR:\n\n<code>${esc(data)}</code>`);
  } catch (e) {
    await tg.sendMessage(chatId, `❌ Errore lettura QR: ${esc(e.message)}`);
  }
}

/** Documenti non immagine: export di Ente Auth (testo o cifrato). */
async function handleDocument(msg) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const doc = msg.document;
  if ((doc.file_size || 0) > MAX_IMPORT_BYTES) {
    return tg.sendMessage(chatId, '❌ File troppo grande (max 1 MB).');
  }
  if (rateLimited(`imp:${uid}`, 10, 600000)) return tg.sendMessage(chatId, '⛔ Troppe importazioni, riprova tra qualche minuto.');
  let text;
  try {
    text = (await tg.downloadFile(doc.file_id)).toString('utf8');
  } catch (e) {
    return tg.sendMessage(chatId, `❌ Download non riuscito: ${esc(e.message)}`);
  }
  // il file contiene secret: rimuovilo dalla chat
  tg.deleteMessage(chatId, msg.message_id).catch(() => {});

  if (ente.isEncryptedExport(text)) {
    pending.set(uid, { step: 'importpw', content: text });
    return tg.sendMessage(chatId, '🔒 Export cifrato di Ente Auth ricevuto.\nInviami la <b>password</b> usata per l\'export (il messaggio verrà eliminato subito).', { reply_markup: CANCEL_KEYBOARD });
  }
  const uris = await ente.readExport(text);
  if (!uris.length) {
    return tg.sendMessage(chatId, '❌ Nessun codice trovato. Invia un export di Ente Auth (.txt con URI otpauth:// oppure .json cifrato).');
  }
  pending.delete(uid);
  return tg.sendMessage(chatId, importReport(importUris(vaults.for(uid), uris)), { reply_markup: menuKeyboard() });
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat.id;
  const msgId = cb.message?.message_id;
  const uid = cb.from.id;
  if (!chatId) return;
  if (cb.message.chat.type !== 'private') return tg.answerCallbackQuery(cb.id, { text: 'Usami in chat privata', show_alert: true });
  if (!isAllowedId(uid)) return tg.answerCallbackQuery(cb.id, { text: 'Non autorizzato', show_alert: true });
  const vault = vaults.for(uid);

  const [action, arg, arg2] = (cb.data || '').split(':');
  const ack = (opts) => tg.answerCallbackQuery(cb.id, opts).catch(() => {});

  try {
    switch (action) {
      case 'menu': {
        await ack();
        if (arg === 'add') {
          pending.set(uid, { step: 'name' });
          return tg.editMessageText(chatId, msgId, 'Nome del nuovo account (es. <code>github</code>):', { reply_markup: CANCEL_KEYBOARD });
        }
        if (arg === 'code') {
          const kb = accountsKeyboard(vault, 'c');
          if (!kb) return tg.editMessageText(chatId, msgId, 'Nessun account. Aggiungine uno con /add.', { reply_markup: menuKeyboard() });
          return tg.editMessageText(chatId, msgId, 'Scegli l\'account:', { reply_markup: kb });
        }
        if (arg === 'list') return tg.editMessageText(chatId, msgId, listText(vault), { reply_markup: accountsKeyboard(vault, 'c') || menuKeyboard() });
        if (arg === 'cat') {
          const v = categoriesView(vault);
          return tg.editMessageText(chatId, msgId, v.text, { reply_markup: v.reply_markup });
        }
        if (arg === 'scan') {
          pending.set(uid, { step: 'scan' });
          return tg.editMessageText(chatId, msgId, SCAN_PROMPT, { reply_markup: CANCEL_KEYBOARD });
        }
        if (arg === 'import') {
          pending.set(uid, { step: 'import' });
          return tg.editMessageText(chatId, msgId, IMPORT_PROMPT, { reply_markup: CANCEL_KEYBOARD });
        }
        if (arg === 'export') return tg.editMessageText(chatId, msgId, '📤 <b>Esporta in formato Ente Auth</b>\nScegli il formato:', { reply_markup: exportKeyboard() });
        if (arg === 'help') return tg.editMessageText(chatId, msgId, HELP, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Menu', callback_data: 'menu:main' }]] } });
        return tg.editMessageText(chatId, msgId, menuText(vault), { reply_markup: menuKeyboard() });
      }

      // ---- codici ----
      case 'c':
        await ack();
        return sendCode(chatId, vault, arg, msgId);
      case 'r': {
        const m = codeMessage(vault, arg);
        if (!m) return ack({ text: 'Account non trovato', show_alert: true });
        try {
          await tg.editMessageText(chatId, msgId, m.text, { reply_markup: m.reply_markup });
          return ack();
        } catch (e) {
          return ack({ text: e.message.includes('not modified') ? 'Codice ancora valido' : 'Errore aggiornamento' });
        }
      }
      case 'delmsg':
        await ack();
        return tg.deleteMessage(chatId, msgId).catch(() => {});

      // ---- eliminazione account ----
      case 'd':
        await ack();
        if (!vault.has(arg)) return tg.editMessageText(chatId, msgId, 'Account non trovato.', { reply_markup: { inline_keyboard: [BACK_ROW] } });
        return tg.editMessageText(chatId, msgId, `Eliminare <b>${esc(vault.get(arg).name)}</b>? L'operazione è definitiva.`, { reply_markup: confirmDelKeyboard(arg) });
      case 'dc': {
        const acc = vault.has(arg) ? vault.get(arg) : null;
        vault.remove(arg);
        await ack({ text: 'Eliminato' });
        return tg.editMessageText(chatId, msgId, acc ? `🗑 Account <b>${esc(acc.name)}</b> eliminato.` : 'Account già eliminato.', { reply_markup: { inline_keyboard: [BACK_ROW] } });
      }

      // ---- categorie dell'account ----
      case 't':
        await ack();
        if (!vault.has(arg)) return tg.sendMessage(chatId, 'Account non trovato.');
        return tg.sendMessage(chatId, `🏷 Categorie di <b>${esc(vault.get(arg).name)}</b>:`, { reply_markup: tagsKeyboard(vault, arg) });
      case 'tt': {
        const cat = vault.categories()[+arg2];
        if (!vault.has(arg) || cat === undefined) return ack({ text: 'Non trovato' });
        const acc = vault.get(arg);
        const tags = acc.tags.includes(cat) ? acc.tags.filter((t) => t !== cat) : [...acc.tags, cat];
        vault.update(arg, { tags });
        await ack({ text: tags.includes(cat) ? `Aggiunto a ${cat}` : `Rimosso da ${cat}` });
        return tg.call('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: tagsKeyboard(vault, arg) });
      }
      case 'tn':
        await ack();
        pending.set(uid, { step: 'catnew', assignTo: arg });
        return tg.sendMessage(chatId, 'Nome della nuova categoria:', { reply_markup: CANCEL_KEYBOARD });

      // ---- gestione categorie ----
      case 'cn':
        await ack();
        pending.set(uid, { step: 'catnew' });
        return tg.editMessageText(chatId, msgId, 'Nome della nuova categoria (es. <code>Lavoro</code>):', { reply_markup: CANCEL_KEYBOARD });
      case 'cv': {
        await ack();
        const cat = vault.categories()[+arg];
        if (cat === undefined) return tg.editMessageText(chatId, msgId, 'Categoria non trovata.', { reply_markup: menuKeyboard() });
        const kb = accountsKeyboard(vault, 'c', (a) => a.tags.includes(cat), { back: false }) || { inline_keyboard: [] };
        kb.inline_keyboard.push(
          [{ text: '✏️ Rinomina', callback_data: `cr:${arg}` }, { text: '🗑 Elimina categoria', callback_data: `cd:${arg}` }],
          [{ text: '⬅️ Categorie', callback_data: 'menu:cat' }],
        );
        const n = vault.list().filter((a) => a.tags.includes(cat)).length;
        return tg.editMessageText(chatId, msgId, `📁 <b>${esc(cat)}</b> — ${n} account${n ? '' : '\nAssegna i codici a questa categoria con il tasto 🏷 di un codice.'}`, { reply_markup: kb });
      }
      case 'cr': {
        await ack();
        const cat = vault.categories()[+arg];
        if (cat === undefined) return;
        pending.set(uid, { step: 'catrename', old: cat });
        return tg.editMessageText(chatId, msgId, `Nuovo nome per <b>${esc(cat)}</b>:`, { reply_markup: CANCEL_KEYBOARD });
      }
      case 'cd': {
        const cat = vault.categories()[+arg];
        if (cat === undefined) return ack();
        vault.removeCategory(cat);
        await ack({ text: 'Categoria eliminata' });
        const v = categoriesView(vault);
        return tg.editMessageText(chatId, msgId, `🗑 Categoria <b>${esc(cat)}</b> eliminata (gli account restano nel vault).\n\n${v.text}`, { reply_markup: v.reply_markup });
      }

      // ---- export ----
      case 'ex':
        await ack();
        if (arg === 'enc') {
          pending.set(uid, { step: 'exportpw' });
          return tg.editMessageText(chatId, msgId, '🔒 Scegli una <b>password</b> per cifrare l\'export (almeno 8 caratteri).\nTi servirà per importarlo in Ente Auth. Il messaggio verrà eliminato subito.', { reply_markup: CANCEL_KEYBOARD });
        }
        return tg.editMessageText(chatId, msgId, `⚠️ <b>Attenzione</b>: l'export in chiaro contiene tutti i tuoi secret leggibili. Chiunque lo ottenga può generare i tuoi codici.\nIl file verrà eliminato dalla chat dopo ${PLAIN_EXPORT_TTL_MIN} minuti.`, {
          reply_markup: { inline_keyboard: [[{ text: 'Ho capito, esporta', callback_data: 'exp' }], [{ text: '❌ Annulla', callback_data: 'cancel' }]] },
        });
      case 'exp': {
        await ack();
        if (rateLimited(`exp:${uid}`, 5, 600000)) return tg.editMessageText(chatId, msgId, '⛔ Troppi export, riprova più tardi.');
        try {
          const n = await sendExport(uid, 'plain');
          return tg.editMessageText(chatId, msgId, `✅ Export in chiaro di ${n} account inviato.`);
        } catch (e) {
          return tg.editMessageText(chatId, msgId, `❌ ${esc(e.message)}`);
        }
      }

      // ---- accesso web ----
      case 'wl':
      case 'wn': {
        const l = webAuth.decideTelegramLogin(arg, uid, action === 'wl');
        if (!l) {
          await ack({ text: 'Richiesta scaduta', show_alert: true });
          return tg.editMessageText(chatId, msgId, '⌛ Richiesta di accesso scaduta o già usata.');
        }
        await ack({ text: action === 'wl' ? 'Accesso consentito' : 'Accesso rifiutato' });
        return tg.editMessageText(chatId, msgId, action === 'wl'
          ? `✅ Accesso web consentito a <b>${esc(l.ua)}</b>.\nPuoi gestire le sessioni dalla Mini App → ⋯ → Sicurezza.`
          : '❌ Accesso web rifiutato.');
      }

      case 'cancel':
        pending.delete(uid);
        await ack({ text: 'Annullato' });
        return tg.editMessageText(chatId, msgId, 'Operazione annullata.', { reply_markup: menuKeyboard() });
    }
    await ack();
  } catch (e) {
    console.error('callback error:', e.message);
    ack({ text: 'Errore interno', show_alert: true });
  }
}

const groupNotified = new Set();

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.message;
  if (!msg || !msg.from) return;

  // privacy: il bot lavora solo in chat privata (in un gruppo i codici sarebbero visibili a tutti)
  if (msg.chat.type !== 'private') {
    if (!groupNotified.has(msg.chat.id)) {
      groupNotified.add(msg.chat.id);
      tg.sendMessage(msg.chat.id, '🔒 Per privacy uso solo la chat privata: scrivimi direttamente.').catch(() => {});
    }
    return;
  }
  if (!isAllowedId(msg.from.id)) {
    return tg.sendMessage(msg.chat.id, `Non autorizzato. Il tuo Telegram user ID è: <code>${esc(msg.from.id)}</code>`);
  }
  if (rateLimited(`msg:${msg.from.id}`, 30, 60000)) return;

  if (msg.photo) return handleImage(msg, msg.photo[msg.photo.length - 1].file_id);
  if (msg.document) {
    if (/^image\//.test(msg.document.mime_type || '')) return handleImage(msg, msg.document.file_id);
    return handleDocument(msg);
  }
  if (msg.text) return handleText(msg);
}

async function relayUpdate(rawBody) {
  if (!RELAY_URL) return;
  try {
    await fetch(RELAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody });
  } catch (e) {
    console.error('relay error:', e.message);
  }
}

// ---------- Mini App: validazione initData ----------

const ICONS_DIR = path.join(__dirname, 'node_modules', 'simple-icons', 'icons');

/**
 * Verifica initData di una Telegram Mini App (firma HMAC con il bot token)
 * e che l'utente sia autorizzato.
 * @returns {object|null} user Telegram, o null
 */
function validateInitData(initData) {
  try {
    const params = new URLSearchParams(String(initData));
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheck = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest();
    const given = Buffer.from(hash, 'hex');
    if (given.length !== calc.length || !crypto.timingSafeEqual(given, calc)) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (Math.floor(Date.now() / 1000) - authDate > 86400) return null; // max 24h
    const user = JSON.parse(params.get('user') || 'null');
    if (!user?.id || !isAllowedId(user.id)) return null;
    return user;
  } catch {
    return null;
  }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function accountView(vault, meta) {
  const acc = vault.get(meta.id);
  const code = totp(acc.keyBuf, acc);
  const next = totp(acc.keyBuf, { ...acc, t: Date.now() + acc.period * 1000 });
  const brand = matchBrand(acc.name, acc.issuer);
  return {
    id: acc.id, name: acc.name, issuer: acc.issuer, tags: acc.tags, period: acc.period,
    code, spaced: spaced(code), next, nextSpaced: spaced(next),
    remaining: secondsRemaining(acc.period),
    icon: brand?.slug || null, color: brand?.color || null,
  };
}

/**
 * Autentica una richiesta API:
 *  - dentro Telegram: initData firmato nel body;
 *  - da browser: cookie di sessione + header Origin uguale al nostro (anti-CSRF).
 * @returns {{uid:string, via:'telegram'|'web', user?:object, token?:string}|null}
 */
function authenticate(req, body) {
  if (body.initData) {
    const user = validateInitData(body.initData);
    return user ? { uid: String(user.id), via: 'telegram', user } : null;
  }
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !sameOrigin(req)) return null;
  const s = webAuth.getSession(token);
  if (!s || !isAllowedId(s.uid)) return null;
  return { uid: s.uid, via: 'web', token };
}

async function handleApi(req, res, raw) {
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'JSON non valido' }); }
  const auth = authenticate(req, body);
  if (!auth) return json(res, 403, { error: 'Non autorizzato' });
  const { uid } = auth;
  if (rateLimited(`api:${uid}`, 120, 60000)) return json(res, 429, { error: 'Troppe richieste, riprova tra poco' });
  const vault = vaults.for(uid);
  const url = req.url.split('?')[0];

  try {
    switch (url) {
      // contesto della sessione (Telegram o browser)
      case '/api/session':
        return json(res, 200, {
          via: auth.via,
          webEnabled: webAuth.enabled,
          origin: WEB_ORIGIN,
          name: auth.user ? [auth.user.first_name, auth.user.last_name].filter(Boolean).join(' ') : null,
        });

      // ---- sicurezza: passkey e sessioni web ----
      case '/api/security':
        return json(res, 200, { passkeys: webAuth.listPasskeys(uid), sessions: webAuth.listSessions(uid, auth.token) });

      case '/api/passkey/options': {
        if (!webAuth.enabled) return json(res, 400, { error: 'Accesso web non configurato (WEB_ORIGIN)' });
        const userName = auth.user?.username ? `@${auth.user.username}` : String(body.userName || '').slice(0, 64) || null;
        return json(res, 200, await webAuth.registrationOptions(uid, userName));
      }
      case '/api/passkey/register': {
        await webAuth.verifyRegistration(uid, body.response, body.name);
        tg.sendMessage(uid, `🔑 Nuova passkey registrata: <b>${esc(String(body.name || 'Passkey').slice(0, 40))}</b>.\nSe non sei stato tu, eliminala dalla Mini App → ⋯ → Sicurezza.`).catch(() => {});
        return json(res, 200, { ok: true });
      }
      case '/api/passkey/delete':
        if (!webAuth.deletePasskey(uid, String(body.id || ''))) return json(res, 404, { error: 'Passkey non trovata' });
        return json(res, 200, { ok: true });

      case '/api/sessions/revoke': {
        const n = body.id ? webAuth.revokeSessions(uid, { id: String(body.id) }) : webAuth.revokeSessions(uid, { allExcept: auth.token });
        return json(res, 200, { ok: true, revoked: n });
      }

      // HTML della mini app: servito SOLO a chi è autenticato
      case '/api/app': {
        const read = (f) => fs.readFileSync(path.join(WEBAPP_DIR, f), 'utf8');
        return json(res, 200, { css: read('app.css'), html: read('app.html'), js: read('app.js') });
      }
      case '/api/list':
        return json(res, 200, { accounts: vault.list().map((m) => accountView(vault, m)), categories: vault.categories() });

      case '/api/add': {
        const acc = validateAccount(parseAccountInput(body.secret || '', String(body.name || '').trim() || null));
        if (vault.isDuplicate(acc.key)) return json(res, 409, { error: 'Questo secret è già presente' });
        const tags = Array.isArray(body.tags) ? body.tags : acc.tags;
        const id = vault.add({ name: acc.name, issuer: acc.issuer, secretBuf: acc.key, digits: acc.digits, period: acc.period, algorithm: acc.algorithm, tags });
        return json(res, 200, { ok: true, id, name: vault.get(id).name });
      }
      case '/api/update': {
        if (!vault.has(body.id)) return json(res, 404, { error: 'Account non trovato' });
        vault.update(body.id, {
          name: body.name !== undefined ? String(body.name) : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        });
        return json(res, 200, { ok: true });
      }
      case '/api/del':
        if (!vault.remove(String(body.id || ''))) return json(res, 404, { error: 'Account non trovato' });
        return json(res, 200, { ok: true });

      case '/api/category': {
        if (body.action === 'add') return json(res, 200, { ok: true, name: vault.addCategory(body.name) });
        if (body.action === 'rename') return json(res, 200, { ok: true, name: vault.renameCategory(String(body.name), body.newName) });
        if (body.action === 'delete') { vault.removeCategory(String(body.name)); return json(res, 200, { ok: true }); }
        return json(res, 400, { error: 'Azione non valida' });
      }

      case '/api/import': {
        if (rateLimited(`imp:${uid}`, 10, 600000)) return json(res, 429, { error: 'Troppe importazioni, riprova più tardi' });
        const content = String(body.content || '');
        if (!content) return json(res, 400, { error: 'File vuoto' });
        if (ente.isEncryptedExport(content)) {
          if (!body.password) return json(res, 400, { error: 'Password richiesta', needPassword: true });
          if (rateLimited(`pw:${uid}`, 5, 600000)) return json(res, 429, { error: 'Troppi tentativi di password' });
        }
        const uris = await ente.readExport(content, body.password);
        if (!uris.length) return json(res, 400, { error: 'Nessun codice trovato nel file' });
        return json(res, 200, { ok: true, ...importUris(vault, uris) });
      }

      case '/api/export': {
        if (rateLimited(`exp:${uid}`, 5, 600000)) return json(res, 429, { error: 'Troppi export, riprova più tardi' });
        const format = body.format === 'plain' ? 'plain' : 'encrypted';
        if (format === 'encrypted' && String(body.password || '').length < 8) {
          return json(res, 400, { error: 'La password deve avere almeno 8 caratteri' });
        }
        const n = await sendExport(uid, format, body.password);
        return json(res, 200, { ok: true, count: n });
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

// ---------- login da browser (non autenticato) ----------

async function handleAuth(req, res, raw) {
  if (!webAuth.enabled) return json(res, 404, { error: 'Accesso web non configurato' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'Origin non valido' });
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'JSON non valido' }); }
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '');
  const url = req.url.split('?')[0];
  const login = (uid, method) => {
    const token = webAuth.createSession(uid, { ua, ip, method });
    res.setHeader('Set-Cookie', sessionCookie(token, parseInt(env.WEB_SESSION_MAX_DAYS || '7', 10) * 86400));
  };

  try {
    switch (url) {
      // stato della sessione del browser: 200 sempre (evita 403 "rumorosi" al primo caricamento)
      case '/auth/session': {
        const s = webAuth.getSession(parseCookies(req)[SESSION_COOKIE]);
        return json(res, 200, { authenticated: !!(s && isAllowedId(s.uid)) });
      }
      case '/auth/telegram/start': {
        if (rateLimited(`tgl:${ip}`, 10, 600000)) return json(res, 429, { error: 'Troppi tentativi, riprova tra qualche minuto' });
        if (!BOT_USERNAME) return json(res, 503, { error: 'Bot non ancora connesso a Telegram, riprova' });
        const l = webAuth.startTelegramLogin({ ua, ip });
        const link = `https://t.me/${BOT_USERNAME}?start=login_${l.loginId}`;
        const qr = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return json(res, 200, { loginId: l.loginId, pollToken: l.pollToken, code: l.code, link, qr });
      }
      case '/auth/telegram/poll': {
        if (rateLimited(`tgp:${ip}`, 120, 60000)) return json(res, 429, { error: 'Troppe richieste' });
        const r = webAuth.pollTelegramLogin(String(body.loginId || ''), body.pollToken);
        if (r.status === 'approved') {
          if (!isAllowedId(r.uid)) return json(res, 403, { status: 'denied' });
          login(r.uid, 'Telegram');
          notifyWebLogin(r.uid, 'Telegram', req);
        }
        return json(res, 200, { status: r.status });
      }
      case '/auth/passkey/options':
        if (rateLimited(`pko:${ip}`, 30, 600000)) return json(res, 429, { error: 'Troppi tentativi' });
        return json(res, 200, await webAuth.authenticationOptions());
      case '/auth/passkey/verify': {
        if (rateLimited(`pkv:${ip}`, 20, 600000)) return json(res, 429, { error: 'Troppi tentativi' });
        const r = await webAuth.verifyAuthentication(body.response || {});
        if (!isAllowedId(r.uid)) return json(res, 403, { error: 'Non autorizzato' });
        login(r.uid, `passkey «${r.name}»`);
        notifyWebLogin(r.uid, `passkey «${r.name}»`, req);
        return json(res, 200, { ok: true });
      }
      case '/auth/logout':
        webAuth.destroySession(parseCookies(req)[SESSION_COOKIE]);
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

// ---------- server HTTP unico: Mini App + API + (opzionale) webhook ----------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function startHttpServer() {
  const secretPath = env.WEBHOOK_SECRET || '';
  http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // webhook Telegram (solo se MODE=webhook)
    if (MODE === 'webhook' && secretPath && req.method === 'POST' && url === `/tg/${secretPath}`) {
      readBody(req, 5 * 1024 * 1024).then((raw) => {
        res.writeHead(200).end();
        relayUpdate(raw);
        handleUpdate(JSON.parse(raw.toString('utf8'))).catch((e) => console.error('update error:', e));
      }).catch(() => res.writeHead(413).end());
      return;
    }

    // API mini app
    if (req.method === 'POST' && url.startsWith('/api/')) {
      readBody(req, 2 * MAX_IMPORT_BYTES)
        .then((raw) => handleApi(req, res, raw))
        .catch(() => { if (!res.headersSent) json(res, 413, { error: 'Richiesta troppo grande' }); });
      return;
    }

    // login da browser
    if (req.method === 'POST' && url.startsWith('/auth/')) {
      readBody(req, 64 * 1024)
        .then((raw) => handleAuth(req, res, raw))
        .catch(() => { if (!res.headersSent) json(res, 413, { error: 'Richiesta troppo grande' }); });
      return;
    }

    if (req.method === 'GET' && (url === '/favicon.svg' || url === '/favicon.ico')) {
      fs.readFile(path.join(WEBAPP_DIR, 'favicon.svg'), (e, data) => {
        if (e) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800' });
        res.end(data);
      });
      return;
    }

    // libreria WebAuthn lato browser (servita in locale)
    if (req.method === 'GET' && url === '/webauthn.js') {
      fs.readFile(path.join(__dirname, 'node_modules', '@simplewebauthn', 'browser', 'dist', 'bundle', 'index.umd.min.js'), (e, data) => {
        if (e) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
      return;
    }

    // libreria QR per lo scanner live (fallback della mini app)
    if (req.method === 'GET' && url === '/jsQR.js') {
      fs.readFile(path.join(__dirname, 'node_modules', 'jsqr', 'dist', 'jsQR.js'), (e, data) => {
        if (e) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
      return;
    }

    // logo brand (SVG simple-icons, fill bianco per il tile colorato)
    if (req.method === 'GET' && /^\/icon\/[a-z0-9]+\.svg$/.test(url)) {
      fs.readFile(path.join(ICONS_DIR, `${url.slice(6, -4)}.svg`), (e, data) => {
        if (e) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        res.end(data.toString('utf8').replace('<svg ', '<svg fill="#ffffff" '));
      });
      return;
    }

    // pagina pubblica = solo il gate di accesso: il markup vero esce da /api/app
    if (req.method === 'GET' && (url === '/' || url === '/app' || url === '/index.html')) {
      fs.readFile(path.join(WEBAPP_DIR, 'gate.html'), (e, data) => {
        if (e) { res.writeHead(500).end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }

    res.writeHead(404).end();
  }).listen(HTTP_PORT, env.HTTP_HOST || '0.0.0.0', () => {
    console.log(`HTTP server su ${env.HTTP_HOST || '0.0.0.0'}:${HTTP_PORT} — Mini App ${MINIAPP_URL || '(MINIAPP_URL non configurata)'}`);
    if (MODE === 'webhook' && secretPath) console.log('Webhook su /tg/<secret>');
    if (RELAY_URL) console.log(`Relay update attivo verso: ${RELAY_URL}`);
  });
}

// ---------- setup comune ----------
// Retry infinito con backoff: un timeout di rete verso Telegram non deve uccidere il processo
async function setupBot() {
  for (let attempt = 1; ; attempt++) {
    try {
      const me = await tg.getMe();
      BOT_USERNAME = me.username;
      const nVaults = fs.readdirSync(VAULTS_DIR).filter((f) => f.endsWith('.json')).length;
      console.log(`Bot @${me.username} avviato (mode=${MODE}, accesso=${OPEN_ACCESS ? 'aperto' : 'whitelist'}). Vault utenti: ${nVaults}`);
      tg.setMyCommands(BOT_COMMANDS).catch((e) => console.error('setMyCommands:', e.message));
      if (MINIAPP_URL) {
        tg.call('setChatMenuButton', {
          menu_button: { type: 'web_app', text: '🔐 Codici 2FA', web_app: { url: MINIAPP_URL } },
        }).catch((e) => console.error('setChatMenuButton:', e.message));
      }
      return me;
    } catch (e) {
      console.error(`getMe fallito (tentativo ${attempt}): ${e.message} — riprovo tra 10s`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

// ---------- modalità polling ----------
async function pollingLoop() {
  startHttpServer(); // la Mini App resta raggiungibile anche se Telegram è down
  await setupBot();

  const wh = await tg.getWebhookInfo().catch(() => null);
  if (wh?.url) {
    console.error(`ATTENZIONE: webhook attivo (${wh.url}) — getUpdates non funzionerà. Rimuovilo o usa MODE=webhook.`);
  }

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg.getUpdates(offset, 30);
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u).catch((e) => console.error('update error:', e));
      }
    } catch (e) {
      console.error('polling error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------- modalità webhook ----------
async function webhookMode() {
  if (!env.WEBHOOK_SECRET) {
    console.error('MODE=webhook richiede WEBHOOK_SECRET (path segreta, es. stringa lunga casuale)');
    process.exit(1);
  }
  startHttpServer();
  await setupBot();
  if (env.WEBHOOK_PUBLIC_URL) {
    tg.setWebhook(`${env.WEBHOOK_PUBLIC_URL.replace(/\/$/, '')}/tg/${env.WEBHOOK_SECRET}`)
      .then(() => console.log(`Webhook impostato su ${env.WEBHOOK_PUBLIC_URL}/tg/<secret>`))
      .catch((e) => console.error('setWebhook:', e.message));
  }
}

(MODE === 'webhook' ? webhookMode() : pollingLoop()).catch((e) => {
  console.error('Errore fatale:', e);
  process.exit(1);
});
