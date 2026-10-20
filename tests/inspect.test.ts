import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectStage } from '../src/modules/inspect.js';

const jsonl = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

async function runWithTranscripts(files: Record<string, unknown[]>) {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'inspect-'));
  const dir = path.join(runsDir, 'fake-20261024-100000', 'transcripts');
  await mkdir(dir, { recursive: true });
  for (const [name, events] of Object.entries(files)) await writeFile(path.join(dir, name), jsonl(events));
  return runsDir;
}

const casesSession = (task: string, submits: unknown[], ok: boolean) => [
  { type: 'start', purpose: 'cases', task },
  ...submits.flatMap((s) => [
    { type: 'response', content: [{ type: 'tool_call', name: 'submit_test_cases' }], reasoning: 'I think the id is stripped.', stopReason: 'tool_call' },
    s,
  ]),
  ok ? { type: 'end', ok: true } : { type: 'end', ok: false, error: 'AgentSubmitError: All 3 submit attempts were rejected' },
];

describe('inspectStage', () => {
  it('lists every session with its rejected submits, kinds and grouped problems', async () => {
    const runsDir = await runWithTranscripts({
      'cases-1.jsonl': casesSession('Write test cases for feature F-07.\n- REQ-028', [
        { type: 'submit', ok: false, kind: 'invalidInput', errors: ['testCases.0.expected.0.id: Invalid input', 'testCases.3.expected.1.id: Invalid input'] },
        { type: 'submit', ok: false, kind: 'checkFailed', errors: ['testCases[4].expected[1].value 403 is not found'] },
        { type: 'submit', ok: true },
      ], true),
      'cases-2.jsonl': casesSession('These requirements of feature F-07 got no test case and no decline yet.', [
        { type: 'submit', ok: false, errors: ['testCases.1.preconditions: Invalid input: expected array'] },
      ], false),
      'prd-1.jsonl': [{ type: 'start', purpose: 'prd' }, { type: 'end', ok: true }],
    });
    const lines = await inspectStage({ stage: 'cases', runsDir });
    expect(lines[0]).toBe('Run fake-20261024-100000, stage cases: 2 session(s) in the latest run');
    expect(lines).toContain('#1 cases-1.jsonl: F-07; 3 turns; ok');
    expect(lines).toContain('  submit 1: rejected, invalid input (2 problems)');
    expect(lines).toContain('    - testCases.*.expected.*.id: Invalid input ×2');
    expect(lines).toContain('  submit 2: rejected, failed checks (1 problem)');
    expect(lines).toContain('  submit 3: accepted');
    expect(lines).toContain('#2 cases-2.jsonl: F-07 (gap round); 1 turns; FAILED (AgentSubmitError: All 3 submit attempts were rejected)');
    // An older transcript without a recorded kind: told apart by the schema wording.
    expect(lines).toContain('  submit 1: rejected, invalid input (1 problem)');
    expect(lines.join('\n')).not.toContain('reasoning');
  });

  it('shows one session in full, with the reasoning of each turn', async () => {
    const runsDir = await runWithTranscripts({
      'cases-1.jsonl': casesSession('Write test cases for feature F-01.', [{ type: 'submit', ok: true }], true),
    });
    const lines = await inspectStage({ stage: 'cases', runsDir, session: 1 });
    expect(lines).toContain('  turn 1: calls submit_test_cases');
    expect(lines).toContain('    reasoning: I think the id is stripped.');
  });

  it('lists rejected recording tool calls for the PRD stage', async () => {
    const runsDir = await runWithTranscripts({
      'prd-1.jsonl': [
        { type: 'start', purpose: 'prd' },
        { type: 'response', content: [{ type: 'tool_call', name: 'add_ui_routes' }] },
        {
          type: 'tool_result',
          name: 'add_ui_routes',
          isError: true,
          content: 'Error: Batch rejected; nothing from it was stored.\n- uiRoutes[14]: /dashboard/* is listed twice\n- uiRoutes[15]: /dashboard/* is listed twice',
        },
        { type: 'end', ok: true },
      ],
    });
    const lines = await inspectStage({ stage: 'prd', runsDir });
    expect(lines).toContain('  tool add_ui_routes rejected: Error: Batch rejected; nothing from it was stored.');
    expect(lines).toContain('    - uiRoutes[*]: /dashboard/* is listed twice ×2');
  });

  it('shows only the latest run of the stage by default, and earlier runs with all', async () => {
    const runsDir = await runWithTranscripts({
      'cases-1.jsonl': casesSession('Write test cases for feature F-02.', [{ type: 'submit', ok: true }], true),
    });
    const previous = path.join(runsDir, 'fake-20261024-100000', 'transcripts', 'previous-20261024T090000Z');
    await mkdir(previous);
    await writeFile(path.join(previous, 'cases-1.jsonl'), jsonl(casesSession('Write test cases for feature F-09.', [{ type: 'submit', ok: true }], true)));
    const latest = await inspectStage({ stage: 'cases', runsDir });
    expect(latest[0]).toBe('Run fake-20261024-100000, stage cases: 1 session(s) in the latest run');
    expect(latest.join('\n')).not.toContain('F-09');
    const all = await inspectStage({ stage: 'cases', runsDir, all: true });
    expect(all[0]).toBe('Run fake-20261024-100000, stage cases: 1 session(s) in the latest run, 1 in earlier runs');
    expect(all).toContain('=== earlier run (previous-20261024T090000Z) ===');
    expect(all.indexOf('#1 cases-1.jsonl: F-09; 1 turns; ok')).toBeLessThan(all.indexOf('#1 cases-1.jsonl: F-02; 1 turns; ok'));
  });

    it('fails clearly when there are no transcripts for the stage', async () => {
    const runsDir = await runWithTranscripts({ 'prd-1.jsonl': [] });
    await expect(inspectStage({ stage: 'cases', runsDir })).rejects.toThrow(/No run with cases transcripts/);
  });
});
