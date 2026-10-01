'use strict';
// The settings form: validation that mirrors the sched.employees CHECKs (so
// people see a clear message instead of a database error), and the one-time
// prefill from Outlook's mailboxSettings.
const { toIana, isValidIana } = require('./tz');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const GRAPH_DAYS = { monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun' };
const LOCATIONS = ['teams', 'in_person', 'phone'];
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

// [field, label, min, max]
const NUMBERS = [
  ['default_duration_min', 'Default meeting length', 10, 240],
  ['hard_gap_min', 'Minimum gap between meetings', 0, 120],
  ['preferred_gap_min', 'Preferred gap between meetings', 0, 240],
  ['in_person_buffer_min', 'Travel buffer for in-person meetings', 0, 240],
  ['max_meetings_per_day', 'Most meetings in a day', 1, 20],
  ['min_notice_hours', 'Minimum notice', 0, 336],
  ['search_window_days', 'How far ahead to look', 1, 60],
  ['offers_per_round', 'Times offered per email', 1, 5],
];

const toMinutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/**
 * form: flat key/value pairs as posted (URLSearchParams → object).
 * Returns { ok, value, errors } where value is ready for portal_save_settings.
 */
function validateSettings(form) {
  const f = form || {};
  const errors = {};
  const value = {};
  const str = (k) => (typeof f[k] === 'string' ? f[k].trim() : '');

  const first = str('first_name');
  if (!first || first.length > 40 || !/^[\p{L}\p{M}' .-]+$/u.test(first)) errors.first_name = 'Enter your first name (letters only, up to 40).';
  value.first_name = first;

  const tz = str('timezone');
  if (!isValidIana(tz)) errors.timezone = 'Choose a valid timezone.';
  value.timezone = tz;

  const hours = {};
  let anyDay = false;
  for (const d of DAYS) {
    if (f[`${d}_on`] !== 'on') { hours[d] = null; continue; }
    const s = str(`${d}_start`);
    const e = str(`${d}_end`);
    if (!HM.test(s) || !HM.test(e) || toMinutes(e) <= toMinutes(s)) {
      errors[`${d}_hours`] = `${DAY_NAMES[d]}: the end time must be after the start time.`;
    }
    hours[d] = [s, e];
    anyDay = true;
  }
  if (!anyDay) errors.working_hours = 'Turn on at least one working day.';
  value.working_hours = hours;

  const ps = str('preferred_start');
  const pe = str('preferred_end');
  if (!HM.test(ps) || !HM.test(pe) || toMinutes(pe) <= toMinutes(ps)) errors.preferred_hours = 'Preferred hours: the end must be after the start.';
  value.preferred_start = ps;
  value.preferred_end = pe;

  for (const [k, label, min, max] of NUMBERS) {
    const raw = str(k);
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) errors[k] = `${label} must be a whole number from ${min} to ${max}.`;
    value[k] = n;
  }
  if (!errors.hard_gap_min && !errors.preferred_gap_min && value.preferred_gap_min < value.hard_gap_min) {
    errors.preferred_gap_min = 'The preferred gap can\'t be shorter than the minimum gap.';
  }

  const loc = str('default_location');
  if (!LOCATIONS.includes(loc)) errors.default_location = 'Choose Teams, in person, or phone.';
  value.default_location = loc;

  const office = str('office_address');
  if (office.length > 200) errors.office_address = 'Keep the office address under 200 characters.';
  value.office_address = office;

  value.bcc_after_intro = f.bcc_after_intro === 'on';
  return { ok: Object.keys(errors).length === 0, value, errors };
}

// Graph mailboxSettings → { timezone, working_hours } for the first connect.
// Unknown or custom timezones give null (the employee picks one).
function prefillFromMailboxSettings(ms) {
  if (!ms || typeof ms !== 'object') return null;
  const wh = ms.workingHours || {};
  const timezone = toIana(wh.timeZone && wh.timeZone.name) || toIana(ms.timeZone);
  const out = {};
  if (timezone) out.timezone = timezone;
  const s = String(wh.startTime || '').slice(0, 5);
  const e = String(wh.endTime || '').slice(0, 5);
  const days = (wh.daysOfWeek || []).map((d) => GRAPH_DAYS[String(d).toLowerCase()]).filter(Boolean);
  if (HM.test(s) && HM.test(e) && toMinutes(e) > toMinutes(s) && days.length) {
    out.working_hours = Object.fromEntries(DAYS.map((d) => [d, days.includes(d) ? [s, e] : null]));
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { validateSettings, prefillFromMailboxSettings, DAYS, DAY_NAMES, LOCATIONS, NUMBERS };
