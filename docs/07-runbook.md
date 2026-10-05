# Runbook

## At a glance

```sql
SELECT * FROM sched.status;                                   -- threads, newest first
SELECT key, value FROM sched.settings WHERE key = 'mode';
SELECT id, kind, purpose, status, attempts, last_error
  FROM sched.outbox WHERE status NOT IN ('done', 'skipped') ORDER BY id DESC;
SELECT id, from_address, subject, disposition, event_at
  FROM sched.messages WHERE direction = 'in' ORDER BY id DESC LIMIT 20;
```

A thread's whole history:

```sql
SELECT at, from_state, to_state, note FROM sched.thread_events WHERE thread_id = <n> ORDER BY at;
SELECT direction, from_address, disposition, left(body_text, 200) FROM sched.messages WHERE thread_id = <n> ORDER BY id;
SELECT round, option_no, slot, status, flags FROM sched.offers WHERE thread_id = <n> ORDER BY round, option_no;
```

## Kill switch

```sql
SELECT sched.set_mode('off');
```

Takes effect within a minute. Mail keeps arriving in Sarah's Inbox. The poller's cursor doesn't advance, so nothing is lost; it's picked up when you turn the mode back on.

Two protections apply on the way back:
- Client-facing mail queued more than `outbox_max_age_hours` earlier is cancelled rather than sent late, and the thread goes to Vic.
- Mail that arrived long ago is still processed. If you were off for days, first set `processing_start_at` to now, so Sarah only picks up new mail, and deal with the backlog by hand.

## Alerts you'll get (to `alert_address`)

| Subject | Meaning | Do |
|---|---|---|
| `[Sarah] Workflow failed: Sarah · <name>` | An n8n execution errored | Open the execution link. A single failure after a network blip is fine; repeats aren't |
| `[Sarah] Thread #n needs attention` | A Graph call failed 3×, an email got stuck mid-processing, or queued mail expired | The thread is `NEEDS_VIC`. Tell Vic, or finish it by hand |
| `[Sarah] Ignored an email (ignored_unauthenticated)` | An email claiming to be from an employee wasn't Exchange-authenticated | Probably spoofing. If it was really Vic (e.g. from his phone via a third-party app), see `docs/05-rollout.md` §1a |
| `[Sarah] Could not process an email` | The email never finished processing. If it belonged to a thread, that thread is now `NEEDS_VIC` | Look at it in Sarah's Inbox and handle it by hand |
| `[Sarah] Ignored an email (ignored_model_unavailable)` | The model was down when Vic CC'd Sarah, so nothing was started | Check LiteLLM, then tell Vic to CC Sarah again, or start it yourself |
| `[Sarah] Booking created on a NEEDS_VIC thread` | A booking finished after the thread was handed to Vic | Ask Vic whether to keep or cancel the event |
| `[Sarah review] #n …` | Shadow mode: approve or reject | — |
| `[Sarah] <name>'s account looks disabled or deleted` | The portal's token refresh failed with AADSTS50057/50034 | If they left BZB, offboard them (below). Their open threads are listed in the alert |

## Common situations

**Vic says Sarah offered a bad time.**
Check `sched.employees` (hours, gaps, notice) and whether the conflicting event was `free` / `workingElsewhere` / declined; those don't count as busy. Also check whether it was an all-day event that isn't busy or OOF.

**A client is stuck with Sarah and Vic wants it.**
Vic replies in the thread "I'll take it from here". Or, by hand:

```sql
UPDATE sched.threads SET closed_reason = 'closed by Casey' WHERE id = <n>;
UPDATE sched.threads SET state = 'CLOSED' WHERE id = <n>;
```

The next timer run (≤ 15 min) retires its offers, so they stop blocking Vic's slots, and releases the holds.

**Wrong or leftover holds on Vic's calendar.**
Holds have the category `Sarah hold`, are private, and are released automatically after `hold_ttl_hours`. It's safe to delete one by hand in Outlook; the executor treats "already gone" as done.

**Poller cursor broken** (e.g. repeated 410 errors, or you restored the mailbox):

```sql
UPDATE sched.settings SET value = 'null' WHERE key = 'poller_delta_link';
UPDATE sched.settings SET value = to_jsonb(now()) WHERE key = 'processing_start_at';
```

The poller then resyncs, and anything older than `processing_start_at` is logged and ignored.

