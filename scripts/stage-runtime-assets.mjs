/**
 * Copies the non-JavaScript files the runtime reads at run time into a build.
 *
 * `tsc` emits JavaScript and nothing else, so a module that reads a file beside
 * its own compiled location finds nothing in a build tree. The minutes helper
 * did exactly that: it resolves its prompt template relative to `__dirname`
 * (`domains/agent-execution/minutes.ts`), and every desktop run therefore threw
 * on the missing template and fell back to mechanical minutes — silently,
 * because the fallback catch treated any failure as "no LLM available".
 * The Team runtime's setup mode had the same gap. It reads its prompt from
 * `__dirname/../setup/setup-agent.md` (`team-runtime/index.ts`), and when the
 * file is missing it starts setup mode without the setup prompt, keeping only
 * Pi's base prompt, and reports nothing.
 *
 * Declared in one place and used by both build trees, so the compiled tests and
 * the shipped application cannot disagree about where an asset lives. The
 * distribution needs no separate entry: `dist-electron/**\/*` is already in
 * `package.json`'s `build.files`, so staging here ships it too.
 */
import { copyFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Each asset's path relative to the repository root, which is also its path
 * relative to the build root.
 *
 * Keeping the two identical is what makes the runtime's own `__dirname`
 * arithmetic work unchanged in both trees, rather than needing a build-aware
 * lookup in the module that reads the file.
 */
export const RUNTIME_ASSET_RELATIVE_PATHS = [
  path.join("services", "officecli-supervisor.cjs"),
  // Read by `domains/agent-execution/minutes.ts`.
  path.join("examples", "minutes-template.md"),
  // Read by `team-runtime/index.ts` in setup mode.
  path.join("setup", "setup-agent.md"),
];

/** Stages every declared asset into `destinationRoot`, creating directories. */
export async function stageRuntimeAssets(destinationRoot) {
  const staged = [];
  for (const relativePath of RUNTIME_ASSET_RELATIVE_PATHS) {
    const destination = path.join(destinationRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repositoryRoot, relativePath), destination);
    staged.push(destination);
  }
  return staged;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const destinationRoot = process.argv[2];
  if (!destinationRoot) {
    console.error("Usage: node scripts/stage-runtime-assets.mjs <build-root>");
    process.exit(1);
  }
  // Fails loudly. A build that silently ships without its assets is the bug
  // this exists to prevent, and it is only visible at run time.
  await stageRuntimeAssets(path.resolve(repositoryRoot, destinationRoot));
}
