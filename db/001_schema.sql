-- =============================================================================
-- BZB Scheduling Agent ("Sarah") — schema
-- Apply order: 001_schema.sql → 002_functions.sql → 003_seed.sql
-- See docs/02-database.md.
--
-- Invariants enforced here rather than trusted to workflow code:
--   * an inbound email is processed at most once (unique internet_message_id)
--   * live offers for one employee never overlap, across all threads
--   * threads only move along legal state transitions; every move is logged
--   * every side effect (email, calendar write) goes through the outbox, so the
--     run mode (off / dry_run / shadow / live) is enforced in one place
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- trusted extension: DB owner can create it

CREATE SCHEMA IF NOT EXISTS sched;
SET search_path = sched, public;

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------
CREATE TYPE thread_state AS ENUM (
  'NEW',             -- trigger email received, nothing sent yet
  'PROPOSED',        -- slots offered, waiting on the client
  'CLIENT_ACCEPTED', -- client picked a slot; re-checking the calendar before asking Vic
  'AWAITING_VIC',    -- confirmation request sent to Vic, waiting on YES/NO
  'BOOKED',          -- event on Vic's calendar, client invited
  'NEEDS_VIC',       -- escalated: a person has to handle it
  'STALLED',         -- client went quiet after the one follow-up
  'CLOSED'           -- terminal
);

CREATE TYPE offer_status  AS ENUM ('offered', 'accepted', 'declined', 'superseded', 'expired', 'booked');
CREATE TYPE msg_direction AS ENUM ('in', 'out');
CREATE TYPE outbox_kind   AS ENUM ('reply', 'new_mail', 'notify_internal', 'create_hold', 'delete_hold', 'create_booking');
CREATE TYPE outbox_status AS ENUM (
  'pending',            -- waiting to run (or waiting on depends_on)
  'executing',          -- claimed by the executor
  'awaiting_approval',  -- shadow mode: draft exists, waiting for Casey
  'approved',           -- Casey approved; executor sends it next run
  'done',
  'failed',             -- gave up after max attempts
  'cancelled',
  'skipped'             -- dry_run mode: recorded, never executed
);

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- settings: run mode, config, tunables, poller cursor, leases
-- -----------------------------------------------------------------------------
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER settings_touch BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- employees: one row per enrolled person (Vic only for v1)
-- -----------------------------------------------------------------------------
CREATE TABLE employees (
  id                    serial PRIMARY KEY,
  upn                   text NOT NULL UNIQUE CHECK (upn = lower(upn)),
  display_name          text NOT NULL,
  first_name            text NOT NULL,
  timezone              text NOT NULL,                  -- IANA; every proposed time uses this
  -- {"mon":["09:00","17:00"], ..., "sat":null}; null/missing day = not bookable
  working_hours         jsonb NOT NULL,
  preferred_start       time NOT NULL,                  -- soft: outside gets a small penalty
  preferred_end         time NOT NULL,
  default_duration_min  int  NOT NULL CHECK (default_duration_min BETWEEN 10 AND 240),
  default_location      text NOT NULL DEFAULT 'teams'
                        CHECK (default_location IN ('teams', 'in_person', 'phone')),
  office_address        text,
  hard_gap_min          int  NOT NULL DEFAULT 5  CHECK (hard_gap_min >= 0),
  preferred_gap_min     int  NOT NULL DEFAULT 30 CHECK (preferred_gap_min >= hard_gap_min),
  in_person_buffer_min  int  NOT NULL DEFAULT 30 CHECK (in_person_buffer_min >= 0),  -- travel, each side
  max_meetings_per_day  int  NOT NULL DEFAULT 6  CHECK (max_meetings_per_day > 0),
  min_notice_hours      int  NOT NULL DEFAULT 24 CHECK (min_notice_hours >= 0),
  search_window_days    int  NOT NULL DEFAULT 10 CHECK (search_window_days BETWEEN 1 AND 60),
  offers_per_round      int  NOT NULL DEFAULT 3  CHECK (offers_per_round BETWEEN 1 AND 5),
  bcc_after_intro       boolean NOT NULL DEFAULT true,
  enrolled              boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (preferred_end > preferred_start)
);
CREATE TRIGGER employees_touch BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- threads: one scheduling negotiation
-- -----------------------------------------------------------------------------
CREATE TABLE threads (
  id                     bigserial PRIMARY KEY,
  conversation_id        text NOT NULL,                  -- Graph conversationId of the client thread (see partial unique index)
  vic_conversation_id    text UNIQUE,                    -- conversationId of Sarah's confirmation email to Vic
  employee_id            int  NOT NULL REFERENCES employees(id),
  state                  thread_state NOT NULL DEFAULT 'NEW',
  subject                text,
  topic                  text,                           -- short topic for the calendar title, if Vic gave one
  -- Lowercased. Only these addresses (plus the employee) may continue the
  -- thread; outbound recipients are validated against this list.
  client_addresses       text[] NOT NULL CHECK (cardinality(client_addresses) > 0),
  client_names           jsonb NOT NULL DEFAULT '{}',    -- address → display name from headers
  other_internal         text[] NOT NULL DEFAULT '{}',   -- other BZB people Vic CC'd
  duration_min           int  NOT NULL CHECK (duration_min BETWEEN 10 AND 240),
  location_type          text NOT NULL CHECK (location_type IN ('teams', 'in_person', 'phone')),
  location_text          text,
  constraints            jsonb NOT NULL DEFAULT '{}',    -- merged client/Vic constraints (date range, days, time of day)
  round_count            int  NOT NULL DEFAULT 0,
  employee_moved_to_bcc  boolean NOT NULL DEFAULT false,
  accepted_offer_id      bigint,                         -- FK added below (circular)
  booked_event_id        text,
  booked_at              timestamptz,
  followup_sent_at       timestamptz,
  vic_reminded_at        timestamptz,
  vic_clarify_asked      boolean NOT NULL DEFAULT false, -- asked Vic once to answer YES/NO
  last_inbound_at        timestamptz,
  last_outbound_at       timestamptz,
  last_timer_at          timestamptz,                    -- timer events fire at most hourly per thread
  plan_version           int  NOT NULL DEFAULT 0,        -- bumped by every plan + state change; stale plans are refused
  created_mode           text,                           -- run mode when created (dry_run threads are closed on go-live)
  trigger_message_id     text NOT NULL,
  escalation_reason      text,
  closed_reason          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'BOOKED'    OR booked_event_id IS NOT NULL),
  CHECK (state <> 'NEEDS_VIC' OR escalation_reason IS NOT NULL),
  CHECK (state <> 'CLOSED'    OR closed_reason IS NOT NULL)
);
CREATE INDEX threads_open_idx ON threads (state) WHERE state NOT IN ('BOOKED', 'CLOSED');
-- One active negotiation per conversation. A finished one (booked, closed,
-- stalled) doesn't block Vic starting a new request in the same email thread.
CREATE UNIQUE INDEX threads_active_conversation_uq ON threads (conversation_id)
  WHERE state NOT IN ('BOOKED', 'CLOSED', 'STALLED');
