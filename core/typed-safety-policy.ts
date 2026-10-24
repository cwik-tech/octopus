import path from "node:path";
import ts from "typescript";

/**
 * Rules that need the type checker, for backend code.
 *
 * The syntactic policy in `type-safety-policy.ts` sees only what is written:
 * an explicit `any`, a double assertion. It cannot see `any` arriving from
 * `JSON.parse` or an untyped library and then flowing into typed code, or a
 * promise nobody awaits. The UI enforces those with typed ESLint; the backend
 * has no ESLint, so the same rules are checked here with the compiler the
 * repository already builds with.
 *
 * Modelled on typescript-eslint's no-floating-promises and no-unsafe-* rules.
 * It is a subset, not a reimplementation:
 * - a promise used as a statement must be awaited, `void`ed, or given a
 *   rejection handler (`.catch(h)` or `.then(f, h)`). Promises inside arrays
 *   and promises passed to callbacks that expect `void` are not checked.
 * - an `any` (or `any[]`) may not be called, have a member read, initialise
 *   a variable that has no annotation, or land anywhere the compiler expects
 *   a type other than `any`, `unknown`, or an open type parameter. That covers
 *   assignments, properties, elements, defaults, fields, arguments, and
 *   returns. A type assertion (`as T`) is not treated as a flow.
 * - Not covered: places with no expected type, such as a template literal
 *   span or the iterable of a `for...of`.
 */
export type TypedSafetyPolicyRule =
  | "no-floating-promise"
  | "no-unsafe-any-argument"
  | "no-unsafe-any-assignment"
  | "no-unsafe-any-call"
  | "no-unsafe-any-member-access"
  | "no-unsafe-any-return";

export interface TypedSafetyPolicyViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: TypedSafetyPolicyRule;
}

export interface TypedSafetyPolicyInput {
  /** The repository root; reported paths are relative to it, with `/`. */
  readonly root: string;
  /** Projects to check, relative to `root`. A file in two is checked once. */
  readonly tsconfigPaths: readonly string[];
  readonly isOwned: (file: string) => boolean;
}

