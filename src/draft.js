'use strict';
// Client-email guardrails and all internal (templated) emails.
//
// The model writes words; this module decides whether those words may be sent.
// A draft that mentions any date, time, timezone, link, or address — or that
// misuses a placeholder — is thrown away and replaced by a fixed template.
const { htmlEscape, textToHtml, joinNames, lower, isInternal, setting, employeeAddress } = require('./util');
const { formatSlotShort, locationPhrase } = require('./format');
const { DateTime } = require('./luxon');

const PLACEHOLDERS = {
  intro: ['SLOTS'], new_round: ['SLOTS'], counter_unavailable: ['SLOTS'], window_unavailable: ['SLOTS'], taken: ['SLOTS'],
  employee_declined: ['SLOTS'], followup: ['SLOTS'], ack: ['TIME'], confirmed: ['TIME'], handoff: [],
};
// Placeholders a draft MAY use (at most once), when code has the text for
// them: {{ASKED}} is the day or time the client asked about, written by code.
const OPTIONAL_PLACEHOLDERS = { new_round: ['ASKED'], counter_unavailable: ['ASKED'], window_unavailable: ['ASKED'] };

const TEMPLATES = {
  intro: (f) => `${f.bcc ? `Thanks for the intro, ${f.employee_first}. I'll move you to BCC so your inbox stays quiet.` : `Thanks, ${f.employee_first}.`}\n\nHi ${f.names}, great to meet you. I help ${f.employee_first} with scheduling. Would one of these work for a ${f.duration_min}-minute ${f.location}?\n\n{{SLOTS}}\n\nJust reply with the number, or tell me what suits you and I'll work around it.`,
  new_round: (f) => `No problem, ${f.names}. Here are a few more options:\n\n{{SLOTS}}\n\nDo any of these work better?`,
  counter_unavailable: (f) => `Thanks for suggesting that, ${f.names}. Unfortunately ${f.employee_first} is already booked then, but these are open:\n\n{{SLOTS}}`,
  window_unavailable: (f) => `Thanks, ${f.names}. Unfortunately ${f.employee_first} is booked up then, but these are the closest open times:\n\n{{SLOTS}}`,
  taken: (f) => `Sorry, ${f.names}, that slot was just taken. These are still open:\n\n{{SLOTS}}`,
  employee_declined: (f) => `Sorry, ${f.names}, that time won't work for ${f.employee_first} after all. Could one of these work instead?\n\n{{SLOTS}}`,
  followup: (f) => `Hi ${f.names}, circling back on finding a time with ${f.employee_first}. These are still open:\n\n{{SLOTS}}\n\nIf none of them fit, tell me what works and I'll find something.`,
  ack: (f) => `Great, ${f.names}. {{TIME}} it is. I'll confirm with ${f.employee_first} and send the invite over shortly.`,
  confirmed: (f) => `You're all set, ${f.names}: {{TIME}}. The invite is on its way from ${f.employee_first}'s calendar${f.location_type === 'teams' ? ', Teams link included' : ''}.`,
  handoff: (f) => `Thanks, ${f.names}. That one is best answered by ${f.employee_first}, so I've passed it along and ${f.employee_first} will be in touch.`,
};

const FORBIDDEN = [
  ['weekday', /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i],
  ['weekday_abbrev', /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\.?,?\s+\d/i],
  ['month', /\b(january|february|march|april|june|july|august|september|october|november|december)\b/i],
  ['month_may', /\bmay\s+\d{1,2}\b/i],
  ['month_abbrev', /\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+\d{1,2}\b/i],
  ['clock_ampm', /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i],
  ['clock_24h', /\b\d{1,2}:\d{2}\b/],
  ['noon', /\b(noon|midnight|midday)\b/i],
  ['numeric_date', /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/],
  ['iso_date', /\b\d{4}-\d{2}-\d{2}\b/],
  ['ordinal', /\b\d{1,2}(st|nd|rd|th)\b/i],
  ['relative_date', /\b(today|tomorrow|tonight|yesterday|this (week|weekend|morning|afternoon|evening)|next (week|month)|weekend)\b/i],
  ['timezone', /\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT|GMT|UTC|BST|CET|CEST|IST)\b|\b(eastern|pacific|central|mountain)\s+(time|standard|daylight)\b/i],
  ['url', /https?:\/\/|www\.|calendly/i],
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ['phone', /\+?\d[\d\s().-]{8,}\d/],
  ['human_claim', /\b(i am|i'm)\s+(a\s+)?(real\s+)?(human|person)\b/i],
];

const SIGNOFF = /^(best|best regards|kind regards|warm regards|regards|thanks|thank you|many thanks|cheers|sincerely|warmly|all the best|talk soon)[,.!]*$/i;

// Strip a trailing sign-off / signature the model added despite instructions.
function stripSignoff(text) {
  const lines = String(text).replace(/\r\n/g, '\n').trim().split('\n');
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (last === '' || SIGNOFF.test(last) || /^sarah\b/i.test(last) || /scheduling assistant/i.test(last) || /^[-—–]+$/.test(last)) {
      lines.pop();
    } else break;
  }
  return lines.join('\n').trim();
}