CREATE INDEX threads_conversation_idx ON threads (conversation_id, id DESC);
CREATE INDEX threads_clients_idx ON threads USING gin (client_addresses);
CREATE TRIGGER threads_touch BEFORE UPDATE ON threads
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE thread_events (
  id          bigserial PRIMARY KEY,
  thread_id   bigint NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  from_state  thread_state,
  to_state    thread_state NOT NULL,
  note        text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX thread_events_thread_idx ON thread_events (thread_id, at);

-- Legal transitions only. Same-state updates (e.g. PROPOSED → PROPOSED for a
-- new round) are allowed and not logged.
CREATE FUNCTION check_transition() RETURNS trigger LANGUAGE plpgsql AS $$
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
    WHEN 'BOOKED'          THEN NEW.state IN ('NEEDS_VIC', 'CLOSED')
    WHEN 'CLOSED'          THEN false
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'illegal thread transition % → % (thread %)', OLD.state, NEW.state, OLD.id;
  END IF;

  INSERT INTO sched.thread_events (thread_id, from_state, to_state, note)
    VALUES (NEW.id, OLD.state, NEW.state,
            CASE NEW.state WHEN 'NEEDS_VIC' THEN NEW.escalation_reason
                           WHEN 'CLOSED'    THEN NEW.closed_reason END);
  RETURN NEW;
END $$;

CREATE TRIGGER threads_state_insert AFTER INSERT ON threads
  FOR EACH ROW EXECUTE FUNCTION check_transition();
CREATE TRIGGER threads_state_update BEFORE UPDATE OF state ON threads
  FOR EACH ROW EXECUTE FUNCTION check_transition();

-- -----------------------------------------------------------------------------
-- offers: every slot ever put in front of a client
-- -----------------------------------------------------------------------------
CREATE TABLE offers (
  id             bigserial PRIMARY KEY,
  thread_id      bigint NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  employee_id    int    NOT NULL REFERENCES employees(id),
  round          int    NOT NULL CHECK (round >= 1),
  option_no      int    NOT NULL CHECK (option_no >= 1),   -- "option 2" as shown to the client
  slot           tstzrange NOT NULL,
  score          int    NOT NULL,
  status         offer_status NOT NULL DEFAULT 'offered',
  hold_event_id  text,                                      -- private tentative block on Vic's calendar
  flags          text[] NOT NULL DEFAULT '{}',              -- e.g. {back_to_back_before}
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT isempty(slot) AND lower_inc(slot) AND NOT upper_inc(slot)),
  -- Two clients can never hold overlapping live offers for the same person.
  -- '[)' ranges: 10:00–10:30 and 10:30–11:00 do NOT conflict.
  EXCLUDE USING gist (employee_id WITH =, slot WITH &&)
    WHERE (status IN ('offered', 'accepted'))
);
CREATE INDEX offers_thread_idx ON offers (thread_id, round);
CREATE TRIGGER offers_touch BEFORE UPDATE ON offers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE threads
  ADD CONSTRAINT threads_accepted_offer_fk
  FOREIGN KEY (accepted_offer_id) REFERENCES offers(id)
  DEFERRABLE INITIALLY DEFERRED;