export function collectTypedSafetyViolations(
  input: TypedSafetyPolicyInput,
): TypedSafetyPolicyViolation[] {
  const seen = new Set<string>();
  const violations: TypedSafetyPolicyViolation[] = [];
  for (const tsconfigPath of input.tsconfigPaths) {
    const program = createProgram(path.join(input.root, tsconfigPath));
    const checker = program.getTypeChecker();
    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      const file = path
        .relative(input.root, sourceFile.fileName)
        .split(path.sep)
        .join("/");
      if (file.startsWith("../") || !input.isOwned(file)) continue;
      for (const violation of collectFileViolations(checker, sourceFile, file)) {
        const key = `${violation.file}:${violation.line}:${violation.rule}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push(violation);
      }
    }
  }
  return violations.sort(compareViolations);
}

function createProgram(tsconfigFile: string): ts.Program {
  const read = ts.readConfigFile(tsconfigFile, (file) => ts.sys.readFile(file));
  if (read.error) {
    throw new Error(
      `Cannot read ${tsconfigFile}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(tsconfigFile),
  );
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function collectFileViolations(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  file: string,
): TypedSafetyPolicyViolation[] {
  const violations: TypedSafetyPolicyViolation[] = [];
  const report = (node: ts.Node, rule: TypedSafetyPolicyRule): void => {
    const line =
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    violations.push({ file, line, rule });
  };
  const isAny = (node: ts.Node): boolean =>
    (checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any) !== 0;
  const isAnyOrAnyArray = (node: ts.Node): boolean => {
    const type = checker.getTypeAtLocation(node);
    if ((type.flags & ts.TypeFlags.Any) !== 0) return true;
    if (!checker.isArrayType(type)) return false;
    const element = checker.getIndexInfoOfType(type, ts.IndexKind.Number)?.type;
    return element !== undefined && (element.flags & ts.TypeFlags.Any) !== 0;
  };
  // Where a value lands decides whether its `any` escapes: a place typed
  // `any` or `unknown` (or a still-open type parameter) keeps the uncertainty
  // visible, anything else hides it.
  const landsInTypedPlace = (expression: ts.Expression): boolean => {
    const target = checker.getContextualType(expression);
    if (!target) return false;
    const open = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter;
    return (target.flags & open) === 0;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && isFloatingPromise(checker, node.expression)) {
      report(node, "no-floating-promise");
    }
    // `import(...)` is typed through its result; the compiler gives the
    // keyword itself the type `any`, which is not a call on an unknown value.
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      node.expression.kind !== ts.SyntaxKind.ImportKeyword &&
      isAny(node.expression)
    ) {
      report(node, "no-unsafe-any-call");
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isAny(node.expression)
    ) {
      report(node, "no-unsafe-any-member-access");
    }
    // A variable with no annotation takes the initializer's type, so an `any`
    // there spreads to every later use of the name.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      !node.type &&
      isAnyOrAnyArray(node.initializer)
    ) {
      report(node, "no-unsafe-any-assignment");
    }
    // Every other landing place: an annotated variable, an assignment, an
    // object property, an array element, a default, a field, an argument, a
    // return. The compiler's contextual type is the type expected there.
    if (
      isValueSlot(node) &&
      isAnyOrAnyArray(node) &&
      landsInTypedPlace(node)
    ) {
      report(node, ruleForSlot(node));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * An expression whose value is used where it stands, rather than a name, a
 * type, or a part that a wrapping expression passes through. A parenthesised,
 * conditional, or `??`/`||`/`&&` wrapper is judged as a whole, so one value is
 * reported once. An assertion (`as T`) is an explicit claim, not a silent
 * flow, and is left to the assertion rules.
 */
function isValueSlot(node: ts.Node): node is ts.Expression {
  if (!isExpressionLike(node)) return false;
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isParenthesizedExpression(parent)) return false;
  if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isSatisfiesExpression(parent)) {
    return false;
  }
  if (ts.isConditionalExpression(parent) && node !== parent.condition) return false;
  if (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && node === parent.name) return false;
  if (ts.isVariableDeclaration(parent) && node === parent.name) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  if ("name" in parent && parent.name === node) return false;
  return true;
}

function isExpressionLike(node: ts.Node): node is ts.Expression {
  return (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isConditionalExpression(node) ||
    ts.isBinaryExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node)
  );
}

function ruleForSlot(node: ts.Expression): TypedSafetyPolicyRule {
  const parent = node.parent;
  if (ts.isReturnStatement(parent)) return "no-unsafe-any-return";
  if (ts.isArrowFunction(parent) && parent.body === node) return "no-unsafe-any-return";
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.arguments?.some((argument) => argument === node)
  ) {
    return "no-unsafe-any-argument";
  }
  return "no-unsafe-any-assignment";
}

function isFloatingPromise(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const unwrapped = skipParentheses(expression);
  if (ts.isVoidExpression(unwrapped) || ts.isAwaitExpression(unwrapped)) return false;
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    unwrapped.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return false;
  }
  if (!isThenable(checker, checker.getTypeAtLocation(unwrapped))) return false;
  return !handlesRejection(unwrapped);
}

function handlesRejection(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  if (method === "catch") return expression.arguments.length >= 1;
  if (method === "then") return expression.arguments.length >= 2;
  return false;
}

function isThenable(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Any) !== 0) return false;
  if (type.isUnion()) return type.types.some((member) => isThenable(checker, member));
  const then = type.getProperty("then");
  if (!then) return false;
  const thenType = checker.getNonNullableType(
    checker.getTypeOfSymbol(then),
  );
  return thenType.getCallSignatures().length > 0;
}

function skipParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function compareViolations(
  left: TypedSafetyPolicyViolation,
  right: TypedSafetyPolicyViolation,
): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.rule.localeCompare(right.rule)
  );
}
