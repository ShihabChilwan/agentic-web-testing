import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * A file's content at a commit (`git show <commit>:<path>`), without touching the working tree,
 * which may hold a variant or a running app. Returns null when the file is not in that commit.
 */
export async function showFile(repoDir: string, commit: string, file: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoDir, 'show', `${commit}:${file}`], {
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch {
    return null;
  }
}
