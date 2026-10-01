'use strict';

const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decodifica base32 (RFC 4648). Tollerante a spazi, minuscole e padding mancante.
 */
function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=]/g, '');
  if (!clean.length) throw new Error('Secret base32 vuoto');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Carattere base32 non valido: "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

/**
 * Genera un codice TOTP (RFC 6238).
 * @param {Buffer} keyBuf  segreto decodificato
 * @param {{digits?:number, period?:number, algorithm?:string, t?:number}} opts
 */
function totp(keyBuf, { digits = 6, period = 30, algorithm = 'SHA1', t = Date.now() } = {}) {
  const counter = Math.floor(t / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmacAlg = algorithm.toLowerCase().replace(/[^a-z0-9]/g, '');
  const digest = crypto.createHmac(hmacAlg, keyBuf).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String((binary >>> 0) % 10 ** digits).padStart(digits, '0');
}

function secondsRemaining(period = 30, t = Date.now()) {
  return period - (Math.floor(t / 1000) % period);
}

/**
 * Parsa un URI otpauth://totp/... oppure un secret base32 nudo.
 * Ritorna { name, secret, digits, period, algorithm } oppure null se non è un URI.
 */
function parseAccountInput(input, fallbackName) {
  const s = String(input).trim();
  if (/^otpauth:\/\//i.test(s)) {
    const url = new URL(s);
    if (url.hostname.toLowerCase() !== 'totp') {
      throw new Error('Supportati solo URI otpauth://totp/...');
    }
    const secret = url.searchParams.get('secret');
    if (!secret) throw new Error('URI otpauth senza parametro secret');
    const issuer = url.searchParams.get('issuer') || '';
    let label = '';
    try { label = decodeURIComponent(url.pathname.replace(/^\//, '')); } catch { label = url.pathname.replace(/^\//, ''); }
    // metadati Ente Auth (codeDisplay: tags, note, trashed)
    let display = {};
    try { display = JSON.parse(url.searchParams.get('codeDisplay') || '{}') || {}; } catch {}
    return {
      name: fallbackName || label || issuer || 'account',
      secret,
      digits: parseInt(url.searchParams.get('digits') || '6', 10),
      period: parseInt(url.searchParams.get('period') || '30', 10),
      algorithm: (url.searchParams.get('algorithm') || 'SHA1').toUpperCase().replace(/^ALGORITHM\./, ''),
      issuer,
      tags: Array.isArray(display.tags) ? display.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : [],
      note: typeof display.note === 'string' ? display.note : '',
      trashed: display.trashed === true,
    };
  }
  return {
    name: fallbackName || 'account',
    secret: s,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
    issuer: '',
    tags: [],
    note: '',
    trashed: false,
  };
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Costruisce un URI otpauth compatibile con Ente Auth (con codeDisplay per tag/note).
 */
function buildOtpauthUri({ name, issuer, keyBuf, digits, period, algorithm, tags, note }) {
  const label = String(name).split(':').map(encodeURIComponent).join(':');
  const params = [
    `secret=${base32Encode(keyBuf)}`,
    issuer ? `issuer=${encodeURIComponent(issuer)}` : null,
    `algorithm=${algorithm || 'SHA1'}`,
    `digits=${digits || 6}`,
    `period=${period || 30}`,
    `codeDisplay=${encodeURIComponent(JSON.stringify({
      pinned: false, trashed: false, lastUsedAt: 0, tapCount: 0,
      tags: tags || [], note: note || '', position: 0, iconSrc: '', iconID: '',
    }))}`,
  ].filter(Boolean);
  return `otpauth://totp/${label}?${params.join('&')}`;
}

/**
 * Valida e normalizza un account: decodifica il secret e verifica che generi un codice.
 */
function validateAccount(acc) {
  const key = base32Decode(acc.secret);
  if (key.length < 5) throw new Error('Secret troppo corto');
  if (!['SHA1', 'SHA256', 'SHA512'].includes(acc.algorithm)) {
    throw new Error(`Algoritmo non supportato: ${acc.algorithm}`);
  }
  if (acc.digits < 6 || acc.digits > 8) throw new Error('Digits deve essere 6-8');
  if (acc.period < 5 || acc.period > 300) throw new Error('Period non valido');
  totp(key, acc); // prova generazione
  return { ...acc, key };
}

module.exports = { base32Decode, base32Encode, buildOtpauthUri, totp, secondsRemaining, parseAccountInput, validateAccount };
