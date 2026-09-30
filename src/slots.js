'use strict';
// Slot selection. Pure code, no model involvement: which times are free, which
// are "clean" (not back-to-back), and which three go in front of the client.
//
// Hard rules (a slot is never offered if it breaks one):
//   * no overlap with a busy/tentative/OOF event or another thread's live offer
//   * at least hard_gap_min on each side (in_person_buffer_min for in-person)
//   * inside working hours, at least min_notice_hours from now
//   * fewer than max_meetings_per_day meetings that day
// Soft preferences (score penalties; see docs/01-architecture.md):
//   gap before < preferred_gap_min −40 · gap after < preferred −40 ·
//   creates a run of 3+ meetings −30 · day already has 4+ meetings −15 ·
//   outside preferred hours −10
const { DateTime } = require('./luxon');
const { lower } = require('./util');

const HOLD_CATEGORY = 'Sarah hold';
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MIN = 60 * 1000;

function parseGraphTime(t) {
  if (!t || !t.dateTime) return NaN;
  // Graph returns 7 fractional digits; trim to milliseconds for Luxon.
  const iso = String(t.dateTime).replace(/(\.\d{3})\d+/, '$1');
  const zone = !t.timeZone || /^(utc|coordinated universal time)$/i.test(t.timeZone) ? 'utc' : t.timeZone;
  return DateTime.fromISO(iso, { zone }).toMillis();
}

