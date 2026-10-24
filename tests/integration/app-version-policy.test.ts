import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const REPOSITORY_ROOT = process.cwd();
const VERSION_SCRIPT = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "app-version.ts",
);

interface ToolResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

test("version check rejects an app change whose version did not increase", () => {
  const repository = createRepository();
  try {
    fs.writeFileSync(
      path.join(repository, "app.ts"),
      "export const answer = 43;\n",
    );
    runGit(repository, ["add", "app.ts"]);
    runGit(repository, ["commit", "-m", "change app"]);

    const result = runVersionTool(repository, ["check", "--base", "HEAD^"]);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /app version must increase/i);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("version bump increments the app manifest and both lockfile versions", () => {
  const repository = createRepository();
  try {
    const result = runVersionTool(repository, ["bump"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readVersion(path.join(repository, "package.json")), "0.1.1");
    assert.deepEqual(readLockfileVersions(repository), {
      lockfile: "0.1.1",
      rootPackage: "0.1.1",
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("version check treats a deleted app file as an app-affecting change", () => {
  const repository = createRepository();
  try {
    fs.rmSync(path.join(repository, "app.ts"));
    runGit(repository, ["add", "app.ts"]);
    runGit(repository, ["commit", "-m", "remove app module"]);

    const result = runVersionTool(repository, ["check", "--base", "HEAD^"]);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /app version must increase/i);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "app-version-policy-"));
  runGit(repository, ["init", "--quiet"]);
  runGit(repository, ["config", "user.email", "version-policy@example.test"]);
  runGit(repository, ["config", "user.name", "Version Policy Test"]);
  writeJson(path.join(repository, "package.json"), {
    name: "test-app",
    version: "0.1.0",
  });
  writeJson(path.join(repository, "package-lock.json"), {
    name: "test-app",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "test-app",
        version: "0.1.0",
      },
    },
  });
  fs.writeFileSync(
    path.join(repository, "app.ts"),
    "export const answer = 42;\n",
  );
  runGit(repository, ["add", "."]);
  runGit(repository, ["commit", "-m", "initial"]);
  return repository;
}

function runVersionTool(
  repository: string,
  args: readonly string[],
): ToolResult {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", VERSION_SCRIPT, ...args, "--repo-root", repository],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
  return {
    status: result.status,
    stderr: readOutput(result.stderr),
    stdout: readOutput(result.stdout),
  };
}

function runGit(repository: string, args: readonly string[]): void {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readVersion(filePath: string): string {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.ok(hasStringVersion(value));
  return value.version;
}

function readLockfileVersions(repository: string): {
  lockfile: string;
  rootPackage: string;
} {
  const filePath = path.join(repository, "package-lock.json");
  const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.ok(hasLockfileVersions(value));
  return {
    lockfile: value.version,
    rootPackage: value.packages[""].version,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringVersion(
  value: unknown,
): value is Record<string, unknown> & { version: string } {
  return isRecord(value) && typeof value.version === "string";
}

function hasLockfileVersions(value: unknown): value is {
  version: string;
  packages: { "": { version: string } };
} {
  return hasStringVersion(value)
    && isRecord(value.packages)
    && hasStringVersion(value.packages[""]);
}

function readOutput(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}
