import { describe, expect, it } from 'vitest';
import { TargetConfig } from '../../../src/shared/schemas.js';
import { errorPaths, example } from './helpers.js';

describe('target.config.json', () => {
  const config = example('target.config.json');

  it('accepts the reference example and defaults disabledServices', () => {
    expect(TargetConfig.parse(config).backend.disabledServices.MAILGUN_KEY).toBe('');
    const { disabledServices: _omit, ...backend } = config.backend;
    expect(TargetConfig.parse({ ...config, backend }).backend.disabledServices).toEqual({});
  });

  it('rejects unknown keys (catches typos in hand-written config)', () => {
    expect(errorPaths(TargetConfig, { ...config, forbidenPaths: [] })).toContain('');
    expect(errorPaths(TargetConfig, { ...config, lifecycle: { ...config.lifecycle, startupTimeout: 1 } })).toContain(
      'lifecycle',
    );
  });

  it('accepts the optional coverage setting, node-v8 only', () => {
    expect(TargetConfig.parse(config).coverage).toBeUndefined();
    expect(TargetConfig.parse({ ...config, coverage: { kind: 'node-v8' } }).coverage).toEqual({ kind: 'node-v8' });
    expect(errorPaths(TargetConfig, { ...config, coverage: { kind: 'istanbul' } })).toContain('coverage.kind');
  });

  it('validates the optional seedCheck', () => {
    expect(TargetConfig.parse(config).seedCheck?.expect.nonEmptyArrayAt).toBe('products');
    const { seedCheck: _s, ...noCheck } = config;
    expect(TargetConfig.parse(noCheck).seedCheck).toBeUndefined();
    const withExpect = (expect: unknown) => ({ ...config, seedCheck: { ...config.seedCheck, expect } });
    expect(errorPaths(TargetConfig, withExpect({ status: 200, nonEmptyArrayAt: 'a..b' }))).toContain(
      'seedCheck.expect.nonEmptyArrayAt',
    );
    expect(errorPaths(TargetConfig, withExpect({ status: 200, minItems: 1 }))).toContain('seedCheck.expect');
    expect(errorPaths(TargetConfig, withExpect({}))).toContain('seedCheck.expect.status');
    expect(errorPaths(TargetConfig, { ...config, seedCheck: { ...config.seedCheck, path: 'api/x' } })).toContain(
      'seedCheck.path',
    );
  });

    it('accepts optional frontend.sourceRoots as relative folders', () => {
    expect(TargetConfig.parse(config).frontend.sourceRoots).toEqual(['client/app']);
    const { sourceRoots: _r, ...frontend } = config.frontend;
    expect(TargetConfig.parse({ ...config, frontend }).frontend.sourceRoots).toBeUndefined();
    expect(errorPaths(TargetConfig, { ...config, frontend: { ...frontend, sourceRoots: [] } })).toContain('frontend.sourceRoots');
    expect(errorPaths(TargetConfig, { ...config, frontend: { ...frontend, sourceRoots: ['../x'] } })).toContain(
      'frontend.sourceRoots.0',
    );
  });

    it('accepts the auth section and fact requests, with defaults', () => {
    const parsed = TargetConfig.parse(config);
    expect(parsed.auth).toMatchObject({ tokenAt: 'token', header: 'Authorization', prefix: '' });
    expect(parsed.facts?.find((f) => f.name === 'meNoToken')).toMatchObject({ as: null, maxItems: 5 });
    const bad = { ...config, facts: [{ name: 'has space', method: 'GET', path: 'no-slash' }] };
    expect(errorPaths(TargetConfig, bad)).toEqual(expect.arrayContaining(['facts.0.name', 'facts.0.path']));
    expect(errorPaths(TargetConfig, { ...config, auth: { ...config.auth, tokenAt: '' } })).toContain('auth.tokenAt');
  });

    it('rejects a target missing backend or frontend', () => {
    const { frontend: _f, ...noFrontend } = config;
    expect(errorPaths(TargetConfig, noFrontend)).toContain('frontend');
  });

  it('rejects a wrong schemaVersion', () => {
    expect(errorPaths(TargetConfig, { ...config, schemaVersion: '2.0' })).toContain('schemaVersion');
  });
});
