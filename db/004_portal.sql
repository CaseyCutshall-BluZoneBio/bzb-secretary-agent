-- =============================================================================
-- 004 · Self-service portal: per-user delegated calendars
--
-- Additive and idempotent: run it on an existing install (after 001–003) to
-- upgrade in place, or as part of a fresh install. Running it twice is a no-op.
--
--   * employees: calendar_auth ('app' | 'delegated'), pause, reconnect state,
--     Entra identity, per-employee signature
--   * portal_tokens: each employee's MSAL token cache, AES-256-GCM encrypted by
--     the portal (the database never sees a key or a plaintext token)
--   * portal_sessions: portal sign-in sessions (hashed ids)
--   * portal_* functions: everything the portal does, as SECURITY DEFINER
--     functions. The portal's role (sched_portal) gets EXECUTE on those only.
--   * outbox_claim / outbox_report gain calendar_auth routing and a specific
--     "needs reconnect" failure path (the originals are kept as *_base).
--
-- The sched_portal role is created by a superuser (docs/09-portal.md); the
-- grants at the end apply only if it exists. Re-run this file after creating it.
-- =============================================================================
SET search_path = sched, public;
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES ('001_schema'), ('002_functions'), ('003_seed')
  ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- employees
-- -----------------------------------------------------------------------------
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS calendar_auth text NOT NULL DEFAULT 'app'
      CHECK (calendar_auth IN ('app', 'delegated')),
  ADD COLUMN IF NOT EXISTS calendar_connected_at timestamptz,     -- delegated: first/last successful connect
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false, -- set by the employee: ignore new triggers
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS needs_reconnect boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_reconnect_since timestamptz,
  ADD COLUMN IF NOT EXISTS reconnect_reason text,                 -- an error code (AADSTS…), never a message
  ADD COLUMN IF NOT EXISTS aad_object_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS mail text UNIQUE CHECK (mail = lower(mail)),  -- primary SMTP; matched against From:
  ADD COLUMN IF NOT EXISTS signature_title text,                  -- second signature line (the AI disclosure)
  ADD COLUMN IF NOT EXISTS settings_saved_at timestamptz,         -- null = still on defaults / Outlook prefill
  ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz;

-- Vic's existing row keeps working exactly as before: calendar_auth = 'app'.
UPDATE employees SET signature_title = 'Scheduling Assistant to ' || display_name || ' (AI)'
 WHERE signature_title IS NULL;

