import type {
  WorkspaceProject,
  WorkspaceProjectDeleteMode,
  WorkspaceProjectMembership,
  WorkspaceProjectSummary,
} from "../../contracts/projects.js";
import type {
  SessionOrigin,
  SessionSummary,
} from "../../contracts/sessions.js";
import {
  sessionDeletionBlockerFor,
  type CreateSessionInput,
  type SessionCreateResult,
  type SessionDeletionBlocker,
  type SessionStore,
} from "../sessions/session-store.js";
import type { WorkspaceProjectMembershipStore } from "./project-membership-store.js";
import type { WorkspaceProjectStore } from "./project-store.js";
import type { WorkspaceProjectContextStore } from "./project-context-store.js";

export class WorkspaceProjectServiceError extends Error {
  constructor(
    readonly code:
      | "project_not_found"
      | "archived_project"
      | "session_not_found"
      | "project_not_empty",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceProjectServiceError";
  }
}

export interface WorkspaceProjectWithSessions {
  project: WorkspaceProjectSummary;
  sessions: SessionSummary[];
}

const SESSION_HYDRATION_CONCURRENCY = 16;

export class WorkspaceProjectService {
  private readonly projectStore: WorkspaceProjectStore;
  private readonly membershipStore: WorkspaceProjectMembershipStore;
  private readonly sessionStore: SessionStore;
  private readonly projectContextStore: Pick<WorkspaceProjectContextStore, "hasContent"> | undefined;
  private readonly hasBlockingReference: ((projectId: string) => Promise<boolean>) | undefined;

  constructor(options: {
    projectStore: WorkspaceProjectStore;
    membershipStore: WorkspaceProjectMembershipStore;
    sessionStore: SessionStore;
    projectContextStore?: Pick<WorkspaceProjectContextStore, "hasContent">;
    hasBlockingReference?: (projectId: string) => Promise<boolean>;
  }) {
    this.projectStore = options.projectStore;
    this.membershipStore = options.membershipStore;
    this.sessionStore = options.sessionStore;
    this.projectContextStore = options.projectContextStore;
    this.hasBlockingReference = options.hasBlockingReference;
  }

  async createProject(input: {
    name: string;
    description?: string;
  }): Promise<WorkspaceProject> {
    return this.projectStore.create(input);
  }

  async listProjects(options: {
    includeArchived?: boolean;
  } = {}): Promise<WorkspaceProjectSummary[]> {
    const [projects, memberships] = await Promise.all([
      this.projectStore.list(options),
      this.membershipStore.list(),
    ]);
    const projectIds = new Set(projects.map((project) => project.id));
    const sessionsByProject = new Map<string, SessionSummary[]>();
    for (const { membership, session } of await this.hydrateMembershipSessions(
      memberships.filter((membership) => projectIds.has(membership.projectId)),
    )) {
      const sessions = sessionsByProject.get(membership.projectId) ?? [];
      sessions.push({ ...session, projectId: membership.projectId });
      sessionsByProject.set(membership.projectId, sessions);
    }
    return projects.map((project) =>
      summarizeProject(
        project,
        sortSessionsByUpdatedAt(sessionsByProject.get(project.id) ?? []),
      ),
    );
  }

  async getProject(projectId: string): Promise<WorkspaceProjectSummary> {
    return (await this.getProjectWithSessions(projectId)).project;
  }

  async getProjectRecord(projectId: string): Promise<WorkspaceProject> {
    return this.requireProject(projectId);
  }

  async getProjectWithSessions(
    projectId: string,
  ): Promise<WorkspaceProjectWithSessions> {
    const [project, memberships] = await Promise.all([
      this.requireProject(projectId),
      this.membershipStore.list(),
    ]);
    const hydrated = await this.hydrateMembershipSessions(
      memberships.filter((membership) => membership.projectId === projectId),
    );
    const sessions = sortSessionsByUpdatedAt(
      hydrated.map(({ session }) => ({ ...session, projectId })),
    );
    return {
      project: summarizeProject(project, sessions),
      sessions,
    };
  }

  async updateProject(
    projectId: string,
    patch: { name?: string; description?: string },
  ): Promise<WorkspaceProject> {
    const project = await this.projectStore.update(projectId, patch);
    if (!project) throw projectNotFound(projectId);
    return project;
  }

  async archiveProject(projectId: string): Promise<WorkspaceProject> {
    return this.membershipStore.mutate(async () => {
      const project = await this.projectStore.archive(projectId);
      if (!project) throw projectNotFound(projectId);
      return project;
    });
  }

  async restoreProject(projectId: string): Promise<WorkspaceProject> {
    return this.membershipStore.mutate(async () => {
      const project = await this.projectStore.restore(projectId);
      if (!project) throw projectNotFound(projectId);
      return project;
    });
  }