// Graph calendarView events → busy intervals (ms). Skips free, workingElsewhere,
// cancelled, declined, Sarah's own holds (the DB's offers are authoritative for
// those), and all-day events unless they are busy or out-of-office.
function busyFromEvents(events) {
  return (events || [])
    .filter((ev) => {
      if (ev.isCancelled) return false;
      const show = lower(ev.showAs || 'busy');
      if (show === 'free' || show === 'workingelsewhere') return false;
      if ((ev.categories || []).some((c) => lower(c) === lower(HOLD_CATEGORY))) return false;
      if (ev.responseStatus && lower(ev.responseStatus.response) === 'declined') return false;
      if (ev.isAllDay && !(show === 'busy' || show === 'oof')) return false;
      return true;
    })
    .map((ev) => ({
      start: parseGraphTime(ev.start),
      end: parseGraphTime(ev.end),
      allDay: !!ev.isAllDay,
      kind: 'event',
      id: ev.id,
    }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
}

function offersToBlocks(offers) {
  return (offers || []).map((o) => ({
    start: DateTime.fromISO(o.start, { setZone: true }).toMillis(),
    end: DateTime.fromISO(o.end, { setZone: true }).toMillis(),
    allDay: false,
    kind: 'offer',
    id: o.id,
  }));
}

function parseHm(s) {
  const [h, m] = String(s).split(':').map(Number);
  return { hour: h, minute: m || 0 };
}

function timeOfDayOk(start, tod) {
  if (!tod || tod === 'any') return true;
  if (tod === 'morning') return start.hour < 12;
  if (tod === 'afternoon') return start.hour >= 12;
  return true;
}

// Context shared by candidate generation and single-slot checks.
function prepare(p) {
  const emp = p.employee;
  const zone = emp.timezone;
  const durMs = p.durationMin * MIN;
  const inPerson = p.locationType === 'in_person';
  const hardGapMs = Math.max(emp.hard_gap_min, inPerson ? emp.in_person_buffer_min || 0 : 0) * MIN;
  const prefGapMs = Math.max(emp.preferred_gap_min, hardGapMs / MIN) * MIN;
  const blocks = [...(p.busy || []), ...offersToBlocks(p.otherOffers)].sort((a, b) => a.start - b.start);
  const timed = blocks.filter((b) => !b.allDay);
  const eventsByDay = {};
  for (const b of timed) {
    if (b.kind !== 'event') continue;
    const k = DateTime.fromMillis(b.start, { zone }).toISODate();
    eventsByDay[k] = (eventsByDay[k] || 0) + 1;
  }
  const now = DateTime.fromISO(p.now, { setZone: true }).setZone(zone);
  return { emp, zone, durMs, hardGapMs, prefGapMs, blocks, timed, eventsByDay, now };
}

// Score one concrete slot. Returns null if it breaks a hard rule.
function evaluate(P, startDT, opts = {}) {
  const s = startDT.toMillis();
  const e = s + P.durMs;
  const gap = opts.ignoreGaps ? 0 : P.hardGapMs;

  for (const b of P.blocks) {
    if (b.start < e + gap && b.end > s - gap) return null;
  }

  const dayKey = startDT.toISODate();
  const dayCount = P.eventsByDay[dayKey] || 0;
  if (!opts.ignoreDayCap && dayCount >= P.emp.max_meetings_per_day) return null;

  let prevEnd = -Infinity;
  let nextStart = Infinity;
  for (const b of P.timed) {
    if (b.end <= s && b.end > prevEnd) prevEnd = b.end;
    if (b.start >= e && b.start < nextStart) nextStart = b.start;
  }
  const gapBefore = s - prevEnd;
  const gapAfter = nextStart - e;

  let score = 100;
  const flags = [];
  if (gapBefore < P.prefGapMs) { score -= 40; flags.push('back_to_back_before'); }
  if (gapAfter < P.prefGapMs) { score -= 40; flags.push('back_to_back_after'); }

  // Run length: walk the chain of meetings separated by less than the preferred gap.
  const chain = [...P.timed, { start: s, end: e, self: true }].sort((a, b) => a.start - b.start);
  const idx = chain.findIndex((x) => x.self);
  let len = 1;
  for (let i = idx; i > 0 && chain[i].start - chain[i - 1].end < P.prefGapMs; i--) len++;
  for (let i = idx; i < chain.length - 1 && chain[i + 1].start - chain[i].end < P.prefGapMs; i++) len++;
  if (len >= 3) { score -= 30; flags.push('long_run'); }

  if (dayCount >= 4) { score -= 15; flags.push('busy_day'); }

  const ps = parseHm(P.emp.preferred_start);
  const pe = parseHm(P.emp.preferred_end);
  const minutes = startDT.hour * 60 + startDT.minute;
  const endMinutes = minutes + P.durMs / MIN;
  if (minutes < ps.hour * 60 + ps.minute || endMinutes > pe.hour * 60 + pe.minute) {
    score -= 10; flags.push('outside_preferred_hours');
  }

  return {
    start: DateTime.fromMillis(s, { zone: 'utc' }).toISO({ suppressMilliseconds: true }),
    end: DateTime.fromMillis(e, { zone: 'utc' }).toISO({ suppressMilliseconds: true }),
    startMs: s,
    endMs: e,
    day: dayKey,
    score,
    flags,
    clean: !flags.includes('back_to_back_before') && !flags.includes('back_to_back_after'),
  };
}

function workingWindow(emp, day) {
  const hours = emp.working_hours ? emp.working_hours[DAY_KEYS[day.weekday - 1]] : null;
  if (!hours || !hours[0] || !hours[1]) return null;
  const ws = parseHm(hours[0]);
  const we = parseHm(hours[1]);
  return {
    start: day.set({ hour: ws.hour, minute: ws.minute, second: 0, millisecond: 0 }),
    end: day.set({ hour: we.hour, minute: we.minute, second: 0, millisecond: 0 }),
  };
}

// All hard-legal candidates in the window (+ widen days), with a pass marker.
function candidates(p) {
  const P = prepare(p);
  const c = p.constraints || {};
  const step = (p.stepMin || 30) * MIN;
  const earliest = P.now.plus({ hours: P.emp.min_notice_hours });
  const ws = p.windowStart ? DateTime.fromISO(p.windowStart, { setZone: true }).setZone(P.zone) : P.now;
  const first = (ws > P.now ? ws : P.now).startOf('day');
  const totalDays = (p.windowDays || P.emp.search_window_days) + (p.widenDays || 0);
  const exclude = new Set((p.excludeStarts || []).map((x) => DateTime.fromISO(x, { setZone: true }).toMillis()));
  const days = (c.days_of_week || []).map(lower).filter((d) => DAY_KEYS.includes(d));

  const out = [];
  for (let i = 0; i < totalDays; i++) {
    const day = first.plus({ days: i });
    const iso = day.toISODate();
    if (c.earliest_date && iso < c.earliest_date) continue;
    if (c.latest_date && iso > c.latest_date) break;
    if (days.length && !days.includes(DAY_KEYS[day.weekday - 1])) continue;
    const w = workingWindow(P.emp, day);
    if (!w) continue;
    for (let t = w.start; t.toMillis() + P.durMs <= w.end.toMillis(); t = t.plus({ milliseconds: step })) {
      if (t < earliest) continue;
      if (!timeOfDayOk(t, c.time_of_day)) continue;
      if (exclude.has(t.toMillis())) continue;
      const cand = evaluate(P, t);
      if (cand) {
        cand.pass = i < (p.windowDays || P.emp.search_window_days) ? 1 : 2;
        out.push(cand);
      }
    }
  }
  return out;
}

const byScoreThenTime = (a, b) => b.score - a.score || a.startMs - b.startMs;
const overlaps = (a, b) => a.startMs < b.endMs && b.startMs < a.endMs;

const minuteOfDay = (c) => { const d = new Date(c.startMs); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

// One slot per day first (spread across days), then fill from the rest.
// Within a day, among the top-scoring candidates, prefer a time of day far
// from the times already chosen, so the client sees a morning/afternoon mix.
function pickSpread(list, n) {
  const byDay = {};
  for (const c of list) (byDay[c.day] = byDay[c.day] || []).push(c);
  const dayBest = Object.values(byDay).map((cs) => {
    const top = Math.max(...cs.map((c) => c.score));
    return { day: cs[0].day, score: top, firstMs: Math.min(...cs.filter((c) => c.score === top).map((c) => c.startMs)),
             options: cs.filter((c) => c.score === top) };
  }).sort((a, b) => b.score - a.score || a.firstMs - b.firstMs).slice(0, n);
  const chosen = [];
  for (const d of dayBest.sort((a, b) => a.firstMs - b.firstMs)) {
    let pick = d.options.sort((a, b) => a.startMs - b.startMs)[0];
    if (chosen.length) {
      const dist = (c) => Math.min(...chosen.map((x) => Math.abs(minuteOfDay(x) - minuteOfDay(c))));
      pick = [...d.options].sort((a, b) => dist(b) - dist(a) || a.startMs - b.startMs)[0];
    }
    chosen.push(pick);
  }
  for (const c of [...list].sort(byScoreThenTime)) {
    if (chosen.length >= n) break;
    if (!chosen.includes(c) && !chosen.some((x) => overlaps(x, c))) chosen.push(c);
  }
  return chosen;
}

const distinctDays = (list) => new Set(list.map((c) => c.day)).size;

/**
 * Pick the slots to offer. Fallback order when clean slots are scarce:
 *   1. clean slots in the normal window, one per day
 *   2. widen the window by widenDays and try again
 *   3. offer fewer (but at least 2) clean slots
 *   4. only then include back-to-back slots, ranked last
 * Returns { slots: [...with option_no], note }.
 */
function pickSlots(p) {
  const n = p.count || p.employee.offers_per_round || 3;
  const all = candidates(p);
  const pass1 = all.filter((c) => c.pass === 1);
  const clean1 = pass1.filter((c) => c.clean);
  const cleanAll = all.filter((c) => c.clean);

  let chosen;
  let note;
  if (distinctDays(clean1) >= n) {
    chosen = pickSpread(clean1, n); note = 'clean';
  } else if (distinctDays(cleanAll) >= n) {
    chosen = pickSpread(cleanAll, n); note = 'clean_widened';
  } else if (cleanAll.length >= 2) {
    chosen = pickSpread(cleanAll, n); note = 'fewer_clean';
  } else {
    const clean = pickSpread(cleanAll, n);
    const rest = all.filter((c) => !c.clean && !clean.some((x) => overlaps(x, c)));
    chosen = [...clean, ...pickSpread(rest, n - clean.length)];
    note = chosen.length ? 'includes_back_to_back' : 'none';
  }

  // Clean slots first (chronological), back-to-back ones last.
  chosen.sort((a, b) => (a.clean === b.clean ? a.startMs - b.startMs : a.clean ? -1 : 1));
  const slots = chosen.map((c, i) => ({
    option_no: i + 1, start: c.start, end: c.end, score: c.score, flags: c.flags,
  }));
  return { slots, note, considered: all.length };
}

/**
 * Check one specific slot (a client's counter-proposal, or re-checking an
 * accepted slot before asking Vic / before booking).
 *   mode 'propose' — all hard rules incl. working hours + notice
 *   mode 'booking' — Vic already said yes: only a real overlap blocks it
 */
function checkSlot(p, startIso, endIso, mode = 'propose') {
  const P = prepare(p);
  const start = DateTime.fromISO(startIso, { setZone: true }).setZone(P.zone);
  const end = DateTime.fromISO(endIso, { setZone: true }).setZone(P.zone);
  P.durMs = end.toMillis() - start.toMillis();

  if (mode === 'propose') {
    const w = workingWindow(P.emp, start.startOf('day'));
    if (!w || start < w.start || end > w.end) return { ok: false, reason: 'outside_working_hours' };
    if (start < P.now.plus({ hours: P.emp.min_notice_hours })) return { ok: false, reason: 'too_soon' };
  } else if (start < P.now) {
    return { ok: false, reason: 'in_the_past' };
  }

  const r = evaluate(P, start, mode === 'booking' ? { ignoreGaps: true, ignoreDayCap: true } : {});
  if (!r) return { ok: false, reason: 'conflict' };
  return { ok: true, flags: r.flags, score: r.score };
}

module.exports = {
  HOLD_CATEGORY, DAY_KEYS, parseGraphTime, busyFromEvents, offersToBlocks,
  candidates, pickSlots, checkSlot, evaluate, prepare,
};
