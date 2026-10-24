import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  isSafePathSegment,
  resolveRelativePathInside,
} from "../../core/path-safety.js";
import {
  buildSessionRunAssignmentLocation,
  type LegacyRunAssignmentLocation,
  type RunAssignmentLocation,
  type SessionRunAssignmentLocation,
} from "../../core/run-assignment-location.js";

export {
  buildSessionRunAssignmentLocation,
  type LegacyRunAssignmentLocation,
  type RunAssignmentLocation,
  type SessionRunAssignmentLocation,
} from "../../core/run-assignment-location.js";

export const RUN_ASSIGNMENT_LOCATOR_VERSION = 1 as const;

export interface RunAssignmentLocator {
  readonly version: typeof RUN_ASSIGNMENT_LOCATOR_VERSION;
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly relativeRunPath: string;
  readonly relativeAssignmentPath: string;
}

export async function writeRunAssignmentLocator(
  workspacePath: string,
  location: SessionRunAssignmentLocation,
): Promise<void> {
  const expected = buildSessionRunAssignmentLocation(workspacePath, location);
  if (!expected || !sameSessionLocation(expected, location)) {
    throw new Error("Run assignment location is invalid");
  }
  if (
    !isExactExistingDirectory(workspacePath, expected.relativeAssignmentPath)
  ) {
    throw new Error("Run assignment directory must exist before it is indexed");
  }

  const indexRoot = await ensureRunIndexRoot(workspacePath);
  const locatorPath = path.join(indexRoot, `${expected.assignmentId}.json`);
  const existing = readIndexedLocation(workspacePath, expected.assignmentId);
  if (fs.existsSync(locatorPath)) {
    if (existing && sameSessionLocation(existing, expected)) return;
    throw new Error(
      `Run assignment locator already exists: ${expected.assignmentId}`,
    );
  }

  const locator = locatorFromLocation(expected);
  await writeJsonAtomic(locatorPath, locator);
}

