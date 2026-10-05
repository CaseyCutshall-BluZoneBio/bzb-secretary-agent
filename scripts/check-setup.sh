#!/usr/bin/env bash
# One-shot setup check for Sarah on BZB-AI-1. Read-only: it changes nothing.
#
#   sudo bash /opt/bzb-ai/sarah/scripts/check-setup.sh
#
# It asks for the tenant ID and the Graph app's client secret VALUE (never
# shown, never saved), and optionally the LiteLLM virtual key, then prints one
# PASS / FAIL / SKIP line per check, with what to do about each FAIL.
#
# Paths (override with env vars if yours differ):
BZB_DIR=${BZB_DIR:-/opt/bzb-ai/compose}   # compose stack with `db` (and the portal)
N8N_DIR=${N8N_DIR:-/opt/n8n}              # n8n's compose stack
APP_ID=${APP_ID:-78410cc1-8884-4ea6-9a56-bb03d7c003c3}   # BZB Secretary Agent (mail app)
SARAH=${SARAH:-sarah.johnson@bluzonebio.com}
OTHER=${OTHER:-vic.suarez@bluzonebio.com}  # any other mailbox: must be OUT of the app's reach
PORTAL_PORT=${PORTAL_PORT:-10000}
set -u

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n        → %s\n' "$1" "$2"; fail=$((fail+1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s (%s)\n' "$1" "$2"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
sql()  { (cd "$BZB_DIR" && docker compose exec -T db psql -U sched_agent -d sched_agent -tAc "$1" 2>/dev/null); }
n8n_node() { (cd "$N8N_DIR" && docker compose exec -T n8n node -e "$1" 2>/dev/null); }

echo "Sarah setup check: nothing is changed by this script."
echo
read -r  -p "Tenant ID (Entra → Overview): " TENANT
read -rs -p "BZB Secretary Agent client secret VALUE (hidden): " SECRET; echo
read -rs -p "LiteLLM virtual key sk-… (hidden; Enter to skip): " LLMKEY; echo
echo

# --- 1. Microsoft: mail app -------------------------------------------------
echo "1. Microsoft Graph (the mail app)"
TOKEN=""
if [ "${#SECRET}" -eq 36 ] && [[ "$SECRET" =~ ^[0-9a-f-]{36}$ ]]; then
  bad "client secret" "that looks like the Secret ID (a GUID). Use the secret's Value (about 40 characters, shown once when created)."
else
  tok=$(curl -s -m 20 -X POST "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" \
        -d "client_id=$APP_ID" -d grant_type=client_credentials \
        --data-urlencode "scope=https://graph.microsoft.com/.default" --data-urlencode "client_secret=$SECRET")
  TOKEN=$(printf '%s' "$tok" | json "d.get('access_token','')")
  if [ -n "$TOKEN" ]; then
    ok "app gets a token from Microsoft (tenant, client ID and secret are right)"
  else
    why=$(printf '%s' "$tok" | json "d.get('error_description','no answer')" | head -1 | cut -c1-160)
    case "$why" in
      *AADSTS7000215*) bad "token" "wrong client secret: use the secret's Value, not its ID. ($why)";;
      *AADSTS7000222*) bad "token" "the client secret has expired: create a new one. ($why)";;
      *AADSTS700016*)  bad "token" "app $APP_ID not found in this tenant: check the tenant ID and APP_ID. ($why)";;
      *AADSTS90002*|*AADSTS900023*) bad "token" "tenant ID is wrong. ($why)";;
      *) bad "token" "$why";;
    esac
  fi
fi
if [ -n "$TOKEN" ]; then
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
         "https://graph.microsoft.com/v1.0/users/$SARAH/mailFolders/inbox?\$select=displayName")
  case "$code" in
    200) ok "app can read Sarah's inbox ($SARAH)";;
    403) bad "Sarah's inbox: HTTP 403" "Exchange scoping not active for Graph yet (can take ~2 h after setup), or CustomAttribute10/role assignments missing (docs/02-m365-setup.md)";;
    404) bad "Sarah's inbox: HTTP 404" "no mailbox $SARAH (set SARAH=… if her address differs)";;
    *)   bad "Sarah's inbox: HTTP $code" "unexpected; check the app and mailbox";;
  esac
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
         "https://graph.microsoft.com/v1.0/users/$OTHER/mailFolders/inbox?\$select=displayName")
  if [ "$code" = "403" ]; then ok "app is blocked from other mailboxes ($OTHER → 403)"
  elif [ "$code" = "200" ]; then bad "app can read $OTHER" "STOP: the app reaches mailboxes it must not. Check Entra → the app → API permissions is EMPTY, and the Exchange scope (docs/02-m365-setup.md)"
  else skip "other-mailbox check" "HTTP $code for $OTHER"; fi
fi
unset SECRET TOKEN tok

# --- 2. Database ------------------------------------------------------------
echo "2. Sarah's database"
if [ -z "$(sql 'SELECT 1')" ]; then
  bad "connect to sched_agent" "is the db container running? (cd $BZB_DIR && docker compose ps db)"
