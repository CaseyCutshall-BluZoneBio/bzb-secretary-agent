'use strict';
// Test doubles: an in-memory stand-in for the sched.portal_* functions, a fake
// MSAL client, a fake Graph, and a raw HTTP client (so tests can send spoofed
// Host / X-Forwarded-* headers, which fetch() refuses to set).
const http = require('http');
const crypto = require('crypto');
const { loadConfig } = require('../src/config');
const { createKeyRing } = require('../src/crypto');
const { createTokenService } = require('../src/tokens');
const { build } = require('../src/server');

const TENANT = '11111111-2222-3333-4444-555555555555';
const OTHER_TENANT = '99999999-8888-7777-6666-555555555555';
const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const KEY1 = crypto.randomBytes(32).toString('base64');
const KEY2 = crypto.randomBytes(32).toString('base64');

function testConfig(over = {}) {
  return loadConfig({
    PORTAL_BASE_URL: 'https://bzb-ai-1.tail9f1964.ts.net:8443',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: 'client-id', ENTRA_CLIENT_SECRET: 'client-secret',
    PORTAL_TOKEN_KEYS: `k1:${KEY1}`, PORTAL_SESSION_SECRET: crypto.randomBytes(32).toString('base64'),
    PORTAL_BROKER_KEY: 'broker-key-0123456789-0123456789-abcdef', PORTAL_PORT: '1', PORTAL_BROKER_PORT: '1',
    PORTAL_LISTEN_HOST: '127.0.0.1', PORTAL_BROKER_HOST: '127.0.0.1', ...over,
  });
}

function employeeRow(over = {}) {
  return {
    id: 2, upn: 'brad@bluzonebio.com', mail: 'brad@bluzonebio.com', aad_object_id: OID, display_name: 'Brad Lee', first_name: 'Brad',
    timezone: 'America/New_York', working_hours: { mon: ['09:00', '17:00'], tue: ['09:00', '17:00'], wed: ['09:00', '17:00'], thu: ['09:00', '17:00'], fri: ['09:00', '17:00'], sat: null, sun: null },
    preferred_start: '09:30', preferred_end: '16:00', default_duration_min: 30, default_location: 'teams', office_address: null,
    hard_gap_min: 5, preferred_gap_min: 30, in_person_buffer_min: 30, max_meetings_per_day: 6, min_notice_hours: 24,
    search_window_days: 10, offers_per_round: 3, bcc_after_intro: true, enrolled: true, calendar_auth: 'delegated',
    calendar_connected_at: null, paused: false, needs_reconnect: false, reconnect_reason: null, settings_saved_at: null,
    ...over,
  };
}

