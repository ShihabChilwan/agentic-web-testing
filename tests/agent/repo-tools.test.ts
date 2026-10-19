import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRepoTools, MAX_READ_LINES, MAX_SEARCH_HITS, resolveInRepo } from '../../src/agent/tools/repo-tools.js';
import type { RepoScope } from '../../src/agent/tools/repo-tools.js';

let scope: RepoScope;
let outside: string;

async function put(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

beforeAll(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'repo-tools-'));
  const root = path.join(base, 'repo');
  outside = path.join(base, 'outside');
  await put(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
  await put(path.join(root, 'README.md'), '# Shop\nA demo shop.\n');
  await put(path.join(root, 'server', 'routes', 'auth.js'), 'router.post("/login", login);\nrouter.post("/register", register);\n');
  await put(path.join(root, 'server', 'models', 'user.js'), 'const User = {};\n');
  await put(path.join(root, 'client', 'app', 'deep', 'deeper', 'deepest', 'x.js'), 'deep\n');
  await put(path.join(root, 'client', 'board.pe.js'), 'router.post("/pro", pro);\n');
  await put(path.join(root, 'big.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  await put(path.join(root, 'many.js'), Array.from({ length: 80 }, () => 'router.post("/x", x);').join('\n'));
  await put(path.join(root, '.env.example'), 'JWT_SECRET=\n');
  await put(path.join(root, '.git', 'config'), '[core]\nrouter.post\n');
  await put(path.join(root, 'node_modules', 'lib', 'index.js'), 'router.post("/lib", lib);\n');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link-out.txt'));
  await symlink(outside, path.join(root, 'dir-out'));
  await symlink(path.join(root, '.git', 'config'), path.join(root, 'git-link'));
  await symlink(path.join(root, 'README.md'), path.join(root, 'readme-link.md'));
  scope = { root, forbiddenPaths: ['**/*.pe.*', '**/*.pe/**'] };
});

const tools = () => {
  const [listFiles, readFile, searchCode] = createRepoTools(scope);
  return {
    list: (input: Record<string, unknown>) => listFiles.run(listFiles.input.parse(input)),
    read: (input: Record<string, unknown>) => readFile.run(readFile.input.parse(input)),
    search: (input: Record<string, unknown>) => searchCode.run(searchCode.input.parse(input)),
  };
};

describe('resolveInRepo', () => {
  it.each([
    ['../outside/secret.txt', /\.\./],
    ['server/../../outside/secret.txt', /\.\./],
    ['/etc/passwd', /relative/],
    ['.git/config', /not accessible/],
    ['node_modules/lib/index.js', /not accessible/],
    ['client/board.pe.js', /not accessible/],
    ['link-out.txt', /outside the repo/],
    ['dir-out/secret.txt', /outside the repo/],
    ['git-link', /not accessible/],
    ['missing.js', /does not exist/],
  ])('rejects %s', async (input, message) => {
    await expect(resolveInRepo(scope, input)).rejects.toThrow(message);
  });

  it('accepts normal paths and symlinks that stay inside the repo', async () => {
    expect((await resolveInRepo(scope, 'server/routes/auth.js')).rel).toBe('server/routes/auth.js');
    expect((await resolveInRepo(scope, './server/')).rel).toBe('server');
    expect((await resolveInRepo(scope, '')).rel).toBe('.');
    expect((await resolveInRepo(scope, 'readme-link.md')).rel).toBe('readme-link.md');
  });
});

describe('list_files', () => {
  it('lists a tree, hiding .git, node_modules and forbidden paths, not following symlinks', async () => {
    const out = await tools().list({ depth: 2 });
    expect(out).toContain('server/\n    models/');
    expect(out).toContain('README.md');
    expect(out).toContain('link-out.txt (symlink, not followed)');
    expect(out).not.toMatch(/\.git\/|node_modules|board\.pe\.js|secret/);
  });

  it('respects depth (max 3)', async () => {
    const out = await tools().list({ path: 'client', depth: 3 });
    expect(out).toContain('deeper/');
    expect(out).not.toContain('deepest/');
    expect(() => createRepoTools(scope)[0].input.parse({ depth: 4 })).toThrow();
  });

  it('returns rejected paths as text', async () => {
    expect(await tools().list({ path: '../outside' })).toMatch(/^Error: .*\.\./);
    expect(await tools().list({ path: 'README.md' })).toMatch(/is a file/);
  });
});

describe('read_file', () => {
  it('returns numbered lines with a header', async () => {
    expect(await tools().read({ path: 'README.md' })).toBe('README.md (lines 1-2 of 2)\n1: # Shop\n2: A demo shop.');
  });

  it('returns a requested range', async () => {
    expect(await tools().read({ path: 'big.txt', startLine: 10, endLine: 12 })).toBe(
      'big.txt (lines 10-12 of 1000)\n10: line 10\n11: line 11\n12: line 12',
    );
  });

  it('stops at 400 lines and says where to continue', async () => {
    const out = await tools().read({ path: 'big.txt', startLine: 101 });
    const lines = out.split('\n');
    expect(lines[0]).toBe('big.txt (lines 101-500 of 1000)');
    expect(lines.filter((l) => /^\d+: /.test(l))).toHaveLength(MAX_READ_LINES);
    expect(out).toContain('call again with startLine=501');
  });

  it('returns errors as text', async () => {
    const t = tools();
    expect(await t.read({ path: 'link-out.txt' })).toMatch(/outside the repo/);
    expect(await t.read({ path: 'client/board.pe.js' })).toMatch(/not accessible/);
    expect(await t.read({ path: 'README.md', startLine: 50 })).toMatch(/only 2 lines/);
    expect(await t.read({ path: 'server' })).toMatch(/is a directory/);
  });
});

describe('search_code', () => {
  it('returns file:line: text hits, skipping hidden and forbidden files and symlinks', async () => {
    const out = await tools().search({ pattern: 'router\\.post\\("/(login|register|pro|lib)"' });
    expect(out.split('\n')).toEqual([
      'server/routes/auth.js:1: router.post("/login", login);',
      'server/routes/auth.js:2: router.post("/register", register);',
    ]);
  });

  it('searches dotfiles but never .git', async () => {
    expect(await tools().search({ pattern: 'JWT_SECRET|core' })).toBe('.env.example:1: JWT_SECRET=');
  });

  it('filters by glob', async () => {
    expect(await tools().search({ pattern: 'User', glob: 'server/**/*.js' })).toBe('server/models/user.js:1: const User = {};');
    expect(await tools().search({ pattern: 'User', glob: 'client/**' })).toBe('No matches.');
  });

  it('stops at 50 hits', async () => {
    const out = await tools().search({ pattern: 'router', glob: 'many.js' });
    expect(out.split('\n').filter((l) => l.startsWith('many.js:'))).toHaveLength(MAX_SEARCH_HITS);
    expect(out).toContain('[stopped at 50 hits');
  });

  it('rejects bad patterns and globs as text', async () => {
    const t = tools();
    expect(await t.search({ pattern: '(' })).toMatch(/invalid regular expression/);
    expect(await t.search({ pattern: 'x', glob: '../outside/**' })).toMatch(/"\.\."/);
    expect(await t.search({ pattern: 'x', glob: '/etc/**' })).toMatch(/relative/);
    expect(await t.search({ pattern: 'x', glob: '{a,{b,c}}' })).toMatch(/nested braces/);
  });
});
