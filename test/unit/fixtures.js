'use strict';
// Shared fixtures for unit tests: a realistic context as load_context() returns it.
const VIC = {
  id: 1, upn: 'vic@bluzonebio.com', display_name: 'Vic Suarez', first_name: 'Vic', timezone: 'America/New_York',
  working_hours: { mon: ['09:00', '17:00'], tue: ['09:00', '17:00'], wed: ['09:00', '17:00'], thu: ['09:00', '17:00'], fri: ['09:00', '16:00'], sat: null, sun: null },
  preferred_start: '09:30:00', preferred_end: '16:00:00', default_duration_min: 30, default_location: 'teams',
  office_address: '123 Main St, Frederick, MD', hard_gap_min: 5, preferred_gap_min: 30, in_person_buffer_min: 30,
  max_meetings_per_day: 6, min_notice_hours: 24, search_window_days: 10, offers_per_round: 3, bcc_after_intro: true, enrolled: true,
};

const SETTINGS = {
  mode: 'live', sarah_upn: 'sarah.johnson@bluzonebio.com', sarah_name: 'Sarah Johnson',
  signature_title: 'Scheduling Assistant to Vic Suarez (AI)', company_name: 'Blu Zone Bio',
  internal_domains: ['bluzonebio.com'], alert_address: 'casey@bluzonebio.com',
  graph_base_url: 'https://graph.test/v1.0', litellm_url: 'http://litellm.test/v1/chat/completions', llm_model: 'qwen-test',
  max_rounds: 4, holds_enabled: true, slot_step_min: 30, widen_window_days: 7,
};

// Monday 2026-10-05 10:00 EDT
const NOW = '2026-10-05T14:00:00+00:00';

function message(over = {}) {
  return {
    id: 101, direction: 'in', internet_message_id: '<m101@x>', graph_message_id: 'G-101', conversation_id: 'CONV-1',
    from_address: 'vic@bluzonebio.com', from_name: 'Vic Suarez',
    to_addresses: ['dana@acme-bio.com'], cc_addresses: ['sarah.johnson@bluzonebio.com'],
    recipient_names: { 'dana@acme-bio.com': 'Dana Whitfield', 'sarah.johnson@bluzonebio.com': 'Sarah Johnson' },
    subject: 'Intro: Dana / Vic', body_text: 'Dana, great to meet you. Sarah will find us a time.',
    headers: { auth_as: 'Internal' }, event_at: '2026-10-05T13:58:00+00:00',
    ...over,
  };
}

function thread(over = {}) {
  return {
    id: 7, conversation_id: 'CONV-1', vic_conversation_id: null, employee_id: 1, state: 'PROPOSED',
    subject: 'Intro: Dana / Vic', topic: null, client_addresses: ['dana@acme-bio.com'],
    client_names: { 'dana@acme-bio.com': 'Dana Whitfield' }, other_internal: [], duration_min: 30,
    location_type: 'teams', location_text: null, constraints: {}, round_count: 1, employee_moved_to_bcc: true,
    accepted_offer_id: null, booked_event_id: null, vic_clarify_asked: false, trigger_message_id: '<m100@x>',
    ...over,
  };
}

function offers() {
  return [
    { id: 11, thread_id: 7, employee_id: 1, round: 1, option_no: 1, start: '2026-10-06T14:00:00+00:00', end: '2026-10-06T14:30:00+00:00', status: 'offered', flags: [], hold_event_id: 'H11' },
    { id: 12, thread_id: 7, employee_id: 1, round: 1, option_no: 2, start: '2026-10-07T14:00:00+00:00', end: '2026-10-07T14:30:00+00:00', status: 'offered', flags: [], hold_event_id: 'H12' },
    { id: 13, thread_id: 7, employee_id: 1, round: 1, option_no: 3, start: '2026-10-08T14:00:00+00:00', end: '2026-10-08T14:30:00+00:00', status: 'offered', flags: [], hold_event_id: 'H13' },
  ];
}

function ctx(over = {}) {
  return {
    now: NOW, event: { type: 'message', message_id: 101 }, settings: { ...SETTINGS }, employees: [VIC],
    message: message(), match_kind: null, thread: null, thread_offers: [], live_offers: [],
    reply_target: message(), history: [], open_outbox: 0,
    ...over,
  };
}

// A reply from the client in the thread
function clientCtx(body, over = {}) {
  const th = thread(over.thread || {});
  const offs = over.offers || offers();
  const msg = message({ id: 102, internet_message_id: '<m102@acme>', graph_message_id: 'G-102', from_address: 'dana@acme-bio.com',
    from_name: 'Dana Whitfield', to_addresses: ['sarah.johnson@bluzonebio.com'], cc_addresses: [], subject: 'RE: Intro: Dana / Vic',
    body_text: body, headers: { auth_as: 'Anonymous' } });
  return ctx({ message: msg, match_kind: 'conversation', thread: th, thread_offers: offs,
               live_offers: offs.filter((o) => o.status === 'offered' || o.status === 'accepted'), reply_target: msg, ...over.ctx });
}

// OpenAI-style response carrying a JSON object
function llm(obj, prefix = '') {
  return { choices: [{ message: { role: 'assistant', content: prefix + JSON.stringify(obj) } }] };
}

function graphEvent(startIso, endIso, over = {}) {
  const toUtc = (iso) => new Date(iso).toISOString().replace('Z', '').replace(/\.\d{3}$/, '.0000000');
  return { id: `E-${startIso}`, subject: 'Busy', start: { dateTime: toUtc(startIso), timeZone: 'UTC' },
           end: { dateTime: toUtc(endIso), timeZone: 'UTC' }, showAs: 'busy', isAllDay: false, isCancelled: false,
           categories: [], responseStatus: { response: 'organizer' }, ...over };
}

const NO_CONSTRAINTS = { earliest_date: null, latest_date: null, days_of_week: [], time_of_day: 'any' };

module.exports = { VIC, SETTINGS, NOW, message, thread, offers, ctx, clientCtx, llm, graphEvent, NO_CONSTRAINTS };
