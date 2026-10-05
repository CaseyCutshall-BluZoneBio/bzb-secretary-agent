'use strict';
// Every date/time a client or Vic ever reads is produced here, never by the model.
const { DateTime } = require('./luxon');

function dt(iso, zone) {
  const d = DateTime.fromISO(String(iso), { setZone: true });
  return zone ? d.setZone(zone) : d;
}

// "UTC−04:00"
function offsetLabel(d) {
  const off = d.toFormat('ZZ'); // -04:00
  return `UTC${off.replace('-', '−')}`;
}

// "Tuesday, October 6, 2:00–2:30 PM EDT (UTC−04:00)"
function formatSlot(startIso, endIso, zone) {
  const s = dt(startIso, zone);
  const e = dt(endIso, zone);
  const sameMeridiem = s.toFormat('a') === e.toFormat('a');
  const startPart = sameMeridiem ? s.toFormat('h:mm') : s.toFormat('h:mm a');
  return `${s.toFormat('cccc, LLLL d')}, ${startPart}–${e.toFormat('h:mm a')} ${s.toFormat('ZZZZ')} (${offsetLabel(s)})`;
}

// Numbered list for the email body, in chronological order of option number.
function formatSlotList(offers, zone) {
  return [...offers]
    .sort((a, b) => a.option_no - b.option_no)
    .map((o) => `${o.option_no}. ${formatSlot(o.start, o.end, zone)}`)
    .join('\n');
}

// The agreed time said back in a sentence: "Thursday, October 15 at 3:00 PM EDT".
// (The numbered options and the final confirmation keep the full form with
// the UTC offset.)
function formatSpoken(startIso, zone) {
  const s = dt(startIso, zone);
  return `${s.toFormat('cccc, LLLL d')} at ${s.toFormat('h:mm a')} ${s.toFormat('ZZZZ')}`;
}

// Plain names people use for US zones; anything else uses the abbreviation.
const ZONE_NAMES = {
  'America/New_York': 'Eastern', 'America/Detroit': 'Eastern', 'America/Indiana/Indianapolis': 'Eastern',
  'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Phoenix': 'Arizona',
  'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii',
};

/**
 * The options as a person would write them: a bulleted list without option
 * numbers, start times only (the length is in the message), and the timezone
 * stated once with its UTC offset. If the options straddle a DST change,
 * each line carries its own offset instead.
 *   • Tuesday, October 6 at 2:00 PM
 *   • Wednesday, October 7 at 10:30 AM
 *
 *   All times are Eastern (UTC−04:00).
 */
function formatSlotOptions(offers, zone) {
  const sorted = [...offers].sort((a, b) => a.option_no - b.option_no);
  const offsets = new Set(sorted.map((o) => offsetLabel(dt(o.start, zone))));
  const name = ZONE_NAMES[zone] || dt(sorted[0].start, zone).toFormat('ZZZZ');
  const lines = sorted.map((o) => {
    const s = dt(o.start, zone);
    return `• ${s.toFormat('cccc, LLLL d')} at ${s.toFormat('h:mm a')}${offsets.size > 1 ? ` (${offsetLabel(s)})` : ''}`;
  });
  return `${lines.join('\n')}\n\nAll times are ${name}${offsets.size > 1 ? '' : ` (${[...offsets][0]})`}.`;
}

// Short form for subjects: "Tue Oct 6, 2:00 PM EDT"
function formatSlotShort(startIso, zone) {
  const s = dt(startIso, zone);
  return `${s.toFormat('ccc LLL d, h:mm a')} ${s.toFormat('ZZZZ')}`;
}

// The next N days as a lookup table for the model, so it maps "Thursday" or
// "next Tuesday" to a date by reading, not by doing date arithmetic.
function calendarTable(nowIso, zone, days) {
  const start = dt(nowIso, zone).startOf('day');
  const rows = [];
  for (let i = 0; i < days; i++) {
    const d = start.plus({ days: i });
    rows.push(`${d.toFormat('ccc yyyy-MM-dd')}${i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : ''}`);
  }
  return rows.join('\n');
}

// What the client asked for, in words, for the {{ASKED}} placeholder. Code
// writes every date the client reads; the model only places the placeholder.
function askedWindowText(c) {
  if (!c) return null;
  const d = (iso) => DateTime.fromISO(String(iso)).toFormat('cccc, LLLL d');
  if (c.earliest_date && c.latest_date) {
    return c.earliest_date === c.latest_date ? d(c.earliest_date) : `${d(c.earliest_date)} to ${d(c.latest_date)}`;
  }
  if (c.latest_date) return `by ${d(c.latest_date)}`;
  if (c.earliest_date) return `${d(c.earliest_date)} onward`;
  return null;
}

// "Wednesday, October 14 at 8:00 AM"
function askedTimeText(startIso, zone) {
  const s = dt(startIso, zone);
  return `${s.toFormat('cccc, LLLL d')} at ${s.toFormat('h:mm a')}`;
}

function locationPhrase(locationType, locationText) {
  if (locationType === 'in_person') return locationText ? `in person at ${locationText}` : 'in person';
  if (locationType === 'phone') return 'a phone call';
  return 'a Teams call';
}

module.exports = { dt, formatSpoken, formatSlot, formatSlotList, formatSlotOptions, formatSlotShort, calendarTable, offsetLabel, locationPhrase, askedWindowText, askedTimeText };
