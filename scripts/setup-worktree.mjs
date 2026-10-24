import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = [".", "ui", "file-parser"];
const isCheckOnly = process.argv.includes("--check");
const unknownOption = process.argv
  .slice(2)
  .find((option) => option !== "--check");

if (unknownOption) {
  console.error(`Unknown setup option: ${unknownOption}`);
  process.exit(2);
}

for (const relativeDirectory of packageDirectories) {
  validatePackageDirectory(relativeDirectory);
  if (!isCheckOnly) {
    installPackageDependencies(relativeDirectory);
  }
}

console.log(
  isCheckOnly
    ? "Worktree dependency boundaries are valid."
    : "Worktree dependencies installed.",
);

function validatePackageDirectory(relativeDirectory) {
  const packageDirectory = path.resolve(repoRoot, relativeDirectory);

  for (const manifestName of ["package.json", "package-lock.json"]) {
    if (!existsSync(path.join(packageDirectory, manifestName))) {
      throw new Error(
        `Missing ${manifestName} in ${displayDirectory(relativeDirectory)}`,
      );
    }
  }

  console.log(`Validated ${displayDirectory(relativeDirectory)}`);
}

function installPackageDependencies(relativeDirectory) {
  const packageDirectory = path.resolve(repoRoot, relativeDirectory);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  console.log(`Installing ${displayDirectory(relativeDirectory)} with npm ci...`);
  const installation = spawnSync(npmCommand, ["ci"], {
    cwd: packageDirectory,
    env: process.env,
    stdio: "inherit",
  });

  if (installation.error) {
    throw installation.error;
  }
  if (installation.status !== 0) {
    process.exit(installation.status ?? 1);
  }
}

function displayDirectory(relativeDirectory) {
  return relativeDirectory === "." ? "repository root" : `${relativeDirectory}/`;
}
