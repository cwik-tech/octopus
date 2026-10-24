import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const setupScriptPath = path.join(repoRoot, "scripts", "setup-worktree.mjs");

test("worktree setup validates every independent package boundary", () => {
  const validation = spawnSync(
    process.execPath,
    [setupScriptPath, "--check"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /Validated repository root/);
  assert.match(validation.stdout, /Validated ui\//);
  assert.match(validation.stdout, /Validated file-parser\//);

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts["setup:worktree"],
    "node scripts/setup-worktree.mjs",
  );
});

test("worktree setup rejects unsupported options before installing", () => {
  const validation = spawnSync(
    process.execPath,
    [setupScriptPath, "--unsupported"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(validation.status, 2);
  assert.match(validation.stderr, /Unknown setup option/);
  assert.doesNotMatch(validation.stdout, /Installing/);
});
