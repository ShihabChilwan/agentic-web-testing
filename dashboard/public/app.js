import { planReplay, viewAt } from './replay.js';

const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const svg = (d, size = 20) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = d;
  return s;
};
const ICONS = {
  prd: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  cases: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9"/>',
  scripts: '<path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/>',
  gaps: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  execute: '<path d="M7 4l13 8-13 8z"/>',
  analyze: '<path d="M11 4a7 7 0 1 0 4.2 12.6L20 21"/><path d="M11 8v6M8 11h6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};

// ------------------------------------------------------------------ state

const state = {
  runs: [], targets: [], runId: null,
  live: null,            // latest view from the server
  replay: null,          // { plan, base (view), startedReal, offset, speed, paused, view }
  job: null,
  es: null,
  logs: { live: [], replay: [] },
  logPaused: false,
  logSource: 'job',
  firstSeen: new Map(),  // "run/stage" -> ms when the page first saw it running
  tab: 'run',
  variants: [],
  excerpts: new Map(),
  prevReplayView: null,
};
const cur = () => (state.replay ? state.replay.view : state.live);

// ------------------------------------------------------------------ formatting

const fmtDur = (ms) => {
  if (ms == null || !isFinite(ms)) return '–';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
const pct = (v, d = 1) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);
const usd = (v, d = 3) => (v == null ? '–' : `$${v.toFixed(d)}`);
const num = (v) => (v == null ? '–' : String(v));
const badge = (cls, text) => h('span', { class: `badge ${cls}` }, text);
const STATE_TEXT = { pending: 'waiting', running: 'running', done: 'done', failed: 'failed', stale: 'outdated' };
const tagReplay = () => (state.replay ? h('span', { class: 'replay-tag' }, `Replay of run ${state.runId}`) : null);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 4500);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
}

// ------------------------------------------------------------------ keyed table rows (update in place, no flicker)

function syncRows(tbody, items, keyOf, sigOf, build, detail) {
  const existing = new Map();
  for (const tr of tbody.children) existing.set(tr.dataset.k, tr);
  const animate = tbody.dataset.init === '1';
  const cols = tbody.parentElement.tHead?.rows[0]?.cells.length || 1;
  tbody._detail = detail || null;
  let at = 0;
  const place = (tr) => { if (tbody.children[at] !== tr) tbody.insertBefore(tr, tbody.children[at] || null); at += 1; };
  for (const it of items) {
    const k = keyOf(it);
    const sig = sigOf(it);
    let tr = existing.get(k);
    let dr = existing.get(`${k}#d`);
    existing.delete(k);
    existing.delete(`${k}#d`);
    if (!tr) {
      tr = h('tr', { 'data-k': k, class: detail ? 'xrow' : '' });
      build(tr, it);
      tr.dataset.sig = sig;
      if (animate) tr.classList.add('fresh');
      if (detail) {
        tr.tabIndex = 0;
        tr.setAttribute('aria-expanded', 'false');
        tr.addEventListener('click', () => toggleRow(tbody, k));
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(tbody, k); } });
      }
    } else if (tr.dataset.sig !== sig) { tr.replaceChildren(); build(tr, it); tr.dataset.sig = sig; }
    tr._item = it;
    place(tr);
    if (detail) {
      if (!dr) dr = h('tr', { 'data-k': `${k}#d`, class: 'drow' }, h('td', { colspan: String(cols) }, h('div', { class: 'dwrap' }, h('div', { class: 'dinner' }))));
      place(dr);
      if (tbody.dataset.open === k) setRow(tbody, k, true);
    }
  }
  for (const tr of existing.values()) tr.remove();
  tbody.dataset.init = '1';
}

/** Opens or closes a row's detail; one row is open at a time per table. */
function setRow(tbody, k, open) {
  const rows = [...tbody.children];
  const tr = rows.find((r) => r.dataset.k === k);
  const dr = rows.find((r) => r.dataset.k === `${k}#d`);
  if (!tr || !dr) return;
  tr.classList.toggle('open', open);
  tr.setAttribute('aria-expanded', String(open));
  dr.classList.toggle('open', open);
  if (open && dr.dataset.filled !== tr.dataset.sig && tbody._detail) {
    dr.querySelector('.dinner').replaceChildren(tbody._detail(tr._item));
    dr.dataset.filled = tr.dataset.sig;
  }
}

function toggleRow(tbody, k, forceOpen = false) {
  const prev = tbody.dataset.open || '';
  const next = forceOpen ? k : prev === k ? '' : k;
  if (prev && prev !== next) setRow(tbody, prev, false);
  tbody.dataset.open = next;
  if (next) setRow(tbody, next, true);
}

function resetLists() {
  for (const k of ['cases-body', 'scripts-body', 'exec-body']) { const b = $('#' + k); b.replaceChildren(); delete b.dataset.init; delete b.dataset.open; }
  $('#dx-list').replaceChildren();
}

/** Same idea for a list of cards: update in place, rebuild a card only when its signature changed. */
function syncCards(box, items, keyOf, sigOf, build) {
  const existing = new Map([...box.children].map((c) => [c.dataset.k, c]));
  const animate = box.dataset.init === '1';
  items.forEach((it, i) => {
    const k = keyOf(it);
    const sig = sigOf(it);
    let el = existing.get(k);
    if (!el) {
      el = build(it);
      el.dataset.k = k; el.dataset.sig = sig;
      if (animate) el.classList.add('fresh-card');
    } else {
      existing.delete(k);
      if (el.dataset.sig !== sig) { const n = build(it); n.dataset.k = k; n.dataset.sig = sig; el.replaceWith(n); el = n; }
    }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
  for (const el of existing.values()) el.remove();
  box.dataset.init = '1';
}

// ------------------------------------------------------------------ header

function elapsedOf(stage, now) {
  let ms = stage.elapsedMs || 0;
  if (stage.status === 'running') {
    if (state.replay) return ms;
    const key = `${state.runId}/${stage.key}`;
    let since = stage.runningSince ? Date.parse(stage.runningSince) : null;
    if (since == null) {
      if (!state.firstSeen.has(key)) state.firstSeen.set(key, now);
      since = state.firstSeen.get(key);
    }
    ms += Math.max(0, now - since);
  } else state.firstSeen.delete(`${state.runId}/${stage.key}`);
  return ms;
}

const MODE_TEXT = { full: 'With tools', 'no-tools': 'Without tools', mixed: 'Mixed' };

function renderHeader(v) {
  $('#h-title').textContent = v ? v.run.target : 'Pipeline';
  $('#btn-info').hidden = !v;
  if (!v) { $('#pop-info').hidden = true; return; }
  const rows = [['Run', v.run.id], ['Type', v.demo ? 'Demo run' : 'Full run'], ['Model', v.run.model || '–'],
    ['Analysis', v.run.mode ? MODE_TEXT[v.run.mode] || v.run.mode : 'not run yet'], ...(state.replay ? [['Replay', 'recorded files, not live']] : [])];
  const sig = JSON.stringify(rows);
  const pop = $('#pop-info');
  if (pop.dataset.sig === sig) return;
  pop.dataset.sig = sig;
  pop.replaceChildren(h('dl', { class: 'pop-kv' }, rows.flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val)])));
}

function runState(r) {
  const entries = Object.entries(r.stages);
  const failed = entries.find(([, st]) => st === 'failed');
  if (failed) return `failed at ${failed[0]}`;
  const running = entries.find(([, st]) => st === 'running');
  if (running) return `running ${running[0]}`;
  const stale = entries.find(([, st]) => st === 'stale');
  if (stale) return `${stale[0]} outdated`;
  if (entries.length && entries.every(([, st]) => st === 'done') && r.executions > 0) return 'done';
  const last = [...entries].reverse().find(([, st]) => st === 'done');
  return last ? `stopped after ${last[0]}` : 'waiting';
}

const shortRunId = (r) => (r.id.startsWith(`${r.target}-`) ? r.id.slice(r.target.length + 1) : r.id);

function renderPicker() {
  const sel = $('#run-picker');
  const keep = state.runId || '';
  sel.replaceChildren(h('option', { value: '' }, 'Open a run…'));
  for (const r of state.runs) sel.append(h('option', { value: r.id, title: r.id }, `${shortRunId(r)}${r.demo ? ' · Demo' : ''} · ${runState(r)}`));
  sel.value = keep;
  const r = state.runs.find((x) => x.id === keep);
  sel.title = r ? `${r.id} · ${runState(r)}` : 'Open a run';
}

