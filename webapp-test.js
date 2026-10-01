'use strict';

// Test end-to-end della Mini App in un DOM reale (jsdom):
// gate -> /api/app -> iniezione css/html/js -> /api/list -> render card.
// Uso: node webapp-test.js  (avvia un'istanza isolata del server su porta di test)
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const PORT = 18931;
const TOKEN = 'test:token';
process.env.BOT_TOKEN = TOKEN;
process.env.ALLOWED_USERS = '12345';
process.env.MASTER_KEY = 'cd'.repeat(32);
process.env.HTTP_PORT = String(PORT);
process.env.HTTP_HOST = '127.0.0.1';
process.env.MINIAPP_URL = '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'totp-web-'));
process.env.STORE_FILE = path.join(tmp, 'secrets.json');
process.env.VAULTS_DIR = path.join(tmp, 'users');
process.env.DATA_DIR = tmp;

// stub di Telegram: getUpdates resta appeso, il resto risponde ok
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.telegram.org')) {
    if (String(url).endsWith('/getUpdates')) return new Promise(() => {});
    return { json: async () => ({ ok: true, result: { username: 'testbot' } }) };
  }
  return realFetch(url, opts);
};

// pre-popola il vault dell'utente con due account
const { Vaults } = require('./store');
const vault = new Vaults(process.env.VAULTS_DIR, Buffer.from(process.env.MASTER_KEY, 'hex')).for('12345');
vault.add({ name: 'GitHub:mario', issuer: 'GitHub', secretBuf: Buffer.from('12345678901234567890'), digits: 6, period: 30, algorithm: 'SHA1', tags: ['Lavoro'] });
vault.add({ name: 'Proxmox:admin', issuer: 'Proxmox VE', secretBuf: Buffer.from('abcdefghij0123456789'), digits: 6, period: 30, algorithm: 'SHA1' });

// sessione web pre-esistente per l'utente (salvata come hash, come fa il server)
process.env.WEB_ORIGIN = 'https://auth.test';
const WEB_TOKEN = crypto.randomBytes(32).toString('base64url');
fs.writeFileSync(path.join(tmp, 'web.json'), JSON.stringify({
  sessions: { [crypto.createHash('sha256').update(WEB_TOKEN).digest('hex')]: { uid: '12345', created: Date.now(), lastSeen: Date.now(), ua: 'Chrome su Linux', ip: '127.0.0.1', method: 'Telegram' } },
  passkeys: {},
}));

function makeInitData(userId) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAt', user: JSON.stringify({ id: userId, first_name: 'T' }) };
  const dc = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dc).digest('hex');
  return Object.entries(fields).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') + `&hash=${hash}`;
}

