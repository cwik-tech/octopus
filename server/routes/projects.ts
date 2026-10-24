import type * as http from "node:http";
import * as path from "node:path";
import type { URL } from "node:url";

import { isValidWorkspaceProjectId } from "../../contracts/projects.js";
import { isValidSessionId } from "../../contracts/sessions.js";
import { unsupportedUploadMessage } from "../../contracts/uploadable-formats.js";
import {
  projectCreateRequestSchema,
  projectDeleteRequestSchema,
  projectBriefUpdateRequestSchema,
  projectMemoryProposalCreateRequestSchema,
  projectUpdateRequestSchema,
} from "../../contracts/schemas/project-requests.js";
import { withFileMutationLock } from "../../core/file-mutation.js";
import { isSafePathSegment } from "../../core/path-safety.js";
import {
  WorkspaceProjectContextStoreError,
  type ProjectFileSaveResult,
  type WorkspaceProjectContextStore,
} from "../../domains/projects/project-context-store.js";
import {
  WorkspaceProjectServiceError,
  type WorkspaceProjectService,
} from "../../domains/projects/workspace-project-service.js";
import type { FileParserLauncher } from "../../core/file-parser-launcher.js";
import type { WorkspaceProjectFileCatalogService } from "../../services/project-file-catalog-service.js";
import {
  WorkspaceProjectMemoryServiceError,
  type WorkspaceProjectMemoryService,
} from "../../services/project-memory-service.js";
import { WorkspaceProjectMemoryStoreError } from "../../domains/projects/project-memory-store.js";
import type { WorkspaceProjectExportService } from "../../services/project-export-service.js";
import type { WorkspaceProjectDetailsService } from "../../services/project-details-service.js";
import type { SharedFolderService } from "../../services/shared-folder-service.js";
import {
  ApiRequestError,
  parseApiRequest,
  readJsonBody,
  writeJson,
} from "../http.js";
import { readFilenameHeader, readUploadBody } from "../upload-body.js";
import { handleProjectSharedFolderRoutes } from "./shared-folders.js";

