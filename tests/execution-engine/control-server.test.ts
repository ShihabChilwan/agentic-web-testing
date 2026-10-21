import { afterEach, describe, expect, it } from 'vitest';
import { startControlServer, type ControlServer } from '../../src/modules/execution-engine/control-server.js';

let server: ControlServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const post = (path: string, body: unknown) =>
  fetch(`${server!.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('control server', () => {
  it('listens on 127.0.0.1 only and calls the handlers', async () => {
    const calls: string[] = [];
    server = await startControlServer({
      before: async (id) => void calls.push(`before ${id}`),
      after: async (id, dir) => void calls.push(`after ${id} ${dir}`),
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await post('/before', { testId: 'TC-001' })).status).toBe(200);
    expect((await post('/after', { testId: 'TC-001', outputDir: '/out' })).status).toBe(200);
    expect(calls).toEqual(['before TC-001', 'after TC-001 /out']);
  });

  it('handles calls one at a time, in order', async () => {
    const log: string[] = [];
    server = await startControlServer({
      before: async (id) => {
        log.push(`start ${id}`);
        await new Promise((resolve) => setTimeout(resolve, id === 'TC-001' ? 100 : 0));
        log.push(`end ${id}`);
      },
      after: async () => {},
    });
    await Promise.all([post('/before', { testId: 'TC-001' }), post('/before', { testId: 'TC-002' })]);
    expect(log).toEqual(['start TC-001', 'end TC-001', 'start TC-002', 'end TC-002']);
  });

  it('answers 400 for a bad body, 404 for other routes and 500 with the message when a handler throws', async () => {
    server = await startControlServer({
      before: async () => {
        throw new Error('restore exploded');
      },
      after: async () => {},
    });
    expect((await post('/before', { testId: '../etc' })).status).toBe(400);
    expect((await post('/after', { testId: 'TC-001' })).status).toBe(400);
    expect((await post('/restore-everything', {})).status).toBe(404);
    const failed = await post('/before', { testId: 'TC-001' });
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe('restore exploded');
  });
});
