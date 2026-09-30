-- =============================================================================
-- BZB Scheduling Agent — configuration + Vic's row
--
-- Everything the workflows need to know lives here, not in n8n environment
-- variables (n8n 2.x blocks $env in nodes by default, and Variables are a paid
-- feature). Change a value with:
--   UPDATE sched.settings SET value = '"new value"' WHERE key = '...';
--
-- Values marked FILL IN must be set before leaving mode 'off'.
-- Values marked CONFIRM are defaults Casey picked; go through them with Vic.
-- =============================================================================
SET search_path = sched, public;

INSERT INTO settings (key, value, note) VALUES
  -- run mode ------------------------------------------------------------------
  ('mode', '"off"',
   'off = nothing runs | dry_run = decide + log, never execute | shadow = drafts, Casey approves external mail + bookings | live = autonomous. Change with SELECT sched.set_mode(''shadow'');'),
  ('processing_start_at', to_jsonb(now()),
   'Inbound mail received before this is logged and ignored. Reset when you first leave off.'),

  -- identities ----------------------------------------------------------------
  ('sarah_upn',          '"sarah.johnson@bluzonebio.com"', 'The shared mailbox. The ONLY sender.'),
  ('sarah_name',         '"Sarah Johnson"',                'First line of the signature.'),
  ('signature_title',    '"Scheduling Assistant to Vic Suarez (AI)"', 'Second line of the signature — the AI disclosure.'),
  ('company_name',       '"Blu Zone Bio"',                 'Third line of the signature.'),
  ('internal_domains',   '["bluzonebio.com"]',             'Addresses on these domains are internal (never treated as clients).'),
  ('alert_address',      '"FILL IN: casey@bluzonebio.com"', 'Gets error alerts and shadow-mode review emails.'),

  -- endpoints -----------------------------------------------------------------
  ('graph_base_url',     '"https://graph.microsoft.com/v1.0"', 'Microsoft Graph base URL.'),
  ('litellm_url',        '"http://litellm:4000/v1/chat/completions"', 'FILL IN if n8n reaches LiteLLM by another host name.'),
  ('llm_model',          '"FILL IN: model alias in LiteLLM"', 'Model used for classification and drafting.'),
  ('n8n_base_url',       '"FILL IN: http://bzb-ai-1:5678"', 'Base URL Casey opens review links on (tailnet, not public).'),
  ('llm_json_schema',    'true', 'Send response_format json_schema to LiteLLM. Set false if the backend rejects it; parsing still works.'),
  ('llm_drafting',       'true', 'Let the model word client emails. false = always use the fixed templates.'),
  ('require_internal_auth', 'true', 'Only act on employee emails that Exchange stamped AuthAs: Internal. See docs/05-rollout.md before changing.'),

  -- behavior ------------------------------------------------------------------
  ('max_rounds',                  '4',  'Offer rounds before escalating to NEEDS_VIC.'),
  ('client_followup_after_hours', '72', 'Client silence before the one follow-up.'),
  ('stall_after_followup_hours',  '72', 'Silence after the follow-up before STALLED.'),
  ('vic_reminder_after_hours',    '4',  'AWAITING_VIC before one reminder to Vic.'),
  ('holds_enabled',               'true', 'Put private tentative holds on Vic''s calendar for offered slots.'),
  ('hold_ttl_hours',              '48', 'Holds are released after this even if the client hasn''t answered.'),
  ('slot_step_min',               '30', 'Candidate start times are on this grid.'),
  ('widen_window_days',           '7',  'If too few clean slots, look this many extra days ahead once.'),
  ('max_horizon_days',            '90', 'Furthest ahead (days from today) a requested window may start; later ones go to the employee. Also the length of the date table the model reads.'),
  ('outbox_max_attempts',         '3',  'Graph call retries before the item fails and the thread escalates.'),
  ('outbox_max_age_hours',        '24', 'Client-facing mail unsent after this long is cancelled, not sent late.'),
  ('poller_lease_seconds',        '90', 'If a poller run crashes, the next one can start after this long.'),

  -- poller cursor (managed by the poller) --------------------------------------
  ('poller_delta_link', 'null', 'Graph delta cursor for Sarah''s Inbox. Set to null to resync.');

-- Vic ------------------------------------------------------------------------
INSERT INTO employees (
  upn, display_name, first_name, timezone,
  working_hours,
  preferred_start, preferred_end,
  default_duration_min, default_location, office_address,
  hard_gap_min, preferred_gap_min, in_person_buffer_min, max_meetings_per_day,
  min_notice_hours, search_window_days, offers_per_round,
  bcc_after_intro
) VALUES (
  'vic@bluzonebio.com',                 -- FILL IN: Vic's exact UPN (lowercase)
  'Vic Suarez', 'Vic',
  'America/New_York',
  '{"mon":["09:00","17:00"],"tue":["09:00","17:00"],"wed":["09:00","17:00"],
    "thu":["09:00","17:00"],"fri":["09:00","16:00"],"sat":null,"sun":null}',   -- CONFIRM
  '09:30', '16:00',                     -- CONFIRM: preferred meeting hours (soft)
  30,                                   -- CONFIRM: default length
  'teams',
  NULL,                                 -- FILL IN: BZB office address for "in person at our office"
  5, 30, 30, 6,                         -- CONFIRM: hard gap / preferred gap / travel buffer / max per day
  24, 10, 3,                            -- CONFIRM: min notice h / look-ahead days / slots per round
  true                                  -- decided 2026-09-30: BCC after intro
);
