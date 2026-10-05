'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../src/llm');
const Dr = require('../../src/draft');
const F = require('../../src/format');
const X = require('../../src/executor');
const Pl = require('../../src/poller');
const { route } = require('../../src/route');
const { ctx, clientCtx, message, thread } = require('./fixtures');

// ---------------------------------------------------------------------------
// model output parsing
// ---------------------------------------------------------------------------
const wrap = (content) => ({ choices: [{ message: { content } }] });

test('parser: think blocks, fences, narration, echoed schema', () => {
  const ok = { body: 'Hi {{SLOTS}}' };
  assert.deepEqual(L.parseModelJson(wrap(`<think>let me think {"body": 1}</think>\n${JSON.stringify(ok)}`), 'draft').value, ok);
  assert.deepEqual(L.parseModelJson(wrap('```json\n{"body":"x"}\n```'), 'draft').value, { body: 'x' });
  assert.deepEqual(L.parseModelJson(wrap('Thinking Process: first... then {"body":"y"} done.'), 'draft').value, { body: 'y' });
  const echoed = '{"type":"object","properties":{"body":{}},"required":["body"]} answer: {"body":"z"}';
  assert.deepEqual(L.parseModelJson(wrap(echoed), 'draft').value, { body: 'z' });
  assert.equal(L.parseModelJson(wrap('no json here'), 'draft').ok, false);
  assert.equal(L.parseModelJson({ error: { message: 'boom' } }, 'draft').ok, false);
  assert.equal(L.parseModelJson(wrap('{"body": "a \\" } tricky"}'), 'draft').value.body, 'a " } tricky');
});

test('request carries json_schema unless disabled', () => {
  const c = ctx();
  const r = L.buildRequest(c, { system: 's', user: 'u', schema: 'draft' });
  assert.equal(r.body.response_format.type, 'json_schema');
  assert.equal(r.body.model, 'qwen-test');
  c.settings.llm_json_schema = false;
  assert.equal(L.buildRequest(c, { system: 's', user: 'u', schema: 'draft' }).body.response_format, undefined);
});

// ---------------------------------------------------------------------------
// draft validator
// ---------------------------------------------------------------------------
test('validator accepts a clean draft and strips a sign-off', () => {
  const v = Dr.validateDraft('Hi Dana, would any of these work for a 30-minute Teams call?\n\n{{SLOTS}}\n\nBest regards,\nSarah', 'new_round');
  assert.ok(v.ok, v.errors.join());
  assert.ok(!/Sarah$/.test(v.body));
});

test('validator rejects every way a model sneaks in a fact', () => {
  const bad = [
    ['Hi, how about Tuesday? {{SLOTS}}', 'weekday'],
    ['Hi, October works {{SLOTS}}', 'month'],
    ['Hi, 2pm? {{SLOTS}}', 'clock_ampm'],
    ['Hi, 14:30? {{SLOTS}}', 'clock_24h'],
    ['Hi, 10/14? {{SLOTS}}', 'numeric_date'],
    ['Hi, the 14th? {{SLOTS}}', 'ordinal'],
    ['Hi, tomorrow maybe {{SLOTS}}', 'relative_date'],
    ['Hi, all times EDT {{SLOTS}}', 'timezone'],
    ['Book here https://x.y {{SLOTS}}', 'url'],
    ['Write to vic@bzb.com {{SLOTS}}', 'email'],
    ['Call 301-555-1234 {{SLOTS}}', 'phone'],
    ["I'm a real person! {{SLOTS}}", 'human_claim'],
  ];
  for (const [body, kind] of bad) {
    const v = Dr.validateDraft(body, 'new_round');
    assert.ok(!v.ok && v.errors.some((e) => e.startsWith(kind)), `${kind}: ${v.errors.join()}`);
  }
});

