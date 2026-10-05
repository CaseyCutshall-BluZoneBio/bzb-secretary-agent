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

module.exports = { dt, formatSlot, formatSlotList, formatSlotShort, calendarTable, offsetLabel, locationPhrase, askedWindowText, askedTimeText };