// ------------------------------------------------------------------ stage timeline

const STAGES = [['prd', 'Requirements'], ['cases', 'Test cases'], ['scripts', 'Scripts'], ['gaps', 'Coverage round'], ['execute', 'Execution'], ['analyze', 'Diagnosis']];

function renderStepper(v) {
  const root = $('#stepper');
  if (!root.children.length) {
    for (const [key, label] of STAGES) {
      root.append(h('div', { class: 'step s-pending', 'data-k': key },
        h('div', { class: 'ic' }),
        h('div', { class: 'name' }, label),
        h('div', { class: 'state' }),
        h('div', { class: 'time' }, '–'),
        h('div', { class: 'cost' })));
    }
  }
  const now = Date.now();
  let err = '';
  for (const el of root.children) {
    const s = v.stages.find((x) => x.key === el.dataset.k);
    const status = s.status || 'pending';
    $('.name', el).textContent = s.label;
    $('.cost', el).textContent = s.costUsd ? usd(s.costUsd, 3) : '';
    el.className = `step s-${status === 'stale' ? 'pending' : status}`;
    const ic = $('.ic', el);
    const iconKey = status === 'done' ? 'check' : status === 'failed' ? 'x' : el.dataset.k;
    if (ic.dataset.i !== iconKey) { ic.dataset.i = iconKey; ic.replaceChildren(svg(ICONS[iconKey])); }
    const st = $('.state', el);
    const text = STATE_TEXT[status] || status;
    if (st.dataset.t !== status) {
      st.dataset.t = status;
      st.replaceChildren(...(status === 'running' ? [h('span', { class: 'pulse' })] : []), text);
    }
    const ms = elapsedOf(s, now);
    $('.time', el).textContent = status === 'pending' || status === 'stale' ? '–' : fmtDur(ms);
    if (status === 'failed' && s.error) err = `${s.label}: ${s.error}`;
  }
  const e = $('#stage-error');
  e.hidden = !err;
  $('#stage-error-text').textContent = err.slice(0, 300);
  $('#btn-continue2').hidden = !canContinue(v);
}

// ------------------------------------------------------------------ continue

function canContinue(v) {
  if (!v || state.replay || state.job?.state === 'running') return false;
  const bad = v.stages.some((s) => s.status === 'failed' || s.status === 'stale' || s.status === 'running');
  if (bad) return true;
  return Boolean(v.demo?.selection) && v.stages.some((s) => s.status !== 'done');
}

async function continueRun() {
  if (!state.runId) return;
  await start({ action: 'continue', run: state.runId });
}

// ------------------------------------------------------------------ demo card

const DEMO_INFO = 'Limited to the chosen features and a case cap, by editing prd.json and testcases.json between stages (the full files are kept as prd.full.json and testcases.full.json). Coverage is measured only: it adds no test cases. Never score a demo run.';
let demoForm = null; // { run, features, el, read() }

