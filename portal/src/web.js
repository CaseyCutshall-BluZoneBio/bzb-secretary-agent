'use strict';
// The public server (behind Tailscale Funnel). Before sign-in only /login, the
// sign-in callback (with a valid sign-in state cookie) and the stylesheet are
// reachable; everything else redirects to /login. The broker's /internal/...
// routes do not exist here: they live on a separate listener (broker.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const V = require('./views');
const { COOKIE, parseCookies, readForm, responder, createRateLimiter, socketAddress } = require('./http');
const { createSealer, randomToken, sha256, safeEqual, tokenAad } = require('./crypto');
const { checkIdentity } = require('./identity');
const { validateSettings, prefillFromMailboxSettings } = require('./settings');
const { SIGNIN_SCOPES, CONNECT_SCOPES } = require('./msal');
const { classifyMsalError } = require('./tokens');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'static', 'portal.css'));
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const ME_SELECT = '/me?$select=id,userPrincipalName,mail,displayName,givenName,userType';

const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
const lower = (s) => String(s || '').trim().toLowerCase();

function createPublicApp({ config, db, tokens, graph, msalFactory, keyRing, logger, now = () => Date.now() }) {
  const sealer = createSealer(config.sessionSecret);
  const limit = { login: createRateLimiter(config.rateLimit), callback: createRateLimiter(config.rateLimit) };

  async function loadSession(req) {
    const raw = parseCookies(req)[COOKIE.session];
    if (!raw || raw.length > 200) return null;
    const hash = sha256(raw);
    const s = await db.sessionGet(hash);
    if (!s || !s.employee || !s.employee.enrolled) return null;
    return { hash, csrf: s.csrf, employee: s.employee };
  }

  async function createSession(r, employeeId) {
    const id = randomToken(32);
    await db.sessionCreate(sha256(id), employeeId, randomToken(24), config.sessionTtlSeconds);
    r.cookie(COOKIE.session, id, { maxAge: config.sessionTtlSeconds });
  }

  function isAdmin(emp, cfg) {
    const admins = new Set([lower(cfg.alert_address), ...(cfg.portal_admins || []).map(lower)].filter(Boolean));
    return admins.has(lower(emp.upn)) || (!!emp.mail && admins.has(lower(emp.mail)));
  }

  // Send the browser to Microsoft. The sign-in state (state, nonce, PKCE
  // verifier, purpose) travels in a sealed, short-lived __Host- cookie.
  async function startAuth(r, purpose, emp) {
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const url = await msalFactory(null).getAuthCodeUrl({
      scopes: purpose === 'connect' ? CONNECT_SCOPES : SIGNIN_SCOPES,
      redirectUri: config.redirectUri,
      responseMode: 'query',
      codeChallenge: pkceChallenge(verifier),
      codeChallengeMethod: 'S256',
      state,
      nonce,
      ...(purpose === 'connect' && emp ? { loginHint: emp.upn } : { prompt: 'select_account' }),
    });
    r.cookie(COOKIE.auth, sealer.seal({ s: state, n: nonce, v: verifier, p: purpose, x: now() + AUTH_STATE_TTL_MS,
                                        e: emp ? emp.id : null }), { maxAge: AUTH_STATE_TTL_MS / 1000 });
    r.redirectToLogin(url);
  }

  // Identical for every unauthenticated failure: nothing about why.
  const signInFailed = (r, status = 400) => r.html(status, V.loginPage({ error: true }));

  async function callback(req, r, url) {
    const st = sealer.unseal(parseCookies(req)[COOKIE.auth]);
    if (!st || typeof st.x !== 'number' || st.x < now()) return r.redirect('/login');
    r.clearCookie(COOKIE.auth);
    const q = url.searchParams;
    const connecting = st.p === 'connect';
    const sess = connecting ? await loadSession(req) : null;
    if (connecting && (!sess || sess.employee.id !== st.e)) return r.redirect('/login');
    const fail = (why, flash = 'connect_failed') => {
      logger.warn('sign_in_failed', { purpose: st.p, reason: why });
      return connecting ? r.redirect(`/connect?m=${flash}`) : signInFailed(r);
    };
    if (q.get('error')) return fail(`entra_${String(q.get('error')).slice(0, 40)}`, 'consent_missing');
    if (!q.get('code') || !safeEqual(q.get('state') || '', st.s)) return fail('state_mismatch');

    const cca = msalFactory(null);
    let result;
    try {
      result = await cca.acquireTokenByCode({
        code: q.get('code'), scopes: connecting ? CONNECT_SCOPES : SIGNIN_SCOPES, redirectUri: config.redirectUri,
        codeVerifier: st.v, state: q.get('state'), nonce: st.n,
      });
    } catch (e) {
      return fail(`code_exchange_${classifyMsalError(e).code}`);
    }
    const me = await graph.call('GET', ME_SELECT, result.accessToken);
    if (me.status !== 200) return fail(`graph_me_${me.status}`);
    const cfg = await db.config();
    const id = checkIdentity(result, me.body, { tenantId: config.tenantId, internalDomains: cfg.internal_domains });
    if (!id.ok) return fail(id.reason);

    if (!connecting) {
      const emp = await db.signIn(id.profile);
      if (!emp || !emp.enrolled) return fail('not_enrolled');
      await createSession(r, emp.id);
      logger.info('signed_in', { employee_id: emp.id });
      return r.redirect('/');
    }

    // Connecting the calendar
    const emp = sess.employee;
    if (lower(emp.aad_object_id) !== id.profile.aad_object_id) return fail('wrong_account', 'wrong_account');
    const granted = (result.scopes || []).map(lower);
    if (!granted.includes('calendars.readwrite')) return fail('scope_not_granted', 'consent_missing');
    const day = new Date(now());
    const test = await graph.call('GET', `/me/calendarView?startDateTime=${encodeURIComponent(day.toISOString())}`
      + `&endDateTime=${encodeURIComponent(new Date(now() + 86400e3).toISOString())}&$top=1&$select=id`, result.accessToken);
    if (test.status !== 200) return fail(`test_read_${test.status}`);
    const ms = await graph.call('GET', '/me/mailboxSettings', result.accessToken);
    const prefill = ms.status === 200 ? prefillFromMailboxSettings(ms.body) : null;

    await db.tokenPut(emp.id, { home_account_id: result.account.homeAccountId,
                                ...keyRing.encrypt(cca.getTokenCache().serialize(), tokenAad(emp.id)) });
    tokens.forget(emp.id);
    await db.connected(emp.id, prefill);
    logger.info('calendar_connected', { employee_id: emp.id, prefill: !!prefill });
    return r.redirect('/settings?m=connected');
  }

  async function authed(req, r, url, sess) {
    const { employee: emp, csrf } = sess;
    const cfg = await db.config();
    const admin = isAdmin(emp, cfg);
    const base = { emp, csrf, admin, mode: cfg.mode, flash: V.FLASH[url.searchParams.get('m')] ? url.searchParams.get('m') : null };
    const p = url.pathname;

    if (req.method === 'GET') {
      if (p === '/') return r.html(200, V.homePage(base));
      if (p === '/login') return r.redirect('/');
      if (p === '/connect') return r.html(200, V.connectPage(base));
      if (p === '/settings') return r.html(200, V.settingsPage(base));
      if (p === '/help') return r.html(200, V.helpPage({ ...base, sarahUpn: cfg.sarah_upn }));
      if (p === '/threads') return r.html(200, V.threadsPage({ ...base, threads: await db.myThreads(emp.id) }));
      if (p === '/admin' && admin) return r.html(200, V.adminPage({ ...base, rows: await db.overview() }));
      return r.html(404, V.notFoundPage(base));
    }
    if (req.method !== 'POST') return r.html(404, V.notFoundPage(base));

    const form = await readForm(req);
    if (!form || !safeEqual(form.csrf || '', csrf)) {
      return r.html(403, V.errorPage({ ...base, message: 'That form expired. Go back, reload the page and try again.' }));
    }
    if (p === '/logout') {
      await db.sessionDelete(sess.hash);
      r.clearCookie(COOKIE.session);
      return r.redirect('/login');
    }
    if (p === '/connect') return startAuth(r, 'connect', emp);
    if (p === '/settings') {
      const v = validateSettings(form);
      if (!v.ok) return r.html(400, V.settingsPage({ ...base, flash: null, values: v.value, errors: v.errors }));
      await db.saveSettings(emp.id, v.value);
      return r.redirect('/settings?m=saved');
    }
    if (p === '/pause') {
      const pause = form.action === 'pause';
      await db.setPaused(emp.id, pause);
      return r.redirect(`/?m=${pause ? 'paused' : 'resumed'}`);
    }
    if (p === '/test-email') {
      const q = await db.queueTestMail(emp.id);
      return r.redirect(`/?m=${q && q.status === 'pending' ? 'test_sent' : 'test_not_sent'}`);
    }
    return r.html(404, V.notFoundPage(base));
  }

  return async function publicHandler(req, res) {
    const r = responder(config, res);
    try {
      // The request URL is resolved against the configured origin: the Host
      // header plays no part in anything the portal builds.
      const url = new URL(req.url || '/', config.origin);
      const p = url.pathname;
      if (req.method === 'GET' && p === '/static/portal.css') return r.static(200, 'text/css; charset=utf-8', CSS);

      // Cross-site form posts are refused outright (CSRF tokens apply as well).
      // Browsers send "Origin: null" for a form POST from a page with
      // Referrer-Policy: no-referrer (ours), so "null" carries no information
      // and is treated like a missing header; any real foreign origin is refused.
      const origin = req.headers.origin;
      if (req.method === 'POST' && origin && origin !== 'null' && origin !== config.origin) {
        logger.warn('post_refused', { reason: 'foreign_origin', path: p, origin: String(origin).slice(0, 100) });
        return r.html(403, V.loginPage({ error: true }));
      }
      if (p === '/login' || p === '/auth/callback') {
        const lim = p === '/login' ? limit.login : limit.callback;
        if (!lim.allow(socketAddress(req))) {
          logger.warn('sign_in_failed', { reason: 'rate_limited', path: p });
          return signInFailed(r, 429);
        }
        if (p === '/auth/callback') return req.method === 'GET' ? await callback(req, r, url) : r.redirect('/login');
        if (req.method === 'POST') return await startAuth(r, 'signin', null);
        if (await loadSession(req)) return r.redirect('/');
        return r.html(200, V.loginPage());
      }
      const sess = await loadSession(req);
      if (!sess) return r.redirect('/login');
      return await authed(req, r, url, sess);
    } catch (e) {
      logger.error('portal_error', { message: e && e.message });
      if (!res.headersSent) return r.html(500, V.errorPage({ message: 'Please try again in a minute.' }));
      return res.end();
    }
  };
}

module.exports = { createPublicApp, pkceChallenge };
