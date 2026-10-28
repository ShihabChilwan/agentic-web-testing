import { execFileSync, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../src/shared/paths.js';

// tools/postgres/*: the generic reset and snapshot for any app that uses PostgreSQL, against a scratch database on the
// compose service `db` (or PGHOST). Skipped when there is no psql or no server.

const host = process.env.PGHOST ?? 'db';
const connection = { ...process.env, PGHOST: host, PGUSER: process.env.PGUSER ?? 'app', PGPASSWORD: process.env.PGPASSWORD ?? 'app' };
const available = spawnSync('psql', ['-X', '-q', '-t', '-A', '-d', 'postgres', '-c', 'select 1'], { env: connection, encoding: 'utf8', timeout: 10_000 }).stdout?.trim() === '1';

const database = `awt_test_${process.pid}_${Date.now().toString(36)}`;
const env = { ...connection, PGDATABASE: database };
const tool = (script: string, ...args: string[]) => execFileSync('bash', [path.join(PROJECT_ROOT, 'tools/postgres', script), ...args], { env, encoding: 'utf8' });
const sql = (text: string, db = database) => execFileSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', text], { env, encoding: 'utf8' }).trim();

describe.skipIf(!available)('tools/postgres', () => {
  afterAll(() => {
    sql(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`, 'postgres');
  });

  it('reset creates the database, and drops it again with its data even while a client is connected', () => {
    tool('reset.sh');
    sql('CREATE TABLE marker (id int)');
    const holder = spawn('psql', ['-X', '-q', '-d', database, '-c', 'select pg_sleep(30)'], { env, stdio: 'ignore' }); // a client that stays connected
    try {
      execFileSync('sleep', ['0.5']);
      tool('reset.sh');
    } finally {
      holder.kill();
    }
    expect(sql("select count(*) from information_schema.tables where table_name = 'marker'")).toBe('0');
  });

  it('save and restore put back rows, sequences and identity counters across tables with foreign keys', () => {
    tool('reset.sh');
    sql(`
      CREATE TABLE owners (id serial PRIMARY KEY, name text NOT NULL);
      CREATE TABLE items (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_id int REFERENCES owners (id) ON DELETE CASCADE, label text, doubled int GENERATED ALWAYS AS (id * 2) STORED);
      CREATE SCHEMA other;
      CREATE TABLE other.notes (id serial PRIMARY KEY, body jsonb);
      INSERT INTO owners (name) VALUES ('a'), ('b');
      INSERT INTO items (owner_id, label) VALUES (1, 'x'), (2, 'y');
      INSERT INTO other.notes (body) VALUES ('{"k": 1}');
    `);
    const fingerprint = () => sql("select (select string_agg(name, ',' order by id) from owners) || '/' || (select string_agg(label || doubled, ',' order by id) from items)");
    const seeded = fingerprint();
    tool('snapshot.sh', 'save');

    sql("INSERT INTO owners (name) VALUES ('c'); INSERT INTO items (owner_id, label) VALUES (3, 'z'); UPDATE owners SET name = 'changed' WHERE id = 1; DELETE FROM items WHERE id = 1; INSERT INTO other.notes (body) VALUES ('{}')");
    expect(fingerprint()).not.toBe(seeded);
    tool('snapshot.sh', 'restore');

    expect(fingerprint()).toBe(seeded);
    expect(sql('select count(*) from other.notes')).toBe('2'); // only `public` is in the snapshot: the other schema is not touched
    expect(sql('INSERT INTO owners (name) VALUES (\'new\') RETURNING id')).toBe('3'); // the sequence is back at 2
    expect(sql("INSERT INTO items (owner_id, label) VALUES (1, 'n') RETURNING id")).toBe('3'); // so is the identity counter
  });

  it('covers the schemas named in AWT_PG_SCHEMAS', () => {
    tool('reset.sh');
    sql('CREATE SCHEMA app; CREATE TABLE app.t (id serial PRIMARY KEY, v text); INSERT INTO app.t (v) VALUES (\'one\')');
    const inApp = { ...env, AWT_PG_SCHEMAS: 'app' };
    const run = (mode: string) => execFileSync('bash', [path.join(PROJECT_ROOT, 'tools/postgres/snapshot.sh'), mode], { env: inApp, encoding: 'utf8' });
    run('save');
    sql("INSERT INTO app.t (v) VALUES ('two'); UPDATE app.t SET v = 'x'");
    run('restore');
    expect(sql("select string_agg(v, ',') from app.t")).toBe('one');
  });

  it('restore without a saved snapshot fails, so the lifecycle falls back to a full restore', () => {
    tool('reset.sh');
    sql('CREATE TABLE t (id int)');
    expect(() => tool('snapshot.sh', 'restore')).toThrow();
  });

  it('rejects an unknown mode', () => {
    expect(() => tool('snapshot.sh', 'bogus')).toThrow();
  });
});
