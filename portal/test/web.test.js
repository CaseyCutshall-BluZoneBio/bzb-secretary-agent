'use strict';
// The public server, over real HTTP: Funnel hardening (headers, cookies,
// spoofed Host / X-Forwarded-*, redirects before sign-in, rate limits), the
// sign-in and connect flows with MSAL mocked, settings, pause, test email, admin.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { tokenAad } = require('../src/crypto');

const ORIGIN = 'https://bzb-ai-1.tail9f1964.ts.net:10000';
const SPOOF = { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '6.6.6.6', Forwarded: 'host=evil.example;proto=http' };

let P;
test.beforeEach(async () => { P = await H.startPortal(); });
test.afterEach(async () => { await P.app.close(); });

// Every route the public server knows, plus a few it must not.
const AUTHED_GETS = ['/', '/connect', '/settings', '/help', '/threads', '/admin', '/nope', '/internal/v1/calendar', '/internal/v1/health', '/static/other.css', '/favicon.ico'];
const AUTHED_POSTS = ['/connect', '/settings', '/pause', '/test-email', '/logout', '/internal/v1/calendar', '/auth/callback'];

test('before sign-in, every route except /login (and the stylesheet) redirects to /login', async () => {
  for (const path of AUTHED_GETS) {
    const r = await H.request(P.publicPort, { path });
    assert.equal(r.status, 302, `GET ${path}`);
    assert.equal(r.headers.location, `${ORIGIN}/login`, `GET ${path}`);
  }
  for (const path of AUTHED_POSTS) {
    const r = await H.request(P.publicPort, { method: 'POST', path, ...H.form({ csrf: 'x' }) });
    assert.equal(r.status, 302, `POST ${path}`);
    assert.equal(r.headers.location, `${ORIGIN}/login`, `POST ${path}`);
  }
  // the callback without a sign-in in flight is just another redirect
  assert.equal((await H.request(P.publicPort, { path: '/auth/callback?code=x&state=y' })).headers.location, `${ORIGIN}/login`);
  assert.equal((await H.request(P.publicPort, { path: '/login' })).status, 200);
  const css = await H.request(P.publicPort, { path: '/static/portal.css' });
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
});

test('security headers are on every response: pages, redirects, errors, static', async () => {
  const { cookie } = await H.signIn(P);
  const responses = [
    await H.request(P.publicPort, { path: '/login' }),
    await H.request(P.publicPort, { path: '/settings' }),
    await H.request(P.publicPort, { path: '/static/portal.css' }),
    await H.request(P.publicPort, { path: '/', headers: { Cookie: cookie } }),
    await H.request(P.publicPort, { path: '/nope', headers: { Cookie: cookie } }),
    await H.request(P.publicPort, { method: 'POST', path: '/login', ...H.form({}) }),
  ];
  for (const r of responses) {
    assert.equal(r.headers['strict-transport-security'], 'max-age=31536000');
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self' https:\/\/login\.microsoftonline\.com/);
    assert.ok(!/script-src|unsafe-inline|unsafe-eval/.test(csp), 'no script allowed at all');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-frame-options'], 'DENY');
  }
  // and no inline script anywhere in the pages
  for (const r of responses.filter((x) => /text\/html/.test(x.headers['content-type'] || ''))) assert.ok(!/<script/i.test(r.body));
});

