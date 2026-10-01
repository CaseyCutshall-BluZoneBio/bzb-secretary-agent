'use strict';
// Token-cache encryption (AES-256-GCM) and small session helpers.
//
// PORTAL_TOKEN_KEYS = "k2:<base64 32 bytes>,k1:<base64 32 bytes>"
//   The first key encrypts; every listed key can decrypt. Rotation: put a new
//   key first, restart, run bin/rotate-keys.js, then drop the old key.
// The additional authenticated data binds a ciphertext to its employee, so a
// row copied onto another employee won't decrypt.
const crypto = require('crypto');

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

function parseKeyRing(spec) {
  const keys = new Map();
  let current = null;
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const id = part.slice(0, i);
    if (i < 1 || !KEY_ID.test(id)) throw new Error('PORTAL_TOKEN_KEYS: each entry is <id>:<base64 key>');
    const key = Buffer.from(part.slice(i + 1), 'base64');
    if (key.length !== 32) throw new Error(`PORTAL_TOKEN_KEYS: key ${id} must be 32 bytes`);
    if (keys.has(id)) throw new Error(`PORTAL_TOKEN_KEYS: duplicate key id ${id}`);
    keys.set(id, key);
    if (!current) current = id;
  }
  if (!current) throw new Error('PORTAL_TOKEN_KEYS has no keys');
  return { current, keys };
}

function createKeyRing(spec) {
  const ring = parseKeyRing(spec);
  return {
    currentKeyId: ring.current,
    encrypt(plaintext, aad) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', ring.keys.get(ring.current), iv);
      c.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
      return { key_id: ring.current, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'),
               tag: c.getAuthTag().toString('base64') };
    },
    decrypt(rec, aad) {
      const key = ring.keys.get(rec.key_id);
      if (!key) throw new Error(`no key ${rec.key_id} in PORTAL_TOKEN_KEYS`);
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64'));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(rec.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(rec.ciphertext, 'base64')), d.final()]).toString('utf8');
    },
  };
}

const tokenAad = (employeeId) => `sarah-portal:token-cache:v1:${employeeId}`;

// Short-lived sealed values (the sign-in state cookie): encrypted and
// authenticated with a key derived from PORTAL_SESSION_SECRET.
function createSealer(sessionSecret) {
  const key = Buffer.from(crypto.hkdfSync('sha256', sessionSecret, Buffer.alloc(0), 'sarah-portal auth-state v1', 32));
  return {
    seal(obj) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
    },
    unseal(s) {
      try {
        const b = Buffer.from(String(s), 'base64url');
        if (b.length < 29) return null;
        const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
        d.setAuthTag(b.subarray(12, 28));
        return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
      } catch (_) {
        return null;
      }
    },
  };
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Constant-time string comparison (lengths hidden by hashing first).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
}

module.exports = { parseKeyRing, createKeyRing, tokenAad, createSealer, randomToken, sha256, safeEqual };
