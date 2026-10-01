'use strict';

// Smoke test end-to-end del bot: simula l'API Telegram e verifica i flussi principali,
// incluso l'isolamento tra utenti, categorie e import/export Ente Auth.
// Uso: node smoke.js  (non tocca Telegram reale)
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const assert = require('assert');

const TOKEN = 'test:token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'totp-smoke-'));
Object.assign(process.env, {
  BOT_TOKEN: TOKEN,
  DATA_DIR: tmp,
  ALLOWED_USERS: '*',
  OWNER_ID: '12345',
  MASTER_KEY: 'ab'.repeat(32),
  STORE_FILE: path.join(tmp, 'secrets.json'),
  VAULTS_DIR: path.join(tmp, 'users'),
  CODE_TTL_SECONDS: '5',
  HTTP_PORT: '18923',
  HTTP_HOST: '127.0.0.1',
  MINIAPP_URL: '',
  WEB_ORIGIN: 'https://auth.test',
});
const ORIGIN = 'https://auth.test';

const A = 12345; // proprietario
const B = 777;   // secondo utente
const calls = [];
const files = {}; // file_id -> contenuto
const queue = [];
let pollResolve = null;

global.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = url.split('/').pop();
  const respond = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });

  if (url.includes('/file/bot')) {
    const buf = files[url.split('/').pop()];
    return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  }
  let body = {};
  if (typeof opts.body === 'string') body = JSON.parse(opts.body);
  else if (opts.body && typeof opts.body.get === 'function') {
    body = { chat_id: opts.body.get('chat_id'), caption: opts.body.get('caption'), document: await opts.body.get('document').text(), filename: opts.body.get('document').name };
  }
  if (method === 'getFile') return respond({ file_path: body.file_id });
  if (method === 'getMe') return respond({ username: 'smokebot' });
  if (method === 'getWebhookInfo' || method === 'setMyCommands') return respond({});
  if (method === 'getUpdates') {
    if (queue.length) return respond(queue.splice(0, queue.length));
    return new Promise((r) => { pollResolve = () => r(respond(queue.splice(0, queue.length))); });
  }
  calls.push({ method, body });
  return respond({ message_id: 1000 + calls.length });
};

let uid = 1;
function send(update) {
  update.update_id = uid++;
  queue.push(update);
  if (pollResolve) { const r = pollResolve; pollResolve = null; r(); }
}
const msg = (from, extra, chatType = 'private') => send({ message: { message_id: uid + 100, chat: { id: chatType === 'private' ? from : -100, type: chatType }, from: { id: from }, ...extra } });
const text = (from, t, chatType) => msg(from, { text: t }, chatType);
const cbq = (from, data) => send({ callback_query: { id: `cb${uid}`, from: { id: from }, data, message: { chat: { id: from, type: 'private' }, message_id: 5000 + uid } } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(30); }
  return false;
}
const sent = (filter) => calls.filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && (!filter || filter(c)));
const lastText = (to) => { const s = sent((c) => String(c.body.chat_id) === String(to)); return s.length ? s[s.length - 1].body.text : ''; };
const findButton = (to, pred) => {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (String(calls[i].body.chat_id) !== String(to)) continue;
    const kb = calls[i].body.reply_markup?.inline_keyboard;
    if (!kb) continue;
    const b = kb.flat().find(pred);
    if (b) return b;
  }
  return null;
};