/** The same compact summary for every run. */
function renderSummary(v) {
  const now = Date.now();
  const totalMs = v.stages.reduce((a, s) => a + elapsedOf(s, now), 0);
  const golden = v.executions.find((e) => e.kind === 'golden' && e.executeStatus === 'done');
  const t = v.scripts.totals;
  const item = (k, val, cls = '', title = '') => h('div', { class: 'sum-item' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls}`, title }, val));
  const items = [
    item('Run type', v.demo ? 'Demo' : 'Full'),
    item('Total time', fmtDur(totalMs)),
    item('Model cost', v.run.cost == null ? '–' : usd(v.run.cost, 3)),
    golden
      ? item('Tests passing (correct version)', `${golden.passed} / ${golden.total}`)
      : item('Scripts passing', v.cases.total ? `${t.passed + t.repaired} / ${v.cases.total}` : '–'),
  ];
  $('#summary').replaceChildren(...items);
}

async function renderDemo(v) {
  const card = $('#demo-card');
  card.hidden = !v?.demo;
  if (!v?.demo) { demoForm = null; return; }
  const body = $('#demo-body');
  const d = v.demo;
  if (d.awaiting) {
    if (!demoForm || demoForm.run !== state.runId) {
      demoForm = { run: state.runId, features: null, el: null };
      try { const o = await api(`/api/demo?run=${encodeURIComponent(state.runId)}`); demoForm.features = o.features; demoForm.cap = o.defaultCap; }
      catch (e) { body.replaceChildren(h('div', { class: 'note' }, `Cannot list the features: ${e.message}`)); return; }
      demoForm.el = buildDemoForm(demoForm);
    }
    if (body.firstChild !== demoForm.el) body.replaceChildren(demoForm.el);
    return;
  }
  demoForm = null;
  const sel = d.selection;
  const chip = (k, val, title = '') => h('span', { class: 'kchip', title }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, val));
  const names = v.prd ? v.prd.featureNames.join(', ') : '';
  body.replaceChildren(
    sel ? h('div', { class: 'chips-row' },
      chip('Features', names || `${sel.featureIds.length} ticked`, names),
      chip('Cap', String(sel.cap)),
      chip('Versions', sel.buggy ? `correct + ${sel.buggy.slice(sel.buggy.lastIndexOf(':') + 1)}` : 'correct only'),
      chip('Analyze', sel.analyze ? 'on' : 'off'),
      h('span', { class: 'info', tabindex: '0', role: 'img', 'aria-label': 'About demo runs', title: DEMO_INFO }, 'ⓘ')) : h('div', { class: 'note' }, 'Features not chosen yet.'));
}

function buildDemoForm(f) {
  const boxes = f.features.map((x) => h('input', { type: 'checkbox', value: x.id, disabled: x.requirements === 0 }));
  const total = h('span', { class: 'note' });
  const cap = h('input', { class: 'cap', type: 'number', min: '3', max: '250', value: String(f.cap), 'aria-label': 'Cap on test cases' });
  const buggy = h('input', { type: 'checkbox' });
  const variant = h('select', { class: 'sel', hidden: true, 'aria-label': 'Buggy version' }, h('option', { value: '' }, 'Pick a variant…'),
    state.variants.map((x) => h('option', { value: x.value }, `${x.id}${x.group === 'dev' ? ' (development set)' : ''}`)));
  const analyze = h('input', { type: 'checkbox', checked: true });
  const go = h('button', { class: 'btn primary', disabled: true }, 'Start with the ticked features');
  const refresh = () => {
    const picked = f.features.filter((_, i) => boxes[i].checked);
    total.textContent = picked.length ? `${picked.length} ticked: about ${picked.reduce((a, x) => a + x.requirements, 0)} requirements, up to ${cap.value || '?'} test cases` : 'Tick at least one feature.';
    go.disabled = picked.length === 0 || state.job?.state === 'running';
    variant.hidden = !buggy.checked;
  };
  boxes.forEach((b) => b.addEventListener('change', refresh));
  cap.addEventListener('input', refresh);
  buggy.addEventListener('change', refresh);
  go.onclick = () => {
    const featureIds = f.features.filter((_, i) => boxes[i].checked).map((x) => x.id);
    const payload = { action: 'demo-start', run: f.run, featureIds, cap: Number(cap.value), analyze: analyze.checked };
    if (!buggy.checked) return start(payload);
    if (!variant.value) return toast('Pick a buggy version first.');
    const id = variant.value.slice(variant.value.lastIndexOf(':') + 1);
    const dlg = $('#dlg-buggy');
    $('#buggy-text').textContent = `After the correct version, this runs the scripts against version ${id}.${analyze.checked ? ' Its failures are then diagnosed (model calls).' : ''}`;
    dlg.addEventListener('close', () => {
      if (dlg.returnValue === 'ok') start({ ...payload, buggy: variant.value, confirm: true });
      dlg.returnValue = '';
    }, { once: true });
    dlg.showModal();
  };
  const el = h('div', {},
    h('div', {}, h('strong', {}, 'Requirements are ready. Tick the features to test.'), ' Only these continue to test cases, scripts and the coverage measurement.'),
    h('div', { class: 'feat-list' }, f.features.map((x, i) => h('label', { class: 'feat' }, boxes[i],
      h('span', {}, h('div', { class: 'nm' }, x.name), h('div', { class: 'ct' }, x.requirements === 0 ? 'no requirements (nothing to test)' : `${x.requirements} requirements · ${x.endpoints} endpoints`))))),
    h('div', { class: 'demo-row' },
      h('label', { class: 'chk' }, 'Cap on test cases', cap),
      h('label', { class: 'chk' }, buggy, 'Also run a buggy version'), variant,
      h('label', { class: 'chk' }, analyze, 'Analyze after execution')),
    h('div', { class: 'note', style: 'margin-top:8px' }, 'The correct version always runs. Coverage is measured only; it adds no test cases.'),
    h('div', { class: 'demo-row' }, go, total));
  refresh();
  return el;
}

// ------------------------------------------------------------------ tiles, generation

function tile(n, l, cls = '') { return h('div', { class: 'card tile' }, h('div', { class: `n ${cls}` }, String(n)), h('div', { class: 'l' }, l)); }

function renderTiles(v) {
  const t = v.scripts.totals;
  const ex = v.executions.filter((e) => e.kind === 'golden')[0] || v.executions[0];
  $('#tiles').replaceChildren(
    tile(v.prd ? v.prd.requirements : '–', 'Requirements'),
    tile(v.prd ? v.prd.endpoints : '–', 'API endpoints found'),
    tile(v.prd ? v.prd.uiRoutes : '–', 'Pages found'),
    tile(v.cases.total || '–', `Test cases · ${v.cases.api} API · ${v.cases.browser} browser`),
    tile(v.cases.total ? `${t.passed + t.repaired}/${v.cases.total}` : '–', 'Scripts passing', 'green'),
  );
  void ex;
}

const reqState = new Map(); // "<run>/<feature id>" -> open, once a person has toggled a row

function reachMark(reached) {
  if (reached == null) return null;
  return h('span', { class: `reach ${reached ? 'yes' : 'no'}` }, reached ? '✓ reached' : '✗ not reached');
}

function epLine(e) {
  return h('div', { class: 'ep' }, h('span', { class: 'm' }, e.method), h('span', { class: 'mono p', title: e.path }, e.path), reachMark(e.reached));
}

function featureRow(f, open, recorded) {
  const total = f.endpoints.length;
  const reached = f.endpoints.filter((e) => e.reached).length;
  const eps = !total ? h('span', { class: 'note' }, 'no endpoints')
    : !recorded ? h('span', { class: 'note' }, `${total} endpoint${total === 1 ? '' : 's'}`)
    : total === 1 ? h('span', { class: 'note' }, reached ? '1 of 1 reached' : '0 of 1 reached')
    : h('span', { class: 'ep-bar' }, h('span', { class: 'progress' }, h('span', { class: 'c-green', style: `width:${(100 * reached) / total}%` })), h('span', { class: 'note' }, `${reached} of ${total} reached`));
  const d = h('details', { class: 'feat-row', 'data-k': f.id }, 
    h('summary', {},
      h('span', { class: 'f-name', title: f.name }, f.name),
      h('span', { class: 'f-n' }, `${f.requirements.length} req`),
      h('span', { class: 'f-ep' }, eps),
      h('span', { class: 'f-n' }, `${f.tests} test${f.tests === 1 ? '' : 's'}`)),
    h('div', { class: 'f-body' },
      h('div', { class: 'f-col' }, h('div', { class: 'f-h' }, 'Requirements'),
        f.requirements.length ? f.requirements.map((r) => h('div', { class: 'rq' },
          h('span', { class: 'mono id' }, r.id), h('span', { class: 'rq-t', title: r.text }, r.text), badge(r.priority === 'high' ? 'failed' : r.priority === 'medium' ? 'suspected' : 'pending', r.priority))) : h('div', { class: 'note' }, 'None.')),
      h('div', { class: 'f-col' }, h('div', { class: 'f-h' }, 'Endpoints'),
        f.endpoints.length ? f.endpoints.map(epLine) : h('div', { class: 'note' }, 'None linked.'))));
  d.open = open;
  d.addEventListener('toggle', () => reqState.set(`${state.runId}/${f.id}`, d.open));
  return d;
}

function renderReq(v) {
  const body = $('#req-body');
  const p = v.prd;
  const sub = $('#req-sub');
  if (!p) { sub.replaceChildren(tagReplay() || ''); body.replaceChildren(h('div', { class: 'note' }, 'The requirements document is written when the first stage finishes.')); return; }
  const c = v.coverage;
  const recorded = p.reachRecorded !== false;
  const line = [`${p.features} feature${p.features === 1 ? '' : 's'}`, `${p.requirements} requirement${p.requirements === 1 ? '' : 's'}`];
  if (c && recorded) line.push(c.reached === c.total ? `${c.total === 1 ? 'the' : 'all'} ${c.total} endpoint${c.total === 1 ? '' : 's'} reached` : `${c.reached} of ${c.total} endpoints reached`);
  else line.push(`${p.endpoints} endpoint${p.endpoints === 1 ? '' : 's'}`);
  sub.replaceChildren(...[line.join(' · '), !recorded ? h('span', { class: 'note-pill' }, 'reach not recorded for this run') : null, tagReplay()].filter(Boolean));
  // Rebuild only when the data changed, so open rows stay open while the page refreshes.
  const sig = JSON.stringify([state.runId, p.featureRows, p.otherEndpoints]);
  if (body.dataset.sig === sig) return;
  body.dataset.sig = sig;
  const rows = p.featureRows.map((f, i) => featureRow(f, reqState.get(`${state.runId}/${f.id}`) ?? i === 0, recorded));
  const other = p.otherEndpoints.length ? h('details', { class: 'feat-row', 'data-k': '_other' },
    h('summary', {}, h('span', { class: 'f-name' }, 'Other endpoints'), h('span', { class: 'f-n' }, ''), h('span', { class: 'f-ep note' }, `${p.otherEndpoints.length} not linked to a feature`), h('span', { class: 'f-n' }, '')),
    h('div', { class: 'f-body one' }, h('div', { class: 'f-col' }, p.otherEndpoints.map(epLine)))) : null;
  body.replaceChildren(h('div', { class: `feat-rows${p.featureRows.length >= 16 ? ' scroll' : ''}` }, rows, other));
}

const byIdDesc = (a, b) => b.id.localeCompare(a.id, undefined, { numeric: true });

const chevron = () => h('span', { class: 'chev-i' }, svg('<path d="M9 6l6 6-6 6"/>', 14));
const dl = (pairs) => h('dl', { class: 'dl' }, pairs.filter(Boolean).flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val)]));
const dlist = (items, ordered = false) => h(ordered ? 'ol' : 'ul', { class: 'dlist' }, items.map((x) => h('li', {}, x)));

function caseDetail(c) {
  const type = [c.layer === 'api' ? 'API' : 'Browser', c.category, c.priority ? `${c.priority} priority` : null].filter(Boolean).join(' · ');
  const reqs = c.requirements || [];
  return h('div', { class: 'dbody' }, dl([
    ['Title', c.title],
    c.feature ? ['Feature', c.feature] : null,
    ['Type', type],
    reqs.length ? ['Requirement', reqs.map((r) => h('div', {}, h('span', { class: 'mono' }, r.id), r.text ? ` — ${r.text}` : ''))] : null,
    c.preconditions?.length ? ['Preconditions', dlist(c.preconditions)] : null,
    c.steps?.length ? ['Steps', dlist(c.steps, true)] : null,
    c.expected?.length ? ['Expected result', dlist(c.expected.map((e) => `${e.id}: ${e.description}`))] : null,
  ]));
}

function renderCases(v) {
  const list = [...v.cases.list].sort(byIdDesc);
  $('#cases-empty').hidden = list.length > 0;
  $('#cases-sub').replaceChildren(`${v.cases.total} total`, tagReplay() || '');
  syncRows($('#cases-body'), list, (c) => c.id, (c) => `${c.title}|${c.layer}|${(c.steps || []).length}`, (tr, c) => {
    tr.append(h('td', { class: 'id' }, h('span', { class: 'idc' }, chevron(), c.id)), h('td', { class: 'title', title: c.title }, c.title), h('td', { class: 'title fcell', title: c.feature || '' }, c.feature || '–'),
      h('td', {}, badge(c.layer === 'api' ? 'api' : 'browser', c.layer === 'api' ? 'API' : 'Browser')));
  }, caseDetail);
}

const REASON_TEXT = {
  'no-submit': 'No script written', typecheck: 'Code error', 'lock-check': 'Expected value changed', 'value-less-expect': 'Missing expected value',
  locator: 'Element not found', timeout: 'Timed out', 'runtime-error': 'Script error', 'fixture-mutation': 'Changed a fixture user',
};
const SCRIPT_TEXT = { passed: 'Passed', repaired: 'Repaired', suspected: 'Suspected defect', invalid: 'Invalid' };
const REVIEW_TEXT = { keep: 'kept the test as written', test_case_wrong: 'found the test case wrong and changed it', script_wrong: 'found the script wrong and rewrote it' };

function scriptStatusText(s) {
  if (s.status === 'invalid') return `Invalid: no working script${s.category ? ` (${REASON_TEXT[s.category] || s.category})` : ''}`;
  if (s.status === 'suspected') return 'Suspected defect: the script ran and a checked value differed from the test case';
  return s.attempts > 1 ? `Passed after ${s.attempts} tries (repaired)` : 'Passed on the first try';
}

function scriptDetail(s, title) {
  const notes = [];
  if (s.repairs) notes.push(`Rewritten ${s.repairs} time${s.repairs === 1 ? '' : 's'} after a failed check`);
  if (s.unstable) notes.push('Passed only after a timeout or a browser error, so it may be unstable');
  if (s.review) notes.push(h('span', {}, h('strong', {}, `Review ${REVIEW_TEXT[s.review.verdict] || s.review.verdict}. `), s.review.explanation));
  if (s.earlierReviews) notes.push(`${s.earlierReviews} earlier review${s.earlierReviews === 1 ? '' : 's'} of this script`);
  return h('div', { class: 'dbody' }, dl([
    title ? ['Title', title] : null,
    ['Status', scriptStatusText(s)],
    ['Tries', String(s.attempts)],
    s.lastError ? ['Last error', h('span', { class: 'mono' }, s.lastError)] : null,
    notes.length ? ['Notes', dlist(notes)] : null,
    s.file ? ['Script file', h('span', { class: 'mono' }, s.file)] : null,
  ]));
}

function renderScripts(v) {
  const titles = new Map(v.cases.list.map((c) => [c.id, c.title]));
  const list = [...v.scripts.list].sort((a, b) => byIdDesc({ id: a.id }, { id: b.id }));
  const t = v.scripts.totals;
  $('#scripts-empty').hidden = list.length > 0;
  $('#scripts-sub').replaceChildren(`${list.length} of ${t.total || '–'} written`, tagReplay() || '');
  $('#scripts-totals').replaceChildren(
    badge('passed', `${t.passed} passed`), badge('repaired', `${t.repaired} repaired`), badge('suspected', `${t.suspected} suspected defect`),
    badge('invalid', `${t.invalid} invalid`), badge('pending', `${t.pending} waiting`));
  const total = Math.max(1, t.total);
  const seg = (c, n) => h('span', { class: c, style: `width:${(100 * n) / total}%` });
  $('#scripts-stack').replaceChildren(seg('c-green', t.passed), seg('c-amber', t.repaired + t.suspected), seg('c-red', t.invalid));
  syncRows($('#scripts-body'), list, (s) => s.id, (s) => `${s.status}|${s.attempts}|${s.category}`, (tr, s) => {
    tr.append(h('td', { class: 'id' }, h('span', { class: 'idc' }, chevron(), s.id)), h('td', { class: 'title', title: titles.get(s.id) || '' }, titles.get(s.id) || ''),
      h('td', {}, h('div', { class: 'st' }, badge(s.status, SCRIPT_TEXT[s.status]), s.status === 'invalid' && s.category ? h('span', { class: 'note reason', title: s.category }, REASON_TEXT[s.category] || s.category) : null)),
      h('td', { class: 'num' }, String(s.attempts)));
  }, (s) => scriptDetail(s, titles.get(s.id)));
}

// ------------------------------------------------------------------ executions

const badCount = (e) => e.failed + e.errored;

function execCard(e) {
  const total = Math.max(1, e.total);
  const bad = badCount(e);
  const running = e.executeStatus === 'running';
  const failedRun = e.executeStatus === 'failed';
  const tone = running ? 'running' : failedRun ? 'bad' : e.executeStatus !== 'done' ? 'wait' : bad > 0 ? 'bad' : 'ok';
  const name = e.kind === 'golden' ? 'Correct version' : `${e.kind === 'environment' ? 'Environment fault' : 'Buggy version'} · ${e.label}`;
  const big = running ? [`${e.done} / ${e.total || '?'}`, h('span', { class: 'unit' }, ' run')]
    : failedRun ? ['Execution failed']
    : e.executeStatus !== 'done' ? ['Waiting']
    : bad > 0 ? [`${e.passed}`, h('span', { class: 'unit' }, ' passed · '), h('span', { class: 'bad' }, `${bad}`), h('span', { class: 'unit bad' }, ' failed')]
    : [`${e.passed} / ${e.total}`, h('span', { class: 'unit' }, ' passed')];
  let link;
  if (e.analyzeStatus === 'running') link = h('span', { class: 'xlink busy' }, h('span', { class: 'pulse' }), 'Diagnosing…');
  else if (e.executeStatus === 'done' && bad > 0 && e.analyzeStatus === 'done') {
    link = h('button', { class: 'xlink', onclick: () => { dxChoice = e.execId; renderDiag(cur()); $('#dx-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 'View diagnosis →');
  } else if (e.analyzeStatus === 'failed') link = h('span', { class: 'xlink bad' }, 'Diagnosis failed');
  else if (e.executeStatus === 'done' && bad > 0) link = h('span', { class: 'xlink muted' }, 'Waiting for diagnosis');
  else if (e.executeStatus === 'done') link = h('span', { class: 'xlink muted' }, 'No failures');
  else link = h('span', { class: 'xlink muted' }, '');
  return h('div', { class: `xcard t-${tone}` },
    h('div', { class: 'x-name' }, h('div', { class: 'vname', title: name }, name), h('div', { class: 'xid' }, e.execId)),
    h('div', { class: 'x-big' }, h('div', { class: 'big-n' }, big), e.skipped ? h('div', { class: 'xid' }, `${e.skipped} skipped`) : null),
    h('div', { class: 'x-bar' }, h('div', { class: 'segbar' }, h('span', { class: 'c-green', style: `width:${(100 * e.passed) / total}%` }), h('span', { class: 'c-red', style: `width:${(100 * bad) / total}%` }))),
    h('div', { class: 'x-time mono' }, fmtDur(e.durationMs)),
    h('div', { class: 'x-link' }, link));
}

function renderExec(v) {
  const list = v.executions;
  $('#exec-empty').hidden = list.length > 0;
  $('#exec-sub').replaceChildren(`${list.length} version${list.length === 1 ? '' : 's'}`, tagReplay() || '');
  syncCards($('#exec-body'), list, (e) => e.execId, (e) => JSON.stringify([e.executeStatus, e.analyzeStatus, e.done, e.total, e.passed, e.failed, e.errored, e.skipped, e.durationMs]), execCard);
  renderExecControls(v);
}

function renderExecControls(v) {
  const busy = state.job?.state === 'running';
  const replay = !!state.replay;
  const hasGolden = state.live?.executions.some((e) => e.kind === 'golden');
  $('#btn-run-golden').disabled = busy || replay;
  $('#chk-buggy').disabled = replay;
  const buggy = $('#chk-buggy').checked;
  $('#sel-variant').hidden = !buggy;
  const btn = $('#btn-run-golden');
  btn.textContent = buggy ? 'Run buggy version…' : 'Run correct version';
  const noScripts = state.live && state.live.stages.find((s) => s.key === 'scripts').status !== 'done';
  if (noScripts) btn.disabled = true;
  $('#exec-note').textContent = replay ? 'Controls are off during a replay.'
    : noScripts ? 'Scripts are not finished yet.'
    : buggy && !hasGolden ? 'No correct version has run yet; it runs first.' : buggy ? 'The correct version stays in the table above.' : '';
  void v;
}

// ------------------------------------------------------------------ diagnosis cards

const CLASS_TEXT = { app_defect: 'App defect', environment_issue: 'Environment issue', test_defect: 'Faulty test' };
let dxChoice = null;

/** Diagnoses that point at the same file and line range are one finding: one card, all their tests. */
function groupDiagnoses(items) {
  const groups = [];
  const byLoc = new Map();
  for (const it of items) {
    const loc = it.location;
    const key = loc ? `${loc.file}:${loc.lines[0]}-${loc.lines[1]}` : null;
    let g = key ? byLoc.get(key) : null;
    if (!g) {
      g = { items: [] };
      groups.push(g);
      if (key) byLoc.set(key, g);
    }
    g.items.push(it);
  }
  return groups.map((g) => {
    const lead = [...g.items].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    return {
      key: g.items.map((x) => x.id).join('+'), items: g.items, lead, location: lead.location,
      testCaseIds: [...new Set(g.items.flatMap((x) => x.testCaseIds))],
    };
  });
}

/** First sentence, at most `max` characters. */
function headline(text, max = 90) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  const m = /^.*?[.!?](?=\s|$)/.exec(t);
  const first = m ? m[0] : t;
  return first.length <= max ? first : `${first.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

function openCase(id) {
  const body = $('#cases-body');
  const tr = [...body.children].find((r) => r.dataset.k === id);
  if (!tr) { toast(`${id} is not in the test cases table`); return; }
  toggleRow(body, id, true);
  setTimeout(() => tr.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
}

function renderDiag(v) {
  const withDx = v.diagnoses;
  const itemsOf = (id) => withDx.find((d) => d.execId === id)?.items ?? [];
  // A version gets a tab when it has failures or a diagnosis.
  const tabs = v.executions
    .filter((e) => badCount(e) > 0 || itemsOf(e.execId).length > 0)
    .map((e) => ({ execId: e.execId, label: e.kind === 'golden' ? 'Correct version' : e.label, count: itemsOf(e.execId).length }))
    .sort((a, b) => b.execId.localeCompare(a.execId));
  const total = withDx.reduce((a, d) => a + d.items.length, 0);
  $('#dx-sub').replaceChildren(total + ' diagnoses', tagReplay() || '');
  if (!tabs.find((t) => t.execId === dxChoice)) dxChoice = (tabs.find((t) => t.count > 0) || tabs[0])?.execId ?? null;
  const chips = $('#dx-chips');
  chips.hidden = tabs.length === 0;
  chips.replaceChildren(...tabs.map((t) => h('button', {
    class: 'chip', 'aria-pressed': String(t.execId === dxChoice),
    onclick: () => { dxChoice = t.execId; renderDiag(cur()); },
  }, `${t.label} · ${t.execId} · ${t.count}`)));
  const done = v.executions.filter((e) => e.executeStatus === 'done');
  const empty = $('#dx-empty');
  const clean = done.length > 0 && tabs.length === 0 && done.length === v.executions.length;
  empty.className = clean ? 'empty ok' : 'empty';
  empty.hidden = tabs.length > 0 && itemsOf(dxChoice).length > 0;
  if (!empty.hidden) {
    empty.replaceChildren(...(clean ? [svg(ICONS.check, 18), 'No failures, nothing to diagnose']
      : [tabs.length ? 'Waiting for the diagnosis of this version…' : 'Failures are diagnosed after an execution that has any.']));
  }
  const list = $('#dx-list');
  const sel = tabs.find((t) => t.execId === dxChoice);
  const groups = sel ? groupDiagnoses(itemsOf(sel.execId)) : [];
  const wanted = new Set(groups.map((g) => `${sel.execId}/${g.key}`));
  for (const c of [...list.children]) if (!wanted.has(c.dataset.k)) c.remove();
  for (const g of groups) {
    const key = `${sel.execId}/${g.key}`;
    if (![...list.children].some((c) => c.dataset.k === key)) list.append(dxCard(sel, g, key));
  }
  list.hidden = groups.length === 0;
}

function dxCard(d, g, key) {
  const it = g.lead;
  const conf = Math.round((it.confidence ?? 0) * 100);
  const loc = g.location;
  const codeBox = h('div', {});
  const shown = g.testCaseIds.slice(0, 12);
  const card = h('article', { class: `dx cls-${it.classification}`, 'data-k': key },
    h('div', { class: 'dx-top' },
      badge(it.classification, CLASS_TEXT[it.classification] || it.classification),
      h('span', { class: 'dx-id' }, g.items.map((x) => x.id).join(' · ')),
      h('div', { class: 'ring', style: `--p:${conf}`, title: `Confidence ${conf}%` }, h('span', {}, `${conf}%`))),
    h('p', { class: 'dx-head', title: it.summary }, headline(it.summary)),
    loc ? h('div', { class: 'loc' }, `${loc.file}:${loc.lines[0]}${loc.lines[1] !== loc.lines[0] ? '–' + loc.lines[1] : ''}`) : h('div', { class: 'note' }, 'No code location (the cause is not in the application source).'),
    codeBox,
    h('div', { class: 'dx-tc' }, h('span', { class: 'k' }, 'Explains'),
      shown.map((id) => h('button', { class: 'tcchip', title: 'Open in the test cases table', onclick: () => openCase(id) }, id)),
      g.testCaseIds.length > shown.length ? h('span', { class: 'note', title: g.testCaseIds.slice(shown.length).join(', ') }, `+${g.testCaseIds.length - shown.length} more`) : null),
    h('details', { class: 'more' }, h('summary', {}, 'Root cause, evidence and suggested fix'),
      g.items.map((x) => h('div', { class: 'more-item' },
        g.items.length > 1 ? h('div', { class: 'body' }, h('strong', {}, `${x.id}: `), x.summary) : h('div', { class: 'body' }, x.summary),
        h('div', { class: 'body' }, h('strong', {}, 'Root cause: '), x.rootCause || ''),
        x.evidence.length ? h('ul', { class: 'ev' }, x.evidence.map((e) => h('li', {}, h('strong', {}, e.source + ': '), e.detail))) : null,
        x.suggestedFix ? h('div', { class: 'body' }, h('strong', {}, 'Suggested fix: '), x.suggestedFix) : null))));
  if (loc) loadExcerpt(d.execId, loc, codeBox);
  return card;
}

async function loadExcerpt(execId, loc, box) {
  const key = `${state.runId}/${execId}/${loc.file}/${loc.lines.join('-')}`;
  let x = state.excerpts.get(key);
  if (x === undefined) {
    box.replaceChildren(h('div', { class: 'note' }, 'Loading code…'));
    try {
      x = await api(`/api/excerpt?run=${encodeURIComponent(state.runId)}&exec=${execId}&file=${encodeURIComponent(loc.file)}&from=${loc.lines[0]}&to=${loc.lines[1]}`);
    } catch { x = null; }
    state.excerpts.set(key, x);
  }
  if (!x) { box.replaceChildren(h('div', { class: 'note' }, 'Code excerpt not available (the source tree could not be rebuilt).')); return; }
  box.replaceChildren(h('div', { class: 'code' }, x.lines.map((t, i) => {
    const n = x.from + i;
    return h('div', { class: `ln${n >= x.mark[0] && n <= x.mark[1] ? ' hot' : ''}` }, h('span', { class: 'no' }, String(n)), h('span', { class: 'tx' }, t || ' '));
  })));
}

// ------------------------------------------------------------------ log

function logClass(t) {
  if (t.startsWith('$ ')) return 'cmd';
  if (t.startsWith('-- ') || t.startsWith('== ')) return 'sep';
  if (/\b(error|failed|exception)\b|✘|ERR_/i.test(t)) return 'err';
  return '';
}

function renderLog(full = false) {
  const box = $('#log');
  const src = state.logSource;
  if (src !== 'job') return;
  const lines = state.replay ? state.logs.replay : state.logs.live;
  if (state.logPaused) return;
  if (full || box.dataset.mode !== (state.replay ? 'r' : 'l')) {
    box.replaceChildren();
    box.dataset.mode = state.replay ? 'r' : 'l';
    box.dataset.n = '0';
    if (state.replay) box.append(h('div', { class: 'sep' }, `-- Replay of run ${state.runId}: lines below are made from the recorded files, not live output`));
  }
  let n = Number(box.dataset.n || 0);
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  if (lines.length < n) { box.replaceChildren(); n = 0; }
  for (; n < lines.length; n++) box.append(h('div', { class: logClass(lines[n].text) }, lines[n].text || ' '));
  box.dataset.n = String(n);
  while (box.children.length > 1600) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

function renderLogSources(v) {
  const sel = $('#log-source');
  const opts = [['job', state.replay ? 'Replay log' : 'Dashboard job output']];
  if (v && !state.replay) for (const e of v.executions) for (const [n, l] of [['playwright', 'tests'], ['backend', 'backend']]) opts.push([`${e.execId}/${n}`, `${e.execId} ${e.kind === 'golden' ? 'correct' : e.label} · ${l} log`]);
  const sig = JSON.stringify(opts);
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  sel.replaceChildren(...opts.map(([v2, l]) => h('option', { value: v2 }, l)));
  sel.value = opts.some(([v2]) => v2 === state.logSource) ? state.logSource : 'job';
  state.logSource = sel.value;
}

async function loadFileLog() {
  const [exec, name] = state.logSource.split('/');
  const box = $('#log');
  try {
    const { lines } = await api(`/api/log?run=${encodeURIComponent(state.runId)}&exec=${exec}&name=${name}`);
    box.dataset.mode = 'f';
    box.replaceChildren(...lines.map((t) => h('div', { class: logClass(t) }, t || ' ')));
    box.scrollTop = box.scrollHeight;
  } catch (e) { box.replaceChildren(h('div', { class: 'err' }, `No log: ${e.message}`)); }
}

// ------------------------------------------------------------------ job state

function renderTimer() {
  const j = state.job;
  const el = $('#timer-v');
  el.textContent = j?.state === 'running' && j.startedAt ? fmtDur(Date.now() - j.startedAt) : '';
}

function renderJob() {
  const j = state.job;
  const el = $('#job');
  const running = j?.state === 'running';
  el.hidden = !j;
  $('#btn-stop').hidden = !running;
  if (j) {
    const text = `${j.title}${running ? '' : ' · ' + j.state}`;
    el.replaceChildren(...(running ? [h('span', { class: 'pulse' })] : []), h('span', { class: 'job-t' }, text));
    el.title = text;
    el.className = `job ${running ? 'running' : j.state === 'done' ? 'done' : 'failed'}`;
  }
  renderTimer();
  $('#btn-new-menu').disabled = running;
  $('#btn-new').disabled = running;
  $('#btn-demo').disabled = running;
  $('#btn-continue').hidden = !canContinue(cur());
  const c2 = $('#btn-continue2'); if (c2) c2.hidden = !canContinue(cur());
  $('#btn-replay').disabled = !state.runId || running;
  if (cur()) renderExecControls(cur());
}

// ------------------------------------------------------------------ whole page

function render() {
  const v = cur();
  $('#empty').hidden = !!state.runId;
  $('#run-body').hidden = !state.runId || !v;
  $('#run-body').style.display = state.runId && v ? 'flex' : 'none';
  $('#btn-replay').disabled = !state.runId || state.job?.state === 'running';
  renderHeader(v);
  renderLogSources(v);
  $('#btn-continue').hidden = !canContinue(v);
  if (!v) return;
  renderStepper(v);
  void renderDemo(v);
  renderSummary(v);
  renderTiles(v);
  renderReq(v);
  renderCases(v);
  renderScripts(v);
  renderExec(v);
  renderDiag(v);
  renderLog();
}

// ------------------------------------------------------------------ runs, SSE

async function refreshRuns() {
  const r = await api('/api/runs');
  state.runs = r.runs; state.targets = r.targets;
  renderPicker();
}

function connect() {
  state.es?.close();
  const es = new EventSource(`/events?run=${encodeURIComponent(state.runId || '')}`);
  state.es = es;
  es.addEventListener('view', (e) => {
    const v = JSON.parse(e.data);
    if (v.run.id !== state.runId) return;
    state.live = v;
    if (!state.replay) render();
  });
  es.addEventListener('job', (e) => {
    const prev = state.job;
    state.job = JSON.parse(e.data);
    renderJob();
    if (state.job?.runId && !state.runId && !state.replay) openRun(state.job.runId);
    else if (state.job?.runId && state.job.target && state.runId !== state.job.runId && prev && !prev.runId && !state.replay) openRun(state.job.runId);
    if (prev?.state === 'running' && state.job?.state !== 'running') refreshRuns();
  });
  es.addEventListener('log', (e) => {
    const l = JSON.parse(e.data);
    if (state.logs.live.length && state.logs.live[state.logs.live.length - 1].n >= l.n) return;
    state.logs.live.push(l);
    if (state.logs.live.length > 3000) state.logs.live.splice(0, 500);
    if (!state.replay) renderLog();
  });
}

async function openRun(id, { push = true } = {}) {
  if (state.replay) exitReplay(false);
  state.runId = id || null;
  state.live = null;
  dxChoice = null;
  resetLists();
  $('#stepper').replaceChildren();
  state.logSource = 'job';
  if (push) history.replaceState(null, '', id ? `#run=${encodeURIComponent(id)}` : '#');
  renderPicker();
  connect();
  if (id) {
    try {
      state.live = await api(`/api/run/${encodeURIComponent(id)}`);
      loadVariants(state.live.run.target);
    } catch (e) { toast(`Cannot open run: ${e.message}`); state.runId = null; }
  }
  render();
  renderJob();
}

async function loadVariants(target) {
  try { state.variants = (await api(`/api/variants?target=${encodeURIComponent(target)}`)).variants; } catch { state.variants = []; }
  const sel = $('#sel-variant');
  sel.replaceChildren(h('option', { value: '' }, 'Pick a variant…'));
  for (const [group, label] of [['draw', 'Evaluation draw'], ['dev', 'Development set']]) {
    const vs = state.variants.filter((x) => x.group === group);
    if (!vs.length) continue;
    sel.append(h('optgroup', { label }, vs.map((x) => h('option', { value: x.value }, x.id))));
  }
}

// ------------------------------------------------------------------ replay

function startReplay() {
  if (!state.live) return;
  const plan = planReplay(state.live);
  if (plan.total === 0) { toast('This run has no finished stages to replay.'); return; }
  state.replay = { plan, base: state.live, startedReal: Date.now(), offset: 0, speed: Number($('#replay-speed').value), paused: false, view: null };
  state.logs.replay = [];
  state.prevReplayView = null;
  dxChoice = null;
  resetLists();
  $('#replay-bar').hidden = false;
  $('#replay-title').textContent = `Replay of run ${state.runId}.`;
  $('#replay-pause').textContent = 'Pause';
  $('#log').dataset.mode = '';
  stepReplay();
}

function replayT() {
  const r = state.replay;
  return Math.min(r.plan.total, r.offset + (r.paused ? 0 : (Date.now() - r.startedReal) * r.speed));
}

function stepReplay() {
  const r = state.replay;
  if (!r) return;
  const t = replayT();
  r.view = viewAt(r.base, r.plan, t);
  logTransitions(state.prevReplayView, r.view);
  state.prevReplayView = r.view;
  $('#replay-fill').style.width = `${(100 * t) / r.plan.total}%`;
  if (t >= r.plan.total && !r.paused) { r.offset = r.plan.total; r.paused = true; $('#replay-pause').textContent = 'Played'; }
  render();
}

function logTransitions(a, b) {
  const add = (text) => state.logs.replay.push({ n: state.logs.replay.length + 1, text: `[replay] ${text}` });
  for (const s of b.stages) {
    const was = a?.stages.find((x) => x.key === s.key)?.status ?? 'pending';
    if (was !== s.status && s.status !== 'pending') add(`${s.label}: ${s.status === 'running' ? 'started' : s.status}`);
  }
  for (const e of b.executions) {
    const was = a?.executions.find((x) => x.execId === e.execId);
    const name = e.kind === 'golden' ? 'correct version' : e.label;
    if (!was) add(`${e.execId} (${name}): execution started`);
    else if (was.executeStatus !== e.executeStatus && e.executeStatus === 'done') add(`${e.execId} (${name}): ${e.passed} passed, ${e.failed + e.errored} failed`);
    if ((was?.analyzeStatus ?? 'pending') !== e.analyzeStatus && e.analyzeStatus !== 'pending') add(`${e.execId} (${name}): diagnosis ${e.analyzeStatus === 'running' ? 'started' : 'done'}`);
  }
}

function exitReplay(redraw = true) {
  state.replay = null;
  state.prevReplayView = null;
  $('#replay-bar').hidden = true;
  $('#log').dataset.mode = '';
  resetLists();
  dxChoice = null;
  if (redraw) render();
}

// ------------------------------------------------------------------ results tab

const OUTCOME = {
  C: ['Caught, genuine', 'c-green'], A: ['Caught by accident', 'c-amber'], a: ['Equivalent mutant', 'c-grey'],
  b: ['Not reached', 'c-slate'], c: ['Reached, not checked', 'c-red'], d: ['Masked', 'c-blue'],
};

function md(text) {
  const frag = document.createDocumentFragment();
  String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/).forEach((p) => {
    if (p.startsWith('`')) frag.append(h('code', {}, p.slice(1, -1)));
    else if (p.startsWith('**')) frag.append(h('strong', {}, p.slice(2, -2)));
    else if (p) frag.append(p);
  });
  return frag;
}

function mdTableEl(t) {
  if (!t) return h('div', { class: 'note' }, 'Not found in the score files.');
  return h('div', { class: 'tbl-wrap', style: 'max-height:none' }, h('table', {},
    h('thead', {}, h('tr', {}, t.headers.map((x) => h('th', {}, md(x))))),
    h('tbody', {}, t.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, md(c))))))));
}

