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
 * Type-checks one spec file together with _helpers.ts, in-process. The previous program is reused, so
 * later checks only re-check what changed. Returns problems with line numbers; empty when it compiles.
 */
export class TypeChecker {
  private previous: ts.Program | undefined;

  check(file: string, lineOffset = 0): string[] {
    const program = ts.createProgram({ rootNames: [file], options: OPTIONS, ...(this.previous ? { oldProgram: this.previous } : {}) });
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
