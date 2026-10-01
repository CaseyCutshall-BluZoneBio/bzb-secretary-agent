#!/usr/bin/env node
'use strict';
// Re-encrypt every stored token cache with the CURRENT key (the first entry in
// PORTAL_TOKEN_KEYS). Steps (docs/09-portal.md, "Rotating the encryption key"):
//   1. PORTAL_TOKEN_KEYS="new:<b64>,old:<b64>", restart the portal
//   2. run this:  docker compose exec sarah-portal node bin/rotate-keys.js
//   3. drop the old key from PORTAL_TOKEN_KEYS, restart again
// Uses the same env as the portal. Prints counts only, never token data.
const { Pool } = require('pg');
const { createKeyRing, tokenAad } = require('../src/crypto');
const { createDb } = require('../src/db');

async function rotate({ db, keyRing }) {
  let rotated = 0;
  let current = 0;
  const failed = [];
  for (const id of await db.tokenIds()) {
    const row = await db.tokenGet(id);
    if (!row) continue;
    if (row.key_id === keyRing.currentKeyId) { current += 1; continue; }
    try {
      const plain = keyRing.decrypt(row, tokenAad(id));
      await db.tokenPut(id, { home_account_id: row.home_account_id, ...keyRing.encrypt(plain, tokenAad(id)) });
      rotated += 1;
    } catch (_) {
      failed.push(id);
    }
  }
  return { rotated, already_current: current, failed };
}

if (require.main === module) {
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
  rotate({ db: createDb(pool), keyRing: createKeyRing(process.env.PORTAL_TOKEN_KEYS) })
    .then((r) => {
      process.stdout.write(`${JSON.stringify(r)}\n`);
      if (r.failed.length) process.stdout.write('Some caches could not be decrypted with any listed key; those employees must reconnect.\n');
      return pool.end().then(() => process.exit(r.failed.length ? 2 : 0));
    })
    .catch((e) => { process.stderr.write(`rotation failed: ${e.message}\n`); process.exit(1); });
}

module.exports = { rotate };
