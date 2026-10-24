import { seedCuratedBuiltIns } from "./builtin-resources.js";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const DESKTOP_EDITABLE_PROJECT_ENTRIES = [
  "agents",
  "skills",
  "teams",
  "workflows",
  "teams.yaml",
  "start.yaml",
] as const;

export interface DesktopProjectRootOptions {
  appRootPath: string;
  isPackaged: boolean;
  projectRootOverride?: string;
  userDataPath: string;
}

export interface DesktopProjectSeedResult {
  copiedFiles: number;
  skippedFiles: number;
}

interface MutableSeedResult {
  copiedFiles: number;
  skippedFiles: number;
}

export function resolveDesktopProjectRootPath(
  options: DesktopProjectRootOptions,
): string {
  if (options.projectRootOverride) {
    return path.resolve(options.projectRootOverride);
  }
  if (options.isPackaged) {
    return path.join(path.resolve(options.userDataPath), "project");
  }
  return path.resolve(options.appRootPath);
}

async function copyMissingFile(
  sourcePath: string,
  destinationPath: string,
  result: MutableSeedResult,
): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fs.copyFile(
      sourcePath,
      destinationPath,
      fsConstants.COPYFILE_EXCL,
    );
    result.copiedFiles += 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    result.skippedFiles += 1;
  }
}

async function copyMissingTree(
  sourcePath: string,
  destinationPath: string,
  result: MutableSeedResult,
): Promise<void> {
  const sourceStat = await fs.lstat(sourcePath);
  if (!sourceStat.isDirectory()) {
    await copyMissingFile(sourcePath, destinationPath, result);
    return;
  }

  await fs.mkdir(destinationPath, { recursive: true });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    await copyMissingTree(
      path.join(sourcePath, entry.name),
      path.join(destinationPath, entry.name),
      result,
    );
  }
}

export async function seedDesktopProjectRoot(options: {
  appRootPath: string;
  projectRootPath: string;
}): Promise<DesktopProjectSeedResult> {
  const appRootPath = path.resolve(options.appRootPath);
  const projectRootPath = path.resolve(options.projectRootPath);
  if (appRootPath === projectRootPath) {
    return { copiedFiles: 0, skippedFiles: 0 };
  }

  const curated = await seedCuratedBuiltIns(appRootPath, projectRootPath);
  if (curated) return curated;
  await fs.mkdir(projectRootPath, { recursive: true });
  const result: MutableSeedResult = { copiedFiles: 0, skippedFiles: 0 };
  for (const entry of DESKTOP_EDITABLE_PROJECT_ENTRIES) {
    await copyMissingTree(
      path.join(appRootPath, entry),
      path.join(projectRootPath, entry),
      result,
    );
  }
  return result;
}
