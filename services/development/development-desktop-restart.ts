import { realpathSync } from "node:fs";
import * as path from "node:path";

export const DEVELOPMENT_DESKTOP_RESTART_ACTION =
  "replace-development-desktop-v1";
export const DEVELOPMENT_DESKTOP_RESTART_EXIT_CODE = 75;
export const DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV =
  "PIPELINE_DESKTOP_REPLACE_EXISTING";
export const DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV =
  "PIPELINE_DESKTOP_RESTART_REPOSITORY_ROOT";

export interface DevelopmentDesktopRestartRequest {
  action: typeof DEVELOPMENT_DESKTOP_RESTART_ACTION;
  repositoryRoot: string;
}

export function canonicalDevelopmentRepositoryRoot(value: string): string {
  const resolved = path.resolve(value);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // The caller still receives a normalized path. Validation will reject it
    // unless it identifies the same root as the running development app.
  }
  return canonical;
}

export function developmentDesktopRestartRequestFromEnvironment(
  environment: NodeJS.ProcessEnv,
): DevelopmentDesktopRestartRequest | undefined {
  if (environment[DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV] !== "1") {
    return undefined;
  }

  const repositoryRoot =
    environment[DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV]?.trim();
  if (!repositoryRoot) return undefined;

  return {
    action: DEVELOPMENT_DESKTOP_RESTART_ACTION,
    repositoryRoot: canonicalDevelopmentRepositoryRoot(repositoryRoot),
  };
}

export function isAcceptedDevelopmentDesktopRestartRequest(options: {
  additionalData: unknown;
  currentRepositoryRoot: string;
  isPackaged: boolean;
}): boolean {
  if (options.isPackaged || !isObject(options.additionalData)) return false;

  const action = options.additionalData.action;
  const repositoryRoot = options.additionalData.repositoryRoot;
  if (
    action !== DEVELOPMENT_DESKTOP_RESTART_ACTION ||
    typeof repositoryRoot !== "string" ||
    repositoryRoot.trim().length === 0
  ) {
    return false;
  }

  return canonicalDevelopmentRepositoryRoot(repositoryRoot) ===
    canonicalDevelopmentRepositoryRoot(options.currentRepositoryRoot);
}

export function isDevelopmentDesktopRestartRequest(
  additionalData: unknown,
): additionalData is DevelopmentDesktopRestartRequest {
  return isObject(additionalData) &&
    additionalData.action === DEVELOPMENT_DESKTOP_RESTART_ACTION &&
    typeof additionalData.repositoryRoot === "string" &&
    additionalData.repositoryRoot.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
