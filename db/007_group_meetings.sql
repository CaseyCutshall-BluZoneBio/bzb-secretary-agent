-- =============================================================================
-- 007 · Group meetings: a time that works for everyone
--
-- Additive and idempotent (run after 001–006; running it twice is a no-op).
--
--   * threads.responders: everyone who must agree to a time (set when the
--     thread starts). Older threads have none and behave as before: any
--     client's pick books the meeting.
--   * threads.responses: { address: { starts: [iso], at } }, the open times
--     each responder said work this round. Sarah clears it on a new round.
--   * apply_plan (wrapping 002's version, kept as apply_plan_v002) stores
--     create.responders and set.responses.
--
-- A partial answer doesn't touch last_inbound_at, so the existing follow-up
-- and stall timers keep running for whoever hasn't replied (src/group.js).
-- =============================================================================
SET search_path = sched, public;
SET client_min_messages = warning;

ALTER TABLE threads ADD COLUMN IF NOT EXISTS responders text[] NOT NULL DEFAULT '{}';
ALTER TABLE threads ADD COLUMN IF NOT EXISTS responses  jsonb  NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF to_regprocedure('sched.apply_plan_v002(jsonb)') IS NULL THEN
    ALTER FUNCTION sched.apply_plan(jsonb) RENAME TO apply_plan_v002;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION apply_plan(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  res    jsonb := sched.apply_plan_v002(p);
  v_tid  bigint := nullif(res->>'thread_id', '')::bigint;
  v_cre  jsonb := p->'thread'->'create';
  s      jsonb := coalesce(p->'thread'->'set', '{}'::jsonb);
BEGIN
  IF coalesce((res->>'stale')::boolean, false) OR v_tid IS NULL THEN
    RETURN res;
  END IF;
  IF v_cre IS NOT NULL AND jsonb_typeof(v_cre) = 'object' AND v_cre ? 'responders' THEN
    UPDATE sched.threads SET responders = sched.jtext_array(v_cre->'responders') WHERE id = v_tid;
  END IF;
  IF s ? 'responses' AND jsonb_typeof(s->'responses') = 'object' THEN
    UPDATE sched.threads SET responses = s->'responses' WHERE id = v_tid;
  END IF;
  RETURN res;
END $$;

-- Pin search_path on every function (new ones included); PUBLIC runs nothing.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'sched' AND p.prokind = 'f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = sched, public', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END $$;

INSERT INTO schema_migrations (version) VALUES ('007_group_meetings') ON CONFLICT DO NOTHING;
