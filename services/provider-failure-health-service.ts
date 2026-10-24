import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { ExecutionJournalEvent } from '../contracts/execution-journal.js'
import { writeFileAtomic } from '../core/file-mutation.js'
import {
  activeProviderFailure,
  applyProviderFailure,
  clearProviderFailures,
  projectProviderFailure,
  pruneProviderFailures,
  PROVIDER_FAILURE_REDUCER_VERSION,
  type ProviderFailureObservation,
  type ProviderFailureSnapshot,
  type ProviderFailureTarget,
} from '../domains/provider/provider-failure-projection.js'

export const PROVIDER_FAILURE_HEALTH_DIRECTORY_NAME = '.runtime'
export const PROVIDER_FAILURE_HEALTH_FILENAME = 'provider-failure-health.json'

interface StoredProviderFailures {
  readonly schemaVersion: 1
  readonly reducerVersion: number
  readonly failures: Readonly<Record<string, ProviderFailureObservation>>
}

/**
 * The workspace's view of what runs have discovered about each provider.
 *
 * Derived, never authoritative. Every fact in it came from an
 * `agent.turn.failed` event that was written to a journal first, and deleting
 * the file loses nothing that replaying those journals would not restore. It
 * exists because the alternative is asking every provider on every sidebar
 * render, which is a live network call per agent per keystroke.
 *
 * Nothing here is allowed to fail a turn. A journal append that succeeded and
 * a projection write that did not is a stale badge, which is exactly the state
 * the app was in before this existed; a journal append rolled back because a
 * cache could not be updated would be a lost fact.
 */
export class ProviderFailureHealthService {
  private snapshot: ProviderFailureSnapshot = {}
  private readonly filePath: string
  private readonly clock: { now(): number }
  private writing: Promise<void> = Promise.resolve()

  constructor(options: {
    readonly workspacePath: string
    readonly clock?: { now(): number }
  }) {
    this.filePath = path.join(
      options.workspacePath,
      PROVIDER_FAILURE_HEALTH_DIRECTORY_NAME,
      PROVIDER_FAILURE_HEALTH_FILENAME,
    )
    this.clock = options.clock ?? { now: () => Date.now() }
  }

  /** Read whatever a previous process left behind. Absent is normal. */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch {
      return
    }
    const stored = parseStored(raw)
    // A reducer whose rules changed cannot trust what the old one wrote. The
    // view starts empty and refills from the next runs rather than reporting
    // observations classified under rules this build no longer uses.
    if (!stored || stored.reducerVersion !== PROVIDER_FAILURE_REDUCER_VERSION) {
      return
    }
    this.snapshot = pruneProviderFailures(stored.failures, this.clockDate())
  }

  /**
   * Fold one journal event in. Most events project to nothing.
   *
   * Takes the appended event rather than the recorder's input, so this really
   * is a projection of what the journal now holds and not a second opinion
   * about it.
   */
  async observe(event: ExecutionJournalEvent): Promise<void> {
    const observation = projectProviderFailure(event)
    if (!observation) return
    const next = applyProviderFailure(this.snapshot, observation)
    if (next === this.snapshot) return
    this.snapshot = next
    await this.persist()
  }

  /** What both health endpoints read. Expired observations are already gone. */
  read(now: Date = this.clockDate()): ProviderFailureSnapshot {
    return pruneProviderFailures(this.snapshot, now)
  }

  /** Whether one provider and model is currently known to be failing. */
  active(
    target: { readonly provider: string; readonly model: string },
    now: Date = this.clockDate(),
  ): ProviderFailureObservation | undefined {
    return activeProviderFailure(this.snapshot, target, now)
  }

  /** Something newer disproved what a run found — usually a working ping. */
  async forget(target: ProviderFailureTarget): Promise<void> {
    const next = clearProviderFailures(this.snapshot, target)
    if (Object.keys(next).length === Object.keys(this.snapshot).length) return
    this.snapshot = next
    await this.persist()
  }

  /** Rebuild the whole view from journal events, discarding what was stored. */
  async rebuild(events: Iterable<ExecutionJournalEvent>): Promise<void> {
    let rebuilt: ProviderFailureSnapshot = {}
    for (const event of events) {
      const observation = projectProviderFailure(event)
      if (observation) rebuilt = applyProviderFailure(rebuilt, observation)
    }
    this.snapshot = rebuilt
    await this.persist()
  }

  private clockDate(): Date {
    return new Date(this.clock.now())
  }

  /**
   * Writes are serialized and their failures are swallowed on purpose: see the
   * class comment. A dropped write costs a stale badge until the next
   * observation, and the journal still holds the fact.
   */
  private async persist(): Promise<void> {
    const contents: StoredProviderFailures = {
      schemaVersion: 1,
      reducerVersion: PROVIDER_FAILURE_REDUCER_VERSION,
      failures: pruneProviderFailures(this.snapshot, this.clockDate()),
    }
    this.writing = this.writing.then(async () => {
      try {
        await writeFileAtomic(this.filePath, JSON.stringify(contents, null, 2))
      } catch {
        // Derived view; the journal remains the authority.
      }
    })
    await this.writing
  }
}

function parseStored(raw: string): StoredProviderFailures | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (parsed['schemaVersion'] !== 1) return undefined
  const reducerVersion = parsed['reducerVersion']
  if (typeof reducerVersion !== 'number') return undefined
  const failures = parsed['failures']
  if (!isRecord(failures)) return undefined

  const restored: Record<string, ProviderFailureObservation> = {}
  for (const [key, value] of Object.entries(failures)) {
    const observation = readObservation(value)
    if (observation) restored[key] = observation
  }
  return { schemaVersion: 1, reducerVersion, failures: restored }
}

function readObservation(value: unknown): ProviderFailureObservation | undefined {
  if (!isRecord(value)) return undefined
  const provider = value['provider']
  const model = value['model']
  const kind = value['kind']
  const observedAt = value['observedAt']
  const resetsAt = value['resetsAt']
  if (
    typeof provider !== 'string' ||
    typeof model !== 'string' ||
    typeof kind !== 'string' ||
    typeof observedAt !== 'string'
  ) {
    return undefined
  }
  // Re-validated through the projection rather than trusted: the file is
  // derived, and a kind this build does not project must not come back in
  // through it.
  const replayed = projectProviderFailure({
    schemaVersion: 1,
    eventId: 'restore',
    sequence: 0,
    recordedAt: observedAt,
    scopeKind: 'assignment',
    scopeId: 'restore',
    tenantId: 'local',
    streamKind: 'agent.turn',
    streamId: 'restore',
    streamRevision: 0,
    type: 'agent.turn.failed',
    payloadSchemaVersion: 1,
    appendRequestDigest: 'restore',
    correlationId: 'restore',
    previousEventHash: 'restore',
    eventHash: 'restore',
    // Replayed through the projection rather than trusted, reset included: the
    // file is derived, and a reset this build cannot read exactly must not come
    // back in through it and expire a failure at an invented moment.
    payload: {
      failure: {
        provider,
        model,
        providerKind: kind,
        ...(typeof resetsAt === 'string' ? { resetsAt } : {}),
      },
    },
  })
  return replayed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
