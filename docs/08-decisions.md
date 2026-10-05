# Decisions

Newest last. Each entry records what was decided and why, so the next person doesn't have to reverse-engineer it.

### D1 · 2026-09-17 · Four narrow workflows, not one "secretary agent"
The AI secretary for Vic is split into narrow pieces (inbox triage, scheduling, meeting prep, commitment tracking) over shared state. Scheduling is built first because it talks to Vic's clients. The evidence: BZB-EVAL-01 scored open-ended tasks around 37% against about 75% for targeted ones.

### D2 · 2026-09-30 · Sarah is a shared mailbox; the invite comes from Vic's calendar
A shared mailbox needs no license. The only thing that would need one is a Teams meeting organized by Sarah. Instead, the booking is created on Vic's calendar with the client as an attendee: Exchange sends the invite as Vic, and the Teams link works because Vic is licensed. All negotiation email still comes from Sarah. **To confirm with Vic:** "never from my address" covers correspondence, not the invite. If he wants the invite from Sarah, the path is to mint the meeting with `POST /users/{vic}/onlineMeetings` (Teams application access policy + `OnlineMeetings.ReadWrite.All`) and create the event on Sarah's calendar. That isn't built.

### D3 · 2026-09-30 · Vic moves to BCC after the intro
Sarah's first reply moves Vic from CC to BCC, the way a human assistant does. Client replies then come only to Sarah. This is set per employee (`bcc_after_intro`).

