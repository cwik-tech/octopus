import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resourceArchitectConversationSchema, type ResourceArchitectConversation } from "../contracts/schemas/resource-architect-conversation.js";
import { writeFileAtomic } from "../core/file-mutation.js";

type StartConversation = Omit<ResourceArchitectConversation, "schemaVersion" | "turn" | "buildJobId"> &
  Pick<ResourceArchitectConversation["turn"], "jobId" | "operation"> & {
    /**
     * The conversation's build that ended before this message. It is let go of
     * in the same save as the message, so a failed save keeps both as they were.
     */
    releaseEndedBuildJobId?: string;
  };
type SettleConversation = Pick<ResourceArchitectConversation, "draftId" | "updatedAt"> & {
  jobId: string;
  status: "completed" | "failed" | "cancelled";
  assistant?: ResourceArchitectConversation["history"][number];
  planId?: string;
};

export class ResourceArchitectConversationStore {
  private readonly filePath: string | undefined;
  private current: ResourceArchitectConversation | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(workspacePath?: string) {
    this.filePath = workspacePath ? join(workspacePath, "resource-architect-conversation", "active.json") : undefined;
  }

  async read(): Promise<ResourceArchitectConversation | null> {
    await this.writing;
    return this.readCurrent();
  }

  /**
   * Admits one turn and returns the conversation exactly as it was saved.
   *
   * A turn that arrives without a time is stamped with the admission time. The
   * route's parsed request history never carries one, so every time in the
   * returned history was assigned by the server.
   */
  async start(input: StartConversation): Promise<ResourceArchitectConversation> {
    return this.change((current): ResourceArchitectConversation => {
      const previous = current?.draftId === input.draftId ? current : null;
      // Each conversation request adds one user message. Proposal preparation
      // adds none. The request's bounded model context is not the transcript.
      const latest = input.history.at(-1);
      const history = previous
        ? [...previous.history, ...(input.operation === "conversation" && latest?.role === "user" ? [latest] : [])]
        : input.history;
      return {
        schemaVersion: 1, draftId: input.draftId,
        history: history.map((turn) => ({ ...turn, createdAt: turn.createdAt ?? input.updatedAt })),
        planId: input.planId ?? previous?.planId ?? null,
        buildJobId: previous && previous.buildJobId !== input.releaseEndedBuildJobId ? previous.buildJobId : null,
        selectedResource: input.selectedResource,
        documentReader: input.documentReader,
        updatedAt: input.updatedAt,
        turn: { jobId: input.jobId, operation: input.operation, status: "running" },
      };
    });
  }

  async settle(input: SettleConversation): Promise<void> {
    await this.change((current) => {
      // New and later turns revoke the old response's right to publish here.
      if (!current || current.draftId !== input.draftId || current.turn.jobId !== input.jobId) return current;
      return {
        ...current,
        history: input.assistant ? [...current.history, { ...input.assistant, createdAt: input.assistant.createdAt ?? input.updatedAt }] : current.history,
        planId: input.planId ?? current.planId,
        buildJobId: input.planId && input.planId !== current.planId ? null : current.buildJobId,
        updatedAt: input.updatedAt,
        turn: { ...current.turn, status: input.status },
      };
    });
  }

  async clear(draftId: string): Promise<void> {
    await this.change((current) => current?.draftId === draftId ? null : current);
  }

  async attachBuild(draftId: string, planId: string, jobId: string): Promise<void> {
    await this.change((current) => current?.draftId === draftId && current.planId === planId
      ? { ...current, buildJobId: jobId }
      : current);
  }

  private async change<T extends ResourceArchitectConversation | null>(update: (current: ResourceArchitectConversation | null) => T): Promise<T> {
    const write = this.writing.then(async () => {
      const next = update(await this.readCurrent());
      if (this.filePath) await writeFileAtomic(this.filePath, `${JSON.stringify(next)}\n`);
      this.current = next;
      return structuredClone(next);
    });
    // A failed write is reported to its caller; later operations may retry.
    this.writing = write.then(() => undefined, () => undefined);
    return write;
  }

  private async readCurrent(): Promise<ResourceArchitectConversation | null> {
    if (!this.filePath) return structuredClone(this.current);
    let contents: string;
    try { contents = await readFile(this.filePath, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw new Error("The saved Create conversation could not be read.", { cause: error });
    }
    try {
      const value: unknown = JSON.parse(contents);
      return resourceArchitectConversationSchema.nullable().parse(value);
    } catch (error) {
      throw new Error("The saved Create conversation is invalid.", { cause: error });
    }
  }
}
