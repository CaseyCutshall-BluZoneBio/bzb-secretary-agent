# 2 · Database

Sarah gets **her own database and role** in the Postgres already running in the `bzb-ai` compose stack. The n8n credential for Sarah can't touch LiteLLM's tables, and LiteLLM's can't touch Sarah's.

## Create and migrate

From `/opt/bzb-ai/compose` on BZB-AI-1, where the Postgres service is `db` (container `bzb-ai-db-1`). The repo is checked out at `/opt/bzb-ai/sarah`.

**1. Roles and database.** Do this inside `psql`, so no password lands in your shell history. `$POSTGRES_USER` is the container's own superuser:

```bash
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d postgres'
```
```sql
CREATE ROLE sched_agent LOGIN;
\password sched_agent
CREATE ROLE sched_portal LOGIN;       -- the portal's role (docs/09-portal.md); create it before 004 so 004 can grant to it
\password sched_portal
CREATE DATABASE sched_agent OWNER sched_agent;
\q
```

**2. Fill in `db/003_seed.sql`:** every `FILL IN` (office address, alert address, LiteLLM URL + model name, n8n tailnet URL). Values are SQL: text goes in single quotes, e.g. `'321 Ballenger Center Dr, Frederick, MD 21703'`, and an apostrophe inside text is doubled (`''`). Leave Vic's UPN as it is; step 4 sets the real one.

**3. Apply, in order** (stops at the first error):

```bash
for f in /opt/bzb-ai/sarah/db/0[0-9][0-9]_*.sql; do
  echo "== $f"
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U sched_agent -d sched_agent < "$f" || break
done
```

`003` isn't wrapped in a transaction. If it fails part-way (usually a quoting mistake), its settings rows are already in: fix the file, `DELETE FROM sched.settings;` (only on a fresh install), and re-run `003` and `004`.

**4. Vic's real address,** then the self-tests:

```bash
docker compose exec -T db psql -U sched_agent -d sched_agent -c \
  "UPDATE sched.employees SET upn = 'vic.suarez@bluzonebio.com' WHERE upn = 'vic@bluzonebio.com';"
for t in /opt/bzb-ai/sarah/db/tests/*.sql; do
  docker compose exec -T db psql -U sched_agent -d sched_agent -t -A < "$t" | grep -E '^(PASS|FAIL)' > /tmp/sched-test.out
  echo "$t: $(grep -c '^PASS' /tmp/sched-test.out) PASS, $(grep -c '^FAIL' /tmp/sched-test.out) FAIL"
done
```

Expect 84 PASS / 0 FAIL and 50 PASS / 0 FAIL. Each test file runs in one transaction and rolls back, so it never changes your data. Run them right after installing or upgrading, before real traffic: they count rows such as queued outbox items, so on a busy system they can report false FAILs.

### Upgrading an existing install

Migrations are numbered and additive. Never edit an applied file; add the next one. `sched.schema_migrations` records what's applied. To upgrade, apply only the new files:

```bash
docker compose exec -T db psql -U sched_agent -d sched_agent -c "SELECT version FROM sched.schema_migrations ORDER BY 1;"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U sched_agent -d sched_agent < /opt/bzb-ai/sarah/db/004_portal.sql
```

`004_portal.sql` is idempotent (safe to run twice). It leaves existing rows working exactly as before: Vic keeps `calendar_auth = 'app'`. It also revokes `PUBLIC`'s default `EXECUTE` on every `sched` function. n8n connects as the owner, `sched_agent`, so it's unaffected; the portal role can only run `portal_*`.

`btree_gist` is a trusted extension, so the database owner can create it without superuser. It powers the "no two live offers overlap" constraint.

## Settings reference (`sched.settings`)

Change a value with, for example:

```sql
UPDATE sched.settings SET value = '"qwen-3.8"' WHERE key = 'llm_model';  -- strings need JSON quotes
UPDATE sched.settings SET value = '72' WHERE key = 'client_followup_after_hours';
SELECT sched.set_mode('shadow');                                        -- mode has its own guarded setter
```

Workflows read settings on every run, so changes apply immediately. A setting missing from the table falls back to the default below, so a key added in a later version works on an older install before you insert it, for example:

```sql
INSERT INTO sched.settings (key, value, note) VALUES ('max_horizon_days', '90', 'Furthest ahead a requested window may start') ON CONFLICT (key) DO NOTHING;
```

