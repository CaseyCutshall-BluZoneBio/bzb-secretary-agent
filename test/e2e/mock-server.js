'use strict';
// Mock Microsoft Graph + OAuth token endpoint + LiteLLM, for end-to-end tests
// of the real n8n workflows. Holds a tiny in-memory Exchange: Sarah's inbox,
// drafts and sent items, and Vic's calendar.
//
//   /token                               client-credentials token
//   /graph/v1.0/...                      the Graph calls the workflows make
//   /llm/v1/chat/completions             rule-based fake model
//   /__test/...                          control API for the test
const http = require('http');
const { URL } = require('url');

function createMock({ sarah = 'sarah.johnson@bluzonebio.com' } = {}) {
  const S = {
    inbox: [],          // Graph message objects delivered to Sarah
    deltaIndex: 0,      // how many inbox items the poller has seen via delta
    drafts: {},         // id → message
    sent: [],           // messages actually sent (from Sarah)
    events: {},         // Vic's calendar: id → event
    busy: [],           // extra busy events
    requests: [],       // log of every Graph call
    llmCalls: [],
    llmOverride: null,  // (schemaName, userText) → content string | undefined
    failNext: {},       // 'METHOD path-regex' → status code (one-shot)
    seq: 1,
  };
  const newId = (p) => `${p}-${S.seq++}`;

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => { d += c; });
      req.on('end', () => {
        if (!d) return resolve(null);
        try { resolve(JSON.parse(d)); } catch (_) { resolve(d); }
      });
    });
  }

  function recip(list) {
    return (list || []).map((r) => ({ emailAddress: { address: r.emailAddress.address, name: r.emailAddress.name } }));
  }

  // ---------------------------------------------------------------- LLM ----
  function fakeModel(body) {
    const schema = body.response_format && body.response_format.json_schema && body.response_format.json_schema.name;
    const user = (body.messages.find((m) => m.role === 'user') || {}).content || '';
    const sys = (body.messages.find((m) => m.role === 'system') || {}).content || '';
    S.llmCalls.push({ schema, user, sys });
    if (S.llmOverride) {
      const o = S.llmOverride(schema, user, sys);
      if (o !== undefined) return o;
    }
    const email = (user.split('-----')[1] || '').toLowerCase();
    const none = { earliest_date: null, latest_date: null, days_of_week: [], time_of_day: 'any' };
    let out;
    if (schema === 'trigger') {
      out = { is_scheduling_request: /sarah/.test(email), duration_min: /45 ?min/.test(email) ? 45 : null,
              location: /in person/.test(email) ? 'in_person' : null, location_detail: null, constraints: none, topic: null };
    } else if (schema === 'client') {
      const m = email.match(/option (\d)/);
      if (m) out = { intent: 'accept', accepted_option: Number(m[1]), proposed_times: [], constraints: none, other_timezone: null, question: null, summary: 'accepts' };
      else if (/none of/.test(email)) out = { intent: 'reject_all', accepted_option: null, proposed_times: [], constraints: none, other_timezone: null, question: null, summary: 'none work' };
      else if (/\?/.test(email)) out = { intent: 'question', accepted_option: null, proposed_times: [], constraints: none, other_timezone: null, question: 'a question', summary: 'asks a question' };
      else out = { intent: 'thanks', accepted_option: null, proposed_times: [], constraints: none, other_timezone: null, question: null, summary: 'thanks' };
    } else if (schema === 'confirmation') {
      out = { decision: /\byes\b/.test(email) ? 'yes' : /\bno\b/.test(email) ? 'no' : 'unclear', proposed_times: [], constraints: none };
    } else if (schema === 'employee_in_thread') {
      out = { intent: /take it from here|i've got it/.test(email) ? 'take_over' : 'other' };
    } else if (schema === 'draft') {
      const task = user.split('\n')[0];
      const names = (user.match(/"recipients_first_names": \[\s*"([^"]+)"/) || [])[1] || 'there';
      if (/\{\{SLOTS\}\}/.test(task)) out = { body: `Hi ${names}, would any of these work?\n\n{{SLOTS}}\n\nThanks!` };
      else if (/\{\{TIME\}\}/.test(task)) out = { body: `Thanks ${names}, {{TIME}} is confirmed on our side.` };
      else out = { body: `Thanks ${names}, I'll pass this to Vic, who will follow up.` };
    }
    // Emulate a reasoning model: think first, then the JSON.
    return `<think>working it out</think>${JSON.stringify(out)}`;
  }

  // -------------------------------------------------------------- Graph ----
  async function graph(req, res, path, url) {
    const body = await readBody(req);
    S.requests.push({ method: req.method, path, auth: req.headers.authorization, prefer: req.headers.prefer, body });
    if (req.headers.authorization !== 'Bearer mock-token') return json(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'bad token' } });
    for (const [k, code] of Object.entries(S.failNext)) {
      const [m, re] = k.split(' ');
      if (m === req.method && new RegExp(re).test(path)) { delete S.failNext[k]; return json(res, code, { error: { code: 'Mock', message: 'injected failure' } }); }
    }
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent); // users, upn, ...
    const needsBody = req.method === 'POST' && !/\/send$/.test(path);
    if (needsBody && (!body || typeof body !== 'object')) {
      return json(res, 400, { error: { code: 'BadRequest', message: 'Empty Payload. JSON content expected.' } });
    }
    const upn = (seg[1] || '').toLowerCase();

    // delta
    if (req.method === 'GET' && /\/mailFolders\/inbox\/messages\/delta$/.test(path)) {
      const page = S.inbox.slice(S.deltaIndex);
      S.deltaIndex = S.inbox.length;
      return json(res, 200, { value: page.map((m) => ({ id: m.id, receivedDateTime: m.receivedDateTime })),
                              '@odata.deltaLink': `http://127.0.0.1:${S.port}/graph/v1.0/users/${encodeURIComponent(sarah)}/mailFolders/inbox/messages/delta?$deltatoken=${S.seq++}` });
    }
    // get message
    if (req.method === 'GET' && seg[2] === 'messages' && seg.length === 4) {
      const m = S.inbox.find((x) => x.id === seg[3]);
      return m ? json(res, 200, m) : json(res, 404, { error: { code: 'ErrorItemNotFound', message: 'nope' } });
    }
    // createReply
    if (req.method === 'POST' && seg[2] === 'messages' && seg[4] === 'createReply') {
      const orig = S.inbox.find((x) => x.id === seg[3]);
      if (!orig) return json(res, 404, { error: { code: 'ErrorItemNotFound', message: 'no original' } });
      const id = newId('DRAFT');
      const d = { id, conversationId: orig.conversationId, subject: `RE: ${orig.subject}`, isDraft: true,
                  toRecipients: recip(body.message.toRecipients), ccRecipients: recip(body.message.ccRecipients),
                  bccRecipients: recip(body.message.bccRecipients), body: body.message.body, inReplyTo: orig.internetMessageId };
      S.drafts[id] = d;
      return json(res, 201, d);
    }
    // new draft
    if (req.method === 'POST' && seg[2] === 'messages' && seg.length === 3) {
      const id = newId('DRAFT');
      const d = { id, conversationId: newId('CONV'), subject: body.subject, isDraft: true, toRecipients: recip(body.toRecipients),
                  ccRecipients: recip(body.ccRecipients), bccRecipients: recip(body.bccRecipients), body: body.body };
      S.drafts[id] = d;
      return json(res, 201, d);
    }
    // send draft
    if (req.method === 'POST' && seg[2] === 'messages' && seg[4] === 'send') {
      const d = S.drafts[seg[3]];
      if (!d) return json(res, 404, { error: { code: 'ErrorItemNotFound', message: 'no draft' } });
      delete S.drafts[seg[3]];
      S.sent.push({ ...d, from: upn, isDraft: false, internetMessageId: `<sent-${d.id}@bluzonebio.com>` });
      return json(res, 202);
    }
    // sendMail (error workflow)
    if (req.method === 'POST' && seg[2] === 'sendMail') {
      S.sent.push({ ...body.message, from: upn, via: 'sendMail' });
      return json(res, 202);
    }
    // calendarView
    if (req.method === 'GET' && seg[2] === 'calendarView') {
      return json(res, 200, { value: [...Object.values(S.events), ...S.busy] });
    }
    // create event
    if (req.method === 'POST' && seg[2] === 'events' && seg.length === 3) {
      const dup = Object.values(S.events).find((e) => e.transactionId && e.transactionId === body.transactionId);
      if (dup) return json(res, 201, dup);
      const id = newId('EVT');
      const ev = { id, owner: upn, ...body, isCancelled: false, isAllDay: false, showAs: body.showAs || 'busy',
                   onlineMeeting: body.isOnlineMeeting ? { joinUrl: `https://teams.test/${id}` } : null };
      S.events[id] = ev;
      return json(res, 201, ev);
    }
    // delete event
    if (req.method === 'DELETE' && seg[2] === 'events') {
      if (!S.events[seg[3]]) return json(res, 404, { error: { code: 'ErrorItemNotFound', message: 'gone' } });
      delete S.events[seg[3]];
      res.writeHead(204); return res.end();
    }
    return json(res, 400, { error: { code: 'MockUnknown', message: `${req.method} ${path}` } });
  }

  // --------------------------------------------------------- test control ----
  function deliver(msg) {
    const id = newId('MSG');
    const m = {
      id,
      internetMessageId: msg.internetMessageId || `<${id}@test>`,
      conversationId: msg.conversationId || newId('CONV'),
      subject: msg.subject || '(no subject)',
      from: { emailAddress: { address: msg.from, name: msg.fromName || '' } },
      sender: { emailAddress: { address: msg.from, name: msg.fromName || '' } },
      toRecipients: (msg.to || []).map((a) => ({ emailAddress: { address: a, name: '' } })),
      ccRecipients: (msg.cc || []).map((a) => ({ emailAddress: { address: a, name: '' } })),
      receivedDateTime: new Date().toISOString(),
      isDraft: false,
      uniqueBody: { contentType: 'text', content: msg.body || '' },
      body: { contentType: 'text', content: msg.body || '' },
      internetMessageHeaders: [
        ...(msg.authAs ? [{ name: 'X-MS-Exchange-Organization-AuthAs', value: msg.authAs }] : []),
        ...(msg.autoSubmitted ? [{ name: 'Auto-Submitted', value: msg.autoSubmitted }] : []),
      ],
    };
    S.inbox.push(m);
    return m;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/token' && req.method === 'POST') {
        await readBody(req);
        return json(res, 200, { access_token: 'mock-token', token_type: 'Bearer', expires_in: 3600 });
      }
      if (p.startsWith('/graph/v1.0/')) return await graph(req, res, p.slice('/graph/v1.0'.length), url);
      if (p === '/llm/v1/chat/completions') {
        const body = await readBody(req);
        if (req.headers.authorization !== 'Bearer sk-mock') return json(res, 401, { error: { message: 'bad key' } });
        return json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: fakeModel(body) }, finish_reason: 'stop' }] });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: { code: 'MockCrash', message: e.message } });
    }
  });

  return {
    state: S,
    deliver,
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', () => { S.port = server.address().port; r(S.port); })),
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { createMock };
