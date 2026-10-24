import { whenDefined } from '../../core/optional-properties.js'
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  isValidWorkspaceProjectId,
  type WorkspaceProject,
} from "../../contracts/projects.js";
import { writeFileAtomic } from "../../core/file-mutation.js";
import {
  isPathInside,
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../../core/path-safety.js";

const MAX_PROJECT_NAME_LENGTH = 200;
const MAX_PROJECT_DESCRIPTION_LENGTH = 20_000;

export class WorkspaceProjectStoreError extends Error {
  constructor(
    readonly code:
      | "invalid_project"
      | "invalid_project_id"
      | "unsafe_storage"
      | "project_exists",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceProjectStoreError";
  }
}

export class WorkspaceProjectStore {
  private readonly workspacePath: string;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: {
    workspacePath: string;
    now?: () => Date;
    randomUUID?: () => string;
  }) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  }

  async create(input: {
    name: string;
    description?: string;
  }): Promise<WorkspaceProject> {
    const name = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    const id = this.randomUUID();
    if (!isValidWorkspaceProjectId(id)) {
      throw new WorkspaceProjectStoreError(
        "invalid_project_id",
        "Generated project id is invalid",
      );
    }
    const root = await this.ensureRoot();
    const projectDir = this.resolveProjectDir(root, id);
    try {
      await fs.mkdir(projectDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceProjectStoreError(
          "project_exists",
          `Project already exists: ${id}`,
        );
      }
      throw error;
    }
    if (!resolveExistingPathInside(root, projectDir)) {
      throw new WorkspaceProjectStoreError(
        "unsafe_storage",
        "Project directory escaped the projects root",
      );
    }
    const now = this.now().toISOString();
    const project: WorkspaceProject = {
      version: 1,
      id,
      name,
      ...(description ? { description } : {}),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await this.writeProject(projectDir, project);
    return project;
  }

  async list(options: { includeArchived?: boolean } = {}): Promise<WorkspaceProject[]> {
    return (await this.listWithDiagnostics(options)).projects;
  }

  async listWithDiagnostics(
    options: { includeArchived?: boolean } = {},
  ): Promise<{
    projects: WorkspaceProject[];
    diagnostics: Array<{ code: "corrupt_project"; projectId: string }>;
  }> {
    const root = await this.ensureRoot();
    const projects: WorkspaceProject[] = [];
    const diagnostics: Array<{
      code: "corrupt_project";
      projectId: string;
    }> = [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidWorkspaceProjectId(entry.name)) {
        continue;
      }
      const projectDir = this.resolveProjectDir(root, entry.name);
      const project = await this.readProject(projectDir, entry.name);
      if (!project) {
        diagnostics.push({ code: "corrupt_project", projectId: entry.name });
        continue;
      }
      if (options.includeArchived || project.status === "active") {
        projects.push(project);
      }
    }
    projects.sort(compareProjects);
    return { projects, diagnostics };
  }

  async get(projectId: string): Promise<WorkspaceProject | null> {
    this.assertProjectId(projectId);
    const root = await this.ensureRoot();
    return this.readProject(this.resolveProjectDir(root, projectId), projectId);
  }

  async update(
    projectId: string,
    patch: { name?: string; description?: string },
  ): Promise<WorkspaceProject | null> {
    return this.mutate(projectId, (current) => {
      const name = patch.name === undefined
        ? current.name
        : normalizeName(patch.name);
      const description = Object.prototype.hasOwnProperty.call(
        patch,
        "description",
      )
        ? normalizeDescription(patch.description)
        : current.description;
      return {
        ...current,
        name,
        ...(description ? { description } : {}),
        updatedAt: this.now().toISOString(),
      };
    });
  }

  async archive(projectId: string): Promise<WorkspaceProject | null> {
    return this.mutate(projectId, (current) => {
      if (current.status === "archived") return current;
      const now = this.now().toISOString();
      return {
        ...current,
        status: "archived",
        archivedAt: now,
        updatedAt: now,
      };
    });
  }

  async restore(projectId: string): Promise<WorkspaceProject | null> {
    return this.mutate(projectId, (current) => {
      if (current.status === "active") return current;
      const { archivedAt: _archivedAt, ...rest } = current;
      return {
        ...rest,
        status: "active",
        updatedAt: this.now().toISOString(),
      };
    });
  }

  async hardDelete(projectId: string): Promise<boolean> {
    this.assertProjectId(projectId);
    const root = await this.ensureRoot();
    const projectDir = this.resolveProjectDir(root, projectId);
    const stat = await fs.lstat(projectDir).catch(() => null);
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceProjectStoreError(
        "unsafe_storage",
        "Project directory is unsafe",
      );
    }
    if (!resolveExistingPathInside(root, projectDir)) {
      throw new WorkspaceProjectStoreError(
        "unsafe_storage",
        "Project directory escaped the projects root",
      );
    }
    await fs.rm(projectDir, { recursive: true, force: true });
    return true;
  }

  private async mutate(
    projectId: string,
    operation: (current: WorkspaceProject) => WorkspaceProject,
  ): Promise<WorkspaceProject | null> {
    this.assertProjectId(projectId);
    const root = await this.ensureRoot();
    const projectDir = this.resolveProjectDir(root, projectId);
    const current = await this.readProject(projectDir, projectId);
    if (!current) return null;
    const next = operation(current);
    await this.writeProject(projectDir, next);
    return next;
  }

  private async ensureRoot(): Promise<string> {
    await fs.mkdir(this.workspacePath, { recursive: true });
    const workspaceRealPath = await fs.realpath(this.workspacePath);
    const root = path.join(this.workspacePath, "projects");
    const existing = await fs.lstat(root).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new WorkspaceProjectStoreError(
        "unsafe_storage",
        "Projects root must not be a symbolic link",
      );
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const rootRealPath = await fs.realpath(root);
    if (!isPathInside(workspaceRealPath, rootRealPath)) {
      throw new WorkspaceProjectStoreError(
        "unsafe_storage",
        "Projects root escaped the workspace",
      );
    }
    return root;
  }

  private resolveProjectDir(root: string, projectId: string): string {
    const projectDir = resolveRelativePathInside(root, projectId);
    if (!projectDir) {
      throw new WorkspaceProjectStoreError(
        "invalid_project_id",
        "Project id must be a safe UUID",
      );
    }
    return projectDir;
  }

  private async readProject(
    projectDir: string,
    expectedId: string,
  ): Promise<WorkspaceProject | null> {
    const stat = await fs.lstat(projectDir).catch(() => null);
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const root = path.dirname(projectDir);
    if (!resolveExistingPathInside(root, projectDir)) return null;
    const recordPath = path.join(projectDir, "project.json");
    const recordStat = await fs.lstat(recordPath).catch(() => null);
    if (!recordStat?.isFile() || recordStat.isSymbolicLink()) return null;
    if (!resolveExistingPathInside(projectDir, recordPath)) return null;
    try {
      return parseProject(JSON.parse(await fs.readFile(recordPath, "utf8")), expectedId);
    } catch {
      return null;
    }
  }

  private async writeProject(
    projectDir: string,
    project: WorkspaceProject,
  ): Promise<void> {
    const root = path.dirname(projectDir);
    if (!resolveExistingPathInside(root, projectDir)) {
      throw new WorkspaceProjectStoreError(
        "unsafe_storage",
        "Project directory escaped the projects root",
      );
    }
    const recordPath = path.join(projectDir, "project.json");
    const existing = await fs.lstat(recordPath).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new WorkspaceProjectStoreError(
        "unsafe_storage",
        "Project record must not be a symbolic link",
      );
    }
    await writeFileAtomic(
      recordPath,
      Buffer.from(`${JSON.stringify(project, null, 2)}\n`, "utf8"),
    );
  }

  private assertProjectId(projectId: string): void {
    if (!isValidWorkspaceProjectId(projectId)) {
      throw new WorkspaceProjectStoreError(
        "invalid_project_id",
        "Project id must be a UUID",
      );
    }
  }
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") {
    throw new WorkspaceProjectStoreError(
      "invalid_project",
      "Project name must be a string",
    );
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_PROJECT_NAME_LENGTH) {
    throw new WorkspaceProjectStoreError(
      "invalid_project",
      `Project name must contain 1-${MAX_PROJECT_NAME_LENGTH} characters`,
    );
  }
  return normalized;
}

function normalizeDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkspaceProjectStoreError(
      "invalid_project",
      "Project description must be a string",
    );
  }
  const normalized = value.trim();
  if (normalized.length > MAX_PROJECT_DESCRIPTION_LENGTH) {
    throw new WorkspaceProjectStoreError(
      "invalid_project",
      `Project description exceeds ${MAX_PROJECT_DESCRIPTION_LENGTH} characters`,
    );
  }
  return normalized || undefined;
}

function parseProject(
  value: unknown,
  expectedId: string,
): WorkspaceProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<WorkspaceProject>;
  if (
    record.version !== 1 ||
    record.id !== expectedId ||
    !isValidWorkspaceProjectId(record.id) ||
    typeof record.name !== "string" ||
    !record.name.trim() ||
    record.name.length > MAX_PROJECT_NAME_LENGTH ||
    (record.description !== undefined &&
      (typeof record.description !== "string" ||
        record.description.length > MAX_PROJECT_DESCRIPTION_LENGTH)) ||
    (record.status !== "active" && record.status !== "archived") ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    (record.archivedAt !== undefined &&
      (typeof record.archivedAt !== "string" ||
        !Number.isFinite(Date.parse(record.archivedAt)))) ||
    (record.status === "archived" && !record.archivedAt)
  ) {
    return null;
  }
  return record as WorkspaceProject;
}

function compareProjects(
  left: WorkspaceProject,
  right: WorkspaceProject,
): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}
