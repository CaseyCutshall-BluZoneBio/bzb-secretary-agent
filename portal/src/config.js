'use strict';
// Portal configuration, from the environment only (docs/09-portal.md lists every
// variable). Every absolute URL the portal ever produces is built from
// PORTAL_BASE_URL: never from the Host or X-Forwarded-* request headers, which
// a request can set to anything.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ConfigError extends Error {}

function required(env, name) {
  const v = env[name];
  if (v === undefined || String(v).trim() === '') throw new ConfigError(`${name} is required`);
  return String(v).trim();
}

function int(env, name, fallback) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

// The public origin. HTTPS, at the root path, nothing else. Plain http is only
// accepted for localhost, and only when explicitly allowed (local development).
function parseBaseUrl(raw, allowInsecureLocalhost) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new ConfigError('PORTAL_BASE_URL is not a URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && allowInsecureLocalhost)) {
    throw new ConfigError('PORTAL_BASE_URL must be https:// (Entra only accepts an HTTPS redirect URI)');
  }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    throw new ConfigError('PORTAL_BASE_URL must be an origin only, e.g. https://bzb-ai-1.tail9f1964.ts.net:8443');
  }
  return u.origin;
}

function loadConfig(env = process.env) {
  const origin = parseBaseUrl(required(env, 'PORTAL_BASE_URL'), env.PORTAL_ALLOW_INSECURE_LOCALHOST === '1');
  const tenantId = required(env, 'ENTRA_TENANT_ID');
  if (!GUID.test(tenantId)) throw new ConfigError('ENTRA_TENANT_ID must be the tenant GUID (not a domain)');
  const brokerKey = required(env, 'PORTAL_BROKER_KEY');
  if (brokerKey.length < 32) throw new ConfigError('PORTAL_BROKER_KEY must be at least 32 characters');
  const sessionSecret = Buffer.from(required(env, 'PORTAL_SESSION_SECRET'), 'base64');
  if (sessionSecret.length < 32) throw new ConfigError('PORTAL_SESSION_SECRET must be at least 32 random bytes, base64');
  const authorityHost = (env.ENTRA_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/+$/, '');
  return {
    origin,
    redirectUri: `${origin}/auth/callback`,
    tenantId: tenantId.toLowerCase(),
    clientId: required(env, 'ENTRA_CLIENT_ID'),
    clientSecret: required(env, 'ENTRA_CLIENT_SECRET'),
    authorityHost,
    authority: `${authorityHost}/${tenantId.toLowerCase()}`,
    graphBaseUrl: (env.GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, ''),
    tokenKeys: required(env, 'PORTAL_TOKEN_KEYS'),
    sessionSecret,
    brokerKey,
    databaseUrl: env.DATABASE_URL || null,      // else the standard PG* variables
    publicHost: env.PORTAL_LISTEN_HOST || '0.0.0.0',
    publicPort: int(env, 'PORTAL_PORT', 3000),
    brokerHost: env.PORTAL_BROKER_HOST || '0.0.0.0',
    brokerPort: int(env, 'PORTAL_BROKER_PORT', 3001),
    sessionTtlSeconds: int(env, 'PORTAL_SESSION_HOURS', 12) * 3600,
    rateLimit: { max: int(env, 'PORTAL_RATE_LIMIT_MAX', 30), windowMs: int(env, 'PORTAL_RATE_LIMIT_WINDOW_S', 300) * 1000 },
    keepaliveHours: int(env, 'PORTAL_KEEPALIVE_HOURS', 24),
  };
}

module.exports = { loadConfig, parseBaseUrl, ConfigError };
