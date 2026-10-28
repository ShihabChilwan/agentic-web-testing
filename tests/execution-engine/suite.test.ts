import { describe, expect, it } from 'vitest';
import { targetSettings } from '../../src/modules/execution-engine/suite.js';
import { TargetConfig } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

describe('targetSettings (what the scripts read from _target.json)', () => {
  const config = TargetConfig.parse(example('target.config.json'));

  it('gives the frontend\'s URL as the UI URL, and the backend\'s as the API URL', () => {
    expect(targetSettings(config)).toMatchObject({ apiUrl: config.backend.baseUrl, uiUrl: config.frontend!.baseUrl });
  });

  it('for a one-process app (no frontend) the pages open at the backend\'s URL', () => {
    const { frontend: _f, ...rest } = config;
    const single = targetSettings(TargetConfig.parse(rest));
    expect(single.uiUrl).toBe(config.backend.baseUrl);
    expect(single.apiUrl).toBe(config.backend.baseUrl);
  });
});
