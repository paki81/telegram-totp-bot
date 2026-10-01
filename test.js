'use strict';

// Test con i vettori ufficiali RFC 6238 (Appendix B)
const assert = require('assert');
const { base32Decode, base32Encode, buildOtpauthUri, totp, parseAccountInput, validateAccount } = require('./totp');
const { Vaults, migrateLegacy } = require('./store');
const ente = require('./ente');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('TOTP / base32 / store — test\n');

check('base32 decode del vettore RFC', () => {
  const key = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.strictEqual(key.toString('ascii'), '12345678901234567890');
});

check('base32 decode tollera spazi/minuscole', () => {
  const key = base32Decode('gezd gnbv gy3t qojq');
  assert.ok(key.length > 0);
});

// RFC 6238 Appendix B — SHA1, key ASCII "12345678901234567890"
const k1 = Buffer.from('12345678901234567890', 'ascii');
const vectorsSha1 = [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
];
for (const [t, expected] of vectorsSha1) {
  check(`TOTP SHA1 T=${t} -> ${expected}`, () => {
    assert.strictEqual(totp(k1, { digits: 8, t: t * 1000 }), expected);
  });
}

// SHA256, key ASCII "12345678901234567890123456789012" (32 byte)
const k256 = Buffer.from('12345678901234567890123456789012', 'ascii');
const vectorsSha256 = [
  [59, '46119246'], [1111111109, '68084774'], [1111111111, '67062674'], [1234567890, '91819424'],
];
for (const [t, expected] of vectorsSha256) {
  check(`TOTP SHA256 T=${t} -> ${expected}`, () => {
    assert.strictEqual(totp(k256, { digits: 8, t: t * 1000, algorithm: 'SHA256' }), expected);
  });
}

// SHA512, key ASCII di 64 byte
const k512 = Buffer.from(
  '1234567890123456789012345678901234567890123456789012345678901234', 'ascii'
);
check('TOTP SHA512 T=59 -> 90693936', () => {
  assert.strictEqual(totp(k512, { digits: 8, t: 59000, algorithm: 'SHA512' }), '90693936');
});

check('6 cifre di default', () => {
  const code = totp(k1);
  assert.match(code, /^\d{6}$/);
});

check('parseAccountInput: otpauth URI', () => {
  const acc = parseAccountInput(
    'otpauth://totp/GitHub:mario?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub&digits=8&period=45&algorithm=SHA256'
  );
  assert.strictEqual(acc.name, 'GitHub:mario');
  assert.strictEqual(acc.issuer, 'GitHub');
  assert.strictEqual(acc.digits, 8);
  assert.strictEqual(acc.period, 45);
  assert.strictEqual(acc.algorithm, 'SHA256');
});

check('parseAccountInput: secret nudo', () => {
  const acc = parseAccountInput('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'test');
  assert.strictEqual(acc.name, 'test');
  assert.strictEqual(acc.digits, 6);
});

check('validateAccount rifiuta secret invalido', () => {
  assert.throws(() => validateAccount(parseAccountInput('!!!invalid!!!', 'x')));
});

check('validateAccount rifiuta secret troppo corto', () => {
  assert.throws(() => validateAccount(parseAccountInput('GEZDGN', 'x')));
});

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'totp-test-'));

