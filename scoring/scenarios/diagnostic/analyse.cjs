// Diagnostic: for every (suite, bug) pair caught by nothing, was the mutated line run by a TC or an SC test on the
// correct version (backend V8 coverage per origin), and which variation points cite that code (selected, reserve or cut)?
// Usage: node scoring/scenarios/diagnostic/analyse.cjs > scoring/scenarios/diagnostic/cases.json
const fs = require('fs');
const det = JSON.parse(fs.readFileSync('scoring/scenarios/out/detection.json', 'utf8'));
const scn = { S1: 'mern-ecommerce-20261030-125711-diff-scn', S2: 'mern-ecommerce-20261030-211147-diff-scn', S3: 'mern-ecommerce-20261031-201456-diff-scn', Kutt: 'kutt-20261029-175214-diff-scn' };
const target = (s) => (s === 'Kutt' ? 'kutt' : 'mern-ecommerce');
const variants = (t) => JSON.parse(fs.readFileSync(`targets/${t}/sealed-2/variants.json`, 'utf8')).variants;
const cov = (s, o) => JSON.parse(fs.readFileSync(`scoring/scenarios/diagnostic/coverage/${s}-${o}.json`, 'utf8'));
const out = [];
for (const d of det.detections.filter((x) => !x.withScenarios)) {
  const v = variants(target(d.suite)).find((x) => x.id === d.bug);
  const [a, b] = v.lines;
  const ran = (o) => {
    const c = cov(d.suite, o);
    if (!(v.file in c.files)) return { measured: false, ran: false };
    const lines = c.files[v.file];
    return { measured: true, ran: lines.some((l) => l >= a && l <= b), fileLinesRun: lines.length };
  };
  const vp = JSON.parse(fs.readFileSync(`runs/${scn[d.suite]}/scenarios/variation-points.json`, 'utf8'));
  const status = (id) => (vp.selected.includes(id) ? 'selected' : vp.reserve.includes(id) ? 'reserve' : 'cut');
  const citing = vp.points
    .filter((p) => p.citation && p.citation.file === v.file && p.citation.lines[0] <= b && p.citation.lines[1] >= a)
    .map((p) => ({ id: p.id, kind: p.kind, status: status(p.id), lines: p.citation.lines, endpoint: p.endpoint ?? null, description: p.description.slice(0, 160) }));
  out.push({ suite: d.suite, bug: d.bug, file: v.file, lines: v.lines, tc: ran('tc'), sc: ran('sc'), citing });
}
console.log(JSON.stringify(out, null, 1));
