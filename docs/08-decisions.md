# Decisions

Newest last. Each entry records what was decided and why, so the next person doesn't have to reverse-engineer it.

### D1 · 2026-09-17 · Four narrow workflows, not one "secretary agent"
The AI secretary for Vic is split into narrow pieces (inbox triage, scheduling, meeting prep, commitment tracking) over shared state. Scheduling is built first because it talks to Vic's clients. The evidence: BZB-EVAL-01 scored open-ended tasks around 37% against about 75% for targeted ones.

### D2 · 2026-09-30 · Sarah is a shared mailbox; the invite comes from Vic's calendar
A shared mailbox needs no license. The only thing that would need one is a Teams meeting organized by Sarah. Instead, the booking is created on Vic's calendar with the client as an attendee: Exchange sends the invite as Vic, and the Teams link works because Vic is licensed. All negotiation email still comes from Sarah. **To confirm with Vic:** "never from my address" covers correspondence, not the invite. If he wants the invite from Sarah, the path is to mint the meeting with `POST /users/{vic}/onlineMeetings` (Teams application access policy + `OnlineMeetings.ReadWrite.All`) and create the event on Sarah's calendar. That isn't built.

### D3 · 2026-09-30 · Vic moves to BCC after the intro
Sarah's first reply moves Vic from CC to BCC, the way a human assistant does. Client replies then come only to Sarah. This is set per employee (`bcc_after_intro`).

### D4 · 2026-09-30 · Scope the app with Exchange RBAC for Applications, split mail vs calendar
Entra application permissions can't be limited to mailboxes. Code-level limits don't count as a boundary, because anyone holding the secret bypasses the code. So the app has no Entra permissions at all. Mail rights cover Sarah only (`CustomAttribute10`) and calendar rights cover Vic only (`CustomAttribute11`). A stolen secret can't read Vic's inbox or send as him.

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
