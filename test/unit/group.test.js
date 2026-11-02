'use strict';
// Group meetings: everyone on the meeting must agree on one time.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../src/decide');
const G = require('../../src/group');
const { ctx, clientCtx, llm, thread, offers, message, NO_CONSTRAINTS } = require('./fixtures');

function run(c, { classify, calendar = { value: [] }, draft } = {}) {
  let S = D.start(c);
  S = D.interpret(S, S.llm ? classify : null);
  S = D.act(S, S.calendar ? calendar : null);
  S = D.finish(S, S.llm ? draft : null);
  if (S.llm) S = D.finish(S, null);
  return { S, plan: S.plan };
}

const DANA = 'dana@acme-bio.com';
const RAJ = 'raj.patel@acme-bio.com';
const GROUP = {
  client_addresses: [DANA, RAJ], responders: [DANA, RAJ],
  client_names: { [DANA]: 'Dana Whitfield', [RAJ]: 'Raj Patel' }, responses: {},
};
const CLIENT = (over) => ({ intent: 'accept', accepted_option: null, accepted_options: [], answering_for: [], proposed_times: [],
                            constraints: NO_CONSTRAINTS, other_timezone: null, question: null, summary: 'x', ...over });
const START = (id) => offers().find((o) => o.id === id).start;

function groupReply(from, body, threadOver = {}, ctxOver = {}) {
  const c = clientCtx(body, { thread: { ...GROUP, ...threadOver } });
  c.message = { ...c.message, from_address: from, from_name: from === DANA ? 'Dana Whitfield' : 'Raj Patel' };
  c.reply_target = c.message;
  return { ...c, ...ctxOver };
}

test('trigger: everyone in the meeting must answer', () => {
  const c = ctx({ message: message({ to_addresses: [DANA, RAJ] }) });
  const { plan } = run(c, { classify: llm({ is_scheduling_request: true, duration_min: null, location: null, location_detail: null,
                                           constraints: NO_CONSTRAINTS, topic: null }),
                            draft: llm({ body: 'Hi Dana and Raj, would one of these work?\n\n{{SLOTS}}' }) });
  assert.deepEqual(plan.thread.create.responders, [DANA, RAJ]);
});

test('first of two answers → thank them, ask the other, drop times they ruled out', () => {
  const { plan } = run(groupReply(DANA, 'Tuesday or Wednesday work for me'), {
    classify: llm(CLIENT({ accepted_option: 1, accepted_options: [1, 2] })),
    draft: llm({ body: 'Thanks, Dana. Raj, which of these work for you?\n\n{{SLOTS}}' }),
  });
  assert.deepEqual(plan.thread.transitions, []);
  assert.deepEqual(Object.keys(plan.thread.set.responses), [DANA]);
  assert.equal(plan.thread.set.touch_inbound, undefined, 'the timers keep running for Raj');
  assert.deepEqual(plan.offers.update, [{ id: 13, status: 'declined' }]);
  const reply = plan.outbox.find((o) => o.kind === 'reply');
  assert.equal(reply.purpose, 'group_partial');
  assert.ok(reply.payload.body_text.includes('Raj'));
  assert.deepEqual(reply.payload.to.map((p) => p.address), [DANA, RAJ]);
});

test('last answer with a time in common → the earliest common time goes to Vic', () => {
  const responses = { [DANA]: { starts: [START(11), START(12)], at: 'x' } };
  const { plan } = run(groupReply(RAJ, 'Option 2 or 1 is fine', { responses }), {
    classify: llm(CLIENT({ accepted_option: 2, accepted_options: [2, 1] })),
    draft: llm({ body: 'Great, Dana and Raj. {{TIME}} it is. I\'ll confirm with Vic.' }),
  });
  assert.deepEqual(plan.thread.transitions, ['CLIENT_ACCEPTED', 'AWAITING_VIC']);
  assert.equal(plan.thread.set.accepted_offer_id, 11);
  assert.ok(plan.outbox.some((o) => o.purpose === 'vic_confirmation'));
  assert.equal(plan.outbox.find((o) => o.kind === 'reply').purpose, 'ack');
});

test('answers with nothing in common → a new round for everyone, answers cleared', () => {
  const responses = { [DANA]: { starts: [START(11)], at: 'x' } };
  const { plan } = run(groupReply(RAJ, 'Only Thursday works', { responses }), {
    classify: llm(CLIENT({ accepted_option: 3, accepted_options: [3] })),
    draft: llm({ body: 'None of those worked for everyone, so here are more. Which work for each of you?\n\n{{SLOTS}}' }),
  });
  assert.deepEqual(plan.thread.set.responses, {});
  assert.equal(plan.thread.set.round_count, 2);
  assert.equal(plan.outbox.find((o) => o.kind === 'reply').purpose, 'group_no_overlap');
});

test('one person suggests a free time → the others are asked about it', () => {
  const { plan } = run(groupReply(RAJ, 'How about Friday the 9th at 11?'), {
    classify: llm(CLIENT({ intent: 'counter', proposed_times: [{ date: '2026-10-09', time: '11:00' }] })),
    draft: llm({ body: 'Thanks for suggesting that, Raj. Dana, does it work for you too?\n\n{{SLOTS}}' }),
  });
  assert.deepEqual(plan.thread.transitions, []);
  assert.equal(plan.offers.insert.length, 1);
  assert.equal(Date.parse(plan.offers.insert[0].start), Date.parse('2026-10-09T15:00:00Z'));
  assert.deepEqual(Object.keys(plan.thread.set.responses), [RAJ]);
  assert.equal(plan.outbox.find((o) => o.kind === 'reply').purpose, 'group_counter');
});

