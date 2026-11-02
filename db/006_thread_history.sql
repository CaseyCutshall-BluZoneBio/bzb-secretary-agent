-- =============================================================================
-- 006 · The conversation so far, for the model
--
-- Additive and idempotent (run after 001–005; running it twice is a no-op).
--
--   * load_context's history now holds only what the client has already seen,
--     and up to 12 emails. Sarah uses it to write replies that follow the
--     conversation and to choose which times to offer.
-- =============================================================================
SET search_path = sched, public;
SET client_min_messages = warning;

CREATE OR REPLACE FUNCTION load_context(p_event jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
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
    -- What the client has already seen, for the model that writes to them and
    -- picks their times: the client's own emails, the trigger, and Sarah's
    -- replies to them. Never the employee's confirmation replies or internal
    -- notes, so nothing private can reach a draft. The current email is
    -- passed separately.
    'history', CASE WHEN v_tid IS NULL THEN '[]'::jsonb ELSE (
        SELECT coalesce(jsonb_agg(h ORDER BY h.at), '[]') FROM (
          SELECT direction, from_address, left(body_text, 1500) AS body, coalesce(event_at, created_at) AS at
            FROM sched.messages
           WHERE thread_id = v_tid
             AND id IS DISTINCT FROM m.id
             AND conversation_id IS DISTINCT FROM t.vic_conversation_id
             AND coalesce(subject, '') !~ '\[S-\d+\]'
             AND ((direction = 'in' AND disposition NOT IN ('ignored_autoreply')
                   AND (from_address = ANY (t.client_addresses) OR internet_message_id = t.trigger_message_id))
               OR (direction = 'out' AND to_addresses && t.client_addresses))
           ORDER BY coalesce(event_at, created_at) DESC LIMIT 12) h) END,
    'open_outbox', CASE WHEN v_tid IS NULL THEN '[]'::jsonb ELSE (
        SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'purpose', purpose, 'status', status)), '[]')
          FROM sched.outbox
         WHERE thread_id = v_tid AND status IN ('pending', 'executing', 'awaiting_approval', 'approved')) END
  );
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

INSERT INTO schema_migrations (version) VALUES ('006_thread_history') ON CONFLICT DO NOTHING;
