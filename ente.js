'use strict';

// Import/export nel formato di Ente Auth:
//  - testo in chiaro: un URI otpauth:// per riga (o separati da virgola), con codeDisplay per i tag
//  - cifrato: JSON { version, kdfParams{memLimit,opsLimit,salt}, encryptedData, encryptionNonce }
//    Argon2id + XChaCha20-Poly1305 (libsodium secretstream), come l'app Ente.
const path = require('path');
const { Worker } = require('worker_threads');
const { buildOtpauthUri } = require('./totp');

const EXPORT_MEMLIMIT = 268435456; // 256 MiB (libsodium MODERATE)
const EXPORT_OPSLIMIT = 3;
const MAX_IMPORT_MEMLIMIT = 1073741824; // 1 GiB: oltre si rifiuta (protezione DoS)
const MAX_IMPORT_OPSLIMIT = 64;

// coda: al massimo un calcolo Argon2 alla volta (ognuno può usare centinaia di MB)
let queue = Promise.resolve();
function runWorker(data) {
  const job = queue.then(() => new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'ente-worker.js'), { workerData: data });
    const timer = setTimeout(() => { w.terminate(); reject(new Error('Timeout decifratura')); }, 120000);
    w.once('message', (m) => { clearTimeout(timer); w.terminate(); m.ok ? resolve(m) : reject(new Error(m.error)); });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  }));
  queue = job.catch(() => {});
  return job;
}

/** true se il contenuto è un export cifrato Ente */
function isEncryptedExport(text) {
  try {
    const j = JSON.parse(text);
    return !!(j && j.encryptedData && j.encryptionNonce && j.kdfParams);
  } catch {
    return false;
  }
}

/** Estrae le righe otpauth:// da un export in chiaro (righe o virgole) */
function splitPlain(text) {
  return String(text)
    .split(/[\r\n,]+/)
    .map((l) => l.trim())
    .filter((l) => /^otpauth:\/\//i.test(l));
}

async function decryptExport(text, password) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('File cifrato non valido'); }
  if (j.version !== 1) throw new Error(`Versione export non supportata: ${j.version}`);
  const { memLimit, opsLimit, salt } = j.kdfParams || {};
  if (!Number.isInteger(memLimit) || !Number.isInteger(opsLimit) || !salt) throw new Error('Parametri KDF non validi');
  if (memLimit < 8192 || memLimit > MAX_IMPORT_MEMLIMIT || opsLimit < 1 || opsLimit > MAX_IMPORT_OPSLIMIT) {
    throw new Error('Parametri KDF fuori dai limiti consentiti');
  }
  try {
    const r = await runWorker({ op: 'decrypt', password: String(password), salt, memLimit, opsLimit, encryptedData: j.encryptedData, encryptionNonce: j.encryptionNonce });
    return r.text;
  } catch (e) {
    if (e.message === 'BAD_PASSWORD') throw new Error('Password errata o file danneggiato');
    throw e;
  }
}

/**
 * Converte il contenuto di un file (cifrato o in chiaro) nella lista di URI otpauth.
 * @returns {Promise<string[]>}
 */
async function readExport(text, password) {
  const plain = isEncryptedExport(text) ? await decryptExport(text, password) : text;
  return splitPlain(plain);
}

/** accounts: [{ name, issuer, keyBuf, digits, period, algorithm, tags, note }] */
function buildPlainExport(accounts) {
  return accounts.map((a) => buildOtpauthUri(a).replace(/,/g, '%2C')).join('\n') + '\n';
}

async function buildEncryptedExport(accounts, password) {
  const r = await runWorker({
    op: 'encrypt', password: String(password), plaintext: buildPlainExport(accounts),
    memLimit: EXPORT_MEMLIMIT, opsLimit: EXPORT_OPSLIMIT,
  });
  return JSON.stringify(r.json);
}

function exportFileName(kind) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return kind === 'encrypted' ? `ente-auth-codes-encrypted-${stamp}.json` : `ente-auth-codes-plaintext-${stamp}.txt`;
}

module.exports = { isEncryptedExport, readExport, buildPlainExport, buildEncryptedExport, exportFileName };