function fakeDb({ employees = [], config = {} } = {}) {
  const S = {
    employees: new Map(employees.map((e) => [e.id, { ...e }])),
    tokens: new Map(), sessions: new Map(), calls: [],
    config: { mode: 'live', internal_domains: ['bluzonebio.com'], alert_address: 'casey@bluzonebio.com', portal_admins: [],
              sarah_upn: 'sarah.johnson@bluzonebio.com', ...config },
  };
  const rec = (name, ...args) => S.calls.push([name, ...args]);
  const db = {
    _s: S,
    config: async () => S.config,
    signIn: async (p) => {
      rec('signIn', p);
      let e = [...S.employees.values()].find((x) => x.aad_object_id === p.aad_object_id || x.upn === p.upn);
      if (!e) { e = employeeRow({ id: S.employees.size + 10, ...p }); S.employees.set(e.id, e); }
      e.aad_object_id = p.aad_object_id;
      return { ...e };
    },
    employee: async (id) => (S.employees.has(id) ? { ...S.employees.get(id) } : null),
    employeeByUpn: async (upn) => {
      const e = [...S.employees.values()].find((x) => x.upn === upn);
      return e ? { id: e.id, upn: e.upn, enrolled: e.enrolled, calendar_auth: e.calendar_auth, connected: !!e.calendar_connected_at, needs_reconnect: e.needs_reconnect } : null;
    },
    connected: async (id, prefill) => {
      rec('connected', id, prefill);
      const e = S.employees.get(id);
      Object.assign(e, { calendar_auth: 'delegated', calendar_connected_at: new Date().toISOString(), needs_reconnect: false });
      if (prefill && !e.settings_saved_at) Object.assign(e, prefill);
      return { ...e };
    },
    saveSettings: async (id, v) => { rec('saveSettings', id, v); Object.assign(S.employees.get(id), v, { settings_saved_at: 'now' }); return {}; },
    setPaused: async (id, p) => { rec('setPaused', id, p); S.employees.get(id).paused = p; return {}; },
    tokenGet: async (id) => (S.tokens.has(id) ? { ...S.tokens.get(id) } : null),
    tokenPut: async (id, r) => { rec('tokenPut', id); S.tokens.set(id, { ...r }); },
    tokenIds: async () => [...S.tokens.keys()],
    keepaliveList: async () => [...S.employees.values()].filter((e) => e.calendar_connected_at && !e.needs_reconnect && S.tokens.has(e.id)).map((e) => ({ id: e.id, upn: e.upn })),
    tokenOk: async (id) => { rec('tokenOk', id); if (S.employees.has(id)) S.employees.get(id).needs_reconnect = false; },
    markReconnect: async (id, code, notify) => {
      rec('markReconnect', id, code, notify);
      const e = S.employees.get(id);
      const already = !!e.needs_reconnect;
      e.needs_reconnect = true;
      return { ok: true, already };
    },
    queueTestMail: async (id) => { rec('queueTestMail', id); return { outbox_id: 1, mode: S.config.mode, status: ['live', 'shadow'].includes(S.config.mode) ? 'pending' : 'skipped' }; },
    myThreads: async (id) => [{ id: 7, state: 'PROPOSED', subject: 'Intro <b>', clients: 'dana@acme-bio.com', round_count: 1, updated_at: '2026-10-05T14:00:00Z', reason: null, _for: id }],
    overview: async () => [...S.employees.values()].map((e) => ({ ...e, connected: !!e.calendar_connected_at, open_threads: 0 })),
    sessionCreate: async (hash, id, csrf, ttl) => { rec('sessionCreate', id, ttl); S.sessions.set(hash, { id, csrf }); },
    sessionGet: async (hash) => {
      const s = S.sessions.get(hash);
      return s ? { csrf: s.csrf, employee: { ...S.employees.get(s.id) } } : null;
    },
    sessionDelete: async (hash) => { rec('sessionDelete'); S.sessions.delete(hash); },
  };
  return db;
}

// A fake ConfidentialClientApplication. `msal` holds the scenario.
function fakeMsal(scenario = {}) {
  const M = {
    authUrlRequests: [], codeRequests: [], silentRequests: [], created: 0,
    codeResult: null,        // AuthenticationResult returned by acquireTokenByCode (or an Error to throw)
    silent: () => ({ accessToken: 'AT-fresh' }),   // per call; may throw
    cacheJson: '{"fake":"msal-cache"}',
    ...scenario,
  };
  M.factory = (plugin) => {
    M.created += 1;
    let loaded = null;
    const tokenCache = {
      deserialize: (s) => { loaded = s; },
      serialize: () => M.cacheJson,
    };
    return {
      getAuthCodeUrl: async (req) => {
        M.authUrlRequests.push(req);
        return `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?client_id=client-id&state=${encodeURIComponent(req.state)}`;
      },
      acquireTokenByCode: async (req) => {
        M.codeRequests.push(req);
        if (M.codeResult instanceof Error) throw M.codeResult;
        return M.codeResult;
      },
      getTokenCache: () => ({
        serialize: () => M.cacheJson,
        getAccountByHomeId: async (homeId) => {
          if (plugin) await plugin.beforeCacheAccess({ tokenCache });
          return loaded && JSON.parse(loaded).account !== false ? { homeAccountId: homeId } : null;
        },
      }),
      acquireTokenSilent: async (req) => {
        M.silentRequests.push(req);
        if (plugin) await plugin.beforeCacheAccess({ tokenCache });
        const r = M.silent(req);
        if (plugin) await plugin.afterCacheAccess({ cacheHasChanged: true, tokenCache: { serialize: () => '{"fake":"refreshed-cache"}' } });
        return r;
      },
    };
  };
  return M;
}

// A successful auth-code result for BZB member Brad.
function authResult({ tid = TENANT, homeTenant = TENANT, oid = OID, scopes = ['User.Read', 'MailboxSettings.Read', 'Calendars.ReadWrite'] } = {}) {
  return {
    accessToken: 'AT-from-code', scopes,
    account: { homeAccountId: `${oid}.${homeTenant}`, tenantId: tid, username: 'brad@bluzonebio.com' },
    idTokenClaims: { tid, oid },
  };
}

