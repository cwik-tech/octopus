import type {
  WorkspaceProjectMemoryProposal,
  WorkspaceProjectMemoryProposalStatus,
} from "../contracts/projects.js";
import type { WorkspaceProjectMemoryStore } from "../domains/projects/project-memory-store.js";
import type { WorkspaceProjectService } from "../domains/projects/workspace-project-service.js";

export class WorkspaceProjectMemoryServiceError extends Error {
  constructor(
    readonly code: "source_session_project_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceProjectMemoryServiceError";
  }
}

export class WorkspaceProjectMemoryService {
  constructor(
    private readonly options: {
      projectService: Pick<
        WorkspaceProjectService,
        "getProjectRecord" | "getSession" | "withProjectReferenceMutation"
      >;
      memoryStore: WorkspaceProjectMemoryStore;
    },
  ) {}

  async list(
    projectId: string,
    options: { status?: WorkspaceProjectMemoryProposalStatus } = {},
  ): Promise<WorkspaceProjectMemoryProposal[]> {
    await this.options.projectService.getProjectRecord(projectId);
    return this.options.memoryStore.list(projectId, options);
  }

  async propose(
    projectId: string,
    input: { content: string; sourceSessionId?: string },
  ): Promise<WorkspaceProjectMemoryProposal> {
    return this.options.projectService.withProjectReferenceMutation(
      projectId,
      async () => {
        if (input.sourceSessionId) {
          const source = await this.options.projectService.getSession(
            input.sourceSessionId,
          );
          if (!source || source.projectId !== projectId) {
            throw new WorkspaceProjectMemoryServiceError(
              "source_session_project_mismatch",
              "Memory proposal source session does not belong to this project",
            );
          }
        }
        return this.options.memoryStore.propose(projectId, input);
      },
    );
  }

  async decide(
    projectId: string,
    proposalId: string,
    decision: "approved" | "rejected",
  ): Promise<WorkspaceProjectMemoryProposal> {
    return this.options.projectService.withProjectReferenceMutation(
      projectId,
      () => this.options.memoryStore.decide(projectId, proposalId, decision),
    );
  }
}
