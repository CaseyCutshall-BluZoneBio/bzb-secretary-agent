'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const SL = require('../../src/slots');
const { VIC, NOW, graphEvent } = require('./fixtures');

const local = (iso) => DateTime.fromISO(iso).setZone('America/New_York');
const base = (over = {}) => ({ employee: VIC, now: NOW, busy: [], otherOffers: [], durationMin: 30, locationType: 'teams',
                               stepMin: 30, windowDays: 10, widenDays: 7, count: 3, ...over });

test('picks 3 clean slots on 3 different days, in order, after min notice', () => {
  const r = SL.pickSlots(base());
  assert.equal(r.slots.length, 3);
  assert.equal(r.note, 'clean');
  const days = r.slots.map((s) => local(s.start).toISODate());
  assert.equal(new Set(days).size, 3);
  assert.deepEqual(r.slots.map((s) => s.option_no), [1, 2, 3]);
  for (let i = 1; i < r.slots.length; i++) assert.ok(r.slots[i].start > r.slots[i - 1].start);
  // 24h notice from Mon 10:00 → nothing before Tue 10:00
  assert.ok(local(r.slots[0].start) >= local(NOW).plus({ hours: 24 }));
  for (const s of r.slots) assert.equal(s.score, 100);
});

test('slots stay inside working hours and preferred hours when possible', () => {
  const r = SL.pickSlots(base());
  for (const s of r.slots) {
    const st = local(s.start);
    const en = local(s.end);
    assert.ok(st.hour >= 9 && (en.hour < 17 || (en.hour === 17 && en.minute === 0)));
    assert.ok(!s.flags.includes('outside_preferred_hours'), JSON.stringify(s));
  }
});

test('never overlaps a busy event, respects the hard gap', () => {
  // Busy every weekday 9:30–16:00 local for two weeks except a 10:00–10:30 hole on Wed 10/7
  const busy = [];
  for (let d = 6; d <= 19; d++) {
    const day = DateTime.fromObject({ year: 2026, month: 10, day: d }, { zone: 'America/New_York' });
    if (day.weekday > 5) continue;
    busy.push(graphEvent(day.set({ hour: 9, minute: 30 }).toISO(), day.set({ hour: 16 }).toISO()));
  }
  const r = SL.pickSlots(base({ busy: SL.busyFromEvents(busy) }));
  for (const s of r.slots) {
    const st = local(s.start);
    const en = local(s.end);
    // must fit 9:00–9:25 (no: 30 min + 5 gap won't fit) or 16:05–17:00
    assert.ok(st.hour * 60 + st.minute >= 16 * 60 + 5 || en.hour * 60 + en.minute <= 9 * 60 + 25, `${st.toISO()}`);
  }
});

test('back-to-back only as a last resort, flagged, ranked last', () => {
  // Only openings: Tue 10/6 11:00–11:30 sandwiched (b2b), Wed 10/7 11:30–12:00 clean, rest busy
  const busy = [];
  for (let d = 5; d <= 23; d++) {
    const day = DateTime.fromObject({ year: 2026, month: 10, day: d }, { zone: 'America/New_York' });
    if (day.weekday > 5) continue;
    if (d === 6) {
      busy.push(graphEvent(day.set({ hour: 9 }).toISO(), day.set({ hour: 10, minute: 55 }).toISO()));
      busy.push(graphEvent(day.set({ hour: 11, minute: 35 }).toISO(), day.set({ hour: 17 }).toISO()));
    } else if (d === 7) {
      busy.push(graphEvent(day.set({ hour: 9 }).toISO(), day.set({ hour: 11 }).toISO()));
      busy.push(graphEvent(day.set({ hour: 12, minute: 30 }).toISO(), day.set({ hour: 17 }).toISO()));
    } else {
      busy.push(graphEvent(day.set({ hour: 9 }).toISO(), day.set({ hour: 17 }).toISO()));
    }
  }
  const r = SL.pickSlots(base({ busy: SL.busyFromEvents(busy) }));
  assert.equal(r.note, 'includes_back_to_back');
  assert.ok(r.slots.length >= 2);
  const last = r.slots[r.slots.length - 1];
  assert.ok(last.flags.includes('back_to_back_before') || last.flags.includes('back_to_back_after'));
  assert.ok(r.slots[0].flags.every((f) => !f.startsWith('back_to_back')));
});

test('widens the window when the normal window has too few clean days', () => {
  // Block every weekday in the first 10 days entirely except one
  const busy = [];
  for (let d = 5; d <= 16; d++) {
    const day = DateTime.fromObject({ year: 2026, month: 10, day: d }, { zone: 'America/New_York' });
    if (day.weekday > 5 || d === 8) continue;
    busy.push(graphEvent(day.set({ hour: 8 }).toISO(), day.set({ hour: 18 }).toISO()));
  }
  const r = SL.pickSlots(base({ busy: SL.busyFromEvents(busy) }));
  assert.equal(r.note, 'clean_widened');
  assert.equal(r.slots.length, 3);
});