| Key | Default | Meaning |
|---|---|---|
| `mode` | `off` | `off` / `dry_run` / `shadow` / `live`. See `docs/05-rollout.md` |
| `processing_start_at` | install time | Inbound mail older than this is logged and ignored. Reset it the first time you leave `off` |
| `sarah_upn` | `sarah.johnson@bluzonebio.com` | The only sender |
| `sarah_name`, `signature_title`, `company_name` | Sarah Johnson · Scheduling Assistant to Vic Suarez (AI) · Blu Zone Bio | Signature lines. The second line is the AI disclosure; keep it |
| `internal_domains` | `["bluzonebio.com"]` | Addresses here are never treated as clients |
| `alert_address` | — | Errors and shadow-mode review emails go here (you) |
| `graph_base_url` | `https://graph.microsoft.com/v1.0` | |
| `litellm_url` | `http://litellm:4000/v1/chat/completions` | As n8n reaches LiteLLM on the compose network |
| `llm_model` | — | The LiteLLM model alias |
| `llm_json_schema` | `true` | Send `response_format: json_schema`. Set `false` if the backend rejects it; the parser copes either way |
| `llm_drafting` | `true` | `false` = client emails always use the fixed templates (no model wording) |
| `require_internal_auth` | `true` | Only act on employee emails stamped `AuthAs: Internal`. Read `docs/05-rollout.md` §2 before changing |
| `n8n_base_url` | — | Tailnet URL for review links, e.g. `http://bzb-ai-1:5678` |
| `max_rounds` | 4 | Offer rounds before handing to Vic |
| `client_followup_after_hours` | 72 | Client silence before the one follow-up |
| `stall_after_followup_hours` | 72 | Silence after the follow-up before `STALLED` |
| `vic_reminder_after_hours` | 4 | Waiting on Vic this long → one reminder |
| `holds_enabled` | `true` | Private tentative holds on Vic's calendar for offered slots |
| `hold_ttl_hours` | 48 | Holds are released after this even if the client hasn't answered |
| `slot_step_min` | 30 | Candidate start-time grid |
| `widen_window_days` | 7 | Extra look-ahead when clean slots are scarce |
| `max_horizon_days` | 90 | How far ahead a requested window may start (today is day 0). A request that starts later goes to the employee instead of being offered nearer dates. Also the length of the date table the model maps "the week of the 26th" against |
| `outbox_max_attempts` | 3 | Graph retries before an item fails and the thread escalates |
| `outbox_max_age_hours` | 24 | Client-facing mail unsent after this long is cancelled, not sent late |
| `poller_lease_seconds` | 90 | After a poller crash, the next run can start after this long |
| `poller_delta_link` | `null` | Graph delta cursor, managed by the poller. `null` = resync |
| `portal_base_url` | `https://bzb-ai-1.tail9f1964.ts.net:10000` | The public portal URL. Links in emails (reconnect, pause notices) use it. Must match the portal's `PORTAL_BASE_URL` |
| `portal_internal_url` | `http://sarah-portal:3001` | The token broker as n8n reaches it on the compose network |
| `portal_admins` | `[]` | UPNs (lowercase) allowed on the portal's admin page, besides `alert_address` |

Per-person rules live in `sched.employees`: working hours, preferred hours, default length and location, gaps, travel buffer, max per day, notice, look-ahead, slots per round, and BCC-after-intro. Employees edit their own in the portal. Values marked `CONFIRM` in `003_seed.sql` are defaults; go through them with Vic.

Columns added by `004` (`docs/09-portal.md`):

| Column | Meaning |
|---|---|
| `calendar_auth` | `app` (legacy RBAC-scoped app-only access) or `delegated` (the employee's own token through the portal's broker) |
| `calendar_connected_at` | Last successful connect. A `delegated` row without it hasn't connected yet, and Sarah ignores its triggers with a notice |
| `paused`, `paused_at` | Set by the employee. New requests are ignored with a notice; running threads continue |
| `needs_reconnect`, `needs_reconnect_since`, `reconnect_reason` | Their token is dead (the reason is an AADSTS code). New requests are ignored with a notice; threads that need the calendar go to `NEEDS_VIC` |
| `aad_object_id`, `mail` | Entra identity; `mail` (primary SMTP) is matched against `From:` alongside `upn` |
| `signature_title` | The AI-disclosure line in client emails, e.g. "Scheduling Assistant to Brad Lee (AI)" |
| `settings_saved_at`, `last_sign_in_at` | Saved own settings (the Outlook prefill then never overwrites them); last portal sign-in |
| `enrolled` | Admin switch (unchanged). `false` = Sarah ignores them and they lose portal access. Use it for offboarding |

## Functions the workflows call

All take and return `jsonb`, so each n8n Postgres node is one parameterized statement and every multi-row change is atomic. Every function pins its own `search_path`. n8n connects with the default one, and a test guards this.

| Function | Caller | Does |
|---|---|---|
| `try_lease`, `release_lease` | Poller | Prevents overlapping poller runs |
| `ingest_message(msg)` | Poller | Stores an inbound email once. Redelivers one that was stored but never started |
| `load_context(event)` | Processor | Everything one decision needs. Marks the email "in progress" |
| `apply_plan(plan)` | Processor | Creates/updates the thread, offers and transitions, and queues the outbox, atomically |
| `outbox_claim(n)` | Executor | Hands out ready items per the run mode |
| `outbox_report(result)` | Executor | Records results. Sets `BOOKED`, stores hold ids, escalates failures, queues review emails |
| `outbox_review(id, token, action)` | Review | Shadow-mode approve/reject |
| `timer_events()` | Timers | Sweeps stuck work, expires offers, releases holds, emits follow-up / stall / reminder events |
| `set_mode(mode)` | you | Guarded mode switch |
| `outbox_claim` / `outbox_report` (004 wrappers) | Executor | Calendar items carry the employee's current `calendar_auth`. A `needs_reconnect` failure fails a hold or booking without retries and hands the thread to the employee with a specific reason (no Casey alert). Hold releases for a disconnected employee aren't handed out; they wait until the reconnect. Everything else goes to the originals, kept as `*_base` |
| `portal_*` | Portal (`sched_portal` role) | `SECURITY DEFINER`: sign-in, connect, settings, pause, the encrypted token cache, `portal_mark_reconnect` (flags once and queues one email), test email, threads, admin overview, sessions |
