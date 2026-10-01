'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_NAME = 80;
const MAX_CATEGORY = 32;
const MAX_CATEGORIES = 50;

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME);
const cleanCategory = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_CATEGORY);
const uniq = (arr) => [...new Set(arr)];

/**
 * Vault personale di un singolo utente Telegram.
 *
 * - File separato per utente, nome = HMAC(master, uid): non rivela lo user ID.
 * - Chiave dedicata per utente: HKDF-SHA256(master, uid).
 * - Ogni secret è cifrato con AES-256-GCM, con AAD legata a utente + id account:
 *   un blob copiato da un altro vault o da un altro account non si decifra.
 *
 * Formato: { v: 2, categories: [..], accounts: { id: { name, issuer, enc, fp, digits, period, algorithm, tags, note, created } } }
 */
class Vault {
  constructor(file, key, uid, { maxAccounts = 500 } = {}) {
    this.file = file;
    this.key = key;
    this.uid = String(uid);
    this.maxAccounts = maxAccounts;
    this.data = { v: 2, categories: [], accounts: {} };
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { v: 2, categories: Array.isArray(d.categories) ? d.categories : [], accounts: d.accounts || {} };
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`Vault illeggibile: ${e.message}`);
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  aad(id) {
    return Buffer.from(`totp-bot/v2|${this.uid}|${id}`);
  }

