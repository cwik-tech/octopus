import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

const COPY_TIMEOUT_MS = 60_000;
const PLIST_TIMEOUT_MS = 10_000;
const PLIST_BUDDY_PATH = "/usr/libexec/PlistBuddy";

export interface DevelopmentElectronBundle {
  appPath: string;
  executablePath: string;
}

export interface DevelopmentElectronBundleInput {
  cacheRootPath: string;
  productName: string;
  sourceAppPath: string;
}

export interface DevelopmentElectronLaunchOptions {
  appArguments?: readonly string[];
  electronCliPath: string;
  executablePath?: string;
}

interface DevelopmentElectronBundlePaths extends DevelopmentElectronBundle {
  versionCachePath: string;
}

export async function developmentElectronLaunchOptions(
  repositoryRoot: string,
  platform = process.platform,
): Promise<DevelopmentElectronLaunchOptions> {
  if (platform !== "darwin") {
    return {
      electronCliPath: path.join(
        repositoryRoot,
        "node_modules",
        "electron",
        "cli.js",
      ),
    };
  }

  const electronExecutablePath = loadElectronExecutable(repositoryRoot);
  const prepared = await prepareDevelopmentElectronBundle({
    cacheRootPath: path.join(
      repositoryRoot,
      "node_modules",
      ".cache",
      "octopus-development-electron",
    ),
    productName: "Octopus",
    sourceAppPath: macOsAppBundlePath(electronExecutablePath),
  });
  return {
    appArguments: [],
    electronCliPath: repositoryRoot,
    executablePath: prepared.executablePath,
  };
}

/**
 * Loads Electron through the repository-local package entry.
 *
 * Electron 43 downloads its platform binary lazily from this entry. Reading
 * `node_modules/electron/dist` directly skips that installation path in a new
 * worktree and leaves no macOS bundle to brand.
 */
function loadElectronExecutable(repositoryRoot: string): string {
  const requireFromRepository = createRequire(
    path.join(path.resolve(repositoryRoot), "package.json"),
  );
  const executablePath: unknown = requireFromRepository("electron");
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) {
    throw new Error("Electron did not resolve to an absolute executable path.");
  }
  return executablePath;
}

function macOsAppBundlePath(executablePath: string): string {
  const appPath = path.resolve(path.dirname(executablePath), "..", "..");
  if (path.extname(appPath).toLowerCase() !== ".app") {
    throw new Error(
      `Electron executable is not inside a macOS app bundle: ${executablePath}`,
    );
  }
  return appPath;
}

export async function prepareDevelopmentElectronBundle(
  input: DevelopmentElectronBundleInput,
): Promise<DevelopmentElectronBundle> {
  const productName = requireProductName(input.productName);
  const sourceAppPath = await fs.realpath(input.sourceAppPath);
  const sourceIdentity = await identifySourceBundle(sourceAppPath);
  const bundlePaths = developmentBundlePaths({
    cacheRootPath: input.cacheRootPath,
    productName,
    sourceIdentity,
  });
  if (await isPreparedBundle({ ...bundlePaths, productName })) {
    return bundlePaths;
  }

  await createPreparedBundle({
    bundlePaths,
    productName,
    sourceAppPath,
  });
  return bundlePaths;
}

async function identifySourceBundle(sourceAppPath: string): Promise<string> {
  const sourceExecutablePath = path.join(
    sourceAppPath,
    "Contents",
    "MacOS",
    "Electron",
  );
  const sourcePlistPath = path.join(sourceAppPath, "Contents", "Info.plist");
  const [executableStat, sourcePlist] = await Promise.all([
    fs.stat(sourceExecutablePath, { bigint: true }),
    fs.readFile(sourcePlistPath),
  ]);
  if (!executableStat.isFile()) {
    throw new Error(
      `Development Electron executable is missing: ${sourceExecutablePath}`,
    );
  }
  return createHash("sha256")
    .update(sourceAppPath)
    .update(sourcePlist)
    .update(executableStat.size.toString())
    .update(executableStat.mtimeNs.toString())
    .digest("hex")
    .slice(0, 16);
}

