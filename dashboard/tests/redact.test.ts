import { describe, expect, it } from 'vitest';
import { redactLine, shortError } from '../redact.js';

// The shape of a real key-limit error; the key id is made up.
const REAL = 'LLMRequestError: 403 Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/0a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f6789 $0.70 of $0.70 used; does not reset.';

describe('shortError', () => {
  it('keeps the short message of the real key-limit error and nothing else', () => {
    expect(shortError(REAL)).toBe('LLMRequestError: 403 Key limit exceeded (total limit)');
  });
  it('removes key-like ids even without a link', () => {
    expect(shortError('Bad key sk-or-v1-abcdef0123456789abcdef0123456789 rejected')).toBe('Bad key rejected');
    expect(shortError('token 0a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f6789 invalid')).toBe('token invalid');
  });
  it('uses the first line and a length limit', () => {
    expect(shortError('Error: first\n    at stack line')).toBe('Error: first');
    expect(shortError('x'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(shortError(undefined)).toBe('');
  });
});

describe('redactLine', () => {
  it('hides external links and ids but keeps local addresses and paths', () => {
    const out = redactLine(REAL);
    expect(out).not.toMatch(/openrouter|0a1b2c3d/);
    expect(redactLine('Starting backend at http://localhost:3000/api/x')).toContain('http://localhost:3000/api/x');
    expect(redactLine('runs/mern-ecommerce-20261104-143721/executions/x-01')).toContain('mern-ecommerce-20261104-143721');
    expect(redactLine('$ npx tsx src/cli.ts agent cases --run mern-ecommerce-20261104-154332')).toContain('--run mern-ecommerce-20261104-154332');
  });
});
