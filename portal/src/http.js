'use strict';
// HTTP plumbing for the public server: security headers, cookies, forms,
// redirects and rate limiting.
//
// The portal sits behind Tailscale Funnel: TLS ends at tailscaled and requests
// arrive as plain HTTP from a local address. So nothing here trusts the
// request's Host, X-Forwarded-Proto/-Host/-For or similar headers: absolute
// URLs come from PORTAL_BASE_URL, cookies are always Secure, and rate limits
// key on the socket address.

// Every cookie the portal sets or reads. __Host- means: Secure, Path=/, no
// Domain, so it is bound to this exact host. The hostname is shared with Open
// WebUI (cookies are per host, not per port); the "sarah_" names can't collide
// with its cookies, and any other cookie in the jar is ignored.
const COOKIE = { session: '__Host-sarah_session', auth: '__Host-sarah_auth' };
const OUR_COOKIES = new Set(Object.values(COOKIE));

function securityHeaders(config) {
  const loginOrigin = new URL(config.authorityHost).origin;
  return {
    'Strict-Transport-Security': 'max-age=31536000',
    // No script at all. Forms post to the portal itself; /login and /connect
    // then redirect to Microsoft's sign-in page, which form-action must allow.
    'Content-Security-Policy': [
      "default-src 'none'", "style-src 'self'", "img-src 'self'", `form-action 'self' ${loginOrigin}`,
      "frame-ancestors 'none'", "base-uri 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}

function serializeCookie(name, value, { maxAge, expire = false } = {}) {
  if (!OUR_COOKIES.has(name)) throw new Error(`refusing to set unknown cookie ${name}`);
  const parts = [`${name}=${expire ? '' : encodeURIComponent(value)}`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax'];
  if (expire) parts.push('Max-Age=0');
  else if (maxAge) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  return parts.join('; ');
}

// Only the portal's own cookies; everything else in the jar is ignored.
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!OUR_COOKIES.has(name) || out[name] !== undefined) continue;
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* malformed: ignore */ }
  }
  return out;
}

function readForm(req, limit = 32 * 1024) {
  return new Promise((resolve) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') { req.resume(); resolve(null); return; }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', () => resolve(null));
  });
}

// A response object that always carries the security headers.
function responder(config, res) {
  const headers = securityHeaders(config);
  const cookies = [];
  const base = () => ({ ...headers, 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  return {
    cookie(name, value, opts) { cookies.push(serializeCookie(name, value, opts)); },
    clearCookie(name) { cookies.push(serializeCookie(name, '', { expire: true })); },
    html(status, body) {
      res.writeHead(status, { ...base(), 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    },
    // In-portal redirect: the Location is always PORTAL_BASE_URL + a fixed path.
    redirect(path) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('bad redirect path');
      res.writeHead(302, { ...base(), Location: `${config.origin}${path}` });
      res.end();
    },
    // Redirect to Microsoft's sign-in page (an MSAL-built URL on the authority host).
    redirectToLogin(url) {
      if (new URL(url).origin !== new URL(config.authorityHost).origin) throw new Error('unexpected sign-in host');
      res.writeHead(302, { ...base(), Location: url });
      res.end();
    },
    static(status, type, body, maxAge = 3600) {
      res.writeHead(status, { ...headers, 'Content-Type': type, 'Cache-Control': `public, max-age=${maxAge}` });
      res.end(body);
    },
  };
}

// Fixed-window counter per key. The key is the socket address, never a header.
// Behind Funnel + Docker every request may share one socket address, so in
// practice this caps sign-in attempts for the whole portal (docs/09-portal.md).
function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      let h = hits.get(key);
      if (!h || t - h.start >= windowMs) { h = { start: t, n: 0 }; hits.set(key, h); }
      h.n += 1;
      if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      return h.n <= max;
    },
  };
}

const socketAddress = (req) => (req.socket && req.socket.remoteAddress) || 'unknown';

module.exports = { COOKIE, securityHeaders, serializeCookie, parseCookies, readForm, responder, createRateLimiter, socketAddress };
