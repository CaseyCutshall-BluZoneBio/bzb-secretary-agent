'use strict';
// End-to-end scenarios against the real workflows in a running n8n.
// Started by test/e2e/run.sh, which prepares n8n + the database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { createMock } = require('./mock-server');

const SARAH = 'sarah.johnson@bluzonebio.com';
const VIC = 'vic@bluzonebio.com';
const CASEY = 'casey@bluzonebio.com';
const mock = createMock({ sarah: SARAH });
const db = new Client({ host: process.env.E2E_PGHOST || '127.0.0.1', port: Number(process.env.E2E_PGPORT || 5432),
                        user: 'sched_agent', password: process.env.SCHED_PGPASSWORD || 'x', database: 'sched_e2e' });
const S = mock.state;

async function waitFor(label, fn, ms = 90000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for: ${label} (last: ${last && last.message ? last.message : JSON.stringify(last)})`);
}

const sentTo = (addr, pred = () => true) => S.sent.filter((m) =>
  [...(m.toRecipients || [])].some((r) => r.emailAddress.address === addr) && pred(m));
const bodyOf = (m) => (m.body && m.body.content) || '';
const holds = () => Object.values(S.events).filter((e) => (e.categories || []).includes('Sarah hold'));
const q1 = async (sql, p) => (await db.query(sql, p)).rows[0];
const setMode = (m) => db.query('SELECT sched.set_mode($1)', [m]);

test.before(async () => {
  await mock.listen(8787);
  await db.connect();
  await db.query(`
    UPDATE sched.settings SET value = '"http://127.0.0.1:8787/graph/v1.0"' WHERE key = 'graph_base_url';
    UPDATE sched.settings SET value = '"http://127.0.0.1:8787/llm/v1/chat/completions"' WHERE key = 'litellm_url';
    UPDATE sched.settings SET value = '"qwen-test"' WHERE key = 'llm_model';
    UPDATE sched.settings SET value = '"${CASEY}"' WHERE key = 'alert_address';
    UPDATE sched.settings SET value = '"http://127.0.0.1:5678"' WHERE key = 'n8n_base_url';
    UPDATE sched.settings SET value = to_jsonb(now() - interval '1 minute') WHERE key = 'processing_start_at';
    UPDATE sched.settings SET value = '20' WHERE key = 'poller_lease_seconds';`);
  await setMode('live');
});

test.after(async () => {
  // Keep a readable copy of everything Sarah sent, for review.
  if (process.env.E2E_DUMP) {
    const out = S.sent.map((m) => [
      `From: ${m.from}`, `To: ${(m.toRecipients || []).map((r) => r.emailAddress.address).join(', ')}`,
      `Cc: ${(m.ccRecipients || []).map((r) => r.emailAddress.address).join(', ')}`,
      `Bcc: ${(m.bccRecipients || []).map((r) => r.emailAddress.address).join(', ')}`,
      `Subject: ${m.subject}`, '', bodyOf(m).replace(/<br>/g, '\n').replace(/<\/p>\s*<p>/g, '\n\n').replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim(),
    ].join('\n')).join('\n\n==========\n\n');
    require('fs').writeFileSync(process.env.E2E_DUMP, out);
  }
  await setMode('off');
  await db.end();
  await mock.close();
});

// -----------------------------------------------------------------------------
test('live: trigger → intro → client picks option 2 → Vic says YES → booked', async () => {
  const trig = mock.deliver({
    from: VIC, fromName: 'Vic Suarez', to: ['dana@acme-bio.com'], cc: [SARAH], authAs: 'Internal',
    subject: 'Intro: Dana / Vic', body: 'Dana, great to meet you. Sarah will find us a time to talk.',
  });

  const intro = await waitFor('intro email to Dana', () => sentTo('dana@acme-bio.com')[0]);
  assert.equal(intro.from, SARAH, 'sent from Sarah');
  assert.equal(intro.conversationId, trig.conversationId, 'threaded as a reply');
  assert.deepEqual(intro.bccRecipients.map((r) => r.emailAddress.address), [VIC], 'Vic moved to BCC');
  assert.deepEqual(intro.ccRecipients, []);
  const text = bodyOf(intro);
  assert.match(text, /1\. \w+day, \w+ \d+, .*E[DS]T \(UTC−0[45]:00\)/);
  assert.match(text, /3\. /);
  assert.match(text, /Scheduling Assistant to Vic Suarez \(AI\)/);
  await waitFor('3 holds on Vic\'s calendar', () => holds().length === 3);
  for (const h of holds()) {
    assert.equal(h.owner, VIC);
    assert.equal(h.sensitivity, 'private');
    assert.equal(h.attendees, undefined);
  }
  const t = await q1('SELECT * FROM sched.threads WHERE conversation_id = $1', [trig.conversationId]);
  assert.equal(t.state, 'PROPOSED');

  // Client picks option 2
  mock.deliver({ from: 'dana@acme-bio.com', fromName: 'Dana Whitfield', to: [SARAH], conversationId: trig.conversationId,
                 subject: 'RE: Intro: Dana / Vic', body: 'Option 2 works for me, thanks!' });
  const confirm = await waitFor('confirmation request to Vic', () => sentTo(VIC, (m) => /^Confirm:/.test(m.subject))[0]);
  assert.match(confirm.subject, new RegExp(`\\[S-${t.id}\\]$`));
  assert.match(bodyOf(confirm), /Reply YES/);
  await waitFor('ack to Dana', () => sentTo('dana@acme-bio.com').length === 2);
  await waitFor('two unused holds released', () => holds().length === 1);
  assert.equal((await q1('SELECT state FROM sched.threads WHERE id = $1', [t.id])).state, 'AWAITING_VIC');

  // Vic replies YES on the confirmation thread
  mock.deliver({ from: VIC, fromName: 'Vic Suarez', to: [SARAH], authAs: 'Internal', conversationId: confirm.conversationId,
                 subject: `RE: ${confirm.subject}`, body: 'yes' });
  const booking = await waitFor('booking on Vic\'s calendar', () =>
    Object.values(S.events).find((e) => (e.attendees || []).some((a) => a.emailAddress.address === 'dana@acme-bio.com')));
  assert.equal(booking.owner, VIC, 'the event (and invite) comes from Vic\'s calendar');
  assert.equal(booking.isOnlineMeeting, true);
  assert.match(booking.transactionId, /^sarah-booking-\d+$/);
  const done = await waitFor('thread BOOKED', async () => {
    const r = await q1('SELECT state, booked_event_id FROM sched.threads WHERE id = $1', [t.id]);
    return r.state === 'BOOKED' && r;
  });
  assert.equal(done.booked_event_id, booking.id);
  await waitFor('confirmation to Dana', () => sentTo('dana@acme-bio.com').length === 3);
  await waitFor('last hold released', () => holds().length === 0);
  assert.ok(!S.sent.some((m) => m.from === VIC), 'nothing is ever sent from Vic\'s mailbox');
  assert.ok(S.requests.every((r) => r.auth === 'Bearer mock-token'), 'every Graph call used the app token');
});

// -----------------------------------------------------------------------------
test('shadow: external email waits as a draft until approved through the review page', async () => {
  await setMode('shadow');
  const trig = mock.deliver({ from: VIC, to: ['lee@northwind.com'], cc: [SARAH], authAs: 'Internal',
                              subject: 'Lee intro', body: 'Lee, Sarah will find us a time for a 45 min call.' });
  const review = await waitFor('review email to Casey', () => sentTo(CASEY, (m) => /^\[Sarah review\]/.test(m.subject))[0]);
  assert.equal(sentTo('lee@northwind.com').length, 0, 'nothing sent to the client yet');
  const draft = Object.values(S.drafts).find((d) => d.toRecipients.some((r) => r.emailAddress.address === 'lee@northwind.com'));
  assert.ok(draft, 'draft sits in Sarah\'s Drafts');
  assert.match(bodyOf(draft), /45-minute|45 min|would any of these/i);
  await waitFor('holds created in shadow mode', () => holds().length === 3);

  const link = bodyOf(review).match(/APPROVE: (\S+)/)[1].replace(/&amp;/g, '&');
  const page = await fetch(link);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<form method="post">/);
  assert.equal(sentTo('lee@northwind.com').length, 0, 'opening the link (e.g. a link scanner) does nothing');

  const u = new URL(link);
  const res = await fetch(`${u.origin}${u.pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: u.searchParams.get('id'), t: u.searchParams.get('t'), a: 'approve' }).toString(),
  });
  assert.match(await res.text(), /Approved/);
  const sent = await waitFor('intro sent after approval', () => sentTo('lee@northwind.com')[0]);
  assert.equal(sent.id, draft.id, 'the reviewed draft is exactly what was sent');
  const again = await fetch(`${u.origin}${u.pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: u.searchParams.get('id'), t: u.searchParams.get('t'), a: 'approve' }).toString(),
  });
  assert.match(await again.text(), /already/);
  const t = await q1('SELECT duration_min FROM sched.threads WHERE conversation_id = $1', [trig.conversationId]);
  assert.equal(t.duration_min, 45);
  await setMode('live');
});

// -----------------------------------------------------------------------------
test('guards: spoofed Vic, out-of-office, unknown sender', async () => {
  const before = S.sent.length;
  const spoof = mock.deliver({ from: VIC, to: ['mallory@evil.com'], cc: [SARAH], subject: 'urgent', body: 'Sarah will find us a time' });
  const alert = await waitFor('alert to Casey about the unauthenticated email', () =>
    sentTo(CASEY, (m) => /ignored_unauthenticated/.test(m.subject))[0]);
  assert.ok(alert);
  assert.equal(sentTo('mallory@evil.com').length, 0);
  assert.equal((await q1('SELECT count(*)::int AS n FROM sched.threads WHERE conversation_id = $1', [spoof.conversationId])).n, 0);

  const ooo = mock.deliver({ from: 'dana@acme-bio.com', to: [SARAH], autoSubmitted: 'auto-replied', subject: 'Automatic reply: hi', body: 'Out of office' });
  const stranger = mock.deliver({ from: 'rando@spam.com', to: [SARAH], subject: 'hello', body: 'hi' });
  await waitFor('both logged as ignored', async () => {
    const r = await db.query('SELECT disposition FROM sched.messages WHERE internet_message_id = ANY($1)',
                             [[ooo.internetMessageId, stranger.internetMessageId]]);
    return r.rows.length === 2 && r.rows.every((x) => x.disposition.startsWith('ignored_'));
  });
  assert.equal(S.sent.length, before + 1, 'only the one alert was sent');
});

// -----------------------------------------------------------------------------
test('model returns garbage for a client reply → NEEDS_VIC and Vic is told', async () => {
  const trig = mock.deliver({ from: VIC, to: ['kim@contoso.com'], cc: [SARAH], authAs: 'Internal', subject: 'Kim intro', body: 'Sarah will find us a time.' });
  await waitFor('intro to Kim', () => sentTo('kim@contoso.com')[0]);
  S.llmOverride = (schema) => (schema === 'client' ? 'Sorry, I cannot help with that.' : undefined);
  mock.deliver({ from: 'kim@contoso.com', to: [SARAH], conversationId: trig.conversationId, subject: 'RE: Kim intro', body: 'Hmm, let me check.' });
  const notice = await waitFor('notice to Vic', () => sentTo(VIC, (m) => /^Needs you:/.test(m.subject))[0]);
  assert.match(bodyOf(notice), /couldn&#39;t interpret|couldn't interpret/);
  const t = await q1('SELECT state FROM sched.threads WHERE conversation_id = $1', [trig.conversationId]);
  assert.equal(t.state, 'NEEDS_VIC');
  assert.equal(sentTo('kim@contoso.com').length, 1, 'no email to the client');
  S.llmOverride = null;
});

// -----------------------------------------------------------------------------
test('Graph 503 on send is retried and the email still goes out once', async () => {
  S.failNext['POST /messages/.*/createReply$'] = 503;
  mock.deliver({ from: VIC, to: ['pat@fabrikam.com'], cc: [SARAH], authAs: 'Internal', subject: 'Pat intro', body: 'Sarah will find us a time.' });
  await waitFor('intro to Pat after retry', () => sentTo('pat@fabrikam.com')[0]);
  await new Promise((r) => setTimeout(r, 12000));
  assert.equal(sentTo('pat@fabrikam.com').length, 1, 'sent exactly once');
  const o = await q1(`SELECT attempts, status FROM sched.outbox WHERE purpose = 'intro' AND payload->'to'->0->>'address' = 'pat@fabrikam.com'`);
  assert.equal(o.status, 'done');
  assert.equal(o.attempts, 1);
});

// -----------------------------------------------------------------------------
test('timer: quiet client gets one follow-up with fresh options', async () => {
  const trig = mock.deliver({ from: VIC, to: ['sam@litware.com'], cc: [SARAH], authAs: 'Internal', subject: 'Sam intro', body: 'Sarah will find us a time.' });
  await waitFor('intro to Sam', () => sentTo('sam@litware.com')[0]);
  await waitFor('thread PROPOSED with last_outbound_at', async () =>
    (await q1('SELECT last_outbound_at FROM sched.threads WHERE conversation_id = $1', [trig.conversationId])).last_outbound_at);
  await db.query(`UPDATE sched.threads SET last_outbound_at = now() - interval '80 hours', last_timer_at = NULL WHERE conversation_id = $1`,
                 [trig.conversationId]);
  const fu = await waitFor('follow-up to Sam', () => sentTo('sam@litware.com')[1], 120000);
  assert.match(bodyOf(fu), /4\. /, 'option numbers continue across rounds');
  const t = await q1('SELECT followup_sent_at, round_count FROM sched.threads WHERE conversation_id = $1', [trig.conversationId]);
  assert.ok(t.followup_sent_at);
  assert.equal(t.round_count, 2);
});

// -----------------------------------------------------------------------------
test('a failing workflow triggers the error workflow, which emails Casey', async () => {
  S.failNext['GET /mailFolders/inbox/messages/delta$'] = 500;
  const alert = await waitFor('failure alert to Casey', () =>
    sentTo(CASEY, (m) => /^\[Sarah\] Workflow failed: Sarah · Poller/.test(m.subject))[0]);
  assert.equal(alert.via, 'sendMail');
  assert.match(bodyOf(alert), /Graph delta failed/);
  // and the poller recovers on its next run
  const m = mock.deliver({ from: 'rando2@spam.com', to: [SARAH], subject: 'after failure', body: 'hi' });
  await waitFor('poller recovered and processed the next email', async () =>
    (await q1('SELECT count(*)::int AS n FROM sched.messages WHERE internet_message_id = $1 AND processed_at IS NOT NULL',
              [m.internetMessageId])).n === 1);
});

// -----------------------------------------------------------------------------
test('no errors: every processed email reached a final disposition', async () => {
  const r = await db.query(`SELECT id, disposition FROM sched.messages WHERE direction = 'in' AND (processed_at IS NULL OR disposition LIKE 'error%')`);
  assert.deepEqual(r.rows, []);
  const f = await db.query(`SELECT id, kind, last_error FROM sched.outbox WHERE status = 'failed'`);
  assert.deepEqual(f.rows, []);
});
