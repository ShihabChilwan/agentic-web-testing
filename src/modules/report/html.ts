import type { RunView } from '../../shared/schemas.js';

/**
 * The browser may load nothing from anywhere: inline styles and scripts, and data: images only
 * (SPEC §9.2). This is what guarantees "no external URL", not a search of the page.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const STYLE = `
:root { --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --panel: #f6f8fa; --accent: #0969da;
  --pass: #1a7f37; --fail: #cf222e; --err: #9a6700; --skip: #6e7781; --chg: #fff8c5; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d; --panel: #161b22;
  --accent: #4493f8; --pass: #3fb950; --fail: #f85149; --err: #d29922; --skip: #8d96a0; --chg: #3b2e00; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 16px 24px; border-bottom: 1px solid var(--line); }
header h1 { margin: 0 0 4px; font-size: 18px; }
.meta { color: var(--muted); font-size: 13px; }
nav { display: flex; gap: 4px; padding: 8px 24px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 1; }
nav button { border: 1px solid transparent; background: none; color: var(--fg); padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; }
nav button.on { border-color: var(--line); background: var(--panel); font-weight: 600; }
main { padding: 16px 24px 48px; max-width: 1400px; }
h2 { font-size: 16px; margin: 24px 0 8px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
tr.click { cursor: pointer; }
tr.click:hover td { background: var(--panel); }
tr.changed td { background: var(--chg); }
.tiles { display: flex; flex-wrap: wrap; gap: 8px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; min-width: 120px; background: var(--panel); }
.tile b { display: block; font-size: 20px; }
.tile span { color: var(--muted); font-size: 12px; }
.badge { display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 12px; border: 1px solid currentColor; margin: 0 4px 2px 0; white-space: nowrap; }
.passed { color: var(--pass); } .failed, .app_defect, .newly-failing { color: var(--fail); }
.errored, .assertion_failed, .environment_issue, .failure-changed { color: var(--err); }
.skipped, .invalid, .none, .inconclusive, .only-in-one { color: var(--skip); } .test_defect, .fixed { color: var(--accent); }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px; overflow: auto; max-height: 360px; white-space: pre-wrap; word-break: break-word; font-size: 12px; margin: 4px 0; }
.detail { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 4px 0 12px; }
.detail img { display: block; max-width: min(100%, 760px); margin: 8px 0; border: 1px solid var(--line); border-radius: 4px; }
.card { border-left: 3px solid var(--accent); padding: 4px 12px; margin: 8px 0; }
.ev { display: grid; grid-template-columns: 240px 1fr; gap: 4px 12px; }
input[type=search] { min-width: 320px; }
input[type=search], select { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
.muted { color: var(--muted); }
`;

/** Renders the view model; every value from the data is inserted as text (textContent), never as HTML. */
const SCRIPT = `
'use strict';
var V = JSON.parse(document.getElementById('run-view').textContent);
var main = document.getElementById('main');

function h(tag, props) {
  var el = document.createElement(tag);
  var p = props || {};
  Object.keys(p).forEach(function (k) {
    var v = p[k];
    if (v === null || v === undefined || v === false) return;
    if (k === 'class') el.className = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, String(v));
  });
  for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, c) {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
  el.append(c instanceof Node ? c : document.createTextNode(String(c)));
}
function fill(el) { el.replaceChildren(); for (var i = 1; i < arguments.length; i++) add(el, arguments[i]); }
function badge(text) { return h('span', { class: 'badge ' + text }, text); }
function secs(ms) { return ms === null || ms === undefined ? '' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(ms < 60000 ? 1 : 0) + ' s'; }
function money(c) { return c === null || c === undefined ? '' : '$' + c.toFixed(4); }
function tile(value, label) { return h('div', { class: 'tile' }, h('b', null, value), h('span', null, label)); }
function table(head, rows) {
  return h('table', null, h('thead', null, h('tr', null, head.map(function (x) { return h('th', null, x); }))), h('tbody', null, rows));
}
function pre(text) { return text ? h('pre', null, text) : null; }
function section(title) { return h('h2', null, title); }
function safePath(p) { return typeof p === 'string' && /^[A-Za-z0-9_./-]+$/.test(p) && p.indexOf('..') < 0 ? p : null; }
function exec(id) { return V.executions.find(function (e) { return e.execId === id; }); }

function overview() {
  var c = V.coverage;
  var s = c.scripts;
  return [
    section('Coverage'),
    h('div', { class: 'tiles' },
      tile(c.covered + ' / ' + c.requirements, 'requirements with a test case'),
      tile(c.partial, 'partly untestable'),
      c.pages ? tile(c.pages.opened + ' / ' + c.pages.total, 'pages opened by a test case') : null,
      tile(c.afterAction, 'ui expectations marked afterAction'),
      c.endpoints ? tile(c.endpoints.reached + ' / ' + c.endpoints.total, 'API endpoints reached by a test') : null,
      c.reviewed ? tile(c.reviewed.testCaseWrong, 'test cases revised after review') : null,
      c.reviewed ? tile(c.reviewed.scriptWrong, 'scripts rewritten after review') : null,
      tile(c.testCases, 'test cases'),
      tile(s.passed, 'scripts passed on ' + V.run.generationRef),
      tile(s.assertionFailed, 'scripts disagree with ' + V.run.generationRef),
      tile(s.invalid + s.none, 'scripts invalid or missing')),
    suspected(),
    revisions(),
    section('Stages'),
    table(['Stage', 'Status', 'Time', 'Model calls', 'Cost'], V.stages.map(function (st) {
      return h('tr', null, h('td', null, st.name), h('td', null, badge(st.status)), h('td', null, secs(st.durationMs)), h('td', null, st.calls), h('td', null, money(st.costUsd)));
    })),
    section('Executions'),
    table(['Id', 'Version', 'Execute', 'Passed', 'Failed', 'Errored', 'Skipped', 'Not isolated', 'Incidents', 'Diagnoses', 'Analysis cost'], V.executions.map(function (e) {
      var m = e.summary || {};
      return h('tr', { class: 'click', onclick: function () { show('executions', e.execId); } },
        h('td', null, e.execId), h('td', null, e.label), h('td', null, badge(e.executeStatus)),
        h('td', { class: 'passed' }, m.passed), h('td', { class: 'failed' }, m.failed), h('td', { class: 'errored' }, m.errored),
        h('td', null, m.skipped), h('td', null, m.notIsolated), h('td', null, e.incidents.length),
        h('td', null, e.diagnoses ? e.diagnoses.length : ''), h('td', null, e.analysis.full ? money(e.analysis.full.costUsd) : ''));
    })),
  ];
}

function suspected() {
  var list = V.suspectedDefects;
  if (!list.length) return null;
  return [
    section('Suspected defects in ' + V.run.generationRef + ' (' + list.length + ')'),
    h('p', { class: 'muted' }, 'The app contradicts these locked expectations: either the test case or the app is wrong. They are not executed; review each one.'),
    table(['Test', 'Requirement', 'Expectation', 'Expected', 'Actual', 'Review'], list.map(function (d) {
      return h('tr', null,
        h('td', null, d.testCaseId + ': ' + d.title),
        h('td', null, d.requirements.map(function (r) { return h('div', null, r.id + (r.statement ? ': ' + r.statement : '')); })),
        h('td', null, (d.expectationId || '?') + (d.expectation ? ' ' + d.expectation : '')),
        h('td', null, d.expected === null ? '' : d.expected),
        h('td', { class: 'failed' }, d.received === null ? '' : d.received),
        h('td', null, d.review ? d.review.verdict + ': ' + d.review.explanation : 'not reviewed'));
    })),
  ];
}

function revisions() {
  var list = V.revisions;
  if (!list.length) return null;
  var removed = list.filter(function (r) { return r.change === 'remove'; }).length;
  function shown(x) { return x ? x.description + (x.value === undefined ? '' : ' [' + JSON.stringify(x.value) + ']') : ''; }
  return [
    section('Expectations changed after review (' + list.length + (removed ? ', ' + removed + ' removed' : '') + ')'),
    h('p', { class: 'muted' }, 'A review found the test case wrong and cited the code. A removed expectation is no longer checked: look at each removal, and at each cited line.'),
    table(['Test', 'Expectation', 'Change', 'Before', 'After', 'Cited code', 'Reason'], list.map(function (r) {
      return h('tr', null,
        h('td', null, r.testCaseId + ': ' + r.title),
        h('td', null, r.expectationId),
        h('td', { class: r.change === 'remove' ? 'failed' : '' }, r.change === 'remove' ? 'removed' : 'value changed'),
        h('td', null, shown(r.from)),
        h('td', null, r.to ? shown(r.to) : '(none)'),
        h('td', null, r.citation.file + ':' + r.citation.lines[0] + '-' + r.citation.lines[1]),
        h('td', null, r.explanation));
    })),
  ];
}

function requirements() {
  var box = h('div');
  var q = h('input', { type: 'search', placeholder: 'Filter by id, feature or text' });
  function draw() {
    var term = q.value.toLowerCase();
    fill(box, table(['Requirement', 'Feature', 'Statement', 'Test cases (script outcome)'], V.requirements.filter(function (r) {
      return !term || (r.id + ' ' + r.feature + ' ' + r.statement).toLowerCase().indexOf(term) >= 0;
    }).map(function (r) {
      return h('tr', null, h('td', null, r.id, h('div', { class: 'muted' }, r.priority + ', ' + r.layer)), h('td', null, r.feature),
        h('td', null, r.statement, r.partial ? h('div', { class: 'muted' }, 'Partly untestable: ' + r.partial) : null),
        h('td', null, r.testCases.length === 0 ? h('span', { class: 'muted' }, 'Not covered' + (r.uncovered ? ': ' + r.uncovered : '')) : r.testCases.map(function (t) {
          return h('div', null, badge(t.outcome), t.id + ' ' + t.title, t.failureCategory ? h('span', { class: 'muted' }, ' (' + t.failureCategory + ')') : null);
        })));
    })));
  }
  q.addEventListener('input', draw);
  draw();
  return [h('div', { class: 'row' }, q), box];
}

function diagnosisCard(d, title) {
  if (!d) return null;
  var loc = d.location ? d.location.file + ':' + d.location.lines[0] + '-' + d.location.lines[1] : 'no single location';
  return h('div', { class: 'card' },
    h('div', null, h('b', null, title + ' ' + d.id + ' '), badge(d.classification), 'confidence ' + d.confidence),
    h('div', null, h('b', null, d.summary)),
    h('div', { class: 'muted' }, loc + (d.violatedRequirementIds.length ? '; violates ' + d.violatedRequirementIds.join(', ') : '') + '; ' + d.toolCalls + ' tool calls, ' + secs(d.durationMs)),
    h('p', null, d.rootCause),
    d.evidence.length ? h('ul', null, d.evidence.map(function (x) { return h('li', null, h('b', null, x.source + ': '), x.detail); })) : null,
    d.suggestedFix ? h('div', null, h('b', null, 'Suggested fix: '), d.suggestedFix.description, pre(d.suggestedFix.patch)) : null);
}

function failureDetail(e, t) {
  var f = t.failure;
  if (!f) return h('div', { class: 'detail muted' }, t.status === 'skipped' ? 'Not executed: its dry run ended ' + t.skipReason + '.' : 'Passed.');
  var find = function (list, id) { return (list || []).find(function (d) { return d.id === id; }); };
  var trace = safePath(f.trace);
  var shot = typeof f.screenshot === 'string' && f.screenshot.indexOf('data:image/png;base64,') === 0 ? f.screenshot : null;
  var ex = f.excerpts;
  return h('div', { class: 'detail' },
    h('div', null, badge(t.status), f.expectationId ? 'at ' + f.expectationId + ' ' : '', f.category ? '(' + f.category + ')' : '', t.isolated ? '' : h('b', { class: 'errored' }, ' ran without a data restore')),
    f.expected !== null || f.received !== null ? h('div', { class: 'ev' }, h('b', null, 'Expected'), h('code', null, f.expected || ''), h('b', null, 'Received'), h('code', null, f.received || '')) : null,
    pre(f.message),
    diagnosisCard(find(e.diagnoses, f.diagnosisId), 'Diagnosis'),
    diagnosisCard(find(e.noToolsDiagnoses, f.noToolsDiagnosisId), 'Without tools'),
    shot ? h('img', { src: shot, alt: 'Screenshot at the failure' }) : null,
    trace ? h('div', null, 'Trace: ', h('a', { href: trace }, trace), h('span', { class: 'muted' }, '  (npx playwright show-trace ' + trace + ')')) : null,
    ['lastResponse', 'serverLog', 'network', 'console'].map(function (k) {
      return ex[k] ? h('details', null, h('summary', null, k), pre(ex[k])) : null;
    }),
    !ex.lastResponse && !ex.serverLog && !ex.network && !ex.console ? h('div', { class: 'muted' }, 'No response, log or network excerpt was captured for this test.') : null);
}

function testRows(e, tests, extra) {
  var rows = [];
  tests.forEach(function (t) {
    var open = null;
    var row = h('tr', { class: 'click' + (extra && extra.changed ? ' changed' : '') },
      h('td', null, t.testCaseId), h('td', null, t.title), (extra ? extra.cells(t) : [h('td', null, badge(t.status))]),
      h('td', null, t.status === 'skipped' ? '' : t.isolated ? 'yes' : h('b', { class: 'errored' }, 'no')), h('td', null, secs(t.durationMs)));
    row.addEventListener('click', function () {
      if (open) { open.remove(); open = null; return; }
      var cols = row.children.length;
      open = h('tr', null, h('td', { colspan: cols }, failureDetail(e, t)));
      row.after(open);
    });
    rows.push(row);
  });
  return rows;
}

function executions(selected) {
  var current = selected || (V.executions[0] && V.executions[0].execId);
  var pick = h('select', null, V.executions.map(function (e) { return h('option', { value: e.execId, selected: e.execId === current }, e.execId + ': ' + e.label); }));
  var only = h('input', { type: 'checkbox', checked: true });
  var box = h('div');
  function draw() {
    var e = exec(pick.value);
    if (!e) { fill(box, h('p', { class: 'muted' }, 'No executions yet.')); return; }
    var m = e.summary;
    var tests = e.tests.filter(function (t) { return !only.checked || t.status === 'failed' || t.status === 'errored'; });
    fill(box, 
      h('div', { class: 'meta' }, 'Commit ' + e.commit.slice(0, 7) + (e.patch ? ', patch ' + e.patch : '') + (e.skipSeed ? ', seed skipped' : '') + '; ' + (e.startedAt || '') + (e.error ? '; error: ' + e.error : '')),
      m ? h('div', { class: 'tiles' }, tile(m.passed, 'passed'), tile(m.failed, 'failed'), tile(m.errored, 'errored'), tile(m.skipped, 'skipped'),
        tile(m.notIsolated, 'not isolated'), e.timing ? tile(secs(e.timing.suiteMs), 'suite, ' + e.timing.restores + ' restores ' + secs(e.timing.restoreMs)) : null,
        e.analysis.full ? tile(money(e.analysis.full.costUsd), e.analysis.full.groups + ' groups analysed') : null) : h('p', { class: 'muted' }, 'No results.json.'),
      e.environment ? h('div', null, section('Environment'), e.environment.healthChecks.map(function (c) { return h('div', null, badge(c.ok ? 'passed' : 'failed'), c.name + ' health check, ' + secs(c.elapsedMs)); }),
        h('div', null, e.environment.seed.length + ' seed requests, ' + e.environment.seed.filter(function (s) { return !s.ok; }).length + ' failed' + (e.environment.seedCheck ? '; seed check: ' + e.environment.seedCheck.detail : ''))) : null,
      e.incidents.length ? [section('Incidents'), table(['Before test', 'Kind', 'Detail'], e.incidents.map(function (i) { return h('tr', null, h('td', null, i.beforeTestCaseId || 'end'), h('td', null, i.kind), h('td', null, i.detail)); }))] : null,
      section(only.checked ? 'Failures (click a row for the evidence and diagnosis)' : 'All tests'),
      tests.length ? table(['Test', 'Title', 'Status', 'Isolated', 'Time'], testRows(e, tests)) : h('p', { class: 'muted' }, 'No failures.'));
  }
  pick.addEventListener('change', draw);
  only.addEventListener('change', draw);
  draw();
  return [h('div', { class: 'row' }, pick, h('label', null, only, ' failures only')), box];
}

var FLIP = { 'newly-failing': 'fixed', fixed: 'newly-failing' };
function comparison(a, b) {
  var rows = V.comparisons[a + '|' + b];
  if (rows) return rows;
  return (V.comparisons[b + '|' + a] || []).map(function (r) { return { testCaseId: r.testCaseId, from: r.to, to: r.from, kind: FLIP[r.kind] || r.kind }; });
}

function compare() {
  var withResults = V.executions.filter(function (e) { return e.summary; });
  if (withResults.length < 2) return [h('p', { class: 'muted' }, 'At least two executions with results are needed.')];
  var opts = function (sel) { return withResults.map(function (e) { return h('option', { value: e.execId, selected: e.execId === sel }, e.execId + ': ' + e.label); }); };
  var a = h('select', null, opts(withResults[0].execId));
  var b = h('select', null, opts(withResults[withResults.length - 1].execId));
  var box = h('div');
  function draw() {
    var rows = comparison(a.value, b.value);
    var eb = exec(b.value);
    var ea = exec(a.value);
    var byId = function (e, id) { return e.tests.find(function (t) { return t.testCaseId === id; }); };
    var counts = {};
    rows.forEach(function (r) { counts[r.kind] = (counts[r.kind] || 0) + 1; });
    fill(box, 
      h('div', { class: 'tiles' }, ['newly-failing', 'fixed', 'failure-changed', 'only-in-one'].map(function (k) { return tile(counts[k] || 0, k); })),
      a.value === b.value ? h('p', { class: 'muted' }, 'Pick two different executions.') :
      rows.length === 0 ? h('p', { class: 'muted' }, 'No test changed its result.') :
      table(['Test', 'Title', a.value, b.value, 'Change', 'Isolated', 'Time'], testRows(eb, rows.map(function (r) {
        return byId(eb, r.testCaseId) || byId(ea, r.testCaseId);
      }), { changed: true, cells: function (t) {
        var r = rows.find(function (x) { return x.testCaseId === t.testCaseId; });
        return [h('td', null, r.from ? badge(r.from) : '-'), h('td', null, r.to ? badge(r.to) : '-'), h('td', null, badge(r.kind))];
      } })));
  }
  a.addEventListener('change', draw);
  b.addEventListener('change', draw);
  draw();
  return [h('div', { class: 'row' }, 'Compare ', a, ' with ', b), box];
}

var TABS = { overview: overview, requirements: requirements, executions: executions, compare: compare };
var buttons = {};
function show(name, arg) {
  Object.keys(buttons).forEach(function (k) { buttons[k].className = k === name ? 'on' : ''; });
  fill(main, TABS[name](arg));
}
var nav = document.getElementById('nav');
Object.keys(TABS).forEach(function (k) {
  buttons[k] = h('button', { type: 'button', onclick: function () { show(k); } }, k[0].toUpperCase() + k.slice(1));
  nav.append(buttons[k]);
});
document.getElementById('meta').textContent = V.run.target + ' · generated at ' + V.run.generationRef + ' (' + V.run.generationCommit.slice(0, 7) + ') · models: ' +
  Object.keys(V.run.models).map(function (k) { return k + ' ' + V.run.models[k]; }).join(', ') + (V.run.upstreamProviders.length ? ' via ' + V.run.upstreamProviders.join(', ') : '') +
  (V.run.playwrightVersion ? ' · Playwright ' + V.run.playwrightVersion : '') + ' · report built ' + V.generatedAt;
show('overview');
`;

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One self-contained HTML page for the view model (SPEC §9.2): inline CSS and JS, the data as escaped JSON. */
export function renderReport(view: RunView): string {
  // Inside <script type="application/json"> only "</script" could end the element early; escaping every "<" rules it out.
  const data = JSON.stringify(view).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
<title>${escapeText(`Test report ${view.run.runId}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>${escapeText(view.run.runId)}</h1><div class="meta" id="meta"></div></header>
<nav id="nav"></nav>
<main id="main"></main>
<script type="application/json" id="run-view">${data}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
