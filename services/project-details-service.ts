import type { WorkspaceProjectDetails } from "../contracts/project-details.js";
import type { Schedule } from "../contracts/schedules.js";
import type { WorkspaceProjectContextStore } from "../domains/projects/project-context-store.js";
import type { WorkspaceProjectService } from "../domains/projects/workspace-project-service.js";
import { buildProjectCatalogRoot } from "./project-file-catalog-service.js";
import type { WorkspaceProjectMemoryService } from "./project-memory-service.js";

export class WorkspaceProjectDetailsService {
  constructor(
    private readonly options: {
      projectService: Pick<WorkspaceProjectService, "getProjectWithSessions">;
      contextStore: Pick<
        WorkspaceProjectContextStore,
        "readBrief" | "listFiles"
      >;
      memoryService: Pick<WorkspaceProjectMemoryService, "list">;
      scheduleService?: { listByProject(projectId: string): Promise<Schedule[]> };
    },
  ) {}

  async get(projectId: string): Promise<WorkspaceProjectDetails> {
    const projectRead = await this.options.projectService.getProjectWithSessions(
      projectId,
    );
    const [storedBrief, files, memoryProposals, schedules] = await Promise.all([
      this.options.contextStore.readBrief(projectId),
      this.options.contextStore.listFiles(projectId),
      this.options.memoryService.list(projectId),
      this.options.scheduleService?.listByProject(projectId) ?? Promise.resolve([]),
    ]);
    return {
      version: 1,
      project: projectRead.project,
      brief: storedBrief ?? {
        content: "",
        updatedAt: projectRead.project.updatedAt,
      },
      files,
      catalog: buildProjectCatalogRoot(
        projectId,
        files,
        projectRead.sessions,
      ),
      sessions: projectRead.sessions,
      schedules,
      memoryProposals,
    };
  }
}
