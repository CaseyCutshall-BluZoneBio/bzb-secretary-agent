# 3 · n8n setup

Assumes n8n **2.x** in the `bzb-ai` compose stack on BZB-AI-1, the service named `n8n` below. The workflows were built and tested against **n8n 2.41.4** (see `docs/06-testing.md`).

## 1. Prerequisites

- **n8n must NOT be publicly reachable.** The review webhook is token-protected, but it belongs on the tailnet only. (The Funnel `:8443` exposure is closed; keep it that way.)
- n8n can reach Postgres, LiteLLM and the portal's token broker (`sarah-portal:3001`, `docs/09-portal.md`) by service name on the compose network.
- A LiteLLM virtual key named **Scheduling Agent**, so this agent's usage shows up on its own.

## 2. Credentials

```bash
cp n8n/credentials.template.json n8n/credentials.json    # credentials.json is gitignored
```

Fill in every `FILL IN` in `n8n/credentials.json`:

| Credential (fixed ID) | Fields |
|---|---|
| `SchedPostgres001` · Sarah · Postgres | host = Postgres service name, `sched_agent` / password |
| `SchedGraphApp001` · Sarah · Microsoft Graph | `accessTokenUrl` with your **tenant ID**, `clientId`, `clientSecret` (from `docs/02-m365-setup.md`). Grant type **Client Credentials**, scope `https://graph.microsoft.com/.default` |
| `SchedLiteLLM0001` · Sarah · LiteLLM key | `Bearer <Scheduling Agent virtual key>` |
| `SchedPortalKey01` · Sarah · Portal broker key | Header `X-Sarah-Broker-Key`, value = the portal's `PORTAL_BROKER_KEY`. Used only for calendar calls of employees on delegated access; mail never uses it |

The workflows reference these IDs, so import them rather than creating them by hand:

```bash
docker compose cp n8n/credentials.json n8n:/tmp/sarah-creds.json
docker compose exec n8n n8n import:credentials --input=/tmp/sarah-creds.json
docker compose exec n8n rm /tmp/sarah-creds.json
shred -u n8n/credentials.json      # it holds the secret in plain text
```

n8n encrypts the credentials on import.

## 3. Workflows

```bash
npm install && npm run build          # only if you changed src/; the committed JSON is current
docker compose cp n8n/workflows n8n:/tmp/sarah-workflows
docker compose exec n8n n8n import:workflow --separate --input=/tmp/sarah-workflows
docker compose exec n8n sh -c 'for id in SarahErrors00001 SarahExecutor001 SarahPoller00001 SarahProcessor01 SarahReview00001 SarahTimers00001; do n8n publish:workflow --id=$id; done'
docker compose restart n8n            # the running instance picks up CLI publishes on restart
```

You should now see six workflows named **Sarah · …**, all published. The IDs are fixed (`SarahPoller00001` …), so the workflows find each other and their error workflow without any manual wiring.

**Re-importing after changes** (for example, after editing a prompt): run the same three commands. Import overwrites by ID; then re-publish and restart.

## 4. Smoke checks (mode is still `off`)

1. **Executions list:** Poller and Executor run every minute and finish in milliseconds. In `off` they do nothing.
2. **Graph credential:** open **Sarah · Poller**, then **Graph: inbox delta** → *Execute step*. Expect `statusCode: 200`.
   - `401`: the tenant ID or secret is wrong.
   - `403 ErrorAccessDenied`: the RBAC scope hasn't applied yet, or `$SpObjectId` was the wrong GUID.
3. **LiteLLM:** from the n8n container,
   ```bash
   curl -s $LITELLM_URL -H "Authorization: Bearer <key>" -H 'Content-Type: application/json' \
     -d '{"model":"<alias>","messages":[{"role":"user","content":"Say {\"ok\":true} as JSON"}],"response_format":{"type":"json_schema","json_schema":{"name":"t","schema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false},"strict":true}}}'
   ```
   If this errors on `response_format`, set `llm_json_schema` to `false` (`docs/03-database.md`). The parser handles plain output, `<think>` blocks, and code fences either way.
4. **Error workflow:** Settings → *Error workflow* on each Sarah workflow is **Sarah · Errors**. It's set in the JSON; this just confirms it.
5. **Broker:** from the n8n container, `wget -qO- http://sarah-portal:3001/internal/v1/health` → `{"ok":true}`.

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
