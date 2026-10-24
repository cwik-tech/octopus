import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  isValidWorkspaceProjectId,
  type WorkspaceProjectMemoryProposal,
  type WorkspaceProjectMemoryProposalStatus,
} from "../../contracts/projects.js";
import { isValidSessionId } from "../../contracts/sessions.js";
import { withCrossProcessFileLock } from "../../core/cross-process-file-lock.js";
import { writeFileAtomic } from "../../core/file-mutation.js";
import {
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../../core/path-safety.js";

const MEMORY_PROPOSAL_ID_PATTERN = /^mem_[0-9a-f-]{36}$/i;
const MAX_MEMORY_CONTENT_LENGTH = 20_000;

export class WorkspaceProjectMemoryStoreError extends Error {
  constructor(
    readonly code:
      | "invalid_project_id"
      | "invalid_proposal"
      | "proposal_not_found"
      | "proposal_already_decided"
      | "unsafe_storage",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceProjectMemoryStoreError";
  }
}

export class WorkspaceProjectMemoryStore {
  private readonly projectsRoot: string;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: {
    workspacePath: string;
    now?: () => Date;
    randomUUID?: () => string;
  }) {
    this.projectsRoot = path.join(path.resolve(options.workspacePath), "projects");
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  }

  async propose(
    projectId: string,
    input: { content: string; sourceSessionId?: string },
  ): Promise<WorkspaceProjectMemoryProposal> {
    const content = normalizeContent(input.content);
    if (
      input.sourceSessionId !== undefined &&
      !isValidSessionId(input.sourceSessionId)
    ) {
      throw new WorkspaceProjectMemoryStoreError(
        "invalid_proposal",
        "Memory proposal source session id is invalid",
      );
    }
    const root = await this.ensureMemoryRoot(projectId);
    const id = `mem_${this.randomUUID()}`;
    if (!MEMORY_PROPOSAL_ID_PATTERN.test(id)) {
      throw new WorkspaceProjectMemoryStoreError(
        "invalid_proposal",
        "Generated memory proposal id is invalid",
      );
    }
    const createdAt = this.now().toISOString();
    const proposal: WorkspaceProjectMemoryProposal = {
      version: 1,
      id,
      projectId,
      content,
      ...(input.sourceSessionId
        ? { sourceSessionId: input.sourceSessionId }
        : {}),
      status: "pending",
      createdAt,
    };
    await writeFileAtomic(
      path.join(root, `${id}.json`),
      `${JSON.stringify(proposal, null, 2)}\n`,
    );
    return proposal;
  }

  async list(
    projectId: string,
    options: { status?: WorkspaceProjectMemoryProposalStatus } = {},
  ): Promise<WorkspaceProjectMemoryProposal[]> {
    const root = await this.resolveMemoryRoot(projectId);
    if (!root) return [];
    const proposals: WorkspaceProjectMemoryProposal[] = [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!MEMORY_PROPOSAL_ID_PATTERN.test(id)) continue;
      const proposal = await this.readProposal(root, projectId, id);
      if (proposal && (!options.status || proposal.status === options.status)) {
        proposals.push(proposal);
      }
    }
    return proposals.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
  }

  async decide(
    projectId: string,
    proposalId: string,
    decision: "approved" | "rejected",
  ): Promise<WorkspaceProjectMemoryProposal> {
    if (!MEMORY_PROPOSAL_ID_PATTERN.test(proposalId)) {
      throw new WorkspaceProjectMemoryStoreError(
        "invalid_proposal",
        "Memory proposal id is invalid",
      );
    }
    const root = await this.ensureMemoryRoot(projectId);
    const locksRoot = path.join(root, ".locks");
    await ensureContainedDirectory(root, locksRoot, "Memory proposal locks directory");
    return withCrossProcessFileLock(
      path.join(locksRoot, `${proposalId}.lock`),
      async () => {
        const current = await this.readProposal(root, projectId, proposalId);
        if (!current) {
          throw new WorkspaceProjectMemoryStoreError(
            "proposal_not_found",
            "Memory proposal was not found",
          );
        }
        if (current.status !== "pending") {
          throw new WorkspaceProjectMemoryStoreError(
            "proposal_already_decided",
            "Memory proposal was already decided",
          );
        }
        const next: WorkspaceProjectMemoryProposal = {
          ...current,
          status: decision,
          decidedAt: this.now().toISOString(),
        };
        await writeFileAtomic(
          path.join(root, `${proposalId}.json`),
          `${JSON.stringify(next, null, 2)}\n`,
        );
        return next;
      },
    );
  }

  private async readProposal(
    root: string,
    projectId: string,
    proposalId: string,
  ): Promise<WorkspaceProjectMemoryProposal | null> {
    const proposalPath = resolveRelativePathInside(root, `${proposalId}.json`);
    if (!proposalPath) return null;
    const stat = await fs.lstat(proposalPath).catch(() => null);
    if (
      !stat?.isFile() ||
      stat.isSymbolicLink() ||
      !resolveExistingPathInside(root, proposalPath)
    ) {
      return null;
    }
    try {
      const value: unknown = JSON.parse(await fs.readFile(proposalPath, "utf8"));
      return parseProposal(value, projectId, proposalId);
    } catch {
      return null;
    }
  }

  private async resolveMemoryRoot(projectId: string): Promise<string | null> {
    const projectDir = await this.resolveProjectDir(projectId);
    const root = path.join(projectDir, "context", "memory-proposals");
    const stat = await fs.lstat(root).catch(() => null);
    if (!stat) return null;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !resolveExistingPathInside(projectDir, root)
    ) {
      throw new WorkspaceProjectMemoryStoreError(
        "unsafe_storage",
        "Memory proposals directory is unsafe",
      );
    }
    return root;
  }

  private async ensureMemoryRoot(projectId: string): Promise<string> {
    const projectDir = await this.resolveProjectDir(projectId);
    const contextDir = path.join(projectDir, "context");
    await ensureContainedDirectory(projectDir, contextDir, "Project context directory");
    const root = path.join(contextDir, "memory-proposals");
    await ensureContainedDirectory(projectDir, root, "Memory proposals directory");
    return root;
  }

  private async resolveProjectDir(projectId: string): Promise<string> {
    if (!isValidWorkspaceProjectId(projectId)) {
      throw new WorkspaceProjectMemoryStoreError(
        "invalid_project_id",
        "Project id must be a UUID",
      );
    }
    const projectDir = resolveRelativePathInside(this.projectsRoot, projectId);
    const stat = projectDir ? await fs.lstat(projectDir).catch(() => null) : null;
    if (
      !projectDir ||
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      !resolveExistingPathInside(this.projectsRoot, projectDir)
    ) {
      throw new WorkspaceProjectMemoryStoreError(
        "unsafe_storage",
        "Project content directory is unavailable or unsafe",
      );
    }
    return projectDir;
  }
}

