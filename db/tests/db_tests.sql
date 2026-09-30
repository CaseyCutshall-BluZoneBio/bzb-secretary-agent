-- =============================================================================
-- Database tests. Wrapped in a transaction and rolled back, so this is safe to
-- run against the real database after migrating:
--   psql -d sched_agent -t -A -f db/tests/db_tests.sql
-- Every line of output should start with PASS.
-- =============================================================================
BEGIN;
SET search_path = sched, public;

CREATE TEMP TABLE results (n serial, line text);

CREATE FUNCTION pg_temp.ok(label text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO results (line) VALUES (CASE WHEN cond THEN 'PASS ' || label ELSE 'FAIL ' || label || ' ' || coalesce(detail, '') END);
END $$;

CREATE FUNCTION pg_temp.expect_error(label text, stmt text, pattern text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  INSERT INTO results (line) VALUES ('FAIL ' || label || ' — succeeded, expected error');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO results (line) VALUES (CASE WHEN SQLERRM ~* pattern THEN 'PASS ' || label
                                          ELSE 'FAIL ' || label || ' — wrong error: ' || SQLERRM END);
END $$;

-- n8n connects with the default search_path, so every function must carry its own.
SELECT pg_temp.ok('every sched function pins search_path',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'sched' AND p.prokind = 'f'
                 AND NOT coalesce(p.proconfig::text[] @> ARRAY['search_path=sched, public'], false)));
SAVEPOINT default_path;
SET LOCAL search_path = public;
SELECT pg_temp.ok('functions + triggers work under the default search_path (as n8n calls them)',
  (sched.apply_plan(jsonb_build_object('thread', jsonb_build_object(
     'create', jsonb_build_object('conversation_id', 'SP-TEST', 'employee_id', (SELECT id FROM sched.employees LIMIT 1),
                                  'client_addresses', '["x@y.com"]'::jsonb, 'duration_min', 30, 'location_type', 'teams',
                                  'trigger_message_id', 't'),
     'transitions', '["PROPOSED"]'::jsonb)))->>'thread_id') IS NOT NULL);
ROLLBACK TO SAVEPOINT default_path;
SET LOCAL search_path = sched, public;

SELECT pg_temp.ok('seed: max_horizon_days defaults to 90',
  setting_int('max_horizon_days') = 90);

-- Isolate from whatever the real settings are
UPDATE settings SET value = '"sarah.johnson@bluzonebio.com"' WHERE key = 'sarah_upn';
UPDATE settings SET value = '"casey@bluzonebio.com"' WHERE key = 'alert_address';
UPDATE settings SET value = '"http://n8n.test"' WHERE key = 'n8n_base_url';
UPDATE settings SET value = to_jsonb(now() - interval '1 day') WHERE key = 'processing_start_at';
DELETE FROM employees WHERE upn <> 'vic@bluzonebio.com';
SELECT set_mode('live');

-- -----------------------------------------------------------------------------
-- leases
-- -----------------------------------------------------------------------------
SELECT pg_temp.ok('lease: first acquire succeeds', try_lease('t', 60));
SELECT pg_temp.ok('lease: second acquire blocked', NOT try_lease('t', 60));
SELECT release_lease('t');
SELECT pg_temp.ok('lease: acquire after release', try_lease('t', 60));

-- -----------------------------------------------------------------------------
-- ingest_message
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE ing AS SELECT ingest_message(jsonb_build_object(
  'internet_message_id', '<trig1@bzb>', 'graph_message_id', 'G-TRIG1', 'conversation_id', 'CONV-1',
  'from_address', 'Vic@BluZoneBio.com', 'from_name', 'Vic Suarez',
  'to_addresses', '["dana@client.com"]'::jsonb, 'cc_addresses', '["sarah.johnson@bluzonebio.com"]'::jsonb,
  'subject', 'Intro', 'body_text', 'Sarah will find us a time.',
  'headers', '{"auth_as":"Internal"}'::jsonb, 'event_at', now())) AS r;
SELECT pg_temp.ok('ingest: new message inserted and processable',
  (SELECT (r->>'inserted')::boolean AND (r->>'process')::boolean FROM ing));
SELECT pg_temp.ok('ingest: addresses lowercased',
  (SELECT from_address = 'vic@bluzonebio.com' FROM messages WHERE internet_message_id = '<trig1@bzb>'));
SELECT pg_temp.ok('ingest: redelivered but never-started message is handed over again',
  (ingest_message('{"internet_message_id":"<trig1@bzb>","event_at":"2026-01-01T00:00:00Z"}')->>'reason') = 'redelivered_unprocessed');
SELECT pg_temp.ok('ingest: mail from Sarah herself ignored',
  ingest_message(jsonb_build_object('internet_message_id', '<self@bzb>', 'from_address', 'sarah.johnson@bluzonebio.com',
                                    'event_at', now()))->>'reason' = 'ignored_self');
SELECT pg_temp.ok('ingest: mail before processing_start_at ignored',
  ingest_message(jsonb_build_object('internet_message_id', '<old@x>', 'from_address', 'a@x.com',
                                    'event_at', now() - interval '3 days'))->>'reason' = 'ignored_before_start');

-- -----------------------------------------------------------------------------
-- load_context + apply_plan: new trigger → thread in PROPOSED with 3 offers + holds
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE ctx AS SELECT load_context(jsonb_build_object('type', 'message',
  'message_id', (SELECT (r->>'id')::bigint FROM ing))) AS c;
SELECT pg_temp.ok('load_context: no thread matched yet', (SELECT c->'thread' = 'null'::jsonb FROM ctx));
SELECT pg_temp.ok('load_context: reply target is the trigger itself',
  (SELECT c->'reply_target'->>'graph_message_id' = 'G-TRIG1' FROM ctx));
SELECT pg_temp.ok('load_context: settings included', (SELECT c->'settings'->>'mode' = 'live' FROM ctx));
SELECT pg_temp.ok('load_context: marks processing started',
  (SELECT processing_started_at IS NOT NULL FROM messages WHERE internet_message_id = '<trig1@bzb>'));
SELECT pg_temp.ok('load_context: a second run on the same email is refused',
  load_context(jsonb_build_object('type', 'message', 'message_id', (SELECT (r->>'id')::bigint FROM ing)))->>'reason' = 'already in progress');
SELECT pg_temp.ok('ingest: once processing started, a duplicate is never processed twice',
  NOT (ingest_message('{"internet_message_id":"<trig1@bzb>","event_at":"2026-01-01T00:00:00Z"}')->>'process')::boolean);

CREATE TEMP TABLE ap AS SELECT apply_plan(jsonb_build_object(
  'message_id', (SELECT (r->>'id')::bigint FROM ing),
  'message', '{"disposition":"processed","classification":{"intent":"schedule"}}'::jsonb,
  'thread', jsonb_build_object(
    'create', jsonb_build_object('conversation_id', 'CONV-1', 'employee_id', (SELECT id FROM employees LIMIT 1),
       'subject', 'Intro', 'client_addresses', '["dana@client.com"]'::jsonb, 'duration_min', 30,
       'location_type', 'teams', 'trigger_message_id', '<trig1@bzb>'),
    'set', '{"round_count":1,"employee_moved_to_bcc":true}'::jsonb,
    'transitions', '["PROPOSED"]'::jsonb),
  'offers', jsonb_build_object('insert', jsonb_build_array(
    jsonb_build_object('ref','o1','round',1,'option_no',1,'start','2026-10-06T14:00:00Z','end','2026-10-06T14:30:00Z','score',100),
    jsonb_build_object('ref','o2','round',1,'option_no',2,'start','2026-10-07T14:00:00Z','end','2026-10-07T14:30:00Z','score',100),
    jsonb_build_object('ref','o3','round',1,'option_no',3,'start','2026-10-08T14:00:00Z','end','2026-10-08T14:30:00Z','score',60,'flags','["back_to_back_after"]'::jsonb))),
  'outbox', jsonb_build_array(
    jsonb_build_object('ref','m1','kind','reply','purpose','intro','needs_approval',true,
      'payload', '{"reply_to_graph_id":"G-TRIG1","to":[{"address":"dana@client.com","name":"Dana"}],"cc":[],"bcc":[{"address":"vic@bluzonebio.com","name":"Vic"}],"body_text":"Hi Dana","body_html":"<p>Hi Dana</p>"}'::jsonb),
    jsonb_build_object('ref','h1','kind','create_hold','purpose','hold','offer_ref','o1','payload','{"employee_upn":"vic@bluzonebio.com"}'::jsonb),
    jsonb_build_object('ref','h2','kind','create_hold','purpose','hold','offer_ref','o2','payload','{"employee_upn":"vic@bluzonebio.com"}'::jsonb),
    jsonb_build_object('ref','h3','kind','create_hold','purpose','hold','offer_ref','o3','payload','{"employee_upn":"vic@bluzonebio.com"}'::jsonb))
)) AS r;

SELECT pg_temp.ok('apply_plan: thread created and PROPOSED',
  (SELECT state = 'PROPOSED' AND round_count = 1 AND employee_moved_to_bcc FROM threads WHERE conversation_id = 'CONV-1'));
SELECT pg_temp.ok('apply_plan: 3 offers', (SELECT count(*) = 3 FROM offers));
SELECT pg_temp.ok('apply_plan: hold outbox rows linked to offers',
  (SELECT count(*) = 3 FROM outbox WHERE kind = 'create_hold' AND offer_id IS NOT NULL));
SELECT pg_temp.ok('apply_plan: message attached + processed',
  (SELECT thread_id IS NOT NULL AND processed_at IS NOT NULL FROM messages WHERE internet_message_id = '<trig1@bzb>'));
SELECT pg_temp.ok('apply_plan: transitions logged', (SELECT count(*) = 2 FROM thread_events));

-- A second thread whose offer overlaps must fail atomically (no half-created thread)
SELECT pg_temp.expect_error('apply_plan: overlapping offer in another thread rejected',
  $q$SELECT sched.apply_plan(jsonb_build_object(
      'thread', jsonb_build_object('create', jsonb_build_object('conversation_id', 'CONV-2',
         'employee_id', (SELECT id FROM sched.employees LIMIT 1), 'client_addresses', '["lee@other.com"]'::jsonb,
         'duration_min', 30, 'location_type', 'teams', 'trigger_message_id', '<t2>'),
         'transitions', '["PROPOSED"]'::jsonb),
      'offers', jsonb_build_object('insert', jsonb_build_array(
         jsonb_build_object('ref','x','round',1,'option_no',1,'start','2026-10-06T14:15:00Z','end','2026-10-06T14:45:00Z','score',100)))))$q$,
  'exclusion constraint');
SELECT pg_temp.ok('apply_plan: failed plan left nothing behind',
  NOT EXISTS (SELECT 1 FROM threads WHERE conversation_id = 'CONV-2'));

-- -----------------------------------------------------------------------------
-- outbox: live mode executes everything; report effects
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE cl AS SELECT outbox_claim(10) AS item;
SELECT pg_temp.ok('claim(live): all 4 items claimed with step full',
  (SELECT count(*) = 4 AND bool_and(item->>'step' = 'full') FROM cl));
SELECT pg_temp.ok('claim: config attached',
  (SELECT bool_and(item->'config'->>'sarah_upn' = 'sarah.johnson@bluzonebio.com') FROM cl));
SELECT pg_temp.ok('claim: nothing left to claim', (SELECT count(*) = 0 FROM outbox_claim(10)));

SELECT outbox_report(jsonb_build_object('id', (item->>'id')::bigint, 'outcome', 'done',
         'result', jsonb_build_object('event_id', 'HOLD-' || (item->>'offer_id'))))
  FROM cl WHERE item->>'kind' = 'create_hold';
SELECT pg_temp.ok('report: holds recorded on offers', (SELECT count(*) = 3 FROM offers WHERE hold_event_id LIKE 'HOLD-%'));

SELECT outbox_report(jsonb_build_object('id', (item->>'id')::bigint, 'outcome', 'done',
         'draft_graph_id', 'D-1', 'result', '{"conversation_id":"CONV-1"}'::jsonb))
  FROM cl WHERE item->>'kind' = 'reply';
SELECT pg_temp.ok('report: reply logged as outbound + last_outbound_at set',
  (SELECT count(*) = 1 FROM messages WHERE direction = 'out' AND disposition = 'sent:intro')
  AND (SELECT last_outbound_at IS NOT NULL FROM threads WHERE conversation_id = 'CONV-1'));
SELECT pg_temp.ok('report: stale report ignored',
  (outbox_report(jsonb_build_object('id', (SELECT (item->>'id')::bigint FROM cl WHERE item->>'kind' = 'reply'),
                                    'outcome', 'done'))->>'ignored')::boolean);

-- -----------------------------------------------------------------------------
-- client accepts option 2 → AWAITING_VIC → Vic YES → booking → BOOKED
-- -----------------------------------------------------------------------------
SELECT apply_plan(jsonb_build_object(
  'thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'CONV-1'),
    'set', jsonb_build_object('accepted_offer_id', (SELECT id FROM offers WHERE option_no = 2), 'touch_inbound', true),
    'transitions', '["CLIENT_ACCEPTED","AWAITING_VIC"]'::jsonb),
  'offers', jsonb_build_object('update', jsonb_build_array(
    jsonb_build_object('id', (SELECT id FROM offers WHERE option_no = 2), 'status', 'accepted'),
    jsonb_build_object('id', (SELECT id FROM offers WHERE option_no = 1), 'status', 'superseded'),
    jsonb_build_object('id', (SELECT id FROM offers WHERE option_no = 3), 'status', 'superseded'))),
  'outbox', jsonb_build_array(
    jsonb_build_object('kind','new_mail','purpose','vic_confirmation',
      'payload','{"to":[{"address":"vic@bluzonebio.com","name":"Vic"}],"subject":"Confirm [S-1]","body_text":"YES?","body_html":"YES?"}'::jsonb),
    jsonb_build_object('kind','delete_hold','purpose','hold','offer_id',(SELECT id FROM offers WHERE option_no = 1),'payload','{"employee_upn":"vic@bluzonebio.com"}'::jsonb),
    jsonb_build_object('kind','delete_hold','purpose','hold','offer_id',(SELECT id FROM offers WHERE option_no = 3),'payload','{"employee_upn":"vic@bluzonebio.com"}'::jsonb))));