const rateRow = (k, rate, fmt = pct) => [k, rate ? `${fmt(rate.mean)}  (range ${fmt(rate.min)} – ${fmt(rate.max)})` : '–'];

async function renderResults() {
  const root = $('#view-results');
  root.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  let r;
  try { r = await api('/api/results'); } catch (e) {
    root.replaceChildren(h('section', { class: 'card hero' }, h('h1', {}, 'No results yet'), h('p', {}, `Could not read scoring/out/scores.json (${e.message}).`)));
    return;
  }
  const m = r.rates.mutationScoreRaw;
  const nSuites = m.n;
  const codeVariants = r.suites[0]?.counts?.codeVariants ?? 12;
  const genuine = r.sensitivity?.rows.find((x) => /genuine/i.test(x[0]));
  const outcomes = (r.whyNot?.rows ?? []).map((row) => ({ letter: row[0].split(':')[0].trim(), cells: Number(row[1]) || 0 }));
  const get = (l) => outcomes.find((o) => o.letter === l)?.cells ?? 0;
  const missed = get('a') + get('b') + get('c') + get('d');
  // Accidental catches (A) are also counted under their true cause (a or b), so they are not added again.
  const bars = outcomes.filter((o) => o.letter !== 'A');
  const totalCells = bars.reduce((a, o) => a + o.cells, 0);

  const lead = h('div', { class: 'res-lead' },
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Bug detection'), h('span', { class: 'sub' }, `${codeVariants} code bugs planted per suite · ${nSuites} independent suites`)),
      h('div', { class: 'card-b' },
        h('div', { style: 'display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap' },
          h('div', { class: 'big' }, pct(m.mean)),
          h('div', { class: 'note', style: 'padding-bottom:6px' }, `mean mutation score, range ${pct(m.min)} to ${pct(m.max)}, SD ${pct(m.sd)}`)),
        h('div', { style: 'display:flex;gap:8px;margin:14px 0;flex-wrap:wrap' }, m.values.map((v, i) => h('span', { class: 'badge pending', style: 'color:var(--text-2)' }, `Suite ${i + 1}: ${pct(v)}`))),
        genuine ? h('div', { class: 'kv', style: 'margin-bottom:14px' }, h('span', { class: 'k' }, 'Genuine catches only (accidental catches removed)'), h('span', { class: 'v' }, String(genuine[4] ?? genuine[1]).replace(/\*/g, ''))) : null,
        h('div', { class: 'finding' }, 'Main finding: agents reach the code but miss specific checks.'),
        h('div', { class: 'note', style: 'margin-top:10px' }, `${r.caughtByNoSuite.length} of ${codeVariants} bugs were caught by no suite (${r.caughtByNoSuite.join(', ')}). Detection is low; what the agent does well is naming the cause once a test fails.`))),
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Why bugs were missed'), h('span', { class: 'sub' }, `${totalCells} bug-suite cells`)),
      h('div', { class: 'card-b' },
        outcomes.length ? [
          h('div', { class: 'progress', style: 'height:18px' }, bars.map((o) => h('span', { class: OUTCOME[o.letter]?.[1] || 'c-grey', style: `width:${(100 * o.cells) / Math.max(1, totalCells)}%`, title: `${OUTCOME[o.letter]?.[0] ?? o.letter}: ${o.cells}` }))),
          h('div', { class: 'legend' }, bars.map((o) => h('span', {}, h('i', { class: OUTCOME[o.letter]?.[1] || 'c-grey' }), `${OUTCOME[o.letter]?.[0] ?? o.letter}: ${o.cells}`))),
          get('A') ? h('div', { class: 'note', style: 'margin-top:6px' }, `${get('A')} more cells were caught by accident (a test failed for an unrelated reason); they are counted under their true cause.`) : null,
          h('p', { style: 'font-weight:500;margin:16px 0 0' }, `Of ${missed} cells without a real catch, `, h('strong', {}, `${get('c')} (${Math.round((100 * get('c')) / Math.max(1, missed))}%)`), ' were reached by a passing script that never checked the changed behaviour. ', `${get('b')} were not reached at all.`),
        ] : mdTableEl(r.whyNot))));

  const tiles = h('div', { class: 'tiles' },
    tile(pct(r.rates.codeClassification.mean, 0), 'Classification right, caught bugs'),
    tile(pct(r.rates.codeFile.mean, 0), 'File right, caught bugs'),
    tile(pct(r.rates.codeLine.mean, 0), 'Line within ±5, caught bugs'),
    tile(pct(r.rates.envDetection.mean, 0), 'Environment faults detected', 'green'),
    tile(pct(r.rates.envClassification.mean, 0), 'Environment faults: classification right', 'green'),
    tile(pct(r.goldenFalseAlarm.mean, 0), 'Golden false-alarm rate'));

  const perVersion = h('table', {},
    h('thead', {}, h('tr', {}, ['Version', 'Kind', 'Caught in', 'Per suite', 'Class', 'File', 'Line ±5'].map((x) => h('th', {}, x)))),
    h('tbody', {}, r.variants.map((v) => h('tr', {},
      h('td', { class: 'id' }, v.version), h('td', {}, v.kind),
      h('td', {}, `${v.caughtInSuites} of ${nSuites}`),
      h('td', {}, h('span', { class: 'dots' }, v.caught.map((c) => h('span', { class: `dot ${c ? 'y' : 'n'}` })))),
      h('td', {}, h('span', { class: 'dots' }, v.classCorrect.map((c, i) => h('span', { class: `dot ${v.caught[i] && c ? 'y' : 'n'}` })))),
      h('td', {}, h('span', { class: 'dots' }, v.fileCorrect.map((c, i) => h('span', { class: `dot ${v.caught[i] && c ? 'y' : 'n'}` })))),
      h('td', {}, h('span', { class: 'dots' }, v.lineCorrect.map((c, i) => h('span', { class: `dot ${v.caught[i] && c ? 'y' : 'n'}` }))))))));

  const kv = (rows) => h('div', { class: 'kv' }, rows.flatMap(([k, v]) => [h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)]));
  const cost = h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('h2', {}, 'Cost and time')),
    h('div', { class: 'card-b' }, kv([
      rateRow('Analysis cost per suite', r.cost.analysisCostUsd, (v) => usd(v, 3)),
      ['Analysis time per suite (sum of groups)', `${fmtDur(r.cost.analysisMs.mean)}  (range ${fmtDur(r.cost.analysisMs.min)} – ${fmtDur(r.cost.analysisMs.max)})`],
      ['Execution time per version (cloud task)', `${fmtDur(r.cost.executionMsMean.mean)}  (range ${fmtDur(r.cost.executionMsMean.min)} – ${fmtDur(r.cost.executionMsMean.max)})`],
    ])));
  const conf = r.confusion;
  const classes = ['app_defect', 'environment_issue', 'test_defect'];
  const diag = h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('h2', {}, 'Diagnosis accuracy'), h('span', { class: 'sub' }, 'expected (rows) vs highest-confidence diagnosis (columns), caught versions only')),
    h('div', { class: 'card-b' },
      h('table', {}, h('thead', {}, h('tr', {}, [h('th', {}, 'Expected'), ...classes.map((c) => h('th', { class: 'num' }, CLASS_TEXT[c]))])),
        h('tbody', {}, Object.keys(conf).map((row) => h('tr', {}, h('td', {}, CLASS_TEXT[row] || row), ...classes.map((c) => h('td', { class: 'num' }, String(conf[row][c] ?? 0))))))),
      h('div', { style: 'margin-top:14px' }, kv([
        rateRow('Classification right (code bugs, caught)', r.rates.codeClassification),
        rateRow('File right', r.rates.codeFile), rateRow('Line within ±5', r.rates.codeLine),
        rateRow('Environment faults detected', r.rates.envDetection), rateRow('Environment classification right', r.rates.envClassification),
      ])),
      h('h3', { style: 'margin:18px 0 8px;font-size:15px' }, 'Genuine catches only (accidental catches removed)'), mdTableEl(r.sensitivity),
      r.ablation ? [h('h3', { style: 'margin:18px 0 8px;font-size:15px' }, 'Analyzer with tools vs without tools'), mdTableEl(r.ablation)] : null));

  const bugs = h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('h2', {}, 'Real bugs found in the target apps'), h('span', { class: 'sub' }, 'not planted: found while testing')),
    h('div', {}, (r.realBugs?.rows ?? []).map((row) => h('div', { class: 'bug' },
      h('div', { class: 'b-h' }, `#${row[0]} · `, md(row[1])), h('div', { class: 'b-t' }, md(row[2])), h('div', { class: 'note', style: 'margin-top:4px' }, 'Found by: ', md(row[3]))))));

  root.replaceChildren(lead, tiles,
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Per version'), h('span', { class: 'sub' }, 'a green square means yes; one square per suite')), h('div', { class: 'tbl-wrap', style: 'max-height:none' }, perVersion)),
    h('div', { class: 'grid2' }, diag, h('div', { style: 'display:flex;flex-direction:column;gap:20px' }, cost, bugs)),
    h('div', { class: 'note' }, `Read from scoring/out/scores.json. Protocol hash ${r.protocolSha256.slice(0, 12)}…. Warnings: ${r.warnings.length ? r.warnings.join(' ') : 'none'}`));
}