test('all-day OOF blocks the day; all-day free event does not', () => {
  const tue = '2026-10-06';
  const oof = graphEvent(`${tue}T00:00:00-04:00`, '2026-10-07T00:00:00-04:00', { isAllDay: true, showAs: 'oof' });
  const r = SL.candidates(base({ busy: SL.busyFromEvents([oof]) }));
  assert.ok(!r.some((c) => c.day === tue));
  const free = graphEvent(`${tue}T00:00:00-04:00`, '2026-10-07T00:00:00-04:00', { isAllDay: true, showAs: 'free' });
  const r2 = SL.candidates(base({ busy: SL.busyFromEvents([free]) }));
  assert.ok(r2.some((c) => c.day === tue));
});

test("Sarah's own holds, cancelled and declined events are not busy", () => {
  const ev = [
    graphEvent('2026-10-06T10:00:00-04:00', '2026-10-06T10:30:00-04:00', { categories: ['Sarah hold'] }),
    graphEvent('2026-10-06T11:00:00-04:00', '2026-10-06T11:30:00-04:00', { isCancelled: true }),
    graphEvent('2026-10-06T12:00:00-04:00', '2026-10-06T12:30:00-04:00', { responseStatus: { response: 'declined' } }),
    graphEvent('2026-10-06T13:00:00-04:00', '2026-10-06T13:30:00-04:00', { showAs: 'tentative' }),
  ];
  const busy = SL.busyFromEvents(ev);
  assert.equal(busy.length, 1); // only the tentative one counts
});

test("another thread's live offer blocks the slot (no double booking)", () => {
  const taken = { id: 99, thread_id: 3, employee_id: 1, start: '2026-10-06T14:00:00Z', end: '2026-10-06T14:30:00Z' };
  const c = SL.candidates(base({ otherOffers: [taken] }));
  assert.ok(!c.some((x) => x.start === '2026-10-06T14:00:00Z'));
  assert.ok(!c.some((x) => x.start === '2026-10-06T13:30:00Z'), 'hard gap applies to offers too');
});

test('constraints: days_of_week, time_of_day, date range', () => {
  const r = SL.pickSlots(base({ constraints: { days_of_week: ['thu'], time_of_day: 'afternoon', earliest_date: null, latest_date: null } }));
  assert.ok(r.slots.length >= 1);
  for (const s of r.slots) {
    assert.equal(local(s.start).weekday, 4);
    assert.ok(local(s.start).hour >= 12);
  }
  const r2 = SL.pickSlots(base({ constraints: { earliest_date: '2026-10-13', latest_date: '2026-10-14', days_of_week: [], time_of_day: 'any' } }));
  for (const s of r2.slots) assert.ok(['2026-10-13', '2026-10-14'].includes(local(s.start).toISODate()));
});

test('in-person meetings keep the travel buffer', () => {
  const ev = [graphEvent('2026-10-06T10:00:00-04:00', '2026-10-06T11:00:00-04:00')];
  const busy = SL.busyFromEvents(ev);
  const c = SL.candidates(base({ busy, locationType: 'in_person' }));
  assert.ok(!c.some((x) => x.start === '2026-10-06T15:15:00Z'));
  assert.ok(!c.some((x) => local(x.start).toISODate() === '2026-10-06' && local(x.start).hour === 11 && local(x.start).minute === 0));
  assert.ok(c.some((x) => local(x.start).toISODate() === '2026-10-06' && local(x.start).hour === 11 && local(x.start).minute === 30));
});

test('max meetings per day is a hard cap', () => {
  const ev = [];
  for (let h = 9; h < 15; h++) ev.push(graphEvent(`2026-10-06T${String(h).padStart(2, '0')}:00:00-04:00`, `2026-10-06T${String(h).padStart(2, '0')}:20:00-04:00`));
  const c = SL.candidates(base({ busy: SL.busyFromEvents(ev) }));
  assert.ok(!c.some((x) => x.day === '2026-10-06'));
});

