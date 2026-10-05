'use strict';
// scripts/simulate.js: the in-terminal conversation simulator, with a fake model.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, turn } = require('../../scripts/simulate');

const NONE = { earliest_date: null, latest_date: null, days_of_week: [], time_of_day: 'any' };
// Which prompt is this? (json_schema is off, so the schema is written into the system prompt.)
function fakeModel(answers) {
  return async (body) => {
    const sys = body.messages[0].content;
    const kind = sys.includes('"is_scheduling_request"') ? 'trigger' : sys.includes('"accepted_option"') ? 'client'
      : sys.includes('"decision"') ? 'confirmation' : 'draft';
    const out = typeof answers[kind] === 'function' ? answers[kind](body) : answers[kind];
    return { choices: [{ message: { role: 'assistant', content: JSON.stringify(out) }, finish_reason: 'stop' }] };
  };
}

test('simulator: request → offers → client picks → you say yes → booked, all in memory', async () => {
  const w = makeWorld({ employeeName: 'Casey Cutshall', tz: 'America/New_York', thinking: 'off', jsonSchema: false });
  let pick = 2;
  const llm = fakeModel({
    trigger: { is_scheduling_request: true, duration_min: null, location: null, location_detail: null, constraints: NONE, topic: null },
    client: () => ({ intent: 'accept', accepted_option: pick, proposed_times: [], constraints: NONE, other_timezone: null, question: null, summary: 'picks' }),
    confirmation: { decision: 'yes', proposed_times: [], constraints: NONE },
    draft: (body) => ({ body: body.messages[1].content.includes('{{TIME}}') ? 'Great, {{TIME}} it is.' : 'Hi Dana, would one of these work?\n\n{{SLOTS}}' }),
  });
  const r1 = await turn(w, 'trigger', 'Sarah will find us a time.', llm);
  assert.equal(r1.state, 'PROPOSED');
  assert.equal(r1.offered, 3);
  const intro = r1.emails.find((e) => e.to === 'client');
  assert.equal(intro.source, 'model');
  assert.match(intro.body, /^Hi Dana, would one of these work\?\n\n1\. /);
  assert.match(intro.body, /Scheduling Assistant to Casey Cutshall \(AI\)/);

  const r2 = await turn(w, 'client', 'Option 2 works', llm);
  assert.equal(r2.state, 'AWAITING_VIC');
  assert.ok(r2.emails.some((e) => e.to === 'you' && /^Confirm:/.test(e.subject)));

  const r3 = await turn(w, 'me', 'yes', llm);
  assert.equal(r3.state, 'BOOKED');
  assert.ok(r3.emails.some((e) => e.to === 'client' && e.purpose === 'confirmed'));
  assert.ok(w.settings.llm_extra_body.chat_template_kwargs.enable_thinking === false);
});

test('simulator: several rounds keep numbering, and a rejected draft is redrafted', async () => {
  const w = makeWorld({ thinking: 'off', jsonSchema: false });
  let drafts = 0;
  const llm = fakeModel({
    trigger: { is_scheduling_request: true, duration_min: null, location: null, location_detail: null, constraints: NONE, topic: null },
    client: { intent: 'reject_all', accepted_option: null, proposed_times: [], constraints: NONE, other_timezone: null, question: null, summary: 'none' },
    draft: () => { drafts += 1; return { body: drafts === 2 ? 'How about Thursday? {{SLOTS}}' : 'No worries, Dana. Here are some more:\n\n{{SLOTS}}' }; },
  });
  await turn(w, 'trigger', 'Sarah will find us a time.', llm);
  const r = await turn(w, 'client', 'None of those work', llm);
  const e = r.emails.find((x) => x.to === 'client');
  assert.equal(e.purpose, 'new_round');
  assert.equal(e.source, 'model_retry');
  assert.match(e.body, /\n4\. /, 'round 2 numbers continue at 4');
  assert.equal(w.offers.filter((o) => o.status === 'offered').length, 3);
});
