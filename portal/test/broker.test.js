'use strict';
// The internal broker and the token service: separate listener, shared-secret
// auth, the three allowed operations, Graph answers passed through, refresh on
// 401, and the failure paths (reconnect vs account gone vs our own
// misconfiguration vs transient).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { tokenAad } = require('../src/crypto');
const { refreshAll } = require('../src/keepalive');

const KEY = 'broker-key-0123456789-0123456789-abcdef';
const CONNECTED = () => H.employeeRow({ calendar_connected_at: '2026-10-01T00:00:00Z' });

let P;
async function start(opts = {}) {
  P = await H.startPortal({ db: H.fakeDb({ employees: [CONNECTED(), H.employeeRow({ id: 1, upn: 'vic@bluzonebio.com', aad_object_id: null, calendar_auth: 'app' })] }), ...opts });
  // Brad's stored cache, encrypted the way the connect step stores it
  await P.db.tokenPut(2, { home_account_id: `${H.OID}.${H.TENANT}`, ...P.keyRing.encrypt('{"fake":"msal-cache"}', tokenAad(2)) });
  P.db._s.calls.length = 0;
  return P;
}
test.afterEach(async () => { if (P) await P.app.close(); });

const call = (body, headers = { 'X-Sarah-Broker-Key': KEY }, port = P.brokerPort) =>
  H.request(port, { method: 'POST', path: '/internal/v1/calendar', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then((r) => ({ ...r, json: r.body ? JSON.parse(r.body) : null }));
const VIEW = { employee_upn: 'brad@bluzonebio.com', op: 'calendar_view', start: '2026-10-05T00:00:00Z', end: '2026-10-20T00:00:00Z' };

test('the broker is its own listener: the public server never routes /internal, even with the key', async () => {
  await start();
  assert.notEqual(P.publicPort, P.brokerPort);
  const viaPublic = await call(VIEW, { 'X-Sarah-Broker-Key': KEY }, P.publicPort);
  assert.equal(viaPublic.status, 302);
  assert.match(viaPublic.headers.location, /\/login$/);
  const health = await H.request(P.publicPort, { path: '/internal/v1/health' });
  assert.equal(health.status, 302);
  assert.equal(P.graph.calls.length, 0, 'nothing reached Graph through the public port');
  assert.equal((await H.request(P.brokerPort, { path: '/internal/v1/health' })).status, 200);
  // and the broker serves no UI
  assert.equal((await H.request(P.brokerPort, { path: '/login' })).status, 404);
  assert.equal((await H.request(P.brokerPort, { path: '/' })).status, 404);
});

test('broker auth: wrong or missing key → 401; nothing else happens', async () => {
  await start();
  assert.equal((await call(VIEW, {})).status, 401);
  assert.equal((await call(VIEW, { 'X-Sarah-Broker-Key': `${KEY}x` })).status, 401);
  assert.equal((await call(VIEW, { 'X-Sarah-Broker-Key': KEY.slice(0, -1) })).json.error.code, 'BrokerAuth');
  assert.equal(P.graph.calls.length, 0);
  assert.equal(P.msal.silentRequests.length, 0);
});

test('calendar_view: Graph is called on /me with the employee\'s token; the answer comes back unchanged and holds no token', async () => {
  await start({ graph: H.defaultGraph({ 'GET ^/me/calendarView': { status: 200, body: { value: [{ id: 'E1', subject: 'Busy' }], '@odata.nextLink': 'next' } } }) });
  const r = await call(VIEW);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { value: [{ id: 'E1', subject: 'Busy' }], '@odata.nextLink': 'next' });
  const g = P.graph.calls[0];
  assert.equal(g.token, 'AT-fresh');
  assert.match(g.path, /^\/me\/calendarView\?startDateTime=2026-10-05T00%3A00%3A00Z&endDateTime=2026-10-20T00%3A00%3A00Z&\$select=/);
  assert.equal(g.headers.Prefer, 'outlook.timezone="UTC"');
  assert.ok(!r.body.includes('AT-fresh'));
  assert.deepEqual(P.msal.silentRequests[0].scopes, ['Calendars.ReadWrite']);
  // the refreshed MSAL cache was written back, encrypted
  assert.equal(P.keyRing.decrypt(P.db._s.tokens.get(2), tokenAad(2)), '{"fake":"refreshed-cache"}');
});

test('create_event / delete_event map to POST /me/events and DELETE /me/events/{id}', async () => {
  await start();
  const ev = { subject: 'Hold', transactionId: 'sarah-hold-9', showAs: 'tentative' };
  const c = await call({ employee_upn: 'brad@bluzonebio.com', op: 'create_event', event: ev });
  assert.equal(c.status, 201);
  assert.equal(c.json.id, 'EV1');
  assert.deepEqual(P.graph.calls[0].body, ev);
  const d = await call({ employee_upn: 'Brad@BluZoneBio.com', op: 'delete_event', event_id: 'AAMk/abc=' });
  assert.equal(d.status, 204);
  assert.equal(P.graph.calls[1].path, '/me/events/AAMk%2Fabc%3D');
});

test('only the three operations, well-formed; no way to name another user or an arbitrary path', async () => {
  await start();
  const bad = [
    { ...VIEW, op: 'send_mail' }, { ...VIEW, op: 'raw', path: '/users/vic@bluzonebio.com/messages' },
    { ...VIEW, start: 'yesterday' }, { ...VIEW, end: '2026-10-01T00:00:00Z' }, { ...VIEW, end: '2028-01-01T00:00:00Z' },
    { employee_upn: 'brad@bluzonebio.com', op: 'create_event', event: [] }, { employee_upn: 'brad@bluzonebio.com', op: 'delete_event' },
    { op: 'calendar_view', start: VIEW.start, end: VIEW.end }, [],
  ];
  for (const b of bad) assert.equal((await call(b)).status, 400, JSON.stringify(b));
  const notJson = await H.request(P.brokerPort, { method: 'POST', path: '/internal/v1/calendar', headers: { 'X-Sarah-Broker-Key': KEY }, body: 'nope' });
  assert.equal(notJson.status, 400);
  assert.equal(P.graph.calls.length, 0);
  assert.ok(P.graph.calls.every((c) => c.path.startsWith('/me/')));
});

test('an employee who is not delegated, unknown, or not enrolled → 422 (never confused with "event gone")', async () => {
  await start();
  assert.equal((await call({ ...VIEW, employee_upn: 'vic@bluzonebio.com' })).status, 422, 'app-only employees are not the broker\'s business');
  assert.equal((await call({ ...VIEW, employee_upn: 'nobody@bluzonebio.com' })).json.error.code, 'EmployeeNotDelegated');
  P.db._s.employees.get(2).enrolled = false;
  assert.equal((await call(VIEW)).status, 422);
});

test('dead refresh token → 409 NeedsReconnect, employee flagged once with a code (no PII), nothing sent to Graph', async () => {
  const err = Object.assign(new Error('AADSTS700082: The refresh token has expired due to inactivity. user brad@bluzonebio.com'),
    { name: 'InteractionRequiredAuthError', errorCode: 'invalid_grant', errorNo: '700082', errorMessage: 'AADSTS700082: … brad@bluzonebio.com' });
  await start({ msal: H.fakeMsal({ silent: () => { throw err; } }) });
  const r = await call(VIEW);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'NeedsReconnect');
  assert.ok(!/AADSTS|brad@|refresh token/i.test(r.body), 'no MSAL detail in the response');
  assert.deepEqual(P.db._s.calls.filter((c) => c[0] === 'markReconnect'), [['markReconnect', 2, 'AADSTS700082', true]]);
  assert.equal(P.graph.calls.length, 0);
  assert.ok(!JSON.stringify(P.logger.lines).includes('brad@bluzonebio.com'), 'logs carry the code, not the message');
});