test('absolute URLs come from PORTAL_BASE_URL; spoofed Host / X-Forwarded-* headers are ignored', async () => {
  const unauth = await H.request(P.publicPort, { path: '/settings', headers: SPOOF });
  assert.equal(unauth.headers.location, `${ORIGIN}/login`);
  const start = await H.request(P.publicPort, { method: 'POST', path: '/login', headers: { ...SPOOF, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(start.status, 302);
  assert.ok(start.headers.location.startsWith('https://login.microsoftonline.com/'));
  assert.equal(P.msal.authUrlRequests[0].redirectUri, `${ORIGIN}/auth/callback`, 'the OAuth redirect URI never follows the Host header');
  const { cookie } = await H.signIn(P);
  const out = await H.request(P.publicPort, { method: 'POST', path: '/pause', headers: { ...SPOOF, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
                                              body: `csrf=${await H.csrfFor(P, cookie)}&action=pause` });
  assert.equal(out.headers.location, `${ORIGIN}/?m=paused`);
  // cookies stay Secure even though the request arrived as plain HTTP claiming proto=http
  for (const c of start.headers['set-cookie']) assert.match(c, /; Secure/);
});

test('cookies: __Host- prefixed, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain; other cookies are ignored', async () => {
  const start = await H.request(P.publicPort, { method: 'POST', path: '/login', ...H.form({}) });
  const { callback } = await H.signIn(P);
  const set = [...start.headers['set-cookie'], ...callback.headers['set-cookie']];
  assert.ok(set.length >= 3);
  for (const c of set) {
    const name = c.split('=')[0];
    assert.ok(['__Host-sarah_session', '__Host-sarah_auth'].includes(name), `unexpected cookie ${name}`);
    assert.match(c, /; Path=\/(;|$)/);
    assert.match(c, /; Secure(;|$)/);
    assert.match(c, /; HttpOnly(;|$)/);
    assert.match(c, /; SameSite=Lax(;|$)/);
    assert.ok(!/domain=/i.test(c), 'no Domain attribute');
  }
  // Open WebUI's cookies on the same hostname (and look-alikes) are never read
  const r = await H.request(P.publicPort, { path: '/', headers: { Cookie: 'token=owui-jwt; sarah_session=x; __Host-sarah_sessionX=y; oauth_id_token=z' } });
  assert.equal(r.headers.location, `${ORIGIN}/login`);
});

test('sign-in: PKCE + state + nonce; tenant members get a session; MSAL received the verifier', async () => {
  const { cookie, callback } = await H.signIn(P);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, `${ORIGIN}/`);
  const a = P.msal.authUrlRequests[0];
  assert.equal(a.codeChallengeMethod, 'S256');
  assert.ok(a.state.length >= 24 && a.nonce.length >= 24);
  assert.deepEqual(a.scopes, ['User.Read']);
  const c = P.msal.codeRequests[0];
  assert.equal(require('../src/web').pkceChallenge(c.codeVerifier), a.codeChallenge);
  assert.equal(c.nonce, a.nonce);
  const home = await H.request(P.publicPort, { path: '/', headers: { Cookie: cookie } });
  assert.equal(home.status, 200);
  assert.match(home.body, /Hi Brad/);
  // the sign-in step stores no tokens
  assert.equal(P.db._s.tokens.size, 0);
});

test('sign-in failures look identical to the user: other tenant, guest, bad state, Entra error', async () => {
  const attempt = async (setup, mangleState = false, extra = '') => {
    setup();
    const start = await H.request(P.publicPort, { method: 'POST', path: '/login', ...H.form({}) });
    const auth = H.cookieValue(start, '__Host-sarah_auth');
    const state = P.msal.authUrlRequests[P.msal.authUrlRequests.length - 1].state;
    return H.request(P.publicPort, { path: `/auth/callback?code=C&state=${mangleState ? 'wrong' : encodeURIComponent(state)}${extra}`,
                                     headers: { Cookie: `__Host-sarah_auth=${auth}` } });
  };
  const results = [
    await attempt(() => { P.msal.codeResult = H.authResult({ tid: H.OTHER_TENANT, homeTenant: H.OTHER_TENANT }); }),
    await attempt(() => { P.msal.codeResult = H.authResult({ homeTenant: H.OTHER_TENANT }); }),
    await attempt(() => { P.msal.codeResult = H.authResult(); }, true),
    await attempt(() => { P.msal.codeResult = Object.assign(new Error('x'), { errorCode: 'invalid_grant', errorMessage: 'AADSTS50105: user brad@bluzonebio.com is not assigned' }); }),
  ];
  const guestGraph = await (async () => {
    await P.app.close();
    P = await H.startPortal({ graph: H.defaultGraph({ 'GET ^/me\\?': { status: 200, body: { ...H.ME, userType: 'Guest' } } }) });
    return attempt(() => { P.msal.codeResult = H.authResult(); });
  })();
  results.push(guestGraph);
  for (const r of results) {
    assert.equal(r.status, 400);
    assert.equal(r.body, results[0].body, 'same page for every failure');
    assert.ok(!(r.headers['set-cookie'] || []).some((c) => c.startsWith('__Host-sarah_session=') && !/Max-Age=0/.test(c)), 'no session');
    assert.ok(!/AADSTS|brad@|tenant|guest/i.test(r.body), 'no detail leaks to the browser');
  }
});

test('connect: tokens stored encrypted for the right employee; Outlook prefill applied; calendar_auth flips to delegated', async () => {
  const { cookie } = await H.signIn(P);
  P.msal.codeResult = H.authResult();
  const start = await H.request(P.publicPort, { method: 'POST', path: '/connect', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
                                                body: `csrf=${await H.csrfFor(P, cookie)}` });
  assert.equal(start.status, 302);
  const req = P.msal.authUrlRequests[P.msal.authUrlRequests.length - 1];
  assert.deepEqual(req.scopes, ['User.Read', 'MailboxSettings.Read', 'Calendars.ReadWrite']);
  assert.equal(req.loginHint, 'brad@bluzonebio.com');
  const auth = H.cookieValue(start, '__Host-sarah_auth');
  const cb = await H.request(P.publicPort, { path: `/auth/callback?code=C2&state=${encodeURIComponent(req.state)}`,
                                             headers: { Cookie: `${cookie}; __Host-sarah_auth=${auth}` } });
  assert.equal(cb.headers.location, `${ORIGIN}/settings?m=connected`);
  const row = P.db._s.tokens.get(2);
  assert.equal(row.home_account_id, `${H.OID}.${H.TENANT}`);
  assert.ok(!Buffer.from(row.ciphertext, 'base64').toString('utf8').includes('msal-cache'));
  assert.equal(P.keyRing.decrypt(row, tokenAad(2)), '{"fake":"msal-cache"}');
  const emp = P.db._s.employees.get(2);
  assert.equal(emp.calendar_auth, 'delegated');
  assert.ok(emp.calendar_connected_at);
  assert.equal(emp.timezone, 'America/Los_Angeles');
  assert.deepEqual(emp.working_hours.mon, ['08:00', '16:30']);
  assert.equal(emp.working_hours.fri, null);
  assert.ok(P.graph.calls.some((c) => c.path.startsWith('/me/calendarView') && c.token === 'AT-from-code'), 'a test read proved the grant works');
});

test('connect: refused calendar consent or a different account never stores tokens', async () => {
  const { cookie } = await H.signIn(P);
  const connect = async () => {
    const start = await H.request(P.publicPort, { method: 'POST', path: '/connect', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
                                                  body: `csrf=${await H.csrfFor(P, cookie)}` });
    const st = P.msal.authUrlRequests[P.msal.authUrlRequests.length - 1].state;
    return H.request(P.publicPort, { path: `/auth/callback?code=C&state=${encodeURIComponent(st)}`,
                                     headers: { Cookie: `${cookie}; __Host-sarah_auth=${H.cookieValue(start, '__Host-sarah_auth')}` } });
  };
  P.msal.codeResult = H.authResult({ scopes: ['User.Read'] });
  assert.equal((await connect()).headers.location, `${ORIGIN}/connect?m=consent_missing`);
  P.msal.codeResult = H.authResult({ oid: 'ffffffff-0000-0000-0000-000000000000' });
  await P.app.close();
  P = await H.startPortal({ db: P.db, msal: P.msal, graph: H.defaultGraph({ 'GET ^/me\\?': { status: 200, body: { ...H.ME, id: 'ffffffff-0000-0000-0000-000000000000' } } }) });
  assert.equal((await connect()).headers.location, `${ORIGIN}/connect?m=wrong_account`);
  assert.equal(P.db._s.tokens.size, 0);
});

test('every POST needs the session CSRF token; cross-site posts are refused', async () => {
  const { cookie } = await H.signIn(P);
  const post = (body, headers = {}) => H.request(P.publicPort, { method: 'POST', path: '/pause', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body });
  assert.equal((await post('action=pause')).status, 403);
  assert.equal((await post('action=pause&csrf=forged')).status, 403);
  assert.equal(P.db._s.employees.get(2).paused, false);
  const csrf = await H.csrfFor(P, cookie);
  assert.equal((await post(`action=pause&csrf=${csrf}`, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(`action=pause&csrf=${csrf}`, { Origin: ORIGIN })).status, 302);
  assert.equal(P.db._s.employees.get(2).paused, true);
});

test('settings: validation errors re-render with messages; a valid form is saved', async () => {
  const { cookie } = await H.signIn(P);
  const csrf = await H.csrfFor(P, cookie);
  const page = await H.request(P.publicPort, { path: '/settings', headers: { Cookie: cookie } });
  assert.match(page.body, /name="default_duration_min"[^>]*value="30"/);
  const base = { csrf, first_name: 'Brad', timezone: 'America/New_York', mon_on: 'on', mon_start: '09:00', mon_end: '17:00', preferred_start: '09:30', preferred_end: '16:00',
    default_duration_min: '30', default_location: 'teams', hard_gap_min: '5', preferred_gap_min: '30', in_person_buffer_min: '30', max_meetings_per_day: '6',
    min_notice_hours: '24', search_window_days: '10', offers_per_round: '3' };
  const bad = await H.request(P.publicPort, { method: 'POST', path: '/settings', ...H.form({ ...base, default_duration_min: '500' }, { Cookie: cookie }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /Default meeting length must be a whole number from 10 to 240/);
  assert.ok(!P.db._s.calls.some((c) => c[0] === 'saveSettings'));
  const good = await H.request(P.publicPort, { method: 'POST', path: '/settings', ...H.form({ ...base, default_duration_min: '45' }, { Cookie: cookie }) });
  assert.equal(good.headers.location, `${ORIGIN}/settings?m=saved`);
  assert.equal(P.db._s.employees.get(2).default_duration_min, 45);
});

test('pause/resume, send-me-a-test (honest about the run mode), my threads (escaped), sign out', async () => {
  const { cookie } = await H.signIn(P);
  const csrf = await H.csrfFor(P, cookie);
  const post = (path, extra = {}) => H.request(P.publicPort, { method: 'POST', path, ...H.form({ csrf, ...extra }, { Cookie: cookie }) });
  assert.equal((await post('/pause', { action: 'pause' })).headers.location, `${ORIGIN}/?m=paused`);
  assert.equal((await post('/pause', { action: 'resume' })).headers.location, `${ORIGIN}/?m=resumed`);
  assert.equal(P.db._s.employees.get(2).paused, false);
  assert.equal((await post('/test-email')).headers.location, `${ORIGIN}/?m=test_sent`);
  P.db._s.config.mode = 'dry_run';
  assert.equal((await post('/test-email')).headers.location, `${ORIGIN}/?m=test_not_sent`);
  const home = await H.request(P.publicPort, { path: '/?m=test_not_sent', headers: { Cookie: cookie } });
  assert.match(home.body, /dry_run mode, so it won&#39;t actually be sent/);
  const junk = await H.request(P.publicPort, { path: '/?m=<script>alert(1)</script>', headers: { Cookie: cookie } });
  assert.ok(!junk.body.includes('<script>'), 'flash keys are looked up, never echoed');
  const threads = await H.request(P.publicPort, { path: '/threads', headers: { Cookie: cookie } });
  assert.match(threads.body, /Intro &lt;b&gt;/);
  const out = await post('/logout');
  assert.equal(out.headers.location, `${ORIGIN}/login`);
  assert.ok(out.headers['set-cookie'].some((c) => c.startsWith('__Host-sarah_session=;') && /Max-Age=0/.test(c)));
  assert.equal((await H.request(P.publicPort, { path: '/', headers: { Cookie: cookie } })).status, 302, 'the session is gone server-side');
});

test('admin page: only alert_address / portal_admins; for anyone else it does not exist', async () => {
  const { cookie } = await H.signIn(P);
  const no = await H.request(P.publicPort, { path: '/admin', headers: { Cookie: cookie } });
  assert.equal(no.status, 404);
  assert.ok(!/href="\/admin"/.test((await H.request(P.publicPort, { path: '/', headers: { Cookie: cookie } })).body));
  P.db._s.config.portal_admins = ['brad@bluzonebio.com'];
  const yes = await H.request(P.publicPort, { path: '/admin', headers: { Cookie: cookie } });
  assert.equal(yes.status, 200);
  assert.match(yes.body, /Brad Lee/);
  assert.match(yes.body, /not connected/);
});

test('an offboarded employee (enrolled = false) loses the session', async () => {
  const { cookie } = await H.signIn(P);
  P.db._s.employees.get(2).enrolled = false;
  assert.equal((await H.request(P.publicPort, { path: '/', headers: { Cookie: cookie } })).headers.location, `${ORIGIN}/login`);
});

test('/login and /auth/callback are rate-limited per socket address; the error page stays generic', async () => {
  await P.app.close();
  P = await H.startPortal({ config: H.testConfig({ PORTAL_RATE_LIMIT_MAX: '3' }) });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await H.request(P.publicPort, { path: '/login', headers: { 'X-Forwarded-For': `10.0.0.${i}` } })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429], 'X-Forwarded-For does not buy a fresh bucket');
  const cb = [];
  for (let i = 0; i < 4; i++) cb.push((await H.request(P.publicPort, { path: '/auth/callback?code=x&state=y' })).status);
  assert.deepEqual(cb, [302, 302, 302, 429]);
  const limited = await H.request(P.publicPort, { path: '/login' });
  assert.match(limited.body, /Sign-in didn&#39;t work/);
  // signed-in pages are not limited by this
  assert.equal((await H.request(P.publicPort, { path: '/static/portal.css' })).status, 200);
});

test('a real browser form post (Origin: null, because of Referrer-Policy: no-referrer) works', async () => {
  // POST /login from the sign-in page, as a browser sends it
  const start = await H.request(P.publicPort, { method: 'POST', path: '/login', ...H.form({}, { Origin: 'null' }) });
  assert.equal(start.status, 302);
  assert.ok(start.headers.location.startsWith('https://login.microsoftonline.com/'));
  // a signed-in form post with Origin: null still needs (and passes with) the CSRF token
  const { cookie } = await H.signIn(P);
  const csrf = await H.csrfFor(P, cookie);
  const ok = await H.request(P.publicPort, { method: 'POST', path: '/pause', ...H.form({ csrf, action: 'pause' }, { Cookie: cookie, Origin: 'null' }) });
  assert.equal(ok.headers.location, `${ORIGIN}/?m=paused`);
  const forged = await H.request(P.publicPort, { method: 'POST', path: '/pause', ...H.form({ action: 'resume' }, { Cookie: cookie, Origin: 'null' }) });
  assert.equal(forged.status, 403, 'no CSRF token, no change');
  // a real foreign origin is refused, and logged
  const evil = await H.request(P.publicPort, { method: 'POST', path: '/login', ...H.form({}, { Origin: 'https://evil.example' }) });
  assert.equal(evil.status, 403);
  assert.ok(P.logger.lines.some((l) => l.event === 'post_refused' && l.reason === 'foreign_origin'));
});
