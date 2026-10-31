#!/usr/bin/env bash
# Runs the Orb.IT migrations and security/workflow tests against a throwaway
# local PostgreSQL 16 cluster. Usage: supabase/tests/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-55432}"
RUN_AS=""
if [ "$(id -u)" = "0" ]; then RUN_AS="runuser -u postgres --"; chown postgres "$WORK"; fi

cleanup() { $RUN_AS "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

$RUN_AS "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
$RUN_AS "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" start >/dev/null

PSQL=(psql -h "$WORK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -c "create database orbit_test" postgres
"${PSQL[@]}" -f "$HERE/stub_supabase.sql" orbit_test
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "migrate: $(basename "$f")"
  "${PSQL[@]}" -f "$f" orbit_test
done
echo "test: security_and_workflow.sql"
"${PSQL[@]}" -f "$HERE/security_and_workflow.sql" orbit_test
echo "ALL DATABASE TESTS PASSED"
