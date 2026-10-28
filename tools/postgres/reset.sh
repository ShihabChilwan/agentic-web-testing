#!/usr/bin/env bash
# Drops and recreates the target app's PostgreSQL database (lifecycle.reset for any app that uses PostgreSQL).
# Connection settings come from the standard variables: PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE (the
# database to recreate). Connected clients are disconnected, so a running backend cannot block the drop.
set -euo pipefail
: "${PGDATABASE:?PGDATABASE (the database to recreate) is not set}"
target="$PGDATABASE"
psql -X -q -v ON_ERROR_STOP=1 -v db="$target" -d postgres <<'SQL'
DROP DATABASE IF EXISTS :"db" WITH (FORCE);
CREATE DATABASE :"db";
SQL
echo "Recreated database ${target}"
