/**
 * The Team Runtime's two teardown routes and the steps they share.
 *
 * `index.ts` keeps both registrations. The signal route is the `onShutdown`
 * callback `session_start` passes to `installShutdownHandlers`; the session
 * route is the `session_shutdown` handler. Each calls its sequence here with
 * the ports `index.ts` builds once.
 *
 * - `teardownOnSignal` is synchronous. It records the run as incomplete with
 *   the reason `signal_shutdown`, aborts the work in flight, stops the dev
 *   services synchronously, then clears the timers and persists state. It
 *   releases no process binding, closes no writer, emits no completion and
 *   leaves the checkpoint in place.
 * - `teardownOnSessionShutdown` is async. It stops the dashboard observer
 *   first, abandons the host run lifetime, records the run as incomplete with
 *   the reason `session_shutdown`, emits a pending completion and awaits the
 *   text stream's flush. It then aborts the work in flight, releases the
 *   signal registration and the exit listener, starts the dev services' stop
 *   without awaiting it, awaits the evidence writer's and the journal
 *   registry's closes, clears the timers, persists state, and deletes the
 *   checkpoint of a completed run.
 *
 * Both routes call the same ports to record the run as incomplete and to abort
 * the work in flight, and both call `clearTimersThenPersist`: last in the
 * signal route, and just before the checkpoint step in the session route.
 *
 * It reads no environment and no runtime context. Each read reaches it through
 * a port called at the step that reads it, and each effect through a port
 * named for what it does.
 */

// ── Ports ─────────────────────────────────────────────────────────────────

/** The reason each route records on `run.incomplete`. */
export type IncompleteRunReason = "signal_shutdown" | "session_shutdown";

/** The run's durable records. Both routes write them. */
export interface TeardownRecords {
  /**
   * Records the run as incomplete with this reason. `index.ts` decides
   * whether the run takes the record.
   */
  recordIncompleteRun(reason: IncompleteRunReason): void;
  persistState(): void;
}

/** The work in flight and the two timers. Both routes stop them. */
export interface InFlightWork {
  /** Aborts the runtime's shutdown controller. */
  abort(): void;
  /** Clears the dashboard refresh interval, when one is set. */
  clearRefreshInterval(): void;
  /** Clears the pending follow-up timer, when one is set. */
  clearFollowUpTimer(): void;
}

/** The dev services' two stops: the signal route's and the session route's. */
export interface DevServicesStop {
  /** Stops the dev services before it returns. */
  stopSync(): void;
  stop(): Promise<void>;
}

/** What the session route ends before its first await. */
export interface SessionRunEnd {
  stopDashboardObserver(): void;
  /** Abandons the host run lifetime, when there is one. */
  abandonHostRun(): void;
  /** Emits the run's pending completion, when there is one. */
  emitCompletionOnShutdown(): void;
}

/** What the session bound to the process. */
export interface ProcessBindings {
  /** Disposes the signal registration, when there is one, and forgets it. */
  releaseSignalRegistration(): void;
  /** Removes the exit listener that stops the dev services. */
  removeExitListener(): void;
}

/**
 * The text stream and the two writers the session route closes. Each writer is
 * read when its port is called, and is undefined when it was never created.
 */
export interface SessionWriters {
  /** Flushes and closes the process's agent text stream. */
  flushTextStream(): Promise<void>;
  /** The capability evidence writer. */
  evidenceWriter(): { close(): Promise<void> } | undefined;
  /** The execution journal registry. */
  journalRegistry(): { close(): Promise<void> } | undefined;
}

/** The checkpoint the session route deletes for a completed run. */
export interface CompletedRunCheckpoint {
  /** Whether a Team is loaded and the run has a session id and an end time. */
  runCompleted(): boolean;
  delete(): void;
}

/**
 * Every port either route calls, one group per thing the session route
 * releases or writes: its records, in-flight work and timers, the dev
 * services, the observer, host run and pending completion, the process
 * bindings, the writers, and the checkpoint. The signal route takes the
 * records, the in-flight work and only the synchronous dev-services stop.
 */
export interface RuntimeTeardownPorts {
  readonly records: TeardownRecords;
  readonly work: InFlightWork;
  readonly devServices: DevServicesStop;
  readonly session: SessionRunEnd;
  readonly processBindings: ProcessBindings;
  readonly writers: SessionWriters;
  readonly checkpoint: CompletedRunCheckpoint;
}

/** The ports the signal route calls. */
export type SignalTeardownPorts = Pick<RuntimeTeardownPorts, "records" | "work"> & {
  readonly devServices: Pick<DevServicesStop, "stopSync">;
};

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * The signal route, synchronous. `installShutdownHandlers` calls it at most
 * once per registration.
 */
export function teardownOnSignal(ports: SignalTeardownPorts): void {
  ports.records.recordIncompleteRun("signal_shutdown");
  ports.work.abort();
  ports.devServices.stopSync();
  clearTimersThenPersist(ports);
}

/**
 * The session route. Its promise resolves after the last step, or rejects at
 * the first step that throws.
 */
export async function teardownOnSessionShutdown(
  ports: RuntimeTeardownPorts,
): Promise<void> {
  // First, so nothing that follows can render into a pane this run no longer
  // owns, and so the runtime stops being reachable from the global event bus.
  ports.session.stopDashboardObserver();
  // Teardown is already under way, so the owner has nothing left to hold open
  // for — and its start deadline must not outlive the run that armed it.
  ports.session.abandonHostRun();
  ports.records.recordIncompleteRun("session_shutdown");
  // A runtime-owned path can complete before any host loop starts. Shutdown
  // is the final safety net so a queued successful run is never left without
  // a terminal event.
  ports.session.emitCompletionOnShutdown();
  // The display frames are batched, so a dispatch's last suffix and the
  // frame that closes its bubble are usually still queued here. This process
  // is the only thing that can still send them, and it is about to end.
  // Bounded by the sender's own terminal deadline, and never allowed to
  // change what the run reports: a preview is not an outcome.
  await ports.writers
    .flushTextStream()
    .catch((error: unknown) => {
      console.error(
        "[team-runtime] Failed to flush the agent text stream:",
        error instanceof Error ? error.message : String(error),
      );
    });
  ports.work.abort();
  // Everything this session bound to the process, given back beside the
  // instance it belonged to. A host loads one of these per session; anything
  // kept here is kept for the life of the host, still holding this run.
  ports.processBindings.releaseSignalRegistration();
  ports.processBindings.removeExitListener();
  void ports.devServices.stop();
  await ports.writers.evidenceWriter()?.close().catch((error: unknown) => {
    console.error(
      "[team-runtime] Failed to close capability evidence writer:",
      error instanceof Error ? error.message : String(error),
    );
  });
  await ports.writers.journalRegistry()?.close().catch((error: unknown) => {
    console.error(
      "[team-runtime] Failed to close execution journal registry:",
      error instanceof Error ? error.message : String(error),
    );
  });
  clearTimersThenPersist(ports);
  // Clean up checkpoint if the run completed successfully
  if (ports.checkpoint.runCompleted()) {
    ports.checkpoint.delete();
  }
}

/** Clears the refresh interval, then the follow-up timer, then persists state. */
function clearTimersThenPersist(
  ports: Pick<RuntimeTeardownPorts, "records" | "work">,
): void {
  ports.work.clearRefreshInterval();
  ports.work.clearFollowUpTimer();
  ports.records.persistState();
}