SELECT pg_temp.ok('accept: AWAITING_VIC with accepted offer',
  (SELECT state = 'AWAITING_VIC' AND accepted_offer_id IS NOT NULL FROM threads WHERE conversation_id = 'CONV-1'));

DELETE FROM cl;
INSERT INTO cl SELECT outbox_claim(10);
SELECT pg_temp.ok('claim: delete_hold carries the event id',
  (SELECT bool_and(item->'payload'->>'event_id' LIKE 'HOLD-%') FROM cl WHERE item->>'kind' = 'delete_hold'));
SELECT outbox_report(jsonb_build_object('id', (item->>'id')::bigint, 'outcome', 'done',
         'result', '{"conversation_id":"CONV-VIC-1"}'::jsonb)) FROM cl WHERE item->>'purpose' = 'vic_confirmation';
SELECT outbox_report(jsonb_build_object('id', (item->>'id')::bigint, 'outcome', 'done')) FROM cl WHERE item->>'kind' = 'delete_hold';
SELECT pg_temp.ok('report: vic_conversation_id stored from confirmation email',
  (SELECT vic_conversation_id = 'CONV-VIC-1' FROM threads WHERE conversation_id = 'CONV-1'));
SELECT pg_temp.ok('report: released holds cleared', (SELECT count(*) = 1 FROM offers WHERE hold_event_id IS NOT NULL));