function normalizeContent(value: unknown): string {
  const content = typeof value === "string" ? value.trim() : "";
  if (!content || content.length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new WorkspaceProjectMemoryStoreError(
      "invalid_proposal",
      `Memory proposal content must contain 1-${MAX_MEMORY_CONTENT_LENGTH} characters`,
    );
  }
  return content;
}

function parseProposal(
  value: unknown,
  projectId: string,
  proposalId: string,
): WorkspaceProjectMemoryProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proposal = value as Partial<WorkspaceProjectMemoryProposal>;
  if (
    proposal.version !== 1 ||
    proposal.id !== proposalId ||
    proposal.projectId !== projectId ||
    typeof proposal.content !== "string" ||
    !proposal.content ||
    proposal.content.length > MAX_MEMORY_CONTENT_LENGTH ||
    (proposal.sourceSessionId !== undefined &&
      !isValidSessionId(proposal.sourceSessionId)) ||
    !["pending", "approved", "rejected"].includes(proposal.status ?? "") ||
    typeof proposal.createdAt !== "string" ||
    !Number.isFinite(Date.parse(proposal.createdAt)) ||
    (proposal.status === "pending" && proposal.decidedAt !== undefined) ||
    (proposal.status !== "pending" &&
      (typeof proposal.decidedAt !== "string" ||
        !Number.isFinite(Date.parse(proposal.decidedAt))))
  ) {
    return null;
  }
  return proposal as WorkspaceProjectMemoryProposal;
}

async function ensureContainedDirectory(
  containmentRoot: string,
  directory: string,
  label: string,
): Promise<void> {
  const existing = await fs.lstat(directory).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new WorkspaceProjectMemoryStoreError(
      "unsafe_storage",
      `${label} must not be a symbolic link`,
    );
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!resolveExistingPathInside(containmentRoot, directory)) {
    throw new WorkspaceProjectMemoryStoreError(
      "unsafe_storage",
      `${label} escaped its project`,
    );
  }
}
