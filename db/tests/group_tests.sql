-- =============================================================================
-- Group meeting tests (db/007_group_meetings.sql). One transaction, rolled
-- back; every line should start with PASS.
-- =============================================================================
BEGIN;
SET search_path = sched, public;
SET client_min_messages = warning;

CREATE TEMP TABLE results (n serial, line text);
CREATE FUNCTION pg_temp.ok(label text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO results (line) VALUES (CASE WHEN coalesce(cond, false) THEN 'PASS ' || label ELSE 'FAIL ' || label || ' ' || coalesce(detail, '') END);
END $$;

SELECT pg_temp.ok('007: recorded', EXISTS (SELECT 1 FROM schema_migrations WHERE version = '007_group_meetings'));

-- Create: responders are stored with the thread.
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object(
  'create', jsonb_build_object('conversation_id', 'GR-1', 'employee_id', (SELECT min(id) FROM employees),
     'subject', 'Intro', 'client_addresses', '["dana@client.com","raj@client.com"]'::jsonb,
     'responders', '["dana@client.com","raj@client.com"]'::jsonb, 'duration_min', 30,
     'location_type', 'teams', 'trigger_message_id', '<gr1@bzb>'),
  'set', '{"round_count":1}'::jsonb, 'transitions', '["PROPOSED"]'::jsonb)));
SELECT pg_temp.ok('create: responders stored',
  (SELECT responders = ARRAY['dana@client.com','raj@client.com'] AND responses = '{}'::jsonb FROM threads WHERE conversation_id = 'GR-1'));

-- Set: one person's answer is stored; other fields still apply.
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object(
  'id', (SELECT id FROM threads WHERE conversation_id = 'GR-1'),
  'set', jsonb_build_object('round_count', 2,
     'responses', '{"dana@client.com":{"starts":["2026-10-06T14:00:00Z"],"at":"x"}}'::jsonb))));
SELECT pg_temp.ok('set: responses stored',
  (SELECT responses ? 'dana@client.com' AND round_count = 2 FROM threads WHERE conversation_id = 'GR-1'));

-- A plan without responses leaves them alone; an empty object clears them.
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object(
  'id', (SELECT id FROM threads WHERE conversation_id = 'GR-1'), 'set', '{"round_count":3}'::jsonb)));
SELECT pg_temp.ok('set without responses: kept',
  (SELECT responses ? 'dana@client.com' FROM threads WHERE conversation_id = 'GR-1'));
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object(
  'id', (SELECT id FROM threads WHERE conversation_id = 'GR-1'), 'set', '{"responses":{}}'::jsonb)));
SELECT pg_temp.ok('set responses {}: cleared',
  (SELECT responses = '{}'::jsonb FROM threads WHERE conversation_id = 'GR-1'));

-- A stale plan changes nothing.
SELECT pg_temp.ok('stale plan: refused, responses untouched',
  (apply_plan(jsonb_build_object('thread', jsonb_build_object(
     'id', (SELECT id FROM threads WHERE conversation_id = 'GR-1'), 'expected_plan_version', -1,
     'set', '{"responses":{"raj@client.com":{"starts":[]}}}'::jsonb)))->>'stale')::boolean
  AND (SELECT responses = '{}'::jsonb FROM threads WHERE conversation_id = 'GR-1'));

-- Older threads (no responders) load as before.
SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object(
  'create', jsonb_build_object('conversation_id', 'GR-2', 'employee_id', (SELECT min(id) FROM employees),
     'subject', 'Old', 'client_addresses', '["solo@client.com"]'::jsonb, 'duration_min', 30,
     'location_type', 'teams', 'trigger_message_id', '<gr2@bzb>'))));
SELECT pg_temp.ok('no responders: empty array',
  (SELECT responders = '{}' FROM threads WHERE conversation_id = 'GR-2'));
SELECT pg_temp.ok('load_context: carries responders and responses',
  (load_context(jsonb_build_object('type', 'timer', 'action', 'x',
     'thread_id', (SELECT id FROM threads WHERE conversation_id = 'GR-1')))->'thread') ?& ARRAY['responders', 'responses']);

SELECT pg_temp.ok('apply_plan: search_path pinned, PUBLIC cannot run it',
  (SELECT proconfig IS NOT NULL AND NOT has_function_privilege('public', oid, 'EXECUTE')
     FROM pg_proc WHERE proname = 'apply_plan' AND pronamespace = 'sched'::regnamespace));

SELECT line FROM results ORDER BY n;
ROLLBACK;
