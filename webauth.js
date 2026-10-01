'use strict';

// Autenticazione per l'accesso da browser:
//  - login Telegram: il browser apre il bot con un deep link, l'utente conferma nel bot
//    (codice di verifica mostrato su entrambi i lati), il browser riceve la sessione;
//  - passkey (WebAuthn): registrate da un utente già autenticato, poi login senza password;
//  - sessioni: token casuale in cookie HttpOnly/Secure/SameSite=Strict, salvato solo come hash.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const LOGIN_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 20;
const MAX_PASSKEYS_PER_USER = 10;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomId = (n = 16) => crypto.randomBytes(n).toString('base64url');

/** Riassunto leggibile dello user agent (es. "Chrome su Windows") */
function describeUA(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'sistema sconosciuto';
  return `${browser} su ${os}`;
}

class WebAuth {
  /**
   * @param {object} o
   * @param {string} o.file        file JSON di persistenza (sessioni + passkey)
   * @param {string} o.origin      origin pubblico, es. https://auth.example.org
   * @param {Buffer} o.secret      chiave per derivare lo user handle delle passkey
   */
  constructor({ file, origin, secret, rpName = 'Codici 2FA', sessionIdleHours = 12, sessionMaxDays = 7 }) {
    this.file = file;
    this.origin = origin;
    this.rpID = origin ? new URL(origin).hostname : '';
    this.rpName = rpName;
    this.secret = secret;
    this.idleMs = sessionIdleHours * 3600 * 1000;
    this.maxMs = sessionMaxDays * 86400 * 1000;
    this.logins = new Map();      // loginId -> { pollHash, code, status, uid, created, ua, ip }
    this.regChallenges = new Map(); // uid -> { challenge, exp }
    this.authChallenges = new Map(); // challenge -> exp
    this.data = { sessions: {}, passkeys: {} };
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { sessions: d.sessions || {}, passkeys: d.passkeys || {} };
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`File auth web illeggibile: ${e.message}`);
    }
    this.saveTimer = null;
    setInterval(() => this.gc(), 60000).unref();
  }

  get enabled() {
    return !!this.origin;
  }

  save(now = false) {
    const write = () => {
      this.saveTimer = null;
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    };
    if (now) { clearTimeout(this.saveTimer); return write(); }
    if (!this.saveTimer) this.saveTimer = setTimeout(write, 1000);
  }

  gc() {
    const now = Date.now();
    for (const [id, l] of this.logins) if (now - l.created > LOGIN_TTL_MS) this.logins.delete(id);
    for (const [uid, c] of this.regChallenges) if (c.exp < now) this.regChallenges.delete(uid);
    for (const [ch, exp] of this.authChallenges) if (exp < now) this.authChallenges.delete(ch);
    let changed = false;
    for (const [h, s] of Object.entries(this.data.sessions)) {
      if (now - s.lastSeen > this.idleMs || now - s.created > this.maxMs) { delete this.data.sessions[h]; changed = true; }
    }
    if (changed) this.save();
  }

  // ================= SESSIONI =================

  createSession(uid, { ua = '', ip = '', method }) {
    const token = randomId(32);
    const now = Date.now();
    this.data.sessions[sha256(token)] = { uid: String(uid), created: now, lastSeen: now, ua: describeUA(ua), ip, method };
    // limita il numero di sessioni per utente (elimina le più vecchie)
    const mine = Object.entries(this.data.sessions).filter(([, s]) => s.uid === String(uid)).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    while (mine.length > MAX_SESSIONS_PER_USER) delete this.data.sessions[mine.shift()[0]];
    this.save(true);
    return token;
  }

  /** @returns {{uid:string, id:string}|null} */
  getSession(token) {
    if (!token) return null;
    const h = sha256(token);
    const s = this.data.sessions[h];
    if (!s) return null;
    const now = Date.now();
    if (now - s.lastSeen > this.idleMs || now - s.created > this.maxMs) {
      delete this.data.sessions[h];
      this.save();
      return null;
    }
    if (now - s.lastSeen > 60000) { s.lastSeen = now; this.save(); }
    return { uid: s.uid, id: h.slice(0, 16) };
  }

  destroySession(token) {
    if (token && this.data.sessions[sha256(token)]) {
      delete this.data.sessions[sha256(token)];
      this.save(true);
    }
  }

  listSessions(uid, currentToken) {
    const cur = currentToken ? sha256(currentToken) : null;
    return Object.entries(this.data.sessions)
      .filter(([, s]) => s.uid === String(uid))
      .map(([h, s]) => ({ id: h.slice(0, 16), ua: s.ua, ip: s.ip, method: s.method, created: s.created, lastSeen: s.lastSeen, current: h === cur }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** revoca una sessione (id = prefisso hash) o tutte tranne la corrente */
  revokeSessions(uid, { id, allExcept } = {}) {
    let n = 0;
    const keep = allExcept ? sha256(allExcept) : null;
    for (const [h, s] of Object.entries(this.data.sessions)) {
      if (s.uid !== String(uid)) continue;
      if ((id && h.startsWith(id)) || (!id && h !== keep)) { delete this.data.sessions[h]; n++; }
    }
    if (n) this.save(true);
    return n;
  }

  // ================= LOGIN TELEGRAM (deep link + conferma nel bot) =================

  startTelegramLogin({ ua = '', ip = '' }) {
    const loginId = randomId(16);
    const pollToken = randomId(24);
    const code = String(crypto.randomInt(10, 99)) + '-' + String(crypto.randomInt(10, 99));
    this.logins.set(loginId, { pollHash: sha256(pollToken), code, status: 'pending', uid: null, created: Date.now(), ua: describeUA(ua), ip });
    return { loginId, pollToken, code };
  }

  getTelegramLogin(loginId) {
    const l = this.logins.get(loginId);
    if (!l || Date.now() - l.created > LOGIN_TTL_MS) return null;
    return l;
  }

  decideTelegramLogin(loginId, uid, approve) {
    const l = this.getTelegramLogin(loginId);
    if (!l || l.status !== 'pending') return null;
    l.status = approve ? 'approved' : 'denied';
    l.uid = String(uid);
    return l;
  }

  /** il browser che ha avviato il login ritira l'esito (una sola volta) */
  pollTelegramLogin(loginId, pollToken) {
    const l = this.getTelegramLogin(loginId);
    if (!l) return { status: 'expired' };
    const given = Buffer.from(sha256(String(pollToken || '')));
    if (!crypto.timingSafeEqual(given, Buffer.from(l.pollHash))) return { status: 'invalid' };
    if (l.status === 'pending') return { status: 'pending' };
    this.logins.delete(loginId);
    return l.status === 'approved' ? { status: 'approved', uid: l.uid } : { status: 'denied' };
  }

  // ================= PASSKEY (WebAuthn) =================

  userHandle(uid) {
    // identificativo opaco per l'autenticatore: non espone lo user ID Telegram
    return crypto.createHmac('sha256', this.secret).update(`webauthn:${uid}`).digest().subarray(0, 32);
  }

  listPasskeys(uid) {
    return Object.entries(this.data.passkeys)
      .filter(([, p]) => p.uid === String(uid))
      .map(([id, p]) => ({ id, name: p.name, created: p.created, lastUsed: p.lastUsed || null, backedUp: !!p.backedUp }))
      .sort((a, b) => a.created - b.created);
  }

  deletePasskey(uid, id) {
    const p = this.data.passkeys[id];
    if (!p || p.uid !== String(uid)) return false;
    delete this.data.passkeys[id];
    this.save(true);
    return true;
  }

  async registrationOptions(uid, userName) {
    if (this.listPasskeys(uid).length >= MAX_PASSKEYS_PER_USER) throw new Error(`Massimo ${MAX_PASSKEYS_PER_USER} passkey`);
    const opts = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userID: this.userHandle(uid),
      userName: userName || `utente-${String(uid).slice(-4)}`,
      userDisplayName: userName || 'Codici 2FA',
      attestationType: 'none',
      excludeCredentials: Object.entries(this.data.passkeys)
        .filter(([, p]) => p.uid === String(uid))
        .map(([id, p]) => ({ id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    this.regChallenges.set(String(uid), { challenge: opts.challenge, exp: Date.now() + CHALLENGE_TTL_MS });
    return opts;
  }

  async verifyRegistration(uid, response, name) {
    const c = this.regChallenges.get(String(uid));
    this.regChallenges.delete(String(uid));
    if (!c || c.exp < Date.now()) throw new Error('Richiesta scaduta, riprova');
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
    });
    if (!v.verified || !v.registrationInfo) throw new Error('Passkey non verificata');
    const { credential, credentialBackedUp } = v.registrationInfo;
    if (this.data.passkeys[credential.id]) throw new Error('Passkey già registrata');
    this.data.passkeys[credential.id] = {
      uid: String(uid),
      publicKey: b64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || [],
      name: String(name || '').trim().slice(0, 40) || 'Passkey',
      backedUp: !!credentialBackedUp,
      created: Date.now(),
    };
    this.save(true);
    return credential.id;
  }

  async authenticationOptions() {
    const opts = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: 'required', allowCredentials: [] });
    this.authChallenges.set(opts.challenge, Date.now() + CHALLENGE_TTL_MS);
    return opts;
  }

  /** @returns {Promise<string>} uid dell'utente autenticato */
  async verifyAuthentication(response) {
    let challenge;
    try {
      challenge = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).challenge;
    } catch {
      throw new Error('Risposta non valida');
    }
    const exp = this.authChallenges.get(challenge);
    this.authChallenges.delete(challenge);
    if (!exp || exp < Date.now()) throw new Error('Richiesta scaduta, riprova');
    const p = this.data.passkeys[response.id];
    if (!p) throw new Error('Passkey non riconosciuta');
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential: { id: response.id, publicKey: Buffer.from(p.publicKey, 'base64url'), counter: p.counter, transports: p.transports },
      requireUserVerification: true,
    });
    if (!v.verified) throw new Error('Passkey non verificata');
    p.counter = v.authenticationInfo.newCounter;
    p.lastUsed = Date.now();
    this.save(true);
    return { uid: p.uid, name: p.name };
  }
}

module.exports = { WebAuth, describeUA };