test('account disabled → reconnect without emailing the employee; our own bad secret → 503 and nobody is flagged', async () => {
  await start({ msal: H.fakeMsal({ silent: () => { throw Object.assign(new Error('x'), { errorCode: 'invalid_grant', errorNo: '50057' }); } }) });
  assert.equal((await call(VIEW)).status, 409);
  assert.deepEqual(P.db._s.calls.find((c) => c[0] === 'markReconnect'), ['markReconnect', 2, 'AADSTS50057', false]);
  await P.app.close();

  await start({ msal: H.fakeMsal({ silent: () => { throw Object.assign(new Error('x'), { errorCode: 'invalid_client', errorNo: '7000222' }); } }) });
  const r = await call(VIEW);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'TokenServiceUnavailable');
  assert.equal(P.db._s.calls.filter((c) => c[0] === 'markReconnect').length, 0, 'an expired portal secret must not mass-email every employee');
  assert.ok(P.logger.lines.some((l) => l.event === 'token_unavailable' && l.app_problem === true));
});

test('Graph 401 with a token that looked fine (revoked mid-life) → one forced refresh, then the retry', async () => {
  let n = 0;
  await start({ graph: H.defaultGraph({ 'GET ^/me/calendarView': () => (++n === 1 ? { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } } : { status: 200, body: { value: [] } }) }) });
  const r = await call(VIEW);
  assert.equal(r.status, 200);
  assert.deepEqual(P.msal.silentRequests.map((s) => s.forceRefresh), [false, true]);
  // …and if the forced refresh fails, it's a reconnect
  await P.app.close();
  let first = true;
  await start({
    msal: H.fakeMsal({ silent: (req) => { if (req.forceRefresh && !first) throw Object.assign(new Error('x'), { name: 'InteractionRequiredAuthError', errorCode: 'invalid_grant', errorNo: '50173' }); first = false; return { accessToken: 'AT-old' }; } }),
    graph: H.defaultGraph({ 'GET ^/me/calendarView': { status: 401, body: {} } }),
  });
  assert.equal((await call(VIEW)).status, 409);
});

