#!/usr/bin/env bash
# End-to-end test: the real generated workflows running in a real n8n, against
# a mock Microsoft Graph + mock LiteLLM (test/e2e/mock-server.js) and a real
# Postgres. See docs/06-testing.md.
#
# Needs:
#   N8N_BIN   path to n8n's bin/n8n (n8n >= 2.x, run with Node >= 24)
#   PG*       env for a Postgres superuser (PGHOST, PGPORT, PGUSER); a role
#             sched_agent must exist and be able to log in without a password
#             from this host (trust/peer), or set SCHED_PGPASSWORD.
# Uses ports 5678 (n8n), 5679 (task broker) and 8787 (mock).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
: "${N8N_BIN:?set N8N_BIN to the path of bin/n8n}"
WORK=${E2E_WORK:-/tmp/sarah-e2e}
DB=sched_e2e
PGH=${PGHOST:-127.0.0.1}; PGP=${PGPORT:-5432}

rm -rf "$WORK"; mkdir -p "$WORK/n8n" "$WORK/wf"

echo "== database"
psql -q -h "$PGH" -p "$PGP" -d postgres -c "DROP DATABASE IF EXISTS $DB;"
psql -q -h "$PGH" -p "$PGP" -d postgres -c "CREATE DATABASE $DB OWNER sched_agent;"
for f in db/001_schema.sql db/002_functions.sql db/003_seed.sql; do
  PGPASSWORD=${SCHED_PGPASSWORD:-} psql -q -v ON_ERROR_STOP=1 -h "$PGH" -p "$PGP" -U sched_agent -d $DB -f "$f"
done

echo "== n8n credentials + workflows (schedules shortened for testing)"
node - "$WORK" "$PGH" "$PGP" <<'EOF'
const fs = require('fs'); const [work, host, port] = process.argv.slice(2);
const c = require(process.cwd() + '/n8n/credentials.template.json');
Object.assign(c[0].data, { host, port: Number(port), database: 'sched_e2e', password: process.env.SCHED_PGPASSWORD || 'x' });
Object.assign(c[1].data, { accessTokenUrl: 'http://127.0.0.1:8787/token', clientId: 'cid', clientSecret: 'csecret' });
c[2].data.value = 'Bearer sk-mock';
fs.writeFileSync(`${work}/creds.json`, JSON.stringify(c));
const fast = { poller: 8, executor: 5, timers: 20 };
for (const f of fs.readdirSync('n8n/workflows')) {
  const wf = JSON.parse(fs.readFileSync(`n8n/workflows/${f}`, 'utf8'));
  const key = f.replace('.json', '');
  for (const n of wf.nodes) {
    if (n.type === 'n8n-nodes-base.scheduleTrigger' && fast[key]) {
      n.parameters.rule = { interval: [{ field: 'seconds', secondsInterval: fast[key] }] };
    }
  }
  fs.writeFileSync(`${work}/wf/${f}`, JSON.stringify(wf));
}
EOF

export N8N_USER_FOLDER="$WORK/n8n" N8N_ENCRYPTION_KEY=sarah-e2e-key N8N_DIAGNOSTICS_ENABLED=false \
       N8N_PORT=5678 N8N_LISTEN_ADDRESS=127.0.0.1 N8N_PERSONALIZATION_ENABLED=false \
       N8N_RUNNERS_TASK_TIMEOUT=300 NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
node "$N8N_BIN" import:credentials --input="$WORK/creds.json" >/dev/null
node "$N8N_BIN" import:workflow --separate --input="$WORK/wf" >/dev/null
for id in SarahErrors00001 SarahExecutor001 SarahPoller00001 SarahProcessor01 SarahReview00001 SarahTimers00001; do
  node "$N8N_BIN" publish:workflow --id=$id >/dev/null
done

echo "== starting n8n"
node "$N8N_BIN" start > "$WORK/n8n.log" 2>&1 &
N8N_PID=$!
trap 'kill $N8N_PID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  curl --noproxy '*' -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:5678/healthz | grep -q 200 && break
  sleep 2
done

echo "== scenarios"
E2E_PGHOST=$PGH E2E_PGPORT=$PGP node --test --test-concurrency=1 test/e2e/scenarios.test.js
