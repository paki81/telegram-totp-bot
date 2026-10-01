'use strict';

// Worker per le operazioni pesanti del formato cifrato Ente Auth
// (Argon2id + XChaCha20-Poly1305 secretstream di libsodium), così il
// calcolo della chiave non blocca il bot per gli altri utenti.
const { parentPort, workerData } = require('worker_threads');
const sodium = require('libsodium-wrappers-sumo');

(async () => {
  await sodium.ready;
  const B64 = sodium.base64_variants.ORIGINAL;
  const { op, password } = workerData;
  try {
    if (op === 'decrypt') {
      const { salt, memLimit, opsLimit, encryptedData, encryptionNonce } = workerData;
      const key = sodium.crypto_pwhash(32, password, sodium.from_base64(salt, B64), opsLimit, memLimit, sodium.crypto_pwhash_ALG_ARGON2ID13);
      const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(sodium.from_base64(encryptionNonce, B64), key);
      const res = sodium.crypto_secretstream_xchacha20poly1305_pull(state, sodium.from_base64(encryptedData, B64));
      const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
      const TAG_MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      if (!res || (res.tag !== TAG_FINAL && res.tag !== TAG_MESSAGE)) throw new Error('BAD_PASSWORD');
      parentPort.postMessage({ ok: true, text: sodium.to_string(res.message) });
    } else if (op === 'encrypt') {
      const { plaintext, memLimit, opsLimit } = workerData;
      const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
      const key = sodium.crypto_pwhash(32, password, salt, opsLimit, memLimit, sodium.crypto_pwhash_ALG_ARGON2ID13);
      const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
      const c = sodium.crypto_secretstream_xchacha20poly1305_push(state, sodium.from_string(plaintext), null, sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL);
      parentPort.postMessage({
        ok: true,
        json: {
          version: 1,
          kdfParams: { memLimit, opsLimit, salt: sodium.to_base64(salt, B64) },
          encryptedData: sodium.to_base64(c, B64),
          encryptionNonce: sodium.to_base64(header, B64),
        },
      });
    } else {
      throw new Error('op non valida');
    }
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e && e.message === 'BAD_PASSWORD' ? 'BAD_PASSWORD' : String(e && e.message || e) });
  }
})();
