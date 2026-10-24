import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  isValidWorkspaceProjectId,
  type WorkspaceProjectBrief,
  type WorkspaceProjectFile,
} from "../../contracts/projects.js";
import {
  UPLOADABLE_DOCUMENT_EXTENSIONS,
  isUploadableDocumentFilename,
} from "../../contracts/uploadable-formats.js";
import { writeFileAtomic } from "../../core/file-mutation.js";
import {
  isSafePathSegment,
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../../core/path-safety.js";
import { FileSourceRepository } from "../file-sources/file-source-repository.js";

export const PROJECT_CONTEXT_MAX_FILES = 20;
/**
 * What a shared project file may be, taken from the one list the picker and the 400 also read.
 *
 * Stated as a re-export rather than a copy: when this was its own array it fell nine extensions
 * behind the picker, and the picker went on offering files this store then rejected.
 */
export const PROJECT_CONTEXT_FILE_EXTENSIONS = UPLOADABLE_DOCUMENT_EXTENSIONS;

export type ProjectFileSaveResult =
  | { status: "saved"; file: WorkspaceProjectFile }
  | { status: "invalid_filename" }
  | { status: "unsupported_file" }
  | { status: "duplicate_file" }
  | { status: "file_limit_reached" };

export class WorkspaceProjectContextStoreError extends Error {
  constructor(
    readonly code: "invalid_project_id" | "unsafe_storage",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceProjectContextStoreError";
  }
}

export class WorkspaceProjectContextStore {
  private readonly workspacePath: string;
  private readonly projectsRoot: string;

  constructor(options: { workspacePath: string }) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.projectsRoot = path.join(this.workspacePath, "projects");
  }

  async readBrief(projectId: string): Promise<WorkspaceProjectBrief | null> {
    const projectDir = await this.resolveProjectDir(projectId);
    const briefPath = path.join(projectDir, "context", "brief.md");
    const stat = await fs.lstat(briefPath).catch(() => null);
    if (!stat) return null;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !resolveExistingPathInside(projectDir, briefPath)
    ) {
      return null;
    }
    return {
      content: await fs.readFile(briefPath, "utf8"),
      updatedAt: stat.mtime.toISOString(),
    };
  }

  async saveBrief(
    projectId: string,
    content: string,
  ): Promise<WorkspaceProjectBrief> {
    const projectDir = await this.resolveProjectDir(projectId);
    const contextDir = path.join(projectDir, "context");
    await ensureContainedDirectory(projectDir, contextDir, "Project context directory");
    const briefPath = path.join(contextDir, "brief.md");
    const existing = await fs.lstat(briefPath).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new WorkspaceProjectContextStoreError(
        "unsafe_storage",
        "Project brief must not be a symbolic link",
      );
    }
    if (!content) {
      await fs.unlink(briefPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return { content: "", updatedAt: new Date().toISOString() };
    }
    await writeFileAtomic(briefPath, Buffer.from(content, "utf8"));
    const stat = await fs.stat(briefPath);
    return { content, updatedAt: stat.mtime.toISOString() };
  }

  filesDir(projectId: string): string {
    this.assertProjectId(projectId);
    return path.join(this.projectsRoot, projectId, "files");
  }

  async saveFile(
    projectId: string,
    input: { filename: string; contents: Uint8Array },
  ): Promise<ProjectFileSaveResult> {
    const projectDir = await this.resolveProjectDir(projectId);
    const filename = sanitizeProjectFilename(input.filename);
    if (!filename) return { status: "invalid_filename" };
    if (!isSupportedProjectFilename(filename)) {
      return { status: "unsupported_file" };
    }
    const repository = this.fileRepository(projectId, projectDir);
    const target = await repository.inspectSaveTarget(filename);
    if (target === "invalid_path") return { status: "invalid_filename" };
    if (target === "duplicate_file") return { status: "duplicate_file" };
    if ((await repository.list()).length >= PROJECT_CONTEXT_MAX_FILES) {
      return { status: "file_limit_reached" };
    }
    const saved = await repository.save(filename, input.contents, {
      overwrite: false,
    });
    if (saved.status === "invalid_path") return { status: "invalid_filename" };
    if (saved.status === "duplicate_file") return { status: "duplicate_file" };
    return { status: "saved", file: saved.file };
  }

  async listFiles(projectId: string): Promise<WorkspaceProjectFile[]> {
    const projectDir = await this.resolveProjectDir(projectId);
    return this.fileRepository(projectId, projectDir).list();
  }

  async readFile(projectId: string, filename: string): Promise<Buffer | null> {
    if (!isSafePathSegment(filename)) return null;
    const projectDir = await this.resolveProjectDir(projectId);
    const filesDir = this.filesDir(projectId);
    const rootStat = await fs.lstat(filesDir).catch(() => null);
    if (
      !rootStat?.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !resolveExistingPathInside(projectDir, filesDir)
    ) {
      return null;
    }
    const filePath = resolveRelativePathInside(filesDir, filename);
    if (!filePath || !resolveExistingPathInside(filesDir, filePath)) return null;
    const stat = await fs.lstat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) return null;
    return fs.readFile(filePath);
  }

  async readParsedText(
    projectId: string,
    outputName: string,
  ): Promise<string | null> {
    const projectDir = await this.resolveProjectDir(projectId);
    return this.fileRepository(projectId, projectDir).readParsedText(outputName);
  }

  async deleteFile(projectId: string, filename: string): Promise<boolean> {
    const projectDir = await this.resolveProjectDir(projectId);
    return this.fileRepository(projectId, projectDir).delete(filename);
  }

  async hasContent(projectId: string): Promise<boolean> {
    if (await this.readBrief(projectId)) return true;
    if ((await this.listFiles(projectId)).length > 0) return true;
    const projectDir = await this.resolveProjectDir(projectId);
    const memoryRoot = path.join(projectDir, "context", "memory-proposals");
    const stat = await fs.lstat(memoryRoot).catch(() => null);
    if (!stat) return false;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !resolveExistingPathInside(projectDir, memoryRoot)
    ) {
      throw new WorkspaceProjectContextStoreError(
        "unsafe_storage",
        "Memory proposals directory is unsafe",
      );
    }
    return (await fs.readdir(memoryRoot, { withFileTypes: true })).some(
      (entry) => entry.name.endsWith(".json"),
    );
  }

  private fileRepository(
    projectId: string,
    projectDir: string,
  ): FileSourceRepository {
    return new FileSourceRepository({
      rootDir: this.filesDir(projectId),
      containmentRoot: projectDir,
    });
  }

  private async resolveProjectDir(projectId: string): Promise<string> {
    this.assertProjectId(projectId);
    const projectDir = resolveRelativePathInside(this.projectsRoot, projectId);
    const projectStat = projectDir
      ? await fs.lstat(projectDir).catch(() => null)
      : null;
    if (
      !projectDir ||
      !projectStat?.isDirectory() ||
      projectStat.isSymbolicLink() ||
      !resolveExistingPathInside(this.projectsRoot, projectDir)
    ) {
      throw new WorkspaceProjectContextStoreError(
        "unsafe_storage",
        "Project content directory is unavailable or unsafe",
      );
    }
    return projectDir;
  }

  private assertProjectId(projectId: string): void {
    if (!isValidWorkspaceProjectId(projectId)) {
      throw new WorkspaceProjectContextStoreError(
        "invalid_project_id",
        "Project id must be a UUID",
      );
    }
  }
}

async function ensureContainedDirectory(
  containmentRoot: string,
  directory: string,
  label: string,
): Promise<void> {
  const existing = await fs.lstat(directory).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new WorkspaceProjectContextStoreError(
      "unsafe_storage",
      `${label} must not be a symbolic link`,
    );
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!resolveExistingPathInside(containmentRoot, directory)) {
    throw new WorkspaceProjectContextStoreError(
      "unsafe_storage",
      `${label} escaped its project`,
    );
  }
}

function sanitizeProjectFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const filename = path
    .basename(value)
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 200);
  return filename && filename !== "." && filename !== ".." ? filename : null;
}

function isSupportedProjectFilename(filename: string): boolean {
  return isUploadableDocumentFilename(filename);
}
