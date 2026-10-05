'use strict';
// The processor's brain, split into the four steps the n8n workflow runs:
//
//   start(ctx)            route the event; build the classification request
//   interpret(S, llmResp) turn the classification into an action
//   act(S, calendarResp)  compute slots / checks; build the plan (+ email to draft)
//   finish(S, llmResp)    validate the drafted email (or use the template); final plan
//
// S is plain JSON so it can pass between n8n Code nodes. Every fact in an
// outgoing email (times, recipients, what happens next) is decided here in
// code; the model only classifies and writes words around placeholders.
const { DateTime } = require('./luxon');
const U = require('./util');
const F = require('./format');
const SL = require('./slots');
const P = require('./prompts');
const L = require('./llm');
const D = require('./draft');
const { route } = require('./route');

const CALENDAR_ACTIONS = new Set(['start', 'propose', 'accept_offer', 'counter_times', 'book']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const ZONE_ALIASES = {
  'america/new_york': ['et', 'est', 'edt', 'eastern', 'eastern time', 'new york'],
  'america/chicago': ['ct', 'cst', 'cdt', 'central', 'central time'],
  'america/denver': ['mt', 'mst', 'mdt', 'mountain', 'mountain time'],
  'america/los_angeles': ['pt', 'pst', 'pdt', 'pacific', 'pacific time'],
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const employeeById = (ctx, id) => (ctx.employees || []).find((e) => e.id === id);

function employeeOf(S) {
  if (S.ctx.thread) return employeeById(S.ctx, S.ctx.thread.employee_id);
  return S.route.employee;
}

function liveOffers(ctx, employeeId, excludeThreadId) {
  return (ctx.live_offers || []).filter((o) => o.employee_id === employeeId && o.thread_id !== excludeThreadId);
}

const threadOffers = (ctx) => ctx.thread_offers || [];
const liveThreadOffers = (ctx) => threadOffers(ctx).filter((o) => o.status === 'offered' || o.status === 'accepted');

function sanitizeConstraints(c, todayIso) {
  c = c || {};
  const date = (d) => (typeof d === 'string' && DATE_RE.test(d) ? d : null);
  let earliest = date(c.earliest_date);
  let latest = date(c.latest_date);
  if (latest && todayIso && latest < todayIso) latest = null;
  if (earliest && latest && earliest > latest) [earliest, latest] = [latest, earliest];
  return {
    earliest_date: earliest,
    latest_date: latest,
    days_of_week: U.unique((c.days_of_week || []).map(U.lower).filter((d) => SL.DAY_KEYS.includes(d))),
    time_of_day: ['morning', 'afternoon'].includes(c.time_of_day) ? c.time_of_day : 'any',
  };
}

const hasConstraints = (c) => !!(c && (c.earliest_date || c.latest_date || (c.days_of_week || []).length || (c.time_of_day && c.time_of_day !== 'any')));

function sanitizeTimes(times) {
  return (Array.isArray(times) ? times : [])
    .filter((t) => t && DATE_RE.test(t.date) && TIME_RE.test(String(t.time).trim()))
    .map((t) => ({ date: t.date, time: String(t.time).trim().padStart(5, '0') }))
    .slice(0, 3);
}

function constraintsFromTimes(times) {
  const dates = times.map((t) => t.date).sort();
  return dates.length ? { earliest_date: dates[0], latest_date: dates[dates.length - 1], days_of_week: [], time_of_day: 'any' } : null;
}

function sameZone(text, zone) {
  const t = U.lower(text).replace(/[()]/g, '').trim();
  if (!t) return true;
  if (t === U.lower(zone)) return true;
  return (ZONE_ALIASES[U.lower(zone)] || []).includes(t);
}

function cleanTopic(t) {
  if (typeof t !== 'string') return null;
  const s = t.replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  return s || null;
}

function basePlan(ctx) {
  return {
    message_id: ctx.message ? ctx.message.id : null,
    message: { disposition: 'processed' },
    thread: { id: ctx.thread ? ctx.thread.id : null, create: null, set: {}, transitions: [] },
    offers: { update: [], insert: [] },
    outbox: [],
  };
}

function holdsEnabled(ctx) {
  return U.setting(ctx, 'holds_enabled', true) !== false;
}

// The thread as it will look after this plan (for composing emails).
function threadView(S) {
  const ctx = S.ctx;
  if (ctx.thread) {
    const t = { ...ctx.thread };
    const set = S.plan ? S.plan.thread.set : {};
    if (set.client_addresses) t.client_addresses = set.client_addresses;
    if (set.client_names) t.client_names = set.client_names;
    return t;
  }
  const c = S.plan && S.plan.thread.create;
  return c ? { id: null, ...c } : null;
}

function tidToken(S) {
  return S.ctx.thread ? String(S.ctx.thread.id) : '{{THREAD_ID}}';
}

function outboxInternal(S, purpose, mail, extra = {}) {
  S.plan.outbox.push({ kind: 'new_mail', purpose, needs_approval: false, payload: mail, ...extra });
}

function releaseOffers(S, offers, status) {
  for (const o of offers) {
    S.plan.offers.update.push({ id: o.id, status });
    if (holdsEnabled(S.ctx) || o.hold_event_id) {
      S.plan.outbox.push({
        kind: 'delete_hold', purpose: 'hold', offer_id: o.id,
        payload: { employee_upn: U.lower(employeeOf(S).upn) },
      });
    }
  }
}

// The constraints and start a new round of offers uses (doPropose).
function proposeConstraints(S, a) {
  return hasConstraints(a.constraints) ? a.constraints : ((S.ctx.thread && S.ctx.thread.constraints) || {});
}

// "None of those work": the next round starts the day after the last offered day.
function proposeWindowStart(S, a) {
  if (!a.shiftAfterLast) return null;
  const starts = threadOffers(S.ctx).map((o) => o.start).sort();
  if (!starts.length) return null;
  return DateTime.fromISO(starts[starts.length - 1], { setZone: true }).setZone(employeeOf(S).timezone)
    .plus({ days: 1 }).startOf('day').toISO();
}

// A counter-proposal that doesn't fit falls back to a round around its dates.
function counterFallbackConstraints(a) {
  return hasConstraints(a.constraints) ? a.constraints : constraintsFromTimes(a.times);
}

function windowParams(S, extra = {}) {
  const ctx = S.ctx;
  const emp = employeeOf(S);
  return {
    employee: emp,
    now: ctx.now,
    windowDays: emp.search_window_days,
    widenDays: U.setting(ctx, 'widen_window_days', 7),
    maxHorizonDays: U.setting(ctx, 'max_horizon_days', 90),
    ...extra,
  };
}

// Every span of days this action may offer or check a slot in. The calendar
// read must cover all of them, or a slot could be judged free on a partial
// calendar. A window past the horizon is left out: act() escalates it.
function calendarSpans(S) {
  const ctx = S.ctx;
  const a = S.action || {};
  const zone = employeeOf(S).timezone;
  const spans = [];
  const addWindow = (constraints, windowStart) => {
    const w = SL.searchWindow(windowParams(S, { constraints, windowStart }));
    if (!w.beyondHorizon) spans.push([w.first, w.end]);
  };
  const addOffer = (o) => spans.push([DateTime.fromISO(o.start, { setZone: true }), DateTime.fromISO(o.end, { setZone: true })]);

  if (a.type === 'start') addWindow(a.create.constraints);
  if (a.type === 'propose') addWindow(proposeConstraints(S, a), proposeWindowStart(S, a));
  if (a.type === 'accept_offer') addWindow(proposeConstraints(S, {})); // if taken → new round
  if (a.type === 'counter_times') {
    for (const t of a.times) {
      const day = DateTime.fromISO(t.date, { zone });
      if (day.isValid) spans.push([day, day.plus({ days: 1 })]);
    }
    addWindow(proposeConstraints(S, { constraints: counterFallbackConstraints(a) }));
  }
  for (const o of liveThreadOffers(ctx)) addOffer(o);
  return spans;
}

function calendarRequest(S) {
  const ctx = S.ctx;
  const emp = employeeOf(S);
  const now = DateTime.fromISO(ctx.now, { setZone: true });
  const spans = calendarSpans(S);
  let from = spans.length ? DateTime.min(...spans.map((s) => s[0])) : now;
  let to = spans.length ? DateTime.max(...spans.map((s) => s[1])) : now;
  from = from.minus({ hours: 12 });
  to = to.plus({ days: 1 });
  const iso = (d) => d.toUTC().toISO({ suppressMilliseconds: true });
  if (U.delegated(emp)) {
    // The portal's broker reads the calendar with the employee's own token. n8n
    // never sees that token; it names the employee and the window, nothing else.
    const broker = String(U.setting(ctx, 'portal_internal_url', '')).replace(/\/+$/, '');
    return { via: 'broker', url: `${broker}/internal/v1/calendar`,
             body: { employee_upn: U.lower(emp.upn), op: 'calendar_view', start: iso(from), end: iso(to) } };
  }
  const base = U.setting(ctx, 'graph_base_url', 'https://graph.microsoft.com/v1.0');
  const qs = [
    `startDateTime=${encodeURIComponent(iso(from))}`,
    `endDateTime=${encodeURIComponent(iso(to))}`,
    `$select=${encodeURIComponent('subject,start,end,showAs,isAllDay,isCancelled,categories,responseStatus')}`,
    '$top=500',
  ].join('&');
  return {
    via: 'app',
    url: `${base}/users/${encodeURIComponent(U.lower(emp.upn))}/calendarView?${qs}`,
    prefer: 'outlook.timezone="UTC"',
  };
}

function slotParams(S, busy, extra = {}) {
  const ctx = S.ctx;
  const emp = employeeOf(S);
  const t = threadView(S);
  return windowParams(S, {
    busy,
    otherOffers: liveOffers(ctx, emp.id, ctx.thread ? ctx.thread.id : null),
    durationMin: t.duration_min,
    locationType: t.location_type,
    stepMin: U.setting(ctx, 'slot_step_min', 30),
    count: emp.offers_per_round,
    ...extra,
  });
}

const shortDate = (d) => d.toFormat('ccc LLL d');

// Why no slots were found, for Vic. r is pickSlots' result.
function noSlotsReason(S, r, fallback) {
  const h = U.setting(S.ctx, 'max_horizon_days', 90);
  if (r.note === 'beyond_horizon') {
    return `The requested dates start ${shortDate(r.window.first)}, more than ${h} days out. I only schedule up to ${h} days ahead`;
  }
  return fallback(r.window);
}

// ---------------------------------------------------------------------------
// step 1: start
// ---------------------------------------------------------------------------
function start(ctx) {
  const S = { v: 1, ctx, route: route(ctx), llm: null, calendar: null, action: null, plan: null,
              email: null, classification: null, model_raw: null, done: false, log: [] };
  const r = S.route;
  if (r.kind === 'new_trigger' && r.reuseConversation) {
    // New request in an email thread whose earlier negotiation is finished:
    // decide it as a fresh trigger. The old thread stays as it is.
    S.ctx = { ...ctx, thread: null, thread_offers: [], match_kind: null, reply_target: ctx.message, open_outbox: [] };
    S.log.push(`new request in the conversation of finished thread #${ctx.thread.id}`);
    ctx = S.ctx;
  }
  if (r.kind === 'skip') { S.done = true; S.log.push(`skip: ${r.reason || ''}`); return S; }
  if (r.kind === 'ignore') {
    S.action = { type: 'ignore', disposition: r.disposition, attach: r.attach, alert: r.alert, notice: r.notice };
    return S;
  }
  if (r.kind === 'timer') { S.action = timerAction(r.action); return prepareCalendar(S); }

  const emp = employeeOf(S);
  const zone = emp.timezone;
  const table = F.calendarTable(ctx.now, zone, U.setting(ctx, 'max_horizon_days', 90));
  const msg = ctx.message;
  const t = ctx.thread;
  let prompt;
  if (r.kind === 'new_trigger') {
    prompt = P.classifyTriggerPrompt({ employeeFirst: emp.first_name, zone, table, from: msg.from_address, subject: msg.subject, body: msg.body_text });
  } else if (r.kind === 'client_reply') {
    const opts = threadOffers(ctx).filter((o) => o.status === 'offered');
    prompt = P.classifyClientPrompt({ employeeFirst: emp.first_name, zone, table, optionsText: F.formatSlotList(opts, zone),
                                      from: msg.from_address, subject: msg.subject, body: msg.body_text, state: t.state });
  } else if (r.kind === 'employee_confirmation') {
    const offer = threadOffers(ctx).find((o) => o.id === t.accepted_offer_id);
    prompt = P.classifyConfirmationPrompt({ employeeFirst: emp.first_name, zone, table,
      whenText: offer ? F.formatSlot(offer.start, offer.end, zone) : 'the proposed time', body: msg.body_text });
  } else if (r.kind === 'employee_in_thread') {
    prompt = P.classifyEmployeeInThreadPrompt({ employeeFirst: emp.first_name, body: msg.body_text });
  }
  S.llm = L.buildRequest(ctx, prompt, { temperature: 0, maxTokens: 4096 });
  return S;
}

function timerAction(action) {
  if (action === 'client_followup') return { type: 'propose', reason: 'followup' };
  if (action === 'mark_stalled') return { type: 'stall' };
  if (action === 'remind_vic') return { type: 'remind' };
  return { type: 'ignore', disposition: 'timer_unknown' };
}

function prepareCalendar(S) {
  if (!S.done && S.action && CALENDAR_ACTIONS.has(S.action.type)) S.calendar = calendarRequest(S);
  return S;
}

// ---------------------------------------------------------------------------
// step 2: interpret the classification
// ---------------------------------------------------------------------------
function interpret(S, resp) {
  if (S.done || S.action) return S;
  const parsed = L.parseModelJson(resp, S.llm.schema);
  S.model_raw = (parsed.raw || '').slice(0, 4000);
  S.classification = parsed.ok ? parsed.value : null;
  if (!parsed.ok) S.log.push(`classification failed: ${parsed.error}`);
  S.llm = null;
  const k = S.route.kind;
  if (k === 'new_trigger') S.action = decideTrigger(S, parsed);
  else if (k === 'client_reply') S.action = decideClient(S, parsed);
  else if (k === 'employee_confirmation') S.action = decideConfirmation(S, parsed);
  else if (k === 'employee_in_thread') S.action = decideEmployeeInThread(S, parsed);
  return prepareCalendar(S);
}

function decideTrigger(S, parsed) {
  const ctx = S.ctx;
  const msg = ctx.message;
  const emp = S.route.employee;
  const cls = parsed.ok ? parsed.value : null;
  // Model unavailable: don't guess whether Vic asked for scheduling ("Sarah,
  // don't book anything yet" contains the same keywords). Alert Casey instead.
  if (!cls) return { type: 'ignore', disposition: 'ignored_model_unavailable', alert: true };
  if (!cls.is_scheduling_request) return { type: 'ignore', disposition: 'ignored_not_scheduling' };

  const sarah = U.lower(U.setting(ctx, 'sarah_upn', ''));
  const domains = U.setting(ctx, 'internal_domains', []);
  const recips = U.unique([...(msg.to_addresses || []), ...(msg.cc_addresses || [])].map(U.lower))
    .filter((a) => a !== sarah && a !== U.lower(emp.upn) && a !== U.employeeAddress(emp));
  const clients = recips.filter((a) => !U.isInternal(a, domains));
  const internal = recips.filter((a) => U.isInternal(a, domains));
  if (!clients.length) return { type: 'notify_no_clients' };

  const names = {};
  for (const a of clients) names[a] = U.sanitizeName((msg.recipient_names || {})[a]);
  const duration = Number.isInteger(cls.duration_min) && cls.duration_min >= 10 && cls.duration_min <= 240
    ? cls.duration_min : emp.default_duration_min;
  const location = ['teams', 'in_person', 'phone'].includes(cls.location) ? cls.location : emp.default_location;
  const today = DateTime.fromISO(ctx.now, { setZone: true }).setZone(emp.timezone).toISODate();
  return {
    type: 'start',
    create: {
      conversation_id: msg.conversation_id,
      employee_id: emp.id,
      subject: msg.subject,
      topic: cleanTopic(cls.topic),
      client_addresses: clients,
      client_names: names,
      other_internal: internal,
      duration_min: duration,
      location_type: location,
      location_text: cls.location_detail || (location === 'in_person' ? emp.office_address : null),
      constraints: sanitizeConstraints(cls.constraints, today),
      trigger_message_id: msg.internet_message_id,
    },
  };
}

function newPeople(S) {
  const ctx = S.ctx;
  const msg = ctx.message;
  const t = ctx.thread;
  const sarah = U.lower(U.setting(ctx, 'sarah_upn', ''));
  const domains = U.setting(ctx, 'internal_domains', []);
  const known = new Set((t.client_addresses || []).map(U.lower));
  const add = U.unique([msg.from_address, ...(msg.to_addresses || []), ...(msg.cc_addresses || [])].map(U.lower))
    .filter((a) => a && a !== sarah && !U.isInternal(a, domains) && !known.has(a));
  return add;
}

function decideClient(S, parsed) {
  const ctx = S.ctx;
  const t = ctx.thread;
  const emp = employeeOf(S);
  const cls = parsed.ok ? parsed.value : null;

  // Anyone the client adds to the thread (their EA, a colleague) becomes a
  // client, and a client's display name is learned from their own reply.
  const add = newPeople(S);
  const names = { ...(t.client_names || {}) };
  const from = U.lower(ctx.message.from_address);
  let learned = false;
  const fromName = U.sanitizeName(ctx.message.from_name);
  if (fromName && !names[from] && !U.isInternal(from, U.setting(ctx, 'internal_domains', []))) {
    names[from] = fromName;
    learned = true;
  }
  for (const a of add) {
    if (!names[a]) names[a] = U.sanitizeName((ctx.message.recipient_names || {})[a]);
  }
  if (add.length || learned) {
    S.addClients = { client_addresses: U.unique([...(t.client_addresses || []), ...add]), client_names: names };
  }

  if (!cls) return { type: 'escalate', reason: "I couldn't interpret the client's reply", handoff: false };
  const intent = cls.intent;
  const why = (base) => `${base}${cls.summary ? `: ${cls.summary}` : ''}`;
  const ack = { type: 'ignore', disposition: 'client_ack', attach: true, touch: true };

  if (t.state === 'BOOKED') {
    if (intent === 'thanks' || intent === 'accept') return ack;
    return { type: 'escalate', reason: why('Client wrote after the meeting was booked'), handoff: true, question: cls.question };
  }
  if (t.state === 'AWAITING_VIC' || t.state === 'CLIENT_ACCEPTED') {
    if (intent === 'thanks' || intent === 'accept' || intent === 'delegate') return ack;
    return { type: 'escalate', reason: why('Client wrote again while I was waiting on your confirmation'),
             handoff: intent === 'question', question: cls.question };
  }

  // PROPOSED or STALLED
  const today = DateTime.fromISO(ctx.now, { setZone: true }).setZone(emp.timezone).toISODate();
  const times = sanitizeTimes(cls.proposed_times);
  const constraints = sanitizeConstraints(cls.constraints, today);
  switch (intent) {
    case 'accept': {
      const offer = threadOffers(ctx).find((o) => o.status === 'offered' && o.option_no === cls.accepted_option);
      if (offer) return { type: 'accept_offer', offer_id: offer.id };
      // An option from an earlier email (numbers are unique per thread): take
      // that exact time again if it's still free.
      const old = threadOffers(ctx).find((o) => o.option_no === cls.accepted_option);
      if (old) {
        const st = DateTime.fromISO(old.start, { setZone: true }).setZone(emp.timezone);
        return { type: 'counter_times', times: [{ date: st.toISODate(), time: st.toFormat('HH:mm') }], constraints };
      }
      if (times.length) {
        if (cls.other_timezone && !sameZone(cls.other_timezone, emp.timezone)) {
          return { type: 'escalate', reason: `The client proposed a time in ${cls.other_timezone}; I only schedule in ${emp.timezone}`, handoff: true };
        }
        return { type: 'counter_times', times, constraints };
      }
      return { type: 'escalate', reason: why("The client accepted, but I couldn't tell which option"), handoff: false };
    }
    case 'counter':
      if (cls.other_timezone && !sameZone(cls.other_timezone, emp.timezone)) {
        return { type: 'escalate', reason: `The client proposed times in ${cls.other_timezone}; I only schedule in ${emp.timezone}`, handoff: true };
      }
      if (times.length) return { type: 'counter_times', times, constraints };
      if (hasConstraints(constraints)) return { type: 'propose', reason: 'new_round', constraints };
      // "None of those, anything later?": no usable dates, so offer a fresh
      // round after the last offered day (max_rounds still caps this).
      return { type: 'propose', reason: 'new_round', constraints, shiftAfterLast: true };
    case 'reject_all':
      return { type: 'propose', reason: 'new_round', constraints, shiftAfterLast: !hasConstraints(constraints) };
    case 'thanks':
      return ack;
    case 'delegate':
      return { type: 'ignore', disposition: 'client_delegated', attach: true, touch: true };
    case 'own_link':
      return { type: 'escalate', reason: 'The client sent their own booking link', handoff: true };
    case 'question':
      return { type: 'escalate', reason: why('The client asked a question'), handoff: true, question: cls.question };
    default:
      return { type: 'escalate', reason: why(`The client's reply needs a person (${intent})`), handoff: true, question: cls.question };
  }
}

function decideConfirmation(S, parsed) {
  const ctx = S.ctx;
  const t = ctx.thread;
  const emp = employeeOf(S);
  const cls = parsed.ok ? parsed.value : { decision: 'unclear', proposed_times: [], constraints: {} };
  const today = DateTime.fromISO(ctx.now, { setZone: true }).setZone(emp.timezone).toISODate();
  // A booking is already queued (e.g. waiting for shadow approval): a second
  // YES (or anything else) must not queue another one.
  if ((ctx.open_outbox || []).some((o) => o.kind === 'create_booking')) {
    return { type: 'ignore', disposition: 'ignored_booking_in_progress', attach: true };
  }
  switch (cls.decision) {
    case 'yes':
      return { type: 'book' };
    case 'no':
      return { type: 'propose', reason: 'employee_declined', decline_offer: t.accepted_offer_id };
    case 'alternative': {
      const times = sanitizeTimes(cls.proposed_times);
      const c = hasConstraints(sanitizeConstraints(cls.constraints, today))
        ? sanitizeConstraints(cls.constraints, today) : constraintsFromTimes(times);
      return { type: 'propose', reason: 'employee_declined', decline_offer: t.accepted_offer_id, constraints: c || undefined };
    }
    default:
      if (!t.vic_clarify_asked) return { type: 'clarify' };
      return { type: 'escalate', reason: "I couldn't understand your reply to the confirmation request", handoff: false };
  }
}

function decideEmployeeInThread(S, parsed) {
  if (parsed.ok && parsed.value.intent === 'take_over') return { type: 'close', reason: `${employeeOf(S).first_name} took over the thread` };
  return { type: 'ignore', disposition: 'employee_note', attach: true };
}

// ---------------------------------------------------------------------------
// step 3: act
// ---------------------------------------------------------------------------
function act(S, calResp) {
  if (S.done) return S;
  S.plan = basePlan(S.ctx);
  let busy = null;
  if (S.calendar) {
    S.calendar = null;
    if (needsReconnect(calResp)) {
      S.log.push('calendar read: the employee\'s token is dead (needs reconnect)');
      S.action = { type: 'escalate', reason: reconnectReason(S.ctx), handoff: false, origin: S.action, needs_reconnect: true };
    } else if (!calResp || calResp.error || !Array.isArray(calResp.value)) {
      S.log.push(`calendar read failed: ${JSON.stringify((calResp && calResp.error) || calResp).slice(0, 300)}`);
      S.action = { type: 'escalate', reason: "I couldn't read your calendar (Microsoft Graph error)", handoff: false, origin: S.action };
    } else {
      busy = SL.busyFromEvents(calResp.value);
      if (calResp['@odata.nextLink']) {
        // More events than one page: deciding on a partial calendar could double-book.
        S.action = { type: 'escalate', reason: 'Your calendar had more events than I can read in one request', handoff: false, origin: S.action };
      }
    }
  }
  if (S.addClients) Object.assign(S.plan.thread.set, S.addClients);

  const a = S.action;
  const handlers = { ignore: doIgnore, start: doStart, propose: doPropose, accept_offer: doAcceptOffer,
                     counter_times: doCounterTimes, book: doBook, escalate: doEscalate, close: doClose,
                     stall: doStall, remind: doRemind, clarify: doClarify, notify_no_clients: doNoClients };
  const h = handlers[a.type];
  if (!h) throw new Error(`unknown action ${a.type}`);
  h(S, a, busy);

  if (S.email && U.setting(S.ctx, 'llm_drafting', true) !== false) {
    S.llm = L.buildRequest(S.ctx, P.draftPrompt(S.email.facts), { temperature: 0.4, maxTokens: 4096 });
  }
  return S;
}

// The broker's answer when the employee's Microsoft sign-in is expired or revoked.
function needsReconnect(resp) {
  const e = resp && resp.error;
  return !!(e && e.status === 409 && e.body && e.body.error && e.body.error.code === 'NeedsReconnect');
}

function reconnectReason(ctx) {
  const link = D.portalLink(ctx, '/connect');
  return 'Sarah lost access to your calendar (your Microsoft sign-in for Sarah expired or was revoked). '
    + `Reconnect at ${link || 'the Sarah portal'} and then handle this thread yourself`;
}

function touchIfClient(S) {
  if (S.route.kind === 'client_reply') S.plan.thread.set.touch_inbound = true;
}

function doIgnore(S, a) {
  const ctx = S.ctx;
  S.plan.message.disposition = a.disposition;
  if (!(a.attach && ctx.thread)) S.plan.thread.id = null;
  if (a.touch) touchIfClient(S);
  if (a.notice) {
    // Paused, or calendar not connected: tell the employee why nothing happened.
    const emp = employeeOf(S);
    const mail = a.notice === 'paused' ? D.vicPausedMail(ctx, emp, (ctx.message || {}).subject)
                                       : D.vicNotConnectedMail(ctx, emp, (ctx.message || {}).subject);
    outboxInternal(S, 'vic_notice', mail, { no_thread: !S.plan.thread.id });
  }
  if (a.alert) {
    const m = ctx.message || {};
    S.plan.outbox.push({
      kind: 'notify_internal', purpose: 'alert', no_thread: !ctx.thread, needs_approval: false,
      payload: alertMail(ctx, `Ignored an email (${a.disposition})`,
        `Disposition: ${a.disposition}\nFrom: ${m.from_address}\nSubject: ${m.subject}\nAuth header: ${JSON.stringify((m.headers || {}).auth_as || null)}\n\n${String(m.body_text || '').slice(0, 1000)}`),
    });
  }
}

function alertMail(ctx, subject, body) {
  return {
    to: [{ address: U.lower(U.setting(ctx, 'alert_address', '')), name: '' }], cc: [], bcc: [],
    subject: `[Sarah] ${subject}`, body_text: body,
    body_html: `<pre style="font-family:Consolas,monospace;white-space:pre-wrap">${U.htmlEscape(body)}</pre>`,
  };
}

function facts(S, purpose, extra = {}) {
  const t = threadView(S);
  const emp = employeeOf(S);
  const names = t.client_names || {};
  // Unknown names are left out ("Dana" rather than "Dana and there"); with no
  // known name at all the greeting is "Hi there".
  const known = (t.client_addresses || []).map((a) => U.firstName(names[a], a)).filter((n) => n !== 'there');
  const firsts = known.length ? known : ['there'];
  return {
    purpose,
    employee_first: emp.first_name,
    employee_full: emp.display_name,
    company: U.setting(S.ctx, 'company_name', ''),
    recipient_first_names: firsts,
    names: U.joinNames(firsts),
    duration_min: t.duration_min,
    location: F.locationPhrase(t.location_type, t.location_text),
    location_type: t.location_type,
    bcc: !!emp.bcc_after_intro,
    client_last_message: S.route.kind === 'client_reply' ? S.ctx.message.body_text : null,
    ...extra,
  };
}

// Queue a client email. Its words are drafted in finish().
function queueClientEmail(S, purpose, fill, extra = {}) {
  const t = threadView(S);
  const emp = employeeOf(S);
  const target = S.ctx.reply_target;
  if (!target || !target.graph_message_id) throw new Error('no message to reply to for a client email');
  S.email = {
    purpose,
    fill,
    recipients: D.clientRecipients(t, emp, purpose),
    allowed: [...(t.client_addresses || []), ...(t.other_internal || []), U.employeeAddress(emp)],
    reply_target: {
      graph_message_id: target.graph_message_id, from_address: target.from_address, from_name: target.from_name,
      subject: target.subject, event_at: target.event_at, body_text: target.body_text,
    },
    facts: facts(S, purpose, extra.facts),
    depends_on_ref: extra.depends_on_ref || null,
  };
}

// Offer a set of slots: offers, holds, and the email.
function offerSlots(S, slots, round, purpose) {
  const emp = employeeOf(S);
  const t = threadView(S);
  // Option numbers are unique per thread (round 2 is 4–6, …), so "option 2"
  // from an older email can never be mistaken for a newer option 2.
  const offset = Math.max(0, ...threadOffers(S.ctx).map((o) => o.option_no));
  const offers = slots.map((s, i) => ({ ref: `o${i + 1}`, round, option_no: offset + s.option_no, start: s.start, end: s.end,
                                        score: s.score, flags: s.flags }));
  S.plan.offers.insert.push(...offers);
  if (holdsEnabled(S.ctx)) {
    for (const o of offers) {
      S.plan.outbox.push({
        kind: 'create_hold', purpose: 'hold', offer_ref: o.ref, needs_approval: false,
        payload: { employee_upn: U.lower(emp.upn), start: o.start, end: o.end, subject: `Hold: ${D.clientLabel(t)} (pending)` },
      });
    }
  }
  queueClientEmail(S, purpose, { slotsText: F.formatSlotList(offers, emp.timezone) });
}

function doStart(S, a, busy) {
  S.plan.thread.create = a.create;
  S.plan.thread.id = null;
  const emp = employeeOf(S);
  const r = SL.pickSlots(slotParams(S, busy, { constraints: a.create.constraints }));
  S.log.push(`slots: ${r.note} (${r.considered} candidates)`);
  if (!r.slots.length) {
    return doEscalate(S, { reason: noSlotsReason(S, r, (w) =>
      `No open times between ${shortDate(w.first)} and ${shortDate(w.end.minus({ days: 1 }))} fit your calendar rules`), handoff: true });
  }
  S.plan.thread.transitions.push('PROPOSED');
  Object.assign(S.plan.thread.set, { round_count: 1, employee_moved_to_bcc: !!emp.bcc_after_intro });
  offerSlots(S, r.slots, 1, 'intro');
}

function doPropose(S, a, busy) {
  const ctx = S.ctx;
  const t = ctx.thread;
  const maxRounds = U.setting(ctx, 'max_rounds', 4);
  if (t.round_count >= maxRounds && a.reason !== 'followup') {
    return doEscalate(S, { reason: `No agreement after ${t.round_count} rounds of times`, handoff: true });
  }

  const constraints = proposeConstraints(S, a);
  const windowStart = proposeWindowStart(S, a);
  // Retiring this thread's live offers frees their slots for the new round.
  const live = liveThreadOffers(ctx);
  const r = SL.pickSlots(slotParams(S, busy, {
    constraints, windowStart,
    excludeStarts: threadOffers(ctx).map((o) => o.start),
  }));
  S.log.push(`slots: ${r.note} (${r.considered} candidates)`);
  if (!r.slots.length) {
    return doEscalate(S, { reason: noSlotsReason(S, r, () => 'I ran out of open times that fit'), handoff: true });
  }

  const extra = a.extraUpdates || [];
  const declined = live.filter((o) => o.id === a.decline_offer);
  const retiring = live.filter((o) => o.id !== a.decline_offer && !extra.some((x) => x.id === o.id));
  releaseOffers(S, declined, 'declined');
  releaseOffers(S, retiring, 'superseded');
  for (const x of extra) {
    const o = live.find((y) => y.id === x.id);
    if (o) releaseOffers(S, [o], x.status);
  }

  if (t.state !== 'PROPOSED') S.plan.thread.transitions.push('PROPOSED');
  Object.assign(S.plan.thread.set, { round_count: t.round_count + 1, constraints });
  if (a.reason === 'followup') S.plan.thread.set.followup_sent = true;
  touchIfClient(S);

  const purpose = { new_round: 'new_round', followup: 'followup', taken: 'taken',
                    employee_declined: 'employee_declined', counter_unavailable: 'counter_unavailable' }[a.reason] || 'new_round';
  offerSlots(S, r.slots, t.round_count + 1, purpose);
}

// Client (or counter-proposal) picked a slot that passed its re-check.
function acceptFlow(S, slot, flags) {
  const ctx = S.ctx;
  const t = ctx.thread;
  const emp = employeeOf(S);
  const live = liveThreadOffers(ctx);

  if (slot.id) {
    S.plan.offers.update.push({ id: slot.id, status: 'accepted' });
    S.plan.thread.set.accepted_offer_id = slot.id;
  } else {
    const optionNo = Math.max(0, ...threadOffers(ctx).map((o) => o.option_no)) + 1;
    S.plan.offers.insert.push({ ref: 'acc', round: Math.max(1, t.round_count), option_no: optionNo,
                                start: slot.start, end: slot.end, score: slot.score || 0, flags: flags || [], status: 'accepted' });
    S.plan.thread.set.accepted_offer_ref = 'acc';
    if (holdsEnabled(ctx)) {
      S.plan.outbox.push({ kind: 'create_hold', purpose: 'hold', offer_ref: 'acc', needs_approval: false,
        payload: { employee_upn: U.lower(emp.upn), start: slot.start, end: slot.end, subject: `Hold: ${D.clientLabel(t)} (pending)` } });
    }
  }
  releaseOffers(S, live.filter((o) => o.id !== slot.id), 'superseded');

  S.plan.thread.transitions.push('CLIENT_ACCEPTED', 'AWAITING_VIC');
  S.plan.thread.set.vic_clarify_asked = false;
  touchIfClient(S);

  const when = F.formatSlot(slot.start, slot.end, emp.timezone);
  outboxInternal(S, 'vic_confirmation', D.vicConfirmationMail(ctx, emp, threadView(S), slot, when, flags, tidToken(S)));
  queueClientEmail(S, 'ack', { timeText: when });
}

function doAcceptOffer(S, a, busy) {
  const ctx = S.ctx;
  const offer = threadOffers(ctx).find((o) => o.id === a.offer_id);
  if (!offer || offer.status !== 'offered') {
    return doEscalate(S, { reason: 'The client accepted an option that is no longer open', handoff: false });
  }
  const check = SL.checkSlot(slotParams(S, busy), offer.start, offer.end, 'recheck');
  if (!check.ok) {
    S.log.push(`accepted slot failed re-check: ${check.reason}`);
    return doPropose(S, { reason: 'taken', extraUpdates: [{ id: offer.id, status: 'expired' }] }, busy);
  }
  acceptFlow(S, offer, check.flags);
}

function doCounterTimes(S, a, busy) {
  const ctx = S.ctx;
  const t = ctx.thread;
  const emp = employeeOf(S);
  for (const time of a.times) {
    const start = DateTime.fromISO(`${time.date}T${time.time}`, { zone: emp.timezone });
    if (!start.isValid) continue;
    const end = start.plus({ minutes: t.duration_min });
    const s = start.toUTC().toISO({ suppressMilliseconds: true });
    const e = end.toUTC().toISO({ suppressMilliseconds: true });
    const check = SL.checkSlot(slotParams(S, busy), s, e, 'propose');
    S.log.push(`counter ${time.date} ${time.time}: ${check.ok ? 'ok' : check.reason}`);
    if (check.ok) return acceptFlow(S, { start: s, end: e, score: check.score }, check.flags);
  }
  const c = counterFallbackConstraints(a);
  return doPropose(S, { reason: 'counter_unavailable', constraints: c || undefined }, busy);
}

function doBook(S, a, busy) {
  const ctx = S.ctx;
  const t = ctx.thread;
  const emp = employeeOf(S);
  const offer = threadOffers(ctx).find((o) => o.id === t.accepted_offer_id);
  if (!offer || offer.status !== 'accepted') {
    return doEscalate(S, { reason: 'You said yes, but the accepted time is no longer open', handoff: false });
  }
  const when = F.formatSlot(offer.start, offer.end, emp.timezone);
  const check = SL.checkSlot(slotParams(S, busy), offer.start, offer.end, 'booking');
  if (!check.ok) {
    return doEscalate(S, { reason: `You said yes, but ${when} now ${check.reason === 'in_the_past' ? 'has passed' : 'conflicts with something on your calendar'}`, handoff: false });
  }
  const view = threadView(S);
  const names = view.client_names || {};
  const attendees = [...(view.client_addresses || []).map((x) => ({ address: x, name: names[x] || '' })),
                     ...(view.other_internal || []).map((x) => ({ address: x, name: '' }))];
  const local = (iso) => DateTime.fromISO(iso, { setZone: true }).setZone(emp.timezone).toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const title = `${D.clientLabel(view)} / ${emp.display_name}${view.topic ? `: ${view.topic}` : ''}`;
  S.plan.outbox.push({
    ref: 'booking', kind: 'create_booking', purpose: 'booking', offer_id: offer.id, needs_approval: true,
    payload: {
      employee_upn: U.lower(emp.upn),
      subject: title,
      start: { dateTime: local(offer.start), timeZone: emp.timezone },
      end: { dateTime: local(offer.end), timeZone: emp.timezone },
      when_text: when,
      attendees,
      location_type: view.location_type,
      location_text: view.location_text,
      body_html: `<p>Scheduled by ${U.htmlEscape(U.setting(ctx, 'sarah_name', 'Sarah'))}, ${U.htmlEscape(emp.first_name)}'s AI scheduling assistant.</p>`,
    },
  });
  if (holdsEnabled(ctx) || offer.hold_event_id) {
    S.plan.outbox.push({ kind: 'delete_hold', purpose: 'hold', offer_id: offer.id, depends_on_ref: 'booking',
                         payload: { employee_upn: U.lower(emp.upn) } });
  }
  queueClientEmail(S, 'confirmed', { timeText: when }, { depends_on_ref: 'booking' });
}

function doEscalate(S, a) {
  const ctx = S.ctx;
  const emp = employeeOf(S);
  if (!ctx.thread && !S.plan.thread.create) {
    const origin = a.origin || S.action;
    if (origin && origin.type === 'start') S.plan.thread.create = origin.create;
  }
  // Discard anything a failed handler may have queued before escalating.
  S.plan.offers.insert = [];
  S.plan.outbox = S.plan.outbox.filter((o) => o.kind === 'delete_hold');
  S.email = null;
  const t = threadView(S);
  if (!t) throw new Error(`escalation with no thread: ${a.reason}`);

  S.plan.thread.set.escalation_reason = a.reason;
  S.plan.thread.transitions = ctx.thread && ctx.thread.state === 'NEEDS_VIC' ? [] : ['NEEDS_VIC'];
  S.plan.cancel_open_client_outbox = true;
  touchIfClient(S);

  const excerpt = S.route.kind === 'client_reply' ? ctx.message.body_text : null;
  const canTell = a.handoff && ctx.reply_target && ctx.reply_target.graph_message_id;
  outboxInternal(S, 'vic_notice', D.vicNoticeMail(ctx, emp, t, a.reason, excerpt, !!canTell, tidToken(S)));
  if (canTell) queueClientEmail(S, 'handoff', {}, { facts: { question: a.question || null } });
  S.action = { ...a, type: 'escalate' };
}

function doClose(S, a) {
  S.plan.cancel_open_client_outbox = true;
  S.plan.thread.set.closed_reason = a.reason;
  S.plan.thread.transitions.push('CLOSED');
  releaseOffers(S, liveThreadOffers(S.ctx), 'expired');
}

function doStall(S) {
  const emp = employeeOf(S);
  S.plan.thread.transitions.push('STALLED');
  releaseOffers(S, liveThreadOffers(S.ctx), 'expired');
  outboxInternal(S, 'vic_notice', D.vicStalledMail(S.ctx, emp, S.ctx.thread, tidToken(S)));
}

function acceptedOffer(S) {
  return threadOffers(S.ctx).find((o) => o.id === S.ctx.thread.accepted_offer_id);
}

function doRemind(S) {
  const emp = employeeOf(S);
  const offer = acceptedOffer(S);
  if (!offer) return doEscalate(S, { reason: 'Waiting on you, but I lost track of the accepted time', handoff: false });
  S.plan.thread.set.vic_reminded = true;
  outboxInternal(S, 'vic_reminder',
    D.vicReminderMail(S.ctx, emp, S.ctx.thread, offer, F.formatSlot(offer.start, offer.end, emp.timezone), tidToken(S)));
}

function doClarify(S) {
  const emp = employeeOf(S);
  const offer = acceptedOffer(S);
  if (!offer) return doEscalate(S, { reason: 'I lost track of the accepted time', handoff: false });
  S.plan.thread.set.vic_clarify_asked = true;
  outboxInternal(S, 'vic_clarify',
    D.vicClarifyMail(S.ctx, emp, S.ctx.thread, offer, F.formatSlot(offer.start, offer.end, emp.timezone), tidToken(S)));
}

function doNoClients(S) {
  const emp = employeeOf(S);
  S.plan.thread.id = null;
  S.plan.message.disposition = 'ignored_no_clients';
  outboxInternal(S, 'vic_notice', D.vicNoClientsMail(S.ctx, emp, S.ctx.message.subject), { no_thread: true });
}

// ---------------------------------------------------------------------------
// step 4: finish
// ---------------------------------------------------------------------------
function finish(S, resp) {
  if (S.done) return S;
  if (S.email) {
    const e = S.email;
    let body = null;
    let source = 'template';
    let errors = [];
    if (S.llm) {
      const parsed = L.parseModelJson(resp, 'draft');
      if (parsed.ok) {
        const v = D.validateDraft(parsed.value.body, e.purpose);
        if (v.ok) { body = v.body; source = 'model'; } else errors = v.errors;
      } else errors = [parsed.error];
    }
    if (!body) body = D.TEMPLATES[e.purpose](e.facts);
    if (errors.length) S.log.push(`draft rejected (${e.purpose}): ${errors.join('; ')}`);

    const recErrors = D.checkRecipients(S.ctx, e.recipients, e.allowed);
    if (recErrors.length) throw new Error(`recipient check failed: ${recErrors.join('; ')}`);

    const rendered = D.renderClientEmail(S.ctx, body, e.fill, e.reply_target, employeeOf(S).timezone, employeeOf(S));
    S.plan.outbox.push({
      kind: 'reply', purpose: e.purpose, depends_on_ref: e.depends_on_ref || undefined,
      needs_approval: D.hasExternal(S.ctx, e.recipients),
      payload: { reply_to_graph_id: e.reply_target.graph_message_id, ...e.recipients, ...rendered,
                 draft_source: source, draft_errors: errors },
    });
  }
  S.llm = null;
  // Decided on this version of the thread; apply_plan refuses it if the thread changed meanwhile.
  const t = S.ctx.thread;
  if (t && S.plan.thread.id === t.id && !S.plan.thread.create && t.plan_version !== undefined) {
    S.plan.thread.expected_plan_version = t.plan_version;
  }
  if (S.classification) S.plan.message.classification = S.classification;
  if (S.model_raw) S.plan.message.model_raw = S.model_raw;
  if (S.log.length) S.plan.message.classification = { ...(S.plan.message.classification || {}), _log: S.log };
  return S;
}

module.exports = {
  start, interpret, act, finish,
  // exported for tests
  sanitizeConstraints, sanitizeTimes, hasConstraints, sameZone, calendarRequest,
};
