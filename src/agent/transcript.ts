import { appendFile, mkdir, open, readdir, rename } from 'node:fs/promises';
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

  /**
   * Moves `<purpose>-<n>.jsonl` files left by an earlier run of the same stage into
   * `previous-<UTC timestamp>/`, so a rerun's sessions start again at 1 and never mix with the old ones.
   * Returns the folder, or null when there was nothing to move.
   */
  static async archive(dir: string, purpose: string, now: Date = new Date()): Promise<string | null> {
    const pattern = new RegExp(`^${purpose}-\\d+\\.jsonl$`);
    const old = (await readdir(dir).catch(() => [] as string[])).filter((f) => pattern.test(f));
    if (old.length === 0) return null;
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const target = path.join(dir, `previous-${stamp}`);
    await mkdir(target, { recursive: true });
    for (const f of old) await rename(path.join(dir, f), path.join(target, f));
    return target;
  }

  write(type: string, data: Record<string, unknown>): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n';
    this.queue = this.queue.then(() => appendFile(file, line, 'utf8'));
    return this.queue;
  }
}
