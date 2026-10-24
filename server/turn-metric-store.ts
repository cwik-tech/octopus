/**
 * One authoring helper's durable turn records.
 *
 * Every helper that runs a model owes the same account of it: which pair the
 * turn used and how that pair was decided, written before the provider is
 * called so the record survives a crash, and replaced in place by the outcome.
 * The Resource Architect and the Workflow Architect both need exactly this, and
 * a second copy of it would let one of them drift into recording less.
 *
 * Sanitized by construction: prompts, model output, uploaded documents and
 * credentials must never reach these files.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ResourceArchitectTurnMetric } from "../contracts/resource-architect.js";
import { parseTurnMetricRecord } from "./resource-architect-durable-records.js";
import { resourceArchitectFeedbackDiagnosticsSchema } from '../contracts/schemas/resource-architect-review.js';
import { writeFileAtomic } from "../core/file-mutation.js";

const TURN_METRIC_RETENTION = 200;

export class TurnMetricStore {
  private metrics: ResourceArchitectTurnMetric[] = [];
  private hydration: Promise<void> | null = null;
  private write: Promise<void> = Promise.resolve();

  /**
   * @param directory Where this helper's records live, relative to the
   * workspace. Distinct per helper so one cannot overwrite another's history.
   */
  constructor(
    private readonly workspacePath: string | undefined,
    private readonly directory: string,
  ) {}

  async save(metric: ResourceArchitectTurnMetric): Promise<void> {
    const priorWrite = this.write.catch(() => undefined);
    this.write = priorWrite.then(async () => {
      await this.hydrate();
      const sanitized = sanitizeTurnMetric(metric);
      // One record per turn. The record written before the provider is called
      // says the turn is running; the terminal record is that same turn's
      // outcome, not a second turn, and two rows for one job would double every
      // count taken from this file.
      const existing = this.metrics.findIndex(
        (candidate) =>
          candidate.jobId === sanitized.jobId && candidate.status === "running",
      );
      // Built beside what is on disk, not over it. What this store *reports*
      // has to be what it *persisted*: replacing the row first and writing
      // afterwards means a failed write leaves a completion nobody can read
      // back being reported as fact — and, worse, leaves no `running` row for
      // the caller's next save to replace, so the failure it records next
      // arrives as a second turn rather than as this one's outcome.
      const next = [...this.metrics];
      if (existing === -1) {
        next.push(sanitized);
      } else {
        // A terminal record often has no result to report — a cancellation, or
        // a failure raised before any reply — but the turn had already said
        // what it was running on. The outcome replaces the status, not the
        // account of how the model was chosen.
        const previous = next[existing];
        const carried = previous?.selection;
        next[existing] = sanitized.selection || !carried
          ? sanitized
          : { ...sanitized, selection: carried };
        if (previous?.review && !sanitized.review) {
          next[existing] = { ...next[existing], review: previous.review };
        }
      }
      const retained = next.slice(-TURN_METRIC_RETENTION);
      await this.persist(retained);
    });
    await this.write;
  }

  async list(limit = TURN_METRIC_RETENTION): Promise<ResourceArchitectTurnMetric[]> {
    await this.write.catch(() => undefined);
    await this.hydrate();
    const bounded = Math.min(TURN_METRIC_RETENTION, Math.max(1, limit));
    return this.metrics.slice(-bounded).map((metric) => structuredClone(metric));
  }

  /** Correct the admitted turn when its completed response cannot be published. */
  async recordPublicationFailure(jobId: string, status: 'failed' | 'cancelled', totalDurationMs: number): Promise<void> {
    const priorWrite = this.write.catch(() => undefined);
    this.write = priorWrite.then(async () => {
      await this.hydrate();
      let index = this.metrics.length - 1;
      while (index >= 0 && this.metrics[index]?.jobId !== jobId) index -= 1;
      const previous = this.metrics[index];
      if (!previous || previous.status === 'running') {
        throw new Error('Publication correction requires a terminal turn metric.');
      }
      const next = [...this.metrics];
      next[index] = sanitizeTurnMetric({
        ...previous,
        status,
        errorCode: 'publication_failed',
        timing: { ...previous.timing, totalDurationMs },
      });
      await this.persist(next);
    });
    await this.write;
  }

  private async persist(metrics: ResourceArchitectTurnMetric[]): Promise<void> {
    if (this.workspacePath) {
      await writeFileAtomic(this.filePath(), `${JSON.stringify({ schemaVersion: 1, metrics }, null, 2)}\n`);
    }
    // Publish the in-memory snapshot only after its durable write succeeds.
    this.metrics = metrics;
  }

  private async hydrate(): Promise<void> {
    if (!this.workspacePath || this.hydration) {
      await this.hydration;
      return;
    }
    this.hydration = (async () => {
      let stored: unknown;
      try {
        stored = JSON.parse(await fs.readFile(this.filePath(), "utf8"));
      } catch {
        return;
      }
      if (
        typeof stored !== "object" ||
        stored === null ||
        Array.isArray(stored)
      ) {
        return;
      }
      const record = stored as Record<string, unknown>;
      if (record.schemaVersion !== 1 || !Array.isArray(record.metrics)) return;
      // Each entry is rebuilt on its own. One stored turn nobody can read is
      // one turn missing from the history, not a reason to lose the turns
      // recorded either side of it.
      const recovered: ResourceArchitectTurnMetric[] = [];
      for (const entry of record.metrics) {
        const metric = parseTurnMetricRecord(entry);
        if (metric) recovered.push(metric);
      }
      this.metrics = recovered.slice(-TURN_METRIC_RETENTION);
    })();
    await this.hydration;
  }

  private filePath(): string {
    if (!this.workspacePath) {
      throw new Error("A turn metric store with no workspace has no file.");
    }
    return path.join(this.workspacePath, this.directory, "turns.json");
  }
}