/** Validate a model draft. Returns { ok, body, errors }. */
function validateDraft(rawBody, purpose, { optional = [] } = {}) {
  const errors = [];
  if (typeof rawBody !== 'string') return { ok: false, errors: ['body is not a string'] };
  const body = stripSignoff(rawBody.replace(/^subject:.*\n/i, ''));
  const needed = PLACEHOLDERS[purpose] || [];
  const allowedOptional = optional.filter((o) => (OPTIONAL_PLACEHOLDERS[purpose] || []).includes(o));

  const found = body.match(/\{\{\s*[A-Z_]+\s*\}\}/g) || [];
  for (const p of found) {
    const name = p.replace(/[{}\s]/g, '');
    if (!needed.includes(name) && !allowedOptional.includes(name)) errors.push(`unexpected placeholder ${p}`);
  }
  for (const o of allowedOptional) {
    const count = (body.match(new RegExp(`\\{\\{\\s*${o}\\s*\\}\\}`, 'g')) || []).length;
    if (count > 1) errors.push(`{{${o}}} may appear at most once (found ${count})`);
  }
  for (const n of needed) {
    const count = (body.match(new RegExp(`\\{\\{\\s*${n}\\s*\\}\\}`, 'g')) || []).length;
    if (count !== 1) errors.push(`{{${n}}} must appear exactly once (found ${count})`);
  }
  if (/\{\{|\}\}/.test(body.replace(/\{\{\s*[A-Z_]+\s*\}\}/g, ''))) errors.push('stray braces');

  const checkable = body.replace(/\{\{\s*[A-Z_]+\s*\}\}/g, ' ');
  for (const [name, re] of FORBIDDEN) {
    const m = checkable.match(re);
    if (m) errors.push(`${name}: "${m[0]}"`);
  }
  if (body.length < 15) errors.push('too short');
  if (body.length > 1500) errors.push('too long');
  return { ok: errors.length === 0, body, errors };
}

// The second line is the AI disclosure. It names the employee Sarah is working
// for, so it comes from their row when set ("Scheduling Assistant to Brad Lee (AI)").
function signature(ctx, employee) {
  const title = (employee && employee.signature_title) || setting(ctx, 'signature_title', 'Scheduling Assistant (AI)');
  return [setting(ctx, 'sarah_name', 'Sarah'), title, setting(ctx, 'company_name', '')].filter(Boolean).join('\n');
}

function fillPlaceholders(body, { slotsText, timeText, askedText }) {
  return body
    .replace(/\{\{\s*SLOTS\s*\}\}/g, slotsText || '')
    .replace(/\{\{\s*TIME\s*\}\}/g, timeText || '')
    .replace(/\{\{\s*ASKED\s*\}\}/g, askedText || 'then');
}

// Quoted original under the reply, Outlook-style.
function quoteHtml(target, zone) {
  if (!target) return '';
  let sent = target.event_at;
  if (sent) {
    const d = DateTime.fromISO(String(sent), { setZone: true });
    if (d.isValid) sent = (zone ? d.setZone(zone) : d).toFormat("cccc, LLLL d, yyyy h:mm a");
  }
  const who = target.from_name ? `${htmlEscape(target.from_name)} &lt;${htmlEscape(target.from_address)}&gt;` : htmlEscape(target.from_address);
  return `<hr style="border:none;border-top:1px solid #ccc">\n<div style="color:#555"><b>From:</b> ${who}<br>`
    + (sent ? `<b>Sent:</b> ${htmlEscape(sent)}<br>` : '')
    + `<b>Subject:</b> ${htmlEscape(target.subject || '')}<br><br>${textToHtml(String(target.body_text || '').slice(0, 4000))}</div>`;
}

