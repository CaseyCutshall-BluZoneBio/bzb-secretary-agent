'use strict';
// Poller helpers: Graph delta over Sarah's Inbox, and message normalization.
const { lower } = require('./util');

const enc = encodeURIComponent;

function deltaUrl(settings) {
  if (settings.poller_delta_link) return settings.poller_delta_link;
  return `${settings.graph_base_url}/users/${enc(settings.sarah_upn)}/mailFolders/inbox/messages/delta`
    + `?$select=${enc('id,receivedDateTime,isDraft')}`;
}

/** Split a delta page into message ids + the cursor to store for next time. */
function splitDelta(resp) {
  const values = (resp && resp.value) || [];
  const ids = values.filter((v) => v && v.id && !v['@removed'] && !v.isDraft).map((v) => v.id);
  const cursor = (resp && (resp['@odata.nextLink'] || resp['@odata.deltaLink'])) || null;
  return { ids: [...new Set(ids)], cursor, more: !!(resp && resp['@odata.nextLink']) };
}

function messageUrl(settings, id) {
  const select = 'id,internetMessageId,conversationId,subject,from,sender,toRecipients,ccRecipients,'
    + 'receivedDateTime,isDraft,uniqueBody,body,internetMessageHeaders';
  return `${settings.graph_base_url}/users/${enc(settings.sarah_upn)}/messages/${enc(id)}?$select=${enc(select)}`;
}

function header(headers, name) {
  const h = (headers || []).find((x) => lower(x.name) === lower(name));
  return h ? String(h.value) : null;
}

/** Graph message → ingest_message() payload. */
function normalizeMessage(m) {
  const addr = (r) => lower(r && r.emailAddress && r.emailAddress.address);
  const names = {};
  for (const r of [...(m.toRecipients || []), ...(m.ccRecipients || [])]) {
    const a = addr(r);
    if (a) names[a] = (r.emailAddress && r.emailAddress.name && r.emailAddress.name !== r.emailAddress.address) ? r.emailAddress.name : '';
  }
  const hs = m.internetMessageHeaders || [];
  const body = (m.uniqueBody && m.uniqueBody.content) || (m.body && m.body.content) || '';
  return {
    internet_message_id: m.internetMessageId || null,
    graph_message_id: m.id,
    conversation_id: m.conversationId || null,
    from_address: addr(m.from) || addr(m.sender),
    from_name: (m.from && m.from.emailAddress && m.from.emailAddress.name) || '',
    to_addresses: (m.toRecipients || []).map(addr).filter(Boolean),
    cc_addresses: (m.ccRecipients || []).map(addr).filter(Boolean),
    recipient_names: names,
    subject: m.subject || '',
    body_text: String(body).replace(/\r\n/g, '\n').slice(0, 8000),
    headers: {
      auth_as: header(hs, 'X-MS-Exchange-Organization-AuthAs'),
      auto_submitted: header(hs, 'Auto-Submitted'),
      precedence: header(hs, 'Precedence'),
      x_autoreply: header(hs, 'X-Autoreply'),
      x_autorespond: header(hs, 'X-Autorespond'),
      headers_present: hs.length > 0,
    },
    event_at: m.receivedDateTime,
    is_draft: !!m.isDraft,
  };
}

// A readable reason for a failed Graph call (n8n HTTP node, fullResponse +
// continue on error). When the request never reached Graph, n8n's error object
// carries no message at all; by far the most common cause is the credential
// failing to get a token, so say that, and what to check.
function describeGraphFailure(r) {
  if (r && r.statusCode !== undefined) {
    const e = r.body && r.body.error;
    const what = e ? `${e.code || ''}${e.message ? `: ${e.message}` : ''}` : JSON.stringify(r.body || '').slice(0, 300);
    const hint = r.statusCode === 401 ? ' (token rejected: check the credential\'s scope is https://graph.microsoft.com/.default)'
      : r.statusCode === 403 ? ' (Exchange scoping: the app is not allowed on this mailbox yet; it can take up to ~2 h after setup)' : '';
    return `HTTP ${r.statusCode} ${what}${hint}`.slice(0, 600);
  }
  const msg = r && r.error && (r.error.message || r.error.description);
  if (msg) return String(msg).slice(0, 600);
  return 'the request never reached Microsoft Graph. Usually the n8n credential "Sarah · Microsoft Graph (app-only)" '
    + 'could not get a token: check the Client Secret (the secret\'s Value, not its Secret ID), the tenant ID in the '
    + 'Access Token URL, and the Client ID. scripts/check-setup.sh tests these directly.';
}

module.exports = { deltaUrl, splitDelta, messageUrl, normalizeMessage, describeGraphFailure };
