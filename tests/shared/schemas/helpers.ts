import { readFileSync } from 'node:fs';
import type { z } from 'zod';

/** Reads a reference example of a file format from tests/fixtures/examples. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function example(name: string): any {
  return JSON.parse(readFileSync(new URL(`../../fixtures/examples/${name}`, import.meta.url), 'utf8'));
}

/** Paths of all validation issues, joined with dots ('' for the root). Empty when the value is valid. */
export function errorPaths(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}
