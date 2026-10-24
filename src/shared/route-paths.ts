/** A route template's parameter segment: ":id", "{id}", "<id>" or "${id}". */
export const isParam = (segment: string): boolean => /^(:\w+|\{\w+\}|<[^>]+>|\$\{[^}]+\})$/.test(segment);

/** Whether a concrete path fits a route template: same segment count, parameters match any one segment. */
export function templateMatches(template: string, path: string): boolean {
  const parts = path.split('?')[0]!.split('/').filter(Boolean);
  const segments = template.split('?')[0]!.split('/').filter(Boolean);
  return segments.length === parts.length && segments.every((t, i) => isParam(t) || t === parts[i]);
}

/**
 * Paths a text names: "/x/y", or a full URL's path ("http://host:8080/x" → "/x", "http://host:8080" → "/"). Trailing
 * punctuation is dropped.
 */
export function textPaths(texts: readonly string[]): string[] {
  return texts.flatMap((text) =>
    [...text.matchAll(/(?:^|[\s("'`])(?:(https?:\/\/[^/\s"'`]+)(\/[^\s"'`,;)]*)?|(\/[^\s"'`,;)]*))/g)].map((m) => {
      const raw = (m[2] ?? m[3] ?? '').replace(/[.,:;]+$/, '');
      return raw || '/';
    }),
  );
}