/**
 * The allow-list that makes a record sanitized.
 *
 * Named field by field rather than copied, so a field added upstream cannot
 * arrive here unnoticed.
 */
export function sanitizeTurnMetric(
  metric: ResourceArchitectTurnMetric,
): ResourceArchitectTurnMetric {
  const timing = metric.timing;
  const context = timing.context;
  return {
    schemaVersion: 1,
    recordedAt: metric.recordedAt,
    jobId: metric.jobId,
    operation: metric.operation,
    status: metric.status,
    provider: metric.provider,
    model: metric.model,
    // The selection holds only how the pair was decided: no prompt, no output,
    // no credential.
    ...(metric.selection ? { selection: metric.selection } : {}),
    ...(metric.review ? { review: resourceArchitectFeedbackDiagnosticsSchema.parse(metric.review) } : {}),
    reasoning: metric.reasoning,
    outcomeKind: metric.outcomeKind,
    fallback: metric.fallback,
    ...(metric.errorCode ? { errorCode: metric.errorCode } : {}),
    timing: {
      contextAssemblyMs: timing.contextAssemblyMs,
      providerDurationMs: timing.providerDurationMs,
      processSpawnMs: timing.processSpawnMs,
      firstProviderEventMs: timing.firstProviderEventMs,
      firstTextMs: timing.firstTextMs,
      parseDurationMs: timing.parseDurationMs,
      repairOccurred: timing.repairOccurred,
      repairDurationMs: timing.repairDurationMs,
      totalDurationMs: timing.totalDurationMs,
      context: {
        instructionsChars: context.instructionsChars,
        operationChars: context.operationChars,
        uploadedDocumentPolicyChars: context.uploadedDocumentPolicyChars,
        visualizationPolicyChars: context.visualizationPolicyChars,
        teamLibraryChars: context.teamLibraryChars,
        agentLibraryChars: context.agentLibraryChars,
        totalChars: context.totalChars,
        historyChars: context.historyChars,
      },
    },
  };
}