-- Vic's YES must match the thread through his confirmation conversation
INSERT INTO messages (direction, internet_message_id, graph_message_id, conversation_id, from_address, subject, body_text, event_at)
VALUES ('in', '<yes@bzb>', 'G-YES', 'CONV-VIC-1', 'vic@bluzonebio.com', 'RE: Confirm [S-1]', 'YES', now());
SELECT pg_temp.ok('match: Vic''s reply matched via confirmation conversation',
  (SELECT load_context(jsonb_build_object('type','message','message_id', id))->>'match_kind' = 'confirmation'
     FROM messages WHERE internet_message_id = '<yes@bzb>'));
SELECT pg_temp.ok('reply_target: never Vic''s confirmation thread',
  (SELECT load_context(jsonb_build_object('type','timer','action','x','thread_id', id))->'reply_target'->>'graph_message_id' = 'G-TRIG1'
     FROM threads WHERE conversation_id = 'CONV-1'));

SELECT apply_plan(jsonb_build_object(
  'message_id', (SELECT id FROM messages WHERE internet_message_id = '<yes@bzb>'),
  'thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'CONV-1')),
  'outbox', jsonb_build_array(
    jsonb_build_object('ref','b','kind','create_booking','purpose','booking','needs_approval',true,
      'offer_id',(SELECT id FROM offers WHERE option_no = 2),'payload','{"employee_upn":"vic@bluzonebio.com"}'::jsonb),
    jsonb_build_object('kind','reply','purpose','confirmed','depends_on_ref','b','needs_approval',true,
      'payload','{"reply_to_graph_id":"G-TRIG1","to":[{"address":"dana@client.com"}],"body_text":"All set"}'::jsonb),
    jsonb_build_object('kind','delete_hold','purpose','hold','depends_on_ref','b',
      'offer_id',(SELECT id FROM offers WHERE option_no = 2),'payload','{"employee_upn":"vic@bluzonebio.com"}'::jsonb))));