export async function handleProjectRoutes(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  service?: WorkspaceProjectService;
  contextStore?: WorkspaceProjectContextStore;
  catalogService?: WorkspaceProjectFileCatalogService;
  memoryService?: WorkspaceProjectMemoryService;
  exportService?: WorkspaceProjectExportService;
  detailsService?: WorkspaceProjectDetailsService;
  fileParserLauncher?: FileParserLauncher;
  sharedFolderService?: SharedFolderService;
}): Promise<boolean> {
  const {
    req,
    res,
    url,
    service,
    contextStore,
    catalogService,
    memoryService,
    exportService,
    detailsService,
    fileParserLauncher,
    sharedFolderService,
  } = params;
  if (
    url.pathname !== "/projects" &&
    !url.pathname.startsWith("/projects/")
  ) {
    return false;
  }
  if (!service) {
    writeJson(res, 501, {
      error: "Projects are not configured on this server",
    });
    return true;
  }

  if (url.pathname === "/projects" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const input = parseApiRequest(projectCreateRequestSchema, payload);
    const project = await service.createProject(input);
    writeJson(res, 201, project);
    return true;
  }

  if (url.pathname === "/projects" && req.method === "GET") {
    const projects = await service.listProjects({
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });
    writeJson(res, 200, { projects });
    return true;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  // `/projects/:id/folders` and `/projects/:id/folders/:folderId`: the folders
  // every chat in the project gets (docs/feature-local-folder-access.md).
  if (
    (segments.length === 3 || segments.length === 4) &&
    segments[0] === "projects" &&
    segments[2] === "folders"
  ) {
    const projectId = requireSegment(segments, 1);
    if (!validateProjectId(res, projectId)) return true;
    return handleProjectSharedFolderRoutes({
      req,
      res,
      projectId,
      folderId: segments[3],
      service: sharedFolderService,
    });
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "details"
  ) {
    const projectId = requireSegment(segments, 1);
    if (!validateProjectId(res, projectId)) return true;
    if (!detailsService) {
      writeJson(res, 501, { error: "Project details are not configured" });
      return true;
    }
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      writeJson(res, 200, await detailsService.get(projectId));
    } catch (error) {
      if (!writeProjectMemoryError(res, error)) throw error;
    }
    return true;
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "export"
  ) {
    const projectId = requireSegment(segments, 1);
    if (!validateProjectId(res, projectId)) return true;
    if (!exportService) {
      writeJson(res, 501, { error: "Project export is not configured" });
      return true;
    }
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const exported = await exportService.exportProject(projectId);
      res.setHeader(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(projectExportFilename(exported.project.name))}`,
      );
      writeJson(res, 200, exported);
    } catch (error) {
      if (!writeWorkspaceProjectServiceError(res, error)) throw error;
    }
    return true;
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "memory-proposals"
  ) {
    const projectId = requireSegment(segments, 1);
    if (!validateProjectId(res, projectId)) return true;
    if (!memoryService) return writeProjectMemoryUnavailable(res);
    try {
      if (req.method === "GET") {
        const status = url.searchParams.get("status");
        if (
          status !== null &&
          status !== "pending" &&
          status !== "approved" &&
          status !== "rejected"
        ) {
          writeJson(res, 400, { error: "Invalid memory proposal status" });
          return true;
        }
        writeJson(res, 200, {
          proposals: await memoryService.list(
            projectId,
            status ? { status } : {},
          ),
        });
        return true;
      }
      if (req.method === "POST") {
        const payload = await readJsonBody(req);
        const input = parseApiRequest(
          projectMemoryProposalCreateRequestSchema,
          payload,
        );
        writeJson(res, 201, await memoryService.propose(projectId, input));
        return true;
      }
      writeJson(res, 405, { error: "Method not allowed" });
    } catch (error) {
      if (!writeProjectMemoryError(res, error)) throw error;
    }
    return true;
  }

  if (
    segments.length === 5 &&
    segments[0] === "projects" &&
    segments[2] === "memory-proposals" &&
    (segments[4] === "approve" || segments[4] === "reject")
  ) {
    const projectId = requireSegment(segments, 1);
    if (!validateProjectId(res, projectId)) return true;
    if (!memoryService) return writeProjectMemoryUnavailable(res);
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      writeJson(
        res,
        200,
        await memoryService.decide(
          projectId,
          requireSegment(segments, 3),
          segments[4] === "approve" ? "approved" : "rejected",
        ),
      );
    } catch (error) {
      if (!writeProjectMemoryError(res, error)) throw error;
    }
    return true;
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "catalog"
  ) {
    const projectId = requireSegment(segments, 1);
    if (!validateProjectId(res, projectId)) return true;
    if (!catalogService) return writeProjectCatalogUnavailable(res);
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      writeJson(res, 200, await catalogService.listRoot(projectId));
    } catch (error) {
      if (!writeWorkspaceProjectServiceError(res, error)) throw error;
    }
    return true;
  }

  if (
    segments.length === 5 &&
    segments[0] === "projects" &&
    segments[2] === "catalog" &&
    segments[3] === "sessions"
  ) {
    const projectId = requireSegment(segments, 1);
    const sessionId = requireSegment(segments, 4);
    if (!validateProjectId(res, projectId)) return true;
    if (!isValidSessionId(sessionId)) {
      writeJson(res, 400, { error: "Invalid session id" });
      return true;
    }
    if (!catalogService) return writeProjectCatalogUnavailable(res);
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      writeJson(
        res,
        200,
        await catalogService.listSessionBranch(projectId, sessionId),
      );
    } catch (error) {
      if (!writeWorkspaceProjectServiceError(res, error)) throw error;
    }
    return true;
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "brief"
  ) {
    const projectId = requireSegment(segments, 1);
    if (!validateProjectId(res, projectId)) return true;
    if (!contextStore) return writeProjectContextUnavailable(res);
    try {
      const project = await service.getProjectRecord(projectId);
      if (req.method === "GET") {
        const brief = await contextStore.readBrief(projectId);
        writeJson(
          res,
          200,
          brief ?? { content: "", updatedAt: project.updatedAt },
        );
        return true;
      }
      if (req.method === "PUT") {
        requireActiveProject(project);
        const payload = await readJsonBody(req);
        const input = parseApiRequest(projectBriefUpdateRequestSchema, payload);
        const brief = await contextStore.saveBrief(projectId, input.content);
        writeJson(res, 200, brief);
        return true;
      }
      writeJson(res, 405, { error: "Method not allowed" });
    } catch (error) {
      if (!writeProjectContextError(res, error)) throw error;
    }
    return true;
  }

  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "files"
  ) {
    const projectId = requireSegment(segments, 1);
    if (!validateProjectId(res, projectId)) return true;
    if (!contextStore) return writeProjectContextUnavailable(res);
    try {
      const project = await service.getProjectRecord(projectId);
      if (req.method === "GET") {
        writeJson(res, 200, {
          files: await contextStore.listFiles(projectId),
        });
        return true;
      }
      if (req.method === "POST") {
        requireActiveProject(project);
        const rawFilename = readFilenameHeader(req);
        if (!rawFilename) {
          writeJson(res, 400, {
            error: "Missing required header: x-filename",
          });
          return true;
        }
        const contents = await readUploadBody(req);
        const filesDir = contextStore.filesDir(projectId);
        const uploaded = await withFileMutationLock(filesDir, async () => {
          const saved = await contextStore.saveFile(projectId, {
            filename: decodeHeaderValue(rawFilename),
            contents,
          });
          if (saved.status !== "saved") return saved;
          if (fileParserLauncher) {
            try {
              await fileParserLauncher.parseDirectory(filesDir);
            } catch (error) {
              throw new ApiRequestError(
                `File uploaded, but parsing failed: ${errorMessage(error)}`,
                502,
              );
            }
          }
          const refreshed = (await contextStore.listFiles(projectId)).find(
            (file) => file.name === saved.file.name,
          );
          return {
            status: "saved" as const,
            file: refreshed ?? saved.file,
          };
        });
        if (uploaded.status !== "saved") {
          writeProjectUploadError(res, uploaded.status);
          return true;
        }
        writeJson(res, 201, uploaded.file);
        return true;
      }
      writeJson(res, 405, { error: "Method not allowed" });
    } catch (error) {
      if (!writeProjectContextError(res, error)) throw error;
    }
    return true;
  }

  if (
    segments.length === 4 &&
    segments[0] === "projects" &&
    segments[2] === "files"
  ) {
    const projectId = requireSegment(segments, 1);
    if (!validateProjectId(res, projectId)) return true;
    const filename = decodeSafeFilename(requireSegment(segments, 3));
    if (!filename) {
      writeJson(res, 400, { error: "Invalid filename" });
      return true;
    }
    if (!contextStore) return writeProjectContextUnavailable(res);
    try {
      const project = await service.getProjectRecord(projectId);
      if (req.method === "GET") {
        const contents = await contextStore.readFile(projectId, filename);
        if (!contents) {
          writeJson(res, 404, { error: "File not found" });
          return true;
        }
        res.statusCode = 200;
        res.setHeader("content-type", contentTypeForFilename(filename));
        // The bytes are whatever a person uploaded, and the picker now admits markup. Anything
        // `contentTypeForFilename` does not recognise leaves here as application/octet-stream,
        // which the MIME Sniffing standard permits a browser to sniff into text/html; downloading
        // a shared file would then be a way to run script against the loopback API origin.
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader(
          "content-disposition",
          `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        );
        res.setHeader("content-length", contents.byteLength);
        res.end(contents);
        return true;
      }
      if (req.method === "DELETE") {
        requireActiveProject(project);
        const deleted = await withFileMutationLock(
          contextStore.filesDir(projectId),
          () => contextStore.deleteFile(projectId, filename),
        );
        if (!deleted) {
          writeJson(res, 404, { error: "File not found" });
          return true;
        }
        res.statusCode = 204;
        res.end();
        return true;
      }
      writeJson(res, 405, { error: "Method not allowed" });
    } catch (error) {
      if (!writeProjectContextError(res, error)) throw error;
    }
    return true;
  }

  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "sessions"
  ) {
    const projectId = requireSegment(segments, 1);
    if (!isValidWorkspaceProjectId(projectId)) {
      writeJson(res, 400, { error: "Invalid project id" });
      return true;
    }
    if (req.method === "GET") {
      try {
        const sessions = await service.listProjectSessions(projectId);
        writeJson(res, 200, { sessions });
      } catch (error) {
        if (!writeWorkspaceProjectServiceError(res, error)) throw error;
      }
      return true;
    }
  }

  if (
    segments.length === 4 &&
    segments[0] === "projects" &&
    segments[2] === "sessions"
  ) {
    const projectId = requireSegment(segments, 1);
    const sessionId = requireSegment(segments, 3);
    if (!isValidWorkspaceProjectId(projectId)) {
      writeJson(res, 400, { error: "Invalid project id" });
      return true;
    }
    if (!isValidSessionId(sessionId)) {
      writeJson(res, 400, { error: "Invalid session id" });
      return true;
    }
    if (req.method === "PUT") {
      try {
        const membership = await service.assignSession(projectId, sessionId);
        writeJson(res, 200, membership);
      } catch (error) {
        if (!writeWorkspaceProjectServiceError(res, error)) throw error;
      }
      return true;
    }
    if (req.method === "DELETE") {
      try {
        await service.removeSession(projectId, sessionId);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        if (!writeWorkspaceProjectServiceError(res, error)) throw error;
      }
      return true;
    }
  }

  if (segments.length === 2 && segments[0] === "projects") {
    const projectId = requireSegment(segments, 1);
    if (!isValidWorkspaceProjectId(projectId)) {
      writeJson(res, 400, { error: "Invalid project id" });
      return true;
    }
    if (req.method === "GET") {
      try {
        const project = await service.getProject(projectId);
        writeJson(res, 200, project);
      } catch (error) {
        if (!writeWorkspaceProjectServiceError(res, error)) throw error;
      }
      return true;
    }
    if (req.method === "PATCH") {
      const payload = await readJsonBody(req);
      const patch = parseApiRequest(projectUpdateRequestSchema, payload);
      try {
        let project;
        if (patch.name !== undefined || patch.description !== undefined) {
          project = await service.updateProject(projectId, patch);
        }
        if (patch.status === "archived") {
          project = await service.archiveProject(projectId);
        } else if (patch.status === "active") {
          project = await service.restoreProject(projectId);
        }
        writeJson(res, 200, project);
      } catch (error) {
        if (!writeWorkspaceProjectServiceError(res, error)) throw error;
      }
      return true;
    }
    if (req.method === "DELETE") {
      try {
        const contentType = req.headers["content-type"];
        if (
          typeof contentType === "string" &&
          contentType.toLowerCase().includes("application/json")
        ) {
          const payload = await readJsonBody(req);
          const input = parseApiRequest(projectDeleteRequestSchema, payload);
          await service.deleteProject(projectId, input.mode);
        } else {
          await service.hardDeleteProject(projectId);
        }
        // The project's folder list went with it, and with "delete_sessions"
        // its chats' lists too, so a folder nothing else attaches loses its
        // parses and parsed text before the delete is answered.
        await sharedFolderService?.handleOwnerDeleted();
        res.statusCode = 204;
        res.end();
      } catch (error) {
        if (!writeWorkspaceProjectServiceError(res, error)) throw error;
      }
      return true;
    }
  }

  return false;
}