async function openGate(initData, cookie) {
  const base = `http://127.0.0.1:${PORT}`;
  const html = await (await realFetch(`${base}/`)).text();
  const errors = [];
  const dom = new JSDOM(html.replace(/<script src="https:\/\/telegram\.org[^>]*><\/script>/, ''), {
    url: `${base}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.addEventListener('error', (e) => errors.push(e.message));
  // il browser invia Origin e cookie di sessione: li simuliamo
  w.fetch = (u, o = {}) => realFetch(new URL(u, base).href, { ...o, headers: { ...(o.headers || {}), Origin: 'https://auth.test', ...(cookie ? { Cookie: cookie } : {}) } });
  w.PublicKeyCredential = function () {};
  Object.defineProperty(w.navigator, 'credentials', { value: {}, configurable: true });
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.scrollTo = () => {};
  w.Telegram = {
    WebApp: {
      initData, colorScheme: 'light', platform: 'android', version: '8.0',
      ready() {}, expand() {}, onEvent() {},
      isVersionAtLeast: () => true,
      setHeaderColor() {}, setBackgroundColor() {}, setBottomBarColor() {},
      HapticFeedback: { notificationOccurred() {}, impactOccurred() {} },
      showConfirm: (m, cb) => cb(true),
    },
  };
  // esegue gli script inline del gate come farebbe il browser
  for (const s of w.document.querySelectorAll('script')) {
    if (s.src) continue;
    w.eval(s.textContent);
  }
  return { w, errors };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(50); }
  return false;
}

(async () => {
  require('./index.js');
  await wait(400);

  // 1) browser senza sessione -> pagina di login, nessun markup app
  {
    const { w } = await openGate('');
    assert.ok(await until(() => w.document.getElementById('gTg')), 'mostra il login');
    assert.ok(w.document.getElementById('gPk'), 'tasto passkey');
    assert.ok(!w.document.getElementById('list'), 'nessun markup app senza auth');
    // avvio login Telegram: codice + link al bot + QR
    w.document.getElementById('gTg').click();
    assert.ok(await until(() => w.document.querySelector('.g-code')), 'schermata conferma Telegram');
    assert.ok(/^\d{2}-\d{2}$/.test(w.document.querySelector('.g-code').textContent), 'codice di verifica');
    assert.ok(w.document.getElementById('gOpen').href.startsWith('https://t.me/testbot?start=login_'), 'deep link al bot');
    assert.ok(w.document.querySelector('.g-qr svg'), 'QR per il telefono');
    w.document.getElementById('gBack').click();
    console.log('  ✓ browser senza sessione: login con Telegram (codice, link, QR) e passkey');
  }

  // 2) utente non autorizzato -> negato
  {
    const { w } = await openGate(makeInitData(999));
    await until(() => w.document.body.textContent.includes('Accesso negato'));
    assert.ok(w.document.body.textContent.includes('Accesso negato'), 'gate nega utente non whitelist');
    console.log('  ✓ utente non autorizzato: accesso negato');
  }

  // 3) utente autorizzato -> app caricata e card renderizzate
  const { w, errors } = await openGate(makeInitData(12345));
  // jsdom non esegue <script> creati con textContent in modalità outside-only: lo eseguiamo noi
  await until(() => w.document.getElementById('list'));
  const injected = [...w.document.querySelectorAll('body > script')].pop();
  w.eval(injected.textContent);
  const ok = await until(() => w.document.querySelectorAll('.card').length === 2);
  assert.ok(ok, `card renderizzate (trovate ${w.document.querySelectorAll('.card').length}, errori: ${errors.join('; ')})`);
  assert.deepStrictEqual(errors, [], 'nessun errore JS');
  console.log('  ✓ app iniettata senza errori, 2 card renderizzate');

  const cards = [...w.document.querySelectorAll('.card')];
  const gh = cards.find((c) => c.textContent.includes('GitHub'));
  assert.ok(/^\d{3} \d{3}$/.test(gh.querySelector('[data-code]').textContent), 'codice formattato');
  assert.ok(/^\d{3} \d{3}$/.test(gh.querySelector('.next b').textContent), 'codice next');
  assert.ok(gh.querySelector('.icon img').getAttribute('src') === '/icon/github.svg', 'logo github');
  const px = cards.find((c) => c.textContent.includes('Proxmox'));
  assert.ok(px.querySelector('.icon img').getAttribute('src') === '/icon/proxmox.svg', 'logo proxmox');
  assert.ok(+gh.querySelector('[data-num]').textContent > 0, 'countdown attivo');
  console.log('  ✓ codici, Next, loghi brand e countdown corretti');

  // ricerca
  const search = w.document.getElementById('search');
  search.value = 'prox';
  search.dispatchEvent(new w.Event('input'));
  assert.strictEqual(w.document.querySelectorAll('.card').length, 1, 'ricerca filtra');
  search.value = '';
  search.dispatchEvent(new w.Event('input'));
  console.log('  ✓ ricerca');

  // tema
  w.document.getElementById('themeBtn').click();
  w.document.querySelector('#themes [data-theme="peach"]').click();
  assert.strictEqual(w.document.documentElement.getAttribute('data-theme'), 'peach', 'cambio tema');
  console.log('  ✓ cambio tema');

  const $ = (s) => w.document.querySelector(s);
  const cardCount = () => w.document.querySelectorAll('.card').length;

  // filtro categorie
  const chips = [...w.document.querySelectorAll('#chips .chip')].map((c) => c.textContent);
  assert.ok(chips.some((t) => t.startsWith('Lavoro')), 'chip categoria');
  [...w.document.querySelectorAll('#chips .chip')].find((c) => c.textContent.startsWith('Lavoro')).click();
  assert.strictEqual(cardCount(), 1, 'filtro per categoria');
  [...w.document.querySelectorAll('#chips .chip')].find((c) => c.textContent.startsWith('Tutti')).click();
  assert.strictEqual(cardCount(), 2);
  console.log('  ✓ filtro per categoria');

  // aggiunta manuale con nuova categoria
  $('#addBtn').click();
  $('#fName').value = 'Netflix';
  $('#fSecret').value = 'JBSWY3DPEHPK3PXP';
  $('[data-newtag]').click();
  const tagInput = $('[data-pick] input');
  tagInput.value = 'Svago';
  tagInput.dispatchEvent(new w.Event('blur'));
  $('#addForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.ok(await until(() => cardCount() === 3), 'aggiunta manuale');
  const nfCard = () => [...w.document.querySelectorAll('.card')].find((c) => c.textContent.includes('Netflix'));
  assert.ok(nfCard().querySelector('.tag').textContent === 'Svago', 'categoria creata e assegnata');
  assert.strictEqual(nfCard().querySelector('.icon img').getAttribute('src'), '/icon/netflix.svg');
  console.log('  ✓ aggiunta manuale con nuova categoria');

  // modifica: rinomina + cambio categorie
  nfCard().querySelector('[data-edit]').click();
  $('#eName').value = 'Netflix:casa';
  [...w.document.querySelectorAll('[data-pick] .chip')].find((c) => c.textContent === 'Lavoro').click();
  $('#editForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.ok(await until(() => nfCard() && nfCard().querySelectorAll('.tag').length === 2), 'modifica categorie');
  assert.ok(nfCard().querySelector('.issuer').textContent === 'casa', 'rinomina');
  console.log('  ✓ modifica account (nome e categorie)');

  // gestione categorie: rinomina
  $('#moreBtn').click();
  $('[data-go="cats"]').click();
  const row = [...w.document.querySelectorAll('.cat-row')].find((r) => r.getAttribute('data-cat') === 'Svago');
  row.querySelector('[data-ren]').click();
  row.querySelector('input').value = 'Tempo libero';
  row.querySelector('button').click();
  assert.ok(await until(() => [...w.document.querySelectorAll('#chips .chip')].some((c) => c.textContent.startsWith('Tempo libero'))), 'rinomina categoria');
  $('[data-close]').click();
  console.log('  ✓ gestione categorie');

  // import backup in chiaro
  $('#moreBtn').click();
  $('[data-go="import"]').click();
  $('#impText').value = 'otpauth://totp/Discord:me?secret=KRSXG5CTMVRXEZLU&issuer=Discord&codeDisplay=%7B%22tags%22%3A%5B%22Social%22%5D%7D\n' +
    'otpauth://totp/Old?secret=MFRGGZDFMZTWQ2LK&codeDisplay=%7B%22trashed%22%3Atrue%7D';
  $('#impGo').click();
  assert.ok(await until(() => !$('#impResult').hidden), 'risultato import');
  assert.ok($('#impResult').textContent.includes('1 account importati') && $('#impResult').textContent.includes('1 nel cestino'));
  assert.ok(await until(() => cardCount() === 4));
  $('[data-close]').click();
  console.log('  ✓ import backup (tag → categorie, cestino saltato)');

  // nessun riferimento a prodotti terzi nella GUI
  for (const go of ['import', 'export', 'cats']) {
    $('#moreBtn').click();
    const menuText = $('#sheetBody').textContent;
    $(`[data-go="${go}"]`).click();
    assert.ok(!/\bente\b/i.test(menuText + $('#sheetBody').textContent), `nessun "Ente" nella GUI (${go})`);
    $('[data-close]').click();
  }
  console.log('  ✓ nessun riferimento a Ente Auth nella GUI');

  // eliminazione dal pannello modifica (showConfirm stub -> true)
  nfCard().querySelector('[data-edit]').click();
  $('#eDel').click();
  assert.ok(await until(() => cardCount() === 3), 'eliminazione');
  console.log('  ✓ eliminazione');

  // Sicurezza dentro Telegram: passkey, apertura web
  $('#moreBtn').click();
  $('[data-go="security"]').click();
  assert.ok(await until(() => $('#pkAdd')), 'schermata sicurezza');
  assert.ok($('#openWeb'), 'in Telegram: tasto per aprire la versione web');
  assert.ok(!$('#logoutBtn'), 'in Telegram niente logout');
  $('[data-close]').click();
  console.log('  ✓ Sicurezza (Telegram): passkey e apertura versione web');

  // 4) versione browser con sessione valida
  {
    const r = await realFetch(`http://127.0.0.1:${PORT}/api/app`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://auth.test', Cookie: `__Host-totp_sid=${WEB_TOKEN}` }, body: '{}' });
    assert.strictEqual(r.status, 200, 'sessione web valida');
    const { w: bw, errors: berr } = await openGate('', `__Host-totp_sid=${WEB_TOKEN}`);
    assert.ok(await until(() => bw.document.getElementById('list')), 'app caricata nel browser');
    bw.eval([...bw.document.querySelectorAll('body > script')].pop().textContent);
    assert.ok(await until(() => bw.document.querySelectorAll('.card').length === 3), `card nel browser (errori: ${berr.join('; ')})`);
    assert.ok(bw.document.documentElement.classList.contains('is-web'), 'modalità web');
    const b$ = (s) => bw.document.querySelector(s);
    b$('#moreBtn').click();
    assert.ok(b$('[data-go="logout"]'), 'nel browser c\'è "Esci"');
    b$('[data-go="security"]').click();
    assert.ok(await until(() => b$('#logoutBtn')), 'sicurezza nel browser');
    assert.ok(bw.document.querySelector('[data-sid] .tag').textContent === 'questo browser', 'sessione corrente evidenziata');
    assert.deepStrictEqual(berr, [], 'nessun errore JS nel browser');
    console.log('  ✓ versione browser: app con sessione, layout web, Sicurezza ed Esci');
  }

  assert.deepStrictEqual(errors, [], 'nessun errore JS a fine test');
  console.log('\nMini App OK.');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
