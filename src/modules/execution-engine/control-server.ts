import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { ScriptTestId } from '../../shared/schemas.js';

export interface ControlHandlers {
  /** Before a test: check the services and restore the data. */
  before(testId: string): Promise<void>;
  /** After a test and its other fixtures. */
  after(testId: string, outputDir: string): Promise<void>;
}

export interface ControlServer {
  /** Base URL for the suite (AWT_CONTROL_URL). */
  url: string;
  close(): Promise<void>;
}

const BeforeBody = z.strictObject({ testId: ScriptTestId });
const AfterBody = z.strictObject({ testId: ScriptTestId, outputDir: z.string().min(1) });

const MAX_BODY = 64 * 1024;

/**
 * The Execution Engine's control endpoint (SPEC §7.2): `POST /before` and `POST /after`, bound to
 * 127.0.0.1 only, on a random free port. Calls are handled one at a time, in the order they arrive.
 */
export async function startControlServer(handlers: ControlHandlers): Promise<ControlServer> {
  let queue: Promise<unknown> = Promise.resolve();
  const server = http.createServer((req, res) => {
    const reply = (status: number, text: string) => res.writeHead(status, { 'content-type': 'text/plain' }).end(text);
    if (req.method !== 'POST' || (req.url !== '/before' && req.url !== '/after')) return reply(404, 'not found');
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(400, 'body must be JSON');
      }
      const handle =
        req.url === '/before'
          ? () => {
              const parsed = BeforeBody.parse(body);
              return handlers.before(parsed.testId);
            }
          : () => {
              const parsed = AfterBody.parse(body);
              return handlers.after(parsed.testId, parsed.outputDir);
            };
      const done = queue.then(handle);
      queue = done.catch(() => undefined);
      done.then(
        () => reply(200, 'ok'),
        (err: unknown) => reply(err instanceof z.ZodError ? 400 : 500, err instanceof Error ? err.message : String(err)),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
