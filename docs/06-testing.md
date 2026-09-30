# Testing

Three layers. All of them passed on 2026-09-30 against n8n 2.41.4, Node 24, and Postgres 16.

## Unit tests: `npm test` (71 tests, ~1 s)

Plain Node (≥ 20). No n8n, database, or network.

| File | Covers |
|---|---|
| `test/unit/slots.test.js` | Hard rules (busy, gaps, travel buffer, day cap, notice, working hours), soft scoring, back-to-back fallback order, window widening, all-day/OOF handling, holds not counted, cross-thread offers blocking, constraints, time-of-day mix, re-check modes |
| `test/unit/decide.test.js` | Every processor path end to end with canned model/calendar responses: trigger → intro; accept; taken slot; counter-proposals (free / busy / other timezone / back-to-back); reject-all; max rounds; question hand-off; delegation to an EA; unparseable replies; Vic YES / NO / unclear / conflict; take-over; follow-up, stall and reminder timers; recipient guard |
| `test/unit/parts.test.js` | Model-output parser (`<think>`, fences, echoed schemas), draft validator (every forbidden fact type, placeholder rules, every template passes), slot formatting incl. DST, routing and spoof/OOO guards, Graph request shapes, retry classification, poller normalization |
| `test/unit/bundle.test.js` | The generated bundle runs in a sandbox with only Luxon globals (as in an n8n Code node) |

## Database tests: `npm run test:db` (83 tests)

```bash
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres npm run test:db
```

This creates `sched_agent_test`, applies all migrations, and runs `db/tests/db_tests.sql`, which rolls itself back. It covers:

- leases
- ingest dedupe and redelivery
- `load_context` matching and the "in progress" guard
- atomic `apply_plan`, including the cross-thread overlap rejection
- the outbox in all four modes
- dependencies, retries, failure escalation and cascade-cancel
- shadow review (bad token, double click, reject)
- hold release
- timers and the stuck-email sweeper
- the state machine
- `search_path` pinning (n8n connects with the default path)

You can run the test file against the production database too. It never commits.

## End-to-end: `npm run test:e2e` (8 scenarios, ~3–4 min)

This runs **the real generated workflows in a real n8n** against:

- a real Postgres
- `test/e2e/mock-server.js`, which mocks the OAuth token endpoint, Microsoft Graph (inbox, delta, drafts, send, calendar, events), and LiteLLM (a rule-based model that answers with `<think>` blocks like a reasoning model)

```bash
N8N_BIN=/path/to/node_modules/n8n/bin/n8n PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres npm run test:e2e
```

`test/e2e/run.sh`:

1. Creates `sched_e2e`.
2. Imports the credentials (pointed at the mock) and the workflows (with schedules shortened to seconds).
3. Publishes them and starts n8n.
4. Runs `test/e2e/scenarios.test.js`.

Set `E2E_DUMP=/tmp/sent.txt` to get a readable copy of every email Sarah sent.

| Scenario | Proves |
|---|---|
| live happy path | Trigger → intro (reply-all, Vic BCC, formatted times, AI signature) → 3 private holds → client picks option 2 → Vic asked → ack → holds released → Vic YES → event on **Vic's** calendar with client attendee + Teams + idempotency key → `BOOKED` → confirmation. Nothing ever sent from Vic's mailbox |
| shadow review | External mail waits as a draft; review email arrives; opening the link does nothing; POST approve sends **the reviewed draft itself**; a second approve is refused |
| guards | Spoofed Vic → ignored + alert; out-of-office and stranger → ignored; nothing else sent |
| model garbage | Unparseable classification → `NEEDS_VIC`, Vic told, client not emailed |
| Graph 503 | Retried; the email goes out exactly once |
| follow-up timer | Quiet client gets one follow-up with a fresh round |
| error workflow | A failing Poller run emails Casey via Sarah's mailbox; the next run recovers |
| clean finish | Every inbound email reached a final disposition; no failed outbox items |

**Bugs this layer caught that unit and DB tests missed:**

- A trigger function referenced a table without its schema. The tests ran with `search_path = sched`; n8n doesn't. The fix pins every function's `search_path`, and a DB test now guards it.
- n8n ignores an expression in HTTP Request → *Send Body*, so a dynamic POST went out with an empty body. The Executor now uses a separate node for body and no-body calls.
- A lease that outlived a crashed run exposed a double-processing race. `load_context` now refuses a message another run has started.

**Bugs an independent code review caught after all three layers were green** (each now has a test):

- A reply could quote Vic's private note to the client.
- A crash mid-processing left the thread running instead of escalating it.
- Client display names could steer the YES/NO classifier.
- A proposed time in another timezone slipped through the "accept" path.
- After a follow-up, a stale "option 2" could mean a different time.
- A second YES could queue a second booking in shadow mode.
- An email and a timer could race on one thread.
- Vic couldn't start a new request in a finished email thread.
- dry_run threads blocked slots after go-live.
- Offers on escalated threads never expired.
- The calendar read could stop short of the candidate window.
- "9:00" (unpadded) from the model was dropped.
- Shadow drafts never expired.
- The model-down fallback could start scheduling Vic hadn't asked for.

## Running n8n 2.x locally for the e2e

n8n 2.x needs Node ≥ 24. If `isolated-vm` (the expression sandbox) was installed under an older Node, run `npm rebuild isolated-vm` under Node 24. Without that, n8n fails with "IsolatePool failed to create any bridges".