export async function removeRunAssignmentLocator(
  workspacePath: string,
  assignmentId: string,
): Promise<boolean> {
  if (!isSafePathSegment(assignmentId)) return false;
  const indexRoot = existingRunIndexRoot(workspacePath);
  if (!indexRoot) return false;
  const locatorPath = path.join(indexRoot, `${assignmentId}.json`);
  if (!isExactExistingFile(indexRoot, `${assignmentId}.json`)) return false;
  try {
    await fsp.unlink(locatorPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function resolveRunAssignmentLocation(
  workspacePath: string,
  assignmentId: string,
): RunAssignmentLocation | null {
  if (!isSafePathSegment(assignmentId)) return null;
  return (
    readIndexedLocation(workspacePath, assignmentId) ??
    readLegacyLocation(workspacePath, assignmentId)
  );
}

export function listRunAssignmentLocations(
  workspacePath: string,
): RunAssignmentLocation[] {
  const locations = new Map<string, RunAssignmentLocation>();
  for (const location of listIndexedLocations(workspacePath)) {
    locations.set(location.assignmentId, location);
  }
  for (const location of listLegacyLocations(workspacePath)) {
    if (!locations.has(location.assignmentId)) {
      locations.set(location.assignmentId, location);
    }
  }
  return [...locations.values()].sort((left, right) =>
    left.assignmentId.localeCompare(right.assignmentId),
  );
}

function readIndexedLocation(
  workspacePath: string,
  assignmentId: string,
): SessionRunAssignmentLocation | null {
  const indexRoot = existingRunIndexRoot(workspacePath);
  if (!indexRoot || !isExactExistingFile(indexRoot, `${assignmentId}.json`)) {
    return null;
  }
  const locator = parseLocator(
    fs.readFileSync(path.join(indexRoot, `${assignmentId}.json`), "utf8"),
  );
  if (!locator || locator.assignmentId !== assignmentId) return null;
  const location = buildSessionRunAssignmentLocation(workspacePath, locator);
  if (!location || !locatorMatchesLocation(locator, location)) return null;
  return isExactExistingDirectory(
    workspacePath,
    location.relativeAssignmentPath,
  )
    ? location
    : null;
}

function listIndexedLocations(
  workspacePath: string,
): SessionRunAssignmentLocation[] {
  const indexRoot = existingRunIndexRoot(workspacePath);
  if (!indexRoot) return [];
  return fs
    .readdirSync(indexRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .filter(isSafePathSegment)
    .map((assignmentId) => readIndexedLocation(workspacePath, assignmentId))
    .filter((location): location is SessionRunAssignmentLocation =>
      Boolean(location),
    );
}

function readLegacyLocation(
  workspacePath: string,
  assignmentId: string,
): LegacyRunAssignmentLocation | null {
  const relativeAssignmentPath = toPosixPath(
    path.join("assignments", assignmentId),
  );
  const assignmentPath = resolveRelativePathInside(
    workspacePath,
    relativeAssignmentPath,
  );
  if (
    !assignmentPath ||
    !isExactExistingDirectory(workspacePath, relativeAssignmentPath)
  ) {
    return null;
  }
  return {
    layout: "legacy",
    runId: assignmentId,
    assignmentId,
    runPath: assignmentPath,
    assignmentPath,
    relativeRunPath: relativeAssignmentPath,
    relativeAssignmentPath,
  };
}

function listLegacyLocations(
  workspacePath: string,
): LegacyRunAssignmentLocation[] {
  if (!isExactExistingDirectory(workspacePath, "assignments")) return [];
  const assignmentsRoot = path.join(workspacePath, "assignments");
  return fs
    .readdirSync(assignmentsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSafePathSegment(entry.name))
    .map((entry) => readLegacyLocation(workspacePath, entry.name))
    .filter((location): location is LegacyRunAssignmentLocation =>
      Boolean(location),
    );
}

function existingRunIndexRoot(workspacePath: string): string | null {
  return isExactExistingDirectory(workspacePath, "run-index")
    ? path.join(workspacePath, "run-index")
    : null;
}

async function ensureRunIndexRoot(workspacePath: string): Promise<string> {
  const indexRoot = path.join(workspacePath, "run-index");
  await fsp.mkdir(indexRoot, { recursive: true, mode: 0o700 });
  if (!isExactExistingDirectory(workspacePath, "run-index")) {
    throw new Error("Run index must be a contained directory");
  }
  return indexRoot;
}

function isExactExistingDirectory(
  rootPath: string,
  relativePath: string,
): boolean {
  const candidatePath = resolveRelativePathInside(rootPath, relativePath);
  if (!candidatePath) return false;
  try {
    const stat = fs.lstatSync(candidatePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return hasExactRealPath(rootPath, relativePath, candidatePath);
  } catch {
    return false;
  }
}

function isExactExistingFile(rootPath: string, relativePath: string): boolean {
  const candidatePath = resolveRelativePathInside(rootPath, relativePath);
  if (!candidatePath) return false;
  try {
    const stat = fs.lstatSync(candidatePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return hasExactRealPath(rootPath, relativePath, candidatePath);
  } catch {
    return false;
  }
}

function hasExactRealPath(
  rootPath: string,
  relativePath: string,
  candidatePath: string,
): boolean {
  try {
    const realRoot = fs.realpathSync(rootPath);
    const realCandidate = fs.realpathSync(candidatePath);
    const expectedRealPath = path.resolve(realRoot, ...relativePath.split("/"));
    return realCandidate === expectedRealPath;
  } catch {
    return false;
  }
}

function locatorFromLocation(
  location: SessionRunAssignmentLocation,
): RunAssignmentLocator {
  return {
    version: RUN_ASSIGNMENT_LOCATOR_VERSION,
    sessionId: location.sessionId,
    runId: location.runId,
    assignmentId: location.assignmentId,
    relativeRunPath: location.relativeRunPath,
    relativeAssignmentPath: location.relativeAssignmentPath,
  };
}

function parseLocator(content: string): RunAssignmentLocator | null {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (
      value.version !== RUN_ASSIGNMENT_LOCATOR_VERSION ||
      typeof value.sessionId !== "string" ||
      typeof value.runId !== "string" ||
      typeof value.assignmentId !== "string" ||
      typeof value.relativeRunPath !== "string" ||
      typeof value.relativeAssignmentPath !== "string"
    ) {
      return null;
    }
    return {
      version: RUN_ASSIGNMENT_LOCATOR_VERSION,
      sessionId: value.sessionId,
      runId: value.runId,
      assignmentId: value.assignmentId,
      relativeRunPath: value.relativeRunPath,
      relativeAssignmentPath: value.relativeAssignmentPath,
    };
  } catch {
    return null;
  }
}

function locatorMatchesLocation(
  locator: RunAssignmentLocator,
  location: SessionRunAssignmentLocation,
): boolean {
  return (
    locator.relativeRunPath === location.relativeRunPath &&
    locator.relativeAssignmentPath === location.relativeAssignmentPath
  );
}

function sameSessionLocation(
  left: SessionRunAssignmentLocation,
  right: SessionRunAssignmentLocation,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.assignmentId === right.assignmentId &&
    path.resolve(left.runPath) === path.resolve(right.runPath) &&
    path.resolve(left.assignmentPath) === path.resolve(right.assignmentPath) &&
    left.relativeRunPath === right.relativeRunPath &&
    left.relativeAssignmentPath === right.relativeAssignmentPath
  );
}

async function writeJsonAtomic(
  targetPath: string,
  value: RunAssignmentLocator,
): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fsp.rename(temporaryPath, targetPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
