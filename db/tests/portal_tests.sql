-- =============================================================================
-- Portal / delegated-calendar tests (db/004_portal.sql). Same harness as
-- db_tests.sql: one transaction, rolled back; every line should start with PASS.
--   psql -d sched_agent -t -A -f db/tests/portal_tests.sql
-- =============================================================================
BEGIN;
SET search_path = sched, public;
SET client_min_messages = warning;

CREATE TEMP TABLE results (n serial, line text);
CREATE FUNCTION pg_temp.ok(label text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO results (line) VALUES (CASE WHEN coalesce(cond, false) THEN 'PASS ' || label ELSE 'FAIL ' || label || ' ' || coalesce(detail, '') END);
END $$;
CREATE FUNCTION pg_temp.expect_error(label text, stmt text, pattern text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  INSERT INTO results (line) VALUES ('FAIL ' || label || ' — succeeded, expected error');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO results (line) VALUES (CASE WHEN SQLERRM ~* pattern THEN 'PASS ' || label
                                          ELSE 'FAIL ' || label || ' — wrong error: ' || SQLERRM END);
END $$;

UPDATE settings SET value = '"sarah.johnson@bluzonebio.com"' WHERE key = 'sarah_upn';
UPDATE settings SET value = '"casey@bluzonebio.com"' WHERE key = 'alert_address';
UPDATE settings SET value = '"https://portal.test:8443"' WHERE key = 'portal_base_url';
-- Put the seeded employee (the lowest id) back in its just-migrated state,
-- under the fixtures' address, whatever has happened since (real address,
-- portal sign-in, connected calendar). Anyone else is switched off, not
-- deleted. All of this is rolled back.
UPDATE employees SET enrolled = false WHERE id <> (SELECT min(id) FROM employees);
UPDATE employees SET upn = 'vic@bluzonebio.com', mail = NULL, aad_object_id = NULL, calendar_auth = 'app',
       calendar_connected_at = NULL, paused = false, needs_reconnect = false, reconnect_reason = NULL
 WHERE id = (SELECT min(id) FROM employees);
CREATE TEMP TABLE before_count AS SELECT count(*) AS n FROM employees;
SELECT set_mode('live');

-- -----------------------------------------------------------------------------
-- upgrade in place
-- -----------------------------------------------------------------------------
SELECT pg_temp.ok('004: recorded in schema_migrations (with 001–003)',
  (SELECT count(*) = 4 FROM schema_migrations WHERE version IN ('001_schema', '002_functions', '003_seed', '004_portal')));
SELECT pg_temp.ok('004: Vic''s existing row keeps the app-only calendar path',
  (SELECT calendar_auth = 'app' AND NOT paused AND NOT needs_reconnect FROM employees WHERE upn = 'vic@bluzonebio.com'));
SELECT pg_temp.ok('004: Vic gets a per-employee signature line naming him',
  (SELECT signature_title = 'Scheduling Assistant to ' || display_name || ' (AI)' FROM employees WHERE upn = 'vic@bluzonebio.com'));
SELECT pg_temp.ok('004: portal settings seeded',
  setting_text('portal_internal_url') = 'http://sarah-portal:3001' AND setting('portal_admins') = '[]'::jsonb);
SELECT pg_temp.ok('004: the originals are kept as *_base and wrapped',
  to_regprocedure('sched.outbox_claim_base(integer)') IS NOT NULL AND to_regprocedure('sched.outbox_report_base(jsonb)') IS NOT NULL);
SELECT pg_temp.ok('004: every sched function (new ones too) pins search_path',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'sched' AND p.prokind = 'f'
                 AND NOT coalesce(p.proconfig::text[] @> ARRAY['search_path=sched, public'], false)));

