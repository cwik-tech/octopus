import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ENGINE_EVENT_SCHEMA_VERSION,
  type EngineEventCategory,
  type EngineEventEnvelope,
} from '../../contracts/runtime-events.js'

/** Assignment-local durable event log owned by the runtime foundation. */
const ENGINE_EVENT_LOG_FILENAME = 'engine-events.jsonl'

export { ENGINE_EVENT_SCHEMA_VERSION }
export type { EngineEventCategory, EngineEventEnvelope }

export type EngineEventSubscriber = (event: EngineEventEnvelope) => void

const subscribers = new Set<EngineEventSubscriber>()

export function subscribeEngineEvents(subscriber: EngineEventSubscriber): () => void {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}

function getEngineEventLogPath(outputDir: string): string {
  return path.join(outputDir, 'logs', ENGINE_EVENT_LOG_FILENAME)
}

function appendEngineEvent(filePath: string, event: EngineEventEnvelope): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n')
}

/**
 * The payloads this assignment has already announced for one event type.
 *
 * Reading the engine-event log belongs here, beside the writer that owns it:
 * a caller that needed to know what had been announced would otherwise have to
 * name this file itself, and a second module naming an authoritative evidence
 * path is exactly what the architecture rule exists to prevent.
 *
 * A line that does not parse is skipped. A damaged tail must not hide the
 * events before it, and it must not end the run still writing them.
 */
export function readAnnouncedEventPayloads(
  outputDir: string,
  type: string,
): Record<string, unknown>[] {
  const filePath = getEngineEventLogPath(outputDir)
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const trimmed = line.trim()
      // The log holds every event this run emitted, so only lines that mention
      // the requested family are worth parsing.
      if (!trimmed || !trimmed.includes(type)) return []
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return []
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      const envelope: Record<string, unknown> = { ...parsed }
      if (envelope.type !== type) return []
      const payload = envelope.payload
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? [{ ...payload }]
        : []
    })
}

export function publishEngineEvent(
  outputDir: string | undefined,
  event: Omit<EngineEventEnvelope, 'schema_version' | 'tenant_id'> & { tenant_id?: string },
): EngineEventEnvelope {
  const envelope: EngineEventEnvelope = {
    schema_version: ENGINE_EVENT_SCHEMA_VERSION,
    tenant_id: event.tenant_id ?? 'local',
    ...event,
  }

  if (outputDir) {
    appendEngineEvent(getEngineEventLogPath(outputDir), envelope)
  }

  for (const subscriber of subscribers) {
    subscriber(envelope)
  }

  return envelope
}