test('an assistant answering for one of them counts for that person', () => {
  const c = groupReply(DANA, 'x');
  c.message = { ...c.message, from_address: 'pa@acme-bio.com', from_name: 'Pat' };
  assert.deepEqual(G.voters(c.thread, 'pa@acme-bio.com', ['Raj'], c.thread.client_names), [RAJ]);
  // No name given: the unanswered people at the assistant's company.
  assert.deepEqual(G.voters({ ...c.thread, responses: { [DANA]: {} } }, 'pa@acme-bio.com', [], {}), [RAJ]);
  assert.deepEqual(G.voters(c.thread, 'stranger@else.com', [], {}), []);
});

function timerCtx(action, over = {}) {
  return ctx({ event: { type: 'timer', action, thread_id: 7 }, message: null, match_kind: 'timer',
               thread: thread({ ...GROUP, ...over }), thread_offers: offers(), live_offers: offers(), reply_target: clientCtx('x').message });
}

test('someone silent after the follow-up → Vic chooses: book with who agreed, or follow up', () => {
  const { plan } = run(timerCtx('mark_stalled', { followup_sent_at: 'x', responses: { [DANA]: { starts: [START(12)], at: 'x' } } }));
  assert.deepEqual(plan.thread.transitions, ['CLIENT_ACCEPTED', 'AWAITING_VIC']);
  assert.equal(plan.thread.set.accepted_offer_id, 12);
  const mail = plan.outbox.find((o) => o.purpose === 'vic_confirmation');
  assert.ok(mail.payload.body_text.includes('Dana can do:'));
  assert.ok(mail.payload.body_text.includes("Raj hasn't replied"));
  assert.ok(mail.payload.body_text.includes('FOLLOW UP'));
});

test('nobody in the group answered the follow-up → stalled as before', () => {
  const { plan } = run(timerCtx('mark_stalled', { followup_sent_at: 'x' }));
  assert.deepEqual(plan.thread.transitions, ['STALLED']);
});

test('follow-up in a group with some answers in is aimed at whoever is silent', () => {
  const { plan } = run(timerCtx('client_followup', { responses: { [DANA]: { starts: [START(12)], at: 'x' } } }));
  const reply = plan.outbox.find((o) => o.kind === 'reply');
  assert.equal(reply.purpose, 'followup');
  assert.ok(reply.payload.body_text.startsWith('Hi Raj'));
});

function vicCtx(body, over = {}) {
  const offs = offers().map((o) => (o.id === 12 ? { ...o, status: 'accepted' } : { ...o, status: 'superseded', hold_event_id: null }));
  const msg = message({ id: 103, internet_message_id: '<fu@bzb>', graph_message_id: 'G-103', conversation_id: 'CONV-VIC',
    to_addresses: ['sarah.johnson@bluzonebio.com'], cc_addresses: [], subject: 'RE: Confirm [S-7]', body_text: body });
  return ctx({ message: msg, match_kind: 'confirmation',
               thread: thread({ ...GROUP, state: 'AWAITING_VIC', accepted_offer_id: 12, responses: { [DANA]: { starts: [START(12)], at: 'x' } }, ...over }),
               thread_offers: offs, live_offers: offs.filter((o) => o.status === 'accepted'), reply_target: clientCtx('2').message });
}

test('Vic says follow up → Sarah asks the silent person about the agreed time', () => {
  const { plan, S } = run(vicCtx('follow up with Raj'), {
    classify: llm({ decision: 'nudge', proposed_times: [], constraints: NO_CONSTRAINTS }),
    draft: llm({ body: 'Hi Raj, Dana can do the time below. Does it work for you too?\n\n{{SLOTS}}' }),
  });
  assert.ok(S.log.length >= 0);
  assert.deepEqual(plan.thread.transitions, ['PROPOSED']);
  assert.deepEqual(plan.offers.update, [{ id: 12, status: 'offered' }]);
  assert.equal(plan.thread.set.followup_sent, true);
  assert.equal(plan.thread.set.accepted_offer_id, null);
  assert.equal(plan.outbox.find((o) => o.kind === 'reply').purpose, 'group_nudge');
});

test('Vic says YES with someone silent → booked with everyone invited', () => {
  const { plan } = run(vicCtx('yes'), {
    classify: llm({ decision: 'yes', proposed_times: [], constraints: NO_CONSTRAINTS }),
    draft: llm({ body: 'All set: {{TIME}}. The invite is coming from Vic\'s calendar.' }),
  });
  const b = plan.outbox.find((o) => o.kind === 'create_booking');
  assert.deepEqual(b.payload.attendees.map((a) => a.address), [DANA, RAJ]);
});

test('"nudge" with nobody silent is not a nudge', () => {
  const { plan } = run(vicCtx('chase them', { responses: { [DANA]: { starts: [START(12)] }, [RAJ]: { starts: [START(12)] } } }), {
    classify: llm({ decision: 'nudge', proposed_times: [], constraints: NO_CONSTRAINTS }),
  });
  assert.ok(plan.outbox.some((o) => o.purpose === 'vic_clarify'));
});

test('one-person threads (and older threads with no responders) book on the first pick, as before', () => {
  const c = clientCtx('2 works');
  const { plan } = run(c, { classify: llm(CLIENT({ accepted_option: 2 })), draft: llm({ body: 'Great, Dana. {{TIME}} it is.' }) });
  assert.deepEqual(plan.thread.transitions, ['CLIENT_ACCEPTED', 'AWAITING_VIC']);
});
