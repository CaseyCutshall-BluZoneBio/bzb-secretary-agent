'use strict';
// The token service: a fresh access token for one employee's calendar, from
// their encrypted MSAL cache. Tokens stay inside the portal process: the broker
// uses them to call Graph and returns only Graph's answer.
//
// getAccessToken(employeeId) →
//   { ok: true, token }
//   { ok: false, kind: 'reconnect', code }    the employee must sign in again;
//                                             flagged + one email queued here
//   { ok: false, kind: 'unavailable', code }  Entra/network/app problem; retry
//                                             later, never flags the employee
const { tokenAad } = require('./crypto');
const { CALENDAR_SCOPES } = require('./msal');

// Refresh failed because of the user's account or grant: they must reconnect.
const RECONNECT_CODES = new Set([
  'invalid_grant', 'interaction_required', 'consent_required', 'login_required', 'no_tokens_found',
  'refresh_token_expired', 'bad_token', 'no_account_in_cache', 'token_cache_unreadable', 'no_token_cache',
]);
// AADSTS codes meaning the account is disabled or gone (don't email them).
const ACCOUNT_GONE = new Set(['50057', '50034', '500014']);
// AADSTS codes meaning OUR app is misconfigured (bad/expired secret, app
// deleted, wrong tenant). Never blame the user for these: one bad secret would
// otherwise flag and email every employee at once.
const APP_PROBLEM = new Set(['7000215', '7000222', '700016', '700027', '90002', '500011', '7000112', '650056']);

function classifyMsalError(e) {
  const errorNo = e && e.errorNo ? String(e.errorNo).replace(/^AADSTS/, '') : null;
  const fromMessage = !errorNo && e && typeof e.errorMessage === 'string' ? (e.errorMessage.match(/AADSTS(\d{5,7})/) || [])[1] : null;
  const aadsts = errorNo || fromMessage;
  const code = aadsts ? `AADSTS${aadsts}` : String((e && e.errorCode) || (e && e.name) || 'unknown').slice(0, 60);
  if (aadsts && APP_PROBLEM.has(aadsts)) return { kind: 'unavailable', code, appProblem: true };
  if (aadsts && ACCOUNT_GONE.has(aadsts)) return { kind: 'reconnect', code, notifyEmployee: false };
  const interaction = e && (e.name === 'InteractionRequiredAuthError' || e.constructor && e.constructor.name === 'InteractionRequiredAuthError');
  if (interaction || RECONNECT_CODES.has(e && e.errorCode)) return { kind: 'reconnect', code, notifyEmployee: true };
  return { kind: 'unavailable', code };
}

function createTokenService({ db, keyRing, msalFactory, logger, now = () => Date.now() }) {
  const clients = new Map();      // employeeId → ConfidentialClientApplication
  const locks = new Map();        // employeeId → tail of the promise chain
  const lastOk = new Map();       // employeeId → ms of the last portal_token_ok write

  // Serialize everything for one employee: two refreshes at once would race on
  // the cache row.
  function withLock(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return run;
  }

  function clientFor(id) {
    if (clients.has(id)) return clients.get(id);
    let homeAccountId = null;
    const plugin = {
      beforeCacheAccess: async (ctx) => {
        const row = await db.tokenGet(id);
        if (!row) { homeAccountId = null; return; }
        homeAccountId = row.home_account_id;
        ctx.tokenCache.deserialize(keyRing.decrypt(row, tokenAad(id)));
      },
      afterCacheAccess: async (ctx) => {
        if (!ctx.cacheHasChanged || !homeAccountId) return;
        await db.tokenPut(id, { home_account_id: homeAccountId, ...keyRing.encrypt(ctx.tokenCache.serialize(), tokenAad(id)) });
      },
    };
    const cca = msalFactory(plugin);
    clients.set(id, cca);
    return cca;
  }

  async function fail(id, c) {
    if (c.kind === 'reconnect') {
      await db.markReconnect(id, c.code, c.notifyEmployee !== false);
      logger.warn('token_reconnect_needed', { employee_id: id, error_code: c.code });
    } else {
      logger.error('token_unavailable', { employee_id: id, error_code: c.code, app_problem: !!c.appProblem });
    }
    return { ok: false, kind: c.kind, code: c.code };
  }

  async function getAccessToken(id, { forceRefresh = false } = {}) {
    return withLock(id, async () => {
      const row = await db.tokenGet(id);
      if (!row) return fail(id, { kind: 'reconnect', code: 'no_token_cache', notifyEmployee: true });
      try {
        keyRing.decrypt(row, tokenAad(id));
      } catch (_) {
        return fail(id, { kind: 'reconnect', code: 'token_cache_unreadable', notifyEmployee: true });
      }
      const cca = clientFor(id);
      let result;
      try {
        const account = await cca.getTokenCache().getAccountByHomeId(row.home_account_id);
        if (!account) return fail(id, { kind: 'reconnect', code: 'no_account_in_cache', notifyEmployee: true });
        result = await cca.acquireTokenSilent({ account, scopes: CALENDAR_SCOPES, forceRefresh });
      } catch (e) {
        return fail(id, classifyMsalError(e));
      }
      if (!result || !result.accessToken) return fail(id, { kind: 'unavailable', code: 'empty_result' });
      // Record health at most hourly (and always right after a reconnect flag clears).
      if (forceRefresh || !lastOk.has(id) || now() - lastOk.get(id) > 3600e3) {
        await db.tokenOk(id);
        lastOk.set(id, now());
      }
      return { ok: true, token: result.accessToken };
    });
  }

  // A new sign-in replaced the cache: drop the client so it re-reads.
  const forget = (id) => { clients.delete(id); lastOk.delete(id); };

  return { getAccessToken, forget };
}

module.exports = { createTokenService, classifyMsalError, RECONNECT_CODES, ACCOUNT_GONE, APP_PROBLEM };