**Model misbehaving** (lots of `draft_source = template`, or escalations saying "couldn't interpret"):
Check the LiteLLM logs for the Scheduling Agent key. Look at `sched.messages.model_raw` for the raw output. If the model rejects `response_format`, set `llm_json_schema` to `false`. To take the model out of client wording entirely while you fix it, set `llm_drafting` to `false`: templates only, classification unchanged.

## Portal and delegated calendars

**Someone says "Sarah lost access to my calendar".** They got "Action needed: reconnect" once. They reconnect at the portal's `/connect` (two clicks). On the admin page their row goes back to "OK". Threads that hit the dead token are already `NEEDS_VIC` and stay theirs; Sarah doesn't resume them. Their "Hold" blocks stay until they reconnect: the releases wait in the outbox as `pending` and run by themselves afterwards. Why it died is in `employees.reconnect_reason` (an AADSTS code). If it recurs on a schedule, check Conditional Access sign-in frequency (`docs/09-portal.md` §9).

```sql
SELECT upn, calendar_auth, calendar_connected_at, needs_reconnect, needs_reconnect_since, reconnect_reason, paused
  FROM sched.employees ORDER BY upn;
```

**Everyone's calendar fails at once.** Look at the portal log (`docker compose logs sarah-portal`) for `token_unavailable … app_problem: true`. That's the portal's client secret (expired or wrong), not the employees' tokens, and nobody was flagged. Rotate it (`docs/09-portal.md` §8).

**Portal down.** `docker compose ps sarah-portal`, then the logs. While it's down, delegated employees' calendar reads fail, so their incoming client replies escalate as calendar errors, and the executor retries holds and bookings 3×. App-only employees are unaffected. Bring it back quickly; there's nothing to replay.

**Offboarding (someone leaves BZB).**
1. Remove them from `Sarah users` in Entra (portal sign-in stops).
2. `UPDATE sched.employees SET enrolled = false WHERE upn = '<upn>';` (Sarah ignores their email and their portal session ends).
3. `DELETE FROM sched.portal_tokens WHERE employee_id = (SELECT id FROM sched.employees WHERE upn = '<upn>');`
   and drop the hold releases that will never run: `UPDATE sched.outbox SET status = 'cancelled', last_error = 'offboarded' WHERE kind = 'delete_hold' AND status = 'pending' AND payload->>'employee_upn' = '<upn>';`
4. Hand their open threads to someone: `SELECT * FROM sched.status WHERE employee_id = …` (close each by hand, as above, after telling the client).

**Turn the public portal off** (Sarah keeps running): `sudo tailscale funnel --https=10000 off`. Turn it back on with `sudo tailscale funnel --bg --https=10000 http://127.0.0.1:3000`.

## Changing behavior

| Change | How |
|---|---|
| Timing, rounds, holds | `UPDATE sched.settings …` (applies immediately) |
| An employee's hours, gaps, defaults | They change them in the portal's Settings (or `UPDATE sched.employees …`) |
| Wording style | `STYLE_EXAMPLES` / `PURPOSE_GUIDE` in `src/prompts.js`, then `npm test && npm run build`, re-import (`docs/04-n8n-setup.md` §3) |
| Fallback templates | `TEMPLATES` in `src/draft.js` (the tests check that every template passes the validator) |
| Routing / decisions | `src/route.js`, `src/decide.js`. Add a test in `test/unit/decide.test.js` first |

## Rotating secrets

The portal's secrets (encryption key, client secret, broker key, session secret): `docs/09-portal.md` §8.

### The Graph client secret (app-only)

1. Entra → the app → Certificates & secrets → **New client secret**. Keep the old one for now.
2. n8n → Credentials → **Sarah · Microsoft Graph (app-only)** → paste the new secret → Save.
3. Watch one poller run succeed.
4. Delete the old secret in Entra.

## Upgrading n8n

After upgrading, run the end-to-end suite locally against the new version (`docs/06-testing.md`) before upgrading production. The HTTP Request, Postgres, Code, IF and Execute Workflow nodes are pinned to specific type versions in the JSON, so an upgrade doesn't silently change their behavior.

## Adding an employee

1. Add them to the **Sarah users** group in Entra.
2. Send them the portal link (`https://bzb-ai-1.tail9f1964.ts.net:10000`) and `docs/vic-guide.md`.

They sign in, connect their calendar, check their settings, and can CC Sarah straight away. Confirmation emails, holds and bookings all use the thread's own employee, and client emails are signed with their name.
