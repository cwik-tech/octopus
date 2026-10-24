import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { TypeSafetyPolicyFile } from "./type-safety-policy.js";

const SOURCE_ROOTS = ["."];
const EXCLUDED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "coverage",
  "examples",
  "release",
  "test-results",
  "__tests__",
  "tests",
]);
const EXCLUDED_DIRECTORIES = new Set([
  "ui/src/components/ui",
  "ui/src/components/ai-elements",
]);

export async function readOwnedTypeSafetySourceFiles(
  root: string,
): Promise<TypeSafetyPolicyFile[]> {
  const files = await Promise.all(
    SOURCE_ROOTS.flatMap((sourceRoot) => findTypeScriptFiles(root, sourceRoot)),
  );
  return Promise.all(
    files.flat().map(async (file) => ({
      path: file,
      source: await readFile(path.join(root, file), "utf8"),
    })),
  );
}

async function findTypeScriptFiles(
  root: string,
  relativeDirectory: string,
): Promise<string[]> {
  if (EXCLUDED_DIRECTORIES.has(relativeDirectory)) return [];
  let entries;
  try {
    entries = await readdir(path.join(root, relativeDirectory), {
      withFileTypes: true,
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) return [];
    throw error;
  }
  const children = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        return EXCLUDED_DIRECTORY_NAMES.has(entry.name)
          ? []
          : findTypeScriptFiles(root, relativePath);
      }
      return entry.isFile() && /\.[cm]?tsx?$/.test(entry.name) ? [relativePath] : [];
    }),
  );
  return children.flat();
}