/** Final client-facing email: body text + signature, HTML version + quote. */
function renderClientEmail(ctx, body, fill, replyTarget, zone, employee) {
  const text = `${fillPlaceholders(body, fill)}\n\n${signature(ctx, employee)}`;
  const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${textToHtml(text)}</div>\n${quoteHtml(replyTarget, zone)}`;
  return { body_text: text, body_html: html };
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------
function person(address, names) {
  const a = lower(address);
  return { address: a, name: (names && names[a]) || '' };
}

/**
 * Who a client-facing email goes to. Only the thread's clients, other BZB
 * people Vic copied, and (intro only, as BCC) Vic himself.
 */
function clientRecipients(thread, employee, purpose) {
  const names = thread.client_names || {};
  const to = (thread.client_addresses || []).map((a) => person(a, names));
  const cc = (thread.other_internal || []).map((a) => person(a, {}));
  const bcc = [];
  const emp = person(employeeAddress(employee), { [employeeAddress(employee)]: employee.display_name });
  if (purpose === 'intro') {
    (employee.bcc_after_intro ? bcc : cc).push(emp);
  } else if (!employee.bcc_after_intro) {
    cc.push(emp);
  }
  return { to, cc, bcc };
}

/** Hard check on any outbound recipient list. Returns error strings. */
function checkRecipients(ctx, r, allowed) {
  const errors = [];
  const sarah = lower(setting(ctx, 'sarah_upn', ''));
  const ok = new Set((allowed || []).map(lower));
  const all = [...r.to, ...r.cc, ...r.bcc];
  if (!r.to.length) errors.push('no To recipient');
  for (const p of all) {
    if (p.address === sarah) errors.push('Sarah cannot email herself');
    if (!ok.has(p.address)) errors.push(`recipient not allowed: ${p.address}`);
  }
  return errors;
}

function hasExternal(ctx, r) {
  const domains = setting(ctx, 'internal_domains', []);
  return [...r.to, ...r.cc, ...r.bcc].some((p) => !isInternal(p.address, domains));
}

// ---------------------------------------------------------------------------
// Internal emails to the employee (templated, never model-written)
// ---------------------------------------------------------------------------
const HEADS_UP = {
  back_to_back_before: 'It starts right after another meeting on your calendar.',
  back_to_back_after: 'It ends right before another meeting on your calendar.',
  long_run: 'It makes a run of three or more meetings in a row.',
  busy_day: 'You already have four or more meetings that day.',
  outside_preferred_hours: 'It is outside your preferred meeting hours.',
};

function clientLabel(thread) {
  const names = thread.client_names || {};
  const list = (thread.client_addresses || []).map((a) => names[a] || a);
  return joinNames(list) || 'the client';
}

function internalMail(ctx, employee, subject, lines) {
  const text = `${lines.filter((l) => l !== null && l !== undefined).join('\n')}\n\n${setting(ctx, 'sarah_name', 'Sarah')}`;
  return {
    to: [{ address: employeeAddress(employee), name: employee.display_name }], cc: [], bcc: [],
    subject,
    body_text: text,
    body_html: `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${textToHtml(text)}</div>`,
  };
}

function vicConfirmationMail(ctx, employee, thread, offer, whenText, flags, tidToken) {
  const heads = (flags || []).map((f) => HEADS_UP[f]).filter(Boolean);
  return internalMail(ctx, employee,
    `Confirm: ${clientLabel(thread)} — ${formatSlotShort(offer.start, employee.timezone)} [S-${tidToken}]`,
    [
      `Hi ${employee.first_name},`,
      '',
      `${clientLabel(thread)} picked:`,
      '',
      `    ${whenText}`,
      `    ${thread.duration_min} minutes, ${locationPhrase(thread.location_type, thread.location_text)}`,
      '',
      heads.length ? `Heads-up: ${heads.join(' ')}\n` : null,
      'Reply YES and I\'ll book it (the invite goes out from your calendar), NO and I\'ll offer them other times, or reply with a different day or time.',
    ]);
}

function vicReminderMail(ctx, employee, thread, offer, whenText, tidToken) {
  return internalMail(ctx, employee,
    `Reminder: confirm ${clientLabel(thread)} — ${formatSlotShort(offer.start, employee.timezone)} [S-${tidToken}]`,
    [`Hi ${employee.first_name},`, '',
     `Still waiting on your answer for ${whenText} with ${clientLabel(thread)}.`, '',
     'Reply YES to book it or NO for other times.']);
}

function vicClarifyMail(ctx, employee, thread, offer, whenText, tidToken) {
  return internalMail(ctx, employee,
    `Confirm: ${clientLabel(thread)} — ${formatSlotShort(offer.start, employee.timezone)} [S-${tidToken}]`,
    [`Hi ${employee.first_name},`, '',
     `Sorry, I couldn't tell from your reply. For ${whenText} with ${clientLabel(thread)}:`, '',
     'Reply YES to book it, or NO and I\'ll offer other times.']);
}

