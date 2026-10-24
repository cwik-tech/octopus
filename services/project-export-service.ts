import * as crypto from "node:crypto";

import type {
  WorkspaceProject,
  WorkspaceProjectExport,
  WorkspaceProjectExportFile,
  WorkspaceProjectExportSchedule,
} from "../contracts/projects.js";
import type { WorkspaceProjectContextStore } from "../domains/projects/project-context-store.js";
import type { WorkspaceProjectService } from "../domains/projects/workspace-project-service.js";
import type { ScheduleService } from "./schedule-service.js";
import type { WorkspaceProjectMemoryService } from "./project-memory-service.js";

export class WorkspaceProjectExportService {
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      projectService: Pick<
        WorkspaceProjectService,
        "getProjectWithSessions"
      >;
      contextStore: WorkspaceProjectContextStore;
      memoryService: Pick<WorkspaceProjectMemoryService, "list">;
      scheduleService?: Pick<ScheduleService, "list">;
      now?: () => Date;
    },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async exportProject(projectId: string): Promise<WorkspaceProjectExport> {
    const projectRead = await this.options.projectService.getProjectWithSessions(
      projectId,
    );
    const summary = projectRead.project;
    const { sessionCount: _sessionCount, activeSessionCount: _activeSessionCount,
      latestActivityAt: _latestActivityAt, ...project } = summary;
    const [brief, fileRecords, memoryProposals, schedules] =
      await Promise.all([
        this.options.contextStore.readBrief(projectId),
        this.options.contextStore.listFiles(projectId),
        this.options.memoryService.list(projectId),
        this.options.scheduleService?.list() ?? Promise.resolve([]),
      ]);
    const files = await Promise.all(
      fileRecords.map(async (file): Promise<WorkspaceProjectExportFile> => {
        const contents = await this.options.contextStore.readFile(
          projectId,
          file.name,
        );
        if (!contents) {
          throw new Error(`Project export source disappeared: ${file.name}`);
        }
        return {
          ...file,
          contentBase64: contents.toString("base64"),
          sha256: crypto.createHash("sha256").update(contents).digest("hex"),
        };
      }),
    );
    return {
      version: 1,
      exportedAt: this.now().toISOString(),
      project: project as WorkspaceProject,
      ...(brief ? { brief } : {}),
      files,
      sessions: projectRead.sessions,
      memoryProposals,
      schedules: schedules
        .filter((schedule) => schedule.projectId === projectId)
        .map(toExportSchedule),
    };
  }
}

function toExportSchedule(
  schedule: Awaited<ReturnType<ScheduleService["list"]>>[number],
): WorkspaceProjectExportSchedule {
  if (!schedule.projectId) {
    throw new Error("Project export schedule is missing project ownership");
  }
  const {
    runtime: _runtime,
    modelOverride: _modelOverride,
    projectContext: _projectContext,
    ...definition
  } = schedule;
  return {
    ...definition,
    projectId: schedule.projectId,
    ...(schedule.modelOverride
      ? { modelOverride: { ...schedule.modelOverride } }
      : {}),
    ...(schedule.projectContext
      ? {
          projectContext: {
            version: 1,
            includeBrief: schedule.projectContext.includeBrief,
            fileNames: [...schedule.projectContext.fileNames],
          },
        }
      : {}),
  };
}