function makeInitData(userId) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAt', user: JSON.stringify({ id: userId, first_name: 'T' }) };
  const dc = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dc).digest('hex');
  return Object.entries(fields).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') + `&hash=${hash}`;
}
function apiPost(pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: process.env.HTTP_PORT, path: pathName, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

async function main() {
  // store legacy v1 del proprietario → deve essere migrato all'avvio
  const master = Buffer.from(process.env.MASTER_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', master, iv);
  const ct = Buffer.concat([c.update(Buffer.from('legacy-secret-1234').toString('base64'), 'utf8'), c.final()]);
  fs.writeFileSync(process.env.STORE_FILE, JSON.stringify({ accounts: { 'Proxmox:admin': { enc: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'), digits: 6, period: 30, algorithm: 'SHA1', issuer: 'Proxmox' } } }));

  require('./index.js');
  await wait(300);
  const step = (name) => console.log(`  ✓ ${name}`);

  // ---- menu e migrazione ----
  text(A, '/start');
  assert.ok(await until(() => lastText(A).includes('1 account')), 'migrazione legacy nel vault del proprietario');
  step('migrazione store legacy → vault del proprietario');

  // ---- gruppi ignorati ----
  text(A, '/list', 'group');
  assert.ok(await until(() => sent((c) => c.body.chat_id === -100 && c.body.text.includes('chat privata')).length === 1));
  step('in un gruppo il bot non mostra nulla e rimanda alla chat privata');

  // ---- aggiunta + codice ----
  text(A, `/add github ${SECRET}`);
  assert.ok(await until(() => lastText(A).includes('github') && lastText(A).includes('salvato')));
  text(A, '/code github');
  assert.ok(await until(() => /\d{3} \d{3}/.test(lastText(A))));
  step('aggiunta account e generazione codice');

  // ---- secondo utente: vault separato ----
  text(B, '/start');
  assert.ok(await until(() => lastText(B).includes('0 account')), 'B parte da vault vuoto');
  text(B, '/code github');
  assert.ok(await until(() => lastText(B).includes('non trovato')), 'B non vede gli account di A');
  text(B, `/add github ${SECRET}`);
  assert.ok(await until(() => lastText(B).includes('salvato')), 'B può avere lo stesso secret nel suo vault');
  step('isolamento: il secondo utente ha un vault proprio e non vede quelli altrui');

  // ---- categorie ----
  text(A, '/cat');
  assert.ok(await until(() => lastText(A).includes('Categorie')));
  cbq(A, 'cn');
  await until(() => lastText(A).includes('Nome della nuova categoria'));
  text(A, 'Lavoro');
  assert.ok(await until(() => lastText(A).includes('Lavoro') && lastText(A).includes('creata')));
  text(A, '/code');
  assert.ok(await until(() => findButton(A, (b) => b.text === 'github' && b.callback_data?.startsWith('c:'))));
  const id = findButton(A, (b) => b.text === 'github').callback_data.slice(2);
  cbq(A, `t:${id}`);
  await until(() => lastText(A).includes('Categorie di'));
  cbq(A, `tt:${id}:0`);
  assert.ok(await until(() => calls.some((x) => x.method === 'editMessageReplyMarkup' && JSON.stringify(x.body).includes('✅ Lavoro'))));
  text(A, '/list');
  assert.ok(await until(() => lastText(A).includes('📁 <b>Lavoro</b>')), 'lista raggruppata per categoria');
  const listMsg = sent((x) => String(x.body.chat_id) === String(A)).pop();
  assert.ok(listMsg.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'menu:main'), 'la lista ha il tasto per tornare al menu');
  cbq(A, 'menu:main');
  assert.ok(await until(() => lastText(A).includes('Cosa vuoi fare?')), 'torna al menu');
  step('categorie: creazione, assegnazione, lista raggruppata');

  // ---- export cifrato via bot ----
  cbq(A, 'ex:enc');
  await until(() => lastText(A).includes('password'));
  text(A, 'corta');
  assert.ok(await until(() => lastText(A).includes('almeno 8')));
  text(A, 'password-export-1');
  assert.ok(await until(() => calls.some((x) => x.method === 'sendDocument' && x.body.filename.endsWith('.json')), 20000));
  const encDoc = calls.find((x) => x.method === 'sendDocument' && x.body.filename.endsWith('.json'));
  assert.strictEqual(String(encDoc.body.chat_id), String(A));
  assert.ok(!encDoc.body.document.includes('GEZD'), 'export cifrato non contiene secret in chiaro');
  step('export cifrato Ente inviato come documento');

  // ---- export in chiaro ----
  cbq(A, 'exp');
  assert.ok(await until(() => calls.some((x) => x.method === 'sendDocument' && x.body.filename.endsWith('.txt'))));
  const txtDoc = calls.find((x) => x.method === 'sendDocument' && x.body.filename.endsWith('.txt'));
  assert.ok(txtDoc.body.document.includes('otpauth://totp/') && txtDoc.body.document.includes('Lavoro'), 'export in chiaro con tag');
  step('export in chiaro Ente con categorie come tag');

  // ---- import cifrato in un nuovo utente (C) ----
  const C = 999;
  files.encfile = Buffer.from(encDoc.body.document);
  msg(C, { document: { file_id: 'encfile', file_name: 'ente-auth-codes-encrypted.json', mime_type: 'application/json', file_size: files.encfile.length } });
  assert.ok(await until(() => lastText(C).includes('password')));
  text(C, 'sbagliata!!');
  assert.ok(await until(() => lastText(C).includes('Password errata'), 20000));
  text(C, 'password-export-1');
  assert.ok(await until(() => lastText(C).includes('Importazione completata'), 20000));
  assert.ok(lastText(C).includes('2 account importati'), lastText(C));
  assert.ok(calls.some((x) => x.method === 'deleteMessage' && String(x.body.chat_id) === String(C)), 'file e password eliminati dalla chat');
  step('import file cifrato Ente (password errata rifiutata, poi ok)');

  // ---- import in chiaro: duplicati saltati ----
  files.txtfile = Buffer.from(txtDoc.body.document);
  msg(C, { document: { file_id: 'txtfile', file_name: 'ente.txt', mime_type: 'text/plain', file_size: files.txtfile.length } });
  assert.ok(await until(() => lastText(C).includes('0 account importati') && lastText(C).includes('2 già presenti')));
  step('import in chiaro: duplicati riconosciuti e saltati');

  // ---- Mini App API ----
  const r1 = await apiPost('/api/list', { initData: makeInitData(C) });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.body.accounts.length, 2);
  assert.deepStrictEqual(r1.body.categories, ['Lavoro'], 'categorie importate dai tag');
  assert.ok(!JSON.stringify(r1.body).includes('GEZD'), 'list non espone secret');
  const rB = await apiPost('/api/list', { initData: makeInitData(B) });
  assert.strictEqual(rB.body.accounts.length, 1, 'API isolata per utente');

  const tampered = makeInitData(C).replace(/hash=../, 'hash=00');
  assert.strictEqual((await apiPost('/api/list', { initData: tampered })).status, 403, 'firma corrotta');

  const add = await apiPost('/api/add', { initData: makeInitData(C), name: 'Netflix', secret: 'JBSWY3DPEHPK3PXP', tags: ['Svago'] });
  assert.strictEqual(add.status, 200);
  const dup = await apiPost('/api/add', { initData: makeInitData(C), name: 'X', secret: 'JBSWY3DPEHPK3PXP' });
  assert.strictEqual(dup.status, 409, 'duplicato rifiutato');
  const up = await apiPost('/api/update', { initData: makeInitData(C), id: add.body.id, name: 'Netflix:casa', tags: ['Svago', 'Famiglia'] });
  assert.strictEqual(up.status, 200);
  // un utente non può modificare/cancellare account altrui conoscendo l'id
  assert.strictEqual((await apiPost('/api/del', { initData: makeInitData(B), id: add.body.id })).status, 404, 'id di un altro utente non accessibile');
  const cat = await apiPost('/api/category', { initData: makeInitData(C), action: 'rename', name: 'Famiglia', newName: 'Casa' });
  assert.strictEqual(cat.status, 200);
  const r2 = await apiPost('/api/list', { initData: makeInitData(C) });
  const nf = r2.body.accounts.find((a) => a.id === add.body.id);
  assert.deepStrictEqual(nf.tags, ['Svago', 'Casa']);
  assert.strictEqual(nf.icon, 'netflix');

  const needPw = await apiPost('/api/import', { initData: makeInitData(B), content: encDoc.body.document });
  assert.strictEqual(needPw.status, 400);
  assert.ok(needPw.body.needPassword);
  const imp = await apiPost('/api/import', { initData: makeInitData(B), content: encDoc.body.document, password: 'password-export-1' });
  assert.strictEqual(imp.status, 200);
  assert.strictEqual(imp.body.imported, 1);
  assert.strictEqual(imp.body.duplicates, 1);

  const ex = await apiPost('/api/export', { initData: makeInitData(C), format: 'encrypted', password: 'abc' });
  assert.strictEqual(ex.status, 400, 'password export troppo corta');
  const ex2 = await apiPost('/api/export', { initData: makeInitData(C), format: 'encrypted', password: 'abcdefgh' });
  assert.strictEqual(ex2.status, 200);
  assert.ok(calls.some((x) => x.method === 'sendDocument' && String(x.body.chat_id) === String(C)), 'export dalla mini app inviato nella chat dell\'utente');

  const app = await apiPost('/api/app', { initData: makeInitData(C) });
  assert.ok(app.status === 200 && app.body.html.includes('Codici 2FA'));
  assert.strictEqual((await apiPost('/api/app', { initData: '' })).status, 403);
  step('Mini App API: isolamento, categorie, duplicati, import/export, gate');

  // ================= ACCESSO DA BROWSER =================
  const web = (p, body, cookie, origin = ORIGIN) => apiPost(p, body, { ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', 'X-Real-IP': '203.0.113.7' });
  const cookieOf = (r) => (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('__Host-totp_sid='));

  assert.strictEqual((await web('/api/list', {})).status, 403, 'senza sessione: negato');
  assert.strictEqual((await web('/auth/telegram/start', {}, null, 'https://evil.test')).status, 403, 'origin estraneo rifiutato');

  // login Telegram: deep link → conferma nel bot → poll
  const st = await web('/auth/telegram/start', {});
  assert.strictEqual(st.status, 200);
  assert.ok(st.body.link.startsWith('https://t.me/smokebot?start=login_') && st.body.qr.startsWith('<svg'));
  assert.strictEqual((await web('/auth/telegram/poll', { loginId: st.body.loginId, pollToken: st.body.pollToken })).body.status, 'pending');
  text(A, `/start login_${st.body.loginId}`);
  assert.ok(await until(() => lastText(A).includes('Richiesta di accesso web') && lastText(A).includes(st.body.code)), 'il bot mostra la richiesta con il codice');
  cbq(A, `wl:${st.body.loginId}`);
  assert.ok(await until(() => lastText(A).includes('Accesso web consentito')));
  assert.strictEqual((await web('/auth/telegram/poll', { loginId: st.body.loginId, pollToken: 'sbagliato' })).body.status, 'invalid', 'pollToken errato');
  const ok1 = await web('/auth/telegram/poll', { loginId: st.body.loginId, pollToken: st.body.pollToken });
  assert.strictEqual(ok1.body.status, 'approved');
  const sidA = cookieOf(ok1);
  assert.ok(sidA, 'cookie di sessione');
  assert.ok(/HttpOnly/.test(ok1.headers['set-cookie'][0]) && /Secure/.test(ok1.headers['set-cookie'][0]) && /SameSite=Strict/.test(ok1.headers['set-cookie'][0]));
  assert.strictEqual((await web('/auth/telegram/poll', { loginId: st.body.loginId, pollToken: st.body.pollToken })).body.status, 'expired', 'login monouso');
  assert.ok(await until(() => lastText(A).includes('Nuovo accesso web')), 'notifica di accesso nel bot');

  const wl = await web('/api/list', {}, sidA);
  assert.strictEqual(wl.status, 200);
  assert.ok(wl.body.accounts.some((a) => a.name === 'github'), 'il browser vede il vault di A');
  assert.strictEqual((await web('/api/list', {}, sidA, null)).status, 403, 'cookie senza Origin rifiutato (CSRF)');
  assert.strictEqual((await web('/api/session', {}, sidA)).body.via, 'web');
  step('login web via Telegram: conferma nel bot, codice, sessione HttpOnly, monouso, anti-CSRF');

  // login rifiutato
  const st2 = await web('/auth/telegram/start', {});
  text(A, `/start login_${st2.body.loginId}`);
  await until(() => lastText(A).includes(st2.body.code));
  cbq(A, `wn:${st2.body.loginId}`);
  assert.ok(await until(() => lastText(A).includes('rifiutato')));
  assert.strictEqual((await web('/auth/telegram/poll', { loginId: st2.body.loginId, pollToken: st2.body.pollToken })).body.status, 'denied');
  step('login web rifiutato dal bot');

  // ---- passkey: autenticatore software P-256 ----
  const { encodeCBOR } = require('@levischuck/tiny-cbor');
  const h = (b) => crypto.createHash('sha256').update(b).digest();
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  const rpHash = h('auth.test');

  const regOpts = await web('/api/passkey/options', {}, sidA);
  assert.strictEqual(regOpts.status, 200);
  assert.strictEqual(regOpts.body.rp.id, 'auth.test');
  const cose = encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
  const regAuthData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, Buffer.from(cose)]);
  const regClient = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: regOpts.body.challenge, origin: ORIGIN, crossOrigin: false }));
  const attObj = encodeCBOR(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', regAuthData]]));
  const regResp = { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform', response: { clientDataJSON: b64u(regClient), attestationObject: b64u(attObj), transports: ['internal'] } };
  const reg = await web('/api/passkey/register', { response: regResp, name: 'Portatile' }, sidA);
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
  assert.strictEqual((await web('/api/passkey/register', { response: regResp, name: 'replay' }, sidA)).status, 400, 'challenge di registrazione monouso');
  step('registrazione passkey (WebAuthn verificato con autenticatore software)');

  const passkeyLogin = async (counter, tamper) => {
    const o = await web('/auth/passkey/options', {});
    const ad = Buffer.concat([rpHash, Buffer.from([0x05]), Buffer.from([0, 0, 0, counter])]);
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: o.body.challenge, origin: tamper === 'origin' ? 'https://evil.test' : ORIGIN, crossOrigin: false }));
    let sig = crypto.sign('sha256', Buffer.concat([ad, h(cd)]), privateKey);
    if (tamper === 'sig') sig = crypto.sign('sha256', Buffer.from('altro'), privateKey);
    return web('/auth/passkey/verify', { response: { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig) } } });
  };
  const pl = await passkeyLogin(1);
  assert.strictEqual(pl.status, 200, JSON.stringify(pl.body));
  const sidPk = cookieOf(pl);
  assert.ok(sidPk && sidPk !== sidA);
  assert.ok((await web('/api/list', {}, sidPk)).body.accounts.some((a) => a.name === 'github'), 'login passkey → vault di A');
  assert.strictEqual((await passkeyLogin(2, 'sig')).status, 400, 'firma non valida rifiutata');
  assert.strictEqual((await passkeyLogin(3, 'origin')).status, 400, 'origin errato rifiutato');
  step('login con passkey (firma e origin verificati)');

  // sicurezza: elenco, revoca sessioni, logout, isolamento passkey
  const sec = await web('/api/security', {}, sidPk);
  assert.strictEqual(sec.body.passkeys.length, 1);
  assert.ok(sec.body.sessions.length >= 2 && sec.body.sessions.some((x) => x.current));
  assert.strictEqual((await apiPost('/api/security', { initData: makeInitData(B) })).body.passkeys.length, 0, 'B non vede le passkey di A');
  assert.strictEqual((await apiPost('/api/passkey/delete', { initData: makeInitData(B), id: b64u(credId) })).status, 404, 'B non può eliminare passkey di A');
  const rv = await web('/api/sessions/revoke', {}, sidPk);
  assert.strictEqual(rv.body.revoked, 1, 'revocate le altre sessioni');
  assert.strictEqual((await web('/api/list', {}, sidA)).status, 403, 'sessione revocata non più valida');
  assert.strictEqual((await web('/api/list', {}, sidPk)).status, 200, 'sessione corrente intatta');
  const lo = await web('/auth/logout', {}, sidPk);
  assert.ok(/Max-Age=0/.test(lo.headers['set-cookie'][0]));
  assert.strictEqual((await web('/api/list', {}, sidPk)).status, 403, 'logout');
  const webFile = fs.readFileSync(path.join(tmp, 'web.json'), 'utf8');
  assert.ok(!webFile.includes(sidPk.split('=')[1]) && !webFile.includes(sidA.split('=')[1]), 'i token di sessione non sono salvati in chiaro');
  step('gestione sicurezza: passkey isolate, revoca sessioni, logout, token salvati come hash');

  console.log(`\nOK — ${calls.length} chiamate API simulate, tutti i flussi verificati.`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
