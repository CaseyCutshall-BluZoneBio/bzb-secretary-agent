'use strict';
// Pure modules: config, encryption, timezones, settings, identity, error
// classification, log scrubbing, key rotation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError } = require('../src/config');
const { createKeyRing, tokenAad, createSealer, safeEqual } = require('../src/crypto');
const { toIana, isValidIana, WINDOWS_TO_IANA } = require('../src/tz');
const { validateSettings, prefillFromMailboxSettings } = require('../src/settings');
const { checkIdentity } = require('../src/identity');
const { classifyMsalError } = require('../src/tokens');
const { scrub } = require('../src/log');
const { rotate } = require('../bin/rotate-keys');
const H = require('./helpers');

// ---------------------------------------------------------------------------
test('config: base URL must be an HTTPS origin; the redirect URI is derived from it', () => {
  const c = H.testConfig();
  assert.equal(c.origin, 'https://bzb-ai-1.tail9f1964.ts.net:8443');
  assert.equal(c.redirectUri, 'https://bzb-ai-1.tail9f1964.ts.net:8443/auth/callback');
  assert.equal(c.authority, `https://login.microsoftonline.com/${H.TENANT}`);
  assert.throws(() => H.testConfig({ PORTAL_BASE_URL: 'http://bzb-ai-1.tail9f1964.ts.net:8443' }), /must be https/);
  assert.throws(() => H.testConfig({ PORTAL_BASE_URL: 'https://bzb-ai-1.tail9f1964.ts.net:8443/portal' }), /origin only/);
  assert.throws(() => H.testConfig({ PORTAL_BASE_URL: 'http://localhost:3000' }), /must be https/);
  assert.equal(H.testConfig({ PORTAL_BASE_URL: 'http://localhost:3000', PORTAL_ALLOW_INSECURE_LOCALHOST: '1' }).origin, 'http://localhost:3000');
  assert.throws(() => H.testConfig({ ENTRA_TENANT_ID: 'bluzonebio.com' }), /tenant GUID/);
  assert.throws(() => H.testConfig({ PORTAL_BROKER_KEY: 'short' }), /at least 32/);
  assert.throws(() => loadConfig({}), ConfigError);
});

// ---------------------------------------------------------------------------
test('encryption: AES-256-GCM round trip; bound to the employee; tamper and unknown keys fail', () => {
  const ring = createKeyRing(`k1:${H.KEY1}`);
  const enc = ring.encrypt('{"refresh_token":"secret"}', tokenAad(2));
  assert.equal(enc.key_id, 'k1');
  assert.ok(!Buffer.from(enc.ciphertext, 'base64').toString('utf8').includes('secret'));
  assert.equal(ring.decrypt(enc, tokenAad(2)), '{"refresh_token":"secret"}');
  assert.notEqual(ring.encrypt('x', tokenAad(2)).iv, ring.encrypt('x', tokenAad(2)).iv, 'fresh IV every time');
  assert.throws(() => ring.decrypt(enc, tokenAad(3)), 'a row copied to another employee does not decrypt');
  const flipped = Buffer.from(enc.ciphertext, 'base64'); flipped[0] ^= 1;
  assert.throws(() => ring.decrypt({ ...enc, ciphertext: flipped.toString('base64') }, tokenAad(2)));
  assert.throws(() => ring.decrypt({ ...enc, tag: Buffer.alloc(16).toString('base64') }, tokenAad(2)));
  assert.throws(() => createKeyRing(`k2:${H.KEY2}`).decrypt(enc, tokenAad(2)), /no key k1/);
  assert.throws(() => createKeyRing('k1:dG9vc2hvcnQ='), /32 bytes/);
  assert.throws(() => createKeyRing(`k1:${H.KEY1},k1:${H.KEY2}`), /duplicate/);
});

test('key rotation: everything is re-encrypted with the new key; the old key can then go', async () => {
  const db = H.fakeDb({ employees: [H.employeeRow({ id: 2 }), H.employeeRow({ id: 3, upn: 'c@bluzonebio.com', aad_object_id: 'x' })] });
  const old = createKeyRing(`k1:${H.KEY1}`);
  await db.tokenPut(2, { home_account_id: 'h2', ...old.encrypt('cache-2', tokenAad(2)) });
  await db.tokenPut(3, { home_account_id: 'h3', ...old.encrypt('cache-3', tokenAad(3)) });
  const both = createKeyRing(`k2:${H.KEY2},k1:${H.KEY1}`);
  assert.deepEqual(await rotate({ db, keyRing: both }), { rotated: 2, already_current: 0, failed: [] });
  const onlyNew = createKeyRing(`k2:${H.KEY2}`);
  assert.equal(onlyNew.decrypt(await db.tokenGet(2), tokenAad(2)), 'cache-2');
  assert.equal((await db.tokenGet(3)).home_account_id, 'h3');
  assert.deepEqual(await rotate({ db, keyRing: both }), { rotated: 0, already_current: 2, failed: [] });
});

