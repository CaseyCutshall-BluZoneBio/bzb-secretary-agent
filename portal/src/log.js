'use strict';
// One-line JSON logs. Only plain fields that are safe to keep go in; anything
// that looks like a token, an auth code, a cookie or the broker key is
// redacted, and MSAL messages that contain PII are dropped (see msal.js).

const SECRET_KEYS = /token|secret|code|cookie|authorization|password|key|verifier|assertion|claims/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const LONG_OPAQUE = /\b[A-Za-z0-9_\-.~+/]{60,}={0,2}/g;

function scrub(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.replace(JWT, '[redacted-jwt]').replace(LONG_OPAQUE, '[redacted]').slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(scrub);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) && k !== 'error_code' ? '[redacted]' : scrub(v);
    return out;
  }
  return '[unloggable]';
}

function createLogger(write = (line) => process.stdout.write(`${line}\n`)) {
  const log = (level, event, fields = {}) => write(JSON.stringify({ t: new Date().toISOString(), level, event, ...scrub(fields) }));
  return {
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}

module.exports = { createLogger, scrub };