### D4 · 2026-09-30 · Scope the app with Exchange RBAC for Applications, split mail vs calendar
Entra application permissions can't be limited to mailboxes. Code-level limits don't count as a boundary, because anyone holding the secret bypasses the code. So the app has no Entra permissions at all. Mail rights cover Sarah only (`CustomAttribute10`) and calendar rights cover Vic only (`CustomAttribute11`). A stolen secret can't read Vic's inbox or send as him. *(Calendar part superseded by D17: calendars now come through the portal with each employee's own token, and the app gets no calendar rights. `CustomAttribute11` survives only as an optional, temporary step in `docs/02-m365-setup.md`.)*

### D5 · Poll with Graph delta; no webhooks
A 1-minute delay doesn't matter in scheduling. Polling avoids exposing n8n publicly and avoids subscription renewal.

### D6 · The model writes words; code controls every fact
The model classifies into fixed JSON and writes wording around `{{SLOTS}}` / `{{TIME}}` placeholders. It never produces a date, time, recipient or action. Drafts containing any date, time, timezone, link, email address or phone number are replaced with a template. This makes it safe to run on a local model.

### D7 · Transactional outbox + run modes
All side effects go through `sched.outbox`, written in the same transaction as the state change. The mode (`off` / `dry_run` / `shadow` / `live`) is enforced where the outbox is claimed, so no workflow can bypass it. Shadow mode gates exactly the things that leave BZB (external mail and bookings) and lets holds and internal notices run, so shadow behaves like live.

### D8 · Soft back-to-back avoidance
Back-to-back meetings are penalized in scoring, not forbidden. Fallback order: widen the window → offer fewer → include back-to-back, ranked last. A client's own back-to-back but legal proposal is accepted and flagged to Vic rather than refused.

### D9 · v1 scope
Initial booking only. Vic confirms after the client picks. All times are in Vic's timezone with the offset stated. One follow-up, then stop. Anything after booking goes to Vic.

### D10 · Configuration in Postgres, not n8n variables
n8n 2.x blocks `$env` in nodes by default, and Variables are a paid feature. Settings in `sched.settings` apply without redeploying and are visible in one query.

### D11 · Logic in `src/`, generated into the workflows
The routing, slot and validation logic is tested JavaScript, bundled into the Code nodes at build time. The workflow JSON is generated, has fixed IDs, and is reproducible. Nobody edits logic inside the n8n UI.

### D12 · Review links need a POST
Email security scanners follow links. A GET only shows a confirm page, and only the button's POST acts. The token is 256-bit and single-use, and the webhook is tailnet-only.

### D13 · Disclosed AI assistant
The display name is "Sarah Johnson (AI Scheduling Assistant)", and the signature says "(AI)". Clients will eventually ask Sarah something only a person can answer. The disclosure keeps that from looking deceptive, which matters in the biotech and government circles Vic works in.

### D14 · 2026-09-30 · Option numbers are unique per thread
Round 2 offers 4–6, and so on. A client answering an older email is never matched to a newer option with the same number. Their original pick is re-checked and taken if still free.

### D15 · 2026-09-30 · Optimistic concurrency on threads
Every plan records the `plan_version` it was decided on, and `apply_plan` refuses a stale one. The email goes back into the queue and is decided again on fresh state. The rare cost is a few minutes' delay; the alternative was two decisions overwriting each other.

### D16 · 2026-09-30 · When the model is down, don't guess
A keyword fallback for triggers was removed: "Sarah, don't schedule anything yet, I'll call them" matches the same keywords. Casey is alerted instead.

### D17 · 2026-09-30 · Delegated calendars, through a broker that never hands out tokens
Calendar access is now per employee and delegated: each person signs in to the portal and consents to Sarah using their own calendar. Enrolling someone no longer needs PowerShell (`CustomAttribute11`) or SQL, and once everyone is moved over, the app-only secret loses calendar rights entirely and can touch nothing but Sarah's mailbox. Mail stays app-only and RBAC-scoped (D4); nothing ever sends from an employee's mailbox.

Three choices inside that:
- **A separate app ("BZB Sarah Portal").** The app-only app keeps zero Entra permissions (D4's audit rule), and each secret lives in one place: the portal's in the portal, the app-only one in n8n.
- **The broker makes the calendar calls instead of returning tokens.** A returned access token would pass through n8n's item data and be saved in its execution history. A raw delegated `Calendars.ReadWrite` token also reaches every calendar shared *with* that person. So n8n names an employee and one of three operations, and the portal calls Graph on `/me` and passes Graph's answer back unchanged. Tokens never leave the portal, and the executor's error handling didn't change. Every broker call is a POST with a body, which also sidesteps n8n's *Send Body* expression bug.
- **Refresh tokens at rest:** an MSAL cache per employee, AES-256-GCM, key only in the portal's env, ciphertext bound to the employee row. The portal's DB role can run its own functions and read no tables.

Vic's existing app-only path keeps working (`calendar_auth = 'app'`) until he signs in and connects once.

### D18 · 2026-09-30 · Pause affects new requests only; a dead token hands threads back
**Pause** is for "I'm away": new requests from that person are ignored, and Sarah emails them why. Threads already running continue, so no client is left hanging mid-negotiation.

**A dead token** (revoked, consent withdrawn, account disabled, Conditional Access) is detected by a daily refresh, ideally before any client writes. The employee is flagged once and gets one reconnect email. New requests are refused with a notice. A running thread that needs the calendar goes to `NEEDS_VIC` with a specific reason, and the client is told nothing. `NEEDS_VIC` is terminal for Sarah, so after reconnecting the employee finishes those threads by hand. A resumable "paused for reconnect" state was considered and left out: the daily refresh makes the case rare, and handing back follows the rule "when unsure, give it to a person". Two special cases: a disabled account alerts Casey instead of emailing a dead mailbox, and a bad *portal* secret flags nobody, because one expired secret must not email every employee.

### D19 · 2026-09-30 · The portal is public, on Tailscale Funnel :10000
Employees sign in from wherever they are, so the portal is internet-facing at `https://bzb-ai-1.tail9f1964.ts.net:10000`: Open WebUI holds Funnel's 443, and Funnel allows only 443/8443/10000. Being public changes the defaults:
- **Access:** "Assignment required" plus a `Sarah users` group (mandatory), and generic errors.
- **Browser hardening:** `__Host-` cookies (the hostname is shared with Open WebUI), CSRF on every POST, a strict CSP with no script, HSTS.
- **Rate limits** on sign-in, keyed on the socket address.
- **No trusted proxy headers:** every URL is built from `PORTAL_BASE_URL` alone, because TLS ends at tailscaled and the app can't tell a real forwarded header from a forged one. The cost: per-IP rate limiting effectively becomes portal-wide.
- **The broker's port is never published.**

Funnel hostnames appear in certificate-transparency logs, so the portal assumes it will be found. Moving to a branded domain later is a config change (`docs/09-portal.md` §4).

### D20 · 2026-10-05 · More model, same guardrails: {{ASKED}} and one redraft
In shadow testing on the local Qwen model, many client emails fell back to the fixed templates, because the model naturally repeated the client's own words ("Thursday the 8th is full…"), which D6 forbids. Two changes let the model do more of the writing without letting it state a fact:
- **`{{ASKED}}`:** a placeholder for the day or time the client asked about. Code fills it in ("Thursday, October 8"), so the model can say "{{ASKED}} is booked up, but…".
- **One redraft:** a draft that breaks a rule goes back to the model once, with the exact problem quoted. Only a second failure falls back to the template. `draft_source` records `model`, `model_retry` or `template`.

At the same time, the voice guidance became more conversational: respond to what the client said, match their tone, no stock phrases. When the client's window is fully booked, Sarah now offers the closest times after it (`window_unavailable`) instead of handing off. The disclosure (D13) is unchanged.