DELETE FROM cl;
INSERT INTO cl SELECT outbox_claim(10);
SELECT pg_temp.ok('depends_on: only the booking is claimable first', (SELECT count(*) = 1 AND bool_and(item->>'kind' = 'create_booking') FROM cl));
SELECT pg_temp.expect_error('report: booking without event id cannot mark BOOKED',
  format($q$SELECT sched.outbox_report('{"id": %s, "outcome": "done", "result": {}}')$q$, (SELECT item->>'id' FROM cl)),
  'check constraint');
SELECT outbox_report(jsonb_build_object('id', (SELECT (item->>'id')::bigint FROM cl), 'outcome', 'done',
                                        'result', '{"event_id":"EVT-REAL"}'::jsonb));
SELECT pg_temp.ok('report: booking → BOOKED with event id',
  (SELECT state = 'BOOKED' AND booked_event_id = 'EVT-REAL' FROM threads WHERE conversation_id = 'CONV-1'));
SELECT pg_temp.ok('report: offer marked booked', (SELECT status = 'booked' FROM offers WHERE option_no = 2));
SELECT pg_temp.ok('depends_on: confirmation + hold release now claimable', (SELECT count(*) = 2 FROM outbox_claim(10)));

-- -----------------------------------------------------------------------------
-- shadow mode: external mail becomes a draft + review email; approve / reject
-- -----------------------------------------------------------------------------
SELECT set_mode('shadow');
UPDATE outbox SET status = 'done' WHERE status = 'executing';
INSERT INTO threads (conversation_id, employee_id, client_addresses, duration_min, location_type, trigger_message_id)
VALUES ('CONV-3', (SELECT id FROM employees LIMIT 1), '{kim@c.com}', 30, 'teams', '<t3>');
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'CONV-3')),
  'outbox', jsonb_build_array(
    jsonb_build_object('kind','reply','purpose','intro','needs_approval',true,
      'payload','{"reply_to_graph_id":"G3","to":[{"address":"kim@c.com"}],"body_text":"Hello Kim"}'::jsonb),
    jsonb_build_object('kind','new_mail','purpose','vic_notice','needs_approval',false,
      'payload','{"to":[{"address":"vic@bluzonebio.com"}],"subject":"FYI","body_text":"fyi"}'::jsonb))));
DELETE FROM cl;
INSERT INTO cl SELECT outbox_claim(10) WHERE true;
SELECT pg_temp.ok('shadow: external reply → draft_only, internal notice → full',
  (SELECT item->>'step' FROM cl WHERE item->>'purpose' = 'intro') = 'draft_only'
  AND (SELECT item->>'step' FROM cl WHERE item->>'purpose' = 'vic_notice') = 'full');
SELECT outbox_report(jsonb_build_object('id', (item->>'id')::bigint, 'outcome', 'awaiting_approval', 'draft_graph_id', 'DRAFT-3'))
  FROM cl WHERE item->>'purpose' = 'intro';
SELECT pg_temp.ok('shadow: review email queued with approve link',
  (SELECT payload->>'body_text' LIKE '%http://n8n.test/webhook/sched-review?id=%&a=approve%'
     FROM outbox WHERE purpose = 'review'));
SELECT pg_temp.ok('review: bad token refused',
  NOT (outbox_review((SELECT id FROM outbox WHERE purpose = 'intro' AND thread_id = (SELECT id FROM threads WHERE conversation_id='CONV-3')),
                     'nope', 'approve')->>'ok')::boolean);
SELECT pg_temp.ok('review: approve',
  (outbox_review(o.id, o.approval_token, 'approve')->>'ok')::boolean)
  FROM outbox o WHERE o.purpose = 'intro' AND o.thread_id = (SELECT id FROM threads WHERE conversation_id='CONV-3');
SELECT pg_temp.ok('review: second click refused',
  NOT (outbox_review(o.id, o.approval_token, 'approve')->>'ok')::boolean)
  FROM outbox o WHERE o.purpose = 'intro' AND o.thread_id = (SELECT id FROM threads WHERE conversation_id='CONV-3');
UPDATE outbox SET status = 'done' WHERE status = 'executing';
SELECT pg_temp.ok('shadow: approved item comes back as send_draft with its draft id',
  (SELECT item->>'step' = 'send_draft' AND item->>'draft_graph_id' = 'DRAFT-3'
     FROM outbox_claim(10) item WHERE item->>'purpose' = 'intro'));

-- reject path
UPDATE threads SET state = 'PROPOSED' WHERE conversation_id = 'CONV-3';
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'CONV-3')),
  'outbox', jsonb_build_array(jsonb_build_object('kind','reply','purpose','new_round','needs_approval',true,
      'payload','{"reply_to_graph_id":"G3","to":[{"address":"kim@c.com"}],"body_text":"Round 2"}'::jsonb))));
SELECT outbox_report(jsonb_build_object('id', (item->>'id')::bigint, 'outcome', 'awaiting_approval', 'draft_graph_id', 'DRAFT-4'))
  FROM outbox_claim(10) item WHERE item->>'purpose' = 'new_round';