/** Every caller checks `segments.length` first, so a missing segment is a routing bug. */
function requireSegment(segments: readonly string[], index: number): string {
  const segment = segments[index];
  if (segment === undefined) {
    throw new Error(`Project route matched without path segment ${index}`);
  }
  return segment;
}

function validateProjectId(
  res: http.ServerResponse,
  projectId: string,
): boolean {
  if (isValidWorkspaceProjectId(projectId)) return true;
  writeJson(res, 400, { error: "Invalid project id" });
  return false;
}

function requireActiveProject(project: { status: "active" | "archived" }): void {
  if (project.status === "active") return;
  throw new WorkspaceProjectServiceError(
    "archived_project",
    "Archived projects are read-only",
  );
}

function writeProjectContextUnavailable(res: http.ServerResponse): true {
  writeJson(res, 501, { error: "Project context is not configured" });
  return true;
}

function writeProjectCatalogUnavailable(res: http.ServerResponse): true {
  writeJson(res, 501, { error: "Project catalog is not configured" });
  return true;
}

function writeProjectMemoryUnavailable(res: http.ServerResponse): true {
  writeJson(res, 501, { error: "Project memory is not configured" });
  return true;
}

function writeProjectMemoryError(
  res: http.ServerResponse,
  error: unknown,
): boolean {
  if (writeWorkspaceProjectServiceError(res, error)) return true;
  if (error instanceof WorkspaceProjectMemoryServiceError) {
    writeJson(res, 409, { error: error.message, code: error.code });
    return true;
  }
  if (!(error instanceof WorkspaceProjectMemoryStoreError)) return false;
  const statusCode = error.code === "proposal_not_found" ? 404
    : error.code === "proposal_already_decided" ? 409
    : 400;
  writeJson(res, statusCode, { error: error.message, code: error.code });
  return true;
}

