# 3 · n8n setup

Assumes n8n **2.x** in the `bzb-ai` compose stack on BZB-AI-1, the service named `n8n` below. The workflows were built and tested against **n8n 2.41.4** (see `docs/06-testing.md`).

## 1. Prerequisites

- **n8n must NOT be publicly reachable.** The review webhook is token-protected, but it belongs on the tailnet only. On BZB-AI-1, n8n is served on `:8443` with `tailscale serve` (tailnet only). `tailscale serve status` must not show Funnel on 8443. (The portal uses Funnel on 10000; `docs/09-portal.md`.)
- **n8n runs in its own compose stack** (`n8n`, network `n8n_default`), while Sarah's database, LiteLLM and the portal are in the `bzb-ai` stack (`bzb-ai_default`). Attach n8n to that network as well, so it reaches them by service name. In n8n's compose file:
  ```yaml
  services:
    n8n:
      networks: [default, bzb-ai]
  networks:
    bzb-ai:
      external: true
      name: bzb-ai_default
  ```
  Then `docker compose up -d` in n8n's folder. From n8n, the database is `db:5432`, LiteLLM is `http://litellm:4000`, and the broker is `http://sarah-portal:3001`.
- n8n can reach Postgres, LiteLLM and the portal's token broker (`sarah-portal:3001`, `docs/09-portal.md`) by service name on the compose network.
- A LiteLLM virtual key named **Scheduling Agent**, so this agent's usage shows up on its own.

## 2. Credentials

```bash
cp n8n/credentials.template.json n8n/credentials.json    # credentials.json is gitignored
```

Fill in every `FILL IN` in `n8n/credentials.json`:

| Credential (fixed ID) | Fields |
|---|---|
| `SchedPostgres001` · Sarah · Postgres | host `db` (reachable once n8n is on `bzb-ai_default`, §1), port 5432, database `sched_agent`, user `sched_agent` / password |
| `SchedGraphApp001` · Sarah · Microsoft Graph | `accessTokenUrl` with your **tenant ID**, `clientId`, `clientSecret` (from `docs/02-m365-setup.md`). Grant type **Client Credentials**, scope `https://graph.microsoft.com/.default` |
| `SchedLiteLLM0001` · Sarah · LiteLLM key | `Bearer <Scheduling Agent virtual key>` |
| `SchedPortalKey01` · Sarah · Portal broker key | Header `X-Sarah-Broker-Key`, value = the portal's `PORTAL_BROKER_KEY`. Used only for calendar calls of employees on delegated access; mail never uses it |

The client secret is the secret's **Value** (about 40 characters, shown once when you create it), **not** its Secret ID (a GUID). Using the Secret ID is the most common setup mistake. The Poller then fails with "the request never reached Microsoft Graph".

The workflows reference these IDs, so import them rather than creating them by hand. On BZB-AI-1, n8n's stack is `/opt/n8n` and the repo is `/opt/bzb-ai/sarah`:

```bash
cp /opt/bzb-ai/sarah/n8n/credentials.template.json /root/sarah-creds.json && chmod 600 /root/sarah-creds.json
nano /root/sarah-creds.json                     # replace every FILL IN
cd /opt/n8n
docker compose cp /root/sarah-creds.json n8n:/tmp/sarah-creds.json
docker compose exec -u root n8n chown node:node /tmp/sarah-creds.json   # n8n runs as "node"; root-only files give EACCES
docker compose exec n8n n8n import:credentials --input=/tmp/sarah-creds.json
docker compose exec n8n rm /tmp/sarah-creds.json
shred -u /root/sarah-creds.json                 # it holds the secrets in plain text
```

n8n encrypts the credentials on import.

## 3. Workflows

```bash
cd /opt/n8n
docker compose cp /opt/bzb-ai/sarah/n8n/workflows n8n:/tmp/sarah-workflows
docker compose exec -u root n8n chown -R node:node /tmp/sarah-workflows
docker compose exec n8n n8n import:workflow --separate --input=/tmp/sarah-workflows
docker compose exec n8n sh -c 'for id in SarahErrors00001 SarahExecutor001 SarahPoller00001 SarahProcessor01 SarahReview00001 SarahTimers00001; do n8n publish:workflow --id=$id; done'
docker compose restart n8n            # the running instance picks up CLI publishes on restart
```

You should now see six workflows named **Sarah · …**, all published. The IDs are fixed (`SarahPoller00001` …), so the workflows find each other and their error workflow without any manual wiring. (The committed JSON is current; run `npm run build` only if you changed `src/`.)

**Re-importing after changes** (for example, after `git pull`): run the same commands. Import overwrites by ID; then re-publish and restart.

## 4. Check everything at once

```bash
sudo bash /opt/bzb-ai/sarah/scripts/check-setup.sh
```

It's read-only. It asks for the tenant ID, the mail app's client secret **Value** (hidden, never saved) and, optionally, the LiteLLM key. It then prints PASS / FAIL with a fix for each:

- **Microsoft:** the app gets a token, can read Sarah's inbox, and is blocked from other mailboxes.
- **Database:** migrations applied, no `FILL IN` left, the mode, the employees.
- **n8n:** version, network reach to `db` and `litellm`, all 6 workflows, LiteLLM key + model.
- **Portal:** container up, the broker isn't published, n8n reaches it, Funnel.

Run it after each setup step; anything not set up yet shows SKIP.

Don't test the workflows with **Execute step** in the editor. The Poller skips everything while the mode is `off`, and a manual run while the scheduled run holds its lock (`poller_lease_seconds`) also skips, and both look like "Node was not executed". To exercise the real path, switch to `dry_run` (nothing is sent; `docs/05-rollout.md` Stage 1) and watch **Executions**. A failed Graph call now names its cause in the error.

**LiteLLM `response_format`:** if the model's backend rejects `json_schema` (the processor's classification fails with a 400), set `llm_json_schema` to `false` (`docs/03-database.md`). The parser handles plain output, `<think>` blocks, and code fences either way.

## How calendar calls are routed

| Workflow | Node | When |
|---|---|---|
| Processor | **Delegated calendar?** → **Portal: calendar** (POST, broker key) | the thread's employee has `calendar_auth = 'delegated'` |
| Processor | **Delegated calendar?** → **Graph: calendar** (GET, app-only) | `calendar_auth = 'app'` (Vic until he connects) |
| Executor | **Via broker?** → **Portal: calendar call** (POST with body) | a hold, hold release or booking for a delegated employee |
| Executor | **With body?** → the app-only Graph nodes | all mail, and calendar work for `app` employees |

Every broker call is a POST with a JSON body, because n8n ignores expressions in *Send Body* (the reason the app-only path has separate body and no-body nodes). The broker returns Graph's status and body unchanged, so the executor classifies its answers exactly like Graph's. One addition: `409 NeedsReconnect` fails a hold or booking at once, with a specific reason. A hold release waits for the reconnect instead.

## Code nodes

Each Code node contains a generated bundle of `src/`, marked `bundled from src/ … edit src/, not this`, followed by a few lines of node logic. Edit `src/`, run `npm test && npm run build`, and re-import. Don't edit the bundle inside n8n: the next import overwrites it, and the tests don't cover it.
