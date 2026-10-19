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

  it('rejects a target missing backend or frontend', () => {
    const { frontend: _f, ...noFrontend } = config;
    expect(errorPaths(TargetConfig, noFrontend)).toContain('frontend');
  });

  it('rejects a wrong schemaVersion', () => {
    expect(errorPaths(TargetConfig, { ...config, schemaVersion: '2.0' })).toContain('schemaVersion');
  });
});
