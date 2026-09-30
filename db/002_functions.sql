-- =============================================================================
-- BZB Scheduling Agent — functions called by the n8n workflows
--
-- Every workflow talks to the database through these functions, each taking
-- and returning jsonb. That keeps each n8n Postgres node to one parameterized
-- statement, and makes every multi-row change atomic.
--
--   try_lease / release_lease   poller + executor overlap guard
--   ingest_message              poller: store an inbound email once
--   load_context                processor: everything one decision needs
--   apply_plan                  processor: apply a decision atomically
--   outbox_claim / outbox_report executor: run side effects
--   outbox_review               review webhook: approve/reject in shadow mode
--   timer_events                timers: housekeeping + follow-up/stall/remind events
-- =============================================================================
SET search_path = sched, public;

-- -----------------------------------------------------------------------------
-- Small helpers
-- -----------------------------------------------------------------------------
CREATE FUNCTION setting(p_key text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT value FROM sched.settings WHERE key = p_key
$$;

CREATE FUNCTION setting_text(p_key text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT value #>> '{}' FROM sched.settings WHERE key = p_key
$$;

CREATE FUNCTION setting_int(p_key text) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT (value #>> '{}')::int FROM sched.settings WHERE key = p_key
$$;

-- jsonb array of strings → lowercased text[]; tolerates null and a bare string
CREATE FUNCTION jtext_array(p jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(lower(x)), '{}')
    FROM jsonb_array_elements_text(
           CASE jsonb_typeof(p) WHEN 'array'  THEN p
                                WHEN 'string' THEN jsonb_build_array(p)
                                ELSE '[]'::jsonb END) AS x
$$;

CREATE FUNCTION html_escape(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

CREATE FUNCTION norm_subject(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(regexp_replace(coalesce(p, ''), '^\s*((re|fw|fwd|aw|sv)\s*:\s*)+', '', 'i')))
$$;

-- Outbox rows start 'skipped' unless the agent is allowed to act.
CREATE FUNCTION initial_outbox_status() RETURNS outbox_status LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN sched.setting_text('mode') IN ('shadow', 'live')
              THEN 'pending'::sched.outbox_status
              ELSE 'skipped'::sched.outbox_status END
$$;

CREATE FUNCTION set_mode(p_mode text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF p_mode NOT IN ('off', 'dry_run', 'shadow', 'live') THEN
    RAISE EXCEPTION 'mode must be off, dry_run, shadow or live';
  END IF;
  UPDATE sched.settings SET value = to_jsonb(p_mode) WHERE key = 'mode';
  -- Threads created in dry_run never sent anything real. Close them when Sarah
  -- starts acting, so their offers stop blocking slots and their conversations
  -- are free for real requests.
  IF p_mode IN ('shadow', 'live') THEN
    UPDATE sched.threads SET closed_reason = 'created in dry_run'
     WHERE created_mode = 'dry_run' AND state NOT IN ('CLOSED', 'BOOKED');
    UPDATE sched.threads SET state = 'CLOSED'
     WHERE created_mode = 'dry_run' AND state NOT IN ('CLOSED', 'BOOKED');
    UPDATE sched.offers f SET status = 'expired'
      FROM sched.threads d
     WHERE d.id = f.thread_id AND d.created_mode = 'dry_run' AND f.status IN ('offered', 'accepted');
  END IF;
  RETURN p_mode;
END $$;

-- -----------------------------------------------------------------------------
-- Leases: a workflow run holds one so a slow run can't overlap the next
-- -----------------------------------------------------------------------------
CREATE FUNCTION try_lease(p_name text, p_ttl_seconds int) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  k   text := 'lease:' || p_name;
  got int;
BEGIN
  INSERT INTO sched.settings (key, value, note) VALUES (k, 'null', 'workflow lease')
    ON CONFLICT (key) DO NOTHING;
  UPDATE sched.settings
     SET value = to_jsonb(now() + make_interval(secs => p_ttl_seconds))
   WHERE key = k
     AND (value = 'null'::jsonb OR (value #>> '{}')::timestamptz < now());
  GET DIAGNOSTICS got = ROW_COUNT;
  RETURN got = 1;
END $$;

CREATE FUNCTION release_lease(p_name text) RETURNS void LANGUAGE sql AS $$
  UPDATE sched.settings SET value = 'null' WHERE key = 'lease:' || p_name
$$;

-- -----------------------------------------------------------------------------
-- Alerts + system escalation (used when something breaks, not for judgment calls)
-- -----------------------------------------------------------------------------
CREATE FUNCTION enqueue_alert(p_thread_id bigint, p_subject text, p_body text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_id bigint;
  v_to text := sched.setting_text('alert_address');
BEGIN
  INSERT INTO sched.outbox (thread_id, kind, purpose, payload, status)
  VALUES (p_thread_id, 'notify_internal', 'alert',
          jsonb_build_object(
            'to', jsonb_build_array(jsonb_build_object('address', v_to, 'name', '')),
            'cc', '[]'::jsonb, 'bcc', '[]'::jsonb,
            'subject', '[Sarah] ' || p_subject,
            'body_text', p_body,
            'body_html', '<pre style="font-family:Consolas,monospace;white-space:pre-wrap">'
                         || sched.html_escape(p_body) || '</pre>'),
          sched.initial_outbox_status())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Move a thread to NEEDS_VIC if that's a legal move, and tell Casey.
CREATE FUNCTION escalate_system(p_thread_id bigint, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t sched.threads;
BEGIN
  SELECT * INTO t FROM sched.threads WHERE id = p_thread_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM sched.enqueue_alert(NULL, 'System problem', p_reason);
    RETURN;
  END IF;
  IF t.state NOT IN ('CLOSED', 'NEEDS_VIC') THEN
    UPDATE sched.threads SET escalation_reason = p_reason WHERE id = t.id;
    UPDATE sched.threads SET state = 'NEEDS_VIC' WHERE id = t.id;
  END IF;
  PERFORM sched.enqueue_alert(t.id,
    format('Thread #%s needs attention', t.id),
    format(E'%s\n\nThread #%s — %s\nClients: %s\nState: %s',
           p_reason, t.id, coalesce(t.subject, ''), array_to_string(t.client_addresses, ', '), t.state));
END $$;

-- Cancel everything that was waiting on an item that will never finish.
CREATE FUNCTION cancel_dependents(p_outbox_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  d bigint;
BEGIN
  FOR d IN SELECT id FROM sched.outbox
            WHERE depends_on = p_outbox_id AND status IN ('pending', 'approved', 'awaiting_approval')
  LOOP
    UPDATE sched.outbox SET status = 'cancelled', last_error = 'dependency did not complete' WHERE id = d;
    PERFORM sched.cancel_dependents(d);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- ingest_message: poller stores each inbound email exactly once
-- -----------------------------------------------------------------------------
CREATE FUNCTION ingest_message(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_id      bigint;
  v_start   timestamptz := (sched.setting_text('processing_start_at'))::timestamptz;
  v_sarah   text := lower(sched.setting_text('sarah_upn'));
  v_from    text := lower(p->>'from_address');
  v_at      timestamptz := (p->>'event_at')::timestamptz;
  v_skip    text;
BEGIN
  IF coalesce(p->>'internet_message_id', '') = '' THEN
    RETURN jsonb_build_object('inserted', false, 'process', false, 'reason', 'no internet_message_id');
  END IF;

  INSERT INTO sched.messages (direction, internet_message_id, graph_message_id, conversation_id,
                              from_address, from_name, to_addresses, cc_addresses, recipient_names,
                              subject, body_text, headers, event_at)
  VALUES ('in', p->>'internet_message_id', p->>'graph_message_id', p->>'conversation_id',
          v_from, p->>'from_name', sched.jtext_array(p->'to_addresses'), sched.jtext_array(p->'cc_addresses'),
          coalesce(p->'recipient_names', '{}'), p->>'subject', p->>'body_text',
          coalesce(p->'headers', '{}'), v_at)
  ON CONFLICT (internet_message_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- Seen before. If an earlier poll stored it but crashed before processing
    -- started, hand it to the processor now instead of dropping it.
    SELECT id INTO v_id FROM sched.messages
     WHERE internet_message_id = p->>'internet_message_id'
       AND processed_at IS NULL AND processing_started_at IS NULL;
    IF v_id IS NOT NULL THEN
      RETURN jsonb_build_object('id', v_id, 'inserted', false, 'process', true, 'reason', 'redelivered_unprocessed');
    END IF;
    RETURN jsonb_build_object('inserted', false, 'process', false, 'reason', 'duplicate');
  END IF;

  v_skip := CASE
    WHEN v_from = v_sarah                    THEN 'ignored_self'
    WHEN v_start IS NOT NULL AND v_at < v_start THEN 'ignored_before_start'
    WHEN coalesce((p->>'is_draft')::boolean, false) THEN 'ignored_draft'
  END;

  IF v_skip IS NOT NULL THEN
    UPDATE sched.messages SET disposition = v_skip, processed_at = now() WHERE id = v_id;
    RETURN jsonb_build_object('id', v_id, 'inserted', true, 'process', false, 'reason', v_skip);
  END IF;

  RETURN jsonb_build_object('id', v_id, 'inserted', true, 'process', true);
END $$;

-- -----------------------------------------------------------------------------
-- match_thread: which negotiation does this email belong to?
-- -----------------------------------------------------------------------------
CREATE FUNCTION match_thread(m sched.messages, OUT thread_id bigint, OUT match_kind text)
LANGUAGE plpgsql AS $$
DECLARE
  v_tok text;
BEGIN
  -- 1. same Graph conversation as a client thread
  SELECT t.id INTO thread_id FROM sched.threads t WHERE t.conversation_id = m.conversation_id
   ORDER BY t.id DESC LIMIT 1;
  IF FOUND THEN match_kind := 'conversation'; RETURN; END IF;

  -- 2. reply to Sarah's confirmation email to Vic
  SELECT t.id INTO thread_id FROM sched.threads t WHERE t.vic_conversation_id = m.conversation_id;
  IF FOUND THEN match_kind := 'confirmation'; RETURN; END IF;

  -- 3. [S-123] token in the subject (confirmation / notice emails carry it)
  v_tok := substring(coalesce(m.subject, '') FROM '\[S-(\d+)\]');
  IF v_tok IS NOT NULL THEN
    SELECT t.id INTO thread_id FROM sched.threads t WHERE t.id = v_tok::bigint;
    IF FOUND THEN match_kind := 'token'; RETURN; END IF;
  END IF;

  -- 4. client broke the thread: same sender + same normalized subject
  SELECT t.id INTO thread_id FROM sched.threads t
   WHERE t.state <> 'CLOSED'
     AND m.from_address = ANY (t.client_addresses)
     AND sched.norm_subject(t.subject) = sched.norm_subject(m.subject)
   ORDER BY t.updated_at DESC LIMIT 1;
  IF FOUND THEN match_kind := 'fallback_subject'; RETURN; END IF;

  -- 5. new subject, but this sender has exactly one open negotiation
  IF (SELECT count(*) FROM sched.threads t
       WHERE t.state IN ('PROPOSED', 'STALLED', 'CLIENT_ACCEPTED', 'AWAITING_VIC')
         AND m.from_address = ANY (t.client_addresses)) = 1 THEN
    SELECT t.id INTO thread_id FROM sched.threads t
     WHERE t.state IN ('PROPOSED', 'STALLED', 'CLIENT_ACCEPTED', 'AWAITING_VIC')
       AND m.from_address = ANY (t.client_addresses);
    match_kind := 'fallback_sender';
    RETURN;
  END IF;

  thread_id := NULL;
  match_kind := NULL;
END $$;

-- -----------------------------------------------------------------------------
-- load_context: everything the processor needs for one decision
--   event = {"type":"message","message_id":123}
--         | {"type":"timer","action":"client_followup","thread_id":45}
-- -----------------------------------------------------------------------------
CREATE FUNCTION offer_json(o sched.offers) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', o.id, 'thread_id', o.thread_id, 'employee_id', o.employee_id,
    'round', o.round, 'option_no', o.option_no,
    'start', lower(o.slot), 'end', upper(o.slot),
    'score', o.score, 'status', o.status, 'flags', to_jsonb(o.flags),
    'hold_event_id', o.hold_event_id)
$$;

CREATE FUNCTION load_context(p_event jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_type      text := p_event->>'type';
  m           sched.messages;
  t           sched.threads;
  v_tid       bigint;
  v_kind      text;
  v_msg       jsonb := NULL;
  v_thread    jsonb := NULL;
BEGIN
  IF v_type = 'message' THEN
    SELECT * INTO m FROM sched.messages WHERE id = (p_event->>'message_id')::bigint FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('skip', true, 'reason', 'message not found');
    END IF;
    IF m.processed_at IS NOT NULL THEN
      RETURN jsonb_build_object('skip', true, 'reason', 'already processed');
    END IF;
    -- Another run is working on it (overlapping polls). The sweeper takes over
    -- if that run died: after 10 minutes the email is escalated, not retried.
    IF m.processing_started_at IS NOT NULL THEN
      RETURN jsonb_build_object('skip', true, 'reason', 'already in progress');
    END IF;
    SELECT mt.thread_id, mt.match_kind INTO v_tid, v_kind FROM sched.match_thread(m) mt;
    -- Attach the email to its thread now, so if processing crashes the
    -- sweeper escalates the right thread instead of letting it run on.
    UPDATE sched.messages SET processing_started_at = now(), thread_id = coalesce(thread_id, v_tid)
     WHERE id = m.id;
    v_msg := to_jsonb(m);
  ELSIF v_type = 'timer' THEN
    v_tid := (p_event->>'thread_id')::bigint;
    v_kind := 'timer';
  ELSE
    RAISE EXCEPTION 'unknown event type %', v_type;
  END IF;

  IF v_tid IS NOT NULL THEN
    SELECT * INTO t FROM sched.threads WHERE id = v_tid;
    v_thread := to_jsonb(t);
  END IF;

  RETURN jsonb_build_object(
    'now', now(),
    'event', p_event,
    'settings', (SELECT jsonb_object_agg(key, value) FROM sched.settings WHERE key NOT LIKE 'lease:%'),
    'employees', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]') FROM sched.employees e),
    'message', v_msg,
    'match_kind', v_kind,
    'thread', v_thread,
    'thread_offers', CASE WHEN v_tid IS NULL THEN '[]'::jsonb ELSE
        (SELECT coalesce(jsonb_agg(sched.offer_json(o) ORDER BY o.round, o.option_no), '[]')
           FROM sched.offers o WHERE o.thread_id = v_tid) END,
    -- every live offer for every employee: the slot picker must avoid these
    'live_offers', (SELECT coalesce(jsonb_agg(sched.offer_json(o)), '[]')
                      FROM sched.offers o WHERE o.status IN ('offered', 'accepted')),
    -- The message Sarah replies to on the client thread: the newest email FROM
    -- A CLIENT, or Vic's original trigger (the client already saw it). Never an
    -- internal note, a colleague's reply, an auto-reply, or the confirmation
    -- thread — the reply quotes its target, so this decides what the client sees.
    'reply_target', CASE WHEN v_tid IS NULL THEN v_msg ELSE (
        SELECT to_jsonb(x) FROM (
          SELECT * FROM sched.messages
           WHERE direction = 'in' AND graph_message_id IS NOT NULL
             AND (thread_id = v_tid OR id = m.id)
             AND conversation_id IS DISTINCT FROM t.vic_conversation_id
             AND coalesce(subject, '') !~ '\[S-\d+\]'
             AND disposition NOT IN ('ignored_autoreply')
             AND (from_address = ANY (t.client_addresses) OR internet_message_id = t.trigger_message_id)
           ORDER BY event_at DESC NULLS LAST, id DESC LIMIT 1) x) END,
    'history', CASE WHEN v_tid IS NULL THEN '[]'::jsonb ELSE (
        SELECT coalesce(jsonb_agg(h ORDER BY h.at), '[]') FROM (
          SELECT direction, from_address, left(body_text, 1500) AS body, coalesce(event_at, created_at) AS at
            FROM sched.messages WHERE thread_id = v_tid
           ORDER BY coalesce(event_at, created_at) DESC LIMIT 6) h) END,
    'open_outbox', CASE WHEN v_tid IS NULL THEN '[]'::jsonb ELSE (
        SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'purpose', purpose, 'status', status)), '[]')
          FROM sched.outbox
         WHERE thread_id = v_tid AND status IN ('pending', 'executing', 'awaiting_approval', 'approved')) END
  );
END $$;

-- -----------------------------------------------------------------------------
-- apply_plan: apply one decision atomically
--
-- plan = {
--   "message_id": 123 | null,
--   "message": {"disposition": "...", "classification": {...}, "model_raw": "..."},
--   "thread": {
--     "id": 45 | null,
--     "create": {conversation_id, employee_id, subject, topic, client_addresses[], client_names{},
--                other_internal[], duration_min, location_type, location_text, constraints{},
--                trigger_message_id} | null,
--     "set": {round_count, employee_moved_to_bcc, escalation_reason, closed_reason,
--             followup_sent, vic_reminded, vic_clarify_asked, client_addresses, client_names,
--             constraints, duration_min, location_type, location_text,
--             accepted_offer_ref | accepted_offer_id, touch_inbound},
--     "transitions": ["CLIENT_ACCEPTED", "AWAITING_VIC"]
--   },
--   "offers": {"update": [{"id": 9, "status": "superseded"}],
--              "insert": [{"ref": "o1", "round": 2, "option_no": 1, "start": "...", "end": "...",
--                          "score": 100, "flags": [], "status": "offered"}]},
--   "cancel_open_client_outbox": false,   (true on escalate/close)
--   (thread.expected_plan_version: refuse the plan if the thread changed meanwhile)
--   "outbox": [{"ref": "m1", "kind": "reply", "purpose": "new_round", "payload": {...},
--               "needs_approval": true, "depends_on_ref": "b1", "offer_ref": "o1",
--               "offer_id": 9, "no_thread": false}]
-- }
-- -----------------------------------------------------------------------------
CREATE FUNCTION apply_plan(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_tid        bigint := nullif(p->'thread'->>'id', '')::bigint;
  v_create     jsonb  := p->'thread'->'create';
  s            jsonb  := coalesce(p->'thread'->'set', '{}'::jsonb);
  v_offer_ids  jsonb  := '{}';
  v_outbox_ids jsonb  := '{}';
  v_status     sched.outbox_status := sched.initial_outbox_status();
  r            jsonb;
  v_id         bigint;
  v_emp        int;
  v_ver        int;
  v_state      text;
BEGIN
  -- 1. create the thread
  IF v_create IS NOT NULL AND jsonb_typeof(v_create) = 'object' THEN
    INSERT INTO sched.threads (conversation_id, employee_id, subject, topic, client_addresses, client_names,
                               other_internal, duration_min, location_type, location_text,
                               constraints, trigger_message_id, created_mode)
    VALUES (v_create->>'conversation_id', (v_create->>'employee_id')::int, v_create->>'subject', v_create->>'topic',
            sched.jtext_array(v_create->'client_addresses'), coalesce(v_create->'client_names', '{}'),
            sched.jtext_array(v_create->'other_internal'), (v_create->>'duration_min')::int,
            v_create->>'location_type', v_create->>'location_text',
            coalesce(v_create->'constraints', '{}'), v_create->>'trigger_message_id',
            sched.setting_text('mode'))
    RETURNING id INTO v_tid;
  END IF;

  IF v_tid IS NOT NULL AND v_create IS NULL THEN
    SELECT employee_id, plan_version INTO v_emp, v_ver FROM sched.threads WHERE id = v_tid FOR UPDATE;
    -- Optimistic concurrency: the decision was made on version N. If anything
    -- changed the thread since (another email, a timer, a booking), refuse,
    -- and put the email back so it is decided again on fresh state.
    IF p->'thread' ? 'expected_plan_version'
       AND (p->'thread'->>'expected_plan_version')::int <> v_ver THEN
      IF nullif(p->>'message_id', '') IS NOT NULL THEN
        UPDATE sched.messages SET processing_started_at = NULL
         WHERE id = (p->>'message_id')::bigint AND processed_at IS NULL;
      END IF;
      RETURN jsonb_build_object('stale', true, 'thread_id', v_tid, 'expected', p->'thread'->'expected_plan_version', 'actual', v_ver);
    END IF;
    UPDATE sched.threads SET plan_version = plan_version + 1 WHERE id = v_tid;
  ELSIF v_tid IS NOT NULL THEN
    SELECT employee_id INTO v_emp FROM sched.threads WHERE id = v_tid FOR UPDATE;
  END IF;

  -- Escalating / closing: nothing still queued may reach the client or book.
  IF v_tid IS NOT NULL AND coalesce((p->>'cancel_open_client_outbox')::boolean, false) THEN
    FOR r IN SELECT to_jsonb(x) FROM sched.outbox x
              WHERE x.thread_id = v_tid AND x.kind IN ('reply', 'create_booking')
                AND x.status IN ('pending', 'awaiting_approval', 'approved') LOOP
      UPDATE sched.outbox SET status = 'cancelled', last_error = 'thread escalated or closed' WHERE id = (r->>'id')::bigint;
      PERFORM sched.cancel_dependents((r->>'id')::bigint);
    END LOOP;
  END IF;

  -- 2. offer status changes first, so superseded offers free their slots
  FOR r IN SELECT * FROM jsonb_array_elements(coalesce(p->'offers'->'update', '[]'::jsonb)) LOOP
    UPDATE sched.offers SET status = (r->>'status')::sched.offer_status
     WHERE id = (r->>'id')::bigint AND thread_id = v_tid;
  END LOOP;

  -- 3. new offers (the exclusion constraint rejects any overlap with another live offer)
  FOR r IN SELECT * FROM jsonb_array_elements(coalesce(p->'offers'->'insert', '[]'::jsonb)) LOOP
    INSERT INTO sched.offers (thread_id, employee_id, round, option_no, slot, score, flags, status)
    VALUES (v_tid, v_emp, (r->>'round')::int, (r->>'option_no')::int,
            tstzrange((r->>'start')::timestamptz, (r->>'end')::timestamptz, '[)'),
            (r->>'score')::int,
            coalesce((SELECT array_agg(x) FROM jsonb_array_elements_text(r->'flags') x), '{}'),
            coalesce(r->>'status', 'offered')::sched.offer_status)
    RETURNING id INTO v_id;
    v_offer_ids := v_offer_ids || jsonb_build_object(r->>'ref', v_id);
  END LOOP;

  -- 4. thread fields (before transitions: NEEDS_VIC / CLOSED need their reasons set)
  IF v_tid IS NOT NULL AND s <> '{}'::jsonb THEN
    UPDATE sched.threads SET
      round_count           = coalesce((s->>'round_count')::int, round_count),
      employee_moved_to_bcc = coalesce((s->>'employee_moved_to_bcc')::boolean, employee_moved_to_bcc),
      escalation_reason     = CASE WHEN s ? 'escalation_reason' THEN s->>'escalation_reason' ELSE escalation_reason END,
      closed_reason         = CASE WHEN s ? 'closed_reason' THEN s->>'closed_reason' ELSE closed_reason END,
      followup_sent_at      = CASE WHEN coalesce((s->>'followup_sent')::boolean, false) THEN now() ELSE followup_sent_at END,
      vic_reminded_at       = CASE WHEN coalesce((s->>'vic_reminded')::boolean, false) THEN now() ELSE vic_reminded_at END,
      vic_clarify_asked     = coalesce((s->>'vic_clarify_asked')::boolean, vic_clarify_asked),
      client_addresses      = CASE WHEN s ? 'client_addresses' THEN sched.jtext_array(s->'client_addresses') ELSE client_addresses END,
      client_names          = coalesce(s->'client_names', client_names),
      constraints           = coalesce(s->'constraints', constraints),
      duration_min          = coalesce((s->>'duration_min')::int, duration_min),
      location_type         = coalesce(s->>'location_type', location_type),
      location_text         = CASE WHEN s ? 'location_text' THEN s->>'location_text' ELSE location_text END,
      accepted_offer_id     = CASE
                                WHEN s ? 'accepted_offer_ref' THEN (v_offer_ids->>(s->>'accepted_offer_ref'))::bigint
                                WHEN s ? 'accepted_offer_id'  THEN (s->>'accepted_offer_id')::bigint
                                ELSE accepted_offer_id END,
      last_inbound_at       = CASE WHEN coalesce((s->>'touch_inbound')::boolean, false) THEN now() ELSE last_inbound_at END
    WHERE id = v_tid;
  END IF;

  -- 5. state transitions, in order; the trigger rejects illegal ones
  FOR v_state IN SELECT jsonb_array_elements_text(coalesce(p->'thread'->'transitions', '[]'::jsonb)) LOOP
    UPDATE sched.threads SET state = v_state::sched.thread_state WHERE id = v_tid;
  END LOOP;

  -- 6. side effects
  FOR r IN SELECT * FROM jsonb_array_elements(coalesce(p->'outbox', '[]'::jsonb)) LOOP
    INSERT INTO sched.outbox (thread_id, kind, purpose, payload, status, needs_approval, depends_on, offer_id)
    VALUES (CASE WHEN coalesce((r->>'no_thread')::boolean, false) THEN NULL ELSE v_tid END,
            (r->>'kind')::sched.outbox_kind, r->>'purpose',
            -- a new thread's id isn't known when the plan is built: fill {{THREAD_ID}} now
            replace((r->'payload')::text, '{{THREAD_ID}}', coalesce(v_tid::text, '?'))::jsonb,
            v_status,
            coalesce((r->>'needs_approval')::boolean, false),
            coalesce((v_outbox_ids->>(r->>'depends_on_ref'))::bigint, (r->>'depends_on_id')::bigint),
            coalesce((v_offer_ids->>(r->>'offer_ref'))::bigint, (r->>'offer_id')::bigint))
    RETURNING id INTO v_id;
    v_outbox_ids := v_outbox_ids || jsonb_build_object(coalesce(r->>'ref', 'x' || v_id), v_id);
  END LOOP;

  -- 7. close out the inbound message
  IF nullif(p->>'message_id', '') IS NOT NULL THEN
    UPDATE sched.messages SET
      thread_id      = coalesce(v_tid, thread_id),
      disposition    = coalesce(p->'message'->>'disposition', 'processed'),
      classification = p->'message'->'classification',
      model_raw      = p->'message'->>'model_raw',
      processed_at   = now()
    WHERE id = (p->>'message_id')::bigint;
  END IF;

  RETURN jsonb_build_object('thread_id', v_tid, 'offer_ids', v_offer_ids, 'outbox_ids', v_outbox_ids,
                            'outbox_status', v_status);
END $$;

-- Processor failed hard on a message: record it so the sweeper doesn't wait.
CREATE FUNCTION fail_message(p_message_id bigint, p_error text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  m sched.messages;
BEGIN
  SELECT * INTO m FROM sched.messages WHERE id = p_message_id;
  IF NOT FOUND OR m.processed_at IS NOT NULL THEN RETURN; END IF;
  UPDATE sched.messages SET disposition = 'error', processed_at = now() WHERE id = m.id;
  PERFORM sched.enqueue_alert(m.thread_id, 'Could not process an email',
    format(E'%s\n\nFrom: %s\nSubject: %s\nMessage row #%s', p_error, m.from_address, m.subject, m.id));
END $$;

-- -----------------------------------------------------------------------------
-- Outbox: claim → execute (n8n) → report
-- -----------------------------------------------------------------------------
CREATE FUNCTION outbox_claim(p_limit int DEFAULT 10) RETURNS SETOF jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_mode text := sched.setting_text('mode');
  o      sched.outbox;
  c      sched.outbox;
  v_ev   text;
  v_step text;
BEGIN
  IF v_mode NOT IN ('shadow', 'live') THEN
    RETURN;
  END IF;

  -- Anything waiting on a dead item will never run.
  UPDATE sched.outbox SET status = 'cancelled', last_error = 'dependency did not complete'
   WHERE status IN ('pending', 'approved')
     AND depends_on IN (SELECT id FROM sched.outbox WHERE status IN ('failed', 'cancelled', 'skipped'));

  -- delete_hold for a hold that was never created: cancel the create instead.
  FOR o IN SELECT * FROM sched.outbox WHERE status = 'pending' AND kind = 'delete_hold' LOOP
    SELECT hold_event_id INTO v_ev FROM sched.offers WHERE id = o.offer_id;
    IF v_ev IS NULL THEN
      SELECT * INTO c FROM sched.outbox
       WHERE kind = 'create_hold' AND offer_id = o.offer_id ORDER BY id DESC LIMIT 1;
      IF NOT FOUND OR c.status IN ('pending', 'cancelled', 'failed', 'skipped', 'done') THEN
        IF FOUND AND c.status = 'pending' THEN
          UPDATE sched.outbox SET status = 'cancelled', last_error = 'hold released before creation' WHERE id = c.id;
        END IF;
        UPDATE sched.outbox SET status = 'done', done_at = now(), result = '{"noop": true}' WHERE id = o.id;
      END IF;
      -- c executing/approved: leave the delete pending until the create reports back
    END IF;
  END LOOP;

  FOR o IN
    WITH ready AS (
      SELECT x.id FROM sched.outbox x
       WHERE x.status IN ('pending', 'approved')
         AND (x.depends_on IS NULL
              OR EXISTS (SELECT 1 FROM sched.outbox d WHERE d.id = x.depends_on AND d.status = 'done'))
         AND NOT (x.kind = 'delete_hold'
                  AND (SELECT hold_event_id FROM sched.offers WHERE id = x.offer_id) IS NULL)
       ORDER BY x.id
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    )
    UPDATE sched.outbox x SET status = 'executing', claimed_from = x.status, claimed_at = now()
      FROM ready WHERE x.id = ready.id
    RETURNING x.*
  LOOP
    v_step := CASE
      WHEN o.claimed_from = 'approved' AND o.kind IN ('reply', 'new_mail') THEN 'send_draft'
      WHEN o.claimed_from = 'approved'                                     THEN 'full'
      WHEN v_mode = 'shadow' AND o.needs_approval AND o.kind IN ('reply', 'new_mail') THEN 'draft_only'
      WHEN v_mode = 'shadow' AND o.needs_approval                          THEN 'await_approval'
      ELSE 'full'
    END;

    RETURN NEXT jsonb_build_object(
      'id', o.id, 'kind', o.kind, 'purpose', o.purpose, 'step', v_step,
      'thread_id', o.thread_id, 'offer_id', o.offer_id,
      'payload', o.payload
                 || CASE WHEN o.kind = 'delete_hold'
                         THEN jsonb_build_object('event_id', (SELECT hold_event_id FROM sched.offers WHERE id = o.offer_id))
                         ELSE '{}'::jsonb END,
      'draft_graph_id', o.draft_graph_id,
      'result', o.result,
      'config', jsonb_build_object(
          'graph_base_url', sched.setting_text('graph_base_url'),
          'sarah_upn', sched.setting_text('sarah_upn')));
  END LOOP;
END $$;

-- r = {"id": 1, "outcome": "done"|"awaiting_approval"|"retry"|"failed",
--      "result": {...}, "draft_graph_id": "...", "error": "..."}
CREATE FUNCTION outbox_report(r jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  o          sched.outbox;
  v_outcome  text := r->>'outcome';
  v_result   jsonb := coalesce(r->'result', '{}'::jsonb);
  v_token    text;
  v_base     text := rtrim(coalesce(sched.setting_text('n8n_base_url'), ''), '/');
  v_body     text;
  v_max      int := coalesce(sched.setting_int('outbox_max_attempts'), 3);
  v_offer    sched.offers;
  t          sched.threads;
BEGIN
  SELECT * INTO o FROM sched.outbox WHERE id = (r->>'id')::bigint FOR UPDATE;
  IF NOT FOUND OR o.status <> 'executing' THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'not executing');
  END IF;

  IF v_outcome = 'done' THEN
    UPDATE sched.outbox SET status = 'done', result = v_result, done_at = now(),
           draft_graph_id = coalesce(r->>'draft_graph_id', draft_graph_id)
     WHERE id = o.id;

    IF o.kind IN ('reply', 'new_mail', 'notify_internal') THEN
      INSERT INTO sched.messages (direction, graph_message_id, conversation_id, thread_id, from_address,
                                  to_addresses, cc_addresses, subject, body_text, event_at, disposition, processed_at)
      VALUES ('out', coalesce(r->>'draft_graph_id', o.draft_graph_id), v_result->>'conversation_id', o.thread_id,
              lower(sched.setting_text('sarah_upn')),
              (SELECT coalesce(array_agg(lower(x->>'address')), '{}') FROM jsonb_array_elements(coalesce(o.payload->'to', '[]')) x),
              (SELECT coalesce(array_agg(lower(x->>'address')), '{}') FROM jsonb_array_elements(coalesce(o.payload->'cc', '[]')) x),
              o.payload->>'subject', o.payload->>'body_text', now(), 'sent:' || o.purpose, now());

      IF o.thread_id IS NOT NULL AND o.kind IN ('reply', 'new_mail') THEN
        UPDATE sched.threads SET last_outbound_at = now() WHERE id = o.thread_id;
      END IF;
      IF o.purpose = 'vic_confirmation' AND v_result ? 'conversation_id' THEN
        UPDATE sched.threads SET vic_conversation_id = v_result->>'conversation_id' WHERE id = o.thread_id;
      END IF;

    ELSIF o.kind = 'create_hold' THEN
      UPDATE sched.offers SET hold_event_id = v_result->>'event_id' WHERE id = o.offer_id
        RETURNING * INTO v_offer;
      -- The offer died while the hold was being created: release it straight away.
      IF v_offer.status NOT IN ('offered', 'accepted') THEN
        INSERT INTO sched.outbox (thread_id, kind, purpose, payload, status, offer_id)
        VALUES (o.thread_id, 'delete_hold', 'hold',
                jsonb_build_object('employee_upn', o.payload->>'employee_upn'),
                sched.initial_outbox_status(), o.offer_id);
      END IF;

    ELSIF o.kind = 'delete_hold' THEN
      UPDATE sched.offers SET hold_event_id = NULL WHERE id = o.offer_id;

    ELSIF o.kind = 'create_booking' THEN
      UPDATE sched.offers SET status = 'booked' WHERE id = o.offer_id;
      SELECT * INTO t FROM sched.threads WHERE id = o.thread_id FOR UPDATE;
      UPDATE sched.threads SET booked_event_id = v_result->>'event_id', booked_at = now() WHERE id = t.id;
      IF t.state = 'AWAITING_VIC' THEN
        UPDATE sched.threads SET state = 'BOOKED' WHERE id = t.id;
      ELSE
        -- The thread moved on (escalated/closed) while the booking was in flight.
        PERFORM sched.enqueue_alert(t.id, format('Booking created on a %s thread', t.state),
          format(E'Thread #%s was %s when its booking completed. The event exists on the calendar (id %s).\nCheck with Vic whether to keep or cancel it.',
                 t.id, t.state, v_result->>'event_id'));
      END IF;
    END IF;

    RETURN jsonb_build_object('ok', true, 'status', 'done');

  ELSIF v_outcome = 'awaiting_approval' THEN
    v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    UPDATE sched.outbox SET status = 'awaiting_approval', approval_token = v_token,
           draft_graph_id = coalesce(r->>'draft_graph_id', draft_graph_id), result = v_result
     WHERE id = o.id;

    v_body := format(E'Sarah wants to %s.\n\nThread #%s\nPurpose: %s\n',
                     CASE o.kind WHEN 'create_booking' THEN 'book a meeting on Vic''s calendar (the client gets the invite)'
                                 ELSE 'send this email' END,
                     coalesce(o.thread_id::text, '-'), o.purpose);
    IF o.kind = 'create_booking' THEN
      v_body := v_body || format(E'When: %s\nAttendees: %s\nSubject: %s\nLocation: %s\n',
          o.payload->>'when_text',
          (SELECT string_agg(x->>'address', ', ') FROM jsonb_array_elements(o.payload->'attendees') x),
          o.payload->>'subject', coalesce(o.payload->>'location_text', o.payload->>'location_type'));
    ELSE
      v_body := v_body || format(E'To: %s\nCc: %s\nBcc: %s\nSubject: %s\n\n----------\n%s\n----------\n',
          (SELECT string_agg(x->>'address', ', ') FROM jsonb_array_elements(coalesce(o.payload->'to', '[]')) x),
          coalesce((SELECT string_agg(x->>'address', ', ') FROM jsonb_array_elements(coalesce(o.payload->'cc', '[]')) x), ''),
          coalesce((SELECT string_agg(x->>'address', ', ') FROM jsonb_array_elements(coalesce(o.payload->'bcc', '[]')) x), ''),
          coalesce(o.payload->>'subject', '(reply in thread)'), o.payload->>'body_text');
      v_body := v_body || E'The draft is also in Sarah''s Drafts folder.\n';
    END IF;
    v_body := v_body || format(E'\nAPPROVE: %s/webhook/sched-review?id=%s&t=%s&a=approve\nREJECT:  %s/webhook/sched-review?id=%s&t=%s&a=reject\n\nRejecting moves the thread to NEEDS_VIC.',
                               v_base, o.id, v_token, v_base, o.id, v_token);

    INSERT INTO sched.outbox (thread_id, kind, purpose, payload, status)
    VALUES (o.thread_id, 'notify_internal', 'review',
            jsonb_build_object(
              'to', jsonb_build_array(jsonb_build_object('address', sched.setting_text('alert_address'), 'name', '')),
              'cc', '[]'::jsonb, 'bcc', '[]'::jsonb,
              'subject', format('[Sarah review] #%s %s — thread #%s', o.id, o.purpose, coalesce(o.thread_id::text, '-')),
              'body_text', v_body,
              'body_html', '<pre style="font-family:Consolas,monospace;white-space:pre-wrap">'
                           || sched.html_escape(v_body) || '</pre>'),
            'pending');
    RETURN jsonb_build_object('ok', true, 'status', 'awaiting_approval');

  ELSE  -- retry | failed
    UPDATE sched.outbox SET attempts = attempts + 1, last_error = left(r->>'error', 2000),
           draft_graph_id = coalesce(r->>'draft_graph_id', draft_graph_id)
     WHERE id = o.id RETURNING * INTO o;

    IF v_outcome = 'failed' OR o.attempts >= v_max THEN
      UPDATE sched.outbox SET status = 'failed' WHERE id = o.id;
      PERFORM sched.cancel_dependents(o.id);
      IF o.kind <> 'notify_internal' THEN
        PERFORM sched.escalate_system(o.thread_id,
          format('Outbox #%s (%s, %s) failed after %s attempt(s): %s',
                 o.id, o.kind, o.purpose, o.attempts, left(r->>'error', 500)));
      END IF;
      RETURN jsonb_build_object('ok', true, 'status', 'failed');
    END IF;

    UPDATE sched.outbox SET status = claimed_from, claimed_at = NULL WHERE id = o.id;
    RETURN jsonb_build_object('ok', true, 'status', 'retry');
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- outbox_review: the approve/reject links in shadow-mode review emails
-- -----------------------------------------------------------------------------
CREATE FUNCTION outbox_review(p_id bigint, p_token text, p_action text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  o sched.outbox;
BEGIN
  SELECT * INTO o FROM sched.outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR o.approval_token IS NULL OR o.approval_token <> coalesce(p_token, '') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Invalid or expired review link.');
  END IF;
  IF o.status <> 'awaiting_approval' THEN
    RETURN jsonb_build_object('ok', false, 'message', format('Item #%s is already %s.', o.id, o.status));
  END IF;

  IF p_action = 'approve' THEN
    UPDATE sched.outbox SET status = 'approved',
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object('reviewed', 'approved', 'reviewed_at', now())
     WHERE id = o.id;
    RETURN jsonb_build_object('ok', true, 'message', format('Approved #%s. It goes out within a minute.', o.id));
  ELSIF p_action = 'reject' THEN
    UPDATE sched.outbox SET status = 'cancelled',
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object('reviewed', 'rejected', 'reviewed_at', now())
     WHERE id = o.id;
    PERFORM sched.cancel_dependents(o.id);
    IF o.thread_id IS NOT NULL THEN
      UPDATE sched.threads SET escalation_reason = format('Rejected in shadow review (outbox #%s, %s)', o.id, o.purpose)
       WHERE id = o.thread_id AND state NOT IN ('CLOSED', 'NEEDS_VIC');
      UPDATE sched.threads SET state = 'NEEDS_VIC'
       WHERE id = o.thread_id AND state NOT IN ('CLOSED', 'NEEDS_VIC');
    END IF;
    RETURN jsonb_build_object('ok', true,
      'message', format('Rejected #%s. Thread #%s is now NEEDS_VIC — handle it manually. The draft is still in Sarah''s Drafts; delete it there.', o.id, o.thread_id));
  END IF;
  RETURN jsonb_build_object('ok', false, 'message', 'Unknown action.');
END $$;

-- -----------------------------------------------------------------------------
-- timer_events: housekeeping, then the events that need the processor
-- -----------------------------------------------------------------------------
CREATE FUNCTION timer_events() RETURNS SETOF jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_mode      text := sched.setting_text('mode');
  v_followup  int  := sched.setting_int('client_followup_after_hours');
  v_stall     int  := sched.setting_int('stall_after_followup_hours');
  v_remind    int  := sched.setting_int('vic_reminder_after_hours');
  v_ttl       int  := sched.setting_int('hold_ttl_hours');
  v_maxage    int  := coalesce(sched.setting_int('outbox_max_age_hours'), 24);
  v_max       int  := coalesce(sched.setting_int('outbox_max_attempts'), 3);
  m           sched.messages;
  o           sched.outbox;
  t           sched.threads;
BEGIN
  IF v_mode NOT IN ('dry_run', 'shadow', 'live') THEN
    RETURN;
  END IF;

  -- a) inbound emails whose processing started but never finished
  FOR m IN SELECT * FROM sched.messages
            WHERE processed_at IS NULL AND processing_started_at < now() - interval '10 minutes'
  LOOP
    UPDATE sched.messages SET disposition = 'error_stuck', processed_at = now() WHERE id = m.id;
    IF m.thread_id IS NOT NULL THEN
      PERFORM sched.escalate_system(m.thread_id, format('Processing never finished for email #%s from %s', m.id, m.from_address));
    ELSE
      PERFORM sched.enqueue_alert(NULL, 'Could not process an email',
        format(E'Processing never finished.\nFrom: %s\nSubject: %s\nMessage row #%s', m.from_address, m.subject, m.id));
    END IF;
  END LOOP;

  -- b) outbox items stuck mid-execution (n8n crashed or restarted)
  FOR o IN SELECT * FROM sched.outbox WHERE status = 'executing' AND claimed_at < now() - interval '10 minutes' LOOP
    IF o.attempts + 1 >= v_max THEN
      UPDATE sched.outbox SET status = 'failed', attempts = attempts + 1, last_error = 'stuck executing' WHERE id = o.id;
      PERFORM sched.cancel_dependents(o.id);
      IF o.kind <> 'notify_internal' THEN
        PERFORM sched.escalate_system(o.thread_id, format('Outbox #%s (%s) kept getting stuck', o.id, o.kind));
      END IF;
    ELSE
      UPDATE sched.outbox SET status = claimed_from, attempts = attempts + 1, claimed_at = NULL,
             last_error = 'stuck executing' WHERE id = o.id;
    END IF;
  END LOOP;

  -- c) client-facing items that sat unsent too long (executor was down): don't send stale email
  IF v_mode IN ('shadow', 'live') THEN
    FOR o IN SELECT * FROM sched.outbox
              WHERE status IN ('pending', 'awaiting_approval', 'approved')
                AND kind IN ('reply', 'new_mail', 'create_booking')
                AND created_at < now() - make_interval(hours => v_maxage)
    LOOP
      UPDATE sched.outbox SET status = 'cancelled', last_error = 'expired unsent' WHERE id = o.id;
      PERFORM sched.cancel_dependents(o.id);
      PERFORM sched.escalate_system(o.thread_id, format('Outbox #%s (%s) expired unsent after %s h', o.id, o.purpose, v_maxage));
    END LOOP;
  END IF;

  -- d) offers whose time has come and gone, and offers left on threads that
  --    are finished (e.g. closed by hand) so they stop blocking Vic's slots
  UPDATE sched.offers SET status = 'expired'
   WHERE status = 'offered' AND lower(slot) < now();
  UPDATE sched.offers stale SET status = 'expired'
    FROM sched.threads fin
   WHERE fin.id = stale.thread_id AND fin.state IN ('CLOSED', 'STALLED', 'NEEDS_VIC') AND stale.status IN ('offered', 'accepted');

  -- e) release holds nobody needs any more
  INSERT INTO sched.outbox (thread_id, kind, purpose, payload, status, offer_id)
  SELECT o2.thread_id, 'delete_hold', 'hold',
         jsonb_build_object('employee_upn', e.upn), sched.initial_outbox_status(), o2.id
    FROM sched.offers o2 JOIN sched.employees e ON e.id = o2.employee_id
   WHERE o2.hold_event_id IS NOT NULL
     AND (o2.status NOT IN ('offered', 'accepted')
          OR (o2.status = 'offered' AND o2.created_at < now() - make_interval(hours => v_ttl))
          OR upper(o2.slot) < now())
     AND NOT EXISTS (SELECT 1 FROM sched.outbox x
                      WHERE x.offer_id = o2.id AND x.kind = 'delete_hold'
                        AND x.status IN ('pending', 'executing'));

  -- f) emails put back by a stale plan (or never dispatched): decide them again
  FOR m IN SELECT * FROM sched.messages
            WHERE direction = 'in' AND processed_at IS NULL AND processing_started_at IS NULL
              AND created_at < now() - interval '1 minute'
            ORDER BY id
  LOOP
    RETURN NEXT jsonb_build_object('type', 'message', 'message_id', m.id);
  END LOOP;

  -- g) conversation timers → processor events (at most one per thread per hour;
  --    never while an email on the thread is still waiting to be decided)
  FOR t IN
    SELECT * FROM sched.threads th
     WHERE th.state IN ('PROPOSED', 'AWAITING_VIC')
       AND (th.last_timer_at IS NULL OR th.last_timer_at < now() - interval '1 hour')
       AND NOT EXISTS (SELECT 1 FROM sched.messages mm WHERE mm.thread_id = th.id AND mm.direction = 'in'
                         AND mm.processed_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM sched.outbox x WHERE x.thread_id = th.id
                         AND x.status IN ('pending', 'executing', 'awaiting_approval', 'approved')
                         AND x.kind IN ('reply', 'new_mail', 'create_booking'))
  LOOP
    IF t.state = 'PROPOSED' AND t.followup_sent_at IS NULL
       AND t.last_outbound_at < now() - make_interval(hours => v_followup)
       AND (t.last_inbound_at IS NULL OR t.last_inbound_at < t.last_outbound_at) THEN
      UPDATE sched.threads SET last_timer_at = now() WHERE id = t.id;
      RETURN NEXT jsonb_build_object('type', 'timer', 'action', 'client_followup', 'thread_id', t.id);
    ELSIF t.state = 'PROPOSED' AND t.followup_sent_at IS NOT NULL
       AND t.followup_sent_at < now() - make_interval(hours => v_stall)
       AND (t.last_inbound_at IS NULL OR t.last_inbound_at < t.followup_sent_at) THEN
      UPDATE sched.threads SET last_timer_at = now() WHERE id = t.id;
      RETURN NEXT jsonb_build_object('type', 'timer', 'action', 'mark_stalled', 'thread_id', t.id);
    ELSIF t.state = 'AWAITING_VIC' AND t.vic_reminded_at IS NULL
       AND t.last_outbound_at < now() - make_interval(hours => v_remind) THEN
      UPDATE sched.threads SET last_timer_at = now() WHERE id = t.id;
      RETURN NEXT jsonb_build_object('type', 'timer', 'action', 'remind_vic', 'thread_id', t.id);
    END IF;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Status view for a quick look: SELECT * FROM sched.status;
-- -----------------------------------------------------------------------------
CREATE VIEW status AS
SELECT t.id, t.state, t.subject, array_to_string(t.client_addresses, ', ') AS clients,
       t.round_count, t.updated_at,
       (SELECT count(*) FROM sched.outbox x WHERE x.thread_id = t.id AND x.status = 'awaiting_approval') AS awaiting_review,
       coalesce(t.escalation_reason, t.closed_reason) AS reason
  FROM sched.threads t
 ORDER BY t.updated_at DESC;

-- -----------------------------------------------------------------------------
-- Pin search_path on every function in the schema. n8n connects with the
-- default search_path (public), so an unqualified name inside a function or
-- trigger would otherwise fail at runtime.
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