SELECT outbox_review(o.id, o.approval_token, 'reject') FROM outbox o WHERE o.purpose = 'new_round';
SELECT pg_temp.ok('review: reject → NEEDS_VIC with reason',
  (SELECT state = 'NEEDS_VIC' AND escalation_reason LIKE 'Rejected in shadow review%' FROM threads WHERE conversation_id = 'CONV-3'));

-- -----------------------------------------------------------------------------
-- failures: retries, then fail + escalate + cancel dependents
-- -----------------------------------------------------------------------------
SELECT set_mode('live');
UPDATE outbox SET status = 'done' WHERE status IN ('executing', 'pending');
INSERT INTO threads (conversation_id, employee_id, client_addresses, duration_min, location_type, trigger_message_id)
VALUES ('CONV-5', (SELECT id FROM employees LIMIT 1), '{pat@c.com}', 30, 'teams', '<t5>');
UPDATE threads SET state = 'PROPOSED' WHERE conversation_id = 'CONV-5';
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'CONV-5')),
  'outbox', jsonb_build_array(
    jsonb_build_object('ref','a','kind','reply','purpose','ack','payload','{"to":[{"address":"pat@c.com"}]}'::jsonb),
    jsonb_build_object('kind','reply','purpose','after_ack','depends_on_ref','a','payload','{"to":[{"address":"pat@c.com"}]}'::jsonb))));
SELECT outbox_report(jsonb_build_object('id', (item->>'id')::bigint, 'outcome', 'retry', 'error', 'HTTP 503'))
  FROM outbox_claim(10) item WHERE item->>'purpose' = 'ack';
SELECT pg_temp.ok('retry: back to pending with attempts = 1',
  (SELECT status = 'pending' AND attempts = 1 FROM outbox WHERE purpose = 'ack'));
SELECT outbox_report(jsonb_build_object('id', (item->>'id')::bigint, 'outcome', 'retry', 'error', 'HTTP 503'))
  FROM outbox_claim(10) item WHERE item->>'purpose' = 'ack';
SELECT outbox_report(jsonb_build_object('id', (item->>'id')::bigint, 'outcome', 'retry', 'error', 'HTTP 503'))
  FROM outbox_claim(10) item WHERE item->>'purpose' = 'ack';
SELECT pg_temp.ok('retry: fails after max attempts', (SELECT status = 'failed' FROM outbox WHERE purpose = 'ack'));
SELECT pg_temp.ok('fail: dependent cancelled', (SELECT status = 'cancelled' FROM outbox WHERE purpose = 'after_ack'));
SELECT pg_temp.ok('fail: thread escalated to NEEDS_VIC',
  (SELECT state = 'NEEDS_VIC' FROM threads WHERE conversation_id = 'CONV-5'));
SELECT pg_temp.ok('fail: alert queued for Casey',
  EXISTS (SELECT 1 FROM outbox WHERE purpose = 'alert' AND payload->'to'->0->>'address' = 'casey@bluzonebio.com'));

-- -----------------------------------------------------------------------------
-- delete_hold for a hold never created → cancels the create, no Graph call
-- -----------------------------------------------------------------------------
UPDATE outbox SET status = 'done' WHERE status IN ('pending', 'executing');
INSERT INTO threads (conversation_id, employee_id, client_addresses, duration_min, location_type, trigger_message_id)
VALUES ('CONV-6', (SELECT id FROM employees LIMIT 1), '{q@c.com}', 30, 'teams', '<t6>');
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'CONV-6')),
  'offers', '{"insert":[{"ref":"z","round":1,"option_no":1,"start":"2026-11-02T15:00:00Z","end":"2026-11-02T15:30:00Z","score":100}]}'::jsonb,
  'outbox', '[{"kind":"create_hold","purpose":"hold","offer_ref":"z","payload":{}},{"kind":"delete_hold","purpose":"hold","offer_ref":"z","payload":{}}]'::jsonb));
SELECT pg_temp.ok('delete_hold: nothing claimed for a never-created hold',
  (SELECT count(*) = 0 FROM outbox_claim(10) item WHERE item->>'kind' IN ('create_hold', 'delete_hold')));
