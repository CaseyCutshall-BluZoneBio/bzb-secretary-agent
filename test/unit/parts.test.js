'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../src/llm');
const Dr = require('../../src/draft');
const F = require('../../src/format');
const X = require('../../src/executor');
const Pl = require('../../src/poller');
const { route } = require('../../src/route');
const { ctx, clientCtx, message, thread, VIC } = require('./fixtures');

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
  // logistics: every topic, every meeting type (incl. a real street address), with and without open options
  const kinds = [{ location: 'a Teams call', location_type: 'teams' }, { location: 'a phone call', location_type: 'phone' },
                 { location: 'in person at 321 Ballenger Center Dr, Frederick, MD 21703', location_type: 'in_person' }];
  for (const topic of ['duration', 'format', 'location', 'add_attendee']) {
    for (const k of kinds) {
      for (const has_open_options of [true, false]) {
        const text = Dr.TEMPLATES.logistics({ ...f, ...k, topic, has_open_options });
        const v = Dr.validateDraft(text, 'logistics');
        assert.ok(v.ok, `logistics/${topic}/${k.location_type}: ${v.errors.join()} :: ${text}`);
        assert.ok(!text.includes('undefined'));
      }
    }
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
  // A colleague Sarah is scheduling with is a client; one who isn't stays ignored.
  const brad = { from_address: 'brad@bluzonebio.com', from_name: 'Brad Lee', headers: { auth_as: 'Internal' } };
  const bradThread = { client_addresses: ['brad@bluzonebio.com'], client_names: {} };
  assert.equal(route(clientCtx('Tuesday works', { thread: bradThread, ctx: { message: message({ ...brad, conversation_id: 'CONV-1' }) } })).kind, 'client_reply');
  assert.equal(route(clientCtx('fyi', { ctx: { message: message(brad) } })).disposition, 'ignored_internal_other');
  // Enrolled in the portal too: on Vic's thread Brad is still an attendee, and
  // can't take over (close) a thread that isn't his.
  const BRAD = { id: 2, upn: 'brad@bluzonebio.com', mail: 'brad@bluzonebio.com', enrolled: true, first_name: 'Brad' };
  const withBrad = (body, thread) => clientCtx(body, { thread, ctx: { employees: [VIC, BRAD], message: message({ ...brad, conversation_id: 'CONV-1' }) } });
  assert.equal(route(withBrad('Tuesday works', bradThread)).kind, 'client_reply');
  assert.equal(route(withBrad("I'll take it from here", {})).disposition, 'ignored_employee_note');
  assert.equal(route(withBrad('Tuesday works', { ...bradThread, state: 'NEEDS_VIC', escalation_reason: 'x' })).disposition, 'ignored_thread_escalated');
  const bradFb = withBrad('Tuesday works', bradThread);
  bradFb.match_kind = 'fallback_sender';
  assert.equal(route(bradFb).kind, 'client_reply');
  // On his own thread he's still the employee.
  assert.equal(route(withBrad('thanks', { ...bradThread, employee_id: 2 })).kind, 'employee_in_thread');
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

test('first names: display name first; the address only when it clearly holds a name; else "there"', () => {
  const U = require('../../src/util');
  assert.equal(U.firstName('Dana Whitfield', 'dana@acme-bio.com'), 'Dana');
  assert.equal(U.firstName('Dr. Kim Lee', 'k@x.com'), 'Kim');
  assert.equal(U.firstName('', 'dana.whitfield@acme-bio.com'), 'Dana');
  assert.equal(U.firstName('', 'lou_park@x.com'), 'Lou');
  assert.equal(U.firstName('', 'cmcutshall5@gmail.com'), 'there');
  assert.equal(U.firstName('', 'jsmith@x.com'), 'there');
  assert.equal(U.firstName('', 'info@x.com'), 'there');
  assert.equal(U.firstName('cmcutshall5@gmail.com', 'cmcutshall5@gmail.com'), 'there', 'a display name that is just the address');
  assert.equal(U.joinNames([U.firstName('', 'a1@x.com')]), 'there');
});

test('greeting: unknown client names are left out; none known → "there"', () => {
  const D = require('../../src/decide');
  const { clientCtx, llm, NO_CONSTRAINTS } = require('./fixtures');
  const CL = (o) => ({ intent: 'reject_all', accepted_option: null, proposed_times: [], constraints: NO_CONSTRAINTS, other_timezone: null, question: null, summary: 'x', ...o });
  const go = (thread) => {
    const c = clientCtx('None of those work', { thread });
    c.message = { ...c.message, from_address: thread.client_addresses[thread.client_addresses.length - 1], from_name: '' };
    c.reply_target = c.message;
    let S = D.start(c);
    S = D.interpret(S, llm(CL({})));
    S = D.act(S, { value: [] });
    return S.email.facts.names;
  };
  assert.equal(go({ client_addresses: ['cmcutshall5@gmail.com'], client_names: {} }), 'there');
  assert.equal(go({ client_addresses: ['dana@acme-bio.com', 'x9@y.com'], client_names: { 'dana@acme-bio.com': 'Dana Whitfield' } }), 'Dana');
});

test('validator: {{ASKED}} only where offered, at most once', () => {
  const D = require('../../src/draft');
  assert.ok(D.validateDraft('Sure, Dana. {{ASKED}} has openings:\n\n{{SLOTS}}', 'new_round', { optional: ['ASKED'] }).ok);
  assert.ok(D.validateDraft('Sure, Dana, here are more options:\n\n{{SLOTS}}', 'new_round', { optional: ['ASKED'] }).ok, 'optional');
  assert.match(D.validateDraft('{{ASKED}} has openings:\n\n{{SLOTS}}', 'new_round').errors.join(), /unexpected placeholder/, 'not offered');
  assert.match(D.validateDraft('{{ASKED}} or {{ASKED}}:\n\n{{SLOTS}}', 'new_round', { optional: ['ASKED'] }).errors.join(), /at most once/);
  assert.match(D.validateDraft('Great, {{TIME}} works. {{ASKED}}', 'ack', { optional: ['ASKED'] }).errors.join(), /unexpected placeholder/, 'not for ack');
  assert.ok(D.validateDraft(D.TEMPLATES.window_unavailable({ names: 'Dana', employee_first: 'Vic' }), 'window_unavailable').ok);
});

test('llm: with json_schema off, the schema goes into the prompt so the model uses the right field names', () => {
  const L = require('../../src/llm');
  const { ctx: mk } = require('./fixtures');
  const c = mk();
  c.settings.llm_json_schema = false;
  const b = L.buildRequest(c, { system: 'Classify.', user: 'u', schema: 'client' }).body;
  assert.equal(b.response_format, undefined);
  assert.match(b.messages[0].content, /^Classify\.\n\nYour reply must be one JSON object matching this JSON Schema/);
  assert.match(b.messages[0].content, /"earliest_date"/);
  c.settings.llm_json_schema = true;
  assert.equal(L.buildRequest(c, { system: 'Classify.', user: 'u', schema: 'client' }).body.messages[0].content, 'Classify.');
});

test('drafting rules only mention {{ASKED}} when it is on offer', () => {
  const P = require('../../src/prompts');
  const f = { purpose: 'new_round', employee_first: 'Vic', employee_full: 'Vic Suarez', company: 'BZB', recipient_first_names: ['Dana'], duration_min: 30, location: 'a Teams call' };
  assert.ok(!P.draftPrompt(f).system.includes('{{ASKED}}'));
  assert.ok(P.draftPrompt({ ...f, asked: true }).system.includes('{{ASKED}}'));
});

test('options read like a person wrote them: bullets, start times, the timezone once; numbered style still available', () => {
  const F = require('../../src/format');
  const offs = [
    { option_no: 5, start: '2026-10-07T14:30:00Z', end: '2026-10-07T15:00:00Z' },
    { option_no: 4, start: '2026-10-06T18:00:00Z', end: '2026-10-06T18:30:00Z' },
  ];
  assert.equal(F.formatSlotOptions(offs, 'America/New_York'),
    '• Tuesday, October 6 at 2:00 PM\n• Wednesday, October 7 at 10:30 AM\n\nAll times are Eastern (UTC−04:00).');
  // straddling the DST change: each line gets its offset
  const dst = [{ option_no: 1, start: '2026-10-30T14:00:00Z' }, { option_no: 2, start: '2026-11-02T15:00:00Z' }];
  assert.equal(F.formatSlotOptions(dst, 'America/New_York'),
    '• Friday, October 30 at 10:00 AM (UTC−04:00)\n• Monday, November 2 at 10:00 AM (UTC−05:00)\n\nAll times are Eastern.');
  assert.match(F.formatSlotOptions(offs, 'Europe/Berlin'), /All times are GMT\+2 \(UTC\+02:00\)\.$|All times are CEST \(UTC\+02:00\)\.$/);
  // the old numbered style on request
  const D = require('../../src/decide');
  const { ctx, llm, NO_CONSTRAINTS } = require('./fixtures');
  const c = ctx(); c.settings.slot_style = 'numbered';
  let S = D.start(c);
  S = D.interpret(S, llm({ is_scheduling_request: true, duration_min: null, location: null, location_detail: null, constraints: NO_CONSTRAINTS, topic: null }));
  S = D.act(S, { value: [] });
  assert.match(S.email.fill.slotsText, /^1\. /);
});

test('client emails end with a sign-off before the signature', () => {
  const D = require('../../src/draft');
  const { ctx } = require('./fixtures');
  const emp = { signature_title: 'Executive Assistant to Vic Suarez (AI)' };
  assert.match(D.renderClientEmail(ctx(), 'Hi Dana. {{SLOTS}}', { slotsText: '• x' }, null, 'America/New_York', emp, 'new_round').body_text,
    /\n\nBest,\nSarah Johnson\nExecutive Assistant to Vic Suarez \(AI\)\nBluZoneBio\nEmail: sarah\.johnson@bluzonebio\.com\nWebsite: www\.bluzonebio\.com$/);
  assert.match(D.renderClientEmail(ctx(), 'Great, {{TIME}} it is.', { timeText: 'x' }, null, 'America/New_York', emp, 'ack').body_text, /\n\nThanks,\nSarah Johnson\n/);
});

// ---------------------------------------------------------------------------
// checkMentions: what she may say about days and times
// ---------------------------------------------------------------------------
{
  const Dr = require('../../src/draft');
  const Fm = require('../../src/format');
  // Thu Oct 8 at 2:00 PM and Fri Oct 9 at 10:30 AM (Eastern) are open; the client asked about Mon Oct 12.
  const m = (said = '') => Fm.mentionable({ open: ['2026-10-08T18:00:00Z', '2026-10-09T14:30:00Z'], askedDates: ['2026-10-12'] }, 'America/New_York', said);
  const ok = (text, said) => assert.deepEqual(Dr.checkMentions(text, m(said)), [], text);
  const bad = (text, said) => assert.ok(Dr.checkMentions(text, m(said)).length > 0, text);

  test('mentions: true statements pass', () => {
    ok('Thursday at 2pm looks good.');
    ok('Thursday at 2:00 PM looks good.');
    ok('Friday morning is open, and Thursday afternoon too.');
    ok('October 8 at 2pm works, or the 9th.');
    ok('Thursday, October 8 at 2:00 PM is open.');
    ok('Monday is booked up, sorry.');
    ok('Friday at 10:30 is open.');
    ok('A 30-minute call in October, at 2pm.');
  });
  test('mentions: false statements fail', () => {
    bad('Saturday works.');
    bad('Tuesday works.');
    bad('Friday at 2pm works.');
    bad('Thursday at 10:30 works.');
    bad('Friday afternoon is open.');
    bad('Thursday morning is open.');
    bad('The 15th works.');
    bad('October 15 works.');
    bad('November is open.');
    bad('Let us say 4pm.');
    bad('How about at 4?');
    bad('Noon is fine.');
    bad('October 8 at 10:30am is open.');
  });
  test('mentions: a day the client named may be repeated, but a clock time may not', () => {
    bad('Safe travels on Tuesday.');
    ok('Safe travels on Tuesday.', 'I fly out Tuesday');
    bad('Tuesday at 4pm is fine.', 'Tuesday at 4pm?');
  });
  test('mentions: not fooled by numbers that are not times', () => {
    ok('It will take at 30 minutes or so.');
    ok('See you at 30 people or fewer.');
  });
}
