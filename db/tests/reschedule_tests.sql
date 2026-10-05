-- =============================================================================
-- Rescheduling tests (db/005_reschedule.sql). One transaction, rolled back;
-- every line should start with PASS.
-- =============================================================================
BEGIN;
SET search_path = sched, public;
SET client_min_messages = warning;

CREATE TEMP TABLE results (n serial, line text);
CREATE FUNCTION pg_temp.ok(label text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO results (line) VALUES (CASE WHEN coalesce(cond, false) THEN 'PASS ' || label ELSE 'FAIL ' || label || ' ' || coalesce(detail, '') END);
END $$;

UPDATE employees SET enrolled = false WHERE id <> (SELECT min(id) FROM employees);
UPDATE employees SET upn = 'vic@bluzonebio.com', calendar_auth = 'app' WHERE id = (SELECT min(id) FROM employees);
UPDATE settings SET value = '"casey@bluzonebio.com"' WHERE key = 'alert_address';
SELECT set_mode('live');

SELECT pg_temp.ok('005: recorded', EXISTS (SELECT 1 FROM schema_migrations WHERE version = '005_reschedule'));

-- a booked meeting
CREATE TEMP TABLE b AS SELECT apply_plan(jsonb_build_object(
  'thread', jsonb_build_object(
    'create', jsonb_build_object('conversation_id', 'RS-1', 'employee_id', (SELECT min(id) FROM employees),
       'subject', 'Move me', 'client_addresses', '["dana@client.com"]'::jsonb, 'duration_min', 30,
       'location_type', 'teams', 'trigger_message_id', '<rs1@bzb>'),
    'set', '{"round_count":1}'::jsonb, 'transitions', '["PROPOSED"]'::jsonb),
  'offers', jsonb_build_object('insert', jsonb_build_array(
    jsonb_build_object('ref','o1','round',1,'option_no',1,'start','2027-03-02T14:00:00Z','end','2027-03-02T14:30:00Z','score',100))))) AS r;
UPDATE offers SET status = 'booked' WHERE thread_id = (SELECT id FROM threads WHERE conversation_id = 'RS-1');
UPDATE threads SET booked_event_id = 'EV-1', booked_at = now() WHERE conversation_id = 'RS-1';
UPDATE threads SET state = 'CLIENT_ACCEPTED' WHERE conversation_id = 'RS-1';
UPDATE threads SET state = 'AWAITING_VIC' WHERE conversation_id = 'RS-1';
UPDATE threads SET state = 'BOOKED' WHERE conversation_id = 'RS-1';

-- the client asks to move it: BOOKED → PROPOSED with new offers, booked event kept
SELECT apply_plan(jsonb_build_object(
  'thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'RS-1'),
    'set', '{"round_count":1}'::jsonb, 'transitions', '["PROPOSED"]'::jsonb),
  'offers', jsonb_build_object('insert', jsonb_build_array(
    jsonb_build_object('ref','o2','round',1,'option_no',2,'start','2027-03-03T15:00:00Z','end','2027-03-03T15:30:00Z','score',100)))));
SELECT pg_temp.ok('reschedule: BOOKED → PROPOSED is allowed and logged',
  (SELECT state = 'PROPOSED' AND booked_event_id = 'EV-1' FROM threads WHERE conversation_id = 'RS-1')
  AND EXISTS (SELECT 1 FROM thread_events e JOIN threads t ON t.id = e.thread_id
               WHERE t.conversation_id = 'RS-1' AND e.from_state = 'BOOKED' AND e.to_state = 'PROPOSED' AND e.note = 'client asked to reschedule'));

-- the client picks the new time, the employee says yes: the move is queued
UPDATE offers SET status = 'accepted' WHERE option_no = 2 AND thread_id = (SELECT id FROM threads WHERE conversation_id = 'RS-1');
UPDATE threads SET accepted_offer_id = (SELECT id FROM offers WHERE option_no = 2 AND thread_id = threads.id) WHERE conversation_id = 'RS-1';
UPDATE threads SET state = 'CLIENT_ACCEPTED' WHERE conversation_id = 'RS-1';
UPDATE threads SET state = 'AWAITING_VIC' WHERE conversation_id = 'RS-1';
UPDATE outbox SET status = 'done' WHERE status IN ('pending', 'approved');
SELECT apply_plan(jsonb_build_object(
  'thread', jsonb_build_object('id', (SELECT id FROM threads WHERE conversation_id = 'RS-1')),
  'outbox', jsonb_build_array(jsonb_build_object('ref', 'booking', 'kind', 'create_booking', 'purpose', 'reschedule', 'needs_approval', true,
    'offer_id', (SELECT id FROM offers WHERE option_no = 2 AND thread_id = (SELECT id FROM threads WHERE conversation_id = 'RS-1')),
    'payload', jsonb_build_object('employee_upn', 'vic@bluzonebio.com', 'move_event_id', 'EV-1', 'subject', 'Move me',
                                  'when_text', 'Wed Mar 3, 10:00 (moved from Tue Mar 2, 9:00)', 'attendees', '[]'::jsonb)))));
CREATE TEMP TABLE claimed AS SELECT * FROM outbox_claim(10) AS item;
SELECT pg_temp.ok('claim: the move is a calendar item with calendar_auth and move_event_id',
  (SELECT item->>'calendar_auth' = 'app' AND item->'payload'->>'move_event_id' = 'EV-1' FROM claimed WHERE item->>'kind' = 'create_booking'));
SELECT outbox_report(jsonb_build_object('id', (SELECT (item->>'id')::bigint FROM claimed WHERE item->>'kind' = 'create_booking'),
  'outcome', 'done', 'result', '{"event_id": "EV-1"}'::jsonb));
SELECT pg_temp.ok('move done: thread BOOKED again on the same event',
  (SELECT state = 'BOOKED' AND booked_event_id = 'EV-1' FROM threads WHERE conversation_id = 'RS-1'));
SELECT pg_temp.ok('move done: the new time is booked, the old one superseded',
  (SELECT string_agg(option_no || ':' || status, ',' ORDER BY option_no) FROM offers WHERE thread_id = (SELECT id FROM threads WHERE conversation_id = 'RS-1'))
  = '1:superseded,2:booked');

-- an ordinary booking is untouched by the wrapper
SELECT pg_temp.ok('outbox_report wraps 004 (kept as outbox_report_v004)',
  to_regprocedure('sched.outbox_report_v004(jsonb)') IS NOT NULL AND to_regprocedure('sched.outbox_report_base(jsonb)') IS NOT NULL);
SELECT pg_temp.ok('every sched function pins search_path; PUBLIC runs none',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'sched' AND p.prokind = 'f'
                 AND (NOT coalesce(p.proconfig::text[] @> ARRAY['search_path=sched, public'], false)
                      OR has_function_privilege('public', p.oid, 'EXECUTE'))));
SELECT pg_temp.ok('the portal role keeps its grants', has_function_privilege('sched_portal', 'sched.portal_config()', 'EXECUTE'));

SELECT line FROM results ORDER BY n;
ROLLBACK;