// ------------------------------------------------------------------ theme and menus

const storedTheme = () => { try { const t = localStorage.getItem('theme'); return t === 'light' || t === 'dark' ? t : null; } catch { return null; } };
const systemTheme = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const applyTheme = (t) => { document.documentElement.dataset.theme = t; };
function setThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const b = $('#btn-theme');
  b.replaceChildren(svg(dark ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' : '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', 17));
  b.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('theme', next); } catch { /* the choice just is not remembered */ }
  setThemeButton();
}

function wireMenus() {
  const pairs = [['#btn-new-menu', '#menu-new'], ['#btn-info', '#pop-info']];
  const closeAll = () => pairs.forEach(([b, m]) => { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); });
  for (const [b, m] of pairs) {
    $(b).addEventListener('click', (e) => {
      e.stopPropagation();
      const open = $(m).hidden;
      closeAll();
      $(m).hidden = !open;
      $(b).setAttribute('aria-expanded', String(open));
    });
    if (m === '#menu-new') $(m).addEventListener('click', closeAll);
    else $(m).addEventListener('click', (e) => e.stopPropagation());
  }
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeAll());
}

// ------------------------------------------------------------------ wiring

function setTab(name) {
  state.tab = name;
  $('#tab-run').setAttribute('aria-selected', String(name === 'run'));
  $('#tab-results').setAttribute('aria-selected', String(name === 'results'));
  $('#view-run').hidden = name !== 'run';
  $('#view-results').hidden = name !== 'results';
  if (name === 'results') renderResults();
}

