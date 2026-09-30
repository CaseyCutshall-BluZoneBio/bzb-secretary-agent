'use strict';
// The bundle must behave exactly like src/ inside an n8n Code node, where
// Luxon's DateTime is a global and require() is unavailable.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const vm = require('vm');
const { DateTime, Interval, Duration } = require('luxon');
const { bundle } = require('../../scripts/bundle');
const { ctx, llm, NO_CONSTRAINTS } = require('./fixtures');

test('bundled lib runs a full trigger → plan without require()', () => {
  const code = bundle(path.join(__dirname, '../../src/index.js'));
  const sandbox = { DateTime, Interval, Duration, console, JSON, Math, Object, Array, Set, Map, String, Number, Error, RegExp, encodeURIComponent };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.lib = lib;`, sandbox);
  const lib = sandbox.lib;
  const c = JSON.parse(JSON.stringify(ctx()));
  let S = lib.decide.start(c);
  S = lib.decide.interpret(S, llm({ is_scheduling_request: true, duration_min: null, location: null, location_detail: null, constraints: NO_CONSTRAINTS, topic: null }));
  S = lib.decide.act(S, { value: [] });
  S = lib.decide.finish(S, llm({ body: 'Hi Dana, would any of these work?\n\n{{SLOTS}}' }));
  // (compare through JSON: objects built inside the vm have another realm's prototypes)
  const plan = JSON.parse(JSON.stringify(S.plan));
  assert.deepEqual(plan.thread.transitions, ['PROPOSED']);
  assert.equal(plan.offers.insert.length, 3);
  assert.equal(plan.outbox.find((o) => o.kind === 'reply').payload.draft_source, 'model');
});
