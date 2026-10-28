-- Run by snapshot.sh save, after "SET awt.schemas = '<comma separated schemas>'".
BEGIN;
DROP SCHEMA IF EXISTS awt_snapshot CASCADE;
CREATE SCHEMA awt_snapshot;
CREATE TABLE awt_snapshot.tables (id int PRIMARY KEY, schema_name text NOT NULL, table_name text NOT NULL);
CREATE TABLE awt_snapshot.sequences (schema_name text NOT NULL, sequence_name text NOT NULL, last_value bigint NOT NULL, is_called boolean NOT NULL);

DO $$
DECLARE
  t record;
  s record;
  n int := 0;
  v bigint;
  c boolean;
BEGIN
  FOR t IN
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_type = 'BASE TABLE' AND table_schema = ANY (string_to_array(current_setting('awt.schemas'), ','))
    ORDER BY table_schema, table_name
  LOOP
    n := n + 1;
    EXECUTE format('CREATE TABLE awt_snapshot.%I AS TABLE %I.%I', 't' || n, t.table_schema, t.table_name);
    INSERT INTO awt_snapshot.tables VALUES (n, t.table_schema, t.table_name);
  END LOOP;
  FOR s IN
    SELECT schemaname, sequencename FROM pg_sequences WHERE schemaname = ANY (string_to_array(current_setting('awt.schemas'), ','))
  LOOP
    EXECUTE format('SELECT last_value, is_called FROM %I.%I', s.schemaname, s.sequencename) INTO v, c;
    INSERT INTO awt_snapshot.sequences VALUES (s.schemaname, s.sequencename, v, c);
  END LOOP;
  IF n = 0 THEN
    RAISE EXCEPTION 'no tables found in schemas %', current_setting('awt.schemas');
  END IF;
END $$;
COMMIT;