function developmentBundlePaths(input: {
  cacheRootPath: string;
  productName: string;
  sourceIdentity: string;
}): DevelopmentElectronBundlePaths {
  const versionCachePath = path.join(
    path.resolve(input.cacheRootPath),
    input.sourceIdentity,
  );
  const appPath = path.join(versionCachePath, `${input.productName}.app`);
  const executablePath = path.join(
    appPath,
    "Contents",
    "MacOS",
    "Electron",
  );
  return { appPath, executablePath, versionCachePath };
}

async function createPreparedBundle(input: {
  bundlePaths: DevelopmentElectronBundlePaths;
  productName: string;
  sourceAppPath: string;
}): Promise<void> {
  await fs.mkdir(input.bundlePaths.versionCachePath, { recursive: true });
  const temporaryPath = await fs.mkdtemp(
    path.join(input.bundlePaths.versionCachePath, ".preparing-"),
  );
  const temporaryAppPath = path.join(
    temporaryPath,
    `${input.productName}.app`,
  );
  try {
    await cloneAndBrandBundle({ ...input, temporaryAppPath });
    await commitPreparedBundle({ ...input, temporaryAppPath });
  } finally {
    await fs.rm(temporaryPath, { recursive: true, force: true });
  }
}

async function cloneAndBrandBundle(input: {
  productName: string;
  sourceAppPath: string;
  temporaryAppPath: string;
}): Promise<void> {
  await runCommand(
    "/bin/cp",
    ["-cR", input.sourceAppPath, input.temporaryAppPath],
    COPY_TIMEOUT_MS,
  );
  const plistPath = path.join(input.temporaryAppPath, "Contents", "Info.plist");
  await runCommand(
    PLIST_BUDDY_PATH,
    ["-c", `Set :CFBundleDisplayName ${input.productName}`, plistPath],
    PLIST_TIMEOUT_MS,
  );
  const preparedName = await readDisplayName(input.temporaryAppPath);
  if (preparedName !== input.productName) {
    throw new Error(
      `Development Electron bundle has display name ${preparedName ?? "missing"}`,
    );
  }
}

async function commitPreparedBundle(input: {
  bundlePaths: DevelopmentElectronBundlePaths;
  productName: string;
  temporaryAppPath: string;
}): Promise<void> {
  try {
    await fs.rename(input.temporaryAppPath, input.bundlePaths.appPath);
  } catch (error) {
    if (await isPreparedBundle({ ...input.bundlePaths, productName: input.productName })) {
      return;
    }
    await fs.rm(input.bundlePaths.appPath, { recursive: true, force: true });
    await fs.rename(input.temporaryAppPath, input.bundlePaths.appPath).catch(
      (renameError: unknown) => {
        throw new AggregateError(
          [error, renameError],
          "Could not replace the development Electron bundle",
        );
      },
    );
  }
}

function requireProductName(value: string): string {
  const productName = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(productName)) {
    throw new Error("Development Electron product name is invalid");
  }
  return productName;
}

async function isPreparedBundle(input: {
  appPath: string;
  executablePath: string;
  productName: string;
}): Promise<boolean> {
  try {
    const executableStat = await fs.stat(input.executablePath);
    if (!executableStat.isFile()) return false;
    return (await readDisplayName(input.appPath)) === input.productName;
  } catch {
    return false;
  }
}

async function readDisplayName(appPath: string): Promise<string | null> {
  try {
    const stdout = await runCommand(
      PLIST_BUDDY_PATH,
      [
        "-c",
        "Print :CFBundleDisplayName",
        path.join(appPath, "Contents", "Info.plist"),
      ],
      PLIST_TIMEOUT_MS,
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", maxBuffer: 64 * 1024, timeout },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