check('base32 encode/decode roundtrip', () => {
  for (let n = 1; n < 40; n++) {
    const b = crypto.randomBytes(n);
    assert.ok(base32Decode(base32Encode(b)).equals(b));
  }
  assert.strictEqual(base32Encode(k1), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

check('URI Ente: codeDisplay (tag, note, cestino) e secret con "+"', () => {
  const p = parseAccountInput('otpauth://totp/facebook.com:me@x.it?algorithm=SHA1&digits=6&issuer=facebook.com&period=30&secret=GEZD+GNBV+GY3T+QOJQ&codeDisplay=%7B%22pinned%22%3Afalse%2C%22trashed%22%3Atrue%2C%22tags%22%3A%5B%22Social%22%5D%2C%22note%22%3A%22n%22%7D');
  assert.deepStrictEqual(p.tags, ['Social']);
  assert.strictEqual(p.trashed, true);
  assert.strictEqual(p.note, 'n');
  assert.strictEqual(validateAccount(p).key.length, 10);
});

check('buildOtpauthUri → parse roundtrip con tag', () => {
  const uri = buildOtpauthUri({ name: 'GitHub:mario rossi', issuer: 'GitHub', keyBuf: k1, digits: 6, period: 30, algorithm: 'SHA1', tags: ['Lavoro', 'Dev'] });
  const p = parseAccountInput(uri);
  assert.strictEqual(p.name, 'GitHub:mario rossi');
  assert.strictEqual(p.issuer, 'GitHub');
  assert.deepStrictEqual(p.tags, ['Lavoro', 'Dev']);
  assert.ok(validateAccount(p).key.equals(k1));
});

check('Vault: isolamento tra utenti, cifratura, permessi 600', () => {
  const dir = tmpDir();
  const vs = new Vaults(dir, crypto.randomBytes(32));
  const a = vs.for('111');
  const b = vs.for('222');
  const id = a.add({ name: 'github', issuer: 'GitHub', secretBuf: k1, digits: 6, period: 30, algorithm: 'SHA1', tags: ['Lavoro'] });
  assert.strictEqual(a.size, 1);
  assert.strictEqual(b.size, 0, 'utente B non vede gli account di A');
  assert.ok(!b.has(id));
  const fileA = vs.fileFor('111');
  assert.ok(!path.basename(fileA).includes('111'), 'il nome file non rivela lo user id');
  const raw = fs.readFileSync(fileA, 'utf8');
  assert.ok(!raw.includes('12345678901234567890') && !raw.includes('GEZD'), 'nessun secret in chiaro');
  assert.strictEqual(fs.statSync(fileA).mode & 0o777, 0o600);
  // un blob copiato nel vault di B non si decifra (chiave e AAD diverse)
  b.data.accounts[id] = JSON.parse(raw).accounts[id];
  assert.throws(() => b.get(id), 'blob di A illeggibile per B');
  fs.rmSync(dir, { recursive: true });
});

check('Vault: categorie (crea, assegna, rinomina, elimina) e duplicati', () => {
  const dir = tmpDir();
  const v = new Vaults(dir, crypto.randomBytes(32)).for('5');
  const id = v.add({ name: 'x', secretBuf: k1, digits: 6, period: 30, algorithm: 'SHA1' });
  assert.ok(v.isDuplicate(k1));
  v.addCategory('Lavoro');
  assert.throws(() => v.addCategory('lavoro'), 'duplicato case-insensitive');
  v.update(id, { tags: ['Lavoro', 'Server'] });
  assert.deepStrictEqual(v.categories(), ['Lavoro', 'Server']);
  v.renameCategory('Lavoro', 'Ufficio');
  assert.deepStrictEqual(v.get(id).tags, ['Ufficio', 'Server']);
  v.removeCategory('Server');
  assert.deepStrictEqual(v.get(id).tags, ['Ufficio']);
  assert.deepStrictEqual(v.categories(), ['Ufficio']);
  assert.strictEqual(v.uniqueName('x'), 'x (2)');
  fs.rmSync(dir, { recursive: true });
});

check('Migrazione store v1 → vault del proprietario', () => {
  const dir = tmpDir();
  const master = crypto.randomBytes(32);
  const legacy = path.join(dir, 'secrets.json');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', master, iv);
  const ct = Buffer.concat([c.update(k1.toString('base64'), 'utf8'), c.final()]);
  fs.writeFileSync(legacy, JSON.stringify({ accounts: { 'Proxmox:admin': { enc: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'), digits: 6, period: 30, algorithm: 'SHA1', issuer: 'Proxmox' } } }));
  const v = new Vaults(path.join(dir, 'users'), master).for('42');
  assert.strictEqual(migrateLegacy(legacy, master, v), 1);
  assert.ok(fs.existsSync(`${legacy}.migrated`) && !fs.existsSync(legacy));
  const acc = v.get(v.findByName('Proxmox:admin'));
  assert.ok(acc.keyBuf.equals(k1));
  fs.rmSync(dir, { recursive: true });
});

(async () => {
  const accs = [
    { name: 'GitHub:mario', issuer: 'GitHub', keyBuf: k1, digits: 6, period: 30, algorithm: 'SHA1', tags: ['Lavoro'] },
    { name: 'Netflix', issuer: '', keyBuf: k256, digits: 8, period: 60, algorithm: 'SHA256', tags: [] },
  ];

  const plain = ente.buildPlainExport(accs);
  const uris = await ente.readExport(plain);
  assert.strictEqual(uris.length, 2);
  assert.deepStrictEqual(parseAccountInput(uris[0]).tags, ['Lavoro']);
  assert.strictEqual(parseAccountInput(uris[1]).digits, 8);
  passed++; console.log('  ✓ Ente plain: export → import roundtrip');

  const encJson = await ente.buildEncryptedExport(accs, 'password-sicura');
  const j = JSON.parse(encJson);
  assert.strictEqual(j.version, 1);
  assert.ok(j.kdfParams.memLimit && j.kdfParams.opsLimit && j.kdfParams.salt && j.encryptedData && j.encryptionNonce);
  assert.ok(!encJson.includes('GEZD'));
  assert.ok(ente.isEncryptedExport(encJson));
  const dec = await ente.readExport(encJson, 'password-sicura');
  assert.strictEqual(dec.length, 2);
  assert.ok(validateAccount(parseAccountInput(dec[0])).key.equals(k1));
  passed++; console.log('  ✓ Ente cifrato: export → import roundtrip (Argon2id + XChaCha20-Poly1305)');

  await assert.rejects(() => ente.readExport(encJson, 'sbagliata'), /Password errata/);
  passed++; console.log('  ✓ Ente cifrato: password errata rifiutata');

  const evil = JSON.stringify({ ...j, kdfParams: { ...j.kdfParams, memLimit: 8 * 1073741824 } });
  await assert.rejects(() => ente.readExport(evil, 'x'), /fuori dai limiti/);
  passed++; console.log('  ✓ Ente cifrato: parametri KDF abnormi rifiutati (anti-DoS)');

  // vettore generato con libsodium nel formato dell'app Ente (memLimit 64 MiB, opsLimit 2)
  const sodium = require('libsodium-wrappers-sumo');
  await sodium.ready;
  const B64 = sodium.base64_variants.ORIGINAL;
  const salt = sodium.randombytes_buf(16);
  const key = sodium.crypto_pwhash(32, 'pw1234', salt, 2, 67108864, sodium.crypto_pwhash_ALG_ARGON2ID13);
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  // Ente può chiudere lo stream con TAG_MESSAGE invece di TAG_FINAL
  const c = sodium.crypto_secretstream_xchacha20poly1305_push(state, sodium.from_string('otpauth://totp/A:b?secret=GEZDGNBVGY3TQOJQ&issuer=A\n'), null, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
  const enteFile = JSON.stringify({ version: 1, kdfParams: { memLimit: 67108864, opsLimit: 2, salt: sodium.to_base64(salt, B64) }, encryptedData: sodium.to_base64(c, B64), encryptionNonce: sodium.to_base64(header, B64) });
  const got = await ente.readExport(enteFile, 'pw1234');
  assert.strictEqual(got.length, 1);
  passed++; console.log('  ✓ Ente cifrato: file con TAG_MESSAGE (variante app Ente) importato');

  console.log(`\n${passed} test passati.`);
})().catch((e) => { console.error(e); process.exit(1); });
