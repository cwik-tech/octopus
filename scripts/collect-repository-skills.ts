import * as fs from "node:fs";
import * as path from "node:path";

/** Discover repository skill sources while leaving generated dependencies and outputs out. */
export function collectRepositorySkillDirectories(root: string): string[] {
  const found: string[] = [];
  const skipped = new Set(["node_modules", ".git", ".tests-dist", "dist", "build"]);
  const walk = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) found.push(directory);
    for (const entry of entries) {
      const generatedTestOutput = directory === root && entry.name === "test-results";
      if (entry.isDirectory() && !generatedTestOutput && !skipped.has(entry.name) && !entry.name.startsWith(".")) {
        walk(path.join(directory, entry.name));
      }
    }
  };
  walk(root);
  return found;
}
