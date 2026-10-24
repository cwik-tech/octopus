import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = await mkdtemp(
  path.join(tmpdir(), "pipeline-ui-check-"),
);

try {
  await build({
    root: uiRoot,
    build: {
      emptyOutDir: true,
      outDir: outputDirectory,
    },
  });
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
