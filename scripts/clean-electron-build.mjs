import { rm } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputPath = path.join(repositoryRoot, "dist-electron");

if (path.basename(outputPath) !== "dist-electron") {
  throw new Error(`Refusing to clean unexpected path: ${outputPath}`);
}

await rm(outputPath, { recursive: true, force: true });