test('validator enforces placeholders per purpose', () => {
  assert.ok(!Dr.validateDraft('Hi Dana, here you go.', 'new_round').ok);            // missing SLOTS
  assert.ok(!Dr.validateDraft('Hi {{SLOTS}} and {{SLOTS}}', 'new_round').ok);       // twice
  assert.ok(!Dr.validateDraft('Thanks, {{TIME}} works {{SLOTS}}', 'ack').ok);        // wrong one
  assert.ok(!Dr.validateDraft('Thanks, I will pass this on {{NAME}}', 'handoff').ok); // invented
  assert.ok(Dr.validateDraft('Thanks, {{TIME}} it is. I will confirm with Vic.', 'ack').ok);
  assert.ok(Dr.validateDraft('Thanks Dana, I will pass this along to Vic.', 'handoff').ok);
});

test('every template passes its own validator', () => {
  const f = { names: 'Dana', employee_first: 'Vic', duration_min: 30, location: 'a Teams call', location_type: 'teams', bcc: true };
  for (const [purpose, tpl] of Object.entries(Dr.TEMPLATES)) {
    const v = Dr.validateDraft(tpl(f), purpose);
    assert.ok(v.ok, `${purpose}: ${v.errors.join()}`);
  }
});

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------
test('slot formatting states the offset and handles DST', () => {
  assert.equal(F.formatSlot('2026-10-06T14:00:00Z', '2026-10-06T14:30:00Z', 'America/New_York'),
    'Tuesday, October 6, 10:00–10:30 AM EDT (UTC−04:00)');
  assert.equal(F.formatSlot('2026-11-10T17:30:00Z', '2026-11-10T18:30:00Z', 'America/New_York'),
    'Tuesday, November 10, 12:30–1:30 PM EST (UTC−05:00)');
  assert.equal(F.formatSlot('2026-11-10T16:30:00Z', '2026-11-10T17:30:00Z', 'America/New_York'),
    'Tuesday, November 10, 11:30 AM–12:30 PM EST (UTC−05:00)');
  assert.match(F.calendarTable('2026-10-05T14:00:00Z', 'America/New_York', 3), /^Mon 2026-10-05 \(today\)\nTue 2026-10-06 \(tomorrow\)\nWed 2026-10-07$/);
});

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------
test('routing', () => {
  assert.equal(route(ctx()).kind, 'new_trigger');
  assert.equal(route(ctx({ settings: { ...ctx().settings, mode: 'off' } })).kind, 'ignore');
  assert.equal(route(ctx({ message: message({ cc_addresses: [], to_addresses: ['dana@acme-bio.com'] }) })).disposition, 'ignored_not_addressed');
  assert.equal(route(clientCtx('hi')).kind, 'client_reply');
  assert.equal(route(clientCtx('hi', { thread: { state: 'NEEDS_VIC', escalation_reason: 'x' } })).disposition, 'ignored_thread_escalated');
  assert.equal(route(ctx({ message: message({ from_address: 'stranger@x.com', headers: {} }) })).disposition, 'ignored_no_thread');
  assert.equal(route(ctx({ message: message({ from_address: 'brad@bluzonebio.com' }) })).disposition, 'ignored_internal_other');
  const noAuth = ctx({ message: message({ headers: {} }) });
  assert.equal(route(noAuth).disposition, 'ignored_unauthenticated');
  noAuth.settings.require_internal_auth = false;
  assert.equal(route(noAuth).kind, 'new_trigger');
  // broken-thread fallback only for known clients
  const fb = clientCtx('hi', { ctx: { match_kind: 'fallback_sender' } });
  assert.equal(route(fb).kind, 'client_reply');
  fb.message.from_address = 'someone.else@acme-bio.com';
  assert.equal(route(fb).disposition, 'ignored_unknown_sender');
  // Vic's confirmation only counts while awaiting him
  const conf = ctx({ match_kind: 'confirmation', thread: thread({ state: 'AWAITING_VIC' }) });
  assert.equal(route(conf).kind, 'employee_confirmation');
  conf.thread.state = 'BOOKED';
  assert.equal(route(conf).disposition, 'ignored_employee_note');
});

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------
const cfg = { graph_base_url: 'https://graph.test/v1.0', sarah_upn: 'sarah.johnson@bluzonebio.com' };
const item = (over) => ({ id: 5, kind: 'reply', step: 'full', offer_id: 9, draft_graph_id: null, config: cfg,
  payload: { reply_to_graph_id: 'G1', to: [{ address: 'dana@acme-bio.com', name: 'Dana' }], cc: [], bcc: [], body_html: '<p>x</p>' }, ...over });

