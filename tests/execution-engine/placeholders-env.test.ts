import { describe, expect, it } from 'vitest';
import { applyOverride, childEnv, formatEnvFile, serviceEnv } from '../../src/modules/execution-engine/env.js';
import { PlaceholderError, fillPlaceholders } from '../../src/modules/execution-engine/placeholders.js';
import { TargetConfig } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

describe('fillPlaceholders', () => {
  const context = { fixtures: { users: { alice: { email: 'a@x.test', age: 30, admin: false } } }, targetDir: '/t' };

  it('fills nested objects and arrays and leaves other values alone', () => {
    const body = {
      email: '{{fixtures.users.alice.email}}',
      tags: ['x', '{{ fixtures.users.alice.email }}'],
      nested: { note: 'hi {{fixtures.users.alice.email}}!' },
      count: 3,
      flag: true,
      none: null,
    };
    expect(fillPlaceholders(body, context)).toEqual({
      email: 'a@x.test',
      tags: ['x', 'a@x.test'],
      nested: { note: 'hi a@x.test!' },
      count: 3,
      flag: true,
      none: null,
    });
  });

  it('keeps the type of a value when the string is exactly one placeholder', () => {
    expect(fillPlaceholders({ age: '{{fixtures.users.alice.age}}' }, context)).toEqual({ age: 30 });
    expect(fillPlaceholders('{{fixtures.users.alice.admin}}', context)).toBe(false);
    expect(fillPlaceholders('age {{fixtures.users.alice.age}}', context)).toBe('age 30');
  });

  it('fills command placeholders', () => {
    expect(fillPlaceholders('node --require "{{targetDir}}/seed.cjs" x.js', context)).toBe(
      'node --require "/t/seed.cjs" x.js',
    );
  });

  it('throws on an unknown placeholder or one that names an object', () => {
    expect(() => fillPlaceholders('{{fixtures.users.bob.email}}', context)).toThrow(PlaceholderError);
    expect(() => fillPlaceholders('{{fixtures.users.alice}}', context)).toThrow(/not a string/);
  });
});

describe('env', () => {
  const config = TargetConfig.parse(example('target.config.json'));

  it('merges config env, disabledServices and the override (null removes)', () => {
    const env = serviceEnv(config, 'backend', {
      backend: { env: { MONGO_URI: 'mongodb://nowhere:1/x', JWT_SECRET: null } },
    });
    expect(env.MONGO_URI).toBe('mongodb://nowhere:1/x');
    expect(env).not.toHaveProperty('JWT_SECRET');
    expect(env.MAILGUN_KEY).toBe('');
    expect(env.PORT).toBe('3000');
  });

  it('gives the frontend only its own env', () => {
    expect(serviceEnv(config, 'frontend')).toEqual({ API_URL: 'http://localhost:3000/api' });
  });

  it('passes only PATH and HOME from the parent to children', () => {
    const parent = { PATH: '/bin', HOME: '/home/x', LLM_API_KEY: 'secret', AWS_ACCESS_KEY_ID: 'real' };
    expect(childEnv({ PORT: '1' }, parent)).toEqual({ PATH: '/bin', HOME: '/home/x', PORT: '1' });
  });

  it('applyOverride does not change its input', () => {
    const env = { A: '1' };
    expect(applyOverride(env, { A: null, B: '2' })).toEqual({ B: '2' });
    expect(env).toEqual({ A: '1' });
  });

  it('formats env files, quoting values with other characters', () => {
    expect(formatEnvFile({ API_URL: 'http://localhost:3000/api', MSG: 'a b#c', EMPTY: '' })).toBe(
      "API_URL=http://localhost:3000/api\nMSG='a b#c'\nEMPTY=\n",
    );
    expect(() => formatEnvFile({ BAD: "it's" })).toThrow(/quote/);
    expect(formatEnvFile({})).toBe('');
  });
});
