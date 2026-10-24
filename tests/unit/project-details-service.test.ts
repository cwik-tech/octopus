import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceProjectDetailsService } from "../../services/project-details-service.js";

test("project details requests only schedules owned by the selected project", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const schedule = {
    id: "schedule-1",
    name: "Daily scan",
    kind: "agent" as const,
    target: "Researcher",
    projectId,
    prompt: "Scan",
    cron: "0 9 * * *",
    timezone: "Europe/Warsaw",
    scheduleLabel: "Every day at 09:00",
    overlap: "skip" as const,
    notifyOnFailure: true,
    enabled: true,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:00.000Z",
    runtime: {},
  };
  const requestedProjectIds: string[] = [];
  const scheduleService = {
    list: async () => {
      throw new Error("global schedule listing was invoked");
    },
    listByProject: async (selectedProjectId: string) => {
      requestedProjectIds.push(selectedProjectId);
      return [schedule];
    },
  };
  const service = new WorkspaceProjectDetailsService({
    projectService: {
      getProjectWithSessions: async () => ({
        project: {
          version: 1,
          id: projectId,
          name: "Acme",
          status: "active",
          createdAt: "2026-08-05T12:00:00.000Z",
          updatedAt: "2026-08-05T12:00:00.000Z",
          sessionCount: 0,
          activeSessionCount: 0,
        },
        sessions: [],
      }),
    },
    contextStore: {
      readBrief: async () => null,
      listFiles: async () => [],
    },
    memoryService: { list: async () => [] },
    scheduleService,
  });

  const details = await service.get(projectId);

  assert.deepEqual(requestedProjectIds, [projectId]);
  assert.deepEqual(details.schedules, [schedule]);
});
