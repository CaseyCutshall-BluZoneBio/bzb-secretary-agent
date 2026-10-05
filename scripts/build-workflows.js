'use strict';
// Generates n8n/workflows/*.json from src/. Run `npm run build` after editing
// anything in src/ (logic or prompts). Never hand-edit the generated JSON.
//
// Six workflows, all with fixed IDs so they can reference each other and the
// four credentials (created from n8n/credentials.template.json):
//   Sarah · Poller     every minute: Graph delta on Sarah's Inbox → ingest → processor
//   Sarah · Processor  one email or timer event → decision → apply_plan → kick executor
//   Sarah · Executor   every minute + on demand: outbox → Graph (or the portal broker) → report
//   Sarah · Timers     every 15 min: housekeeping + follow-up / stall / reminder events
//   Sarah · Review     shadow-mode approve/reject page (tailnet only)
//   Sarah · Errors     error workflow for all of the above: email Casey
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { bundle } = require('./bundle');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'n8n', 'workflows');
const LIBS = {
  all: bundle(path.join(ROOT, 'src', 'index.js')),
  poller: bundle(path.join(ROOT, 'src', 'poller.js'), 'poller'),
  executor: bundle(path.join(ROOT, 'src', 'executor.js'), 'executor'),
};

const ID = {
  poller: 'SarahPoller00001',
  processor: 'SarahProcessor01',
  executor: 'SarahExecutor001',
  timers: 'SarahTimers00001',
  review: 'SarahReview00001',
  errors: 'SarahErrors00001',
};
const CRED = {
  postgres: { id: 'SchedPostgres001', name: 'Sarah · Postgres (sched_agent)' },
  graph: { id: 'SchedGraphApp001', name: 'Sarah · Microsoft Graph (app-only)' },
  litellm: { id: 'SchedLiteLLM0001', name: 'Sarah · LiteLLM key' },
  portal: { id: 'SchedPortalKey01', name: 'Sarah · Portal broker key' },
};

// Deterministic UUIDs so rebuilding without changes produces identical files.
function uuid(seed) {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// node builders
// ---------------------------------------------------------------------------
function node(wf, name, type, typeVersion, position, parameters, extra = {}) {
  return { parameters, id: uuid(`${wf}:${name}`), name, type, typeVersion, position, ...extra };
}

const pgCred = { postgres: { id: CRED.postgres.id, name: CRED.postgres.name } };
const graphCred = { oAuth2Api: { id: CRED.graph.id, name: CRED.graph.name } };
const llmCred = { httpHeaderAuth: { id: CRED.litellm.id, name: CRED.litellm.name } };
// The portal's token broker: a shared-secret header, on the compose network only.
const portalCred = { httpHeaderAuth: { id: CRED.portal.id, name: CRED.portal.name } };
const CREDS = { llm: llmCred, portal: portalCred, graph: graphCred };

function pg(wf, name, position, query, params, extra = {}) {
  const options = params ? { queryReplacement: `={{ ${params} }}` } : {};
  return node(wf, name, 'n8n-nodes-base.postgres', 2.6, position,
    { operation: 'executeQuery', query, options }, { credentials: pgCred, ...extra });
}

function code(wf, name, position, body, { perItem = true, withLib = true, lib = 'all' } = {}) {
  const jsCode = `${withLib ? `${LIBS[lib]}\n` : ''}// ---- node logic ----\n${body.trim()}\n`;
  return node(wf, name, 'n8n-nodes-base.code', 2, position,
    { mode: perItem ? 'runOnceForEachItem' : 'runOnceForAllItems', jsCode });
}

function ifNode(wf, name, position, leftExpr) {
  return node(wf, name, 'n8n-nodes-base.if', 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{
        id: uuid(`${wf}:${name}:cond`),
        leftValue: `={{ ${leftExpr} }}`,
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  });
}

const RESPONSE = { response: { response: { fullResponse: true, neverError: true } } };

function http(wf, name, position, { method, url, headers, body, cred, timeout = 30000 }) {
  const p = {
    method,
    url,
    authentication: 'genericCredentialType',
    genericAuthType: cred === 'graph' ? 'oAuth2Api' : 'httpHeaderAuth',
    sendHeaders: !!headers,
    options: { timeout, ...RESPONSE },
  };
  if (headers) {
    p.headerParameters = { parameters: headers.map(([n, v]) => ({ name: n, value: v })) };
  }
  if (body) {
    p.sendBody = true;
    p.contentType = 'json';
    p.specifyBody = 'json';
    p.jsonBody = `={{ ${body} }}`;
  }
  return node(wf, name, 'n8n-nodes-base.httpRequest', 4.2, position, p,
    { credentials: CREDS[cred], onError: 'continueRegularOutput' });
}

function execWf(wf, name, position, target, { wait = true, each = true, continueOnFail = false } = {}) {
  return node(wf, name, 'n8n-nodes-base.executeWorkflow', 1.2, position, {
    source: 'database',
    workflowId: { __rl: true, mode: 'id', value: ID[target] },
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [],
                      attemptToConvertTypes: false, convertFieldsToString: true },
    mode: each ? 'each' : 'once',
    options: { waitForSubWorkflow: wait },
  }, continueOnFail ? { onError: 'continueRegularOutput' } : {});
}

