// Copies the MongoDB database FROM_DB into TO_DB for the lifecycle's data snapshot (target.config.json
// lifecycle.snapshot): after the seed, the test database is copied into a snapshot database once; a restore copies
// it back. Collections of TO_DB that FROM_DB lacks are emptied; the others are replaced with $out, which keeps the
// target collection's indexes, so a running backend keeps the indexes it created at start. FROM_DB's indexes are
// then ensured on TO_DB. Run with mongosh: FROM_DB=a TO_DB=b mongosh <uri> --quiet --file db-snapshot.js
const fromName = process.env.FROM_DB;
const toName = process.env.TO_DB;
if (!fromName || !toName) throw new Error('FROM_DB and TO_DB must be set');
const from = db.getSiblingDB(fromName);
const to = db.getSiblingDB(toName);
const names = from.getCollectionNames();
for (const name of to.getCollectionNames()) {
  if (!names.includes(name)) to.getCollection(name).deleteMany({});
}
for (const name of names) {
  from.getCollection(name).aggregate([{ $match: {} }, { $out: { db: toName, coll: name } }]);
  const indexes = from
    .getCollection(name)
    .getIndexes()
    .filter((i) => i.name !== '_id_')
    .map(({ v, ns, ...spec }) => spec);
  if (indexes.length > 0) to.runCommand({ createIndexes: name, indexes });
}