  encrypt(buf, id) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(this.aad(id));
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  decrypt(blob, id) {
    const raw = Buffer.from(blob, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAAD(this.aad(id));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  }

  /** impronta del secret per rilevare duplicati senza decifrare */
  fingerprint(secretBuf) {
    return crypto.createHmac('sha256', this.key).update('fp|').update(secretBuf).digest('hex').slice(0, 32);
  }

  get size() {
    return Object.keys(this.data.accounts).length;
  }

  /** metadati (senza secret), ordinati per nome */
  list() {
    return Object.entries(this.data.accounts)
      .map(([id, a]) => ({ id, name: a.name, issuer: a.issuer || '', tags: a.tags || [], note: a.note || '', digits: a.digits, period: a.period, algorithm: a.algorithm }))
      .sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
  }

  has(id) {
    return Object.prototype.hasOwnProperty.call(this.data.accounts, id);
  }

  get(id) {
    const a = this.data.accounts[id];
    if (!a) return null;
    return { id, name: a.name, issuer: a.issuer || '', tags: a.tags || [], note: a.note || '', digits: a.digits, period: a.period, algorithm: a.algorithm, keyBuf: this.decrypt(a.enc, id) };
  }

  findByName(name) {
    const n = String(name).trim().toLowerCase();
    const hit = this.list().find((a) => a.name.toLowerCase() === n);
    return hit ? hit.id : null;
  }

  isDuplicate(secretBuf) {
    const fp = this.fingerprint(secretBuf);
    return Object.values(this.data.accounts).some((a) => a.fp === fp);
  }

  uniqueName(name) {
    const base = cleanName(name) || 'account';
    const taken = new Set(Object.values(this.data.accounts).map((a) => a.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
      const n = `${base} (${i})`;
      if (!taken.has(n.toLowerCase())) return n;
    }
  }

  /** @returns {string} id del nuovo account */
  add({ name, issuer, secretBuf, digits, period, algorithm, tags = [], note = '' }, { save = true } = {}) {
    if (this.size >= this.maxAccounts) throw new Error(`Limite di ${this.maxAccounts} account raggiunto`);
    const id = crypto.randomBytes(6).toString('hex');
    const cleanTags = uniq(tags.map(cleanCategory).filter(Boolean)).slice(0, 10);
    this.data.accounts[id] = {
      name: this.uniqueName(name),
      issuer: String(issuer || '').slice(0, MAX_NAME),
      enc: this.encrypt(secretBuf, id),
      fp: this.fingerprint(secretBuf),
      digits, period, algorithm,
      tags: cleanTags,
      note: String(note || '').slice(0, 500),
      created: Date.now(),
    };
    for (const t of cleanTags) this.ensureCategory(t);
    if (save) this.save();
    return id;
  }

  update(id, { name, tags }) {
    const a = this.data.accounts[id];
    if (!a) throw new Error('Account non trovato');
    if (name !== undefined) {
      const n = cleanName(name);
      if (!n) throw new Error('Nome non valido');
      if (n.toLowerCase() !== a.name.toLowerCase()) a.name = this.uniqueName(n);
      else a.name = n;
    }
    if (tags !== undefined) {
      a.tags = uniq(tags.map(cleanCategory).filter(Boolean)).slice(0, 10);
      for (const t of a.tags) this.ensureCategory(t);
    }
    this.save();
  }

  remove(id) {
    if (!this.has(id)) return false;
    delete this.data.accounts[id];
    this.save();
    return true;
  }

  // ---- categorie ----
  categories() {
    const used = Object.values(this.data.accounts).flatMap((a) => a.tags || []);
    return uniq([...this.data.categories, ...used]).sort((a, b) => a.localeCompare(b, 'it', { sensitivity: 'base' }));
  }

  ensureCategory(name) {
    if (!this.data.categories.includes(name)) {
      if (this.data.categories.length >= MAX_CATEGORIES) throw new Error(`Massimo ${MAX_CATEGORIES} categorie`);
      this.data.categories.push(name);
    }
  }

  addCategory(name) {
    const n = cleanCategory(name);
    if (!n) throw new Error('Nome categoria non valido');
    if (this.categories().some((c) => c.toLowerCase() === n.toLowerCase())) throw new Error('Categoria già esistente');
    this.ensureCategory(n);
    this.save();
    return n;
  }

  renameCategory(oldName, newName) {
    const n = cleanCategory(newName);
    if (!n) throw new Error('Nome categoria non valido');
    if (!this.categories().includes(oldName)) throw new Error('Categoria non trovata');
    this.data.categories = uniq(this.data.categories.map((c) => (c === oldName ? n : c)));
    if (!this.data.categories.includes(n)) this.data.categories.push(n);
    for (const a of Object.values(this.data.accounts)) {
      if (a.tags && a.tags.includes(oldName)) a.tags = uniq(a.tags.map((t) => (t === oldName ? n : t)));
    }
    this.save();
    return n;
  }

  removeCategory(name) {
    this.data.categories = this.data.categories.filter((c) => c !== name);
    for (const a of Object.values(this.data.accounts)) {
      if (a.tags) a.tags = a.tags.filter((t) => t !== name);
    }
    this.save();
  }

  /** tutti gli account con secret decifrato (per l'export) */
  exportAll() {
    return this.list().map((m) => this.get(m.id));
  }
}

/**
 * Gestore dei vault: un vault isolato per ogni utente Telegram.
 */
class Vaults {
  constructor(dir, masterKey, opts = {}) {
    this.dir = dir;
    this.master = masterKey;
    this.opts = opts;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  userKey(uid) {
    return Buffer.from(crypto.hkdfSync('sha256', this.master, Buffer.from('totp-bot/v2'), Buffer.from(`vault:${uid}`), 32));
  }

  fileFor(uid) {
    const h = crypto.createHmac('sha256', this.master).update(`file:${uid}`).digest('hex').slice(0, 40);
    return path.join(this.dir, `${h}.json`);
  }

  for(uid) {
    const id = String(uid);
    if (!/^\d+$/.test(id)) throw new Error('user id non valido');
    if (!this.cache.has(id)) this.cache.set(id, new Vault(this.fileFor(id), this.userKey(id), id, this.opts));
    return this.cache.get(id);
  }
}

/**
 * Migra il vecchio store unico (v1, chiave master, indicizzato per nome) nel vault
 * del proprietario. Il file originale viene conservato come backup `.migrated`.
 */
function migrateLegacy(legacyFile, masterKey, vault) {
  if (!fs.existsSync(legacyFile)) return 0;
  const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  let n = 0;
  for (const [name, a] of Object.entries(legacy.accounts || {})) {
    const raw = Buffer.from(a.enc, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const b64 = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    const secretBuf = Buffer.from(b64, 'base64');
    if (vault.isDuplicate(secretBuf)) continue;
    vault.add({ name, issuer: a.issuer, secretBuf, digits: a.digits, period: a.period, algorithm: a.algorithm }, { save: false });
    n++;
  }
  vault.save();
  fs.renameSync(legacyFile, `${legacyFile}.migrated`);
  return n;
}

/**
 * Ricava la chiave master (32 byte) da env:
 *  - MASTER_KEY: 64 caratteri esadecimali
 *  - MASTER_PASSPHRASE: derivata con scrypt + salt persistente in dataDir
 */
function loadMasterKey(env, dataDir) {
  if (env.MASTER_KEY) {
    const k = Buffer.from(env.MASTER_KEY.trim(), 'hex');
    if (k.length !== 32) throw new Error('MASTER_KEY deve essere 64 caratteri hex (32 byte)');
    return k;
  }
  if (env.MASTER_PASSPHRASE) {
    const saltFile = path.join(dataDir, '.salt');
    let salt;
    try {
      salt = Buffer.from(fs.readFileSync(saltFile, 'utf8').trim(), 'hex');
    } catch {
      salt = crypto.randomBytes(16);
      fs.writeFileSync(saltFile, salt.toString('hex'), { mode: 0o600 });
    }
    return crypto.scryptSync(env.MASTER_PASSPHRASE, salt, 32);
  }
  throw new Error('Configura MASTER_KEY (64 hex) o MASTER_PASSPHRASE nel file .env');
}

module.exports = { Vault, Vaults, migrateLegacy, loadMasterKey };