-- -----------------------------------------------------------------------------
-- messages: every inbound email the poller saw, and every outbound one
-- -----------------------------------------------------------------------------
CREATE TABLE messages (
  id                     bigserial PRIMARY KEY,
  direction              msg_direction NOT NULL,
  internet_message_id    text UNIQUE,
  graph_message_id       text,                      -- id in Sarah's mailbox (reply target)
  conversation_id        text,
  thread_id              bigint REFERENCES threads(id) ON DELETE SET NULL,
  from_address           text,
  from_name              text,
  to_addresses           text[] NOT NULL DEFAULT '{}',
  cc_addresses           text[] NOT NULL DEFAULT '{}',
  recipient_names        jsonb  NOT NULL DEFAULT '{}',
  subject                text,
  body_text              text,                      -- uniqueBody: the new part only
  headers                jsonb  NOT NULL DEFAULT '{}',  -- auth_as, auto_submitted, precedence, ...
  event_at               timestamptz,               -- receivedDateTime
  disposition            text NOT NULL DEFAULT 'received',
  classification         jsonb,
  model_raw              text,
  processing_started_at  timestamptz,
  processed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_idx ON messages (thread_id, created_at);
CREATE INDEX messages_conversation_idx ON messages (conversation_id);
CREATE INDEX messages_stuck_idx ON messages (processing_started_at)
  WHERE processed_at IS NULL AND processing_started_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- outbox: every side effect, executed by the executor workflow
-- -----------------------------------------------------------------------------
CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  thread_id       bigint REFERENCES threads(id) ON DELETE CASCADE,
  kind            outbox_kind NOT NULL,
  purpose         text NOT NULL,                  -- intro | new_round | ack | confirmed | followup | vic_confirmation | vic_notice | alert | review | hold | booking ...
  payload         jsonb NOT NULL,
  status          outbox_status NOT NULL,
  needs_approval  boolean NOT NULL DEFAULT false, -- shadow mode gates only these
  depends_on      bigint REFERENCES outbox(id),
  offer_id        bigint REFERENCES offers(id),
  approval_token  text,
  draft_graph_id  text,
  result          jsonb,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  claimed_from    outbox_status,                  -- status before 'executing', restored on retry
  claimed_at      timestamptz,
  done_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_ready_idx ON outbox (status, id) WHERE status IN ('pending', 'approved', 'executing');
CREATE INDEX outbox_thread_idx ON outbox (thread_id);
CREATE TRIGGER outbox_touch BEFORE UPDATE ON outbox
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
