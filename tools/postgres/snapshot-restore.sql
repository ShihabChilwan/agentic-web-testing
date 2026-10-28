-- Run by snapshot.sh restore, after "SET awt.schemas = '<comma separated schemas>'".
BEGIN;
SET LOCAL session_replication_role = replica; -- needs a superuser: foreign keys do not decide the order
DO $$
DECLARE
  t record;
  s record;
  everything text;
  cols text;
BEGIN
  IF to_regclass('awt_snapshot.tables') IS NULL THEN
    RAISE EXCEPTION 'there is no saved snapshot (run snapshot.sh save first)';
  END IF;
  -- All tables in one statement, so that foreign keys between them do not stop the truncate.
  SELECT string_agg(format('%I.%I', table_schema, table_name), ', ') INTO everything
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE' AND table_schema = ANY (string_to_array(current_setting('awt.schemas'), ','));
  IF everything IS NOT NULL THEN
    EXECUTE 'TRUNCATE ' || everything;
  END IF;
  FOR t IN SELECT * FROM awt_snapshot.tables ORDER BY id LOOP
    CONTINUE WHEN to_regclass(format('%I.%I', t.schema_name, t.table_name)) IS NULL;
    -- Columns of the live table that can be written (a generated column fills itself) and that the snapshot has.
    SELECT string_agg(quote_ident(l.column_name), ', ' ORDER BY l.ordinal_position) INTO cols
    FROM information_schema.columns l
    JOIN information_schema.columns k ON k.table_schema = 'awt_snapshot' AND k.table_name = 't' || t.id AND k.column_name = l.column_name
    WHERE l.table_schema = t.schema_name AND l.table_name = t.table_name AND l.is_generated = 'NEVER';
    EXECUTE format('INSERT INTO %I.%I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM awt_snapshot.%I', t.schema_name, t.table_name, cols, cols, 't' || t.id);
  END LOOP;
  FOR s IN SELECT * FROM awt_snapshot.sequences LOOP
    CONTINUE WHEN to_regclass(format('%I.%I', s.schema_name, s.sequence_name)) IS NULL;
    PERFORM setval(format('%I.%I', s.schema_name, s.sequence_name)::regclass, s.last_value, s.is_called);
  END LOOP;
END $$;
COMMIT;