test('executor: reply → createReply on Sarah, then send', () => {
  const it = item();
  const r1 = X.firstRequest(it);
  assert.equal(r1.url, 'https://graph.test/v1.0/users/sarah.johnson%40bluzonebio.com/messages/G1/createReply');
  assert.equal(r1.body.message.toRecipients[0].emailAddress.address, 'dana@acme-bio.com');
  const a = X.afterFirst(it, { statusCode: 201, body: { id: 'DRAFT1', conversationId: 'C1' } });
  assert.equal(a.next.url, 'https://graph.test/v1.0/users/sarah.johnson%40bluzonebio.com/messages/DRAFT1/send');
  const rep = X.afterSecond(it, a, { statusCode: 202, body: '' });
  assert.deepEqual(rep, { id: 5, draft_graph_id: 'DRAFT1', outcome: 'done', result: { conversation_id: 'C1' } });
});

test('executor: shadow draft_only stops at the draft', () => {
  const it = item({ step: 'draft_only' });
  const a = X.afterFirst(it, { statusCode: 201, body: { id: 'D2', conversationId: 'C2' } });
  assert.equal(a.report.outcome, 'awaiting_approval');
  assert.equal(a.report.draft_graph_id, 'D2');
});

test('executor: retry after send failure reuses the draft instead of creating another', () => {
  const r = X.firstRequest(item({ draft_graph_id: 'D3' }));
  assert.match(r.url, /messages\/D3\/send$/);
});

test('executor: error classification', () => {
  const it = item();
  assert.equal(X.afterFirst(it, { statusCode: 503, body: {} }).report.outcome, 'retry');
  assert.equal(X.afterFirst(it, { statusCode: 429, body: {} }).report.outcome, 'retry');
  assert.equal(X.afterFirst(it, { statusCode: 403, body: { error: { code: 'ErrorAccessDenied', message: 'no' } } }).report.outcome, 'failed');
  assert.equal(X.afterFirst(it, { error: { message: 'ECONNRESET' } }).report.outcome, 'retry');
  const del = item({ kind: 'delete_hold', payload: { employee_upn: 'vic@bluzonebio.com', event_id: 'E1' } });
  assert.equal(X.firstRequest(del).method, 'DELETE');
  assert.equal(X.afterFirst(del, { statusCode: 404, body: {} }).report.outcome, 'done');
});

test('executor: booking is created on Vic\'s calendar with Teams + idempotency key', () => {
  const it = item({ kind: 'create_booking', payload: { employee_upn: 'vic@bluzonebio.com', subject: 'S', location_type: 'teams',
    start: { dateTime: '2026-10-07T10:00:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-07T10:30:00', timeZone: 'America/New_York' },
    attendees: [{ address: 'dana@acme-bio.com', name: 'Dana' }] } });
  const r = X.firstRequest(it);
  assert.equal(r.url, 'https://graph.test/v1.0/users/vic%40bluzonebio.com/events');
  assert.equal(r.body.isOnlineMeeting, true);
  assert.equal(r.body.transactionId, 'sarah-booking-9');
  assert.equal(X.afterFirst(it, { statusCode: 201, body: { id: 'EV' } }).report.result.event_id, 'EV');
  assert.equal(X.afterFirst({ ...it, step: 'await_approval' }).report.outcome, 'awaiting_approval');
});

test('executor: holds are private, tentative, tagged', () => {
  const r = X.firstRequest(item({ kind: 'create_hold', payload: { employee_upn: 'vic@bluzonebio.com', start: '2026-10-06T14:00:00Z', end: '2026-10-06T14:30:00Z', subject: 'Hold' } }));
  assert.equal(r.body.showAs, 'tentative');
  assert.equal(r.body.sensitivity, 'private');
  assert.deepEqual(r.body.categories, ['Sarah hold']);
  assert.deepEqual(r.body.start, { dateTime: '2026-10-06T14:00:00', timeZone: 'UTC' });
  assert.equal(r.body.attendees, undefined, 'a hold never invites anyone');
});

