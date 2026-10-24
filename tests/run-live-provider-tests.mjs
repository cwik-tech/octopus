import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDirectory, "..");
const outputDirectory = path.join(repoRoot, ".tests-dist");

rmSync(outputDirectory, { recursive: true, force: true });

const compile = spawnSync("tsc", ["-p", "tests/tsconfig.test.json"], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
if (compile.status !== 0) process.exit(compile.status ?? 1);

const liveDirectory = path.join(outputDirectory, "tests", "live");
const testTargets = readdirSync(liveDirectory)
  .filter((entry) => entry.endsWith(".test.js"))
  .map((entry) => path.join(liveDirectory, entry))
  .sort();

if (testTargets.length === 0) {
  console.error("No compiled live provider tests found.");
  process.exit(1);
}

const run = spawnSync(
  "node",
  ["--test", "--test-concurrency=1", ...testTargets],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  },
);
process.exit(run.status ?? 1);
