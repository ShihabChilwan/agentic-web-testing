import { appendFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes one agent session to transcripts/<purpose>-<n>.jsonl, one JSON event
 * per line, in order. Contains model output (reasoning included) and tool
 * output; never configuration, keys or headers.
 */
export class Transcript {
  private queue: Promise<void> = Promise.resolve();

  private constructor(readonly file: string | undefined) {}

  /** A transcript that writes nothing (used when no transcript directory is given). */
  static none(): Transcript {
    return new Transcript(undefined);
  }

  /** Creates the next free <purpose>-<n>.jsonl. Safe when several sessions start at once. */
  static async create(dir: string, purpose: string): Promise<Transcript> {
    await mkdir(dir, { recursive: true });
    for (let n = 1; ; n++) {
      const file = path.join(dir, `${purpose}-${n}.jsonl`);
      try {
        const handle = await open(file, 'wx');
        await handle.close();
        return new Transcript(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  }

  write(type: string, data: Record<string, unknown>): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n';
    this.queue = this.queue.then(() => appendFile(file, line, 'utf8'));
    return this.queue;
  }
}
