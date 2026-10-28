import path from 'node:path';
import ts from 'typescript';

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: ['node'],
  // page.evaluate callbacks run in the browser, so scripts may use DOM names (localStorage, document).
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
};

/**
 * Type-checks one spec file together with _helpers.ts, in-process. Returns problems with line numbers; empty when it
 * compiles. Everything but the checked file (the TypeScript and DOM libraries, @playwright/test and node types,
 * _helpers.ts) is read once and kept with its lookups: those reads, not the check itself, made each check take ~5 s
 * on a mounted project folder (measured 25 Oct: ~5 s before, ~130 ms after; the check proper takes ~15 ms). The
 * checked file is always read fresh, since each attempt rewrites it.
 */
export class TypeChecker {
  private previous: ts.Program | undefined;
  private readonly base = ts.createCompilerHost(OPTIONS);
  private readonly sources = new Map<string, ts.SourceFile | undefined>();
  private readonly files = new Map<string, boolean>();
  private readonly directories = new Map<string, boolean>();

  private host(root: string): ts.CompilerHost {
    const { base } = this;
    const cached = <T>(map: Map<string, T>, key: string, read: () => T): T => {
      if (!map.has(key)) map.set(key, read());
      return map.get(key) as T;
    };
    return {
      ...base,
      getSourceFile: (name, version, onError, fresh) =>
        name === root ? base.getSourceFile(name, version, onError, fresh) : cached(this.sources, name, () => base.getSourceFile(name, version, onError, fresh)),
      fileExists: (name) => (name === root ? base.fileExists(name) : cached(this.files, name, () => base.fileExists(name))),
      directoryExists: (name) => cached(this.directories, name, () => base.directoryExists?.(name) ?? true),
    };
  }

  check(file: string, lineOffset = 0): string[] {
    const program = ts.createProgram({ rootNames: [file], options: OPTIONS, host: this.host(file), ...(this.previous ? { oldProgram: this.previous } : {}) });
    this.previous = program;
    const source = program.getSourceFile(file);
    const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
    return diagnostics.slice(0, 15).map((d) => {
      const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      if (!d.file || d.start === undefined) return text;
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      const where = d.file.fileName === file ? `body line ${line + 1 - lineOffset}` : `${path.basename(d.file.fileName)} line ${line + 1}`;
      return `${where}, column ${character + 1}: ${text}`;
    });
  }
}
