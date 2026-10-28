#!/usr/bin/env bash
# Saves the seeded data of a PostgreSQL database once and puts it back in place (lifecycle.snapshot for any app that
# uses PostgreSQL):
#   snapshot.sh save     copies every table of the schemas in AWT_PG_SCHEMAS (default "public") and the position
#                        of every sequence into the schema awt_snapshot of the same database
#   snapshot.sh restore  in one transaction empties those tables and copies the rows back, then moves the sequences
#                        back; the app keeps its connections, the schema and the migration tables stay as they are
# Connection settings: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE. The user must be a superuser: the restore
# switches session_replication_role to replica so that foreign keys do not decide the order of the tables.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:-}"
case "$mode" in
  save | restore) ;;
  *) echo "usage: snapshot.sh save|restore" >&2; exit 2 ;;
esac
: "${PGDATABASE:?PGDATABASE is not set}"
schemas="${AWT_PG_SCHEMAS:-public}"
{
  printf "SET awt.schemas = '%s';\n" "${schemas//\'/\'\'}"
  cat "$here/snapshot-$mode.sql"
} | psql -X -q -v ON_ERROR_STOP=1
echo "Snapshot ${mode}: ${PGDATABASE} (${schemas})"