-- -----------------------------------------------------------------------------
-- token cache + sessions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_tokens (
  employee_id        int PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  home_account_id    text NOT NULL,
  key_id             text NOT NULL,      -- which PORTAL_TOKEN_KEYS entry encrypted it
  iv                 bytea NOT NULL,
  ciphertext         bytea NOT NULL,
  tag                bytea NOT NULL,
  last_refresh_ok_at timestamptz,
  last_error_code    text,
  last_error_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS portal_tokens_touch ON portal_tokens;
CREATE TRIGGER portal_tokens_touch BEFORE UPDATE ON portal_tokens
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE IF NOT EXISTS portal_sessions (
  id_hash     text PRIMARY KEY,           -- sha256 of the cookie value; the value itself is never stored
  employee_id int NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  csrf        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_sessions_expiry_idx ON portal_sessions (expires_at);

-- -----------------------------------------------------------------------------
-- settings
-- -----------------------------------------------------------------------------
INSERT INTO settings (key, value, note) VALUES
  ('portal_base_url', '"https://bzb-ai-1.tail9f1964.ts.net:10000"',
   'Public portal URL (Tailscale Funnel). Links in emails use it. Must match PORTAL_BASE_URL in the portal''s env.'),
  ('portal_internal_url', '"http://sarah-portal:3001"',
   'The portal''s token broker as n8n reaches it on the compose network. Never published.'),
  ('portal_admins', '[]',
   'UPNs (lowercase) allowed on the portal admin page, in addition to alert_address.')
ON CONFLICT (key) DO NOTHING;

-- status: + employee_id (for "My threads"). New columns go at the end.
CREATE OR REPLACE VIEW status AS
SELECT t.id, t.state, t.subject, array_to_string(t.client_addresses, ', ') AS clients,
       t.round_count, t.updated_at,
       (SELECT count(*) FROM sched.outbox x WHERE x.thread_id = t.id AND x.status = 'awaiting_approval') AS awaiting_review,
       coalesce(t.escalation_reason, t.closed_reason) AS reason,
       t.employee_id
  FROM sched.threads t
 ORDER BY t.updated_at DESC;

-- -----------------------------------------------------------------------------
-- helpers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION employee_address(e employees) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(coalesce(e.mail, e.upn))
$$;

CREATE OR REPLACE FUNCTION portal_link(p_path text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT rtrim(coalesce(sched.setting_text('portal_base_url'), ''), '/') || p_path
$$;

-- Queue an internal email from Sarah to an employee (through the outbox, so the
-- run mode applies).
CREATE OR REPLACE FUNCTION notify_employee(p_employee_id int, p_thread_id bigint, p_purpose text,
                                           p_subject text, p_body text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  e    sched.employees;
  v_id bigint;
  v_text text;
BEGIN
  SELECT * INTO e FROM sched.employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_text := p_body || E'\n\n' || coalesce(sched.setting_text('sarah_name'), 'Sarah');
  INSERT INTO sched.outbox (thread_id, kind, purpose, payload, status)
  VALUES (p_thread_id, 'notify_internal', p_purpose,
          jsonb_build_object(
            'to', jsonb_build_array(jsonb_build_object('address', sched.employee_address(e), 'name', e.display_name)),
            'cc', '[]'::jsonb, 'bcc', '[]'::jsonb,
            'subject', p_subject,
            'body_text', v_text,
            'body_html', '<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;white-space:pre-wrap">'
                         || sched.html_escape(v_text) || '</div>'),
          sched.initial_outbox_status())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION reconnect_reason_text() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT 'Sarah lost access to your calendar (your Microsoft sign-in for Sarah expired or was revoked). '
      || 'Reconnect at ' || sched.portal_link('/connect') || ' and then handle this thread yourself'
$$;

-- -----------------------------------------------------------------------------
-- portal functions (SECURITY DEFINER; the portal role can call only these)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION portal_employee_json(e employees) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', e.id, 'upn', e.upn, 'mail', e.mail, 'aad_object_id', e.aad_object_id,
    'display_name', e.display_name, 'first_name', e.first_name, 'timezone', e.timezone,
    'working_hours', e.working_hours,
    'preferred_start', to_char(e.preferred_start, 'HH24:MI'), 'preferred_end', to_char(e.preferred_end, 'HH24:MI'),
    'default_duration_min', e.default_duration_min, 'default_location', e.default_location,
    'office_address', e.office_address, 'hard_gap_min', e.hard_gap_min, 'preferred_gap_min', e.preferred_gap_min,
    'in_person_buffer_min', e.in_person_buffer_min, 'max_meetings_per_day', e.max_meetings_per_day,
    'min_notice_hours', e.min_notice_hours, 'search_window_days', e.search_window_days,
    'offers_per_round', e.offers_per_round, 'bcc_after_intro', e.bcc_after_intro,
    'enrolled', e.enrolled, 'calendar_auth', e.calendar_auth, 'calendar_connected_at', e.calendar_connected_at,
    'paused', e.paused, 'needs_reconnect', e.needs_reconnect, 'reconnect_reason', e.reconnect_reason,
    'signature_title', e.signature_title, 'settings_saved_at', e.settings_saved_at)
$$;

-- Portal-wide configuration the portal needs (no secrets live in settings).
CREATE OR REPLACE FUNCTION portal_config() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object(
    'mode', sched.setting_text('mode'),
    'internal_domains', coalesce(sched.setting('internal_domains'), '[]'::jsonb),
    'alert_address', lower(coalesce(sched.setting_text('alert_address'), '')),
    'portal_admins', coalesce(sched.setting('portal_admins'), '[]'::jsonb),
    'sarah_upn', sched.setting_text('sarah_upn'))
$$;

-- Sign-in: find the employee by Entra object id, else attach to an existing
-- row by UPN/mail (Vic's legacy row), else create one. A created row is
-- 'delegated' but not connected, so Sarah ignores its triggers until the
-- calendar is connected.
CREATE OR REPLACE FUNCTION portal_sign_in(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  e      sched.employees;
  v_oid  text := p->>'aad_object_id';
  v_upn  text := lower(p->>'upn');
  v_mail text := lower(nullif(p->>'mail', ''));
  v_name text := coalesce(nullif(btrim(p->>'display_name'), ''), v_upn);
BEGIN
  IF v_oid IS NULL OR v_upn IS NULL THEN RAISE EXCEPTION 'aad_object_id and upn are required'; END IF;
  SELECT * INTO e FROM sched.employees WHERE aad_object_id = v_oid FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO e FROM sched.employees
     WHERE aad_object_id IS NULL AND (upn IN (v_upn, v_mail) OR mail IN (v_upn, v_mail))
     ORDER BY id LIMIT 1 FOR UPDATE;
  END IF;
  IF FOUND THEN
    UPDATE sched.employees
       SET aad_object_id = v_oid, mail = coalesce(v_mail, mail), last_sign_in_at = now()
     WHERE id = e.id RETURNING * INTO e;
  ELSE
    INSERT INTO sched.employees (
      upn, mail, aad_object_id, display_name, first_name, timezone, working_hours,
      preferred_start, preferred_end, default_duration_min, calendar_auth, signature_title, last_sign_in_at)
    VALUES (
      v_upn, v_mail, v_oid, v_name,
      coalesce(nullif(btrim(p->>'first_name'), ''), split_part(v_name, ' ', 1)),
      'America/New_York',
      '{"mon":["09:00","17:00"],"tue":["09:00","17:00"],"wed":["09:00","17:00"],"thu":["09:00","17:00"],"fri":["09:00","17:00"],"sat":null,"sun":null}',
      '09:30', '16:00', 30, 'delegated',
      'Scheduling Assistant to ' || v_name || ' (AI)', now())
    RETURNING * INTO e;
  END IF;
  RETURN sched.portal_employee_json(e);
END $$;

CREATE OR REPLACE FUNCTION portal_employee(p_employee_id int) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT sched.portal_employee_json(e) FROM sched.employees e WHERE e.id = p_employee_id
$$;

-- Broker lookup: who is this calendar request for?
CREATE OR REPLACE FUNCTION portal_employee_by_upn(p_upn text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object('id', e.id, 'upn', e.upn, 'enrolled', e.enrolled, 'calendar_auth', e.calendar_auth,
                            'connected', e.calendar_connected_at IS NOT NULL, 'needs_reconnect', e.needs_reconnect)
    FROM sched.employees e WHERE e.upn = lower(p_upn)
$$;

-- The calendar was just connected (tokens stored, a test read worked). The
-- Outlook prefill (timezone, working hours) applies only while the employee
-- hasn't saved their own settings.
CREATE OR REPLACE FUNCTION portal_connected(p_employee_id int, p_prefill jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  e sched.employees;
BEGIN
  UPDATE sched.employees
     SET calendar_auth = 'delegated', calendar_connected_at = now(),
         needs_reconnect = false, needs_reconnect_since = NULL, reconnect_reason = NULL
   WHERE id = p_employee_id RETURNING * INTO e;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown employee %', p_employee_id; END IF;
  IF e.settings_saved_at IS NULL AND p_prefill IS NOT NULL THEN
    UPDATE sched.employees
       SET timezone = coalesce(p_prefill->>'timezone', timezone),
           working_hours = coalesce(p_prefill->'working_hours', working_hours)
     WHERE id = e.id RETURNING * INTO e;
  END IF;
  UPDATE sched.portal_tokens SET last_refresh_ok_at = now(), last_error_code = NULL WHERE employee_id = e.id;
  RETURN sched.portal_employee_json(e);
END $$;

-- Settings form. Only these columns can change; the table's CHECKs are the
-- final word (the portal validates first so people see friendly errors).
CREATE OR REPLACE FUNCTION portal_save_settings(p_employee_id int, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  e sched.employees;
BEGIN
  UPDATE sched.employees SET
    first_name           = p->>'first_name',
    timezone             = p->>'timezone',
    working_hours        = p->'working_hours',
    preferred_start      = (p->>'preferred_start')::time,
    preferred_end        = (p->>'preferred_end')::time,
    default_duration_min = (p->>'default_duration_min')::int,
    default_location     = p->>'default_location',
    office_address       = nullif(p->>'office_address', ''),
    hard_gap_min         = (p->>'hard_gap_min')::int,
    preferred_gap_min    = (p->>'preferred_gap_min')::int,
    in_person_buffer_min = (p->>'in_person_buffer_min')::int,
    max_meetings_per_day = (p->>'max_meetings_per_day')::int,
    min_notice_hours     = (p->>'min_notice_hours')::int,
    search_window_days   = (p->>'search_window_days')::int,
    offers_per_round     = (p->>'offers_per_round')::int,
    bcc_after_intro      = (p->>'bcc_after_intro')::boolean,
    settings_saved_at    = now()
  WHERE id = p_employee_id RETURNING * INTO e;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown employee %', p_employee_id; END IF;
  RETURN sched.portal_employee_json(e);
END $$;

CREATE OR REPLACE FUNCTION portal_set_paused(p_employee_id int, p_paused boolean) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE sched.employees SET paused = p_paused, paused_at = CASE WHEN p_paused THEN now() END
   WHERE id = p_employee_id
  RETURNING sched.portal_employee_json(employees)
$$;

-- Encrypted token cache (base64 in and out; the portal encrypts and decrypts).
CREATE OR REPLACE FUNCTION portal_token_get(p_employee_id int) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object('home_account_id', home_account_id, 'key_id', key_id,
                            'iv', encode(iv, 'base64'), 'ciphertext', encode(ciphertext, 'base64'),
                            'tag', encode(tag, 'base64'))
    FROM sched.portal_tokens WHERE employee_id = p_employee_id
$$;

CREATE OR REPLACE FUNCTION portal_token_put(p_employee_id int, p jsonb) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO sched.portal_tokens (employee_id, home_account_id, key_id, iv, ciphertext, tag)
  VALUES (p_employee_id, p->>'home_account_id', p->>'key_id', decode(p->>'iv', 'base64'),
          decode(p->>'ciphertext', 'base64'), decode(p->>'tag', 'base64'))
  ON CONFLICT (employee_id) DO UPDATE
     SET home_account_id = EXCLUDED.home_account_id, key_id = EXCLUDED.key_id, iv = EXCLUDED.iv,
         ciphertext = EXCLUDED.ciphertext, tag = EXCLUDED.tag
$$;

CREATE OR REPLACE FUNCTION portal_token_ids() RETURNS SETOF int LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT employee_id FROM sched.portal_tokens ORDER BY employee_id
$$;

-- Employees whose tokens the daily keep-alive refreshes.
CREATE OR REPLACE FUNCTION portal_keepalive_list() RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object('id', e.id, 'upn', e.upn)
    FROM sched.employees e JOIN sched.portal_tokens k ON k.employee_id = e.id
   WHERE e.enrolled AND e.calendar_auth = 'delegated' AND e.calendar_connected_at IS NOT NULL
     AND NOT e.needs_reconnect
   ORDER BY e.id
$$;

-- A token refresh worked: clear any reconnect flag.
CREATE OR REPLACE FUNCTION portal_token_ok(p_employee_id int) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE sched.portal_tokens SET last_refresh_ok_at = now(), last_error_code = NULL WHERE employee_id = p_employee_id;
  UPDATE sched.employees SET needs_reconnect = false, needs_reconnect_since = NULL, reconnect_reason = NULL
   WHERE id = p_employee_id AND needs_reconnect;
$$;

-- A token refresh failed for good. Flags the employee and queues ONE email on
-- the false → true change: to the employee with a reconnect link, or (account
-- disabled / deleted: p_notify_employee = false) an alert to alert_address.
CREATE OR REPLACE FUNCTION portal_mark_reconnect(p_employee_id int, p_code text, p_notify_employee boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  e       sched.employees;
  v_open  text;
BEGIN
  UPDATE sched.portal_tokens SET last_error_code = left(p_code, 80), last_error_at = now()
   WHERE employee_id = p_employee_id;
  SELECT * INTO e FROM sched.employees WHERE id = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;
  IF e.needs_reconnect THEN RETURN jsonb_build_object('ok', true, 'already', true); END IF;

  UPDATE sched.employees SET needs_reconnect = true, needs_reconnect_since = now(), reconnect_reason = left(p_code, 80)
   WHERE id = e.id;
  IF p_notify_employee THEN
    PERFORM sched.notify_employee(e.id, NULL, 'reconnect',
      'Action needed: reconnect your calendar to Sarah',
      format(E'Hi %s,\n\nI can no longer reach your calendar. Your Microsoft sign-in for Sarah expired or was revoked.\n\nReconnect here (it takes a minute):\n%s\n\nUntil then I won''t start new scheduling for you, and any thread that needs your calendar comes back to you.',
             e.first_name, sched.portal_link('/connect')));
  ELSE
    SELECT string_agg(format('#%s %s (%s)', t.id, coalesce(t.subject, ''), t.state), E'\n')
      INTO v_open FROM sched.threads t
     WHERE t.employee_id = e.id AND t.state NOT IN ('CLOSED', 'BOOKED');
    PERFORM sched.enqueue_alert(NULL, format('%s''s account looks disabled or deleted', e.display_name),
      format(E'Sarah''s calendar access for %s (%s) failed with %s, which means the account is disabled or gone.\n\nIf they left BZB: set enrolled = false (docs/07-runbook.md, Offboarding).\n\nOpen threads:\n%s',
             e.display_name, e.upn, p_code, coalesce(v_open, '(none)')));
  END IF;
  RETURN jsonb_build_object('ok', true, 'already', false);
END $$;

-- "Send me a test": an internal email through the outbox. Returns the mode so
-- the portal can say whether it will actually be sent.
CREATE OR REPLACE FUNCTION portal_queue_test_mail(p_employee_id int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  e    sched.employees;
  v_id bigint;
BEGIN
  SELECT * INTO e FROM sched.employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown employee %', p_employee_id; END IF;
  v_id := sched.notify_employee(e.id, NULL, 'portal_test', 'Test from Sarah',
    format(E'Hi %s,\n\nThis is a test from the Sarah portal. If you can read this, I can reach you.\n\nTo use me, CC %s on an email with a client and say "Sarah will find us a time."',
           e.first_name, sched.setting_text('sarah_upn')));
  RETURN jsonb_build_object('outbox_id', v_id, 'mode', sched.setting_text('mode'),
                            'status', (SELECT status FROM sched.outbox WHERE id = v_id));
END $$;

CREATE OR REPLACE FUNCTION portal_my_threads(p_employee_id int) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'state', s.state, 'subject', s.subject, 'clients', s.clients,
           'round_count', s.round_count, 'updated_at', s.updated_at, 'reason', s.reason)
           ORDER BY s.updated_at DESC), '[]'::jsonb)
    FROM (SELECT * FROM sched.status WHERE employee_id = p_employee_id ORDER BY updated_at DESC LIMIT 100) s
$$;

-- Admin page: every employee, token health, last activity.
CREATE OR REPLACE FUNCTION portal_overview() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'upn', e.upn, 'display_name', e.display_name, 'enrolled', e.enrolled,
           'calendar_auth', e.calendar_auth, 'connected', e.calendar_connected_at IS NOT NULL,
           'paused', e.paused, 'needs_reconnect', e.needs_reconnect, 'reconnect_reason', e.reconnect_reason,
           'last_refresh_ok_at', k.last_refresh_ok_at, 'last_error_code', k.last_error_code,
           'last_sign_in_at', e.last_sign_in_at,
           'last_activity_at', (SELECT max(t.updated_at) FROM sched.threads t WHERE t.employee_id = e.id),
           'open_threads', (SELECT count(*) FROM sched.threads t WHERE t.employee_id = e.id
                             AND t.state NOT IN ('CLOSED', 'BOOKED', 'NEEDS_VIC', 'STALLED')))
           ORDER BY e.display_name), '[]'::jsonb)
    FROM sched.employees e LEFT JOIN sched.portal_tokens k ON k.employee_id = e.id
$$;

-- Sessions
CREATE OR REPLACE FUNCTION portal_session_create(p_hash text, p_employee_id int, p_csrf text, p_ttl_seconds int)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM sched.portal_sessions WHERE expires_at < now();
  INSERT INTO sched.portal_sessions (id_hash, employee_id, csrf, expires_at)
  VALUES (p_hash, p_employee_id, p_csrf, now() + make_interval(secs => p_ttl_seconds));
$$;

CREATE OR REPLACE FUNCTION portal_session_get(p_hash text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object('csrf', s.csrf, 'employee', sched.portal_employee_json(e))
    FROM sched.portal_sessions s JOIN sched.employees e ON e.id = s.employee_id
   WHERE s.id_hash = p_hash AND s.expires_at > now()
$$;

CREATE OR REPLACE FUNCTION portal_session_delete(p_hash text) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM sched.portal_sessions WHERE id_hash = p_hash
$$;

-- -----------------------------------------------------------------------------
-- outbox: calendar_auth routing + the "needs reconnect" failure path.
-- The 002 versions are kept as *_base and wrapped, so this file never has to
-- copy their bodies.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('sched.outbox_claim_base(integer)') IS NULL THEN
    ALTER FUNCTION sched.outbox_claim(integer) RENAME TO outbox_claim_base;
  END IF;
  IF to_regprocedure('sched.outbox_report_base(jsonb)') IS NULL THEN
    ALTER FUNCTION sched.outbox_report(jsonb) RENAME TO outbox_report_base;
  END IF;
END $$;

-- Calendar items carry the employee's CURRENT calendar_auth (resolved at claim
-- time, so a switch to delegated applies to work already queued).
-- Hold releases for an employee whose token is dead are put straight back:
-- they wait (pending, so the timers don't queue duplicates) and run by
-- themselves once the employee reconnects. No broker call, no refresh attempt
-- meanwhile. Holds and bookings still go through and fail, handing the thread
-- back (outbox_report below).
DROP FUNCTION IF EXISTS outbox_claim(integer);
CREATE FUNCTION outbox_claim(p_limit int DEFAULT 10) RETURNS SETOF jsonb LANGUAGE plpgsql AS $$
DECLARE
  i      jsonb;
  v_auth text;
  v_wait boolean;
BEGIN
  FOR i IN SELECT * FROM sched.outbox_claim_base(p_limit) LOOP
    IF i->>'kind' IN ('create_hold', 'delete_hold', 'create_booking') THEN
      SELECT e.calendar_auth, e.calendar_auth = 'delegated' AND e.needs_reconnect
        INTO v_auth, v_wait
        FROM sched.employees e WHERE e.upn = lower(i->'payload'->>'employee_upn');
      IF i->>'kind' = 'delete_hold' AND coalesce(v_wait, false) THEN
        UPDATE sched.outbox SET status = coalesce(claimed_from, 'pending'), claimed_at = NULL
         WHERE id = (i->>'id')::bigint;
        CONTINUE;
      END IF;
      i := i || jsonb_build_object('calendar_auth', coalesce(v_auth, 'app'));
    END IF;
    RETURN NEXT i || jsonb_build_object('config', (i->'config')
                       || jsonb_build_object('portal_internal_url', sched.setting_text('portal_internal_url')));
  END LOOP;
END $$;

-- A calendar call that failed because the employee's token is dead: fail the
-- item (no retries), and hand the thread to the employee with a specific
-- reason. Not a system fault, so Casey isn't alerted (the broker already
-- emailed the employee once).
CREATE OR REPLACE FUNCTION outbox_report(r jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  o sched.outbox;
  t sched.threads;
  x bigint;
BEGIN
  IF coalesce(r->>'error_code', '') <> 'needs_reconnect' THEN
    RETURN sched.outbox_report_base(r);
  END IF;
  SELECT * INTO o FROM sched.outbox WHERE id = (r->>'id')::bigint FOR UPDATE;
  IF NOT FOUND OR o.status <> 'executing' THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'not executing');
  END IF;
  -- A hold release is only cleanup: it waits for the reconnect (see outbox_claim).
  IF o.kind = 'delete_hold' THEN
    UPDATE sched.outbox SET status = coalesce(claimed_from, 'pending'), claimed_at = NULL,
           last_error = 'NeedsReconnect: waiting for the employee to reconnect'
     WHERE id = o.id;
    RETURN jsonb_build_object('ok', true, 'status', 'waiting_for_reconnect');
  END IF;
  UPDATE sched.outbox SET status = 'failed', attempts = attempts + 1, last_error = left(r->>'error', 2000)
   WHERE id = o.id;
  PERFORM sched.cancel_dependents(o.id);

  SELECT * INTO t FROM sched.threads WHERE id = o.thread_id FOR UPDATE;
  IF FOUND AND t.state NOT IN ('CLOSED', 'NEEDS_VIC', 'BOOKED') THEN
    FOR x IN SELECT id FROM sched.outbox
              WHERE thread_id = t.id AND kind IN ('reply', 'create_booking')
                AND status IN ('pending', 'awaiting_approval', 'approved') LOOP
      UPDATE sched.outbox SET status = 'cancelled', last_error = 'thread escalated or closed' WHERE id = x;
      PERFORM sched.cancel_dependents(x);
    END LOOP;
    UPDATE sched.threads SET escalation_reason = sched.reconnect_reason_text() WHERE id = t.id;
    UPDATE sched.threads SET state = 'NEEDS_VIC' WHERE id = t.id;
    PERFORM sched.notify_employee(t.employee_id, t.id, 'vic_notice',
      format('Needs you: %s [S-%s]', coalesce(t.subject, 'scheduling'), t.id),
      format(E'I''ve stopped handling scheduling with %s.\nReason: %s\n\nThe thread is yours from here.',
             array_to_string(t.client_addresses, ', '), sched.reconnect_reason_text()));
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'failed', 'needs_reconnect', true);
END $$;

-- -----------------------------------------------------------------------------
-- Pin search_path on every function (new ones included), then grants.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'sched' AND p.prokind = 'f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = sched, public', f.sig);
  END LOOP;
END $$;

-- The portal role sees nothing but its own functions. Postgres lets PUBLIC
-- execute every new function by default; take that away for the whole schema
-- (n8n connects as the owner, sched_agent, so it is unaffected), then grant the
-- portal_* SECURITY DEFINER functions to sched_portal.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'sched' AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'sched' AND p.proname LIKE 'portal\_%' AND p.prosecdef
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sched_portal') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO sched_portal', f.sig);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sched_portal') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA sched TO sched_portal';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('004_portal') ON CONFLICT DO NOTHING;