function fakeGraph(routes = {}) {
  const G = { calls: [] };
  G.call = async (method, path, token, opts = {}) => {
    G.calls.push({ method, path, token, body: opts.body, headers: opts.headers });
    for (const [pattern, fn] of Object.entries(routes)) {
      const [m, re] = pattern.split(' ');
      if (m === method && new RegExp(re).test(path)) return typeof fn === 'function' ? fn({ method, path, token, opts, n: G.calls.length }) : fn;
    }
    return { status: 404, body: { error: { code: 'NotMocked', message: path } } };
  };
  return G;
}

const ME = { id: OID, userPrincipalName: 'brad@bluzonebio.com', mail: 'brad@bluzonebio.com', displayName: 'Brad Lee', givenName: 'Brad', userType: 'Member' };

function defaultGraph(over = {}) {
  return fakeGraph({
    'GET ^/me\\?': { status: 200, body: ME },
    'GET ^/me/mailboxSettings': { status: 200, body: { timeZone: 'Pacific Standard Time',
      workingHours: { daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday'], startTime: '08:00:00.0000000', endTime: '16:30:00.0000000', timeZone: { name: 'Pacific Standard Time' } } } },
    'GET ^/me/calendarView': { status: 200, body: { value: [] } },
    'POST ^/me/events$': ({ opts }) => ({ status: 201, body: { id: 'EV1', subject: opts.body.subject } }),
    'DELETE ^/me/events/': { status: 204, body: null },
    ...over,
  });
}

const silentLogger = () => {
  const lines = [];
  const add = (level) => (event, fields) => lines.push({ level, event, ...fields });
  return { lines, info: add('info'), warn: add('warn'), error: add('error') };
};

// Start both servers on ephemeral ports.
async function startPortal({ config = testConfig(), db = fakeDb({ employees: [employeeRow()] }), msal = fakeMsal(), graph = defaultGraph(), now } = {}) {
  const logger = silentLogger();
  const keyRing = createKeyRing(config.tokenKeys);
  const tokens = createTokenService({ db, keyRing, msalFactory: msal.factory, logger });
  const cfg = { ...config, publicPort: 0, brokerPort: 0 };
  const app = build({ config: cfg, db, tokens, graph, msalFactory: msal.factory, keyRing, logger, now });
  await app.listen();
  return { app, config: cfg, db, msal, graph, logger, keyRing, tokens,
           publicPort: app.publicServer.address().port, brokerPort: app.brokerServer.address().port };
}

// Raw request: any headers allowed (Host, X-Forwarded-*).
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const form = (obj, headers = {}) => ({ body: new URLSearchParams(obj).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });
const cookieValue = (res, name) => {
  const c = (res.headers['set-cookie'] || []).find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0].slice(name.length + 1) : null;
};

// Sign in as Brad through the real callback (fake MSAL + Graph). Returns the cookie header.
async function signIn(P) {
  P.msal.codeResult = authResult({ scopes: ['User.Read'] });
  const start = await request(P.publicPort, { method: 'POST', path: '/login', ...form({}) });
  const auth = cookieValue(start, '__Host-sarah_auth');
  const state = P.msal.authUrlRequests[P.msal.authUrlRequests.length - 1].state;
  const cb = await request(P.publicPort, { path: `/auth/callback?code=CODE&state=${encodeURIComponent(state)}`, headers: { Cookie: `__Host-sarah_auth=${auth}` } });
  const session = cookieValue(cb, '__Host-sarah_session');
  return { cookie: `__Host-sarah_session=${session}`, callback: cb };
}

async function csrfFor(P, cookie) {
  const home = await request(P.publicPort, { path: '/', headers: { Cookie: cookie } });
  return (home.body.match(/name="csrf" value="([^"]+)"/) || [])[1];
}

module.exports = {
  TENANT, OTHER_TENANT, OID, KEY1, KEY2, ME, testConfig, employeeRow, fakeDb, fakeMsal, authResult, fakeGraph, defaultGraph,
  silentLogger, startPortal, request, form, cookieValue, signIn, csrfFor,
};
