// Saves the seeded SQLite data once and puts it back in place (target.config.json lifecycle.snapshot), so a restore is
// one short command instead of reset, migrate, seed and a backend restart.
//   node sqlite-snapshot.cjs save     copies the database file to <file>.snapshot (SQLite's online backup)
//   node sqlite-snapshot.cjs restore  in one transaction empties every table and copies the saved rows back
// The running app keeps its connections: the file, the schema and the migration table stay the same, only rows change.
// Run in the repo root with PATH and HOME only; the file is DB_FILENAME or Kutt's default db/data.
const path = require('node:path');
const { createRequire } = require('node:module');

const Database = createRequire(path.join(process.cwd(), 'package.json'))('better-sqlite3');
const FILE = process.env.DB_FILENAME || 'db/data';
const SNAPSHOT = `${FILE}.snapshot`;

async function save() {
  const db = new Database(FILE, { fileMustExist: true });
  try {
    await db.backup(SNAPSHOT);
  } finally {
    db.close();
  }
  console.log(`Saved ${FILE} to ${SNAPSHOT}`);
}

function restore() {
  const db = new Database(FILE, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 10000');
    db.pragma('foreign_keys = OFF'); // rows come back as they were; the order of tables must not matter
    db.prepare('ATTACH DATABASE ? AS snap').run(path.resolve(SNAPSHOT));
    const tables = (schema) =>
      db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
    const saved = new Set(tables('snap'));
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const name of tables('main')) {
        db.exec(`DELETE FROM main."${name}"`);
        if (saved.has(name)) db.exec(`INSERT INTO main."${name}" SELECT * FROM snap."${name}"`);
      }
      // AUTOINCREMENT counters, so new rows get the same ids as after a fresh seed.
      db.exec('DELETE FROM main.sqlite_sequence');
      db.exec('INSERT INTO main.sqlite_sequence SELECT * FROM snap.sqlite_sequence');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    db.exec('DETACH DATABASE snap');
  } finally {
    db.close();
  }
}

const command = process.argv[2];
if (command === 'save') save().catch((err) => { console.error(err); process.exit(1); });
else if (command === 'restore') {
  try {
    restore();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
} else {
  console.error('usage: node sqlite-snapshot.cjs save|restore');
  process.exit(2);
}
