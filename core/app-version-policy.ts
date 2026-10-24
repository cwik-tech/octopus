export interface AppVersionPolicyInput {
  baseVersion: string;
  currentVersion: string;
  lockfileVersion: string;
  rootPackageVersion: string;
  changedPaths: readonly string[];
}

export type AppVersionPolicyResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export type VersionIncrementResult =
  | { ok: true; version: string }
  | { ok: false; message: string };

export function incrementPatchVersion(version: string): VersionIncrementResult {
  const parsed = parseVersion(version);
  if (parsed === undefined) {
    return {
      ok: false,
      message: `App version must use MAJOR.MINOR.PATCH integers; received ${version}.`,
    };
  }
  const nextPatch = parsed.patch + 1;
  if (!Number.isSafeInteger(nextPatch)) {
    return { ok: false, message: `App patch version cannot exceed ${parsed.patch}.` };
  }
  return {
    ok: true,
    version: `${parsed.major}.${parsed.minor}.${nextPatch}`,
  };
}

export function evaluateAppVersionPolicy(
  input: AppVersionPolicyInput,
): AppVersionPolicyResult {
  if (
    input.currentVersion !== input.lockfileVersion
    || input.currentVersion !== input.rootPackageVersion
  ) {
    return {
      ok: false,
      message: `package.json and package-lock.json must all use version ${input.currentVersion}.`,
    };
  }
  const comparison = compareVersions(input.currentVersion, input.baseVersion);
  if (comparison === undefined) {
    return {
      ok: false,
      message: "App versions must use MAJOR.MINOR.PATCH integers.",
    };
  }
  if (!input.changedPaths.some(isAppAffectingPath)) {
    return {
      ok: true,
      message: "No app-affecting changes require a version bump.",
    };
  }
  if (comparison <= 0) {
    return {
      ok: false,
      message: `App version must increase above ${input.baseVersion} for app-affecting changes.`,
    };
  }
  return {
    ok: true,
    message: `App version increased from ${input.baseVersion} to ${input.currentVersion}.`,
  };
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (match === null) return undefined;
  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  if (
    majorText === undefined
    || minorText === undefined
    || patchText === undefined
  ) {
    return undefined;
  }
  const parsed = {
    major: Number(majorText),
    minor: Number(minorText),
    patch: Number(patchText),
  };
  return Number.isSafeInteger(parsed.major)
    && Number.isSafeInteger(parsed.minor)
    && Number.isSafeInteger(parsed.patch)
    ? parsed
    : undefined;
}

function compareVersions(left: string, right: string): number | undefined {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (parsedLeft === undefined || parsedRight === undefined) return undefined;
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = parsedLeft[key] - parsedRight[key];
    if (difference !== 0) return difference;
  }
  return 0;
}

function isAppAffectingPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (
    normalized === "AGENTS.md"
    || normalized === "CLAUDE.md"
    || normalized === "README.md"
    || basename === "CHANGELOG.md"
  ) {
    return false;
  }
  if (
    normalized.startsWith(".github/")
    || normalized.startsWith(".claude/")
    || normalized.startsWith("docs/")
    || normalized.startsWith("examples/")
    || normalized.startsWith("tests/")
    || normalized.includes("/__tests__/")
    || normalized.includes("/tests/")
  ) {
    return false;
  }
  return !/\.(?:test|spec)\.[^/]+$/.test(basename);
}
