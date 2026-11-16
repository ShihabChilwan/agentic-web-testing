// Crash check over the four correct-version runs of one imported suite: crashes in the backend log by kind, incidents,
// and for the tests that hit the two crash routes, whether their recorded responses (method, path, status) are identical.
const fs = require('fs'), path = require('path');
const run = process.argv[2];
const m = JSON.parse(fs.readFileSync(`runs/${run}/eval/mapping.json`, 'utf8'));
const g = ['golden', 'golden-2', 'golden-3', 'golden-4'].map((v) => [v, m.versions.find((x) => x.version === v).execId]);
const norm = (p) => p.replace(/[0-9a-f]{24}/g, '<id>');
const triggers = new Set(); const per = {};
for (const [v, x] of g) {
  const dir = `runs/${run}/executions/${x}`;
  const log = fs.readFileSync(`${dir}/server/backend.log`, 'utf8');
  const res = JSON.parse(fs.readFileSync(`${dir}/results.json`, 'utf8'));
  const R = fs.readFileSync(`${dir}/responses.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
  for (const r of R) if (r.source === 'api' && (/^\/api\/category\/[^/]+\/active$/.test(r.path) || (/^\/api\/address\/[0-9a-f]{24}$/.test(r.path) && r.method === 'GET' && r.status === 404))) triggers.add(r.testCaseId);
  per[v] = { x, bulk: (log.match(/MongoError: Invalid Operation, no operations specified/g) || []).length, headers: (log.match(/Error \[ERR_HTTP_HEADERS_SENT\]/g) || []).length,
    exits: (log.match(/^Node\.js v/gm) || []).length, incidents: (res.incidents || []).map((i) => `${i.kind} before ${i.beforeTestCaseId}`), R, results: res.results };
}
console.log(`== ${run}`);
for (const [v] of g) { const p = per[v]; console.log(`${v} ${p.x}: exits ${p.exits} (empty bulkWrite ${p.bulk}, headers-sent ${p.headers}); incidents: ${p.incidents.join(', ') || 'none'}`); }
for (const t of [...triggers].sort()) {
  const seqs = g.map(([v]) => per[v].R.filter((r) => r.testCaseId === t && r.source === 'api').map((r) => `${r.method} ${norm(r.path)} ${r.status}`).join(' | '));
  const st = g.map(([v]) => per[v].results.find((r) => r.testCaseId === t)?.status ?? 'not run');
  console.log(`${t}: responses ${new Set(seqs).size === 1 ? 'identical in all 4' : 'DIFFER'}; status ${[...new Set(st)].join('/')}; ${seqs[0].slice(0, 230)}`);
  if (new Set(seqs).size > 1) seqs.forEach((s, i) => console.log(`   ${g[i][0]}: ${s.slice(0, 230)}`));
}