test('sealed sign-in state: round trip, tamper-proof, secret-bound', () => {
  const s = createSealer(Buffer.alloc(32, 7));
  const v = s.seal({ s: 'state', v: 'verifier' });
  assert.deepEqual(s.unseal(v), { s: 'state', v: 'verifier' });
  assert.ok(!Buffer.from(v, 'base64url').toString('utf8').includes('verifier'), 'the PKCE verifier is encrypted, not just signed');
  assert.equal(s.unseal(`${v.slice(0, -2)}AA`), null);
  assert.equal(createSealer(Buffer.alloc(32, 8)).unseal(v), null);
  assert.equal(s.unseal('garbage'), null);
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', undefined));
});

// ---------------------------------------------------------------------------
test('timezones: Windows names from Outlook become IANA names', () => {
  assert.equal(toIana('Eastern Standard Time'), 'America/New_York');
  assert.equal(toIana('Pacific Standard Time'), 'America/Los_Angeles');
  assert.equal(toIana('US Mountain Standard Time'), 'America/Phoenix');
  assert.equal(toIana('GMT Standard Time'), 'Europe/London');
  assert.equal(toIana('India Standard Time'), 'Asia/Kolkata');
  assert.equal(toIana('eastern standard time'), 'America/New_York', 'case-insensitive');
  assert.equal(toIana('America/Chicago'), 'America/Chicago', 'already IANA');
  assert.equal(toIana('UTC'), 'Etc/UTC');
  assert.equal(toIana('Customized Time Zone'), null);
  assert.equal(toIana(''), null);
  assert.equal(toIana('Mars/Olympus_Mons'), null);
  for (const [win, iana] of Object.entries(WINDOWS_TO_IANA)) assert.ok(isValidIana(iana), `${win} → ${iana} is a zone this Node knows`);
});

// ---------------------------------------------------------------------------
const goodForm = (over = {}) => ({
  first_name: 'Brad', timezone: 'America/Chicago', mon_on: 'on', mon_start: '08:00', mon_end: '16:00', wed_on: 'on', wed_start: '10:00', wed_end: '18:00',
  preferred_start: '09:00', preferred_end: '15:00', default_duration_min: '45', default_location: 'in_person', office_address: '1 Main St',
  hard_gap_min: '10', preferred_gap_min: '30', in_person_buffer_min: '20', max_meetings_per_day: '5', min_notice_hours: '12',
  search_window_days: '14', offers_per_round: '3', bcc_after_intro: 'on', ...over,
});

test('settings: a valid form becomes exactly what portal_save_settings expects', () => {
  const v = validateSettings(goodForm());
  assert.deepEqual(v.errors, {});
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.working_hours, { mon: ['08:00', '16:00'], tue: null, wed: ['10:00', '18:00'], thu: null, fri: null, sat: null, sun: null });
  assert.equal(v.value.default_duration_min, 45);
  assert.equal(v.value.bcc_after_intro, true);
  assert.equal(validateSettings(goodForm({ bcc_after_intro: undefined })).value.bcc_after_intro, false);
});

test('settings: every rule the database enforces is caught first, with a readable message', () => {
  const bad = (over) => validateSettings(goodForm(over)).errors;
  assert.ok(bad({ timezone: 'Eastern Standard Time' }).timezone, 'IANA only');
  assert.ok(bad({ timezone: 'Not/AZone' }).timezone);
  assert.ok(bad({ mon_end: '07:00' }).mon_hours, 'end before start');
  assert.ok(bad({ mon_start: '9am' }).mon_hours);
  assert.ok(bad({ mon_on: undefined, wed_on: undefined }).working_hours, 'at least one day');
  assert.ok(bad({ preferred_end: '08:00' }).preferred_hours);
  assert.ok(bad({ default_duration_min: '5' }).default_duration_min);
  assert.ok(bad({ default_duration_min: '300' }).default_duration_min);
  assert.ok(bad({ default_duration_min: '30.5' }).default_duration_min, 'whole numbers');
  assert.ok(bad({ preferred_gap_min: '5' }).preferred_gap_min, 'preferred gap ≥ minimum gap');
  assert.ok(bad({ offers_per_round: '9' }).offers_per_round);
  assert.ok(bad({ search_window_days: '0' }).search_window_days);
  assert.ok(bad({ default_location: 'zoom' }).default_location);
  assert.ok(bad({ first_name: '' }).first_name);
  assert.ok(bad({ first_name: '<script>' }).first_name);
  assert.ok(bad({ office_address: 'x'.repeat(201) }).office_address);
  assert.match(bad({ max_meetings_per_day: '0' }).max_meetings_per_day, /from 1 to 20/);
});

