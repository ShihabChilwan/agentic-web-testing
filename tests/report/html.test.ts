import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, renderReport } from '../../src/modules/report/html.js';
import { writeReport } from '../../src/modules/report/index.js';
import { buildRunView } from '../../src/modules/report/view-model.js';
import { EVIL, makeReportRun } from './fixture.js';

let run: Awaited<ReturnType<typeof makeReportRun>>;
let html: string;

beforeAll(async () => {
  run = await makeReportRun();
  const { file } = await writeReport({ runId: run.runId, runsDir: run.runsDir });
  html = await readFile(file, 'utf8');
});

afterAll(async () => {
  await rm(run.runsDir, { recursive: true, force: true });
});

describe('renderReport', () => {
  it('is one self-contained file: no external loads, a strict security policy, the data embedded', async () => {
    expect(path.basename((await writeReport({ runId: run.runId, runsDir: run.runsDir })).file)).toBe('report.html');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`);
    expect(CONTENT_SECURITY_POLICY).toMatch(/^default-src 'none';/);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(|@import/i);
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('escapes the data so text from files can never close the script element', async () => {
    expect(html).not.toContain(EVIL);
    expect(html.match(/<\/script>/g)).toHaveLength(2); // only the two real script elements end
    const json = /<script type="application\/json" id="run-view">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(await buildRunView(run.dir, new Date(JSON.parse(json).generatedAt)))));
  });

  it('renders in a browser with no errors and no requests, and shows hostile text as text', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(String(e)));
      page.on('console', (m) => (m.type() === 'error' ? problems.push(m.text()) : undefined));
      page.on('request', (r) => (r.url().startsWith('data:') || r.url().startsWith('file:') ? undefined : problems.push(`request ${r.url()}`)));
      await page.goto(`file://${path.join(run.dir, 'report.html')}`);
      // Overview: the suspected defect with expected and actual; its hostile title shown as text.
      const defect = page.getByRole('row', { name: /TC-004/ });
      expect(await defect.getByRole('cell').allTextContents()).toEqual([
        `TC-004: Non-admin cannot approve ${EVIL}`,
        expect.stringMatching(/^REQ-002: /),
        'E1 Response status is 403',
        '403',
        '200',
        'not reviewed',
      ]);
      expect(await page.getByRole('heading', { name: 'Suspected defects in golden (1)' }).count()).toBe(1);
      await page.getByRole('button', { name: 'Executions' }).click();
      await page.locator('select').selectOption('x-02');
      await page.getByRole('row', { name: /TC-001/ }).click();
      await expect.poll(() => page.getByText(EVIL, { exact: false }).count()).toBe(1);
      expect(await page.title()).not.toBe('pwned');
      expect(await page.locator('img[src="x"]').count()).toBe(0);
      expect(await page.locator('img[alt="Screenshot at the failure"]').getAttribute('src')).toMatch(/^data:image\/png;base64,/);
      await page.getByRole('button', { name: 'Compare' }).click();
      await page.locator('select').first().selectOption('x-01');
      await page.locator('select').nth(1).selectOption('x-02');
      await expect.poll(() => page.locator('tr.changed').count()).toBe(1);
      await page.locator('select').first().selectOption('x-02');
      await page.locator('select').nth(1).selectOption('x-01');
      await expect.poll(() => page.locator('tr.changed .badge.fixed').count()).toBe(1); // the reversed pair flips the kind
      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('renders a run without executions', () => {
    const view = { schemaVersion: '1.0', generatedAt: '2026-10-25T00:00:00.000Z', run: { runId: 'r', target: 't', generationRef: 'g', generationCommit: 'abc1234', createdAt: '2026-10-25T00:00:00.000Z', models: {}, upstreamProviders: [], playwrightVersion: null },
      stages: [], coverage: { requirements: 0, covered: 0, partial: 0, testCases: 0, scripts: { passed: 0, assertionFailed: 0, invalid: 0, none: 0 } }, requirements: [], executions: [], comparisons: {} } as const;
    expect(renderReport(view as never)).toContain('<title>Test report r</title>');
  });
});