else
  ok "database reachable"
  n=$(sql "SELECT count(*) FROM sched.schema_migrations WHERE version IN ('001_schema','002_functions','003_seed','004_portal')")
  [ "$n" = "4" ] && ok "all 4 migrations applied" || bad "migrations ($n of 4)" "apply db/0*.sql in order (docs/03-database.md)"
  left=$(sql "SELECT string_agg(key, ', ') FROM sched.settings WHERE value::text ILIKE '%FILL IN%'")
  [ -z "$left" ] && ok "no FILL IN left in settings" || bad "settings still FILL IN: $left" "UPDATE sched.settings … (docs/03-database.md)"
  echo "        mode = $(sql "SELECT sched.setting_text('mode')")"
  emp=$(sql "SELECT string_agg(upn || ' (' || calendar_auth || CASE WHEN calendar_connected_at IS NOT NULL THEN ', connected' ELSE '' END || ')', ', ') FROM sched.employees WHERE enrolled")
  echo "        employees = ${emp:-none}"
  case "$emp" in *"@bluzonebio.com"*) ;; *) bad "employees" "no enrolled employee";; esac
  case "$emp" in *"vic@bluzonebio.com"*) bad "Vic's address" "still the placeholder: UPDATE sched.employees SET upn = 'vic.suarez@bluzonebio.com' WHERE upn = 'vic@bluzonebio.com';";; esac
  link=$(sql "SELECT sched.setting_text('poller_delta_link') IS NOT NULL")
  mode=$(sql "SELECT sched.setting_text('mode')")
  if [ "$mode" = "off" ]; then skip "poller has read Sarah's inbox" "mode is off"
  elif [ "$link" = "t" ]; then ok "poller has read Sarah's inbox (delta cursor saved)"
  else bad "poller hasn't completed a run yet" "n8n → Executions → Sarah · Poller: open the newest red run; its error now says why"; fi
fi

# --- 3. n8n -----------------------------------------------------------------
echo "3. n8n"
ver=$(cd "$N8N_DIR" && docker compose exec -T n8n n8n --version 2>/dev/null | tail -1)
if [ -z "$ver" ]; then
  bad "n8n container" "not running, or N8N_DIR=$N8N_DIR is wrong"
else
  [[ "$ver" == 2.41.* ]] && ok "n8n $ver" || bad "n8n $ver" "tested on 2.41.4: set N8N_VERSION=2.41.4 in $N8N_DIR/.env, docker compose up -d n8n"
  res=$(n8n_node "for (const h of ['db','litellm','sarah-portal']) require('dns').lookup(h, (e) => console.log(h + '=' + (e ? 'no' : 'yes')))")
  [[ "$res" == *db=yes* ]] && ok "n8n reaches the database (db)" || bad "n8n can't resolve db" "add the bzb-ai_default network to n8n (docs/04-n8n-setup.md §1)"
  [[ "$res" == *litellm=yes* ]] && ok "n8n reaches LiteLLM (litellm)" || bad "n8n can't resolve litellm" "same network fix as above"
  cnt=$(cd "$N8N_DIR" && docker compose exec -T n8n n8n list:workflow 2>/dev/null | grep -c 'Sarah ·')
  [ "$cnt" = "6" ] && ok "6 Sarah workflows imported" || bad "Sarah workflows: $cnt of 6" "import + publish (docs/04-n8n-setup.md §3)"
  if [ -n "$LLMKEY" ]; then
    model=$(sql "SELECT sched.setting_text('llm_model')")
    out=$(n8n_node "fetch('http://litellm:4000/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer $LLMKEY'},body:JSON.stringify({model:'$model',max_tokens:5,messages:[{role:'user',content:'Say OK'}]})}).then(async r=>console.log(r.status,(await r.text()).slice(0,160)),e=>console.log('ERR',e.message))")
    case "$out" in
      200*) ok "LiteLLM answers with model $model and this key";;
      401*) bad "LiteLLM: key rejected" "create the 'Scheduling Agent' virtual key; the n8n credential value is 'Bearer sk-…'";;
      400*|404*) bad "LiteLLM: model '$model'" "llm_model must match the model's public name in LiteLLM. ($out)";;
      *) bad "LiteLLM" "$out";;
    esac
  else skip "LiteLLM key + model" "no key entered"; fi
fi
unset LLMKEY

# --- 4. Portal --------------------------------------------------------------
echo "4. Portal"
if ! (cd "$BZB_DIR" && docker compose ps --status running --services 2>/dev/null | grep -qx sarah-portal); then
  skip "portal" "sarah-portal isn't running yet (docs/09-portal.md §3)"
else
  ok "portal container running"
  c=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/login)
  [ "$c" = "200" ] && ok "portal UI answers on 127.0.0.1:3100" || bad "portal UI: HTTP $c" "docker compose logs sarah-portal | tail"
  pub=$(docker port sarah-portal 2>/dev/null)
  if echo "$pub" | grep -q '^3001/'; then
    bad "broker port 3001 is published on the host" "remove the 3001 line under ports: in compose.portal.yml; only 127.0.0.1:3100:3000 may be published"
  else ok "broker port 3001 not published (portal publishes: $(echo "$pub" | tr '\n' ' '))"; fi
  h=$(n8n_node "fetch('http://sarah-portal:3001/internal/v1/health').then(r=>r.text()).then(console.log,e=>console.log('ERR '+e.message))")
  [[ "$h" == *'"ok":true'* ]] && ok "n8n reaches the broker" || bad "n8n can't reach the broker" "n8n must be on bzb-ai_default; portal must be up ($h)"
fi
st=$(tailscale serve status 2>/dev/null)
if [ -z "$st" ]; then skip "Funnel" "tailscale serve status gave nothing"
else
  echo "$st" | grep -q ":$PORTAL_PORT" && ok "something is served on :$PORTAL_PORT" || skip "Funnel :$PORTAL_PORT" "not set up yet: sudo tailscale funnel --bg --https=$PORTAL_PORT http://127.0.0.1:3100"
  echo "$st" | sed 's/^/        /'
  echo "        (check: :$PORTAL_PORT Funnel on; :8443 (n8n) tailnet only, NOT Funnel)"
fi

echo
echo "Done: $pass passed, $fail failed."
[ "$fail" -eq 0 ]