// ---------------------------------------------------------------------------
// poller
// ---------------------------------------------------------------------------
test('poller: delta split + message normalization', () => {
  const s = Pl.splitDelta({ value: [{ id: 'a' }, { id: 'b', '@removed': { reason: 'deleted' } }, { id: 'a' }, { id: 'c', isDraft: true }],
                            '@odata.deltaLink': 'https://graph.test/delta?token=1' });
  assert.deepEqual(s.ids, ['a']);
  assert.equal(s.cursor, 'https://graph.test/delta?token=1');
  const n = Pl.normalizeMessage({
    id: 'G', internetMessageId: '<x@y>', conversationId: 'C', subject: 'Hi',
    from: { emailAddress: { address: 'Vic@BluZoneBio.com', name: 'Vic Suarez' } },
    toRecipients: [{ emailAddress: { address: 'Dana@Acme.com', name: 'Dana W' } }],
    ccRecipients: [{ emailAddress: { address: 'sarah.johnson@bluzonebio.com', name: 'sarah.johnson@bluzonebio.com' } }],
    receivedDateTime: '2026-10-05T13:58:00Z', uniqueBody: { content: 'new part\r\nline 2' },
    internetMessageHeaders: [{ name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' }, { name: 'Auto-Submitted', value: 'no' }],
  });
  assert.equal(n.from_address, 'vic@bluzonebio.com');
  assert.deepEqual(n.to_addresses, ['dana@acme.com']);
  assert.equal(n.recipient_names['dana@acme.com'], 'Dana W');
  assert.equal(n.recipient_names['sarah.johnson@bluzonebio.com'], '');
  assert.equal(n.headers.auth_as, 'Internal');
  assert.equal(n.body_text, 'new part\nline 2');
});

test('poller: Graph failures are described in words, never as an empty error object', () => {
  const Pl = require('../../src/poller');
  const silent = { error: { level: 'warning', shouldReport: false, tags: {} } };   // what n8n gives when no request was made
  assert.match(Pl.describeGraphFailure(silent), /never reached Microsoft Graph.*Client Secret.*Value, not its Secret ID/);
  assert.match(Pl.describeGraphFailure({ statusCode: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } }),
    /^HTTP 403 ErrorAccessDenied: Access is denied\. \(Exchange scoping/);
  assert.match(Pl.describeGraphFailure({ statusCode: 401, body: { error: { code: 'InvalidAuthenticationToken' } } }), /^HTTP 401 InvalidAuthenticationToken.*scope/);
  assert.equal(Pl.describeGraphFailure({ error: { message: 'getaddrinfo ENOTFOUND graph.microsoft.com' } }), 'getaddrinfo ENOTFOUND graph.microsoft.com');
});

test('llm: token budget and extra body come from settings; running out of tokens says so', () => {
  const L = require('../../src/llm');
  const { ctx: mk } = require('./fixtures');
  const c = mk();
  const prompt = { system: 's', user: 'u', schema: 'trigger' };
  assert.equal(L.buildRequest(c, prompt, { maxTokens: 4096 }).body.max_tokens, 4096);
  c.settings.llm_max_tokens = 8000;
  c.settings.llm_extra_body = { chat_template_kwargs: { enable_thinking: false }, model: 'ignored' };
  const b = L.buildRequest(c, prompt, { maxTokens: 4096 }).body;
  assert.equal(b.max_tokens, 8000);
  assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  assert.equal(b.model, 'qwen-test', 'extra body never overrides the model or messages');
  const out = L.parseModelJson({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'hmm…' } }] }, 'trigger');
  assert.equal(out.ok, false);
  assert.match(out.error, /whole token budget.*llm_max_tokens/);
  assert.equal(L.parseModelJson({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }, 'trigger').error, 'empty model response');
});
