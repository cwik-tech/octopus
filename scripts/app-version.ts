import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  evaluateAppVersionPolicy,
  incrementPatchVersion,
} from "../core/app-version-policy.js";

interface CheckCommand {
  command: "check";
  base: string;
  repoRoot: string;
}

interface BumpCommand {
  command: "bump";
  repoRoot: string;
}

type VersionCommand = BumpCommand | CheckCommand;

interface VersionedPackage {
  version: string;
}

interface VersionedLockfile extends VersionedPackage {
  packages: Record<string, unknown> & { "": VersionedPackage };
}

class VersionPolicyError extends Error {
  override readonly name = "VersionPolicyError";
}

function main(): void {
  const command = parseCommand(process.argv.slice(2));
  const result = command.command === "check"
    ? checkVersionPolicy(command)
    : bumpVersion(command);
  const output = `${result.message}\n`;
  if (result.ok) {
    process.stdout.write(output);
    return;
  }
  process.stderr.write(output);
  process.exitCode = 1;
}

function parseCommand(args: readonly string[]): VersionCommand {
  const [command, ...options] = args;
  if (command !== "bump" && command !== "check") {
    throw new VersionPolicyError(
      "Usage: app-version.ts <bump|check> [--base <git-ref>] [--repo-root <path>]",
    );
  }
  const requestedRoot = readOption(options, "--repo-root");
  const repoRoot = path.resolve(requestedRoot ?? process.cwd());
  if (command === "bump") return { command, repoRoot };
  const base = readOption(options, "--base");
  if (base === undefined || !isSafeGitRef(base)) {
    throw new VersionPolicyError("--base must be a safe, non-empty Git ref.");
  }
  return {
    command,
    base,
    repoRoot,
  };
}

function bumpVersion(command: BumpCommand) {
  const manifestPath = path.join(command.repoRoot, "package.json");
  const lockfilePath = path.join(command.repoRoot, "package-lock.json");
  const manifest = readVersionedPackage(manifestPath);
  const lockfile = readVersionedLockfile(lockfilePath);
  if (
    manifest.version !== lockfile.version
    || manifest.version !== lockfile.packages[""].version
  ) {
    return {
      ok: false as const,
      message: "App manifest and lockfile versions must match before bumping.",
    };
  }
  const next = incrementPatchVersion(manifest.version);
  if (!next.ok) return next;

  runNpm(command.repoRoot, [
    "version",
    "patch",
    "--no-git-tag-version",
    "--ignore-scripts",
  ]);

  const updatedManifest = readVersionedPackage(manifestPath);
  const updatedLockfile = readVersionedLockfile(lockfilePath);
  if (
    updatedManifest.version !== next.version
    || updatedLockfile.version !== next.version
    || updatedLockfile.packages[""].version !== next.version
  ) {
    return {
      ok: false as const,
      message: `Version bump did not update every app version to ${next.version}.`,
    };
  }
  return {
    ok: true as const,
    message: `App version bumped from ${manifest.version} to ${next.version}.`,
  };
}

function checkVersionPolicy(command: CheckCommand) {
  const manifest = readVersionedPackage(
    path.join(command.repoRoot, "package.json"),
  );
  const lockfile = readVersionedLockfile(
    path.join(command.repoRoot, "package-lock.json"),
  );
  const baseManifest = parseVersionedPackage(
    runGit(command.repoRoot, ["show", `${command.base}:package.json`]),
    `${command.base}:package.json`,
  );
  const changedPaths = runGit(command.repoRoot, [
    "diff",
    "--name-only",
    "--diff-filter=ACDMRTUXB",
    `${command.base}...HEAD`,
    "--",
  ])
    .split("\n")
    .filter((entry) => entry.length > 0);

  return evaluateAppVersionPolicy({
    baseVersion: baseManifest.version,
    currentVersion: manifest.version,
    lockfileVersion: lockfile.version,
    rootPackageVersion: lockfile.packages[""].version,
    changedPaths,
  });
}

function readOption(
  args: readonly string[],
  optionName: string,
): string | undefined {
  const optionIndex = args.indexOf(optionName);
  if (optionIndex === -1) return undefined;
  return args[optionIndex + 1];
}

function isSafeGitRef(value: string): boolean {
  return value.length > 0
    && !value.startsWith("-")
    && !value.includes("..")
    && /^[A-Za-z0-9_./^~-]+$/.test(value);
}

function readVersionedPackage(filePath: string): VersionedPackage {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    throw new VersionPolicyError(`Cannot read ${filePath}.`, { cause: error });
  }
  return parseVersionedPackage(contents, filePath);
}

function readVersionedLockfile(filePath: string): VersionedLockfile {
  const value = parseJsonFile(filePath);
  if (!isRecord(value) || typeof value.version !== "string") {
    throw new VersionPolicyError(`${filePath} must declare a string version.`);
  }
  const packages = value.packages;
  if (!isRecord(packages)) {
    throw new VersionPolicyError(`${filePath} must declare packages.`);
  }
  const rootPackage = packages[""];
  if (!isRecord(rootPackage) || typeof rootPackage.version !== "string") {
    throw new VersionPolicyError(
      `${filePath} must declare packages[\"\"].version.`,
    );
  }
  return {
    version: value.version,
    packages: { ...packages, "": { version: rootPackage.version } },
  };
}

function parseVersionedPackage(
  contents: string,
  sourceName: string,
): VersionedPackage {
  const value = parseJson(contents, sourceName);
  if (!isRecord(value) || typeof value.version !== "string") {
    throw new VersionPolicyError(`${sourceName} must declare a string version.`);
  }
  return { version: value.version };
}

function parseJsonFile(filePath: string): unknown {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    throw new VersionPolicyError(`Cannot read ${filePath}.`, { cause: error });
  }
  return parseJson(contents, filePath);
}

function parseJson(contents: string, sourceName: string): unknown {
  try {
    const value: unknown = JSON.parse(contents);
    return value;
  } catch (error: unknown) {
    throw new VersionPolicyError(`${sourceName} must contain valid JSON.`, {
      cause: error,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runGit(repoRoot: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error !== undefined) {
    throw new VersionPolicyError(`Git failed: git ${args.join(" ")}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new VersionPolicyError(
      `Git failed: git ${args.join(" ")}\n${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function runNpm(repoRoot: string, args: readonly string[]): void {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error !== undefined) {
    throw new VersionPolicyError(`npm failed: npm ${args.join(" ")}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new VersionPolicyError(
      `npm failed: npm ${args.join(" ")}\n${result.stderr.trim()}`,
    );
  }
}

try {
  main();
} catch (error: unknown) {
  if (error instanceof VersionPolicyError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