async function start(body) {
  try {
    const j = await api('/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    state.job = j;
    renderJob();
    if (j.runId && j.runId !== state.runId) openRun(j.runId);
  } catch (e) { toast(e.message); }
}

function wire() {
  $('#tab-run').onclick = () => setTab('run');
  $('#tab-results').onclick = () => setTab('results');
  $('#run-picker').onchange = (e) => openRun(e.target.value);
  $('#btn-stop').onclick = () => api('/api/stop', { method: 'POST' }).catch((e) => toast(e.message));
  const newDlg = $('#dlg-new');
  const openNew = () => {
    $('#new-target').replaceChildren(...state.targets.map((t) => h('option', { value: t }, t)));
    newDlg.showModal();
  };
  $('#btn-new').onclick = openNew;
  $('#empty-new').onclick = openNew;
  $('#form-new').addEventListener('close', () => {});
  newDlg.addEventListener('close', () => {
    if (newDlg.returnValue === 'ok') start({ action: 'all', target: $('#new-target').value, fresh: true });
    newDlg.returnValue = '';
  });
  $('#empty-latest').onclick = () => state.runs[0] && openRun(state.runs[0].id);
  wireMenus();
  $('#btn-theme').onclick = toggleTheme;
  setThemeButton();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!storedTheme()) { applyTheme(systemTheme()); setThemeButton(); } });
  $('#btn-continue').onclick = continueRun;
  $('#btn-continue2').onclick = continueRun;
  const demoDlg = $('#dlg-demo');
  $('#btn-demo').onclick = () => { $('#demo-target').replaceChildren(...state.targets.map((t) => h('option', { value: t }, t))); demoDlg.showModal(); };
  demoDlg.addEventListener('close', () => {
    if (demoDlg.returnValue === 'ok') start({ action: 'demo-new', target: $('#demo-target').value });
    demoDlg.returnValue = '';
  });
  $('#btn-replay').onclick = startReplay;
  $('#replay-exit').onclick = () => exitReplay();
  $('#replay-restart').onclick = () => {
    const r = state.replay; if (!r) return;
    r.offset = 0; r.startedReal = Date.now(); r.paused = false; state.logs.replay = []; state.prevReplayView = null;
    $('#replay-pause').textContent = 'Pause'; $('#log').dataset.mode = '';
    resetLists(); stepReplay();
  };
  $('#replay-pause').onclick = () => {
    const r = state.replay; if (!r || r.offset >= r.plan.total) return;
    if (r.paused) { r.startedReal = Date.now(); r.paused = false; $('#replay-pause').textContent = 'Pause'; }
    else { r.offset = replayT(); r.paused = true; $('#replay-pause').textContent = 'Resume'; }
  };
  $('#replay-speed').onchange = (e) => {
    const r = state.replay; if (!r) return;
    r.offset = replayT(); r.startedReal = Date.now(); r.speed = Number(e.target.value);
  };

  $('#chk-buggy').onchange = () => renderExecControls(cur());
  $('#btn-run-golden').onclick = () => {
    if (!state.runId) return;
    const analyze = $('#chk-analyze').checked;
    if (!$('#chk-buggy').checked) return start({ action: 'execute', run: state.runId, analyze });
    const variant = $('#sel-variant').value;
    if (!variant) return toast('Pick a buggy version first.');
    const id = variant.slice(variant.lastIndexOf(':') + 1);
    const dlg = $('#dlg-buggy');
    $('#buggy-text').textContent = `This runs the scripts against version ${id} on run ${state.runId}.${analyze ? ' Its failures are then diagnosed (model calls).' : ''}`;
    dlg.addEventListener('close', () => {
      if (dlg.returnValue === 'ok') start({ action: 'execute', run: state.runId, analyze, variant, confirm: true, alsoGolden: !state.live.executions.some((e) => e.kind === 'golden') });
      dlg.returnValue = '';
    }, { once: true });
    dlg.showModal();
  };

  $('#log-h').onclick = (e) => {
    if (e.target.closest('select,button')) return;
    $('#log-card').classList.toggle('collapsed');
    $('#log-wrap').hidden = $('#log-card').classList.contains('collapsed');
  };
  $('#log-pause').onclick = () => {
    state.logPaused = !state.logPaused;
    $('#log-pause').textContent = state.logPaused ? 'Resume' : 'Pause';
    if (!state.logPaused) renderLog(true);
  };
  $('#log-source').onchange = (e) => {
    state.logSource = e.target.value;
    if (state.logSource === 'job') renderLog(true); else loadFileLog();
  };
}

async function init() {
  wire();
  await refreshRuns().catch((e) => toast(e.message));
  const m = /run=([^&]+)/.exec(location.hash);
  await openRun(m ? decodeURIComponent(m[1]) : null, { push: false });
  if (location.hash.includes('results')) setTab('results');
  if (/replay/.test(location.search)) startReplay();
  // timers: live stage clocks tick every 500 ms; a replay recomputes its view
  setInterval(() => {
    if (state.replay) { if (!state.replay.paused) stepReplay(); return; }
    const v = state.live;
    if (v && v.stages.some((s) => s.status === 'running')) { renderStepper(v); renderHeader(v); renderSummary(v); }
    renderTimer();
  }, 500);
  setInterval(() => { if (state.job?.state !== 'running') refreshRuns().catch(() => {}); }, 15000);
}
init();
