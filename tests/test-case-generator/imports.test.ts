import { describe, expect, it } from 'vitest';
import { collectEvidence, relativeImports, resolveImport } from '../../src/modules/test-case-generator/context.js';
import type { ReadLines } from '../../src/modules/test-case-generator/context.js';
import type { PrdRequirement } from '../../src/shared/schemas.js';

/** An in-memory repo at the generation commit. */
const repo = (files: Record<string, string>): ReadLines => async (file) => (file in files ? files[file]!.split('\n') : null);

const requirement = (file: string, lines: [number, number]): PrdRequirement => ({
  id: 'REQ-001',
  featureId: 'F-01',
  layer: 'api',
  statement: 's',
  priority: 'high',
  acceptanceCriteria: [{ text: 't', evidence: [{ file, lines }] }],
});

describe('relativeImports', () => {
  it('finds require, import from, side-effect import, dynamic import and export from; ignores packages', () => {
    const source = [
      "const role = require('../../middleware/role');",
      "const express = require('express');",
      "import Button from './Button';",
      "import { a, b } from '../utils/date.js';",
      "import './styles.scss';",
      "const Page = () => import('./Page');",
      "export { x } from './x';",
      "import React from 'react';",
    ].join('\n');
    expect(relativeImports(source).sort()).toEqual(
      ['../../middleware/role', '../utils/date.js', './Button', './Page', './styles.scss', './x'].sort(),
    );
  });
});

describe('resolveImport', () => {
  const read = repo({
    'server/middleware/role.js': 'x',
    'client/app/components/Button/index.js': 'x',
    'client/app/user.model.ts': 'x',
    'client/app/data.json': '{}',
  });

  it('tries code extensions and index files, keeps names with dots, and skips non-code files', async () => {
    expect(await resolveImport('server/routes/api/merchant.js', '../../middleware/role', read)).toBe('server/middleware/role.js');
    expect(await resolveImport('client/app/containers/Page.js', '../components/Button', read)).toBe('client/app/components/Button/index.js');
    expect(await resolveImport('client/app/x.js', './user.model', read)).toBe('client/app/user.model.ts');
    expect(await resolveImport('client/app/x.js', './data.json', read)).toBe('client/app/data.json');
    expect(await resolveImport('client/app/x.js', './styles.scss', read)).toBeNull();
    expect(await resolveImport('client/app/x.js', './missing', read)).toBeNull();
    expect(await resolveImport('server/x.js', '../../outside', read)).toBeNull();
  });
});

describe('collectEvidence with imports', () => {
  const files = {
    'server/routes/merchant.js': [
      "const role = require('../middleware/role');",
      "const helper = require('./helper');",
      'router.get("/", role.check(ROLES.Admin), handler);',
    ].join('\n'),
    'server/middleware/role.js': [
      "const deep = require('./deep');",
      "if (!req.user) return res.status(401).send('Unauthorized');",
      "return res.status(403).send('You are not allowed to make this request.');",
    ].join('\n'),
    'server/middleware/deep.js': 'module.exports = "imports of imports are not followed";',
    'server/routes/helper.js': 'module.exports = 1;',
  };

  it('adds each file a cited file imports, whole, once, one level deep, after the cited ranges', async () => {
    const { blocks, omitted } = await collectEvidence(
      [requirement('server/routes/merchant.js', [3, 3]), requirement('server/routes/helper.js', [1, 1])],
      repo(files),
    );
    expect(blocks.map((b) => [b.file, b.importedBy ?? null])).toEqual([
      ['server/routes/helper.js', null],
      ['server/routes/merchant.js', null],
      ['server/middleware/role.js', 'server/routes/merchant.js'],
    ]);
    // helper.js is already cited, so it is not added again as an import; deep.js is two levels away.
    expect(blocks.find((b) => b.file === 'server/middleware/role.js')?.lines.join('\n')).toContain('You are not allowed');
    expect(omitted).toEqual([]);
  });

  it('names the importer of an imported file left out by the size cap', async () => {
    const big = { ...files, 'server/middleware/role.js': Array.from({ length: 200 }, () => 'x'.repeat(50)).join('\n') };
    const { blocks, omitted } = await collectEvidence([requirement('server/routes/merchant.js', [1, 3])], repo(big), 1_000);
    // The large import is left out; the small one after it still fits.
    expect(blocks.map((b) => b.file)).toEqual(['server/routes/merchant.js', 'server/routes/helper.js']);
    expect(omitted).toContain('server/middleware/role.js (imported by server/routes/merchant.js)');
  });
});