  async withProjectReferenceMutation<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.membershipStore.mutate(async () => {
      const project = await this.projectStore.get(projectId);
      if (!project) throw projectNotFound(projectId);
      if (project.status !== "active") {
        throw new WorkspaceProjectServiceError(
          "archived_project",
          `Project is archived: ${projectId}`,
        );
      }
      return operation();
    });
  }

  async assignSession(
    projectId: string,
    sessionId: string,
  ): Promise<WorkspaceProjectMembership> {
    return this.membershipStore.mutate(async (transaction) => {
      const [project, session] = await Promise.all([
        this.projectStore.get(projectId),
        this.sessionStore.getSession(sessionId),
      ]);
      if (!project) throw projectNotFound(projectId);
      if (project.status !== "active") {
        throw new WorkspaceProjectServiceError(
          "archived_project",
          `Project is archived: ${projectId}`,
        );
      }
      if (!session) {
        throw new WorkspaceProjectServiceError(
          "session_not_found",
          `Session not found: ${sessionId}`,
        );
      }
      return transaction.assign(sessionId, projectId);
    });
  }

  async removeSession(projectId: string, sessionId: string): Promise<boolean> {
    return this.membershipStore.mutate(async (transaction) => {
      await this.requireProject(projectId);
      const membership = await transaction.get(sessionId);
      if (!membership || membership.projectId !== projectId) return false;
      return transaction.remove(sessionId);
    });
  }

  async hardDeleteProject(projectId: string): Promise<boolean> {
    return this.membershipStore.mutate(async (transaction) => {
      await this.requireProject(projectId);
      const memberships = await transaction.list();
      const ownedSessions = await Promise.all(
        memberships
          .filter((membership) => membership.projectId === projectId)
          .map((membership) => this.sessionStore.getSession(membership.sessionId)),
      );
      if (ownedSessions.some(Boolean)) {
        throw new WorkspaceProjectServiceError(
          "project_not_empty",
          `Project still owns sessions: ${projectId}`,
        );
      }
      if (await this.projectContextStore?.hasContent(projectId)) {
        throw new WorkspaceProjectServiceError(
          "project_not_empty",
          `Project still owns a brief or shared files: ${projectId}`,
        );
      }
      if (await this.hasBlockingReference?.(projectId)) {
        throw new WorkspaceProjectServiceError(
          "project_not_empty",
          `Project is referenced by durable automation: ${projectId}`,
        );
      }
      return this.projectStore.hardDelete(projectId);
    });
  }

  async deleteProject(
    projectId: string,
    mode: WorkspaceProjectDeleteMode,
  ): Promise<boolean> {
    return this.membershipStore.mutate(async (transaction) => {
      await this.requireProject(projectId);
      if (await this.hasBlockingReference?.(projectId)) {
        throw new WorkspaceProjectServiceError(
          "project_not_empty",
          `Delete project schedules before deleting the project: ${projectId}`,
        );
      }

      const memberships = (await transaction.list()).filter(
        (membership) => membership.projectId === projectId,
      );
      const sessions = (
        await Promise.all(
          memberships.map((membership) =>
            this.sessionStore.getSession(membership.sessionId),
          ),
        )
      ).filter((session): session is SessionSummary => Boolean(session));

      if (mode === "delete_sessions") {
        if (this.sessionStore.deleteSessionsIfNoActiveTasks) {
          const deletion = await this.sessionStore.deleteSessionsIfNoActiveTasks(
            sessions.map((session) => session.id),
          );
          if (!deletion.deleted && deletion.reason) {
            throw projectSessionsNotDeletable(deletion.reason);
          }
        } else {
          const taskGroups = await Promise.all(
            sessions.map((session) => this.sessionStore.listTaskRecords(session.id)),
          );
          const blocker = sessionDeletionBlockerFor(taskGroups.flat());
          if (blocker) throw projectSessionsNotDeletable(blocker);
          for (const session of sessions) {
            const deletion = this.sessionStore.deleteSessionIfNoActiveTasks
              ? await this.sessionStore.deleteSessionIfNoActiveTasks(session.id)
              : { deleted: await this.sessionStore.deleteSession(session.id) };
            if (
              !deletion.deleted &&
              deletion.reason !== undefined &&
              deletion.reason !== "not_found"
            ) {
              throw projectSessionsNotDeletable(deletion.reason);
            }
          }
        }
      }

      const deleted = await this.projectStore.hardDelete(projectId);
      if (!deleted) return false;
      for (const membership of memberships) {
        await transaction.remove(membership.sessionId);
      }
      return true;
    });
  }

  async listProjectSessions(projectId: string): Promise<SessionSummary[]> {
    return (await this.getProjectWithSessions(projectId)).sessions;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const [sessions, memberships, projects] = await Promise.all([
      this.sessionStore.listSessions(),
      this.membershipStore.list(),
      this.projectStore.list({ includeArchived: true }),
    ]);
    const projectIds = new Set(projects.map((project) => project.id));
    const projectsBySession = new Map(
      memberships
        .filter((membership) => projectIds.has(membership.projectId))
        .map((membership) => [
          membership.sessionId,
          membership.projectId,
        ]),
    );
    return sessions.map((session) => {
      const projectId = projectsBySession.get(session.id);
      return projectId ? { ...session, projectId } : session;
    });
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    const [session, membership] = await Promise.all([
      this.sessionStore.getSession(sessionId),
      this.membershipStore.get(sessionId),
    ]);
    if (!session) return null;
    if (!membership) return session;
    const project = await this.projectStore.get(membership.projectId);
    return project ? { ...session, projectId: membership.projectId } : session;
  }

  async createSession(input: {
    title?: string;
    projectId?: string;
    origin?: SessionOrigin;
    id?: string;
    creationToken?: string;
  }): Promise<SessionSummary> {
    return (await this.createSessionWithClaim(input)).session;
  }

  async createSessionWithClaim(input: {
    title?: string;
    projectId?: string;
    origin?: SessionOrigin;
    id?: string;
    creationToken?: string;
  }): Promise<SessionCreateResult> {
    const createInput =
      input.title === undefined &&
      input.origin === undefined &&
      input.id === undefined &&
      input.creationToken === undefined
        ? undefined
        : {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.origin === undefined ? {} : { origin: input.origin }),
            ...(input.id === undefined ? {} : { id: input.id }),
            ...(input.creationToken === undefined
              ? {}
              : { creationToken: input.creationToken }),
          };
    const { projectId } = input;
    if (!projectId) {
      return this.createInStore(createInput);
    }

    let created: SessionSummary | undefined;
    try {
      return await this.membershipStore.mutate(async (transaction) => {
        const project = await this.projectStore.get(projectId);
        if (!project) throw projectNotFound(projectId);
        if (project.status !== "active") {
          throw new WorkspaceProjectServiceError(
            "archived_project",
            `Project is archived: ${input.projectId}`,
          );
        }
        const result = await this.createInStore(createInput);
        // Only what this call made is ours to undo. A replay found a session
        // that already existed, and unwinding a later membership failure must
        // not delete a conversation this request did not create.
        if (result.outcome === "created") created = result.session;
        const membership = await transaction.assign(
          result.session.id,
          projectId,
        );
        return {
          session: { ...result.session, projectId: membership.projectId },
          outcome: result.outcome,
        };
      });
    } catch (error) {
      if (created) {
        if (this.sessionStore.deleteSessionIfNoActiveTasks) {
          await this.sessionStore.deleteSessionIfNoActiveTasks(created.id)
            .catch(() => undefined);
        } else {
          await this.sessionStore.deleteSession(created.id).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private async createInStore(
    createInput: CreateSessionInput | undefined,
  ): Promise<SessionCreateResult> {
    return this.sessionStore.createSessionWithClaim(createInput);
  }

  private async requireProject(projectId: string): Promise<WorkspaceProject> {
    const project = await this.projectStore.get(projectId);
    if (!project) throw projectNotFound(projectId);
    return project;
  }

  private async hydrateMembershipSessions(
    memberships: readonly WorkspaceProjectMembership[],
  ): Promise<Array<{
    membership: WorkspaceProjectMembership;
    session: SessionSummary;
  }>> {
    const hydrated = await mapWithConcurrency(
      memberships,
      SESSION_HYDRATION_CONCURRENCY,
      async (membership) => {
        const session = await this.sessionStore.getSession(membership.sessionId);
        return session ? { membership, session } : null;
      },
    );
    return hydrated.filter(
      (
        entry,
      ): entry is {
        membership: WorkspaceProjectMembership;
        session: SessionSummary;
      } => entry !== null,
    );
  }
}

async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  // Every worker pulls from this one iterator, so each entry is taken once.
  const entries = values.entries();
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        for (const [index, value] of entries) {
          results[index] = await operation(value);
        }
      },
    ),
  );
  return results;
}

