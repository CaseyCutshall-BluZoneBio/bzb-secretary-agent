'use strict';
// Outbox item → Microsoft Graph request(s), and Graph response → outbox report.
// Sarah's mailbox is the only mailbox this module ever sends from.
const { DateTime } = require('./luxon');
const { HOLD_CATEGORY } = require('./slots');

const enc = encodeURIComponent;

function recips(list) {
  return (list || []).map((p) => ({ emailAddress: { address: p.address, name: p.name || p.address } }));
}

function utcLocal(iso) {
  return DateTime.fromISO(iso, { setZone: true }).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function mailbox(item) {
  return `${item.config.graph_base_url}/users/${enc(item.config.sarah_upn)}`;
}

function calendarOwner(item) {
  return `${item.config.graph_base_url}/users/${enc(item.payload.employee_upn)}`;
}

/**
 * First request for a claimed item, or null when no Graph call is needed
 * (booking waiting for approval in shadow mode).
 */
function firstRequest(item) {
  const p = item.payload || {};
  const step = item.step;
  if (step === 'await_approval') return null;

  // A draft already exists (earlier attempt created it, or it was approved): just send it.
  if (step === 'send_draft' || ((item.kind === 'reply' || item.kind === 'new_mail' || item.kind === 'notify_internal')
      && item.draft_graph_id && step === 'full')) {
    return { method: 'POST', url: `${mailbox(item)}/messages/${enc(item.draft_graph_id)}/send`, body: null, sends: true };
  }

  switch (item.kind) {
    case 'reply':
      return {
        method: 'POST',
        url: `${mailbox(item)}/messages/${enc(p.reply_to_graph_id)}/createReply`,
        body: { message: { toRecipients: recips(p.to), ccRecipients: recips(p.cc), bccRecipients: recips(p.bcc),
                           body: { contentType: 'HTML', content: p.body_html } } },
      };
    case 'new_mail':
    case 'notify_internal':
      return {
        method: 'POST',
        url: `${mailbox(item)}/messages`,
        body: { subject: p.subject, body: { contentType: 'HTML', content: p.body_html },
                toRecipients: recips(p.to), ccRecipients: recips(p.cc), bccRecipients: recips(p.bcc) },
      };
    case 'create_hold':
      return {
        method: 'POST',
        url: `${calendarOwner(item)}/events`,
        body: {
          subject: p.subject || 'Hold (Sarah)',
          start: { dateTime: utcLocal(p.start), timeZone: 'UTC' },
          end: { dateTime: utcLocal(p.end), timeZone: 'UTC' },
          showAs: 'tentative', sensitivity: 'private', isReminderOn: false,
          categories: [HOLD_CATEGORY],
          body: { contentType: 'text', content: 'Held by Sarah while a client picks a time. Released automatically.' },
          transactionId: `sarah-hold-${item.offer_id || item.id}`,
        },
      };
    case 'delete_hold':
      return { method: 'DELETE', url: `${calendarOwner(item)}/events/${enc(p.event_id)}`, body: null };
    case 'create_booking': {
      const body = {
        subject: p.subject,
        body: { contentType: 'HTML', content: p.body_html || '' },
        start: p.start,
        end: p.end,
        attendees: (p.attendees || []).map((a) => ({ emailAddress: { address: a.address, name: a.name || a.address }, type: 'required' })),
        allowNewTimeProposals: true,
        responseRequested: true,
        transactionId: `sarah-booking-${item.offer_id || item.id}`,
      };
      if (p.location_type === 'teams') {
        body.isOnlineMeeting = true;
        body.onlineMeetingProvider = 'teamsForBusiness';
      } else if (p.location_type === 'in_person') {
        body.location = { displayName: p.location_text || 'In person' };
      } else if (p.location_type === 'phone') {
        body.location = { displayName: p.location_text ? `Phone: ${p.location_text}` : 'Phone call' };
      }
      return { method: 'POST', url: `${calendarOwner(item)}/events`, body };
    }
    default:
      throw new Error(`unknown outbox kind ${item.kind}`);
  }
}

// n8n HTTP Request with fullResponse + neverError gives {statusCode, body};
// a network failure (with "continue on error") gives {error}.
function classify(resp) {
  if (!resp || resp.error || resp.statusCode === undefined) {
    return { ok: false, retry: true, error: `network: ${JSON.stringify((resp && resp.error) || resp).slice(0, 400)}` };
  }
  const s = Number(resp.statusCode);
  if (s >= 200 && s < 300) return { ok: true, status: s, body: resp.body || {} };
  const msg = resp.body && resp.body.error ? `${resp.body.error.code}: ${resp.body.error.message}` : JSON.stringify(resp.body || '').slice(0, 400);
  return { ok: false, status: s, retry: s === 429 || s >= 500, error: `HTTP ${s} ${msg}` };
}

/**
 * Interpret the first response. Returns either a final report
 * ({ report: {...} }) or a second request to make ({ next: {...}, draft_graph_id, conversation_id }).
 */
function afterFirst(item, resp) {
  const base = { id: item.id };
  if (item.step === 'await_approval') return { report: { ...base, outcome: 'awaiting_approval' } };

  const req = firstRequest(item);
  const c = classify(resp);
  if (!c.ok) {
    if (item.kind === 'delete_hold' && c.status === 404) return { report: { ...base, outcome: 'done', result: { already_gone: true } } };
    if (req.sends && c.status === 404) return { report: { ...base, outcome: 'failed', error: 'draft no longer exists (deleted from Drafts?)' } };
    return { report: { ...base, outcome: c.retry ? 'retry' : 'failed', error: c.error } };
  }

  if (req.sends) {
    return { report: { ...base, outcome: 'done', draft_graph_id: item.draft_graph_id,
                       result: { conversation_id: (item.result && item.result.conversation_id) || null } } };
  }

  const b = c.body || {};
  switch (item.kind) {
    case 'reply':
    case 'new_mail':
    case 'notify_internal': {
      if (!b.id) return { report: { ...base, outcome: 'retry', error: 'draft created without id' } };
      if (item.step === 'draft_only') {
        return { report: { ...base, outcome: 'awaiting_approval', draft_graph_id: b.id, result: { conversation_id: b.conversationId } } };
      }
      return {
        next: { method: 'POST', url: `${mailbox(item)}/messages/${enc(b.id)}/send`, body: null },
        draft_graph_id: b.id,
        conversation_id: b.conversationId,
      };
    }
    case 'create_hold':
    case 'create_booking':
      if (!b.id) return { report: { ...base, outcome: 'retry', error: 'event created without id' } };
      return { report: { ...base, outcome: 'done', result: { event_id: b.id, web_link: b.webLink || null,
                                                             join_url: (b.onlineMeeting && b.onlineMeeting.joinUrl) || null } } };
    case 'delete_hold':
      return { report: { ...base, outcome: 'done' } };
    default:
      return { report: { ...base, outcome: 'failed', error: `unknown kind ${item.kind}` } };
  }
}

/** Interpret the send call that follows a draft. */
function afterSecond(item, first, resp) {
  const c = classify(resp);
  const base = { id: item.id, draft_graph_id: first.draft_graph_id };
  if (c.ok) return { ...base, outcome: 'done', result: { conversation_id: first.conversation_id } };
  return { ...base, outcome: c.retry ? 'retry' : 'failed', error: c.error, result: { conversation_id: first.conversation_id } };
}

module.exports = { firstRequest, afterFirst, afterSecond, classify, recips };
