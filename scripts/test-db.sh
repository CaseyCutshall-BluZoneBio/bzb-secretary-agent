#!/usr/bin/env bash
# Apply the schema to a throwaway database and run db/tests/*.sql.
# Usage: PGHOST=... PGPORT=... PGUSER=... bash scripts/test-db.sh
# Needs a role that can CREATE DATABASE. Drops and recreates sched_agent_test.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=sched_agent_test
psql -v ON_ERROR_STOP=1 -q -d postgres -c "DROP DATABASE IF EXISTS $DB;"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "CREATE DATABASE $DB;"
for f in db/001_schema.sql db/002_functions.sql db/003_seed.sql; do
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"
done
fail=0
for t in db/tests/*.sql; do
  out=$(psql -v ON_ERROR_STOP=1 -q -t -A -d "$DB" -f "$t" 2>&1 | grep -E '^(PASS|FAIL|psql:|ERROR)' || true)
  echo "$out"
  if echo "$out" | grep -qE '^(FAIL|psql:|ERROR)'; then fail=1; fi
done
[ $fail -eq 0 ] && echo "ALL DB TESTS PASSED" || { echo "DB TESTS FAILED"; exit 1; }
