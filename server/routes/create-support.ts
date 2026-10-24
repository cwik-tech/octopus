import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import type * as http from "node:http";
import * as path from "node:path";
import type { URL } from "node:url";

import { createRevealArtifactRequestSchema } from "../../contracts/schemas/create-support-requests.js";
import { getChatDefaults } from "../../services/chat-defaults-service.js";
import type { ProviderSettingsService } from "../../services/provider-settings-service.js";
import { resolveExistingPathInside } from "../../core/path-safety.js";
import type { CreateJobRegistry } from "../create-job-registry.js";
import {
  ApiRequestError,
  parseApiRequest,
  readJsonBody,
  writeJson,
} from "../http.js";

const revealArtifactRequestSchema = createRevealArtifactRequestSchema({
  isAbsolutePath: path.isAbsolute,
});

export interface CreateSupportRoutesOptions {
  readonly repoRootPath?: string;
  readonly workspacePath?: string;
  readonly createJobRegistry: Pick<CreateJobRegistry, "cancelAndWait">;
  readonly providerSettingsService: Pick<ProviderSettingsService, "snapshot">;
}

export async function handleCreateSupportRoutes(params: {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly url: URL;
  readonly options: CreateSupportRoutesOptions;
}): Promise<boolean> {
  const { req, res, url, options } = params;
  if (!url.pathname.startsWith("/create/")) return false;

  // Preserve the existing Create boundary: every /create/* request requires
  // a repository root before any feature handler is considered.
  if (!options.repoRootPath) {
    writeJson(res, 500, {
      error: "Workflow generator requires repoRootPath to be configured",
    });
    return true;
  }

  const cancelCreateJobMatch = url.pathname.match(
    /^\/create\/jobs\/([^/]+)\/cancel$/,
  );
  if (req.method === "POST" && cancelCreateJobMatch) {
    const jobId = decodeCreateJobId(cancelCreateJobMatch[1] ?? "");
    writeJson(res, 200, await options.createJobRegistry.cancelAndWait(jobId));
    return true;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/create/reveal-artifact"
  ) {
    const body = parseApiRequest(
      revealArtifactRequestSchema,
      await readJsonBody(req),
    );
    const artifactPath = await findExistingArtifactPath(
      body.artifactPath,
      options,
    );
    if (!artifactPath) {
      writeJson(res, 404, {
        error: `Artifact file does not exist yet: ${body.artifactPath}`,
      });
      return true;
    }
    await revealPathInFileManager(artifactPath);
    writeJson(res, 200, { path: artifactPath });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/create/chat-defaults") {
    const providerSnapshot =
      await options.providerSettingsService.snapshot(false);
    writeJson(
      res,
      200,
      getChatDefaults(options.repoRootPath, providerSnapshot.defaultModel, {
        // The snapshot names a default only when one was stored and can run.
        // It never fills one in from the catalog, so there is no automatic
        // pick here for the persona to outrank.
        globalDefaultSource:
          providerSnapshot.defaultModelState.status === "available"
            ? "stored"
            : "none",
      }),
    );
    return true;
  }

  return false;
}

export function handleCreateNotFoundRoute(params: {
  readonly res: http.ServerResponse;
  readonly url: URL;
}): boolean {
  if (!params.url.pathname.startsWith("/create/")) return false;
  writeJson(params.res, 404, { error: "Not found" });
  return true;
}

function decodeCreateJobId(value: string): string {
  let jobId: string;
  try {
    jobId = decodeURIComponent(value).trim();
  } catch {
    throw new ApiRequestError("Invalid Create job id", 400);
  }
  if (!jobId) throw new ApiRequestError("Invalid Create job id", 400);
  if (jobId.length > 128) {
    throw new ApiRequestError("Create job id exceeds 128 characters", 400);
  }
  return jobId;
}

function resolveArtifactPathInsideBase(
  basePath: string | undefined,
  artifactPath: string,
): string | null {
  if (!basePath) return null;
  const resolvedBase = path.resolve(basePath);
  const resolvedPath = path.resolve(resolvedBase, artifactPath);
  const relative = path.relative(resolvedBase, resolvedPath);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return resolvedPath;
  }
  return null;
}

async function findExistingArtifactPath(
  artifactPath: string,
  options: Pick<
    CreateSupportRoutesOptions,
    "repoRootPath" | "workspacePath"
  >,
): Promise<string | null> {
  const candidates = [options.repoRootPath, options.workspacePath]
    .filter((basePath): basePath is string => Boolean(basePath))
    .map((basePath) => ({
      basePath,
      candidatePath: resolveArtifactPathInsideBase(basePath, artifactPath),
    }))
    .filter(
      (candidate): candidate is { basePath: string; candidatePath: string } =>
        Boolean(candidate.candidatePath),
    );

  for (const { basePath, candidatePath } of candidates) {
    try {
      await fs.stat(candidatePath);
      const contained = resolveExistingPathInside(basePath, candidatePath);
      if (contained) return contained;
    } catch {
      // Try the next safe candidate.
    }
  }

  return null;
}

async function revealPathInFileManager(targetPath: string): Promise<void> {
  const stat = await fs.stat(targetPath);
  const parentDir = stat.isDirectory() ? targetPath : path.dirname(targetPath);

  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = stat.isDirectory() ? [targetPath] : ["-R", targetPath];
  } else if (process.platform === "win32") {
    command = "explorer";
    args = stat.isDirectory() ? [targetPath] : [`/select,${targetPath}`];
  } else {
    command = "xdg-open";
    args = [parentDir];
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
