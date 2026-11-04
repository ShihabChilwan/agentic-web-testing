// Replay of a finished run: the recorded files shown again in order, on a shortened clock.
// Pure functions of (view, time); the page labels everything it shows from here as a replay.

const MIN_MS = 4000;
const MAX_MS = 40 * 60 * 1000;
const clamp = (v) => Math.min(MAX_MS, Math.max(MIN_MS, v || 0));

/** The order things happened in: four generation stages, then each execution followed by its analysis. */
export function planReplay(view) {
  const segments = [];
  let at = 0;
  const add = (seg) => {
    segments.push({ ...seg, start: at, end: at + seg.dur });
    at += seg.dur;
  };
  for (const key of ['prd', 'cases', 'scripts', 'gaps']) {
    const st = view.stages.find((s) => s.key === key);
    if (st && st.status === 'done') add({ type: 'stage', key, dur: clamp(st.elapsedMs) });
  }
  const execs = view.executions
    .filter((e) => e.executeStatus === 'done')
    .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '') || a.execId.localeCompare(b.execId));
  for (const e of execs) {
    add({ type: 'exec', execId: e.execId, dur: clamp(e.durationMs) });
    if (e.analyzeStatus === 'done') add({ type: 'diag', execId: e.execId, dur: clamp(e.analysisMs || 2000) });
  }
  return { segments, total: at };
}

const frac = (seg, t) => (t <= seg.start ? 0 : t >= seg.end ? 1 : (t - seg.start) / seg.dur);

/** A copy of `view` as it looked `t` milliseconds into the replay. */
export function viewAt(view, plan, t) {
  const v = structuredClone(view);
  const seg = (type, key) => plan.segments.find((s) => s.type === type && (s.key === key || s.execId === key));
  const segsOf = (type) => plan.segments.filter((s) => s.type === type);

  // --- stages
  for (const st of v.stages) {
    st.runningSince = null;
    st.error = '';
    if (st.key === 'execute' || st.key === 'analyze') {
      const type = st.key === 'execute' ? 'exec' : 'diag';
      const ss = segsOf(type);
      if (ss.length === 0) continue;
      const started = ss.some((s) => t > s.start);
      const finished = ss.every((s) => t >= s.end);
      st.status = !started ? 'pending' : finished ? 'done' : 'running';
      st.elapsedMs = ss.reduce((a, s) => a + frac(s, t) * s.dur, 0);
      continue;
    }
    const s = seg('stage', st.key);
    if (!s) continue;
    st.status = t <= s.start ? 'pending' : t >= s.end ? 'done' : 'running';
    st.elapsedMs = frac(s, t) * s.dur;
  }
  const stageDone = (k) => v.stages.find((s) => s.key === k)?.status === 'done';
  v.run.workMs = v.stages.reduce((a, s) => a + (s.elapsedMs || 0), 0);

  // --- generation panels
  if (!stageDone('prd')) v.prd = null;
  if (!stageDone('cases')) {
    v.cases = { total: 0, api: 0, browser: 0, list: [], cost: null };
  }
  const sSeg = seg('stage', 'scripts');
  if (sSeg) {
    const n = Math.floor(frac(sSeg, t) * v.scripts.list.length);
    v.scripts.list = v.scripts.list.slice(0, n);
    const totals = { passed: 0, repaired: 0, suspected: 0, invalid: 0, pending: 0, total: v.cases.total };
    for (const s of v.scripts.list) totals[s.status] += 1;
    totals.pending = Math.max(0, totals.total - v.scripts.list.length);
    v.scripts.totals = totals;
  }
  if (!stageDone('gaps')) {
    v.coverage = null;
    // Reach is known only after the coverage stage; rows keep their endpoints without marks until then.
    if (v.prd) for (const e of [...(v.prd.otherEndpoints || []), ...(v.prd.featureRows || []).flatMap((r) => r.endpoints)]) e.reached = null;
  }

  // --- executions and diagnoses
  const visible = [];
  for (const e of v.executions) {
    const es = plan.segments.find((s) => s.type === 'exec' && s.execId === e.execId);
    const ds = plan.segments.find((s) => s.type === 'diag' && s.execId === e.execId);
    if (!es || t <= es.start) continue;
    const f = frac(es, t);
    if (f < 1) {
      const n = Math.round(f * e.total);
      const seq = (e.seq || '').slice(0, n);
      e.done = n;
      e.failed = [...seq].filter((c) => c === 'f').length;
      e.errored = [...seq].filter((c) => c === 'e').length;
      e.passed = n - e.failed - e.errored;
      e.executeStatus = 'running';
      e.finishedAt = null;
    }
    e.analyzeStatus = !ds || t <= ds.start ? 'pending' : t >= ds.end ? 'done' : 'running';
    visible.push(e);
  }
  v.executions = visible;
  v.diagnoses = v.diagnoses
    .map((d) => {
      const ds = plan.segments.find((s) => s.type === 'diag' && s.execId === d.execId);
      if (!ds || t <= ds.start) return null;
      return { ...d, items: d.items.slice(0, Math.ceil(frac(ds, t) * d.items.length)) };
    })
    .filter(Boolean);
  if (v.diagnoses.length === 0) v.run.mode = null;
  v.replay = { t, total: plan.total, finished: t >= plan.total };
  return v;
}