/**
 * The refusal for a project whose sessions cannot be deleted yet, saying what
 * the person can do: cancel an active task, or wait for the cleanup of one
 * that has ended.
 */
function projectSessionsNotDeletable(
  blocker: SessionDeletionBlocker,
): WorkspaceProjectServiceError {
  return new WorkspaceProjectServiceError(
    "project_not_empty",
    blocker === "process_cleanup_pending"
      ? "A task in one of this project's sessions has ended, but its processes could not yet be confirmed stopped. " +
          "Delete the project's sessions once that cleanup finishes."
      : "Cancel active project sessions before deleting their data",
  );
}

function projectNotFound(projectId: string): WorkspaceProjectServiceError {
  return new WorkspaceProjectServiceError(
    "project_not_found",
    `Project not found: ${projectId}`,
  );
}

function summarizeProject(
  project: WorkspaceProject,
  sessions: readonly SessionSummary[],
): WorkspaceProjectSummary {
  const latestActivityAt = sessions
    .map((session) => session.updatedAt)
    .sort((left, right) => right.localeCompare(left))[0];
  return {
    ...project,
    sessionCount: sessions.length,
    activeSessionCount: sessions.filter((session) => session.status === "active")
      .length,
    ...(latestActivityAt ? { latestActivityAt } : {}),
  };
}

function sortSessionsByUpdatedAt(
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  return [...sessions].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}
