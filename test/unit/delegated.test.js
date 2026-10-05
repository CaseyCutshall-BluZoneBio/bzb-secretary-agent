'use strict';
// Per-user delegated calendars (portal): the processor/executor side.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../src/decide');
const X = require('../../src/executor');
const P = require('../../src/prompts');
const { VIC, ctx, clientCtx, llm, message, NO_CONSTRAINTS } = require('./fixtures');

function run(c, { classify, calendar = { value: [] }, draft } = {}) {
  let S = D.start(c);
  const classifyReq = S.llm;
  S = D.interpret(S, S.llm ? classify : null);
  const calReq = S.calendar;
  S = D.act(S, S.calendar ? calendar : null);
  S = D.finish(S, S.llm ? draft : null);
  return { S, plan: S.plan, classifyReq, calReq };
}

const TRIGGER_CLS = { is_scheduling_request: true, duration_min: null, location: null, location_detail: null, constraints: NO_CONSTRAINTS, topic: null };
const CLIENT = (over) => ({ intent: 'other', accepted_option: null, proposed_times: [], constraints: NO_CONSTRAINTS,
                            other_timezone: null, question: null, summary: 'x', ...over });
// Brad signs in with brad@… but his mail address is brad.lee@…
const BRAD = { ...VIC, id: 2, upn: 'brad@bluzonebio.com', mail: 'brad.lee@bluzonebio.com', display_name: 'Brad Lee', first_name: 'Brad',
               calendar_auth: 'delegated', calendar_connected_at: '2026-10-01T12:00:00Z', needs_reconnect: false, paused: false,
               signature_title: 'Scheduling Assistant to Brad Lee (AI)' };
const PORTAL = { portal_internal_url: 'http://sarah-portal:3001', portal_base_url: 'https://bzb-ai-1.tail9f1964.ts.net:10000' };

function bradCtx(over = {}, emp = BRAD) {
  const c = ctx({ employees: [VIC, emp],
                  message: message({ from_address: 'brad.lee@bluzonebio.com', from_name: 'Brad Lee', body_text: 'Sarah will find us a time.' }),
                  ...over });
  c.reply_target = c.message;
  Object.assign(c.settings, PORTAL);
  return c;
}
const RECONNECT = { error: { status: 409, body: { error: { code: 'NeedsReconnect', message: 'reconnect' } } } };

