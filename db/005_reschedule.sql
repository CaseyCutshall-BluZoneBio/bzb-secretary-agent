-- =============================================================================
-- 005 · Rescheduling a booked meeting
--
-- Additive and idempotent (run after 001–004; running it twice is a no-op).
--
--   * A BOOKED thread may go back to PROPOSED (the client asked to move it and
--     Sarah offers new times) or straight to CLIENT_ACCEPTED (the client named
--     a new time that's free). booked_event_id stays set meanwhile: that is
--     the event that will be moved.
--   * The move itself is an ordinary create_booking outbox item whose payload
--     carries move_event_id: the executor PATCHes that event instead of
--     creating one, so every existing safeguard (shadow approval, cancel on
--     hand-off, retries, the broker) applies unchanged.
--   * When the move completes, the offer the meeting used to be at is marked
--     superseded (outbox_report, wrapping 004's version).
-- =============================================================================
SET search_path = sched, public;
SET client_min_messages = warning;

-- Legal transitions: + BOOKED → PROPOSED / CLIENT_ACCEPTED (reschedule).
CREATE OR REPLACE FUNCTION check_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'NEW' THEN
      RAISE EXCEPTION 'threads must start in NEW, got %', NEW.state;
    END IF;
    INSERT INTO sched.thread_events (thread_id, from_state, to_state, note)
      VALUES (NEW.id, NULL, NEW.state, 'created');
    RETURN NEW;
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  NEW.plan_version := OLD.plan_version + 1;

  ok := CASE OLD.state
    WHEN 'NEW'             THEN NEW.state IN ('PROPOSED', 'NEEDS_VIC', 'CLOSED')
    WHEN 'PROPOSED'        THEN NEW.state IN ('CLIENT_ACCEPTED', 'NEEDS_VIC', 'STALLED', 'CLOSED')
    WHEN 'CLIENT_ACCEPTED' THEN NEW.state IN ('AWAITING_VIC', 'PROPOSED', 'NEEDS_VIC', 'CLOSED')
    WHEN 'AWAITING_VIC'    THEN NEW.state IN ('BOOKED', 'PROPOSED', 'NEEDS_VIC', 'CLOSED')
    WHEN 'STALLED'         THEN NEW.state IN ('PROPOSED', 'CLIENT_ACCEPTED', 'NEEDS_VIC', 'CLOSED')
    WHEN 'NEEDS_VIC'       THEN NEW.state IN ('PROPOSED', 'AWAITING_VIC', 'BOOKED', 'CLOSED')
    WHEN 'BOOKED'          THEN NEW.state IN ('NEEDS_VIC', 'CLOSED', 'PROPOSED', 'CLIENT_ACCEPTED')
    WHEN 'CLOSED'          THEN false
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'illegal thread transition % → % (thread %)', OLD.state, NEW.state, OLD.id;
  END IF;

  INSERT INTO sched.thread_events (thread_id, from_state, to_state, note)
    VALUES (NEW.id, OLD.state, NEW.state,
            CASE NEW.state WHEN 'NEEDS_VIC' THEN NEW.escalation_reason
                           WHEN 'CLOSED'    THEN NEW.closed_reason
                           WHEN 'PROPOSED'  THEN CASE WHEN OLD.state = 'BOOKED' THEN 'client asked to reschedule' END
                           WHEN 'CLIENT_ACCEPTED' THEN CASE WHEN OLD.state = 'BOOKED' THEN 'client asked to reschedule' END END);
  RETURN NEW;
END $$;

-- outbox_report: a completed move supersedes the offer the meeting used to be
-- at; everything else goes to 004's version (kept as outbox_report_v004).
DO $$
BEGIN
  IF to_regprocedure('sched.outbox_report_v004(jsonb)') IS NULL THEN
    ALTER FUNCTION sched.outbox_report(jsonb) RENAME TO outbox_report_v004;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION outbox_report(r jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  o sched.outbox;
BEGIN
  IF r->>'outcome' = 'done' THEN
    SELECT * INTO o FROM sched.outbox WHERE id = (r->>'id')::bigint;
    IF FOUND AND o.status = 'executing' AND o.kind = 'create_booking' AND o.payload ? 'move_event_id' THEN
      UPDATE sched.offers SET status = 'superseded'
       WHERE thread_id = o.thread_id AND status = 'booked' AND id <> o.offer_id;
    END IF;
  END IF;
  RETURN sched.outbox_report_v004(r);
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

INSERT INTO schema_migrations (version) VALUES ('005_reschedule') ON CONFLICT DO NOTHING;
