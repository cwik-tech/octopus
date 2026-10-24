import { collectTypeSafetyViolations } from "../core/type-safety-policy.ts";
import { collectTypedSafetyViolations } from "../core/typed-safety-policy.ts";
import { readOwnedTypeSafetySourceFiles } from "../core/owned-type-safety-source.ts";

const ROOT = process.cwd();
const sourceFiles = await readOwnedTypeSafetySourceFiles(ROOT);
// The UI checks the typed rules with its own type-aware ESLint config, so the
// typed pass here covers the backend projects only.
const ownedBackendFiles = new Set(
  sourceFiles.map((file) => file.path).filter((file) => !file.startsWith("ui/")),
);
const violations = [
  ...collectTypeSafetyViolations(sourceFiles),
  ...collectTypedSafetyViolations({
    root: ROOT,
    tsconfigPaths: ["tsconfig.json", "tsconfig.electron.json"],
    isOwned: (file) => ownedBackendFiles.has(file),
  }),
];

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.rule}`);
  }
  process.exitCode = 1;
}