test('delegated employee: the calendar read goes to the broker, never to Graph with the app credential', () => {
  const { calReq, plan } = run(bradCtx(), { classify: llm(TRIGGER_CLS) });
  assert.equal(calReq.via, 'broker');
  assert.equal(calReq.url, 'http://sarah-portal:3001/internal/v1/calendar');
  assert.equal(calReq.body.employee_upn, 'brad@bluzonebio.com');
  assert.equal(calReq.body.op, 'calendar_view');
  assert.match(calReq.body.start, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.ok(calReq.body.end > calReq.body.start);
  assert.ok(!JSON.stringify(calReq).includes('graph'), 'no Graph URL in a broker request');
  assert.deepEqual(plan.thread.transitions, ['PROPOSED']);
  // Vic (calendar_auth unset / 'app') is unchanged
  const vic = run(ctx(), { classify: llm(TRIGGER_CLS) }).calReq;
  assert.equal(vic.via, 'app');
  assert.match(vic.url, /\/users\/vic%40bluzonebio\.com\/calendarView\?/);
});

test('delegated employee is matched by their mail address; BCC, notices and the signature use it', () => {
  const { plan } = run(bradCtx(), { classify: llm(TRIGGER_CLS) });
  assert.equal(plan.thread.create.employee_id, 2);
  const reply = plan.outbox.find((o) => o.kind === 'reply');
  assert.deepEqual(reply.payload.bcc.map((p) => p.address), ['brad.lee@bluzonebio.com']);
  assert.match(reply.payload.body_text, /Sarah Johnson\nScheduling Assistant to Brad Lee \(AI\)\nBlu Zone Bio$/);
  assert.ok(!/Vic/.test(reply.payload.body_text), "Brad's client never sees Vic's name");
});

test('dead token on a client reply → NEEDS_VIC with the reconnect reason; no client email', () => {
  const c = clientCtx('Option 2 works', { ctx: { employees: [VIC, BRAD] }, thread: { employee_id: 2 } });
  Object.assign(c.settings, PORTAL);
  const { plan, calReq } = run(c, { classify: llm(CLIENT({ intent: 'accept', accepted_option: 2 })), calendar: RECONNECT });
  assert.equal(calReq.via, 'broker');
  assert.deepEqual(plan.thread.transitions, ['NEEDS_VIC']);
  assert.match(plan.thread.set.escalation_reason, /lost access to your calendar/);
  assert.match(plan.thread.set.escalation_reason, /https:\/\/bzb-ai-1\.tail9f1964\.ts\.net:10000\/connect/);
  assert.equal(plan.outbox.filter((o) => o.kind === 'reply').length, 0, 'the client is not emailed');
  assert.equal(plan.outbox.filter((o) => o.kind === 'create_hold' || o.kind === 'create_booking').length, 0);
  const notice = plan.outbox.find((o) => o.purpose === 'vic_notice');
  assert.equal(notice.payload.to[0].address, 'brad.lee@bluzonebio.com');
  assert.equal(plan.cancel_open_client_outbox, true);
  // a generic Graph error is still the generic reason
  const g = run(c, { classify: llm(CLIENT({ intent: 'accept', accepted_option: 2 })), calendar: { error: { status: 503, body: {} } } });
  assert.match(g.plan.thread.set.escalation_reason, /couldn't read your calendar/);
});

test('paused employee: a new trigger is ignored with a notice; the model is never asked', () => {
  const { plan, classifyReq } = run(bradCtx({}, { ...BRAD, paused: true }));
  assert.equal(classifyReq, null);
  assert.equal(plan.message.disposition, 'ignored_paused');
  assert.equal(plan.thread.create, null);
  assert.equal(plan.thread.id, null);
  const n = plan.outbox.find((o) => o.purpose === 'vic_notice');
  assert.equal(n.no_thread, true);
  assert.equal(n.payload.to[0].address, 'brad.lee@bluzonebio.com');
  assert.match(n.payload.subject, /^Paused, so I didn't start/);
  assert.match(n.payload.body_text, /Resume me at https:\/\/bzb-ai-1\.tail9f1964\.ts\.net:10000\//);
  assert.equal(plan.outbox.length, 1, 'nothing else is queued');
});

test('pause affects new triggers only: a client reply on a running thread is still handled', () => {
  const c = clientCtx('Option 2 works', { ctx: { employees: [VIC, { ...BRAD, paused: true }] }, thread: { employee_id: 2 } });
  Object.assign(c.settings, PORTAL);
  const { plan } = run(c, { classify: llm(CLIENT({ intent: 'accept', accepted_option: 2 })) });
  assert.deepEqual(plan.thread.transitions, ['CLIENT_ACCEPTED', 'AWAITING_VIC']);
});

test('calendar never connected, or needs reconnect → trigger ignored with the matching notice', () => {
  const never = run(bradCtx({}, { ...BRAD, calendar_connected_at: null }));
  assert.equal(never.plan.message.disposition, 'ignored_needs_reconnect');
  const n1 = never.plan.outbox.find((o) => o.purpose === 'vic_notice').payload;
  assert.match(n1.subject, /^Connect your calendar/);
  assert.match(n1.body_text, /isn't connected to me yet/);
  assert.match(n1.body_text, /\/connect/);
  const lost = run(bradCtx({}, { ...BRAD, needs_reconnect: true }));
  assert.equal(lost.plan.message.disposition, 'ignored_needs_reconnect');
  assert.match(lost.plan.outbox[0].payload.subject, /^Reconnect your calendar/);
  assert.equal(lost.plan.thread.create, null);
  // Vic on the app path is never blocked by these checks
  assert.deepEqual(run(ctx({ employees: [{ ...VIC, needs_reconnect: true }] }), { classify: llm(TRIGGER_CLS) }).plan.thread.transitions, ['PROPOSED']);
});

test('prompts name the employee Sarah works for, never Vic, and use neutral pronouns', () => {
  const draft = P.draftPrompt({ purpose: 'intro', employee_first: 'Brad', employee_full: 'Brad Lee', company: 'Blu Zone Bio',
    recipient_first_names: ['Dana'], duration_min: 30, location: 'a Teams call', bcc: true });
  assert.ok(draft.system.includes('Thanks for the introduction, Brad'));
  assert.ok(!/Vic/.test(draft.system + draft.user));
  const trig = P.classifyTriggerPrompt({ employeeFirst: 'Brad', zone: 'America/New_York', table: '', from: 'b', subject: '', body: '' });
  assert.ok(!/\b(he|his|him)\b/.test(trig.system));
  const cl = P.classifyClientPrompt({ employeeFirst: 'Brad', zone: 'America/New_York', table: '', optionsText: '', from: 'x', subject: '', body: '', state: 'PROPOSED' });
  assert.ok(cl.system.includes('ask Brad to book with them'));
});

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------
const cfg = { graph_base_url: 'https://graph.test/v1.0', sarah_upn: 'sarah.johnson@bluzonebio.com', portal_internal_url: 'http://sarah-portal:3001/' };
const hold = (over) => ({ id: 5, kind: 'create_hold', step: 'full', offer_id: 9, config: cfg, calendar_auth: 'delegated',
  payload: { employee_upn: 'brad@bluzonebio.com', start: '2026-10-06T14:00:00Z', end: '2026-10-06T14:30:00Z', subject: 'Hold' }, ...over });

test('executor: delegated holds, bookings and hold releases go to the broker with the same event body', () => {
  const r = X.firstRequest(hold());
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'http://sarah-portal:3001/internal/v1/calendar');
  assert.equal(r.broker, true);
  assert.equal(r.body.op, 'create_event');
  assert.equal(r.body.employee_upn, 'brad@bluzonebio.com');
  assert.deepEqual(r.body.event, X.firstRequest(hold({ calendar_auth: 'app' })).body, 'the event is exactly what Graph would get');
  assert.equal(r.body.event.transactionId, 'sarah-hold-9');

  const del = X.firstRequest(hold({ kind: 'delete_hold', payload: { employee_upn: 'brad@bluzonebio.com', event_id: 'EV1' } }));
  assert.deepEqual(del.body, { employee_upn: 'brad@bluzonebio.com', op: 'delete_event', event_id: 'EV1' });
  assert.equal(del.method, 'POST', 'every broker call has a body (n8n ignores expressions in Send Body)');

  const booking = X.firstRequest(hold({ kind: 'create_booking', payload: { employee_upn: 'brad@bluzonebio.com', subject: 'S', location_type: 'teams',
    start: { dateTime: '2026-10-07T10:00:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-07T10:30:00', timeZone: 'America/New_York' },
    attendees: [{ address: 'dana@acme-bio.com', name: 'Dana' }] } }));
  assert.equal(booking.body.event.isOnlineMeeting, true);
  assert.equal(booking.body.event.attendees[0].emailAddress.address, 'dana@acme-bio.com');

  // app-only employees: unchanged
  assert.equal(X.firstRequest(hold({ calendar_auth: 'app' })).url, 'https://graph.test/v1.0/users/brad%40bluzonebio.com/events');
});

test('executor: mail never goes through the broker, whatever the item says', () => {
  const r = X.firstRequest({ id: 6, kind: 'reply', step: 'full', config: cfg, calendar_auth: 'delegated',
    payload: { reply_to_graph_id: 'G1', to: [{ address: 'dana@acme-bio.com' }], cc: [], bcc: [], body_html: 'x' } });
  assert.equal(r.broker, undefined);
  assert.match(r.url, /^https:\/\/graph\.test\/v1\.0\/users\/sarah\.johnson%40bluzonebio\.com\//);
});

test('executor: broker answers → report', () => {
  const it = hold();
  // Graph's own answer, passed back unchanged
  assert.equal(X.afterFirst(it, { statusCode: 201, body: { id: 'EV' } }).report.result.event_id, 'EV');
  // dead token: failed at once, with a code outbox_report recognizes
  const dead = X.afterFirst(it, { statusCode: 409, body: { error: { code: 'NeedsReconnect', message: 'x' } } }).report;
  assert.equal(dead.outcome, 'failed');
  assert.equal(dead.error_code, 'needs_reconnect');
  // Entra/network trouble at the broker: retried
  assert.equal(X.afterFirst(it, { statusCode: 503, body: { error: { code: 'TokenServiceUnavailable' } } }).report.outcome, 'retry');
  // not delegated (config drift): failed, not mistaken for "hold already gone"
  const del = hold({ kind: 'delete_hold', payload: { employee_upn: 'brad@bluzonebio.com', event_id: 'EV1' } });
  assert.equal(X.afterFirst(del, { statusCode: 422, body: { error: { code: 'EmployeeNotDelegated' } } }).report.outcome, 'failed');
  assert.equal(X.afterFirst(del, { statusCode: 404, body: { error: { code: 'ErrorItemNotFound' } } }).report.result.already_gone, true);
});
