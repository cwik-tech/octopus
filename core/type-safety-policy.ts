import ts from "typescript";

export type TypeSafetyPolicyRule =
  | "no-double-assertion"
  | "no-explicit-any"
  | "no-non-null-assertion"
  | "no-typescript-suppression";

export interface TypeSafetyPolicyFile {
  readonly path: string;
  readonly source: string;
}

export interface TypeSafetyPolicyViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: TypeSafetyPolicyRule;
}

export function collectTypeSafetyViolations(
  files: readonly TypeSafetyPolicyFile[],
): TypeSafetyPolicyViolation[] {
  return files.flatMap(collectFileViolations);
}

function collectFileViolations(file: TypeSafetyPolicyFile): TypeSafetyPolicyViolation[] {
  const sourceFile = ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    false,
  );
  const violations: TypeSafetyPolicyViolation[] = [];
  const reported = new Set<string>();

  const report = (node: ts.Node, rule: TypeSafetyPolicyRule): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const key = `${rule}:${node.getStart(sourceFile)}`;
    if (reported.has(key)) return;
    reported.add(key);
    violations.push({
      file: file.path,
      line,
      rule,
    });
  };

  const visit = (node: ts.Node): void => {
    if (isAnyTypeNode(node)) report(node, "no-explicit-any");
    if (isChainedAssertion(node)) report(node, "no-double-assertion");
    if (ts.isNonNullExpression(node)) report(node, "no-non-null-assertion");
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  collectSuppressionCommentViolations(sourceFile, file.path, violations);
  return violations.sort(compareViolations);
}

function isAnyTypeNode(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.AnyKeyword;
}

function isChainedAssertion(node: ts.Node): boolean {
  if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return false;
  return ts.isAsExpression(node.expression) || ts.isTypeAssertionExpression(node.expression);
}

function collectSuppressionCommentViolations(
  sourceFile: ts.SourceFile,
  file: string,
  violations: TypeSafetyPolicyViolation[],
): void {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceFile.text,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) &&
      /@ts-(?:ignore|expect-error|nocheck)\b/.test(scanner.getTokenText())
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1;
      violations.push({ file, line, rule: "no-typescript-suppression" });
    }
  }
}

function compareViolations(
  left: TypeSafetyPolicyViolation,
  right: TypeSafetyPolicyViolation,
): number {
  return left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule);
}
