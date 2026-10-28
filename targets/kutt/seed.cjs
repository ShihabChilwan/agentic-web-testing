// Seed data for the lifecycle's seedCommand (target.config.json lifecycle.seedCommand): runs in the repo root right
// after `npm run migrate` and writes users, links and visits straight into the SQLite file, so the data is identical
// after every reset: fixed ids, uuids, addresses and dates, and fixed password salts (no clock, no randomness).
// Kutt validates what the API accepts (a link may not point at its own domain, passwords of 8-64 characters), which
// a seed through the API would have to respect; writing the rows directly does not.
const path = require('node:path');
const { createRequire } = require('node:module');

const requireFromRepo = createRequire(path.join(process.cwd(), 'package.json'));
const Database = requireFromRepo('better-sqlite3');
const bcrypt = requireFromRepo('bcryptjs');

const FILE = process.env.DB_FILENAME || 'db/data';
const CREATED = '2026-01-15 09:00:00';

// Must match the fixtures of target.config.json. The salts are fixed so a hash is the same on every seed.
const hash = (password, salt) => bcrypt.hashSync(password, `$2a$10$${salt}`);
const USERS = [
  { id: 1, email: 'admin@kutt.test', password: 'Admin-pass-123', salt: 'adminadminadminadmin..', role: 'ADMIN', apikey: 'adminadminadminadminadminadminadminadm01' },
  { id: 2, email: 'alice@kutt.test', password: 'Alice-pass-123', salt: 'alicealicealicealice..', role: 'USER', apikey: 'alicealicealicealicealicealicealiceali02' },
  { id: 3, email: 'bob@kutt.test', password: 'Bob-pass-12345', salt: 'bobbobbobbobbobbobbob.', role: 'USER', apikey: null },
];

const FAR_FUTURE = '2099-01-01 00:00:00'; // the form the app itself writes (UTC text), not milliseconds
const LINKS = [
  { id: 1, uuid: '11111111-1111-4111-8111-111111111111', address: 'alice1', target: 'https://example.com/alpha', user_id: 2, visit_count: 7 },
  { id: 2, uuid: '22222222-2222-4222-8222-222222222222', address: 'alice2', target: 'https://example.com/beta', user_id: 2, description: 'Beta page', visit_count: 3 },
  { id: 3, uuid: '33333333-3333-4333-8333-333333333333', address: 'alice3', target: 'https://example.com/secret', user_id: 2, password: hash('link-pass-123', 'linklinklinklinklink..') },
  { id: 4, uuid: '44444444-4444-4444-8444-444444444444', address: 'soon00', target: 'https://example.com/expiring', user_id: 2, expire_in: FAR_FUTURE },
  { id: 5, uuid: '55555555-5555-4555-8555-555555555555', address: 'bob001', target: 'https://example.org/bob', user_id: 3 },
  { id: 6, uuid: '66666666-6666-4666-8666-666666666666', address: 'adm001', target: 'https://example.net/admin', user_id: 1 },
  { id: 7, uuid: '77777777-7777-4777-8777-777777777777', address: 'banned', target: 'https://example.com/banned', user_id: 3, banned: 1, banned_by_id: 1 },
];

// Visits are counted per link and day-like bucket: totals by browser and system, countries and referrers as JSON.
const VISITS = [
  { link_id: 1, user_id: 2, created_at: '2026-01-20 10:00:00', total: 5, br_chrome: 3, br_firefox: 2, os_linux: 3, os_windows: 2, countries: { US: 3, DE: 2 }, referrers: { 'google.com': 2, Direct: 3 } },
  { link_id: 1, user_id: 2, created_at: '2026-01-21 10:00:00', total: 2, br_safari: 2, os_macos: 2, countries: { US: 2 }, referrers: { Direct: 2 } },
  { link_id: 2, user_id: 2, created_at: '2026-01-21 12:00:00', total: 3, br_chrome: 3, os_linux: 3, countries: { FR: 3 }, referrers: { 'news.example.org': 3 } },
];

function insert(db, table, rows) {
  for (const row of rows) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
  }
}

const db = new Database(FILE);
try {
  db.transaction(() => {
    insert(db, 'users', USERS.map(({ id, email, password, salt, role, apikey }) => ({ id, email, password: hash(password, salt), role, apikey, verified: 1, created_at: CREATED, updated_at: CREATED })));
    insert(db, 'links', LINKS.map((l) => ({ visit_count: 0, banned: 0, ...l, created_at: CREATED, updated_at: CREATED })));
    insert(db, 'visits', VISITS.map(({ countries, referrers, ...v }) => ({ ...v, countries: JSON.stringify(countries), referrers: JSON.stringify(referrers), updated_at: v.created_at })));
  })();
  console.log(`Seeded ${USERS.length} users, ${LINKS.length} links and ${VISITS.length} visits into ${FILE}`);
} finally {
  db.close();
}