function schedule(wf, name, position, minutes) {
  return node(wf, name, 'n8n-nodes-base.scheduleTrigger', 1.2, position,
    { rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] } });
}

function subTrigger(wf, name, position) {
  return node(wf, name, 'n8n-nodes-base.executeWorkflowTrigger', 1.1, position, { inputSource: 'passthrough' });
}

// connections: [[from, to, fromOutput=0], ...]
function connect(pairs) {
  const c = {};
  for (const [from, to, out = 0] of pairs) {
    c[from] = c[from] || { main: [] };
    while (c[from].main.length <= out) c[from].main.push([]);
    c[from].main[out].push({ node: to, type: 'main', index: 0 });
  }
  return c;
}

function workflow(key, name, nodes, pairs, { errorWorkflow = true, description } = {}) {
  return {
    id: ID[key],
    name,
    active: false,
    isArchived: false,
    nodes,
    connections: connect(pairs),
    settings: {
      executionOrder: 'v1',
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
      saveManualExecutions: true,
      callerPolicy: 'workflowsFromSameOwner',
      ...(errorWorkflow ? { errorWorkflow: ID.errors } : {}),
    },
    pinData: {},
    meta: { templateCredsSetupCompleted: true, description },
    tags: [],
  };
}

// Shared snippet: unwrap an HTTP node result (fullResponse + neverError).
const HTTP_RESULT = `
function httpResult(x) {
  if (!x || x.v === 1) return null;                       // branch skipped: input is the state itself
  if (x.error) return { error: x.error };                 // network error (continueRegularOutput)
  if (x.statusCode !== undefined) {
    return x.statusCode >= 200 && x.statusCode < 300 ? x.body : { error: { status: x.statusCode, body: x.body } };
  }
  return x;
}`;

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------
function poller() {
  const W = 'poller';
  const nodes = [
    schedule(W, 'Every minute', [0, 300], 1),
    pg(W, 'Mode + lease', [220, 300],
      `SELECT CASE WHEN sched.setting_text('mode') IN ('dry_run', 'shadow', 'live')
            THEN sched.try_lease('poller', coalesce(sched.setting_int('poller_lease_seconds'), 90)) ELSE false END AS got,
       (SELECT jsonb_object_agg(key, value) FROM sched.settings WHERE key NOT LIKE 'lease:%') AS settings;`),
    ifNode(W, 'Run?', [440, 300], '$json.got === true'),
    code(W, 'Delta URL', [660, 300], `
return { json: { url: lib.poller.deltaUrl($json.settings), settings: $json.settings } };`, { lib: 'poller' }),
    http(W, 'Graph: inbox delta', [880, 300], {
      method: 'GET', url: '={{ $json.url }}', headers: [['Prefer', 'odata.maxpagesize=50']], cred: 'graph',
    }),
    code(W, 'Split', [1100, 300], `
const r = $json;
const settings = $('Delta URL').item.json.settings;
if (r.statusCode === 410) {
  // Delta token expired: resync from scratch (processing_start_at guards old mail).
  return { json: { ok: true, reset: true, cursor: null, ids: [], settings } };
}
if (r.error || r.statusCode < 200 || r.statusCode >= 300) {
  throw new Error('Graph delta failed: ' + lib.poller.describeGraphFailure(r));
}
const s = lib.poller.splitDelta(r.body);
return { json: { ok: true, cursor: s.cursor, ids: s.ids, more: s.more, settings } };`, { lib: 'poller' }),
    code(W, 'Fan out', [1320, 180], `
const out = [];
for (const item of $input.all()) {
  for (const id of item.json.ids) out.push({ json: { id, url: lib.poller.messageUrl(item.json.settings, id) } });
}
return out;`, { perItem: false, lib: 'poller' }),
    http(W, 'Graph: get message', [1540, 180], {
      method: 'GET', url: '={{ $json.url }}', headers: [['Prefer', 'outlook.body-content-type="text"']], cred: 'graph',
    }),
    code(W, 'Normalize', [1760, 180], `
const r = $json;
if (r.error || r.statusCode !== 200) {
  if (r.statusCode === 404) return { json: { skip: true } };          // deleted between delta and fetch
  throw new Error('Graph get message failed: ' + lib.poller.describeGraphFailure(r));
}
return { json: { msg: lib.poller.normalizeMessage(r.body) } };`, { lib: 'poller' }),
    pg(W, 'Ingest', [1980, 180],
      `SELECT sched.ingest_message($1::jsonb) AS r;`, `[ JSON.stringify($json.msg || {}) ]`),
    ifNode(W, 'Process?', [2200, 180], '$json.r.process === true'),
    code(W, 'Event', [2420, 180], `
return { json: { type: 'message', message_id: $json.r.id } };`, { withLib: false }),
    execWf(W, 'Run processor', [2640, 180], 'processor', { wait: true, each: true, continueOnFail: true }),
    pg(W, 'Save cursor', [1320, 440],
      `UPDATE sched.settings SET value = $1::jsonb WHERE key = 'poller_delta_link';`,
      `[ JSON.stringify($json.cursor) ]`, { executeOnce: true }),
    pg(W, 'Release lease', [1540, 440], `SELECT sched.release_lease('poller');`, null, { executeOnce: true }),
  ];
  const pairs = [
    ['Every minute', 'Mode + lease'], ['Mode + lease', 'Run?'], ['Run?', 'Delta URL'],
    ['Delta URL', 'Graph: inbox delta'], ['Graph: inbox delta', 'Split'],
    // v1 execution order: the top branch (processing) runs to completion before the cursor is saved
    ['Split', 'Fan out'], ['Split', 'Save cursor'],
    ['Fan out', 'Graph: get message'], ['Graph: get message', 'Normalize'], ['Normalize', 'Ingest'],
    ['Ingest', 'Process?'], ['Process?', 'Event'], ['Event', 'Run processor'],
    ['Save cursor', 'Release lease'],
  ];
  return workflow(W, 'Sarah · Poller', nodes, pairs,
    { description: 'Every minute: reads new mail in Sarah\'s Inbox via Graph delta, stores each email once, hands new ones to the processor.' });
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------
function processor() {
  const W = 'processor';
  const nodes = [
    subTrigger(W, 'Event in', [0, 300]),
    pg(W, 'Load context', [220, 300], `SELECT sched.load_context($1::jsonb) AS ctx;`, `[ JSON.stringify($json) ]`),
    code(W, '1 · Route', [440, 300], `
return { json: lib.decide.start($json.ctx) };`),
    ifNode(W, 'Classify?', [660, 300], '$json.llm != null'),
    http(W, 'LLM: classify', [880, 180], {
      method: 'POST', url: '={{ $json.llm.url }}', body: 'JSON.stringify($json.llm.body)', cred: 'llm', timeout: 180000,
    }),
    code(W, '2 · Interpret', [1100, 300], `${HTTP_RESULT}
const S = $('1 · Route').item.json;
return { json: lib.decide.interpret(S, httpResult($json)) };`),
    ifNode(W, 'Calendar?', [1320, 300], '$json.calendar != null'),
    // Delegated employees: the portal's broker reads the calendar with their own
    // token (never seen here). Everyone else: app-only Graph, as before.
    ifNode(W, 'Delegated calendar?', [1540, 180], "$json.calendar.via === 'broker'"),
    http(W, 'Portal: calendar', [1760, 60], {
      method: 'POST', url: '={{ $json.calendar.url }}', body: 'JSON.stringify($json.calendar.body)', cred: 'portal',
    }),
    http(W, 'Graph: calendar', [1760, 240], {
      method: 'GET', url: '={{ $json.calendar.url }}', headers: [['Prefer', '={{ $json.calendar.prefer }}']], cred: 'graph',
    }),
    code(W, '3 · Act', [1980, 300], `${HTTP_RESULT}
const S = $('2 · Interpret').item.json;
return { json: lib.decide.act(S, httpResult($json)) };`),
    ifNode(W, 'Draft?', [2200, 300], '$json.llm != null'),
    http(W, 'LLM: draft', [2420, 180], {
      method: 'POST', url: '={{ $json.llm.url }}', body: 'JSON.stringify($json.llm.body)', cred: 'llm', timeout: 180000,
    }),
    code(W, '4 · Finish', [2640, 300], `${HTTP_RESULT}
const S = $('3 · Act').item.json;
return { json: lib.decide.finish(S, httpResult($json)) };`),
    ifNode(W, 'Plan?', [2860, 300], '$json.plan != null'),
    pg(W, 'Apply plan', [3080, 300], `SELECT sched.apply_plan($1::jsonb) AS result;`, `[ JSON.stringify($json.plan) ]`),
    execWf(W, 'Kick executor', [3300, 300], 'executor', { wait: false, each: false }),
  ];
  const pairs = [
    ['Event in', 'Load context'], ['Load context', '1 · Route'], ['1 · Route', 'Classify?'],
    ['Classify?', 'LLM: classify', 0], ['Classify?', '2 · Interpret', 1], ['LLM: classify', '2 · Interpret'],
    ['2 · Interpret', 'Calendar?'],
    ['Calendar?', 'Delegated calendar?', 0], ['Calendar?', '3 · Act', 1],
    ['Delegated calendar?', 'Portal: calendar', 0], ['Delegated calendar?', 'Graph: calendar', 1],
    ['Portal: calendar', '3 · Act'], ['Graph: calendar', '3 · Act'],
    ['3 · Act', 'Draft?'],
    ['Draft?', 'LLM: draft', 0], ['Draft?', '4 · Finish', 1], ['LLM: draft', '4 · Finish'],
    ['4 · Finish', 'Plan?'], ['Plan?', 'Apply plan', 0], ['Apply plan', 'Kick executor'],
  ];
  return workflow(W, 'Sarah · Processor', nodes, pairs,
    { description: 'One inbound email or timer event → route → classify (LLM) → calendar → decide → draft (LLM) → apply_plan.' });
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
function executor() {
  const W = 'executor';
  const nodes = [
    schedule(W, 'Every minute', [0, 200], 1),
    subTrigger(W, 'Kicked', [0, 420]),
    pg(W, 'Claim', [220, 300], `SELECT item FROM sched.outbox_claim(10) AS item;`, null, { executeOnce: true }),
    code(W, 'Build request', [440, 300], `
const item = $json.item;
return { json: { item, req: lib.executor.firstRequest(item) } };`, { lib: 'executor' }),
    ifNode(W, 'Call Graph?', [660, 300], '$json.req != null'),
    // Calendar work for a delegated employee goes to the portal's broker, which
    // calls Graph with that employee's token. Always a POST with a JSON body.
    ifNode(W, 'Via broker?', [880, 180], '$json.req.broker === true'),
    http(W, 'Portal: calendar call', [1100, -60], {
      method: 'POST', url: '={{ $json.req.url }}', body: 'JSON.stringify($json.req.body)', cred: 'portal',
    }),
    // Two nodes on purpose: n8n ignores an expression in "Send Body", so a
    // single dynamic node would POST with an empty body.
    ifNode(W, 'With body?', [1100, 180], '$json.req.body != null'),
    http(W, 'Graph: POST with body', [1320, 60], {
      method: 'POST', url: '={{ $json.req.url }}', body: 'JSON.stringify($json.req.body)', cred: 'graph',
    }),
    http(W, 'Graph: call without body', [1320, 240], {
      method: '={{ $json.req.method }}', url: '={{ $json.req.url }}', cred: 'graph',
    }),
    code(W, 'After call', [1540, 300], `
const b = $('Build request').item.json;
const resp = $json.item && $json.req !== undefined ? null : $json;   // IF false branch passes the build output
return { json: { item: b.item, ...lib.executor.afterFirst(b.item, resp) } };`, { lib: 'executor' }),
    ifNode(W, 'Send draft?', [1760, 300], '$json.next != null'),
    http(W, 'Graph: send', [1980, 180], { method: 'POST', url: '={{ $json.next.url }}', cred: 'graph' }),
    code(W, 'After send', [2200, 180], `
const a = $('After call').item.json;
return { json: { report: lib.executor.afterSecond(a.item, a, $json) } };`, { lib: 'executor' }),
    pg(W, 'Report', [2420, 300], `SELECT sched.outbox_report($1::jsonb) AS r;`, `[ JSON.stringify($json.report) ]`),
  ];
  const pairs = [
    ['Every minute', 'Claim'], ['Kicked', 'Claim'], ['Claim', 'Build request'], ['Build request', 'Call Graph?'],
    ['Call Graph?', 'Via broker?', 0], ['Call Graph?', 'After call', 1],
    ['Via broker?', 'Portal: calendar call', 0], ['Via broker?', 'With body?', 1], ['Portal: calendar call', 'After call'],
    ['With body?', 'Graph: POST with body', 0], ['With body?', 'Graph: call without body', 1],
    ['Graph: POST with body', 'After call'], ['Graph: call without body', 'After call'],
    ['After call', 'Send draft?'], ['Send draft?', 'Graph: send', 0], ['Send draft?', 'Report', 1],
    ['Graph: send', 'After send'], ['After send', 'Report'],
  ];
  return workflow(W, 'Sarah · Executor', nodes, pairs,
    { description: 'Every minute and on demand: claims ready outbox items (per run mode), calls Graph, reports results back.' });
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------
function timers() {
  const W = 'timers';
  const nodes = [
    schedule(W, 'Every 15 minutes', [0, 300], 15),
    pg(W, 'Timer events', [220, 300], `SELECT ev FROM sched.timer_events() AS ev;`),
    code(W, 'Unwrap', [440, 300], `return { json: $json.ev };`, { withLib: false }),
    execWf(W, 'Run processor', [660, 300], 'processor', { wait: true, each: true, continueOnFail: true }),
    execWf(W, 'Kick executor', [880, 300], 'executor', { wait: false, each: false }),
  ];
  const pairs = [['Every 15 minutes', 'Timer events'], ['Timer events', 'Unwrap'], ['Unwrap', 'Run processor'],
                 ['Run processor', 'Kick executor']];
  return workflow(W, 'Sarah · Timers', nodes, pairs,
    { description: 'Every 15 minutes: stuck-email sweeper, hold release, then follow-up / stall / reminder events through the processor.' });
}

// ---------------------------------------------------------------------------
// Review (shadow mode)
// ---------------------------------------------------------------------------
function review() {
  const W = 'review';
  const page = (title, bodyExpr) => `\`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sarah review</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#11111F}h1{font-size:20px}button{font-size:16px;padding:10px 20px;border:0;border-radius:6px;background:#11111F;color:#fff;cursor:pointer}.reject{background:#a33}</style>
</head><body><h1>${title}</h1>\${${bodyExpr}}</body></html>\``;
  const nodes = [
    node(W, 'Link opened (GET)', 'n8n-nodes-base.webhook', 2, [0, 200],
      { httpMethod: 'GET', path: 'sched-review', responseMode: 'responseNode', options: {} },
      { webhookId: uuid('review-get') }),
    code(W, 'Confirm page', [220, 200], `
const q = $json.query || {};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const approve = q.a === 'approve';
// A link scanner that fetches this page does nothing: only the POST below acts.
const form = \`<p>\${approve ? 'Approve' : 'Reject'} outbox item #\${esc(q.id)}?</p>
<form method="post"><input type="hidden" name="id" value="\${esc(q.id)}"><input type="hidden" name="t" value="\${esc(q.t)}">
<input type="hidden" name="a" value="\${approve ? 'approve' : 'reject'}">
<button class="\${approve ? '' : 'reject'}" type="submit">\${approve ? 'Approve and send' : 'Reject'}</button></form>\`;
return { json: { html: ${page('Sarah · shadow review', 'form')} } };`, { withLib: false }),
    node(W, 'Show confirm page', 'n8n-nodes-base.respondToWebhook', 1.1, [440, 200],
      { respondWith: 'text', responseBody: '={{ $json.html }}',
        options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } } }),
    node(W, 'Button pressed (POST)', 'n8n-nodes-base.webhook', 2, [0, 440],
      { httpMethod: 'POST', path: 'sched-review', responseMode: 'responseNode', options: {} },
      { webhookId: uuid('review-post') }),
    pg(W, 'Apply review', [220, 440], `SELECT sched.outbox_review($1::bigint, $2, $3) AS r;`,
      `[ String(parseInt(($json.body || {}).id, 10) || 0), String(($json.body || {}).t || ''), String(($json.body || {}).a || '') ]`),
    code(W, 'Result page', [440, 440], `
const r = $json.r || {};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const msg = \`<p>\${esc(r.message)}</p>\`;
return { json: { html: ${page("\${r.ok ? 'Done' : 'Nothing changed'}", 'msg')} } };`, { withLib: false }),
    node(W, 'Show result', 'n8n-nodes-base.respondToWebhook', 1.1, [660, 440],
      { respondWith: 'text', responseBody: '={{ $json.html }}',
        options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } } }),
    execWf(W, 'Kick executor', [880, 440], 'executor', { wait: false, each: false }),
  ];
  const pairs = [['Link opened (GET)', 'Confirm page'], ['Confirm page', 'Show confirm page'],
                 ['Button pressed (POST)', 'Apply review'], ['Apply review', 'Result page'],
                 ['Result page', 'Show result'], ['Show result', 'Kick executor']];
  return workflow(W, 'Sarah · Review', nodes, pairs,
    { description: 'Shadow mode: the approve/reject links in review emails. GET shows a confirm button; only the POST acts.' });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
