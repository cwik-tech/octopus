import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  isValidWorkspaceProjectId,
  type WorkspaceProjectMembership,
} from "../../contracts/projects.js";
import { isValidSessionId } from "../../contracts/sessions.js";
import { withCrossProcessFileLock } from "../../core/cross-process-file-lock.js";
import { writeFileAtomic } from "../../core/file-mutation.js";
import {
  isPathInside,
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../../core/path-safety.js";

export class WorkspaceProjectMembershipStoreError extends Error {
  constructor(
    readonly code:
      | "invalid_session_id"
      | "invalid_project_id"
      | "unsafe_storage"
      | "corrupt_membership",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceProjectMembershipStoreError";
  }
}

export interface WorkspaceProjectMembershipTransaction {
  get(sessionId: string): Promise<WorkspaceProjectMembership | null>;
  list(): Promise<WorkspaceProjectMembership[]>;
  assign(
    sessionId: string,
    projectId: string,
  ): Promise<WorkspaceProjectMembership>;
  remove(sessionId: string): Promise<boolean>;
}

export class WorkspaceProjectMembershipStore {
  private readonly workspacePath: string;
  private readonly now: () => Date;

  constructor(options: { workspacePath: string; now?: () => Date }) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.now = options.now ?? (() => new Date());
  }

  async assign(
    sessionId: string,
    projectId: string,
  ): Promise<WorkspaceProjectMembership> {
    return this.mutate((transaction) =>
      transaction.assign(sessionId, projectId),
    );
  }

  async get(sessionId: string): Promise<WorkspaceProjectMembership | null> {
    this.assertSessionId(sessionId);
    const root = await this.ensureRoot();
    return this.readMembership(root, sessionId);
  }

  async list(): Promise<WorkspaceProjectMembership[]> {
    return (await this.listWithDiagnostics()).memberships;
  }

  async listWithDiagnostics(): Promise<{
    memberships: WorkspaceProjectMembership[];
    diagnostics: Array<{
      code: "corrupt_membership";
      sessionId: string;
    }>;
  }> {
    const root = await this.ensureRoot();
    return this.listWithDiagnosticsAtRoot(root);
  }

  private async listWithDiagnosticsAtRoot(root: string): Promise<{
    memberships: WorkspaceProjectMembership[];
    diagnostics: Array<{
      code: "corrupt_membership";
      sessionId: string;
    }>;
  }> {
    const memberships: WorkspaceProjectMembership[] = [];
    const diagnostics: Array<{
      code: "corrupt_membership";
      sessionId: string;
    }> = [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const candidateSessionId = entry.name.slice(0, -".json".length);
      if (!isValidSessionId(candidateSessionId)) continue;
      const membership = await this.readMembership(root, candidateSessionId);
      if (membership) {
        memberships.push(membership);
      } else {
        diagnostics.push({
          code: "corrupt_membership",
          sessionId: candidateSessionId,
        });
      }
    }
    memberships.sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId),
    );
    return { memberships, diagnostics };
  }

  async remove(sessionId: string): Promise<boolean> {
    return this.mutate((transaction) => transaction.remove(sessionId));
  }

  async mutate<T>(
    operation: (
      transaction: WorkspaceProjectMembershipTransaction,
    ) => Promise<T>,
  ): Promise<T> {
    const root = await this.ensureRoot();
    return withCrossProcessFileLock(
      path.join(root, ".locks", "membership-mutation.lock"),
      () =>
        operation({
          get: (sessionId) => {
            this.assertSessionId(sessionId);
            return this.readMembership(root, sessionId);
          },
          list: async () => (await this.listWithDiagnosticsAtRoot(root)).memberships,
          assign: (sessionId, projectId) =>
            this.assignAtRoot(root, sessionId, projectId),
          remove: (sessionId) => this.removeAtRoot(root, sessionId),
        }),
    );
  }

  private async assignAtRoot(
    root: string,
    sessionId: string,
    projectId: string,
  ): Promise<WorkspaceProjectMembership> {
    this.assertSessionId(sessionId);
    this.assertProjectId(projectId);
    const existing = await this.readMembership(root, sessionId);
    if (existing?.projectId === projectId) return existing;
    if (existsSync(this.membershipPath(root, sessionId)) && !existing) {
      throw new WorkspaceProjectMembershipStoreError(
        "corrupt_membership",
        `Membership record is corrupt: ${sessionId}`,
      );
    }
    const now = this.now().toISOString();
    const membership: WorkspaceProjectMembership = {
      version: 1,
      sessionId,
      projectId,
      assignedAt: existing?.assignedAt ?? now,
      updatedAt: now,
    };
    await this.writeMembership(root, membership);
    return membership;
  }

  private async removeAtRoot(
    root: string,
    sessionId: string,
  ): Promise<boolean> {
    this.assertSessionId(sessionId);
    const recordPath = this.membershipPath(root, sessionId);
    const stat = await fs.lstat(recordPath).catch(() => null);
    if (!stat) return false;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new WorkspaceProjectMembershipStoreError(
        "unsafe_storage",
        "Membership record is unsafe",
      );
    }
    await fs.unlink(recordPath);
    return true;
  }

  private async ensureRoot(): Promise<string> {
    await fs.mkdir(this.workspacePath, { recursive: true });
    const workspaceRealPath = await fs.realpath(this.workspacePath);
    const root = path.join(this.workspacePath, "project-memberships");
    const existing = await fs.lstat(root).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new WorkspaceProjectMembershipStoreError(
        "unsafe_storage",
        "Membership root must not be a symbolic link",
      );
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const rootRealPath = await fs.realpath(root);
    if (!isPathInside(workspaceRealPath, rootRealPath)) {
      throw new WorkspaceProjectMembershipStoreError(
        "unsafe_storage",
        "Membership root escaped the workspace",
      );
    }
    return root;
  }

  private membershipPath(root: string, sessionId: string): string {
    const recordPath = resolveRelativePathInside(root, `${sessionId}.json`);
    if (!recordPath) {
      throw new WorkspaceProjectMembershipStoreError(
        "invalid_session_id",
        "Session id must be a safe UUID",
      );
    }
    return recordPath;
  }

  private async readMembership(
    root: string,
    sessionId: string,
  ): Promise<WorkspaceProjectMembership | null> {
    const recordPath = this.membershipPath(root, sessionId);
    const stat = await fs.lstat(recordPath).catch(() => null);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (!resolveExistingPathInside(root, recordPath)) return null;
    try {
      return parseMembership(
        JSON.parse(await fs.readFile(recordPath, "utf8")),
        sessionId,
      );
    } catch {
      return null;
    }
  }

  private async writeMembership(
    root: string,
    membership: WorkspaceProjectMembership,
  ): Promise<void> {
    const recordPath = this.membershipPath(root, membership.sessionId);
    const existing = await fs.lstat(recordPath).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new WorkspaceProjectMembershipStoreError(
        "unsafe_storage",
        "Membership record must not be a symbolic link",
      );
    }
    await writeFileAtomic(
      recordPath,
      Buffer.from(`${JSON.stringify(membership, null, 2)}\n`, "utf8"),
    );
  }

  private assertSessionId(sessionId: string): void {
    if (!isValidSessionId(sessionId)) {
      throw new WorkspaceProjectMembershipStoreError(
        "invalid_session_id",
        "Session id must be a UUID",
      );
    }
  }

  private assertProjectId(projectId: string): void {
    if (!isValidWorkspaceProjectId(projectId)) {
      throw new WorkspaceProjectMembershipStoreError(
        "invalid_project_id",
        "Project id must be a UUID",
      );
    }
  }
}

function parseMembership(
  value: unknown,
  expectedSessionId: string,
): WorkspaceProjectMembership | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<WorkspaceProjectMembership>;
  if (
    record.version !== 1 ||
    record.sessionId !== expectedSessionId ||
    !isValidSessionId(record.sessionId) ||
    typeof record.projectId !== "string" ||
    !isValidWorkspaceProjectId(record.projectId) ||
    typeof record.assignedAt !== "string" ||
    !Number.isFinite(Date.parse(record.assignedAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    return null;
  }
  return record as WorkspaceProjectMembership;
}
