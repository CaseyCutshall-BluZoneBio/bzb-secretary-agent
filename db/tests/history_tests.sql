-- =============================================================================
-- Thread history tests (db/006_thread_history.sql). One transaction, rolled
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

UPDATE employees SET enrolled = false WHERE id <> (SELECT min(id) FROM employees);
UPDATE employees SET upn = 'vic@bluzonebio.com', calendar_auth = 'app' WHERE id = (SELECT min(id) FROM employees);

SELECT pg_temp.ok('006: recorded', EXISTS (SELECT 1 FROM schema_migrations WHERE version = '006_thread_history'));

SELECT apply_plan(jsonb_build_object('thread', jsonb_build_object(
  'create', jsonb_build_object('conversation_id', 'HI-1', 'employee_id', (SELECT min(id) FROM employees),
     'subject', 'Intro', 'client_addresses', '["dana@client.com"]'::jsonb, 'duration_min', 30,
     'location_type', 'teams', 'trigger_message_id', '<hi1@bzb>'),
  'set', '{"round_count":1}'::jsonb, 'transitions', '["PROPOSED"]'::jsonb)));
UPDATE threads SET vic_conversation_id = 'HI-VIC' WHERE conversation_id = 'HI-1';

INSERT INTO messages (direction, internet_message_id, conversation_id, thread_id, from_address, to_addresses, subject, body_text, event_at, disposition)
SELECT d, i, c, (SELECT id FROM threads WHERE conversation_id = 'HI-1'), f, a, s, b, now() + (o * interval '1 minute'), p
FROM (VALUES
  ('in'::msg_direction,  '<hi1@bzb>',  'HI-1',   'vic@bluzonebio.com',   ARRAY['dana@client.com'],     'Intro',           'TRIGGER TEXT',     1, 'processed'),
  ('out'::msg_direction, NULL,         'HI-1',   'sarah@bluzonebio.com', ARRAY['dana@client.com'],     'RE: Intro',       'SARAH TO CLIENT',  2, 'sent:intro'),
  ('in'::msg_direction,  '<hi2@c>',    'HI-1',   'dana@client.com',      ARRAY['sarah@bluzonebio.com'],'RE: Intro',       'CLIENT REPLY',     3, 'processed'),
  ('out'::msg_direction, NULL,         'HI-VIC', 'sarah@bluzonebio.com', ARRAY['vic@bluzonebio.com'],  'Confirm [S-1]',   'SARAH TO VIC',     4, 'sent:vic_confirmation'),
  ('in'::msg_direction,  '<hi3@bzb>',  'HI-VIC', 'vic@bluzonebio.com',   ARRAY['sarah@bluzonebio.com'],'RE: Confirm [S-1]','PRIVATE FROM VIC', 5, 'processed'),
  ('in'::msg_direction,  '<hi4@bzb>',  'HI-1',   'vic@bluzonebio.com',   ARRAY['sarah@bluzonebio.com'],'RE: Intro',       'INTERNAL NOTE',    6, 'employee_note'),
  ('in'::msg_direction,  '<hi5@c>',    'HI-1',   'dana@client.com',      ARRAY['sarah@bluzonebio.com'],'Out of office',   'AUTO REPLY',       7, 'ignored_autoreply')
) v(d, i, c, f, a, s, b, o, p);

CREATE TEMP TABLE h AS SELECT load_context(jsonb_build_object('type', 'timer', 'action', 'x',
  'thread_id', (SELECT id FROM threads WHERE conversation_id = 'HI-1')))->'history' AS j;

SELECT pg_temp.ok('history: what the client saw, oldest first',
  (SELECT jsonb_agg(e->>'body') FROM h, jsonb_array_elements(j) e) = '["TRIGGER TEXT", "SARAH TO CLIENT", "CLIENT REPLY"]'::jsonb,
  (SELECT j::text FROM h));
SELECT pg_temp.ok('history: never the confirmation thread or internal notes',
  (SELECT j::text !~ 'PRIVATE|SARAH TO VIC|INTERNAL NOTE|AUTO REPLY' FROM h));

-- A message event: the current email is passed separately, not repeated.
INSERT INTO messages (direction, internet_message_id, conversation_id, from_address, to_addresses, subject, body_text, event_at)
VALUES ('in', '<hi6@c>', 'HI-1', 'dana@client.com', ARRAY['sarah@bluzonebio.com'], 'RE: Intro', 'CURRENT EMAIL', now() + interval '1 hour');
SELECT pg_temp.ok('history: leaves out the email being processed',
  (load_context(jsonb_build_object('type', 'message', 'message_id', (SELECT id FROM messages WHERE internet_message_id = '<hi6@c>')))->'history')::text !~ 'CURRENT EMAIL');

SELECT pg_temp.ok('load_context: search_path still pinned',
  (SELECT proconfig IS NOT NULL FROM pg_proc WHERE proname = 'load_context' AND pronamespace = 'sched'::regnamespace));

SELECT line FROM results ORDER BY n;
ROLLBACK;