function errors() {
  const W = 'errors';
  const nodes = [
    node(W, 'Workflow failed', 'n8n-nodes-base.errorTrigger', 1, [0, 300], {}),
    pg(W, 'Settings', [220, 300],
      `SELECT sched.setting_text('graph_base_url') AS graph, sched.setting_text('sarah_upn') AS sarah,
              sched.setting_text('alert_address') AS alert_to, sched.setting_text('n8n_base_url') AS n8n;`,
      null, { alwaysOutputData: true }),
    code(W, 'Build alert', [440, 300], `
const e = $('Workflow failed').first().json;
const s = $json;
const exec = e.execution || {};
const wf = e.workflow || {};
const text = [
  'An n8n workflow failed.',
  '',
  'Workflow: ' + (wf.name || '?'),
  'Node:     ' + (exec.lastNodeExecuted || '?'),
  'Error:    ' + ((exec.error && exec.error.message) || '?'),
  'Execution: ' + (s.n8n ? s.n8n.replace(/\\/$/, '') + '/workflow/' + wf.id + '/executions/' + exec.id : exec.id),
  '',
  'If this was an inbound email, the thread is moved to NEEDS_VIC by the timer sweeper within ~15 minutes.',
].join('\\n');
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
return { json: { url: s.graph + '/users/' + encodeURIComponent(s.sarah) + '/sendMail', body: {
  message: { subject: '[Sarah] Workflow failed: ' + (wf.name || '?'),
             body: { contentType: 'HTML', content: '<pre style="font-family:Consolas,monospace">' + esc(text) + '</pre>' },
             toRecipients: [{ emailAddress: { address: s.alert_to } }] },
  saveToSentItems: true } } };`, { withLib: false }),
    http(W, 'Graph: email Casey', [660, 300], { method: 'POST', url: '={{ $json.url }}', body: 'JSON.stringify($json.body)', cred: 'graph' }),
  ];
  const pairs = [['Workflow failed', 'Settings'], ['Settings', 'Build alert'], ['Build alert', 'Graph: email Casey']];
  return workflow(W, 'Sarah · Errors', nodes, pairs,
    { errorWorkflow: false, description: 'Error workflow for every Sarah workflow: emails the alert address from Sarah\'s mailbox.' });
}

// ---------------------------------------------------------------------------
function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const all = { poller, processor, executor, timers, review, errors };
  for (const [key, fn] of Object.entries(all)) {
    const wf = fn();
    const file = path.join(OUT, `${key}.json`);
    fs.writeFileSync(file, `${JSON.stringify(wf, null, 2)}\n`);
    console.log(`wrote ${path.relative(ROOT, file)} (${wf.nodes.length} nodes)`);
  }
}

if (require.main === module) main();
module.exports = { ID, CRED };