test('settings prefill: Outlook working hours + Windows timezone → Sarah settings', () => {
  const p = prefillFromMailboxSettings({ timeZone: 'Eastern Standard Time',
    workingHours: { daysOfWeek: ['monday', 'tuesday', 'friday'], startTime: '08:30:00.0000000', endTime: '17:00:00.0000000', timeZone: { name: 'Pacific Standard Time' } } });
  assert.equal(p.timezone, 'America/Los_Angeles', 'the working-hours timezone wins');
  assert.deepEqual(p.working_hours, { mon: ['08:30', '17:00'], tue: ['08:30', '17:00'], wed: null, thu: null, fri: ['08:30', '17:00'], sat: null, sun: null });
  assert.deepEqual(prefillFromMailboxSettings({ timeZone: 'Customized Time Zone', workingHours: {} }), null);
  assert.deepEqual(prefillFromMailboxSettings({ timeZone: 'GMT Standard Time' }), { timezone: 'Europe/London' });
  assert.equal(prefillFromMailboxSettings(null), null);
});

// ---------------------------------------------------------------------------
test('identity: BZB members only. Other tenants, guests and outside domains are rejected', () => {
  const opts = { tenantId: H.TENANT, internalDomains: ['bluzonebio.com'] };
  const ok = checkIdentity(H.authResult(), H.ME, opts);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.profile, { aad_object_id: H.OID, upn: 'brad@bluzonebio.com', mail: 'brad@bluzonebio.com', display_name: 'Brad Lee', first_name: 'Brad' });
  assert.equal(checkIdentity(H.authResult({ tid: H.OTHER_TENANT, homeTenant: H.OTHER_TENANT }), H.ME, opts).reason, 'other_tenant');
  // A B2B guest: token from BZB's tenant, but their home tenant is elsewhere
  assert.equal(checkIdentity(H.authResult({ homeTenant: H.OTHER_TENANT }), H.ME, opts).reason, 'guest_home_tenant');
  assert.equal(checkIdentity(H.authResult(), { ...H.ME, userType: 'Guest' }, opts).reason, 'not_member');
  assert.equal(checkIdentity(H.authResult(), { ...H.ME, userPrincipalName: 'dana_acme.com#EXT#@bluzonebio.onmicrosoft.com' }, opts).reason, 'guest_upn');
  assert.equal(checkIdentity(H.authResult(), { ...H.ME, mail: 'brad@gmail.com' }, opts).reason, 'not_internal_domain');
  assert.equal(checkIdentity(H.authResult(), { ...H.ME, id: 'someone-else' }, opts).reason, 'graph_profile_mismatch');
  assert.equal(checkIdentity({ ...H.authResult(), idTokenClaims: { tid: H.TENANT, oid: 'other' } }, H.ME, opts).reason, 'oid_mismatch');
  // UPN and mail can differ; mail is kept for matching
  assert.equal(checkIdentity(H.authResult(), { ...H.ME, mail: 'Brad.Lee@bluzonebio.com' }, opts).profile.mail, 'brad.lee@bluzonebio.com');
});

// ---------------------------------------------------------------------------
test('MSAL errors: reconnect vs account gone vs our own misconfiguration vs transient', () => {
  const e = (props, name = 'AuthError') => Object.assign(Object.create({ constructor: { name } }), { name, ...props });
  assert.deepEqual(classifyMsalError(e({ errorCode: 'invalid_grant', errorNo: '700082' }, 'InteractionRequiredAuthError')),
    { kind: 'reconnect', code: 'AADSTS700082', notifyEmployee: true });
  assert.equal(classifyMsalError(e({ errorCode: 'invalid_grant', errorNo: '50173' })).kind, 'reconnect');
  assert.equal(classifyMsalError(e({ errorCode: 'consent_required' })).kind, 'reconnect');
  assert.equal(classifyMsalError(e({ errorCode: 'invalid_grant', errorMessage: 'AADSTS65001: The user has not consented' })).code, 'AADSTS65001');
  // account disabled / deleted: reconnect, but don't email a dead mailbox
  assert.deepEqual(classifyMsalError(e({ errorCode: 'invalid_grant', errorNo: '50057' })), { kind: 'reconnect', code: 'AADSTS50057', notifyEmployee: false });
  // our secret expired: never blame (or email) the employees
  assert.deepEqual(classifyMsalError(e({ errorCode: 'invalid_client', errorNo: '7000222' })), { kind: 'unavailable', code: 'AADSTS7000222', appProblem: true });
  assert.equal(classifyMsalError(e({ errorCode: 'invalid_grant', errorNo: '7000215' }, 'InteractionRequiredAuthError')).kind, 'unavailable');
  assert.equal(classifyMsalError(e({ errorCode: 'network_error' })).kind, 'unavailable');
  assert.equal(classifyMsalError(new Error('socket hang up')).kind, 'unavailable');
});

test('logs never carry tokens, codes, cookies or keys', () => {
  const s = scrub({ access_token: 'x', refresh_token: 'y', code: 'z', cookie: 'c', broker_key: 'k', error_code: 'AADSTS50057',
                    message: 'got eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc in reply', employee_id: 2 });
  assert.equal(s.access_token, '[redacted]');
  assert.equal(s.refresh_token, '[redacted]');
  assert.equal(s.code, '[redacted]');
  assert.equal(s.cookie, '[redacted]');
  assert.equal(s.broker_key, '[redacted]');
  assert.equal(s.error_code, 'AADSTS50057');
  assert.equal(s.employee_id, 2);
  assert.ok(!s.message.includes('eyJ'));
});