SELECT pg_temp.ok('delete_hold: create cancelled, delete marked done (noop)',
  (SELECT string_agg(kind || ':' || status, ',' ORDER BY id) = 'create_hold:cancelled,delete_hold:done'
     FROM outbox WHERE thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-6')));

-- -----------------------------------------------------------------------------
-- timers
-- -----------------------------------------------------------------------------
UPDATE outbox SET status = 'done' WHERE status IN ('pending', 'executing', 'awaiting_approval', 'approved');
INSERT INTO threads (conversation_id, employee_id, client_addresses, duration_min, location_type, trigger_message_id)
VALUES ('CONV-7', (SELECT id FROM employees LIMIT 1), '{r@c.com}', 30, 'teams', '<t7>');
UPDATE threads SET state = 'PROPOSED', last_outbound_at = now() - interval '80 hours' WHERE conversation_id = 'CONV-7';
SELECT pg_temp.ok('timer: quiet client → client_followup',
  EXISTS (SELECT 1 FROM timer_events() e WHERE e->>'action' = 'client_followup'
            AND (e->>'thread_id')::bigint = (SELECT id FROM threads WHERE conversation_id = 'CONV-7')));
SELECT pg_temp.ok('timer: not re-emitted within the hour',
  NOT EXISTS (SELECT 1 FROM timer_events() e WHERE (e->>'thread_id')::bigint = (SELECT id FROM threads WHERE conversation_id = 'CONV-7')));
UPDATE threads SET followup_sent_at = now() - interval '73 hours', last_timer_at = NULL WHERE conversation_id = 'CONV-7';
SELECT pg_temp.ok('timer: still quiet after follow-up → mark_stalled',
  EXISTS (SELECT 1 FROM timer_events() e WHERE e->>'action' = 'mark_stalled'));

INSERT INTO threads (conversation_id, employee_id, client_addresses, duration_min, location_type, trigger_message_id)
VALUES ('CONV-8', (SELECT id FROM employees LIMIT 1), '{s@c.com}', 30, 'teams', '<t8>');
UPDATE threads SET state = 'PROPOSED' WHERE conversation_id = 'CONV-8';
UPDATE threads SET state = 'CLIENT_ACCEPTED' WHERE conversation_id = 'CONV-8';
UPDATE threads SET state = 'AWAITING_VIC', last_outbound_at = now() - interval '5 hours' WHERE conversation_id = 'CONV-8';
SELECT pg_temp.ok('timer: Vic silent → remind_vic', EXISTS (SELECT 1 FROM timer_events() e WHERE e->>'action' = 'remind_vic'));

-- sweeper: an email whose processing never finished escalates its thread
INSERT INTO messages (direction, internet_message_id, from_address, thread_id, processing_started_at)
VALUES ('in', '<stuck@c>', 'r@c.com', (SELECT id FROM threads WHERE conversation_id = 'CONV-8'), now() - interval '20 minutes');
SELECT count(*) FROM timer_events();
SELECT pg_temp.ok('sweeper: stuck email marked + thread escalated',
  (SELECT disposition = 'error_stuck' FROM messages WHERE internet_message_id = '<stuck@c>')
  AND (SELECT state = 'NEEDS_VIC' FROM threads WHERE conversation_id = 'CONV-8'));

-- holds: an old unanswered offer gets its hold released, once
INSERT INTO offers (thread_id, employee_id, round, option_no, slot, score, hold_event_id, created_at)
VALUES ((SELECT id FROM threads WHERE conversation_id = 'CONV-7'), (SELECT id FROM employees LIMIT 1), 1, 1,
        tstzrange(now() + interval '3 days', now() + interval '3 days 30 minutes', '[)'), 100, 'HOLD-OLD', now() - interval '50 hours');
SELECT count(*) FROM timer_events();
SELECT count(*) FROM timer_events();
SELECT pg_temp.ok('holds: expired hold released exactly once',
  (SELECT count(*) = 1 FROM outbox o JOIN offers f ON f.id = o.offer_id
    WHERE o.kind = 'delete_hold' AND f.hold_event_id = 'HOLD-OLD'));

-- a thread closed by hand stops blocking slots on the next timer run
INSERT INTO threads (conversation_id, employee_id, client_addresses, duration_min, location_type, trigger_message_id)
VALUES ('CONV-9', (SELECT id FROM employees LIMIT 1), '{z@c.com}', 30, 'teams', '<t9>');
INSERT INTO offers (thread_id, employee_id, round, option_no, slot, score)
VALUES ((SELECT id FROM threads WHERE conversation_id = 'CONV-9'), (SELECT id FROM employees LIMIT 1), 1, 1,
        tstzrange(now() + interval '5 days', now() + interval '5 days 30 minutes', '[)'), 100);
UPDATE threads SET closed_reason = 'closed by Casey' WHERE conversation_id = 'CONV-9';
UPDATE threads SET state = 'CLOSED' WHERE conversation_id = 'CONV-9';
SELECT count(*) FROM timer_events();
SELECT pg_temp.ok('closed thread: its offers are expired by the timer',
  (SELECT bool_and(status = 'expired') FROM offers WHERE thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-9')));

-- -----------------------------------------------------------------------------
-- review fixes
-- -----------------------------------------------------------------------------
UPDATE outbox SET status = 'done' WHERE status IN ('pending', 'executing', 'awaiting_approval', 'approved');
INSERT INTO threads (conversation_id, employee_id, client_addresses, duration_min, location_type, trigger_message_id)
VALUES ('CONV-R', (SELECT id FROM employees LIMIT 1), '{dana@r.com}', 30, 'teams', '<trigR@bzb>');
UPDATE threads SET state = 'PROPOSED', last_outbound_at = now() WHERE conversation_id = 'CONV-R';
INSERT INTO messages (direction, internet_message_id, graph_message_id, conversation_id, thread_id, from_address, event_at, processed_at, disposition) VALUES
  ('in', '<trigR@bzb>', 'G-R-TRIG',   'CONV-R', (SELECT id FROM threads WHERE conversation_id = 'CONV-R'), 'vic@bluzonebio.com', now() - interval '3 hours', now(), 'processed'),
  ('in', '<r-client@r>', 'G-R-CLIENT', 'CONV-R', (SELECT id FROM threads WHERE conversation_id = 'CONV-R'), 'dana@r.com',        now() - interval '2 hours', now(), 'processed'),
  ('in', '<r-vic@bzb>', 'G-R-VICNOTE', 'CONV-R', (SELECT id FROM threads WHERE conversation_id = 'CONV-R'), 'vic@bluzonebio.com', now() - interval '1 hour',  now(), 'employee_note'),
  ('in', '<r-ooo@r>',   'G-R-OOO',     'CONV-R', (SELECT id FROM threads WHERE conversation_id = 'CONV-R'), 'dana@r.com',        now() - interval '30 minutes', now(), 'ignored_autoreply');
SELECT pg_temp.ok('reply_target: a later private note from Vic (or an auto-reply) is never quoted to the client',
  (SELECT load_context(jsonb_build_object('type','timer','action','x','thread_id', id))->'reply_target'->>'graph_message_id' = 'G-R-CLIENT'
     FROM threads WHERE conversation_id = 'CONV-R'));

-- crash mid-processing: the email is attached to its thread at load time, so the sweeper escalates THAT thread
INSERT INTO messages (direction, internet_message_id, graph_message_id, conversation_id, from_address, event_at)
VALUES ('in', '<r-crash@r>', 'G-R-CRASH', 'CONV-R', 'dana@r.com', now());
SELECT load_context(jsonb_build_object('type','message','message_id', (SELECT id FROM messages WHERE internet_message_id = '<r-crash@r>')));
SELECT pg_temp.ok('load_context: attaches the email to its thread immediately',
  (SELECT thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-R') FROM messages WHERE internet_message_id = '<r-crash@r>'));
SELECT pg_temp.ok('timers: no follow-up while an email on the thread is still undecided',
  NOT EXISTS (SELECT 1 FROM timer_events() e WHERE (e->>'thread_id')::bigint = (SELECT id FROM threads WHERE conversation_id = 'CONV-R')));
UPDATE messages SET processing_started_at = now() - interval '20 minutes' WHERE internet_message_id = '<r-crash@r>';
SELECT count(*) FROM timer_events();
SELECT pg_temp.ok('sweeper: the crashed email escalates its thread (no silent follow-up later)',
  (SELECT state = 'NEEDS_VIC' FROM threads WHERE conversation_id = 'CONV-R'));

-- optimistic concurrency
INSERT INTO threads (conversation_id, employee_id, client_addresses, duration_min, location_type, trigger_message_id)
VALUES ('CONV-V', (SELECT id FROM employees LIMIT 1), '{v@v.com}', 30, 'teams', '<tV>');
UPDATE threads SET state = 'PROPOSED' WHERE conversation_id = 'CONV-V';
INSERT INTO messages (direction, internet_message_id, from_address, conversation_id, processing_started_at, created_at)
VALUES ('in', '<v-late@v>', 'v@v.com', 'CONV-V', now(), now() - interval '5 minutes');
SELECT pg_temp.ok('apply_plan: a plan decided on an old version is refused',
  (apply_plan(jsonb_build_object('message_id', (SELECT id FROM messages WHERE internet_message_id = '<v-late@v>'),
     'thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'CONV-V'),
                                  'expected_plan_version', (SELECT plan_version - 1 FROM threads WHERE conversation_id = 'CONV-V'),
                                  'transitions', '["STALLED"]'::jsonb)))->>'stale')::boolean
  AND (SELECT state = 'PROPOSED' FROM threads WHERE conversation_id = 'CONV-V'));
SELECT pg_temp.ok('stale plan: the email is put back and re-dispatched by the timers',
  EXISTS (SELECT 1 FROM timer_events() e WHERE e->>'type' = 'message'
            AND (e->>'message_id')::bigint = (SELECT id FROM messages WHERE internet_message_id = '<v-late@v>')));
SELECT pg_temp.ok('apply_plan: a plan on the current version applies',
  (SELECT NOT (apply_plan(jsonb_build_object('thread', jsonb_build_object('id', id, 'expected_plan_version', plan_version))) ? 'stale')
     FROM threads WHERE conversation_id = 'CONV-V'));
SELECT pg_temp.ok('apply_plan: ...and bumps the version',
  (SELECT plan_version = 2 FROM threads WHERE conversation_id = 'CONV-V'));

-- escalation cancels queued client-facing work (e.g. a booking waiting for approval)
SELECT set_mode('shadow');
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'CONV-V')),
  'outbox', '[{"ref":"b","kind":"create_booking","purpose":"booking","needs_approval":true,"payload":{}},
              {"kind":"reply","purpose":"confirmed","depends_on_ref":"b","needs_approval":true,"payload":{"to":[]}},
              {"kind":"new_mail","purpose":"vic_notice","payload":{"to":[]}}]'::jsonb));
SELECT apply_plan(jsonb_build_object('cancel_open_client_outbox', true,
  'thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'CONV-V'),
                               'set', '{"escalation_reason":"client asked a question"}'::jsonb, 'transitions', '["NEEDS_VIC"]'::jsonb)));
SELECT pg_temp.ok('escalate: queued booking + its dependent reply cancelled; internal notice kept',
  (SELECT string_agg(purpose || ':' || status, ',' ORDER BY id) FROM outbox
    WHERE thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-V'))
  = 'booking:cancelled,confirmed:cancelled,vic_notice:pending');
SELECT set_mode('live');

-- a booking that completes after the thread moved on: kept, not marked BOOKED, Casey alerted
INSERT INTO outbox (thread_id, kind, purpose, payload, status, claimed_from)
VALUES ((SELECT id FROM threads WHERE conversation_id = 'CONV-V'), 'create_booking', 'booking', '{}', 'executing', 'pending');
SELECT outbox_report(jsonb_build_object('id', (SELECT max(id) FROM outbox WHERE purpose = 'booking'), 'outcome', 'done', 'result', '{"event_id":"LATE-EVT"}'::jsonb));
SELECT pg_temp.ok('late booking on an escalated thread: stays NEEDS_VIC, event id kept, alert queued',
  (SELECT state = 'NEEDS_VIC' AND booked_event_id = 'LATE-EVT' FROM threads WHERE conversation_id = 'CONV-V')
  AND EXISTS (SELECT 1 FROM outbox WHERE purpose = 'alert' AND payload->>'subject' LIKE '%Booking created on a NEEDS_VIC thread%'));

-- offers on an escalated thread stop blocking slots
INSERT INTO offers (thread_id, employee_id, round, option_no, slot, score)
VALUES ((SELECT id FROM threads WHERE conversation_id = 'CONV-V'), (SELECT id FROM employees LIMIT 1), 1, 1,
        tstzrange(now() + interval '6 days', now() + interval '6 days 30 minutes', '[)'), 100);
SELECT count(*) FROM timer_events();
SELECT pg_temp.ok('NEEDS_VIC thread: its offers are expired by the timer',
  (SELECT bool_and(status = 'expired') FROM offers WHERE thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-V')));

-- shadow items waiting for approval too long are cancelled, not sent stale
SELECT set_mode('shadow');
INSERT INTO threads (conversation_id, employee_id, client_addresses, duration_min, location_type, trigger_message_id)
VALUES ('CONV-A', (SELECT id FROM employees LIMIT 1), '{a@a.com}', 30, 'teams', '<tA>');
UPDATE threads SET state = 'PROPOSED' WHERE conversation_id = 'CONV-A';
INSERT INTO outbox (thread_id, kind, purpose, payload, status, needs_approval, approval_token, created_at)
VALUES ((SELECT id FROM threads WHERE conversation_id = 'CONV-A'), 'reply', 'intro', '{}', 'awaiting_approval', true, 'tok', now() - interval '30 hours');
SELECT count(*) FROM timer_events();
SELECT pg_temp.ok('approval expiry: an unreviewed draft older than max age is cancelled and the thread escalated',
  (SELECT status = 'cancelled' FROM outbox WHERE approval_token = 'tok')
  AND (SELECT state = 'NEEDS_VIC' FROM threads WHERE conversation_id = 'CONV-A'));

-- a new request in a finished conversation may create a new thread there; an active one blocks it
SELECT pg_temp.ok('conversation reuse: a new thread in the conversation of a BOOKED one is allowed',
  (apply_plan(jsonb_build_object('thread', jsonb_build_object('create', jsonb_build_object('conversation_id', 'CONV-1',
     'employee_id', (SELECT id FROM employees LIMIT 1), 'client_addresses', '["dana@client.com"]'::jsonb, 'duration_min', 30,
     'location_type', 'teams', 'trigger_message_id', '<again>'))))->>'thread_id') IS NOT NULL);
SELECT pg_temp.ok('conversation reuse: matching picks the newest thread in the conversation',
  (SELECT (match_thread(m)).thread_id = (SELECT max(id) FROM threads WHERE conversation_id = 'CONV-1')
     FROM messages m WHERE internet_message_id = '<trig1@bzb>'));
SELECT pg_temp.expect_error('conversation reuse: two ACTIVE threads in one conversation are refused',
  $q$SELECT sched.apply_plan(jsonb_build_object('thread', jsonb_build_object('create', jsonb_build_object('conversation_id', 'CONV-1',
     'employee_id', (SELECT id FROM sched.employees LIMIT 1), 'client_addresses', '["x@x.com"]'::jsonb, 'duration_min', 30,
     'location_type', 'teams', 'trigger_message_id', '<again2>'))))$q$, 'duplicate key');

-- going live closes whatever dry_run created
SELECT set_mode('dry_run');
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object('create', jsonb_build_object('conversation_id', 'CONV-DRY',
   'employee_id', (SELECT id FROM employees LIMIT 1), 'client_addresses', '["d@d.com"]'::jsonb, 'duration_min', 30,
   'location_type', 'teams', 'trigger_message_id', '<dry>'), 'transitions', '["PROPOSED"]'::jsonb),
   'offers', jsonb_build_object('insert', jsonb_build_array(jsonb_build_object('ref','d','round',1,'option_no',1,
      'start', now() + interval '8 days', 'end', now() + interval '8 days 30 minutes', 'score', 100)))));
SELECT set_mode('shadow');
SELECT pg_temp.ok('go-live: threads created in dry_run are closed and their offers expired',
  (SELECT state = 'CLOSED' AND closed_reason = 'created in dry_run' FROM threads WHERE conversation_id = 'CONV-DRY')
  AND (SELECT bool_and(status = 'expired') FROM offers WHERE thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-DRY')));
SELECT set_mode('live');

-- -----------------------------------------------------------------------------
-- state machine (carried over from v1)
-- -----------------------------------------------------------------------------
SELECT pg_temp.expect_error('state: cannot insert a thread in PROPOSED',
  $q$INSERT INTO sched.threads (conversation_id, employee_id, state, client_addresses, duration_min, location_type, trigger_message_id)
     SELECT 'X', id, 'PROPOSED', '{x@x.com}', 30, 'teams', 't' FROM sched.employees LIMIT 1$q$, 'must start in NEW');
SELECT pg_temp.expect_error('state: BOOKED → PROPOSED blocked',
  $q$UPDATE sched.threads SET state = 'PROPOSED' WHERE conversation_id = 'CONV-1'$q$, 'illegal thread transition');
SELECT pg_temp.expect_error('state: NEEDS_VIC requires a reason',
  $q$UPDATE sched.threads SET state = 'NEEDS_VIC', escalation_reason = NULL WHERE conversation_id = 'CONV-7'$q$, 'check constraint');

-- -----------------------------------------------------------------------------
-- modes: dry_run records but never executes; off does nothing at all
-- -----------------------------------------------------------------------------
SELECT set_mode('dry_run');
SELECT pg_temp.ok('dry_run: outbox rows start skipped',
  (apply_plan('{"outbox":[{"kind":"notify_internal","purpose":"x","no_thread":true,"payload":{}}]}')->>'outbox_status') = 'skipped');
SELECT pg_temp.ok('dry_run: executor claims nothing', (SELECT count(*) = 0 FROM outbox_claim(10)));
SELECT set_mode('off');
SELECT pg_temp.ok('off: timers do nothing', (SELECT count(*) = 0 FROM timer_events()));
SELECT pg_temp.expect_error('set_mode: rejects unknown modes', $q$SELECT sched.set_mode('turbo')$q$, 'mode must be');

SELECT line FROM results ORDER BY n;
ROLLBACK;
