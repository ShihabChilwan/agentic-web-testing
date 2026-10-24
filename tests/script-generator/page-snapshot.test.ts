import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { pageSnapshotOf } from '../../src/modules/script-generator/dry-run.js';

// A real error-context.md written by Playwright 1.64.0 for a failed ui dry run (tests/fixtures/playwright-errors/).
const recorded = await readFile(new URL('../fixtures/playwright-errors/error-context-1.64.0.md', import.meta.url), 'utf8');

describe('page snapshot of a failed dry run', () => {
  it('reads the page snapshot YAML without element refs and cursor marks', () => {
    const snapshot = pageSnapshotOf(recorded)!;
    expect(snapshot.startsWith('- generic:\n  - banner:')).toBe(true);
    expect(snapshot).toContain('heading "MERN Store" [level=1]');
    expect(snapshot).toContain('textbox "Search Products"');
    expect(snapshot).not.toMatch(/\[ref=e\d+\]|\[cursor=pointer\]/);
    expect(snapshot).not.toContain('# Test source'); // stops at the end of the YAML block
  });

  it('also reads the bare yaml block Playwright writes after the error details, with no heading', async () => {
    const bare = await readFile(new URL('../fixtures/playwright-errors/error-context-bare-1.64.0.md', import.meta.url), 'utf8');
    const snapshot = pageSnapshotOf(bare)!;
    expect(snapshot.startsWith('- banner:')).toBe(true);
    expect(snapshot).toContain('- text: Email Address\n  - textbox "Please Enter Your Email"'); // plain text, not a label
    expect(snapshot).not.toContain('# Test source');
    // A yaml block inside the test source never counts.
    expect(pageSnapshotOf('# Error details\n\n```\nError: E1\n```\n\n# Test source\n\n```yaml\n- not: a snapshot\n```\n')).toBeNull();
  });

  it('cuts a long snapshot and says so, and returns null without one', () => {
    const cut = pageSnapshotOf(recorded, 200)!;
    expect(cut).toMatch(/\n\[… snapshot cut at 200 characters\]$/);
    expect(pageSnapshotOf('# Instructions\n\n# Error details\n\n```\nError: E1\n```\n')).toBeNull();
  });
});