test('checkSlot modes', () => {
  const busy = SL.busyFromEvents([graphEvent('2026-10-07T10:00:00-04:00', '2026-10-07T10:30:00-04:00')]);
  const p = base({ busy });
  // conflict
  assert.equal(SL.checkSlot(p, '2026-10-07T14:15:00Z', '2026-10-07T14:45:00Z', 'propose').reason, 'conflict');
  // outside working hours
  assert.equal(SL.checkSlot(p, '2026-10-07T23:00:00Z', '2026-10-07T23:30:00Z', 'propose').reason, 'outside_working_hours');
  // too soon
  assert.equal(SL.checkSlot(p, '2026-10-05T15:00:00Z', '2026-10-05T15:30:00Z', 'propose').reason, 'too_soon');
  // back-to-back but legal → ok with flag
  const ok = SL.checkSlot(p, '2026-10-07T14:35:00Z', '2026-10-07T15:05:00Z', 'propose');
  assert.ok(ok.ok);
  assert.ok(ok.flags.includes('back_to_back_before'));
  // booking mode: only a real overlap blocks, even inside the hard gap
  assert.ok(SL.checkSlot(p, '2026-10-07T14:30:00Z', '2026-10-07T15:00:00Z', 'booking').ok);
  assert.equal(SL.checkSlot(p, '2026-10-07T14:20:00Z', '2026-10-07T14:50:00Z', 'booking').reason, 'conflict');
});

test('chosen offers never overlap each other', () => {
  const r = SL.pickSlots(base({ durationMin: 90, count: 5, windowDays: 2, widenDays: 0 }));
  for (let i = 0; i < r.slots.length; i++) {
    for (let j = i + 1; j < r.slots.length; j++) {
      const a = r.slots[i]; const b = r.slots[j];
      assert.ok(!(a.start < b.end && b.start < a.end), `${a.start} overlaps ${b.start}`);
    }
  }
});

test('Graph timestamps with 7 fractional digits parse', () => {
  const ms = SL.parseGraphTime({ dateTime: '2026-10-06T14:00:00.0000000', timeZone: 'UTC' });
  assert.equal(new Date(ms).toISOString(), '2026-10-06T14:00:00.000Z');
});

test('offers mix times of day instead of the same hour every day', () => {
  const r = SL.pickSlots(base());
  const hours = new Set(r.slots.map((s) => local(s.start).hour));
  assert.ok(hours.size >= 2, `all at ${[...hours]}`);
  assert.ok(r.slots.every((s) => s.score === 100), 'variety never costs score');
});

test('earliest_date moves the window: it starts there and runs the full window from there', () => {
  // Mon Oct 5 + 3 weeks = Mon Oct 26: far past the 10+7 day default window
  const c = { earliest_date: '2026-10-26', latest_date: null, days_of_week: [], time_of_day: 'any' };
  const w = SL.searchWindow(base({ constraints: c }));
  assert.equal(w.first.toISODate(), '2026-10-26');
  assert.equal(w.end.toISODate(), '2026-11-12', '10 + 7 days counted from the 26th');
  const r = SL.pickSlots(base({ constraints: c }));
  assert.equal(r.note, 'clean');
  assert.equal(r.slots.length, 3);
  for (const s of r.slots) assert.ok(local(s.start).toISODate() >= '2026-10-26' && local(s.start).toISODate() <= '2026-10-30');
  // an earliest_date inside min notice starts at the notice, not before it
  const soon = SL.searchWindow(base({ constraints: { ...c, earliest_date: '2026-10-05' } }));
  assert.equal(soon.first.toISODate(), '2026-10-06');
  // no earliest_date: unchanged, the window starts today
  assert.equal(SL.searchWindow(base()).first.toISODate(), '2026-10-05');
});

test('earliest_date = latest_date offers only that day', () => {
  const r = SL.pickSlots(base({ constraints: { earliest_date: '2026-11-18', latest_date: '2026-11-18', days_of_week: [], time_of_day: 'any' } }));
  assert.equal(r.slots.length, 3);
  for (const s of r.slots) assert.equal(local(s.start).toISODate(), '2026-11-18');
});

test('a window starting past max_horizon_days offers nothing; checkSlot refuses past the horizon', () => {
  const c = (d) => ({ earliest_date: d, latest_date: null, days_of_week: [], time_of_day: 'any' });
  // today is day 0: with a 90-day horizon, Jan 2 (day 89) is the last start day
  const inside = SL.pickSlots(base({ maxHorizonDays: 90, constraints: c('2027-01-01') }));
  assert.ok(inside.slots.length > 0);
  const out = SL.pickSlots(base({ maxHorizonDays: 90, constraints: c('2027-01-03') }));
  assert.equal(out.note, 'beyond_horizon');
  assert.deepEqual(out.slots, []);
  assert.equal(out.window.first.toISODate(), '2027-01-03');
  const p = base({ maxHorizonDays: 30 });
  assert.equal(SL.checkSlot(p, '2026-11-05T15:00:00Z', '2026-11-05T15:30:00Z', 'propose').reason, 'beyond_horizon');
  assert.ok(SL.checkSlot(p, '2026-11-03T15:00:00Z', '2026-11-03T15:30:00Z', 'propose').ok);
});