function writeProjectContextError(
  res: http.ServerResponse,
  error: unknown,
): boolean {
  if (writeWorkspaceProjectServiceError(res, error)) return true;
  if (!(error instanceof WorkspaceProjectContextStoreError)) return false;
  writeJson(res, 400, {
    error: error.message,
    code: error.code,
  });
  return true;
}

function writeProjectUploadError(
  res: http.ServerResponse,
  status: Exclude<ProjectFileSaveResult["status"], "saved">,
): void {
  switch (status) {
    case "duplicate_file":
      writeJson(res, 409, {
        error: "A shared file with that name already exists",
      });
      return;
    case "file_limit_reached":
      writeJson(res, 400, {
        error: "A maximum of 20 shared project files is allowed",
      });
      return;
    case "unsupported_file":
      writeJson(res, 400, {
        // Composed from the same list the picker's `accept` and the store's allow-list read, so
        // this sentence cannot come to describe a different set than the one that was enforced.
        error: unsupportedUploadMessage("project file"),
      });
      return;
    case "invalid_filename":
      writeJson(res, 400, { error: "Invalid filename" });
  }
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeSafeFilename(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return isSafePathSegment(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function contentTypeForFilename(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectExportFilename(projectName: string): string {
  const slug = projectName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "workspace-project";
  return `${slug}.workspace-project.json`;
}

export function writeWorkspaceProjectServiceError(
  res: http.ServerResponse,
  error: unknown,
): boolean {
  if (!(error instanceof WorkspaceProjectServiceError)) return false;
  const statusCode =
    error.code === "project_not_found" || error.code === "session_not_found"
      ? 404
      : 409;
  writeJson(res, statusCode, { error: error.message, code: error.code });
  return true;
}
