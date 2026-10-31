import type { SuiteScore } from './score.js';

export interface Spread {
  /** One value per suite; null where the suite had no denominator. */
  values: Array<number | null>;
  n: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** Sample standard deviation (n − 1); null for fewer than two values. */
  sd: number | null;
}

export function spread(values: Array<number | null>): Spread {
  const xs = values.filter((v): v is number => v !== null);
  if (xs.length === 0) return { values, n: 0, mean: null, min: null, max: null, sd: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length < 2 ? null : Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  return { values, n: xs.length, mean, min: Math.min(...xs), max: Math.max(...xs), sd };
}

export interface VariantRow {
  version: string;
  kind: string;
  equivalent: boolean;
  /** Per suite, in suite order. */
  caught: boolean[];
  caughtInSuites: number;
  classCorrect: boolean[];
  fileCorrect: boolean[];
  lineCorrect: boolean[];
}

export interface Aggregate {
  suites: number;
  rates: Record<string, Spread>;
  variants: VariantRow[];
  cost: { analysisCostUsd: Spread; analysisMs: Spread; executionMsMean: Spread };
  goldenFalseAlarm: Spread;
  /** Code variants caught by no suite: candidates for the by-hand equivalent-mutant review. */
  caughtByNoSuite: string[];
  confusion: Record<string, Record<string, number>>;
  warnings: string[];
}

export function aggregate(scores: readonly SuiteScore[], equivalents: readonly string[] = []): Aggregate {
  const rateNames = [...new Set(scores.flatMap((s) => Object.keys(s.rates)))];
  const rates = Object.fromEntries(rateNames.map((name) => [name, spread(scores.map((s) => s.rates[name] ?? null))]));
  const ids = scores[0]?.versions.map((v) => v.version) ?? [];
  const variants: VariantRow[] = ids.map((id) => {
    const per = scores.map((s) => s.versions.find((v) => v.version === id)!);
    return {
      version: id,
      kind: per[0]!.kind,
      equivalent: equivalents.includes(id),
      caught: per.map((v) => v.caught),
      caughtInSuites: per.filter((v) => v.caught).length,
      classCorrect: per.map((v) => v.classCorrect),
      fileCorrect: per.map((v) => v.fileCorrect),
      lineCorrect: per.map((v) => v.lineCorrect),
    };
  });
  const confusion: Aggregate['confusion'] = {};
  for (const s of scores) for (const [expected, row] of Object.entries(s.confusion)) for (const [got, n] of Object.entries(row)) {
    const target = (confusion[expected] ??= {});
    target[got] = (target[got] ?? 0) + n;
  }
  return {
    suites: scores.length,
    rates,
    variants,
    cost: {
      analysisCostUsd: spread(scores.map((s) => s.totals.analysisCostUsd)),
      analysisMs: spread(scores.map((s) => s.totals.analysisMs)),
      executionMsMean: spread(scores.map((s) => s.totals.executionMsMean)),
    },
    goldenFalseAlarm: spread(scores.map((s) => s.golden.falseAlarmRate)),
    caughtByNoSuite: variants.filter((v) => v.kind === 'code' && v.caughtInSuites === 0).map((v) => v.version),
    confusion,
    warnings: scores.flatMap((s) => s.warnings),
  };
}