test('Graph errors are passed through as they are (the executor classifies them)', async () => {
  await start({ graph: H.defaultGraph({ 'POST ^/me/events$': { status: 429, body: { error: { code: 'TooManyRequests' } } }, 'DELETE ^/me/events/': { status: 404, body: { error: { code: 'ErrorItemNotFound' } } } }) });
  assert.equal((await call({ employee_upn: 'brad@bluzonebio.com', op: 'create_event', event: { subject: 'x' } })).status, 429);
  assert.equal((await call({ employee_upn: 'brad@bluzonebio.com', op: 'delete_event', event_id: 'gone' })).json.error.code, 'ErrorItemNotFound');
});

test('no cache, unreadable cache (wrong key), or never connected → NeedsReconnect', async () => {
  await start();
  P.db._s.tokens.delete(2);
  assert.equal((await call(VIEW)).status, 409);
  assert.equal(P.db._s.calls.find((c) => c[0] === 'markReconnect')[2], 'no_token_cache');
  await P.app.close();
  await start();
  await P.db.tokenPut(2, { home_account_id: 'h', ...require('../src/crypto').createKeyRing(`zz:${H.KEY2}`).encrypt('x', tokenAad(2)) });
  assert.equal((await call(VIEW)).status, 409);
  await P.app.close();
  await start();
  P.db._s.employees.get(2).calendar_connected_at = null;
  const r = await call(VIEW);
  assert.equal(r.status, 409);
  assert.equal(P.db._s.calls.filter((c) => c[0] === 'markReconnect').length, 0, 'never connected is not "lost access": no reconnect email');
});

test('refreshes for one employee never overlap (the cache row would race)', async () => {
  let active = 0;
  let maxActive = 0;
  await start({ msal: H.fakeMsal({ silent: () => ({ accessToken: 'AT' }) }) });
  const origGet = P.db.tokenGet;
  P.db.tokenGet = async (id) => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return origGet(id); };
  await Promise.all([1, 2, 3, 4].map(() => P.tokens.getAccessToken(2)));
  assert.equal(maxActive, 1);
});

test('daily keep-alive refreshes every connected employee and flags a dead one before any client email', async () => {
  await start({ msal: H.fakeMsal({ silent: () => { throw Object.assign(new Error('x'), { name: 'InteractionRequiredAuthError', errorCode: 'invalid_grant', errorNo: '50173' }); } }) });
  const r = await refreshAll({ db: P.db, tokens: P.tokens, logger: P.logger });
  assert.deepEqual(r, { employees: 1, ok: 0 });
  assert.equal(P.msal.silentRequests[0].forceRefresh, true);
  assert.equal(P.db._s.employees.get(2).needs_reconnect, true);
  // once flagged, it's no longer on the list (no daily email storm)
  assert.deepEqual(await refreshAll({ db: P.db, tokens: P.tokens, logger: P.logger }), { employees: 0, ok: 0 });
});
