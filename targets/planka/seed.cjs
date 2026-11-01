// Seeds the fixture users and a small set of projects through the app's own HTTP API, so every row is valid by
// construction. Run after the database exists and is migrated (`node db/init.js` creates the default admin), from
// the repo's `server` folder: it lifts a private copy of the backend on another port, seeds, and stops it again.
// The values are fixed (no clock, no randomness); only the database ids differ between fresh seeds.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const PORT = 1338;
const BASE = `http://127.0.0.1:${PORT}`;

const USERS = {
  admin: { email: 'admin@planka.test', password: 'Admin-pass-123' },
  alice: { email: 'alice@planka.test', password: 'Alice-pass-123', username: 'alice', name: 'Alice Test', role: 'projectOwner' },
  bob: { email: 'bob@planka.test', password: 'Bob-pass-12345', username: 'bob', name: 'Bob Test', role: 'boardUser' },
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json };
}

async function ok(method, path, options) {
  const res = await call(method, path, options);
  if (res.status < 200 || res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

// A login of a user who has not accepted the terms answers 403 with a pending token; accepting needs the hash of the
// terms text the server shows.
async function login(user) {
  const first = await call('POST', '/api/access-tokens', { body: { emailOrUsername: user.email, password: user.password } });
  if (first.status === 200) return first.json.item;
  if (first.status !== 403 || !first.json.pendingToken) throw new Error(`login of ${user.email} -> ${first.status} ${JSON.stringify(first.json)}`);
  const terms = await ok('GET', '/api/terms');
  const signature = crypto.createHash('sha256').update(terms.item.content).digest('hex');
  const accepted = await ok('POST', '/api/access-tokens/accept-terms', { body: { pendingToken: first.json.pendingToken, signature } });
  return accepted.item;
}

async function waitForServer(child) {
  for (let i = 0; i < 300; i += 1) {
    if (child.exitCode !== null) throw new Error(`the private backend exited with code ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/bootstrap`);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the private backend did not answer in 60 s');
}

async function seed() {
  const adminToken = await login(USERS.admin);
  const ids = {};
  for (const key of ['alice', 'bob']) {
    const u = USERS[key];
    const created = await ok('POST', '/api/users', {
      token: adminToken,
      body: { email: u.email, password: u.password, role: u.role, name: u.name, username: u.username },
    });
    ids[key] = created.item.id;
    await login(u);
  }
  const aliceToken = await login(USERS.alice);

  const project = (await ok('POST', '/api/projects', { token: aliceToken, body: { type: 'shared', name: 'Website Redesign', description: 'Relaunch of the company website' } })).item;
  const board = (await ok('POST', `/api/projects/${project.id}/boards`, { token: aliceToken, body: { position: 65536, name: 'Sprint 1' } })).item;
  await ok('POST', `/api/boards/${board.id}/board-memberships`, { token: aliceToken, body: { userId: ids.bob, role: 'editor' } });

  const labels = {};
  const labelSpecs = [['Bug', 'berry-red'], ['Feature', 'fresh-salad']];
  for (const [i, [name, color]] of labelSpecs.entries()) {
    labels[name] = (await ok('POST', `/api/boards/${board.id}/labels`, { token: aliceToken, body: { position: 65536 * (i + 1), name, color } })).item.id;
  }

  const lists = {};
  for (const [i, name] of ['Backlog', 'In Progress', 'Done'].entries()) {
    lists[name] = (await ok('POST', `/api/boards/${board.id}/lists`, { token: aliceToken, body: { type: 'active', position: 65536 * (i + 1), name } })).item.id;
  }

  const card = async (list, position, name, description) =>
    (await ok('POST', `/api/lists/${lists[list]}/cards`, { token: aliceToken, body: { type: 'project', position, name, ...(description ? { description } : {}) } })).item;

  const design = await card('Backlog', 65536, 'Design homepage', 'Create the new homepage layout.');
  await card('Backlog', 131072, 'Write copy');
  const loginPage = await card('In Progress', 65536, 'Build login page', 'Email and password form with validation.');
  await card('Done', 65536, 'Release v1');

  await ok('POST', `/api/cards/${design.id}/card-labels`, { token: aliceToken, body: { labelId: labels.Feature } });
  await ok('POST', `/api/cards/${design.id}/card-memberships`, { token: aliceToken, body: { userId: ids.alice } });
  await ok('POST', `/api/cards/${loginPage.id}/card-labels`, { token: aliceToken, body: { labelId: labels.Bug } });
  await ok('POST', `/api/cards/${loginPage.id}/card-memberships`, { token: aliceToken, body: { userId: ids.bob } });
  await ok('POST', `/api/cards/${design.id}/comments`, { token: aliceToken, body: { text: 'Looks good, starting now.' } });
  const taskList = (await ok('POST', `/api/cards/${design.id}/task-lists`, { token: aliceToken, body: { position: 65536, name: 'Checklist' } })).item;
  await ok('POST', `/api/task-lists/${taskList.id}/tasks`, { token: aliceToken, body: { position: 65536, name: 'Wireframe', isCompleted: true } });
  await ok('POST', `/api/task-lists/${taskList.id}/tasks`, { token: aliceToken, body: { position: 131072, name: 'Mockup' } });

  // A project the member users have no access to.
  const hidden = (await ok('POST', '/api/projects', { token: adminToken, body: { type: 'private', name: 'Admin Only', description: 'Not shared with the fixture members' } })).item;
  const hiddenBoard = (await ok('POST', `/api/projects/${hidden.id}/boards`, { token: adminToken, body: { position: 65536, name: 'Private Board' } })).item;
  const hiddenList = (await ok('POST', `/api/boards/${hiddenBoard.id}/lists`, { token: adminToken, body: { type: 'active', position: 65536, name: 'Ideas' } })).item;
  await ok('POST', `/api/lists/${hiddenList.id}/cards`, { token: adminToken, body: { type: 'project', position: 65536, name: 'Private idea' } });
}

async function main() {
  const child = spawn('node', ['app.js', `--port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keep = (chunk) => {
    tail = (tail + chunk).slice(-4000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  try {
    await waitForServer(child);
    await seed();
    console.log('planka seed: 3 users, 2 projects');
  } catch (error) {
    console.error(String(error.stack ?? error));
    console.error(tail);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
  }
}

main();
