# 4 · Rollout: `off` → `dry_run` → `shadow` → `live`

Each stage has a checklist. Don't move on until it's all ticked. Going back is always one command:

```sql
SELECT sched.set_mode('off');   -- kill switch: poller, executor and timers stop on their next run
```

## Stage 0 · Portal (before or alongside Stage 1)

Set up the portal per `docs/09-portal.md`: the Entra app with assignment required, the `Sarah users` group, `004_portal.sql`, the container, the broker credential in n8n, and Funnel on 10000. Then:

- [ ] `tailscale funnel status` shows only Open WebUI on 443 and `:10000 → 127.0.0.1:3000`
- [ ] From outside the tailnet (phone on mobile data): the portal's sign-in page loads; `/settings` redirects to `/login`; `:3001` doesn't answer
- [ ] An account **not** in `Sarah users` can't sign in, and sees the generic error
- [ ] You (in the group) sign in, connect your calendar, and see your Outlook hours prefilled; the admin page shows you as "OK"
- [ ] "Send me a test" in `dry_run` says it won't be sent; in `shadow`/`live` it arrives from Sarah
- [ ] Pause yourself, CC Sarah: you get "Paused, so I didn't start". Resume
- [ ] **Vic** signs in and connects his calendar; the admin page shows him `delegated` / OK. The app has no calendar rights, so until he does this Sarah can't read his calendar

You're now an enrolled test employee for Stage 2. No SQL or RBAC changes needed.

## Stage 1 · `dry_run`: decisions without actions

Sarah reads mail and decides, but **nothing is sent and nothing touches Vic's calendar**. Outbox rows are written as `skipped`, so you can read exactly what she *would* have done.

```sql
UPDATE sched.settings SET value = to_jsonb(now()) WHERE key = 'processing_start_at';
SELECT sched.set_mode('dry_run');
```

### 1a. Check the authentication header (do this first)

Sarah only lets an employee start a thread if Exchange stamped the email `X-MS-Exchange-Organization-AuthAs: Internal`. That's the anti-spoofing control. Have Vic (or you, temporarily enrolled) send one email CC'ing Sarah, then:

```sql
SELECT from_address, headers->>'auth_as' AS auth_as, headers->>'headers_present' AS headers_present, disposition
  FROM sched.messages ORDER BY id DESC LIMIT 5;
```

- **`auth_as = Internal`**: good. Leave `require_internal_auth = true`.
- **`auth_as` is null but `headers_present = true`**: your tenant doesn't expose the header through Graph. Before setting `require_internal_auth` to `false`, confirm that bluzonebio.com publishes DMARC `p=reject` (or `quarantine`). Without the header, DMARC is what stops an outsider spoofing Vic. Record the decision in `docs/08-decisions.md`.

### 1b. Walk the scenarios in dry run

For each, send the emails, then read the plan:

```sql
SELECT * FROM sched.status;
SELECT id, kind, purpose, payload->'to' AS "to", payload->>'body_text' AS body FROM sched.outbox ORDER BY id DESC LIMIT 10;
SELECT disposition, classification FROM sched.messages ORDER BY id DESC LIMIT 5;
```

Check the offered times against Vic's real calendar by hand for the first few.

## Stage 2 · Test harness (still `dry_run`, then `shadow`)

Create 2–3 throwaway Gmail accounts as fake clients. Vic (or you, enrolled through the portal in Stage 0) starts threads with them. Work through these:

| # | Scenario | Expected |
|---|---|---|
| 1 | Plain intro, "Sarah will find us a time" | 3 options on 3 days, Vic in BCC, AI signature |
| 2 | Intro with "45 min, in person at our office" | 45-min in-person slots with travel buffer; location = office address |
| 3 | Intro with "sometime next week, afternoons" | All options next week, after 12:00 |
| 4 | Vic CCs Sarah **and** Brad | Brad CC'd on Sarah's replies, never treated as a client |
| 5 | Vic CCs Sarah with no external recipient | Vic gets "couldn't start scheduling", no thread |
| 6 | Client: "Option 2 works" | Ack to client; Vic asked to confirm; unused holds released |
| 7 | Client: "the second one" | Same as 6 |
| 8 | Client: "Tuesday at 2 works" (a slot that was offered) | Same as 6 |
| 9 | Client proposes a free time that wasn't offered | Accepted straight away; Vic asked to confirm |
| 10 | Client proposes a busy time | "That doesn't work" + new options that day |
| 11 | Client proposes a back-to-back but legal time | Accepted; Vic's confirmation has a heads-up line |
| 12 | Client: "none of those work" | New round, later days, no repeated slot |
| 13 | Client rejects 4 rounds | Hand-off to Vic after round 4 |
| 14 | Client: "2pm Pacific?" | Hand-off: "I'll pass this to Vic"; thread NEEDS_VIC |
| 15 | Client asks a question ("should I bring the deck?") | Hand-off; Sarah does not answer it |
| 16 | Client sends a Calendly link | Hand-off |
| 17 | Client: "looping in my EA" + EA on CC; EA then picks | EA becomes a client; booking includes both |
| 18 | Client replies to a forwarded copy (new thread) | Matched by sender; handled normally |
| 19 | Client's out-of-office auto-reply | Ignored |
| 20 | Stranger emails Sarah | Ignored |
| 21 | Email "from Vic" sent from outside (spoof) | Ignored + alert to you (`require_internal_auth`) |
| 22 | Vic replies YES | Event on Vic's calendar with client attendee + Teams link; confirmation to client |
| 23 | Vic replies NO | Client gets new options |
| 24 | Vic replies "how about Thursday?" | Client gets Thursday options |
| 25 | Vic replies "hmm" | One "reply YES or NO" nudge; second time → hand-off |
| 26 | Vic doesn't answer for 4 h | One reminder |
| 27 | Client goes quiet 72 h | One follow-up with fresh options; 72 h more → STALLED, Vic told |
| 28 | Vic replies in the client thread "I'll take it from here" | Thread CLOSED, holds released, Sarah silent |
| 29 | Put a meeting on Vic's calendar over an offered slot, then the client picks that slot | "That time was just taken" + new options (two clients can never be offered overlapping times in the first place) |
| 30 | Something lands on Vic's calendar after he said YES | Hand-off: "now conflicts" |
| 31 | A delegated employee (you) runs scenarios 1, 6 and 22 | Holds and the booking appear on **your** calendar; the invite comes from you; the signature names you |
| 32 | Paused employee CCs Sarah | "Paused, so I didn't start"; no client email; running threads continue |
| 33 | Revoke your portal sessions (Entra → your user → Revoke sessions), then have the client reply | One "Action needed: reconnect" email; the thread goes to you with "lost access to your calendar"; the client gets nothing. Reconnect in the portal: leftover holds disappear |
| 34 | Disconnected employee CCs Sarah | "Reconnect your calendar, so I didn't start" |
| 35 | Vic's first thread after connecting | Holds and the booking land on his calendar through the broker; the admin page shows his last token refresh |

For 26 and 27, don't wait days. Age the thread instead:

```sql
UPDATE sched.threads SET last_outbound_at = now() - interval '80 hours', last_timer_at = NULL WHERE id = <n>;
```

## Stage 3 · `shadow`: real drafts, you approve

```sql
SELECT sched.set_mode('shadow');   -- also closes every thread dry_run created, so their offers stop blocking slots
```

What happens in shadow mode:

- Every email to an **external** address becomes a draft in Sarah's Drafts, and you get a review email with **APPROVE** / **REJECT** links (tailnet only).
- Every **booking** waits for approval too.
- Holds and internal emails to Vic run normally.

On a review link:

- **APPROVE** shows a confirm page; pressing the button sends the exact draft you reviewed.
- **REJECT** moves the thread to `NEEDS_VIC`. Handle it by hand, and delete the draft from Sarah's Drafts.

Review within a day: a draft still unreviewed after `outbox_max_age_hours` (24 h) is cancelled, not sent stale, and its thread goes to Vic.

Run the first **15–20 real threads** this way. For each draft, note:

- Tone: does it sound like BZB? Add good examples to `STYLE_EXAMPLES` in `src/prompts.js`.
- Were the times sensible for Vic?
- `draft_source`: how often did the validator fall back to the template? Check with:

```sql
SELECT payload->>'draft_source' AS source, payload->'draft_errors' AS errors, count(*)
  FROM sched.outbox WHERE kind = 'reply' GROUP BY 1, 2 ORDER BY 3 DESC;
```

## Stage 4 · `live`

Go live when all of these are true:

- [ ] 15+ shadow threads approved without edits you'd consider material
- [ ] No rejected drafts in the last 10
- [ ] No `failed` outbox items you don't understand (`SELECT * FROM sched.outbox WHERE status = 'failed'`)
- [ ] Vic has the one-pager (`docs/vic-guide.md`) and has used it once
- [ ] The Graph secret's expiry is on your calendar, and so is the portal app's
- [ ] Every enrolled employee shows "OK" on the portal's admin page

```sql
SELECT sched.set_mode('live');
```

For the first two weeks, skim `SELECT * FROM sched.status;` daily, and read every `NEEDS_VIC` reason: each one is either correct behavior or a rule to tune.