-- -----------------------------------------------------------------------------
-- least privilege: the portal role runs portal_* functions and nothing else
-- -----------------------------------------------------------------------------
SELECT pg_temp.ok('grants: portal role can run the portal functions',
  has_function_privilege('sched_portal', 'sched.portal_config()', 'EXECUTE')
  AND has_function_privilege('sched_portal', 'sched.portal_mark_reconnect(integer, text, boolean)', 'EXECUTE'));
SELECT pg_temp.ok('grants: portal role cannot read tables or call the workflow functions',
  NOT has_table_privilege('sched_portal', 'sched.employees', 'SELECT')
  AND NOT has_table_privilege('sched_portal', 'sched.portal_tokens', 'SELECT')
  AND NOT has_function_privilege('sched_portal', 'sched.apply_plan(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('sched_portal', 'sched.outbox_claim(integer)', 'EXECUTE'));
SELECT pg_temp.ok('grants: PUBLIC cannot run portal functions',
  NOT has_function_privilege('public', 'sched.portal_token_get(integer)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'sched.portal_sign_in(jsonb)', 'EXECUTE'));

-- -----------------------------------------------------------------------------
-- sign-in
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE vic AS SELECT portal_sign_in('{"aad_object_id":"oid-vic","upn":"Vic@BluZoneBio.com","mail":"vic@bluzonebio.com","display_name":"Vic Suarez"}') AS e;
SELECT pg_temp.ok('sign-in: attaches to Vic''s legacy row by UPN (no duplicate)',
  (SELECT (e->>'id')::int FROM vic) = (SELECT id FROM employees WHERE upn = 'vic@bluzonebio.com')
  AND (SELECT count(*) FROM employees) = (SELECT n FROM before_count));
SELECT pg_temp.ok('sign-in: Vic stays on app-only until he connects his calendar',
  (SELECT e->>'calendar_auth' = 'app' AND e->>'aad_object_id' = 'oid-vic' FROM vic));

CREATE TEMP TABLE brad AS SELECT portal_sign_in('{"aad_object_id":"oid-brad","upn":"brad@bluzonebio.com","mail":"Brad.Lee@bluzonebio.com","display_name":"Brad Lee","first_name":"Brad"}') AS e;
SELECT pg_temp.ok('sign-in: a new person gets a delegated row that is not connected yet',
  (SELECT e->>'calendar_auth' = 'delegated' AND e->'calendar_connected_at' = 'null'::jsonb AND (e->>'enrolled')::boolean FROM brad));
SELECT pg_temp.ok('sign-in: mail stored lowercase for matching From:, signature names the employee',
  (SELECT mail = 'brad.lee@bluzonebio.com' AND signature_title = 'Scheduling Assistant to Brad Lee (AI)' FROM employees WHERE upn = 'brad@bluzonebio.com'));
SELECT pg_temp.ok('sign-in: signing in again finds the same row by object id',
  (portal_sign_in('{"aad_object_id":"oid-brad","upn":"brad@bluzonebio.com","display_name":"Brad Lee"}')->>'id')::int = (SELECT (e->>'id')::int FROM brad));
SELECT pg_temp.expect_error('sign-in: object id is required',
  $q$SELECT sched.portal_sign_in('{"upn":"x@bluzonebio.com"}')$q$, 'required');
SELECT pg_temp.ok('broker lookup: delegated, not connected',
  (SELECT portal_employee_by_upn('BRAD@bluzonebio.com') @> '{"calendar_auth":"delegated","connected":false}'));

-- -----------------------------------------------------------------------------
-- connect + settings
-- -----------------------------------------------------------------------------
SELECT portal_token_put((SELECT (e->>'id')::int FROM brad),
  '{"home_account_id":"oid-brad.tenant","key_id":"k1","iv":"AAAAAAAAAAAAAAAA","ciphertext":"c2VjcmV0","tag":"AAAAAAAAAAAAAAAAAAAAAA=="}');
SELECT pg_temp.ok('tokens: stored as bytea, returned as the same base64',
  (SELECT portal_token_get((e->>'id')::int) = '{"home_account_id":"oid-brad.tenant","key_id":"k1","iv":"AAAAAAAAAAAAAAAA","ciphertext":"c2VjcmV0","tag":"AAAAAAAAAAAAAAAAAAAAAA=="}'::jsonb FROM brad));
SELECT portal_connected((SELECT (e->>'id')::int FROM brad), '{"timezone":"America/Los_Angeles","working_hours":{"mon":["08:00","16:00"],"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}}');
SELECT pg_temp.ok('connect: calendar_auth delegated, connected, prefill applied',
  (SELECT calendar_connected_at IS NOT NULL AND timezone = 'America/Los_Angeles' AND working_hours->'mon' = '["08:00","16:00"]'::jsonb
     FROM employees WHERE upn = 'brad@bluzonebio.com'));
SELECT portal_save_settings((SELECT (e->>'id')::int FROM brad), jsonb_build_object(
  'first_name', 'Brad', 'timezone', 'America/Chicago',
  'working_hours', '{"mon":["09:00","17:00"],"tue":["09:00","17:00"],"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}'::jsonb,
  'preferred_start', '09:30', 'preferred_end', '16:00', 'default_duration_min', 45, 'default_location', 'teams', 'office_address', '',
  'hard_gap_min', 10, 'preferred_gap_min', 30, 'in_person_buffer_min', 30, 'max_meetings_per_day', 5, 'min_notice_hours', 12,
  'search_window_days', 14, 'offers_per_round', 3, 'bcc_after_intro', false));
SELECT pg_temp.ok('settings: saved, office address blank → null',
  (SELECT default_duration_min = 45 AND timezone = 'America/Chicago' AND office_address IS NULL AND NOT bcc_after_intro AND settings_saved_at IS NOT NULL
     FROM employees WHERE upn = 'brad@bluzonebio.com'));
SELECT portal_connected((SELECT (e->>'id')::int FROM brad), '{"timezone":"Europe/London"}');
SELECT pg_temp.ok('connect again: the Outlook prefill never overwrites saved settings',
  (SELECT timezone = 'America/Chicago' FROM employees WHERE upn = 'brad@bluzonebio.com'));
SELECT pg_temp.expect_error('settings: the table CHECKs are the final word',
  format($q$SELECT sched.portal_save_settings(%s, '{"first_name":"B","timezone":"America/Chicago","working_hours":{},"preferred_start":"09:00","preferred_end":"10:00","default_duration_min":5,"default_location":"teams","hard_gap_min":0,"preferred_gap_min":0,"in_person_buffer_min":0,"max_meetings_per_day":1,"min_notice_hours":0,"search_window_days":1,"offers_per_round":1,"bcc_after_intro":true}')$q$,
         (SELECT e->>'id' FROM brad)), 'check constraint');
SELECT portal_set_paused((SELECT (e->>'id')::int FROM brad), true);
SELECT pg_temp.ok('pause: set and timestamped', (SELECT paused AND paused_at IS NOT NULL FROM employees WHERE upn = 'brad@bluzonebio.com'));
SELECT portal_set_paused((SELECT (e->>'id')::int FROM brad), false);

-- -----------------------------------------------------------------------------
-- reconnect: one email per incident, through the outbox
-- -----------------------------------------------------------------------------
SELECT pg_temp.ok('reconnect: first failure flags the employee',
  NOT (portal_mark_reconnect((SELECT (e->>'id')::int FROM brad), 'AADSTS700082', true)->>'already')::boolean);
SELECT pg_temp.ok('reconnect: one email to the employee''s mail address with the portal link',
  (SELECT count(*) = 1 FROM outbox WHERE purpose = 'reconnect' AND kind = 'notify_internal' AND status = 'pending'
     AND payload->'to'->0->>'address' = 'brad.lee@bluzonebio.com' AND payload->>'body_text' LIKE '%https://portal.test:8443/connect%'));
SELECT pg_temp.ok('reconnect: a second failure is "already" and queues nothing more',
  (portal_mark_reconnect((SELECT (e->>'id')::int FROM brad), 'AADSTS700082', true)->>'already')::boolean
  AND (SELECT count(*) = 1 FROM outbox WHERE purpose = 'reconnect' AND payload->'to'->0->>'address' = 'brad.lee@bluzonebio.com'));
SELECT pg_temp.ok('reconnect: the code is recorded, not a message',
  (SELECT reconnect_reason = 'AADSTS700082' AND needs_reconnect FROM employees WHERE upn = 'brad@bluzonebio.com')
  AND (SELECT last_error_code = 'AADSTS700082' FROM portal_tokens WHERE home_account_id = 'oid-brad.tenant'));
SELECT portal_token_ok((SELECT (e->>'id')::int FROM brad));
SELECT pg_temp.ok('reconnect: a working refresh clears the flag',
  (SELECT NOT needs_reconnect AND reconnect_reason IS NULL FROM employees WHERE upn = 'brad@bluzonebio.com'));
SELECT portal_mark_reconnect((SELECT (e->>'id')::int FROM brad), 'AADSTS50057', false);
SELECT pg_temp.ok('account disabled: Casey is alerted instead of emailing a dead mailbox',
  (SELECT count(*) = 1 FROM outbox WHERE purpose = 'reconnect' AND payload->'to'->0->>'address' = 'brad.lee@bluzonebio.com')
  AND (SELECT count(*) = 1 FROM outbox WHERE purpose = 'alert' AND payload->>'subject' LIKE '%Brad Lee''s account looks disabled%'
         AND payload->'to'->0->>'address' = 'casey@bluzonebio.com'));
SELECT portal_token_ok((SELECT (e->>'id')::int FROM brad));
SELECT set_mode('dry_run');
SELECT portal_mark_reconnect((SELECT (e->>'id')::int FROM brad), 'AADSTS50173', true);
SELECT pg_temp.ok('reconnect: the run mode applies (dry_run → skipped, nothing sent)',
  (SELECT status = 'skipped' FROM outbox WHERE purpose = 'reconnect' ORDER BY id DESC LIMIT 1));
SELECT pg_temp.ok('test email: dry_run is reported so the portal can say it won''t send',
  (SELECT r->>'mode' = 'dry_run' AND r->>'status' = 'skipped' FROM (SELECT portal_queue_test_mail((SELECT (e->>'id')::int FROM brad)) AS r) x));
SELECT set_mode('live');
SELECT portal_token_ok((SELECT (e->>'id')::int FROM brad));
SELECT pg_temp.ok('test email: queued to the employee in live',
  (SELECT r->>'status' = 'pending' FROM (SELECT portal_queue_test_mail((SELECT (e->>'id')::int FROM brad)) AS r) x)
  AND (SELECT payload->'to'->0->>'address' = 'brad.lee@bluzonebio.com' FROM outbox WHERE purpose = 'portal_test' ORDER BY id DESC LIMIT 1));
SELECT pg_temp.ok('keep-alive list: connected, delegated, not flagged',
  (SELECT count(*) = 1 FROM portal_keepalive_list() k WHERE k->>'upn' = 'brad@bluzonebio.com'));

-- -----------------------------------------------------------------------------
-- outbox: calendar_auth at claim time; the needs-reconnect failure path
-- -----------------------------------------------------------------------------
UPDATE outbox SET status = 'done' WHERE status IN ('pending', 'approved');
CREATE TEMP TABLE bt AS SELECT apply_plan(jsonb_build_object(
  'thread', jsonb_build_object(
    'create', jsonb_build_object('conversation_id', 'CONV-BRAD', 'employee_id', (SELECT (e->>'id')::int FROM brad),
       'subject', 'Brad intro', 'client_addresses', '["dana@client.com"]'::jsonb, 'duration_min', 30,
       'location_type', 'teams', 'trigger_message_id', '<b1@bzb>'),
    'set', '{"round_count":1}'::jsonb, 'transitions', '["PROPOSED"]'::jsonb),
  'offers', jsonb_build_object('insert', jsonb_build_array(
    jsonb_build_object('ref','o1','round',1,'option_no',1,'start','2027-03-02T14:00:00Z','end','2027-03-02T14:30:00Z','score',100))),
  'outbox', jsonb_build_array(
    jsonb_build_object('ref','h1','kind','create_hold','purpose','hold','offer_ref','o1',
                       'payload', jsonb_build_object('employee_upn','brad@bluzonebio.com','start','2027-03-02T14:00:00Z','end','2027-03-02T14:30:00Z')),
    jsonb_build_object('kind','reply','purpose','intro','needs_approval',true,'depends_on_ref','h1',
                       'payload', jsonb_build_object('to', '[{"address":"dana@client.com"}]'::jsonb, 'body_text', 'hi'))))) AS r;
CREATE TEMP TABLE claimed AS SELECT * FROM outbox_claim(10) AS item;
SELECT pg_temp.ok('claim: Brad''s hold carries calendar_auth = delegated and the broker URL',
  (SELECT item->>'calendar_auth' = 'delegated' AND item->'config'->>'portal_internal_url' = 'http://sarah-portal:3001'
     FROM claimed WHERE item->>'kind' = 'create_hold'));
SELECT pg_temp.ok('claim: mail items carry no calendar_auth',
  NOT EXISTS (SELECT 1 FROM claimed WHERE item->>'kind' IN ('reply', 'new_mail', 'notify_internal') AND item ? 'calendar_auth'));

CREATE TEMP TABLE rep AS SELECT outbox_report(jsonb_build_object('id', (SELECT (item->>'id')::bigint FROM claimed WHERE item->>'kind' = 'create_hold'),
  'outcome', 'failed', 'error_code', 'needs_reconnect', 'error', 'NeedsReconnect: the employee must reconnect their calendar')) AS r;
SELECT pg_temp.ok('needs reconnect: the hold fails at once (no retries)',
  (SELECT status = 'failed' AND attempts = 1 FROM outbox WHERE id = (SELECT (item->>'id')::bigint FROM claimed WHERE item->>'kind' = 'create_hold')));
SELECT pg_temp.ok('needs reconnect: the thread goes to NEEDS_VIC with the specific reason',
  (SELECT state = 'NEEDS_VIC' AND escalation_reason LIKE 'Sarah lost access to your calendar%https://portal.test:8443/connect%'
     FROM threads WHERE conversation_id = 'CONV-BRAD'));
SELECT pg_temp.ok('needs reconnect: the client email waiting on it is cancelled',
  (SELECT status = 'cancelled' FROM outbox WHERE kind = 'reply' AND thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-BRAD')));
SELECT pg_temp.ok('needs reconnect: Brad is told; Casey is not alerted (not a system fault)',
  (SELECT count(*) = 1 FROM outbox WHERE purpose = 'vic_notice' AND payload->'to'->0->>'address' = 'brad.lee@bluzonebio.com'
     AND thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-BRAD'))
  AND NOT EXISTS (SELECT 1 FROM outbox WHERE purpose = 'alert' AND thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-BRAD')));
-- hold releases while the token is dead: they wait, then run after the reconnect
UPDATE offers SET hold_event_id = 'EV-HOLD', status = 'expired' WHERE thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-BRAD');
UPDATE employees SET needs_reconnect = true WHERE upn = 'brad@bluzonebio.com';
SELECT count(*) FROM timer_events();
SELECT pg_temp.ok('dead token: the timers queue one hold release',
  (SELECT count(*) = 1 FROM outbox WHERE kind = 'delete_hold' AND status = 'pending'
     AND thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-BRAD')));
SELECT pg_temp.ok('dead token: the executor is not handed it (no broker call, no refresh attempt)',
  NOT EXISTS (SELECT 1 FROM outbox_claim(10) i WHERE i->>'kind' = 'delete_hold'));
SELECT pg_temp.ok('dead token: it stays pending, not failed',
  (SELECT status = 'pending' FROM outbox WHERE kind = 'delete_hold' AND thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-BRAD')));
SELECT count(*) FROM timer_events();
SELECT pg_temp.ok('dead token: later timer runs don''t queue duplicates',
  (SELECT count(*) = 1 FROM outbox WHERE kind = 'delete_hold' AND thread_id = (SELECT id FROM threads WHERE conversation_id = 'CONV-BRAD')));
-- a release already in flight when the token died goes back to waiting, not to failed
UPDATE employees SET needs_reconnect = false WHERE upn = 'brad@bluzonebio.com';
CREATE TEMP TABLE inflight AS SELECT i FROM outbox_claim(10) i WHERE i->>'kind' = 'delete_hold';
UPDATE employees SET needs_reconnect = true WHERE upn = 'brad@bluzonebio.com';
SELECT outbox_report(jsonb_build_object('id', (SELECT (i->>'id')::bigint FROM inflight), 'outcome', 'failed', 'error_code', 'needs_reconnect', 'error', 'NeedsReconnect: x'));
SELECT pg_temp.ok('dead token mid-flight: the hold release waits instead of failing',
  (SELECT status = 'pending' AND last_error LIKE 'NeedsReconnect: waiting%' FROM outbox WHERE id = (SELECT (i->>'id')::bigint FROM inflight)));
SELECT portal_connected((SELECT (e->>'id')::int FROM brad), NULL);
SELECT pg_temp.ok('after reconnecting, the waiting hold release is handed to the executor',
  EXISTS (SELECT 1 FROM outbox_claim(10) i WHERE i->>'kind' = 'delete_hold' AND i->>'calendar_auth' = 'delegated'));
SELECT pg_temp.ok('other failures still take the original path (system escalation + alert)',
  (SELECT outbox_report(jsonb_build_object('id', 999999999, 'outcome', 'failed')) @> '{"ignored":true}'));

-- -----------------------------------------------------------------------------
-- sessions, threads, admin overview
-- -----------------------------------------------------------------------------
SELECT portal_session_create('hash-1', (SELECT (e->>'id')::int FROM brad), 'csrf-1', 3600);
SELECT pg_temp.ok('session: found by hash, carries the employee and CSRF token',
  (SELECT portal_session_get('hash-1') @> '{"csrf":"csrf-1","employee":{"upn":"brad@bluzonebio.com"}}'));
SELECT portal_session_create('hash-old', (SELECT (e->>'id')::int FROM brad), 'c', 1);
UPDATE portal_sessions SET expires_at = now() - interval '1 second' WHERE id_hash = 'hash-old';
SELECT pg_temp.ok('session: expired sessions are not returned', portal_session_get('hash-old') IS NULL);
SELECT portal_session_delete('hash-1');
SELECT pg_temp.ok('session: signed out', portal_session_get('hash-1') IS NULL);
SELECT pg_temp.ok('my threads: only the employee''s own',
  (SELECT jsonb_array_length(portal_my_threads((e->>'id')::int)) = 1 AND portal_my_threads((e->>'id')::int)->0->>'subject' = 'Brad intro' FROM brad)
  AND jsonb_array_length(portal_my_threads((SELECT id FROM employees WHERE upn = 'vic@bluzonebio.com'))) = 0);
SELECT pg_temp.ok('admin overview: every employee with token health',
  (SELECT jsonb_array_length(portal_overview()) = (SELECT count(*) FROM employees))
  AND (SELECT x->>'last_refresh_ok_at' IS NOT NULL FROM jsonb_array_elements(portal_overview()) x WHERE x->>'upn' = 'brad@bluzonebio.com'));

SELECT line FROM results ORDER BY n;
ROLLBACK;