function vicNoticeMail(ctx, employee, thread, reason, excerpt, toldClient, tidToken) {
  return internalMail(ctx, employee,
    `Needs you: ${thread.subject || clientLabel(thread)} [S-${tidToken}]`,
    [`Hi ${employee.first_name},`, '',
     `I've handed the scheduling with ${clientLabel(thread)} back to you.`,
     `Why: ${reason}`,
     excerpt ? `\nTheir last message:\n${String(excerpt).slice(0, 800).split('\n').map((l) => `> ${l}`).join('\n')}` : null,
     '',
     toldClient ? `I let them know you'd be in touch, so it's over to you from here.` : `I haven't replied to them, so it's over to you from here.`]);
}

function vicStalledMail(ctx, employee, thread, tidToken) {
  return internalMail(ctx, employee,
    `No reply: ${clientLabel(thread)} [S-${tidToken}]`,
    [`Hi ${employee.first_name},`, '',
     `${clientLabel(thread)} hasn't replied after my follow-up, so I've stopped and released the holds on your calendar.`, '',
     'If you still want the meeting, reach out to them directly or start a new thread with me copied.']);
}

function vicNoClientsMail(ctx, employee, subject) {
  return internalMail(ctx, employee,
    `Couldn't start scheduling: ${subject || '(no subject)'}`,
    [`Hi ${employee.first_name},`, '',
     'You copied me, but I couldn\'t find anyone outside BZB on the email to schedule with.', '',
     'Reply-all with the client on To or CC and me copied, and I\'ll take it from there.']);
}

function portalLink(ctx, path) {
  const base = String(setting(ctx, 'portal_base_url', '') || '').replace(/\/+$/, '');
  return base ? `${base}${path}` : null;
}

function vicPausedMail(ctx, employee, subject) {
  const link = portalLink(ctx, '/');
  return internalMail(ctx, employee,
    `Paused, so I didn't start: ${subject || '(no subject)'}`,
    [`Hi ${employee.first_name},`, '',
     'You copied me on this email, but you\'ve paused me, so I haven\'t contacted anyone.', '',
     link ? `Resume me at ${link} and then send the request again.` : 'Resume me in the Sarah portal and then send the request again.']);
}

function vicNotConnectedMail(ctx, employee, subject) {
  const link = portalLink(ctx, '/connect');
  const lost = !!employee.calendar_connected_at;
  return internalMail(ctx, employee,
    `${lost ? 'Reconnect your calendar' : 'Connect your calendar'}, so I didn't start: ${subject || '(no subject)'}`,
    [`Hi ${employee.first_name},`, '',
     lost ? 'You copied me on this email, but I\'ve lost access to your calendar, so I haven\'t contacted anyone.'
          : 'You copied me on this email, but your calendar isn\'t connected to me yet, so I haven\'t contacted anyone.', '',
     link ? `${lost ? 'Reconnect' : 'Connect'} it at ${link} (it takes a minute), then send the request again.`
          : 'Connect it in the Sarah portal, then send the request again.']);
}

module.exports = {
  portalLink, vicPausedMail, vicNotConnectedMail, OPTIONAL_PLACEHOLDERS,
  PLACEHOLDERS, TEMPLATES, FORBIDDEN, HEADS_UP, stripSignoff, validateDraft, fillPlaceholders, renderClientEmail,
  signature, quoteHtml, clientRecipients, checkRecipients, hasExternal, clientLabel,
  vicConfirmationMail, vicReminderMail, vicClarifyMail, vicNoticeMail, vicStalledMail, vicNoClientsMail,
};
